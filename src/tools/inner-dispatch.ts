/**
 * inner-dispatch — the nested tool-dispatch lane shared by `run_batch`,
 * `call_tool`, `work_call`, and the pending-action executor: one gated path
 * that resolves a named inner tool (local wrapped tool or exact native-MCP port)
 * and dispatches it with full gate parity to a discrete call.
 *
 * This module is deliberately a transport primitive, not a model-visible
 * execution mode. Reads fan out through the model's own parallel calls and
 * deterministic same-shape work goes through `run_batch`; both reuse this one
 * inner gate chain instead of owning a second dispatcher.
 */
import { randomUUID } from 'node:crypto';
import {
  wrapToolForHarness,
  withHarnessRunContext,
  ToolCallsCounter,
  ToolCallsLimitExceeded,
  harnessRunContextStorage,
  pendingActionApprovalRequiredError,
  pendingNestedToolApprovalRequiredError,
} from '../runtime/harness/brackets.js';
import {
  appendEvent,
  getToolOutputForInvocation,
  resolveToolOutputForAuthority,
} from '../runtime/harness/eventlog.js';
import { withToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';
import { deriveInnerDispatchSets } from './tool-registry.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import { mcpToolAllowedByScope, stripMcpToolCarrier } from '../runtime/mcp-tool-authority.js';
import { toolOutputLooksSuccessful } from '../runtime/harness/tool-evidence.js';
import type { PendingActionExecutionCapability } from '../runtime/harness/pending-actions.js';
import {
  invokeAcceptedExactMcpCarrier,
} from '../runtime/harness/accepted-mcp-carrier.js';
import { isolatedTestContractActive } from '../runtime/harness/isolated-test-contract.js';
import {
  consumeAcceptedTaskNestedApprovalAdmission,
  consumeNestedCallAdmission,
  issueStagedParentCallAdmission,
} from '../runtime/harness/nested-tool-approval-admission.js';
// NB: getCoreTools is reached via DYNAMIC import in realToolsByName() — a static
// import would form a registry ↔ inner-dispatch cycle. The dynamic import
// resolves at first dispatch, by when the registry module is fully loaded.


function currentEventAttribution(): { sourceUserSeq?: number; runScopeId?: string } {
  const ctx = harnessRunContextStorage.getStore();
  return {
    ...(Number.isSafeInteger(ctx?.sourceUserSeq) && (ctx?.sourceUserSeq ?? 0) > 0
      ? { sourceUserSeq: ctx?.sourceUserSeq as number }
      : {}),
    ...(ctx?.behaviorScopeId ? { runScopeId: ctx.behaviorScopeId } : {}),
  };
}

// Registry-derived surfaces (step-2 flip, strategic-wave Track 1a): the
// hand-curated sets are gone — the registry's `innerDispatch` axis is the one
// truth, proven set-equal by the conformance test before the flip. Adding a
// tool to nested dispatch is now ONE registry field, not a second hand list.
// run_worker stays excluded via the registry (worker-of-worker recursion is
// out of scope); every write here still routes through wrapToolForHarness so
// the write-boundary gates cover it with NO new gate code.
const innerDispatchSets = deriveInnerDispatchSets();

/** Phase 2 mutating surface (registry-derived). */
export const WRITE_TOOLS: ReadonlySet<string> = innerDispatchSets.write;

/** Read-only tools available to the nested dispatcher (registry-derived). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = innerDispatchSets.readOnly;

type InvokableTool = { name: string; invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

export interface InnerDispatchShellResult {
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

export function parseShellToolOutput(raw: string, opts: { callId?: string; truncatedAtWrite?: boolean } = {}): InnerDispatchShellResult | null {
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

  const result: InnerDispatchShellResult = {
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
    /^(?:⚠️\s*)?(?:composio_execute_tool\s+)?FAILED\b/i.test(text) ||
    /^NOT CONNECTED\b/i.test(text)
  ) {
    return { ok: false, error: text.slice(0, 2000), raw, error_kind: 'tool_error' };
  }
  return null;
}

export function normalizeInnerDispatchToolResult(
  method: string,
  out: unknown,
  opts: { sessionId?: string; callId?: string; settlementNonce?: string } = {},
): unknown {
  // Nested dispatch owns the nonce for this exact child invocation. Prefer that
  // row: it is safe before/independent of presentation clipping and cannot be
  // confused with another invocation that reused an SDK call id. Detached
  // callers retain the lifecycle-based compatibility resolver.
  const exactInvocation = opts.sessionId && opts.callId && opts.settlementNonce
    ? getToolOutputForInvocation(opts.sessionId, opts.callId, opts.settlementNonce)
    : null;
  const exactParked = exactInvocation?.tool === method ? exactInvocation : null;
  const resolution = !exactParked && opts.sessionId && opts.callId
    ? resolveToolOutputForAuthority(opts.sessionId, opts.callId)
    : null;
  const parked = exactParked ?? (resolution?.status === 'ok' ? resolution.record : null);
  if (parked?.truncatedAtWrite) {
    return {
      ok: false,
      error_kind: 'truncated_tool_output',
      error: `Tool result "${opts.callId}" is incomplete (${parked.contentBytes} original bytes; legacy truncation or missing/corrupt durable chunks), so nested dispatch will not consume the parked prefix. Re-read/page the provider source until every page is present, or stage the full result as a file and read that artifact.`,
      truncated_at_write: true,
      ...(opts.callId ? { result_handle: opts.callId } : {}),
    };
  }
  // MCP transports return a structured presentation array. When this exact
  // invocation parked a serializable normalized envelope, consume those bytes
  // instead of short-circuiting on the array's non-string carrier.
  if (!parked && (out == null || typeof out !== 'string')) return out ?? null;
  const raw = parked?.output ?? (out as string);
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
export function _setInnerDispatchToolsForTests(map: Map<string, InvokableTool> | null): void {
  toolsByName = map;
}

/**
 * Shape recognition for an external MCP operation, e.g.
 * "dataforseo__serp_organic_live_advanced". Shape check only (a `<server>__<tool>`
 * with non-empty halves; no local tool name contains a double underscore).
 * Shape grants nothing: accepted execution reopens the host's exact immutable
 * manifest/catalog/account/schema/port binding at the final edge.
 */
export function isMcpNamespacedTool(method: string): boolean {
  const i = method.indexOf('__');
  return i > 0 && i + 2 < method.length && !READ_ONLY_TOOLS.has(method) && !WRITE_TOOLS.has(method);
}

type ExternalMcpShim = {
  listTools?: () => Promise<unknown>;
  callTool: (name: string, args: Record<string, unknown> | null) => Promise<unknown>;
};
let externalMcpResolverForTest:
  | ((toolName: string, scope: McpToolScope | null | undefined) => ExternalMcpShim | null)
  | null = null;
/** Isolated compatibility seam for older gate-parity fixtures. Production
 * ignores it completely and has no shim/listTools execution fallback. */
export function _setInnerDispatchMcpResolverForTests(
  fn: ((toolName: string, scope: McpToolScope | null | undefined) => ExternalMcpShim | null) | null,
): void {
  externalMcpResolverForTest = fn;
}

/** Compatibility only for isolated unit/vertical fixtures.  Production never
 * treats this resolver as execution authority. */
export function _innerDispatchLegacyMcpTestResolverActive(): boolean {
  return isolatedTestContractActive() && externalMcpResolverForTest !== null;
}

export function inheritedNestedHarnessContext(sessionId: string): Partial<Pick<
  NonNullable<ReturnType<typeof harnessRunContextStorage.getStore>>,
  | 'sourceUserSeq'
  | 'behaviorScopeId'
  | 'guardrailScopeId'
  | 'workerScope'
  | 'recallBudget'
  | 'turnRecallRunIds'
  | 'mcpToolScope'
  | 'dispatchLease'
  | 'runAttemptId'
>> {
  const parent = harnessRunContextStorage.getStore();
  if (!parent || parent.sessionId !== sessionId) return {};
  // Preserve attempt authority and per-run accounting across a carrier's nested
  // ALS context. Never inherit certifiedBatch implicitly: only the batch
  // executor's byte-pinned argument may grant that optimization.
  return {
    ...(parent.sourceUserSeq ? { sourceUserSeq: parent.sourceUserSeq } : {}),
    ...(parent.behaviorScopeId ? { behaviorScopeId: parent.behaviorScopeId } : {}),
    ...(parent.guardrailScopeId ? { guardrailScopeId: parent.guardrailScopeId } : {}),
    ...(parent.workerScope === true ? { workerScope: true } : {}),
    ...(parent.mcpToolScope !== undefined ? { mcpToolScope: parent.mcpToolScope } : {}),
    ...(parent.dispatchLease ? { dispatchLease: parent.dispatchLease } : {}),
    ...(parent.runAttemptId ? { runAttemptId: parent.runAttemptId } : {}),
    // recallBudget is deliberately NOT inherited (live 2026-07-24): the budget
    // protects the MODEL's context window, but an inner recall never enters
    // model context — only the carrier's clipped output does. Inheriting
    // it capped a 100-item resume at 3 recalls; calls 4+ returned the budget
    // error, and 60 accounts of good banked data were declared "malformed" —
    // triggering a full wasteful re-scrape. Inner recalls stay bounded by the
    // tool-call counter and carrier timeout.
    ...(parent.turnRecallRunIds ? { turnRecallRunIds: parent.turnRecallRunIds } : {}),
  };
}

async function dispatchInnerLocalTool(method: string, args: unknown, sessionId: string, callId: string, counter?: ToolCallsCounter, certifiedBatch?: { batchId: string; payloadHash: string }, batchItem?: boolean): Promise<unknown> {
  const real = (await realToolsByName()).get(method);
  if (!real || typeof real.invoke !== 'function') {
    throw new Error(`inner-dispatch: unknown tool "${method}"`);
  }
  const exactHostAdmission = !certifiedBatch
    && (
      consumeNestedCallAdmission({ sessionId, toolName: method, args })
      // Transitional replay compatibility for paused states issued before the
      // generic single-consent cut. New host_v1 calls never mint this token.
      || consumeAcceptedTaskNestedApprovalAdmission({ sessionId, toolName: method, args })
    );
  if (exactHostAdmission) {
    // Mint the process-opaque staged parent hand-off at the same exact inner
    // edge that consumed consent/work authority. Ordinary tools ignore it;
    // a file-bearing provider adapter may consume it once after its pure
    // resolver has frozen the final provider-ready contract.
    issueStagedParentCallAdmission({ sessionId, toolName: method, args });
  }
  // SEND FLOOR (2026-07-09 bypass hunt, Hole 1): nested dispatch
  // by calling wrapped.invoke() DIRECTLY — bypassing the SDK's per-tool
  // needsApproval hook. So an irreversible SEND reached this way never parks
  // for a card. Refuse it here unless it rides an approved certified payload,
  // and point the model at the typed pending-action graph so one exact card can
  // authorize one exact call. Reads and reversible writes are unaffected.
  if (!certifiedBatch) {
    const { classifyExternalWrite } = await import('../runtime/harness/confirm-first-gate.js');
    const shape = classifyExternalWrite(method, args);
    if (shape.mutating && shape.irreversible && !exactHostAdmission) {
      // This floor runs before wrapToolForHarness, so it must account for the
      // refused attempt itself. Otherwise repeated nested sends can request the
      // same recovery forever while consuming zero of the ambient turn budget.
      if (counter) {
        if (counter.willExceed()) throw new ToolCallsLimitExceeded(counter.limit);
        counter.increment();
      }
      throw pendingActionApprovalRequiredError(method, args);
    }

    // EXECUTE/WRITE PARITY (2026-07 bypass hunt): the direct wrapped.invoke()
    // below ALSO skips the tool's OWN needsApproval hook — where
    // run_shell_command's danger classifier and the read/write sensitive-path
    // checks live. classifyExternalWrite (above) only recognizes SEND-class
    // irreversibility, so a danger-classified shell command or a sensitive-path
    // write reached via call_tool/inner dispatch would otherwise run card-free.
    // Consult the real tool's hook with the SAME sessionId-scoped runContext the
    // invoke uses, so plan-scope / workspace / yolo policy resolve IDENTICALLY to
    // a direct tool call — this is gate-parity, not a new gate. Fail CLOSED: a
    // hook that throws is treated as needs-approval, never a silent grant.
    const approvalHook = (real as { needsApproval?: unknown }).needsApproval;
    let hookRequiresApproval = false;
    if (approvalHook === true) {
      hookRequiresApproval = true;
    } else if (typeof approvalHook === 'function') {
      try {
        hookRequiresApproval =
          (await (approvalHook as (rc: unknown, input: unknown) => unknown)({ context: { sessionId } }, args)) === true;
      } catch {
        hookRequiresApproval = true;
      }
    }
    if (hookRequiresApproval && !exactHostAdmission) {
      if (counter) {
        if (counter.willExceed()) throw new ToolCallsLimitExceeded(counter.limit);
        counter.increment();
      }
      throw pendingNestedToolApprovalRequiredError(method, args);
    }
  }
  const wrapped = wrapToolForHarness(real as never) as InvokableTool;
  const runContext = { context: { sessionId } };
  const details = { toolCall: { callId } };
  // `certifiedBatch` is threaded into the run context ONLY on the batch runner's
  // approved execute path (dispatchBatchItemTool passes it); other nested calls
  // leave it undefined, so ad-hoc writes keep full per-item judging.
  // BOTH ALS contexts must be established: withHarnessRunContext carries the
  // GATE state, but tools that read their session via getToolOutputContext()
  // (dispatch_background_task among them) need the tool-output context too —
  // without it every catalog-tier context-reading tool reached through
  // call_tool/inner dispatch refused with "no session context here" (live
  // 2026-07-09: background handoff looked broken on every chat surface).
  return withToolOutputContext({ sessionId, callId, toolName: method }, () =>
    // nestedDispatch:true exempts these calls from the direct-read fanout block.
    withHarnessRunContext({
      ...inheritedNestedHarnessContext(sessionId),
      sessionId,
      counter: counter ?? new ToolCallsCounter(1000),
      nestedDispatch: true,
      ...(certifiedBatch ? { certifiedBatch } : {}),
      ...(batchItem ? { batchItem: true } : {}),
    }, () =>
      wrapped.invoke!(runContext, JSON.stringify(coerceJsonStringParams(method, args) ?? {}), details),
    ),
  );
}

/** Boundary tolerance (live 2026-08-20 sess-synthetic-010: a fan-out steer sent the
 *  model to batch Slack reads in a program, and EVERY inner
 *  composio_execute_tool failed "InvalidToolInputError: Invalid JSON input"
 *  — the program passed `arguments` as an OBJECT where the schema demands a
 *  JSON STRING. 71 fan-out blocks and 547 calls later the turn died between
 *  two locked doors.) Models writing code will always pass objects; the
 *  dispatch coerces object-valued JSON-string params instead of refusing.
 *  Fail-repair over fail-closed — the schema still validates everything else. */
export const _coerceJsonStringParamsForTest = (method: string, args: unknown): unknown => coerceJsonStringParams(method, args);

function coerceJsonStringParams(method: string, args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  for (const key of ['arguments', 'args_json', 'input_json']) {
    const value = out[key];
    if (value && typeof value === 'object') {
      try { out[key] = JSON.stringify(value); } catch { /* leave as-is; schema reports */ }
    }
  }
  void method;
  return out;
}

/** An external MCP tool: redeem the host-prepared exact admission and invoke
 *  the immutable native-MCP port registered for that manifest.  Metadata
 *  enumeration and the namespace shim are discovery surfaces, never execution
 *  authority at this edge.
 *
 *  Runs under `nestedDispatch: true` harness context (mirroring the local lane)
 *  so the carrier and its child retain one logical identity. */
async function dispatchInnerMcpTool(
  method: string,
  args: unknown,
  sessionId: string,
  callId: string,
  counter?: ToolCallsCounter,
  certifiedBatch?: { batchId: string; payloadHash: string },
  batchItem?: boolean,
  scopeOverride?: McpToolScope | null,
  pendingActionExecution?: PendingActionExecutionCapability,
  exactMcpRequiresNestedAdmission = false,
): Promise<unknown> {
  const executableMethod = stripMcpToolCarrier(method);
  const scope = scopeOverride !== undefined
    ? scopeOverride
    : harnessRunContextStorage.getStore()?.mcpToolScope;
  const argObj = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const activeCounter = counter ?? new ToolCallsCounter(1000);
  return withHarnessRunContext(
    {
      ...inheritedNestedHarnessContext(sessionId),
      sessionId,
      counter: activeCounter,
      nestedDispatch: true,
      ...(certifiedBatch ? { certifiedBatch } : {}),
      ...(pendingActionExecution ? { pendingActionExecution } : {}),
      ...(pendingActionExecution?.sourceUserSeq
        ? { sourceUserSeq: pendingActionExecution.sourceUserSeq }
        : {}),
      ...(batchItem ? { batchItem: true } : {}),
    },
    () => withToolOutputContext(
      { sessionId, callId, toolName: executableMethod },
      async () => {
        // Existing isolated tests inject a fake shim to exercise the surrounding
        // call_tool gates. Keep that explicit fixture seam, but make it inert in
        // every non-test process. It is not a production fallback.
        if (_innerDispatchLegacyMcpTestResolverActive()) {
          if (!mcpToolAllowedByScope(method, scope)) {
            throw new Error(`MCP_SCOPE_DENIED: inner-dispatch tool "${method}" is outside this turn's external MCP scope`);
          }
          const shim = externalMcpResolverForTest!(executableMethod, scope);
          if (!shim || typeof shim.callTool !== 'function') {
            throw new Error(`inner-dispatch: no isolated MCP fixture is configured (cannot call "${method}")`);
          }
          if (typeof shim.listTools === 'function') {
            try { await shim.listTools(); } catch { /* isolated compatibility */ }
          }
          return shim.callTool(executableMethod, argObj);
        }
        return invokeAcceptedExactMcpCarrier({
          requestedOperationId: executableMethod,
          args: argObj,
          sessionId,
          counter: activeCounter,
          requiresNestedAdmission: exactMcpRequiresNestedAdmission,
        });
      },
    ),
  );
}

/**
 * Batch-runner dispatch: the same two gated lanes (local wrapped tool /
 * exact native-MCP carrier), WITHOUT the nested-dispatch allowlist. The batch runner's
 * authority model is different: a READ plan may call read tools freely, and a
 * WRITE plan only executes after its exact payloads were certified and approved
 * as ONE pending action — so no writes flag governs it. Every per-call runtime gate still fires: local tools route
 * through wrapToolForHarness (write boundary, guardrails, telemetry) and MCP
 * tools through their exact host-bound port. Telemetry parity via the same
 * tool_called/tool_returned events with batchMode:true.
 */
export async function dispatchBatchItemTool(
  method: string,
  args: unknown,
  sessionId: string,
  counter: ToolCallsCounter,
  certifiedBatch?: { batchId: string; payloadHash: string },
  telemetry?: { accounting?: 'transport_mirror'; canonicalCallId?: string },
  mcpToolScopeOverride?: McpToolScope | null,
  pendingActionExecution?: PendingActionExecutionCapability,
  exactMcpRequiresNestedAdmission = false,
): Promise<unknown> {
  // `call_tool` is a transport mirror of the model's existing invocation, so
  // its inner bracket must carry the same logical id.  A real batch item has no
  // canonical parent id and therefore receives a fresh child call as before.
  const callId = telemetry?.accounting === 'transport_mirror'
    && typeof telemetry.canonicalCallId === 'string'
    && telemetry.canonicalCallId.trim().length > 0
    ? telemetry.canonicalCallId
    : `batch-${randomUUID()}`;
  const telemetryData = {
    ...currentEventAttribution(),
    ...(telemetry?.accounting ? { accounting: telemetry.accounting } : {}),
    ...(telemetry?.canonicalCallId ? { canonicalCallId: telemetry.canonicalCallId } : {}),
  };
  // call_tool/work_call reuse this dispatcher as a transport mirror of one
  // ordinary inner invocation; they are not batch items. Marking them as a
  // batch item suppressed normal artifact claiming/content contracts, so a
  // generated Sheet created through the production work carrier could never
  // connect to its exact readback. Calls without mirror telemetry are genuine
  // batch items and retain the existing outer-owned artifact behavior.
  const batchItem = telemetry?.accounting !== 'transport_mirror';
  try { appendEvent({ sessionId, turn: 0, role: 'Clem', type: 'tool_called', data: { tool: method, callId, batchMode: batchItem, ...telemetryData, args: JSON.stringify(args ?? {}).slice(0, 300) } }); } catch { /* telemetry never blocks */ }
  try {
    const out = isMcpNamespacedTool(method)
      ? await dispatchInnerMcpTool(
          method,
          args,
          sessionId,
          callId,
          counter,
          certifiedBatch,
          batchItem,
          mcpToolScopeOverride,
          pendingActionExecution,
          exactMcpRequiresNestedAdmission,
        )
      : await dispatchInnerLocalTool(method, args, sessionId, callId, counter, certifiedBatch, batchItem);
    const ok = toolOutputLooksSuccessful(out);
    try { appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: method, callId, ok, batchMode: batchItem, ...telemetryData, preview: (typeof out === 'string' ? out : JSON.stringify(out ?? '')).slice(0, 400) } }); } catch { /* best-effort */ }
    if (typeof out !== 'string') return out ?? null;
    try { return JSON.parse(out); } catch { return out; }
  } catch (err) {
    try { appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { tool: method, callId, ok: false, batchMode: batchItem, ...telemetryData, error: (err instanceof Error ? err.message : String(err)).slice(0, 400) } }); } catch { /* best-effort */ }
    throw err;
  }
}
