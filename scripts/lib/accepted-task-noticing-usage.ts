import { createHash } from 'node:crypto';
import type { UsageEvent } from '../../src/runtime/usage-log.js';

/** Accounting evidence only. These identities never become task, tool or
 * review authority, nor widen the accepted task's execution-time window. */
export interface NoticingAccountingParticipant {
  usageJobId: string;
  operation: 'noticing_proposal' | 'noticing_answer';
  operationId: string;
  revisionDigest: string;
  parentAcceptedSources: string[];
  responseBindings: Array<{ modelCallId: string; physicalAttempt: number; providerResponseIdDigest: string }>;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface NoticingUsageSelection {
  exactIndices: number[];
  unprovenIndices: number[];
  issues: string[];
}
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && value.trim() === value && !/[\u0000-\u0020\u007f]/.test(value);
const jobId = (value: unknown): value is string => typeof value === 'string'
  && /^noticing-job:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Select row indices in the one canonical usage read. A job namespace alone
 * retains possible spend but cannot prove the original response. Conflicting
 * or duplicate response records stay visible as unproven, never doubled. */
export function selectAcceptedTaskNoticingUsage(input: {
  jobs: readonly NoticingAccountingParticipant[];
  claimedJobIds: readonly string[];
  acceptedSources: ReadonlySet<string>;
  usage: readonly UsageEvent[];
}): NoticingUsageSelection {
  const issues = new Set<string>();
  const claims = new Set(input.claimedJobIds.filter(jobId));
  const jobs = new Map<string, NoticingAccountingParticipant>();
  const invalid = new Set<string>();
  const bindings = new Map<string, { job: string; call: string; response: string; key: string }>();
  const digestOwners = new Map<string, string>();
  const callOwners = new Map<string, string>();
  const conflictingBindings = new Set<string>();
  for (const job of input.jobs) {
    if (!jobId(job.usageJobId)) { issues.add('noticing_invalid_job_identity'); continue; }
    claims.add(job.usageJobId);
    if (jobs.has(job.usageJobId)) { invalid.add(job.usageJobId); issues.add(`noticing_duplicate_job:${job.usageJobId}`); continue; }
    jobs.set(job.usageJobId, job);
    if (!['noticing_proposal', 'noticing_answer'].includes(job.operation) || !safeId(job.operationId)
      || !digest(job.revisionDigest) || job.parentAcceptedSources.length !== 1
      || !input.acceptedSources.has(job.parentAcceptedSources[0]!)) {
      invalid.add(job.usageJobId); issues.add(`noticing_unproved_job_parent:${job.usageJobId}`);
    }
    for (const response of job.responseBindings) {
      if (!safeId(response.modelCallId) || !digest(response.providerResponseIdDigest)
        || !Number.isSafeInteger(response.physicalAttempt) || response.physicalAttempt <= 0) {
        invalid.add(job.usageJobId); issues.add(`noticing_invalid_response_binding:${job.usageJobId}`); continue;
      }
    }
    if (job.responseBindings.length === 0) issues.add(`noticing_job_usage_unknown:${job.usageJobId}`);
  }
  // Unproved claims can name only their own namespace. Validate the WHOLE
  // participant before a copied call ID may relate a different usage source.
  for (const job of jobs.values()) {
    if (invalid.has(job.usageJobId)) continue;
    for (const response of job.responseBindings) {
      const key = JSON.stringify([job.usageJobId, response.modelCallId, response.physicalAttempt, response.providerResponseIdDigest]);
      const priorDigest = digestOwners.get(response.providerResponseIdDigest);
      const priorCallJob = callOwners.get(response.modelCallId);
      if (priorDigest !== undefined && priorDigest !== key) {
        conflictingBindings.add(priorDigest); conflictingBindings.add(key);
        issues.add('noticing_conflicting_original_response');
      }
      if (priorCallJob !== undefined && priorCallJob !== job.usageJobId) {
        invalid.add(priorCallJob); invalid.add(job.usageJobId); issues.add('noticing_conflicting_model_call_owner');
      }
      digestOwners.set(response.providerResponseIdDigest, key);
      callOwners.set(response.modelCallId, job.usageJobId);
      bindings.set(key, { job: job.usageJobId, call: response.modelCallId, response: response.providerResponseIdDigest, key });
    }
  }
  const exact = new Set<number>();
  const unproven = new Set<number>();
  const rowsByBinding = new Map<string, number[]>();
  input.usage.forEach((row, index) => {
    const call = row.trace?.modelCallId;
    if (!claims.has(row.source) && !(safeId(call) && callOwners.has(call))) return;
    unproven.add(index);
    // Standalone producers deliberately retain only a local call ID. Any
    // donated accepted-source/attempt/workflow trace is contrary evidence.
    if (!jobId(row.source) || invalid.has(row.source) || !jobs.has(row.source)
      || !safeId(call) || !safeId(row.responseId) || !row.trace
      || Object.keys(row.trace).some(key => key !== 'modelCallId')
      || row.runId !== undefined || row.stepId !== undefined || row.itemKey !== undefined) return;
    const response = createHash('sha256').update(row.responseId).digest('hex');
    const matching = [...bindings.values()].filter(binding => binding.job === row.source
      && binding.call === call && binding.response === response && !conflictingBindings.has(binding.key));
    if (matching.length !== 1) return;
    const key = matching[0]!.key;
    rowsByBinding.set(key, [...(rowsByBinding.get(key) ?? []), index]);
  });
  for (const binding of bindings.values()) {
    if (invalid.has(binding.job) || conflictingBindings.has(binding.key)) continue;
    const indices = rowsByBinding.get(binding.key) ?? [];
    if (indices.length === 1) { exact.add(indices[0]!); unproven.delete(indices[0]!); }
    else issues.add(`${indices.length > 1 ? 'noticing_duplicate_usage_response' : 'noticing_response_usage_unknown'}:${binding.job}`);
  }
  if (unproven.size) issues.add('noticing_unproved_usage_rows');
  return { exactIndices: [...exact].sort((a, b) => a - b),
    unprovenIndices: [...unproven].sort((a, b) => a - b), issues: [...issues].sort() };
}
