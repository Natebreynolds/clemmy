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
const {
  bareDeicticClarificationForAcceptedSource,
  freshHostConversationSurfaceOnly,
  sessionHasConversationalReferent,
} = await import('./admit-and-compile-accepted-source.js');

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

test('arithmetic plus an answer-shape sentence is still a zero-tool conversation surface', () => {
  const source = acceptedSource('cal-math-shape', 'What is 12 times 12? Reply with the number only.');
  assert.equal(
    freshHostConversationSurfaceOnly({ sessionId: 'cal-math-shape', sourceUserSeq: source.seq }),
    true,
  );
});

test('a bare deictic with no chat or attachment is not a zero-tool conversation surface', () => {
  const source = acceptedSource('deictic-empty', 'can you tidy that up for me');
  assert.equal(
    freshHostConversationSurfaceOnly({ sessionId: 'deictic-empty', sourceUserSeq: source.seq }),
    false,
    'no retrieve/act does not mean no referent; the host asks instead of stripping tools',
  );
  assert.equal(sessionHasConversationalReferent({ sessionId: 'deictic-empty', sourceUserSeq: source.seq }), false);
  assert.match(
    bareDeicticClarificationForAcceptedSource({ sessionId: 'deictic-empty', sourceUserSeq: source.seq })?.question ?? '',
    /no prior message or attachment/,
  );
});

test('a deictic follow-up after prior chat keeps tools and does not host-ask', () => {
  const sessionId = 'deictic-prior-chat';
  acceptedSource(sessionId, 'Here is the draft of the weekly note.');
  const follow = appendEvent({
    sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'can you tidy that up for me', displayText: 'can you tidy that up for me' },
  });
  assert.equal(sessionHasConversationalReferent({ sessionId, sourceUserSeq: follow.seq }), true);
  assert.equal(freshHostConversationSurfaceOnly({ sessionId, sourceUserSeq: follow.seq }), false);
  assert.equal(bareDeicticClarificationForAcceptedSource({ sessionId, sourceUserSeq: follow.seq }), null);
});

test('a deictic display line with folded attachment text keeps tools', () => {
  const sessionId = 'deictic-attach';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: {
      displayText: 'can you tidy that up for me',
      text: 'can you tidy that up for me\n\nAttached file weekly-note.md:\n# Weekly note\nLots of content to tidy.\n',
      attachmentIds: ['att-1'],
    },
  });
  assert.equal(sessionHasConversationalReferent({ sessionId, sourceUserSeq: source.seq }), true);
  assert.equal(freshHostConversationSurfaceOnly({ sessionId, sourceUserSeq: source.seq }), false);
  assert.equal(bareDeicticClarificationForAcceptedSource({ sessionId, sourceUserSeq: source.seq }), null);
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
