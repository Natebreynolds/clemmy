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
import {
  assertDispatchLeaseCurrent,
  parseDispatchLease,
  type DispatchLeaseRef,
} from '../runtime/harness/dispatch-lease.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { toolOutputLooksSuccessful } from '../runtime/harness/tool-evidence.js';
import { toolCallCorrelationFingerprint } from '../runtime/harness/tool-correlation.js';
import {
  claimClaudeLocalPermissionAdmission,
} from '../runtime/harness/claude-local-tool-correlation.js';
import {
  settledReadRepeatReplayDisposition,
} from '../runtime/harness/settled-read-repeat.js';
import { runtimeToolAccountingMetadata } from '../runtime/harness/tool-effect.js';
import { isHarnessRefusalText, textResult } from './shared.js';

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
 * plan-scope. Worker Composio mutations are still refused centrally: workers
 * compose exact payloads, and the parent freezes them into one approved batch.
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

export type GatedInvokableTool = Tool<unknown> & {
  invoke?: (runContext: unknown, input: string, details: unknown) => Promise<unknown>;
  description?: string;
};

export function gatedMutationsEnabled(): boolean {
  return (process.env.CLEMENTINE_MCP_GATED_MUTATIONS ?? '').trim().toLowerCase() === 'on';
}

export interface RegisterGatedMutatingToolsOptions {
  enabled?: boolean;
  sessionId?: string;
  runScopeId?: string;
  sourceUserSeq?: number;
  dispatchLease?: DispatchLeaseRef;
  /** True only for the foreground orchestrator. Claude workers/workflow steps
   * explicitly carry false so settled-read steering never leaks into them. */
  directOrchestrator?: boolean;
  /** True only for run_worker children. Carried into the inner harness context
   * so the central Composio gateway—not prompt wording—owns compose-only
   * mutation enforcement. */
  workerScope?: boolean;
  /** Focused unit-test seam; production always resolves the real registry. */
  runtimeToolsForTest?: GatedInvokableTool[];
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
  const runScopeId = opts.runScopeId?.trim() || process.env.CLEMENTINE_MCP_RUN_SCOPE_ID?.trim() || undefined;
  const sourceUserSeq = (() => {
    if (Number.isSafeInteger(opts.sourceUserSeq) && (opts.sourceUserSeq ?? 0) > 0) return opts.sourceUserSeq;
    const value = Number.parseInt(process.env.CLEMENTINE_MCP_SOURCE_USER_SEQ ?? '', 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  })();
  const dispatchLease = opts.dispatchLease
    ?? parseDispatchLease(process.env.CLEMENTINE_MCP_DISPATCH_LEASE_JSON);
  const directOrchestrator = opts.directOrchestrator
    ?? (process.env.CLEMENTINE_MCP_DIRECT_ORCHESTRATOR ?? '').trim().toLowerCase() === 'on';
  const workerScope = opts.workerScope
    ?? (process.env.CLEMENTINE_MCP_WORKER_SCOPE ?? '').trim().toLowerCase() === 'on';

  const byName = new Map<string, GatedInvokableTool>();
  const runtimeTools = opts.runtimeToolsForTest
    ?? ([...getComputerTools(), ...getComposioRuntimeTools()] as GatedInvokableTool[]);
  for (const t of runtimeTools) {
    if (t && typeof t.name === 'string') byName.set(t.name, t);
  }

  for (const [name, shape] of Object.entries(getGatedToolSchemas())) {
    const realTool = byName.get(name);
    if (!realTool || typeof realTool.invoke !== 'function') continue;
    const wrapped = wrapToolForHarness(realTool as never) as GatedInvokableTool;

    server.tool(
      name,
      realTool.description ?? name,
      shape,
      async (rawInput: Record<string, unknown>) => {
        assertDispatchLeaseCurrent(dispatchLease);
        const counter = new ToolCallsCounter(PER_CALL_COUNTER_LIMIT);
        const innerCallId = `mcp-${randomUUID()}`;
        // Compute this from the original full MCP payload before previewArgs
        // clips long strings. The canonical SDK row computes the same digest,
        // allowing one logical call to be reconstructed without storing another
        // copy of a long email/document/shell payload.
        const correlationFingerprint = toolCallCorrelationFingerprint(name, rawInput);
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
        const canonicalClaim = claimClaudeLocalPermissionAdmission({
          sessionId,
          sourceUserSeq: sourceUserSeq ?? 0,
          runScopeId: runScopeId ?? '',
          toolName: name,
          rawInput,
          directOrchestrator,
          dispatchLease,
        });
        const callId = canonicalClaim?.providerCallId ?? innerCallId;
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
          appendEvent({
            sessionId,
            turn: 0,
            role: 'Clem',
            type: 'tool_called',
            data: {
              ...(sourceUserSeq ? { sourceUserSeq } : {}),
              ...(runScopeId ? { runScopeId } : {}),
              tool: name,
              callId: innerCallId,
              ...(canonicalClaim ? {
                canonicalCallId: canonicalClaim.providerCallId,
                canonicalCalledEventId: canonicalClaim.calledEventId,
                claudePermissionAdmissionEventId: canonicalClaim.admissionEventId,
              } : {}),
              args: previewArgs(input),
              accounting: 'transport_mirror',
              correlationFingerprint,
            },
          });
        } catch { /* telemetry must never block the call */ }
        try {
          const out = await withHarnessRunContext({
            sessionId,
            counter,
            behaviorScopeId: runScopeId,
            directOrchestrator,
            workerScope,
            ...(canonicalClaim ? { settledReadCanonicalArgs: rawInput } : {}),
            ...(sourceUserSeq ? { sourceUserSeq } : {}),
            ...(dispatchLease ? {
              dispatchLease,
              runAttemptId: dispatchLease.runAttemptId,
            } : {}),
          }, () =>
            wrapped.invoke!(runContext, JSON.stringify(input ?? {}), details),
          );
          const text = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out);
          const accounting = runtimeToolAccountingMetadata(name, rawInput);
          const settledReadReplay = canonicalClaim
            && sourceUserSeq
            && runScopeId
            && accounting.effect === 'read'
            && accounting.toolSlug
            ? settledReadRepeatReplayDisposition({
                sessionId,
                replayCallId: canonicalClaim.providerCallId,
                replayCalledEventId: canonicalClaim.calledEventId,
                toolName: name,
                effect: accounting.effect,
                sourceUserSeq,
                replayBehaviorScopeId: runScopeId,
                toolSlug: accounting.toolSlug,
              })
            : null;
          try {
            // The mirror row reports what the OUTPUT says, not "the call
            // returned" — a resolved harness refusal must never read ok:true.
            appendEvent({
              sessionId,
              turn: 0,
              role: 'tool',
              type: 'tool_returned',
              data: {
                ...(sourceUserSeq ? { sourceUserSeq } : {}),
                ...(runScopeId ? { runScopeId } : {}),
                tool: name,
                callId: innerCallId,
                ...(canonicalClaim ? {
                  canonicalCallId: canonicalClaim.providerCallId,
                  canonicalCalledEventId: canonicalClaim.calledEventId,
                } : {}),
                // A harness refusal is a FAILED call in the ledger. Before
                // this check the mirror row stamped ok:1 on refusal text, so
                // every health metric read a policy denial as a success
                // (live: 36 denied discovery calls, all success-shaped on the
                // mirror, Aug 8-10 forensics).
                ok: !isHarnessRefusalText(text) && toolOutputLooksSuccessful(text),
                preview: text.slice(0, 400),
                accounting: 'transport_mirror',
                ...(settledReadReplay ? {
                  providerDispatched: false,
                  replayedFromCallId: settledReadReplay.sourceCallId,
                } : {}),
              },
            });
          } catch { /* best-effort */ }
          // ONE park, inside the bracket: wrapped.invoke already formatted and
          // parked the exact payload (digest + recall pointer + exact-output
          // receipt) inside the harness's tool-output context. Re-formatting
          // here ran OUTSIDE that scope, so the second writeToolOutput lost the
          // invocation nonce and clobbered the receipt-bearing row.
          //
          // isError must be set on refusals: this lane returned policy denials
          // as ordinary text, byte-identical in shape to a real answer — the
          // sibling surface got it right (call-tool.ts textResult isError) and
          // renderTypedRefusalForModel sat here with zero callers while the
          // model treated denials as answers.
          return textResult(text, { isError: isHarnessRefusalText(text) });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            appendEvent({ sessionId, turn: 0, role: 'tool', type: 'tool_returned', data: { ...(sourceUserSeq ? { sourceUserSeq } : {}), ...(runScopeId ? { runScopeId } : {}), tool: name, callId: innerCallId, ...(canonicalClaim ? { canonicalCallId: canonicalClaim.providerCallId, canonicalCalledEventId: canonicalClaim.calledEventId } : {}), ok: false, error: message.slice(0, 400), accounting: 'transport_mirror' } });
          } catch { /* best-effort */ }
          throw err;
        }
      },
    );
  }
}


/**
 * Render a typed refusal as a FAILED result the model can see.
 *
 * The gated local MCP lane returned refusals as ordinary text, so a policy
 * denial and a successful read were the same shape on the wire: the model had
 * to read the sentence to find out whether anything happened. MCP has a field
 * for this, and a refusal that does not set it is a failure pretending to be
 * an answer.
 */
export function renderTypedRefusalForModel(outcome: {
  kind: string;
  detail?: string;
  directive?: { action?: string };
}): { isError: true; ok: false; content: Array<{ type: 'text'; text: string }>; kind: string } {
  const action = outcome.directive?.action ?? 'stop_and_explain';
  return {
    isError: true,
    ok: false,
    kind: outcome.kind,
    content: [{
      type: 'text',
      text: `refused: ${outcome.kind}${outcome.detail ? ` (${outcome.detail})` : ''} — recovery: ${action}`,
    }],
  };
}
