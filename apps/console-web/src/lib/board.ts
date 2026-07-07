/**
 * Tasks board — the unified background-work Kanban. Reads GET
 * /api/console/board (background tasks · runs · executions · in-flight
 * workflow runs) and routes drag actions to the right POST per source.
 *
 * A drop is a REQUEST: the frontend checks the dragged card's `actions`
 * allowlist before firing, the server re-validates, and the board re-polls
 * so the card lands wherever its real status puts it (snap-back on reject).
 */
import { apiGet, apiPost } from './api';
import type { Tone } from '@/components/ui/StatusPill';

export type BoardColumnId = 'queued' | 'running' | 'needs_you' | 'done';
export type BoardSourceKind = 'background' | 'run' | 'execution' | 'workflow' | 'approval';
export type BoardPrimaryAction = 'approve' | 'continue' | 'retry_failed_items' | 'open_result' | 'none';
export type BoardContinueMode = 'approval' | 'background' | 'workflow_failed_items' | 'workflow_resume' | 'open_result' | 'none';

export interface BoardArtifactSummary {
  files: string[];
  urls: string[];
  counts: string[];
}

export interface BoardFailureSummary {
  failedItems: number;
  retryable: boolean;
  reason: string;
}

/** The draft body + image of a CONTENT approval (a post/email), so it's reviewed
 *  in place in the Approvals card instead of a one-line summary. */
export interface ApprovalContentPreview {
  body?: string;
  imageUrl?: string;
}

export interface BoardCard {
  id: string;
  sourceKind: BoardSourceKind;
  title: string;
  column: BoardColumnId;
  status: string;
  progressHint: string;
  sessionId: string | null;
  ageMs: number;
  updatedAt: string;
  /** Allowed actions. Drag uses cancel/resume/promote; buttons may use the rest. */
  actions: string[];
  primaryAction?: BoardPrimaryAction;
  continueMode?: BoardContinueMode;
  approvalId?: string;
  nextSafeAction?: string;
  contentPreview?: ApprovalContentPreview;
  artifactSummary?: BoardArtifactSummary;
  failureSummary?: BoardFailureSummary;
  /** A finished/parked background task idle past the stale threshold (>7d). */
  stale?: boolean;
  staleKind?: 'finished' | 'parked';
  /** Soft-deleted (only present when the board was fetched with ?includeArchived=1). */
  archived?: boolean;
  raw: {
    workflowName?: string;
    runId?: string;
    error?: string;
    blocker?: string;
    pausedBy?: string;
    source?: string;
    objective?: string;
    resultPreview?: string;
    pendingApprovalId?: string;
    approvalKind?: string;
    workflowSlug?: string;
    needsAttention?: boolean;
  };
}

export type BackgroundReportBackTargetType = 'slack_user' | 'slack_channel' | 'discord_user' | 'discord_channel';

export interface BackgroundReportBackTarget {
  type: BackgroundReportBackTargetType;
  userId?: string;
  channelId?: string;
  threadTs?: string;
}

export interface BackgroundTaskNotification {
  id: string;
  title: string;
  createdAt: string;
  deliveredAt?: string;
  deliveryAttempts?: number;
  deliveryError?: string;
  deliveredDestinations?: string[];
  read?: boolean;
}

export interface BackgroundToolEvent {
  at: string;
  toolName: string;
  phase?: string;
  outcome?: string;
  durationMs?: number;
  argsSummary?: string;
  errorMessage?: string;
}

export interface BackgroundTaskDetail {
  task: {
    id: string;
    title: string;
    prompt: string;
    status: string;
    source?: string;
    originSessionId?: string;
    runSessionId: string;
    userId?: string;
    channel?: string;
    reportBackTarget?: BackgroundReportBackTarget;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
    pendingQuestion?: string;
    pendingQuestionId?: string;
    pendingApprovalId?: string;
    lastCheckInAt?: string;
    lastCheckInMessage?: string;
    result?: string;
    resultFull?: string;
    error?: string;
    requestedModel?: string;
    effectiveModel?: string;
    modelProvider?: string;
  };
  detail: {
    latestActivityAt?: string;
    latestActivitySummary?: string;
    pendingApprovals: Array<{ approvalId: string; subject?: string; tool?: string }>;
    toolEvents: BackgroundToolEvent[];
    notifications: BackgroundTaskNotification[];
  };
  /** Server-computed cockpit vitals — best-effort, any field may be absent. */
  vitals?: {
    /** Wall-clock since the task started (frozen at completion). */
    elapsedMs?: number;
    /** Distinct tool invocations so far. */
    toolCallCount: number;
    /** Model tokens attributed to the run session today (undefined when unknown). */
    tokensUsed?: number;
    /** Whether the task is still running (drives the live-ticking timer). */
    running: boolean;
  };
}

export const COLUMNS: { id: BoardColumnId; label: string }[] = [
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'done', label: 'Done' },
];

export const listBoard = () => apiGet<{ cards: BoardCard[]; generatedAt: string }>('/api/console/board');

export const getBackgroundTaskDetail = (id: string) =>
  apiGet<BackgroundTaskDetail>(`/api/console/background-tasks/${encodeURIComponent(id)}`);

export const setBackgroundTaskReportBackTarget = (id: string, target: BackgroundReportBackTarget) =>
  apiPost<{ ok: boolean; task?: BackgroundTaskDetail['task']; reason?: string }>(
    `/api/console/background-tasks/${encodeURIComponent(id)}/report-back-target`,
    target,
  );

export const repostBackgroundTaskResult = (id: string, target: BackgroundReportBackTarget) =>
  apiPost<{ ok: boolean; notificationId?: string; reason?: string }>(
    `/api/console/background-tasks/${encodeURIComponent(id)}/repost-result`,
    target,
  );

// Queue visibility: the sub-task queue of one workflow run (each step/forEach
// unit with status + what runs next), reconstructed server-side from the durable
// event log so it survives restarts. Lets a campaign card expand into its queue.
export type RunQueueStepStatus = 'done' | 'running' | 'failed' | 'queued' | 'blocked';
export interface RunQueueStep {
  stepId: string;
  title: string;
  kind: 'step' | 'forEach';
  status: RunQueueStepStatus;
  isNext: boolean;
  itemsDone?: number;
  itemsTotal?: number;
  itemsFailed?: number;
}
export interface RunQueue {
  runId: string;
  steps: RunQueueStep[];
  doneCount: number;
  totalCount: number;
  nextStepId: string | null;
}

export const getRunQueue = (slug: string, runId: string) =>
  apiGet<RunQueue>(`/api/console/board/run/${encodeURIComponent(slug)}/${encodeURIComponent(runId)}/queue`);

/** A specialized agent this run spawned (Claude / Codex / GLM-BYO fan-out). */
export interface RunAgent {
  id: string;
  parentKind: 'workflow' | 'session';
  workflowName?: string;
  stepId?: string;
  role?: string;
  provider: 'claude' | 'codex' | 'glm' | 'unknown';
  model?: string;
  task: string;
  status: 'ok' | 'error' | 'capped';
  outputPreview: string;
  outputRef?: string;
  startedAt: string;
  finishedAt: string;
}

export const listRunAgents = (slug: string, runId: string) =>
  apiGet<{ runId: string; agents: RunAgent[]; byProvider: Record<string, number> }>(
    `/api/console/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/agents`);

export const getRunAgentOutput = (slug: string, runId: string, agentId: string) =>
  apiGet<{ agentId: string; output: string }>(
    `/api/console/workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/output`);

/** The workflow slug + runId a card's queue lives under, or null if the card
 *  isn't a workflow run (background/execution/approval have no step queue). */
export function runQueueRef(card: BoardCard): { slug: string; runId: string } | null {
  if (card.sourceKind !== 'run' && card.sourceKind !== 'workflow') return null;
  const slug = card.raw.workflowSlug ?? card.raw.workflowName;
  const runId = card.raw.runId ?? card.id;
  if (!slug || !runId) return null;
  return { slug, runId };
}

/**
 * The action a drop onto `target` would trigger, or null if the move isn't
 * legal for this card. Each action verb maps to exactly one target column:
 * cancel → done, resume/promote → running. The card's server-computed
 * `actions` allowlist is the source of truth.
 */
export function intentForDrop(card: BoardCard, target: BoardColumnId): 'cancel' | 'resume' | 'promote' | null {
  if (target === card.column) return null; // no-op (in-column reorder is Phase 2)
  if (target === 'done' && card.actions.includes('cancel')) return 'cancel';
  if (target === 'running' && card.actions.includes('promote')) return 'promote';
  if (target === 'running' && card.actions.includes('resume')) return 'resume';
  return null;
}

/** Why a drop was rejected, for the snap-back toast. */
export function rejectReason(card: BoardCard, target: BoardColumnId): string {
  if (target === card.column) return '';
  if (target === 'done') return 'This card can’t be cancelled.';
  if (card.status === 'awaiting_approval') return 'Approve from the card to continue — a drag can’t grant approval.';
  if (card.status === 'awaiting_continue') return 'Move it to Running to continue the background task.';
  if (target === 'running') return 'Nothing to start or resume here.';
  return 'That move isn’t available.';
}

export type BoardActionIntent = 'cancel' | 'resume' | 'promote' | 'archive' | 'restore';
export type BoardButtonIntent = BoardActionIntent | 'approve' | 'reject' | 'retry_failed_items' | 'resume_safe';

export async function runBoardAction(card: BoardCard, intent: BoardButtonIntent): Promise<{ ok: boolean; reason?: string }> {
  try {
    if ((intent === 'approve' || intent === 'reject') && (card.approvalId || card.raw.pendingApprovalId)) {
      const id = card.approvalId || card.raw.pendingApprovalId!;
      return await apiPost<{ ok: boolean; reason?: string }>(
        `/api/console/board/approval/${encodeURIComponent(id)}/${intent}`,
      );
    }
    if (card.sourceKind === 'workflow' && intent === 'retry_failed_items' && card.raw.runId) {
      const workflowName = card.raw.workflowSlug || card.raw.workflowName || card.title;
      return await apiPost<{ ok: boolean; reason?: string }>(
        `/api/console/board/workflow/${encodeURIComponent(workflowName)}/runs/${encodeURIComponent(card.raw.runId)}/retry-failed-items`,
      );
    }
    if ((card.sourceKind === 'workflow' || card.sourceKind === 'run') && intent === 'resume_safe' && card.raw.runId) {
      const workflowName = card.raw.workflowSlug || card.raw.workflowName || card.title;
      return await apiPost<{ ok: boolean; reason?: string }>(
        `/api/console/board/workflow/${encodeURIComponent(workflowName)}/runs/${encodeURIComponent(card.raw.runId)}/resume-safe`,
      );
    }
    if (card.sourceKind === 'background') {
      // archive/restore + cancel/resume/promote all route to the same per-id action endpoint.
      return await apiPost<{ ok: boolean; reason?: string }>(`/api/console/board/background/${encodeURIComponent(card.id)}/${intent}`);
    }
    if (card.sourceKind === 'execution') {
      const to = intent === 'cancel' ? 'cancelled' : 'active';
      return await apiPost<{ ok: boolean; reason?: string }>(`/api/console/board/execution/${encodeURIComponent(card.id)}/transition`, { to });
    }
    if (card.sourceKind === 'run' && intent === 'cancel') {
      return await apiPost<{ ok: boolean; reason?: string }>(`/api/console/board/run/${encodeURIComponent(card.id)}/cancel`);
    }
    if (card.sourceKind === 'workflow' && intent === 'cancel' && card.raw.runId) {
      const workflowName = card.raw.workflowSlug || card.raw.workflowName || card.title;
      return await apiPost<{ ok: boolean; reason?: string }>(
        `/api/console/workflows/${encodeURIComponent(workflowName)}/runs/${encodeURIComponent(card.raw.runId)}/cancel`,
        { reason: 'Cancelled from the Tasks board.' },
      );
    }
    return { ok: false, reason: 'That action isn’t available for this card.' };
  } catch (err) {
    const reason = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Action failed.';
    return { ok: false, reason };
  }
}

/** A short, human label for the card's source kind (shown as a chip). */
export function sourceLabel(kind: BoardSourceKind): string {
  switch (kind) {
    case 'background': return 'Task';
    case 'workflow': return 'Workflow';
    case 'execution': return 'Goal';
    case 'run': return 'Run';
    case 'approval': return 'Approval';
  }
}

/** Map a board status/column to a semantic pill tone + label. */
export function cardTone(card: BoardCard): { tone: Tone; label: string } {
  const s = card.status.toLowerCase();
  if (card.column === 'done') {
    if (s.includes('fail') || s.includes('abort') || s.includes('interrupt') || s.includes('block')) return { tone: 'danger', label: card.status };
    if (s.includes('cancel')) return { tone: 'neutral', label: 'Cancelled' };
    return { tone: 'success', label: 'Done' };
  }
  if (card.column === 'needs_you') {
    return {
      tone: 'warning',
      label: card.status === 'awaiting_approval'
        ? 'Approval'
        : card.status === 'awaiting_continue'
          ? 'Continue'
          : card.status,
    };
  }
  if (card.column === 'running') return { tone: 'live', label: s === 'cancelling' ? 'Cancelling' : 'Working' };
  return { tone: 'neutral', label: 'Queued' };
}
