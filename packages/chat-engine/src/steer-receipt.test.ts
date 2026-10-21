import test from 'node:test';
import assert from 'node:assert/strict';
import { applySteerReceiptEvent, readSteerReceipt, steerFollowUpRequestId, steerReceiptLabel, unhandledSteerFollowUps } from './steer-receipt.js';
import type { ChatMessage } from './types.js';

const receipt = (state = 'accepted', changedAtSeq = 11) => ({ version: 1, sessionId: 'sess-receipt',
  sourceUserSeq: 10, noteSeq: 11, clientRequestId: 'request-note', state, changedAtSeq });
const note = (state = 'accepted', changedAtSeq = 11) => ({ type: 'user_steer_note', role: 'user',
  sessionId: 'sess-receipt', seq: 11, data: { text: 'Synthetic addition', steerReceipt: receipt(state, changedAtSeq) } });
const status = (state = 'adopted', changedAtSeq = 12) => ({ type: 'user_steer_receipt', role: 'system',
  sessionId: 'sess-receipt', seq: changedAtSeq, data: { receipts: [receipt(state, changedAtSeq)] } });

test('steer receipt: an exact request echo, adoption and replay are one user row without claiming fulfillment', () => {
  const local = { id: 'local', role: 'user' as const, text: 'Synthetic addition', steer: 'pending' as const,
    idempotencyKey: 'request-note', requestSessionId: 'sess-receipt' };
  let rows = applySteerReceiptEvent<ChatMessage>([local], note(), 'sess-receipt');
  assert.equal(rows.length, 1); assert.equal(rows[0]!.id, 'local');
  assert.equal(rows[0]!.steerReceipt?.state, 'accepted');
  rows = applySteerReceiptEvent(rows, status(), 'sess-receipt');
  rows = applySteerReceiptEvent(rows, note(), 'sess-receipt');
  assert.equal(rows.length, 1); assert.equal(rows[0]!.steerReceipt?.state, 'adopted');
  assert.equal((rows[0] as unknown as { acceptedSource?: unknown }).acceptedSource, undefined, 'a note is never a newly accepted turn');
  assert.doesNotMatch(steerReceiptLabel(rows[0]!), /queued|next step|completed|finished|done/i);
});

test('steer receipt: adoption before HTTP acknowledgement cannot regress to accepted', () => {
  const local = { id: 'local', role: 'user' as const, text: 'Synthetic addition', steer: 'pending' as const,
    idempotencyKey: 'request-note', requestSessionId: 'sess-receipt' };
  let rows = applySteerReceiptEvent<ChatMessage>([local], status(), 'sess-receipt');
  rows = applySteerReceiptEvent(rows, note(), 'sess-receipt');
  assert.equal(rows.length, 1); assert.equal(rows[0]!.steerReceipt?.state, 'adopted');
});

test('steer receipt: terminal receipts distinguish an unhandled saved addition from adoption', () => {
  let rows = applySteerReceiptEvent<ChatMessage>([], note(), 'sess-receipt');
  rows = applySteerReceiptEvent(rows, { type: 'conversation_completed', sessionId: 'sess-receipt', seq: 14,
    data: { sourceUserSeq: 10, steerReceipts: [receipt('unhandled', 14)] } }, 'sess-receipt');
  assert.equal(rows[0]!.steerReceipt?.state, 'unhandled');
  assert.match(steerReceiptLabel(rows[0]!), /ended.*kept/i);
  const adopted = applySteerReceiptEvent<ChatMessage>([], note('adopted', 12), 'sess-receipt');
  const final = applySteerReceiptEvent(adopted, { type: 'conversation_completed', sessionId: 'sess-receipt', seq: 14,
    data: { sourceUserSeq: 10, steerReceipts: [receipt('adopted', 12)] } }, 'sess-receipt');
  assert.equal(final[0]!.steerReceipt?.state, 'adopted');
});

test('steer receipt: an addition the run ended without reading goes on from the window that sent it, once', () => {
  // Live 2026-10-21: "we cant even write notes?" sat under "your message is
  // kept" with nothing to send it on.
  const sent = { id: 'echo-1', role: 'user' as const, text: 'Synthetic addition', steer: 'pending' as const,
    idempotencyKey: 'request-note', requestSessionId: 'sess-receipt' };
  let rows = applySteerReceiptEvent<ChatMessage>([sent as ChatMessage], note(), 'sess-receipt');
  rows = applySteerReceiptEvent(rows, { type: 'conversation_completed', sessionId: 'sess-receipt', seq: 14,
    data: { sourceUserSeq: 10, steerReceipts: [receipt('unhandled', 14)] } }, 'sess-receipt');
  assert.deepEqual(unhandledSteerFollowUps(rows).map((row) => row.id), ['echo-1']);
  const id = steerFollowUpRequestId(rows[0]!.steerReceipt!);
  assert.equal(id, 'steer-followup:sess-receipt:11');
  assert.ok(/^[A-Za-z0-9._:-]{8,160}$/.test(id), 'a request id the daemon accepts');
  const followed = rows.map((row) => ({ ...row, steerFollowUp: 'sent' as const }));
  assert.deepEqual(unhandledSteerFollowUps(followed), [], 'followed up once');
  assert.match(steerReceiptLabel(followed[0]!), /its own message/);
  assert.match(steerReceiptLabel({ ...followed[0]!, steerFollowUp: 'held' }), /finished before reading/);
  // A later receipt replay keeps the follow-up state.
  const replayed = applySteerReceiptEvent(followed, { type: 'conversation_completed', sessionId: 'sess-receipt', seq: 15,
    data: { sourceUserSeq: 10, steerReceipts: [receipt('unhandled', 15)] } }, 'sess-receipt');
  assert.equal(replayed[0]!.steerFollowUp, 'sent');
  // A row only seen in history (no request id of this window's) is not sent on its own.
  const history = applySteerReceiptEvent<ChatMessage>([], note('unhandled', 14), 'sess-receipt');
  assert.deepEqual(unhandledSteerFollowUps(history), []);
});

test('steer receipt: foreign identity, wrong source, malformed bounds and text-only matches are inert', () => {
  const rows = applySteerReceiptEvent<ChatMessage>([], note(), 'sess-receipt');
  assert.equal(applySteerReceiptEvent(rows, { ...status(), sessionId: 'sess-foreign' }, 'sess-receipt'), rows);
  assert.equal(applySteerReceiptEvent(rows, { ...status(), data: { receipts: [{ ...receipt('adopted', 12), sourceUserSeq: 9 }] } }, 'sess-receipt'), rows);
  for (const bad of [{ ...receipt(), noteSeq: 10 }, { ...receipt(), changedAtSeq: 9 },
    { ...receipt(), sessionId: '' }, { ...receipt(), state: 'completed' }, { ...receipt(), version: 2 },
    { ...receipt(), clientEchoId: 'https://private.invalid/capability' }, { ...receipt(), clientEchoId: 'x'.repeat(241) }]) {
    assert.equal(readSteerReceipt(bad), null);
  }
  const unrelated = [{ id: 'different', role: 'user' as const, text: 'Synthetic addition' }];
  assert.equal(applySteerReceiptEvent(unrelated, note(), 'sess-receipt').length, 2, 'same text never claims identity');
});

test('steer receipt: reopen reconstructs exact source-bound notes and distinct equal text stays distinct', () => {
  let rows = applySteerReceiptEvent<ChatMessage>([], note('adopted', 12), 'sess-receipt');
  rows = applySteerReceiptEvent(rows, { ...note(), seq: 13,
    data: { text: 'Synthetic addition', steerReceipt: { ...receipt('unhandled', 14), noteSeq: 13, clientRequestId: 'request-two' } } }, 'sess-receipt');
  assert.equal(rows.length, 2); assert.equal(rows[0]!.steerReceipt?.state, 'adopted');
  assert.equal(rows[1]!.steerReceipt?.state, 'unhandled');
});

test('steer receipt: unknown bounded or legacy handling stays visible without a future queue promise', () => {
  let rows = applySteerReceiptEvent<ChatMessage>([], { ...note(), data: { text: 'Synthetic addition' } }, 'sess-receipt');
  rows = applySteerReceiptEvent(rows, { ...note(), data: { text: 'Synthetic addition' } }, 'sess-receipt');
  assert.equal(rows.length, 1); assert.equal(rows[0]!.steerReceipt, undefined);
  assert.equal(steerReceiptLabel(rows[0]!), 'Received for this run');
  assert.doesNotMatch(steerReceiptLabel(rows[0]!), /queued|next step|used|completed/i);
});
