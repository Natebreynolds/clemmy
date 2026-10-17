import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { UsageEvent } from '../../src/runtime/usage-log.js';
import { selectAcceptedTaskNoticingUsage, type NoticingAccountingParticipant } from './accepted-task-noticing-usage.js';

const id = 'noticing-job:11111111-1111-4111-8111-111111111111';
const other = 'noticing-job:22222222-2222-4222-8222-222222222222';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function participant(usageJobId = id): NoticingAccountingParticipant {
  return { usageJobId, operation: 'noticing_answer', operationId: 'controlled-checkin', revisionDigest: 'a'.repeat(64),
    parentAcceptedSources: ['controlled:17'], startedAt: 1, finishedAt: 3,
    responseBindings: [{ modelCallId: 'controlled-call', physicalAttempt: 1, providerResponseIdDigest: hash('original-provider-id') }] };
}
function row(delta: Partial<UsageEvent> = {}): UsageEvent {
  return { at: '2026-10-17T00:00:02Z', source: id, kind: 'other', model: 'controlled-model',
    inputTokens: 11, outputTokens: 2, cacheDialect: 'inclusive', responseId: 'original-provider-id',
    trace: { modelCallId: 'controlled-call' }, ...delta };
}
const run = (jobs: NoticingAccountingParticipant[], usage: UsageEvent[], claims = [id]) =>
  selectAcceptedTaskNoticingUsage({ jobs, usage, claimedJobIds: claims, acceptedSources: new Set(['controlled:17']) });

test('standalone usage joins the exact original response, never times, model names or a later accepted turn', () => {
  const rows = [row(), row({ source: 'foreign', trace: { modelCallId: 'unrelated-call' } }),
    row({ trace: { modelCallId: 'controlled-call', acceptedSource: 'later:18', attemptId: 'later-attempt' } }),
    row({ responseId: 'wrong-provider-id' }), row({ source: other })];
  const result = run([participant()], rows);
  assert.deepEqual(result.exactIndices, [0]);
  assert.deepEqual(result.unprovenIndices, [2, 3, 4], 'a foreign namespace reusing the proved local call is contrary evidence too');
  assert.ok(result.issues.includes('noticing_unproved_usage_rows'));
});

test('duplicates and conflicting response/call ownership are retained unproven rather than counted twice', () => {
  const duplicate = run([participant()], [row(), row()]);
  assert.deepEqual(duplicate.exactIndices, []); assert.deepEqual(duplicate.unprovenIndices, [0, 1]);
  assert.ok(duplicate.issues.some(issue => issue.startsWith('noticing_duplicate_usage_response:')));
  const conflict = run([participant(), { ...participant(other), parentAcceptedSources: ['controlled:17'] }], [row(), row({ source: other })], [id, other]);
  assert.deepEqual(conflict.exactIndices, []); assert.deepEqual(conflict.unprovenIndices, [0, 1]);
  assert.ok(conflict.issues.includes('noticing_conflicting_model_call_owner'));
});

test('failed/retried claims, missing usage and shared parentage do not turn into zero or exact task usage', () => {
  const failed = run([], [row({ ok: false, inputTokens: 0, outputTokens: 0 })]);
  assert.deepEqual(failed.exactIndices, []); assert.deepEqual(failed.unprovenIndices, [0]);
  const missing = run([participant()], []);
  assert.ok(missing.issues.some(issue => issue.startsWith('noticing_response_usage_unknown:')));
  const shared = run([{ ...participant(), parentAcceptedSources: ['controlled:17', 'another:19'] }], [row()]);
  assert.deepEqual(shared.exactIndices, []); assert.deepEqual(shared.unprovenIndices, [0]);
  const noResponse = run([{ ...participant(), responseBindings: [] }], []);
  assert.ok(noResponse.issues.some(issue => issue.startsWith('noticing_job_usage_unknown:')));
});

test('retry responses stay distinct under one invocation while repeated participant roots cannot duplicate rows', () => {
  const job = participant();
  job.responseBindings.push({ modelCallId: 'controlled-call', physicalAttempt: 2, providerResponseIdDigest: hash('retry-original') });
  const result = run([job], [row(), row({ responseId: 'retry-original', ok: false })]);
  assert.deepEqual(result.exactIndices, [0, 1]);
  assert.deepEqual(result.unprovenIndices, []);
  const duplicateJob = run([job, job], [row()]);
  assert.deepEqual(duplicateJob.exactIndices, []); assert.deepEqual(duplicateJob.unprovenIndices, [0]);
});

test('an invalid participant cannot borrow a copied main-call ID to remove another source from normal accounting', () => {
  const main = row({ source: 'controlled', trace: { modelCallId: 'controlled-call',
    acceptedSource: 'controlled:17', logicalTurnId: 'turn:17', attemptId: 'main-attempt' } });
  for (const job of [
    { ...participant(), parentAcceptedSources: ['foreign:19'] },
    { ...participant(), responseBindings: [...participant().responseBindings,
      { modelCallId: 'late-invalid', physicalAttempt: 0, providerResponseIdDigest: 'b'.repeat(64) }] },
  ]) {
    const result = run([job], [main, row()]);
    assert.deepEqual(result.exactIndices, []);
    assert.deepEqual(result.unprovenIndices, [1], 'only its own unproved job namespace is related');
  }
});
