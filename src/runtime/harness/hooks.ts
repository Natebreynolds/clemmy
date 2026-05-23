import type { Runner } from '@openai/agents';
import { appendEvent, writeToolOutput, type EventRow } from './eventlog.js';

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
    // Lossless write FIRST (up to 200KB, see eventlog.ts). The event
    // log copy below is intentionally clipped for readability; the
    // recall_tool_result tool reads from tool_outputs to retrieve the
    // verbatim original.
    if (callId && typeof result === 'string') {
      try {
        writeToolOutput({
          sessionId,
          callId,
          tool: tool?.name ?? null,
          output: result,
        });
      } catch {
        // Best-effort: a tool_outputs write failure must never block
        // the event-log write below.
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
          result: clip(typeof result === 'string' ? result : null, maxResultChars),
        },
        parentEventId,
      });
    } catch {
      // see onToolStart
    }
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
