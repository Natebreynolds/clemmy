/**
 * The server-side activity projector (Clem 4 Stage 9).
 *
 * `surface-projection.ts` holds the pure truth contract; this module is the
 * ONE server projector over durable stores that every surface reads: workflow
 * runs, detached background tasks, and live chat attempts, all reduced to the
 * same `SurfaceRunSnapshot` shape. The console endpoint serves it and the
 * Slack/Discord message lane projects its own chat entry through
 * `projectChatAttemptActivity`, so a transport cannot narrate a phase the
 * server does not assert.
 *
 * Privacy discipline is inherited, not re-decided: the same rule that keeps
 * step outputs, prompts, and inputs out of the runs-list projection keeps
 * them out of snapshots. Headlines and details are built from status
 * vocabulary and already-public fields only.
 *
 * Two rules carry most of the product weight here:
 *
 *   - LIVENESS COMES FROM LEASES. "No event for N seconds" is not evidence of
 *     death; a 90-second provider call under a held lease is live, and a lost
 *     or expired lease is stale however recently the row was touched.
 *   - A TERMINAL IS COPIED, NEVER INFERRED. Only a settled durable status
 *     becomes a terminal, and a non-successful one can never be dressed as
 *     success by any field this module emits.
 *
 * Snapshots only, for now: this endpoint has no delta stream, so each response
 * is a fresh snapshot whose revision is derived from durable evidence (event
 * seq, record timestamps) rather than a per-process counter — a daemon restart
 * must not rewind a surface's revision.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  projectRunSnapshot,
  SURFACE_PROJECTION_SCHEMA_VERSION,
  type SurfaceActivityLabel,
  type SurfaceLifecycle,
  type SurfaceRunSnapshot,
  type SurfaceTerminal,
} from '../runtime/graph/surface-projection.js';
import {
  getLatestEventSeq,
  listLatestRunAttemptsForSessions,
  listSessions as listHarnessSessions,
  type RunAttemptRecord,
  type SessionRow,
} from '../runtime/harness/eventlog.js';
import { listBackgroundTasks, type BackgroundTaskRecord } from '../execution/background-tasks.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';

interface RawRunRecordLike {
  id?: unknown;
  workflow?: unknown;
  status?: unknown;
  createdAt?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  source?: unknown;
  error?: unknown;
  capabilityBlock?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Status vocabulary → lifecycle. Unknown statuses map to 'accepted' — an
 *  honest "we know it exists" — never to running or completed. */
const LIFECYCLES: Record<string, SurfaceLifecycle> = {
  queued: 'queued',
  pending: 'queued',
  running: 'reasoning',
  finalizing: 'completing',
  blocked_capability: 'blocked',
  awaiting_approval: 'awaiting_approval',
  parked: 'awaiting_approval',
  completed: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
};

const TERMINALS: Record<string, SurfaceTerminal['status']> = {
  completed: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
};

/**
 * Project one durable workflow-run record into the shared snapshot shape.
 * Returns null for records too malformed to identify — a projection never
 * invents identity.
 */
export function projectWorkflowRunActivity(
  raw: RawRunRecordLike,
  observedAt: string,
): ActivityEntry | null {
  const id = text(raw.id);
  const workflow = text(raw.workflow);
  if (!id || !workflow) return null;
  const status = text(raw.status) ?? 'unknown';
  const lifecycle = LIFECYCLES[status] ?? 'accepted';

  const terminalStatus = TERMINALS[status];
  const terminal: SurfaceTerminal | undefined = terminalStatus
    ? {
        status: terminalStatus,
        kind: status,
        // Bounded, already-public vocabulary only — the run's OUTPUT is
        // deliberately absent, same as the runs-list projection.
        text: text(raw.error)?.slice(0, 500)
          ?? (terminalStatus === 'completed' ? 'Run completed.' : `Run ${status}.`),
        resumable: false,
      }
    : undefined;

  const block = raw.capabilityBlock && typeof raw.capabilityBlock === 'object'
    ? raw.capabilityBlock as { message?: unknown; toolkit?: unknown }
    : undefined;

  const lastEvidenceAt = text(raw.finishedAt) ?? text(raw.startedAt) ?? text(raw.createdAt) ?? observedAt;
  const snapshot = projectRunSnapshot({
    runKey: `workflow:${id}`,
    attemptId: id,
    presentationLane: text(raw.source) === 'cron' ? 'scheduled' : 'detached',
    lifecycle,
    headline: workflow,
    ...(lifecycle === 'blocked' && block
      ? { detail: text(block.message)?.slice(0, 300) ?? `Connect ${text(block.toolkit) ?? 'the required account'} to resume.` }
      : {}),
    startedAt: text(raw.startedAt) ?? text(raw.createdAt) ?? observedAt,
    // Durable-evidence time only: the record's own timestamps, never poll time.
    lastEvidenceAt,
    connectivity: 'connected',
    observedAt,
    revision: revisionFromEvidence(lastEvidenceAt),
    ...(terminal ? { typedTerminal: terminal } : {}),
  });
  return asEntry(snapshot, 'workflow', { runId: id });
}

// ── the unified projection ───────────────────────────────────────────────────

export type ActivityKind = 'chat' | 'background' | 'workflow';

/**
 * One row of the unified projection: the shared snapshot plus the identity a
 * surface needs to act on it (open the session, cancel the task) and the one
 * derived flag every surface was computing for itself.
 */
export interface ActivityEntry extends SurfaceRunSnapshot {
  kind: ActivityKind;
  /** A human is the blocker, or the owner stopped proving it is alive. */
  needsAttention: boolean;
  sessionId?: string;
  taskId?: string;
  runId?: string;
}

export interface ActivitySnapshot {
  schemaVersion: number;
  observedAt: string;
  entries: ActivityEntry[];
}

/** Lifecycles where the run cannot proceed without a person. */
const ATTENTION_LIFECYCLES: ReadonlySet<SurfaceLifecycle> = new Set<SurfaceLifecycle>([
  'blocked', 'awaiting_approval', 'awaiting_input', 'paused_budget',
]);

/**
 * A revision must be monotonic per ENTRY and must survive a daemon restart, so
 * it is derived from durable evidence rather than a process counter. Records
 * with timestamps use epoch milliseconds; chat entries use the event-log seq,
 * which is exact per session. The scales differ between kinds on purpose —
 * revisions are only ever compared within one runKey.
 */
function revisionFromEvidence(...times: Array<string | null | undefined>): number {
  let newest = 0;
  for (const time of times) {
    const parsed = time ? Date.parse(time) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
  }
  return newest;
}

function asEntry(
  snapshot: SurfaceRunSnapshot,
  kind: ActivityKind,
  identity: { sessionId?: string; taskId?: string; runId?: string } = {},
): ActivityEntry {
  // A person is the blocker when the run is waiting on one, when the owner
  // stopped proving it is alive, or when it settled short of success and can
  // still be picked up. Liveness alone must never read as "fine": a failed run
  // is settled, and `live` on a settled row means nothing about the outcome.
  const needsAttention = ATTENTION_LIFECYCLES.has(snapshot.lifecycle)
    || (snapshot.liveness === 'stale' && !snapshot.terminal)
    || (!!snapshot.terminal && snapshot.terminal.status !== 'completed' && snapshot.terminal.resumable);
  return {
    ...snapshot,
    kind,
    needsAttention,
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.taskId ? { taskId: identity.taskId } : {}),
    ...(identity.runId ? { runId: identity.runId } : {}),
  };
}

/**
 * Lease truth for a durable attempt, or nothing at all.
 *
 * An owner holding an unexpired lease is live no matter how quiet the provider
 * call is; an owner past its expiry, or an expiry with no owner left, is a lost
 * lease and therefore stale. An attempt that never claimed a lease carries no
 * lease truth — the projection says `unknown` rather than guessing in either
 * direction.
 */
function leaseFacts(attempt: RunAttemptRecord): { leaseHeld?: boolean; leaseExpiresAt?: string } {
  if (attempt.finishedAt) return {};
  if (attempt.leaseOwner) {
    return { leaseHeld: true, ...(attempt.leaseExpiresAt ? { leaseExpiresAt: attempt.leaseExpiresAt } : {}) };
  }
  if (attempt.leaseExpiresAt) return { leaseHeld: false, leaseExpiresAt: attempt.leaseExpiresAt };
  return {};
}

/** Settled attempt status → typed terminal. Copied, never inferred, and never
 *  promoted: an interrupted or superseded attempt did not succeed. */
function terminalForAttempt(attempt: RunAttemptRecord): SurfaceTerminal | undefined {
  if (!attempt.finishedAt) return undefined;
  switch (attempt.status) {
    case 'completed':
      return { status: 'completed', kind: 'completed', text: 'Turn completed.', resumable: false };
    case 'failed':
      return { status: 'failed', kind: 'failed', text: 'Turn failed.', resumable: true };
    case 'cancelled':
      return { status: 'cancelled', kind: 'cancelled', text: 'Turn cancelled.', resumable: false };
    case 'interrupted':
      return { status: 'failed', kind: 'interrupted', text: 'Turn interrupted before it settled.', resumable: true };
    case 'superseded':
      return { status: 'cancelled', kind: 'superseded', text: 'Replaced by a newer turn.', resumable: false };
    default:
      return { status: 'failed', kind: attempt.status, text: 'Turn ended without a settled result.', resumable: true };
  }
}

export interface ChatActivityInput {
  sessionId: string;
  headline: string;
  attempt: RunAttemptRecord | null;
  observedAt: string;
  revision: number;
  /**
   * The phase the RUNNING boundary asserts (the channel message lane's display
   * state). Advisory only: once the durable attempt has settled, the settled
   * truth wins and the hint is discarded.
   */
  lifecycleHint?: SurfaceLifecycle;
  activityLabel?: SurfaceActivityLabel;
  /** A public terminal committed by the boundary before the attempt row settles. */
  terminalHint?: SurfaceTerminal;
  presentationLane?: 'foreground' | 'detached' | 'scheduled';
  startedAt?: string;
  lastEvidenceAt?: string;
}

/**
 * Project ONE chat attempt. Both the console snapshot and the Slack/Discord
 * message lane call this, which is what makes the two surfaces agree by
 * construction rather than by convention.
 */
export function projectChatAttemptActivity(input: ChatActivityInput): ActivityEntry {
  const attempt = input.attempt;
  const terminal = (attempt ? terminalForAttempt(attempt) : undefined) ?? input.terminalHint;
  const startedAt = attempt?.startedAt ?? input.startedAt ?? input.observedAt;
  const lastEvidenceAt = attempt?.finishedAt ?? input.lastEvidenceAt ?? startedAt;
  const snapshot = projectRunSnapshot({
    runKey: `chat:${input.sessionId}`,
    attemptId: attempt?.attemptId ?? input.sessionId,
    presentationLane: input.presentationLane ?? 'foreground',
    lifecycle: input.lifecycleHint ?? 'reasoning',
    headline: input.headline,
    startedAt,
    lastEvidenceAt,
    connectivity: 'connected',
    observedAt: input.observedAt,
    revision: input.revision,
    ...(attempt ? leaseFacts(attempt) : {}),
    ...(input.activityLabel ? { activityLabel: input.activityLabel } : {}),
    ...(terminal ? { typedTerminal: terminal } : {}),
  });
  return asEntry(snapshot, 'chat', { sessionId: input.sessionId, runId: attempt?.runId ?? undefined });
}

/** Background statuses → lifecycle. Anything unrecognized is 'accepted'. */
const BACKGROUND_LIFECYCLES: Record<string, SurfaceLifecycle> = {
  pending: 'queued',
  running: 'reasoning',
  cancelling: 'completing',
  awaiting_approval: 'awaiting_approval',
  awaiting_input: 'awaiting_input',
  awaiting_continue: 'paused_budget',
  blocked: 'blocked',
  done: 'completed',
  failed: 'failed',
  aborted: 'cancelled',
  interrupted: 'failed',
};

const BACKGROUND_TERMINALS: Record<string, SurfaceTerminal> = {
  done: { status: 'completed', kind: 'done', text: 'Task completed.', resumable: false },
  failed: { status: 'failed', kind: 'failed', text: 'Task failed.', resumable: true },
  aborted: { status: 'cancelled', kind: 'aborted', text: 'Task aborted.', resumable: false },
  interrupted: { status: 'failed', kind: 'interrupted', text: 'Task interrupted before it settled.', resumable: true },
  blocked: { status: 'blocked', kind: 'blocked', text: 'Task stopped and needs you.', resumable: true },
};

export function projectBackgroundTaskActivity(
  task: BackgroundTaskRecord,
  observedAt: string,
): ActivityEntry {
  const lifecycle = BACKGROUND_LIFECYCLES[task.status] ?? 'accepted';
  const terminal = BACKGROUND_TERMINALS[task.status];
  const lastEvidenceAt = task.completedAt ?? task.updatedAt ?? task.createdAt;
  const snapshot = projectRunSnapshot({
    runKey: `background:${task.id}`,
    attemptId: task.id,
    // Detached by definition; a workflow- or cron-originated task is scheduled.
    presentationLane: task.source === 'workflow' || task.source === 'daemon' ? 'scheduled' : 'detached',
    lifecycle,
    headline: task.title,
    ...(task.pendingQuestion && lifecycle === 'awaiting_input'
      ? { detail: task.pendingQuestion.slice(0, 300) }
      : {}),
    startedAt: task.startedAt ?? task.createdAt,
    lastEvidenceAt,
    connectivity: 'connected',
    observedAt,
    revision: revisionFromEvidence(lastEvidenceAt),
    ...(terminal ? { typedTerminal: terminal } : {}),
  });
  return asEntry(snapshot, 'background', { taskId: task.id, sessionId: task.runSessionId });
}

/** Sessions whose work is already projected by the background lane. */
function isBackgroundRunSession(session: SessionRow): boolean {
  return session.id.startsWith('background:');
}

function chatHeadline(session: SessionRow): string {
  return session.title?.trim() || session.objective?.trim() || 'Chat turn';
}

/**
 * The ONE server projection every surface reads: workflow runs, background
 * tasks, and chat attempts in a single revisioned list. Reconstruction is pure
 * with respect to the durable stores — the same stores produce the same entries
 * after a restart, because nothing here is held in process memory.
 */
export function projectActivitySnapshot(
  options: {
    observedAt?: string;
    sessionLimit?: number;
    limit?: number;
    /** Read only these lanes. A caller that needs one kind should not pay for
     *  a full directory scan of the other two on every poll. */
    kinds?: readonly ActivityKind[];
  } = {},
): ActivitySnapshot {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const wants = (kind: ActivityKind): boolean => !options.kinds || options.kinds.includes(kind);
  const entries: ActivityEntry[] = [];

  if (wants('workflow')) try {
    if (fs.existsSync(WORKFLOW_RUNS_DIR)) {
      for (const file of fs.readdirSync(WORKFLOW_RUNS_DIR)) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(
            fs.readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8'),
          ) as RawRunRecordLike;
          const entry = projectWorkflowRunActivity(raw, observedAt);
          if (entry) entries.push(entry);
        } catch { /* a malformed record is skipped, never guessed at */ }
      }
    }
  } catch { /* the runs directory is optional */ }

  if (wants('background')) try {
    for (const task of listBackgroundTasks()) {
      entries.push(projectBackgroundTaskActivity(task, observedAt));
    }
  } catch { /* the task store is optional */ }

  if (wants('chat')) try {
    const sessions = listHarnessSessions({ limit: options.sessionLimit ?? 60 })
      .filter((session) => !isBackgroundRunSession(session));
    const attempts = listLatestRunAttemptsForSessions(sessions.map((session) => session.id));
    for (const session of sessions) {
      const attempt = attempts.get(session.id);
      // A session that never ran an attempt has no activity to project.
      if (!attempt) continue;
      entries.push(projectChatAttemptActivity({
        sessionId: session.id,
        headline: chatHeadline(session),
        attempt,
        observedAt,
        revision: latestSeqFor(session.id),
      }));
    }
  } catch { /* the event log is optional */ }

  // Total order so two reads of the same durable state reconstruct identically.
  entries.sort((left, right) => right.startedAt.localeCompare(left.startedAt)
    || left.runKey.localeCompare(right.runKey));

  return {
    schemaVersion: SURFACE_PROJECTION_SCHEMA_VERSION,
    observedAt,
    entries: entries.slice(0, options.limit ?? 200),
  };
}

function latestSeqFor(sessionId: string): number {
  try {
    return getLatestEventSeq(sessionId);
  } catch {
    return 0;
  }
}

/**
 * How long a foreground chat turn runs before it stops being "just a reply" and
 * becomes work the user may have walked away from. Below this, chat belongs
 * inline in the conversation, not in a panel that implies detached work.
 */
export const WORKING_NOW_FOREGROUND_MS = 90_000;

/**
 * Working Now shows work that outlives the user's attention: detached and
 * scheduled runs always, ordinary foreground chat only once it has run long
 * enough to matter. A settled run is never "working".
 */
export function shouldSurfaceInWorkingNow(entry: ActivityEntry, observedAtMs: number): boolean {
  if (entry.terminal) return false;
  if (entry.presentationLane !== 'foreground') return true;
  const startedMs = Date.parse(entry.startedAt);
  if (!Number.isFinite(startedMs)) return false;
  return observedAtMs - startedMs >= WORKING_NOW_FOREGROUND_MS;
}
