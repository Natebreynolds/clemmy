/**
 * respondViaHarness — the CANON-ONE-LOOP convergence bridge.
 *
 * The legacy `assistant.respond()` → CodexNativeRuntime loop carries NONE of
 * the harness write gates (grounding judge, duplicate-target bump,
 * confirm-first, runaway-loop guardrail, execution-wrap) because those live
 * in `wrapToolForHarness` and read the harness event log. Surfaces still on
 * the legacy loop — webhook gateway, cron jobs, background tasks (mobile),
 * legacy CLI — are exactly the unattended lanes where an ungated wrong write
 * hurts most (2026-06-11 wrong-city + double-send incident class).
 *
 * This bridge lets those callers run the HARNESS loop while preserving the
 * legacy synchronous contract (`AssistantResponse` in, one awaited reply
 * out). Routing rules, in order:
 *
 *   1. Per-surface kill-switch (`CLEMMY_HARNESS_<SURFACE>`, default ON) —
 *      flips a surface back to legacy instantly.
 *   2. `excludeToolNames` the harness CANNOT enforce (a non-local/external MCP
 *      tool) → legacy. buildOrchestratorAgent now filters HARNESS-surface tools,
 *      so callers excluding only local tools (architect: workflow_*; autonomy:
 *      composio_execute_tool + workflow_*) ride the gated loop. A non-filterable
 *      exclude still routes legacy — never silently WIDEN a caller's surface.
 *   3. Harness runtime auth unavailable → legacy. This check happens BEFORE
 *      any model call or tool dispatch, so falling back can never
 *      double-execute side effects.
 *   4. Once the harness run STARTS, errors propagate — there is deliberately
 *      no run-failed→legacy retry (a retry after a partial run is the
 *      double-send class the gates exist to prevent).
 *
 * Known, accepted contract differences from the legacy loop (same trade the
 * workflow runner accepted when it converged):
 *   - `request.model` is ignored — the harness uses its configured model.
 *   - `onToolActivity` / `onReasoning` / `runId` run-event streaming are not
 *     bridged; the harness writes its own richer event log instead.
 */
import { runConversation } from './loop.js';
import { buildOrchestratorAgent } from '../../agents/orchestrator.js';
import { configureHarnessRuntime } from './codex-client.js';
import { clearKill, createSession, getSession, requestKill } from './eventlog.js';
import { listPending } from './approval-registry.js';
import { AgentRuntimeCancelledError } from '../provider.js';
import { getRuntimeEnv } from '../../config.js';
import { LOCAL_MCP_TOOL_NAMES } from '../../tools/catalog.js';
import type { AssistantRequest, AssistantResponse } from '../../types.js';

export type HarnessSurface = 'webhook' | 'cron' | 'background' | 'cli' | 'dashboard' | 'home';

/** Surfaces that are STAGED, not yet validated live: default OFF (legacy stays
 *  byte-identical) so a new conversion lands reversibly and Nathan flips the
 *  switch to live-verify, after which it bakes in and leaves this set. The
 *  already-validated surfaces (webhook/cron/background/cli) default ON. These
 *  flags are TEMPORARY — they collapse to zero (legacy core deleted, conversions
 *  baked in) once validated, so the net is a flag REDUCTION, not sprawl. */
const STAGING_SURFACES: ReadonlySet<HarnessSurface> = new Set<HarnessSurface>(['dashboard', 'home']);

/** The harness can only ENFORCE an exclusion for tools on its own local surface
 *  (buildOrchestratorAgent filters those by name). External MCP-server tools are
 *  resolved dynamically and can't be filtered here, so if a caller excludes one
 *  we must stay on the legacy core — routing through the harness would silently
 *  WIDEN the caller's requested tool surface (the autonomy no-external-writes
 *  gate is the case that matters). The real callers only ever exclude harness
 *  tools (workflow_*, composio_execute_tool), so they convert cleanly. */
const HARNESS_FILTERABLE_TOOLS: ReadonlySet<string> = new Set(LOCAL_MCP_TOOL_NAMES as readonly string[]);
function harnessCanEnforceExcludes(names: string[] | undefined): boolean {
  if (!names || names.length === 0) return true;
  return names.every((n) => HARNESS_FILTERABLE_TOOLS.has(n));
}

/** Interactive chat lanes get the objective-completion judge (parity with
 *  desktop/Discord). Unattended lanes leave it off: their callers already own
 *  report-back honesty via verifyDelivered, and an in-loop judge with no
 *  human present only burns budget arguing with itself. */
const SURFACE_CONFIG: Record<HarnessSurface, { kind: 'chat' | 'execution'; judgeCompletion: boolean }> = {
  webhook: { kind: 'chat', judgeCompletion: true },
  cli: { kind: 'chat', judgeCompletion: true },
  cron: { kind: 'execution', judgeCompletion: false },
  background: { kind: 'execution', judgeCompletion: false },
  // One-shot console drafting endpoint (workflow architect): chat kind, but NO
  // objective judge — a single drafting reply is not a multi-step action to
  // validate, and the judge would only add latency/loops.
  dashboard: { kind: 'chat', judgeCompletion: false },
  // Interactive console home chat: full chat parity with desktop/Discord, so
  // the objective-completion judge is ON (same as the cli/webhook lanes).
  home: { kind: 'chat', judgeCompletion: true },
};

export function harnessSurfaceEnabled(surface: HarnessSurface): boolean {
  const dflt = STAGING_SURFACES.has(surface) ? 'off' : 'on';
  const raw = (getRuntimeEnv(`CLEMMY_HARNESS_${surface.toUpperCase()}`, dflt) ?? dflt).trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

// Test seams — same pattern as the grounding judge's _setGroundingJudgeForTests.
type RunConversationFn = typeof runConversation;
type BuildAgentFn = typeof buildOrchestratorAgent;
type ConfigureFn = typeof configureHarnessRuntime;
let runConversationImpl: RunConversationFn = runConversation;
let buildAgentImpl: BuildAgentFn = buildOrchestratorAgent;
let configureImpl: ConfigureFn = configureHarnessRuntime;
export function _setBridgeImplsForTests(impls: {
  runConversation?: RunConversationFn | null;
  buildAgent?: BuildAgentFn | null;
  configure?: ConfigureFn | null;
}): void {
  runConversationImpl = impls.runConversation ?? runConversation;
  buildAgentImpl = impls.buildAgent ?? buildOrchestratorAgent;
  configureImpl = impls.configure ?? configureHarnessRuntime;
}

/** Poll cadence for mapping the legacy `shouldCancel` callback onto the
 *  harness kill switch — matches the legacy runtime's own 2s cancel poll. */
const CANCEL_POLL_MS = 2_000;

export async function respondViaHarness(
  surface: HarnessSurface,
  request: AssistantRequest,
): Promise<AssistantResponse> {
  const config = SURFACE_CONFIG[surface];
  const sessionId = request.sessionId;

  if (!getSession(sessionId)) {
    const titleSeed = request.message.trim().replace(/\s+/g, ' ');
    createSession({
      id: sessionId,
      kind: config.kind,
      channel: request.channel,
      userId: request.userId,
      title: titleSeed.length > 80 ? `${titleSeed.slice(0, 77)}...` : titleSeed,
      metadata: { source: `bridge:${surface}` },
    });
  }

  // A kill latched by a previous request on this session id must not abort
  // this fresh run before it starts.
  try { clearKill(sessionId); } catch { /* best effort */ }

  let cancelledByCaller = false;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  if (request.shouldCancel) {
    const shouldCancel = request.shouldCancel;
    cancelPoll = setInterval(() => {
      void (async () => {
        try {
          if (await shouldCancel()) {
            cancelledByCaller = true;
            requestKill(sessionId, 'cancelled by caller (shouldCancel)');
            if (cancelPoll) clearInterval(cancelPoll);
          }
        } catch { /* a broken predicate must not kill the run */ }
      })();
    }, CANCEL_POLL_MS);
  }

  try {
    const agent = await buildAgentImpl({
      userInput: request.message,
      sessionId,
      excludeToolNames: request.excludeToolNames,
    });
    const result = await runConversationImpl({
      agent,
      sessionId,
      input: request.message,
      maxWallClockMs: request.maxWallClockMs,
      judgeCompletion: config.judgeCompletion,
      onChunk: request.onChunk,
    });

    const replyText =
      (result.lastDecision?.reply && result.lastDecision.reply.trim())
        ? result.lastDecision.reply
        : (result.lastDecision?.summary ?? '');

    switch (result.status) {
      case 'completed':
      case 'awaiting_user_input':
        return {
          text: replyText || '(no reply produced)',
          sessionId,
          stoppedReason: 'success',
          turnsUsed: result.lastTurn,
        };
      case 'awaiting_approval': {
        const pending = listPending({ sessionId, status: 'pending' });
        const first = pending[0];
        return {
          text: replyText
            || (first
              ? `Paused for approval \`${first.approvalId}\`: ${first.subject}. Approve or reject it and I'll continue.`
              : 'Paused for an approval. Approve or reject it and I\'ll continue.'),
          sessionId,
          pendingApprovalId: first?.approvalId,
          stoppedReason: 'pending-approval',
          turnsUsed: result.lastTurn,
        };
      }
      case 'limit_exceeded':
        return {
          text: replyText || 'I hit the run budget before finishing — say "continue" to keep going.',
          sessionId,
          stoppedReason: 'max-turns-with-grace',
          turnsUsed: result.lastTurn,
        };
      case 'killed':
        // Preserve the legacy cancellation contract: callers (background
        // tasks) classify aborts via this error type.
        if (cancelledByCaller) throw new AgentRuntimeCancelledError('Run cancelled by caller.');
        return {
          text: replyText || 'Run was cancelled.',
          sessionId,
          stoppedReason: 'cancelled',
          turnsUsed: result.lastTurn,
        };
      case 'failed':
      default:
        throw new Error(result.error || `harness run ${result.status}`);
    }
  } finally {
    if (cancelPoll) clearInterval(cancelPoll);
  }
}

/**
 * Drop-in router for legacy call sites:
 *   `assistant.respond(req)` → `respondPreferHarness('cron', req, (r) => assistant.respond(r))`
 * Falls back to legacy ONLY pre-run (flag off, per-call tool excludes, auth
 * unavailable) — never after the harness run has started.
 */
export async function respondPreferHarness(
  surface: HarnessSurface,
  request: AssistantRequest,
  legacyRespond: (req: AssistantRequest) => Promise<AssistantResponse>,
): Promise<AssistantResponse> {
  if (!harnessSurfaceEnabled(surface)) return legacyRespond(request);
  // Per-call tool-exclusion: route through the harness ONLY when it can ENFORCE
  // every excluded name (harness-surface tool). A non-filterable exclude (an
  // external MCP tool) falls back to legacy so we never silently widen the
  // caller's tool surface. buildOrchestratorAgent does the actual filtering.
  if (!harnessCanEnforceExcludes(request.excludeToolNames)) return legacyRespond(request);
  let auth: { ok: boolean };
  try {
    auth = await configureImpl();
  } catch {
    auth = { ok: false };
  }
  if (!auth.ok) return legacyRespond(request);
  return respondViaHarness(surface, request);
}
