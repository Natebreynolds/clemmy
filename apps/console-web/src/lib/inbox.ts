import { apiGet, apiPost } from './api';
import type { PendingActionApprovalView } from './types';

export interface ApprovalRow {
  approvalId: string;
  sessionId?: string | null;
  subject: string;
  summary?: string;
  reason?: string;
  tool?: string | null;
  args?: unknown;
  status: string;
  resolution?: 'approved' | 'rejected' | 'expired' | 'cancelled_by_user' | 'cancelled_by_system' | null;
  requestedAt?: string;
  expiresAt?: string;
  kind?: string;
  pendingAction?: PendingActionApprovalView;
  /** Unanswered 48h+ with nothing parked on it — sinks out of the urgent
   * header but stays fully approvable. */
  stale?: boolean;
}

export interface ApprovalDecisionResponse {
  ok: boolean;
  status?: string;
  message?: string;
  reason?: string;
}

export interface RunRow {
  id: string;
  sessionId?: string;
  kind?: string;
  channel?: string;
  source?: string;
  title: string;
  input?: string;
  status: string;
  statusLabel?: string;
  runState?: string;
  runStateLabel?: string;
  needsAttention?: boolean;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  outputPreview?: string;
  error?: string;
  canBackground?: boolean;
  backgroundEndpoint?: string;
}

export interface NotificationRow {
  id: string;
  title?: string;
  body?: string;
  createdAt?: string;
  read?: boolean;
  kind?: string;
  deliveredAt?: string;
  deliveryAttempts?: number;
  deliveryError?: string;
  needsAttention?: boolean;
  workflowCapability?: WorkflowCapabilityInboxGate | null;
  /** A workflow the system switched off that only a person can switch back on. */
  workflowEnableGate?: WorkflowEnableInboxGate | null;
}

export interface WorkflowEnableInboxGate {
  workflowName: string;
  displayName: string;
  reason: string;
}

export interface WorkflowCapabilityAccountChoice {
  label: string;
  capabilityId: string;
  accountId: string;
}

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
  resolution:
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
}

/** One visible needs-attention row per underlying subject. A flaky morning
 *  produced ten "Workflow needs attention: morning-…" rows — one per blocked
 *  run — burying the two decisions that actually differed. Group by the
 *  workflow (or exact title), keep the NEWEST row, and surface how many
 *  earlier duplicates it stands for. */
export interface CollapsedAttentionRow {
  row: NotificationRow;
  /** Older rows this one stands for (0 = unique). */
  collapsedCount: number;
  /** Ids of every row in the group (newest first) — dismissing dismisses all. */
  groupIds: string[];
}

export function collapseAttentionRows(rows: NotificationRow[]): CollapsedAttentionRow[] {
  const keyFor = (row: NotificationRow): string => {
    if (row.workflowCapability) return `capability:${row.workflowCapability.notificationId}`;
    const title = (row.title || row.body || '').trim();
    const workflow = /workflow needs attention:\s*(.+)$/i.exec(title)?.[1]?.trim();
    return workflow ? `wf:${workflow.toLowerCase()}` : `title:${title.toLowerCase()}`;
  };
  const groups = new Map<string, NotificationRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  const newestFirst = (a: NotificationRow, b: NotificationRow) =>
    Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || a.id.localeCompare(b.id);
  return [...groups.values()]
    .map((bucket) => {
      const sorted = [...bucket].sort(newestFirst);
      return { row: sorted[0], collapsedCount: sorted.length - 1, groupIds: sorted.map((r) => r.id) };
    })
    .sort((a, b) => newestFirst(a.row, b.row));
}

export const listApprovals = () =>
  apiGet<{ approvals: ApprovalRow[]; count: number; urgentCount?: number }>('/api/console/approvals/list');

export interface WorkspaceDestinationChoice {
  choiceId: string;
  kind: 'existing' | 'create_new';
  label: string;
  workspaceId: string;
}

export interface WorkspaceDestinationChooser {
  version: 1;
  chooserId: string;
  advancementId: string;
  chooserRevision: number;
  chooserDigest: string;
  createdAt: string;
  choices: WorkspaceDestinationChoice[];
}

export const listWorkspaceDestinationChoosers = () =>
  apiGet<{ choosers: WorkspaceDestinationChooser[]; count: number }>(
    '/api/console/automation-pilot/workspace-choosers',
  );

export const resolveWorkspaceDestinationChooser = (
  chooser: WorkspaceDestinationChooser,
  choiceId: string,
) => apiPost(
  `/api/console/automation-pilot/workspace-choosers/${encodeURIComponent(chooser.chooserId)}/resolve`,
  {
    chooserRevision: chooser.chooserRevision,
    chooserDigest: chooser.chooserDigest,
    choiceId,
  },
);

// Runtime approvals (chat/Discord/CLI loop) resolve via /api/approvals/:id/:decision;
// harness approvals via /api/console/harness-approvals/:id/:decision. The list
// returns both kinds, so route by the row's `kind`.
export const decideApproval = (
  id: string,
  decision: 'approve' | 'reject',
  opts?: { kind?: string; modifiedArgs?: string },
) => {
  const path = opts?.kind === 'runtime'
    ? `/api/approvals/${encodeURIComponent(id)}/${decision}`
    : `/api/console/harness-approvals/${encodeURIComponent(id)}/${decision}`;
  return apiPost<ApprovalDecisionResponse>(
    path,
    opts?.modifiedArgs ? { modifiedArgs: opts.modifiedArgs } : undefined,
  );
};

export function approvalDecisionSuccessText(
  row: ApprovalRow,
  decision: 'approve' | 'reject',
  response?: ApprovalDecisionResponse,
): string {
  if (decision === 'reject') return 'Rejected — this action will not be dispatched.';
  if (row.pendingAction) {
    const status = response?.status ?? '';
    if (/workflow.*resume/i.test(status)) {
      return 'Approved — the workflow runner will resume the exact queued action. Execution is not confirmed yet.';
    }
    if (/resum/i.test(status)) {
      return 'Approved — Clementine is resuming the exact queued action. Execution is not confirmed yet.';
    }
    return 'Approved — the exact queued action is authorized, but execution is not confirmed yet.';
  }
  const status = response?.status ?? '';
  if (/workflow.*resume/i.test(status)) return 'Approved — the workflow runner will resume.';
  if (/resum/i.test(status)) return 'Approved — Clementine is resuming the paused work.';
  if (/stale/i.test(status)) return 'Approved — the decision was recorded; no resumed execution is confirmed.';
  return 'Approved.';
}

export function summarizeApprovalDecisionBatch(input: {
  decision: 'approve' | 'reject';
  total: number;
  succeeded: number;
  errors: string[];
}): string {
  const verb = input.decision === 'approve' ? 'Approved' : 'Rejected';
  const failed = Math.max(0, input.total - input.succeeded);
  if (failed === 0) return `${verb} ${input.succeeded} of ${input.total}.`;
  const firstError = input.errors.find((error) => error.trim())?.trim();
  const errorClause = firstError
    ? `: ${firstError.replace(/[.\s]+$/, '')}.`
    : '.';
  return `${verb} ${input.succeeded} of ${input.total}; ${failed} failed${errorClause} Failed items remain selected.`;
}

export const cancelStaleApprovals = () => apiPost('/api/console/approvals/cancel-stale');

export interface TrustProposalRow {
  id: string;
  scopeRevision: 1;
  scopeDigest: string;
  toolkits: string[];
  recipients: string[];
  domains?: string[];
  maxRecipients: number;
  rationale: string;
  status: string;
  createdAt: string;
  evidence: { cleanSendCount: number; distinctDays: number; firstAt: string; lastAt: string };
}

/** Send-trust suggestions Clem proposes after a stable run of clean approved
 *  sends — the desktop half of the desktop↔Discord parity. */
export const listTrustProposals = () =>
  apiGet<{ proposals: TrustProposalRow[] }>('/api/console/trust-proposals?status=pending');

export interface TrustProposalDecisionResponse {
  ok: boolean;
  reason: string;
  scopeReceipt?: {
    scopeRevision: 1;
    scopeDigest: string;
    toolkits: string[];
    recipients: string[];
    domains: string[];
    maxRecipients: number;
  };
}

export function trustProposalScopeExpectation(
  proposal: Pick<TrustProposalRow, 'scopeRevision' | 'scopeDigest'>,
): { scopeRevision: 1; scopeDigest: string } {
  return {
    scopeRevision: proposal.scopeRevision,
    scopeDigest: proposal.scopeDigest,
  };
}

export const decideTrustProposal = (proposal: TrustProposalRow, decision: 'approve' | 'decline') =>
  apiPost<TrustProposalDecisionResponse>(
    `/api/console/trust-proposals/${encodeURIComponent(proposal.id)}/${decision}`,
    trustProposalScopeExpectation(proposal),
  );

export interface PlanProposalRow {
  id: string;
  proposedAt: string;
  status: string;
  originatingRequest: string;
  sessionId?: string;
  context?: string;
  plan: {
    objective: string;
    steps?: Array<{ id?: string; description?: string; action?: string }>;
    needsUserInput?: string[];
  };
}

export const listPlanProposals = () =>
  apiGet<{ proposals: PlanProposalRow[] }>('/api/console/plan-proposals?status=pending');

export const decidePlanProposal = (id: string, decision: 'approve' | 'reject') =>
  apiPost(
    `/api/console/plan-proposals/${encodeURIComponent(id)}/${decision}`,
    decision === 'reject' ? { reason: 'Rejected from the exact desktop plan card.' } : undefined,
  );

export interface InboxQuestionRow {
  id: string;
  source: 'check_in' | 'background_task' | 'workflow';
  question: string;
  options: string[];
  context: string | null;
  askedAt: string;
  urgency: 'low' | 'normal' | 'high';
  agentLabel: string;
  sessionId: string | null;
  taskId: string | null;
  workflowName: string | null;
  runId: string | null;
  stepId: string | null;
  answerable: boolean;
  unavailableReason: string | null;
}

export const listInboxQuestions = () =>
  apiGet<{ questions: InboxQuestionRow[]; count: number }>('/api/console/inbox/questions');

export const answerInboxQuestion = (id: string, answer: string) =>
  apiPost<{ status: 'answered' | 'resuming'; questionId: string; taskId?: string; runId?: string }>(
    `/api/console/inbox/questions/${encodeURIComponent(id)}/answer`,
    { answer },
  );

export const listRuns = (limit = 40) => apiGet<{ runs: RunRow[] }>(`/api/runs?limit=${limit}`);

// 300 matches the command-center feed window — Home "Needs you" cards can
// deep-link to any notification the feed surfaced, so the Inbox must be able
// to find it (50 left older anchors unselectable).
export const listNotifications = () =>
  apiGet<{ notifications: NotificationRow[] }>('/api/notifications?limit=300');

/** Dismiss a "Needs you" card (check-in / plan / proposal). */
export const dismissInboxItem = (kind: string, id: string) =>
  apiPost(`/api/console/inbox/dismiss`, { kind, id });

export const markNotificationRead = (id: string) =>
  apiPost(`/api/notifications/${encodeURIComponent(id)}/read`);

export const retryNotification = (id: string) =>
  apiPost(`/api/notifications/${encodeURIComponent(id)}/retry`);

export const resolveWorkflowCapability = (
  gate: WorkflowCapabilityInboxGate,
  choice?: WorkflowCapabilityAccountChoice,
) => apiPost<{
  ok: true;
  status: 'selected' | 'already_selected' | 'resumed' | 'already_resumed';
  runId: string;
  stepId: string;
}>(
  `/api/console/inbox/workflow-capabilities/${encodeURIComponent(gate.runId)}/resolve`,
  gate.resolution.kind === 'choose_account'
    ? {
        action: 'choose_account',
        stepId: gate.stepId,
        tool: gate.tool,
        retryCount: gate.resolution.retryCount,
        choiceSetDigest: gate.resolution.choiceSetDigest,
        capabilityId: choice?.capabilityId ?? '',
        accountId: choice?.accountId ?? '',
      }
    : {
        action: 'retry',
        stepId: gate.stepId,
        tool: gate.tool,
        retryCount: gate.resolution.kind === 'review_run' ? 0 : gate.resolution.retryCount,
      },
);

/** Friendly relative time ("4m", "2h", "3d", "now"). */
export function relativeTime(value?: string | number | null): string {
  if (!value) return '';
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

import type { Tone } from '@/components/ui/StatusPill';

/** Map a run/notification status to a semantic tone + label. */
export function statusTone(status?: string): { tone: Tone; label: string } {
  const s = (status ?? '').toLowerCase();
  if (['completed', 'complete', 'done', 'delivered', 'sent', 'ok'].includes(s)) return { tone: 'success', label: 'Done' };
  if (['failed', 'error', 'not_delivered'].includes(s)) return { tone: 'danger', label: 'Failed' };
  if (['running', 'active', 'received', 'in_progress'].includes(s)) return { tone: 'live', label: 'Working' };
  if (s === 'blocked_capability') return { tone: 'warning', label: 'Connection needed' };
  if (['awaiting_approval', 'awaiting_input', 'needs_attention', 'paused', 'queued', 'pending'].includes(s)) {
    return { tone: 'warning', label: s === 'needs_attention' ? 'Needs attention' : 'Waiting' };
  }
  if (['cancelled', 'canceled'].includes(s)) return { tone: 'neutral', label: 'Cancelled' };
  return { tone: 'neutral', label: status || 'Unknown' };
}

/** Notification pill derived from real delivery fields (no `status` exists). */
export function notifTone(n: NotificationRow): { tone: Tone; label: string } {
  if (notifFailed(n)) return { tone: 'danger', label: 'Failed' };
  if (n.deliveredAt) return { tone: 'success', label: 'Sent' };
  const kind = (n.kind ?? '').toLowerCase();
  if (kind === 'approval') return { tone: 'warning', label: 'Approval' };
  if (kind) return { tone: 'neutral', label: kind.charAt(0).toUpperCase() + kind.slice(1) };
  return { tone: 'neutral', label: 'Update' };
}

/** A notification whose delivery to an external destination failed. */
export function notifFailed(n: NotificationRow): boolean {
  return Boolean(n.deliveryError) || ((n.deliveryAttempts ?? 0) > 0 && !n.deliveredAt);
}
