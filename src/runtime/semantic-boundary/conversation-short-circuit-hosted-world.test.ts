/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/conversation-short-circuit-hosted-world.test.ts
 *
 * The fresh-host conversation surface may skip tools only for closed-world
 * talk. A greeting prefix on a hosted-world ask is not closed-world.
 *
 * Live 2026-08-28 sess-mob-5d3e… source 92387: "Hey what's on my calendar
 * today" compiled `direct_reply`, denied local and external tool authority,
 * and published `done` after zero crossings.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-conversation-short-circuit-hosted';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { appendEvent, createSession, resetEventLog } = await import('../harness/eventlog.js');
const { freshHostConversationSurfaceOnly } = await import('./admit-and-compile-accepted-source.js');

beforeEach(() => { resetEventLog(); });
after(() => {
  resetEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function acceptedSource(sessionId: string, text: string) {
  createSession({ id: sessionId, kind: 'chat' });
  return appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
}

test('a greeting-prefixed calendar ask is NOT a zero-tool conversation surface', () => {
  const source = acceptedSource(
    'cal-hey',
    "Hey what's on my calendar today",
  );
  assert.equal(
    freshHostConversationSurfaceOnly({ sessionId: 'cal-hey', sourceUserSeq: source.seq }),
    false,
  );
});

test('a bare greeting still is a zero-tool conversation surface', () => {
  const source = acceptedSource('cal-hi', 'hey');
  assert.equal(
    freshHostConversationSurfaceOnly({ sessionId: 'cal-hi', sourceUserSeq: source.seq }),
    true,
  );
});

test('closed-world arithmetic still is a zero-tool conversation surface', () => {
  const source = acceptedSource('cal-math', "what's 2x3");
  assert.equal(
    freshHostConversationSurfaceOnly({ sessionId: 'cal-math', sourceUserSeq: source.seq }),
    true,
  );
});

test('a follow-up after real hosted work keeps its tools even when Normal work created no graph', () => {
  const sessionId = 'drafts-without-plan';
  const first = acceptedSource(sessionId, 'Create the requested drafts.');
  appendEvent({ sessionId, turn: 1, role: 'tool', type: 'tool_called', data: {
    sourceUserSeq: first.seq, callId: 'draft-call', tool: 'work_call', effectiveTool: 'outlook_create_draft', effect: 'external_write',
  } });
  for (const text of ['Hows it looking?', 'Okay']) {
    const source = appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text } });
    assert.equal(freshHostConversationSurfaceOnly({ sessionId, sourceUserSeq: source.seq }), false,
      'a prior real tool attempt is hosted context without requiring a plan graph');
  }
});
