import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-recipient-integrity';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { appendEvent, createSession, resetEventLog, writeToolOutput } = await import('./eventlog.js');
const { evaluateRecipientSetIntegrity } = await import('./recipient-integrity-gate.js');

const correct = [
  'bobby.romano@example.com', 'brett.lorenzini@example.com', 'jake.wright@example.com', 'jarrett.tyus@example.com',
  'kim.hillman@example.com', 'taylor.saunders@example.com', 'tim.demik@example.com', 'tyler.jorgensen@example.com',
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

test('blocks a recipient set stitched across separate source snippets', () => {
  const session = createSession({ kind: 'chat' });
  addReadSource(session.id, 'half-a', 'composio_execute_tool', correct.slice(0, 4));
  addReadSource(session.id, 'half-b', 'composio_execute_tool', correct.slice(4));
  const result = evaluateRecipientSetIntegrity(session.id, outgoing(correct));
  assert.equal(result.action, 'block');
  assert.deepEqual(result.unsupportedRecipients, []);
  assert.match(result.reason, /separate artifacts/);
});
