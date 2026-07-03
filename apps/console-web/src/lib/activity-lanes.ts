/**
 * Activity lanes — pure reducer that folds the operational-telemetry stream into
 * one "lane" per live unit of work (a harness session or a workflow run). The
 * NowStrip subscribes to the SSE telemetry feed and folds each event through
 * here; keeping the logic pure (no React, no I/O) makes it unit-testable and the
 * component a thin renderer.
 *
 * A lane is keyed by sessionId || workflowRunId. Events without either id can't
 * be attributed to a lane and are ignored.
 */
import type { OperationalEvent } from './telemetry';

/** One row per swarm worker in flight, keyed by the packet `item` every worker
 *  telemetry event carries. `done` rows are dropped from the map (their count
 *  lives in the counters); queued/running/failed/capped are retained so the rail
 *  can show a per-worker breakdown of the live fan-out. */
export interface WorkerRow {
  item: string;
  status: 'queued' | 'running' | 'failed' | 'capped';
  model?: string;
  /** When this worker entered its current status (spawn time for `running`). */
  sinceTs: string;
}

export interface ActivityLane {
  key: string;
  kind: string;
  title: string;
  sessionId?: string;
  workflowRunId?: string;
  /** From model_route_decided, when present — may never arrive; tolerate absence. */
  model?: string;
  /** The most recent still-open tool call (started without a matching end). */
  openTool?: { name: string; sinceTs: string };
  /** Internal: open tool calls by toolCallId, from which openTool is derived. */
  openTools: Record<string, { name: string; sinceTs: string }>;
  workers: { active: number; queued: number; done: number; failed: number };
  /** Per-worker rows keyed by packet item (in-flight + failed/capped; done pruned). */
  workerRows: Record<string, WorkerRow>;
  badges: { fallover: number; retries: number; gateVerdicts: number; autoContinues: number; capped: number };
  needsApproval: boolean;
  startedAt?: string;
  lastEventAt: string;
  /** Set once the run reaches a terminal boundary; cleared if the lane resumes. */
  terminal?: 'completed' | 'failed';
}

function firstString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function deriveKind(event: OperationalEvent): string {
  const sessionKind = firstString(event.payload, ['sessionKind']);
  if (sessionKind) return sessionKind;
  if (event.source === 'scheduler') return 'cron';
  if (event.workflowRunId && !event.sessionId) return 'workflow';
  return 'session';
}

function deriveTitle(event: OperationalEvent, key: string): string {
  return firstString(event.payload, ['sessionTitle', 'title', 'name', 'jobName', 'workflowName']) ?? key;
}

function createLane(key: string, event: OperationalEvent): ActivityLane {
  return {
    key,
    kind: deriveKind(event),
    title: deriveTitle(event, key),
    sessionId: event.sessionId,
    workflowRunId: event.workflowRunId,
    openTools: {},
    workers: { active: 0, queued: 0, done: 0, failed: 0 },
    workerRows: {},
    badges: { fallover: 0, retries: 0, gateVerdicts: 0, autoContinues: 0, capped: 0 },
    needsApproval: false,
    startedAt: event.ts,
    lastEventAt: event.ts,
  };
}

function recomputeOpenTool(lane: ActivityLane): void {
  let latest: { name: string; sinceTs: string } | undefined;
  for (const entry of Object.values(lane.openTools)) {
    if (!latest || entry.sinceTs > latest.sinceTs) latest = entry;
  }
  lane.openTool = latest;
}

/** Set (or create) the per-worker row for `item` at `status`. A row's `sinceTs`
 *  advances only when its status changes, so the rail can show "running for N".
 *  No-op when the event carries no item (older/edge payloads) — the counters
 *  still track the swarm, we just can't attribute a row. */
function updateWorkerRow(lane: ActivityLane, event: OperationalEvent, status: WorkerRow['status']): void {
  const item = firstString(event.payload, ['item']);
  if (!item) return;
  const model = firstString(event.payload, ['model']);
  const existing = lane.workerRows[item];
  lane.workerRows[item] = {
    item,
    status,
    model: model ?? existing?.model,
    sinceTs: existing && existing.status === status ? existing.sinceTs : event.ts,
  };
}

/**
 * Fold one operational event into the lane map (mutating + returning it). Events
 * with no session/run correlation are skipped. Idempotency is not guaranteed —
 * the caller feeds an ordered stream (replay then live), each event once.
 */
export function foldOperationalEvent(
  lanes: Map<string, ActivityLane>,
  event: OperationalEvent,
): Map<string, ActivityLane> {
  const key = event.sessionId || event.workflowRunId;
  if (!key) return lanes;

  let lane = lanes.get(key);
  if (!lane) {
    lane = createLane(key, event);
    lanes.set(key, lane);
  }

  // Keep correlation ids + label fresh as later events carry more context.
  if (event.sessionId && !lane.sessionId) lane.sessionId = event.sessionId;
  if (event.workflowRunId && !lane.workflowRunId) lane.workflowRunId = event.workflowRunId;
  const title = firstString(event.payload, ['sessionTitle', 'title', 'name', 'jobName', 'workflowName']);
  if (title && (lane.title === lane.key || !lane.title)) lane.title = title;
  if (event.ts > lane.lastEventAt) lane.lastEventAt = event.ts;
  if (!lane.startedAt || event.ts < lane.startedAt) lane.startedAt = event.ts;

  switch (event.type) {
    case 'model_route_decided': {
      const model = firstString(event.payload, ['model', 'effectiveModel', 'modelId', 'chosenModel', 'route']);
      if (model) lane.model = model;
      break;
    }
    case 'tool_call_started': {
      if (event.toolCallId) {
        const name = firstString(event.payload, ['tool', 'name', 'toolName']) ?? 'tool';
        lane.openTools[event.toolCallId] = { name, sinceTs: event.ts };
        recomputeOpenTool(lane);
      }
      break;
    }
    case 'tool_call_completed':
    case 'tool_call_failed': {
      if (event.toolCallId && lane.openTools[event.toolCallId]) {
        delete lane.openTools[event.toolCallId];
        recomputeOpenTool(lane);
      }
      break;
    }
    // Worker accounting (no per-worker ids in the payload, so this is a counter
    // model): a QUEUED worker leaves the queue when it SPAWNS — the emit order
    // is queued → (slot frees) → spawned. Completions decrement ACTIVE only;
    // decrementing queued there erased genuine waiters when non-queued workers
    // finished first (review finding). worker_capped is a turn-cap signal for
    // a worker whose worker_result (→ worker_failed) also arrives — count the
    // badge, not a second slot decrement.
    case 'worker_spawned':
      lane.workers.active += 1;
      if (lane.workers.queued > 0) lane.workers.queued -= 1;
      updateWorkerRow(lane, event, 'running');
      break;
    case 'worker_queued':
      lane.workers.queued += 1;
      updateWorkerRow(lane, event, 'queued');
      break;
    case 'worker_completed': {
      lane.workers.done += 1;
      lane.workers.active = Math.max(0, lane.workers.active - 1);
      // Done rows leave the live breakdown (their count lives in the counter).
      const doneItem = firstString(event.payload, ['item']);
      if (doneItem) delete lane.workerRows[doneItem];
      break;
    }
    case 'worker_failed':
      lane.workers.failed += 1;
      lane.workers.active = Math.max(0, lane.workers.active - 1);
      updateWorkerRow(lane, event, 'failed');
      break;
    case 'worker_capped':
      lane.badges.capped += 1;
      updateWorkerRow(lane, event, 'capped');
      break;
    case 'model_fallover':
      lane.badges.fallover += 1;
      break;
    case 'workflow_node_retried':
      lane.badges.retries += 1;
      break;
    case 'gate_verdict':
      lane.badges.gateVerdicts += 1;
      break;
    case 'auto_continue':
      lane.badges.autoContinues += 1;
      break;
    case 'approval_required':
      lane.needsApproval = true;
      break;
    case 'approval_resolved':
      lane.needsApproval = false;
      break;
    case 'harness_turn_started':
      // Fresh activity — a resumed lane is no longer terminal.
      lane.terminal = undefined;
      break;
    case 'harness_run_completed':
    case 'cron_job_completed':
    case 'background_task_finished':
      lane.terminal = 'completed';
      break;
    case 'harness_run_failed':
    case 'cron_job_failed':
      lane.terminal = 'failed';
      break;
    default:
      break;
  }

  return lanes;
}

const WORKER_STATUS_ORDER: Record<WorkerRow['status'], number> = {
  running: 0,
  queued: 1,
  failed: 2,
  capped: 3,
};

/** Live worker rows for a lane, ordered running → queued → failed → capped and
 *  within a status oldest-first (longest-running surfaces first). Pure — the
 *  NowStrip renders the head of this list and summarizes the tail as "+N more". */
export function workerRowsForDisplay(lane: ActivityLane): WorkerRow[] {
  return Object.values(lane.workerRows).sort((a, b) => {
    const byStatus = WORKER_STATUS_ORDER[a.status] - WORKER_STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return a.sinceTs.localeCompare(b.sinceTs);
  });
}

/** Lanes sorted running-first: non-terminal before terminal, needs-you first,
 *  then most-recent activity. */
export function lanesToSortedArray(lanes: Map<string, ActivityLane>): ActivityLane[] {
  return [...lanes.values()].sort((a, b) => {
    const at = a.terminal ? 1 : 0;
    const bt = b.terminal ? 1 : 0;
    if (at !== bt) return at - bt;
    if (!a.terminal && !b.terminal) {
      const an = a.needsApproval ? 0 : 1;
      const bn = b.needsApproval ? 0 : 1;
      if (an !== bn) return an - bn;
    }
    return b.lastEventAt.localeCompare(a.lastEventAt);
  });
}
