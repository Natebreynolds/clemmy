import type { NotificationRecord } from '../runtime/notifications.js';

export interface WorkflowCapabilityAccountChoice {
  label: string;
  capabilityId: string;
  accountId: string;
}

export type WorkflowCapabilityInboxResolution =
  | {
      kind: 'choose_account';
      retryCount: number;
      choiceSetDigest: string;
      candidates: WorkflowCapabilityAccountChoice[];
      choiceTotal: number;
      choicesTruncated: boolean;
    }
  | { kind: 'retry_exact_metadata'; retryCount: number }
  | { kind: 'connect_and_retry'; retryCount: number }
  | { kind: 'review_run'; reason: string };

export interface WorkflowCapabilityInboxGate {
  notificationId: string;
  workflow: string;
  runId: string;
  stepId: string;
  tool: string;
  toolkit: string;
  reason: string;
  retryAt: string | null;
  provenNoDispatch: true;
  resolution: WorkflowCapabilityInboxResolution;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, max);
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Fail-closed public projection for the one actionable capability gate carried
 * by a workflow notification. Arbitrary notification metadata never crosses
 * into either Inbox UI. If the exact action receipt is missing or malformed,
 * the user gets a truthful run-review CTA instead of a button that can only
 * fail (or, worse, target a reconstructed account).
 */
export function projectWorkflowCapabilityInboxGate(
  row: Pick<NotificationRecord, 'id' | 'kind' | 'metadata'>,
): WorkflowCapabilityInboxGate | null {
  if (row.kind !== 'workflow') return null;
  const metadata = row.metadata;
  if (!metadata || metadata.status !== 'blocked_capability' || metadata.provenNoDispatch !== true) return null;
  const workflow = text(metadata.workflow, 200);
  const runId = text(metadata.runId, 200);
  const stepId = text(metadata.stepId, 160);
  const tool = text(metadata.tool, 200);
  const toolkit = text(metadata.toolkit, 160);
  const reason = text(metadata.reason, 160);
  const retryAt = text(metadata.retryAt, 80);
  const retryCount = positiveInt(metadata.retryCount);
  if (!workflow || !runId || !stepId || !tool || !toolkit || !reason) return null;

  const raw = metadata.resolution && typeof metadata.resolution === 'object' && !Array.isArray(metadata.resolution)
    ? metadata.resolution as Record<string, unknown>
    : null;
  let resolution: WorkflowCapabilityInboxResolution = {
    kind: 'review_run',
    reason: 'The exact recovery action is unavailable. Review this preserved run before taking action.',
  };
  if (raw?.kind === 'choose_account' && retryCount !== null) {
    const digest = text(raw.choiceSetDigest, 64);
    const total = positiveInt(raw.choiceTotal);
    const candidates = Array.isArray(raw.accountCandidates)
      ? raw.accountCandidates.slice(0, 16).flatMap((value): WorkflowCapabilityAccountChoice[] => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const candidate = value as Record<string, unknown>;
          const capabilityId = text(candidate.capabilityId, 500);
          const accountId = text(candidate.accountId, 500);
          if (!capabilityId || !accountId) return [];
          return [{ label: accountId, capabilityId, accountId }];
        })
      : [];
    if (/^[a-f0-9]{64}$/.test(digest ?? '') && total !== null && total >= candidates.length && candidates.length > 0) {
      resolution = {
        kind: 'choose_account',
        retryCount,
        choiceSetDigest: digest as string,
        candidates,
        choiceTotal: total,
        choicesTruncated: raw.choicesTruncated === true || total > candidates.length,
      };
    }
  } else if (raw?.kind === 'retry_exact_metadata' && retryCount !== null) {
    resolution = { kind: 'retry_exact_metadata', retryCount };
  } else if (raw?.kind === 'connect_and_retry' && retryCount !== null) {
    resolution = { kind: 'connect_and_retry', retryCount };
  }

  return {
    notificationId: row.id,
    workflow,
    runId,
    stepId,
    tool,
    toolkit,
    reason,
    retryAt,
    provenNoDispatch: true,
    resolution,
  };
}
