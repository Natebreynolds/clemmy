#!/usr/bin/env node
// PWA serve smoke. Builds the mobile-web bundle, boots `clementine
// service` against a fresh CLEMENTINE_HOME, then verifies the daemon
// serves the PWA correctly under /m/*:
//
//   1. GET /m and /m/                  → 200 HTML with #app mount point
//   2. GET /m/manifest.webmanifest     → 200 JSON with name "Clementine"
//   3. GET /m/sw.js                    → 200 JS, Cache-Control no-cache, Service-Worker-Allowed: /m/
//   4. GET /m/assets/<hashed>.js       → 200 JS (parsed from index.html)
//   5. GET /m/icon.svg                 → 200 image/svg+xml
//   6. GET /m/auth/status              → 200 JSON (existing API still matches first)
//   7. GET /m/inbox  (Accept: text/html)→ 200 HTML (SPA fallback)
//   8. GET /m/api/whoami               → 401 (auth API not shadowed by static)
//   9. Host=<configured mobile hostname> hides non-/m daemon routes
//  10. Host=<configured mobile hostname> can approve via /m/api/approvals
//
// Run: node scripts/smoke-mobile-pwa.mjs
// Build of the mobile-web bundle happens automatically if missing.

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DAEMON_DIST = path.join(REPO_ROOT, 'dist');
const PWA_ROOT = path.join(REPO_ROOT, 'apps', 'mobile-web');
const PWA_DIST = path.join(PWA_ROOT, 'dist');

let exitCode = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); exitCode = 1; };

console.log('Clementine mobile PWA smoke');

if (!existsSync(path.join(DAEMON_DIST, 'index.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

if (!existsSync(path.join(PWA_DIST, 'index.html'))) {
  console.log('  • building mobile-web…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: PWA_ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('  ✗ mobile-web build failed');
    process.exit(1);
  }
}
ok('mobile-web build present');

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pwa-smoke-'));
const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pwa-smoke-cwd-'));
const stateDir = path.join(tmpHome, '.clementine-next', 'state');
mkdirSync(stateDir, { recursive: true });

const TOKEN = 'pwa-smoke-' + Math.random().toString(36).slice(2, 12);
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
writeFileSync(
  path.join(stateDir, 'mobile-access.json'),
  JSON.stringify({
    version: 1,
    tunnel: {
      id: '00000000-0000-4000-8000-000000000000',
      name: 'pwa-smoke',
      hostname: 'phone-smoke.example.test',
      credentialsFile: '/tmp/not-used.json',
    },
    binary: null,
    autoStart: false,
    status: 'inactive',
    updatedAt: new Date().toISOString(),
  }, null, 2),
  { mode: 0o600 },
);

const PORT = 10000 + Math.floor(Math.random() * 200);

const stagedRoot = path.join(tmpHome, 'daemon-stage');
const stagedDist = path.join(stagedRoot, 'dist');
const stagedPwaDist = path.join(stagedRoot, 'apps', 'mobile-web', 'dist');
mkdirSync(stagedRoot, { recursive: true });
cpSync(DAEMON_DIST, stagedDist, { recursive: true });
mkdirSync(path.dirname(stagedPwaDist), { recursive: true });
cpSync(PWA_DIST, stagedPwaDist, { recursive: true });
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

function requestWithHost(pathname, host, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: options.method ?? 'GET',
      headers: { host, ...(options.headers ?? {}) },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function getWithHost(pathname, host, headers = {}) {
  return requestWithHost(pathname, host, { headers });
}

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
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');

// 1. GET /m and /m/ → index.html with #app
{
  const res = await fetch(`${baseUrl}/m`, { headers: { accept: 'text/html' } });
  const text = await res.text();
  if (res.ok && /<div id="app">/.test(text)) ok('GET /m returns index.html with #app mount point');
  else fail(`GET /m returned ${res.status}; preview: ${text.slice(0, 200)}`);
}
{
  const res = await fetch(`${baseUrl}/m/`, { headers: { accept: 'text/html' } });
  const text = await res.text();
  if (res.ok && /<div id="app">/.test(text)) ok('GET /m/ returns index.html with #app mount point');
  else fail(`GET /m/ returned ${res.status}; preview: ${text.slice(0, 200)}`);
}

// 2. Manifest
{
  const res = await fetch(`${baseUrl}/m/manifest.webmanifest`);
  if (res.ok) {
    const body = await res.json();
    if (body.name === 'Clementine' && body.start_url === '/m/') ok('manifest served + has expected name and start_url');
    else fail(`manifest shape wrong: ${JSON.stringify(body).slice(0, 200)}`);
  } else fail(`manifest returned ${res.status}`);
}

// 3. SW with no-cache + scope header
{
  const res = await fetch(`${baseUrl}/m/sw.js`);
  const cc = res.headers.get('cache-control') ?? '';
  const swa = res.headers.get('service-worker-allowed') ?? '';
  if (res.ok && cc.includes('no-cache') && swa === '/m/') ok('sw.js served with Cache-Control: no-cache and Service-Worker-Allowed: /m/');
  else fail(`sw.js headers wrong: status=${res.status} cache-control=${cc} sw-allowed=${swa}`);
}

// 4. Hashed asset linked from index.html actually exists
{
  const html = await fetch(`${baseUrl}/m/`, { headers: { accept: 'text/html' } }).then((r) => r.text());
  const match = html.match(/\/m\/assets\/[A-Za-z0-9._-]+\.js/);
  if (!match) { fail(`no hashed asset linked from index.html: ${html.slice(0, 300)}`); }
  else {
    const res = await fetch(`${baseUrl}${match[0]}`);
    const ct = res.headers.get('content-type') ?? '';
    if (res.ok && (ct.includes('javascript') || ct.includes('text/javascript'))) ok(`hashed asset ${match[0]} served`);
    else fail(`hashed asset ${match[0]} returned ${res.status} ct=${ct}`);
  }
}

// 5. icon.svg
{
  const res = await fetch(`${baseUrl}/m/icon.svg`);
  const ct = res.headers.get('content-type') ?? '';
  if (res.ok && ct.includes('svg')) ok('icon.svg served with image/svg+xml');
  else fail(`icon.svg returned ${res.status} ct=${ct}`);
}

// 6. /m/auth/status (existing API still wins)
{
  const res = await fetch(`${baseUrl}/m/auth/status`);
  if (res.ok) {
    const body = await res.json();
    if (typeof body.pinConfigured === 'boolean' && typeof body.authenticated === 'boolean') ok('GET /m/auth/status still returns JSON (API not shadowed by static)');
    else fail(`auth/status shape wrong: ${JSON.stringify(body)}`);
  } else fail(`auth/status returned ${res.status}`);
}

// 7. SPA fallback
{
  const res = await fetch(`${baseUrl}/m/inbox`, { headers: { accept: 'text/html' } });
  const text = await res.text();
  if (res.ok && /<div id="app">/.test(text)) ok('GET /m/inbox falls back to index.html (SPA route)');
  else fail(`SPA fallback returned ${res.status}; preview: ${text.slice(0, 200)}`);
}

// 8. Auth API returns 401 (still routed, not shadowed)
{
  const res = await fetch(`${baseUrl}/m/api/whoami`);
  if (res.status === 401) ok('GET /m/api/whoami returns 401 without cookie');
  else fail(`expected 401 for whoami, got ${res.status}`);
}

// 9. Mobile hostname only exposes /m/*.
{
  const mobile = await getWithHost('/m', 'phone-smoke.example.test', { accept: 'text/html' });
  const blocked = await getWithHost('/api/status', 'phone-smoke.example.test');
  if (mobile.status >= 200 && mobile.status < 400 && blocked.status === 404) ok('configured mobile hostname serves /m but hides non-mobile daemon routes');
  else fail(`mobile host boundary wrong: /m=${mobile.status} /api/status=${blocked.status}`);
}

// 10. Mobile approval API stays inside /m on the configured hostname.
{
  const { setPin } = await import(`${stagedDist}/runtime/mobile-pin.js`);
  const { createSession } = await import(`${stagedDist}/runtime/harness/eventlog.js`);
  const approvalRegistry = await import(`${stagedDist}/runtime/harness/approval-registry.js`);
  await setPin('SmokeTest-2024!');
  const login = await requestWithHost('/m/auth/login', 'phone-smoke.example.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ pin: 'SmokeTest-2024!', deviceLabel: 'PWA smoke phone' }),
  });
  const setCookie = login.headers['set-cookie'];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie ?? '').split(';')[0];
  if (login.status !== 200 || !cookie.includes('clem_mobile_session=')) {
    fail(`mobile login on configured host failed: status=${login.status} body=${login.body.slice(0, 160)}`);
  } else {
    const session = createSession({
      id: `pwa-smoke-${Date.now().toString(36)}`,
      kind: 'chat',
      channel: 'mobile',
      title: 'PWA approval smoke',
    });
    const approval = approvalRegistry.register({
      sessionId: session.id,
      channel: 'mobile',
      subject: 'Approve smoke action?',
      tool: 'run_shell_command',
      args: { command: 'echo ok' },
    });
    const list = await requestWithHost('/m/api/approvals', 'phone-smoke.example.test', {
      headers: { cookie, accept: 'application/json' },
    });
    const approve = await requestWithHost(`/m/api/approvals/${approval.approvalId}/approve`, 'phone-smoke.example.test', {
      method: 'POST',
      headers: { cookie, accept: 'application/json' },
    });
    if (list.status === 200 && list.body.includes(approval.approvalId) && approve.status === 200) {
      ok('mobile host approval list + approve work under /m/api/approvals');
    } else {
      fail(`mobile approval API failed: list=${list.status} approve=${approve.status} listBody=${list.body.slice(0, 160)} approveBody=${approve.body.slice(0, 160)}`);
    }
  }
}

console.log(exitCode === 0 ? '\nAll PWA serve checks passed.' : '\nSmoke FAILED.');
process.exit(exitCode);
