import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkerToolInputSchema, workerPacketKey, type WorkerToolInput } from '../agents/worker-job-packet.js';
import { recordSubagentRun, findCompletedSubagentOutput } from '../agents/subagent-runs.js';
import { runClaudeAgentSdkWorker } from '../runtime/harness/claude-agent-worker.js';
import { acquireWorkerSlot } from '../agents/worker-concurrency.js';
import { workerItemAlreadyCapped, workerAlreadyCompletedForPacket, workerResumeIdempotencyEnabled } from '../agents/worker-respawn-guard.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { getClaudeBrainModel, getRuntimeEnv } from '../config.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { recordModelRouteDecision, recordModelRouteOutcome } from '../runtime/model-route-metrics.js';
import type { ModelProviderClass } from '../runtime/harness/model-wire-registry.js';
import { resolveEffectiveProviderForModel } from '../runtime/harness/byo-providers.js';
import { textResult } from './shared.js';

/**
 * `run_worker` for the CLAUDE AGENT SDK BRAIN.
 *
 * The orchestrator (Codex) lane has its own inline `run_worker` (an @openai/agents
 * tool). The Claude SDK brain calls LOCAL tools through this MCP server child and had
 * NO fan-out primitive — so a Claude brain (e.g. Sonnet 5) processed N independent
 * items SEQUENTIALLY and blew its per-query turn budget (2026-07-01 stress: 5-firm SEO
 * stopped at 2/5). This exposes the same fan-out to the SDK brain: spawn a stateless
 * Claude SDK worker on ONE item, reusing the shared substrate — the per-session
 * concurrency cap (P6, so parallel calls can't storm a provider), the respawn guard
 * (a re-spawn of an already-capped item is refused), and the durable worker_result
 * ledger.
 *
 * Worker model, by role: if the WORKER role resolves to a Claude model, the worker
 * runs on the Claude Agent SDK (honors "workers = Sonnet 5"). If it resolves to a
 * NON-Claude model (e.g. gpt-*, glm-*), the worker runs through the SAME
 * cross-provider @openai/agents Worker the orchestrator lane fans out
 * (runCrossProviderWorker) — lane parity, so the SDK brain honors a configured
 * non-Claude worker instead of silently reverting to Claude. Kill-switch
 * CLEMMY_SDK_BRAIN_CROSS_WORKER (default on) reverts to today's Claude-only
 * fallback. Master kill-switch CLEMMY_SDK_BRAIN_RUN_WORKER (default on) disables
 * fan-out entirely.
 */
function enabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SDK_BRAIN_RUN_WORKER', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** Cross-provider workers for the SDK brain lane (default on). off/0/false ⇒ a
 *  configured non-Claude worker model reverts to today's Claude brain fallback
 *  (clean rollback), and the ignored model is surfaced via telemetry. */
export function sdkBrainCrossWorkerEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_SDK_BRAIN_CROSS_WORKER', 'on') ?? 'on').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

export interface SdkBrainWorkerRoute {
  /** The model the worker actually runs on. */
  modelId: string;
  /** true ⇒ Claude Agent SDK worker lane; false ⇒ cross-provider @openai/agents worker. */
  claudeLane: boolean;
  /** Set when a non-Claude worker model was CONFIGURED but ignored (kill-switch
   *  off) — surfaced as a visible telemetry warning instead of a silent fallback. */
  ignoredNonClaudeModel?: string;
}

/** PURE lane-decision (no config/connectivity reads) so every branch is
 *  deterministically testable. A Claude model → Claude SDK lane; a non-Claude
 *  model → cross-provider lane when enabled, else the Claude brain fallback with
 *  the ignored model surfaced. No resolvable model ⇒ the Claude brain fallback. */
export function pickSdkBrainWorkerLane(
  resolvedId: string | undefined,
  opts: { crossEnabled: boolean; claudeBrainModel: string; resolvedProvider?: ModelProviderClass },
): SdkBrainWorkerRoute {
  const isClaude = Boolean(resolvedId && opts.resolvedProvider === 'claude');
  if (isClaude) return { modelId: resolvedId as string, claudeLane: true };
  if (resolvedId && opts.crossEnabled) return { modelId: resolvedId, claudeLane: false };
  // Kill-switch off, or no resolvable model ⇒ today's Claude-only fallback.
  return {
    modelId: opts.claudeBrainModel,
    claudeLane: true,
    ...(resolvedId && !isClaude ? { ignoredNonClaudeModel: resolvedId } : {}),
  };
}

/** Pick the worker model + execution lane for the Claude SDK brain, honoring an
 *  intent-scoped WORKER binding. Fails open to the Claude brain model. */
export function resolveSdkBrainWorker(intent?: string): SdkBrainWorkerRoute {
  let resolvedId: string | undefined;
  let resolvedProvider: ModelProviderClass | undefined;
  try {
    const resolved = resolveRoleModel('worker', intent);
    resolvedId = resolved.modelId;
    resolvedProvider = resolved.provider;
  } catch { /* fall through to the Claude brain model */ }
  return pickSdkBrainWorkerLane(resolvedId, {
    crossEnabled: sdkBrainCrossWorkerEnabled(),
    claudeBrainModel: getClaudeBrainModel(),
    resolvedProvider,
  });
}

const firstLine = (v: unknown): string => {
  const raw = v instanceof Error ? v.message : typeof v === 'string' ? v : String(v ?? '');
  return raw.split('\n')[0].slice(0, 300);
};

export function registerWorkerTools(server: McpServer): void {
  server.tool(
    'run_worker',
    [
      'Spawn a stateless Worker on ONE item using a structured parent-planned job packet. Call this MULTIPLE TIMES IN PARALLEL when you have N independent items to process (scrape, classify, summarize, fetch, transform, create/enrich N records).',
      'Each worker runs in its own isolated context — keeps YOUR context from ballooning over many items, and runs the work concurrently instead of one-at-a-time (which blows your turn budget).',
      'Pass a structured packet for ONE item: the item identifier, exact resolved tool slugs, source facts/context, instructions, and expected output shape. Workers cannot see your prior tool outputs — paste the details they need into the packet.',
      'When to use: 3+ independent items of the same kind. Aggregate the tight results the workers return.',
      'CRITICAL: a worker result beginning with "ERROR:" means that item FAILED — it was NOT done. Never report a batch complete if any worker returned ERROR; report exactly which items succeeded and which failed.',
    ].join(' '),
    WorkerToolInputSchema.shape,
    async (params) => {
      if (!enabled()) return textResult('run_worker is disabled (CLEMMY_SDK_BRAIN_RUN_WORKER=off).');
      const input = params as WorkerToolInput;
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) {
        return textResult('ERROR: run_worker needs a live session context. Do this item inline instead.');
      }
      // Wave 4 Stage 1: packet key identifies this exact job so a resumed run can
      // detect a worker that already completed and skip re-executing it.
      const packetKey = workerPacketKey(input);
      const recordResult = (ok: boolean, reason?: string, model?: string): void => {
        try {
          appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_result', data: { item: input.item, ok, packetKey, ...(reason ? { reason } : {}), ...(model ? { model } : {}), lane: 'sdk_brain' } });
        } catch { /* durable trace is best-effort */ }
      };

      // Wave 4 Stage 1 — durable-resume idempotency (checked BEFORE the fuzzy
      // cap-guard: an exact-packet ok match is a STRONGER signal than the
      // domain-collapsing cap match, and must win so a worker that genuinely
      // COMPLETED isn't refused-as-failed on resume because a same-domain sibling
      // capped — adversarial review F1). If this exact packet already completed
      // successfully in this run session, REUSE the prior work-product instead of
      // re-executing (re-running would redo the work and re-issue its external
      // writes). ONLY short-circuit when the real output is recoverable — else
      // fall through and re-execute rather than pass a placeholder off as success
      // (F4); the duplicate-send wall backstops any repeated send. Fail-open;
      // kill-switch CLEMMY_WORKER_RESUME_IDEMPOTENCY.
      try {
        if (workerResumeIdempotencyEnabled() && workerAlreadyCompletedForPacket(sessionId, packetKey)) {
          const parentRunId = getToolOutputContext()?.workflowRunId || sessionId;
          const prior = findCompletedSubagentOutput(parentRunId, input.item, packetKey);
          if (prior && prior.trim()) {
            recordResult(true, 'resume: reused prior completed result');
            return textResult(prior);
          }
          // No recoverable output → do NOT claim success; re-execute below.
        }
      } catch { /* fail-open */ }

      // HARD respawn guard: if THIS item already hit its turn cap earlier this run,
      // refuse to re-spawn it (a re-run with the same packet just caps again — the
      // non-converging loop). Fail-open so it can never block a first spawn.
      try {
        if (workerItemAlreadyCapped(sessionId, input.item)) {
          const msg = `ERROR: worker for "${input.item}" already exhausted its turn budget on a prior attempt this run and was NOT re-spawned. Report this item as failed / needs-attention; do not retry it.`;
          recordResult(false, firstLine(msg));
          return textResult(msg);
        }
      } catch { /* fail-open */ }

      const route = resolveSdkBrainWorker(input.intent || undefined);
      const workerModel = route.modelId;
      const transport = route.claudeLane ? 'claude_agent_sdk' : 'cross_provider';
      // Visible warning when a configured non-Claude worker model is IGNORED
      // (CLEMMY_SDK_BRAIN_CROSS_WORKER=off) — replaces today's silent fallback so
      // operators can see why their non-Claude worker isn't running.
      if (route.ignoredNonClaudeModel) {
        try {
          recordOperationalEvent({
            source: 'harness',
            type: 'worker_model_ignored',
            sessionId,
            actor: 'run_worker',
            payload: {
              item: input.item,
              lane: 'sdk_brain',
              configuredModel: route.ignoredNonClaudeModel,
              ranModel: workerModel,
              reason: 'CLEMMY_SDK_BRAIN_CROSS_WORKER=off',
            },
          });
        } catch { /* telemetry is best-effort */ }
      }
      // P6 concurrency cap: at most K workers in flight per session; excess queue.
      // worker_queued fires only when this worker actually has to wait for a slot.
      const workerProvider = resolveEffectiveProviderForModel(workerModel);
      const release = await acquireWorkerSlot(sessionId, (info) => {
        try {
          recordOperationalEvent({
            source: 'harness',
            type: 'worker_queued',
            sessionId,
            actor: 'run_worker',
            payload: { item: input.item, lane: 'sdk_brain', ...info },
          });
        } catch { /* telemetry is best-effort */ }
      }, { modelId: workerModel, provider: workerProvider });
      // worker_spawned: a slot was acquired and the worker is about to run.
      try {
        recordOperationalEvent({
          source: 'harness',
          type: 'worker_spawned',
          sessionId,
          actor: 'run_worker',
          payload: { item: input.item, model: workerModel, provider: workerProvider, lane: 'sdk_brain', transport },
        });
      } catch { /* telemetry is best-effort */ }
      // Route-outcome capture (adaptive routing evidence): one decision+outcome
      // pair per worker run so the policy job scores WORKER models, not just the
      // brain. Fail-open — metrics must never fail a worker.
      const routeStartedAt = Date.now();
      const routeDecisionId = recordModelRouteDecision({
        sessionId,
        role: 'worker',
        intent: input.intent || undefined,
        resolvedModel: workerModel,
        provider: workerProvider,
        source: 'default',
        reason: { lane: 'sdk_brain', item: input.item },
      });
      // Live-visibility: announce the agent STARTING (the chat/board render it as a
      // running specialist immediately, not only when worker_result lands). Cheap,
      // fail-open. provider/role let the UI badge it (Claude/Codex/GLM + specialty).
      try {
        appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_started', data: { item: input.item, model: workerModel, provider: workerProvider, role: input.intent || undefined, lane: 'sdk_brain' } });
      } catch { /* telemetry is best-effort */ }
      try {
        // Claude worker role → Claude Agent SDK lane; non-Claude → the SAME
        // cross-provider @openai/agents Worker the orchestrator lane fans out
        // (lazy import: worker-tools loads into the SDK-brain MCP child; the
        // cross-provider runner drags in the whole agent surface, so keep it out
        // of the module graph — mirrors code-mode-tool's runtime imports).
        const result: { text: string; model?: string } = route.claudeLane
          ? await runClaudeAgentSdkWorker(input, workerModel, sessionId)
          : await (async () => {
              const { runCrossProviderWorker } = await import('../agents/sub-agents.js');
              return runCrossProviderWorker(input, workerModel, sessionId);
            })();
        const ok = !/^\s*ERROR:/i.test(result.text ?? '');
        // #6: the SDK-brain worker surfaces a turn-cap as ERROR text, but the
        // hooks.ts worker_capped emit only fires in the nested lane — so the
        // respawn guard was DEAD in this default-on lane (the non-converging
        // cap-loop it exists to stop could recur). Emit it directly here so a
        // re-spawn of THIS capped item is refused (workerItemAlreadyCapped).
        if (!ok && /MaxTurnsExceeded|hit its turn cap/i.test(result.text ?? '')) {
          try {
            appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_capped', data: { item: input.item } });
          } catch { /* telemetry is best-effort */ }
        }
        recordResult(ok, ok ? undefined : firstLine(result.text), result.model ?? workerModel);
        recordModelRouteOutcome({
          decisionId: routeDecisionId,
          status: ok ? 'success' : 'failed',
          latencyMs: Date.now() - routeStartedAt,
          toolSuccess: ok,
        });
        // Subagent-runs visibility spine: WHO ran (provider+model+role), WHAT they
        // did (task + persisted work-product), OUTCOME — attributed to the workflow
        // run when spawned in a step, else the session. This ONE choke-point covers
        // all three lanes (Claude / Codex / GLM-BYO). Fail-open.
        try {
          const ctx = getToolOutputContext();
          const capped = !ok && /MaxTurnsExceeded|hit its turn cap/i.test(result.text ?? '');
          const resultProvider = route.claudeLane
            ? 'claude'
            : resolveEffectiveProviderForModel(result.model ?? workerModel);
          recordSubagentRun({
            id: `w-${routeStartedAt}-${Math.random().toString(36).slice(2, 8)}`,
            parentRunId: ctx?.workflowRunId || sessionId,
            parentKind: ctx?.workflowRunId ? 'workflow' : 'session',
            workflowName: ctx?.workflowName,
            stepId: ctx?.stepId,
            role: input.intent || undefined,
            provider: resultProvider,
            model: result.model ?? workerModel,
            task: input.item,
            packetKey,
            status: capped ? 'capped' : ok ? 'ok' : 'error',
            output: result.text ?? '',
            startedAt: new Date(routeStartedAt).toISOString(),
            finishedAt: new Date().toISOString(),
          });
        } catch { /* visibility trace is best-effort */ }
        return textResult(result.text);
      } catch (err) {
        recordResult(false, firstLine(err), workerModel);
        recordModelRouteOutcome({
          decisionId: routeDecisionId,
          status: 'failed',
          latencyMs: Date.now() - routeStartedAt,
          errorClass: err instanceof Error ? err.name : typeof err,
        });
        // A THROWN worker (crashed before returning a result) was invisible in the
        // Agents panel — the success path above records, this one didn't. Record it
        // as a failed specialist so a crashed worker still shows up. Fail-open.
        try {
          const ctx = getToolOutputContext();
          const failedProvider = route.claudeLane ? 'claude' : resolveEffectiveProviderForModel(workerModel);
          recordSubagentRun({
            id: `w-${routeStartedAt}-${Math.random().toString(36).slice(2, 8)}`,
            parentRunId: ctx?.workflowRunId || sessionId,
            parentKind: ctx?.workflowRunId ? 'workflow' : 'session',
            workflowName: ctx?.workflowName,
            stepId: ctx?.stepId,
            role: input.intent || undefined,
            provider: failedProvider,
            model: workerModel,
            task: input.item,
            packetKey,
            status: 'error',
            output: `ERROR: worker for "${input.item}" failed: ${firstLine(err)}`,
            startedAt: new Date(routeStartedAt).toISOString(),
            finishedAt: new Date().toISOString(),
          });
        } catch { /* visibility trace is best-effort */ }
        // Infra-shaped failure (credentials / auth / no provider): EVERY sibling
        // worker will die the same way, so retrying items through run_worker is
        // pure waste — and silently serializing hides the degradation from the
        // user (live 2026-07-06: 9/10 workers died on "Missing credentials" and
        // the chat never said so). Tell the model to switch lanes AND say so.
        const infraShaped = /missing credentials|no default model provider|api key|apikey|unauthorized|invalid_grant|token_revoked|sign-?in expired/i.test(firstLine(err));
        if (infraShaped) {
          return textResult(
            `ERROR: worker for "${input.item}" failed before starting: ${firstLine(err)} `
            + 'PARALLEL FAN-OUT IS UNAVAILABLE this run (worker model backend has no usable credentials — this will fail identically for every item). '
            + 'Do NOT call run_worker again this turn. Process the remaining items inline instead, and TELL THE USER in your reply that parallel fan-out was unavailable (and why), so they know this run degraded to sequential.',
          );
        }
        return textResult(`ERROR: worker for "${input.item}" failed: ${firstLine(err)}`);
      } finally {
        release();
      }
    },
  );
}
