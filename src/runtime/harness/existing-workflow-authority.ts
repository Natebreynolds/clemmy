/**
 * Typed authority for an admitted `run_existing_workflow` operation.
 *
 * Exact name matching is candidate retrieval only. Delete, edit, disable,
 * reschedule, and run never collapse into one host action. A manual run
 * does not suppress a schedule unless the accepted goal says so.
 */
import { createHash } from 'node:crypto';
import type { ManifestEffect } from './capability-manifest.js';

export const EXISTING_WORKFLOW_AUTHORITY_VERSION = 1 as const;

export type ExistingWorkflowHostAction =
  | 'run'
  | 'edit'
  | 'disable'
  | 'delete'
  | 'reschedule';

export type ExistingWorkflowAuthorityRefusal =
  | 'incomplete'
  | 'unknown_action'
  | 'write_judge_required'
  | 'schedule_suppress_not_accepted'
  | 'definition_digest_missing';

export interface ExistingWorkflowAuthorityV1 {
  version: typeof EXISTING_WORKFLOW_AUTHORITY_VERSION;
  action: ExistingWorkflowHostAction;
  workflowId: string;
  workflowSlug: string;
  definitionDigest: string;
  definitionVersion: string;
  normalizedInputsDigest: string;
  effectSummary: ManifestEffect;
  destination?: { family: string; posture: string };
  acceptedGoal: { goalId: string; revision: number };
  writeJudge?: { identity: string; digest: string };
  /** True only when the accepted goal explicitly authorizes schedule skip. */
  suppressSchedule: boolean;
}

const ACTIONS = new Set<ExistingWorkflowHostAction>([
  'run',
  'edit',
  'disable',
  'delete',
  'reschedule',
]);

const WRITE_EFFECTS = new Set(['local_write', 'external_write', 'admin']);

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

export function existingWorkflowAuthorityDigest(authority: ExistingWorkflowAuthorityV1): string {
  return createHash('sha256').update(JSON.stringify({
    version: authority.version,
    action: authority.action,
    workflowId: authority.workflowId,
    workflowSlug: authority.workflowSlug,
    definitionDigest: authority.definitionDigest,
    definitionVersion: authority.definitionVersion,
    normalizedInputsDigest: authority.normalizedInputsDigest,
    effectSummary: authority.effectSummary,
    destination: authority.destination ?? null,
    acceptedGoal: authority.acceptedGoal,
    writeJudge: authority.writeJudge ?? null,
    suppressSchedule: authority.suppressSchedule,
  }), 'utf8').digest('hex');
}

export function validateExistingWorkflowAuthority(
  authority: ExistingWorkflowAuthorityV1 | null | undefined,
): { ok: true; authority: ExistingWorkflowAuthorityV1 } | { ok: false; reason: ExistingWorkflowAuthorityRefusal } {
  if (!authority || authority.version !== EXISTING_WORKFLOW_AUTHORITY_VERSION) {
    return { ok: false, reason: 'incomplete' };
  }
  if (!ACTIONS.has(authority.action)) return { ok: false, reason: 'unknown_action' };
  if (
    !nonBlank(authority.workflowId)
    || !nonBlank(authority.workflowSlug)
    || !nonBlank(authority.definitionDigest)
    || !nonBlank(authority.definitionVersion)
    || !nonBlank(authority.normalizedInputsDigest)
    || !nonBlank(authority.acceptedGoal?.goalId)
    || !Number.isSafeInteger(authority.acceptedGoal.revision)
    || authority.acceptedGoal.revision < 0
  ) {
    return { ok: false, reason: 'incomplete' };
  }
  if (authority.definitionDigest !== authority.definitionDigest.trim()) {
    return { ok: false, reason: 'definition_digest_missing' };
  }
  if (WRITE_EFFECTS.has(authority.effectSummary)) {
    if (!authority.writeJudge?.identity || !authority.writeJudge.digest) {
      return { ok: false, reason: 'write_judge_required' };
    }
  }
  if (authority.suppressSchedule && authority.action !== 'run') {
    return { ok: false, reason: 'schedule_suppress_not_accepted' };
  }
  return { ok: true, authority };
}
