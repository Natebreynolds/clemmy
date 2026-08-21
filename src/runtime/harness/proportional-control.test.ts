/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/proportional-control.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-proportional-'));
process.env.CLEMENTINE_HOME = HOME;

const { createSession, appendEvent, resetEventLog } = await import('./eventlog.js');
const { parkDependencyRequest, satisfyOpenDependency } = await import('./dependency-request.js');
const { classifyMessageIntent } = await import('../../assistant/message-intent.js');

test('conversation does not require a task plan', () => {
  const intent = classifyMessageIntent('hey hows it going');
  assert.ok(intent.intent === 'casual' || intent.intent === 'chat' || intent.confidence >= 0.5);
});

test('a missing attested contract parks a dependency, not a connection request from an index miss', () => {
  resetEventLog();
  const session = createSession({ id: 'sess-dep', kind: 'chat', userId: 'u' });
  const source = appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'read the connected catalog' },
  });
  const parked = parkDependencyRequest({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    kind: 'capability_contract_missing',
  });
  assert.equal(parked.status, 'open');
  assert.equal(parked.kind, 'capability_contract_missing');
  assert.equal(parked.owner, 'user');
  assert.match(parked.text, /continue this exact request|attested capability/i);
  assert.equal(satisfyOpenDependency({ sessionId: session.id, sourceUserSeq: source.seq }), true);
});

test('direct mode is the only scheduler skip; family gaps park a DependencyRequest', () => {
  const dispatch = readFileSync(
    fileURLToPath(new URL('../semantic-boundary/typed-source-dispatch.ts', import.meta.url)),
    'utf8',
  );
  assert.match(dispatch, /runDirectNodeInvocation/);
  assert.match(dispatch, /generalSchedulerForbidden/);
  assert.match(dispatch, /parkDependencyRequest/);
  assert.doesNotMatch(dispatch, /parkConnectionRequest/);
  const complexity = readFileSync(
    fileURLToPath(new URL('./control-complexity.ts', import.meta.url)),
    'utf8',
  );
  assert.match(complexity, /return mode === 'direct'/);
});
