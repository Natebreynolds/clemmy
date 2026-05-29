#!/usr/bin/env node
// Mobile auth smoke. Boots `clementine service` against a fresh HOME,
// drops a hashed PIN directly into the staged state dir (we don't ship
// a non-interactive `clementine mobile set-pin` arg path through the
// daemon binary — the CLI's password prompt blocks), then runs the
// full curl-equivalent flow against the live webhook server:
//
//   1. PIN not set → /m/auth/login returns 409
//   2. Set PIN → /m/auth/login with right PIN returns 200 + Set-Cookie
//   3. /m/api/whoami with cookie returns 200
//   4. /m/api/whoami without cookie returns 401
//   5. /m/auth/logout clears the cookie + invalidates the session
//   6. /m/api/whoami after logout returns 401
//   7. Five wrong PINs → 5th returns 429 LOCKED_OUT
//
// Run: npm run build && node scripts/smoke-mobile-auth.mjs

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DAEMON_DIST = path.join(REPO_ROOT, 'dist');

if (!existsSync(path.join(DAEMON_DIST, 'index.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

let exitCode = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); exitCode = 1; };

console.log('Clementine mobile auth smoke');

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-auth-'));
const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-auth-cwd-'));
const stateDir = path.join(tmpHome, '.clementine-next', 'state');
mkdirSync(stateDir, { recursive: true });

const TOKEN = 'mobile-auth-smoke-' + Math.random().toString(36).slice(2, 12);
writeFileSync(
  path.join(stateDir, 'secrets-vault.json'),
  JSON.stringify(
    { version: 'v1', entries: { openai_api_key: 'sk-fake', webhook_secret: TOKEN } },
    null,
    2,
  ),
  { mode: 0o600 },
);
writeFileSync(
  path.join(stateDir, 'setup-complete.json'),
  JSON.stringify({
    completedAt: new Date().toISOString(),
    version: 'v1',
    configured: { auth: 'openai', discord: false, composio: false, workspaceCount: 0, profileSet: false },
  }),
);

const PORT = 9700 + Math.floor(Math.random() * 200);

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
    DISCORD_ENABLED: 'false',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
let stdout = '';
child.stderr.on('data', (b) => { stderr += String(b); });
child.stdout.on('data', (b) => { stdout += String(b); });

const baseUrl = `http://127.0.0.1:${PORT}`;

async function tcpProbe() {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: PORT });
    const settle = (ready) => { try { sock.destroy(); } catch { /* noop */ } resolve(ready); };
    sock.once('connect', () => settle(true));
    sock.once('error', () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}

async function waitForPort(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (await tcpProbe()) {
      try {
        const res = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return true;
      } catch { /* still booting */ }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function shutdown() {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
}

process.on('exit', () => {
  shutdown();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* best effort */ }
});
process.on('SIGINT', () => { process.exit(130); });

const ready = await waitForPort();
if (!ready) {
  console.error('  ✗ daemon did not become ready');
  console.error('--- stdout ---\n' + stdout);
  console.error('--- stderr ---\n' + stderr);
  process.exit(1);
}
ok('daemon booted');

// 1. PIN not set → 409
{
  const res = await fetch(`${baseUrl}/m/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'SmokeTest-2024' }),
  });
  if (res.status === 409) ok('login without PIN configured returns 409');
  else fail(`expected 409, got ${res.status}`);
}

// Seed PIN directly via the bundled CLI (so the daemon and CLI agree
// on the state dir). Use --pin to skip the interactive prompt.
{
  const seed = spawn(process.execPath, [path.join(stagedDist, 'index.js'), 'mobile', 'set-pin', '--pin', 'SmokeTest-2024'], {
    cwd: tmpCwd,
    env: {
      PATH: process.env.PATH,
      HOME: tmpHome,
      CLEMENTINE_HOME: path.join(tmpHome, '.clementine-next'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  seed.stdout.on('data', (b) => { out += String(b); });
  seed.stderr.on('data', (b) => { err += String(b); });
  const code = await new Promise((resolve) => seed.on('exit', resolve));
  if (code === 0 && /PIN saved/.test(out)) ok('clementine mobile set-pin --pin SmokeTest-2024 succeeded');
  else fail(`set-pin exited ${code}; out=${out}; err=${err}`);
}

// 2. Login with right PIN → 200 + Set-Cookie
let cookie = '';
{
  const res = await fetch(`${baseUrl}/m/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'SmokeTest-2024', deviceLabel: 'smoke-iphone' }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  if (res.status === 200 && /clem_mobile_session=/.test(setCookie)) {
    cookie = setCookie.split(';')[0];
    ok('login with right PIN returns 200 and sets cookie');
  } else {
    fail(`expected 200+cookie, got ${res.status} setCookie=${setCookie}`);
  }
}

// 3. whoami with cookie → 200
if (cookie) {
  const res = await fetch(`${baseUrl}/m/api/whoami`, { headers: { cookie } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 200 && body.deviceLabel === 'smoke-iphone') ok('whoami with cookie returns 200');
  else fail(`expected 200 with deviceLabel, got ${res.status} ${JSON.stringify(body)}`);
}

// 4. whoami without cookie → 401
{
  const res = await fetch(`${baseUrl}/m/api/whoami`);
  if (res.status === 401) ok('whoami without cookie returns 401');
  else fail(`expected 401, got ${res.status}`);
}

// 5. logout → 200; subsequent whoami with that cookie → 401
if (cookie) {
  const out = await fetch(`${baseUrl}/m/auth/logout`, { method: 'POST', headers: { cookie } });
  if (out.status === 200) ok('logout returns 200');
  else fail(`expected 200, got ${out.status}`);
  const after = await fetch(`${baseUrl}/m/api/whoami`, { headers: { cookie } });
  if (after.status === 401) ok('whoami after logout returns 401 (session invalidated)');
  else fail(`expected 401 after logout, got ${after.status}`);
}

// 6. Five wrong PINs → 5th returns 429
{
  let firstLockout = -1;
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(`${baseUrl}/m/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '000000' }),
    });
    if (res.status === 429 && firstLockout === -1) firstLockout = i + 1;
  }
  if (firstLockout === 5) ok('5th wrong PIN returns 429 LOCKED_OUT');
  else fail(`expected lockout on attempt 5, locked at attempt ${firstLockout}`);
}

shutdown();
console.log(exitCode === 0 ? '\nAll mobile auth checks passed.' : '\nSmoke FAILED.');
process.exit(exitCode);
