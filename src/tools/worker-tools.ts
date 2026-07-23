import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkerToolCallSchema, uniformFailureSignature, workerCallItems, workerPacketKey, workerResultIndicatesFailure, type WorkerToolCall, type WorkerToolInput } from '../agents/worker-job-packet.js';
import { runBoundedPool } from '../execution/bounded-pool.js';
import { recordSubagentRun, findCompletedSubagentOutput } from '../agents/subagent-runs.js';
import { runClaudeAgentSdkWorker } from '../runtime/harness/claude-agent-worker.js';
import { acquireWorkerSlot } from '../agents/worker-concurrency.js';
import { clearFanoutUniformFailure, fanoutUniformFailure, markFanoutUniformFailure, workerItemAlreadyCapped, workerAlreadyCompletedForPacket, workerResumeIdempotencyEnabled } from '../agents/worker-respawn-guard.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { getClaudeBrainModel, getRuntimeEnv } from '../config.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { fanoutBudgetStatus, formatTokens } from '../runtime/harness/run-token-budget.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { recordModelRouteDecision, recordModelRouteOutcome, type ModelRouteDecisionSource } from '../runtime/model-route-metrics.js';
import type { ModelProviderClass } from '../runtime/harness/model-wire-registry.js';
import { looksLikeUnknownModelError, markByoModelNotServed, repairByoRoutedModelId, resolveEffectiveProviderForModel } from '../runtime/harness/byo-providers.js';
import { markWorkerModelCoolingDown, pickWorkerModelWithFallover, workerFailureLooksRateLimited } from '../agents/worker-model-fallover.js';
import { faultInjectWorkerModel, injectedWorkerRateLimitText } from '../runtime/harness/fault-inject.js';
import { maybeFanoutAlignmentBounce, maybeBounceMassExecution, maybeHeavyPerItemToolAdvisory } from '../agents/fanout-alignment-gate.js';
import { textResult } from './shared.js';
import { buildWorkerReturn } from '../runtime/harness/fanout-reduce.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';

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
  /** WHY this model: the resolution source, mapped to the decision enum, so the
   *  route-metrics decision row attributes learned-policy picks honestly
   *  (parity with the orchestrator lane's trace mapping). */
  source?: ModelRouteDecisionSource;
  /** Evidence behind a source='policy' pick — rides into the decision reason. */
  policy?: { score: number; defaultScore: number; sampleCount: number; policyVersion: number };
}

/** PURE lane-decision (no config/connectivity reads) so every branch is
 *  deterministically testable. A Claude model → Claude SDK lane; a non-Claude
 *  model → cross-provider lane when enabled, else the Claude brain fallback with
 *  the ignored model surfaced. No resolvable model ⇒ the Claude brain fallback. */
export function pickSdkBrainWorkerLane(
  resolvedId: string | undefined,
  opts: { crossEnabled: boolean; claudeBrainModel: string; resolvedProvider?: ModelProviderClass; resolvedSource?: ModelRouteDecisionSource },
): SdkBrainWorkerRoute {
  const isClaude = Boolean(resolvedId && opts.resolvedProvider === 'claude');
  if (isClaude) return { modelId: resolvedId as string, claudeLane: true, source: opts.resolvedSource ?? 'default' };
  if (resolvedId && opts.crossEnabled) return { modelId: resolvedId, claudeLane: false, source: opts.resolvedSource ?? 'default' };
  // Kill-switch off (the resolved model was IGNORED ⇒ this run is a fallback),
  // or no resolvable model ⇒ today's Claude-only fallback is simply the default.
  return {
    modelId: opts.claudeBrainModel,
    claudeLane: true,
    source: resolvedId && !isClaude ? 'fallback' : 'default',
    ...(resolvedId && !isClaude ? { ignoredNonClaudeModel: resolvedId } : {}),
  };
}

/** Pick the worker model + execution lane for the Claude SDK brain, honoring an
 *  intent-scoped WORKER binding. Fails open to the Claude brain model. */
export function resolveSdkBrainWorker(intent?: string): SdkBrainWorkerRoute {
  let resolvedId: string | undefined;
  let resolvedProvider: ModelProviderClass | undefined;
  let resolvedSource: ModelRouteDecisionSource | undefined;
  let resolvedPolicy: SdkBrainWorkerRoute['policy'];
  try {
    const resolved = resolveRoleModel('worker', intent);
    resolvedId = resolved.modelId;
    resolvedProvider = resolved.provider;
    // Map the resolution source onto the decision enum (same collapse the
    // orchestrator lane applies to its trace): explicit binding kinds → 'binding'.
    resolvedSource = resolved.source === 'policy' ? 'policy' : resolved.source === 'default' ? 'default' : 'binding';
    resolvedPolicy = resolved.policy;
  } catch { /* fall through to the Claude brain model */ }
  const route = pickSdkBrainWorkerLane(resolvedId, {
    crossEnabled: sdkBrainCrossWorkerEnabled(),
    claudeBrainModel: getClaudeBrainModel(),
    resolvedProvider,
    resolvedSource,
  });
  // The policy evidence only describes the model the policy picked — attach it
  // only when that exact model is what the route runs.
  if (resolvedPolicy && route.source === 'policy' && route.modelId === resolvedId) route.policy = resolvedPolicy;
  return route;
}

const firstLine = (v: unknown): string => {
  const raw = v instanceof Error ? v.message : typeof v === 'string' ? v : String(v ?? '');
  return raw.split('\n')[0].slice(0, 300);
};

export function registerWorkerTools(server: McpServer): void {
  server.tool(
    'run_worker',
    [
      'Spawn stateless Workers over 1..N items using a structured parent-planned job packet. For 2+ independent same-shape items, pass them ALL in `items` — the harness runs them as one bounded parallel pool (wall time ≈ slowest item) with an honest per-item ledger. A single item may use `item` instead.',
      'Each worker runs in its own isolated context — keeps YOUR context from ballooning over many items, and runs the work concurrently instead of one-at-a-time (which blows your turn budget).',
      'The packet (objective, resolvedTools, context, instructions, expectedOutput) applies to every item. Workers cannot see your prior tool outputs — paste the details they need into the packet.',
      'When to use: 3+ independent items of the same kind. Aggregate the tight results the workers return.',
      'On LARGE fan-outs, results MAY return as compact digests with the full output parked and shard summaries attached — when they do, synthesize from those and drill into a specific item with tool_output_query(call_id) only where an exact figure is needed.',
      'CRITICAL: a worker result beginning with "ERROR:" means that item FAILED — it was NOT done. Never report a batch complete if any worker returned ERROR; report exactly which items succeeded and which failed.',
    ].join(' '),
    WorkerToolCallSchema.shape,
    async (callParams) => {
      if (!enabled()) return textResult('run_worker is disabled (CLEMMY_SDK_BRAIN_RUN_WORKER=off).');
      const call = callParams as WorkerToolCall;
      const callItems = workerCallItems(call);
      if (!callItems || callItems.length === 0) {
        return textResult('ERROR: run_worker needs `item` (one identifier) or `items` (the full list for a parallel batch).');
      }
      // First-contact mass fan-out earns ONE alignment beat (SDK-lane twin;
      // fail-open, one-shot — see fanout-alignment-gate.ts).
      const armedBounce = maybeBounceMassExecution(getToolOutputContext()?.sessionId);
      if (armedBounce.bounce && armedBounce.steer) return textResult(armedBounce.steer);
      const alignmentBounce = maybeFanoutAlignmentBounce({ sessionId: getToolOutputContext()?.sessionId, itemCount: callItems.length });
      if (alignmentBounce.bounce && alignmentBounce.steer) return textResult(alignmentBounce.steer);
      // Advisory-only cost note for browser-per-item fan-outs (live 2026-07-23).
      const heavyAdvisory = maybeHeavyPerItemToolAdvisory(
        getToolOutputContext()?.sessionId,
        callItems.length,
        JSON.stringify(call),
      );
      const { items: _batch, ...packetBase } = call;
      if (callItems.length > 1) {
        // Deterministic batch: the harness owns the parallelism (bounded pool;
        // real provider throttling stays with the per-item worker slots), so a
        // brain that would have serialized N calls no longer pays N× wall time.
        const outs: Array<string | null> = new Array(callItems.length).fill(null);
        await runBoundedPool(
          callItems.map((item, index) => ({ input: { ...packetBase, item } as WorkerToolInput, index })),
          Math.min(callItems.length, 16),
          async ({ input: perItem, index }) => {
            try {
              const out = await runOneWorker(perItem);
              outs[index] = String((out as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '');
            } catch (err) {
              outs[index] = `ERROR: worker for "${perItem.item}" failed: ${firstLine(err)}`;
            }
          },
        );
        const rendered = callItems.map((item, index) => {
          const text = outs[index] ?? `ERROR: worker for "${item}" crashed before returning a result.`;
          return { item, text, failed: workerResultIndicatesFailure(text) };
        });
        const failed = rendered.filter((r) => r.failed);
        const sessionIdForMemo = getToolOutputContext()?.sessionId ?? '';
        if (failed.length === 0 && sessionIdForMemo) clearFanoutUniformFailure(sessionIdForMemo);
        const uniform = failed.length === rendered.length ? uniformFailureSignature(failed.map((f) => f.text)) : null;
        // Self-heal: a uniform "unknown model" rejection is the BYO endpoint
        // teaching us its real catalog — memo the dead id so the repair
        // translates it, and invite an IMMEDIATE retry instead of declaring
        // fan-out down (one failed round maximum).
        if (uniform && looksLikeUnknownModelError(uniform)) {
          const deadRoute = resolveSdkBrainWorker(call.intent || undefined);
          markByoModelNotServed(deadRoute.modelId);
          const healed = repairByoRoutedModelId(deadRoute.modelId);
          if (healed !== deadRoute.modelId) {
            return textResult(`Batch failed: ALL ${rendered.length} workers died because the configured worker model "${deadRoute.modelId}" is not served by the BYO endpoint. It has been AUTO-CORRECTED to "${healed}" — call run_worker again NOW with the same items; it will dispatch on the corrected model.`);
          }
        }
        // Fleet resilience twin of the unknown-model heal: a uniform rate limit
        // benches the routed model and invites an immediate retry on the next
        // healthy candidate (spawn-time selection above does the switch).
        // RAW texts, not the normalized signature (429 → <n> blinding; see
        // orchestrator twin, live 2026-07-22).
        if (uniform && (workerFailureLooksRateLimited(uniform) || failed.some((f) => workerFailureLooksRateLimited(f.text)))) {
          const benchedRoute = resolveSdkBrainWorker(call.intent || undefined);
          markWorkerModelCoolingDown(benchedRoute.modelId);
          const next = pickWorkerModelWithFallover([
            benchedRoute.modelId,
            resolveSdkBrainWorker(undefined).modelId,
            getClaudeBrainModel(),
          ]);
          if (next.falloverFrom) {
            return textResult(`Batch failed: ALL ${rendered.length} workers hit a rate limit on worker model "${benchedRoute.modelId}". It is benched for a cooldown and fan-out has AUTO-SWITCHED to "${next.model}" — call run_worker again NOW with the same items; they will dispatch on the healthy model.`);
          }
        }
        if (uniform && sessionIdForMemo) {
          markFanoutUniformFailure(sessionIdForMemo, uniform);
          // The abort transfers these items to INLINE execution — they are no
          // longer worker items, so they must not count against fan-out
          // coverage (live 2026-07-22: a perfectly delivered run was stamped
          // blocked on "0/12" from its dead pre-abort rounds). The ledger
          // already scopes coverage to the latest boundary.
          try {
            appendEvent({ sessionId: sessionIdForMemo, turn: 0, role: 'system', type: 'fanout_run_boundary', data: { reason: 'uniform_failure_abort', signature: uniform } });
          } catch { /* coverage boundary is best-effort */ }
        }
        const header = failed.length === 0
          ? `Batch complete: ${rendered.length}/${rendered.length} items succeeded.`
          : uniform
            ? `PARALLEL FAN-OUT IS DOWN for this run: ALL ${rendered.length} items failed IDENTICALLY (${uniform}). This is an infrastructure failure, not an item problem — do NOT call run_worker again this turn. Process the remaining work inline and TELL THE USER the run degraded to sequential (and why).`
            : `Batch finished with FAILURES: ${rendered.length - failed.length}/${rendered.length} succeeded; FAILED items: ${failed.map((f) => f.item).join(', ')}. Report these honestly — they were NOT done.`;
        return textResult([...(heavyAdvisory ? [heavyAdvisory] : []), header, ...rendered.map((r) => `--- item: ${r.item} ---\n${r.text}`)].join('\n\n'));
      }
      return runOneWorker({ ...packetBase, item: callItems[0] } as WorkerToolInput);
    },
  );

  const runOneWorker = async (params: WorkerToolInput) => {
    {
      const input = params as WorkerToolInput;
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) {
        return textResult('ERROR: run_worker needs a live session context. Do this item inline instead.');
      }
      const knownDead = fanoutUniformFailure(sessionId);
      if (knownDead) {
        return textResult(`ERROR: worker for "${input.item}" was NOT started — parallel fan-out already failed uniformly this run (${knownDead}). Process this item inline; workers stay refused until the underlying failure changes.`);
      }
      const sourceUserSeq = harnessRunContextStorage.getStore()?.sourceUserSeq;
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
            // Route replays through the reduce tier too, so a resumed 100-item
            // fan-out doesn't re-flood the parent context with prior outputs.
            return textResult(await buildWorkerReturn({
              sessionId,
              parentRunId,
              item: input.item,
              text: prior,
              callId: `call_w_resume_${packetKey.slice(0, 16)}`,
            }));
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

      // Stage 4 fan-out slice: never SPAWN past an exhausted run token window.
      // This runs in the SDK-brain MCP child, so the parent's window arrives via
      // the durable run_token_window record, not shared memory. A refusal (not a
      // kill) — the item routes into the honest N-of-M partial path. Fail-open.
      const fanoutBudget = fanoutBudgetStatus(sessionId);
      if (fanoutBudget?.exceeded) {
        const msg = `ERROR: worker for "${input.item}" was NOT started — this run's token budget is exhausted (${formatTokens(fanoutBudget.usedWindow)}/${formatTokens(fanoutBudget.ceiling)} uncached tokens used). Report this item as not-attempted; the user can say "continue" to open a fresh budget window.`;
        recordResult(false, firstLine(msg));
        return textResult(msg);
      }

      const route = resolveSdkBrainWorker(input.intent || undefined);
      let workerModel = route.modelId;
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
      let workerProvider = resolveEffectiveProviderForModel(workerModel);
      // A byo-routed id no BYO provider serves would 400 on dispatch — repair to
      // the backend's real primary id (no-op for owned ids / non-byo providers).
      if (workerProvider === 'byo' && !route.claudeLane) workerModel = repairByoRoutedModelId(workerModel);
      // Fleet resilience: skip a rate-limit-benched worker model at spawn time
      // (routed → default worker binding → Claude brain). Cross-lane pick only
      // applies off the pure-Claude lane; the Claude lane's own model is already
      // the last-resort candidate.
      let benchFalloverFrom: string | undefined;
      if (!route.claudeLane) {
        const pick = pickWorkerModelWithFallover([
          workerModel,
          resolveSdkBrainWorker(undefined).modelId,
          getClaudeBrainModel(),
        ]);
        if (pick.falloverFrom) {
          benchFalloverFrom = pick.falloverFrom;
          workerModel = pick.model;
          workerProvider = resolveEffectiveProviderForModel(workerModel);
          if (workerProvider === 'byo') workerModel = repairByoRoutedModelId(workerModel);
        }
      }
      // Dev-only forced 429 (CLEMMY_FAULT_INJECT_WORKER_MODEL) — SDK-lane twin
      // of the orchestrator hook: only the failure is fake; bench, auto-switch,
      // and the healthy re-batch run for real. Inert in production.
      if (faultInjectWorkerModel() === workerModel) {
        return textResult(injectedWorkerRateLimitText(input.item, workerModel));
      }
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
        // Bench fallover swapped the model after resolution ⇒ the run is a
        // fallback; otherwise attribute the resolution honestly (policy picks
        // must show up as policy — the learning loop's own evidence trail).
        source: benchFalloverFrom ? 'fallback' : route.source ?? 'default',
        reason: {
          lane: 'sdk_brain',
          item: input.item,
          ...(route.policy ? { policy: route.policy } : {}),
          ...(benchFalloverFrom ? { falloverFrom: benchFalloverFrom } : {}),
        },
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
          ? await runClaudeAgentSdkWorker(input, workerModel, sessionId, sourceUserSeq)
          : await (async () => {
              const { runCrossProviderWorker } = await import('../agents/sub-agents.js');
              return runCrossProviderWorker(input, workerModel, sessionId, sourceUserSeq);
            })();
        const ok = !workerResultIndicatesFailure(result.text);
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
        const subagentRunId = `w-${routeStartedAt}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          const ctx = getToolOutputContext();
          const capped = !ok && /MaxTurnsExceeded|hit its turn cap/i.test(result.text ?? '');
          const resultProvider = route.claudeLane
            ? 'claude'
            : resolveEffectiveProviderForModel(result.model ?? workerModel);
          recordSubagentRun({
            id: subagentRunId,
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
        // Stage 3 reduce tier: past ~8 results the return compresses to a
        // parked digest + shard summaries; small fan-outs are byte-identical.
        return textResult(await buildWorkerReturn({
          sessionId,
          parentRunId: getToolOutputContext()?.workflowRunId || sessionId,
          item: input.item,
          text: result.text,
          callId: `call_${subagentRunId}`,
        }));
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
    }
  };
}
