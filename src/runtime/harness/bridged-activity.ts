/**
 * Bridged delegated activity — which events from a background task or a
 * host-dispatched workflow step may mirror onto the ORIGIN chat session's
 * live stream, and how a stream decides that a foreign session bridges to
 * the one it is serving.
 *
 * One source of truth for every user-facing transport (desktop console SSE,
 * mobile stream). The rules:
 *  - Strictly the "work is happening" shapes: tools, fan-out counters,
 *    workers, steps, heartbeats, external writes, gate verdicts. Never
 *    stream_token (would append to the origin bubble's text) and never
 *    turn-lifecycle types (conversation_completed, awaiting_user_input,
 *    approval_requested) — those belong to the session that owns the turn,
 *    and clients treat them as terminal frames.
 *  - Tool events bridge only when they are the canonical top-level dispatch,
 *    not a transport mirror (double-count hazard).
 */
import type { EventType, EventRow as HarnessEventRow, SessionRow as HarnessSessionRow } from './eventlog.js';
import { listEvents as listHarnessEvents, listSessions as listHarnessSessions } from './eventlog.js';
import { isCanonicalTopLevelToolEvent } from './tool-effect.js';
import { getBackgroundTask } from '../../execution/background-tasks.js';
import { readWorkflowRunOriginSessionIds } from '../../tools/workflow-run-queue.js';

export const BRIDGED_BACKGROUND_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'tool_called', 'tool_returned',
  'worker_started', 'worker_result', 'worker_capped',
  'batch_started', 'batch_progress', 'batch_completed',
  'step_started', 'heartbeat',
  'external_write', 'external_write_succeeded', 'external_write_failed', 'external_write_orphaned',
  'verdict_recorded',
  // Typed capability grounding — the origin chat should see what the
  // promoted run resolved as proven / shaky / disconnected going in.
  'capability_resolution',
  // Host work-plan card — origin chat should see research complete vs sheet
  // blocked even when the run was promoted to the background.
  'expected_work_progress',
  // Files landing in a promoted run belong in the origin chat's live feed —
  // the drafting-emails scenario is exactly the work users background.
  'deliverable_saved',
]);

const BRIDGED_BACKGROUND_ACTIVITY_TYPE_LIST =
  [...BRIDGED_BACKGROUND_ACTIVITY_TYPES] as EventType[];

/**
 * Host-dispatched workflows run under `workflow:<runId>:<step>`, not
 * `background:<taskId>`. First colon-separated segment after the prefix is
 * the run id (run ids never contain `:`).
 */
export function workflowRunIdFromSession(eventSessionId: string): string | null {
  if (!eventSessionId.startsWith('workflow:')) return null;
  const rest = eventSessionId.slice('workflow:'.length);
  if (!rest) return null;
  const colon = rest.indexOf(':');
  const runId = colon === -1 ? rest : rest.slice(0, colon);
  return runId || null;
}

export function isCanonicalBridgedActivity(event: HarnessEventRow | { type: string }): boolean {
  if (!BRIDGED_BACKGROUND_ACTIVITY_TYPES.has(event.type)) return false;
  if ((event.type === 'tool_called' || event.type === 'tool_returned')
    && !isCanonicalTopLevelToolEvent(event as HarnessEventRow)) return false;
  return true;
}

/**
 * A live-stream predicate: does an event emitted under `eventSessionId`
 * bridge onto the stream serving `originSessionId`? Callers cache per
 * connection — construct one instance per stream.
 */
export function createBridgePredicate(originSessionId: string): (eventSessionId: string) => boolean {
  const backgroundOriginCache = new Map<string, string | null>();
  const workflowOriginCache = new Map<string, string[]>();
  return (eventSessionId: string): boolean => {
    if (eventSessionId.startsWith('background:')) {
      let origin = backgroundOriginCache.get(eventSessionId);
      if (origin === undefined) {
        try {
          origin = getBackgroundTask(eventSessionId.slice('background:'.length))?.originSessionId ?? null;
        } catch { origin = null; }
        backgroundOriginCache.set(eventSessionId, origin);
      }
      return origin === originSessionId;
    }
    const runId = workflowRunIdFromSession(eventSessionId);
    if (!runId) return false;
    let origins = workflowOriginCache.get(runId);
    if (origins === undefined) {
      try {
        origins = readWorkflowRunOriginSessionIds(runId);
      } catch { origins = []; }
      // Cache successful reads, including empty (cron / no chat origin).
      // Origins are written before the first step session emits.
      workflowOriginCache.set(runId, origins);
    }
    return origins.includes(originSessionId);
  };
}

/**
 * Replay-side counterpart: events from workflow runs this chat dispatched,
 * merged into the origin session's replay so a reconnect mid-run seeds the
 * live activity strip instead of waiting for the next tool frame.
 */
export function collectBridgedWorkflowReplay(
  originSessionId: string,
  originEvents: HarnessEventRow[],
): HarnessEventRow[] {
  const runIds = new Set<string>();
  for (const ev of originEvents) {
    if (ev.type !== 'async_work_dispatched') continue;
    const ids = (ev.data as { runIds?: unknown } | undefined)?.runIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string' && id.trim()) runIds.add(id.trim());
    }
  }
  if (runIds.size === 0) return [];
  let workflowSessions: HarnessSessionRow[] = [];
  try {
    workflowSessions = listHarnessSessions({ kind: 'workflow', status: 'any', limit: 500 });
  } catch {
    return [];
  }
  const out: HarnessEventRow[] = [];
  for (const runId of runIds) {
    let origins: string[];
    try {
      origins = readWorkflowRunOriginSessionIds(runId);
    } catch {
      continue;
    }
    if (!origins.includes(originSessionId)) continue;
    const prefix = `workflow:${runId}`;
    for (const session of workflowSessions) {
      if (session.id !== prefix && !session.id.startsWith(`${prefix}:`)) continue;
      try {
        for (const ev of listHarnessEvents(session.id, {
          types: BRIDGED_BACKGROUND_ACTIVITY_TYPE_LIST,
          limit: 200,
        })) {
          if (isCanonicalBridgedActivity(ev)) out.push(ev);
        }
      } catch { /* a missing step session is not a stream failure */ }
    }
  }
  return out;
}
