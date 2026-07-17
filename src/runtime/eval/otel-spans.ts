/**
 * otel-spans — map the harness event log to OpenTelemetry GenAI spans
 * (Lane A Phase 4, eval-as-harness). EXPORT-ON-READ: no new store, no hot-path
 * touch — a pure function over events the loop already records, so any failure
 * resolves to an exact causal span an external backend (Phoenix / Langfuse /
 * Braintrust) can consume in one standard schema.
 *
 * Mapping (OTel GenAI semantic conventions, gen_ai.*):
 *   tool_called + tool_returned (paired by callId) → an `execute_tool` CLIENT
 *     span (gen_ai.tool.name / .call.id; ERROR status if the result reads as a
 *     gate block / failure).
 *   turn_started + turn_ended (paired by turn) → an `invoke_agent` INTERNAL span.
 *   guardrail_tripped → an `INTERNAL` span with ERROR status carrying the gate
 *     kind (so a blocked write is one glance in the trace).
 *   run_failed → an ERROR span.
 */
import { listEvents, type EventRow } from '../harness/eventlog.js';
import {
  pairTransportMirrorToolCalls,
  projectCanonicalTopLevelToolEvents,
} from '../harness/tool-effect.js';

export interface GenAiSpan {
  name: string;
  kind: 'CLIENT' | 'INTERNAL';
  startTime: string;
  endTime?: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: 'ERROR' | 'OK'; message?: string };
}

// Prose failure cues + the UPPER_SNAKE gate markers (EXECUTION_WRAP_REQUIRED,
// CONFIRM_FIRST_REQUIRED, GROUNDING_CHECK_FAILED, *_BLOCKED). The snake markers
// need `_marker\b` (not `\b_marker`) — `_` is a word char, so there is no word
// boundary before it inside FOO_REQUIRED.
const FAILURE_RE = /\b(error|failed|fail|refused|blocked|denied|cannot|unable|could ?not|not found|timed? ?out|exception)\b|_(required|blocked|failed|denied)\b/i;

function str(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v); }

/** Pure: map a session's events to gen_ai spans. Deterministic — feed it the
 *  event list, get back spans in start order. */
export function toGenAiSpans(events: EventRow[]): GenAiSpan[] {
  const spans: GenAiSpan[] = [];

  // execute_tool spans — one logical provider call, enriched with either/both
  // its provider return and inner MCP transport return. This two-pass merge is
  // deliberate: a sparse canonical return can arrive before or after a richer
  // failed mirror return, but both must produce one canonical ERROR span.
  const pairs = pairTransportMirrorToolCalls(events);
  const returnsByCallId = new Map<string, EventRow[]>();
  for (const event of events) {
    if (event.type !== 'tool_returned') continue;
    const callId = str(event.data.callId);
    if (!callId) continue;
    const bucket = returnsByCallId.get(callId) ?? [];
    bucket.push(event);
    returnsByCallId.set(callId, bucket);
  }
  const canonicalCalls = projectCanonicalTopLevelToolEvents(events, 'tool_called');
  const canonicalCallIds = new Set<string>();
  const appendToolSpan = (callId: string, called: EventRow | undefined, completions: EventRow[]): void => {
    if (completions.length === 0) return;
    const sortedCompletions = [...completions].sort((a, b) => a.seq - b.seq);
    const failedCompletion = sortedCompletions.find((event) => {
      const text = str(event.data.result || event.data.error || event.data.preview);
      return event.data.ok === false || FAILURE_RE.test(text);
    });
    const evidenceEvent = failedCompletion
      ?? sortedCompletions.find((event) => str(event.data.result || event.data.error || event.data.preview))
      ?? sortedCompletions.at(-1)!;
    const result = str(evidenceEvent.data.result || evidenceEvent.data.error || evidenceEvent.data.preview);
    const tool = str(called?.data.tool)
      || str(evidenceEvent.data.tool)
      || 'unknown';
    spans.push({
      name: `execute_tool ${tool}`,
      kind: 'CLIENT',
      startTime: (called ?? sortedCompletions[0]).createdAt,
      endTime: sortedCompletions.at(-1)!.createdAt,
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': tool,
        'gen_ai.tool.call.id': callId || 'unknown',
        'gen_ai.system': 'clementine',
      },
      ...(failedCompletion ? { status: { code: 'ERROR' as const, message: result.slice(0, 160) } } : {}),
    });
  };

  for (const called of canonicalCalls) {
    const callId = str(called.data.callId) || called.id;
    canonicalCallIds.add(callId);
    const mirrorCallId = pairs.canonicalToMirrorCallId.get(callId);
    appendToolSpan(callId, called, [
      ...(returnsByCallId.get(callId) ?? []),
      ...(mirrorCallId ? returnsByCallId.get(mirrorCallId) ?? [] : []),
    ]);
  }

  // Preserve historical return-only spans for legacy/native rows. Explicit MCP
  // mirrors never enter this fallback; paired canonical calls were handled above.
  for (const returned of projectCanonicalTopLevelToolEvents(events, 'tool_returned')) {
    const callId = str(returned.data.callId);
    if (callId && canonicalCallIds.has(callId)) continue;
    appendToolSpan(callId || 'unknown', undefined, [returned]);
  }

  // invoke_agent spans — pair turn_started → turn_ended by turn number.
  const pendingTurn = new Map<number, EventRow>();
  for (const e of events) {
    if (e.type === 'turn_started') pendingTurn.set(e.turn, e);
    else if (e.type === 'turn_ended') {
      const start = pendingTurn.get(e.turn);
      pendingTurn.delete(e.turn);
      spans.push({
        name: `invoke_agent turn:${e.turn}`,
        kind: 'INTERNAL',
        startTime: (start ?? e).createdAt,
        endTime: e.createdAt,
        attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.system': 'clementine', 'clem.turn': e.turn },
      });
    }
  }

  // guardrail / run_failed → ERROR spans (a blocked write or failure is one glance).
  for (const e of events) {
    if (e.type === 'guardrail_tripped') {
      const kind = str(e.data.kind) || 'guardrail';
      spans.push({
        name: `guardrail ${kind}`,
        kind: 'INTERNAL',
        startTime: e.createdAt,
        endTime: e.createdAt,
        attributes: { 'gen_ai.operation.name': 'guardrail', 'clem.guardrail.kind': kind, 'gen_ai.tool.name': str(e.data.toolName) },
        status: { code: 'ERROR', message: kind },
      });
    } else if (e.type === 'run_failed') {
      spans.push({
        name: 'run_failed',
        kind: 'INTERNAL',
        startTime: e.createdAt,
        endTime: e.createdAt,
        attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.system': 'clementine' },
        status: { code: 'ERROR', message: (str(e.data.error) || str(e.data.reason)).slice(0, 160) },
      });
    }
  }

  return spans.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** Read a session's events and map to gen_ai spans (export-on-read). */
export function sessionToGenAiSpans(sessionId: string): GenAiSpan[] {
  return toGenAiSpans(listEvents(sessionId));
}
