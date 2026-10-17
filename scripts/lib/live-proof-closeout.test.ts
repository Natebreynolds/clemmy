import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { captureProofTaskCloseout, parseProofHomeAuth, proofAcceptanceMetadata, proofAcceptedSource,
  proofBuildIdentity, proofDesktopCancellationTarget, proofFailureReason, proofLoopbackRequestUrl,
  proofRequestOperation, proofResponseObject, proofTransport, sameProofBuildIdentity } from './live-proof-closeout.js';

test('installed proof auth uses the selected first-party vault override and never exposes malformed credential bytes', () => {
  const envText = 'WEBHOOK_PORT=8520\nWEBHOOK_SECRET="fixture-old-env-secret"\n';
  const vaultText = JSON.stringify({ version: 'v1', entries: { webhook_secret: 'fixture-current-vault-secret', unrelated: 'fixture-unused' } });
  assert.deepEqual(parseProofHomeAuth({ envText, vaultText }), { port: 8520, secret: 'fixture-current-vault-secret' });
  assert.deepEqual(parseProofHomeAuth({ vaultText }), { port: 8420, secret: 'fixture-current-vault-secret' });
  assert.deepEqual(parseProofHomeAuth({ envText, vaultText: '{"version":"v1","entries":{}}' }),
    { port: 8520, secret: 'fixture-old-env-secret' });
  for (const invalid of ['{"fixture-secret-that-must-not-leak":', 'null', '[]', '{"version":"v2","entries":{}}',
    '{"version":"v1","entries":{"webhook_secret":42}}']) {
    assert.throws(() => parseProofHomeAuth({ envText, vaultText: invalid }), error => {
      assert.doesNotMatch(String(error), /fixture-secret-that-must-not-leak|fixture-old-env-secret|fixture-current-vault-secret/);
      return /vault.*malformed/.test(String(error));
    });
  }
  for (const port of ['0', '65536', '8420@remote.example', 'http://remote.example', '-1']) {
    assert.throws(() => parseProofHomeAuth({ envText: `WEBHOOK_SECRET=fixture\nWEBHOOK_PORT=${port}` }), /invalid loopback/);
  }
});

test('installed proof routes keep authorization on one literal loopback origin', () => {
  const base = 'http://127.0.0.1:8520';
  assert.equal(proofLoopbackRequestUrl(base, '/api/console/build-info'), `${base}/api/console/build-info`);
  assert.equal(proofLoopbackRequestUrl('http://[::1]:8520', '/api/harness/chat'), 'http://[::1]:8520/api/harness/chat');
  for (const route of ['https://remote.example/collect', '//remote.example/collect', '/\\remote.example/collect',
    'api/harness/chat', '/api/console/build-info\n', '/api/harness/chat#fragment']) {
    assert.throws(() => proofLoopbackRequestUrl(base, route), /loopback origin/);
  }
  for (const origin of ['https://remote.example', 'http://127.0.0.1.remote.example', 'http://user:pass@127.0.0.1:8520',
    'http://localhost:8520', 'file:///tmp', `${base}/other`, `${base}/?token=fixture`]) {
    assert.throws(() => proofLoopbackRequestUrl(origin, '/api/console/build-info'), /loopback origin/);
  }
});

test('installed proof response failures expose only reason codes and successful acceptance metadata is allowlisted', async () => {
  const privateBytes = 'fixture-private-response-and-capability';
  const payload = { error: privateBytes, cancelEndpoint: `/api/settings/write?capability=${privateBytes}`,
    sessionId: 'fixture-session', runId: 'fixture-run', clientRequestId: 'fixture-request' };
  assert.equal(proofAcceptanceMetadata({ status: 500, body: payload, clientRequestId: 'fixture-request', mobile: false }), null);
  assert.equal(proofAcceptanceMetadata({ status: 202, body: payload, clientRequestId: 'different-request', mobile: false }), null);
  const accepted = proofAcceptanceMetadata({ status: 202, body: { ...payload, arbitrary: privateBytes,
    attemptId: 'fixture-attempt', runScopeId: 'fixture-session::brain:fixture-run', replayed: false },
    clientRequestId: 'fixture-request', mobile: false });
  assert.deepEqual(accepted, { sessionId: 'fixture-session', runId: 'fixture-run', clientRequestId: 'fixture-request',
    attemptId: 'fixture-attempt', runScopeId: 'fixture-session::brain:fixture-run', replayed: false });
  assert.doesNotMatch(JSON.stringify(accepted), new RegExp(privateBytes));
  assert.equal(proofAcceptanceMetadata({ status: 202, body: { ...payload, accepted: true },
    clientRequestId: 'fixture-mobile-request', mobile: true })?.accepted, true);
  for (const invoke of [
    () => proofTransport(async () => { throw new Error(`fetch failed ${privateBytes}`); }),
    () => proofResponseObject(async () => { throw new SyntaxError(`Unexpected token ${privateBytes}`); }),
    () => proofResponseObject(async () => [privateBytes]),
  ]) await assert.rejects(invoke, error => {
    assert.doesNotMatch(String(error), new RegExp(privateBytes));
    assert.match(proofFailureReason(error), /request_transport_unavailable|response_json_unavailable|response_object_required/);
    return true;
  });
  assert.equal(proofFailureReason(new Error(privateBytes)), 'proof_evidence_unavailable');
  assert.equal(proofRequestOperation(`/api/console/harness-sessions/fixture/cancel?attemptId=fixture&capability=${privateBytes}`), 'desktop_exact_cancel');
  assert.equal(proofRequestOperation(`/arbitrary/${privateBytes}`), 'other_application_request');
});

test('installed proof timeout cancellation derives only the exact owned durable active attempt', () => {
  const receipt = { sessionId: 'fixture-session', runId: 'fixture-run' };
  const source = { sessionId: receipt.sessionId, seq: 17 };
  const attempt = { attempt_id: 'fixture-attempt', session_id: receipt.sessionId, run_id: receipt.runId,
    source_user_seq: source.seq, status: 'active', finished_at: null };
  const target = proofDesktopCancellationTarget({ receipt, source, attempts: [attempt] });
  assert.deepEqual(target, { attemptId: 'fixture-attempt', runScopeId: 'fixture-session::brain:fixture-run',
    route: '/api/console/harness-sessions/fixture-session/cancel?attemptId=fixture-attempt&runScopeId=fixture-session%3A%3Abrain%3Afixture-run' });
  for (const attempts of [[], [attempt, { ...attempt, attempt_id: 'second-attempt' }],
    [{ ...attempt, session_id: 'foreign' }], [{ ...attempt, run_id: 'other-run' }],
    [{ ...attempt, source_user_seq: 18 }], [{ ...attempt, status: 'completed' }],
    [{ ...attempt, finished_at: '2026-10-17T00:00:01.000Z' }], [{ ...attempt, attempt_id: null }]]) {
    assert.equal(proofDesktopCancellationTarget({ receipt, source, attempts }), null);
  }
  assert.equal(proofDesktopCancellationTarget({ receipt, source: { ...source, sessionId: 'foreign' }, attempts: [attempt] }), null);
  assert.equal(proofDesktopCancellationTarget({ receipt, source: { ...source, seq: 0 }, attempts: [attempt] }), null);
  // There is intentionally no server-provided endpoint argument that could
  // turn a deadline into a different same-origin write.
  assert.equal(proofRequestOperation(target!.route), 'desktop_exact_cancel');
});

const build = { version: '3.18.42', entry: '/fixture/Clementine.app/daemon/dist/index.js', packaged: true,
  gitSha: 'a'.repeat(40), gitDirty: false, sourceFingerprint: 'b'.repeat(64), schemaVersion: 95, expectedSchemaVersion: 95,
  daemonProcessId: 123, daemonInstanceId: 'fixture-process-generation', startedAt: '2026-10-17T00:00:00.000Z' };
test('installed proof compares exact stable build and process identity while ignoring volatile response fields', () => {
  const before = proofBuildIdentity({ ...build, cutoverHoldHeartbeatCount: 1, arbitrary: 'fixture-extra-response' });
  const after = proofBuildIdentity({ ...build, cutoverHoldHeartbeatCount: 99, arbitrary: { changed: true } });
  assert.deepEqual(before, build);
  assert.equal(sameProofBuildIdentity(before, after), true);
  for (const delta of [{ version: '3.18.43' }, { gitSha: 'c'.repeat(40) }, { sourceFingerprint: 'd'.repeat(64) },
    { daemonProcessId: 124 }, { daemonInstanceId: 'different-generation' }, { startedAt: '2026-10-17T00:01:00.000Z' },
    { schemaVersion: 96, expectedSchemaVersion: 96 }, { entry: '/other/daemon.js' }, { gitDirty: true }]) {
    assert.equal(sameProofBuildIdentity(before, proofBuildIdentity({ ...build, ...delta })), false);
  }
  for (const key of Object.keys(build)) {
    const incomplete: Record<string, unknown> = { ...build }; delete incomplete[key];
    assert.throws(() => proofBuildIdentity(incomplete), /complete ready/);
  }
  assert.throws(() => proofBuildIdentity({ ...build, expectedSchemaVersion: 96 }), /complete ready/);
});

test('installed proof source recovery uses its exact request journal, never a latest source or conflicting return', () => {
  const receipt = { sessionId: 'fixture-selected-successor', runId: 'fixture-run' };
  const source = { seq: 17, session_id: receipt.sessionId, role: 'user', data_json: JSON.stringify({ runId: receipt.runId }) };
  assert.deepEqual(proofAcceptedSource({ receipt, sources: [source] }), { seq: 17, sessionId: receipt.sessionId });
  assert.equal(proofAcceptedSource({ receipt, sources: [] }), null);
  for (const mutation of [
    { sources: [source, { ...source, seq: 18 }] }, { sources: [{ ...source, role: 'system' }] },
    { sources: [{ ...source, data_json: '{"runId":"foreign"}' }] },
    { sources: [{ ...source, data_json: '{"runId":"fixture-run","synthetic":true}' }] },
    { sources: [{ ...source, session_id: 'another-owner' }] }, { sources: [source], knownSourceUserSeq: 16 },
    { sources: [source], returned: { sessionId: receipt.sessionId, runId: 'another-run' } },
  ]) assert.throws(() => proofAcceptedSource({ receipt, ...mutation }), /proof request|accepted human source/);
});

test('final proof closeout remeasures canonical late review usage and preserves unfinished-task lower bounds', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-proof-closeout-'));
  // No runtime config/credentials are imported before this isolated binding.
  const previousHome = process.env.CLEMENTINE_HOME;
  process.env.CLEMENTINE_HOME = home;
  mkdirSync(path.join(home, 'state', 'token-usage'), { recursive: true });
  const measure = await import('../session-comparison.js');
  const file = path.join(home, 'state', 'harness.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY, session_id TEXT, turn INTEGER, role TEXT, type TEXT, data_json TEXT, created_at TEXT);
    CREATE TABLE run_attempts (attempt_id TEXT PRIMARY KEY, session_id TEXT, started_at TEXT, finished_at TEXT, status TEXT, source_user_seq INTEGER);`);
  const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)');
  const at = (seconds: number) => new Date(Date.parse('2026-10-17T00:00:00Z') + seconds * 1000).toISOString();
  insert.run(1, 'fixture-completed', 1, 'user', 'user_input_received', '{}', at(0));
  insert.run(2, 'fixture-completed', 1, 'system', 'conversation_completed', JSON.stringify({ sourceUserSeq: 1, terminalKey: 'turn:1',
    presentation: { version: 1, id: 'turn:1:presentation', outcomeId: 'turn:1', audience: 'user', phase: 'final',
      identity: { sessionId: 'fixture-completed', sourceUserSeq: 1, turn: 1 }, status: 'done', kind: 'answer', text: 'Fixture result.', resumable: false },
    turnOutcome: { version: 2, id: 'turn:1', status: 'done', resumable: false } }), at(2));
  insert.run(3, 'fixture-unfinished', 1, 'user', 'user_input_received', '{}', at(4));
  db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)').run('fixture-main', 'fixture-completed', at(0), at(3), 'completed', 1);
  db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)').run('fixture-still-owned', 'fixture-unfinished', at(4), null, 'active', 3);
  db.close();
  const usageFile = path.join(home, 'state', 'token-usage', '2026-10-17.ndjson');
  const usage = (source: string, seq: number, attemptId: string, seconds: number, tokens: number, role: string) => ({
    at: at(seconds), source, kind: 'chat', role, model: 'fixture-model', inputTokens: tokens, outputTokens: 1,
    cachedInputTokens: 0, cacheDialect: 'inclusive', trace: { acceptedSource: `${source}:${seq}`, logicalTurnId: `turn:${seq}`, attemptId },
  });
  const first = usage('fixture-completed', 1, 'fixture-main', 1, 11, 'brain');
  writeFileSync(usageFile, `${JSON.stringify(first)}\n`);
  try {
    const early = captureProofTaskCloseout({ sessionId: 'fixture-completed', seq: 1 }, () => measure.measureAcceptedTask(home, 'fixture-completed', 1));
    assert.equal(early.status, 'recorded');
    assert.equal(early.measurement?.promptTokens, 11);
    const late = usage('fixture-completed', 1, 'fixture-main', 2.5, 7, 'reviewer');
    const unfinished = { ...usage('fixture-unfinished', 3, 'fixture-still-owned', 5, 5, 'brain'), ok: false };
    writeFileSync(usageFile, `${JSON.stringify(first)}\n${JSON.stringify(late)}\n${JSON.stringify(unfinished)}\n`);
    const frozenDatabase = readFileSync(file);
    const frozenUsage = readFileSync(usageFile);
    const final = captureProofTaskCloseout({ sessionId: 'fixture-completed', seq: 1 }, () => measure.measureAcceptedTask(home, 'fixture-completed', 1));
    assert.equal(final.measurement?.promptTokens, 18, 'final closeout includes recorded late review work, unlike the earlier snapshot');
    assert.equal(final.qualification, 'unqualified'); assert.equal(final.totals, 'recorded_lower_bound');
    assert.equal(final.allLegUsageCertified, false); assert.equal(final.actualBilling, 'not_measured');
    const partial = captureProofTaskCloseout({ sessionId: 'fixture-unfinished', seq: 3 }, () => measure.measureAcceptedTask(home, 'fixture-unfinished', 3));
    assert.equal(partial.status, 'recorded', 'an unfinished accepted task retains its canonical evidence instead of disappearing');
    assert.equal(partial.measurement?.unfinishedAttempts, 1);
    assert.equal(partial.measurement?.taskWallMs, null);
    assert.equal(partial.measurement?.usageCompleteness.allLegUsageCertified, false);
    assert.equal(partial.qualification, 'unqualified');
    const foreign = captureProofTaskCloseout({ sessionId: 'fixture-completed', seq: 1 }, () => measure.measureAcceptedTask(home, 'fixture-unfinished', 3));
    assert.equal(foreign.status, 'unavailable');
    const failed = captureProofTaskCloseout({ sessionId: 'fixture-completed', seq: 1 }, () => { throw new Error('fixture-secret-must-not-leak'); });
    assert.equal(failed.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(failed), /fixture-secret/);
    assert.deepEqual(readFileSync(file), frozenDatabase);
    assert.deepEqual(readFileSync(usageFile), frozenUsage);
  } finally {
    if (previousHome === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
