#!/usr/bin/env node
// Dashboard "Mobile Access" smoke. Boots `clementine service` against a
// fresh CLEMENTINE_HOME, then drives the new /api/console/mobile-access/*
// endpoints with Bearer auth:
//
//   1. GET status returns a coherent empty-state payload
//   2. POST pin saves a PIN, status reports pinConfigured=true
//   3. POST configure rejects garbage hostname
//   4. GET qr returns a local-preview SVG (no hostname yet) and then
//      a public SVG once a hostname override is supplied
//   5. POST tunnel/start refuses with "no tunnel configured" (since we
//      never actually create one — that would require a real CF account)
//
// Run: npm run build && node scripts/smoke-mobile-access-api.mjs

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

console.log('Clementine mobile-access dashboard smoke');

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-ma-smoke-'));
const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-ma-smoke-cwd-'));
const stateDir = path.join(tmpHome, '.clementine-next', 'state');
mkdirSync(stateDir, { recursive: true });

const TOKEN = 'ma-smoke-' + Math.random().toString(36).slice(2, 12);
writeFileSync(
  path.join(stateDir, 'secrets-vault.json'),
  JSON.stringify({ version: 'v1', entries: { openai_api_key: 'sk-fake', webhook_secret: TOKEN } }, null, 2),
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

const PORT = 9900 + Math.floor(Math.random() * 200);

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
child.stderr.on('data', (b) => { stderr += String(b); });

const baseUrl = `http://127.0.0.1:${PORT}`;
const authHeader = { authorization: `Bearer ${TOKEN}` };

async function tcpProbe() {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: PORT });
    const settle = (ready) => { try { sock.destroy(); } catch { /* noop */ } resolve(ready); };
    sock.once('connect', () => settle(true));
    sock.once('error', () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}
async function waitForReady(timeoutMs = 60_000) {
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

process.on('exit', () => {
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1500);
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* best effort */ }
});

if (!(await waitForReady())) {
  console.error('  ✗ daemon did not become ready');
  console.error('--- stderr ---\n' + stderr);
  process.exit(1);
}
ok('daemon booted');

// 1. status
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/status`, { headers: authHeader });
  if (!res.ok) { fail(`status returned ${res.status}`); }
  else {
    const body = await res.json();
    if (typeof body?.detect === 'object' && typeof body?.pin?.configured === 'boolean' && Array.isArray(body?.sessions)) {
      ok('status payload has detect/pin/sessions shape');
    } else fail(`status payload shape wrong: ${JSON.stringify(body).slice(0, 240)}`);
  }
}

// 2. status without auth → 401
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/status`);
  if (res.status === 401) ok('status requires auth (401 without Bearer)');
  else fail(`expected 401 without auth, got ${res.status}`);
}

// 3. POST pin saves a PIN
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/pin`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'SmokeTest-2024' }),
  });
  if (!res.ok) { fail(`pin save returned ${res.status}`); }
  else {
    const body = await res.json();
    if (body.ok && typeof body.revokedSessions === 'number') ok('PIN saved');
    else fail(`pin response shape wrong: ${JSON.stringify(body)}`);
  }
}

// 4. PIN configured reflected in next status
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/status`, { headers: authHeader });
  const body = await res.json();
  if (body?.pin?.configured === true) ok('next status reports pin.configured=true');
  else fail(`expected pin.configured=true, got ${JSON.stringify(body?.pin)}`);
}

// 5. POST pin with bad input → 400
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/pin`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'abc' }),
  });
  if (res.status === 400) ok('pin rejects too-short input (400)');
  else fail(`expected 400 for bad PIN, got ${res.status}`);
}

// 6. POST configure with bad input
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/configure`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ tunnelName: 'bad name', hostname: 'no-dot' }),
  });
  if (res.status === 400) ok('configure rejects bad input (400)');
  else fail(`expected 400 for bad configure, got ${res.status}`);
}

// 7. GET qr without hostname → local-preview SVG
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/qr`, { headers: authHeader });
  if (res.ok) {
    const text = await res.text();
    const mode = res.headers.get('x-target-mode');
    if (text.startsWith('<svg') && text.includes('</svg>') && mode === 'local-preview') {
      ok('qr without hostname returns local-preview SVG');
    } else {
      fail(`qr without hostname returned unexpected shape: status=${res.status} mode=${mode} body=${text.slice(0, 120)}`);
    }
  } else fail(`expected local-preview SVG with no hostname, got ${res.status}`);
}

// 8. GET qr with hostname override → SVG
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/qr?hostname=clem.example.com`, { headers: authHeader });
  if (res.ok) {
    const text = await res.text();
    if (text.startsWith('<svg') && text.includes('</svg>')) ok('qr with hostname override returns an SVG');
    else fail(`qr returned ${res.status} but body is not SVG: ${text.slice(0, 120)}`);
  } else fail(`qr with hostname override returned ${res.status}`);
}

// 9. POST tunnel/start without configured tunnel → 400
{
  const res = await fetch(`${baseUrl}/api/console/mobile-access/tunnel/start`, {
    method: 'POST',
    headers: authHeader,
  });
  if (res.status === 400) {
    const body = await res.json();
    if (/no tunnel configured|cloudflared binary/.test(body.error || '')) ok('tunnel/start refuses without a tunnel');
    else fail(`tunnel/start returned 400 but wrong error: ${JSON.stringify(body)}`);
  } else fail(`expected 400 for unconfigured tunnel start, got ${res.status}`);
}

console.log(exitCode === 0 ? '\nAll mobile-access dashboard checks passed.' : '\nSmoke FAILED.');
process.exit(exitCode);
