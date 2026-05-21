#!/usr/bin/env node
// Dashboard health smoke. Boots the daemon against a fresh HOME, fetches
// the rendered /console HTML, and runs three classes of checks:
//
//   1. Inline JS parses cleanly (catches stray syntax errors before
//      they surface in DevTools as a blank page).
//   2. The HTML contains the expected anchor elements (update chip,
//      dock cards, transcript wiring) — protects against typos in
//      data-* attributes that would silently disable the JS hooks.
//   3. The render survives a smoke-trip through jsdom (no top-level
//      throws when the script runs in a browser-like env). This is
//      the closest we get to "open it in Chrome" from a Node test.
//
// Use after console.ts changes. Run: node scripts/smoke-dashboard-health.mjs

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

// Use V8's own parser via vm.Script — it'll throw SyntaxError with line/col
// info if the inline JS is malformed. No external dep.
function parseJsForSyntax(code) {
  // Wrap in an IIFE so top-level await / returns parse the same way the
  // browser would treat them (the browser allows top-level await in
  // modules and we don't want false negatives for it). vm.Script gives
  // us classic-script parsing.
  new vm.Script(code, { displayErrors: false });
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DAEMON_DIST = path.join(REPO_ROOT, 'dist');

if (!existsSync(path.join(DAEMON_DIST, 'index.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };

console.log('Clementine dashboard health smoke');

// ─── 1. boot daemon ─────────────────────────────────────────────────

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-dashhealth-'));
const tmpCwd  = mkdtempSync(path.join(os.tmpdir(), 'clemmy-dashhealth-cwd-'));
const stateDir = path.join(tmpHome, '.clementine-next', 'state');
mkdirSync(stateDir, { recursive: true });

const TOKEN = 'dash-health-' + Math.random().toString(36).slice(2, 12);
writeFileSync(path.join(stateDir, 'secrets-vault.json'),
  JSON.stringify({ version: 'v1', entries: { openai_api_key: 'sk-fake', webhook_secret: TOKEN } }, null, 2),
  { mode: 0o600 });
writeFileSync(path.join(stateDir, 'setup-complete.json'),
  JSON.stringify({ completedAt: new Date().toISOString(), version: 'v1',
    configured: { auth: 'openai', discord: false, composio: false, workspaceCount: 0, profileSet: false } }));

const PORT = 9500 + Math.floor(Math.random() * 200);

// Stage daemon into a clean dir so PKG_DIR has no leaky .env. Same
// approach as smoke-fresh-install-e2e.mjs.
const stagedRoot = path.join(tmpHome, 'daemon-stage');
const stagedDist = path.join(stagedRoot, 'dist');
mkdirSync(stagedRoot, { recursive: true });
cpSync(DAEMON_DIST, stagedDist, { recursive: true });
writeFileSync(path.join(stagedRoot, 'package.json'), readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(stagedRoot, 'node_modules'));

const child = spawn(process.execPath, [path.join(stagedDist, 'index.js'), 'service'], {
  cwd: tmpCwd,
  env: {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    HOME: tmpHome,
    CLEMENTINE_HOME: path.join(tmpHome, '.clementine-next'),
    WEBHOOK_PORT: String(PORT),
    WEBHOOK_ENABLED: 'true',
    NODE_ENV: 'test',
    DISCORD_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
let stdout = '';
child.stderr.on('data', (b) => { stderr += String(b); });
child.stdout.on('data', (b) => { stdout += String(b); });
child.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    console.error(`  daemon exited early: code=${code} signal=${signal}`);
  }
});

const dashUrl = `http://localhost:${PORT}`;

// Two-phase readiness: same pattern as smoke-fresh-install-e2e.mjs.
// Phase 1 (TCP probe via net.createConnection) proves the port is
// bound. Phase 2 hits /api/dashboard — cold start can take seconds
// for indexer + DB warmup, so we use a 15s fetch timeout.
const { createConnection } = await import('node:net');
async function tcpProbe() {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: PORT });
    const settle = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.once('connect', () => settle(true));
    sock.once('error', () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}

async function waitForPort(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  let lastStatus = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { ready: false, lastErr: `daemon exited code=${child.exitCode}`, lastStatus: 0 };
    }
    if (!(await tcpProbe())) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    try {
      const res = await fetch(`${dashUrl}/api/dashboard?token=${encodeURIComponent(TOKEN)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      lastStatus = res.status;
      if (res.status === 200 || res.status === 401) return { ready: true };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ready: false, lastErr, lastStatus };
}

let exitCode = 0;
let html = '';
try {
  const { ready, lastErr, lastStatus } = await waitForPort();
  if (!ready) {
    fail(`daemon /api/dashboard never returned 200 on port ${PORT}. lastStatus=${lastStatus} lastErr=${lastErr}`);
    console.error('--- stdout tail ---');
    console.error(stdout.split('\n').slice(-20).join('\n'));
    console.error('--- stderr tail ---');
    console.error(stderr.split('\n').slice(-20).join('\n'));
    throw new Error('daemon-not-ready');
  }
  ok(`daemon bound port ${PORT}`);

  // ─── 2. fetch /console ─────────────────────────────────────────
  const consoleRes = await fetch(`${dashUrl}/console?token=${encodeURIComponent(TOKEN)}`);
  if (consoleRes.status !== 200) {
    fail(`/console returned ${consoleRes.status}`);
    throw new Error('console-not-200');
  }
  html = await consoleRes.text();
  ok(`/console returned 200 (${html.length} bytes of HTML)`);

  // ─── 3. extract inline JS + syntax-check it ────────────────────
  console.log('\n→ Phase 1 · inline JS parses cleanly');
  const scriptBlocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  if (scriptBlocks.length === 0) {
    fail('no inline <script> blocks found');
  } else {
    ok(`found ${scriptBlocks.length} inline <script> block(s) totalling ${scriptBlocks.reduce((a, b) => a + b.length, 0)} chars`);
    for (let i = 0; i < scriptBlocks.length; i += 1) {
      try {
        parseJsForSyntax(scriptBlocks[i]);
        ok(`script #${i + 1}: parses (${scriptBlocks[i].length} chars)`);
      } catch (err) {
        // V8 SyntaxError contains a line:col reference in the message.
        fail(`script #${i + 1} parse error: ${err.message}`);
        const lineMatch = err.stack && err.stack.match(/<anonymous>:(\d+):(\d+)/);
        if (lineMatch) {
          const errLine = Number(lineMatch[1]);
          const lines = scriptBlocks[i].split('\n');
          for (let j = Math.max(0, errLine - 3); j <= Math.min(lines.length - 1, errLine + 1); j += 1) {
            const marker = j + 1 === errLine ? '  >>' : '    ';
            console.error(`${marker} ${j + 1}: ${lines[j].slice(0, 200)}`);
          }
        }
      }
    }
  }

  // ─── 4. expected DOM hooks present ─────────────────────────────
  console.log('\n→ Phase 2 · expected DOM hooks');
  const required = [
    // Update-chip path
    ['data-daemon-version',                     'update chip anchor'],
    // Updater handlers wired via window.clemmy.updater*
    ['updaterStatus',                           'updater bridge call'],
    ['updaterApply',                            'updater apply call'],
    ['updaterRepairOwnership',                  'ownership repair call'],
    // Dock clickable cards (added today)
    ['data-dock-jump="activity"',               'NOW / RECENT dock jump'],
    ['data-dock-jump="workflows"',              'ACTIVE GOAL dock jump'],
    ['data-dock-jump="settings"',               'HEALTH dock jump'],
    ['dock-card-clickable',                     'dock-clickable CSS class'],
    // Live transcript wiring (added today)
    ['__clementineMemoryView',                  'memory sub-view function name'],
    ['data-mem-meetings',                       'meetings sub-view anchor'],
    ['onRecallEvent',                           'recall bridge subscriber'],
    // Make sure the duplicate img is GONE
  ];
  for (const [needle, label] of required) {
    if (html.includes(needle)) ok(`present: ${label} ("${needle}")`);
    else fail(`MISSING: ${label} — searched for "${needle}"`);
  }

  // ─── 5. duplicate pixel image is gone ──────────────────────────
  console.log('\n→ Phase 3 · duplicate Clementine pixel image removed');
  const orbCoreImgRe = /<span\s+class="dock-live-orb-core"[^>]*>\s*<img/i;
  if (orbCoreImgRe.test(html)) fail('dock-live-orb-core still has an <img> child — duplicate not removed');
  else ok('dock-live-orb-core has no <img> child');

  // The other two icon uses (header brand, home-voice portrait) should
  // still be present — we only removed the third (dock) copy.
  const iconUseCount = (html.match(/src="\/console\/icon\.png"/g) || []).length;
  if (iconUseCount === 2) ok(`icon.png used exactly 2x (header brand + home portrait)`);
  else fail(`icon.png used ${iconUseCount}x, expected 2 (was 3 before today's dedup)`);

  // ─── 6. updater wiring uses every updater IPC method ──────────
  // The chip refactor split the inline lambdas into named helper
  // functions (applyUpdate, moveToApplications, repairOwnership,
  // retryCheck), all inside the `if (window.clemmy?.updaterStatus)`
  // block. Capture that whole block so we cover the helpers AND
  // renderUpdaterChip itself.
  console.log('\n→ Phase 4 · updater wiring (all IPC methods referenced)');
  const updaterBlockStart = html.indexOf('updaterStatus');
  const updaterBlockEnd   = html.indexOf('setInterval(renderUpdaterChip', updaterBlockStart);
  const updaterBlock      = updaterBlockStart > 0 && updaterBlockEnd > updaterBlockStart
    ? html.slice(updaterBlockStart, updaterBlockEnd + 200)
    : '';
  if (!updaterBlock) {
    fail('updater wiring block not found');
  } else {
    const needles = ['updaterApply', 'updaterRepairOwnership', 'updaterMoveToApplications', 'updaterCheck', 'onUpdaterEvent', 'renderUpdaterChip'];
    for (const n of needles) {
      if (updaterBlock.includes(n)) ok(`updater wiring references ${n}`);
      else fail(`updater wiring is MISSING reference to ${n}`);
    }
  }

  // ─── 7. new today: visible update CTA + toast layer ───────────
  console.log('\n→ Phase 5 · new dashboard surfaces');
  if (html.includes('data-updater-cta'))  ok('visible update CTA button present');
  else fail('MISSING: data-updater-cta');
  if (html.includes('data-toast-layer'))  ok('toast layer present');
  else fail('MISSING: data-toast-layer');
  if (html.includes('showToast'))         ok('showToast helper defined');
  else fail('MISSING: showToast helper');
  if (html.includes('showError'))         ok('showError helper defined');
  else fail('MISSING: showError helper');
  // The updater chip should no longer trigger a native alert. We allow
  // SOME alerts in the dashboard (haven't migrated them all yet) but
  // the updater-chip ones specifically should be gone.
  const updaterAlerts = (updaterBlock.match(/alert\(/g) || []).length;
  if (updaterAlerts === 0) ok('no native alert() left in updater wiring');
  else fail(`updater wiring still has ${updaterAlerts} alert() call(s)`);

  if (process.exitCode === 1) {
    console.error('\n✗ dashboard health smoke FAILED');
    exitCode = 1;
  } else {
    console.log('\n✓ dashboard renders clean, update button path intact');
    exitCode = 0;
  }
} catch (err) {
  if (String(err.message).match(/daemon-not-ready|console-not-200/)) {
    // Already surfaced.
    exitCode = 1;
  } else {
    console.error('✗ smoke threw:', err);
    exitCode = 1;
  }
} finally {
  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { child.kill('SIGKILL'); } catch {}
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
  process.exit(exitCode);
}
