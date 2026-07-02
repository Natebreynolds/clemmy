/**
 * Shared "what is happening right now" snapshot.
 *
 * Three surfaces used to compute running/upcoming work independently and drift
 * apart: the dashboard command center (console-routes.ts), the Slack App Home,
 * and Discord's status/presence. This module is the ONE builder they can all
 * consume so "running now", "waiting on you", "upcoming", and "recently done"
 * mean the same thing everywhere (desktop ↔ Slack ↔ Discord parity is a binding
 * product directive).
 *
 * It is deliberately read-only and fail-open: every data source is wrapped so a
 * missing store or bad row degrades to an empty section, never a throw. Callers
 * on a live surface must never crash because the snapshot couldn't be built.
 *
 * The mid-turn harness heuristic (isHarnessSessionCurrentlyWorking) lives here
 * so console-routes and the channel surfaces share one definition of "a session
 * the daemon is executing on RIGHT NOW" (status='active' + a fresh non-terminal
 * event), rather than each re-deriving it.
 */
import { listPending as listPendingHarnessApprovals } from '../runtime/harness/approval-registry.js';
import {
  listSessions as listHarnessSessions,
  listEvents as listHarnessEvents,
  type SessionRow as HarnessSessionRow,
  type EventRow as HarnessEventRow,
} from '../runtime/harness/eventlog.js';
import { listOperationalEvents } from '../runtime/operational-telemetry.js';
import { listBackgroundTasks } from '../execution/background-tasks.js';
import { loadCronJobs, loadWorkflows } from '../dashboard/state.js';
import { getNextRun } from './cron.js';
import { listOpenCheckIns } from '../agents/check-ins.js';
import { listGoalDrafts } from '../agents/goal-drafts.js';
import { listPlanProposals, planProposalNeedsUserInput } from '../agents/plan-proposals.js';

/** A single unit of work the daemon is actively running (or has queued). */
export interface RunningNowItem {
  /** Short kind label: 'task' | 'queued' | 'workflow' | 'chat' | 'execution' | 'agent' | 'session'. */
  kind: string;
  /** Stable id for the row (task id or session id). */
  id: string;
  title: string;
  sessionId?: string;
  startedAt?: string;
  elapsedMs?: number;
  /** Live worker fan-out for this session, when any workers were seen recently. */
  workers?: { active: number; queued: number };
  /** True when an approval for this session is still open (e.g. a worker's write). */
  needsApproval?: boolean;
}

export interface UpcomingItem {
  kind: 'cron' | 'workflow';
  name: string;
  nextRunAt: string;
}

export interface RecentDoneItem {
  title: string;
  finishedAt: string;
  ok: boolean;
}

export interface ActivitySnapshot {
  runningNow: RunningNowItem[];
  needsYou: { count: number };
  upcoming: UpcomingItem[];
  recentDone: RecentDoneItem[];
  counts: {
    running: number;
    needsYou: number;
    upcoming: number;
    recentDone: number;
    doneToday: number;
    failed: number;
  };
}

/** Only sessions the daemon is genuinely mid-turn on count as "working now". */
const HARNESS_TERMINAL_EVENT_TYPES: ReadonlySet<HarnessEventRow['type']> = new Set<HarnessEventRow['type']>([
  'conversation_completed',
  'run_completed',
  'run_failed',
  'approval_requested',
  'awaiting_user_input',
]);

export function isHarnessTerminalEvent(type: HarnessEventRow['type']): boolean {
  return HARNESS_TERMINAL_EVENT_TYPES.has(type);
}

/**
 * True when the daemon is executing a turn on this session RIGHT NOW. Chat
 * sessions stay status='active' BETWEEN turns (active = open + addressable, not
 * necessarily executing), so "active" alone over-reports. Heuristic: active AND
 * last event within `activeWindowCutoff` AND that last event is not terminal.
 *
 * Moved here from console-routes so every surface shares one definition.
 */
export function isHarnessSessionCurrentlyWorking(session: HarnessSessionRow, activeWindowCutoff: number): boolean {
  if (session.status !== 'active') return false;
  const updatedMs = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedMs) || updatedMs < activeWindowCutoff) return false;
  const latest = listHarnessEvents(session.id, { limit: 1, desc: true })[0];
  if (!latest) return false;
  return !isHarnessTerminalEvent(latest.type);
}

/** The active window for "mid-turn" — covers an LLM turn plus a slow tool call. */
const ACTIVE_WINDOW_MS = 60_000;
/** How far back to scan operational events for live worker / approval counts. */
const WORKER_WINDOW_MS = 10 * 60_000;
/** "Recent failures" window for the needs-attention count (mirrors Slack's 14d). */
const FAILED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

interface SessionActivity {
  workersActive: number;
  workersQueued: number;
  approvalsOpen: number;
}

/**
 * Live per-session worker fan-out + open approvals, folded from the last
 * ~10 minutes of operational events (a cheap indexed read, grouped by session).
 * active = spawned − completed − failed − capped, clamped ≥ 0.
 */
function computeSessionActivity(sinceIso: string): Map<string, SessionActivity> {
  const map = new Map<string, SessionActivity>();
  const bump = (sessionId: string | undefined, patch: Partial<SessionActivity>): void => {
    if (!sessionId) return;
    const cur = map.get(sessionId) ?? { workersActive: 0, workersQueued: 0, approvalsOpen: 0 };
    map.set(sessionId, {
      workersActive: cur.workersActive + (patch.workersActive ?? 0),
      workersQueued: cur.workersQueued + (patch.workersQueued ?? 0),
      approvalsOpen: cur.approvalsOpen + (patch.approvalsOpen ?? 0),
    });
  };
  try {
    // Fold OLDEST-first: the counter model (queued → spawn dequeues → complete
    // decrements) is order-dependent and the store returns newest-first.
    for (const ev of [...listOperationalEvents({ source: 'harness', since: sinceIso, limit: 1000 })].reverse()) {
      switch (ev.type) {
        // Spawn dequeues one waiter IF any is waiting (emit order: queued →
        // slot frees → spawned; a spawn that never queued must not go negative);
        // capped workers ALSO emit worker_failed via their worker_result, so
        // capped must not decrement a second time (review finding).
        case 'worker_spawned': {
          const hadWaiter = (map.get(ev.sessionId ?? '')?.workersQueued ?? 0) > 0;
          bump(ev.sessionId, { workersActive: 1, ...(hadWaiter ? { workersQueued: -1 } : {}) });
          break;
        }
        case 'worker_queued': bump(ev.sessionId, { workersQueued: 1 }); break;
        case 'worker_completed':
        case 'worker_failed': bump(ev.sessionId, { workersActive: -1 }); break;
        case 'worker_capped': break;
        default: break;
      }
    }
  } catch { /* observability read is best-effort */ }
  try {
    for (const ev of [...listOperationalEvents({ source: 'safety', since: sinceIso, limit: 1000 })].reverse()) {
      if (ev.type === 'approval_required') bump(ev.sessionId, { approvalsOpen: 1 });
      else if (ev.type === 'approval_resolved') bump(ev.sessionId, { approvalsOpen: -1 });
    }
  } catch { /* best-effort */ }
  // Clamp negatives that arise when a completion's spawn fell outside the window.
  for (const [id, a] of map) {
    map.set(id, {
      workersActive: Math.max(0, a.workersActive),
      workersQueued: Math.max(0, a.workersQueued),
      approvalsOpen: Math.max(0, a.approvalsOpen),
    });
  }
  return map;
}

/** Friendly kind label for a harness session row. */
function harnessKindLabel(session: HarnessSessionRow): string {
  if (session.channel === 'discord' || session.channel === 'discord-dm' || session.metadata?.source === 'discord') return 'discord';
  if (session.kind === 'workflow' || session.channel === 'workflow' || session.metadata?.source === 'workflow') return 'workflow';
  return session.kind || 'session';
}

function elapsedFrom(startedAt: string | undefined, nowMs: number): number | undefined {
  if (!startedAt) return undefined;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, nowMs - t);
}

/**
 * Build the shared activity snapshot. `now` is injectable for deterministic tests.
 */
export function buildActivitySnapshot(now: Date = new Date()): ActivitySnapshot {
  const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const nowMs = now.getTime();
  const sinceIso = new Date(nowMs - WORKER_WINDOW_MS).toISOString();

  const activity = safe(() => computeSessionActivity(sinceIso), new Map<string, SessionActivity>());
  const workersFor = (sessionId: string | undefined): { active: number; queued: number } | undefined => {
    if (!sessionId) return undefined;
    const a = activity.get(sessionId);
    if (!a || (a.workersActive === 0 && a.workersQueued === 0)) return undefined;
    return { active: a.workersActive, queued: a.workersQueued };
  };
  const approvalOpenFor = (sessionId: string | undefined): boolean =>
    !!sessionId && (activity.get(sessionId)?.approvalsOpen ?? 0) > 0;

  // ── Running background tasks (genuinely active + queued-to-start) ──
  const bgRunning = safe(() => listBackgroundTasks({ status: 'running' }), []);
  const bgPending = safe(() => listBackgroundTasks({ status: 'pending' }), []);
  const runningNow: RunningNowItem[] = [];
  const seenRunSessionIds = new Set<string>();
  for (const task of [...bgRunning, ...bgPending]) {
    if (task.runSessionId) seenRunSessionIds.add(task.runSessionId);
    const startedAt = task.startedAt ?? task.createdAt;
    runningNow.push({
      kind: task.status === 'pending' ? 'queued' : 'task',
      id: task.id,
      title: task.title || 'Task',
      sessionId: task.runSessionId || undefined,
      startedAt,
      elapsedMs: elapsedFrom(startedAt, nowMs),
      workers: workersFor(task.runSessionId),
      needsApproval: approvalOpenFor(task.runSessionId) || undefined,
    });
  }

  // ── Mid-turn harness sessions the daemon is executing right now ──
  const activeWindowCutoff = nowMs - ACTIVE_WINDOW_MS;
  const harnessSessions = safe(
    () => listHarnessSessions({ limit: 60 }).filter((s) => isHarnessSessionCurrentlyWorking(s, activeWindowCutoff)),
    [] as HarnessSessionRow[],
  );
  for (const session of harnessSessions) {
    // A background task's own run session is already represented above.
    if (seenRunSessionIds.has(session.id)) continue;
    runningNow.push({
      kind: harnessKindLabel(session),
      id: session.id,
      title: session.title || session.objective || 'Clementine run',
      sessionId: session.id,
      startedAt: session.createdAt,
      elapsedMs: elapsedFrom(session.createdAt, nowMs),
      workers: workersFor(session.id),
      needsApproval: approvalOpenFor(session.id) || undefined,
    });
  }

  // ── Upcoming scheduled runs (cron jobs + scheduled workflows), soonest first ──
  const upcoming = safe<UpcomingItem[]>(() => {
    const items: Array<UpcomingItem & { at: number }> = [];
    const add = (kind: 'cron' | 'workflow', name: string, schedule: string | undefined, enabled: boolean): void => {
      if (!enabled || !schedule) return;
      const iso = getNextRun(schedule);
      if (!iso) return;
      items.push({ kind, name, nextRunAt: iso, at: Date.parse(iso) });
    };
    for (const j of safe(() => loadCronJobs(), [])) add('cron', j.name, j.schedule, j.enabled !== false);
    for (const w of safe(() => loadWorkflows(), [])) add('workflow', w.name, w.trigger?.schedule, w.enabled !== false);
    return items.sort((a, b) => a.at - b.at).map(({ at: _at, ...rest }) => rest);
  }, []);

  // ── Recently completed / failed (so a surface can tell the full story) ──
  const finishedAtOf = (t: { completedAt?: string; updatedAt?: string }): string => t.completedAt ?? t.updatedAt ?? '';
  const byFinishedDesc = (a: { completedAt?: string; updatedAt?: string }, b: { completedAt?: string; updatedAt?: string }) =>
    finishedAtOf(b).localeCompare(finishedAtOf(a));
  const doneAll = safe(() => listBackgroundTasks({ status: 'done' }), []).sort(byFinishedDesc);
  const failedRecent = [
    ...safe(() => listBackgroundTasks({ status: 'failed' }), []),
    ...safe(() => listBackgroundTasks({ status: 'aborted' }), []),
    ...safe(() => listBackgroundTasks({ status: 'interrupted' }), []),
  ].filter((t) => {
    const ts = Date.parse(finishedAtOf(t));
    return !Number.isFinite(ts) || ts >= nowMs - FAILED_WINDOW_MS;
  }).sort(byFinishedDesc);
  const recentDone: RecentDoneItem[] = [
    ...doneAll.map((t) => ({ title: t.title || 'Task', finishedAt: finishedAtOf(t), ok: true })),
    ...failedRecent.map((t) => ({ title: t.title || 'Task', finishedAt: finishedAtOf(t), ok: false })),
  ].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 5);

  const today = now.toISOString().slice(0, 10);
  const doneToday = doneAll.filter((t) => finishedAtOf(t).slice(0, 10) === today).length;

  // ── "Waiting on you": the consolidated set genuinely blocked on the user.
  // Kept in lockstep with the Slack App Home formula so every surface agrees.
  const needsYouCount = safe(() => listPendingHarnessApprovals().length, 0)
    + safe(() => listOpenCheckIns().length, 0)
    + safe(() => listGoalDrafts({ status: 'pending' }).length, 0)
    + safe(() => listPlanProposals({ status: 'all' }).filter(planProposalNeedsUserInput).length, 0)
    + safe(() => listBackgroundTasks({ status: 'blocked' }).length, 0)
    + safe(() => listBackgroundTasks({ status: 'awaiting_input' }).length, 0)
    + safe(() => listBackgroundTasks({ status: 'awaiting_continue' }).length, 0);

  return {
    runningNow,
    needsYou: { count: needsYouCount },
    upcoming,
    recentDone,
    counts: {
      running: runningNow.length,
      needsYou: needsYouCount,
      upcoming: upcoming.length,
      recentDone: recentDone.length,
      doneToday,
      failed: failedRecent.length,
    },
  };
}

/** Compact human elapsed, e.g. "12m", "3h", "2d". Small shared formatter so the
 *  channel surfaces render running-time the same way. */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return '<1m';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/** Compact "next run" phrasing, e.g. "in 5m", "in 3h". */
export function formatNextRun(nextRunAt: string, now: Date = new Date()): string {
  const ms = Date.parse(nextRunAt) - now.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'soon';
  const min = Math.round(ms / 60000);
  if (min < 60) return `in ${Math.max(1, min)}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}
