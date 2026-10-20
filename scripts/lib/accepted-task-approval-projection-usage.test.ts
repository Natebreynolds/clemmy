import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { UsageEvent } from '../../src/runtime/usage-log.js';
import { selectAcceptedTaskApprovalProjectionUsage, type ApprovalProjectionAccountingParticipant } from './accepted-task-approval-projection-usage.js';

const jobId = 'approval-projection-job:11111111-1111-4111-8111-111111111111';
const otherId = 'approval-projection-job:22222222-2222-4222-8222-222222222222';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function job(): ApprovalProjectionAccountingParticipant {
  return { projectionId: `approved-result:v1:${'a'.repeat(64)}`, usageJobId: jobId, operation: 'approval_result_projection',
    revisionDigest: 'a'.repeat(64), parentAcceptedSource: 'controlled:17', executionAcceptedSource: 'controlled:22',
    terminalEventId: 'controlled-terminal', status: 'published', accountingQualified: true, authoredResponseBound: true,
    startedAt: 1, finishedAt: 3, attempts: [{ modelCallId: 'controlled-call', physicalAttempt: 1, outcome: 'returned',
      dispatches: 1, late: false, originalResponse: { hostResultReceiptId: 'controlled-original-receipt',
        providerResponseIdDigest: hash('provider-original') } }] };
}
function usage(delta: Partial<UsageEvent> = {}): UsageEvent {
  return { at: '2026-10-19T00:00:02Z', source: jobId, kind: 'other', role: 'writer', channel: 'writer:approval_result_projection',
    model: 'controlled-model', cacheDialect: 'none', inputTokens: 11, outputTokens: 2,
    trace: { modelCallId: 'controlled-call' }, responseId: 'provider-original', ...delta };
}
const select = (jobs: ApprovalProjectionAccountingParticipant[], rows: UsageEvent[], claims = [jobId]) =>
  selectAcceptedTaskApprovalProjectionUsage({ jobs, usage: rows, claimedJobIds: claims, acceptedSources: new Set(['controlled:17']) });

test('only exact original response joins post-terminal writer usage, never B attempt/time/model aliases', () => {
  const rows = [usage(), usage({ responseId: 'wrong' }), usage({ role: 'brain' }), usage({ channel: 'brain' }),
    usage({ trace: { modelCallId: 'controlled-call', acceptedSource: 'controlled:22', logicalTurnId: 'turn:22', attemptId: 'closed-B' } }),
    usage({ source: 'controlled', trace: { modelCallId: 'controlled-call', acceptedSource: 'controlled:17', attemptId: 'main-A' } })];
  const result = select([job()], rows);
  assert.deepEqual(result.exactIndices, [0]); assert.deepEqual(result.unprovenIndices, [1, 2, 3, 4]);
  assert.ok(!result.unprovenIndices.includes(5), 'a copied local ID cannot adopt or remove another accepted source\'s usage');
});

test('failed and unfinished physical attempts remain inventory/unknown spend beside a known returned response', () => {
  const participant = job();
  participant.attempts.unshift({ modelCallId: 'controlled-call', physicalAttempt: 2, outcome: 'failed', dispatches: 1, late: false });
  participant.attempts.push({ modelCallId: 'pending-call', physicalAttempt: 1, outcome: 'unfinished', dispatches: 1, late: true });
  const result = select([participant], [usage(), usage({ ok: false, responseId: undefined, inputTokens: 0, outputTokens: 0 }),
    usage({ trace: { modelCallId: 'pending-call' }, responseId: undefined })]);
  assert.deepEqual(result.exactIndices, [0]); assert.deepEqual(result.unprovenIndices, [1, 2]);
  assert.ok(result.issues.includes('approval_projection_attempt_usage_unknown'));
});

test('late returned responses stay owned after cancelled wording without changing terminal membership', () => {
  const participant = job(); participant.status = 'cancelled'; participant.authoredResponseBound = false;
  participant.attempts[0]!.late = true;
  const result = select([participant], [usage()]);
  assert.deepEqual(result.exactIndices, [0]);
  assert.equal(participant.executionAcceptedSource, 'controlled:22');
  assert.equal(participant.parentAcceptedSource, 'controlled:17');
});

test('physical retry responses remain distinct and duplicates never become two exact rows', () => {
  const participant = job();
  participant.attempts.push({ ...participant.attempts[0]!, physicalAttempt: 2,
    originalResponse: { hostResultReceiptId: 'second-receipt', providerResponseIdDigest: hash('retry-original') } });
  const distinct = select([participant], [usage(), usage({ responseId: 'retry-original' })]);
  assert.deepEqual(distinct.exactIndices, [0, 1]);
  const duplicate = select([job()], [usage(), usage()]);
  assert.deepEqual(duplicate.exactIndices, []); assert.deepEqual(duplicate.unprovenIndices, [0, 1]);
  assert.ok(duplicate.issues.includes('approval_projection_duplicate_usage_response'));
});

test('unproved job, parent, namespace or shared original identity cannot certify task costs', () => {
  for (const participant of [
    { ...job(), parentAcceptedSource: 'foreign:17' }, { ...job(), accountingQualified: false },
    { ...job(), executionAcceptedSource: 'foreign:22' }, { ...job(), executionAcceptedSource: 'controlled:16' },
    { ...job(), revisionDigest: 'b'.repeat(64) },
  ]) {
    const result = select([participant], [usage(), usage({ source: 'foreign', trace: { modelCallId: 'controlled-call' } })]);
    assert.deepEqual(result.exactIndices, []); assert.deepEqual(result.unprovenIndices, [0]);
  }
  const other = { ...job(), usageJobId: otherId, projectionId: `approved-result:v1:${'b'.repeat(64)}`, revisionDigest: 'b'.repeat(64) };
  const conflict = select([job(), other], [usage(), usage({ source: otherId })], [jobId, otherId]);
  assert.deepEqual(conflict.exactIndices, []); assert.deepEqual(conflict.unprovenIndices, [0, 1]);
  assert.ok(conflict.issues.includes('approval_projection_conflicting_model_call_owner'));
});

test('queued/no-attempt, missing usage and duplicate participant are unqualified, never proof of zero spend', () => {
  const queued = select([{ ...job(), usageJobId: null, status: 'queued', attempts: [], startedAt: null, finishedAt: null }], []);
  assert.ok(queued.issues.includes('approval_projection_job_not_started'));
  const unknown = select([{ ...job(), attempts: [] }], []);
  assert.ok(unknown.issues.includes('approval_projection_physical_inventory_unknown'));
  const missing = select([job()], []);
  assert.ok(missing.issues.includes('approval_projection_response_usage_unknown'));
  const duplicate = select([job(), job()], [usage()]);
  assert.deepEqual(duplicate.exactIndices, []); assert.deepEqual(duplicate.unprovenIndices, [0]);
  const contraryOwnership = select([{ ...job(), accountingQualified: false }], [usage()], []);
  assert.deepEqual(contraryOwnership.exactIndices, []); assert.deepEqual(contraryOwnership.unprovenIndices, [],
    'a namespace independently shown to belong elsewhere must not be debited even as possible task spend');
});
