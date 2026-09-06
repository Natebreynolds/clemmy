/**
 * Unified Conversations API — the desktop console as a single client over
 * the two session engines.
 *
 * There is no data merge: desktop chats live in the SessionStore
 * (sessions.json) and the rest live in the harness eventlog (harness.db).
 * This module merges them ONLY at read time into one normalized list, and
 * dispatches organize edits / history reads to whichever store owns the id.
 *
 * Continuability follows the product decision: chat sessions (desktop +
 * Discord/harness `kind:'chat'`) are continuable; workflow / execution /
 * agent runs are read-only.
 */
import { SessionStore } from '../memory/session-store.js';
import {
  configuredSessionRetentionDays,
  getSession as getHarnessSession,
  listEvents as listHarnessEvents,
  listSessions as listHarnessSessions,
  openEventLog,
  sessionHasAcceptedSourceReplayBinding,
  updateSession as updateHarnessSession,
  type EventRow as HarnessEventRow,
  type SessionRow as HarnessSessionRow,
  type SessionStatus as HarnessSessionStatus,
} from '../runtime/harness/eventlog.js';
import { isUserFacingSession, isInternalSessionId } from '../execution/scope.js';
import { listPendingRuns } from '../execution/workflow-events.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { pendingActionApprovalViewFromArgs } from '../runtime/harness/pending-action-view.js';
import { reconstructHarnessTranscript, harnessPreview, humanHarnessText } from '../runtime/harness/transcript.js';
import { publicUserInputText } from '../runtime/harness/public-presentation.js';
import {
  archiveAuthorityPayloadsForSession,
  permanentlyDeleteSessionAuthorityPayloads,
} from '../runtime/harness/dispatch-ledger.js';
import { deriveTitle, humanizeReportBackTitle } from '../memory/derive-title.js';
import {
  listPlanProposals,
  planProposalNeedsUserInput,
  type PlanProposal,
} from '../agents/plan-proposals.js';
import type {
  SessionRecord,
  SessionOrigin,
  UnifiedSessionSummary,
  UnifiedSessionTurn,
} from '../types.js';

const DESKTOP_PREFIX = 'desktop:';
const HARNESS_PREFIX = 'harness:';

export interface SessionListQuery {
  q?: string;
  tag?: string;
  source?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface ContinueHint {
  mode: 'desktop' | 'harness';
  endpoint: string;
  streamUrl: string | null;
  protocol: 'ndjson' | 'sse';
}

/**
 * One step of a collapsed workflow run, addressed the way the console
 * addresses a session.
 *
 * A workflow run is ONE row in the list but N sessions in the eventlog, and
 * the run page reads events per session. Without this the page reads whichever
 * step happened to be the collapse representative and presents that one step's
 * ledger — its writes, its reply, its status — as the whole run's. A run that
 * emailed in step 2 and wrote a sheet in step 4 then reads "1 change", and the
 * email is simply gone.
 */
export interface UnifiedRunStep {
  /** `harness:<sessionId>` — the same namespace the summary id uses. */
  id: string;
  /** The step's own id from the workflow definition, for naming it in the UI. */
  label: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A session summary, plus the steps a collapsed run was collapsed FROM.
 * `runSteps` is present only on a collapsed workflow run; a chat or a
 * single-session run is its own whole story and carries none.
 */
export interface UnifiedRunSummary extends UnifiedSessionSummary {
  runSteps?: UnifiedRunStep[];
}

export interface SessionDetail {
  session: UnifiedRunSummary;
  turns: UnifiedSessionTurn[];
  continueHint: ContinueHint | null;
}

export interface SessionPatchInput {
  title?: string;
  pinned?: boolean;
  tags?: string[];
  archived?: boolean;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function parseId(id: string): { store: 'desktop' | 'harness'; rawId: string } | null {
  if (id.startsWith(DESKTOP_PREFIX)) return { store: 'desktop', rawId: id.slice(DESKTOP_PREFIX.length) };
  if (id.startsWith(HARNESS_PREFIX)) return { store: 'harness', rawId: id.slice(HARNESS_PREFIX.length) };
  return null;
}

// ─── Harness classification (kept local so this module stays decoupled) ──

function harnessOrigin(row: HarnessSessionRow): SessionOrigin {
  if (row.channel === 'discord' || row.channel === 'discord-dm' || row.metadata?.source === 'discord') {
    return 'discord';
  }
  if (row.kind === 'workflow' || row.channel === 'workflow' || row.metadata?.source === 'workflow') {
    return 'workflow';
  }
  if (row.kind === 'agent') return 'agent';
  if (row.kind === 'execution') return 'workflow';
  return 'desktop';
}

function harnessLabel(row: HarnessSessionRow): string {
  const origin = harnessOrigin(row);
  if (origin === 'discord') return 'Discord conversation';
  if (origin === 'workflow') return 'Workflow run';
  if (origin === 'agent') return 'Agent run';
  return row.channel || row.kind;
}

function metaBool(row: HarnessSessionRow, key: string): boolean {
  return row.metadata?.[key] === true;
}

function metaTags(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
}

/** The legacy desktop store predates typed terminal events, so old assistant
 * turns can contain narrated decision envelopes. Apply the same fail-closed
 * projection used by harness replay before detail, preview, or search sees it. */
function publicDesktopTurns(record: SessionRecord): UnifiedSessionTurn[] {
  const turns: UnifiedSessionTurn[] = [];
  for (const turn of record.turns) {
    const text = turn.role === 'assistant'
      ? humanHarnessText(turn.text, '')
      : turn.text.trim();
    if (!text) continue;
    turns.push({ role: turn.role, text, createdAt: turn.createdAt });
  }
  return turns;
}

// ─── Summaries (preview filled in lazily for the final page) ─────────────

function summarizeDesktop(record: SessionRecord): UnifiedSessionSummary {
  const firstUser = record.turns.find((t) => t.role === 'user');
  // Heal already-persisted raw report-back titles ("[background task bg-… ")
  // at read time — no migration; new sessions never store them (deriveTitle
  // humanizes the synthetic turn up front).
  const storedTitle = record.title ? (humanizeReportBackTitle(record.title) ?? record.title) : '';
  const title = storedTitle
    || (firstUser ? deriveTitle(firstUser.text, 'New chat') : 'New chat');
  return {
    id: `${DESKTOP_PREFIX}${record.id}`,
    origin: record.channel === 'cli' ? 'cli' : 'desktop',
    store: 'desktop',
    kind: 'chat',
    title,
    preview: '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: 'active',
    pinned: Boolean(record.pinned),
    tags: Array.isArray(record.tags) ? record.tags : [],
    archived: Boolean(record.archived),
    continuable: true,
    turnCount: publicDesktopTurns(record).length,
  };
}

function summarizeHarness(row: HarnessSessionRow, titleOverride?: string): UnifiedSessionSummary {
  return {
    id: `${HARNESS_PREFIX}${row.id}`,
    origin: harnessOrigin(row),
    store: 'harness',
    kind: row.kind,
    title: titleOverride || row.title || row.objective || harnessLabel(row),
    preview: '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    pinned: metaBool(row, 'pinned'),
    tags: metaTags(row.metadata),
    archived: metaBool(row, 'archived'),
    // Only chat sessions are continuable from the desktop. Workflow /
    // execution / agent runs are read-only (sending a turn into them is
    // unguarded and can re-fire tools — see plan).
    continuable: row.kind === 'chat',
    turnCount: 0,
  };
}

/**
 * Collect candidate harness summaries, collapsing per-step workflow
 * sessions (one session per step, titled `name::stepId`) into a single
 * row per workflow run so a multi-step workflow doesn't flood the list.
 */
const HARNESS_SESSION_PAGE_SIZE = 500;

function listUserFacingHarnessRows(): HarnessSessionRow[] {
  const out: HarnessSessionRow[] = [];
  for (let offset = 0; ; offset += HARNESS_SESSION_PAGE_SIZE) {
    const page = listHarnessSessions({ limit: HARNESS_SESSION_PAGE_SIZE, offset, status: 'any' });
    out.push(...page.filter((row) => isUserFacingSession(row.id, row.channel ?? undefined)));
    if (page.length < HARNESS_SESSION_PAGE_SIZE) break;
  }
  return out;
}

function listHarnessRowsForWorkflowRun(workflowRunId: string): HarnessSessionRow[] {
  if (!workflowRunId) return [];
  const out: HarnessSessionRow[] = [];
  for (let offset = 0; ; offset += HARNESS_SESSION_PAGE_SIZE) {
    const page = listHarnessSessions({ limit: HARNESS_SESSION_PAGE_SIZE, offset, status: 'any' });
    out.push(...page.filter((row) => row.metadata?.workflowRunId === workflowRunId));
    if (page.length < HARNESS_SESSION_PAGE_SIZE) break;
  }
  return out;
}

function workflowRunIdFor(row: HarnessSessionRow): string {
  return typeof row.metadata?.workflowRunId === 'string' ? row.metadata.workflowRunId : '';
}

function workflowNameFor(row: HarnessSessionRow): string {
  return typeof row.metadata?.workflowName === 'string' ? row.metadata.workflowName : '';
}

function mergedWorkflowRunMetadata(
  representative: HarnessSessionRow,
  rows: HarnessSessionRow[],
): Record<string, unknown> {
  const relatedRows = rows.length > 0 ? rows : [representative];
  const metadata: Record<string, unknown> = { ...representative.metadata };
  const tags: string[] = [];
  const seenTags = new Set<string>();
  let workflowName = '';

  for (const row of relatedRows) {
    const rowName = workflowNameFor(row).trim();
    if (!workflowName && rowName) workflowName = rowName.slice(0, 120);

    for (const tag of metaTags(row.metadata)) {
      const normalized = tag.trim().slice(0, 40);
      if (!normalized || seenTags.has(normalized) || tags.length >= 20) continue;
      seenTags.add(normalized);
      tags.push(normalized);
    }
  }

  metadata.pinned = relatedRows.some((row) => metaBool(row, 'pinned'));
  metadata.archived = relatedRows.some((row) => metaBool(row, 'archived'));
  metadata.tags = tags;
  if (workflowName) metadata.workflowName = workflowName;
  return metadata;
}

/**
 * Statuses that describe a run more truthfully than any sibling can override.
 * Read in order: one active step means the run is running; one paused step
 * means it is waiting on someone; one failed step means the run failed,
 * whatever its siblings did.
 */
const WORKFLOW_RUN_STATUS_PRECEDENCE: readonly HarnessSessionStatus[] = [
  'active',
  'paused',
  'failed',
  'cancelled',
];

/**
 * The status of a whole workflow run, never of its most-recent step.
 *
 * The collapse used to hand the representative row's status straight to the
 * page, so between step 3 finishing and step 4 being created a running run
 * wore a green "Completed" pill, elapsed froze, and Stop was withheld. Two
 * sources are consulted, and "Completed" survives only if BOTH agree:
 *
 *   · the step sessions — one still `active` means the run is running;
 *   · the workflow's own durable run log — a run with no terminal record is
 *     still executing even in the gap where no step session is active. That
 *     gap is precisely when the old code lied.
 *
 * Anything unrecognised is reported verbatim rather than rounded up to
 * success: an unknown status is not a completed one.
 */
function aggregateWorkflowRunStatus(
  rows: readonly HarnessSessionRow[],
  fallback: HarnessSessionStatus,
  runStillPending: boolean,
): HarnessSessionStatus {
  if (runStillPending) return 'active';
  if (rows.length === 0) return fallback;
  const statuses = new Set<HarnessSessionStatus>(rows.map((row) => row.status));
  for (const loud of WORKFLOW_RUN_STATUS_PRECEDENCE) {
    if (statuses.has(loud)) return loud;
  }
  // Nothing loud is left, so every step says completed — unless a newer
  // daemon widened the enum, in which case the unrecognised status is
  // reported verbatim rather than rounded up to success.
  const unrecognised = [...statuses].find((status) => status !== 'completed');
  return unrecognised ?? (statuses.has('completed') ? 'completed' : fallback);
}

function earliest(values: readonly string[], fallback: string): string {
  return values.reduce((min, value) => (value && value < min ? value : min), fallback);
}

function latest(values: readonly string[], fallback: string): string {
  return values.reduce((max, value) => (value && value > max ? value : max), fallback);
}

/**
 * The collapsed row a workflow run is summarized from. Its window spans every
 * step (the representative is the NEWEST step, so its own createdAt would date
 * the run from its last step and report a minutes-long run as seconds), and
 * its status is the run's, not the representative's.
 */
function mergedWorkflowRunRow(
  representative: HarnessSessionRow,
  rows: HarnessSessionRow[],
  runStillPending = false,
): HarnessSessionRow {
  const relatedRows = rows.length > 0 ? rows : [representative];
  return {
    ...representative,
    createdAt: earliest(relatedRows.map((row) => row.createdAt), representative.createdAt),
    updatedAt: latest(relatedRows.map((row) => row.updatedAt), representative.updatedAt),
    status: aggregateWorkflowRunStatus(relatedRows, representative.status, runStillPending),
    metadata: mergedWorkflowRunMetadata(representative, rows),
  };
}

function workflowStepLabel(row: HarnessSessionRow): string {
  const stepId = typeof row.metadata?.stepId === 'string' ? row.metadata.stepId.trim() : '';
  if (stepId) return stepId.slice(0, 80);
  // Step sessions are titled `<workflow name>::<stepId>` (workflow-runner.ts).
  const title = (row.title ?? '').trim();
  const marker = title.lastIndexOf('::');
  const tail = marker >= 0 ? title.slice(marker + 2).trim() : title;
  return (tail || row.id).slice(0, 80);
}

/** Chronological, because a run is a sequence and its ledger reads in order. */
function workflowRunSteps(rows: readonly HarnessSessionRow[]): UnifiedRunStep[] {
  return [...rows]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((row) => ({
      id: `${HARNESS_PREFIX}${row.id}`,
      label: workflowStepLabel(row),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
}

/**
 * Whether a workflow run has reached a terminal in its own durable log — the
 * only authority that can see the gap between two step sessions. Read lazily
 * and once per request, and fail OPEN (treat an unreadable log as "no claim")
 * rather than blocking the list.
 */
function pendingWorkflowRunIds(): Set<string> {
  try {
    return new Set(listPendingRuns().map((run) => run.runId));
  } catch {
    return new Set();
  }
}

function summarizeWorkflowRun(
  representative: HarnessSessionRow,
  rows: HarnessSessionRow[],
  runStillPending: boolean,
): UnifiedRunSummary {
  const aggregate = mergedWorkflowRunRow(representative, rows, runStillPending);
  const workflowName = workflowNameFor(aggregate);
  return {
    ...summarizeHarness(aggregate, workflowName || undefined),
    runSteps: workflowRunSteps(rows.length > 0 ? rows : [representative]),
  };
}

function relatedHarnessRowsForPatch(row: HarnessSessionRow): HarnessSessionRow[] {
  const workflowRunId = workflowRunIdFor(row);
  return workflowRunId ? listHarnessRowsForWorkflowRun(workflowRunId) : [row];
}

interface HarnessSummaryCollection {
  summaries: UnifiedRunSummary[];
  rawIds: Set<string>;
}

function collectHarnessSummaries(): HarnessSummaryCollection {
  const rows = listUserFacingHarnessRows();
  const out: UnifiedRunSummary[] = [];
  const rawIds = new Set(rows.map((row) => row.id));
  const workflowRows = new Map<string, HarnessSessionRow[]>();
  const seenWorkflowRuns = new Set<string>();

  for (const row of rows) {
    const runId = workflowRunIdFor(row);
    if (!runId) continue;
    const grouped = workflowRows.get(runId);
    if (grouped) grouped.push(row);
    else workflowRows.set(runId, [row]);
  }

  // One filesystem scan for the whole list, and only when a collapsed
  // workflow run is actually present.
  let pending: Set<string> | null = null;
  const stillPending = (runId: string): boolean => {
    pending ??= pendingWorkflowRunIds();
    return pending.has(runId);
  };

  for (const row of rows) {
    const runId = workflowRunIdFor(row);
    if (runId) {
      // rows are updated_at DESC, so the first one we see per run is the
      // most recent step — keep it as the run's representative row.
      if (seenWorkflowRuns.has(runId)) continue;
      seenWorkflowRuns.add(runId);
      out.push(summarizeWorkflowRun(row, workflowRows.get(runId) ?? [row], stillPending(runId)));
      continue;
    }
    out.push(summarizeHarness(row));
  }
  return { summaries: out, rawIds };
}

function desktopSearchText(record: SessionRecord): string {
  const tail = publicDesktopTurns(record).slice(-20).map((t) => t.text).join(' ');
  return `${record.title ?? ''} ${tail}`.toLowerCase();
}

function harnessSearchText(summary: UnifiedSessionSummary): string {
  const rawId = summary.id.slice(HARNESS_PREFIX.length);
  const row = getHarnessSession(rawId);
  const tail = (row ? reconstructHarnessDetailTurns(row, 40) : reconstructHarnessTranscript(rawId, 40))
    .slice(-20)
    .map((t) => t.text)
    .join(' ');
  return `${summary.title ?? ''} ${tail}`.toLowerCase();
}

function workflowEventTurn(event: HarnessEventRow): (UnifiedSessionTurn & { seq: number }) | null {
  if (event.type === 'user_input_received') {
    // Synthetic user turns (outcome relays / report-back directives from
    // runtime/outcome.ts) are machine input — never render them as user bubbles.
    if (event.data.synthetic === true) return null;
    const text = publicUserInputText(event.data);
    return text ? { role: 'user', text, createdAt: event.createdAt, seq: event.seq } : null;
  }
  if (event.type === 'conversation_completed') {
    const text = humanHarnessText(event.data, '');
    return text ? { role: 'assistant', text, createdAt: event.createdAt, seq: event.seq } : null;
  }
  return null;
}

function reconstructWorkflowRunTranscript(workflowRunId: string, perSessionLimit = 1000): UnifiedSessionTurn[] {
  const turns = listHarnessRowsForWorkflowRun(workflowRunId)
    .flatMap((row) => listHarnessEvents(row.id, {
      types: ['user_input_received', 'conversation_completed'],
      limit: perSessionLimit,
    }))
    .map(workflowEventTurn)
    .filter((turn): turn is UnifiedSessionTurn & { seq: number } => turn !== null);
  turns.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.seq - right.seq);
  return turns.map(({ seq: _seq, ...turn }) => turn);
}

function reconstructHarnessDetailTurns(row: HarnessSessionRow, perSessionLimit = 1000): UnifiedSessionTurn[] {
  const workflowRunId = workflowRunIdFor(row);
  return workflowRunId
    ? reconstructWorkflowRunTranscript(workflowRunId, perSessionLimit)
    : reconstructHarnessTranscript(row.id, perSessionLimit);
}

function fillHarnessPreviewAndCount(summary: UnifiedSessionSummary): void {
  const rawId = summary.id.slice(HARNESS_PREFIX.length);
  const row = getHarnessSession(rawId);
  if (!row) {
    summary.preview = clip(harnessPreview(rawId), 140);
    return;
  }
  const turns = reconstructHarnessDetailTurns(row, 1000);
  summary.turnCount = turns.length;
  summary.preview = clip(turns[turns.length - 1]?.text ?? '', 140);
}

function canonicalHarnessRowForRawId(rawId: string): HarnessSessionRow | null {
  const row = getHarnessSession(rawId);
  return row && isUserFacingSession(row.id, row.channel ?? undefined) ? row : null;
}

function detailForHarnessRow(row: HarnessSessionRow): SessionDetail {
  const runId = workflowRunIdFor(row);
  const summary: UnifiedRunSummary = runId
    ? summarizeWorkflowRun(row, listHarnessRowsForWorkflowRun(runId), pendingWorkflowRunIds().has(runId))
    : summarizeHarness(row);
  const turns = reconstructHarnessDetailTurns(row);
  appendPendingApprovalTurns(row.id, turns);
  // Only a continuable chat can own an inline plan decision. Workflow,
  // execution, and agent transcripts are intentionally read-only; attaching
  // an Approve card there would paint a gate whose handlers are no-ops.
  if (row.kind === 'chat') appendPendingPlanProposalTurns(row.id, turns);
  summary.turnCount = turns.length;
  summary.preview = clip(turns[turns.length - 1]?.text ?? '', 140);
  return { session: summary, turns, continueHint: continueHintFor(summary, row.id) };
}

function reopenedPlanText(proposal: PlanProposal): string {
  const objective = clip(proposal.plan.objective || proposal.originatingRequest || 'Review this plan', 260);
  const steps = proposal.plan.steps
    .slice(0, 12)
    .map((step) => `${step.n}. ${clip(step.action, 220)}`)
    .join('\n');
  return [
    'I drafted this plan for review before I start.',
    '',
    `Goal: ${objective}`,
    steps ? `\nWhat I will do:\n${steps}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Restore still-pending, approvable plan cards when a harness conversation is
 * reopened. The plan registry is the current authority: resolved, rejected,
 * superseded, held, and question-bearing plans never regain approval buttons.
 */
function appendPendingPlanProposalTurns(sessionId: string, turns: UnifiedSessionTurn[]): void {
  try {
    const proposals = listPlanProposals({ status: 'pending', sessionId, limit: 50 })
      .filter((proposal) => proposal.kind !== 'workflow_pending_inputs')
      .filter((proposal) => proposal.heldForLater !== true)
      .filter((proposal) => !planProposalNeedsUserInput(proposal))
      .sort((left, right) => left.proposedAt.localeCompare(right.proposedAt));
    const pendingById = new Map(proposals.map((proposal) => [proposal.id, proposal]));

    // Current plan-first terminals already carry their exact proposal id.
    // Retain that id on the original assistant turn so reopen shows one plan
    // description in its real timeline, not a duplicated synthetic card at the
    // bottom. Resolved/stale ids lose actionability but keep their prose.
    for (const turn of turns) {
      if (!turn.planProposalId) continue;
      if (pendingById.delete(turn.planProposalId)) continue;
      delete turn.planProposalId;
    }

    // Rolling-upgrade and old pre-terminal records may have a pending proposal
    // without planProposalId in their event. Only those need a synthetic card.
    for (const proposal of pendingById.values()) {
      turns.push({
        role: 'assistant',
        text: reopenedPlanText(proposal),
        createdAt: proposal.proposedAt,
        planProposalId: proposal.id,
      });
    }
  } catch {
    // A damaged optional proposal registry must not make conversation history
    // unreadable. The Inbox retains its own explicit error surface.
  }
}

/**
 * A2 (v2.3.0): surface STILL-PENDING approval cards in a reopened chat. The
 * live stream folds `approval_requested` into the actionable card, but the
 * reconstructed transcript is turn-level, so on reopen the user saw only the
 * prose "reply approve apr-x" while the card existed nowhere in the chat
 * (live 2026-07-23). Attach one synthetic assistant turn per approval that is
 * still pending; resolved/expired approvals render nothing.
 */
function appendPendingApprovalTurns(sessionId: string, turns: UnifiedSessionTurn[]): void {
  try {
    const cardEvents = listHarnessEvents(sessionId, { types: ['approval_requested'] });
    if (cardEvents.length === 0) return;
    const seen = new Set<string>();
    for (const ev of cardEvents) {
      const d = ev.data as Record<string, unknown>;
      const approvalId = typeof d.approvalId === 'string' ? d.approvalId : '';
      if (!approvalId || seen.has(approvalId)) continue;
      seen.add(approvalId);
      const rowNow = approvalRegistry.get(approvalId);
      if (!rowNow || rowNow.status !== 'pending') continue;
      if (!approvalRegistry.isFormalApprovalSurface(rowNow)) {
        turns.push({
          role: 'assistant',
          text: rowNow.presentation?.question ?? '',
          createdAt: ev.createdAt,
        });
        continue;
      }
      turns.push({
        role: 'assistant',
        text: '',
        createdAt: ev.createdAt,
        approval: {
          subject: typeof d.subject === 'string' && d.subject ? d.subject : String(d.tool ?? 'this action'),
          reason: typeof d.reason === 'string' ? d.reason : undefined,
          approvalId,
          // Hydrated fresh from the registry row (card events are slim, ids
          // only) — also picks up the CURRENT pending-action state rather
          // than a snapshot from park time.
          pendingAction: pendingActionApprovalViewFromArgs(rowNow.args ?? null),
        },
      });
    }
  } catch { /* history remains renderable without the card */ }
}

// ─── Public API ──────────────────────────────────────────────────────────

export function buildUnifiedSessionList(query: SessionListQuery = {}): UnifiedRunSummary[] {
  const store = new SessionStore();
  const q = query.q?.trim().toLowerCase() ?? '';
  const tag = query.tag?.trim() ?? '';
  const source = query.source?.trim() ?? '';
  const includeArchived = Boolean(query.includeArchived);
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
  const harnessCollection = collectHarnessSummaries();
  const harness = harnessCollection.summaries;
  const harnessRawIds = harnessCollection.rawIds;

  // Desktop side — also keep the matching records for cheap search/preview.
  const desktopRecords = new Map<string, SessionRecord>();
  const desktop: UnifiedRunSummary[] = [];
  for (const record of store.listAll()) {
    if (isInternalSessionId(record.id)) continue;
    // If a raw id exists in both stores, the harness row is the canonical
    // conversation. Desktop duplicates are report-back ghosts created by older
    // outcome delivery and should not shadow the full harness transcript.
    if (harnessRawIds.has(record.id)) continue;
    desktopRecords.set(record.id, record);
    desktop.push(summarizeDesktop(record));
  }

  let all = [...desktop, ...harness];

  if (!includeArchived) all = all.filter((s) => !s.archived);
  if (source) all = all.filter((s) => s.origin === source);
  if (tag) all = all.filter((s) => s.tags.includes(tag));
  if (q) {
    all = all.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      if (s.store === 'desktop') {
        const rec = desktopRecords.get(s.id.slice(DESKTOP_PREFIX.length));
        if (rec && desktopSearchText(rec).includes(q)) return true;
      } else if (harnessSearchText(s).includes(q)) {
        return true;
      }
      return false;
    });
  }

  // Pinned first, then most-recently-updated.
  all.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const page = all.slice(0, limit);

  // Fill previews/turnCounts only for the returned page (bounds query cost).
  for (const summary of page) {
    if (summary.store === 'desktop') {
      const rec = desktopRecords.get(summary.id.slice(DESKTOP_PREFIX.length));
      const publicTurns = rec ? publicDesktopTurns(rec) : [];
      const last = publicTurns[publicTurns.length - 1];
      summary.preview = last ? clip(last.text, 140) : '';
    } else {
      fillHarnessPreviewAndCount(summary);
    }
  }
  return page;
}

function continueHintFor(summary: UnifiedSessionSummary, rawId: string): ContinueHint | null {
  if (!summary.continuable) return null;
  if (summary.store === 'desktop') {
    return {
      mode: 'desktop',
      endpoint: '/api/console/home/chat/stream',
      streamUrl: null,
      protocol: 'ndjson',
    };
  }
  return {
    mode: 'harness',
    endpoint: '/api/harness/chat',
    streamUrl: `/api/sessions/${rawId}/events`,
    protocol: 'sse',
  };
}

export function getUnifiedSessionDetail(id: string): SessionDetail | null {
  const parsed = parseId(id);
  if (!parsed) return null;

  if (parsed.store === 'desktop') {
    const canonicalHarnessRow = canonicalHarnessRowForRawId(parsed.rawId);
    if (canonicalHarnessRow) return detailForHarnessRow(canonicalHarnessRow);

    const store = new SessionStore();
    if (!store.exists(parsed.rawId)) return null;
    const record = store.get(parsed.rawId);
    const summary = summarizeDesktop(record);
    const turns = publicDesktopTurns(record);
    const last = turns[turns.length - 1];
    summary.preview = last ? clip(last.text, 140) : '';
    return { session: summary, turns, continueHint: continueHintFor(summary, parsed.rawId) };
  }

  const row = getHarnessSession(parsed.rawId);
  if (!row) return null;
  return detailForHarnessRow(row);
}

export function patchUnifiedSession(id: string, patch: SessionPatchInput): UnifiedRunSummary | null {
  const parsed = parseId(id);
  if (!parsed) return null;

  if (parsed.store === 'desktop') {
    const canonicalHarnessRow = canonicalHarnessRowForRawId(parsed.rawId);
    if (canonicalHarnessRow) return patchUnifiedSession(`${HARNESS_PREFIX}${canonicalHarnessRow.id}`, patch);

    const store = new SessionStore();
    const updated = store.setMeta(parsed.rawId, patch);
    if (!updated) return null;
    const summary = summarizeDesktop(updated);
    const turns = publicDesktopTurns(updated);
    const last = turns[turns.length - 1];
    summary.preview = last ? clip(last.text, 140) : '';
    return summary;
  }

  const row = getHarnessSession(parsed.rawId);
  if (!row) return null;
  const relatedRows = relatedHarnessRowsForPatch(row);
  const workflowRunId = workflowRunIdFor(row);
  const patchTags = patch.tags !== undefined
    ? patch.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20)
    : undefined;
  let next = row;
  for (const target of relatedRows) {
    const meta = { ...target.metadata };
    if (patch.pinned !== undefined) meta.pinned = patch.pinned;
    if (patch.archived !== undefined) meta.archived = patch.archived;
    if (patchTags !== undefined) meta.tags = patchTags;
    if (workflowRunId && patch.title !== undefined) meta.workflowName = patch.title.trim().slice(0, 120);
    const updated = updateHarnessSession(target.id, {
      metadata: meta,
      ...(!workflowRunId && patch.title !== undefined ? { title: patch.title.trim().slice(0, 120) } : {}),
    });
    if (target.id === parsed.rawId) next = updated;
  }
  // The patched row goes back as the SAME shape the list serves — a collapsed
  // run re-aggregated over its steps, not the one step that was addressed.
  // Anything less and a pin or rename would swap a run's status pill for its
  // representative step's on the way back.
  const summary: UnifiedRunSummary = workflowRunId
    ? summarizeWorkflowRun(
      next,
      listHarnessRowsForWorkflowRun(workflowRunId),
      pendingWorkflowRunIds().has(workflowRunId),
    )
    : summarizeHarness(next);
  fillHarnessPreviewAndCount(summary);
  return summary;
}

export function deleteUnifiedSession(
  id: string,
  hard = false,
): {
  ok: boolean;
  mode: 'deleted' | 'archived';
  retainedForReplay?: boolean;
  retentionDays?: number;
  authorityPayloadsDeleted?: boolean;
  replayMode?: 'terminal_or_typed_no_redispatch';
} | null {
  const parsed = parseId(id);
  if (!parsed) return null;

  if (parsed.store === 'desktop') {
    const canonicalHarnessRow = canonicalHarnessRowForRawId(parsed.rawId);
    if (canonicalHarnessRow) return deleteUnifiedSession(`${HARNESS_PREFIX}${canonicalHarnessRow.id}`, hard);

    const store = new SessionStore();
    return { ok: store.delete(parsed.rawId), mode: 'deleted' };
  }

  const row = getHarnessSession(parsed.rawId);
  if (!row) return null;
  const related = relatedHarnessRowsForPatch(row);
  if (hard) {
    const retainedForReplay = related.some((target) =>
      sessionHasAcceptedSourceReplayBinding(target.id));
    for (const target of related) {
      permanentlyDeleteSessionAuthorityPayloads(target.id);
      if (retainedForReplay) {
        updateHarnessSession(target.id, {
          metadata: {
            ...target.metadata,
            archived: true,
            acceptedSourceReplayTombstone: true,
            acceptedSourceReplayTombstonedAt: new Date().toISOString(),
          },
        });
      }
    }
    if (retainedForReplay) {
      return {
        ok: true,
        mode: 'archived',
        retainedForReplay: true,
        retentionDays: configuredSessionRetentionDays(),
        authorityPayloadsDeleted: true,
        replayMode: 'terminal_or_typed_no_redispatch',
      };
    }
    const db = openEventLog();
    const deleted = db.transaction(() => {
      let count = 0;
      for (const target of related) {
        count += db.prepare('DELETE FROM sessions WHERE id = ?').run(target.id).changes;
      }
      return count;
    }).immediate();
    return { ok: deleted === related.length, mode: 'deleted', authorityPayloadsDeleted: true };
  }
  for (const target of related) {
    archiveAuthorityPayloadsForSession(target.id);
    updateHarnessSession(target.id, { metadata: { ...target.metadata, archived: true } });
  }
  return { ok: true, mode: 'archived' };
}
