import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-turn-learning-policy-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const events = await import('../runtime/harness/eventlog.js');
const composition = await import('../runtime/harness/source-session-context.js');
const policy = await import('./turn-learning-policy.js');
const excluded = { version: 1, mode: 'exclude', reason: 'controlled_test' } as const;
let count = 0;
function source(data: Record<string, unknown> = {}, metadata?: Record<string, unknown>) {
  const session = events.createSession({ id: `learning-policy-${++count}`, kind: 'chat', metadata });
  const row = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Summarize the controlled ledger.', ...data } });
  return { sessionId: session.id, sourceUserSeq: row.seq };
}
after(() => { events.closeEventLog(); rmSync(testHome, { recursive: true, force: true }); });

test('the typed policy only subtracts automatic learning and parses a closed versioned shape', () => {
  assert.deepEqual(policy.parseTurnLearningPolicy(excluded), excluded);
  assert.deepEqual(policy.turnLearningPolicyFields(undefined), {});
  for (const bad of [null, false, 'controlled_test', { ...excluded, mode: 'allow' },
    { ...excluded, reason: 'synthetic' }, { ...excluded, extra: true }, { ...excluded, version: 2 }]) {
    assert.throws(() => policy.parseTurnLearningPolicy(bad), /INVALID_TURN_LEARNING_POLICY/);
  }
  const ordinary = source({ text: 'The words synthetic, fixture and no-memory are quoted labels in a report.' });
  assert.equal(policy.readTurnLearningPolicyForSource(ordinary).status, 'allowed', 'prose labels are never policy');
});

test('an exact excluded source survives restart and cannot exclude its ordinary sibling', () => {
  const first = source({ learningPolicy: excluded });
  const next = events.appendEvent({ sessionId: first.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Prepare an ordinary summary.' } });
  const sibling = { sessionId: first.sessionId, sourceUserSeq: next.seq };
  assert.deepEqual(policy.readTurnLearningPolicyForSource(first), { status: 'excluded', policy: excluded });
  assert.deepEqual(policy.readTurnLearningPolicyForSource(sibling), { status: 'allowed' });
  events.closeEventLog();
  assert.deepEqual(policy.readTurnLearningPolicyForSource(first), { status: 'excluded', policy: excluded });
  assert.deepEqual(policy.readTurnLearningPolicyForSource(sibling), { status: 'allowed' });
  assert.equal(policy.readTurnLearningPolicyForSource({ ...first, sourceUserSeq: next.seq + 10000 }).status, 'unavailable');
  assert.equal(policy.readTurnLearningPolicyForSource({ ...first, sessionId: 'another-session' }).status, 'unavailable');
  assert.equal(policy.readTurnLearningPolicyForSource({ ...first, sourceUserSeq: 0 }).status, 'unavailable');
  assert.equal(policy.readTurnLearningPolicyForSource(source({ learningPolicy: { ...excluded, mode: 'allow' } })).status, 'unavailable');
});

test('a queued scope snapshots validated exact context once, never a newer source', () => {
  const first = source({ learningPolicy: excluded });
  const captured = composition.withAcceptedSourceSessionContext(first,
    () => policy.captureTurnLearningScope({ sessionId: first.sessionId }), { newlyAccepted: true });
  const next = events.appendEvent({ sessionId: first.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Unrelated ordinary work.' } });
  assert.equal(policy.readTurnLearningPolicyForScope(captured).status, 'excluded');
  assert.equal(policy.captureTurnLearningScope({ sessionId: first.sessionId }).kind, 'unavailable', 'session-only cannot select the latest source');
  const nextSource = { sessionId: first.sessionId, sourceUserSeq: next.seq };
  composition.withAcceptedSourceSessionContext(nextSource, () => {
    assert.equal(policy.captureTurnLearningScope({ sessionId: first.sessionId, sourceUserSeq: -1 }).kind, 'unavailable', 'invalid explicit identity never borrows ambient authority');
    assert.equal(policy.readTurnLearningPolicyForScope(captured).status, 'excluded');
    assert.equal(policy.readTurnLearningPolicyForScope(policy.captureTurnLearningScope(nextSource)).status, 'allowed');
  }, { newlyAccepted: true });
  assert.deepEqual(policy.captureTurnLearningScope({}), { kind: 'standalone' });
  assert.equal(policy.captureTurnLearningScope({ sourceUserSeq: first.sourceUserSeq }).kind, 'unavailable');
});

test('helper descendants inherit only the immutable exact parent composition', () => {
  const parent = source({ learningPolicy: { ...excluded, reason: 'owner_opt_out' } });
  assert.ok(composition.captureFreshSourceSessionContext(parent));
  const child = source({}, { workerScope: true, parentSessionId: parent.sessionId, parentSourceUserSeq: parent.sourceUserSeq });
  assert.ok(composition.captureFreshSourceSessionContext(child));
  assert.deepEqual(policy.readTurnLearningPolicyForSource(child), { status: 'excluded', policy: { ...excluded, reason: 'owner_opt_out' } });
  const ordinary = events.appendEvent({ sessionId: parent.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Ordinary later work.' } });
  assert.equal(policy.readTurnLearningPolicyForSource({ sessionId: parent.sessionId, sourceUserSeq: ordinary.seq }).status, 'allowed');
  assert.equal(policy.readTurnLearningPolicyForSource(child).status, 'excluded', 'later parent source never replaces the sealed ancestor');
});

test('host-only background policy ancestry is exact, transitive and restrictive', () => {
  const parent = source({ learningPolicy: excluded });
  const child = source({ learningPolicySource: parent });
  const grandchild = source({ learningPolicySource: child });
  assert.equal(policy.readTurnLearningPolicyForSource(grandchild).status, 'excluded');
  const normal = source();
  assert.equal(policy.readTurnLearningPolicyForSource(source({ learningPolicySource: normal })).status, 'allowed');
  assert.equal(policy.readTurnLearningPolicyForSource(source({ learningPolicySource: { ...normal, sourceUserSeq: 999999 } })).status, 'unavailable');
  assert.equal(policy.readTurnLearningPolicyForSource(source({ learningPolicySource: { ...normal, extra: true } })).status, 'unavailable');
  assert.equal(policy.readTurnLearningPolicyForSource(source({ learningPolicySource: normal, learningPolicy: excluded })).status, 'excluded', 'an ordinary ancestor cannot override the child');
});

test('a malformed retained lineage cannot silently authorize background learning', () => {
  const parent = source();
  const child = source();
  composition.captureFreshSourceSessionContext(parent);
  const identity = { version: 1, ...child, parent: { ...parent, digest: '0'.repeat(64) } };
  events.openEventLog().prepare('INSERT INTO source_session_contexts_v1(session_id,source_user_seq,identity_json,identity_digest) VALUES(?,?,?,?)')
    .run(child.sessionId, child.sourceUserSeq, JSON.stringify(identity), createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
  assert.equal(policy.readTurnLearningPolicyForSource(child).status, 'unavailable');
});

test('ancestry convergence stays allowed while cycles and excessive depth suppress optional learning', () => {
  const parent = source();
  assert.ok(composition.captureFreshSourceSessionContext(parent));
  const child = source({ learningPolicySource: parent },
    { workerScope: true, parentSessionId: parent.sessionId, parentSourceUserSeq: parent.sourceUserSeq });
  assert.ok(composition.captureFreshSourceSessionContext(child));
  assert.equal(policy.readTurnLearningPolicyForSource(child).status, 'allowed', 'the same exact ancestor reached by two proven paths is not a cycle');
  const session = events.createSession({ id: `learning-policy-cycle-${++count}`, kind: 'chat' });
  const nextSeq = (events.openEventLog().prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM events').get() as { n: number }).n;
  const cyclic = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: {
    text: 'A controlled cyclic policy reference.', learningPolicySource: { sessionId: session.id, sourceUserSeq: nextSeq } } });
  assert.equal(cyclic.seq, nextSeq);
  assert.equal(policy.readTurnLearningPolicyForSource({ sessionId: session.id, sourceUserSeq: cyclic.seq }).status, 'unavailable');
  let deep = source();
  for (let index = 0; index < 33; index++) deep = source({ learningPolicySource: deep });
  assert.equal(policy.readTurnLearningPolicyForSource(deep).status, 'unavailable');
});

function countPolicyQueries(input: Parameters<typeof policy.readTurnLearningPolicyForSource>[0]) {
  const db = events.openEventLog();
  const descriptor = Object.getOwnPropertyDescriptor(db, 'prepare');
  const prepare = db.prepare.bind(db);
  let queries = 0;
  Object.defineProperty(db, 'prepare', { configurable: true, writable: true,
    value: (sql: string) => { queries += 1; return prepare(sql); } });
  try { return { result: policy.readTurnLearningPolicyForSource(input), get queries() { return queries; } }; }
  finally {
    if (descriptor) Object.defineProperty(db, 'prepare', descriptor);
    else delete (db as unknown as { prepare?: unknown }).prepare;
  }
}

test('convergent source ancestry costs linear exact lookups and is never cached across calls', () => {
  let current = source();
  assert.ok(composition.captureFreshSourceSessionContext(current));
  const depth = 8;
  for (let index = 0; index < depth; index++) {
    const child = source({ learningPolicySource: current },
      { workerScope: true, parentSessionId: current.sessionId, parentSourceUserSeq: current.sourceUserSeq });
    assert.ok(composition.captureFreshSourceSessionContext(child));
    current = child;
  }
  const first = countPolicyQueries(current);
  assert.equal(first.result.status, 'allowed');
  assert.ok(first.queries <= 4 * (depth + 1) + 1, `convergent ancestry repeated ${first.queries} database lookups`);
  const next = countPolicyQueries(current);
  assert.equal(next.result.status, 'allowed');
  assert.equal(next.queries, first.queries, 'each later check reopens durable source policy rather than sharing mutable process cache');
});

test('wide distinct ancestry is bounded independently of the depth ceiling', () => {
  function tree(depth: number): { sessionId: string; sourceUserSeq: number } {
    if (depth === 0) {
      const leaf = source();
      assert.ok(composition.captureFreshSourceSessionContext(leaf));
      return leaf;
    }
    const left = tree(depth - 1);
    const right = tree(depth - 1);
    const child = source({ learningPolicySource: left },
      { workerScope: true, parentSessionId: right.sessionId, parentSourceUserSeq: right.sourceUserSeq });
    assert.ok(composition.captureFreshSourceSessionContext(child));
    return child;
  }
  const bounded = countPolicyQueries(tree(6));
  assert.equal(bounded.result.status, 'unavailable', 'a shallow but wide graph cannot spend an unbounded foreground learning check');
  assert.ok(bounded.queries <= 129, `reader exceeded its 64 exact-lookup budget: ${bounded.queries} statements`);
});
