/**
 * Deterministic, LLM-free "what's running" summary for the chat channels.
 *
 * The desktop console has GET /api/console/board (console-routes.ts), which
 * aggregates every kind of background work into one Kanban. Channel users
 * (Slack / Discord) have no equivalent — between kicking a task off and the
 * terminal report-back they are blind. This module gives them the same picture
 * on demand: a strict "status" command intercepted BEFORE the brain runs,
 * answered from the exact same stores the board reads.
 *
 * `buildBoardSummary()` fetches the five board sources (background tasks · run
 * records · executions · in-flight workflow runs · pending approvals), and
 * `assembleBoardSummary()` folds them into normalized columns using the same
 * status→column mapping as the board route. `formatBoardSummaryText()` renders
 * a compact, channel-friendly markdown block. Everything is timezone-safe
 * (relative ages only) and global (no user-specific pinning — it mirrors the
 * board, which is unfiltered by owner).
 */

import { listBackgroundTasks, type BackgroundTaskRecord } from '../execution/background-tasks.js';
import { listRuns, type RunRecord } from '../runtime/run-events.js';
import { ExecutionStore } from '../execution/store.js';
import { listPendingRuns, type PendingRun } from '../execution/workflow-events.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { listWorkflows } from '../memory/workflow-store.js';
import type { ExecutionRecord } from '../types.js';

// ── Status-command matcher ─────────────────────────────────────────────────
// ONE shared matcher so both harnesses use the identical trigger set (no
// duplicated regexes). Strict, exact-match only: a false positive that eats a
// real message is worse than a miss, so anything longer or different flows
// through to the brain unchanged.
const STATUS_INTENTS = new Set<string>([
  'status',
  'status?',
  "what's running",
  'whats running',
  "what's running?",
  'whats running?',
]);

/**
 * True when the whole message is a bare status-intent phrase. Case-insensitive,
 * whitespace-trimmed, and curly-apostrophe tolerant (chat clients love to turn
 * `'` into `’`), but otherwise an exact match against the fixed intent set.
 */
export function isStatusCommand(raw: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase().replace(/[‘’]/g, "'");
  return STATUS_INTENTS.has(normalized);
}

// ── Summary model ──────────────────────────────────────────────────────────
export type BoardSummaryColumn = 'running' | 'needs_you' | 'queued' | 'done';

export interface BoardSummaryItem {
  sourceKind: 'background' | 'run' | 'execution' | 'workflow' | 'approval';
  title: string;
  column: BoardSummaryColumn;
  /** Raw source status, for the "needs you" reason label. */
  status: string;
  ageMs: number;
  updatedAt: string;
  /** Number of tools invoked so far (run records only). */
  toolCount?: number;
}

export interface BoardSummary {
  running: BoardSummaryItem[];
  needsYou: BoardSummaryItem[];
  queued: BoardSummaryItem[];
  /** Terminal items completed since local midnight, freshest first. */
  doneToday: BoardSummaryItem[];
  /** Freshest terminal item regardless of the today window — used for the
   *  "Last completed: …" line when nothing is in flight. */
  lastCompleted?: BoardSummaryItem;
  generatedAt: string;
}

/** Pre-fetched board sources — the seam that keeps assembly pure and testable. */
export interface BoardSummarySources {
  backgroundTasks: BackgroundTaskRecord[];
  runs: RunRecord[];
  executions: ExecutionRecord[];
  pendingWorkflowRuns: PendingRun[];
  approvals: approvalRegistry.PendingApprovalRow[];
  /** Slug → display name for workflow cards (falls back to the slug). */
  workflowDisplayName?: (slug: string) => string | undefined;
}

function cleanTitle(input: string | undefined, fallback: string): string {
  const t = (input ?? '').replace(/\s+/g, ' ').trim();
  return t || fallback;
}

function ageMsFrom(iso: string | undefined, now: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

/**
 * Fold pre-fetched sources into board columns. Mirrors the status→column
 * mapping in GET /api/console/board so the channel summary and the desktop
 * board never disagree. Pure and synchronous — `buildBoardSummary` supplies the
 * live data, tests supply fakes.
 */
export function assembleBoardSummary(sources: BoardSummarySources, now: number = Date.now()): BoardSummary {
  const running: BoardSummaryItem[] = [];
  const needsYou: BoardSummaryItem[] = [];
  const queued: BoardSummaryItem[] = [];
  const terminal: BoardSummaryItem[] = [];
  // Approvals already represented by a task/run's pendingApprovalId are the
  // SAME approval — don't list them twice (mirrors the board's dedup).
  const coveredApprovalIds = new Set<string>();

  const place = (item: BoardSummaryItem): void => {
    if (item.column === 'running') running.push(item);
    else if (item.column === 'needs_you') needsYou.push(item);
    else if (item.column === 'queued') queued.push(item);
    else terminal.push(item);
  };

  // 1) Background tasks. Archived tasks drop off the board, so skip them here.
  for (const task of sources.backgroundTasks) {
    if (task.archived) continue;
    if (task.pendingApprovalId) coveredApprovalIds.add(task.pendingApprovalId);
    const column: BoardSummaryColumn =
      task.status === 'pending' ? 'queued'
        : task.status === 'running' || task.status === 'cancelling' ? 'running'
          : task.status === 'awaiting_approval' || task.status === 'awaiting_continue' || task.status === 'blocked' ? 'needs_you'
            : 'done';
    place({
      sourceKind: 'background',
      title: cleanTitle(task.title, 'Background task'),
      column,
      status: task.status,
      ageMs: ageMsFrom(task.updatedAt, now),
      updatedAt: task.updatedAt,
    });
  }

  // 2) Run records — chat/Discord/Slack/CLI/gateway/workflow runs. Drop the
  //    background task's own run record so the same work isn't double-listed.
  for (const run of sources.runs) {
    if (run.id.startsWith('run-bg-')) continue;
    if (run.pendingApprovalId) coveredApprovalIds.add(run.pendingApprovalId);
    const needsAttention = run.needsAttention === true;
    const column: BoardSummaryColumn =
      needsAttention ? 'needs_you'
        : run.status === 'queued' || run.status === 'received' ? 'queued'
          : run.status === 'running' ? 'running'
            : run.status === 'awaiting_approval' ? 'needs_you'
              : 'done';
    const toolCount = run.events.reduce((n, ev) => (ev.type === 'tool_started' ? n + 1 : n), 0);
    place({
      sourceKind: 'run',
      title: cleanTitle(run.title, 'Run'),
      column,
      status: needsAttention ? 'needs_attention' : run.status,
      ageMs: ageMsFrom(run.updatedAt, now),
      updatedAt: run.updatedAt,
      toolCount: toolCount > 0 ? toolCount : undefined,
    });
  }

  // 3) Executions — long-running, controller-driven goals.
  for (const exec of sources.executions) {
    const column: BoardSummaryColumn =
      exec.status === 'active' ? 'running'
        : exec.status === 'paused' || exec.status === 'blocked' ? 'needs_you'
          : 'done';
    place({
      sourceKind: 'execution',
      title: cleanTitle(exec.title, 'Execution'),
      column,
      status: exec.status,
      ageMs: ageMsFrom(exec.updatedAt, now),
      updatedAt: exec.updatedAt,
    });
  }

  // 4) In-flight workflow runs (terminal ones surface via their run record in 2).
  for (const pending of sources.pendingWorkflowRuns) {
    const display = sources.workflowDisplayName?.(pending.workflowName);
    const updatedAt = pending.lastEventAt ?? new Date(now).toISOString();
    place({
      sourceKind: 'workflow',
      title: cleanTitle(display ?? pending.workflowName, 'Workflow run'),
      column: pending.inFlightStepId ? 'running' : 'queued',
      status: pending.inFlightStepId ? `step: ${pending.inFlightStepId}` : 'queued',
      ageMs: ageMsFrom(updatedAt, now),
      updatedAt,
    });
  }

  // 5) Standalone approvals not already carried by a task/run.
  for (const row of sources.approvals) {
    if (coveredApprovalIds.has(row.approvalId)) continue;
    coveredApprovalIds.add(row.approvalId);
    place({
      sourceKind: 'approval',
      title: cleanTitle(row.subject, 'Approval required'),
      column: 'needs_you',
      status: 'awaiting_approval',
      ageMs: ageMsFrom(row.requestedAt, now),
      updatedAt: row.requestedAt,
    });
  }

  const byFreshness = (a: BoardSummaryItem, b: BoardSummaryItem): number => a.ageMs - b.ageMs;
  running.sort(byFreshness);
  needsYou.sort(byFreshness);
  queued.sort(byFreshness);
  terminal.sort(byFreshness);

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  const doneToday = terminal.filter((item) => {
    const t = Date.parse(item.updatedAt);
    return Number.isFinite(t) && t >= startOfTodayMs;
  });

  return {
    running,
    needsYou,
    queued,
    doneToday,
    lastCompleted: terminal[0],
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Gather the five board sources from their live stores and assemble the
 * summary. Fail-safe per source: a broken store degrades that section to empty
 * rather than throwing, so the status command still answers.
 */
export function buildBoardSummary(opts: { now?: number } = {}): BoardSummary {
  const now = opts.now ?? Date.now();
  const safe = <T>(fn: () => T[]): T[] => {
    try { return fn(); } catch { return []; }
  };
  let workflowDisplayName: ((slug: string) => string | undefined) | undefined;
  try {
    const bySlug = new Map(listWorkflows().map((entry) => [entry.name, entry.data.name]));
    workflowDisplayName = (slug: string) => bySlug.get(slug);
  } catch {
    workflowDisplayName = undefined;
  }
  return assembleBoardSummary({
    backgroundTasks: safe(() => listBackgroundTasks()),
    runs: safe(() => listRuns(80)),
    executions: safe(() => new ExecutionStore().list(80)),
    pendingWorkflowRuns: safe(() => listPendingRuns()),
    approvals: safe(() => approvalRegistry.listPending({ status: 'pending' })),
    workflowDisplayName,
  }, now);
}

// ── Formatting ─────────────────────────────────────────────────────────────
const SECTION_CAP = 5;
const TITLE_MAX = 52;

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return '<1m';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function shortTitle(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function needsYouReason(status: string): string {
  switch (status) {
    case 'awaiting_approval': return 'awaiting approval';
    case 'awaiting_continue': return 'awaiting continue';
    case 'needs_attention': return 'needs review';
    case 'blocked': return 'blocked';
    case 'paused': return 'paused';
    default: return 'needs you';
  }
}

function runningItemText(item: BoardSummaryItem): string {
  const meta = [formatAge(item.ageMs)];
  if (item.toolCount && item.toolCount > 0) meta.push(`${item.toolCount} tools`);
  return `${shortTitle(item.title)} — ${meta.join(', ')}`;
}

/** Join up to SECTION_CAP rendered items with " · " and a "+N more" tail. */
function joinCapped(items: string[]): string {
  if (items.length <= SECTION_CAP) return items.join(' · ');
  return `${items.slice(0, SECTION_CAP).join(' · ')} (+${items.length - SECTION_CAP} more)`;
}

/**
 * Render a BoardSummary as a compact channel message. Returns the friendly
 * empty state when nothing is in flight.
 */
export function formatBoardSummaryText(summary: BoardSummary): string {
  const lines: string[] = [];

  if (summary.running.length > 0) {
    lines.push(`🏃 Running (${summary.running.length}): ${joinCapped(summary.running.map(runningItemText))}`);
  }
  if (summary.needsYou.length > 0) {
    lines.push(`⏸️ Needs you (${summary.needsYou.length}): ${joinCapped(
      summary.needsYou.map((item) => `${shortTitle(item.title)} — ${needsYouReason(item.status)}`),
    )}`);
  }
  if (summary.queued.length > 0) {
    lines.push(`⏳ Queued (${summary.queued.length}): ${joinCapped(summary.queued.map((item) => shortTitle(item.title)))}`);
  }

  const nothingLive = lines.length === 0;
  if (nothingLive) {
    if (summary.lastCompleted) {
      return `Nothing running right now. Last completed: ${shortTitle(summary.lastCompleted.title)} (${formatAge(summary.lastCompleted.ageMs)} ago).`;
    }
    return 'Nothing running right now.';
  }

  if (summary.doneToday.length > 0) {
    lines.push(`✅ Done today (${summary.doneToday.length}): ${joinCapped(summary.doneToday.map((item) => shortTitle(item.title)))}`);
  }

  return lines.join('\n');
}
