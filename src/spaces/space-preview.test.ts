/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/space-preview.test.ts
 *
 * The author's eyes on a Workspace: a headless screenshot of the exact served
 * document with its stored data. The browser is faked here (a script that
 * writes the screenshot and lingers, like a real one can); a real render runs
 * only with CLEMMY_TEST_REAL_BROWSER=1.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-preview-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const preview = await import('./space-preview.js');
after(() => rmSync(HOME, { recursive: true, force: true }));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function fakeBrowser(name: string, body: string): string {
  const file = path.join(HOME, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

const lingering = fakeBrowser('lingering-browser.js', `
const fs = require('node:fs');
const arg = process.argv.find((value) => value.startsWith('--screenshot='));
fs.writeFileSync(arg.slice('--screenshot='.length), Buffer.from('${PNG.toString('hex')}', 'hex'));
fs.writeFileSync(${JSON.stringify(path.join(HOME, 'lingering.pid'))}, String(process.pid));
setInterval(() => {}, 1000);
`);
const silent = fakeBrowser('silent-browser.js', 'setInterval(() => {}, 1000);');

const temporaryPreviewDirs = () => readdirSync(os.tmpdir()).filter((name) => name.startsWith('clem-space-preview-') && !HOME.endsWith(name));

test('a browser that writes its screenshot and lingers still yields the image, and is stopped and cleaned up', async () => {
  const before = new Set(temporaryPreviewDirs());
  const result = await preview.renderWorkspacePreview({
    slug: 'my-board',
    servedViewHtml: '<!doctype html><html><body><h1>Board</h1></body></html>',
    dataset: { rows: [1, 2, 3] },
    theme: 'dark',
    width: 390,
  }, { browser: lingering, timeoutMs: 10_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.ok(result.png.equals(PNG), 'the screenshot bytes come back');
  assert.equal(result.theme, 'dark');
  assert.equal(result.width, 390);
  const pid = Number((await import('node:fs')).readFileSync(path.join(HOME, 'lingering.pid'), 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the lingering browser process was stopped');
  assert.deepEqual(temporaryPreviewDirs().filter((name) => !before.has(name)), [], 'its temporary files were removed');
});

test('a browser that never writes a screenshot times out with a reason; no browser at all says so', async () => {
  const slow = await preview.renderWorkspacePreview({
    slug: 'my-board', servedViewHtml: '<html></html>', dataset: {},
  }, { browser: silent, timeoutMs: 1_200 });
  assert.equal(slow.ok, false);
  if (!slow.ok) assert.match(slow.reason, /did not produce a preview in time/);
  const none = await preview.renderWorkspacePreview({
    slug: 'my-board', servedViewHtml: '<html></html>', dataset: {},
  }, { browser: null });
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.reason, /no Chromium-family browser/);
});

test('the preview host frames the view like the desktop and answers the bridge from the stored data only', () => {
  const page = preview.previewHostPage({
    slug: 'my-board',
    dataset: { emails: [{ subject: '</script><script>alert(1)</script>' }] },
    viewFile: 'view.html',
    theme: 'dark',
  });
  assert.match(page, /<iframe id="frame" sandbox="allow-scripts"><\/iframe>/);
  assert.match(page, /frame\.src="view\.html\?theme=dark"/);
  assert.ok(!page.includes('</script><script>alert(1)'), 'stored data cannot close the host script');
  assert.match(page, /if\(r\.op==='data'\)return reply\(true,D\)/);
  assert.match(page, /actions, notes, and compose do not run/);
  assert.match(page, /iframe\{border:0;width:100%;/, 'without a width the frame fills the window');
  const phone = preview.previewHostPage({ slug: 'my-board', dataset: {}, viewFile: 'view.html', theme: 'light', width: 390 });
  assert.match(phone, /iframe\{border:0;width:390px;/, 'a phone preview lays the view out at the phone width');
  const lower = preview.previewHostPage({ slug: 'my-board', dataset: {}, viewFile: 'view.html', theme: 'light', offsetY: 900 });
  assert.match(lower, /top:-900px;height:calc\(100% \+ 900px\)/, 'a lower part of the page is shown by shifting a taller frame');
});

test('a real installed browser renders a Workspace document', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const result = await preview.renderWorkspacePreview({
    slug: 'real-render',
    servedViewHtml: '<!doctype html><html><body style="background:#123"><script>document.body.innerHTML="<h1 style=color:#fff>"+(window.__SPACE_DATA__?"planted":"missing")+"</h1>"</script></body></html>',
    dataset: {},
    width: 800,
    height: 600,
  }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.ok(result.png.subarray(0, 8).equals(PNG.subarray(0, 8)), 'a PNG came back');
});

/** RGB of the first pixel of a PNG (the first pixel of any scanline filter is
 *  stored raw, because its left and upper neighbours are zero). */
async function firstPixel(png: Buffer): Promise<[number, number, number]> {
  const { inflateSync } = await import('node:zlib');
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  return [raw[1]!, raw[2]!, raw[3]!];
}

test('a real installed browser lays a phone preview out at the phone width', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const result = await preview.renderWorkspacePreview({
    slug: 'phone-render',
    servedViewHtml: '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#ff0000}@media (max-width:390px){html,body{background:#00ff00}}</style></head><body></body></html>',
    dataset: {},
    width: 390,
    height: 600,
  }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.png.readUInt32BE(16), 390, 'the image is phone width');
  const pixel = await firstPixel(result.png);
  assert.deepEqual(pixel, [0, 255, 0], `the view saw a 390-pixel viewport (first pixel ${pixel.join(',')})`);
});

test('a real installed browser shows a lower part of a long page at the requested offset', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const result = await preview.renderWorkspacePreview({
    slug: 'long-render',
    servedViewHtml: '<!doctype html><html><head><style>html,body{margin:0}.top{height:1000px;background:#ff0000}.bottom{height:1000px;background:#00ff00}</style></head><body><div class="top"></div><div class="bottom"></div></body></html>',
    dataset: {},
    width: 600,
    height: 600,
    offsetY: 1000,
  }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const pixel = await firstPixel(result.png);
  assert.deepEqual(pixel, [0, 255, 0], `the screenshot starts at the offset (first pixel ${pixel.join(',')})`);
});
