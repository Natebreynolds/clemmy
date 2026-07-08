import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Tool } from '@openai/agents';
import { getComputerTools, WRITE_FILE_PARAMS, RUN_SHELL_COMMAND_PARAMS } from './computer-tools.js';
import {
  getComposioRuntimeTools,
  COMPOSIO_STATUS_PARAMS,
  COMPOSIO_LIST_TOOLS_PARAMS,
  COMPOSIO_SEARCH_TOOLS_PARAMS,
  COMPOSIO_EXECUTE_TOOL_PARAMS,
} from './composio-tools.js';
import { wrapToolForHarness, withHarnessRunContext, ToolCallsCounter } from '../runtime/harness/brackets.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { formatRecallableToolText } from '../runtime/harness/tool-output-format.js';
import { textResult } from './shared.js';

function previewArgs(input: unknown): Record<string, unknown> {
  const o = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  return out;
}

/**
 * Gate bridge for the Anthropic Agent SDK lane.
 *
 * The Claude brain/workers run via the official Agent SDK (`query()`), which
 * executes tool calls in ITS OWN loop against this local MCP server — NOT the
 * `@openai/agents` Runner where the 8 safety gates live. The execution/discovery
 * tools (`run_shell_command`, `write_file`, and the Composio status/search/list/
 * execute chain) are therefore not registered on the MCP surface at all today,
 * so the Agent SDK lane is read-only.
 *
 * This module registers those tools onto the MCP server, reusing the SAME
 * `@openai/agents` `tool()` definitions the Codex lane uses (no logic
 * duplication) and routing every call through `wrapToolForHarness` — so the
 * full gate chain (kill / counter / loop-guard / execution-wrap / grounding /
 * goal-fidelity / destination / confirm-first) fires identically. The MCP
 * subprocess shares the chat session's `harness.db` via `CLEMENTINE_HOME` +
 * `CLEMENTINE_MCP_SESSION_ID`, so the gates read the real session history and
 * plan-scope (this is what lets a batch approval cover a worker fan-out).
 *
 * Registered ONLY when `CLEMENTINE_MCP_GATED_MUTATIONS=on` (set by the Agent SDK
 * lane in buildClaudeAgentSdkLocalMcpServers), so the Codex/OpenAI MCP wiring is
 * untouched. Human APPROVAL for these tools is handled upstream by the Agent
 * SDK's async `canUseTool` (see claude-agent-sdk.ts); the gates here are the
 * automated safety floor that runs post-approval.
 *
 * The MCP-facing input schemas below are DERIVED from the SAME authoritative Zod
 * shapes the source tool() defs register with (computer-tools.ts / composio-tools.ts)
 * — no hand-mirrored copy, so a base-tool param change can never drift out of the
 * gated lane (TOOL-REGISTRY-PLAN C3; the drift here caused ~⅔ InvalidToolInputError
 * on Claude gated calls). They shape only what Claude sees; the real gated `execute`
 * re-validates internally on `.invoke`. A conformance test pins the derived field
 * set to each base tool's registered schema.
 *
 * GATED TRANSFORM: every base field that is nullable-but-NOT-optional is loosened to
 * ALSO be optional here, so the Agent SDK may OMIT it (Claude follows this looser MCP
 * schema and routinely drops such fields); the handler then fills the key with null
 * before the base tool's STRICT inner validate runs. Required (non-nullable) base
 * fields stay required. `overrides` re-declares the few fields whose gated variant
 * INTENTIONALLY differs from the base — an explicit documented transform, not a fork.
 */
function toGatedShape(base: z.ZodRawShape, overrides: z.ZodRawShape = {}): z.ZodRawShape {
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(base)) {
    const schema = raw as z.ZodTypeAny;
    const nullableNotOptional = schema.safeParse(null).success && !schema.safeParse(undefined).success;
    out[key] = nullableNotOptional ? schema.optional() : schema;
  }
  return { ...out, ...(overrides as Record<string, z.ZodTypeAny>) };
}

// LAZILY evaluated + memoized (plan risk #5): computed on first registration, NOT
// at module load, because composio-tools transitively imports this module — reading
// its exported PARAMS at eval time hits a TDZ. By first-call time every module is
// initialized. Consumers (registerGatedMutatingTools + the conformance test) call
// getGatedToolSchemas().
let _gatedToolSchemas: Record<string, z.ZodRawShape> | null = null;
export function getGatedToolSchemas(): Record<string, z.ZodRawShape> {
  if (!_gatedToolSchemas) {
    _gatedToolSchemas = {
      run_shell_command: toGatedShape(RUN_SHELL_COMMAND_PARAMS),
      write_file: toGatedShape(WRITE_FILE_PARAMS),
      composio_status: toGatedShape(COMPOSIO_STATUS_PARAMS),
      composio_search_tools: toGatedShape(COMPOSIO_SEARCH_TOOLS_PARAMS),
      composio_list_tools: toGatedShape(COMPOSIO_LIST_TOOLS_PARAMS),
      // DOCUMENTED DIVERGENCE: the gated executor always needs a JSON args string, so
      // `arguments` stays REQUIRED here even though the base declares it `.nullable()`
      // for strict-mode uniformity. connected_account_id keeps the standard loosening.
      composio_execute_tool: toGatedShape(COMPOSIO_EXECUTE_TOOL_PARAMS, { arguments: z.string() }),
    };
  }
  return _gatedToolSchemas;
}

/** Pre-content counter cap. Each MCP handler call is ONE gated unit, so a fresh
 *  per-call counter never trips the per-turn cap (the Agent SDK bounds its own
 *  turns; cross-call runaways are still caught by the event-log loop-guard). */
const PER_CALL_COUNTER_LIMIT = 1000;

type InvokableTool = Tool<unknown> & {
  invoke?: (runContext: unknown, input: string, details: unknown) => Promise<unknown>;
  description?: string;
};

export function gatedMutationsEnabled(): boolean {
  return (process.env.CLEMENTINE_MCP_GATED_MUTATIONS ?? '').trim().toLowerCase() === 'on';
}

export interface RegisterGatedMutatingToolsOptions {
  enabled?: boolean;
  sessionId?: string;
}

/**
 * Register the gated mutating tools onto the MCP server. No-op unless
 * CLEMENTINE_MCP_GATED_MUTATIONS=on AND a session id is present (the gates need
 * a session to read the event log against).
 */
export function registerGatedMutatingTools(server: McpServer, opts: RegisterGatedMutatingToolsOptions = {}): void {
  const enabled = opts.enabled ?? gatedMutationsEnabled();
  if (!enabled) return;
  const sessionId = opts.sessionId?.trim() || process.env.CLEMENTINE_MCP_SESSION_ID?.trim();
  if (!sessionId) return;

  const byName = new Map<string, InvokableTool>();
  for (const t of [...getComputerTools(), ...getComposioRuntimeTools()] as InvokableTool[]) {
    if (t && typeof t.name === 'string') byName.set(t.name, t);
  }

  for (const [name, shape] of Object.entries(getGatedToolSchemas())) {
    const realTool = byName.get(name);
    if (!realTool || typeof realTool.invoke !== 'function') continue;
    const wrapped = wrapToolForHarness(realTool as never) as InvokableTool;

    server.tool(
      name,
      realTool.description ?? name,
      shape,
      async (rawInput: Record<string, unknown>) => {
        const counter = new ToolCallsCounter(PER_CALL_COUNTER_LIMIT);
        const callId = `mcp-${randomUUID()}`;
        // STRICT-MODE NORMALIZATION (the crux of the gated lane's reliability).
        // The real @openai/agents tool defs run under SDK strict mode: optional
        // fields are declared `.nullable()` (NOT `.optional()`), so the strict
        // JSON schema lists them as REQUIRED-but-nullable — they must be PRESENT,
        // value possibly null. Claude (Agent SDK) follows the looser MCP schema
        // here and frequently omits them entirely (e.g. run_shell_command with
        // just {command}), so the inner strict parse threw "InvalidToolInputError:
        // Invalid JSON input for tool" ~⅔ of the time. Fill every declared key
        // (missing → null) and drop unknown extras so the inner strict validation
        // always passes. Keys mirror the real tool's params (GATED_TOOL_SCHEMAS).
        const input: Record<string, unknown> = {};
        for (const key of Object.keys(shape)) {
          input[key] = rawInput?.[key] ?? null;
        }
        // Synthesize the shapes the gated execute reads: sessionIdFromRunContext
        // wants { context: { sessionId } }; callIdFromToolDetails wants
        // { toolCall: { callId } } (see tool-output-context.ts).
        const runContext = { context: { sessionId } };
        const details = { toolCall: { callId } };
        // Observability: the Agent SDK runs its tool loop OUTSIDE the harness
        // event log, so without this the agentic brain's tool calls are invisible
        // to the trace drawer / Tasks board ("see who does what"). Emit a
        // tool_called before and a tool_returned (with ok/error) after — also the
        // single source of truth for diagnosing gated-call failures.
        try {
          appendEvent({ sessionId, turn: 0, role: 'Clem', type: 'tool_called', data: { tool: name, callId, args: previewArgs(input) } });
        } catch { /* telemetry must never block the call */ }
        try {
          const out = await withHarnessRunContext({ sessionId, counter }, () =>
            wrapped.invoke!(runContext, JSON.stringify(input ?? {}), details),
          );
          const text = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out);
          try {
            appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: name, callId, ok: true, preview: text.slice(0, 400) } });
          } catch { /* best-effort */ }
          // Token efficiency (parity with the Codex lane, computer-tools.ts): digest a
          // large result + park the full payload in tool_outputs keyed by this
          // sessionId/callId, so Claude gets a structure-aware summary + a recall
          // pointer (recall_tool_result / tool_output_query) instead of a 76KB body
          // flooding its context. Without sessionId/callId this falls back to plain
          // truncation — both are present here, so the digest path fires.
          return textResult(formatRecallableToolText(text, { toolName: name, sessionId, callId }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: name, callId, ok: false, error: message.slice(0, 400) } });
          } catch { /* best-effort */ }
          throw err;
        }
      },
    );
  }
}
