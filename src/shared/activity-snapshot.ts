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
 * "Running now" is NOT decided here. It comes from the server activity
 * projection, which derives membership from durable leases and settled
 * terminals. The old rule — active session plus an event inside a 60-second
 * window — could not tell a 90-second provider call from a dead run, so it is
 * gone rather than kept alongside a second opinion.
 */
import { listPending as listPendingHarnessApprovals } from '../runtime/harness/approval-registry.js';
import { listOperationalEvents } from '../runtime/operational-telemetry.js';
import { listBackgroundTasks } from '../execution/background-tasks.js';
import {
  projectActivitySnapshot,
  shouldSurfaceInWorkingNow,
  type ActivityEntry,
} from '../dashboard/activity-projection.js';
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

/**
 * Friendly kind label for a running row, from the projection's own vocabulary:
 * queued work says queued, detached work says task, and a chat turn says where
 * it is being held.
 */
function runningKindLabel(entry: ActivityEntry): string {
  if (entry.lifecycle === 'queued') return 'queued';
  if (entry.kind === 'fanout') return 'plan';
  if (entry.kind === 'background') return 'task';
  const origin = (entry.origin ?? '').toLowerCase();
  if (origin.startsWith('discord')) return 'discord';
  if (origin.startsWith('slack')) return 'slack';
  if (origin === 'workflow') return 'workflow';
  return origin || 'session';
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

  // ── What the daemon is running, from the ONE durable projection ──
  // Every surface that shows "running now" — the notch, Slack App Home,
  // Discord status — reads this list, and the list is the server projection's
  // Working Now gate: detached and scheduled work always, a foreground chat
  // turn only once it has run long enough to be work the user may have walked
  // away from. Membership is lease truth, never "no event for N seconds".
  // Plans are included because their worker windows are NOT: a window is an
  // internal sub-unit the projection deliberately hides, so without the plan
  // itself these surfaces would go blank while a fan-out ran.
  const activityEntries = safe(
    () => projectActivitySnapshot({
      observedAt: now.toISOString(),
      kinds: ['chat', 'background', 'fanout'],
    }).entries,
    [] as ActivityEntry[],
  );
  const runningNow: RunningNowItem[] = [];
  for (const entry of activityEntries) {
    if (!shouldSurfaceInWorkingNow(entry, nowMs)) continue;
    const sessionId = entry.sessionId || undefined;
    runningNow.push({
      kind: runningKindLabel(entry),
      id: entry.planId ?? entry.taskId ?? sessionId ?? entry.runKey,
      title: entry.headline,
      sessionId,
      startedAt: entry.startedAt,
      elapsedMs: elapsedFrom(entry.startedAt, nowMs),
      // A plan's fan-out is its journal's, not a telemetry fold over its origin
      // session: settled items are the honest count, and the origin session's
      // worker events belong to whatever else that chat is doing.
      workers: entry.kind === 'fanout'
        ? (entry.progress
          ? { active: Math.max(0, entry.progress.total - entry.progress.completed), queued: 0 }
          : undefined)
        : workersFor(sessionId),
      // Blocked on a person is the projection's call, from the approval
      // registry and the run's own lifecycle — not a telemetry window.
      needsApproval: entry.lifecycle === 'awaiting_approval' || undefined,
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
