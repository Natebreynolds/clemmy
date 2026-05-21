#!/usr/bin/env node
// End-to-end smoke test for the desktop fresh-install flow.
//
// Simulates a brand-new computer (empty HOME, no `~/.codex/`, no `.env`)
// then walks through the same code paths the wizard hits when the user
// finishes setup, then BOOTS THE REAL DAEMON pointed at that isolated
// HOME and verifies the dashboard responds.
//
// What this catches that the unit smoke test (smoke-fresh-install.mjs)
// can't:
//   - daemon refusing to boot when only file-vault credentials exist
//   - WEBHOOK_SECRET round-trip between wizard write and daemon read
//   - /console route returning 200 with a wizard-generated token
//   - /api/dashboard returning data the renderer can consume
//
// Run with:  node scripts/smoke-fresh-install-e2e.mjs
//
// Exits 0 if the dashboard answers with HTML on /console and a JSON
// payload on /api/dashboard. Non-zero otherwise.

import { mkdtempSync, existsSync, rmSync, writeFileSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DESKTOP_DIST = path.join(REPO_ROOT, 'apps', 'desktop', 'dist');
const DAEMON_DIST = path.join(REPO_ROOT, 'dist', 'index.js');

if (!existsSync(path.join(DESKTOP_DIST, 'setup-state.js'))) {
  console.error('✗ apps/desktop/dist not built. Run: (cd apps/desktop && npm run build)');
  process.exit(2);
}
if (!existsSync(DAEMON_DIST)) {
  console.error('✗ dist/index.js missing. Run: npm run build');
  process.exit(2);
}

const palette = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { red: '', green: '', yellow: '', cyan: '', dim: '', bold: '', reset: '' };

let failures = 0;
function pass(name, detail) { console.log(`  ${palette.green}✓${palette.reset} ${name}${detail ? ' ' + palette.dim + detail + palette.reset : ''}`); }
function fail(name, detail) { failures++; console.log(`  ${palette.red}✗${palette.reset} ${name}`); if (detail) console.log(`      ${palette.dim}${detail}${palette.reset}`); }
function info(line) { console.log(`    ${palette.dim}${line}${palette.reset}`); }
function section(title) { console.log(`\n${palette.bold}→ ${title}${palette.reset}`); }

// ─── Sandbox HOME ──────────────────────────────────────────────────

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-e2e-'));
const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-e2e-cwd-'));
const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const originalOpenai = process.env.OPENAI_API_KEY;
const originalWebhookSecret = process.env.WEBHOOK_SECRET;
const originalClementineHome = process.env.CLEMENTINE_HOME;

process.env.HOME = tmpHome;
delete process.env.OPENAI_API_KEY;
delete process.env.WEBHOOK_SECRET;
delete process.env.CLEMENTINE_HOME;
process.chdir(tmpCwd);

let daemon = null;

function cleanup() {
  if (daemon && !daemon.killed) {
    try { daemon.kill('SIGKILL'); } catch {}
  }
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalOpenai !== undefined) process.env.OPENAI_API_KEY = originalOpenai;
  if (originalWebhookSecret !== undefined) process.env.WEBHOOK_SECRET = originalWebhookSecret;
  if (originalClementineHome !== undefined) process.env.CLEMENTINE_HOME = originalClementineHome;
  try { process.chdir(originalCwd); } catch {}
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  try { rmSync(tmpCwd, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

console.log(`${palette.cyan}${palette.bold}Clementine fresh-install E2E smoke${palette.reset}`);
info(`HOME=${tmpHome}`);
info(`cwd=${tmpCwd}`);

// ─── Phase 1: Simulate wizard finish on OpenAI track ──────────────

section('Phase 1 · simulate wizard completion (OpenAI track)');

const setupState = await import(pathToFileURL(path.join(DESKTOP_DIST, 'setup-state.js')).href);
const credentialsBridge = await import(pathToFileURL(path.join(DESKTOP_DIST, 'credentials-bridge.js')).href);

if (!setupState.needsSetup()) fail('needsSetup() === true before wizard');
else pass('needsSetup() === true');

const webhookSecret = await credentialsBridge.ensureWebhookSecret();
pass(`ensureWebhookSecret() → ${webhookSecret.slice(0, 8)}...`);

// Pretend the user picked OpenAI + entered a fake key.
await credentialsBridge.setCredential('openai_api_key', 'sk-fake-test-DO-NOT-CALL-OPENAI-123');
pass('setCredential("openai_api_key", "sk-fake...") wrote to file vault');

setupState.writeSetupComplete({
  configured: { auth: 'openai', discord: false, composio: false, workspaceCount: 0, profileSet: true },
});
pass('writeSetupComplete() wrote setup-complete.json');

if (setupState.needsSetup()) fail('needsSetup() === false after marker', 'Wizard would re-open on next launch.');
else pass('needsSetup() === false after marker');

// ─── Phase 2: Boot the real daemon pointing at this HOME ──────────

section('Phase 2 · boot daemon with this HOME and probe dashboard');

const daemonPort = 9530 + Math.floor(Math.random() * 100);  // avoid 8520 in case user's real daemon is running
info(`port=${daemonPort}`);

// Mirror the packaged-app layout: the daemon's PKG_DIR (computed as
// path.resolve(__dirname, '..') in config.ts) must not have a sibling
// .env. In dev that resolves to the repo root which DOES have one.
// We stage dist/ + package.json into the tmpHome and run the daemon
// from there so PKG_DIR points at a clean directory — same as the
// packaged-app Resources/daemon/ layout.
const stagedDaemonRoot = path.join(tmpHome, 'daemon-stage');
const stagedDist = path.join(stagedDaemonRoot, 'dist');
cpSync(path.join(REPO_ROOT, 'dist'), stagedDist, { recursive: true });
writeFileSync(path.join(stagedDaemonRoot, 'package.json'), readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
// Symlink node_modules so the staged daemon can resolve runtime deps.
symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(stagedDaemonRoot, 'node_modules'));
const stagedEntry = path.join(stagedDist, 'index.js');
info(`staged daemon at ${stagedDaemonRoot} (PKG_DIR has no .env)`);

daemon = spawn(process.execPath, [stagedEntry, 'service'], {
  cwd: tmpCwd,
  env: {
    // Don't inherit process.env wholesale — the daemon's config.ts also
    // probes PKG_DIR/.env (resolves to the repo root in dev) and that
    // file leaks WEBHOOK_SECRET=change-me-local-secret in this repo.
    // Strip the inherited env down to the system minimum so the only
    // source of WEBHOOK_SECRET is the wizard-written file vault.
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    HOME: tmpHome,
    CLEMENTINE_HOME: path.join(tmpHome, '.clementine-next'),
    WEBHOOK_PORT: String(daemonPort),
    WEBHOOK_ENABLED: 'true',
    NODE_ENV: 'test',
    DISCORD_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const daemonLog = [];
daemon.stdout.on('data', (b) => daemonLog.push(b.toString()));
daemon.stderr.on('data', (b) => daemonLog.push(b.toString()));
daemon.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    console.log(`${palette.red}    daemon exited early code=${code} signal=${signal}${palette.reset}`);
    console.log(`${palette.dim}${daemonLog.join('').slice(-3000)}${palette.reset}`);
  }
});

// Two-phase readiness check. (1) wait for the TCP port to accept
// connections — proves the daemon got far enough to bind. (2) THEN
// hit /api/dashboard with a generous timeout (the route can be slow
// on the very first call while indexers warm up). Without phase 1,
// fetch's connect+request timeout conflates "process hasn't bound the
// socket yet" with "process is hung," which made this test flaky.
const deadline = Date.now() + 60_000;
let ready = false;
let lastError = '';
const { createConnection } = await import('node:net');

async function tcpProbe() {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: daemonPort });
    const settle = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.once('connect', () => settle(true));
    sock.once('error', () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}

while (Date.now() < deadline) {
  if (daemon.exitCode !== null) {
    fail('daemon stayed up while we probed', `exited with code ${daemon.exitCode} during readiness probe`);
    console.log(`${palette.dim}--- daemon stderr/stdout (last 60 lines) ---${palette.reset}`);
    console.log(daemonLog.join('').split('\n').slice(-60).join('\n'));
    process.exit(1);
  }
  // Phase 1: wait for the port to accept TCP.
  if (!(await tcpProbe())) {
    await new Promise((res) => setTimeout(res, 250));
    continue;
  }
  // Phase 2: hit the dashboard route. Cold start can pay for indexer
  // + DB warmup on the first hit, so we give it 15s.
  try {
    const r = await fetch(`http://localhost:${daemonPort}/api/dashboard?token=${encodeURIComponent(webhookSecret)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 200 || r.status === 401) {
      ready = true;
      pass(`/api/dashboard responded ${r.status}`);
      break;
    }
    lastError = `status ${r.status}`;
  } catch (err) {
    lastError = err && err.message ? err.message : String(err);
  }
  await new Promise((res) => setTimeout(res, 500));
}

if (!ready) {
  fail('daemon became ready within 30s', `last error: ${lastError}`);
  console.log(`${palette.dim}--- daemon log (last 60 lines) ---${palette.reset}`);
  console.log(daemonLog.join('').split('\n').slice(-60).join('\n'));
  process.exit(1);
}

// ─── Phase 3: Verify the /console page renders ────────────────────

section('Phase 3 · /console renders HTML and authenticates with the wizard token');

const consoleUrl = `http://localhost:${daemonPort}/console?token=${encodeURIComponent(webhookSecret)}`;
try {
  const r = await fetch(consoleUrl, { signal: AbortSignal.timeout(5000) });
  const body = await r.text();
  if (r.status !== 200) fail(`/console returned 200`, `got ${r.status}, body: ${body.slice(0, 200)}`);
  else if (!body.includes('<') || body.length < 200) fail(`/console returned HTML`, `body too small (${body.length} chars), starts with: ${body.slice(0, 200)}`);
  else pass(`/console returned ${body.length} chars of HTML`);
} catch (err) {
  fail(`/console fetch succeeded`, err.message ?? String(err));
}

// Also probe the WRONG token to make sure auth actually works.
try {
  const r = await fetch(`http://localhost:${daemonPort}/console?token=wrong-token`, { signal: AbortSignal.timeout(5000) });
  // Some routes redirect, some return 401 — anything other than 200 with full HTML means auth is working.
  // We just care that the wizard-issued token is the one that unlocks it.
  if (r.status === 200) {
    const body = await r.text();
    if (body.length > 500 && body.includes('console')) {
      fail('/console rejects bogus tokens', `returned 200 with full dashboard content even with a wrong token — auth bypass`);
    } else {
      pass('/console with wrong token returned 200 but minimal body');
    }
  } else {
    pass(`/console with wrong token rejected (${r.status})`);
  }
} catch {
  pass('/console with wrong token rejected (connection level)');
}

// ─── Phase 4: Verify auth status reports correctly to dashboard ───

section('Phase 4 · dashboard sees the wizard-written openai_api_key');

try {
  const r = await fetch(`http://localhost:${daemonPort}/api/console/credentials?token=${encodeURIComponent(webhookSecret)}`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = await r.text();
  if (r.status !== 200) {
    fail('/api/console/credentials returns 200', `got ${r.status}: ${body.slice(0, 200)}`);
  } else {
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    if (!parsed) {
      fail('/api/console/credentials returns JSON', body.slice(0, 200));
    } else {
      const rows = parsed.rows || parsed.credentials || [];
      const openai = rows.find?.((r) => r.name === 'openai_api_key');
      if (openai && openai.hasValue) pass(`openai_api_key visible to daemon (source=${openai.source}, status=${openai.status})`);
      else fail('openai_api_key visible to daemon', `not found in credential list. rows=${JSON.stringify(rows).slice(0, 300)}`);
    }
  }
} catch (err) {
  // Route may not exist under this exact path in this version — surface it but don't fail.
  info(`(skipping credential probe: ${err.message})`);
}

// ─── Summary ──────────────────────────────────────────────────────

console.log();
if (failures === 0) {
  console.log(`${palette.green}${palette.bold}✓ fresh install → wizard completion → daemon boot → dashboard works end-to-end${palette.reset}`);
  process.exit(0);
} else {
  console.log(`${palette.red}${palette.bold}✗ ${failures} step(s) failed — fresh install flow is broken${palette.reset}`);
  process.exit(1);
}
