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
import { WorkerToolInputSchema, type WorkerToolInput } from '../agents/worker-job-packet.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { appendEvent, getToolOutput, writeToolOutput } from '../runtime/harness/eventlog.js';
import { withToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';
import { deriveCodeModeSets } from './tool-registry.js';
import { runCodeModeProgram, cleanCodeModeStderr, type CodeModeResult } from './code-mode-sandbox.js';
// NB: getCoreTools is reached via DYNAMIC import in realToolsByName() — a static
// import would form a registry ↔ code-mode-tool cycle (registry exposes
// buildCodeModeTool). The dynamic import resolves at first dispatch, by when the
// registry module is fully loaded.

export function codeModeEnabled(): boolean {
  // DEFAULT-ON since v0.11.0: the sandbox containment was adversarially soaked
  // (2026-06-22, scripts/soak-code-mode-escape.ts — 14/14 escapes contained incl.
  // secret-exfil + file-write). Kill-switch CLEMMY_CODE_MODE=off.
  return (getRuntimeEnv('CLEMMY_CODE_MODE', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/** Phase 2: allow GATED WRITES inside code-mode programs. When on, a program may
 *  call the mutating tools — and because every clem call routes through
 *  wrapToolForHarness, the full gate chain (execution-wrap / grounding /
 *  duplicate / goal-fidelity / destination / confirm-first) fires per in-program
 *  write exactly as on a discrete call (gate-parity-proven). DEFAULT-ON since
 *  v0.11.0 alongside CLEMMY_CODE_MODE (sandbox escape-soaked + writes route
 *  through the same gates). Kill-switch CLEMMY_CODE_MODE_WRITES=off. */
export function codeModeWritesEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CODE_MODE_WRITES', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/** JIT adoption mandate (default ON; requires code mode). The tool DESCRIPTION
 *  nudge alone didn't move adoption (live: 0 run_tool_program on a textbook
 *  multi-fetch SEO turn), so on a clearly data-heavy turn we inject a per-turn
 *  DIRECTIVE that steers multi-fetch work to Code Mode. Soft by construction — a
 *  prompt steer, not a hard gate (the model still controls execution).
 *  DELETE-WHEN-VALIDATED: once telemetry shows the mandate lifts the
 *  run_tool_program rate on mandate-fired turns without false-firing on non-data
 *  turns, fold it in unconditionally. Kill-switch: CLEMMY_CODE_MODE_MANDATE=off. */
/** Kill-switch for the code-mode irreversible-send guard (default ON). */
export function codeModeSendGuardEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CODE_MODE_SEND_GUARD', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/** clem.run_worker inside a program (default ON; kill-switch CLEMMY_CODE_MODE_WORKERS=off).
 *  Lets a program fetch/aggregate, then fan out bounded reasoning sub-agents on
 *  the interesting subset — read-aggregation and reasoning-fan-out in ONE program
 *  (the 100-subagent-handoff bridge). HARD depth ≤ 1 (no worker-of-worker) via
 *  guardrailScopeId, and a per-program count cap. */
export function codeModeWorkersEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CODE_MODE_WORKERS', 'on') || 'on').trim().toLowerCase() !== 'off';
}
/** Ceiling on sub-agents ONE program may spawn — beyond this, return items and
 *  let the parent batch. Bounds cost/recursion blast radius. */
const MAX_WORKERS_PER_PROGRAM = 4;
const programWorkerCounts = new WeakMap<ToolCallsCounter, number>();

/** Mutating-call count per PROGRAM RUN, keyed by the run's counter identity
 *  (one ToolCallsCounter spans one program). WeakMap → no cleanup needed. */
const programMutationCounts = new WeakMap<ToolCallsCounter, number>();

export function codeModeMandateEnabled(): boolean {
  if (!codeModeEnabled()) return false;
  return (getRuntimeEnv('CLEMMY_CODE_MODE_MANDATE', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/**
 * Per-turn Code Mode steering directive, or '' when not applicable (so the prompt
 * is byte-identical on non-data turns). Fires only when the turn already has
 * external MCP data servers in scope (the JIT scoper only admits them on a
 * data-relevant intent, so this is an intent-gated "data-heavy turn" signal) —
 * exactly the case where discrete calls dump large JSON into context. Mentions
 * composio_execute_tool as an in-program option only when writes are on. Pure +
 * exported for test.
 */
export function codeModeMandateDirective(opts: {
  mcpServersInScope?: number;
  allowAllMcp?: boolean;
  /** Composio data tools (composio_execute_tool) are in scope this turn. The
   *  original trigger keyed ONLY on external MCP servers, so a composio-heavy
   *  turn (email/CRM/calendar — the common case) never tripped the mandate.
   *  Session-stable, so appending the base rule stays prompt-cache-safe. */
  composioInScope?: boolean;
  fanoutPreferred?: boolean;
  multiItem?: { count: number; kind: string | null; carried?: boolean };
}): string {
  if (!codeModeMandateEnabled()) return '';
  const hasMcpData = !!opts.allowAllMcp || (opts.mcpServersInScope ?? 0) >= 1 || !!opts.composioInScope;
  if (!hasMcpData) return '';
  const fetchTools = codeModeWritesEnabled()
    ? 'MCP tools (`<server>__<tool>`) and `composio_execute_tool`'
    : 'MCP tools (`<server>__<tool>`)';
  // ONE standing lane rule, always present on data turns. The old shape was
  // either/or — mandate code mode OR (on multi-item detection) say nothing —
  // so a missed detection ACTIVELY steered batch work away from fan-out
  // (live 2026-07-07: 18 firms ground serially through one context). The
  // model now always has all three lanes and the decision rule; detection
  // only sharpens the rule with the concrete count, it no longer gates it.
  const rule = [
    `BATCH-SHAPE RULE — external data-fetch tools are in scope this turn (${fetchTools}). Pick the lane by the SHAPE of the work:`,
    '(a) 3+ same-shape items whose tool arguments you can FULLY MATERIALIZE right now (send N drafted emails, update N records with known values, pull N known lookups) → `run_batch` ONE plan: certified once, then executed deterministically with zero model calls between items — the fastest and most auditable lane. ANY batch of external SENDS/WRITES MUST use run_batch — never loop sends yourself and never put sends in run_tool_program (its program ceiling will lose a partial batch).',
    '(b) 3+ independent items that each need their own REASONING/discovery (research each firm, judge each doc) → FAN OUT: call `run_worker` ONCE with the complete stable-id items array and shared output contract; the harness runs isolated Workers with bounded concurrency — do NOT grind the items one-by-one in your own context;',
    '(c) several DIFFERENT read-only fetches feeding ONE deliverable → ONE `run_tool_program` (Promise.all the independent fetches inside), distill, return ONLY the small result. run_tool_program is READ-ONLY aggregation with an activity-based deadline — no sends/writes inside it;',
    '(d) a SINGLE read → call the tool directly.',
  ].join(' ');
  if (opts.fanoutPreferred && opts.multiItem) {
    const n = opts.multiItem.count >= 3 ? `~${opts.multiItem.count}` : 'several';
    const kind = opts.multiItem.kind ?? 'items';
    const source = opts.multiItem.carried ? 'the conversation (your own prior message names the batch)' : 'the request';
    return `${rule} THIS TURN IS BATCH-SHAPED: ${source} indicates ${n} independent ${kind} — use run_batch if you can bake every item's args now, else run_worker.`;
  }
  return rule;
}

// Registry-derived surfaces (step-2 flip, strategic-wave Track 1a): the
// hand-curated sets are gone — the registry's `codeModeAccess` axis is the one
// truth, proven set-equal by the conformance test before the flip. Adding a
// tool to code mode is now ONE registry field, not a second hand list.
// run_worker stays excluded via the registry (worker-of-worker recursion is
// out of scope); every write here still routes through wrapToolForHarness so
// the write-boundary gates cover it with NO new gate code.
const codeModeSets = deriveCodeModeSets();

/** Phase 2 mutating surface (registry-derived). */
export const WRITE_TOOLS: ReadonlySet<string> = codeModeSets.write;

/** The Phase-1 read-only surface a code-mode program may call (registry-derived). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = codeModeSets.readOnly;

type InvokableTool = { name: string; invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

export interface CodeModeShellResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  raw: string;
  stdout_json?: unknown;
  result_handle?: string;
  truncated_at_write?: boolean;
}

function strictJsonParse(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseStdoutJson(stdout: string): unknown | undefined {
  const direct = strictJsonParse(stdout.trim());
  if (direct.ok) return direct.value;
  const candidate = extractJsonCandidate(stdout);
  if (!candidate) return undefined;
  const repaired = strictJsonParse(candidate);
  return repaired.ok ? repaired.value : undefined;
}

function sectionAfter(label: 'stdout' | 'stderr', body: string): string {
  const marker = `${label}:\n`;
  if (body === marker.slice(0, -1)) return '';
  if (!body.startsWith(marker)) return '';
  return body.slice(marker.length);
}

export function parseShellToolOutput(raw: string, opts: { callId?: string; truncatedAtWrite?: boolean } = {}): CodeModeShellResult | null {
  const firstLine = raw.match(/^\s*exit_code:\s*([^\n\r]*)/i);
  if (!firstLine) return null;
  const parsedCode = Number.parseInt(firstLine[1].trim(), 10);
  const exitCode = Number.isFinite(parsedCode) ? parsedCode : null;
  let rest = raw.slice(firstLine[0].length).replace(/^\r?\n\r?\n?/, '');
  let stdout = '';
  let stderr = '';

  if (rest.startsWith('stdout:\n')) {
    const stderrBoundary = rest.indexOf('\n\nstderr:\n');
    if (stderrBoundary >= 0) {
      stdout = sectionAfter('stdout', rest.slice(0, stderrBoundary));
      stderr = sectionAfter('stderr', rest.slice(stderrBoundary + 2));
    } else {
      stdout = sectionAfter('stdout', rest);
    }
  } else if (rest.startsWith('stderr:\n')) {
    stderr = sectionAfter('stderr', rest);
  }

  const result: CodeModeShellResult = {
    ok: exitCode === 0,
    exit_code: exitCode,
    stdout,
    stderr,
    raw,
    ...(opts.callId ? { result_handle: opts.callId } : {}),
    ...(opts.truncatedAtWrite ? { truncated_at_write: true } : {}),
  };
  const stdoutJson = parseStdoutJson(stdout);
  if (stdoutJson !== undefined) result.stdout_json = stdoutJson;
  return result;
}

function parseToolErrorText(raw: string): { ok: false; error: string; raw: string; error_kind: 'tool_error' } | null {
  const text = raw.trim();
  if (!text) return null;
  if (
    /^Tool call (?:refused|blocked) by harness\b/i.test(text) ||
    /^An error occurred while running the tool\b/i.test(text) ||
    /^\s*(?:ERROR|Error|InvalidToolInputError)\b/i.test(text) ||
    /^MCP error\b/i.test(text) ||
    /^FAILED \(slug=/i.test(text) ||
    /^NOT CONNECTED\b/i.test(text)
  ) {
    return { ok: false, error: text.slice(0, 2000), raw, error_kind: 'tool_error' };
  }
  return null;
}

export function normalizeCodeModeToolResult(
  method: string,
  out: unknown,
  opts: { sessionId?: string; callId?: string } = {},
): unknown {
  if (out == null || typeof out !== 'string') return out ?? null;
  const parked = opts.sessionId && opts.callId ? getToolOutput(opts.sessionId, opts.callId) : null;
  const raw = parked?.output ?? out;
  const shell = method === 'run_shell_command' || /^\s*exit_code:\s*/i.test(raw)
    ? parseShellToolOutput(raw, { callId: parked ? opts.callId : undefined, truncatedAtWrite: parked?.truncatedAtWrite })
    : null;
  if (shell) return shell;
  const direct = strictJsonParse(raw.trim());
  if (direct.ok) return direct.value;
  const toolError = parseToolErrorText(raw);
  if (toolError) return toolError;
  return raw;
}

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

/**
 * An external MCP tool routed through the namespaced shim, e.g.
 * "dataforseo__serp_organic_live_advanced". Shape check only (a `<server>__<tool>`
 * with non-empty halves; no local tool name contains a double underscore). These
 * are dispatched through the SAME shim the SDK Runner uses, so they inherit its
 * `decideToolApproval` gating — a destructive/admin MCP tool throws
 * `mcp.approval_blocked`; a read passes — i.e. full gate-parity with a discrete
 * MCP call. That shim gate (not the CODE_MODE_WRITES flag) is the safety boundary
 * for MCP, so MCP reads stay available even when in-program writes are off.
 */
export function isMcpNamespacedTool(method: string): boolean {
  const i = method.indexOf('__');
  return i > 0 && i + 2 < method.length && !READ_ONLY_TOOLS.has(method) && !WRITE_TOOLS.has(method);
}

/** Whether a clem.<method> is reachable: read-only local tools always; mutating
 *  local tools only when writes are enabled (Phase 2); external MCP tools always
 *  (gated by the shim's approval taxonomy). Everything else is refused. */
export function isCodeModeToolAllowed(method: string): boolean {
  if (READ_ONLY_TOOLS.has(method)) return true;
  if (codeModeWritesEnabled() && WRITE_TOOLS.has(method)) return true;
  if (isMcpNamespacedTool(method)) return true;
  return false;
}

/** Dispatch ONE clem.<method>(args) call through the gated tool path. Refuses
 *  anything outside the allowlist. A mutating call routes through the SAME
 *  wrapToolForHarness gate battery as a discrete call (gate-parity), so a gate
 *  block surfaces here as a thrown error the program/model can recover from.
 *  Shares `counter` across the program's calls (loop-guard + batch parity).
 *  Exported for tests. */
/** `clem.describe('tool_name')` — in-program schema lookup (strategic-wave
 *  Track 4). Programs are written blind against `clem.<tool>(args)`; the
 *  arg-shape bug class ({directory} vs {path}) costs a failed call + retry.
 *  describe() answers from host memory at zero context cost. Never throws —
 *  an unknown name reports allowed:false so the program can branch. */
type ExternalMcpTool = { name: string; description?: string; inputSchema?: unknown };
let externalMcpToolListForTest: (() => Promise<ExternalMcpTool[]>) | null = null;
/** Test seam: inject the external MCP tool list so describe()/listTools() can be
 *  tested without spawning real MCP servers. */
export function _setExternalMcpToolsForTests(fn: (() => Promise<ExternalMcpTool[]>) | null): void {
  externalMcpToolListForTest = fn;
}

/** The connected external MCP tools with their real schemas, via the same shim
 *  the dispatch path uses. Best-effort + cached by the shim — never throws (an
 *  unavailable shim just yields []). Shared by describe() and listTools(). */
async function externalMcpToolList(): Promise<ExternalMcpTool[]> {
  if (externalMcpToolListForTest) return externalMcpToolListForTest();
  try {
    const { getOrCreateExternalMcpServers } = await import('../runtime/mcp-servers.js');
    const shim = getOrCreateExternalMcpServers() as unknown as { listTools?: () => Promise<unknown> } | null;
    if (!shim || typeof shim.listTools !== 'function') return [];
    const tools = await shim.listTools();
    return Array.isArray(tools) ? (tools as Array<{ name: string; description?: string; inputSchema?: unknown }>) : [];
  } catch { return []; }
}

/** `clem.listTools()` — in-program DISCOVERY of the connected external MCP tools
 *  (name + short description) so a batching program can find what to call without
 *  the model guessing names. Host-answered, zero context cost, never throws. */
export async function listCodeModeTools(): Promise<unknown> {
  const mcp = await externalMcpToolList();
  return {
    builtin: [...READ_ONLY_TOOLS, ...(codeModeWritesEnabled() ? WRITE_TOOLS : [])].sort(),
    mcp: mcp.map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 120) })),
    note: mcp.length === 0
      ? 'no external MCP servers connected in this session'
      : 'call clem.describe("<name>") for a tool\'s full arg schema before calling it',
  };
}

type WorkerRunner = (input: WorkerToolInput, modelId: string, sessionId: string) => Promise<{ text: string; model: string }>;
let workerRunnerForTest: WorkerRunner | null = null;
/** Test seam: inject the worker runner so run_worker can be tested without a live model. */
export function _setCodeModeWorkerRunnerForTests(fn: WorkerRunner | null): void {
  workerRunnerForTest = fn;
}
async function runCodeModeWorker(input: WorkerToolInput, modelId: string, sessionId: string): Promise<{ text: string; model: string }> {
  if (workerRunnerForTest) return workerRunnerForTest(input, modelId, sessionId);
  const { runCrossProviderWorker } = await import('../agents/sub-agents.js');
  // KNOWN GAP (break-it 2026-07-11, medium): a killed program leaves its in-flight
  // workers running in the daemon (they self-terminate at their turn cap — bounded
  // waste — but a WEDGED provider call has no per-call timeout to rescue it). The
  // clean fix is an AbortSignal.timeout passed as a 4th arg; runCrossProviderWorker
  // does not yet accept a signal on this branch, so it's deferred until that lands
  // rather than reaching into the worker subsystem here.
  const r = await runCrossProviderWorker(input, modelId, sessionId);
  return { text: r.text, model: r.model };
}

/** `clem.run_worker(spec)` — spawn ONE bounded reasoning sub-agent from inside a
 *  program (Move 5 / G6). Returns { ok, text } or { ok:false, error } so the
 *  program can branch. Guards: (1) HARD depth ≤ 1 — refused inside a worker run
 *  (guardrailScopeId), so no worker-of-worker recursion; (2) a per-program count
 *  cap. The worker's own tool grants + read-only-worker boundary gate what it can
 *  do — spawning one is safe. */
async function dispatchCodeModeWorker(args: unknown, sessionId: string, counter?: ToolCallsCounter): Promise<unknown> {
  if (!codeModeWorkersEnabled()) {
    return { ok: false, error: 'run_worker is disabled in code mode (CLEMMY_CODE_MODE_WORKERS=off)' };
  }
  // RECURSION GUARD: guardrailScopeId is set ONLY on worker runs, so its presence
  // means this program is itself running inside a worker → refuse (depth ≤ 1).
  if (harnessRunContextStorage.getStore()?.guardrailScopeId) {
    return { ok: false, error: 'run_worker is not available inside a worker (no worker-of-worker). Do the reasoning inline, or return the items so the parent can fan them out.' };
  }
  // COUNT CAP per program run (keyed by the run's counter, like mutations).
  if (counter) {
    const used = programWorkerCounts.get(counter) ?? 0;
    if (used >= MAX_WORKERS_PER_PROGRAM) {
      return { ok: false, error: `run_worker limit reached (${MAX_WORKERS_PER_PROGRAM} per program). For a bigger fan-out, return the items and let the parent run a batch.` };
    }
    programWorkerCounts.set(counter, used + 1);
  }
  const parsed = WorkerToolInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `run_worker: invalid spec — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  try {
    const modelId = resolveRoleModel('worker').modelId;
    const { text, model } = await runCodeModeWorker(parsed.data, modelId, sessionId);
    return { ok: true, text, model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function describeCodeModeTool(name: unknown): Promise<unknown> {
  const toolName = typeof name === 'string' ? name : String((name as { tool?: unknown; name?: unknown })?.tool ?? (name as { name?: unknown })?.name ?? '');
  if (!toolName) return { error: 'describe: pass a tool name string, e.g. clem.describe("list_files")' };
  const allowed = isCodeModeToolAllowed(toolName);
  if (isMcpNamespacedTool(toolName)) {
    // Return the REAL schema from the shim's listTools so the model stops
    // guessing MCP arg shapes (the {directory}-vs-{path} bug class code mode is
    // meant to batch through). Falls back to the generic note if unavailable.
    const t = (await externalMcpToolList()).find((x) => x.name === toolName);
    if (t) {
      return {
        name: toolName,
        allowed,
        source: 'mcp',
        description: typeof t.description === 'string' ? t.description.slice(0, 600) : undefined,
        parameters: t.inputSchema,
        note: 'a destructive MCP call is still gated by its approval',
      };
    }
    return { name: toolName, allowed, source: 'mcp', note: 'external MCP tool not found in the connected set — call clem.listTools() to see what is available; a destructive call is still gated' };
  }
  const byName = await realToolsByName();
  const t = byName.get(toolName) as (InvokableTool & { description?: string; parameters?: unknown }) | undefined;
  if (!t) return { name: toolName, allowed: false, error: 'unknown tool — check the name (see the run_tool_program description for the built-in surface)' };
  return {
    name: toolName,
    allowed,
    source: 'local',
    ...(allowed ? {} : { note: WRITE_TOOLS.has(toolName) ? 'writes are disabled in code mode right now' : 'not in the code-mode allowlist' }),
    description: typeof t.description === 'string' ? t.description.slice(0, 600) : undefined,
    parameters: t.parameters ?? undefined,
  };
}

export async function dispatchCodeModeTool(method: string, args: unknown, sessionId: string, counter?: ToolCallsCounter): Promise<unknown> {
  // Host-answered helpers — never tool dispatches, never gated, never counted.
  if (method === 'describe') return describeCodeModeTool(args);
  if (method === 'listTools') return listCodeModeTools();
  if (method === 'run_worker') return dispatchCodeModeWorker(args, sessionId, counter);
  if (!isCodeModeToolAllowed(method)) {
    const why = WRITE_TOOLS.has(method) ? 'writes are disabled (set CLEMMY_CODE_MODE_WRITES=on)' : 'not in the code-mode allowlist';
    throw new Error(`code-mode: tool "${method}" is not available — ${why}`);
  }
  // HARD GUARD (2026-07-07): an IRREVERSIBLE external SEND (OUTLOOK_SEND_EMAIL,
  // *_PUBLISH, …) must NEVER run inside a code-mode program. Code mode has a 60s
  // wall-clock kill; a loop of N gated+judged sends cannot finish inside it, so
  // the program dies mid-batch — possibly after sending SOME — and the result is
  // lost, stranding the run in a re-verification loop (live 2026-07-07: 10
  // first-touch emails, run_tool_program timed out at 60s, 0 confirmed sent).
  // Sends belong in run_batch: one certification, a deterministic per-item loop
  // with its OWN per-item budget, honest ledger, and resumability. Refuse here so
  // the model is redirected BEFORE it burns 60s, not after.
  if (codeModeSendGuardEnabled()) {
    try {
      const { classifyExternalWrite } = await import('../runtime/harness/confirm-first-gate.js');
      const shape = classifyExternalWrite(method, args);
      if (shape.mutating && shape.irreversible) {
        throw new Error(
          `code-mode: refusing an irreversible external send (${shape.shapeKey ?? method}) inside run_tool_program — `
          + 'a code program\'s deadline would lose or partially-complete a batch of sends. '
          + 'Use run_batch for sends: propose ONE plan (tool composio_execute_tool, sideEffect "send", one item per recipient with fully-baked args), it certifies once, queues ONE approval, then executes deterministically with per-item gating and an honest ledger.',
        );
      }
      // Escalation guard (same class, reversible writes): a program LOOPING
      // mutations dies at the 60s cap mid-batch just like sends — the writes
      // that landed before the kill are lost to the model. Allow the first
      // couple (legit single-write programs), refuse the third with the same
      // redirect. Counted per PROGRAM RUN via its counter identity.
      if (shape.mutating && counter) {
        const soFar = (programMutationCounts.get(counter) ?? 0) + 1;
        programMutationCounts.set(counter, soFar);
        if (soFar > 2) {
          throw new Error(
            `code-mode: refusing the ${soFar}rd/th mutating call (${shape.shapeKey ?? method}) in ONE program — `
            + 'a mutation loop cannot finish inside the program deadline and dies mid-batch, losing track of completed writes. '
            + 'Use run_batch: one plan, one item per record, certified once, executed deterministically with a per-item ledger.',
          );
        }
      }
    } catch (err) {
      // A genuine guard trip (our Errors above) propagates; a classifier import/
      // parse failure must NOT block the call (fail-open to legacy behavior).
      if (err instanceof Error && err.message.startsWith('code-mode: refusing')) throw err;
    }
  }
  const callId = `codemode-${randomUUID()}`;
  // Observability: emit tool_called/tool_returned for each in-program call so the
  // trace drawer / Tasks board shows what a code-mode program did (parity with
  // discrete calls; `codeMode:true` tags them for adoption measurement).
  try { appendEvent({ sessionId, turn: 0, role: 'Clem', type: 'tool_called', data: { tool: method, callId, codeMode: true, args: JSON.stringify(args ?? {}).slice(0, 300) } }); } catch { /* telemetry never blocks */ }
  try {
    const out = isMcpNamespacedTool(method)
      ? await dispatchCodeModeMcpTool(method, args)
      : await dispatchCodeModeLocalTool(method, args, sessionId, callId, counter);
    const normalized = normalizeCodeModeToolResult(method, out, { sessionId, callId });
    try { appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: method, callId, ok: true, codeMode: true, preview: (typeof normalized === 'string' ? normalized : JSON.stringify(normalized ?? '')).slice(0, 400) } }); } catch { /* best-effort */ }
    return normalized;
  } catch (err) {
    try { appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: method, callId, ok: false, codeMode: true, error: (err instanceof Error ? err.message : String(err)).slice(0, 400) } }); } catch { /* best-effort */ }
    throw err;
  }
}

/** A local clem tool: route through wrapToolForHarness (the full bracket gate
 *  battery) under the shared run-context, exactly as before. */
async function dispatchCodeModeLocalTool(method: string, args: unknown, sessionId: string, callId: string, counter?: ToolCallsCounter, certifiedBatch?: { batchId: string; payloadHash: string }): Promise<unknown> {
  const real = (await realToolsByName()).get(method);
  if (!real || typeof real.invoke !== 'function') {
    throw new Error(`code-mode: unknown tool "${method}"`);
  }
  // SEND FLOOR (2026-07-09 bypass hunt, Hole 1): call_tool / code-mode dispatch
  // by calling wrapped.invoke() DIRECTLY — bypassing the SDK's per-tool
  // needsApproval hook. So an irreversible SEND reached this way never parks
  // for a card. Refuse it here unless it rides an approved certified batch:
  // irreversible sends must go through run_batch (the deterministic, approved
  // primitive) or a first-class call (which hits the SDK approval hook). Reads
  // and reversible writes are unaffected.
  if (!certifiedBatch) {
    const { classifyExternalWrite } = await import('../runtime/harness/confirm-first-gate.js');
    const shape = classifyExternalWrite(method, args);
    if (shape.mutating && shape.irreversible) {
      throw new Error(
        `SEND_REQUIRES_APPROVAL: "${method}" is an irreversible external send and cannot be dispatched through call_tool/code-mode (which bypass the approval card). `
        + 'Use run_batch to send (propose → the user approves the card → it executes), or call the tool first-class so it gets its approval prompt.',
      );
    }
  }
  const wrapped = wrapToolForHarness(real as never) as InvokableTool;
  const runContext = { context: { sessionId } };
  const details = { toolCall: { callId } };
  // `certifiedBatch` is threaded into the run context ONLY on the batch runner's
  // approved execute path (dispatchBatchItemTool passes it); the ad-hoc code-mode
  // path leaves it undefined, so ad-hoc writes keep full per-item judging.
  // BOTH ALS contexts must be established: withHarnessRunContext carries the
  // GATE state, but tools that read their session via getToolOutputContext()
  // (dispatch_background_task among them) need the tool-output context too —
  // without it every catalog-tier context-reading tool reached through
  // call_tool/code-mode refused with "no session context here" (live
  // 2026-07-09: background handoff looked broken on every chat surface).
  return withToolOutputContext({ sessionId, callId, toolName: method }, () =>
    // codeMode:true exempts these reads from the deterministic read-fanout block —
    // a program's batched reads ARE the sanctioned execution the block steers to.
    withHarnessRunContext({ sessionId, counter: counter ?? new ToolCallsCounter(1000), codeMode: true, ...(certifiedBatch ? { certifiedBatch } : {}) }, () =>
      wrapped.invoke!(runContext, JSON.stringify(args ?? {}), details),
    ),
  );
}

/** An external MCP tool: route through the SAME namespaced shim the SDK Runner
 *  uses, so it inherits the shim's `decideToolApproval` gating + server-health
 *  checks — gate-parity with a discrete MCP call (a destructive/admin tool throws
 *  `mcp.approval_blocked`; a read passes). The shim is loaded lazily to keep the
 *  MCP/SDK module graph off code-mode's static surface. */
async function dispatchCodeModeMcpTool(method: string, args: unknown): Promise<unknown> {
  const { getOrCreateExternalMcpServers } = await import('../runtime/mcp-servers.js');
  const shim = getOrCreateExternalMcpServers() as unknown as {
    listTools?: () => Promise<unknown>;
    callTool: (name: string, args: Record<string, unknown> | null) => Promise<unknown>;
  } | null;
  if (!shim || typeof shim.callTool !== 'function') {
    throw new Error(`code-mode: no MCP servers are configured (cannot call "${method}")`);
  }
  // The SDK Runner always lists before it calls; mirror that so the shim's
  // tool→server routing map exists before callTool resolves the name.
  if (typeof shim.listTools === 'function') { try { await shim.listTools(); } catch { /* routing rebuilds on call */ } }
  const argObj = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  return shim.callTool(method, argObj);
}

/**
 * Batch-runner dispatch: same two gated lanes as code mode (local wrapped tool /
 * namespaced MCP shim), WITHOUT the code-mode allowlist. The batch runner's
 * authority model is different: a READ plan may call read tools freely, and a
 * WRITE plan only executes after its exact payloads were certified and approved
 * as ONE pending action — so the code-mode CLEMMY_CODE_MODE_WRITES switch does
 * not govern it. Every per-call runtime gate still fires: local tools route
 * through wrapToolForHarness (write boundary, guardrails, telemetry) and MCP
 * tools through the shim's decideToolApproval. Telemetry parity via the same
 * tool_called/tool_returned events with batchMode:true.
 */
export async function dispatchBatchItemTool(
  method: string,
  args: unknown,
  sessionId: string,
  counter: ToolCallsCounter,
  certifiedBatch?: { batchId: string; payloadHash: string },
): Promise<unknown> {
  const callId = `batch-${randomUUID()}`;
  try { appendEvent({ sessionId, turn: 0, role: 'Clem', type: 'tool_called', data: { tool: method, callId, batchMode: true, args: JSON.stringify(args ?? {}).slice(0, 300) } }); } catch { /* telemetry never blocks */ }
  try {
    const out = isMcpNamespacedTool(method)
      ? await dispatchCodeModeMcpTool(method, args)
      : await dispatchCodeModeLocalTool(method, args, sessionId, callId, counter, certifiedBatch);
    try { appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: method, callId, ok: true, batchMode: true, preview: (typeof out === 'string' ? out : JSON.stringify(out ?? '')).slice(0, 400) } }); } catch { /* best-effort */ }
    if (typeof out !== 'string') return out ?? null;
    try { return JSON.parse(out); } catch { return out; }
  } catch (err) {
    try { appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: method, callId, ok: false, batchMode: true, error: (err instanceof Error ? err.message : String(err)).slice(0, 400) } }); } catch { /* best-effort */ }
    throw err;
  }
}

/** Run a code-mode program for a session. ONE counter spans all in-program calls
 *  so loop-guard + batch gates see the program as a single turn (gate-parity). */
export async function runCodeModeForSession(program: string, sessionId: string): Promise<CodeModeResult> {
  const counter = new ToolCallsCounter(1000);
  const startedAt = Date.now();
  const result = await runCodeModeProgram(
    program,
    (method, args) => dispatchCodeModeTool(method, args, sessionId, counter),
    {
      // clem.progress('…') → the same live-activity spine batch uses, so a long
      // program reads as supervised instead of a frozen spinner.
      onProgress: (message) => {
        try { appendEvent({ sessionId, turn: 0, role: 'system', type: 'codemode_progress', data: { message } }); } catch { /* narration never blocks */ }
      },
      // Oversized return → park the FULL value in the tool-output store and hand
      // the model a recall_tool_result handle instead of a mid-structure cut.
      onLargeResult: (fullJson) => {
        try {
          const handle = `codemode-result-${randomUUID()}`;
          writeToolOutput({ sessionId, callId: handle, tool: 'run_tool_program', output: fullJson });
          return handle;
        } catch { return null; }
      },
    },
  );
  // ONE summary event per program — the adoption/efficiency measurement the
  // mandate's DELETE-WHEN-VALIDATED note is waiting on. intermediateBytes is what
  // stayed in the sandbox; returnBytes is what actually entered context; savedBytes
  // is the token-proxy win an aggregator sums to prove (or disprove) the benefit.
  try {
    const returnBytes = result.ok ? JSON.stringify(result.value ?? null).length : 0;
    const intermediateBytes = result.intermediateBytes ?? 0;
    appendEvent({
      sessionId, turn: 0, role: 'system', type: 'codemode_program_summary',
      data: {
        ok: result.ok,
        rpcCalls: result.rpcCalls,
        durationMs: Date.now() - startedAt,
        intermediateBytes,
        returnBytes,
        savedBytes: Math.max(0, intermediateBytes - returnBytes),
        ...(result.partial ? { completed: result.partial.completed, failed: result.partial.failed } : {}),
        ...(result.ok ? {} : { error: (result.error ?? '').slice(0, 300) }),
      },
    });
  } catch { /* telemetry never blocks */ }
  return result;
}

export function codeModeDescription(): string {
  const writes = codeModeWritesEnabled();
  const surface = [...READ_ONLY_TOOLS, ...(writes ? WRITE_TOOLS : [])].join(', ');
  const fetchTools = writes ? 'composio_execute_tool(...) and MCP tools' : 'MCP tools';
  return [
    'Run ONE short JavaScript program (the body of an async function — use `return` for the result) against the `clem` API instead of emitting many separate tool calls.',
    'Use this for DATA-HEAVY or MULTI-STEP work — loop/filter/paginate/aggregate over many items and `return` only the distilled result, so the large intermediate tool outputs never enter the conversation.',
    'The API is `clem.<tool>(args)` returning a Promise; built-in tools: ' + surface + '.',
    '`run_shell_command` is normalized inside code mode: it returns `{ ok, exit_code, stdout, stderr, raw, stdout_json? }`, not the model-facing `exit_code:\\nstdout:` text wrapper. For JSON-emitting CLIs, use `result.stdout_json ?? JSON.parse(result.stdout)`; never parse the whole tool result.',
    'Obvious upstream tool-error banners return structured `{ ok:false, error, raw }`; branch on `ok === false` instead of trying to parse them as data.',
    'You can ALSO call any connected external MCP tool here by its `<server>__<tool>` name — e.g. `await clem["dataforseo__serp_organic_live_advanced"]({...})` — and they run through the SAME gates as a normal MCP call.',
    'BEST USE — do the FETCHES inside the program: for several DataForSEO / SEO / analytics / Salesforce lookups, call ' + fetchTools + ' here (Promise.all the independent ones), distill, and `return` only the small result — NOT many discrete tool calls each dumping raw JSON into the conversation.',
    writes
      ? 'Writes ARE allowed and pass the SAME approval/grounding/destination gates as a normal tool call — a blocked write throws inside your program (catch it or let it surface).'
      : 'Local writes are off, but MCP reads work; a destructive MCP tool is still blocked by its approval gate.',
    'Example: `const [a,b] = await Promise.all([clem["dataforseo__serp_organic_live_advanced"]({...}), clem["dataforseo__serp_organic_live_advanced"]({...})]); return { aTop: a.items?.[0], bTop: b.items?.[0] };`',
    'Helpers (free — host-answered, not tool calls): `await clem.listTools()` lists the connected external MCP tools (names + descriptions) so you know what is callable; `await clem.describe("tool_name")` returns a tool\'s REAL arg schema — including external MCP tools — so check it before guessing arg shapes; `await clem.progress("34/60 fetched")` narrates status to the user.',
    'FAN-OUT: `await clem.run_worker({ objective, item, resolvedTools, context, instructions, expectedOutput, intent })` runs ONE isolated reasoning sub-agent and returns `{ ok, text }` — use it to fetch/aggregate, then fan reasoning out over the interesting subset (Promise.all a few for parallelism). Bounded: at most 4 per program, and a worker cannot itself call run_worker (no worker-of-worker). For a large uniform per-item batch, prefer run_batch.',
    'Sandboxed: no network, no filesystem, no other modules — only `clem` calls reach Clementine. Tool-call budget applies; a program is killed after ~20s with NO tool activity (an actively-fetching program can run to a ~3-minute ceiling). If it is killed mid-run you receive the completed calls\' results as PARTIAL RESULTS — salvage them, only redo what is missing.',
    'HARD LIMIT: this is for READ-ONLY aggregation. NEVER loop irreversible external SENDS/writes (email send, publish) inside it — a batch of gated sends cannot finish inside the program ceiling, so it dies mid-batch and loses track of what was sent. For ANY batch of sends/writes use `run_batch` instead (it certifies once, then runs a deterministic per-item loop with its own budget and an honest ledger). An irreversible send attempted here is refused.',
  ].join(' ');
}

/**
 * Format a FAILED program for the model so it can FIX and re-run instead of
 * blindly re-emitting. Surfaces (in order): the error, the cleaned stderr detail
 * — a SyntaxError with the user's own line number, or console breadcrumbs, both
 * previously DROPPED behind the generic "exited (1)" — then any salvaged partial
 * results. Exported for testing.
 */
export function formatCodeModeFailure(result: CodeModeResult): string {
  const lines = [`code-mode program failed: ${result.error}`];
  const detail = cleanCodeModeStderr(result.logs);
  if (detail) lines.push(`Program error output (fix and re-run):\n${detail}`);
  // A failed program still hands over what its completed calls produced —
  // salvage beats redoing every fetch (Track 4: partial results).
  if (result.partial && result.partial.completed > 0) {
    lines.push(
      `PARTIAL RESULTS SALVAGED — ${result.partial.completed} call(s) completed, ${result.partial.failed} failed before the abort. Most recent completed results (previews):`,
      JSON.stringify(result.partial.recent.filter((r) => r.ok).slice(-10)),
      'Use these instead of re-fetching; only redo what is missing.',
    );
  }
  return lines.join('\n');
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
      return formatCodeModeFailure(result);
    },
  });
}
