/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/typed-source-dispatch.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-typed-dispatch-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-typed-dispatch\n', 'utf8');

const { createSession, appendEvent } = await import('../harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { recordSemanticParticipation } = await import('./semantic-disposition.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');

async function dispatchFor(text: string) {
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: sess.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  recordSemanticParticipation(sess.id, source.seq, 'participated');
  return dispatchAdmittedSource({ sessionId: sess.id, turn: 1, sourceUserSeq: source.seq });
}

test('an unbound READ parks on the typed kernel instead of falling through to conversation', async () => {
  const dispatched = await dispatchFor('whats on my roster for tomorrow');
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 200));
  assert.ok(
    dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
    JSON.stringify(dispatched).slice(0, 200),
  );
});

test('an unbound retrieve parks instead of falling through to conversation', async () => {
  const dispatched = await dispatchFor('what did casey say in the last email thread from acme');
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 200));
  assert.ok(
    dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
    JSON.stringify(dispatched).slice(0, 200),
  );
});

test('a role-only sketch is not an executable typed graph', async () => {
  const { typedGraphHasExecutableOperations } = await import('./typed-source-dispatch.js');
  assert.equal(typedGraphHasExecutableOperations({
    nodes: [{ capabilityRole: 'source' }, { capabilityRole: 'collection' }],
  }), false);
  assert.equal(typedGraphHasExecutableOperations({
    nodes: [{ operationId: 'cap:store:upsert' }],
  }), true);
});

test('an unbound write never falls through to the conversation loop', async () => {
  const dispatched = await dispatchFor(
    'put the top 5 records into a new workbook and share it with the team',
  );
  // North-star cutover: after participation, a write uses the kernel or parks.
  // Conversation tools must not mint the crossing.
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 200));
  assert.ok(
    dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
    JSON.stringify(dispatched).slice(0, 200),
  );
});

test('a conversation-routed graph dispatches conversation, not an action loop', async () => {
  const dispatched = await dispatchFor('hey hows it going');
  assert.ok(dispatched.kind === 'conversation' || dispatched.kind === 'blocked', dispatched.kind);
});

test('a failed semantic admission does not fall through to a read loop', async () => {
  const { recordSemanticDispositionOutcome } = await import('./semantic-disposition.js');
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'whats on my roster for tomorrow' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: sess.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  recordSemanticDispositionOutcome(sess.id, source.seq, 'blocked');
  const dispatched = await dispatchAdmittedSource({ sessionId: sess.id, turn: 1, sourceUserSeq: source.seq });
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 200));
  assert.ok(
    dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
    JSON.stringify(dispatched).slice(0, 200),
  );
});

test('a failed semantic admission does not fall through to a write loop', async () => {
  const { recordSemanticDispositionOutcome } = await import('./semantic-disposition.js');
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user',
    type: 'user_input_received',
    data: { text: 'put the top 5 records into a new workbook and share it with the team' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: sess.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  recordSemanticDispositionOutcome(sess.id, source.seq, 'blocked');
  const dispatched = await dispatchAdmittedSource({ sessionId: sess.id, turn: 1, sourceUserSeq: source.seq });
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 200));
  assert.ok(
    dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
    JSON.stringify(dispatched).slice(0, 200),
  );
});
