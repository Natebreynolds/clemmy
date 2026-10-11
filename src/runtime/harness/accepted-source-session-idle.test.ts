import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

// The existing isolated runner also confines early module imports and workers.
const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-source-idle-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const selector = await import('./accepted-source-session-branch.js');
const approvals = await import('./approval-registry.js');

test.after(() => { eventlog.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });
let serial = 0;
function fixture() {
  const owner = `idle-owner-${++serial}`, conversationId = `idle-conversation-${serial}`;
  const session = HarnessSession.create({ id: conversationId, kind: 'chat', channel: 'mobile', userId: owner,
    metadata: { source: 'mobile', ingressProvider: 'mobile', channelId: conversationId, userId: owner } });
  return { session, continuity: { provider: 'mobile', scopeId: null, conversationId, audienceId: owner } };
}
function claim(f: ReturnType<typeof fixture>, suffix: string) {
  const runId = `idle-run-${serial}-${suffix}`;
  return { kind: 'ordinary' as const, requireIdle: true, entrySessionId: f.session.id, durableSourceId: runId,
    continuity: f.continuity, receipt: { requestId: `idle-request-${serial}-${suffix}`, runId, inputHash: suffix } };
}
function snapshot() {
  const db = eventlog.openEventLog();
  return ['sessions', 'events', 'accepted_source_session_pointers', 'accepted_source_session_bindings', 'harness_chat_requests']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
function complete(sessionId: string, runId: string, status: 'completed' | 'cancelled') {
  const attempt = eventlog.beginRunAttempt(sessionId, { runId });
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Controlled idle fixture', runId } });
  eventlog.appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: source.seq, runId, attemptId: attempt.attemptId, reply: 'Controlled terminal', reason: status } });
  eventlog.finishRunAttempt(attempt, status);
  HarnessSession.load(sessionId)!.markStatus(status);
  return { attempt, source };
}

test('idle-only root admission refuses its active successor and exact replay keeps that successor', () => {
  const f = fixture(); complete(f.session.id, 'stopped-root', 'cancelled');
  const first = claim(f, 'first'), admitted = selector.claimSessionForAcceptedSource(first);
  assert.notEqual(admitted.selection.sessionId, f.session.id);
  const attempt = eventlog.beginRunAttempt(admitted.selection.sessionId, { runId: first.receipt.runId });
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Still working', runId: attempt.runId } });
  const second = claim(f, 'second'), before = snapshot();
  assert.throws(() => selector.claimSessionForAcceptedSource(second), error => error instanceof selector.AcceptedSourceSessionIdleError && error.reason === 'busy');
  assert.deepEqual(snapshot(), before, 'refusal creates no receipt, binding, child, pointer or event');
  const replay = selector.claimSessionForAcceptedSource(first);
  assert.equal(replay.inserted, false); assert.equal(replay.selection.sessionId, admitted.selection.sessionId);
  assert.equal(eventlog.getRunAttemptSourceUserEvent(attempt)?.seq, source.seq);
  eventlog.appendEvent({ sessionId: admitted.selection.sessionId, turn: 1, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: source.seq, runId: attempt.runId, attemptId: attempt.attemptId, reply: 'Finished', reason: 'success' } });
  eventlog.finishRunAttempt(attempt, 'completed'); HarnessSession.load(admitted.selection.sessionId)!.markStatus('completed');
  const next = selector.claimSessionForAcceptedSource(second);
  assert.equal(next.inserted, true); assert.notEqual(next.selection.sessionId, admitted.selection.sessionId);
});

test('an unaccepted reservation is busy despite a completed previous source, while exact key replay is admissible', () => {
  const f = fixture(); complete(f.session.id, 'previous-completed', 'completed');
  const first = claim(f, 'reserved'), admitted = selector.claimSessionForAcceptedSource(first), before = snapshot();
  assert.equal(eventlog.listEvents(admitted.selection.sessionId, { types: ['user_input_received'] }).length, 0);
  assert.throws(() => selector.claimSessionForAcceptedSource(claim(f, 'competing')), selector.AcceptedSourceSessionIdleError);
  assert.deepEqual(snapshot(), before);
  assert.equal(selector.claimSessionForAcceptedSource(first).receipt.sessionId, admitted.receipt.sessionId);
});

test('expired unfinished attempts, pending approval and source checkpoint holds fail closed without changing default admission', () => {
  for (const hold of ['unfinished', 'approval', 'checkpoint'] as const) {
    const f = fixture();
    if (hold === 'unfinished') {
      eventlog.claimRunAttemptLease({ sessionId: f.session.id, runId: 'recovering', ownerId: 'fixture', leaseMs: 1000, nowMs: 1 });
    } else if (hold === 'approval') approvals.register({ sessionId: f.session.id, channel: 'mobile', subject: 'Controlled hold' });
    else eventlog.openEventLog().prepare('UPDATE sessions SET metadata_json=json_set(metadata_json, ?, json(?)) WHERE id=?')
      .run('$.__source_approval_checkpoints', JSON.stringify({ 1: { revision: 'held', checkpoint: { serialized: 'controlled' } } }), f.session.id);
    const input = claim(f, hold), before = snapshot();
    assert.throws(() => selector.claimSessionForAcceptedSource(input), error => error instanceof selector.AcceptedSourceSessionIdleError
      && error.reason === (hold === 'unfinished' ? 'busy' : 'held'));
    assert.deepEqual(snapshot(), before);
    assert.equal(selector.claimSessionForAcceptedSource({ ...input, requireIdle: false }).inserted, true,
      'ordinary callers that did not opt in retain their prior branching behavior');
  }
});

test('different principals do not inherit another audience idle hold', () => {
  const f = fixture(); eventlog.beginRunAttempt(f.session.id, { runId: 'foreign-active' });
  const selected = selector.claimSessionForAcceptedSource({ ...claim(f, 'different-owner'),
    continuity: { ...f.continuity, audienceId: 'independent-owner' } });
  assert.equal(selected.selection.disposition, 'identity_split');
  assert.notEqual(selected.selection.sessionId, f.session.id);
});

test('competing keys serialize idle admission before either accepted source exists', async () => {
  const f = fixture(), gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const bootstrap = new URL(`data:text/javascript,${encodeURIComponent(
    `import { tsImport } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};\n`
    + `await tsImport(${JSON.stringify(new URL('./accepted-source-session-claim.worker.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)});`,
  )}`);
  const inputs = [claim(f, 'race-one'), claim(f, 'race-two')];
  const workers = inputs.map(input => new Worker(bootstrap, { workerData: { gate, claim: input }, execArgv: [] }));
  let ready = 0;
  try {
    const results = await Promise.all(workers.map(worker => new Promise<{ kind: string; result?: ReturnType<typeof selector.claimSessionForAcceptedSource>; error?: string }>((resolve, reject) => {
      worker.on('message', message => {
        if (message.kind === 'ready') {
          if (++ready === workers.length) { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, workers.length); }
        } else resolve(message);
      });
      worker.on('error', reject); worker.on('exit', code => { if (code !== 0) reject(new Error(`claim worker exited ${code}`)); });
    })));
    assert.equal(results.filter(result => result.kind === 'result').length, 1);
    assert.match(results.find(result => result.kind === 'error')!.error!, /AcceptedSourceSessionIdleError/);
    const db = eventlog.openEventLog();
    assert.equal((db.prepare('SELECT COUNT(*) n FROM harness_chat_requests WHERE request_id IN (?, ?)')
      .get(...inputs.map(input => input.receipt.requestId)) as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM accepted_source_session_bindings WHERE session_id=?')
      .get(f.session.id) as { n: number }).n, 1);
    const winner = results.find(result => result.kind === 'result')!.result!;
    const winningInput = inputs.find(input => input.receipt.requestId === winner.receipt.requestId)!;
    assert.equal(selector.claimSessionForAcceptedSource(winningInput).inserted, false);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
});
