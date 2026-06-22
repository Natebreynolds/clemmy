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
import { appendEvent } from '../runtime/harness/eventlog.js';
import { runCodeModeProgram, type CodeModeResult } from './code-mode-sandbox.js';
// NB: getCoreTools is reached via DYNAMIC import in realToolsByName() — a static
// import would form a registry ↔ code-mode-tool cycle (registry exposes
// buildCodeModeTool). The dynamic import resolves at first dispatch, by when the
// registry module is fully loaded.

export function codeModeEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CODE_MODE', 'off') || 'off').trim().toLowerCase() === 'on';
}

/** Phase 2: allow GATED WRITES inside code-mode programs. Separate opt-in (default
 *  off) so enabling code-mode (read-only) never silently enables writes. When on,
 *  a program may call the mutating tools — and because every clem call routes
 *  through wrapToolForHarness, the full gate chain (execution-wrap / grounding /
 *  duplicate / goal-fidelity / destination / confirm-first) fires per in-program
 *  write exactly as on a discrete call. DELETE-WHEN-VALIDATED: fold into
 *  CLEMMY_CODE_MODE once gate-parity holds across a release. */
export function codeModeWritesEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CODE_MODE_WRITES', 'off') || 'off').trim().toLowerCase() === 'on';
}

/** Phase 2 mutating surface. Each routes through wrapToolForHarness, so the
 *  write-boundary gates cover it with NO new gate code. run_worker is excluded
 *  (worker-of-worker recursion is out of scope for v1). */
export const WRITE_TOOLS = new Set<string>([
  'composio_execute_tool', 'write_file', 'run_shell_command',
]);

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

/** Test seam: inject the tools-by-name map (fake gated tools) so gate-parity can
 *  be exercised through the REAL bracket chain without real sends. null resets. */
export function _setCodeModeToolsForTests(map: Map<string, InvokableTool> | null): void {
  toolsByName = map;
}

/** Whether a clem.<method> is reachable: read-only always; mutating only when
 *  writes are enabled (Phase 2). Everything else is refused (the safety boundary). */
export function isCodeModeToolAllowed(method: string): boolean {
  if (READ_ONLY_TOOLS.has(method)) return true;
  if (codeModeWritesEnabled() && WRITE_TOOLS.has(method)) return true;
  return false;
}

/** Dispatch ONE clem.<method>(args) call through the gated tool path. Refuses
 *  anything outside the allowlist. A mutating call routes through the SAME
 *  wrapToolForHarness gate battery as a discrete call (gate-parity), so a gate
 *  block surfaces here as a thrown error the program/model can recover from.
 *  Shares `counter` across the program's calls (loop-guard + batch parity).
 *  Exported for tests. */
export async function dispatchCodeModeTool(method: string, args: unknown, sessionId: string, counter?: ToolCallsCounter): Promise<unknown> {
  if (!isCodeModeToolAllowed(method)) {
    const why = WRITE_TOOLS.has(method) ? 'writes are disabled (set CLEMMY_CODE_MODE_WRITES=on)' : 'not in the code-mode allowlist';
    throw new Error(`code-mode: tool "${method}" is not available — ${why}`);
  }
  const real = (await realToolsByName()).get(method);
  if (!real || typeof real.invoke !== 'function') {
    throw new Error(`code-mode: unknown tool "${method}"`);
  }
  const wrapped = wrapToolForHarness(real as never) as InvokableTool;
  const callId = `codemode-${randomUUID()}`;
  const runContext = { context: { sessionId } };
  const details = { toolCall: { callId } };
  // Observability: emit tool_called/tool_returned for each in-program call so the
  // trace drawer / Tasks board shows what a code-mode program did (parity with
  // discrete calls; `codeMode:true` tags them for adoption measurement).
  try { appendEvent({ sessionId, turn: 0, role: 'Clem', type: 'tool_called', data: { tool: method, callId, codeMode: true, args: JSON.stringify(args ?? {}).slice(0, 300) } }); } catch { /* telemetry never blocks */ }
  try {
    const out = await withHarnessRunContext({ sessionId, counter: counter ?? new ToolCallsCounter(1000) }, () =>
      wrapped.invoke!(runContext, JSON.stringify(args ?? {}), details),
    );
    try { appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: method, callId, ok: true, codeMode: true, preview: (typeof out === 'string' ? out : JSON.stringify(out ?? '')).slice(0, 400) } }); } catch { /* best-effort */ }
    if (typeof out !== 'string') return out ?? null;
    try { return JSON.parse(out); } catch { return out; }
  } catch (err) {
    try { appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: method, callId, ok: false, codeMode: true, error: (err instanceof Error ? err.message : String(err)).slice(0, 400) } }); } catch { /* best-effort */ }
    throw err;
  }
}

/** Run a code-mode program for a session. ONE counter spans all in-program calls
 *  so loop-guard + batch gates see the program as a single turn (gate-parity). */
export async function runCodeModeForSession(program: string, sessionId: string): Promise<CodeModeResult> {
  const counter = new ToolCallsCounter(1000);
  return runCodeModeProgram(program, (method, args) => dispatchCodeModeTool(method, args, sessionId, counter));
}

export function codeModeDescription(): string {
  const writes = codeModeWritesEnabled();
  const surface = [...READ_ONLY_TOOLS, ...(writes ? WRITE_TOOLS : [])].join(', ');
  return [
    'Run ONE short JavaScript program (the body of an async function — use `return` for the result) against the `clem` API instead of emitting many separate tool calls.',
    'Use this for DATA-HEAVY or MULTI-STEP work — loop/filter/paginate/aggregate over many items and `return` only the distilled result, so the large intermediate tool outputs never enter the conversation.',
    'The API is `clem.<tool>(args)` returning a Promise; available: ' + surface + '.',
    writes
      ? 'Writes ARE allowed and pass the SAME approval/grounding/destination gates as a normal tool call — a blocked write throws inside your program (catch it or let it surface).'
      : 'Read-only: no writes/sends from a program.',
    'Example: `const r = await clem.memory_search({query:"acme"}); return { matches: r.length };`',
    'Sandboxed: no network, no filesystem, no other modules — only `clem` calls reach Clementine. Bounded time + tool-call budget.',
  ].join(' ');
}

/** The run_tool_program tool def. Only meaningful when codeModeEnabled(). */
export function buildCodeModeTool() {
  return tool({
    name: 'run_tool_program',
    description: codeModeDescription(),
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
