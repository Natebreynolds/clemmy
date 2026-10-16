import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatEngine, foldTranscript, inFlightTurnSince } from './engine.js';
import { applyApprovalDecisionAck, readApprovalDecisionAck } from './approval-card-resolution.js';
import { hiddenCardDecision, type HarnessEvent, type ReplayPayload } from './types.js';
import type { StreamConnection, StreamTransport } from './stream.js';

const SESSION = 'approval-card-resolution-fixture';
const event = (seq: number, type: string, data: Record<string, unknown>): HarnessEvent =>
  ({ seq, type, sessionId: SESSION, data });
const card = (seq = 2, approvalId = 'apr-fixture') => event(seq, 'approval_requested',
  { approvalId, subject: 'Save the fixture draft' });
const tap = event(3, 'user_input_received', { text: 'Approve apr-fixture.', synthetic: true,
  source: 'mobile_approval', approvalId: 'apr-fixture', decision: 'approve' });
const completed = (seq: number, sourceUserSeq: number, text: string): HarnessEvent => event(seq, 'conversation_completed', {
  sourceUserSeq, reply: text,
  presentation: { version: 1, audience: 'user', phase: 'final',
    identity: { sessionId: SESSION, sourceUserSeq, turn: 1 },
    status: 'done', kind: 'answer', text, resumable: false },
  turnOutcome: { version: 2, status: 'done', resumable: false },
});
const marker = (sourceUserSeq = 3, decision: 'approve' | 'reject' = 'approve', approvalId = 'apr-fixture') =>
  ({ version: 1, sourceUserSeq, approvalId, decision });
const receipt = (seq = 5, sourceUserSeq = 3, decision: 'approve' | 'reject' = 'approve') => {
  const result = completed(seq, sourceUserSeq, 'Private host acknowledgment wording.');
  result.role = 'system';
  result.data = { ...result.data, notice: { code: 'card_decision' }, approvalDecisionAck: marker(sourceUserSeq, decision) };
  return result;
};
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
class ReceiptTransport implements StreamTransport {
  live: { onEvent(event: HarnessEvent): void } | null = null;
  closes = 0;
  async connect(opts: { sessionId: string; onReplay(payload: ReplayPayload): void;
    onEvent(event: HarnessEvent): void }): Promise<StreamConnection> {
    this.live = opts;
    queueMicrotask(() => opts.onReplay({ events: [] }));
    return { close: () => { this.closes += 1; } };
  }
  async fetchRecent(): Promise<ReplayPayload> { return { events: [] }; }
}

test('a useful execution result mentioning its approval id remains visible after the card tap', () => {
  const result = completed(5, 3, 'The draft for apr-fixture is saved and its attachment is verified.');
  const rows = foldTranscript([card(), tap,
    event(4, 'approval_resolved', { approvalId: 'apr-fixture', decision: 'approve' }), result], SESSION);
  const answer = rows.find(row => row.text === result.data!.reply);
  assert.ok(answer);
  assert.equal(hiddenCardDecision(answer), false, 'an approval id in an answer is not a receipt classifier');
  assert.equal(rows.find(row => row.approval)?.approval?.resolution, 'approved');
});

test('a card notice without an exact public resolution marker cannot hide a terminal', () => {
  const receipt = completed(5, 3, 'Approval recorded.');
  receipt.data!.notice = { code: 'card_decision' };
  const rows = foldTranscript([card(), tap, receipt], SESSION);
  const terminal = rows.find(row => row.terminal?.notice?.code === 'card_decision');
  assert.ok(terminal);
  assert.equal(hiddenCardDecision(terminal), false);
  assert.equal(rows.find(row => row.approval)?.approval?.resolution, undefined);
});

test('a foreign session resolution cannot decide a same-id local card', () => {
  const foreign = { ...event(4, 'approval_resolved', { approvalId: 'apr-fixture', decision: 'approve' }),
    sessionId: 'different-session' };
  const rows = foldTranscript([card(), foreign], SESSION);
  assert.equal(rows.find(row => row.approval)?.approval?.resolution, undefined);
});

test('only a closed exact typed host receipt can be folded into a card', () => {
  const valid = receipt();
  assert.deepEqual(readApprovalDecisionAck(valid, SESSION), marker());
  const data = valid.data!;
  const presentation = data.presentation as Record<string, unknown>;
  const invalid: HarnessEvent[] = [
    { ...valid, type: 'user_input_received' }, { ...valid, role: 'user' }, { ...valid, seq: 3 },
    { ...valid, sessionId: 'another-session' },
    ...[
      { approvalDecisionAck: { ...marker(), version: 2 } },
      { approvalDecisionAck: { ...marker(), extra: true } },
      { approvalDecisionAck: { ...marker(), sourceUserSeq: NaN } },
      { approvalDecisionAck: { ...marker(), decision: 'approve_with_edits' } },
      { approvalDecisionAck: { ...marker(), approvalId: 'bad\nidentifier' } },
      { sourceUserSeq: 4 }, { notice: { code: 'stopped' } }, { notice: { code: 'card_decision', providerSaid: 'A failure' } },
      { presentation: undefined }, { turnOutcome: { version: 2, status: 'failed', resumable: false } },
      { presentation: { ...presentation, status: 'needs_input', kind: 'question' } },
      { presentation: { ...presentation, identity: { sessionId: SESSION, sourceUserSeq: 4, turn: 1 } } },
      { presentation: { ...presentation, identity: { sessionId: 'another-session', sourceUserSeq: 3, turn: 1 } } },
      { retained: { results: 1, outsideChange: 'none' } }, { retained: { results: 0, outsideChange: 'uncertain' } },
      { review: 'checked' }, { review: 'unchecked', reviewNote: 'A useful finding.' },
      { turnOutcome: { version: 2, status: 'done', resumable: false, evidenceRefs: [{ kind: 'artifact', id: 'fixture' }] } },
      { planArtifactRef: { id: 'fixture' } }, { steps: 1 },
    ].map(change => ({ ...valid, data: { ...data, ...change } })),
  ];
  for (const altered of invalid) assert.equal(readApprovalDecisionAck(altered, SESSION), null, JSON.stringify(altered));
  assert.deepEqual(readApprovalDecisionAck({ ...valid, data: { ...data, review: 'unchecked', steps: 0,
    retained: { results: 0, outsideChange: 'none' } } }, SESSION), marker());
});

test('approve and reject update only the exact card, with no receipt bubble across duplicate replay', () => {
  for (const decision of ['approve', 'reject'] as const) {
    const ack = receipt(5, 3, decision);
    const rows = foldTranscript([card(), card(2, 'apr-other'), { ...tap, data: { ...tap.data, decision } }, ack, ack], SESSION);
    assert.equal(rows.filter(row => !hiddenCardDecision(row) && !row.approval).length, 0);
    assert.equal(rows.find(row => row.approval?.approvalId === 'apr-fixture')?.approval?.resolution,
      decision === 'approve' ? 'approved' : 'declined');
    assert.equal(rows.find(row => row.approval?.approvalId === 'apr-other')?.approval?.resolution, undefined);
  }
});

test('a late receipt preserves changed and expired cards, while absent cards retain a concise decision', () => {
  for (const resolution of ['changed', 'expired', 'declined'] as const) {
    const rows = [{ id: 'card', role: 'assistant', approval: { approvalId: 'apr-fixture', resolution } }];
    const applied = applyApprovalDecisionAck(rows, marker() as NonNullable<ReturnType<typeof readApprovalDecisionAck>>);
    assert.equal(applied.matched, false);
    assert.equal(applied.messages, rows);
  }
  const ack = receipt();
  const rows = foldTranscript([ack, ack], SESSION);
  assert.deepEqual(rows.map(row => row.text), ['Approved.']);
  assert.equal(rows[0]?.terminal, undefined, 'a host notice cannot erase the absent-card fallback');
});

test('copied receipt metadata cannot hide a useful result, failure, question or retained evidence', () => {
  const useful = completed(5, 3, 'The fixture draft and attachment are saved.');
  useful.data!.approvalDecisionAck = marker();
  const failed = { ...receipt(), data: { ...receipt().data,
    presentation: { ...(receipt().data!.presentation as object), status: 'failed' },
    turnOutcome: { version: 2, status: 'failed', resumable: false }, notice: { code: 'run_failed' } } };
  const question = { ...receipt(), data: { ...receipt().data,
    presentation: { ...(receipt().data!.presentation as object), status: 'needs_input', kind: 'question', text: 'Which fixture?' },
    turnOutcome: { version: 2, status: 'needs_input', resumable: true }, notice: undefined } };
  const kept = { ...receipt(), data: { ...receipt().data, retained: { results: 2, outsideChange: 'uncertain' } } };
  for (const terminal of [useful, failed, question, kept]) {
    const rows = foldTranscript([card(), tap, terminal], SESSION);
    const result = rows.find(row => row.role === 'assistant' && !row.approval);
    assert.ok(result);
    assert.equal(hiddenCardDecision(result), false);
  }
});

test('a live receipt updates its card while preserving human work, pending steering and exact Stop ownership', async () => {
  const transport = new ReceiptTransport();
  let acceptSteer!: () => void;
  const steering = new Promise<void>(resolve => { acceptSteer = resolve; });
  let sends = 0;
  const engine = new ChatEngine({ sessionId: SESSION, transport, newIdempotencyKey: () => 'human-stop-key', api: {
    loadSession: async () => ({ events: [card()], latestSeq: 2 }),
    send: async () => { sends += 1; if (sends > 1) await steering;
      return { sessionId: SESSION, accepted: true, ...(sends > 1 ? { steered: true, noteSeq: 15 } : {}) }; },
  } });
  let steer: Promise<void> | undefined;
  try {
    await engine.open();
    await engine.send('Continue the fixture.');
    await tick();
    transport.live!.onEvent({ ...event(10, 'user_input_received', { text: 'Continue the fixture.' }), role: 'user', turn: 1 });
    transport.live!.onEvent(event(0, 'stream_token', { sourceUserSeq: 10, delta: 'Checking the original work' }));
    steer = engine.send('Keep the attachment.');
    const before = engine.snapshot();
    const liveApprovalControl = { version: 1, ownerAttemptId: 'fixture-original-owner', ownerSourceUserSeq: 10 };
    transport.live!.onEvent(event(12, 'user_input_received', { synthetic: true, liveApprovalControl }));
    const ack = receipt(13, 12);
    ack.data!.liveApprovalControl = liveApprovalControl;
    transport.live!.onEvent(ack);
    transport.live!.onEvent(ack);
    const after = engine.snapshot();
    assert.equal(after.busy, true);
    assert.equal(after.activeSourceUserSeq, 10);
    assert.equal(after.cancelKey, 'human-stop-key');
    assert.deepEqual(after.messages.filter(row => !row.approval), before.messages.filter(row => !row.approval));
    assert.equal(after.messages.find(row => row.approval)?.approval?.resolution, 'approved');
    assert.equal(transport.closes, 1, 'only the earlier idle observer was replaced by send');
    transport.live!.onEvent(completed(14, 10, 'The original fixture work is complete.'));
    assert.equal(engine.snapshot().busy, false);
    assert.ok(engine.snapshot().messages.some(row => row.text === 'The original fixture work is complete.'));
  } finally { acceptSteer(); await steer; engine.dispose(); }
});

test('an ordinary card source retires only its decision placeholder, and reopen keeps a live human source', async () => {
  const transport = new ReceiptTransport();
  const engine = new ChatEngine({ sessionId: SESSION, transport, api: {
    loadSession: async () => ({ events: [card()], latestSeq: 2 }),
    send: async () => ({ sessionId: SESSION, accepted: true }),
  } });
  try {
    await engine.open();
    await engine.send('Approve apr-fixture.', undefined, { cardDecision: { approvalId: 'apr-fixture', decision: 'approve' } });
    await tick();
    transport.live!.onEvent(tap);
    transport.live!.onEvent(receipt());
    assert.equal(engine.snapshot().busy, false);
    assert.equal(engine.snapshot().messages.filter(row => !hiddenCardDecision(row) && !row.approval).length, 0);
  } finally { engine.dispose(); }
  const liveApprovalControl = { version: 1, ownerAttemptId: 'fixture-original-owner', ownerSourceUserSeq: 10 };
  const ack = receipt(13, 12);
  ack.data!.liveApprovalControl = liveApprovalControl;
  const events = [card(), { ...event(10, 'user_input_received', { text: 'Original work' }), role: 'user', turn: 1 },
    event(12, 'user_input_received', { synthetic: true, liveApprovalControl }), ack];
  assert.equal(inFlightTurnSince(events), 9);
  const reopened = new ChatEngine({ sessionId: SESSION, transport: new ReceiptTransport(), api: {
    send: async () => ({ sessionId: SESSION, accepted: true }),
    loadSession: async () => ({ events, latestSeq: 13 }),
  } });
  try {
    await reopened.open();
    assert.equal(reopened.snapshot().busy, true);
    assert.equal(reopened.snapshot().activeSourceUserSeq, 10);
    assert.equal(reopened.snapshot().messages.find(row => row.approval)?.approval?.resolution, 'approved');
    assert.equal(reopened.snapshot().messages.some(row => row.id === 'control-ack-13'), false);
  } finally { reopened.dispose(); }
});
