/**
 * The shared trusted-evidence ledger — the single source of "what counts as
 * grounded evidence this session" that every field check stands on.
 *
 * Run: npx tsx --test src/runtime/harness/trusted-evidence.test.ts
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-trusted-evidence';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { appendEvent, createSession, resetEventLog, writeToolOutput } = await import('./eventlog.js');
const { gatherTrustedEvidence } = await import('./trusted-evidence.js');

const S = 'sess-trusted-evidence';

function addToolOutput(callId: string, tool: string, effect: string, output: string): void {
  writeToolOutput({ sessionId: S, callId, tool, output });
  appendEvent({ sessionId: S, turn: 1, role: 'system', type: 'tool_returned', data: { tool, callId, effect, result: 'ok' } });
}

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetEventLog(); createSession({ id: S, kind: 'chat' }); });

test('includes real user messages and read/compute tool outputs', () => {
  appendEvent({ sessionId: S, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'invite avery@x.co' } });
  addToolOutput('call_read', 'salesforce_query', 'read', 'blair@x.co, casey@x.co');
  addToolOutput('call_compute', 'run_shell_command', 'compute', 'devon@x.co');

  const ids = gatherTrustedEvidence(S).map((s) => s.id);
  assert.ok(ids.some((id) => id.startsWith('user:')), 'user message included');
  assert.ok(ids.includes('call_read'), 'read output included');
  assert.ok(ids.includes('call_compute'), 'compute output included');
});

test('excludes synthetic user turns, write/send confirmations, and echo surfaces', () => {
  appendEvent({ sessionId: S, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'synthetic nudge', synthetic: true } });
  addToolOutput('call_send', 'outlook_send_mail', 'external_write', 'sent to victim@x.co'); // a send confirmation
  addToolOutput('call_echo', 'pending_action_queue', 'read', 'queued attendee@x.co');       // echo surface

  const ids = gatherTrustedEvidence(S).map((s) => s.id);
  assert.ok(!ids.some((id) => id.startsWith('user:')), 'synthetic user turn excluded');
  assert.ok(!ids.includes('call_send'), 'a send/write CONFIRMATION is not evidence for its own payload');
  assert.ok(!ids.includes('call_echo'), 'echo surface excluded');
});

test('carries effect + tool metadata so field checks can reason about each source', () => {
  addToolOutput('call_x', 'gmail_list', 'read', 'a@x.co');
  const src = gatherTrustedEvidence(S).find((s) => s.id === 'call_x');
  assert.equal(src?.tool, 'gmail_list');
  assert.equal(src?.effect, 'read');
  assert.equal(src?.kind, 'tool');
  assert.match(src?.text ?? '', /a@x\.co/);
});
