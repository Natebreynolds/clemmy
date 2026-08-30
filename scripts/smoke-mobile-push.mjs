#!/usr/bin/env node
// End-to-end Web Push smoke. Boots `clementine service`, seeds a PIN,
// logs in (cookie), subscribes a mock browser to the daemon's push
// endpoint, then enqueues a notification through the durable store API
// and asserts the mock push service receives an encrypted POST with
// VAPID headers. Final step: simulate a 410-Gone response and confirm
// the daemon reaps the subscription.
//
// The push service mock is HTTPS (web-push requires it), with a
// self-signed cert generated on the fly via openssl. We set
// NODE_TLS_REJECT_UNAUTHORIZED=0 in the daemon's env so its outbound
// push fetch trusts the mock cert.
//
// Run: npm run build && node scripts/smoke-mobile-push.mjs

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DAEMON_DIST = path.join(REPO_ROOT, 'dist');

let exitCode = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); exitCode = 1; };
const skip = (m) => console.log(`  • ${m}`);

console.log('Clementine mobile push smoke');

if (!existsSync(path.join(DAEMON_DIST, 'index.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-push-smoke-'));
const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-push-smoke-cwd-'));
const stateDir = path.join(tmpHome, '.clementine-next', 'state');
mkdirSync(stateDir, { recursive: true });

const TOKEN = 'push-smoke-' + Math.random().toString(36).slice(2, 12);
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

// Generate a self-signed cert for the mock push service.
const certDir = path.join(tmpHome, 'mock-cert');
mkdirSync(certDir, { recursive: true });
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
const openssl = spawnSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath,
  '-days', '1', '-subj', '/CN=127.0.0.1',
], { stdio: 'pipe' });
if (openssl.status !== 0) {
  console.error('  ✗ openssl could not generate a self-signed cert; skipping smoke.');
  console.error(openssl.stderr?.toString());
  process.exit(0);
}
ok('self-signed mock-push cert generated');

// Mock push service.
const captures = [];
let mockBehavior = 'ok'; // 'ok' | 'gone'
const mockServer = createHttpsServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      captures.push({
        url: req.url,
        authorization: String(req.headers.authorization ?? ''),
        encoding: req.headers['content-encoding'],
        ttl: req.headers.ttl,
        bodyLen: chunks.reduce((s, c) => s + c.length, 0),
      });
      if (mockBehavior === 'gone') { res.statusCode = 410; res.end('gone'); }
      else { res.statusCode = 201; res.end('ok'); }
    });
  },
);
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
const mockPort = mockServer.address().port;
const mockUrl = `https://127.0.0.1:${mockPort}`;
ok(`mock push service listening at ${mockUrl}`);

const PORT = 10200 + Math.floor(Math.random() * 200);
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
    // Daemon trusts the self-signed mock cert for its outbound push.
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (b) => { stderr += String(b); });

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
  try { mockServer.close(); } catch { /* gone */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* best effort */ }
});

if (!(await waitForReady())) {
  console.error('  ✗ daemon did not become ready');
  console.error('--- stderr ---\n' + stderr);
  process.exit(1);
}
ok('daemon booted');

// 1. Seed a PIN via the bundled CLI.
{
  const seed = spawnSync(process.execPath, [path.join(stagedDist, 'index.js'), 'mobile', 'set-pin', '--pin', 'SmokeTest-2024'], {
    env: {
      PATH: process.env.PATH,
      HOME: tmpHome,
      CLEMENTINE_HOME: path.join(tmpHome, '.clementine-next'),
    },
    stdio: 'pipe',
  });
  if (seed.status === 0) ok('PIN seeded');
  else { fail(`set-pin failed: ${seed.stdout?.toString()} ${seed.stderr?.toString()}`); }
}

// 2. Log in via /m/auth/login → cookie.
let cookie = '';
{
  const res = await fetch(`${baseUrl}/m/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'SmokeTest-2024', deviceLabel: 'push-smoke' }),
  });
  const sc = res.headers.get('set-cookie') ?? '';
  if (res.status === 200 && /clem_mobile_session=/.test(sc)) {
    cookie = sc.split(';')[0];
    ok('mobile session cookie issued');
  } else fail(`expected 200+cookie, got ${res.status} sc=${sc}`);
}

// 3. Fetch the VAPID public key.
let vapidPublicKey = '';
{
  const res = await fetch(`${baseUrl}/m/push/vapid-key`, { headers: { cookie } });
  if (res.ok) {
    const body = await res.json();
    if (typeof body.publicKey === 'string' && body.publicKey.length > 60) {
      vapidPublicKey = body.publicKey;
      ok(`VAPID public key fetched (${vapidPublicKey.length} chars)`);
    } else fail(`VAPID key shape wrong: ${JSON.stringify(body)}`);
  } else fail(`VAPID endpoint returned ${res.status}`);
}

// 4. Register a mock subscription pointing at our HTTPS mock service.
const subEndpoint = `${mockUrl}/sub/${Math.random().toString(36).slice(2, 10)}`;
const subEcdh = createECDH('prime256v1');
subEcdh.generateKeys();
const subP256dh = subEcdh.getPublicKey().toString('base64url');
const subAuth = randomBytes(16).toString('base64url');
{
  const res = await fetch(`${baseUrl}/m/push/subscribe`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: subEndpoint,
      keys: { p256dh: subP256dh, auth: subAuth },
    }),
  });
  if (res.ok) {
    const body = await res.json();
    if (body.ok && body.destinationId) ok(`push subscription registered (destinationId=${body.destinationId})`);
    else fail(`subscribe response wrong: ${JSON.stringify(body)}`);
  } else fail(`subscribe returned ${res.status}`);
}

// 5. Enqueue through the production durable API from a separate process.
// This intentionally exercises the process-shared notification lock and the
// daemon's 15-second boot/timer drain. Direct JSON edits are not a supported
// producer: they bypass frozen destination authority and can manufacture a
// fake approval that the worker must (correctly) discard as stale.
function stageNotification(notification) {
  const notificationsModule = pathToFileURL(path.join(stagedDist, 'runtime', 'notifications.js')).href;
  const enqueue = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `const { addNotification } = await import(${JSON.stringify(notificationsModule)}); addNotification(JSON.parse(process.env.CLEMENTINE_PUSH_SMOKE_NOTIFICATION));`,
  ], {
    cwd: tmpCwd,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      HOME: tmpHome,
      CLEMENTINE_HOME: path.join(tmpHome, '.clementine-next'),
      NODE_ENV: 'test',
      CLEMENTINE_PUSH_SMOKE_NOTIFICATION: JSON.stringify(notification),
    },
    stdio: 'pipe',
  });
  if (enqueue.status !== 0) {
    throw new Error(
      `durable notification enqueue failed: ${enqueue.stdout?.toString() ?? ''} ${enqueue.stderr?.toString() ?? ''}`.trim(),
    );
  }
}

{
  const now = new Date().toISOString();
  const notif = {
    id: `smoke-notif-${Date.now().toString(36)}`,
    kind: 'system',
    title: 'Mobile push smoke',
    body: 'Durable notification delivery test.',
    createdAt: now,
    read: false,
    metadata: { source: 'mobile_push_smoke' },
  };
  try {
    stageNotification(notif);
    ok('test notification + durable delivery job staged');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// 6. Wait for the mock to receive the encrypted push.
{
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && captures.length === 0) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (captures.length > 0) {
    const captured = captures[0];
    if (captured.bodyLen > 0 && /^(WebPush|vapid)/i.test(captured.authorization)) {
      ok(`mock service received push (bodyLen=${captured.bodyLen}, encoding=${captured.encoding}, ttl=${captured.ttl})`);
    } else {
      fail(`push received but headers wrong: auth="${captured.authorization}" len=${captured.bodyLen}`);
    }
  } else {
    fail('mock service did not receive push within 30s');
    console.error('daemon stderr tail:\n' + stderr.split('\n').slice(-30).join('\n'));
  }
}

// 7. Switch the mock to 410, stage another notification, verify reaper.
{
  mockBehavior = 'gone';
  const captureCountBefore = captures.length;
  const now = new Date().toISOString();
  const notif = {
    id: `smoke-gone-${Date.now().toString(36)}`,
    kind: 'system',
    title: 'Mobile push 410 smoke',
    body: 'This delivery should reap the gone subscription.',
    createdAt: now,
    read: false,
    metadata: { source: 'mobile_push_smoke_410' },
  };
  try {
    stageNotification(notif);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // Wait for the gone capture.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && captures.length === captureCountBefore) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (captures.length > captureCountBefore) ok(`mock service received second push (now 410)`);
  else { fail('second push not received'); }

  // Wait a tick for the destinations file to be updated.
  await new Promise((r) => setTimeout(r, 1500));
  const destinationsFile = path.join(stateDir, 'notification-destinations.json');
  const destinations = existsSync(destinationsFile)
    ? JSON.parse(readFileSync(destinationsFile, 'utf-8'))
    : [];
  const stillThere = destinations.find((d) => d.type === 'web_push' && d.pushEndpoint === subEndpoint);
  if (stillThere) fail('destination NOT reaped after 410 (expected pruned)');
  else ok('destination reaped after 410');
}

console.log(exitCode === 0 ? '\nAll mobile push checks passed.' : '\nSmoke FAILED.');
process.exit(exitCode);
