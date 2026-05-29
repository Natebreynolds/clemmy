#!/usr/bin/env node
// Send + idempotency + SSE-resume smoke. Boots `clementine service`
// against a fresh CLEMENTINE_HOME, then exercises the new chat-send
// surface end-to-end:
//
//   1. POST /m/api/chat/send with the “runs” control command (a path
//      that doesn't need a real LLM) → 200 with a sessionId.
//   2. Re-POST with the SAME Idempotency-Key → server replays the
//      cached response and sets Idempotent-Replay: 1.
//   3. POST without the Idempotency-Key → 400 MISSING_IDEMPOTENCY_KEY.
//   4. Open the SSE stream for the new session, read the replay frame,
//      then disconnect and reconnect WITH Last-Event-ID — server
//      replays from there (zero events for this short test).
//
// Control commands (parseCommand in gateway/router.ts: 'runs',
// 'tasks', etc.) skip the model entirely, so this smoke runs cleanly
// against sk-fake without a real OpenAI key.
//
// Run: npm run build && node scripts/smoke-mobile-chat-send.mjs

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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

console.log('Clementine mobile chat-send smoke');

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-send-smoke-'));
const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-send-smoke-cwd-'));
const stateDir = path.join(tmpHome, '.clementine-next', 'state');
mkdirSync(stateDir, { recursive: true });

const TOKEN = 'send-smoke-' + Math.random().toString(36).slice(2, 12);
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

const PORT = 10600 + Math.floor(Math.random() * 200);

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

async function tcpProbe() {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: PORT });
    const settle = (r) => { try { sock.destroy(); } catch { /* noop */ } resolve(r); };
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

// Seed PIN, log in.
{
  const seed = spawnSync(process.execPath, [path.join(stagedDist, 'index.js'), 'mobile', 'set-pin', '--pin', 'SmokeTest-2024'], {
    env: { PATH: process.env.PATH, HOME: tmpHome, CLEMENTINE_HOME: path.join(tmpHome, '.clementine-next') },
    stdio: 'pipe',
  });
  if (seed.status !== 0) { fail(`set-pin failed`); process.exit(1); }
  ok('PIN seeded');
}
let cookie = '';
{
  const res = await fetch(`${baseUrl}/m/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'SmokeTest-2024' }),
  });
  const sc = res.headers.get('set-cookie') ?? '';
  if (res.status === 200 && /clem_mobile_session=/.test(sc)) {
    cookie = sc.split(';')[0];
    ok('cookie issued');
  } else { fail(`login failed: ${res.status}`); process.exit(1); }
}

// 1. First send.
const ikey = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let firstResponse = null;
{
  const res = await fetch(`${baseUrl}/m/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'idempotency-key': ikey },
    body: JSON.stringify({ message: 'runs' }),
  });
  if (!res.ok) { fail(`first send returned ${res.status}: ${await res.text()}`); }
  else {
    firstResponse = await res.json();
    if (firstResponse.sessionId && typeof firstResponse.reply === 'string') {
      ok(`first send returned sessionId=${firstResponse.sessionId}, replyLen=${firstResponse.reply.length}`);
    } else {
      fail(`first send shape wrong: ${JSON.stringify(firstResponse).slice(0, 200)}`);
    }
  }
}

// 2. Same Idempotency-Key → cached replay.
{
  const res = await fetch(`${baseUrl}/m/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'idempotency-key': ikey },
    body: JSON.stringify({ message: 'runs' }),
  });
  const headerReplay = res.headers.get('idempotent-replay');
  if (!res.ok) { fail(`replay send returned ${res.status}`); }
  else if (headerReplay !== '1') { fail(`expected Idempotent-Replay: 1 header, got "${headerReplay}"`); }
  else {
    const body = await res.json();
    if (body.sessionId === firstResponse.sessionId && body.reply === firstResponse.reply) {
      ok('same key → cached replay (matched sessionId + reply)');
    } else {
      fail(`replay body diverged: ${JSON.stringify(body)}`);
    }
  }
}

// 3. Missing Idempotency-Key → 400.
{
  const res = await fetch(`${baseUrl}/m/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ message: 'runs' }),
  });
  if (res.status === 400) {
    const body = await res.json();
    if (body.error === 'MISSING_IDEMPOTENCY_KEY') ok('missing Idempotency-Key → 400 MISSING_IDEMPOTENCY_KEY');
    else fail(`expected MISSING_IDEMPOTENCY_KEY, got ${JSON.stringify(body)}`);
  } else { fail(`expected 400, got ${res.status}`); }
}

// 4. SSE Last-Event-ID handling — seed a real harness chat session so
//    we have something to stream. The "runs" control-command path in
//    the gateway answers from the legacy run-events store and never
//    creates a harness session, so we use the same in-process seeding
//    trick as smoke-mobile-chat.mjs.
{
  const seedScript = `
import('${path.join(stagedDist, 'runtime/harness/eventlog.js').replace(/'/g, "\\'")}').then((m) => {
  const sess = m.createSession({ kind: 'chat', channel: 'send-smoke', userId: 'smoke', title: 'Resume target' });
  m.appendEvent({ sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'first' } });
  m.appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'second' } });
  console.log('SESSION=' + sess.id);
});`;
  const seedFile = path.join(tmpHome, 'seed-send.mjs');
  writeFileSync(seedFile, seedScript);
  const seedRun = spawnSync(process.execPath, [seedFile], {
    env: {
      PATH: process.env.PATH,
      HOME: tmpHome,
      CLEMENTINE_HOME: path.join(tmpHome, '.clementine-next'),
      NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
    },
    stdio: 'pipe',
  });
  const sessionId = (seedRun.stdout?.toString().match(/SESSION=(\S+)/) ?? [])[1];
  if (!sessionId) { fail('seed harness session failed'); }
  else {
    ok(`seeded harness session ${sessionId} for SSE test`);
    const res1 = await fetch(`${baseUrl}/m/api/chat/sessions/${sessionId}/stream`, {
      headers: { cookie, accept: 'text/event-stream' },
    });
    if (!res1.ok) { fail(`stream open failed: ${res1.status}`); }
    else {
      const reader1 = res1.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let lastEventId = '';
      let sawReplay = false;
      const deadline = Date.now() + 5_000;
      while (!sawReplay && Date.now() < deadline) {
        const { done, value } = await reader1.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) lastEventId = line.slice(4).trim();
          }
          if (frame.includes('event: replay')) sawReplay = true;
        }
      }
      if (sawReplay && lastEventId) ok(`SSE replay frame emitted id=${lastEventId}`);
      else fail(`replay frame missing or had no id (replay=${sawReplay}, id="${lastEventId}")`);
      try { await reader1.cancel(); } catch { /* ignore */ }

      // Reconnect with Last-Event-ID. We only need to verify the
      // server accepts the request (200) — the in-process actionBus
      // doesn't fire from our seed script, so there's nothing live
      // to receive. Cancel the body immediately on success.
      const headers = { cookie, accept: 'text/event-stream' };
      if (lastEventId) headers['last-event-id'] = lastEventId;
      try {
        const res2 = await fetch(`${baseUrl}/m/api/chat/sessions/${sessionId}/stream`, { headers });
        if (res2.ok) {
          ok('reconnect with Last-Event-ID returns 200');
          try { await res2.body?.cancel(); } catch { /* ignore */ }
        } else { fail(`reconnect returned ${res2.status}`); }
      } catch (err) {
        fail(`reconnect threw: ${err.message}`);
      }
    }
  }
}

console.log(exitCode === 0 ? '\nAll chat-send checks passed.' : '\nSmoke FAILED.');
process.exit(exitCode);
