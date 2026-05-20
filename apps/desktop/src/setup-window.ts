import { app, BrowserWindow } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Setup wizard window — the first-run UX.
 *
 * Self-contained HTML rendered into a frameless BrowserWindow. Steps:
 *   0 · Welcome
 *   1 · Auth path (OpenAI API key | Codex OAuth | Skip) — Codex OAuth
 *       runs inline via shell.openExternal + a localhost callback so
 *       the user never sees a terminal.
 *   2 · Optional OpenAI API key (embeddings + live voice)
 *   3 · Discord (optional)
 *   4 · Composio (optional)
 *   5 · Workspaces (folders the agent can read/write, native picker)
 *   6 · User profile (name, role, timezone picker, tone) + Launch
 *
 * IMPORTANT: the wizard is loaded from a `file://` URL backed by a
 * temp HTML file rather than a `data:` URL. Electron 32+ with
 * `sandbox: true` + `contextIsolation: true` silently refused to
 * expose contextBridge for the wizard's `data:` URL, which manifested
 * as `window.clemmy` being undefined and "Cannot read properties of
 * undefined (reading 'setupSaveProfile')" at the end of the flow.
 * Loading from a file:// URL fixes that without giving up isolation.
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

export function createSetupWindow(opts: SetupWindowOpts): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 660,
    minHeight: 560,
    title: 'Clementine — Setup',
    backgroundColor: '#07070a',
    frame: process.platform !== 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    resizable: true,
    fullscreenable: false,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: false. The wizard is trusted internal UI (no remote
      // content) and `sandbox: true` blocked contextBridge from
      // exposing window.clemmy on the data: URL we used to load.
      // Loading from a file:// would have worked even with sandbox,
      // but turning it off here also lets the preload import a few
      // node modules without ceremony if we ever need to.
      sandbox: false,
    },
  });
  win.loadFile(materializeSetupHtmlFile());
  return win;
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

function renderSetupHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" /><title>Clementine — Setup</title>
<style>${SETUP_CSS}</style>
</head><body>
  <div class="wiz">
    <header class="wiz-head">
      <span class="brand-pulse"></span>
      <span class="brand-mark">CLEMENTINE</span>
      <span class="brand-sep">//</span>
      <span class="brand-sub">SETUP</span>
      <span class="step-pill" data-step-pill>STEP 1 OF 7</span>
    </header>

    <main class="wiz-main" data-wiz-main></main>

    <footer class="wiz-foot">
      <button class="wiz-back" data-wiz-back type="button" hidden>← BACK</button>
      <button class="wiz-skip" data-wiz-skip type="button">SKIP SETUP</button>
      <button class="wiz-next" data-wiz-next type="button">NEXT →</button>
    </footer>
  </div>

  <script>${SETUP_JS}</script>
</body></html>`;
}

const SETUP_CSS = `
:root {
  --bg-0:#07070a; --bg-1:#0d0d12; --bg-2:#14141c; --bg-3:#1c1c26;
  --line:#2a2a36; --line-bright:#44445a;
  --fg:#e5e5ea; --fg-2:#a0a0aa; --fg-3:#6b6b78; --fg-mute:#4a4a55;
  --accent:#ff5a35; --accent-2:#b9ff36; --accent-3:#36c5ff;
  --accent-warn:#ffcc33; --accent-fail:#ff3b5a;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg-0); color: var(--fg);
  font: 13px/1.5 var(--mono); letter-spacing: 0.01em;
  -webkit-font-smoothing: antialiased; overflow: hidden;
  background-image: repeating-linear-gradient(to bottom, transparent 0 3px, rgba(255,255,255,0.012) 3px 4px);
}
.wiz { display: grid; grid-template-rows: 44px 1fr 64px; height: 100vh; }
.wiz-head {
  display: flex; align-items: center; gap: 8px;
  padding: 0 18px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  font-size: 11px; letter-spacing: 0.18em; font-weight: 600;
  -webkit-app-region: drag;
}
.brand-pulse {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent-2);
  box-shadow: 0 0 8px rgba(185, 255, 54, 0.55);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.4;transform:scale(0.7);}}
.brand-mark { color: var(--fg); }
.brand-sep  { color: var(--fg-mute); }
.brand-sub  { color: var(--accent); }
.step-pill {
  margin-left: auto;
  font-size: 10px; letter-spacing: 0.18em;
  color: var(--fg-3);
  border: 1px solid var(--line);
  padding: 3px 8px;
  -webkit-app-region: no-drag;
}
.wiz-main { padding: 28px 32px; overflow-y: auto; }
.wiz-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 0 18px;
  background: var(--bg-1);
  border-top: 1px solid var(--line);
}
.wiz-foot button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit; font-size: 10px; letter-spacing: 0.18em;
  padding: 8px 16px;
  cursor: pointer;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.wiz-foot button:hover { color: var(--fg); border-color: var(--line-bright); }
.wiz-skip { color: var(--fg-3); margin-left: auto; }
.wiz-next { color: var(--accent); border-color: var(--accent); }
.wiz-next:hover { background: var(--accent); color: var(--bg-0); }
.wiz-next:disabled { opacity: 0.4; cursor: not-allowed; }
.wiz-next.done { color: var(--accent-2); border-color: var(--accent-2); }
.wiz-next.done:hover { background: var(--accent-2); color: var(--bg-0); }

.step { display: block; animation: fade 260ms ease-out; }
@keyframes fade { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: translateY(0);} }

.step h1 { margin: 0 0 6px; font-size: 18px; letter-spacing: 0.04em; color: var(--fg); }
.step .step-tag { font-size: 10px; letter-spacing: 0.22em; color: var(--accent); margin-bottom: 4px; }
.step .step-desc { color: var(--fg-2); font-size: 12px; line-height: 1.55; margin-bottom: 18px; }

.choice { display: grid; grid-template-columns: 1fr; gap: 10px; }
.choice-card {
  border: 1px solid var(--line);
  background: var(--bg-1);
  padding: 14px 16px;
  cursor: pointer;
  transition: background 100ms, border-color 100ms;
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 12px;
  align-items: start;
}
.choice-card:hover { border-color: var(--line-bright); }
.choice-card.selected { border-color: var(--accent); background: var(--bg-2); box-shadow: inset 2px 0 0 var(--accent); }
.choice-mark { width: 16px; height: 16px; border: 1px solid var(--line); border-radius: 50%; margin-top: 2px; }
.choice-card.selected .choice-mark { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 3px var(--bg-0); }
.choice-card h3 { margin: 0 0 4px; font-size: 13px; color: var(--fg); letter-spacing: 0.02em; }
.choice-card .meta { color: var(--fg-3); font-size: 11px; }

.field { margin-bottom: 14px; }
.field label { display: block; font-size: 10px; letter-spacing: 0.18em; color: var(--fg-3); margin-bottom: 5px; }
.field input[type="text"],
.field input[type="password"],
.field select,
.field textarea {
  width: 100%;
  background: var(--bg-1);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit; font-size: 12px;
  padding: 8px 10px;
  outline: none;
  transition: border-color 120ms;
}
.field input:focus, .field select:focus, .field textarea:focus { border-color: var(--accent); }
.field .hint { display: block; margin-top: 4px; font-size: 10px; color: var(--fg-mute); letter-spacing: 0.02em; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.status-msg { font-size: 11px; margin-top: 8px; letter-spacing: 0.05em; }
.status-msg.ok { color: var(--accent-2); }
.status-msg.err { color: var(--accent-fail); }
.status-msg.warn { color: var(--accent-warn); }

.ws-list { list-style: none; margin: 0 0 12px; padding: 0; border: 1px solid var(--line); background: var(--bg-1); font-size: 11px; }
.ws-list li { padding: 7px 12px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
.ws-list li:last-child { border-bottom: 0; }
.ws-list li.empty { color: var(--fg-mute); justify-content: center; padding: 14px; letter-spacing: 0.1em; }
.ws-list .path { color: var(--fg); word-break: break-all; flex: 1; margin-right: 12px; }
.ws-list .remove {
  background: transparent; border: 1px solid var(--line); color: var(--accent-fail);
  font: inherit; font-size: 10px; padding: 2px 8px; cursor: pointer;
}
.ws-add { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; margin-bottom: 8px; }
.ws-pick, .ws-browse {
  background: transparent; border: 1px solid var(--accent); color: var(--accent);
  font: inherit; font-size: 10px; letter-spacing: 0.16em; padding: 6px 12px; cursor: pointer;
}
.ws-pick:hover, .ws-browse:hover { background: var(--accent); color: var(--bg-0); }
.ws-browse { border-color: var(--accent-3); color: var(--accent-3); }
.ws-browse:hover { background: var(--accent-3); color: var(--bg-0); }

.done-summary { border: 1px solid var(--line); background: var(--bg-1); padding: 14px 18px; margin-top: 10px; }
.done-summary h2 { margin: 0 0 10px; font-size: 12px; letter-spacing: 0.18em; color: var(--accent-2); }
.done-summary ul { margin: 0; padding-left: 20px; font-size: 12px; color: var(--fg-2); line-height: 1.55; }
.done-pulse { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 18px 0; }
.done-pulse .ring {
  width: 60px; height: 60px; border-radius: 50%;
  border: 2px solid var(--accent-2);
  box-shadow: 0 0 24px rgba(185,255,54,0.4);
  position: relative;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; color: var(--accent-2);
}
.done-pulse .ring::after {
  content: ''; position: absolute; inset: -4px;
  border-radius: 50%; border: 1px solid var(--accent-2);
  opacity: 0.45; animation: pulse 1.6s ease-in-out infinite;
}
`;

const SETUP_JS = `
(function () {
  'use strict';

  const STEPS = 7;
  let currentStep = 0;

  // Fail fast if the preload bridge didn't attach. Surfaces the root
  // cause instead of a downstream "Cannot read properties of undefined".
  if (!window.clemmy) {
    document.body.innerHTML = '<div style="padding:32px;color:#ff3b5a;font-family:monospace;line-height:1.6"><h2 style="color:#ff5a35">Setup bridge unavailable</h2><p>Clementine could not attach its preload script. Quit and relaunch the app; if this keeps happening, run <code>clementine setup</code> from a terminal.</p></div>';
    return;
  }

  const detectedTimezone = (function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch { return ''; }
  })();

  const timezoneOptions = (function () {
    try {
      const fn = Intl.supportedValuesOf;
      const list = typeof fn === 'function' ? fn('timeZone') : null;
      if (Array.isArray(list) && list.length > 0) return list;
    } catch { /* fall through */ }
    // Minimal fallback so the picker still works on runtimes without
    // Intl.supportedValuesOf. Order: detected tz first, then common.
    const fallback = ['UTC',
      'America/Los_Angeles','America/Denver','America/Chicago','America/New_York',
      'America/Phoenix','America/Anchorage','America/Honolulu','America/Toronto',
      'America/Vancouver','America/Mexico_City','America/Sao_Paulo','America/Argentina/Buenos_Aires',
      'Europe/London','Europe/Dublin','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Rome',
      'Europe/Amsterdam','Europe/Stockholm','Europe/Warsaw','Europe/Moscow','Europe/Istanbul',
      'Africa/Cairo','Africa/Johannesburg','Africa/Lagos','Africa/Nairobi',
      'Asia/Dubai','Asia/Kolkata','Asia/Bangkok','Asia/Singapore','Asia/Hong_Kong',
      'Asia/Tokyo','Asia/Seoul','Asia/Shanghai','Asia/Taipei','Asia/Jakarta',
      'Australia/Perth','Australia/Sydney','Pacific/Auckland'];
    return fallback;
  })();

  const state = {
    authChoice: 'codex',     // 'openai' | 'codex' | 'skipped'
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
    workspaces: [],
    profile: {
      preferredName: '',
      role: '',
      timezone: detectedTimezone,
      communicationTone: 'balanced',
      formality: 'professional',
    },
  };

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  }

  const mainEl = document.querySelector('[data-wiz-main]');
  const stepPill = document.querySelector('[data-step-pill]');
  const backBtn = document.querySelector('[data-wiz-back]');
  const skipBtn = document.querySelector('[data-wiz-skip]');
  const nextBtn = document.querySelector('[data-wiz-next]');

  function canAdvanceFromCurrentStep() {
    if (currentStep !== 1) return true;
    if (state.authChoice === 'skipped') return true;
    if (state.authChoice === 'openai') return Boolean(state.openaiKey && state.openaiKey.trim());
    if (state.authChoice === 'codex') return state.codexStatus === 'ok';
    return true;
  }

  function updateNavState() {
    nextBtn.disabled = !canAdvanceFromCurrentStep();
  }

  function renderStep() {
    stepPill.textContent = 'STEP ' + (currentStep + 1) + ' OF ' + STEPS;
    backBtn.hidden = currentStep === 0;
    nextBtn.classList.toggle('done', currentStep === STEPS - 1);
    nextBtn.textContent = currentStep === STEPS - 1 ? 'LAUNCH CLEMENTINE ▸' : 'NEXT →';
    let html = '';
    if (currentStep === 0) html = renderWelcome();
    if (currentStep === 1) html = renderAuth();
    if (currentStep === 2) html = renderExtraKey();
    if (currentStep === 3) html = renderDiscord();
    if (currentStep === 4) html = renderComposio();
    if (currentStep === 5) html = renderWorkspaces();
    if (currentStep === 6) html = renderProfileAndDone();
    mainEl.innerHTML = html;
    bindStepEvents();
    updateNavState();
  }

  function renderWelcome() {
    return [
      '<div class="step">',
      '  <div class="step-tag">WELCOME · 01</div>',
      '  <h1>Hi. I&rsquo;m Clementine.</h1>',
      '  <div class="step-desc">',
      "    I&rsquo;m a local autonomous agent that runs on your machine. Memory that doesn&rsquo;t forget. Workflows you can build with me. Tools, CLIs, MCPs, browser use &mdash; everything in one place. <br><br>",
      '    The next few steps configure how I connect. Everything happens inside this window &mdash; no terminal required. You can skip anything optional and add it later from the Console.',
      '  </div>',
      '  <div class="status-msg ok">Your credentials stay on this machine in Clementine&rsquo;s local vault. Never .env unless you put them there.</div>',
      '</div>',
    ].join('');
  }

  function renderAuth() {
    function card(value, title, meta) {
      const sel = state.authChoice === value ? 'selected' : '';
      return '<div class="choice-card ' + sel + '" data-choice="' + value + '">' +
        '<div class="choice-mark"></div>' +
        '<div><h3>' + esc(title) + '</h3><div class="meta">' + esc(meta) + '</div></div>' +
        '</div>';
    }

    const openaiField = state.authChoice === 'openai' ? [
      '<div class="field" style="margin-top:14px;">',
      '  <label>OPENAI API KEY</label>',
      '  <input type="password" data-state="openaiKey" name="setup-openai-key-no-autofill" value="' + esc(state.openaiKey) + '" placeholder="sk-..." autocomplete="new-password" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellcheck="false" />',
      '  <span class="hint">Get one at platform.openai.com/api-keys, or choose Codex OAuth / Skip instead.</span>',
      '</div>',
    ].join('') : '';

    let codexBlock = '';
    if (state.authChoice === 'codex') {
      let statusLine = '';
      if (state.codexStatus === 'launching') {
        statusLine = '<div class="status-msg" style="margin-top:10px;">Checking for an existing Codex login, then opening auth.openai.com if needed. Finish sign-in in your browser.</div>';
      } else if (state.codexStatus === 'ok') {
        const who = state.codexAccountId ? ' (account ' + esc(state.codexAccountId) + ')' : '';
        statusLine = '<div class="status-msg ok" style="margin-top:10px;">' + esc(state.codexMessage || 'Signed in with ChatGPT/Codex') + who + '. Tokens stored locally.</div>';
      } else if (state.codexStatus === 'error') {
        statusLine = '<div class="status-msg err" style="margin-top:10px;">' + esc(state.codexMessage || 'Sign-in failed') + '</div>';
      } else {
        statusLine = '<div class="status-msg warn" style="margin-top:10px;">Sign in before continuing, or choose Skip for now.</div>';
      }
      const btnLabel = state.codexStatus === 'ok' ? 'RE-SIGN IN' : 'SIGN IN WITH CHATGPT';
      const btnDisabled = state.codexStatus === 'launching' ? ' disabled' : '';
      codexBlock = [
        '<div class="field" style="margin-top:14px;">',
        '  <label>CODEX OAUTH</label>',
        '  <div class="hint">Click below &mdash; your browser opens and you sign in with the same account you use for ChatGPT. We catch the redirect on localhost:1455 and store the tokens. No terminal needed.</div>',
        '  <button class="ws-pick" type="button" data-codex-login style="margin-top:8px;"' + btnDisabled + '>' + btnLabel + '</button>',
        statusLine,
        '</div>',
      ].join('');
    }

    return [
      '<div class="step">',
      '  <div class="step-tag">AUTH · 02</div>',
      '  <h1>How should I authenticate?</h1>',
      '  <div class="step-desc">Pick how I get to the model. You can add an extra OpenAI API key on the next step for embeddings and live voice regardless of what you pick here.</div>',
      '  <div class="choice">',
           card('openai', 'OpenAI API key runtime', 'Use direct API billing for the agent runtime.'),
           card('codex',  'Codex OAuth runtime', 'Use your ChatGPT/Codex subscription. Signs in here, no terminal.'),
           card('skipped', 'Skip for now', 'Set up later from Settings → Credentials.'),
      '  </div>',
           openaiField + codexBlock,
      '</div>',
    ].join('');
  }

  function renderExtraKey() {
    // Always shown so users on Codex OAuth or Skip can still wire up
    // embeddings + live voice. The same field will also accept the
    // primary key for users who picked OpenAI on the previous step, but
    // we hide it in that case to avoid asking twice.
    if (state.authChoice === 'openai') {
      return [
        '<div class="step">',
        '  <div class="step-tag">VOICE &amp; EMBEDDINGS · 03</div>',
        '  <h1>Voice and embeddings</h1>',
        '  <div class="step-desc">Your OpenAI API key from the previous step also covers embeddings (vault search) and live voice (Realtime API). Nothing else to do here &mdash; press Next.</div>',
        '  <div class="status-msg ok">Using OpenAI key from previous step.</div>',
        '</div>',
      ].join('');
    }
    return [
      '<div class="step">',
      '  <div class="step-tag">VOICE &amp; EMBEDDINGS · 03</div>',
      '  <h1>Voice and embeddings (optional)</h1>',
      '  <div class="step-desc">An OpenAI API key unlocks two extras that Codex OAuth doesn&rsquo;t cover: <strong>embeddings</strong> (semantic search across your vault) and <strong>live voice</strong> (Realtime API on the home screen). Leave blank to skip &mdash; you can paste one later from Settings → Credentials.</div>',
      '  <div class="field">',
      '    <label>OPENAI API KEY (OPTIONAL)</label>',
      '    <input type="password" data-state="extraOpenaiKey" name="setup-extra-openai-key-no-autofill" value="' + esc(state.extraOpenaiKey) + '" placeholder="sk-..." autocomplete="new-password" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellcheck="false" />',
      '    <span class="hint">Stored in Clementine&rsquo;s local vault. Used only for embeddings + voice; never for chat when you&rsquo;re on Codex.</span>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderDiscord() {
    const verifyDisabled = !state.discordToken || state.discordVerifyStatus === 'verifying';
    let verifiedBlock = '';
    if (state.discordVerifyStatus === 'ok') {
      verifiedBlock = [
        '<div class="status-msg ok" style="margin-top:12px;">Verified: ' + esc(state.discordAppName || 'bot') + ' (' + esc(state.discordClientId) + ')</div>',
        '<div class="field" style="margin-top:14px;">',
        '  <label>YOUR DISCORD USER ID</label>',
        '  <input type="text" data-state="discordOwnerId" value="' + esc(state.discordOwnerId) + '" placeholder="e.g. 123456789012345678" autocomplete="off" spellcheck="false" inputmode="numeric" />',
        '  <span class="hint">Right-click your name in Discord → Copy User ID. Used so only you can DM the bot.</span>',
        '</div>',
        '<div class="field" style="margin-top:14px;">',
        '  <label>BOT INSTALL LINK</label>',
        '  <div class="hint" style="word-break:break-all;">' + esc(state.discordInstallUrl) + '</div>',
        '  <button class="ws-pick" type="button" data-discord-open style="margin-top:8px;">OPEN INSTALL LINK ▸</button>',
        '  <span class="hint" style="display:block;margin-top:6px;">Opens in your default browser so you can pick the server to add the bot to.</span>',
        '</div>',
      ].join('');
    } else if (state.discordVerifyStatus === 'error') {
      verifiedBlock = '<div class="status-msg warn" style="margin-top:12px;">' + esc(state.discordVerifyMessage || 'Verification failed') + '</div>';
    } else if (state.discordVerifyStatus === 'verifying') {
      verifiedBlock = '<div class="status-msg" style="margin-top:12px;">Verifying token with Discord…</div>';
    }
    return [
      '<div class="step">',
      '  <div class="step-tag">INTEGRATION · 04</div>',
      '  <h1>Discord (optional)</h1>',
      '  <div class="step-desc">Paste the bot token, click Verify, then add the bot to a server. Skip otherwise.</div>',
      '  <div class="field">',
      '    <label>DISCORD BOT TOKEN</label>',
      '    <input type="password" data-state="discordToken" name="setup-discord-token-no-autofill" value="' + esc(state.discordToken) + '" placeholder="paste token or leave blank" autocomplete="new-password" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellcheck="false" />',
      '    <span class="hint">Create one at discord.com/developers/applications. Bot needs the Message Content + Server Members intents.</span>',
      '    <button class="ws-pick" type="button" data-discord-verify style="margin-top:8px;"' + (verifyDisabled ? ' disabled' : '') + '>VERIFY TOKEN</button>',
      '  </div>',
           verifiedBlock,
      '</div>',
    ].join('');
  }

  function renderComposio() {
    return [
      '<div class="step">',
      '  <div class="step-tag">INTEGRATION · 05</div>',
      '  <h1>Composio (optional)</h1>',
      '  <div class="step-desc">Connect external apps (Gmail, Slack, Notion, GitHub, Linear, Drive, CRMs) in one shot. Skip for now if you don&rsquo;t use these.</div>',
      '  <div class="field">',
      '    <label>COMPOSIO API KEY</label>',
      '    <input type="password" data-state="composioKey" name="setup-composio-key-no-autofill" value="' + esc(state.composioKey) + '" placeholder="paste key or leave blank" autocomplete="new-password" data-1p-ignore="true" data-lpignore="true" data-form-type="other" spellcheck="false" />',
      '    <span class="hint">Sign up at composio.dev and create an API key.</span>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderWorkspaces() {
    const items = state.workspaces.length === 0
      ? '<li class="empty">— no workspaces yet · add one below —</li>'
      : state.workspaces.map((p, i) =>
          '<li>' +
            '<span class="path">' + esc(p) + '</span>' +
            '<button class="remove" type="button" data-remove-ws="' + i + '">REMOVE</button>' +
          '</li>'
        ).join('');
    return [
      '<div class="step">',
      '  <div class="step-tag">WORKSPACE · 06</div>',
      '  <h1>Where do you work?</h1>',
      '  <div class="step-desc">Pick the folders I should be able to read and act in. Use Browse for the native folder picker, or paste a path. Skip if you only want chat + memory and not local file access.</div>',
      '  <ul class="ws-list">' + items + '</ul>',
      '  <div class="ws-add">',
      '    <input type="text" data-ws-input placeholder="/Users/you/Projects/example" />',
      '    <button class="ws-browse" type="button" data-ws-browse>BROWSE…</button>',
      '    <button class="ws-pick" type="button" data-ws-pick>+ ADD</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderProfileAndDone() {
    const p = state.profile;
    const tzOptions = timezoneOptions.map((tz) => {
      const sel = tz === p.timezone ? ' selected' : '';
      return '<option value="' + esc(tz) + '"' + sel + '>' + esc(tz) + '</option>';
    }).join('');
    const profileSummary = p.preferredName ? esc(p.preferredName) : 'no preferred name';
    const tzSummary = p.timezone ? esc(p.timezone) : 'no timezone';

    return [
      '<div class="step">',
      '  <div class="step-tag">PROFILE · 07</div>',
      '  <h1>How should I talk to you?</h1>',
      '  <div class="step-desc">A little context up-front, so I sound right from message one.</div>',
      '  <div class="field-row">',
      '    <div class="field"><label>PREFERRED NAME</label><input type="text" data-state="profile.preferredName" value="' + esc(p.preferredName) + '" placeholder="e.g. Nate" /></div>',
      '    <div class="field"><label>ROLE</label><input type="text" data-state="profile.role" value="' + esc(p.role) + '" placeholder="e.g. building clemmy" /></div>',
      '  </div>',
      '  <div class="field-row">',
      '    <div class="field">',
      '      <label>TIMEZONE</label>',
      '      <select data-state="profile.timezone">' + tzOptions + '</select>',
      '      <span class="hint">Auto-detected from your machine. Change if travelling.</span>',
      '    </div>',
      '    <div class="field"><label>TONE</label>',
      '      <select data-state="profile.communicationTone">',
      '        <option value="terse"' + (p.communicationTone === 'terse' ? ' selected' : '') + '>terse</option>',
      '        <option value="balanced"' + (p.communicationTone === 'balanced' ? ' selected' : '') + '>balanced</option>',
      '        <option value="verbose"' + (p.communicationTone === 'verbose' ? ' selected' : '') + '>verbose</option>',
      '      </select>',
      '    </div>',
      '  </div>',
      '  <div class="done-summary">',
      '    <h2>READY TO LAUNCH</h2>',
      '    <ul>',
      '      <li>Auth: ' + esc(state.authChoice) + (state.authChoice === 'codex' && state.codexStatus === 'ok' ? ' (signed in)' : '') + (state.authChoice === 'openai' && state.openaiKey ? ' (key entered)' : '') + '</li>',
      '      <li>Voice/embeddings key: ' + (state.authChoice === 'openai' ? 'using primary key' : (state.extraOpenaiKey ? 'entered' : 'skipped')) + '</li>',
      '      <li>Discord: ' + (state.discordToken ? 'token entered' : 'skipped') + '</li>',
      '      <li>Composio: ' + (state.composioKey ? 'key entered' : 'skipped') + '</li>',
      '      <li>Workspaces: ' + state.workspaces.length + '</li>',
      '      <li>Profile: ' + profileSummary + ' · ' + tzSummary + ' · ' + esc(p.communicationTone) + ' tone</li>',
      '    </ul>',
      '  </div>',
      '  <div class="done-pulse"><div class="ring">▶</div></div>',
      '  <div class="status-msg ok" style="text-align:center;">Click LAUNCH CLEMENTINE to apply everything and open the Console.</div>',
      '</div>',
    ].join('');
  }

  function bindStepEvents() {
    mainEl.querySelectorAll('[data-choice]').forEach((el) => {
      el.addEventListener('click', () => {
        state.authChoice = el.getAttribute('data-choice');
        renderStep();
      });
    });
    mainEl.querySelectorAll('[data-state]').forEach((el) => {
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        const key = el.getAttribute('data-state');
        if (key.startsWith('profile.')) {
          state.profile[key.slice('profile.'.length)] = el.value;
        } else {
          state[key] = el.value;
        }
        updateNavState();
      });
    });

    const codexBtn = mainEl.querySelector('[data-codex-login]');
    if (codexBtn) {
      codexBtn.addEventListener('click', async () => {
        if (!window.clemmy.setupCodexLogin) return;
        state.codexStatus = 'launching';
        state.codexMessage = '';
        renderStep();
        try {
          const result = await window.clemmy.setupCodexLogin();
          if (result && result.ok) {
            state.codexStatus = 'ok';
            state.codexAccountId = result.accountId || '';
            state.codexMessage = result.reused ? 'Existing Codex sign-in imported' : 'Signed in with ChatGPT/Codex';
          } else {
            state.codexStatus = 'error';
            state.codexMessage = (result && result.error) || 'Sign-in failed';
          }
        } catch (err) {
          state.codexStatus = 'error';
          state.codexMessage = err && err.message ? err.message : String(err);
        }
        renderStep();
      });
    }

    const pick = mainEl.querySelector('[data-ws-pick]');
    if (pick) {
      pick.addEventListener('click', () => {
        const input = mainEl.querySelector('[data-ws-input]');
        const value = (input && input.value || '').trim();
        if (!value) return;
        if (!state.workspaces.includes(value)) state.workspaces.push(value);
        renderStep();
      });
    }
    const browse = mainEl.querySelector('[data-ws-browse]');
    if (browse) {
      browse.addEventListener('click', async () => {
        if (!window.clemmy.setupPickWorkspaceFolder) return;
        try {
          const result = await window.clemmy.setupPickWorkspaceFolder();
          const chosen = result && result.path ? result.path.trim() : '';
          if (chosen && !state.workspaces.includes(chosen)) {
            state.workspaces.push(chosen);
            renderStep();
          }
        } catch (err) {
          alert('Folder picker failed: ' + (err && err.message ? err.message : String(err)));
        }
      });
    }
    mainEl.querySelectorAll('[data-remove-ws]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-remove-ws'), 10);
        if (Number.isFinite(i)) state.workspaces.splice(i, 1);
        renderStep();
      });
    });

    const verifyBtn = mainEl.querySelector('[data-discord-verify]');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', async () => {
        const token = (state.discordToken || '').trim();
        if (!token || !window.clemmy.setupDiscordVerify) return;
        state.discordVerifyStatus = 'verifying';
        state.discordVerifyMessage = '';
        renderStep();
        try {
          const result = await window.clemmy.setupDiscordVerify(token);
          if (result && result.ok) {
            state.discordClientId = result.clientId;
            state.discordAppName = result.appName || '';
            state.discordInstallUrl = result.installUrl;
            state.discordVerifyStatus = 'ok';
          } else {
            state.discordVerifyStatus = 'error';
            state.discordVerifyMessage = (result && result.error) || 'Verification failed';
          }
        } catch (err) {
          state.discordVerifyStatus = 'error';
          state.discordVerifyMessage = err && err.message ? err.message : String(err);
        }
        renderStep();
      });
    }
    const openBtn = mainEl.querySelector('[data-discord-open]');
    if (openBtn) {
      openBtn.addEventListener('click', async () => {
        if (!state.discordInstallUrl || !window.clemmy.setupOpenExternal) return;
        try { await window.clemmy.setupOpenExternal(state.discordInstallUrl); }
        catch (err) { alert('Could not open browser: ' + (err && err.message ? err.message : String(err))); }
      });
    }
  }

  backBtn.addEventListener('click', () => {
    if (currentStep > 0) { currentStep--; renderStep(); }
  });
  skipBtn.addEventListener('click', async () => {
    if (!confirm('Skip the rest of setup?\\nYou can finish from Settings → Credentials later.')) return;
    if (window.clemmy.setupSkip) await window.clemmy.setupSkip();
  });
  nextBtn.addEventListener('click', async () => {
    if (currentStep < STEPS - 1) {
      if (!canAdvanceFromCurrentStep()) return;
      currentStep++;
      renderStep();
      return;
    }
    nextBtn.disabled = true;
    nextBtn.textContent = 'APPLYING…';
    try {
      // 1. Primary auth API key
      if (state.authChoice === 'openai' && state.openaiKey) {
        await window.clemmy.credentialsSet('openai_api_key', state.openaiKey);
      }
      // 2. Optional extra OpenAI key for embeddings + voice (when on
      //    Codex or skipped). When authChoice === 'openai', the primary
      //    key already covers both — extraOpenaiKey is intentionally
      //    not collected on that branch.
      if (state.authChoice !== 'openai' && state.extraOpenaiKey) {
        await window.clemmy.credentialsSet('openai_api_key', state.extraOpenaiKey);
      }
      // 3. Discord
      if (state.discordToken) {
        await window.clemmy.credentialsSet('discord_bot_token', state.discordToken);
      }
      if (state.discordClientId || state.discordOwnerId) {
        await window.clemmy.setupSaveDiscordConfig({
          clientId: state.discordClientId || '',
          ownerId: state.discordOwnerId ? state.discordOwnerId.trim() : '',
        });
      }
      // 4. Composio
      if (state.composioKey) {
        await window.clemmy.credentialsSet('composio_api_key', state.composioKey);
      }
      // 5. Workspaces
      for (const ws of state.workspaces) {
        await window.clemmy.setupSaveWorkspace(ws);
      }
      // 6. Profile — always save when timezone is set (we autodetect)
      //    so the agent gets at least timezone awareness even when the
      //    user blew through with empty fields.
      const p = state.profile;
      if (p.preferredName || p.role || p.timezone || p.communicationTone) {
        await window.clemmy.setupSaveProfile(p);
      }
      // 7. Mark complete
      await window.clemmy.setupComplete({
        configured: {
          auth: state.authChoice,
          discord: Boolean(state.discordToken),
          composio: Boolean(state.composioKey),
          workspaceCount: state.workspaces.length,
          profileSet: Boolean(p.preferredName || p.role || p.timezone),
        },
      });
    } catch (err) {
      nextBtn.disabled = false;
      nextBtn.textContent = 'LAUNCH CLEMENTINE ▸';
      alert('Setup failed: ' + (err && err.message ? err.message : String(err)));
    }
  });

  renderStep();
})();
`;
