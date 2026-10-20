import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalResultFields, normalizeApprovalResultResponse, normalizePendingActionResultRecord,
  normalizePendingActionPublicResult, mergeApprovalResultRecord, pendingActionPresentationCopy,
  pendingActionRecordPresentation, type PendingActionResultRecord,
} from './pending-action-result.js';
import { foldTranscript, ChatEngine } from './engine.js';
import type { HarnessEvent, ReplayPayload } from './types.js';
import type { StreamTransport } from './stream.js';
const owner = 'fixture-parent';
const at = '2026-10-19T12:00:00.000Z';
const later = '2026-10-19T12:00:02.000Z';
const record = (status = 'executed', updatedAt = at): PendingActionResultRecord => ({
  id: 'pa-fixture', approvalId: 'apr-fixture', payloadHash: 'a'.repeat(16), updatedAt, status, resultSummary: 'Recorded raw output.',
});
const withResult = (source: 'record' | 'terminal', status = 'executed', updatedAt = at): PendingActionResultRecord => {
  const r = record(status, updatedAt);
  return { ...r, publicResult: { version: 1, pendingActionId: r.id, approvalId: r.approvalId, payloadHash: r.payloadHash,
    recordUpdatedAt: r.updatedAt, status: status as 'executed', source, text: source === 'terminal' ? 'The approved call completed.' : 'This action completed.',
    ...(source === 'terminal' ? { terminal: { eventId: 'event-terminal', sourceUserSeq: 12 } } : {}) } };
};
const lookup = { sessionId: owner, approvalId: 'apr-fixture' };
const response = (r = record()) => ({ ...lookup, pendingAction: r });

test('one exact-card discovery pins its returned relation and later progress is revision-monotonic', () => {
  const first = normalizeApprovalResultResponse(response(record('executing')), lookup)!;
  assert.equal(first.binding.pendingActionId, 'pa-fixture');
  assert.equal(first.binding.recordUpdatedAt, at);
  const progressed = normalizeApprovalResultResponse(response(record('executed', later)), first.binding)!;
  assert.equal(progressed.binding.recordUpdatedAt, later);
  assert.equal(normalizeApprovalResultResponse(response(), progressed.binding), null);
  for (const altered of [ { sessionId: 'foreign' }, { approvalId: 'apr-other' },
    { pendingAction: { ...record(), id: 'pa-other' } }, { pendingAction: { ...record(), payloadHash: 'b'.repeat(16) } } ]) {
    assert.equal(normalizeApprovalResultResponse({ ...response(), ...altered }, first.binding), null);
  }
});

test('malformed result containers never become public result text', () => {
  const r = withResult('terminal');
  for (const bad of [null, [], { ...r, updatedAt: 'not-a-date' }, { ...r, status: 'future_status' },
    { ...r, resultSummary: 'x'.repeat(16_001) }]) assert.equal(normalizePendingActionResultRecord(bad), null);
  for (const bad of [[], { ...r.publicResult, version: 2 }, { ...r.publicResult, pendingActionId: 'other' },
    { ...r.publicResult, payloadHash: 'other' }, { ...r.publicResult, recordUpdatedAt: later },
    { ...r.publicResult, status: 'failed' }, { ...r.publicResult, text: 'x'.repeat(12_001) },
    { ...r.publicResult, terminal: { eventId: 'e', sourceUserSeq: 0 } }, { ...r.publicResult, source: 'provider' }]) {
    assert.equal(normalizePendingActionPublicResult(bad, r), null);
  }
  assert.equal(normalizePendingActionResultRecord({ ...r, publicResult: { text: 'untrusted' } })?.publicResult, undefined);
});

test('raw record evidence remains details; only a bound public projection supplies answer copy', () => {
  const legacy = pendingActionPresentationCopy(pendingActionRecordPresentation(record())!);
  assert.notEqual(legacy.note, record().resultSummary);
  assert.equal(legacy.details, record().resultSummary);
  const terminal = withResult('terminal');
  const copy = pendingActionPresentationCopy(pendingActionRecordPresentation(terminal)!);
  assert.equal(copy.note, terminal.publicResult!.text);
  assert.equal(copy.details, terminal.resultSummary);
  const running = pendingActionPresentationCopy(pendingActionRecordPresentation(record('executing'))!);
  assert.match(running.note!, /running/);
  assert.equal(running.details, record().resultSummary);
});

test('known execution and approved records close decision controls without claiming whole-task completion', () => {
  assert.equal(pendingActionRecordPresentation(record('approved'))?.phase, 'queued');
  assert.equal(pendingActionRecordPresentation(record('executing'))?.phase, 'running');
  for (const s of ['queued', 'approval_requested']) assert.equal(pendingActionRecordPresentation(record(s)), null);
});

test('record merge admits normal running-to-completed progress and exact terminal enrichment only', () => {
  const running = withResult('record', 'executing');
  const done = withResult('terminal', 'executed', later);
  assert.equal(mergeApprovalResultRecord(running, done), done);
  const before = withResult('record'); const after = withResult('terminal');
  assert.equal(mergeApprovalResultRecord(before, after), after);
  assert.equal(mergeApprovalResultRecord(after, before), after);
  assert.equal(mergeApprovalResultRecord(after, record()), after);
  for (const bad of [ { ...after, status: 'failed' }, { ...after, resultSummary: 'different' },
    { ...after, publicResult: { ...after.publicResult!, text: 'changed' } },
    { ...after, publicResult: { ...after.publicResult!, terminal: { eventId: 'another', sourceUserSeq: 12 } } },
    { ...after, publicResult: { ...after.publicResult!, terminal: { eventId: 'event-terminal', sourceUserSeq: 13 } } } ]) {
    assert.equal(mergeApprovalResultRecord(after, bad), null);
  }
  assert.equal(mergeApprovalResultRecord(done, after), null);
});

test('slim old events can discover only their exact card, conflicting embedded records are dropped', () => {
  assert.deepEqual(approvalResultFields({ approvalId: lookup.approvalId }, owner), { ownerSessionId: owner });
  assert.deepEqual(approvalResultFields({ approvalId: lookup.approvalId }, undefined), {});
  assert.deepEqual(approvalResultFields({ approvalId: lookup.approvalId, pendingActionId: 'other', pendingAction: record() }, owner), {});
  assert.deepEqual(approvalResultFields({ approvalId: 'apr-other', pendingAction: record() }, owner), {});
  assert.equal(approvalResultFields({ approvalId: lookup.approvalId, pendingAction: withResult('terminal') }, owner).resultRecord?.publicResult?.source, 'terminal');
});

const card: HarnessEvent = { seq: 2, type: 'approval_requested', sessionId: owner, data: {
  approvalId: lookup.approvalId, subject: 'Controlled action', pendingAction: withResult('record', 'executing'),
} };
test('replay retains exact raw card owner, known running result and cancelled resolution', () => {
  const rows = foldTranscript([card, { seq: 3, type: 'approval_resolved', sessionId: owner, data: {
    approvalId: lookup.approvalId, decision: 'cancelled', resolution: 'cancelled_by_system',
  } }], owner);
  assert.equal(rows[0]?.approval?.ownerSessionId, owner);
  assert.equal(rows[0]?.approval?.pendingActionId, record().id);
  assert.equal(rows[0]?.approval?.resultRecord?.status, 'executing');
  assert.equal(rows[0]?.approval?.resolution, 'cancelled');
});

test('engine load and live event retain the same result relation without adding model work or suppressing a reply', async () => {
  let event!: (event: HarnessEvent) => void;
  let connects = 0;
  const transport: StreamTransport = {
    async connect(opts) { connects++; event = opts.onEvent; queueMicrotask(() => opts.onReplay({ events: [] })); return { close() {} }; },
    async fetchRecent(): Promise<ReplayPayload> { return { events: [] }; },
  };
  const engine = new ChatEngine({ sessionId: owner, observeWhileIdle: true, transport, api: {
    async loadSession() { return { events: [card], latestSeq: 2 }; },
    async send() { throw new Error('No action or model send is permitted'); },
  } });
  try {
    await engine.open();
    assert.deepEqual(engine.snapshot().messages.find(m => m.approval)?.approval?.resultRecord, withResult('record', 'executing'));
    event({ seq: 3, type: 'approval_resolved', sessionId: owner, data: { approvalId: lookup.approvalId, decision: 'approve' } });
    assert.equal(engine.snapshot().messages.find(m => m.approval)?.approval?.resolution, 'approved');
    assert.equal(connects, 1);
  } finally { engine.dispose(); }
});

test('closed-card presentation preserves locally observed uncertainty/running/settlement against stale waiting props', async () => {
  const { retainPendingActionPresentation } = await import('./pending-action-result.js');
  for (const phase of ['uncertain','running','executed','failed'] as const) {
    const known = { mode: 'durable' as const, phase, note: 'Retained evidence' };
    assert.equal(retainPendingActionPresentation(known, null), known);
    assert.equal(retainPendingActionPresentation(known, { mode: 'durable', phase: 'queued' }), known);
  }
  const incoming = pendingActionRecordPresentation(withResult('terminal'))!;
  assert.equal(retainPendingActionPresentation({ mode: 'durable', phase: 'uncertain' }, incoming), incoming);
});

test('filling an old immutable relation retains pinned identity and the newest observed revision', async () => {
  const { mergeApprovalResultBinding, sameApprovalResultRelation, approvalResultRelationKey } = await import('./pending-action-result.js');
  const first = normalizeApprovalResultResponse(response(record('executed', later)), lookup)!;
  assert.equal(sameApprovalResultRelation(first.binding, lookup), true);
  assert.equal(mergeApprovalResultBinding(first.binding, { ...first.binding, recordUpdatedAt: at }, first.record)?.recordUpdatedAt, later);
  assert.equal(approvalResultRelationKey({ ...first.binding, recordUpdatedAt: at }), approvalResultRelationKey(first.binding));
  assert.equal(sameApprovalResultRelation(first.binding, { ...first.binding, payloadHash: 'other' }), false);
});

function authoredResult(): PendingActionResultRecord {
  const base = withResult('terminal');
  return { ...base, publicResult: { ...base.publicResult!, source: 'authored_projection', text: 'I completed the approved action; the recorded result is available below.',
    projection: { id: 'projection-fixture', revision: 1, evidenceDigest: 'a'.repeat(64), textDigest: 'b'.repeat(64), publishedAt: later } } };
}

test('authored wording enriches only the same settled execution and canonical terminal', async () => {
  const { retainPendingActionPresentation } = await import('./pending-action-result.js');
  const recordOnly = withResult('record'); const terminal = withResult('terminal'); const authored = authoredResult();
  assert.deepEqual(normalizePendingActionResultRecord(authored), authored);
  assert.equal(mergeApprovalResultRecord(recordOnly, authored), authored);
  assert.equal(mergeApprovalResultRecord(terminal, authored), authored);
  assert.equal(mergeApprovalResultRecord(authored, terminal), authored);
  assert.equal(mergeApprovalResultRecord(authored, recordOnly), authored);
  const before = pendingActionRecordPresentation(terminal)!; const after = pendingActionRecordPresentation(authored)!;
  assert.deepEqual(retainPendingActionPresentation(before, after), after);
  assert.equal(retainPendingActionPresentation(after, before), after);
  assert.equal(pendingActionPresentationCopy(after).details, authored.resultSummary);
  assert.equal(pendingActionPresentationCopy(after).note, authored.publicResult!.text);
  for (const change of [
    { ...authored, updatedAt: later, publicResult: { ...authored.publicResult!, recordUpdatedAt: later } },
    { ...authored, resultSummary: 'Changed execution result' },
    { ...authored, publicResult: { ...authored.publicResult!, terminal: { eventId: 'foreign-terminal', sourceUserSeq: 12 } } },
    { ...authored, publicResult: { ...authored.publicResult!, terminal: { eventId: 'event-terminal', sourceUserSeq: 13 } } },
  ]) assert.equal(mergeApprovalResultRecord(terminal, change), null);
  for (const change of [
    { ...authored, publicResult: { ...authored.publicResult!, text: 'Changed authored answer' } },
    { ...authored, publicResult: { ...authored.publicResult!, projection: { ...authored.publicResult!.projection!, textDigest: 'c'.repeat(64) } } },
    { ...authored, publicResult: { ...authored.publicResult!, projection: { ...authored.publicResult!.projection!, id: 'replacement-projection' } } },
  ]) assert.equal(mergeApprovalResultRecord(authored, change), null);
});

test('failed actions and incomplete authored receipts cannot claim authored success', () => {
  const authored = authoredResult();
  for (const change of [
    { ...authored.publicResult!, status: 'failed' },
    { ...authored.publicResult!, terminal: undefined },
    { ...authored.publicResult!, projection: undefined },
    { ...authored.publicResult!, projection: { ...authored.publicResult!.projection!, revision: 2 } },
    { ...authored.publicResult!, projection: { ...authored.publicResult!.projection!, evidenceDigest: 'not-a-digest' } },
    { ...authored.publicResult!, projection: { ...authored.publicResult!.projection!, textDigest: '' } },
  ]) assert.equal(normalizePendingActionPublicResult(change, change.status === 'failed' ? { ...authored, status: 'failed' } : authored), null);
});
