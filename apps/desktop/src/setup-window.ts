import { app, BrowserWindow, dialog, Notification } from 'electron';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {
  detectExistingConfiguration,
  initialAuthChoice,
  planSetupSteps,
  type ExistingConfiguration,
  type SetupStepId,
} from './setup-state.js';

/**
 * Setup wizard window — the first 60 seconds of the product.
 *
 * Self-contained HTML rendered into a frameless BrowserWindow. The step list
 * is not a constant: it is computed per launch by planSetupSteps() over what
 * detectExistingConfiguration() can already see on disk, so the most someone
 * ever answers is
 *
 *   welcome · sign in · about you · your folders (then launch)
 *
 * and a returning user whose setup-complete marker was deleted or corrupted
 * gets welcome → launch, because every question in between already has an
 * answer on disk.
 *
 * WHAT IS NOT HERE ANY MORE: the Discord bot token and Composio API key used
 * to be steps 4 and 5 of 7 — a channel build standing in front of the
 * first-party product, asked before the user had said one word to Clementine.
 * Both still ship: they are a collapsed disclosure on the last step and a
 * first-class surface in Connect. Nothing was deleted, it was moved behind
 * the work it exists to serve.
 *
 * IMPORTANT: the wizard is loaded from a `file://` URL backed by a temp HTML
 * file rather than a `data:` URL. Electron 32+ with `sandbox: true` +
 * `contextIsolation: true` silently refused to expose contextBridge for the
 * wizard's `data:` URL, which manifested as `window.clemmy` being undefined
 * and "Cannot read properties of undefined (reading 'setupSaveProfile')" at
 * the end of the flow. Loading from a file:// URL fixes that without giving
 * up isolation.
 *
 * IMPORTANT (CSP): the page ships `style-src 'nonce-…'` with no
 * 'unsafe-inline'. Under CSP Level 3 that blocks `style="…"` ATTRIBUTES too,
 * not just <style> blocks — the previous wizard carried eleven inline style
 * attributes that Chromium was silently dropping. Every rule here lives in
 * the nonced stylesheet; there is not one style attribute in the markup.
 *
 * IPC contract (see preload.ts for full list):
 *   clemmy:setup-status, clemmy:credentials-list, clemmy:credentials-set
 *   clemmy:setup-save-workspace, clemmy:setup-pick-workspace-folder
 *   clemmy:setup-save-profile
 *   clemmy:setup-codex-login
 *   clemmy:setup-discord-verify, clemmy:setup-save-discord-config
 *   clemmy:setup-open-external
 *   clemmy:setup-complete, clemmy:setup-skip
 */

export interface SetupWindowOpts {
  preloadPath: string;
  onComplete: (record: { configured: SetupConfiguredSummary }) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
}

export interface SetupConfiguredSummary {
  auth: 'openai' | 'codex' | 'skipped';
  discord: boolean;
  composio: boolean;
  workspaceCount: number;
  profileSet: boolean;
}

/**
 * The window's own chrome colour, before any CSS has painted. It is the
 * console's --bg-canvas, not a new value — the wizard and the app the wizard
 * opens are the same warm paper. (Electron needs a literal string here; it
 * cannot read a CSS custom property.)
 */
const WIZARD_CANVAS = '#faf7f2';

export function createSetupWindow(opts: SetupWindowOpts): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 620,
    minHeight: 560,
    title: 'Clementine — Setup',
    backgroundColor: WIZARD_CANVAS,
    frame: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    resizable: true,
    fullscreenable: false,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      // The setup wizard does not need durable Chromium storage; keeping
      // it in-memory avoids Electron Safe Storage touching macOS
      // Keychain for form state, cookies, or autofill artifacts.
      partition: 'clementine-setup',
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Defensive crash handling — without these, a renderer crash in
  // the wizard shows macOS's native "Clementine quit unexpectedly"
  // dialog with zero diagnostic info. Three failure paths to catch:
  //
  //   render-process-gone   → renderer crashed (OOM, uncaught throw,
  //                            killed, etc.). Most "wizard quit
  //                            unexpectedly" reports trace to this.
  //   did-fail-load         → file:// load itself failed (rare —
  //                            usually means the HTML file we wrote
  //                            isn't readable due to perms/sandbox).
  //   preload-error         → the contextBridge preload threw during
  //                            init. v0.5.4 hit this when the install
  //                            path had spaces / non-ASCII in the
  //                            URL pathname; v0.5.5+ uses fileURLToPath
  //                            but this handler keeps us safe against
  //                            future regressions.
  //
  // On any crash: write a diagnostic to ~/.clementine-next/logs/desktop/
  // setup-crash.log + show a macOS Notification + a follow-up dialog
  // when the user clicks the notification. The user has SOMETHING to
  // send us instead of a black box.
  win.webContents.on('render-process-gone', (_e, details) => {
    reportSetupCrash('renderer crashed', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    // Frame loads happen during normal navigation; only treat MAIN
    // frame failures as setup crashes. errorCode === -3 (ABORTED)
    // happens when we ourselves close the window — ignore.
    if (errorCode === -3) return;
    reportSetupCrash('setup HTML failed to load', {
      errorCode,
      errorDescription,
      validatedURL,
    });
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    reportSetupCrash('preload script threw', {
      preloadPath,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  win.loadFile(materializeSetupHtmlFile());
  return win;
}

/**
 * Write a structured diagnostic when the setup wizard renderer dies.
 * Designed so the user can run `cat ~/.clementine-next/logs/desktop/
 * setup-crash.log` and email/paste the result. Never throws — best-
 * effort logging only.
 */
function reportSetupCrash(stage: string, details: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const payload = {
    at: ts,
    stage,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    home: os.homedir(),
    locale: app.getLocale(),
    details,
  };
  try {
    const logDir = path.join(os.homedir(), '.clementine-next', 'logs', 'desktop');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, 'setup-crash.log'), JSON.stringify(payload) + '\n', 'utf-8');
  } catch { /* logging is best-effort */ }
  try {
    new Notification({
      title: 'Clementine setup hit an error',
      body: `${stage}. A diagnostic was written to ~/.clementine-next/logs/desktop/setup-crash.log — please share that file if support asks.`,
      urgency: 'critical',
    }).show();
  } catch { /* notification permissions can be denied */ }
  // Defer the dialog so the notification appears first + the user
  // sees something even if they have macOS notification banners
  // disabled. The dialog blocks until they click OK.
  setTimeout(() => {
    try {
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'Clementine setup error',
        message: `The setup wizard hit a problem: ${stage}`,
        detail: `A diagnostic was written to:\n~/.clementine-next/logs/desktop/setup-crash.log\n\nPlease share that file when reporting the issue. Quit Clementine and reopen to try setup again.`,
        buttons: ['OK'],
      });
    } catch { /* dialog can fail in some macOS states */ }
  }, 300);
}

/**
 * Write the wizard HTML to a stable path under the Electron user-data
 * directory and return that path. We do this rather than ship a static
 * HTML asset so the build process stays simple (TS → JS only), and
 * rather than use a data: URL so contextBridge reliably exposes our
 * preload API onto window.clemmy.
 */
function materializeSetupHtmlFile(): string {
  const dir = path.join(app.getPath('userData'), 'wizard');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'setup.html');
  writeFileSync(file, renderSetupHtml(), 'utf-8');
  return file;
}

/* ────────────────────────────────────────────────────────────────────────────
   The shared token layer, inlined.

   packages/design-tokens/tokens.css is plain CSS with no build step precisely
   so this window can paste it in verbatim — the wizard, the console and the
   PWA then read the same bytes for the accent's two roles, the ink ramp,
   focus and motion. In a checkout we read the real file. In a packaged app
   that file is not inside the asar, so a compiled-in copy of the properties
   this window actually uses is the fallback; it is a subset, never a
   redefinition, and every value in it is copied from the same source.
   ──────────────────────────────────────────────────────────────────────────── */

const FALLBACK_TOKENS_CSS = `
:root {
  --clem-primary:       #f26419;
  --clem-primary-hover: #ff8442;
  --clem-primary-press: #de5a12;
  --clem-primary-tint:  #fff4ed;
  --clem-primary-ink:   #b94300;
  --clem-primary-ink-hover: #963400;
  --clem-primary-fg:    #1f1b16;
  --clem-ink:        #1f1b16;
  --clem-ink-muted:  #5c564b;
  --clem-ink-subtle: #75644f;
  --clem-success:      #2e7d46;  --clem-success-tint: #e8f5ec;
  --clem-info:         #1e6fb8;  --clem-info-tint:    #e6f1fa;
  --clem-warning:      #8a6000;  --clem-warning-tint: #fcf1de;
  --clem-danger:       #c0392b;  --clem-danger-tint:  #fbe9e7;
  --clem-focus:        var(--clem-primary-ink);
  --clem-focus-width:  2px;
  --clem-focus-offset: 2px;
  --clem-ease:       cubic-bezier(0.22, 1, 0.36, 1);
  --clem-dur-fast:   120ms;
  --clem-dur-base:   180ms;
  --clem-dur-slow:   300ms;
  --clem-press:      0.97;
}
`;

/** Candidate locations for the real token file, nearest first. */
export function sharedTokensCandidatePaths(moduleDir: string): string[] {
  return [
    // apps/desktop/{src,dist}/setup-window.{ts,js} → repo root → packages/…
    path.resolve(moduleDir, '..', '..', '..', 'packages', 'design-tokens', 'tokens.css'),
    path.resolve(moduleDir, '..', '..', '..', 'node_modules', '@clem', 'design-tokens', 'tokens.css'),
  ];
}

/** The real tokens when they are on disk, the compiled-in subset when not. */
export function loadSharedTokensCss(): string {
  let moduleDir: string;
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return FALLBACK_TOKENS_CSS;
  }
  for (const candidate of sharedTokensCandidatePaths(moduleDir)) {
    try {
      const css = readFileSync(candidate, 'utf-8');
      if (css.includes('--clem-primary-ink')) return css;
    } catch { /* try the next one */ }
  }
  return FALLBACK_TOKENS_CSS;
}

function renderSetupHtml(): string {
  const nonce = randomBytes(16).toString('base64');
  const existing = safeDetect();
  const plan = planSetupSteps(existing);
  // Only non-secret facts cross into the renderer: what is already answered,
  // and the profile values we would otherwise ask for again. No key, no token.
  // A workspace path is user-controlled text going into a <script> body, so
  // close the one hole that matters: an embedded "</script>" would end the
  // block early. Escaping "<" as < is inert in JSON and safe in HTML.
  //
  // `authChoice` rides along because the auth STEP may never run: the value
  // the wizard submits has to come from the same detection that decided not
  // to ask. See initialAuthChoice().
  const bootstrap = JSON.stringify({
    plan,
    existing,
    authChoice: initialAuthChoice(existing),
  }).replace(/</g, '\\u003c');
  return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" /><title>Clementine — Setup</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'" />
<style nonce="${nonce}">${loadSharedTokensCss()}</style>
<style nonce="${nonce}">${SETUP_CSS}</style>
</head><body>
  <div class="wiz">
    <header class="wiz-head">
      <span class="brand-dot" aria-hidden="true"></span>
      <span class="brand-name">Clementine</span>
      <span class="brand-sub">Setup</span>
      <span class="step-dots" data-step-dots role="status" aria-live="polite"></span>
    </header>

    <main class="wiz-main"><div class="wiz-measure" data-wiz-main></div></main>

    <footer class="wiz-foot">
      <button class="btn btn-ghost" data-wiz-back type="button" hidden>${icon('arrow-left')}<span>Back</span></button>
      <button class="btn btn-quiet" data-wiz-skip type="button">Skip for now</button>
      <button class="btn btn-primary" data-wiz-next type="button"><span data-next-label>Continue</span>${icon('arrow-right')}</button>
    </footer>
  </div>

  <script nonce="${nonce}">window.__CLEM_SETUP__ = ${bootstrap};</script>
  <script nonce="${nonce}">${SETUP_JS}</script>
</body></html>`;
}

/** Detection reads the disk; a wizard that cannot render is worse than a
 *  wizard that asks one extra question, so a failure degrades to "ask". */
function safeDetect(): ExistingConfiguration {
  try {
    return detectExistingConfiguration();
  } catch {
    return {
      auth: 'none',
      embeddingKey: false,
      workspaces: [],
      profile: { preferredName: '', role: '', timezone: '', communicationTone: 'balanced' },
      discord: false,
      composio: false,
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Icons.

   Real icons, never emoji glyphs. These are lucide path data (the same set the
   console imports as lucide-react) hand-inlined, because this window has no
   bundler and no network: it is one HTML string written to disk.
   ──────────────────────────────────────────────────────────────────────────── */

const ICON_PATHS: Record<string, string> = {
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'key-round': '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 7V2"/><path d="M15 7V2"/><path d="M6 13V8h12v5a6 6 0 0 1-12 0Z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'user-round': '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function icon(name: string, className = 'ico'): string {
  const body = ICON_PATHS[name] ?? '';
  return '<svg class="' + className + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
}

/** The renderer builds icons too; hand it the same table rather than a copy. */
const ICON_TABLE_JSON = JSON.stringify(ICON_PATHS);

const SETUP_CSS = `
/* Surfaces. The token layer above deliberately owns semantics, not surface
   ramps; these four values are the desktop console's own paper ramp, copied so
   the wizard and the window it opens are the same material. */
:root {
  --paper:        #faf7f2;
  --surface:      #ffffff;
  --surface-sunk: #f4f0e9;
  --hairline:     #e7e1d6;
  --hairline-strong: #d6cfc0;
  --measure: 62ch;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--paper);
  color: var(--clem-ink);
  font: 16px/1.6 "Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}

/* An outline, not a shadow: it follows each element's own radius and cannot be
   deleted by a later background rule. Twenty-four sites across this product
   set outline:none with nothing in its place; this window has none. */
:focus-visible {
  outline: var(--clem-focus-width) solid var(--clem-focus);
  outline-offset: var(--clem-focus-offset);
}

.ico { width: 16px; height: 16px; flex: none; }
.ico-lg { width: 20px; height: 20px; flex: none; }

.wiz { display: grid; grid-template-rows: 52px 1fr 72px; height: 100vh; }

/* ── Header ─────────────────────────────────────────────────────────────── */
.wiz-head {
  display: flex; align-items: center; gap: 10px;
  padding: 0 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
  -webkit-app-region: drag;
}
.brand-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--clem-primary);   /* fill role */
}
.brand-name { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
.brand-sub  { color: var(--clem-ink-subtle); font-size: 14px; }
.step-dots { margin-left: auto; display: flex; align-items: center; gap: 6px; -webkit-app-region: no-drag; }
.step-dots .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--hairline-strong);
  transition: background var(--clem-dur-fast) var(--clem-ease);
}
.step-dots .dot.done { background: var(--clem-primary-ink); }
.step-dots .dot.now  { background: var(--clem-primary); transform: scale(1.25); }
.step-count { font-size: 13px; color: var(--clem-ink-subtle); margin-right: 4px; }

/* ── Body ───────────────────────────────────────────────────────────────── */
.wiz-main { overflow-y: auto; padding: 34px 32px 28px; }
.wiz-measure { max-width: var(--measure); margin: 0 auto; }

.eyebrow {
  display: inline-flex; align-items: center; gap: 7px;
  color: var(--clem-primary-ink);      /* read role — never the fill */
  font-size: 13px; font-weight: 600;
  margin-bottom: 10px;
}
h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 700; }
.lede { color: var(--clem-ink-muted); margin: 0 0 22px; font-size: 16px; line-height: 1.6; }
.lede strong { color: var(--clem-ink); font-weight: 600; }
code {
  font: 500 0.9em/1 ui-monospace, "SF Mono", Menlo, monospace;
  background: var(--surface-sunk); border-radius: 5px; padding: 2px 5px;
}

.step { animation: rise var(--clem-dur-slow) var(--clem-ease); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* ── Choices (real radios: keyboard, arrow keys and focus come for free) ── */
.choices { display: grid; gap: 10px; margin-bottom: 4px; }
.choice {
  display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: start;
  border: 1px solid var(--hairline);
  border-radius: 12px;
  background: var(--surface);
  padding: 14px 16px;
  cursor: pointer;
  transition: border-color var(--clem-dur-fast) var(--clem-ease), background var(--clem-dur-fast) var(--clem-ease);
}
.choice:hover { border-color: var(--hairline-strong); }
.choice input { accent-color: var(--clem-primary); width: 16px; height: 16px; margin: 4px 0 0; }
.choice:has(input:checked) { border-color: var(--clem-primary-ink); background: var(--clem-primary-tint); }
.choice:has(input:focus-visible) { outline: var(--clem-focus-width) solid var(--clem-focus); outline-offset: var(--clem-focus-offset); }
.choice-title { display: block; font-weight: 600; font-size: 15px; }
.choice-meta  { display: block; color: var(--clem-ink-muted); font-size: 14px; line-height: 1.5; margin-top: 2px; }

/* ── Fields ─────────────────────────────────────────────────────────────── */
.field { margin-top: 18px; }
.field > label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.field input[type="text"], .field select {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--hairline-strong);
  border-radius: 10px;
  color: var(--clem-ink);
  font: inherit; font-size: 16px;
  padding: 10px 12px;
  transition: border-color var(--clem-dur-fast) var(--clem-ease);
}
.field input[type="text"]:hover, .field select:hover { border-color: var(--clem-ink-subtle); }
::placeholder { color: var(--clem-ink-subtle); }
.secret-input { -webkit-text-security: disc; }
.hint { display: block; margin-top: 7px; font-size: 14px; line-height: 1.5; color: var(--clem-ink-muted); }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.field-row .field { margin-top: 18px; }

/* ── Notes ──────────────────────────────────────────────────────────────── */
.note {
  display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start;
  border: 1px solid var(--hairline);
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 14px; line-height: 1.55;
  color: var(--clem-ink-muted);
  background: var(--surface);
  margin-top: 18px;
}
.note .ico { margin-top: 2px; color: var(--clem-ink-subtle); }
.note-ok      { background: var(--clem-success-tint); border-color: transparent; color: var(--clem-success); }
.note-ok .ico { color: var(--clem-success); }
.note-warn      { background: var(--clem-warning-tint); border-color: transparent; color: var(--clem-warning); }
.note-warn .ico { color: var(--clem-warning); }
.note-bad       { background: var(--clem-danger-tint); border-color: transparent; color: var(--clem-danger); }
.note-bad .ico  { color: var(--clem-danger); }

/* ── Workspaces ─────────────────────────────────────────────────────────── */
.ws-list { list-style: none; margin: 0 0 12px; padding: 0; border: 1px solid var(--hairline); border-radius: 12px; background: var(--surface); overflow: hidden; }
.ws-list li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--hairline); font-size: 14px; }
.ws-list li:last-child { border-bottom: 0; }
.ws-list li.empty { color: var(--clem-ink-subtle); justify-content: center; padding: 18px; }
.ws-list .path { flex: 1; word-break: break-all; }
.ws-list .ico { color: var(--clem-ink-subtle); }
.ws-add { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; }
.ws-add input[type="text"] {
  background: var(--surface); border: 1px solid var(--hairline-strong); border-radius: 10px;
  color: var(--clem-ink); font: inherit; font-size: 16px; padding: 10px 12px; width: 100%;
}

/* ── Summary ────────────────────────────────────────────────────────────── */
.summary { border: 1px solid var(--hairline); border-radius: 12px; background: var(--surface); padding: 6px 16px; margin-top: 20px; }
.summary li { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--hairline); font-size: 15px; }
.summary li:last-child { border-bottom: 0; }
.summary ul { list-style: none; margin: 0; padding: 0; }
.summary .ico { color: var(--clem-success); }
.summary .ico.pending { color: var(--clem-ink-subtle); }
.summary .what { color: var(--clem-ink-muted); }
.summary .what b { color: var(--clem-ink); font-weight: 600; }

details.optional { margin-top: 20px; border: 1px solid var(--hairline); border-radius: 12px; background: var(--surface); }
details.optional > summary {
  display: flex; align-items: center; gap: 9px;
  padding: 13px 16px; cursor: pointer; font-size: 15px; font-weight: 600;
  border-radius: 12px;
}
details.optional > summary::-webkit-details-marker { display: none; }
details.optional > summary .ico { color: var(--clem-ink-subtle); }
details.optional[open] > summary { border-bottom: 1px solid var(--hairline); border-radius: 12px 12px 0 0; }
.optional-body { padding: 4px 16px 18px; }

/* ── Buttons ────────────────────────────────────────────────────────────── */
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  font: inherit; font-size: 15px; font-weight: 600;
  border-radius: 10px;
  padding: 9px 16px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background var(--clem-dur-fast) var(--clem-ease), border-color var(--clem-dur-fast) var(--clem-ease), color var(--clem-dur-fast) var(--clem-ease);
}
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn:active:not(:disabled) { transform: scale(var(--clem-press)); }
.btn-primary { background: var(--clem-primary); color: var(--clem-primary-fg); }
.btn-primary:hover:not(:disabled)  { background: var(--clem-primary-hover); }
.btn-primary:active:not(:disabled) { background: var(--clem-primary-press); }
.btn-secondary { background: var(--surface); border-color: var(--hairline-strong); color: var(--clem-ink); }
.btn-secondary:hover:not(:disabled) { border-color: var(--clem-ink-subtle); background: var(--surface-sunk); }
.btn-ghost { background: transparent; color: var(--clem-ink-muted); }
.btn-ghost:hover { color: var(--clem-ink); background: var(--surface-sunk); }
.btn-quiet { background: transparent; color: var(--clem-ink-subtle); font-weight: 500; }
.btn-quiet:hover { color: var(--clem-ink-muted); }
.btn-sm { font-size: 14px; padding: 8px 12px; }
.btn-icon { padding: 6px; border-radius: 8px; background: transparent; color: var(--clem-ink-subtle); border-color: transparent; }
.btn-icon:hover { color: var(--clem-danger); background: var(--clem-danger-tint); }
.btn-link { background: transparent; padding: 0; color: var(--clem-primary-ink); text-decoration: underline; text-underline-offset: 3px; }
.btn-link:hover { color: var(--clem-primary-ink-hover); }

.wiz-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 0 20px;
  background: var(--surface);
  border-top: 1px solid var(--hairline);
}
.wiz-foot .btn-quiet { margin-left: auto; }

.spin { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.launch-mark {
  display: grid; place-items: center;
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--clem-primary-tint);
  color: var(--clem-primary-ink);
  margin: 0 0 14px;
}
.launch-mark .ico { width: 26px; height: 26px; }

.bridge-error { padding: 40px 32px; max-width: var(--measure); margin: 0 auto; }
.bridge-error h1 { color: var(--clem-danger); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
`;

const SETUP_JS = `
(function () {
  'use strict';

  var ICONS = ${ICON_TABLE_JSON};
  function ico(name, cls) {
    return '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (ICONS[name] || '') + '</svg>';
  }

  // Fail fast if the preload bridge didn't attach. Surfaces the root
  // cause instead of a downstream "Cannot read properties of undefined".
  if (!window.clemmy) {
    document.body.innerHTML =
      '<div class="bridge-error"><h1>Setup can\\'t reach the app</h1>' +
      '<p class="lede">Clementine could not attach its preload script, so this window has nothing to save to. ' +
      'Quit and relaunch the app. If it keeps happening, reinstall the latest Clementine and open setup again.</p></div>';
    return;
  }

  var boot = window.__CLEM_SETUP__ || {};
  var STEPS = (boot.plan && boot.plan.length) ? boot.plan : ['welcome', 'auth', 'profile', 'workspace', 'launch'];
  var already = boot.existing || {
    auth: 'none', embeddingKey: false, workspaces: [],
    profile: { preferredName: '', role: '', timezone: '', communicationTone: 'balanced' },
    discord: false, composio: false
  };
  var stepIndex = 0;

  var detectedTimezone = (function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch (e) { return ''; }
  })();

  var timezoneOptions = (function () {
    try {
      var fn = Intl.supportedValuesOf;
      var list = typeof fn === 'function' ? fn('timeZone') : null;
      if (Array.isArray(list) && list.length > 0) return list;
    } catch (e) { /* fall through */ }
    // Minimal fallback so the picker still works on runtimes without
    // Intl.supportedValuesOf. Order: detected tz first, then common.
    return ['UTC',
      'America/Los_Angeles','America/Denver','America/Chicago','America/New_York',
      'America/Phoenix','America/Anchorage','America/Honolulu','America/Toronto',
      'America/Vancouver','America/Mexico_City','America/Sao_Paulo','America/Argentina/Buenos_Aires',
      'Europe/London','Europe/Dublin','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Rome',
      'Europe/Amsterdam','Europe/Stockholm','Europe/Warsaw','Europe/Moscow','Europe/Istanbul',
      'Africa/Cairo','Africa/Johannesburg','Africa/Lagos','Africa/Nairobi',
      'Asia/Dubai','Asia/Kolkata','Asia/Bangkok','Asia/Singapore','Asia/Hong_Kong',
      'Asia/Tokyo','Asia/Seoul','Asia/Shanghai','Asia/Taipei','Asia/Jakarta',
      'Australia/Perth','Australia/Sydney','Pacific/Auckland'];
  })();

  var state = {
    // NOT a literal: the auth step is skipped whenever a credential is already
    // on disk, so a hardcoded 'codex' here was the answer a returning OpenAI
    // user submitted without ever being asked — and main.ts writes AUTH_MODE
    // from it. boot.authChoice is initialAuthChoice(existing), computed in the
    // main process from the same detection that dropped the step. The literal
    // survives only for the no-bootstrap fallback, where auth is 'none' and
    // the step therefore runs.
    authChoice: boot.authChoice || 'codex',  // 'openai' | 'codex' | 'skipped'
    openaiKey: '',           // primary auth key when authChoice === 'openai'
    extraOpenaiKey: '',      // optional embedding+voice key (any auth choice)
    codexStatus: '',         // '' | 'launching' | 'ok' | 'error'
    codexMessage: '',
    codexAccountId: '',
    discordToken: '',
    discordOwnerId: '',
    discordClientId: '',
    discordAppName: '',
    discordInstallUrl: '',
    discordVerifyStatus: '',
    discordVerifyMessage: '',
    composioKey: '',
    // Folders already in WORKSPACE_DIRS are shown and kept; re-saving one is a
    // no-op in setup-bridge, so the list stays the user's whole picture.
    workspaces: (already.workspaces || []).slice(),
    profile: {
      preferredName: already.profile.preferredName || '',
      role: already.profile.role || '',
      timezone: already.profile.timezone || detectedTimezone,
      communicationTone: already.profile.communicationTone || 'balanced',
      formality: 'professional'
    }
  };

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  var mainEl = document.querySelector('[data-wiz-main]');
  var dotsEl = document.querySelector('[data-step-dots]');
  var backBtn = document.querySelector('[data-wiz-back]');
  var skipBtn = document.querySelector('[data-wiz-skip]');
  var nextBtn = document.querySelector('[data-wiz-next]');
  var nextLabel = nextBtn.querySelector('[data-next-label]');

  function currentStep() { return STEPS[stepIndex]; }
  function isLast() { return stepIndex === STEPS.length - 1; }

  function canAdvance() {
    if (currentStep() !== 'auth') return true;
    if (state.authChoice === 'skipped') return true;
    if (state.authChoice === 'openai') return Boolean(state.openaiKey && state.openaiKey.trim());
    if (state.authChoice === 'codex') return state.codexStatus === 'ok';
    return true;
  }

  function renderDots() {
    var out = '<span class="step-count">Step ' + (stepIndex + 1) + ' of ' + STEPS.length + '</span>';
    for (var i = 0; i < STEPS.length; i++) {
      var cls = i < stepIndex ? 'dot done' : (i === stepIndex ? 'dot now' : 'dot');
      out += '<span class="' + cls + '"></span>';
    }
    dotsEl.innerHTML = out;
  }

  function render() {
    renderDots();
    backBtn.hidden = stepIndex === 0;
    nextLabel.textContent = isLast() ? 'Launch Clementine' : 'Continue';
    var step = currentStep();
    var html = '';
    if (step === 'welcome') html = renderWelcome();
    else if (step === 'auth') html = renderAuth();
    else if (step === 'profile') html = renderProfile();
    else if (step === 'workspace') html = renderWorkspace();
    else html = renderLaunch();
    mainEl.innerHTML = html;
    bind();
    nextBtn.disabled = !canAdvance();
  }

  function note(kind, iconName, text) {
    return '<div class="note ' + kind + '">' + ico(iconName) + '<div>' + text + '</div></div>';
  }

  function renderWelcome() {
    var returning = STEPS.length <= 2;
    var body = returning
      ? 'Everything I need is already on this machine — your sign-in, your folders and how you like to be spoken to. ' +
        'There is nothing to fill in. Press <strong>Continue</strong> and I will open the console.'
      : 'I am a local agent. I run on your machine, I remember what we do together, and I can reach the tools ' +
        'and files you already use. The next couple of screens are the only things I cannot work out for myself.';
    return '' +
      '<div class="step">' +
      '  <div class="eyebrow">' + ico('sparkles') + '<span>' + (returning ? 'Welcome back' : 'Welcome') + '</span></div>' +
      '  <h1>Hi. I&rsquo;m Clementine.</h1>' +
      '  <p class="lede">' + body + '</p>' +
      note('', 'lock', 'Your credentials stay on this machine, in Clementine&rsquo;s local vault. They never go into a ' +
        '<code>.env</code> file unless you put them there yourself.') +
      '</div>';
  }

  function renderAuth() {
    function choice(value, title, meta) {
      return '' +
        '<label class="choice">' +
        '  <input type="radio" name="clem-auth" value="' + value + '"' + (state.authChoice === value ? ' checked' : '') + ' />' +
        '  <span><span class="choice-title">' + esc(title) + '</span><span class="choice-meta">' + meta + '</span></span>' +
        '</label>';
    }

    var extra = '';
    if (state.authChoice === 'openai') {
      extra = '' +
        '<div class="field">' +
        '  <label for="clem-openai-key">OpenAI API key</label>' +
        '  <input id="clem-openai-key" type="text" class="secret-input" data-state="openaiKey" name="setup-openai-key-no-autofill" value="' + esc(state.openaiKey) + '" placeholder="sk-…" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellcheck="false" />' +
        '  <span class="hint">From platform.openai.com/api-keys. The same key also covers vault search and live voice.</span>' +
        '</div>';
    } else if (state.authChoice === 'codex') {
      var statusBlock = '';
      if (state.codexStatus === 'launching') {
        statusBlock = note('', 'info', 'Checking for an existing Codex login, then opening auth.openai.com if it needs one. Finish signing in in your browser.');
      } else if (state.codexStatus === 'ok') {
        var who = state.codexAccountId ? ' (account ' + esc(state.codexAccountId) + ')' : '';
        statusBlock = note('note-ok', 'check-circle', esc(state.codexMessage || 'Signed in with ChatGPT') + who + '. Tokens are stored locally.');
      } else if (state.codexStatus === 'error') {
        statusBlock = note('note-bad', 'triangle-alert', esc(state.codexMessage || 'Sign-in failed.'));
      } else {
        statusBlock = note('note-warn', 'info', 'Sign in before continuing, or choose &ldquo;decide later&rdquo;.');
      }
      var label = state.codexStatus === 'ok' ? 'Sign in again' : 'Sign in with ChatGPT';
      extra = '' +
        '<div class="field">' +
        '  <button class="btn btn-secondary" type="button" data-codex-login' + (state.codexStatus === 'launching' ? ' disabled' : '') + '>' +
             ico('arrow-up-right') + '<span>' + label + '</span></button>' +
        '  <span class="hint">Your browser opens, you sign in with the same account you use for ChatGPT, and I catch the redirect on localhost. No terminal.</span>' +
        '</div>' + statusBlock +
        '<div class="field">' +
        '  <label for="clem-extra-key">OpenAI API key <span class="choice-meta">— optional</span></label>' +
        '  <input id="clem-extra-key" type="text" class="secret-input" data-state="extraOpenaiKey" name="setup-extra-openai-key-no-autofill" value="' + esc(state.extraOpenaiKey) + '" placeholder="sk-… (leave blank to skip)" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellcheck="false" />' +
        '  <span class="hint">Two things a ChatGPT sign-in cannot do: search your vault by meaning (embeddings) and talk to you out loud (Realtime voice). A key unlocks both. You can add it later from Settings → Models &amp; routing.</span>' +
        '</div>';
    }

    return '' +
      '<div class="step">' +
      '  <div class="eyebrow">' + ico('key-round') + '<span>Sign in</span></div>' +
      '  <h1>How should I reach a model?</h1>' +
      '  <p class="lede">This is the one thing I genuinely cannot start without. Everything else can wait.</p>' +
      '  <div class="choices">' +
           choice('codex', 'Use my ChatGPT subscription', 'Sign in here with Codex OAuth. No terminal, no card.') +
           choice('openai', 'Use an OpenAI API key', 'Direct API billing for the agent runtime.') +
           choice('skipped', 'Decide later', 'The console opens, but chat and agent calls fail until this is set.') +
      '  </div>' + extra +
      '  <p class="hint">Prefer Claude? Connect a Claude sign-in afterwards from Settings → Models &amp; routing.</p>' +
      '</div>';
  }

  function renderProfile() {
    var p = state.profile;
    var tz = timezoneOptions.map(function (zone) {
      return '<option value="' + esc(zone) + '"' + (zone === p.timezone ? ' selected' : '') + '>' + esc(zone) + '</option>';
    }).join('');
    function toneOption(value, label) {
      return '<option value="' + value + '"' + (p.communicationTone === value ? ' selected' : '') + '>' + label + '</option>';
    }
    return '' +
      '<div class="step">' +
      '  <div class="eyebrow">' + ico('user-round') + '<span>About you</span></div>' +
      '  <h1>How should I talk to you?</h1>' +
      '  <p class="lede">A little context up front, so I sound right from the first message. All of it is editable later.</p>' +
      '  <div class="field-row">' +
      '    <div class="field"><label for="clem-name">Preferred name</label>' +
      '      <input id="clem-name" type="text" data-state="profile.preferredName" value="' + esc(p.preferredName) + '" placeholder="e.g. Alex" /></div>' +
      '    <div class="field"><label for="clem-role">What you do</label>' +
      '      <input id="clem-role" type="text" data-state="profile.role" value="' + esc(p.role) + '" placeholder="e.g. VP of sales at an agency" /></div>' +
      '  </div>' +
      '  <div class="field-row">' +
      '    <div class="field"><label for="clem-tz">Timezone</label>' +
      '      <select id="clem-tz" data-state="profile.timezone">' + tz + '</select>' +
      '      <span class="hint">Detected from your machine. Change it if you are travelling.</span></div>' +
      '    <div class="field"><label for="clem-tone">How much should I say?</label>' +
      '      <select id="clem-tone" data-state="profile.communicationTone">' +
             toneOption('terse', 'Just the answer') + toneOption('balanced', 'Balanced') + toneOption('verbose', 'Show your working') +
      '      </select></div>' +
      '  </div>' +
      '</div>';
  }

  function renderWorkspace() {
    var items = state.workspaces.length === 0
      ? '<li class="empty">No folders yet — add one below, or continue without.</li>'
      : state.workspaces.map(function (folder, i) {
          return '<li>' + ico('folder') + '<span class="path">' + esc(folder) + '</span>' +
            '<button class="btn btn-icon" type="button" data-remove-ws="' + i + '" aria-label="Remove ' + esc(folder) + '">' + ico('x') + '</button></li>';
        }).join('');
    return '' +
      '<div class="step">' +
      '  <div class="eyebrow">' + ico('folder') + '<span>Your folders</span></div>' +
      '  <h1>Where do you work?</h1>' +
      '  <p class="lede">Folders I am allowed to read and write in. Skip this if you only want chat and memory — I will ask again the first time you point me at a file.</p>' +
      '  <ul class="ws-list">' + items + '</ul>' +
      '  <div class="ws-add">' +
      '    <input type="text" data-ws-input placeholder="/Users/you/Projects/example" aria-label="Folder path" />' +
      '    <button class="btn btn-secondary btn-sm" type="button" data-ws-browse>' + ico('folder') + '<span>Browse…</span></button>' +
      '    <button class="btn btn-secondary btn-sm" type="button" data-ws-pick>' + ico('plus') + '<span>Add</span></button>' +
      '  </div>' +
      '</div>';
  }

  function renderLaunch() {
    function row(done, label, value) {
      return '<li>' + ico(done ? 'check-circle' : 'info', done ? 'ico' : 'ico pending') +
        '<span class="what"><b>' + label + '</b> — ' + value + '</span></li>';
    }
    var authDone = state.authChoice !== 'skipped' || already.auth !== 'none';
    var authValue = state.authChoice === 'codex' && state.codexStatus === 'ok' ? 'signed in with ChatGPT'
      : state.authChoice === 'openai' && state.openaiKey ? 'OpenAI API key'
      : already.auth === 'openai' ? 'OpenAI API key already on this machine'
      : already.auth === 'codex' ? 'ChatGPT sign-in already on this machine'
      : 'not set yet — chat will fail until you set it';
    var p = state.profile;
    var profileValue = (p.preferredName || 'no name yet') + ' · ' + (p.timezone || 'no timezone');
    var wsValue = state.workspaces.length === 0 ? 'none — chat and memory only'
      : state.workspaces.length + (state.workspaces.length === 1 ? ' folder' : ' folders');

    return '' +
      '<div class="step">' +
      '  <div class="launch-mark">' + ico('check', 'ico') + '</div>' +
      '  <h1>That&rsquo;s everything.</h1>' +
      '  <p class="lede">I will apply this and open the console. Ask me for something small first — I learn faster from real work than from settings.</p>' +
      '  <div class="summary"><ul>' +
           row(authDone, 'Model', authValue) +
           row(Boolean(p.preferredName || p.timezone), 'You', profileValue) +
           row(state.workspaces.length > 0, 'Folders', wsValue) +
      '  </ul></div>' +
      '  <details class="optional">' +
      '    <summary>' + ico('plug') + '<span>Connect Discord or Composio now (optional)</span></summary>' +
      '    <div class="optional-body">' +
      '      <p class="hint">Neither of these is part of getting started — Gmail, Slack, Notion, Drive, Discord and the rest all connect from <strong>Connect</strong> in the console, where you can see what each one is allowed to do. They are here only so an existing setup can be pasted in once.</p>' +
             renderDiscordFields() + renderComposioFields() +
      '    </div>' +
      '  </details>' +
      '</div>';
  }

  function renderDiscordFields() {
    if (already.discord) {
      return note('note-ok', 'check-circle', 'Discord is already configured on this machine.');
    }
    var verifyBlock = '';
    if (state.discordVerifyStatus === 'ok') {
      verifyBlock = note('note-ok', 'check-circle',
        'Verified ' + esc(state.discordAppName || 'bot') + ' (' + esc(state.discordClientId) + '). ' +
        '<button class="btn btn-link" type="button" data-discord-open>Open the install link</button> to pick a server.');
    } else if (state.discordVerifyStatus === 'error') {
      verifyBlock = note('note-warn', 'triangle-alert', esc(state.discordVerifyMessage || 'Verification failed.'));
    } else if (state.discordVerifyStatus === 'verifying') {
      verifyBlock = note('', 'info', 'Verifying the token with Discord…');
    }
    return '' +
      '<div class="field">' +
      '  <label for="clem-discord-token">Discord bot token</label>' +
      '  <input id="clem-discord-token" type="text" class="secret-input" data-state="discordToken" name="setup-discord-token-no-autofill" value="' + esc(state.discordToken) + '" placeholder="paste a token, or leave blank" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellcheck="false" />' +
      '  <span class="hint">From discord.com/developers/applications. Turn on the message content and server members intents on the Bot tab.</span>' +
      '</div>' +
      '<div class="field">' +
      '  <label for="clem-discord-owner">Your Discord user ID</label>' +
      '  <input id="clem-discord-owner" type="text" data-state="discordOwnerId" value="' + esc(state.discordOwnerId) + '" placeholder="e.g. 123456789012345678" autocomplete="off" spellcheck="false" inputmode="numeric" />' +
      '  <span class="hint">The bot only answers IDs on this list, so without it the bot is online but mute. In Discord: Settings → Advanced → Developer Mode, then right-click your name → Copy User ID.</span>' +
      '</div>' +
      '<div class="field">' +
      '  <button class="btn btn-secondary btn-sm" type="button" data-discord-verify' + (!state.discordToken || state.discordVerifyStatus === 'verifying' ? ' disabled' : '') + '>' +
           ico('check') + '<span>Verify token and build the install link</span></button>' +
      '</div>' + verifyBlock;
  }

  function renderComposioFields() {
    if (already.composio) {
      return note('note-ok', 'check-circle', 'Composio is already configured on this machine.');
    }
    return '' +
      '<div class="field">' +
      '  <label for="clem-composio">Composio API key</label>' +
      '  <input id="clem-composio" type="text" class="secret-input" data-state="composioKey" name="setup-composio-key-no-autofill" value="' + esc(state.composioKey) + '" placeholder="paste a key, or leave blank" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellcheck="false" />' +
      '  <span class="hint">From composio.dev. One key connects Gmail, Slack, Notion, GitHub, Linear, Drive and the CRMs.</span>' +
      '</div>';
  }

  function bind() {
    mainEl.querySelectorAll('input[name="clem-auth"]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (!el.checked) return;
        state.authChoice = el.value;
        render();
      });
    });

    mainEl.querySelectorAll('[data-state]').forEach(function (el) {
      var evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, function () {
        var key = el.getAttribute('data-state');
        if (key.indexOf('profile.') === 0) state.profile[key.slice(8)] = el.value;
        else state[key] = el.value;
        nextBtn.disabled = !canAdvance();
        // The verify button's enabled state tracks the token field.
        var verify = mainEl.querySelector('[data-discord-verify]');
        if (verify) verify.disabled = !state.discordToken || state.discordVerifyStatus === 'verifying';
      });
    });

    var codexBtn = mainEl.querySelector('[data-codex-login]');
    if (codexBtn) {
      codexBtn.addEventListener('click', async function () {
        if (!window.clemmy.setupCodexLogin) return;
        state.codexStatus = 'launching';
        state.codexMessage = '';
        render();
        try {
          var result = await window.clemmy.setupCodexLogin();
          if (result && result.ok) {
            state.codexStatus = 'ok';
            state.codexAccountId = result.accountId || '';
            state.codexMessage = result.reused ? 'Imported the Codex sign-in already on this machine' : 'Signed in with ChatGPT';
          } else {
            state.codexStatus = 'error';
            state.codexMessage = (result && result.error) || 'Sign-in failed.';
          }
        } catch (err) {
          state.codexStatus = 'error';
          state.codexMessage = err && err.message ? err.message : String(err);
        }
        render();
      });
    }

    var pick = mainEl.querySelector('[data-ws-pick]');
    if (pick) {
      pick.addEventListener('click', function () {
        var input = mainEl.querySelector('[data-ws-input]');
        var value = ((input && input.value) || '').trim();
        if (!value) return;
        if (state.workspaces.indexOf(value) === -1) state.workspaces.push(value);
        render();
      });
    }
    var browse = mainEl.querySelector('[data-ws-browse]');
    if (browse) {
      browse.addEventListener('click', async function () {
        if (!window.clemmy.setupPickWorkspaceFolder) return;
        try {
          var result = await window.clemmy.setupPickWorkspaceFolder();
          var chosen = result && result.path ? result.path.trim() : '';
          if (chosen && state.workspaces.indexOf(chosen) === -1) {
            state.workspaces.push(chosen);
            render();
          }
        } catch (err) {
          alert('Folder picker failed: ' + (err && err.message ? err.message : String(err)));
        }
      });
    }
    mainEl.querySelectorAll('[data-remove-ws]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-remove-ws'), 10);
        if (Number.isFinite(i)) state.workspaces.splice(i, 1);
        render();
      });
    });

    var verifyBtn = mainEl.querySelector('[data-discord-verify]');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', async function () {
        var token = (state.discordToken || '').trim();
        if (!token || !window.clemmy.setupDiscordVerify) return;
        state.discordVerifyStatus = 'verifying';
        state.discordVerifyMessage = '';
        render();
        openOptionalPanel();
        try {
          var result = await window.clemmy.setupDiscordVerify(token);
          if (result && result.ok) {
            state.discordClientId = result.clientId;
            state.discordAppName = result.appName || '';
            state.discordInstallUrl = result.installUrl;
            state.discordVerifyStatus = 'ok';
          } else {
            state.discordVerifyStatus = 'error';
            state.discordVerifyMessage = (result && result.error) || 'Verification failed.';
          }
        } catch (err) {
          state.discordVerifyStatus = 'error';
          state.discordVerifyMessage = err && err.message ? err.message : String(err);
        }
        render();
        openOptionalPanel();
      });
    }
    var openBtn = mainEl.querySelector('[data-discord-open]');
    if (openBtn) {
      openBtn.addEventListener('click', async function () {
        if (!state.discordInstallUrl || !window.clemmy.setupOpenExternal) return;
        try { await window.clemmy.setupOpenExternal(state.discordInstallUrl); }
        catch (err) { alert('Could not open your browser: ' + (err && err.message ? err.message : String(err))); }
      });
    }
  }

  /** Re-rendering the launch step collapses the disclosure; if the user was
   *  working inside it, put them back where they were. */
  function openOptionalPanel() {
    var panel = mainEl.querySelector('details.optional');
    if (panel) panel.open = true;
  }

  backBtn.addEventListener('click', function () {
    if (stepIndex > 0) { stepIndex--; render(); }
  });

  skipBtn.addEventListener('click', async function () {
    var needsAuth = already.auth === 'none' && state.authChoice === 'skipped';
    var msg = needsAuth
      ? 'Skip setup without a model sign-in?\\n\\nClementine will open, but every chat and agent call fails until you add an OpenAI key or sign in with ChatGPT from Settings → Models & routing.\\n\\nContinue anyway?'
      : 'Skip the rest of setup?\\n\\nYou can finish from Settings any time.';
    if (!confirm(msg)) return;
    if (window.clemmy.setupSkip) await window.clemmy.setupSkip();
  });

  nextBtn.addEventListener('click', async function () {
    if (!isLast()) {
      if (!canAdvance()) return;
      stepIndex++;
      render();
      return;
    }
    nextBtn.disabled = true;
    nextLabel.textContent = 'Applying…';
    try {
      // 1. Primary auth API key.
      if (state.authChoice === 'openai' && state.openaiKey) {
        await window.clemmy.credentialsSet('openai_api_key', state.openaiKey);
      }
      // 2. Optional extra OpenAI key for embeddings + voice, offered only on
      //    the Codex branch — the API-key branch already covers both.
      if (state.authChoice !== 'openai' && state.extraOpenaiKey) {
        await window.clemmy.credentialsSet('openai_api_key', state.extraOpenaiKey);
      }
      // 3. Discord, if the user opened the optional panel and filled it in.
      if (state.discordToken) {
        await window.clemmy.credentialsSet('discord_bot_token', state.discordToken);
      }
      if (state.discordClientId || state.discordOwnerId) {
        await window.clemmy.setupSaveDiscordConfig({
          clientId: state.discordClientId || '',
          ownerId: state.discordOwnerId ? state.discordOwnerId.trim() : ''
        });
      }
      // 4. Composio.
      if (state.composioKey) {
        await window.clemmy.credentialsSet('composio_api_key', state.composioKey);
      }
      // 5. Workspaces (adding one already present is a no-op).
      for (var i = 0; i < state.workspaces.length; i++) {
        await window.clemmy.setupSaveWorkspace(state.workspaces[i]);
      }
      // 6. Profile — always saved when a timezone is set (we autodetect), so
      //    she at least knows what time it is for you.
      var p = state.profile;
      if (p.preferredName || p.role || p.timezone || p.communicationTone) {
        await window.clemmy.setupSaveProfile(p);
      }
      // 7. Mark complete.
      await window.clemmy.setupComplete({
        configured: {
          auth: state.authChoice === 'skipped' && already.auth !== 'none' ? already.auth : state.authChoice,
          discord: Boolean(state.discordToken) || Boolean(already.discord),
          composio: Boolean(state.composioKey) || Boolean(already.composio),
          workspaceCount: state.workspaces.length,
          profileSet: Boolean(p.preferredName || p.role || p.timezone)
        }
      });
    } catch (err) {
      nextBtn.disabled = false;
      nextLabel.textContent = 'Launch Clementine';
      alert('Setup could not finish: ' + (err && err.message ? err.message : String(err)));
    }
  });

  render();
})();
`;

/** Exported for the test: the wizard never shows more than these, in this
 *  order, and never shows a channel step. */
export const MAX_SETUP_STEPS: SetupStepId[] = ['welcome', 'auth', 'profile', 'workspace', 'launch'];
