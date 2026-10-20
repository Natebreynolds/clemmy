import { readApprovalCardResultSnapshot } from '../runtime/harness/approval-card-result-reader.js';
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
import type Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import pino from 'pino';
import { measureProjectionRead, type ProjectionReadObserver, type ProjectionReadPhase } from './projection-read-metrics.js';
import { createWorkflowRunStatusReader, type UnifiedRunCoverage } from './workflow-run-status.js';
export type { UnifiedRunCoverage } from './workflow-run-status.js';
import {
  configuredSessionRetentionDays,
  getSession as getHarnessSession,
  listEvents as listHarnessEvents,
  listEventsAtSequences as listHarnessEventsAtSequences,
  listSessions as listHarnessSessions,
  listSessionRowsForDisplay,
  openEventLog,
  sessionHasAcceptedSourceReplayBinding,
  updateSession as updateHarnessSession,
  type EventRow as HarnessEventRow,
  type SessionRow as HarnessSessionRow,
  activeRunSessionIds,
} from '../runtime/harness/eventlog.js';
import { withSessionProofCascade } from '../runtime/harness/retained-session-proof-schema.js';
import { readAcceptedSourceConversationProjection } from '../runtime/harness/accepted-source-session-branch.js';
import { isUserFacingSession, isInternalSessionId } from '../execution/scope.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { pendingActionApprovalViewFromArgs } from '../runtime/harness/pending-action-view.js';
import { reconstructHarnessTranscript, reconstructHarnessTranscriptText, harnessPreview, humanHarnessText } from '../runtime/harness/transcript.js';
import { sessionAgentState } from '../agents/session-agent-state.js';
import { sessionProjectState } from '../projects/session-project-state.js';
import { approvalPreviewProjection, publicUserInputText } from '../runtime/harness/public-presentation.js';
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
  /** Only conversations opened in this saved agent. */
  agent?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface ContinueHint {
  mode: 'desktop' | 'harness';
  endpoint: string;
  streamUrl: string | null;
  protocol: 'ndjson' | 'sse';
}

export interface UnifiedRunStep {
  id: string;
  label: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface UnifiedRunSummary extends UnifiedSessionSummary {
  /** Physical head for new messages and controls; id remains the public root. */
  executionSessionId?: string;
  runSteps?: UnifiedRunStep[];
  runCoverage?: UnifiedRunCoverage;
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
    agentId: null,
    agentName: null,
  };
}

function metaAgent(meta: Record<string, unknown> | undefined): {
  agentId: string | null; agentName: string | null; agentIds: string[];
  projectId: string | null; projectName: string | null;
} {
  const { agentId, agentName, agentIds } = sessionAgentState(meta);
  const { projectId, projectName } = sessionProjectState(meta);
  return { agentId, agentName, agentIds, projectId, projectName };
}

/** Sessions with work in flight, read at most once a second for a list. */
let activeRunRead: { at: number; ids: Set<string> } | null = null;
function sessionRunning(sessionId: string): boolean {
  const now = Date.now();
  if (!activeRunRead || now - activeRunRead.at > 1000) {
    try { activeRunRead = { at: now, ids: activeRunSessionIds() }; } catch { activeRunRead = { at: now, ids: new Set() }; }
  }
  return activeRunRead.ids.has(sessionId);
}

/** A session branched off a conversation (an accepted-source successor)
 * carries that conversation's title, never its channel name. Live
 * 2026-10-07: every branched turn listed as "desktop". The root's stored
 * title wins; failing that, the root's first words. */
function branchConversationTitle(row: HarnessSessionRow, allRows?: HarnessSessionRow[]): string {
  try {
    const branch = row.metadata?.__accepted_source_branch as { rootSessionId?: unknown; parentSessionId?: unknown } | undefined;
    const rootId = typeof branch?.rootSessionId === 'string' ? branch.rootSessionId
      : typeof branch?.parentSessionId === 'string' ? branch.parentSessionId : '';
    if (!rootId || rootId === row.id) return '';
    const root = snapshotRow(allRows, rootId);
    if (!root) return '';
    const stored = root.title ? (humanizeReportBackTitle(root.title) ?? root.title) : '';
    if (stored) return stored;
    if (root.objective) return root.objective;
    const first = listHarnessEvents(rootId, { types: ['user_input_received'], limit: 1 })
      .find((event) => event.role === 'user' && typeof event.data.text === 'string' && event.data.synthetic !== true);
    return first ? deriveTitle(publicUserInputText(first.data) || String(first.data.text), '') : '';
  } catch {
    return '';
  }
}

/** The bounded revision link a card event carries, or nothing. */
function approvalRevisionProjection(value: unknown): { revises: NonNullable<UnifiedSessionTurn['approval']>['revises'] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.approvalId !== 'string' || !record.approvalId.trim()) return null;
  const fields = Array.isArray(record.fields)
    ? (record.fields as unknown[]).flatMap((field) => {
        if (!field || typeof field !== 'object' || Array.isArray(field)) return [];
        const f = field as Record<string, unknown>;
        if (typeof f.name !== 'string' || typeof f.value !== 'string') return [];
        return [{ name: f.name, value: f.value, ...(typeof f.label === 'string' ? { label: f.label } : {}) }];
      })
    : undefined;
  return {
    revises: {
      approvalId: record.approvalId,
      ...(typeof record.changeRequest === 'string' && record.changeRequest.trim() ? { changeRequest: record.changeRequest.slice(0, 600) } : {}),
      ...(fields && fields.length > 0 ? { fields } : {}),
    },
  };
}

function summarizeHarness(row: HarnessSessionRow, titleOverride?: string, allRows?: HarnessSessionRow[]): UnifiedSessionSummary {
  return {
    id: `${HARNESS_PREFIX}${row.id}`,
    origin: harnessOrigin(row),
    store: 'harness',
    kind: row.kind,
    title: titleOverride || row.title || row.objective || branchConversationTitle(row, allRows) || harnessLabel(row),
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
    running: sessionRunning(row.id),
    ...metaAgent(row.metadata),
  };
}

/**
 * Collect candidate harness summaries, collapsing per-step workflow
 * sessions (one session per step, titled `name::stepId`) into a single
 * row per workflow run so a multi-step workflow doesn't flood the list.
 */
const HARNESS_SESSION_PAGE_SIZE = 500;

/** Every harness row, unfiltered. The session table is paged through exactly
 *  once and the result is shared by everything that needs it in the same
 *  request — see listHarnessRowsForWorkflowRun for why that matters. */
function listAllHarnessRows(options: { withoutConversationState?: boolean; observer?: ProjectionReadObserver } = {}): HarnessSessionRow[] {
  const out: HarnessSessionRow[] = [];
  for (let offset = 0; ; offset += HARNESS_SESSION_PAGE_SIZE) {
    const page = measureProjectionRead(options.observer, 'catalog_pages', () => listHarnessSessions({
      limit: HARNESS_SESSION_PAGE_SIZE,
      offset,
      status: 'any',
      withoutConversationState: options.withoutConversationState,
    }), (rows) => rows.length);
    out.push(...page);
    if (page.length < HARNESS_SESSION_PAGE_SIZE) break;
  }
  return out;
}

/**
 * The same rows without the model/recovery state in `metadata`, for the list
 * a person reads. Live 2026-09-22 the full scan parsed 136 MB of session
 * metadata per call (132 MB of it conversation state) and held the daemon's
 * event loop for 12-26 s while the chat rail loaded. Read-only: these rows
 * must never reach updateHarnessSession, which replaces metadata whole — the
 * patch and delete paths keep reading full rows.
 */
function listAllHarnessRowsForDisplay(observer?: ProjectionReadObserver): HarnessSessionRow[] {
  const reused = measureProjectionRead(observer, 'catalog_pages', () => listSessionRowsForDisplay(), (rows) => rows?.length ?? 0);
  return reused ?? listAllHarnessRows({ withoutConversationState: true, observer });
}

function userFacingHarnessRows(all: HarnessSessionRow[]): HarnessSessionRow[] {
  return all.filter((row) => isUserFacingSession(row.id, row.channel ?? undefined) && !isHelperSession(row));
}

function listUserFacingHarnessRows(): HarnessSessionRow[] {
  return userFacingHarnessRows(listAllHarnessRows());
}

/** A helper a turn spawned (run_worker) runs under its own worker session.
 *  It is not a conversation — its steps nest under the parent turn's card —
 *  so it never gets a row of its own in the rail (owner 2026-09-08: the
 *  sidebar showed "all the sessions"). */
function isHelperSession(row: HarnessSessionRow): boolean {
  return row.metadata?.workerScope === true || row.metadata?.source === 'delegated_worker';
}
/**
 * Rows belonging to one workflow run.
 *
 * 2026-09-10: this paged through the WHOLE session table on every call, and
 * the sessions list calls it once per workflow row in the page. With 1,469
 * sessions and 45 workflow rows in a 100-row page that is ~66,000 redundant
 * row reads, and /api/console/sessions took 14.6s to produce 65KB — measured
 * at ~110ms per returned row, scaling linearly with the page size (limit=500
 * took 54s). Callers that already hold a snapshot now pass it in; the filter
 * is unchanged, so the result is identical.
 */
function listHarnessRowsForWorkflowRun(
  workflowRunId: string,
  reference: HarnessSessionRow,
  allRows?: HarnessSessionRow[],
): HarnessSessionRow[] {
  if (!workflowRunId) return [];
  if (allRows) return snapshotIndex(allRows).workflowRows.get(JSON.stringify([workflowRunId, reference.userId])) ?? [];
  const source = allRows ?? listAllHarnessRows();
  return source.filter((row) => workflowRunIdFor(row) === workflowRunId
    && row.userId === reference.userId);
}

function workflowRunIdFor(row: HarnessSessionRow): string {
  if (row.kind !== 'workflow' || !isUserFacingSession(row.id, row.channel ?? undefined)) return '';
  return typeof row.metadata?.workflowRunId === 'string' ? row.metadata.workflowRunId : '';
}

function workflowRunGroupKey(row: HarnessSessionRow): string {
  const runId = workflowRunIdFor(row);
  return runId ? JSON.stringify([runId, row.userId]) : '';
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

function mergedWorkflowRunRow(
  representative: HarnessSessionRow,
  rows: HarnessSessionRow[],
): HarnessSessionRow {
  return {
    ...representative,
    createdAt: rows.reduce((min, row) => row.createdAt < min ? row.createdAt : min, representative.createdAt),
    updatedAt: rows.reduce((max, row) => row.updatedAt > max ? row.updatedAt : max, representative.updatedAt),
    metadata: mergedWorkflowRunMetadata(representative, rows),
  };
}

function summarizeWorkflowRun(representative: HarnessSessionRow, rows: HarnessSessionRow[]): UnifiedRunSummary {
  const members = rows.length > 0 ? rows : [representative];
  const aggregate = mergedWorkflowRunRow(representative, members);
  return {
    ...summarizeHarness(aggregate, workflowNameFor(aggregate) || undefined),
    runSteps: [...members].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((row) => ({
        id: `${HARNESS_PREFIX}${row.id}`,
        label: (typeof row.metadata?.stepId === 'string' && row.metadata.stepId.trim()
          ? row.metadata.stepId.trim() : row.title || row.id).slice(0, 80),
        status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
      })),
  };
}

/** The snapshot's row for an id, indexed once per snapshot. A list build
 *  already holds every row; re-reading one by id would parse its full
 *  metadata (up to ~10 MB of conversation state) just to read a few keys. */
interface HarnessSnapshotIndex {
  rows: Map<string, HarnessSessionRow>;
  workflowRows: Map<string, HarnessSessionRow[]>;
  conversations: Map<string, ReturnType<typeof readAcceptedSourceConversationProjection>>;
  observer?: ProjectionReadObserver;
}
// These presentation indexes live only as long as this request's row array.
// Detail, mutation and control paths do not pass a snapshot and read fresh.
const snapshotIndexes = new WeakMap<HarnessSessionRow[], HarnessSnapshotIndex>();
function snapshotIndex(allRows: HarnessSessionRow[], observer?: ProjectionReadObserver): HarnessSnapshotIndex {
  let index = snapshotIndexes.get(allRows);
  if (!index) {
    index = { rows: new Map(), workflowRows: new Map(), conversations: new Map(), observer };
    for (const row of allRows) {
      index.rows.set(row.id, row);
      const key = workflowRunGroupKey(row);
      if (!key) continue;
      const members = index.workflowRows.get(key);
      if (members) members.push(row);
      else index.workflowRows.set(key, [row]);
    }
    snapshotIndexes.set(allRows, index);
  }
  return index;
}
function snapshotRow(allRows: HarnessSessionRow[] | undefined, rawId: string): HarnessSessionRow | null {
  if (!allRows) return getHarnessSession(rawId);
  return snapshotIndex(allRows).rows.get(rawId) ?? getHarnessSession(rawId);
}

function snapshotConversation(allRows: HarnessSessionRow[] | undefined, rawId: string): ReturnType<typeof readAcceptedSourceConversationProjection> {
  if (!allRows) return readAcceptedSourceConversationProjection(rawId);
  const index = snapshotIndex(allRows);
  if (index.conversations.has(rawId)) return index.conversations.get(rawId)!;
  const conversation = measureProjectionRead(index.observer, 'catalog_lineage',
    () => readAcceptedSourceConversationProjection(rawId, { observer: index.observer, rows: (id) => index.rows.get(id) }));
  if (conversation) {
    // The reader verified every member's principal and exact selector binding.
    // Reuse that proof for summary/search/preview, never for source admission.
    for (const id of conversation.sessionIds) index.conversations.set(id, conversation);
  } else index.conversations.set(rawId, null);
  return conversation;
}

function fillWorkflowRunStatus(
  summary: UnifiedRunSummary,
  readStatus: ReturnType<typeof createWorkflowRunStatusReader>,
  allRows?: HarnessSessionRow[],
): void {
  if (!summary.runSteps) return;
  const row = snapshotRow(allRows, summary.id.slice(HARNESS_PREFIX.length));
  const runId = row ? workflowRunIdFor(row) : '';
  const projection = readStatus(runId);
  summary.status = projection.status;
  summary.runCoverage = projection.runCoverage;
}

function relatedHarnessRowsForPatch(row: HarnessSessionRow): HarnessSessionRow[] {
  const workflowRunId = workflowRunIdFor(row);
  if (workflowRunId) return listHarnessRowsForWorkflowRun(workflowRunId, row);
  const conversation = readAcceptedSourceConversationProjection(row.id);
  return conversation
    ? conversation.sessionIds.map((id) => getHarnessSession(id)).filter((item): item is HarnessSessionRow => item !== null)
    : [row];
}

function summarizeHarnessConversation(row: HarnessSessionRow, allRows?: HarnessSessionRow[]): UnifiedRunSummary {
  const conversation = snapshotConversation(allRows, row.id);
  if (!conversation) return summarizeHarness(row, undefined, allRows);
  const root = snapshotRow(allRows, conversation.rootSessionId);
  const head = snapshotRow(allRows, conversation.headSessionId);
  if (!root || !head) return summarizeHarness(row, undefined, allRows);
  const summary = summarizeHarness(root, undefined, allRows);
  const execution = summarizeHarness(head, undefined, allRows);
  return { ...summary, status: execution.status, updatedAt: execution.updatedAt,
    running: execution.running, agentId: execution.agentId, agentName: execution.agentName,
    agentIds: execution.agentIds, projectId: execution.projectId, projectName: execution.projectName,
    ...(head.id !== root.id ? { executionSessionId: head.id } : {}) };
}

interface HarnessSummaryCollection {
  /** The single full-table scan this collection already paid for, shared with
   *  the per-row fills below so they never scan again. */
  allRows: HarnessSessionRow[];
  summaries: UnifiedRunSummary[];
  rawIds: Set<string>;
}

function collectHarnessSummaries(observer?: ProjectionReadObserver): HarnessSummaryCollection {
  const allRows = listAllHarnessRowsForDisplay(observer);
  // The observer follows this request's existing snapshot, never a global
  // cache or any continuation/control reader.
  snapshotIndex(allRows, observer);
  const rows = userFacingHarnessRows(allRows);
  const out: UnifiedRunSummary[] = [];
  const rawIds = new Set(rows.map((row) => row.id));
  const workflowRows = new Map<string, HarnessSessionRow[]>();
  const seenWorkflowRuns = new Set<string>();
  const seenConversations = new Set<string>();

  for (const row of rows) {
    const runId = workflowRunGroupKey(row);
    if (!runId) continue;
    const grouped = workflowRows.get(runId);
    if (grouped) grouped.push(row);
    else workflowRows.set(runId, [row]);
  }

  for (const row of rows) {
    const runId = workflowRunGroupKey(row);
    if (runId) {
      // rows are updated_at DESC, so the first one we see per run is the
      // most recent step — keep it as the run's representative row.
      if (seenWorkflowRuns.has(runId)) continue;
      seenWorkflowRuns.add(runId);
      out.push(summarizeWorkflowRun(row, workflowRows.get(runId) ?? [row]));
      continue;
    }
    if (seenConversations.has(row.id)) continue;
    const conversation = snapshotConversation(allRows, row.id);
    if (conversation) {
      for (const id of conversation.sessionIds) seenConversations.add(id);
      out.push(summarizeHarnessConversation(row, allRows));
    } else out.push(summarizeHarness(row, undefined, allRows));
  }
  return { summaries: out, rawIds, allRows };
}

function desktopSearchText(record: SessionRecord): string {
  const tail = publicDesktopTurns(record).slice(-20).map((t) => t.text).join(' ');
  return `${record.title ?? ''} ${tail}`.toLowerCase();
}

/** Search keeps the exact oldest public-event window. Select its keys using
 * sequence-only, per-type prefixes, then redeem only those exact payload rows.
 * The covering index and primary-key seeks avoid a second sparse session scan.
 * Nothing outside the original window is decoded.
 * The prefix statement lives only for this request; detail and control read normally. */
function createCatalogSearchEventReader(): typeof listHarnessEvents {
  let prefixes: Database.Statement<[string, string, number]> | undefined;
  return (sessionId, options = {}) => {
    const limit = options.limit;
    if (!options.types || options.types.length < 2 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 40
      || options.desc || options.sinceSeq !== undefined || options.throughSeq !== undefined || options.sinceAt !== undefined) {
      return listHarnessEvents(sessionId, options);
    }
    const db = openEventLog();
    // Sequence discovery and payload reading share one read snapshot, even if
    // another connection appends, deletes or repairs rows between the queries.
    return db.transaction(() => {
      let sequences: number[];
      try {
        prefixes ??= db.prepare(`SELECT seq FROM events INDEXED BY idx_events_session_type
          WHERE session_id = ? AND type = ? ORDER BY seq ASC LIMIT ?`);
        sequences = [...new Set(options.types!.flatMap((type) =>
          (prefixes!.all(sessionId, type, limit) as Array<{ seq: number }>).map((row) => row.seq)))];
      } catch {
        // If this optional index/read is unavailable, retain the original reader
        // and its result/error behavior rather than admitting an empty history.
        return listHarnessEvents(sessionId, options);
      }
      if (sequences.some((seq) => !Number.isSafeInteger(seq) || seq <= 0)) return listHarnessEvents(sessionId, options);
      if (sequences.length === 0) return [];
      sequences.sort((left, right) => left - right);
      return listHarnessEventsAtSequences(sessionId, sequences.slice(0, limit));
    })();
  };
}

function harnessSearchText(summary: UnifiedSessionSummary, allRows: HarnessSessionRow[], readEvents: typeof listHarnessEvents): string {
  const rawId = summary.id.slice(HARNESS_PREFIX.length);
  const row = snapshotRow(allRows, rawId);
  const tail = (row ? reconstructHarnessDetailTurns(row, 40, allRows, true, readEvents) : reconstructHarnessTranscriptText(rawId, 40, readEvents))
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

function reconstructWorkflowRunTranscript(workflowRunId: string, reference: HarnessSessionRow, perSessionLimit = 1000, allRows?: HarnessSessionRow[], readEvents: typeof listHarnessEvents = listHarnessEvents): UnifiedSessionTurn[] {
  const turns = listHarnessRowsForWorkflowRun(workflowRunId, reference, allRows)
    .flatMap((row) => readEvents(row.id, {
      types: ['user_input_received', 'conversation_completed'],
      limit: perSessionLimit,
    }))
    .map(workflowEventTurn)
    .filter((turn): turn is UnifiedSessionTurn & { seq: number } => turn !== null);
  turns.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.seq - right.seq);
  return turns.map(({ seq: _seq, ...turn }) => turn);
}

function reconstructHarnessDetailTurns(row: HarnessSessionRow, perSessionLimit = 1000, allRows?: HarnessSessionRow[], textOnly = false, readEvents: typeof listHarnessEvents = listHarnessEvents): UnifiedSessionTurn[] {
  const workflowRunId = workflowRunIdFor(row);
  if (workflowRunId) return reconstructWorkflowRunTranscript(workflowRunId, row, perSessionLimit, allRows, readEvents);
  const conversation = snapshotConversation(allRows, row.id);
  const readTranscript = textOnly
    ? (id: string, limit: number) => reconstructHarnessTranscriptText(id, limit, readEvents)
    : reconstructHarnessTranscript;
  return conversation
    ? conversation.sessionIds.flatMap((id) => readTranscript(id, perSessionLimit))
    : readTranscript(row.id, perSessionLimit);
}

interface HarnessPreviewScalars { preview: string; turnCount: number }
const harnessPreviewCaches = new WeakMap<Database.Database, Map<string, HarnessPreviewScalars>>();
const HARNESS_PREVIEW_CACHE_LIMIT = 512;
const previewCacheStats = { hits: 0, misses: 0 };

/** The rows one public text projection is built from: a workflow run's member
 * rows, a conversation's verified lineage, or the row alone. Null when the
 * snapshot does not hold every member, so nothing is cached on a partial set. */
function previewMembers(row: HarnessSessionRow, allRows: HarnessSessionRow[]): HarnessSessionRow[] | null {
  const workflowRunId = workflowRunIdFor(row);
  if (workflowRunId) {
    const members = listHarnessRowsForWorkflowRun(workflowRunId, row, allRows);
    return members.some((member) => member.id === row.id) ? members : [row, ...members];
  }
  const conversation = snapshotConversation(allRows, row.id);
  if (!conversation) return [row];
  const index = snapshotIndex(allRows);
  const members: HarnessSessionRow[] = [];
  for (const id of conversation.sessionIds) {
    const member = index.rows.get(id);
    if (!member) return null;
    members.push(member);
  }
  return members;
}

/** What a preview depends on, per member: the row's updated_at and the
 * session's event count and last seq. An append, a retention delete or a
 * row update changes a mark; writes to other sessions do not. The schema
 * version covers migrations. A store-wide data_version here invalidated every
 * preview on every write anywhere, so each 10-s sidebar poll rebuilt 200
 * transcripts while Clem was working (1.6 s on the daemon loop per poll). */
function previewChangeMarks(db: Database.Database, members: readonly HarnessSessionRow[]): string | null {
  try {
    if (!db.open || db.inTransaction) return null;
    const schema = db.pragma('schema_version', { simple: true });
    if (!Number.isSafeInteger(schema)) return null;
    const read = db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS seq FROM events WHERE session_id = ?');
    const marks = members.map((member) => {
      const row = read.get(member.id) as { n?: unknown; seq?: unknown } | undefined;
      return [member.id, member.updatedAt, row?.n ?? null, row?.seq ?? null];
    });
    return JSON.stringify([schema, marks]);
  } catch { return null; }
}

function previewReuse(row: HarnessSessionRow, allRows?: HarnessSessionRow[]): {
  cache: Map<string, HarnessPreviewScalars>; key: string;
} | null {
  if (!allRows) return null;
  const members = previewMembers(row, allRows);
  if (!members) return null;
  const db = openEventLog();
  const marks = previewChangeMarks(db, members);
  if (marks === null) return null;
  const key = JSON.stringify([row.id, 'public-text', 1000, marks]);
  if (key.length > 16_384) return null;
  let cache = harnessPreviewCaches.get(db);
  if (!cache) {
    cache = new Map();
    harnessPreviewCaches.set(db, cache);
  }
  return { cache, key };
}

function fillHarnessPreviewAndCount(summary: UnifiedSessionSummary, allRows?: HarnessSessionRow[]): void {
  const rawId = summary.id.slice(HARNESS_PREFIX.length);
  const row = snapshotRow(allRows, rawId);
  if (!row) {
    summary.preview = clip(harnessPreview(rawId), 140);
    return;
  }
  const reuse = previewReuse(row, allRows);
  const cached = reuse?.cache.get(reuse.key);
  if (reuse && cached) {
    previewCacheStats.hits++;
    reuse.cache.delete(reuse.key);
    reuse.cache.set(reuse.key, cached);
    summary.turnCount = cached.turnCount;
    summary.preview = cached.preview;
    return;
  }
  previewCacheStats.misses++;
  // Keep the original projector outside cache/counter error handling.
  const turns = reconstructHarnessDetailTurns(row, 1000, allRows, true);
  summary.turnCount = turns.length;
  summary.preview = clip(turns[turns.length - 1]?.text ?? '', 140);
  if (reuse) {
    reuse.cache.delete(reuse.key);
    reuse.cache.set(reuse.key, { preview: summary.preview, turnCount: summary.turnCount });
    if (reuse.cache.size > HARNESS_PREVIEW_CACHE_LIMIT) reuse.cache.delete(reuse.cache.keys().next().value!);
  }
}

/** Test seam: hit/miss counts of the per-conversation preview cache. */
export function _previewCacheStatsForTests(): { hits: number; misses: number } {
  return { ...previewCacheStats };
}

function canonicalHarnessRowForRawId(rawId: string): HarnessSessionRow | null {
  const row = getHarnessSession(rawId);
  return row && isUserFacingSession(row.id, row.channel ?? undefined) ? row : null;
}

function detailForHarnessRow(row: HarnessSessionRow): SessionDetail {
  const runId = workflowRunIdFor(row);
  const summary: UnifiedRunSummary = runId
    ? summarizeWorkflowRun(row, listHarnessRowsForWorkflowRun(runId, row))
    : summarizeHarnessConversation(row);
  fillWorkflowRunStatus(summary, createWorkflowRunStatusReader());
  const turns = reconstructHarnessDetailTurns(row);
  const executionSessionId = summary.executionSessionId ?? row.id;
  // Selector-proven conversation ancestry only. A card keeps its own session
  // even when the next accepted message moved the conversation's head.
  const approvalConversation = readAcceptedSourceConversationProjection(row.id);
  const approvalSessions = approvalConversation?.headSessionId === executionSessionId
    ? approvalConversation.sessionIds : [executionSessionId];
  for (const ownerSessionId of approvalSessions) appendPendingApprovalTurns(ownerSessionId, turns);
  // Only a continuable chat can own an inline plan decision. Workflow,
  // execution, and agent transcripts are intentionally read-only; attaching
  // an Approve card there would paint a gate whose handlers are no-ops.
  if (row.kind === 'chat') appendPendingPlanProposalTurns(executionSessionId, turns);
  summary.turnCount = turns.length;
  summary.preview = clip(turns[turns.length - 1]?.text ?? '', 140);
  return { session: summary, turns, continueHint: continueHintFor(summary, executionSessionId) };
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
 * still pending. A formal card whose lifetime ran out unanswered stays too,
 * marked expired: otherwise the chat ended on Clem's question with no sign of
 * what became of it. Recent bound results remain discoverable without reopening
 * a decision; their substantive reply stays in the conversation.
 */
function appendPendingApprovalTurns(sessionId: string, turns: UnifiedSessionTurn[]): void {
  try {
    // A verified decision-only receipt belongs on its original card on reopen,
    // just as it did live. Old results and unrelated resolved cards retain
    // their existing history until they carry this exact receipt.
    const receipts = new Map<string, 'approved' | 'declined'>();
    for (const turn of turns) {
      const ack = turn.terminal?.approvalDecisionAck as Record<string, unknown> | undefined;
      if (ack?.version === 1 && typeof ack.approvalId === 'string'
        && (ack.decision === 'approve' || ack.decision === 'reject')) {
        receipts.set(ack.approvalId, ack.decision === 'approve' ? 'approved' : 'declined');
      }
    }
    const cardEvents = listHarnessEvents(sessionId, { types: ['approval_requested'] });
    if (cardEvents.length === 0) return;
    const seen = new Set<string>();
    // Reopening history must not read every old action/terminal. Recent linked
    // results get a cheap typed record view; richer text is one exact-card GET.
    const recentResultCards = new Set(cardEvents.slice(-12).map(event => event.id));
    for (const ev of cardEvents) {
      const d = ev.data as Record<string, unknown>;
      const approvalId = typeof d.approvalId === 'string' ? d.approvalId : '';
      if (!approvalId || seen.has(approvalId)) continue;
      seen.add(approvalId);
      const rowNow = approvalRegistry.get(approvalId);
      if (!rowNow) continue;
      if (rowNow.sessionId !== sessionId || ev.sessionId !== sessionId) continue;
      const expiredUnanswered = rowNow.status === 'expired' && rowNow.resolution === 'expired';
      const decided = rowNow.status === 'resolved' ? receipts.get(approvalId) : undefined;
      const exactResult = rowNow.status !== 'pending' && recentResultCards.has(ev.id)
        ? readApprovalCardResultSnapshot({ approvalId, sessionId }) : null;
      const result = exactResult?.ok && ['executing', 'executed', 'failed'].includes(exactResult.value.pendingAction.status)
        ? exactResult.value.pendingAction : null;
      if (rowNow.status !== 'pending' && !expiredUnanswered && !decided && !result) continue;
      if (turns.some(turn => turn.approval?.approvalId === approvalId)) continue;
      if (!approvalRegistry.isFormalApprovalSurface(rowNow)) {
        if (rowNow.status !== 'pending') continue;
        turns.push({
          role: 'assistant',
          text: rowNow.presentation?.question ?? '',
          createdAt: ev.createdAt,
        });
        continue;
      }
      const actionView = pendingActionApprovalViewFromArgs(rowNow.args ?? null);
      const sameResult = result && actionView && actionView.id === result.id && actionView.approvalId === result.approvalId
        && actionView.payloadHash === result.payloadHash && actionView.updatedAt === result.updatedAt
        && actionView.status === result.status && actionView.resultSummary === result.resultSummary;
      // A racing result never attaches to the prior card snapshot. Keep the
      // existing paused turn too: an executing action may not have a B reply.
      if (result && !sameResult) continue;
      // Only replace the paused question once its card view can be attached.
      const paused = turns.findIndex((turn) => turn.role === 'assistant' && turn.pausedOnApprovalId === approvalId && !turn.approval);
      if (paused >= 0) turns.splice(paused, 1);
      const closedResolution = rowNow.status === 'cancelled' ? 'cancelled' as const
        : rowNow.resolution === 'approved' ? 'approved' as const
          : rowNow.resolution === 'rejected' ? 'declined' as const
            : rowNow.status === 'expired' ? 'expired' as const : undefined;
      turns.push({
        role: 'assistant',
        text: '',
        createdAt: ev.createdAt,
        approval: {
          ownerSessionId: sessionId,
          subject: typeof d.subject === 'string' && d.subject ? d.subject : String(d.tool ?? 'this action'),
          reason: typeof d.reason === 'string' ? d.reason : undefined,
          approvalId,
          // Hydrated fresh from the registry row (card events are slim, ids
          // only) — also picks up the CURRENT pending-action state rather
          // than a snapshot from park time.
          pendingAction: sameResult ? { ...actionView, ...result } : actionView,
          // What approving would do, as the live card showed it.
          ...(approvalPreviewProjection(d.preview) ?? {}),
          // The change in words this card carries (owner's words, fields as
          // they were), so the reopened chat draws it as the live one did.
          ...(approvalRevisionProjection(d.revises) ?? {}),
          ...(expiredUnanswered ? { resolution: 'expired' as const } : {}),
          ...(decided ? { resolution: decided } : result && closedResolution ? { resolution: closedResolution } : {}),
        },
      });
    }
  } catch { /* history remains renderable without the card */ }
}

// ─── Public API ──────────────────────────────────────────────────────────

/** Conversations one saved agent answered in, newest first. */
export function listSessionsForAgent(agentId: string, limit = 20): UnifiedRunSummary[] {
  return buildUnifiedSessionList({ agent: agentId, limit });
}

const logger = pino({ name: 'clementine.sessions-api' });

/** A list build this slow holds the daemon long enough to be felt (the
 * sidebar polls every 10 s; live 2026-10-19 holds ran 1-3 s with no
 * breakdown). It names its phases, at most once a minute. */
let slowSessionList = { thresholdMs: 750, minIntervalMs: 60_000, lastAt: 0,
  sink: (record: Record<string, unknown>) => { logger.warn(record, 'session list build was slow'); } };

export function buildUnifiedSessionList(query: SessionListQuery = {}, diagnostics: { observer?: ProjectionReadObserver } = {}): UnifiedRunSummary[] {
  if (diagnostics.observer) {
    return measureProjectionRead(diagnostics.observer, 'catalog_build', () => buildUnifiedSessionListObserved(query, diagnostics.observer),
      (rows) => rows.length);
  }
  const phases = new Map<ProjectionReadPhase, { ms: number; calls: number }>();
  const observe: ProjectionReadObserver = (phase, observation) => {
    const total = phases.get(phase) ?? { ms: 0, calls: 0 };
    total.ms += observation.durationMs;
    total.calls++;
    phases.set(phase, total);
  };
  const started = performance.now();
  const rows = buildUnifiedSessionListObserved(query, observe);
  const ms = performance.now() - started;
  const now = Date.now();
  if (ms >= slowSessionList.thresholdMs && now - slowSessionList.lastAt >= slowSessionList.minIntervalMs) {
    slowSessionList.lastAt = now;
    try {
      slowSessionList.sink({ ms: Math.round(ms), limit: query.limit ?? null, rows: rows.length,
        phases: Object.fromEntries([...phases].map(([phase, total]) => [phase, { ms: Math.round(total.ms), calls: total.calls }])) });
    } catch { /* diagnostics never change the list */ }
  }
  return rows;
}

/** Test seam: force the slow-build report and capture it. */
export function _setSlowSessionListReportForTests(input: { thresholdMs: number; sink: (record: Record<string, unknown>) => void } | null): void {
  slowSessionList = input
    ? { thresholdMs: input.thresholdMs, minIntervalMs: 0, lastAt: 0, sink: input.sink }
    : { thresholdMs: 750, minIntervalMs: 60_000, lastAt: 0,
        sink: (record) => { logger.warn(record, 'session list build was slow'); } };
}

function buildUnifiedSessionListObserved(query: SessionListQuery, observer?: ProjectionReadObserver): UnifiedRunSummary[] {
  const store = new SessionStore();
  const q = query.q?.trim().toLowerCase() ?? '';
  const tag = query.tag?.trim() ?? '';
  const source = query.source?.trim() ?? '';
  const agent = query.agent?.trim() ?? '';
  const includeArchived = Boolean(query.includeArchived);
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
  const harnessCollection = measureProjectionRead(observer, 'catalog_collect', () => collectHarnessSummaries(observer));
  const harness = harnessCollection.summaries;
  const harnessRawIds = harnessCollection.rawIds;

  // Desktop side — also keep the matching records for cheap search/preview.
  const desktopRecords = new Map<string, SessionRecord>();
  const desktop: UnifiedRunSummary[] = [];
  for (const record of measureProjectionRead(observer, 'catalog_desktop', () => store.listAll(), (rows) => rows.length)) {
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
  // Every conversation the agent answered in, including ones since switched
  // to another agent or back to Clem.
  if (agent) all = all.filter((s) => s.agentId === agent || Boolean(s.agentIds?.includes(agent)));
  if (tag) all = all.filter((s) => s.tags.includes(tag));
  if (q) {
    const readSearchEvents = createCatalogSearchEventReader();
    all = measureProjectionRead(observer, 'catalog_search', () => all.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      if (s.store === 'desktop') {
        const rec = desktopRecords.get(s.id.slice(DESKTOP_PREFIX.length));
        if (rec && desktopSearchText(rec).includes(q)) return true;
      } else if (harnessSearchText(s, harnessCollection.allRows, readSearchEvents).includes(q)) {
        return true;
      }
      return false;
    }), (rows) => rows.length);
  }

  // Pinned first, then most-recently-updated.
  measureProjectionRead(observer, 'catalog_sort', () => all.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  }), (rows) => rows.length);

  const page = all.slice(0, limit);
  const readRunStatus = createWorkflowRunStatusReader(undefined, { observer });

  // Fill previews/turnCounts only for the returned page (bounds query cost).
  for (const summary of page) {
    if (summary.store === 'desktop') {
      measureProjectionRead(observer, 'catalog_preview', () => {
        const rec = desktopRecords.get(summary.id.slice(DESKTOP_PREFIX.length));
        const publicTurns = rec ? publicDesktopTurns(rec) : [];
        const last = publicTurns[publicTurns.length - 1];
        summary.preview = last ? clip(last.text, 140) : '';
      });
    } else {
      if (summary.runSteps) measureProjectionRead(observer, 'catalog_status',
        () => fillWorkflowRunStatus(summary, readRunStatus, harnessCollection.allRows));
      else fillWorkflowRunStatus(summary, readRunStatus, harnessCollection.allRows);
      measureProjectionRead(observer, 'catalog_preview',
        () => fillHarnessPreviewAndCount(summary, harnessCollection.allRows));
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
  const summary: UnifiedRunSummary = workflowRunId
    ? summarizeWorkflowRun(next, listHarnessRowsForWorkflowRun(workflowRunId, next))
    : summarizeHarnessConversation(next);
  fillWorkflowRunStatus(summary, createWorkflowRunStatusReader());
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
    const deleted = db.transaction(() => withSessionProofCascade(db, () =>
      db.prepare(`DELETE FROM sessions WHERE id IN (${related.map(() => '?').join(', ')})`)
        .run(...related.map(target => target.id)).changes,
    )).immediate();
    return { ok: deleted === related.length, mode: 'deleted', authorityPayloadsDeleted: true };
  }
  for (const target of related) {
    archiveAuthorityPayloadsForSession(target.id);
    updateHarnessSession(target.id, { metadata: { ...target.metadata, archived: true } });
  }
  return { ok: true, mode: 'archived' };
}
