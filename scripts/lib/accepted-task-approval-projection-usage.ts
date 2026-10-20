import { createHash } from 'node:crypto';
import type { UsageEvent } from '../../src/runtime/usage-log.js';

/** Display-job accounting only. None of these coordinates belongs to B's
 * closed execution attempt or grants task/effect/presentation authority. */
export interface ApprovalProjectionModelAttempt {
  modelCallId: string;
  physicalAttempt: number;
  outcome: 'returned' | 'failed' | 'unfinished' | 'unknown';
  dispatches: number;
  /** Relative to this display job's closure, never B's terminal. Null means
   * the retained closure/host-clock evidence cannot establish the comparison. */
  late: boolean | null;
  originalResponse?: { hostResultReceiptId: string; providerResponseIdDigest: string; responseOutputDigest?: string };
}
export interface ApprovalProjectionAccountingParticipant {
  projectionId: string;
  usageJobId: string | null;
  operation: 'approval_result_projection';
  revisionDigest: string;
  parentAcceptedSource: string;
  executionAcceptedSource: string;
  terminalEventId: string;
  status: string;
  accountingQualified: boolean;
  authoredResponseBound: boolean;
  attempts: ApprovalProjectionModelAttempt[];
  startedAt: number | null;
  finishedAt: number | null;
}
export interface ApprovalProjectionUsageSelection {
  exactIndices: number[];
  unprovenIndices: number[];
  issues: string[];
}
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && value.trim() === value && !/[\u0000-\u0020\u007f]/.test(value);
export const approvalProjectionJobId = (value: unknown): value is string => typeof value === 'string'
  && /^approval-projection-job:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Select indices in the existing single canonical usage read. A failed
 * attempt without an original-response bridge is possible spend, never zero.
 * An invalid claim cannot capture a foreign main/source row by copying its ID. */
export function selectAcceptedTaskApprovalProjectionUsage(input: {
  jobs: readonly ApprovalProjectionAccountingParticipant[];
  claimedJobIds: readonly string[];
  acceptedSources: ReadonlySet<string>;
  usage: readonly UsageEvent[];
}): ApprovalProjectionUsageSelection {
  const issues = new Set<string>();
  const claims = new Set(input.claimedJobIds.filter(approvalProjectionJobId));
  const jobs = new Map<string, ApprovalProjectionAccountingParticipant>();
  const invalid = new Set<string>();
  const projectionOwners = new Map<string, string>();
  const callOwners = new Map<string, string>();
  const responseOwners = new Map<string, string>();
  const receiptOwners = new Map<string, string>();
  const bindings = new Map<string, { job: string; call: string; response: string }>();
  for (const job of input.jobs) {
    if (job.usageJobId === null) { issues.add('approval_projection_job_not_started'); continue; }
    if (!approvalProjectionJobId(job.usageJobId)) { issues.add('approval_projection_invalid_job_identity'); continue; }
    if (jobs.has(job.usageJobId)) { invalid.add(job.usageJobId); issues.add('approval_projection_duplicate_job'); continue; }
    jobs.set(job.usageJobId, job);
    const parentSource = /^(.+):([1-9]\d*)$/.exec(job.parentAcceptedSource);
    const executionSource = /^(.+):([1-9]\d*)$/.exec(job.executionAcceptedSource);
    if (!claims.has(job.usageJobId) || job.operation !== 'approval_result_projection' || job.projectionId !== `approved-result:v1:${job.revisionDigest}`
      || !digest(job.revisionDigest) || !input.acceptedSources.has(job.parentAcceptedSource)
      || !parentSource || !executionSource || parentSource[1] !== executionSource[1]
      || !Number.isSafeInteger(Number(executionSource[2])) || Number(executionSource[2]) <= Number(parentSource[2])
      || !safeId(job.executionAcceptedSource) || !safeId(job.terminalEventId) || !job.accountingQualified) {
      invalid.add(job.usageJobId); issues.add('approval_projection_unproved_job_parent'); continue;
    }
    const priorProjection = projectionOwners.get(job.projectionId);
    if (priorProjection && priorProjection !== job.usageJobId) {
      invalid.add(priorProjection); invalid.add(job.usageJobId); issues.add('approval_projection_conflicting_job_owner');
    }
    projectionOwners.set(job.projectionId, job.usageJobId);
    const attempts = new Set<string>();
    for (const attempt of job.attempts) {
      const key = JSON.stringify([job.usageJobId, attempt.modelCallId, attempt.physicalAttempt]);
      if (!safeId(attempt.modelCallId) || !Number.isSafeInteger(attempt.physicalAttempt) || attempt.physicalAttempt < 1
        || attempts.has(key)) { invalid.add(job.usageJobId); issues.add('approval_projection_invalid_attempt'); continue; }
      attempts.add(key);
      if (attempt.outcome !== 'returned' || !attempt.originalResponse) issues.add('approval_projection_attempt_usage_unknown');
      const priorCall = callOwners.get(attempt.modelCallId);
      if (priorCall && priorCall !== job.usageJobId) {
        invalid.add(priorCall); invalid.add(job.usageJobId); issues.add('approval_projection_conflicting_model_call_owner');
      }
      callOwners.set(attempt.modelCallId, job.usageJobId);
      const response = attempt.originalResponse;
      if (!response) continue;
      if (!digest(response.providerResponseIdDigest) || !safeId(response.hostResultReceiptId)) {
        invalid.add(job.usageJobId); issues.add('approval_projection_invalid_original_response'); continue;
      }
      for (const [owners, id] of [[responseOwners, response.providerResponseIdDigest], [receiptOwners, response.hostResultReceiptId]] as const) {
        const prior = owners.get(id);
        if (prior && prior !== key) {
          const priorJob = bindings.get(prior)?.job;
          if (priorJob) invalid.add(priorJob);
          invalid.add(job.usageJobId); issues.add('approval_projection_conflicting_original_response');
        }
        owners.set(id, key);
      }
      bindings.set(key, { job: job.usageJobId, call: attempt.modelCallId, response: response.providerResponseIdDigest });
    }
    if (job.attempts.length === 0) issues.add('approval_projection_physical_inventory_unknown');
    if (job.finishedAt === null || job.startedAt === null) issues.add('approval_projection_job_lifecycle_unknown');
  }
  const exact = new Set<number>(), unproven = new Set<number>();
  const rowsByBinding = new Map<string, number[]>();
  input.usage.forEach((row, index) => {
    if (!claims.has(row.source)) return;
    unproven.add(index);
    // Standalone writer usage must remain parentless, including after Stop.
    // Time, source namespace, requested model and parsed prose cannot bridge it.
    if (!approvalProjectionJobId(row.source) || invalid.has(row.source) || !jobs.has(row.source)
      || row.role !== 'writer' || row.channel !== 'writer:approval_result_projection'
      || !safeId(row.trace?.modelCallId) || !safeId(row.responseId)
      || Object.keys(row.trace!).some(key => key !== 'modelCallId')
      || row.runId !== undefined || row.stepId !== undefined || row.itemKey !== undefined) return;
    const response = createHash('sha256').update(row.responseId).digest('hex');
    const matched = [...bindings.entries()].filter(([, binding]) => binding.job === row.source
      && binding.call === row.trace!.modelCallId && binding.response === response);
    if (matched.length !== 1) return;
    const key = matched[0]![0];
    rowsByBinding.set(key, [...(rowsByBinding.get(key) ?? []), index]);
  });
  for (const [key, binding] of bindings) {
    if (invalid.has(binding.job)) continue;
    const indices = rowsByBinding.get(key) ?? [];
    if (indices.length === 1) { exact.add(indices[0]!); unproven.delete(indices[0]!); }
    else issues.add(indices.length > 1 ? 'approval_projection_duplicate_usage_response' : 'approval_projection_response_usage_unknown');
  }
  if (unproven.size) issues.add('approval_projection_unproved_usage_rows');
  return { exactIndices: [...exact].sort((a, b) => a - b), unprovenIndices: [...unproven].sort((a, b) => a - b), issues: [...issues].sort() };
}
