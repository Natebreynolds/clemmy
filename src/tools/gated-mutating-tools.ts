import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Tool } from '@openai/agents';
import { getComputerTools } from './computer-tools.js';
import { getComposioRuntimeTools } from './composio-tools.js';
import { wrapToolForHarness, withHarnessRunContext, ToolCallsCounter } from '../runtime/harness/brackets.js';
import { textResult } from './shared.js';

/**
 * Gate bridge for the Anthropic Agent SDK lane.
 *
 * The Claude brain/workers run via the official Agent SDK (`query()`), which
 * executes tool calls in ITS OWN loop against this local MCP server — NOT the
 * `@openai/agents` Runner where the 8 safety gates live. The mutating tools
 * (`run_shell_command`, `composio_execute_tool`, `write_file`) are therefore not
 * registered on the MCP surface at all today, so the Agent SDK lane is read-only.
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
 * The MCP-facing input schemas below MIRROR the `parameters` of the source
 * `tool()` defs (computer-tools.ts / composio-tools.ts). They shape only what
 * Claude sees; the real gated `execute` re-validates internally on `.invoke`.
 */
const GATED_TOOL_SCHEMAS: Record<string, z.ZodRawShape> = {
  run_shell_command: {
    command: z.string().min(1),
    cwd: z.string().nullable().optional(),
    timeout_ms: z.number().min(1000).max(120000).nullable().optional(),
  },
  write_file: {
    path: z.string().min(1),
    content: z.string(),
    mode: z.enum(['create', 'append', 'overwrite']).nullable().optional(),
  },
  composio_execute_tool: {
    tool_slug: z.string().min(1),
    arguments: z.string(),
    connected_account_id: z.string().nullable().optional(),
  },
};

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

/**
 * Register the gated mutating tools onto the MCP server. No-op unless
 * CLEMENTINE_MCP_GATED_MUTATIONS=on AND a session id is present (the gates need
 * a session to read the event log against).
 */
export function registerGatedMutatingTools(server: McpServer): void {
  if (!gatedMutationsEnabled()) return;
  const sessionId = process.env.CLEMENTINE_MCP_SESSION_ID?.trim();
  if (!sessionId) return;

  const byName = new Map<string, InvokableTool>();
  for (const t of [...getComputerTools(), ...getComposioRuntimeTools()] as InvokableTool[]) {
    if (t && typeof t.name === 'string') byName.set(t.name, t);
  }

  for (const [name, shape] of Object.entries(GATED_TOOL_SCHEMAS)) {
    const realTool = byName.get(name);
    if (!realTool || typeof realTool.invoke !== 'function') continue;
    const wrapped = wrapToolForHarness(realTool as never) as InvokableTool;

    server.tool(
      name,
      realTool.description ?? name,
      shape,
      async (input: Record<string, unknown>) => {
        const counter = new ToolCallsCounter(PER_CALL_COUNTER_LIMIT);
        const callId = `mcp-${randomUUID()}`;
        // Synthesize the shapes the gated execute reads: sessionIdFromRunContext
        // wants { context: { sessionId } }; callIdFromToolDetails wants
        // { toolCall: { callId } } (see tool-output-context.ts).
        const runContext = { context: { sessionId } };
        const details = { toolCall: { callId } };
        const out = await withHarnessRunContext({ sessionId, counter }, () =>
          wrapped.invoke!(runContext, JSON.stringify(input ?? {}), details),
        );
        return textResult(typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out));
      },
    );
  }
}
