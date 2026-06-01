import type { Runner } from '@openai/agents';
import { appendEvent, writeToolOutput, type EventRow } from './eventlog.js';
import { scheduleReflection } from '../../memory/reflection.js';
import { autoInvalidateOnFailure } from './auto-invalidate.js';

/**
 * RunHooks → event log writer.
 *
 * This is the single path from the SDK's lifecycle into the harness
 * event log for run-derived events. The Runner inherits from
 * `RunHooks`, which is an EventEmitter exposing five events:
 *
 *   agent_start, agent_end, agent_handoff,
 *   agent_tool_start, agent_tool_end
 *
 * Each becomes one harness event. Tool start/end pair via the SDK's
 * per-call id — the start emits `tool_called` and stores the resulting
 * event id in a map; the matching `tool_returned` then sets
 * `parent_event_id` to that id, so the audit log can be walked as a
 * tree.
 *
 * The harness session id must travel on the `RunContext.context` slot;
 * the existing tool-taxonomy.ts extractor follows the same convention
 * (src/agents/tool-taxonomy.ts:326).
 */

/** Anything Runner-shaped enough to subscribe to. Lets tests pass a stub. */
export interface RunHooksLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface AttachHooksOptions {
  /** Pull the harness session id from the run context. */
  getSessionId: (runContext: unknown) => string | undefined;
  /** Pull the current turn number. Defaults to 0. */
  getTurn?: (runContext: unknown) => number;
  /** Cap on serialized tool result size persisted in the event. */
  maxResultChars?: number;
  /** Cap on agent_end output size persisted in the event. */
  maxOutputChars?: number;
}

interface NamedAgent {
  name?: string;
}

interface NamedTool {
  name?: string;
}

interface ToolCallLike {
  id?: string;
  callId?: string;
  arguments?: string;
}

interface ToolDetails {
  toolCall?: ToolCallLike;
}

/**
 * Default extractor: reads sessionId from `runContext.context.sessionId`.
 * Mirrors src/agents/tool-taxonomy.ts:326-332 so callers can use the
 * same context shape across guardrails, approvals, and event logging.
 */
export function extractSessionIdFromContext(runContext: unknown): string | undefined {
  if (!runContext || typeof runContext !== 'object') return undefined;
  const ctx = (runContext as { context?: unknown }).context;
  if (!ctx || typeof ctx !== 'object') return undefined;
  const sid = (ctx as { sessionId?: unknown }).sessionId;
  return typeof sid === 'string' ? sid : undefined;
}

function clip(text: string | undefined | null, max: number): string | null {
  if (text == null) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

/**
 * Tool-return-specific clip. When the original is over the budget AND
 * we have a callId, emit a marker the model can actually act on —
 * `recall_tool_result("<call_id>")` retrieves the full payload from
 * the `tool_outputs` side store (already written upstream of this
 * call by writeToolOutput). Falls back to the bare `…[+N chars]`
 * marker when callId is missing, since recall isn't possible without
 * it. Matches the marker format Layer 1 compaction uses
 * (compaction.ts:48) so the model sees the same recovery pattern
 * everywhere — without this consistency, models hesitate to call
 * recall_tool_result because the inline marker looked different.
 */
function clipToolResult(
  text: string | undefined | null,
  max: number,
  callId: string | undefined,
  toolName: string | null | undefined,
): string | null {
  if (text == null) return null;
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  if (callId) {
    const iso = new Date().toISOString();
    return `${head}\n[clipped: ${toolName ?? 'tool'} returned ${text.length} chars at ${iso} — call recall_tool_result("${callId}") for full output]`;
  }
  return `${head}…[+${text.length - max} chars]`;
}

function callIdFromDetails(details: ToolDetails | undefined): string | undefined {
  const call = details?.toolCall;
  return call?.callId ?? call?.id;
}

/**
 * Subscribe to the lifecycle events on a Runner (or anything Runner-
 * shaped) and write each one to the event log. Returns a `detach()`
 * function so callers can tear the subscription down — important for
 * per-run subscriptions that must not leak listeners.
 */
export function attachEventLogHooks(
  hooks: Runner | RunHooksLike,
  options: AttachHooksOptions,
): () => void {
  const getTurn = options.getTurn ?? (() => 0);
  const maxResultChars = options.maxResultChars ?? 8000;
  const maxOutputChars = options.maxOutputChars ?? 4000;
  const callIdToCalledEventId = new Map<string, string>();

  const onAgentStart = (...args: unknown[]) => {
    const [runContext, agent] = args as [unknown, NamedAgent | undefined];
    const sessionId = options.getSessionId(runContext);
    if (!sessionId) return;
    appendEvent({
      sessionId,
      turn: getTurn(runContext),
      role: agent?.name ?? 'agent',
      type: 'turn_started',
      data: { agent: agent?.name ?? null },
    });
  };

  const onAgentEnd = (...args: unknown[]) => {
    const [runContext, agent, output] = args as [unknown, NamedAgent | undefined, string];
    const sessionId = options.getSessionId(runContext);
    if (!sessionId) return;
    appendEvent({
      sessionId,
      turn: getTurn(runContext),
      role: agent?.name ?? 'agent',
      type: 'turn_ended',
      data: {
        agent: agent?.name ?? null,
        output: clip(typeof output === 'string' ? output : null, maxOutputChars),
      },
    });
  };

  const onAgentHandoff = (...args: unknown[]) => {
    const [runContext, fromAgent, toAgent] = args as [
      unknown,
      NamedAgent | undefined,
      NamedAgent | undefined,
    ];
    const sessionId = options.getSessionId(runContext);
    if (!sessionId) return;
    appendEvent({
      sessionId,
      turn: getTurn(runContext),
      role: fromAgent?.name ?? 'orchestrator',
      type: 'handoff',
      data: {
        from: fromAgent?.name ?? null,
        to: toAgent?.name ?? null,
      },
    });
  };

  const onToolStart = (...args: unknown[]) => {
    const [runContext, agent, tool, details] = args as [
      unknown,
      NamedAgent | undefined,
      NamedTool | undefined,
      ToolDetails | undefined,
    ];
    const sessionId = options.getSessionId(runContext);
    if (!sessionId) return;
    const callId = callIdFromDetails(details);
    let event: EventRow;
    try {
      event = appendEvent({
        sessionId,
        turn: getTurn(runContext),
        role: agent?.name ?? 'agent',
        type: 'tool_called',
        data: {
          tool: tool?.name ?? null,
          callId: callId ?? null,
          arguments: clip(details?.toolCall?.arguments ?? null, maxResultChars),
        },
      });
    } catch {
      // Best-effort: never let an event-log write blow up the run.
      return;
    }
    if (callId) {
      callIdToCalledEventId.set(callId, event.id);
    }
  };

  const onToolEnd = (...args: unknown[]) => {
    const [runContext, agent, tool, result, details] = args as [
      unknown,
      NamedAgent | undefined,
      NamedTool | undefined,
      string,
      ToolDetails | undefined,
    ];
    const sessionId = options.getSessionId(runContext);
    if (!sessionId) return;
    const callId = callIdFromDetails(details);
    const parentEventId = callId ? callIdToCalledEventId.get(callId) : undefined;
    if (callId) callIdToCalledEventId.delete(callId);
    // Normalize the result to a string up front. The SDK *usually* hands us a
    // string, but a tool (or a worker via Agent.asTool) can return an
    // object/array/error. Previously the lossless write + clip footer were
    // gated on `typeof result === 'string'`, so a non-string result skipped
    // the side-store ENTIRELY — making it unrecoverable via recall_tool_result
    // even when a callId existed. Stringify defensively so every non-empty
    // result is persisted and recoverable (report-back integrity, 2026-06-01).
    const resultStr: string | null =
      typeof result === 'string'
        ? result
        : result == null
          ? null
          : (() => {
              // Cycle-safe stringify so a circular/object result stays
              // recoverable via recall_tool_result rather than collapsing to a
              // lossy "[object Object]".
              try {
                const seen = new WeakSet<object>();
                return JSON.stringify(result, (_k, v) => {
                  if (typeof v === 'object' && v !== null) {
                    if (seen.has(v)) return '[Circular]';
                    seen.add(v);
                  }
                  return v;
                });
              } catch {
                return String(result);
              }
            })();
    // Lossless write FIRST (up to 200KB, see eventlog.ts). The event
    // log copy below is intentionally clipped for readability; the
    // recall_tool_result tool reads from tool_outputs to retrieve the
    // verbatim original.
    if (callId && resultStr !== null) {
      try {
        writeToolOutput({
          sessionId,
          callId,
          tool: tool?.name ?? null,
          output: resultStr,
        });
      } catch {
        // Best-effort: a tool_outputs write failure must never block
        // the event-log write below.
      }

      // Phase 1 brain architecture (v0.5.11+): fire-and-forget reflection
      // on every non-empty tool return. The length + importance gates
      // live inside reflection.ts so even skipped runs emit a
      // `cancelled` telemetry event — that's what feeds the Brain ->
      // Evolution panel's calibration story. Scheduling is
      // microtask-deferred so the SDK's tool result is unblocked.
      if (resultStr.length > 0) {
        scheduleReflection({
          sessionId,
          callId,
          tool: tool?.name ?? null,
          output: resultStr,
        });
      }
    }
    try {
      appendEvent({
        sessionId,
        turn: getTurn(runContext),
        role: agent?.name ?? 'agent',
        type: 'tool_returned',
        data: {
          tool: tool?.name ?? null,
          callId: callId ?? null,
          result: clipToolResult(
            resultStr,
            maxResultChars,
            callId,
            tool?.name,
          ),
        },
        parentEventId,
      });
    } catch {
      // see onToolStart
    }
    // Evolving procedural memory: if this call was a HARD failure of a
    // remembered tool, self-correct (invalidate the stale memo so the next run
    // rediscovers). Best-effort; runs AFTER the tool_returned event is logged.
    autoInvalidateOnFailure({
      toolName: tool?.name ?? null,
      args: (details as { toolCall?: { arguments?: unknown } } | undefined)?.toolCall?.arguments,
      resultStr,
    });
  };

  hooks.on('agent_start', onAgentStart);
  hooks.on('agent_end', onAgentEnd);
  hooks.on('agent_handoff', onAgentHandoff);
  hooks.on('agent_tool_start', onToolStart);
  hooks.on('agent_tool_end', onToolEnd);

  return () => {
    hooks.off('agent_start', onAgentStart);
    hooks.off('agent_end', onAgentEnd);
    hooks.off('agent_handoff', onAgentHandoff);
    hooks.off('agent_tool_start', onToolStart);
    hooks.off('agent_tool_end', onToolEnd);
  };
}
