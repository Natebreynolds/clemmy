import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatEngine, foldTranscript } from './engine.js';
import { cardDecisionOf, hiddenCardDecision, type HarnessEvent } from './types.js';

const event = (seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent => ({ seq, type, sessionId: 'chat', data });
const card = event(5, 'approval_requested', { approvalId: 'apr-card', subject: 'Let Clem use a server', tool: 'approval' });
const tap = (decision: 'approve' | 'reject') => event(6, 'user_input_received', {
  text: `${decision === 'approve' ? 'Approve' : 'Reject'} apr-card.`, displayText: `${decision === 'approve' ? 'Approve' : 'Reject'} apr-card`,
  synthetic: true, source: 'mobile_approval', approvalId: 'apr-card', decision,
});
const reply = (status: 'done' | 'failed') => event(7, 'conversation_completed', {
  sourceUserSeq: 6, reply: status === 'done' ? 'Approved apr-card.' : 'Could not record that decision.',
  presentation: { identity: { sessionId: 'chat', sourceUserSeq: 6 }, status, kind: status === 'done' ? 'answer' : 'error', text: status === 'done' ? 'Approved apr-card.' : 'Could not record that decision.', resumable: false },
  turnOutcome: { status },
});

test('a card tap is read only from the host record of the message', () => {
  assert.deepEqual(cardDecisionOf(tap('approve').data!), { approvalId: 'apr-card', decision: 'approve' });
  assert.equal(cardDecisionOf({ text: 'Approve apr-card' }), null, 'typed words are not a tap');
  assert.equal(cardDecisionOf({ source: 'mobile_approval', approvalId: 'apr-card', decision: 'maybe' }), null);
});

test('a card tap and its reply stay out of the transcript, and the card reads as decided', () => {
  for (const decision of ['approve', 'reject'] as const) {
    const resolved = event(8, 'approval_resolved', { approvalId: 'apr-card', decision });
    const rows = foldTranscript([card, tap(decision), reply('done'), resolved], 'chat');
    const shown = rows.filter((row) => !hiddenCardDecision(row));
    assert.equal(shown.length, 1, 'only the card itself remains');
    assert.equal(shown[0]!.approval?.resolution, decision === 'approve' ? 'approved' : 'declined');
  }
});

test('a tap whose decision failed to land stays visible', () => {
  const rows = foldTranscript([card, tap('approve'), reply('failed')], 'chat');
  const failed = rows.find((row) => row.role === 'assistant' && /Could not record that decision/.test(row.text ?? ''));
  assert.ok(failed);
  assert.equal(hiddenCardDecision(failed!), false);
  assert.equal(rows.find((row) => row.approval)?.approval?.resolution, undefined, 'the failed decision leaves the card actionable');
});


test('a request or successful turn without resolution evidence never decides the card', () => {
  for (const suffix of [[], [reply('done')]]) {
    const rows = foldTranscript([card, tap('approve'), ...suffix], 'chat');
    assert.equal(rows.find((row) => row.approval)?.approval?.resolution, undefined);
  }
});

test('a decision recorded before a later run failure stays decided', () => {
  const rows = foldTranscript([card, tap('approve'),
    event(7, 'approval_resolved', { approvalId: 'apr-card', decision: 'approve' }), reply('failed')], 'chat');
  assert.equal(rows.find((row) => row.approval)?.approval?.resolution, 'approved');
});

test('an offline tap and discarding its failed echo retain the actionable card', async () => {
  const calls: string[] = [];
  const engine = new ChatEngine({
    sessionId: 'chat',
    api: {
      loadSession: async () => ({ events: [card], latestSeq: 5 }),
      send: async (input) => { calls.push(input.idempotencyKey); throw new Error('offline'); },
    },
    transport: { connect: async () => ({ close() {} }), fetchRecent: async () => ({ events: [] }) },
  });
  try {
    await engine.open();
    const sending = engine.send('Approve apr-card', undefined, { cardDecision: { approvalId: 'apr-card', decision: 'approve' } });
    assert.equal(engine.snapshot().messages.find((row) => row.approval)?.approval?.resolution, undefined);
    await sending;
    const failed = engine.snapshot().messages.find((row) => row.pending === 'failed');
    assert.ok(failed);
    assert.equal(hiddenCardDecision(failed!), false);
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls).size, 1, 'every attempt keeps its exact request identity');
    engine.discard(failed!.id);
    assert.equal(engine.snapshot().messages.find((row) => row.approval)?.approval?.resolution, undefined);
  } finally { engine.dispose(); }
});

test('Clem\'s own answer to a card tap stays in the conversation; only the tap and an echo leave', () => {
  // Phone test 2026-10-09: the resumed work's answer, delivered against the
  // tap ("Yes — done. Slide 7's screenshot is now attached…"), was hidden
  // with the tap, and the owner had to check the draft folder.
  const answer = event(7, 'conversation_completed', {
    sourceUserSeq: 6, reply: 'Yes — done. The screenshot is attached to the same draft.',
    presentation: { identity: { sessionId: 'chat', sourceUserSeq: 6 }, status: 'done', kind: 'answer',
      text: 'Yes — done. The screenshot is attached to the same draft.', resumable: false },
    turnOutcome: { status: 'done' },
  });
  const rows = foldTranscript([card, tap('approve'), answer,
    event(8, 'approval_resolved', { approvalId: 'apr-card', decision: 'approve' })], 'chat');
  const shown = rows.filter((row) => !hiddenCardDecision(row));
  assert.ok(shown.some((row) => row.role === 'assistant' && /screenshot is attached/.test(row.text ?? '')), JSON.stringify(shown.map((row) => [row.role, row.text])));
  assert.equal(shown.some((row) => row.role === 'user'), false, 'the tap itself stays out of sight');
});

test('after a card tap, the work it resumes shows as working until Clem answers', async () => {
  const engine = new ChatEngine({
    sessionId: 'chat',
    api: {
      loadSession: async () => ({ events: [card], latestSeq: 5 }),
      send: async () => ({ sessionId: 'chat', accepted: true }),
    },
    transport: { connect: async () => ({ close() {} }), fetchRecent: async () => ({ events: [] }) },
  });
  try {
    await engine.open();
    await engine.send('Approve apr-card', undefined, { cardDecision: { approvalId: 'apr-card', decision: 'approve' } });
    const visible = engine.snapshot().messages.filter((row) => !hiddenCardDecision(row));
    assert.ok(visible.some((row) => row.role === 'assistant' && row.status === 'thinking'),
      `a working state is on screen: ${JSON.stringify(visible.map((row) => [row.role, row.status]))}`);
    assert.equal(visible.some((row) => row.role === 'user'), false, 'the tap itself is not');
  } finally { engine.dispose(); }
});
