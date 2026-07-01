/**
 * eventlog → operational-telemetry MIRROR.
 *
 * The harness eventlog (harness.db) is the append-only spine of every run; the
 * operational-telemetry store (operational-telemetry.db) is what the dashboard's
 * ObservabilityView and Slack/Discord read for "what is happening right now".
 * Historically those two were disjoint: worker swarms, run lifecycle, judge/gate
 * verdicts, fallovers and auto-continues all landed in the eventlog and were
 * INVISIBLE to the operational store. Rather than sprinkle recordOperationalEvent
 * calls across the hot files (loop.ts / brackets.ts / hooks.ts / the SDK brain),
 * this ONE whitelist mirror runs at the tail of appendEvent — so every mapped
 * eventlog write becomes an operational event with no edits to those files.
 *
 * Design constraints (binding):
 *  - fail-open: mirroring must NEVER throw into (or slow) appendEvent. Everything
 *    is wrapped; a bad payload / unavailable DB is swallowed.
 *  - no double-emit: a small EXCLUDED set drops the high-frequency / already-
 *    covered types (tool_called/returned mirror through the tool-observability
 *    path; stream_token/heartbeat are pure UI noise). Only WHITELISTED types emit.
 *  - cheap: the session row is passed in by appendEvent (it already fetched it for
 *    the actionBus emit), so enrichment costs ZERO extra queries per event.
 *  - kill-switch CLEMMY_EVENTLOG_OPERATIONAL_MIRROR (default ON).
 *
 * Import hygiene: this file imports operational-telemetry at runtime and eventlog
 * for TYPES ONLY (`import type`, erased at compile time), so the eventlog → mirror
 * runtime edge is one-directional — no eventlog ↔ mirror cycle.
 */
import { getRuntimeEnv } from '../../config.js';
import {
  recordOperationalEvent,
  type OperationalEventSeverity,
  type OperationalEventSource,
  type OperationalEventType,
} from '../operational-telemetry.js';
import type { EventRow, EventType, SessionRow } from './eventlog.js';

/** Kill-switch: CLEMMY_EVENTLOG_OPERATIONAL_MIRROR default ON. */
function mirrorEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_EVENTLOG_OPERATIONAL_MIRROR', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * Types we NEVER mirror. tool_called/tool_returned are already surfaced via the
 * tool-observability operational path; stream_token / heartbeat are pure real-time
 * UI frames; memory_signals_captured is covered by the memory operational lane.
 * Keeping this explicit (vs. an allow-list only) documents the deliberate drops.
 */
const EXCLUDED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'tool_called',
  'tool_returned',
  'stream_token',
  'heartbeat',
  'memory_signals_captured',
]);

interface MirrorMapping {
  type: OperationalEventType;
  source: OperationalEventSource;
  severity?: OperationalEventSeverity;
}

/**
 * Whitelist: eventlog EventType → operational event. worker_result branches on
 * its payload (ok) and so is handled in resolveMapping, not here.
 */
const STATIC_MIRROR_MAP: Readonly<Partial<Record<EventType, MirrorMapping>>> = {
  turn_started: { type: 'harness_turn_started', source: 'harness' },
  turn_ended: { type: 'harness_turn_completed', source: 'harness' },
  run_completed: { type: 'harness_run_completed', source: 'harness' },
  conversation_completed: { type: 'harness_run_completed', source: 'harness' },
  run_failed: { type: 'harness_run_failed', source: 'harness', severity: 'error' },
  worker_capped: { type: 'worker_capped', source: 'harness', severity: 'warn' },
  sdk_auto_continue: { type: 'auto_continue', source: 'harness' },
  guardrail_tripped: { type: 'gate_verdict', source: 'safety', severity: 'warn' },
  goal_alignment_judged: { type: 'judge_verdict', source: 'safety' },
  output_grounding_judged: { type: 'judge_verdict', source: 'safety' },
  brain_fallover: { type: 'model_fallover', source: 'model', severity: 'warn' },
  approval_requested: { type: 'approval_required', source: 'safety' },
  approval_resolved: { type: 'approval_resolved', source: 'safety' },
  external_write_orphaned: { type: 'side_effect_orphaned', source: 'safety', severity: 'warn' },
};

/** Resolve the operational mapping for an event, or null when it isn't mirrored. */
function resolveMapping(event: EventRow): MirrorMapping | null {
  if (event.type === 'worker_result') {
    const ok = (event.data as { ok?: unknown } | undefined)?.ok;
    // Treat an explicit ok:false as a failure; anything else (ok:true / missing)
    // is a completion — the ledger's honest coverage map already carries detail.
    return ok === false
      ? { type: 'worker_failed', source: 'harness', severity: 'error' }
      : { type: 'worker_completed', source: 'harness' };
  }
  return STATIC_MIRROR_MAP[event.type] ?? null;
}

const MAX_MIRROR_DATA_BYTES = 4_000;

/**
 * Enrich the mirrored payload with the session's kind/title (so a dashboard lane
 * can label the row without a second lookup) plus the eventlog event's own data,
 * bounded so a pathologically large data blob can't bloat the operational store.
 */
function buildPayload(event: EventRow, session: SessionRow | null | undefined, mapping: MirrorMapping): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    eventType: event.type,
    ...(session?.kind ? { sessionKind: session.kind } : {}),
    ...(session?.title ? { sessionTitle: session.title } : {}),
  };
  // brain_fallover is the workflow-runner's parity twin of the router-lane
  // fallover — tag the stage so the two model_fallover sources are distinguishable.
  if (event.type === 'brain_fallover') payload.stage = 'step_boundary';
  const data = event.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    try {
      const json = JSON.stringify(data);
      if (json.length <= MAX_MIRROR_DATA_BYTES) {
        Object.assign(payload, data);
      } else {
        payload.data = `[omitted: ${json.length} bytes]`;
      }
    } catch {
      /* non-serializable data — skip it, keep the envelope */
    }
  }
  return payload;
}

/** Workflow run id for correlation: the session metadata carries it for workflow
 *  step sessions; otherwise parse the `workflow:<runId>:<stepId>` id shape. */
function workflowRunIdFor(session: SessionRow | null | undefined, sessionId: string): string | undefined {
  const meta = session?.metadata?.workflowRunId;
  if (typeof meta === 'string' && meta) return meta;
  if (sessionId.startsWith('workflow:')) {
    const parts = sessionId.split(':');
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  return undefined;
}

/**
 * Mirror one eventlog write into the operational store. Called from the tail of
 * appendEvent with the session row it already fetched. Fail-open — never throws.
 */
export function mirrorEventToOperational(event: EventRow, session?: SessionRow | null): void {
  try {
    if (!mirrorEnabled()) return;
    if (EXCLUDED_EVENT_TYPES.has(event.type)) return;
    const mapping = resolveMapping(event);
    if (!mapping) return;
    recordOperationalEvent({
      source: mapping.source,
      type: mapping.type,
      severity: mapping.severity ?? 'info',
      sessionId: event.sessionId,
      workflowRunId: workflowRunIdFor(session, event.sessionId),
      actor: 'eventlog-mirror',
      now: event.createdAt ? new Date(event.createdAt) : undefined,
      payload: buildPayload(event, session, mapping),
    });
  } catch {
    // Observability must never break a run — swallow everything.
  }
}
