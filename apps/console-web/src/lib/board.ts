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
import { humanStatusLabel } from './work-status';
import {
  presentWorkingNow,
  type WorkingNowEntryLike,
  type WorkingNowView,
} from './activity-presentation';
import type { Tone } from '@/components/ui/StatusPill';
import type { RunEnvironmentDetail } from './run-environment';
import type { PendingActionApprovalView } from './types';

/** The column the SERVER assigns a card. Four values, and only four. */
export type BoardServerColumnId = 'queued' | 'running' | 'needs_you' | 'done';

/**
 * The lane the board RENDERS a card in. "Needs you" splits into the two
 * different human actions it always mixed — see boardNeedsYouGroup — so a lane
 * is not always a server column. Nothing drops INTO a needs-you lane (no
 * intent targets it), so the split costs the drag gesture nothing.
 */
export type BoardColumnId = BoardServerColumnId | 'needs_you_blocked' | 'needs_you_review';
export type BoardSourceKind = 'background' | 'run' | 'execution' | 'workflow' | 'approval' | 'schedule' | 'guest';
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

export interface WorkflowCatchupReadinessItem {
  kind?: string;
  name?: string;
  status?: string;
  reason?: string;
  stepIds?: string[];
}

export interface WorkflowCatchupReadinessSnapshot {
  ok?: boolean;
  checkedAt?: string;
  blockers?: WorkflowCatchupReadinessItem[];
  warnings?: WorkflowCatchupReadinessItem[];
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
  column: BoardServerColumnId;
  status: string;
  progressHint: string;
  sessionId: string | null;
  ageMs: number;
  updatedAt: string;
  /** Allowed actions. Drag uses cancel/resume/promote; buttons may use the rest. */
  actions: string[];
  /** Canonical harness identity. A session can serve many attempts, so Tasks
   * uses these fields for exact Environment handoff and exact cancellation. */
  attemptId?: string;
  runScopeId?: string;
  sourceUserSeq?: number;
  cancelEndpoint?: string;
  primaryAction?: BoardPrimaryAction;
  continueMode?: BoardContinueMode;
  approvalId?: string;
  nextSafeAction?: string;
  /** Typed next edge for a stopped run: label + in-app href. */
  nextEdge?: { label: string; href: string };
  contentPreview?: ApprovalContentPreview;
  /** Exact durable action behind an approval card. This is display-only;
   * the action route still validates the card/action/session backlink. */
  pendingAction?: PendingActionApprovalView;
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
    /** A missed scheduled occurrence held before workflow execution begins. */
    occurrenceAtMs?: number;
    scheduledFor?: string;
    schedule?: string;
    timezone?: string;
    missedCount?: number;
    /** Readiness captured when this missed occurrence was admitted. Resume
     * rechecks it; Skip remains available even while blockers are unresolved. */
    readiness?: WorkflowCatchupReadinessSnapshot;
    needsAttention?: boolean;
    outcomeSnapshot?: TaskOutcomeSnapshot;
    /** Guest CLI run (project_run) — the user's own Claude Code / Codex
     *  working inside one of their projects. */
    guestRunId?: string;
    harness?: string;
    projectName?: string;
    projectPath?: string;
    prompt?: string;
    changedFiles?: string[];
    finalMessage?: string;
  };
}

/** One normalized review model shared by the compact Tasks card and its full
 * drawer. Keeping this projection pure makes it regression-testable: neither
 * surface may accidentally drop the target/risk/preview/hash that the server
 * supplied for the exact queued payload. */
export function pendingActionReviewFacts(action: PendingActionApprovalView): {
  title: string;
  summary: string;
  status: string;
  toolName: string;
  target: string;
  risk: string;
  preview: string;
  rollback: string;
  payloadHash: string;
  payloadText: string;
} {
  let payloadText = '—';
  if (typeof action.payload === 'string') {
    payloadText = action.payload || '—';
  } else {
    try {
      payloadText = JSON.stringify(action.payload, null, 2) || '—';
    } catch {
      payloadText = '[Payload could not be rendered]';
    }
  }
  return {
    title: action.title,
    summary: action.summary,
    status: action.status,
    toolName: action.toolName,
    target: action.targetSummary,
    risk: action.risk,
    preview: action.preview,
    rollback: action.rollback,
    payloadHash: action.payloadHash,
    payloadText,
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
  /** Terminal/interim delivery state the backend persists ('sent' | 'failed' |
   *  'pending' | 'queued' | …). Optional — the drawer derives a state from the
   *  timestamp/error fields when it's absent, so older rows still render truthfully. */
  state?: string;
  /** Human channel label the delivery landed on, e.g. "Discord DM" (optional). */
  channelLabel?: string;
}

/** A place a background task can report its result back to. Fed to the drawer's
 *  report-back dropdown by GET /api/console/report-back/channels. `connected`
 *  channels are selectable; exactly one is `isDefault` (the resolved target when
 *  no explicit one is set — usually the originating chat). */
export interface ReportBackChannel {
  key: string;
  label: string;
  connected: boolean;
  isDefault: boolean;
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

export interface WorkManifestPhaseProgress {
  id: string;
  label: string;
  dependsOn: string[];
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  needsValidation: number;
  invalidated: number;
}

export interface WorkManifestProgress {
  manifestId: string;
  objective?: string;
  contractVersion: string;
  phases: WorkManifestPhaseProgress[];
  total: number;
  completed: number;
  remaining: number;
  currentPhase?: string;
  evidenceCount: number;
  artifactCount: number;
  staleCheckpoints: number;
  untrackedCheckpoints: number;
  anomalies: string[];
  updatedAt?: string;
}

export interface TaskOutcomeSnapshot {
  version: 1;
  capturedAt: string;
  evidence?: {
    work?: Array<{
      label: string;
      completed: number;
      total: number;
      evidenceCount?: number;
    }>;
    artifacts?: Array<{
      kind: string;
      ref: string;
      verified?: boolean;
    }>;
    committedExternalActions?: number;
    lastToolFailure?: {
      tool?: string;
      summary: string;
    };
  };
  blocker?: string;
  nextAction?: string;
  resumable?: boolean;
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
    outcomeSnapshot?: TaskOutcomeSnapshot;
    requestedModel?: string;
    effectiveModel?: string;
    modelProvider?: string;
    contractVersion?: number;
    contractRevisions?: Array<{
      version: number;
      instruction: string;
      evidencePolicy: 'preserve' | 'revalidate' | 'invalidate';
      queuedAt: string;
      appliedAt?: string;
    }>;
    pendingContractRevision?: {
      version: number;
      instruction: string;
      evidencePolicy: 'preserve' | 'revalidate' | 'invalidate';
      queuedAt: string;
      appliedAt?: string;
    };
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
    /** Honest spend: uncached input + output. tokensUsed is dominated by cached
     *  prompt re-reads on long runs and reads as ~10-100× the real volume. */
    tokensReal?: number;
    tokensCached?: number;
    /** Whether the task is still running (drives the live-ticking timer). */
    running: boolean;
  };
  workManifests?: WorkManifestProgress[];
}

export const COLUMNS: { id: BoardColumnId; label: string }[] = [
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'done', label: 'Done' },
];

/** The two lanes "Needs you" splits into, rendered in the same grid cell the
 *  single Needs-you column used to own. Blocked leads: it is the one a person
 *  cannot clear with a click, so it is the one that decays. */
export const NEEDS_YOU_LANES: { id: BoardColumnId; label: string }[] = [
  { id: 'needs_you_blocked', label: 'Blocked' },
  { id: 'needs_you_review', label: 'Ready for review' },
];

export const listBoard = () => apiGet<{ cards: BoardCard[]; generatedAt: string }>('/api/console/board');

// ─── Which human action a waiting card needs ─────────────────────────────────
//
// "Needs you" mixed two different asks, and the difference is the whole point:
// a card that is BLOCKED cannot proceed until something is supplied (an answer,
// an auth, a reconciliation, a binding) — reading it and deciding does not
// unblock it. A card that is READY FOR REVIEW has finished its work and is one
// approve/continue away from carrying on. Nine unread approvals and one run
// stuck on missing auth are not the same backlog.

export type BoardNeedsYouGroup = 'blocked' | 'review';

/** Server statuses that mean Clementine cannot proceed on her own. Matched on
 *  the board route's own status words, so a renamed status surfaces as the
 *  unknown case (blocked) rather than silently claiming work is ready. */
const BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  'awaiting_input',      // a question was asked — this needs an answer, not a click
  'blocked',             // the background task stopped on its own blocker
  'blocked_mutation',    // the provider outcome must be reconciled before anything resends
  'blocked_capability',  // a proven-capability gate stopped the step before it sent
  'needs_binding',       // the workflow cannot run until a resource is bound
]);

/** Statuses whose one offered decision resumes the work immediately. */
const REVIEW_STATUSES: ReadonlySet<string> = new Set([
  'awaiting_approval',
  'awaiting_continue',
  'parked',              // a workflow parked on approval consumption
]);

/**
 * Which of the two asks a waiting card is making. Total, so it can also
 * classify a card the server left in Running that the shared presenter says is
 * actually waiting on a person.
 */
export function boardNeedsYouGroup(card: BoardCard): BoardNeedsYouGroup {
  // An offered approve outranks the status word: a run flagged
  // `needs_attention` that still carries its approval is a review, not a wall.
  if (card.actions.includes('approve') || card.primaryAction === 'approve') return 'review';
  if (card.approvalId || card.raw.pendingApprovalId) return 'review';
  if (BLOCKED_STATUSES.has(card.status)) return 'blocked';
  // Resume-or-skip on a held occurrence is a decision, not a wall — nothing has
  // started and either answer settles it.
  if (isWorkflowCatchupCard(card)) return 'review';
  if (REVIEW_STATUSES.has(card.status)) return 'review';
  // Fail closed. An unrecognised wait is at worst under-promised as blocked;
  // calling it "ready for review" when nothing is offered is the lie.
  return 'blocked';
}

// ─── One answer to "what is running" ─────────────────────────────────────────
//
// The badge, the drawer and mobile have rendered Working-Now through the shared
// presenter for a while; /tasks kept deriving its own Running column straight
// from the server column, so the badge that sends you to /tasks and the board
// you land on were two answers to the same question (a parked run counted as
// "needs you" in the badge and sat in Running on the board). The board now asks
// the SAME presenter, and its lane follows that verdict.

/** A board card as the shared Working-Now presenter reads it. */
export interface BoardWorkingNowEntry extends WorkingNowEntryLike {
  card: BoardCard;
}

/**
 * The board feed carries no start time, and will not be made to invent one.
 *
 * `ageMs` is age since the card was last TOUCHED, not since the work began —
 * the route computes it from `pending.lastEventAt` for a workflow, `updatedAt`
 * for an execution, `guestUpdatedAt` for a guest run. Reconstructing a start
 * from it would tell a run three hours in that it started 30 seconds ago, which
 * is worse than saying nothing. The presenter renders '' for an unusable
 * timestamp, and no elapsed at all is the honest answer here.
 */
function boardStartedAt(): string {
  return '';
}

export function boardWorkingNowEntry(card: BoardCard): BoardWorkingNowEntry {
  const waiting = card.status === 'parked'
    || card.status.startsWith('awaiting')
    || card.status.startsWith('waiting')
    || card.status.startsWith('blocked');
  return {
    card,
    runKey: card.id,
    lifecycle: card.status,
    // ALWAYS 'unknown'. The presenter's `liveness` is documented as lease
    // truth, and the board feed carries no lease: its Running column is
    // `pending.inFlightStepId ? 'running' : 'queued'` — a step id, which says a
    // step was started, not that anything is still holding it. Minting 'live'
    // from that would hand out the pulse certificate the presenter exists to
    // keep unforgeable. 'unknown' still lands the card in the Running lane
    // (the presenter's 'waiting'), it just does not claim a heartbeat nobody
    // took. (`card.stale` is deliberately NOT mapped to the presenter's
    // 'stale' either: that means a lost lease, while the board's flag means
    // idle for over a week.)
    liveness: 'unknown',
    needsAttention: card.column === 'needs_you' || card.raw.needsAttention === true || waiting,
    startedAt: boardStartedAt(),
    ...(card.sessionId ? { sessionId: card.sessionId } : {}),
    // A settled card is history, not current work — the presenter drops it, so
    // the Done column keeps its own membership.
    ...(card.column === 'done' ? { terminal: { status: card.status } } : {}),
  };
}

/** The board's live rows, presented by the one Working-Now presenter. Queued
 *  cards are excluded here (nothing has started, so they are not current work)
 *  and Done cards fall out on the presenter's own terminal rule — what is left
 *  is the same population the badge counts. */
export function presentBoardWorkingNow(
  cards: readonly BoardCard[],
  generatedAt: string,
): WorkingNowView<BoardWorkingNowEntry> {
  const current = cards.filter((card) => card.column !== 'queued');
  return presentWorkingNow(current.map((card) => boardWorkingNowEntry(card)), generatedAt);
}

/**
 * Every card's lane, from ONE presenter pass over the whole board.
 *
 * Queued and Done stay exactly where the server put them. Everything else asks
 * the presenter whether it is running or waiting on a person, and a waiting
 * card then picks which of the two needs-you lanes it belongs in.
 */
export function boardLanes(
  cards: readonly BoardCard[],
  generatedAt: string,
): { view: WorkingNowView<BoardWorkingNowEntry>; laneOf: Map<string, BoardColumnId> } {
  const view = presentBoardWorkingNow(cards, generatedAt);
  const laneOf = new Map<string, BoardColumnId>();
  // Settled and not-yet-started cards never reach the presenter's entries.
  for (const card of cards) {
    if (card.column === 'queued' || card.column === 'done') laneOf.set(card.id, card.column);
  }
  for (const presented of view.entries) {
    const { card } = presented.entry;
    laneOf.set(card.id, presented.presentation !== 'needs_you'
      ? 'running'
      : boardNeedsYouGroup(card) === 'blocked' ? 'needs_you_blocked' : 'needs_you_review');
  }
  return { view, laneOf };
}

/** The lane ONE card renders in — for the paths that hold a single card (a drag
 *  in flight) rather than the whole board. It delegates so the two entry points
 *  cannot drift into two answers. */
export function boardLaneId(card: BoardCard): BoardColumnId {
  return boardLanes([card], '').laneOf.get(card.id) ?? card.column;
}

export interface ForegroundTaskControlCard {
  id: string;
  sourceKind: 'background' | 'run' | 'workflow';
  title: string;
  column: BoardServerColumnId;
  status: string;
  progressHint: string;
  sessionId: string | null;
  ageMs: number;
  updatedAt: string;
  actions: string[];
  attemptId?: string;
  runScopeId?: string;
  cancelEndpoint?: string;
  raw: {
    runId?: string;
    workflowName?: string;
    workflowSlug?: string;
  };
}

/** Exact action carriers for the compact foreground chat affordance. The
 * server response is a bounded whitelist, not the full Tasks review model. */
export const listForegroundTaskControls = () => apiGet<{ cards: ForegroundTaskControlCard[]; generatedAt: string }>(
  '/api/console/board?surface=foreground-chat',
);

export interface BoardRunSelection {
  select: string;
  attemptId?: string | null;
  runScopeId?: string | null;
}

function boardLineageMatches(card: BoardCard, selected: string): boolean {
  return card.id === selected
    || card.sessionId === selected
    || card.raw.runId === selected;
}

/** Resolve an Environment → Tasks handoff. When canonical identity is present,
 * never fall back to a different card that merely shares a reusable session. */
export function findBoardCardForRun(
  cards: BoardCard[],
  selection: BoardRunSelection,
): BoardCard | undefined {
  const selected = selection.select.trim();
  const attemptId = selection.attemptId?.trim() || '';
  const runScopeId = selection.runScopeId?.trim() || '';
  if (!selected) return undefined;
  if (attemptId || runScopeId) {
    return cards.find((card) => (
      boardLineageMatches(card, selected)
      && (!attemptId || card.attemptId === attemptId)
      && (!runScopeId || card.runScopeId === runScopeId)
    ));
  }
  return cards.find((card) => boardLineageMatches(card, selected));
}

/** Convert the authoritative run detail into a temporary board card when an
 * exact deep link points beyond the board's bounded page. Identity must match
 * before any UI opens; a newer attempt on the same session fails closed. */
export function boardCardFromRunDetail(
  run: RunEnvironmentDetail,
  selection: BoardRunSelection,
): BoardCard | undefined {
  const selected = selection.select.trim();
  const attemptId = selection.attemptId?.trim() || '';
  const runScopeId = selection.runScopeId?.trim() || '';
  const runAttemptId = run.runEnvironmentMeta?.attemptId?.trim() || '';
  const runScope = run.runEnvironmentMeta?.runScopeId?.trim() || '';
  const sessionId = run.sessionId?.trim() || run.id;
  if (!selected || (selected !== run.id && selected !== sessionId)) return undefined;
  if (attemptId && attemptId !== runAttemptId) return undefined;
  if (runScopeId && runScopeId !== runScope) return undefined;

  const rawState = String(run.runState || run.status || '').toLowerCase();
  const awaitingApproval = rawState === 'waiting_for_approval' || rawState === 'awaiting_approval';
  const awaitingInput = rawState === 'waiting_for_input' || rawState === 'awaiting_input' || rawState === 'awaiting_user_input';
  const queued = rawState === 'queued' || rawState === 'received';
  const running = run.live === true || ['planning', 'executing', 'running', 'active', 'in_progress'].includes(rawState);
  const column: BoardServerColumnId = awaitingApproval || awaitingInput
    ? 'needs_you'
    : queued
      ? 'queued'
      : running
        ? 'running'
        : 'done';
  const updatedAt = run.updatedAt || run.completedAt || run.createdAt || new Date().toISOString();
  const updatedMs = Date.parse(updatedAt);
  const cancellable = run.canCancel === true
    && typeof run.cancelEndpoint === 'string'
    && run.cancelEndpoint.startsWith('/api/');
  return {
    id: runAttemptId ? `harness:${runAttemptId}` : run.id,
    sourceKind: 'run',
    title: run.title || run.objective || 'Clementine run',
    column,
    status: run.status || rawState || 'unknown',
    progressHint: run.liveLine || run.outputPreview || run.summary?.result || '',
    sessionId,
    ageMs: Number.isFinite(updatedMs) ? Math.max(0, Date.now() - updatedMs) : 0,
    updatedAt,
    actions: cancellable ? ['cancel'] : [],
    attemptId: runAttemptId || undefined,
    runScopeId: runScope || undefined,
    sourceUserSeq: run.runEnvironmentMeta?.sourceUserSeq ?? undefined,
    cancelEndpoint: cancellable ? run.cancelEndpoint : undefined,
    raw: {
      source: run.source,
      objective: run.objective,
      runId: runScope || run.id,
    },
  };
}

/** Resolve an exact out-of-page Tasks deep link through the same authoritative
 * run-detail projection used by Environment. */
export async function resolveBoardRunSelection(
  selection: BoardRunSelection,
): Promise<BoardCard | undefined> {
  const response = await apiGet<{ run: RunEnvironmentDetail }>(
    `/api/runs/${encodeURIComponent(selection.select)}?view=environment`,
  );
  return boardCardFromRunDetail(response.run, selection);
}

/** Keep an already-open trace on the same canonical attempt while replacing
 * its status/actions with the newest polled card. This is what removes stale
 * Running/Cancel UI as soon as the backend settles the run. */
export function reconcileOpenBoardCard(
  open: BoardCard | null,
  cards: BoardCard[],
): BoardCard | null {
  if (!open) return null;
  if (open.attemptId || open.runScopeId) {
    const exact = findBoardCardForRun(cards, {
      select: open.sessionId || open.id,
      attemptId: open.attemptId,
      runScopeId: open.runScopeId,
    });
    if (exact) return exact;
  }
  const sameId = cards.find((card) => card.id === open.id);
  if (sameId) return sameId;
  const sameRunSession = open.sessionId
    ? cards.find((card) => card.sourceKind === open.sourceKind && card.sessionId === open.sessionId)
    : undefined;
  return sameRunSession ?? open;
}

/** SSE replays events with seq > sinceSeq. Starting one event before the
 * attempt's accepted user input includes that request while excluding prior
 * turns from the reusable session. */
export function boardTraceSinceSeq(card: BoardCard): number | undefined {
  if (!card.attemptId || !Number.isFinite(card.sourceUserSeq) || Number(card.sourceUserSeq) <= 0) {
    return undefined;
  }
  return Math.max(0, Math.floor(Number(card.sourceUserSeq)) - 1);
}

/** Kinds whose stop is a DIFFERENT decision, made in its own block: a missed
 * schedule has not started executing (its choice is Resume or Skip), and an
 * approval's controls are approve/reject. */
const NOT_A_STOP: ReadonlySet<BoardSourceKind> = new Set(['schedule', 'approval']);

/** Kinds for which the server projects the cancel endpoint only while the work
 * is actually live. For those, a missing endpoint means there is nothing to
 * stop, so absence must keep the button away. Every other kind's cancel route
 * is derived by `runBoardAction` from the card's identity, and the server
 * answers a wrong-state stop with a reason the drawer shows. */
const STOP_NEEDS_PROJECTED_ENDPOINT: ReadonlySet<BoardSourceKind> = new Set(['run', 'guest']);

/**
 * May this card be stopped from its trace drawer?
 *
 * Reported 2026-09-10 by a second user: "when a background task is running I
 * can't actually see what's going on, or stop it either." Stop was gated on
 * `sourceKind === 'run'`, so the persistent header button existed only for
 * foreground runs. A background task did carry a Cancel — inside the Task
 * cockpit, which shares the drawer's one scroll region with the live feed and
 * is pinned to the newest row while the task works. So the control scrolled
 * itself off-screen exactly while the thing it stops was running, and
 * execution/workflow cards had no drawer stop at all.
 *
 * The card already declares whether it can be cancelled and the server decides
 * the real transition, so ask the card instead of matching on its kind.
 */
export function canStopFromDrawer(card: BoardCard): boolean {
  if (!card.actions.includes('cancel')) return false;
  if (NOT_A_STOP.has(card.sourceKind)) return false;
  const endpoint = typeof card.cancelEndpoint === 'string' ? card.cancelEndpoint : null;
  // A projected endpoint is honored only when it is ours to call.
  if (endpoint !== null && !endpoint.startsWith('/api/')) return false;
  if (STOP_NEEDS_PROJECTED_ENDPOINT.has(card.sourceKind) && endpoint === null) return false;
  return true;
}

/** A missed schedule is a decision card, not an executing workflow. Its
 * durable run id identifies the held occurrence, but it has no event stream
 * or external effects until the user explicitly resumes it. */
export function isWorkflowCatchupCard(card: BoardCard): boolean {
  return card.sourceKind === 'schedule'
    && (card.status === 'missed_schedule' || card.status === 'awaiting_catchup_decision')
    && typeof card.raw.workflowSlug === 'string'
    && card.raw.workflowSlug.length > 0
    && typeof card.raw.runId === 'string'
    && card.raw.runId.length > 0;
}

/** Concise, defensive projection for the missed-run decision UI. Held records
 * may outlive workflow edits or connections, so malformed/stale readiness must
 * never hide Skip or manufacture a green Resume state. */
export function workflowCatchupReadinessFacts(card: BoardCard): {
  blocked: boolean;
  blockerCount: number;
  warningCount: number;
  blockerMessages: string[];
  warningMessages: string[];
} {
  const readiness = card.raw.readiness;
  if (!isWorkflowCatchupCard(card) || !readiness || typeof readiness !== 'object') {
    return { blocked: false, blockerCount: 0, warningCount: 0, blockerMessages: [], warningMessages: [] };
  }
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
  const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : [];
  const message = (item: WorkflowCatchupReadinessItem): string => {
    const reason = typeof item?.reason === 'string' ? item.reason.trim() : '';
    if (reason) return reason;
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    return name ? `${name} is not ready.` : 'A required workflow dependency is not ready.';
  };
  return {
    blocked: readiness.ok === false || blockers.length > 0,
    blockerCount: blockers.length,
    warningCount: warnings.length,
    blockerMessages: blockers.map(message),
    warningMessages: warnings.map(message),
  };
}

/** Exact authenticated action endpoint for one held occurrence. The legacy
 * drag-to-Done `cancel` gesture and the explicit button's `skip` intent both
 * resolve to Skip: this closes only the missed run and keeps future schedules
 * enabled. */
export function workflowCatchupActionPath(
  card: BoardCard,
  intent: 'resume' | 'cancel' | 'skip',
): string | null {
  if (!isWorkflowCatchupCard(card)) return null;
  const action = intent === 'resume' ? 'resume' : 'skip';
  return `/api/console/board/workflow-catchups/${encodeURIComponent(card.raw.workflowSlug!)}`
    + `/${encodeURIComponent(card.raw.runId!)}/${action}`;
}

export const getBackgroundTaskDetail = (id: string) =>
  apiGet<BackgroundTaskDetail>(`/api/console/background-tasks/${encodeURIComponent(id)}`);

export const reviseBackgroundTaskContract = (
  id: string,
  instruction: string,
  evidencePolicy: 'preserve' | 'revalidate' | 'invalidate',
) => apiPost<{ ok: boolean; task?: BackgroundTaskDetail['task']; reason?: string }>(
  `/api/console/background-tasks/${encodeURIComponent(id)}/contract-revisions`,
  { instruction, evidencePolicy },
);

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

/** The report-back channels the user can pick from (origin chat, Discord DM,
 *  Slack DM, …). 404s until the backend ships the endpoint — callers fall back
 *  to the legacy free-text target controls when this rejects. */
export const listReportBackChannels = () =>
  apiGet<{ channels: ReportBackChannel[] }>('/api/console/report-back/channels');

/** Save the chosen report-back channel by KEY (the dropdown path). Posts to the
 *  same target endpoint the legacy object path uses; the backend accepts either. */
export const setBackgroundTaskReportBackChannel = (id: string, key: string) =>
  apiPost<{ ok: boolean; reason?: string }>(
    `/api/console/background-tasks/${encodeURIComponent(id)}/report-back-target`,
    { key },
  );

/** Re-send the task's result to a channel by KEY (the dropdown path). */
export const repostBackgroundTaskResultByChannel = (id: string, key: string) =>
  apiPost<{ ok: boolean; notificationId?: string; reason?: string }>(
    `/api/console/background-tasks/${encodeURIComponent(id)}/repost-result`,
    { key },
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
  provider: 'claude' | 'codex' | 'byo' | 'glm' | 'unknown';
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
export function intentForDrop(card: BoardCard, target: BoardColumnId): 'cancel' | 'resume' | 'promote' | 'approve' | null {
  // A no-op is a drop back into the lane the card is RENDERED in. Comparing
  // against the server column instead would refuse the approve gesture on a
  // parked run: the server calls it Running while the board shows it waiting.
  if (target === boardLaneId(card)) return null; // in-lane reorder is Phase 2
  if (target === 'done' && card.actions.includes('cancel')) return 'cancel';
  if (target === 'running' && card.actions.includes('promote')) return 'promote';
  if (target === 'running' && card.actions.includes('resume')) return 'resume';
  // Drag Needs You → Running IS the approval gesture (owner feedback, 2026-07-23:
  // "park those in task as queued and I can simply drag them over"). Same
  // server endpoint + gating as the card's Approve button — a drag can never
  // reach anything the button couldn't.
  if (target === 'running' && card.actions.includes('approve')) return 'approve';
  return null;
}

/**
 * A drop that moves the card NOWHERE — silent, never a rejection.
 *
 * There are two of them, because the board now renders a card in a lane the
 * server may not agree with. A parked workflow run is `column:'running'` on the
 * wire and renders in "Ready for review": dragging it onto Running asks for the
 * place it is already in, and shouting "nothing to start or resume here" at a
 * gesture that changes nothing is noise the board never used to make.
 */
function isNoOpDrop(card: BoardCard, target: BoardColumnId): boolean {
  return target === boardLaneId(card) || target === card.column;
}

/** Why a drop was rejected, for the snap-back toast. '' means say nothing. */
export function rejectReason(card: BoardCard, target: BoardColumnId): string {
  if (isNoOpDrop(card, target)) return '';
  // Every needs-you lane is one destination: sliding a waiting card between
  // them is not a rejection to shout about, it is a move nothing offers.
  if (target === 'needs_you' || target === 'needs_you_blocked' || target === 'needs_you_review') return '';
  if (target === 'done') return 'This card can’t be cancelled.';
  if (card.status === 'awaiting_approval') return 'This one needs the card’s Approve button — open it to review first.';
  if (card.status === 'awaiting_input') return 'Answer in the originating chat, or use Cancel to clear this task.';
  if (card.status === 'awaiting_continue') return 'Move it to Running to continue the background task.';
  if (target === 'running') return 'Nothing to start or resume here.';
  return 'That move isn’t available.';
}

/**
 * What a column should show while a card hovers over it.
 *
 * ONE derivation, so the border and the toast can never disagree: 'reject' is
 * shown exactly when dropping would produce a message, and a drop that says
 * nothing gets no border. The column compares against the LANE the card renders
 * in — comparing the server column, as it did, painted a parked run's own lane
 * red for a drop that is defined as a no-op.
 */
export function boardDropHighlight(card: BoardCard, target: BoardColumnId): 'accept' | 'reject' | 'none' {
  if (intentForDrop(card, target) !== null) return 'accept';
  return rejectReason(card, target) === '' ? 'none' : 'reject';
}

export type BoardActionIntent = 'cancel' | 'resume' | 'promote' | 'archive' | 'restore';
export type BoardButtonIntent = BoardActionIntent | 'approve' | 'reject' | 'retry_failed_items' | 'resume_safe' | 'skip';

/** Answer a parked task's clarifying question from the board drawer — the same
 *  resume machinery as the chat/Home/Discord/Slack bridges, making the Tasks
 *  board a first-class answer surface (interact-in-place, 2026-07-22). */
export async function answerBackgroundTaskQuestion(taskId: string, answer: string): Promise<{ ok: boolean; reason?: string }> {
  return await apiPost<{ ok: boolean; reason?: string }>(
    `/api/console/board/background/${encodeURIComponent(taskId)}/answer`,
    { answer },
  );
}

export async function runBoardAction(card: BoardCard, intent: BoardButtonIntent): Promise<{ ok: boolean; reason?: string }> {
  try {
    if ((intent === 'approve' || intent === 'reject') && (card.approvalId || card.raw.pendingApprovalId)) {
      const id = card.approvalId || card.raw.pendingApprovalId!;
      return await apiPost<{ ok: boolean; reason?: string }>(
        `/api/console/board/approval/${encodeURIComponent(id)}/${intent}`,
      );
    }
    if (intent === 'cancel' && card.cancelEndpoint) {
      if (!card.cancelEndpoint.startsWith('/api/')) {
        return { ok: false, reason: 'The run did not provide a safe cancellation endpoint.' };
      }
      return await apiPost<{ ok: boolean; reason?: string }>(card.cancelEndpoint);
    }
    if (card.sourceKind === 'schedule' && (intent === 'resume' || intent === 'cancel' || intent === 'skip')) {
      const endpoint = workflowCatchupActionPath(card, intent);
      if (!endpoint) {
        return { ok: false, reason: 'This missed run no longer has a valid occurrence identity.' };
      }
      return await apiPost<{ ok: boolean; reason?: string }>(endpoint);
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
    if (card.sourceKind === 'run' && intent === 'archive') {
      return await apiPost<{ ok: boolean; reason?: string }>(`/api/console/board/run/${encodeURIComponent(card.id)}/archive`);
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
    // Execution-store items are TRACKED long-running work, NOT the goal-
    // contracts shown on the Goals screen — "Goal" here collided with that
    // screen (two stores, two lifecycles, same word). 2026-07-21 UI audit.
    case 'execution': return 'Tracked';
    case 'run': return 'Run';
    case 'approval': return 'Approval';
    case 'schedule': return 'Missed run';
    // The user's own Claude Code / Codex CLI working inside one of their
    // projects, driven by project_run.
    case 'guest': return 'CLI';
  }
}

/** Map a board status/column to a semantic pill tone + label. Raw harness
 *  states never reach the pill verbatim — everything routes through the
 *  shared human vocabulary (work-status.ts). */
export function cardTone(card: BoardCard): { tone: Tone; label: string } {
  const s = card.status.toLowerCase();
  if (card.column === 'done') {
    if (s.includes('fail') || s.includes('abort') || s.includes('interrupt') || s.includes('block')) {
      return { tone: 'danger', label: humanStatusLabel(card.status) };
    }
    if (s.includes('cancel')) return { tone: 'neutral', label: 'Stopped' };
    return { tone: 'success', label: 'Done' };
  }
  if (card.column === 'needs_you') {
    return {
      tone: 'warning',
      label: card.status === 'awaiting_approval'
        ? 'Approval'
        : card.status === 'awaiting_input'
          ? 'Input'
        : card.status === 'awaiting_continue'
          ? 'Continue'
          : humanStatusLabel(card.status),
    };
  }
  if (card.column === 'running') {
    // A parked run is NOT working — it is waiting on a human. Showing "Working"
    // for hours while an approval sits unanswered erodes trust in every pill.
    if (s === 'parked' || s.startsWith('awaiting') || s.startsWith('waiting')) {
      return { tone: 'warning', label: humanStatusLabel(card.status) };
    }
    return { tone: 'live', label: s === 'cancelling' ? 'Stopping…' : 'Working' };
  }
  return { tone: 'neutral', label: 'Queued' };
}
