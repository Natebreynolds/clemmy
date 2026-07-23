import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-recipient-integrity';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { appendEvent, createSession, resetEventLog, writeToolOutput } = await import('./eventlog.js');
const { evaluateRecipientSetIntegrity } = await import('./recipient-integrity-gate.js');

const correct = [
  'avery.rowan@example.com', 'blair.solis@example.com', 'casey.harbor@example.com', 'devon.quill@example.com',
  'emery.vale@example.com', 'frankie.moss@example.com', 'gray.linden@example.com', 'harper.wren@example.com',
];
const wrong = [
  ...correct.slice(0, 3),
  'john.arnold@example.com', 'justin.hartman@example.com', 'matthew.martin@example.com',
  'michael.garcia@example.com', 'tyler.ward@example.com',
];

function outgoing(addresses: string[]): unknown {
  return {
    tool_slug: 'OUTLOOK_CREATE_EVENT',
    arguments: JSON.stringify({ attendees: addresses.map((email) => ({ email })) }),
  };
}

function addReadSource(sessionId: string, callId: string, tool: string, addresses: string[]): void {
  writeToolOutput({ sessionId, callId, tool, output: JSON.stringify({ members: addresses.map((email) => ({ email })) }) });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool, callId, effect: 'read', result: 'stored separately' },
  });
}

before(() => rmSync(TEST_HOME, { recursive: true, force: true }));
beforeEach(() => resetEventLog());

test('allows an eight-person outgoing set backed by one exact read result', () => {
  const session = createSession({ kind: 'chat' });
  addReadSource(session.id, 'sf-roster', 'composio_execute_tool', correct);
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(correct));
  assert.equal(result.action, 'allow');
  assert.equal(result.sourceId, 'sf-roster');
});

test('blocks a three-correct plus five-fabricated substitution', () => {
  const session = createSession({ kind: 'chat' });
  addReadSource(session.id, 'sf-roster', 'composio_execute_tool', correct);
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(wrong));
  assert.equal(result.action, 'block');
  assert.deepEqual(result.unsupportedRecipients, wrong.slice(3).sort());
});

test('does not let a pending-action echo validate its own recipient payload', () => {
  const session = createSession({ kind: 'chat' });
  addReadSource(session.id, 'pending-echo', 'pending_action_get', wrong);
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(wrong));
  assert.equal(result.action, 'block');
});

test('accepts a complete recipient list stated directly by the user', () => {
  const session = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Invite exactly these people: ${correct.join(', ')}` },
  });
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(correct));
  assert.equal(result.action, 'allow');
  assert.match(result.sourceId ?? '', /^user:/);
});

test('omission advisory: "invite everyone" but a subset flags the dropped recipients (still allow)', () => {
  const session = createSession({ kind: 'chat' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Invite everyone on the team to the sync.' } });
  addReadSource(session.id, 'sf-roster', 'composio_execute_tool', correct);
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(correct.slice(0, 3)));
  assert.equal(result.action, 'allow', 'never blocks a legitimate partial send');
  assert.deepEqual(result.omittedRecipients, correct.slice(3).sort(), 'the dropped 5 are surfaced');
});

test('omission: explicit exclusion language ("except …") does NOT flag omission', () => {
  const session = createSession({ kind: 'chat' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Invite the whole team except Harper.' } });
  addReadSource(session.id, 'sf-roster', 'composio_execute_tool', correct);
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(correct.slice(0, 7)));
  assert.equal(result.action, 'allow');
  assert.equal(result.omittedRecipients, undefined, 'user signaled the exclusion — no advisory');
});

test('omission: no complete-set intent means no advisory on a subset', () => {
  const session = createSession({ kind: 'chat' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Send it to these three leads.' } });
  addReadSource(session.id, 'sf-roster', 'composio_execute_tool', correct);
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(correct.slice(0, 3)));
  assert.equal(result.action, 'allow');
  assert.equal(result.omittedRecipients, undefined);
});

// S1 (gate audit 2026-07-23): FLIPPED from block to allow. Recipients drawn
// from two separate reads are each individually grounded — refusing the union
// hard-blocked user-confirmed multi-source batches (the workflow-run-guard
// failure shape: the confirmation was invisible to the gate). Fabrication
// protection lives in the no-trusted-source block below, which stays.
test('union coverage: a set assembled from two trusted reads is ALLOWED', () => {
  const session = createSession({ kind: 'chat' });
  addReadSource(session.id, 'half-a', 'composio_execute_tool', correct.slice(0, 4));
  addReadSource(session.id, 'half-b', 'composio_execute_tool', correct.slice(4));
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(correct));
  assert.equal(result.action, 'allow');
  assert.match(result.reason, /union coverage/);
});

test('fabrication still blocks: an address in NO trusted source refuses the batch', () => {
  const session = createSession({ kind: 'chat' });
  addReadSource(session.id, 'half-a', 'composio_execute_tool', correct.slice(0, 4));
  addReadSource(session.id, 'half-b', 'composio_execute_tool', correct.slice(4, 7));
  const stitched = [...correct.slice(0, 7), 'phantom@nowhere.example'];
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(stitched));
  assert.equal(result.action, 'block');
  assert.deepEqual(result.unsupportedRecipients, ['phantom@nowhere.example']);
});
