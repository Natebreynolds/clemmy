/**
 * code-mode-tool — the `run_tool_program` tool + its read-only dispatcher
 * (Lane C Code Mode, Phase 1). The model writes ONE short JS program against a
 * `clem.<tool>(args)` API; it runs in the locked-down sandbox (code-mode-sandbox)
 * and every clem call is dispatched HERE, through the SAME wrapToolForHarness +
 * withHarnessRunContext path the gated lane uses — so Phase 2 (gated writes) just
 * widens the allowlist with the gates already covering it.
 *
 * Phase 1 is READ-ONLY: the dispatcher refuses any tool not in READ_ONLY_TOOLS,
 * so a program can read/search/aggregate but cannot send/write/deploy. Flag
 * CLEMMY_CODE_MODE (default OFF) — when off, the tool is never registered, so the
 * surface is byte-identical. DELETE-WHEN-VALIDATED: flip default-on after gate-
 * parity + a measured token win, then make it unconditional.
 */
import { tool } from '@openai/agents';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getRuntimeEnv } from '../config.js';
import { wrapToolForHarness, withHarnessRunContext, ToolCallsCounter, harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { runCodeModeProgram, type CodeModeResult } from './code-mode-sandbox.js';
// NB: getCoreTools is reached via DYNAMIC import in realToolsByName() — a static
// import would form a registry ↔ code-mode-tool cycle (registry exposes
// buildCodeModeTool). The dynamic import resolves at first dispatch, by when the
// registry module is fully loaded.

export function codeModeEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CODE_MODE', 'off') || 'off').trim().toLowerCase() === 'on';
}

/** The Phase-1 read-only surface a code-mode program may call. Every name here is
 *  non-mutating; a write/send tool (composio_execute_tool, write_file, …) is
 *  DELIBERATELY excluded until Phase 2 routes its gates through this path. */
export const READ_ONLY_TOOLS = new Set<string>([
  'memory_recall', 'memory_search', 'memory_read', 'memory_search_facts',
  'read_file', 'list_files', 'workspace_roots',
  'composio_search_tools', 'composio_status',
  'tool_output_query', 'recall_tool_result',
  'user_profile_read', 'session_history',
  'skill_list', 'skill_read',
  'local_cli_list', 'local_cli_probe',
]);

type InvokableTool = { name: string; invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

let toolsByName: Map<string, InvokableTool> | null = null;
async function realToolsByName(): Promise<Map<string, InvokableTool>> {
  if (toolsByName) return toolsByName;
  const { getCoreTools } = await import('./registry.js');
  const m = new Map<string, InvokableTool>();
  for (const t of getCoreTools() as unknown as InvokableTool[]) {
    if (t && typeof t.name === 'string') m.set(t.name, t);
  }
  toolsByName = m;
  return m;
}

/** Dispatch ONE clem.<method>(args) call through the gated tool path. Refuses
 *  anything outside the read-only allowlist (the Phase-1 safety boundary).
 *  Returns the tool's result parsed to a value (JSON when possible, else text).
 *  Exported for tests. */
export async function dispatchReadOnlyTool(method: string, args: unknown, sessionId: string): Promise<unknown> {
  if (!READ_ONLY_TOOLS.has(method)) {
    throw new Error(`code-mode: tool "${method}" is not available — Phase 1 exposes read-only tools only`);
  }
  const real = (await realToolsByName()).get(method);
  if (!real || typeof real.invoke !== 'function') {
    throw new Error(`code-mode: unknown tool "${method}"`);
  }
  const wrapped = wrapToolForHarness(real as never) as InvokableTool;
  const counter = new ToolCallsCounter(1000);
  const callId = `codemode-${randomUUID()}`;
  const runContext = { context: { sessionId } };
  const details = { toolCall: { callId } };
  const out = await withHarnessRunContext({ sessionId, counter }, () =>
    wrapped.invoke!(runContext, JSON.stringify(args ?? {}), details),
  );
  if (typeof out !== 'string') return out ?? null;
  try { return JSON.parse(out); } catch { return out; }
}

/** Run a code-mode program for a session against the read-only surface. */
export async function runCodeModeForSession(program: string, sessionId: string): Promise<CodeModeResult> {
  return runCodeModeProgram(program, (method, args) => dispatchReadOnlyTool(method, args, sessionId));
}

const CODE_MODE_DESCRIPTION = [
  'Run ONE short JavaScript program (the body of an async function — use `return` for the result) against the `clem` API instead of emitting many separate tool calls.',
  'Use this for DATA-HEAVY or MULTI-STEP read work — loop/filter/paginate/aggregate over many items and `return` only the distilled result, so the large intermediate tool outputs never enter the conversation.',
  'The API is `clem.<tool>(args)` returning a Promise; available (read-only, Phase 1): ' + [...READ_ONLY_TOOLS].join(', ') + '.',
  'Example: `let n=0; const r = await clem.memory_search({query:"acme"}); return { matches: r.length };`',
  'Sandboxed: no network, no filesystem, no other modules — only `clem` calls reach Clementine. Bounded time + tool-call budget.',
].join(' ');

/** The run_tool_program tool def. Only meaningful when codeModeEnabled(). */
export function buildCodeModeTool() {
  return tool({
    name: 'run_tool_program',
    description: CODE_MODE_DESCRIPTION,
    parameters: z.object({
      program: z.string().min(1).describe('A JavaScript program body (async). Call `clem.<tool>(args)` and `return` a small distilled value.'),
    }),
    execute: async ({ program }: { program: string }) => {
      const sessionId = harnessRunContextStorage.getStore()?.sessionId ?? '';
      const result = await runCodeModeForSession(program, sessionId);
      if (result.ok) {
        return `code-mode program returned (${result.rpcCalls} tool call${result.rpcCalls === 1 ? '' : 's'}):\n${JSON.stringify(result.value)}`;
      }
      return `code-mode program failed: ${result.error}`;
    },
  });
}
