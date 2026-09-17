/**
 * Let the author SEE a Workspace. A view is judged by how it looks and reads,
 * and an author that cannot see its render designs blind: it cannot tell a
 * cluttered page from a calm one, a boxed column from a full-width surface, or
 * raw codes from decoded text.
 *
 * The preview renders the exact served document (design layer, bridge, planted
 * dataset, authored HTML) inside a local frame that answers the bridge the way
 * the desktop does, using the stored dataset. Actions, notes, and compose never
 * run from a preview. A Chromium-family browser installed on this machine takes
 * the screenshot headlessly; when none is available the preview says so.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRuntimeEnv } from '../config.js';

export const SPACE_PREVIEW_DEFAULT_WIDTH = 1440;
export const SPACE_PREVIEW_DEFAULT_HEIGHT = 1100;
/** Model providers refuse or downscale larger images; a side past this costs
 *  tokens and can fail a request that carries several images. */
export const SPACE_PREVIEW_MAX_SIDE = 2000;
const PREVIEW_TIMEOUT_MS = 30_000;
const SCREENSHOT_SETTLE_MS = 400;

export type SpacePreviewTheme = 'light' | 'dark';

export type SpacePreviewResult =
  | { ok: true; png: Buffer; width: number; height: number; theme: SpacePreviewTheme }
  | { ok: false; reason: string };

/** Installed Chromium-family browsers that can screenshot headlessly, in the
 *  order they are tried. An explicit override wins. */
function browserCandidates(): string[] {
  const override = getRuntimeEnv('CLEMMY_PREVIEW_BROWSER', '')?.trim();
  const home = os.homedir();
  const mac = (app: string, binary: string) => [
    `/Applications/${app}.app/Contents/MacOS/${binary}`,
    path.join(home, 'Applications', `${app}.app`, 'Contents', 'MacOS', binary),
  ];
  const candidates = [
    ...(override ? [override] : []),
    ...(process.platform === 'darwin' ? [
      ...mac('Google Chrome', 'Google Chrome'),
      ...mac('Chromium', 'Chromium'),
      ...mac('Microsoft Edge', 'Microsoft Edge'),
      ...mac('Brave Browser', 'Brave Browser'),
    ] : []),
    ...(process.platform === 'linux' ? [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/snap/bin/chromium',
    ] : []),
    ...(process.platform === 'win32' ? [
      path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : []),
  ];
  return [...new Set(candidates)];
}

export function findPreviewBrowser(): string | null {
  for (const candidate of browserCandidates()) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch { /* not usable */ }
  }
  return null;
}

/** A script-safe JSON string literal: no "<" can close the surrounding tag. */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(JSON.stringify(value ?? {}))
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The local parent page: frames the served view with the desktop's sandbox and
 *  answers the view bridge from the stored dataset. */
export function previewHostPage(input: { slug: string; dataset: unknown; viewFile: string; theme: SpacePreviewTheme; width?: number; offsetY?: number }): string {
  const slug = JSON.stringify(input.slug);
  const view = JSON.stringify(`${input.viewFile}?theme=${input.theme}`);
  const background = input.theme === 'dark' ? '#16140f' : '#faf7f2';
  // Headless browsers enforce a minimum window width wider than a phone, so a
  // narrow window alone lays the view out wider than the screenshot and crops
  // it. The frame is pinned to the requested width: that is the viewport the
  // view actually lays out in.
  const frameWidth = Number.isFinite(input.width) && (input.width as number) > 0
    ? `${Math.round(input.width as number)}px`
    : '100%';
  // A lower part of a long page: the frame is made taller by the offset and
  // shifted up, so the view lays out exactly as it would when scrolled there.
  const offset = Number.isFinite(input.offsetY) && (input.offsetY as number) > 0 ? Math.round(input.offsetY as number) : 0;
  const frameBox = offset > 0
    ? `position:absolute;left:0;top:-${offset}px;height:calc(100% + ${offset}px)`
    : 'height:100%';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Workspace preview</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:${background}}iframe{border:0;width:${frameWidth};${frameBox};display:block}</style></head>
<body><iframe id="frame" sandbox="allow-scripts"></iframe>
<script>(function(){
var C='clementine.workspace.rpc.v1',S=${slug},D=JSON.parse(${scriptLiteral(input.dataset)}),frame=document.getElementById('frame'),pinned=null;
window.addEventListener('message',function(e){var m=e.data;if(!m||m.channel!==C||m.kind!=='bootstrap'||e.source!==frame.contentWindow)return;if(pinned&&pinned!==m.documentId)return;pinned=m.documentId;
var rpc=new MessageChannel(),gesture=new MessageChannel();
rpc.port1.onmessage=function(pe){var r=pe.data;if(!r||r.kind!=='request')return;function reply(ok,result,error){rpc.port1.postMessage({channel:C,version:1,kind:'response',workspaceId:S,id:r.id,ok:ok,result:result,error:error});}
if(r.op==='data')return reply(true,D);if(r.op==='refresh')return reply(true,{results:[],data:D});if(r.op==='history'||r.op==='diff')return reply(true,{entries:[]});
reply(false,null,'This is a preview: actions, notes, and compose do not run.');};
rpc.port1.start();frame.contentWindow.postMessage({channel:C,version:1,kind:'bootstrap_ack',workspaceId:S,documentId:m.documentId},'*',[rpc.port2,gesture.port2]);});
frame.src=${view};
})();</script></body></html>`;
}

export interface SpacePreviewDependencies {
  /** Resolved browser binary; defaults to the installed-browser search. */
  browser?: string | null;
  timeoutMs?: number;
  spawnBrowser?: typeof spawn;
}

function waitForStableFile(file: string, deadlineAt: number): Promise<boolean> {
  return new Promise((resolve) => {
    let lastSize = -1;
    const tick = (): void => {
      let size = -1;
      try { size = existsSync(file) ? statSync(file).size : -1; } catch { size = -1; }
      if (size > 0 && size === lastSize) { resolve(true); return; }
      lastSize = size;
      if (Date.now() >= deadlineAt) { resolve(false); return; }
      setTimeout(tick, SCREENSHOT_SETTLE_MS);
    };
    tick();
  });
}

function stopProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** Screenshot one composed Workspace document headlessly. */
export async function renderWorkspacePreview(
  input: {
    slug: string;
    servedViewHtml: string;
    dataset: unknown;
    theme?: SpacePreviewTheme;
    width?: number;
    height?: number;
    /** Pixels from the top of the page to start the screenshot at. */
    offsetY?: number;
  },
  dependencies: SpacePreviewDependencies = {},
): Promise<SpacePreviewResult> {
  const browser = dependencies.browser === undefined ? findPreviewBrowser() : dependencies.browser;
  if (!browser) {
    return {
      ok: false,
      reason: 'no Chromium-family browser (Chrome, Chromium, Edge, or Brave) is installed on this machine to render the preview',
    };
  }
  const theme: SpacePreviewTheme = input.theme === 'dark' ? 'dark' : 'light';
  const width = Math.round(Math.min(SPACE_PREVIEW_MAX_SIDE, Math.max(360, input.width ?? SPACE_PREVIEW_DEFAULT_WIDTH)));
  const height = Math.round(Math.min(SPACE_PREVIEW_MAX_SIDE, Math.max(480, input.height ?? SPACE_PREVIEW_DEFAULT_HEIGHT)));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-space-preview-'));
  const shot = path.join(dir, 'preview.png');
  let child: ReturnType<typeof spawn> | null = null;
  try {
    writeFileSync(path.join(dir, 'view.html'), input.servedViewHtml, 'utf8');
    writeFileSync(path.join(dir, 'index.html'), previewHostPage({
      slug: input.slug, dataset: input.dataset, viewFile: 'view.html', theme, width,
      offsetY: Math.min(20_000, Math.max(0, Math.round(input.offsetY ?? 0))),
    }), 'utf8');
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=6000',
      `--screenshot=${shot}`,
      `file://${path.join(dir, 'index.html')}`,
    ];
    child = (dependencies.spawnBrowser ?? spawn)(browser, args, {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    const spawned = child;
    const exited = new Promise<void>((resolve) => { spawned.once('exit', () => resolve()); spawned.once('error', () => resolve()); });
    const deadlineAt = Date.now() + (dependencies.timeoutMs ?? PREVIEW_TIMEOUT_MS);
    const settled = await Promise.race([
      waitForStableFile(shot, deadlineAt),
      exited.then(() => waitForStableFile(shot, Math.min(deadlineAt, Date.now() + 1_000))),
    ]);
    if (!settled) {
      return { ok: false, reason: 'the browser did not produce a preview in time' };
    }
    return { ok: true, png: readFileSync(shot), width, height, theme };
  } catch (error) {
    return { ok: false, reason: `the preview could not be rendered: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (child) stopProcessTree(child);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
