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
  badges: { fallover: number; retries: number; gateVerdicts: number; autoContinues: number };
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
    badges: { fallover: 0, retries: 0, gateVerdicts: 0, autoContinues: 0 },
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
    case 'worker_spawned':
      lane.workers.active += 1;
      break;
    case 'worker_queued':
      lane.workers.queued += 1;
      break;
    case 'worker_completed':
      lane.workers.done += 1;
      lane.workers.active = Math.max(0, lane.workers.active - 1);
      lane.workers.queued = Math.max(0, lane.workers.queued - 1);
      break;
    case 'worker_failed':
    case 'worker_capped':
      lane.workers.failed += 1;
      lane.workers.active = Math.max(0, lane.workers.active - 1);
      lane.workers.queued = Math.max(0, lane.workers.queued - 1);
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
