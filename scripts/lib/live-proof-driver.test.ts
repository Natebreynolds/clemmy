import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';

// The actual driver is a child process, never imported into the test process.
// Only these fake HTTP endpoints and disposable fixture files are reachable.
const runner = fileURLToPath(new URL('../live-foreground-proof.mts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const secret = 'fixture-only-current-webhook-secret';
const privateResponse = 'fixture-server-private-bytes-must-not-appear';
const fingerprint = 'b'.repeat(64);
const identity = { version: '3.18.42', entry: '/fixture/Clementine.app/daemon/dist/index.js', packaged: true,
  gitSha: 'a'.repeat(40), gitDirty: false, sourceFingerprint: fingerprint, schemaVersion: 95, expectedSchemaVersion: 95,
  daemonProcessId: 1234, daemonInstanceId: 'fixture-proof-daemon', startedAt: '2026-10-17T00:00:00.000Z' };
const nativeWindowsLimit = process.platform === 'win32'
  ? 'This controlled smoke uses POSIX private temp files; native Windows ACL acceptance remains separate.' : false;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 16_384) throw new Error('fixture request exceeded its bounded body');
  }
  return JSON.parse(text) as Record<string, unknown>;
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
}
function fixture(): { home: string; db: Database.Database; report: string; messages: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-live-proof-driver-controlled-'));
  mkdirSync(path.join(home, 'state', 'token-usage'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(home, 'os-home'), { mode: 0o700 });
  const db = new Database(path.join(home, 'state', 'harness.db'));
  db.exec(`CREATE TABLE events (id TEXT UNIQUE, seq INTEGER PRIMARY KEY, session_id TEXT, turn INTEGER,
      role TEXT, type TEXT, data_json TEXT, created_at TEXT, parent_event_id TEXT);
    CREATE TABLE harness_chat_requests (request_id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT);
    CREATE TABLE run_attempts (attempt_id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, started_at TEXT,
      finished_at TEXT, status TEXT, source_user_seq INTEGER);
    CREATE TABLE model_request_provenance (session_id TEXT, source_user_seq INTEGER);
    CREATE TABLE logical_call_settlements (session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT,
      mutating INTEGER, business_call INTEGER, outcome_kind TEXT, execution_kind TEXT, outcome_detail TEXT,
      physical_crossing_count INTEGER, host_crossing_count INTEGER, requires_reconciliation INTEGER);`);
  const report = path.join(home, 'proof-report.json');
  const messages = path.join(home, 'messages.json');
  writeFileSync(messages, JSON.stringify([{ message: 'Complete the controlled proof task.',
    expect: { replyIncludes: ['deliberately absent fixture assertion'], successfulMutations: 0 } }]), { mode: 0o600 });
  return { home, db, report, messages };
}
function configure(f: ReturnType<typeof fixture>, port: number): void {
  writeFileSync(path.join(f.home, '.env'), `WEBHOOK_PORT=${port}\nWEBHOOK_SECRET=fixture-stale-env-secret\n`, { mode: 0o600 });
  writeFileSync(path.join(f.home, 'state', 'secrets-vault.json'),
    JSON.stringify({ version: 'v1', entries: { webhook_secret: secret } }), { mode: 0o600 });
}
function seedAccepted(f: ReturnType<typeof fixture>, requestId: string, options: { complete?: boolean; foreign?: boolean; ambiguous?: boolean } = {}) {
  const sessionId = options.foreign ? 'fixture-foreign-session' : 'fixture-owned-session';
  const runId = 'fixture-owned-run';
  const at = (seconds: number) => new Date(Date.parse(identity.startedAt) + seconds * 1000).toISOString();
  f.db.prepare('INSERT INTO harness_chat_requests VALUES (?, ?, ?)').run(requestId, sessionId, runId);
  const insert = f.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('fixture-source', 17, sessionId, 1, 'user', 'user_input_received', JSON.stringify({ runId, text: 'Complete the controlled proof task.' }), at(0), null);
  if (options.ambiguous) insert.run('fixture-other-source', 18, sessionId, 1, 'user', 'user_input_received', JSON.stringify({ runId }), at(0.1), null);
  if (options.complete) insert.run('fixture-terminal', 19, sessionId, 1, 'system', 'conversation_completed', JSON.stringify({
    sourceUserSeq: 17, terminalKey: 'turn:17',
    presentation: { version: 1, id: 'turn:17:presentation', outcomeId: 'turn:17', audience: 'user', phase: 'final',
      identity: { sessionId, sourceUserSeq: 17, turn: 1 }, status: 'done', kind: 'answer', text: 'Fixture exact result.', resumable: false },
    turnOutcome: { version: 2, id: 'turn:17', status: 'done', resumable: false },
  }), at(2), 'fixture-source');
  f.db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run('fixture-attempt', sessionId, runId,
    at(0), options.complete ? at(3) : null, options.complete ? 'completed' : 'active', 17);
  const usage = (tokens: number, role: string, seconds: number) => ({ at: at(seconds), source: sessionId,
    kind: 'chat', role, model: 'fixture-model', inputTokens: tokens, outputTokens: 1, cachedInputTokens: 0,
    cacheDialect: 'inclusive', trace: { acceptedSource: `${sessionId}:17`, logicalTurnId: 'turn:17', attemptId: 'fixture-attempt' } });
  writeFileSync(path.join(f.home, 'state', 'token-usage', '2026-10-17.ndjson'),
    [usage(11, 'brain', 1), ...(options.complete ? [usage(7, 'reviewer', 2.5)] : [])].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  return { sessionId, runId };
}
async function drive(f: ReturnType<typeof fixture>): Promise<{ code: number | null; stdout: string; stderr: string; report: any }> {
  // Deliberately do not spread process.env: no installed auth, provider keys,
  // proxies, Node preloads or owner-root discovery are inherited.
  const env: NodeJS.ProcessEnv = { CLEMENTINE_HOME: f.home, HOME: path.join(f.home, 'os-home'),
    USERPROFILE: path.join(f.home, 'os-home'), TMPDIR: f.home, TMP: f.home, TEMP: f.home,
    CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', CLEMMY_LOCAL_EMBEDDINGS: 'off',
    NODE_ENV: 'test', PATH: path.dirname(process.execPath) };
  for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxImport, runner, '--home', f.home, '--messages', f.messages,
      '--out', f.report, '--expected-source-fingerprint', fingerprint, '--timeout-ms', '1000'],
    { cwd: f.home, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('controlled proof child could not start')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error('controlled proof child exceeded its bounded lifetime')); return; }
      try { resolve({ code, stdout, stderr, report: JSON.parse(readFileSync(f.report, 'utf8')) }); }
      catch { reject(new Error('controlled proof child did not retain a readable report')); }
    });
  });
}

test('actual proof driver closes failed exact requests without resubmission or ownership adoption', { skip: nativeWindowsLimit, timeout: 120_000 }, async t => {
  for (const mode of ['assertion_failure', 'lost_response', 'malformed_response', 'foreign_receipt', 'ambiguous_source'] as const) {
    await t.test(mode, async () => {
      const f = fixture();
      let posts = 0; let builds = 0; let unexpected = 0;
      let ownRequestId = '';
      const server = createServer((req, res) => { void (async () => {
        if (req.headers.authorization !== `Bearer ${secret}`) { unexpected++; json(res, 401, { error: privateResponse }); return; }
        if (req.method === 'GET' && req.url === '/api/console/build-info') { builds++; json(res, 200, { ...identity, volatileCounter: builds }); return; }
        if (req.method !== 'POST' || req.url !== '/api/harness/chat') { unexpected++; json(res, 404, { error: privateResponse }); return; }
        posts++;
        const input = await body(req);
        assert.equal(input.input, 'Complete the controlled proof task.');
        assert.match(String(input.clientRequestId), /^live-foreground-[a-f0-9-]+$/);
        ownRequestId = String(input.clientRequestId);
        seedAccepted(f, ownRequestId, { complete: mode === 'assertion_failure', foreign: mode === 'foreign_receipt', ambiguous: mode === 'ambiguous_source' });
        if (mode === 'lost_response') { res.destroy(); return; }
        if (mode === 'malformed_response') { res.writeHead(202, { 'content-type': 'application/json' }); res.end(`{"${privateResponse}":`); return; }
        json(res, 202, { sessionId: 'fixture-owned-session', runId: 'fixture-owned-run', clientRequestId: ownRequestId,
          cancelEndpoint: `/api/arbitrary-write?capability=${privateResponse}`, error: privateResponse });
      })().catch(() => { unexpected++; if (!res.headersSent) json(res, 500, { error: privateResponse }); else res.destroy(); }); });
      try {
        configure(f, await listen(server));
        const result = await drive(f);
        assert.equal(result.code, 1);
        assert.equal(posts, 1, 'a failed or lost reply must not submit the task again');
        assert.equal(builds, 2, 'the common window closes after a task failure too');
        assert.equal(unexpected, 0, 'no server-suggested cancel/write route may be called');
        assert.equal(result.report.turns.length, 1);
        const turn = result.report.turns[0];
        assert.equal(turn.requestId, ownRequestId);
        assert.equal(result.report.completed, false);
        assert.equal(result.report.measurementWindow.identityStatus, 'unchanged');
        assert.deepEqual(result.report.buildBefore, identity);
        assert.deepEqual(result.report.buildAfter, identity);
        assert.doesNotMatch(JSON.stringify(result.report) + result.stdout + result.stderr, new RegExp(`${secret}|${privateResponse}|fixture-stale-env-secret`));
        if (mode === 'foreign_receipt' || mode === 'ambiguous_source') {
          assert.equal(turn.taskCloseout.status, 'unavailable');
          assert.equal(turn.taskCloseout.measurement, undefined);
          assert.equal(turn.sourceUserSeq, undefined);
        } else {
          assert.equal(turn.sourceUserSeq, 17);
          assert.equal(turn.taskCloseout.status, 'recorded');
          assert.equal(turn.taskCloseout.measurement.rootSourceUserSeq, 17);
          assert.equal(turn.taskCloseout.measurement.sessionId, 'fixture-owned-session');
          assert.equal(turn.taskCloseout.qualification, 'unqualified');
          assert.equal(turn.taskCloseout.totals, 'recorded_lower_bound');
          assert.equal(turn.taskCloseout.allLegUsageCertified, false);
          assert.equal(turn.taskCloseout.actualBilling, 'not_measured');
          assert.equal(turn.taskCloseout.measurement.promptTokens, mode === 'assertion_failure' ? 18 : 11);
          if (mode === 'assertion_failure') {
            assert.equal(turn.acceptanceVerified, true);
            assert.equal(turn.assertions.passed, false, 'the existing actual response assertion still runs');
            assert.equal(turn.measurement.terminalStatus, 'done', 'existing per-turn facts are retained');
          } else {
            assert.equal(turn.closeoutAcceptance, 'journal_only_response_unconfirmed');
            assert.equal(turn.taskCloseout.measurement.unfinishedAttempts, 1);
            assert.equal(turn.taskCloseout.measurement.taskWallMs, null);
          }
        }
      } finally { await close(server); f.db.close(); rmSync(f.home, { recursive: true, force: true }); }
    });
  }
});

test('actual proof driver refuses redirect before forwarding credentials to another loopback origin', { skip: nativeWindowsLimit, timeout: 40_000 }, async () => {
  const f = fixture();
  let destinationRequests = 0; let posts = 0; let builds = 0;
  const destination = createServer((_req, res) => { destinationRequests++; json(res, 200, { error: privateResponse }); });
  const destinationPort = await listen(destination);
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    if (req.method === 'GET' && req.url === '/api/console/build-info') { builds++; json(res, 200, identity); return; }
    posts++;
    res.writeHead(307, { location: `http://127.0.0.1:${destinationPort}/collect?capability=${privateResponse}` }); res.end();
  });
  try {
    configure(f, await listen(server));
    const result = await drive(f);
    assert.equal(result.code, 1);
    assert.equal(posts, 1);
    assert.equal(builds, 2);
    assert.equal(destinationRequests, 0, 'neither credentials nor the request may follow the redirect');
    assert.equal(result.report.error, 'request_transport_unavailable');
    assert.equal(result.report.turns[0].taskCloseout.status, 'unavailable');
    assert.equal(result.report.measurementWindow.identityStatus, 'unchanged');
    assert.doesNotMatch(JSON.stringify(result.report) + result.stdout + result.stderr, new RegExp(`${secret}|${privateResponse}`));
  } finally { await close(server); await close(destination); f.db.close(); rmSync(f.home, { recursive: true, force: true }); }
});
