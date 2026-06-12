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
 *   2. `excludeToolNames` present → legacy. The harness agent builder has no
 *      per-call tool excludes; silently WIDENING a caller's requested tool
 *      surface (autonomy's no-external-writes gate) would be a security
 *      regression, so those callers stay legacy until excludes exist here.
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
import type { AssistantRequest, AssistantResponse } from '../../types.js';

export type HarnessSurface = 'webhook' | 'cron' | 'background' | 'cli';

/** Interactive chat lanes get the objective-completion judge (parity with
 *  desktop/Discord). Unattended lanes leave it off: their callers already own
 *  report-back honesty via verifyDelivered, and an in-loop judge with no
 *  human present only burns budget arguing with itself. */
const SURFACE_CONFIG: Record<HarnessSurface, { kind: 'chat' | 'execution'; judgeCompletion: boolean }> = {
  webhook: { kind: 'chat', judgeCompletion: true },
  cli: { kind: 'chat', judgeCompletion: true },
  cron: { kind: 'execution', judgeCompletion: false },
  background: { kind: 'execution', judgeCompletion: false },
};

export function harnessSurfaceEnabled(surface: HarnessSurface): boolean {
  const raw = (getRuntimeEnv(`CLEMMY_HARNESS_${surface.toUpperCase()}`, 'on') ?? 'on').trim().toLowerCase();
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
    const agent = await buildAgentImpl({ userInput: request.message, sessionId });
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
  if (request.excludeToolNames && request.excludeToolNames.length > 0) return legacyRespond(request);
  let auth: { ok: boolean };
  try {
    auth = await configureImpl();
  } catch {
    auth = { ok: false };
  }
  if (!auth.ok) return legacyRespond(request);
  return respondViaHarness(surface, request);
}
