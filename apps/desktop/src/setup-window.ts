import { BrowserWindow } from 'electron';
import path from 'node:path';

/**
 * Setup wizard window — the first-run UX.
 *
 * Self-contained HTML rendered into a frameless BrowserWindow. Steps:
 *   0 · Welcome
 *   1 · Auth path (OpenAI API key | Codex OAuth | Skip)
 *   2 · Discord (optional)
 *   3 · Composio (optional)
 *   4 · Workspaces (paths the agent can work in)
 *   5 · User profile (preferred name, tone)
 *   6 · Done — closes the wizard, signals main to boot the daemon
 *
 * IPC contract:
 *   clemmy:setup-status              → { needsSetup, hasKeychain }
 *   clemmy:credentials-list          → CredentialRow[]
 *   clemmy:credentials-set           → { name, value } → CredentialMetadata
 *   clemmy:setup-save-workspace      → { path } → { ok }
 *   clemmy:setup-save-profile        → partial UserProfile → { ok }
 *   clemmy:setup-complete            → { configured } → closes wizard,
 *                                                       writes marker
 *   clemmy:setup-skip                → closes wizard, writes marker
 *                                                       as skipped
 *
 * Style mirrors the operational-console aesthetic so it doesn't feel
 * like a separate product. After "Done", the main process closes
 * this window and launches the daemon + dashboard window.
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
    width: 720,
    height: 620,
    minWidth: 640,
    minHeight: 540,
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
      sandbox: true,
    },
  });
  win.loadURL(buildSetupDataUrl());
  return win;
}

function buildSetupDataUrl(): string {
  const html = renderSetupHtml();
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function renderSetupHtml(): string {
  // Inlined HTML + CSS + JS — same pattern the /console page uses.
  // Talks to the main process via window.clemmy.* (defined in preload).
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
      <span class="step-pill" data-step-pill>STEP 1 OF 6</span>
    </header>

    <main class="wiz-main" data-wiz-main>
      <!-- step content rendered by JS -->
    </main>

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
.wiz {
  display: grid;
  grid-template-rows: 44px 1fr 64px;
  height: 100vh;
}
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
.wiz-main {
  padding: 28px 32px;
  overflow-y: auto;
}
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
.wiz-back { /* on the left */ }
.wiz-skip { color: var(--fg-3); margin-left: auto; }
.wiz-next { color: var(--accent); border-color: var(--accent); }
.wiz-next:hover { background: var(--accent); color: var(--bg-0); }
.wiz-next:disabled { opacity: 0.4; cursor: not-allowed; }
.wiz-next.done { color: var(--accent-2); border-color: var(--accent-2); }
.wiz-next.done:hover { background: var(--accent-2); color: var(--bg-0); }

/* steps */
.step { display: none; }
.step.active { display: block; animation: fade 260ms ease-out; }
@keyframes fade { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: translateY(0);} }

.step h1 {
  margin: 0 0 6px;
  font-size: 18px;
  letter-spacing: 0.04em;
  color: var(--fg);
}
.step .step-tag {
  font-size: 10px; letter-spacing: 0.22em;
  color: var(--accent);
  margin-bottom: 4px;
}
.step .step-desc {
  color: var(--fg-2);
  font-size: 12px;
  line-height: 1.55;
  margin-bottom: 18px;
}

.choice {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
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
.choice-card.selected {
  border-color: var(--accent);
  background: var(--bg-2);
  box-shadow: inset 2px 0 0 var(--accent);
}
.choice-mark {
  width: 16px; height: 16px;
  border: 1px solid var(--line);
  border-radius: 50%;
  margin-top: 2px;
}
.choice-card.selected .choice-mark {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: inset 0 0 0 3px var(--bg-0);
}
.choice-card h3 {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--fg);
  letter-spacing: 0.02em;
}
.choice-card .meta {
  color: var(--fg-3);
  font-size: 11px;
}

.field { margin-bottom: 14px; }
.field label {
  display: block;
  font-size: 10px; letter-spacing: 0.18em;
  color: var(--fg-3);
  margin-bottom: 5px;
}
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

.ws-list {
  list-style: none;
  margin: 0 0 12px; padding: 0;
  border: 1px solid var(--line);
  background: var(--bg-1);
  font-size: 11px;
}
.ws-list li {
  padding: 7px 12px;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ws-list li:last-child { border-bottom: 0; }
.ws-list li.empty { color: var(--fg-mute); justify-content: center; padding: 14px; letter-spacing: 0.1em; }
.ws-list .path { color: var(--fg); word-break: break-all; flex: 1; margin-right: 12px; }
.ws-list .remove {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--accent-fail);
  font: inherit;
  font-size: 10px;
  padding: 2px 8px;
  cursor: pointer;
}
.ws-add {
  display: grid; grid-template-columns: 1fr auto; gap: 6px;
  margin-bottom: 8px;
}
.ws-pick {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  font: inherit; font-size: 10px; letter-spacing: 0.16em;
  padding: 6px 12px;
  cursor: pointer;
}
.ws-pick:hover { background: var(--accent); color: var(--bg-0); }

/* Done step */
.done-summary {
  border: 1px solid var(--line);
  background: var(--bg-1);
  padding: 14px 18px;
  margin-top: 10px;
}
.done-summary h2 {
  margin: 0 0 10px;
  font-size: 12px; letter-spacing: 0.18em;
  color: var(--accent-2);
}
.done-summary ul {
  margin: 0; padding-left: 20px;
  font-size: 12px; color: var(--fg-2);
  line-height: 1.55;
}
.done-pulse {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 18px 0;
}
.done-pulse .ring {
  width: 60px; height: 60px;
  border-radius: 50%;
  border: 2px solid var(--accent-2);
  box-shadow: 0 0 24px rgba(185,255,54,0.4);
  position: relative;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px;
  color: var(--accent-2);
}
.done-pulse .ring::after {
  content: '';
  position: absolute; inset: -4px;
  border-radius: 50%; border: 1px solid var(--accent-2);
  opacity: 0.45;
  animation: pulse 1.6s ease-in-out infinite;
}
`;

const SETUP_JS = `
(function () {
  'use strict';

  const STEPS = 6;
  let currentStep = 0;
  const state = {
    authChoice: 'skipped',   // 'openai' | 'codex' | 'skipped'
    openaiKey: '',
    codexInstructions: '',
    discordToken: '',
    composioKey: '',
    workspaces: [],          // string paths
    profile: {
      preferredName: '',
      role: '',
      timezone: '',
      communicationTone: 'balanced',
      formality: 'professional',
    },
  };

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  }

  const mainEl = document.querySelector('[data-wiz-main]');
  const stepPill = document.querySelector('[data-step-pill]');
  const backBtn = document.querySelector('[data-wiz-back]');
  const skipBtn = document.querySelector('[data-wiz-skip]');
  const nextBtn = document.querySelector('[data-wiz-next]');

  function renderStep() {
    stepPill.textContent = 'STEP ' + (currentStep + 1) + ' OF ' + STEPS;
    backBtn.hidden = currentStep === 0;
    nextBtn.classList.toggle('done', currentStep === STEPS - 1);
    nextBtn.textContent = currentStep === STEPS - 1 ? 'LAUNCH CLEMENTINE ▸' : 'NEXT →';
    let html = '';
    if (currentStep === 0) html = renderWelcome();
    if (currentStep === 1) html = renderAuth();
    if (currentStep === 2) html = renderDiscord();
    if (currentStep === 3) html = renderComposio();
    if (currentStep === 4) html = renderWorkspaces();
    if (currentStep === 5) html = renderProfileAndDone();
    mainEl.innerHTML = html;
    bindStepEvents();
  }

  function renderWelcome() {
    return [
      '<div class="step active">',
      '  <div class="step-tag">WELCOME · 01</div>',
      '  <h1>Hi. I&rsquo;m Clementine.</h1>',
      '  <div class="step-desc">',
      "    I&rsquo;m a local autonomous agent that runs on your machine. Memory that doesn&rsquo;t forget. Workflows you can build with me. Tools, CLIs, MCPs, browser use — everything in one place. <br><br>",
      '    The next few steps configure how I connect. You can skip anything optional and add it later from the Console.',
      '  </div>',
      '  <div class="status-msg ok">Your credentials stay on this machine. Keychain when available, encrypted file vault otherwise. Never .env unless you put them there.</div>',
      '</div>',
    ].join('');
  }

  function renderAuth() {
    function card(value, title, meta) {
      const sel = state.authChoice === value ? 'selected' : '';
      return [
        '<div class="choice-card ' + sel + '" data-choice="' + value + '">',
        '  <div class="choice-mark"></div>',
        '  <div><h3>' + esc(title) + '</h3><div class="meta">' + esc(meta) + '</div></div>',
        '</div>',
      ].join('');
    }
    const openaiField = state.authChoice === 'openai' ? [
      '<div class="field" style="margin-top:14px;">',
      '  <label>OPENAI API KEY</label>',
      '  <input type="password" data-state="openaiKey" value="' + esc(state.openaiKey) + '" placeholder="sk-..." autocomplete="off" spellcheck="false" />',
      '  <span class="hint">Get one at platform.openai.com/api-keys.</span>',
      '</div>',
    ].join('') : '';
    const codexBlock = state.authChoice === 'codex' ? [
      '<div class="field" style="margin-top:14px;">',
      '  <label>CODEX OAUTH</label>',
      '  <div class="status-msg warn">Open a terminal once and run <code>clementine auth login-native</code>, then come back. The OAuth flow opens in your browser; tokens get stored in the same vault.</div>',
      '</div>',
    ].join('') : '';
    return [
      '<div class="step active">',
      '  <div class="step-tag">AUTH · 02</div>',
      '  <h1>How should I authenticate?</h1>',
      '  <div class="step-desc">Pick the runtime auth path. Codex OAuth runs the agent; an OpenAI API key can be added separately for embeddings and live voice.</div>',
      '  <div class="choice">',
           card('openai', 'OpenAI API key runtime', 'Use direct API billing for the agent runtime and optional capabilities.'),
           card('codex',  'Codex OAuth runtime', 'Use your ChatGPT/Codex subscription to run the agent. OpenAI API key remains optional.'),
           card('skipped', 'Skip for now', 'Set up later from Settings → Credentials.'),
      '  </div>',
           openaiField + codexBlock,
      '</div>',
    ].join('');
  }

  function renderDiscord() {
    return [
      '<div class="step active">',
      '  <div class="step-tag">INTEGRATION · 03</div>',
      '  <h1>Discord (optional)</h1>',
      '  <div class="step-desc">If you want to chat with me on Discord, paste the bot token. Skip otherwise.</div>',
      '  <div class="field">',
      '    <label>DISCORD BOT TOKEN</label>',
      '    <input type="password" data-state="discordToken" value="' + esc(state.discordToken) + '" placeholder="paste token or leave blank" autocomplete="off" spellcheck="false" />',
      '    <span class="hint">Create one at discord.com/developers/applications. Bot needs the Message Content + Server Members intents.</span>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderComposio() {
    return [
      '<div class="step active">',
      '  <div class="step-tag">INTEGRATION · 04</div>',
      '  <h1>Composio (optional)</h1>',
      '  <div class="step-desc">Connect external apps (Gmail, Slack, Notion, GitHub, Linear, Drive, CRMs) in one shot. Skip for now if you don&rsquo;t use these.</div>',
      '  <div class="field">',
      '    <label>COMPOSIO API KEY</label>',
      '    <input type="password" data-state="composioKey" value="' + esc(state.composioKey) + '" placeholder="paste key or leave blank" autocomplete="off" spellcheck="false" />',
      '    <span class="hint">Sign up at composio.dev and create an API key.</span>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderWorkspaces() {
    const items = state.workspaces.length === 0
      ? '<li class="empty">— no workspaces yet · pick one below —</li>'
      : state.workspaces.map((p, i) => [
          '<li>',
          '  <span class="path">' + esc(p) + '</span>',
          '  <button class="remove" type="button" data-remove-ws="' + i + '">REMOVE</button>',
          '</li>',
        ].join('')).join('');
    return [
      '<div class="step active">',
      '  <div class="step-tag">WORKSPACE · 05</div>',
      '  <h1>Where do you work?</h1>',
      '  <div class="step-desc">Pick the folders I should be able to read and act in. You can add more later. Skip if you only want chat + memory and not local file access.</div>',
      '  <ul class="ws-list">' + items + '</ul>',
      '  <div class="ws-add">',
      '    <input type="text" data-ws-input placeholder="/Users/you/Projects/example" />',
      '    <button class="ws-pick" type="button" data-ws-pick>+ ADD</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderProfileAndDone() {
    const p = state.profile;
    return [
      '<div class="step active">',
      '  <div class="step-tag">PROFILE · 06</div>',
      '  <h1>How should I talk to you?</h1>',
      '  <div class="step-desc">A little context up-front, so I sound right from message one.</div>',
      '  <div class="field-row">',
      '    <div class="field"><label>PREFERRED NAME</label><input type="text" data-state="profile.preferredName" value="' + esc(p.preferredName) + '" placeholder="e.g. Nate" /></div>',
      '    <div class="field"><label>ROLE</label><input type="text" data-state="profile.role" value="' + esc(p.role) + '" placeholder="e.g. building clemmy" /></div>',
      '  </div>',
      '  <div class="field-row">',
      '    <div class="field"><label>TIMEZONE</label><input type="text" data-state="profile.timezone" value="' + esc(p.timezone) + '" placeholder="America/Los_Angeles" /></div>',
      '    <div class="field"><label>TONE</label>',
      '      <select data-state="profile.communicationTone">',
      '        <option value="terse">terse</option>',
      '        <option value="balanced">balanced</option>',
      '        <option value="verbose">verbose</option>',
      '      </select>',
      '    </div>',
      '  </div>',
      '  <div class="done-summary">',
      '    <h2>READY TO LAUNCH</h2>',
      '    <ul>',
      '      <li>Auth: ' + esc(state.authChoice) + (state.authChoice === 'openai' && state.openaiKey ? ' (key entered)' : '') + '</li>',
      '      <li>Discord: ' + (state.discordToken ? 'token entered' : 'skipped') + '</li>',
      '      <li>Composio: ' + (state.composioKey ? 'key entered' : 'skipped') + '</li>',
      '      <li>Workspaces: ' + state.workspaces.length + '</li>',
      '      <li>Profile: ' + (p.preferredName ? esc(p.preferredName) : 'no preferred name') + ', ' + esc(p.communicationTone) + ' tone</li>',
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
      el.addEventListener('input', () => {
        const key = el.getAttribute('data-state');
        if (key.startsWith('profile.')) {
          state.profile[key.slice(8)] = el.value;
        } else {
          state[key] = el.value;
        }
      });
    });
    const pick = mainEl.querySelector('[data-ws-pick]');
    if (pick) {
      pick.addEventListener('click', () => {
        const input = mainEl.querySelector('[data-ws-input]');
        const value = (input?.value || '').trim();
        if (!value) return;
        if (!state.workspaces.includes(value)) state.workspaces.push(value);
        renderStep();
      });
    }
    mainEl.querySelectorAll('[data-remove-ws]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-remove-ws'), 10);
        if (Number.isFinite(i)) state.workspaces.splice(i, 1);
        renderStep();
      });
    });
  }

  backBtn.addEventListener('click', () => {
    if (currentStep > 0) { currentStep--; renderStep(); }
  });
  skipBtn.addEventListener('click', async () => {
    if (!confirm('Skip the rest of setup?\\nYou can finish from Settings → Credentials later.')) return;
    if (window.clemmy && window.clemmy.setupSkip) {
      await window.clemmy.setupSkip();
    }
  });
  nextBtn.addEventListener('click', async () => {
    if (currentStep < STEPS - 1) {
      currentStep++;
      renderStep();
      return;
    }
    // Final step → apply.
    nextBtn.disabled = true;
    nextBtn.textContent = 'APPLYING…';
    try {
      // 1. Auth
      if (state.authChoice === 'openai' && state.openaiKey) {
        await window.clemmy.credentialsSet('openai_api_key', state.openaiKey);
      }
      // 2. Discord
      if (state.discordToken) {
        await window.clemmy.credentialsSet('discord_bot_token', state.discordToken);
      }
      // 3. Composio
      if (state.composioKey) {
        await window.clemmy.credentialsSet('composio_api_key', state.composioKey);
      }
      // 4. Workspaces — write into the user's .clementine-next config
      for (const ws of state.workspaces) {
        await window.clemmy.setupSaveWorkspace(ws);
      }
      // 5. Profile
      if (state.profile.preferredName || state.profile.role || state.profile.timezone || state.profile.communicationTone) {
        await window.clemmy.setupSaveProfile(state.profile);
      }
      // 6. Mark complete + transition to dashboard
      await window.clemmy.setupComplete({
        configured: {
          auth: state.authChoice,
          discord: Boolean(state.discordToken),
          composio: Boolean(state.composioKey),
          workspaceCount: state.workspaces.length,
          profileSet: Boolean(state.profile.preferredName || state.profile.role),
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
