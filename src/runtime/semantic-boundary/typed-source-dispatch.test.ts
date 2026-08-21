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

test('an act-routed graph with no bound operations blocks instead of an untyped loop', async () => {
  const dispatched = await dispatchFor('whats on my calendar for tomrrow');
  assert.equal(dispatched.kind, 'blocked', JSON.stringify(dispatched).slice(0, 200));
});

test('an unbound retrieve also blocks instead of falling through', async () => {
  const dispatched = await dispatchFor('what did casey say in the last email thread from acme');
  assert.equal(dispatched.kind, 'blocked', JSON.stringify(dispatched).slice(0, 200));
});

test('a conversation-routed graph dispatches conversation, not an action loop', async () => {
  const dispatched = await dispatchFor('hey hows it going');
  assert.ok(dispatched.kind === 'conversation' || dispatched.kind === 'blocked', dispatched.kind);
});

test('a failed semantic admission blocks — a checker cannot mint an untyped action loop', async () => {
  const { recordSemanticDispositionOutcome } = await import('./semantic-disposition.js');
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'can you update my friday morning meeting dashboard please' },
  });
  recordSemanticDispositionOutcome(sess.id, source.seq, 'blocked');
  const dispatched = await dispatchAdmittedSource({ sessionId: sess.id, turn: 1, sourceUserSeq: source.seq });
  assert.equal(dispatched.kind, 'blocked', JSON.stringify(dispatched).slice(0, 200));
});
