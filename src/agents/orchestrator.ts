import { Agent, tool } from '@openai/agents';
import type { Handoff } from '@openai/agents';
import { z } from 'zod';
import { getRuntimeEnv, MODELS } from '../config.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { getSessionWorkerModelOverride } from '../runtime/harness/session-role-overrides.js';
import type { RuntimeContextValue, TaskContinuationContext } from '../types.js';
import { buildPlannerTool } from './planner.js';
// Phase 3 (v0.5.16): single-agent mode — Clem completes the user's
// request without delegating. The 5 specialized sub-agents (Researcher
// / Writer / Reviewer / Executor / Deployer) were removed after going
// dormant under the single-agent prompt.
//
// EXCEPTION: the Worker. Worker is a STATELESS leaf agent for parallel
// fan-out — Clem calls run_worker(prompt) N times concurrently to
// process N independent items (50 Salesforce tasks, 10 DataForSEO
// scrapes, etc.). Each call gets its own isolated SDK context, so
// N=50 ≠ one balloon context with 50× the tools. The Worker has no
// approval surface of its own (sticky approvals from the parent cover
// composio writes); it just does one job and returns.
import { buildWorkerAgent } from './sub-agents.js';
import {
  workerPacketMcpToolScope,
} from './external-mcp-scope-lock.js';
import { harnessInstructions } from './harness-context.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { enabledExternalServerNames } from '../runtime/mcp-servers.js';
import { batchShapeDirective } from '../tools/batch-shape-directive.js';
import { toolCallHint } from '../runtime/harness/tool-call-hint.js';
import { detectMultiItemIntentFromConversation } from '../runtime/harness/context-packet.js';
import { resolveMcpToolScope, resolveMcpToolScopeWithRecall, type McpToolScope } from '../runtime/mcp-tool-scope.js';
import { renderCapabilityCandidateCard, type TurnCapabilityCandidates } from '../runtime/read-path/capability-candidates.js';
import { bindAgentMcpToolScope } from '../runtime/mcp-tool-authority.js';
import { createHash } from 'node:crypto';
import { getHarnessBudgetSettings } from '../runtime/harness/budget-settings.js';
import { getProactivityPolicySnapshot } from './proactivity-policy.js';
import { appendAgentCapabilityBinding, bindAgentCapabilityEnvelope, bindAgentCapabilityRevision, sealAgentCapabilityUniverse, type SealableToolLike } from './capability-envelope.js';
import { composioStandingPolicyCapabilityHints } from '../integrations/composio/standing-policy-adapter.js';
import { priorTurnEndedAwaitingClarification } from '../runtime/harness/convergence-steer.js';
import type { Tool } from '@openai/agents';
import {
  appendEvent,
  listEvents,
  resolveToolOutputEvidenceExcerptsForAuthority,
  resolveToolOutputExcerptsForAuthority,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { getCheckIn } from './check-ins.js';
import { constrainNeedsInputPresentationForRecovery } from '../runtime/harness/recovery-presentation-truth.js';
import { observedConnectionDependencyPresentationForSource } from '../runtime/harness/dependency-request.js';
import {
  unresolvedRecipientClarification,
  type ExactRecipientActionPath,
  type RecipientTurnObservation,
} from '../runtime/harness/unresolved-recipient-clarification.js';
import { clarificationBlockedByGoal, compileAcceptedGoal } from '../runtime/graph/accepted-goal.js';
import { fanoutBudgetStatus, formatTokens } from '../runtime/harness/run-token-budget.js';
import { resolveRubricVariant, DEFAULT_RUBRIC_VARIANT } from './rubric-variant.js';
import {
  ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS_LEAN,
  ORCHESTRATOR_BEHAVIOR_NATIVE,
} from './clem-rubric.js';
import { resolveToolJitDecision, selectToolsForTurn, recallPinnedBuiltinTools } from './tool-jit.js';
import { resolveToolSearchDecision, resolveHotSet, buildCompactToolCatalog } from './tool-catalog.js';
import {
  composeSessionFromStore,
  pinCompositionHotTools,
  pinCompositionTools,
} from '../runtime/harness/session-composition.js';
import { actionControlAdmittedForTaskState, actionControlContextFor, actionTopologyRoleFor, deriveOrchestratorDiscoveryNames, isRegistryDeclaredRead } from '../tools/tool-registry.js';
import { buildCallTool, type BuildCallToolOptions, type BuiltinCapabilityAdmissionResult } from '../tools/call-tool.js';
import { buildWorkCall, type BuildWorkCallOptions } from '../tools/work-call.js';
import { buildPlanTaskTool } from '../tools/plan-tools.js';
import { uniqueWorkflowRunRequest } from '../tools/named-workflow-match.js';
import {
  disclosePrimaryModelPlanningCapabilities,
  inspectPrimaryModelPlanningReadCapability,
  inspectPrimaryModelPlanningSingleActionCapability,
  snapshotPrimaryModelPlanningContext,
  type HostFreshPlanningContextV1,
} from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import { actionExpectedWorkCarrierSelection } from '../runtime/harness/action-expected-work-boundary.js';
import {
  formatFrozenNodeBindings,
  formatFrozenWorkAuthority,
  frozenCreateDestinationFamily,
  loadBoundExpectedWorkContract,
  resolveFrozenNodeBindings,
} from '../runtime/harness/frozen-work-surface.js';
import { resolveActionTaskState } from '../runtime/harness/action-task-state.js';
import { factorySkipForCompiledRoute } from '../runtime/graph/turn-graph-compiler.js';
import {
  buildScopedLocalToolSearch,
  getLocalToolSchemas,
} from '../tools/local-runtime-tools.js';
import {
  durableSelectedLocalPlanningCapabilityNames,
  isRegistryDeclaredLocalPlanningCapability,
  isWorkCallConfiguredLocalPlanningCapability,
} from '../runtime/harness/local-planning-capability.js';
import {
  accountSelectionBlockersFromSearchResult,
  buildAuthorizedToolSearchCandidateSources,
  connectedAccountExplicitlySelectedInCurrentText,
  sessionEstablishedConnectedAccountEmail,
  stageDisclosedPlanningProviderCandidates,
  uniqueConnectedAccountQuestion,
} from '../tools/tool-search-provider-sources.js';
import {
  toolSearchBrokerCoverage,
  type ToolSearchPlanningDisclosureCandidate,
} from '../tools/tool-search-tool.js';
import { discoveryGovernor } from '../runtime/harness/discovery-governor.js';
import { dynamicReasoningEnabled } from '../runtime/harness/reasoning-effort.js';
import { openPlanScope } from './plan-scope.js';
import { loadProactivityPolicy } from './proactivity-policy.js';
import { buildWorkerJobPrompt, resolveWorkerMaxTurns, uniformFailureSignature, workerPacketKey, WorkerToolInputSchema, WorkerToolCallSchema, workerCallItems, workerResultIndicatesFailure, type WorkerToolInput, type WorkerToolCall } from './worker-job-packet.js';
import { clearFanoutUniformFailure, fanoutUniformFailure, markFanoutUniformFailure, workerItemAlreadyCapped, workerAlreadyCompletedForPacket, workerResumeIdempotencyEnabled } from './worker-respawn-guard.js';
import { acquireWorkerSlot, workerBatchPoolWidth } from './worker-concurrency.js';
import {
  completedWorkerBatchPacket,
  isWorkerBatchGenerationCancellation,
  renderWorkerBatchRemainder,
  runResumableWorkerBatch,
  workerBatchKey,
  WorkerBatchIdentityError,
  WorkerBatchOwnershipConflictError,
  type WorkerBatchExecutionResult,
  type WorkerBatchExecutionLease,
} from './worker-batch-execution.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { looksLikeUnknownModelError, markByoModelNotServed, repairByoRoutedModelId, resolveEffectiveProviderForModel } from '../runtime/harness/byo-providers.js';
import { markWorkerModelCoolingDown, pickWorkerModelWithFallover, workerFailureLooksRateLimited } from './worker-model-fallover.js';
import { maybeHeavyPerItemToolAdvisory } from './fanout-alignment-gate.js';
import { faultInjectWorkerModel, injectedWorkerRateLimitText } from '../runtime/harness/fault-inject.js';
import { recordSubagentRun, findCompletedSubagentOutput } from './subagent-runs.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { buildWorkerReturn } from '../runtime/harness/fanout-reduce.js';
import {
  checkpointPreparedWorker,
  completedPreparedWorker,
  fencePreparedWorkerInFlight,
  prepareWorkerManifest,
  summarizePreparedWorkerReuse,
  type PreparedWorkerManifest,
  type WorkerManifestDescriptor,
} from '../runtime/harness/work-manifest.js';
import { evaluateQuantifiedWorkManifestGate } from '../runtime/harness/quantified-work-manifest.js';
import { currentToolAbortDeadlineAt, currentToolAbortSignal } from '../runtime/tool-abort-context.js';
import type { DispatchLeaseRef } from '../runtime/harness/dispatch-lease.js';
import {
  actionExpectedWorkRequired,
  bindWorkerPacketExpectedWork,
} from '../runtime/harness/expected-work-admission.js';
import {
  harnessInputGuardrails,
  harnessOutputGuardrails,
} from '../runtime/harness/guardrails.js';
import { assertNotKilled, DEFAULT_MAX_TURNS, harnessRunContextStorage, KillRequested, wrapToolForHarness, workerThrashGuardEnabled, withHarnessRunContext, ToolCallsCounter, defaultToolCallsPerTurn, type WrappableTool } from '../runtime/harness/brackets.js';
import { claudeAgentSdkWorkerEnabled, runClaudeAgentSdkWorker } from '../runtime/harness/claude-agent-worker.js';
import { AgentRuntimeCancelledError } from '../runtime/provider.js';
import { falloverBrainModelIds } from '../runtime/harness/model-role-options.js';
import { resolveEffectiveToolPolicy } from '../runtime/harness/tool-policy.js';
import { resolveToolSurface } from '../runtime/harness/tool-surface.js';
import {
  bareTerminalToolName,
  formatAutoResolvedAskUserQuestionOutput,
  formatAwaitingUserInputFinalOutput,
  formatControlReceiptFinalOutput,
  isTerminalToolName,
  renderTerminalToolReply,
  terminalToolShouldHalt,
} from '../runtime/harness/terminal-tool.js';
import { projectHostOwnedAsyncReadRefinementTerminal } from '../runtime/harness/async-read-refinement-terminal-projection.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { pendingActionRequiresHumanApproval } from '../runtime/harness/pending-action-policy.js';

/**
 * Clem (display name) — the top of the 0.3 harness. Internally the
 * Agent name is "Clem"; in logs, transcripts, the Discord bot status,
 * and the dashboard activity feed everything reads "Clem" instead of
 * the abstract "Orchestrator" label that was confusing on a
 * single-agent setup.
 *
 * Plan contract: this is now a SINGLE agent (Phase 3, v0.5.16). All
 * action tools live directly on the orchestrator surface — no
 * delegation, no handoffs. The five specialized sub-agents
 * (Researcher / Writer / Reviewer / Executor / Deployer) were removed
 * after going dormant under the single-agent prompt. Worker survives
 * as a parallel-fan-out leaf invoked via `run_worker(prompt)` for
 * N-independent-items work.
 *
 * The turn output is PLAIN TEXT + an optional one-line marker (ASK: /
 * CONTINUE:), parsed by the loop (parseDecisionText). Worker fan-out happens
 * via parallel tool calls to run_worker, which IS parallelizable because
 * run_worker is a tool, not a handoff.
 *
 * Input + output guardrails come from the harness registry so the
 * SDK enforces policy_violation / missing_capability before any
 * tokens are spent, and secret_leak after the final output.
 */

// Field ORDER is deliberate: `reply` is FIRST so the model generates the
// user-visible text before the internal log line — token streaming surfaces
// `reply` as it forms (stream-reply.ts), so reply-first means visible text
// starts streaming the moment the model starts answering instead of after
// the summary. Schema key order drives generation order under structured
// output. (Streaming-latency fix, 2026-06-11.)
export const OrchestratorDecisionSchema = z.object({
  reply: z
    .string()
    .nullish()
    .describe('The natural-language message to show the user IN THIS TURN. Write this FIRST. REQUIRED when nextAction=completed, including greetings, small talk, confirmations, and final results. Pass null ONLY when nextAction is awaiting_approval or awaiting_user_input because that approval/question text is already in front of the user. There is no separate executor, so "I am handing off" is NEVER a reason to pass null. Without a reply here, the harness treats the decision as invalid and retries.'),
  summary: z
    .string()
    .min(8)
    .describe('One-sentence INTERNAL description of what you decided and/or did this turn. This is a log entry, NOT what the user sees. e.g. "Replied to greeting directly", "Handed off to Researcher for slug discovery".'),
  done: z
    .boolean()
    .describe(
      'Whether the user request is fully handled. False means another turn (or user reply) is still needed.',
    ),
  nextAction: z
    .enum([
      'awaiting_user_input',
      'awaiting_approval',
      'awaiting_handoff_result',
      'completed',
      'abandoned',
    ])
    .describe('What the harness should expect next. `completed` = request fully handled (or you are awaiting the user/approval). `awaiting_user_input` = you called ask_user_question. `awaiting_approval` = a mutating tool paused. `abandoned` = genuinely impossible. Do NOT use `awaiting_handoff_result` to "acknowledge now and act next turn" — there is no separate executor to hand off to. If you have more tool calls to make, make them in THIS turn; never reply "running it now" / "on it" and defer with no tool call (that wastes a full round-trip and the harness will force the action anyway).'),
  reason: z.string().nullable().describe('Free-form context for the next caller.'),
});
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;

export interface BuildOrchestratorAgentOptions {
  /**
   * Fresh user prompt for the turn. When present, Clementine scopes external
   * MCP tools to the likely domain so every run does not pay for every
   * connected server's schema.
   */
  userInput?: string | null;
  /** Advisory capability candidates the bridge resolved for THIS accepted
   * turn. Delivery is the request/build-options path only — candidates widen
   * the visible surface and the advisory card; they decide nothing. */
  turnCandidates?: TurnCapabilityCandidates;
  /** Exact bridge-derived clarification context. Raw userInput remains the
   * current answer; parentInput participates only as verified prior context. */
  taskContinuation?: TaskContinuationContext;
  taskContinuationResolved?: true;
  /** Session id for best-effort tool-scope telemetry. */
  sessionId?: string | null;
  /** Exact accepted source. When present, durable graph authority—not prompt
   * wording—decides whether the action-only work carrier is exposed. */
  sourceUserSeq?: number;
  /** Host-compiled route for this exact accepted source. Non-action routes
   * skip the action-authority read entirely, preserving their prior build cost. */
  acceptedRoute?: 'direct_reply' | 'retrieve' | 'act';
  /** Graph-neutral host chat entry. The foreground model may freeze one exact
   * action graph through plan_task; these descriptors are advisory input to
   * that host-validated control, never execution authority themselves. */
  hostFreshPlanning?: HostFreshPlanningContextV1;
  /** Surface-only closed-world chat optimization. No graph/route authority. */
  hostPlainConversation?: true;
  /** Test/advanced override. */
  mcpToolScope?: McpToolScope;
  /**
   * Per-call tool-exclusion. Names listed here are filtered OUT of the agent's
   * harness tool surface before construction (matched against the wrapped
   * tool's name). This lets callers that need a NARROWED surface — the workflow
   * architect (hides workflow_* mutators) and the autonomy lane (no external
   * writes) — ride the gated harness loop instead of the legacy ungated core.
   * Absent/empty ⇒ full surface (byte-identical to before). Does not affect
   * external MCP-server tools, which are resolved dynamically; the real callers
   * only ever exclude harness tools (workflow_*, composio_execute_tool).
   */
  excludeToolNames?: string[];
  /**
   * Exact local harness tool authority for this call. Unlike an absent value,
   * an empty array is meaningful and produces a decision-only agent with no
   * local tools and no external MCP attachment.
   */
  allowedToolNames?: string[];
  /**
   * Per-call model override. When provided, the agent runs on this model instead
   * of the role-registry brain default — needed so workflow-step lanes that
   * route grunt-work to a cheaper worker model (forEach fan-out) can ride the
   * gated harness loop without losing that routing.
   */
  model?: string;
  /**
   * Phase 1 Tool-RAG gate. JIT tool loading (CLEMMY_TOOL_JIT) only ever applies
   * when this is true AND there is a userInput. It MUST be set ONLY on interactive
   * chat lanes where a user is present turn-by-turn — never on autonomous lanes
   * (cron / background / workflow steps / goal-resume / outcome), which cannot
   * recover a JIT-dropped built-in tool (no mid-run acquisition exists yet) and
   * have no user to consult. Default (undefined/false) ⇒ full surface, so a new
   * caller is safe-by-omission.
   */
  allowToolJit?: boolean;
}

/**
 * Rebuild the orchestrator for a parked approval using the connector authority
 * captured beside that exact RunState. A plain build with no userInput preserves
 * the legacy allow-all surface; that is correct for old/internal callers but
 * wrong for a scoped run resuming after approval. Legacy pauses created before
 * scope persistence still fall back to the prior construction behavior.
 */
export async function buildOrchestratorAgentForApprovalResume(
  options: Omit<BuildOrchestratorAgentOptions, 'mcpToolScope'> & { sessionId: string },
): Promise<Agent<RuntimeContextValue, any>> {
  const pausedScope = HarnessSession.load(options.sessionId)?.loadInterruptMcpToolScope() ?? undefined;
  return buildOrchestratorAgent({
    ...options,
    ...(pausedScope ? { mcpToolScope: pausedScope } : {}),
  });
}

/** Schema-on-demand already exposes mcp_status + mcp_list_tools + call_tool, so
 * an unknown-intent chat does not need to connect every configured external
 * server just to keep obscure apps discoverable. Preserve concrete keyword /
 * recalled scopes for one-hop speed; defer only the broad fail-open candidate
 * until the model selects a named server. */
export function externalMcpAttachmentScope(
  scope: McpToolScope,
  schemaOnDemandActive: boolean,
): McpToolScope {
  if (!schemaOnDemandActive || !scope.failOpenCandidate) return scope;
  return {
    reason: `${scope.reason}; external MCP connection deferred to mcp_list_tools/call_tool`,
    // Deferral, not denial — the whole point is that the model reaches these
    // servers later through call_tool. Treating the deferred surface as zero
    // authority is what made "connect it later" mean "you never can".
    authority: 'catalog',
    allowedServerSlugs: [],
    toolPatterns: [],
    maxTools: 0,
  };
}

// A turn that explicitly selects Clementine memory ("use only local memory",
// "remember this", or a recent-conversation recall) needs a much narrower
// built-in capability surface. Keep every read/recovery hatch that can answer
// from local memory, but do not pay to serialize unrelated workflow, admin,
// file-write, or focus-mutation schemas. The implicit forms remain phrase-tight:
// ordinary memory-ish questions retain the full schema-on-demand catalog.
const LOCAL_MEMORY_ONLY_BUILTINS = new Set([
  'focus_get',
  'memory_list_facts',
  'memory_read',
  'memory_recall',
  'memory_recall_all',
  'memory_remember',
  'memory_search',
  'memory_search_facts',
  'recall_tool_result',
  'session_history',
  'tool_output_query',
]);
const LOCAL_MEMORY_ONLY_TURN_RE = /\b(?:(?:use|using|consult|read|search|check)\s+only\s+(?:clementine(?:'s)?\s+)?local\s+memory|local\s+memory\s+only)\b/i;
const EXPLICIT_MEMORY_STORE_TURN_RE = /^\s*(?:please\s+)?remember\s+(?:this|that|exactly)\b/i;
const RECENT_CONVERSATION_RECALL_TURN_RE = /\b(?:i|we)\s+(?:told|mentioned|said|shared(?:\s+with)?)\s+you\b[^\n.!?]{0,100}\b(?:a\s+(?:moment|minute)\s+ago|earlier|before|previously|last\s+time)\b/i;
const NO_MEMORY_WRITE_TURN_RE = /\b(?:do\s+not|don'?t|never)\s+(?:write|change|modify|update)(?:\s+or\s+(?:write|change|modify|update))?\s+(?:to\s+)?(?:my\s+|the\s+|any\s+)?(?:durable\s+|long[- ]term\s+)?memory\b/i;

export function localMemoryBuiltinScope(input: string | null | undefined): Set<string> | null {
  const text = input?.trim() ?? '';
  if (!text) return null;
  const explicitLocalOnly = LOCAL_MEMORY_ONLY_TURN_RE.test(text);
  const explicitStore = EXPLICIT_MEMORY_STORE_TURN_RE.test(text);
  const recentConversationRecall = RECENT_CONVERSATION_RECALL_TURN_RE.test(text);
  if (!explicitLocalOnly && !explicitStore && !recentConversationRecall) return null;
  const allowed = new Set(LOCAL_MEMORY_ONLY_BUILTINS);
  if (NO_MEMORY_WRITE_TURN_RE.test(text) || (recentConversationRecall && !explicitStore)) {
    allowed.delete('memory_remember');
  }
  return allowed;
}

// ---------- internal helpers ----------

/** Intent-routed chat workers (default on). off => run_worker ignores the
 *  optional packet intent and uses the role-wide Worker binding. */
function workerIntentRoutingEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKER_INTENT_ROUTING', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/** Cross-provider worker fallover (shares the brain-fallover switch): a Claude SDK
 *  worker that overloads OR whose auth expired BEFORE committing re-runs the item on
 *  the next connected brain. Default ON (kill-switch CLEMMY_BRAIN_FALLOVER=off) —
 *  parity with the router, chat, and workflow lanes (2026-07-20: this lane was left
 *  default-off when the others were flipped, so a configured fallback brain never
 *  engaged for fan-out workers). falloverBrainModelIds returns [] when no other brain
 *  is connected, so a single-brain user is an automatic no-op. */
function workerBrainFalloverEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** Commit-safe worker cross-brain fallover eligibility — mirror of the chat lane's
 *  isChatBrainFalloverEligible (respond-bridge.ts). Eligibility ladder:
 *  1. NEVER an intentional stop (user cancel / kill / abort) — not a brain failure.
 *  2. Any typed committed-aware error trusts its flag: committed=true → refuse (a
 *     committed external write must never be blindly re-driven on another brain);
 *     committed=false → eligible (auth-expiry is committed=false by construction:
 *     auth fails before any tool runs — the worker-lane twin of the 2026-07-20
 *     router/workflow auth-aware fix).
 *  3. Any OTHER terminal Error (5xx, transport timeout, rate-limit, SDK internal
 *     throw) is eligible — the worker fallover re-runs the item in the SAME parent
 *     session, so the duplicate-send HARD WALL (brackets.ts, durable external_write
 *     events) blocks any re-send of an already-committed irreversible write, exactly
 *     the property that justifies the chat lane's broad eligibility. Before
 *     2026-07-20 only overload + auth-expiry qualified here, so a commit-safe 5xx
 *     hard-failed the item while every other lane fell over. */
export function isCommitSafeWorkerFallover(err: unknown): boolean {
  if (err instanceof AgentRuntimeCancelledError) return false;
  const name = err instanceof Error ? err.name : '';
  if (/cancel|kill|abort/i.test(name)) return false;
  const committed = (err as { committed?: unknown } | null | undefined)?.committed;
  if (typeof committed === 'boolean') return !committed;
  return err instanceof Error;
}

interface ChatWorkerModelRoute {
  model?: string;
  trace?: {
    seam: 'chat';
    attemptedIntent: string;
    matchedIntent: string | null;
    item: string;
    modelId: string;
    provider: string;
    source: string;
  };
}

function resolveChatWorkerModel(input: Pick<WorkerToolInput, 'intent' | 'item' | 'model'>): ChatWorkerModelRoute {
  // ONE LOOP, MANY BRAINS: an exact per-packet model wins — Clem spreads a
  // fleet across models per item ("these five on codex, those on grok").
  // Permissive: an unroutable id falls through to intent/role routing; a
  // packet model NEVER refuses the dispatch.
  const exact = input.model?.trim();
  if (exact) {
    try {
      const provider = resolveEffectiveProviderForModel(exact);
      if (provider) {
        return {
          model: exact,
          trace: {
            seam: 'chat',
            attemptedIntent: input.intent ?? '',
            matchedIntent: null,
            item: input.item,
            modelId: exact,
            provider,
            source: 'packet',
          },
        };
      }
    } catch { /* fall through to intent routing */ }
  }
  if (!workerIntentRoutingEnabled() || !input.intent) return {};
  const routed = resolveRoleModel('worker', input.intent);
  return {
    model: routed.modelId,
    trace: {
      seam: 'chat',
      attemptedIntent: input.intent,
      matchedIntent: routed.matchedIntent ?? null,
      item: input.item,
      modelId: routed.modelId,
      provider: routed.provider,
      source: routed.source,
    },
  };
}

export const orchestratorInternalsForTest = {
  resolveChatWorkerModel,
  workerIntentRoutingEnabled,
};

type OrchestratorToolResult = {
  type: string;
  tool: { name?: string };
  output?: unknown;
  argumentsJson?: string;
  runItem?: unknown;
};

type AccountSelectionRequirement = Readonly<{
  roleKey: string;
  text: string;
  resolved: boolean;
}>;

type UserChoiceHaltContext = Readonly<{
  actionExpectedWork?: boolean;
  accountSelectionRequirements?: readonly AccountSelectionRequirement[];
}>;

const ASK_USER_QUESTION_CANDIDATE_KIND = 'clementine.ask_user_question.candidate' as const;

type AskUserQuestionCandidate = {
  kind: typeof ASK_USER_QUESTION_CANDIDATE_KIND;
  status: 'staged';
  posted: false;
  question: string;
  options: string[] | null;
  purpose: 'clarification' | 'approval' | null;
};

function askUserQuestionCandidate(output: unknown): AskUserQuestionCandidate | null {
  let value = output;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AskUserQuestionCandidate>;
  if (
    candidate.kind !== ASK_USER_QUESTION_CANDIDATE_KIND
    || candidate.status !== 'staged'
    || candidate.posted !== false
    || typeof candidate.question !== 'string'
    || !(
      candidate.options === null
      || (Array.isArray(candidate.options) && candidate.options.every((option) => typeof option === 'string'))
    )
    || !(
      candidate.purpose === null
      || candidate.purpose === 'clarification'
      || candidate.purpose === 'approval'
    )
  ) return null;
  return candidate as AskUserQuestionCandidate;
}

function exactAskUserQuestionCandidateKey(candidate: AskUserQuestionCandidate): string {
  return JSON.stringify([candidate.question, candidate.options, candidate.purpose]);
}

function renderAskUserQuestionCandidates(candidates: AskUserQuestionCandidate[]): {
  question: string;
  options: string[] | null;
} {
  const [only] = candidates;
  if (candidates.length === 1 && only) {
    return { question: only.question, options: only.options };
  }
  const countLabel = candidates.length === 2 ? 'two' : String(candidates.length);
  const answerLabel = candidates.length === 2 ? 'both answers' : 'each answer';
  const blocks = candidates.map((candidate, index) => {
    const lines = [`${index + 1}. ${candidate.question.trim()}`];
    for (const option of candidate.options ?? []) {
      const text = option.trim();
      if (text) lines.push(`   - ${text}`);
    }
    return lines.join('\n');
  });
  return {
    question: [
      `I need ${countLabel} quick details so I can get this right:`,
      ...blocks,
      `Reply with ${answerLabel} in your own words; the choices are just shortcuts.`,
    ].join('\n\n'),
    // Each candidate owns its own option set. Flattening them into the legacy
    // top-level array would make a reply like "2" ambiguous, so the bundled
    // question renders those choices inline and keeps the outer options empty.
    options: null,
  };
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try { return JSON.stringify(output); } catch { return String(output ?? ''); }
}

function toolCallInputOf(result: OrchestratorToolResult): unknown {
  if (typeof result.argumentsJson !== 'string' || !result.argumentsJson.trim()) return null;
  try {
    return JSON.parse(result.argumentsJson) as unknown;
  } catch {
    return null;
  }
}

function questionFromCheckInReceipt(output: string): string | null {
  const match = /^Check-in created:\s*(chk-[A-Za-z0-9-]+)/i.exec(output.trim());
  if (!match) return null;
  try {
    const question = getCheckIn(match[1]!)?.question?.trim();
    return question || null;
  } catch {
    return null;
  }
}

type ExactAcceptedRecipientSource = {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  text: string;
};

function exactAcceptedRecipientSource(context: unknown): ExactAcceptedRecipientSource | null {
  const sessionId = extractSessionId(context);
  const sourceUserSeq = extractSourceUserSeq(context);
  if (!sessionId || !sourceUserSeq) return null;
  const sources = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
  }).filter((event) => event.data.synthetic !== true);
  const source = sources.find((event) => event.seq === sourceUserSeq);
  if (!source || sources.some((event) => event.seq > sourceUserSeq)) return null;
  const displayText = typeof source.data.displayText === 'string'
    ? source.data.displayText.trim()
    : '';
  const text = displayText || (typeof source.data.text === 'string' ? source.data.text.trim() : '');
  return text ? { sessionId, sourceUserSeq, turn: source.turn, text } : null;
}

function parsedToolSearchRows(output: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 2) return [];
  let value = output;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return []; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.results)) {
    return record.results.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === 'object' && !Array.isArray(row)
    ));
  }
  if (!Array.isArray(record.content)) return [];
  return record.content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' ? parsedToolSearchRows(text, depth + 1) : [];
  });
}

type ParsedToolSearchEnvelope = Readonly<{
  query: string;
  roleKey: string;
  rows: readonly Record<string, unknown>[];
}>;

function parsedToolSearchEnvelope(output: unknown, depth = 0): ParsedToolSearchEnvelope | null {
  if (depth > 2) return null;
  let value = output;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const roleKey = typeof record.role_key === 'string' ? record.role_key : '';
  if (query && roleKey && Array.isArray(record.results)) {
    return {
      query,
      roleKey,
      rows: record.results.filter((row): row is Record<string, unknown> => (
        Boolean(row) && typeof row === 'object' && !Array.isArray(row)
      )),
    };
  }
  if (!Array.isArray(record.content)) return null;
  for (const part of record.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const text = (part as Record<string, unknown>).text;
    if (typeof text !== 'string') continue;
    const parsed = parsedToolSearchEnvelope(text, depth + 1);
    if (parsed) return parsed;
  }
  return null;
}

function accountSelectionOperationNamespace(operation: string): string {
  return operation.trim().toLowerCase().split(/[^a-z0-9]+/).find(Boolean) ?? '';
}

function textExplicitlyNamesOperationNamespace(text: string, namespace: string): boolean {
  if (namespace.length < 4) return false;
  return text.toLowerCase().split(/[^a-z0-9]+/).some((token) => (
    token === namespace
  ));
}

function accountSelectionCandidateMatchesRequiredRole(input: {
  acceptedText: string;
  requirementText: string;
  query: string;
  operation: string;
}): boolean {
  const normalizedAccepted = input.acceptedText.replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedRequirement = input.requirementText.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedRequirement || !normalizedAccepted.includes(normalizedRequirement)) return false;
  const namespace = accountSelectionOperationNamespace(input.operation);
  return textExplicitlyNamesOperationNamespace(input.acceptedText, namespace)
    && textExplicitlyNamesOperationNamespace(input.requirementText, namespace)
    && textExplicitlyNamesOperationNamespace(input.query, namespace);
}

/** A host-authored account question is a narrow optimization, not a semantic
 * router. It needs an exact host-frozen unresolved role, the exact query echoed
 * by the settled search, and that search's top-ranked matching blocker. If any
 * link is missing, the complete result remains with the model. */
function taskRequiredAccountSelectionBlockers(input: {
  source: ExactAcceptedRecipientSource;
  result: OrchestratorToolResult;
  requirements: readonly AccountSelectionRequirement[];
}): Array<{ name: string; choices: string[] }> {
  const envelope = parsedToolSearchEnvelope(input.result.output);
  const invocation = toolCallInputOf(input.result);
  if (!envelope || !invocation || typeof invocation !== 'object' || Array.isArray(invocation)) return [];
  const invocationRecord = invocation as Record<string, unknown>;
  const query = typeof invocationRecord.query === 'string' ? invocationRecord.query : '';
  const roleKey = typeof invocationRecord.role_key === 'string' ? invocationRecord.role_key : '';
  if (!query || query !== envelope.query || !roleKey || roleKey !== envelope.roleKey) return [];
  const requirement = input.requirements.find((candidate) => (
    candidate.resolved === false && candidate.roleKey === roleKey
  ));
  if (!requirement) return [];
  const topName = typeof envelope.rows[0]?.name === 'string'
    ? envelope.rows[0].name.trim()
    : '';
  if (!topName || !accountSelectionCandidateMatchesRequiredRole({
    acceptedText: input.source.text,
    requirementText: requirement.text,
    query,
    operation: topName,
  })) return [];
  const matching = accountSelectionBlockersFromSearchResult(input.result.output)
    .filter((blocker) => blocker.name === topName);
  return uniqueConnectedAccountQuestion(matching) ? matching : [];
}

function capabilityRecipientPathFromBatch(
  source: ExactAcceptedRecipientSource,
  toolResults: readonly OrchestratorToolResult[],
): ExactRecipientActionPath | null {
  const publicRows = new Map<string, { capabilityRef: string; identifier: string }>();
  for (const result of toolResults) {
    if (result.type !== 'function_output') continue;
    if (bareTerminalToolName(result.tool.name ?? '') !== 'tool_search') continue;
    for (const row of parsedToolSearchRows(result.output)) {
      const capabilityRef = typeof row.capabilityRef === 'string' ? row.capabilityRef.trim() : '';
      const identifier = typeof row.name === 'string' ? row.name.trim() : '';
      if (!capabilityRef || !identifier) continue;
      publicRows.set(JSON.stringify([capabilityRef, identifier.toLowerCase()]), {
        capabilityRef,
        identifier,
      });
    }
  }
  if (publicRows.size === 0) return null;

  const accountsByPublicRow = new Map<string, Set<string>>();
  for (const event of listEvents(source.sessionId, { types: ['capability_discovered'] })) {
    if (event.data.sourceUserSeq !== source.sourceUserSeq) continue;
    const capabilities = Array.isArray(event.data.capabilities) ? event.data.capabilities : [];
    for (const raw of capabilities) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const capabilityRef = typeof row.capabilityRef === 'string' ? row.capabilityRef.trim() : '';
      const identifier = typeof row.identifier === 'string' ? row.identifier.trim() : '';
      const accountIdentity = typeof row.accountIdentity === 'string' ? row.accountIdentity.trim() : '';
      if (!capabilityRef || !identifier || !accountIdentity) continue;
      const publicKey = JSON.stringify([capabilityRef, identifier.toLowerCase()]);
      if (!publicRows.has(publicKey)) continue;
      const accounts = accountsByPublicRow.get(publicKey) ?? new Set<string>();
      accounts.add(accountIdentity);
      accountsByPublicRow.set(publicKey, accounts);
    }
  }
  if (accountsByPublicRow.size !== publicRows.size) return null;
  const accounts = [...accountsByPublicRow.values()];
  if (accounts.some((values) => values.size !== 1)) return null;
  const accountIdentities = new Set(accounts.map((values) => [...values][0]!));
  if (accountIdentities.size !== 1) return null;
  const capabilityRefs = [...publicRows.values()].map((row) => row.capabilityRef);
  if (new Set(capabilityRefs).size !== capabilityRefs.length) return null;
  return {
    kind: 'capability_refs',
    sourceUserSeq: source.sourceUserSeq,
    capabilityRefs,
    accountIdentity: [...accountIdentities][0]!,
    accountIdentityProvenance: 'same_source_capability_discovered',
  };
}

function selectedAccountRecipientPathFromBatch(
  source: ExactAcceptedRecipientSource,
  toolResults: readonly OrchestratorToolResult[],
): ExactRecipientActionPath | null {
  const blockers = toolResults.flatMap((result) => (
    result.type === 'function_output'
    && bareTerminalToolName(result.tool.name ?? '') === 'tool_search'
      ? accountSelectionBlockersFromSearchResult(result.output)
      : []
  ));
  if (blockers.length === 0 || blockers.some((blocker) => blocker.choices.length < 2)) return null;
  const choiceSets = new Set(blockers.map((blocker) => JSON.stringify(
    [...blocker.choices].map((choice) => choice.trim().toLowerCase()).sort(),
  )));
  if (choiceSets.size !== 1) return null;
  const uniqueChoices = uniqueConnectedAccountQuestion(blockers);
  if (!uniqueChoices) return null;
  const operations = [...new Set(blockers.map((blocker) => blocker.name.trim()).filter(Boolean))];
  if (operations.length === 0) return null;
  const selected = connectedAccountExplicitlySelectedInCurrentText({
    text: source.text,
    choices: uniqueChoices.choices,
  });
  if (!selected) return null;
  return {
    kind: 'selected_account_blockers',
    sourceUserSeq: source.sourceUserSeq,
    operationNames: operations,
    accountChoices: [...uniqueChoices.choices],
    selectedAccountIdentity: selected,
  };
}

function resultBatchCallId(result: OrchestratorToolResult): string | null {
  if (!result.runItem || typeof result.runItem !== 'object') return null;
  const rawItem = (result.runItem as { rawItem?: unknown }).rawItem;
  if (!rawItem || typeof rawItem !== 'object') return null;
  const callId = (rawItem as { callId?: unknown }).callId;
  return typeof callId === 'string' && callId.trim() ? callId.trim() : null;
}

function providerOrderedRecipientObservations(
  source: ExactAcceptedRecipientSource,
  toolResults: readonly OrchestratorToolResult[],
): RecipientTurnObservation[] {
  const ordered = toolResults.flatMap((result) => {
    if (result.type !== 'function_output') return [];
    const callId = resultBatchCallId(result);
    return callId ? [{ callId, result }] : [];
  });
  if (new Set(ordered.map((entry) => entry.callId)).size !== ordered.length) return [];
  const authorityOptions = {
    readOrComputeOnly: true,
    allowedSourceUserSeqs: [source.sourceUserSeq],
    excerptChars: 100_000,
  } as const;
  const automaticEvidence = resolveToolOutputEvidenceExcerptsForAuthority(
    source.sessionId,
    ordered,
    authorityOptions,
  );
  const automaticByCallId = new Map(automaticEvidence.map((evidence) => [evidence.callId, evidence]));
  // Automatic field-authority projection deliberately withholds unstructured
  // provider prose because request echoes cannot safely establish a value.
  // This boundary never establishes a value: it uses the complete verified
  // read only to decide whether to ask a conservative question. A request echo
  // with no exact target-bound identifier still asks; an identifier can only
  // suppress that question. Raw bytes never leave this function and cannot
  // authorize, plan, approve, or dispatch. Incomplete/excerpted bytes abstain.
  const completeByCallId = new Map(resolveToolOutputExcerptsForAuthority(
    source.sessionId,
    ordered,
    authorityOptions,
  ).map((evidence) => [evidence.callId, evidence]));
  return ordered.flatMap(({ callId, result }) => {
    const automatic = automaticByCallId.get(callId);
    const complete = completeByCallId.get(callId);
    if (!automatic || !complete || automatic.excerpted || complete.excerpted) return [];
    const output = automatic.automaticEvidenceSuppressed
      ? complete.output
      : automatic.output;
    return [{
      sourceUserSeq: source.sourceUserSeq,
      toolName: complete.tool ?? result.tool.name ?? '',
      queryText: typeof result.argumentsJson === 'string' ? result.argumentsJson : '',
      result: output,
      settled: true,
      effect: complete.effect ?? '',
      evidenceRole: complete.effect === 'read'
        ? 'source_read'
        : complete.effect === 'compute' ? 'derivation' : null,
    } satisfies RecipientTurnObservation];
  });
}

function eventBelongsToAcceptedRecipientSource(
  event: EventRow,
  source: ExactAcceptedRecipientSource,
): boolean {
  const explicitSource = event.data.sourceUserSeq;
  if (Object.hasOwn(event.data, 'sourceUserSeq')) {
    return Number.isSafeInteger(explicitSource)
      && Number(explicitSource) > 0
      && explicitSource === source.sourceUserSeq;
  }
  return event.seq > source.sourceUserSeq && event.turn === source.turn;
}

function recipientEffectOrApprovalPathEntered(
  source: ExactAcceptedRecipientSource,
  toolResults: readonly OrchestratorToolResult[],
): boolean {
  if (toolResults.some((result) => (
    result.type === 'function_output'
    && bareTerminalToolName(result.tool.name ?? '') === 'request_approval'
  ))) return true;
  const events = listEvents(source.sessionId, { sinceSeq: source.sourceUserSeq });
  return events.some((event) => {
    if (!eventBelongsToAcceptedRecipientSource(event, source)) return false;
    if (
      event.type === 'approval_requested'
      || event.type === 'approval_resolved'
      || event.type === 'approval_parked'
    ) return true;
    if (/^external_write(?:_|$)/.test(event.type)) return true;
    if (event.type !== 'tool_called' && event.type !== 'tool_returned') return false;
    return /^(?:write|local_write|external_write|admin)$/i.test(
      typeof event.data.effect === 'string' ? event.data.effect.trim() : '',
    );
  });
}

function unresolvedRecipientCandidateFromBatch(
  context: unknown,
  toolResults: readonly OrchestratorToolResult[],
): AskUserQuestionCandidate | null {
  const source = exactAcceptedRecipientSource(context);
  if (!source) return null;
  const currentPath = capabilityRecipientPathFromBatch(source, toolResults)
    ?? selectedAccountRecipientPathFromBatch(source, toolResults);
  if (!currentPath) return null;
  const clarification = unresolvedRecipientClarification({
    sourceUserSeq: source.sourceUserSeq,
    acceptedText: source.text,
    currentPath,
    observations: providerOrderedRecipientObservations(source, toolResults),
    effectOrApprovalPathEntered: recipientEffectOrApprovalPathEntered(source, toolResults),
  });
  return clarification ? {
    kind: ASK_USER_QUESTION_CANDIDATE_KIND,
    status: 'staged',
    posted: false,
    question: clarification.question,
    options: null,
    purpose: 'clarification',
  } : null;
}

/** End a provider turn only after a real user-choice pause. Approval-shaped
 * YOLO asks explicitly return a non-halting result and must run the model again. */
export function userChoiceToolUseBehavior(
  context: unknown,
  toolResults: OrchestratorToolResult[],
  haltContext: UserChoiceHaltContext = {},
) {
  // A bounded async read may finish with one immutable host-owned scope gate.
  // Stop on the exact work_call result itself, before another model turn can
  // paraphrase, omit, or accidentally treat it as verified evidence. This is
  // deliberately result-based: work_call remains an ordinary nonterminal
  // carrier for every other output.
  const terminalIdentity = {
    sessionId: extractSessionId(context),
    sourceUserSeq: extractSourceUserSeq(context),
  };
  const asyncScopeGates = toolResults.flatMap((result) => {
    if (result.type !== 'function_output') return [];
    const logicalToolCallId = resultBatchCallId(result);
    if (!terminalIdentity.sessionId || !terminalIdentity.sourceUserSeq || !logicalToolCallId) return [];
    const parsed = projectHostOwnedAsyncReadRefinementTerminal({
      sessionId: terminalIdentity.sessionId,
      sourceUserSeq: terminalIdentity.sourceUserSeq,
      logicalToolCallId,
      rawToolName: result.tool.name ?? '',
      output: result.output,
    });
    return parsed ? [parsed] : [];
  });
  const distinctAsyncQuestions = new Map(asyncScopeGates.map((gate) => [gate.question, gate]));
  if (distinctAsyncQuestions.size === 1) {
    const gate = distinctAsyncQuestions.values().next().value!;
    const sessionId = extractSessionId(context);
    const sourceUserSeq = extractSourceUserSeq(context);
    const turn = extractTurn(context);
    if (sessionId && sourceUserSeq) {
      const existing = listEvents(sessionId, { types: ['awaiting_user_input'] }).find((event) => (
        event.data.source === 'async_read_refinement_terminal'
        && event.data.sourceUserSeq === sourceUserSeq
        && event.data.protocol === gate.protocol
      ));
      if (!existing) {
        appendEvent({
          sessionId,
          turn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: {
            question: gate.question,
            options: [...gate.options],
            purpose: 'clarification',
            source: 'async_read_refinement_terminal',
            sourceUserSeq,
            protocol: gate.protocol,
            terminalKind: gate.terminalKind,
          },
        });
      }
    }
    return {
      isFinalOutput: true as const,
      isInterrupted: undefined,
      finalOutput: formatAwaitingUserInputFinalOutput(gate.question),
    };
  }
  // The SDK executes parallel function calls concurrently, then supplies this
  // callback with the COMPLETE result array in provider order. Treat real asks
  // as staged candidates until this batch boundary: it lets two independent
  // clarifications become one natural public question instead of racing to
  // publish one while both tool receipts falsely claim success.
  const candidates: AskUserQuestionCandidate[] = [];
  const seenCandidates = new Set<string>();
  for (const result of toolResults) {
    if (result.type !== 'function_output') continue;
    if (bareTerminalToolName(result.tool.name ?? '') !== 'ask_user_question') continue;
    const candidate = askUserQuestionCandidate(result.output);
    if (!candidate) continue;
    const key = exactAskUserQuestionCandidateKey(candidate);
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    candidates.push(candidate);
  }
  if (candidates.length === 0 && haltContext.actionExpectedWork !== false) {
    // Which connected account is a fact only the user has, but an incidental
    // provider row is not proof that this task needs that fact. Keep the fast
    // path only for an exact host-frozen unresolved role whose exact settled
    // search ranks the matching blocker first. Everything else goes back to
    // the model with the complete search result.
    const source = exactAcceptedRecipientSource(context);
    const blockers: Array<{ name: string; choices: string[] }> = [];
    for (const result of toolResults) {
      if (result.type !== 'function_output') continue;
      if (bareTerminalToolName(result.tool.name ?? '') !== 'tool_search') continue;
      if (!source) continue;
      blockers.push(...taskRequiredAccountSelectionBlockers({
        source,
        result,
        requirements: haltContext.accountSelectionRequirements ?? [],
      }));
    }
    const unique = uniqueConnectedAccountQuestion(blockers);
    if (unique && source) {
      const { sessionId, sourceUserSeq } = source;
      const connectedEmails = new Set(
        unique.choices.map((choice) => choice.trim().toLowerCase()),
      );
      const established = sessionEstablishedConnectedAccountEmail({
        sessionId,
        sourceUserSeq,
        connectedEmails,
      });
      const currentSelection = connectedAccountExplicitlySelectedInCurrentText({
        text: source.text,
        choices: unique.choices,
      });
      if (!established && !currentSelection) {
        candidates.push({
          kind: ASK_USER_QUESTION_CANDIDATE_KIND,
          status: 'staged',
          posted: false,
          question: 'Which connected account should I use?',
          options: [...unique.choices],
          purpose: 'clarification',
        });
      }
    }
  }
  if (candidates.length === 0) {
    const unresolvedRecipient = unresolvedRecipientCandidateFromBatch(context, toolResults);
    if (unresolvedRecipient) candidates.push(unresolvedRecipient);
  }
  if (candidates.length > 0) {
    const rendered = renderAskUserQuestionCandidates(candidates);
    const sessionId = extractSessionId(context);
    const turn = extractTurn(context);
    const sourceUserSeq = extractSourceUserSeq(context);
    const purposes = new Set(candidates.map((candidate) => candidate.purpose));
    // A bundle may contain independently authored questions. Only project a
    // typed purpose to the top level when every candidate agrees; otherwise
    // preserve the ambiguity explicitly so downstream continuity cannot treat
    // an approval-shaped ask as a clarification. An all-null bundle remains
    // null for rolling-upgrade compatibility.
    const purpose: AskUserQuestionCandidate['purpose'] | 'mixed' = purposes.size === 1
      ? candidates[0]!.purpose
      : 'mixed';
    if (!sessionId) {
      // This can only occur in direct SDK/playground use outside Clementine's
      // harness. Return the question itself, but never claim a public post that
      // had no session/event destination.
      return {
        isFinalOutput: true as const,
        isInterrupted: undefined,
        finalOutput: rendered.question,
      };
    }
    const connectionProjection = sourceUserSeq
      ? observedConnectionDependencyPresentationForSource({ sessionId, sourceUserSeq })
      : null;
    const publicAsk = connectionProjection
      ? { question: connectionProjection.question, options: [...connectionProjection.options] }
      : rendered;
    const existing = listEvents(sessionId, { types: ['awaiting_user_input'] })
      .find((event) => event.turn === turn);
    if (existing) {
      const existingQuestion = String(
        (existing.data as { question?: unknown }).question ?? publicAsk.question,
      ).trim() || publicAsk.question;
      return {
        isFinalOutput: true as const,
        isInterrupted: undefined,
        finalOutput: formatAwaitingUserInputFinalOutput(existingQuestion),
      };
    }
    const recoveryProjection = sourceUserSeq
      ? constrainNeedsInputPresentationForRecovery({
          sessionId,
          sourceUserSeq,
          proposedText: publicAsk.question,
        })
      : { text: publicAsk.question, constrained: false };
    appendEvent({
      sessionId,
      turn,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: recoveryProjection.constrained
        ? {
            question: recoveryProjection.text,
            source: 'argument_repair_recovery',
            sourceUserSeq,
          }
        : {
            question: recoveryProjection.text,
            options: publicAsk.options,
            purpose,
            ...(connectionProjection
              ? { source: 'host_connection_dependency_projection' }
              : {}),
            ...(sourceUserSeq ? { sourceUserSeq } : {}),
            ...(candidates.length > 1
              ? {
                  bundled: true,
                  questions: candidates.map((candidate) => ({
                    question: candidate.question,
                    options: candidate.options,
                    purpose: candidate.purpose,
                  })),
                }
              : {}),
          },
    });
    return {
      isFinalOutput: true as const,
      isInterrupted: undefined,
      finalOutput: formatAwaitingUserInputFinalOutput(recoveryProjection.text),
    };
  }

  // Rolling-upgrade/backward-compatible path for old string receipts. YOLO's
  // machine-readable auto-resolution prefix remains explicitly non-halting.
  // Live 2026-08-29 mobile: autonomy check-in receipts ("Check-in created:
  // chk-…") halted the host lane as the chat answer while Discord/Slack
  // showed the question. Same render as the SDK lane: the question is the
  // user-facing text.
  for (const result of toolResults) {
    if (result.type !== 'function_output') continue;
    const rawName = result.tool.name ?? '';
    const bare = bareTerminalToolName(rawName);
    if (bare !== 'ask_user_question') continue;
    const output = stringifyToolOutput(result.output);
    if (!terminalToolShouldHalt(rawName, output, haltContext)) continue;
    const rendered = renderTerminalToolReply(rawName, toolCallInputOf(result), output);
    const recovered = /^Check-in created:/i.test(rendered)
      ? questionFromCheckInReceipt(output)
      : null;
    const question = recovered || rendered;
    return {
      isFinalOutput: true as const,
      isInterrupted: undefined,
      finalOutput: formatAwaitingUserInputFinalOutput(question),
    };
  }
  // A successful background-control receipt is itself the answer to the
  // request that invoked it — end the provider turn here on this lane too
  // (the Claude lane already does). The incident this closes ran on Codex:
  // "How's it going?" produced a good status answer, then the harness kept
  // re-invoking — 58 status calls, 95 model calls, 3.36M tokens, nothing
  // delivered (live 2026-08-10). The machine-readable prefix keeps the
  // receipt out of prose decision parsing.
  for (const result of toolResults) {
    if (result.type !== 'function_output') continue;
    const rawName = result.tool.name ?? '';
    if (!isTerminalToolName(rawName)) continue;
    if (bareTerminalToolName(rawName) === 'ask_user_question') continue;
    const output = stringifyToolOutput(result.output);
    if (!terminalToolShouldHalt(rawName, output, haltContext)) continue;
    return {
      isFinalOutput: true as const,
      isInterrupted: undefined,
      finalOutput: formatControlReceiptFinalOutput(renderTerminalToolReply(rawName, null, output)),
    };
  }
  return { isFinalOutput: false as const, isInterrupted: undefined };
}

function extractSessionId(runContext: unknown): string | undefined {
  if (!runContext || typeof runContext !== 'object') return undefined;
  const ctx = (runContext as { context?: { sessionId?: unknown } }).context;
  if (!ctx) return undefined;
  return typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined;
}

function extractSourceUserSeq(runContext: unknown): number | undefined {
  if (!runContext || typeof runContext !== 'object') return undefined;
  const ctx = (runContext as { context?: { sourceUserSeq?: unknown } }).context;
  const value = ctx?.sourceUserSeq;
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : undefined;
}

function extractTurn(runContext: unknown): number {
  if (!runContext || typeof runContext !== 'object') return 0;
  const ctx = (runContext as { context?: { turn?: unknown } }).context;
  if (!ctx) return 0;
  return typeof ctx.turn === 'number' ? ctx.turn : 0;
}

// ---------- deliberation tools ----------

const requestApprovalParams = z.object({
  subject: z.string().min(4).describe('What is being approved — one-line summary.'),
  reason: z.string().nullable().describe('Why this needs human approval. Pass null if none.'),
  destructive: z.boolean().describe('Is the approved action destructive?'),
  // v0.5.20 Bug J — content preview. When approval is for a BATCH
  // action (send N emails, update N rows, etc.), pass `preview` so
  // the user sees WHAT they are approving in the Discord card body
  // (count + sample subjects/recipients) instead of just the generic
  // subject + reason. Optional; for single-call approvals pass null.
  preview: z
    .object({
      count: z.number().int().min(0).nullable().describe('Total items in the batch (e.g. 9 emails).'),
      samples: z
        .array(
          z.object({
            label: z.string().max(40).describe('Field label, e.g. "Subject", "Email", "Row".'),
            value: z.string().max(200).describe('Primary content, e.g. the subject line.'),
            secondary: z
              .string()
              .max(200)
              .nullable()
              .describe('Optional secondary detail, e.g. recipient or row id.'),
          }),
        )
        .max(5)
        .nullable()
        .describe('Up to 5 sample items so the user can sanity-check shape.'),
    })
    .nullable()
    .describe(
      'Optional content preview for the approval card. STRONGLY RECOMMENDED for batch actions (send N emails, update N rows). Workflow authors: always pass this when the subject + reason alone do not convey the actual content.',
    ),
  pendingActionId: z.string()
    .nullable()
    .describe('Optional id from pending_action_queue. Use this when the exact action payload is already queued and the user is approving execution of that queued action.'),
});

/**
 * Detect when the orchestrator is asking for approval on something that
 * is clearly LOCAL (memory / vault / tasks / plans / goals / files in
 * the user's workspace). The user already consented by asking; an
 * approval gate here is friction the user reads as a bug.
 *
 * Observed regression: an explicit request to save a local preference was
 * misclassified as an external write. The later approval resumed a different
 * paused session and the local preference was never persisted.
 *
 * Returns true when the subject + reason patterns indicate a local
 * save the orchestrator should NOT have gated. Used by needsApproval
 * to skip the SDK interrupt, so the request_approval call acts like
 * an auto-resolved "yes" and the orchestrator can continue.
 */
const LOCAL_SAVE_PATTERN = /\b(memory|vault|note|fact|task|plan|goal|workflow|cron|preference|rule|reminder)\b/i;
const LOCAL_VERB_PATTERN = /\b(save|record|remember|write|note|track|add|update|log|store|persist)\b/i;
type RequestApprovalArgs = z.infer<typeof requestApprovalParams>;

function isLocalSaveApproval(args: { subject: string; reason: string | null; destructive: boolean }): boolean {
  if (args.destructive) return false;
  const subject = args.subject;
  const reason = args.reason ?? '';
  const combined = `${subject} ${reason}`;
  // Both a local-noun (memory/vault/etc.) AND a save-verb (save/remember/etc.)
  // must appear. Single-pattern matches are too loose — "save the email"
  // could refer to a remote service.
  return LOCAL_VERB_PATTERN.test(combined) && LOCAL_SAVE_PATTERN.test(combined);
}

function isYoloAutoApprovalPolicy(): boolean {
  try {
    return loadProactivityPolicy().autoApproveScope === 'yolo';
  } catch {
    return false;
  }
}

const IRREVERSIBLE_ACTION_TEXT_RE = /\b(send|sending|sent|post|posting|publish|publishing|tweet|tweeting|dm|sms|text message|call|calling|dial)\b/i;
// `email` is both an action and a noun. Match it only in an action position so
// "Email the customer" cannot auto-approve in YOLO, while local saves such as
// "Save the email template to memory" remain reversible.
const DIRECT_EMAIL_ACTION_TEXT_RE = /(?:^|[.!?]\s+|\b(?:please|to|will|should|must|can|could|would)\s+)(?:email|e-mail)(?:s|ed|ing)?\b/i;

/**
 * YOLO covers reversible work, never irreversible sends or destructive actions.
 * Anchor on the queued payload when available; fall back to explicit action
 * wording for legacy callers that have not queued a payload yet.
 */
export const _requestApprovalRequiresHumanForTests = (
  args: RequestApprovalArgs,
  sessionId?: string,
): Promise<boolean> => requestApprovalRequiresHuman(
  args,
  sessionId ? { context: { sessionId } } : undefined,
);

async function pendingActionForActiveSession(
  args: RequestApprovalArgs,
  runContext: unknown,
) {
  const id = args.pendingActionId?.trim();
  if (!id) return { state: 'none' as const };
  const sessionId = extractSessionId(runContext)?.trim();
  if (!sessionId) {
    return {
      state: 'refused' as const,
      id,
      reason: 'the active run has no authoritative session owner',
    };
  }
  try {
    const { getPendingAction } = await import('../runtime/harness/pending-actions.js');
    const record = getPendingAction(id);
    if (!record || !record.sessionId || record.sessionId !== sessionId) {
      return {
        state: 'refused' as const,
        id,
        reason: 'the queued action does not belong to this session',
      };
    }
    return { state: 'owned' as const, id, sessionId, record };
  } catch {
    return {
      state: 'refused' as const,
      id,
      reason: 'the queued action ownership could not be verified',
    };
  }
}

async function requestApprovalRequiresHuman(
  args: RequestApprovalArgs,
  runContext?: unknown,
): Promise<boolean> {
  if (args.destructive) return true;
  const pendingAction = await pendingActionForActiveSession(args, runContext);
  if (pendingAction.state === 'refused') return true;
  if (pendingAction.state === 'owned') {
    return pendingActionRequiresHumanApproval(pendingAction.record, {
      sessionId: pendingAction.record.sessionId,
    });
  }
  const text = `${args.subject} ${args.reason ?? ''}`;
  return IRREVERSIBLE_ACTION_TEXT_RE.test(text) || DIRECT_EMAIL_ACTION_TEXT_RE.test(text);
}

// Code-level backstop for the v0.5.59 context fix: in YOLO, ask_user_question is
// the ONE human-wait path with no autonomy-scope awareness — its siblings
// (request_approval, confirm-first, per-tool approval) all honor YOLO in code.
// So when a YOLO Clem reaches for ask_user_question to seek SIGN-OFF for an
// action the user already authorized, don't let it halt the run (the prompt
// alone can't guarantee that). A GENUINE clarification still halts and asks —
// the gate is on the approval SHAPE, not on questions in general (the owner:
// "she CAN ask questions"). Kill-switch CLEMMY_YOLO_NO_APPROVAL_HALT=off.
function yoloNoApprovalHaltEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_YOLO_NO_APPROVAL_HALT', 'on') ?? 'on').toLowerCase() !== 'off';
}

// "Should I <do mutating thing>?" / "go ahead?" / "approve?" + a mutating verb,
// OR explicit approval/permission/"for review"/"use a template" vocabulary with
// a mutating action. Mirrors the two-pattern style of isLocalSaveApproval.
const APPROVAL_ASK_WORDS = /\b(approve|approval|permission|sign[-\s]?off|ok(?:ay)?\s+to|go\s+ahead|proceed|for\s+review|review\s+(?:first|before)|drafts?\s+(?:first\s+)?for\s+review|before\s+(?:sending|posting|publishing|writing)|use\s+(?:a|the|this|that|specific|prior)\b[^.?!]*\b(?:template|copy|draft))\b/i;
const APPROVAL_ASK_LEADIN = /\b(should\s+i|shall\s+i|do\s+you\s+want\s+me\s+to|would\s+you\s+like\s+me\s+to|can\s+i|may\s+i|ok\s+to|okay\s+to)\b/i;
const MUTATING_ACTION_WORD = /\b(send|sending|sent|draft|drafts|email|emails|update|post|posting|deploy|publish|write|create|submit)\b/i;

function isApprovalShapedQuestion(question: string, options: string[] | null | undefined): boolean {
  try {
    const text = `${question} ${(options ?? []).join(' ')}`;
    if (!MUTATING_ACTION_WORD.test(text)) return false; // no action being gated → it's a real info question
    return APPROVAL_ASK_LEADIN.test(text) || APPROVAL_ASK_WORDS.test(text);
  } catch {
    return false;
  }
}

async function pendingActionApprovedSlugs(
  args: RequestApprovalArgs,
  runContext: unknown,
): Promise<string[]> {
  const pendingAction = await pendingActionForActiveSession(args, runContext);
  if (pendingAction.state !== 'owned') return [];
  const payload = pendingAction.record.payload as { composioSlug?: string; tool_slug?: string } | undefined;
  const slug = payload?.composioSlug ?? payload?.tool_slug;
  return typeof slug === 'string' && slug.trim() ? [slug.trim()] : [];
}

async function openRequestApprovalScope(args: RequestApprovalArgs, runContext: unknown): Promise<string[]> {
  if (args.destructive) return [];
  const sessionId = extractSessionId(runContext);
  if (!sessionId) return [];
  const pendingAction = await pendingActionForActiveSession(args, runContext);
  if (pendingAction.state === 'refused') return [];
  // Approve-once-then-run: a HUMAN approval of a queued action IS the reviewed
  // plan. Only the byte-frozen queued payload may open its exact operation
  // scope; approval-card prose is never capability authority.
  const fromPendingAction = await pendingActionApprovedSlugs(args, runContext);
  const allowedComposioSlugs = pendingAction.state === 'owned' ? fromPendingAction : [];
  if (allowedComposioSlugs.length === 0) return [];
  openPlanScope({
    sessionId,
    planProposalId: `request_approval:${extractTurn(runContext)}:${Date.now()}`,
    approvedPlanObjective: args.subject,
    allowedTools: ['composio_execute_tool'],
    allowedComposioSlugs,
  });
  return allowedComposioSlugs;
}

async function pendingActionExecutionInstructions(
  args: RequestApprovalArgs,
  runContext: unknown,
): Promise<string> {
  const pendingAction = await pendingActionForActiveSession(args, runContext);
  if (pendingAction.state === 'none') return '';
  if (pendingAction.state === 'refused') {
    return ` Queued action ${pendingAction.id} was refused because ${pendingAction.reason}; do not execute or reconstruct it.`;
  }
  const { record } = pendingAction;
  if (record.status !== 'approved') {
    return ` Queued action ${record.id} is not recorded as approved; do not execute or reconstruct it.`;
  }
  if (record.toolName === 'run_batch') {
    return [
      ` Queued batch ${record.id} is approved.`,
      `Execute ONLY its server-stored certified plan (payload hash ${record.payloadHash}); do not reconstruct any item from memory.`,
      `Call run_batch with action="execute" and pending_action_id="${record.id}" exactly once. Do NOT call pending_action_execute or re-propose the batch.`,
    ].join(' ');
  }
  return [
    ` Queued action ${record.id} is approved.`,
    `Execute ONLY the exact queued payload for ${record.toolName} (payload hash ${record.payloadHash}); do not reconstruct it from memory.`,
    `Call pending_action_execute with id ${record.id}; it dispatches the byte-identical stored payload and records the result. Do NOT call pending_action_get followed by the underlying tool, which would create a second approval boundary and invite reconstruction drift.`,
  ].join(' ');
}

async function markPendingActionPolicyApprovedFromRequest(
  args: RequestApprovalArgs,
  runContext: unknown,
): Promise<string> {
  const pendingAction = await pendingActionForActiveSession(args, runContext);
  if (pendingAction.state === 'none') return '';
  if (pendingAction.state === 'refused') {
    return ` Queued action ${pendingAction.id} was refused because ${pendingAction.reason}; its approval state was not changed.`;
  }
  try {
    const { markPendingActionApprovalResolved } = await import('../runtime/harness/pending-actions.js');
    // Only the two true auto-approval branches call this helper. A resumed human
    // card has already been recorded by approval-registry and must remain human.
    markPendingActionApprovalResolved(pendingAction.record.id, 'approved', null, {
      by: 'policy',
      evidence: { kind: 'policy', scope: loadProactivityPolicy().autoApproveScope },
    });
    return pendingActionExecutionInstructions(args, runContext);
  } catch {
    return '';
  }
}

export function buildRequestApprovalTool() {
  return tool({
    name: 'request_approval',
    description:
      'Pause and ask the user to approve a high-risk action or one batch of same-shape external writes. Use one card with a clear subject, reason, and bounded preview for the exact queued payload. Do not use for read-only calls, local saves, or every individual item in a batch.',
    parameters: requestApprovalParams,
    // Skip the SDK approval interrupt when the model misclassifies a
    // local save as needing approval. The instruction above tells the
    // model not to do this, but the prompt isn't load-bearing — if the
    // model still calls request_approval with subject="save X to
    // memory" + destructive:false, the runtime guard turns it into a
    // no-op so the user doesn't see a phantom approval prompt and the
    // orchestrator can keep moving.
    needsApproval: async (ctx, input) => {
      const args = input as RequestApprovalArgs;
      // Send-batch check FIRST: a queued external_send whose subject happens
      // to read like a local save ("save these emails to memory then send")
      // must never ride the local-save shortcut past the gate (adversarial-
      // review blocker, 2026-07-09).
      if (await requestApprovalRequiresHuman(args, ctx)) return true;
      if (isLocalSaveApproval(args)) return false;
      if (isYoloAutoApprovalPolicy()) return false;
      return true;
    },
    execute: async (args, runContext) => {
      const pendingAction = await pendingActionForActiveSession(args, runContext);
      if (pendingAction.state === 'refused') {
        return `Refused queued action ${pendingAction.id}: ${pendingAction.reason}. Its approval state was not changed and no tool scope was opened.`;
      }
      const requiresHuman = await requestApprovalRequiresHuman(args, runContext);
      if (!requiresHuman && isLocalSaveApproval(args)) {
        const pendingActionText = await markPendingActionPolicyApprovedFromRequest(args, runContext);
        return `Auto-approved (local save — no external mutation): ${args.subject}. Proceed with the save and report back what landed.${pendingActionText}`;
      }
      if (!requiresHuman && isYoloAutoApprovalPolicy()) {
        const pendingActionText = await markPendingActionPolicyApprovedFromRequest(args, runContext);
        return `Auto-approved by YOLO mode: ${args.subject}. Proceed with the action you described.${pendingActionText}`;
      }
      // Human approval was persisted by approval-registry before the SDK resumed
      // this tool. Read that linked action without rewriting its provenance.
      const pendingActionText = await pendingActionExecutionInstructions(args, runContext);
      const scopedSlugs = await openRequestApprovalScope(args, runContext);
      const scopeText = scopedSlugs.length > 0
        ? ` Approved scope opened for ${scopedSlugs.join(', ')} in this session, so matching concrete tool calls should not ask again.`
        : '';
      return `Approved: ${args.subject}. Proceed with the action you described.${pendingActionText}${scopeText}`;
    },
  });
}

const askUserQuestionParams = z.object({
  question: z.string().min(4).describe('A single concise question for the user.'),
  options: z
    .array(z.string())
    .max(5)
    .nullable()
    .describe('Pre-canned answers; pass null if none.'),
  purpose: z
    .enum(['clarification', 'approval'])
    .nullable()
    .describe(
      'Why you are asking. "clarification" = you genuinely cannot proceed without a fact only the user has '
      + '(which of two real resources, a value you cannot infer). "approval" = you are seeking sign-off / permission '
      + 'to do work the user already asked for (send/draft/update/post/deploy). In YOLO the user has STANDING '
      + 'approval, so an "approval" question does NOT pause — it auto-resolves to "proceed with your best default." '
      + 'Mark "clarification" only when waiting is genuinely the only correct move. Pass null if neither fits.',
    ),
});

export function buildAskUserQuestionTool() {
  return tool({
    name: 'ask_user_question',
    description:
      'Ask the user a question and (normally) pause for the reply. This is how you reach the one source of '
      + 'information nothing else can give you — their intent. Use it as a normal step in doing the work, not as a '
      + 'last resort.\n'
      + 'ASK WHEN the ambiguity would materially change what you do: which specific account/base/list/records, the '
      + 'time window, the destination, the format — anything named but unbound, where two readings of the request '
      + 'would produce different results. Ask BEFORE committing to that direction, not after; a question that arrives '
      + 'once the work is done is a report, not a question.\n'
      + 'ASK ALSO when you have hit a boundary the user has to decide about — the connected tool cannot produce '
      + 'exactly what they asked for, or a step genuinely requires them (an account, a permission, a credential). '
      + 'Name the gap and the closest thing you CAN do.\n'
      + 'DO NOT ASK when you can find out yourself: read the file, list the records, check the connection, consult '
      + 'your recalled memory. Anything retrievable is not a question. Do not ask about details that would not change '
      + 'the outcome, and do not re-ask what this session already settled.\n'
      + 'HOW: if part of the work is unblocked, do that part first, then ask ONE targeted question covering what is '
      + 'genuinely open. Give 2-5 concrete options when they exist; if you have a recommendation, put it first and '
      + 'say it is your recommendation. The user can always answer in their own words, so never add an "other" '
      + 'option. Batch independent questions into one turn; only serialize when a later question truly depends on the '
      + 'answer to an earlier one.\n'
      + 'Set `purpose`: "clarification" if you cannot proceed without a fact only the user has, or "approval" if you '
      + 'are seeking sign-off for work already requested. In autonomous mode an "approval" question does NOT pause — '
      + 'it auto-resolves to "proceed with your best default" — because permission for work they already asked for is '
      + 'not a question. A genuine clarification still reaches them.\n'
      + 'This tool is for direction, not safety: dangerous or irreversible actions are gated separately and never '
      + 'need a question here.',
    parameters: askUserQuestionParams,
    execute: async (args, runContext) => {
      const sessionId = extractSessionId(runContext);
      if (sessionId) {
        const lastUser = [...listEvents(sessionId, { types: ['user_input_received'] })].at(-1);
        const lastText = typeof lastUser?.data.text === 'string' ? lastUser.data.text : '';
        if (lastText && clarificationBlockedByGoal(compileAcceptedGoal({
          text: lastText,
          multiItem: { itemCount: 0, isMultiItem: false },
        }), args.question)) {
          return formatAutoResolvedAskUserQuestionOutput(
            'The accepted goal already named the required fields. Do not pause for layout. '
            + 'Proceed with those fields and one destination artifact, then return the verified handle.',
          );
        }
      }
      // YOLO + approval-purpose question → do NOT halt. The user has standing
      // approval; seeking sign-off for an action they authorized is the exact
      // re-block we're killing. PRIMARY signal is the model's declared
      // `purpose` (reliable, mirrors request_approval's typed intent); the
      // regex isApprovalShapedQuestion is the BACKSTOP only when purpose is
      // omitted. A genuine clarification (purpose:'clarification', or no
      // mutating action) falls through to the awaiting_user_input halt below —
      // she can still ask. Record a NON-halting autonomy_note (audit trail).
      const classifier: 'typed' | 'regex-backstop' | null =
        args.purpose === 'approval' ? 'typed'
          : (args.purpose == null && isApprovalShapedQuestion(args.question, args.options)) ? 'regex-backstop'
            : null;
      const isApprovalPurpose = classifier !== null;
      if (
        sessionId
        && isYoloAutoApprovalPolicy()
        && yoloNoApprovalHaltEnabled()
        && isApprovalPurpose
      ) {
        try {
          appendEvent({
            sessionId,
            turn: extractTurn(runContext),
            role: 'Clem',
            type: 'autonomy_note',
            data: {
              question: args.question,
              options: args.options ?? null,
              purpose: args.purpose ?? null,
              classifier,
              autoResolved: 'yolo-standing-approval',
            },
          });
        } catch { /* audit note is best-effort; never block the proceed path */ }
        return formatAutoResolvedAskUserQuestionOutput(
          'YOLO standing approval is in effect — NOT pausing for sign-off on an action you were already asked to do. '
          + 'Proceed now with your best default (reuse the approved copy/template the already-handled items used, or the same approach), '
          + `then report what you did and the assumption you made. (Noted, not waiting: "${args.question}")`
        );
      }
      if (sessionId) {
        // A genuine question is only STAGED here. The SDK may execute several
        // independent asks in parallel; userChoiceToolUseBehavior sees the full
        // provider-ordered batch, bundles it, and owns the single durable post.
        // Therefore every per-tool receipt remains truthful: none says "posted"
        // before the public awaiting_user_input event actually exists.
        return {
          kind: ASK_USER_QUESTION_CANDIDATE_KIND,
          status: 'staged' as const,
          posted: false as const,
          question: args.question,
          options: args.options ?? null,
          purpose: args.purpose ?? null,
        } satisfies AskUserQuestionCandidate;
      }
      return `Question ready for the caller: ${args.question}. No session was available to post it.`;
    },
  });
}

// offer_background was STRIPPED 2026-07-22 (subtraction): backgrounding is now
// the desktop button + a plain prose ask; dispatch_background_task and
// hold_task_for_later remain the capabilities. See v2.2.2 charter item 13.

// ---------- orchestrator factory ----------

// Brain rubric CONTENT now lives in ./clem-rubric.ts (Phase 3 — ONE shared source
// both flagship lanes consume; the Phase-5 prune happens there, in one place).
// Imported above for local use (the variant map below) and RE-EXPORTED here so
// existing importers (orchestrator.test.ts cross-check, claude-wire-capture.test,
// rubric-characterization.test.ts byte-snapshots) keep working unchanged.
export { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_BEHAVIOR_NATIVE };

// Engine-over-prompt A/B substrate. The variant→instructions map for the
// Codex/headless lane keeps the characterized lean default and an attributable
// legacy rollback. resolveRubricVariant() never returns an unregistered body.
export const RUBRIC_INSTRUCTIONS_BY_VARIANT: Record<string, string> = {
  legacy: ORCHESTRATOR_INSTRUCTIONS,
  // Phase-5 surgical prune (~1/4 the tokens) — composed of proven text (the
  // lean Claude-brain rubric + Codex essentials + the decision contract +
  // tail). This is the default; CLEMMY_RUBRIC_VARIANT=legacy is the rollback.
  lean: ORCHESTRATOR_INSTRUCTIONS_LEAN,
};

/** Resolve the Codex-lane rubric (instructions string) + the chosen variant for
 *  telemetry. Bounded by what RUBRIC_INSTRUCTIONS_BY_VARIANT actually implements. */
export function selectOrchestratorRubric(sessionId?: string | null): {
  variant: string;
  requested: string;
  fellBack: boolean;
  experiment: boolean;
  arm: 'lean' | 'legacy' | null;
  instructions: string;
} {
  // sessionId enables the per-session live A/B (CLEMMY_RUBRIC_VARIANT_AB) — without
  // it, the global CLEMMY_RUBRIC_VARIANT governs (byte-identical to before).
  const choice = resolveRubricVariant(Object.keys(RUBRIC_INSTRUCTIONS_BY_VARIANT), sessionId);
  const mapped = RUBRIC_INSTRUCTIONS_BY_VARIANT[choice.variant];
  // fellBack reflects "did we actually serve the proven legacy rubric instead of
  // the requested one" — true if resolveRubricVariant fell back OR the resolved
  // variant has no real instructions registered (a future mis-registration).
  if (mapped == null) {
    const fallbackVariant = RUBRIC_INSTRUCTIONS_BY_VARIANT[DEFAULT_RUBRIC_VARIANT]
      ? DEFAULT_RUBRIC_VARIANT
      : 'legacy';
    return {
      variant: fallbackVariant,
      requested: choice.requested,
      fellBack: true,
      experiment: choice.experiment,
      arm: choice.arm,
      instructions: RUBRIC_INSTRUCTIONS_BY_VARIANT[fallbackVariant] ?? ORCHESTRATOR_INSTRUCTIONS,
    };
  }
  return { ...choice, instructions: mapped };
}

/**
 * Recent prior user-turn texts for continuity-aware tool scoping, NEWEST FIRST.
 * Reads this session's `user_input_received` events (excluding the current turn);
 * if this session has none with intent yet, follows the continuation lineage
 * (cross_session_prefix.priorSessionIds) so a NEW session resuming an old task
 * can still inherit the active scope. Best-effort — never throws into agent build.
 */
export function recentPriorUserInputsForScope(
  sessionId: string,
  currentInput?: string | null,
  perSessionLimit = 8,
): string[] {
  const current = (currentInput ?? '').trim();
  const seen = new Set<string>();
  const out: string[] = [];
  const collect = (sid: string): void => {
    let rows: ReturnType<typeof listEvents>;
    try {
      rows = listEvents(sid, { types: ['user_input_received'], desc: true, limit: perSessionLimit });
    } catch {
      return;
    }
    // desc:true returns chronological (oldest→newest); reverse → newest-first.
    for (const ev of [...rows].reverse()) {
      const text = typeof (ev.data as { text?: unknown })?.text === 'string'
        ? ((ev.data as { text?: string }).text ?? '').trim()
        : '';
      if (!text || text === current || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  };
  collect(sessionId);
  if (out.length === 0) {
    try {
      const prefix = listEvents(sessionId, { types: ['cross_session_prefix'], desc: true, limit: 1 });
      const prior = (prefix[0]?.data as { priorSessionIds?: unknown })?.priorSessionIds;
      if (Array.isArray(prior)) {
        for (const sid of prior) {
          if (typeof sid === 'string') collect(sid);
        }
      }
    } catch {
      /* best-effort lineage walk */
    }
  }
  return out;
}

/**
 * The immediately preceding assistant proposal for multi-item/fan-out
 * detection. The item count often lives in that proposal ("run research on
 * these 18 firms?"), but arbitrary older user/assistant turns are not safe
 * scope: a polite new request must never inherit a stale batch contract.
 * Best-effort: any failure returns [].
 */
export function recentConversationTextsForFanout(
  sessionId: string,
  currentInput?: string | null,
  _limit = 1,
): string[] {
  try {
    const rows = listEvents(sessionId, {
      types: ['conversation_step'],
      desc: true,
      limit: 1,
    });
    const current = (currentInput ?? '').trim();
    const data = rows.at(-1)?.data as {
      decision?: { reply?: unknown; summary?: unknown };
    } | undefined;
    const text = typeof data?.decision?.reply === 'string'
      ? data.decision.reply.trim()
      : typeof data?.decision?.summary === 'string'
        ? data.decision.summary.trim()
        : '';
    return text && text !== current ? [text] : [];
  } catch {
    return [];
  }
}

export async function buildOrchestratorAgent(options: BuildOrchestratorAgentOptions = {}): Promise<
  Agent<RuntimeContextValue, any>
> {
  // Phase 3 architecture (2026-05-20, "single agent"): the Orchestrator
  // IS the agent. Sub-agents are gone. The Orchestrator carries the
  // union of action tools that used to be split across Researcher /
  // Writer / Reviewer / Executor / Deployer, and calls them directly
  // when the user asks for multi-step work. No handoffs, no run_<role>
  // tool wrappers, no Orchestrator → sub-agent ceremony.
  //
  // Why: pause/resume around composio_execute_tool approval breaks
  // .asTool() wrappers (the sub-agent's child completes with empty
  // output back to the parent), so multi-step work degenerated into
  // "approve, fabricate, auto-continue, approve, fabricate, ..." loops.
  // The fix is structural — one agent, one approval per mutating call,
  // one decision loop.
  //
  // Approval is gated at the per-tool level via decideToolApproval()
  // in tool-taxonomy.ts, so admin-class tools (run_shell_command,
  // file writes outside workspace, etc.) still prompt the user. The
  // trust gradient is preserved at the TOOL boundary, not the
  // AGENT boundary.
  //
  // autonomy-v2.ts still uses sub-agent handoffs for its scheduled
  // cycles; that path is a separate migration.
  // run_worker: stateless leaf for parallel fan-out across N items.
  // The agent calls this MULTIPLE TIMES IN PARALLEL (one per item)
  // when the work is "do the same operation across N independent
  // items" — N composio writes, N scrapes, N file edits, etc.
  // Each call spawns a fresh SDK context bounded to a single result.
  // Continuity-aware scope: a keyword-less continuation ("let's get them ready",
  // "yes that's perfect", "go ahead") must NOT strip the tools the conversation
  // is mid-using. When a sessionId is present, feed the scoper the prior turns'
  // inputs (this session + continuation lineage) so a bare follow-up inherits
  // the active scope instead of collapsing to maxTools:0. No session → exact
  // legacy behavior. Still gated by CLEMMY_SCOPED_MCP_TOOLS (no new flag).
  // Prior-turn texts (this session + continuation lineage), newest-first. Reused by
  // BOTH the MCP scope (continuity) and the JIT ranking query, so a bare follow-up
  // ("do it", "schedule it") ranks against the work the conversation built toward.
  const declinedContinuation = options.taskContinuation?.disposition === 'declined';
  const declinedParentWithNewTask =
    options.taskContinuation?.disposition === 'declined_with_new_task';
  const parentAuthorityDeclined = declinedContinuation || declinedParentWithNewTask;
  const plainConversationSurface = options.hostPlainConversation === true;
  const factorySkip = declinedContinuation
    || plainConversationSurface
    || factorySkipForCompiledRoute(options.acceptedRoute, options.allowedToolNames);
  const currentUserInput = typeof options.userInput === 'string' ? options.userInput : '';
  // A dual-clause turn remains byte-exact in the provider transcript, while
  // semantic/tool acquisition sees only the fresh clause after the explicit
  // parent decline.
  const scopeUserInput = declinedParentWithNewTask
    ? options.taskContinuation?.activeTaskInput ?? currentUserInput
    : currentUserInput;
  const hostFreshPlanning = options.hostFreshPlanning;
  const actionWork = (() => {
    if (options.acceptedRoute !== 'act') return false;
    // The host-fresh lane intentionally constructs the model surface before a
    // durable action graph/expected-work contract exists. Its opaque planning
    // authority is the carrier; consulting the legacy durable action boundary
    // here would turn the valid pre-plan state into "missing graph".
    if (hostFreshPlanning) return false;
    if (
      !options.sessionId
      || !Number.isSafeInteger(options.sourceUserSeq)
      || (options.sourceUserSeq ?? 0) <= 0
    ) throw new Error('An accepted action route requires its exact session/source identity before agent construction.');
    return actionExpectedWorkCarrierSelection({
      sessionId: options.sessionId,
      sourceUserSeq: options.sourceUserSeq as number,
    });
  })();
  const carrierWork = Boolean(actionWork || hostFreshPlanning);
  const workCallLocalSchemaNames = carrierWork
    ? new Set(getLocalToolSchemas().keys())
    : new Set<string>();
  // The host's exact plain-conversation proof already seals this turn to a
  // zero-tool surface. Durable capability selection can only influence an
  // action carrier, so reading it here cannot change the compiled model surface.
  const durableSelectedLocalPlanningNames = !plainConversationSurface
    && options.sessionId
    && Number.isSafeInteger(options.sourceUserSeq)
    && (options.sourceUserSeq ?? 0) > 0
      ? durableSelectedLocalPlanningCapabilityNames({
          sessionId: options.sessionId,
          sourceUserSeq: options.sourceUserSeq as number,
          workCallConfiguredNames: workCallLocalSchemaNames,
        })
      : new Set<string>();
  const routesPlanBoundLocalCapability = (name: string): boolean => (
    isRegistryDeclaredLocalPlanningCapability(name)
    && isWorkCallConfiguredLocalPlanningCapability(name, workCallLocalSchemaNames)
    // Read-only control context (skill instructions, profile/status reads,
    // recovery inspection) is evidence for the foreground model, not a node
    // in the accepted business topology. Routing these through work_call made
    // an action turn advertise skill_list/skill_read, then refuse call_tool as
    // not_reachable before the model could load the requested procedure.
    // Mutating controls such as space_save remain plan-bound because this
    // exception is read-only; business reads retain their requirement binding.
    && !(isRegistryDeclaredRead(name) && actionTopologyRoleFor(name) === 'control')
    && (Boolean(hostFreshPlanning) || durableSelectedLocalPlanningNames.has(name))
  );
  const frozenContract = actionWork
    ? loadBoundExpectedWorkContract(options.sessionId ?? undefined, options.sourceUserSeq)
    : null;
  const frozenDestinationFamily = frozenContract
    ? frozenCreateDestinationFamily(frozenContract)
    : null;
  const actionTaskState = actionWork
    ? resolveActionTaskState({
        sessionId: options.sessionId,
        userInput: scopeUserInput,
        taskContinuation: options.taskContinuation,
      })
    : { kind: 'fresh' as const };
  // Recovery/history tools are not ordinary controls. Their registry class is
  // admitted only by typed continuation state; exact-name search is not an
  // authority source and therefore cannot reopen them on a fresh action.
  const actionControlAdmitted = (name: string): boolean => (
    !carrierWork
    || actionControlAdmittedForTaskState(name, actionTaskState.kind)
  );
  // A typed decline is a complete conversational turn, not an execution turn.
  // Keep the transcript and A/Q/B capsule for the model, but make the local
  // allowlist explicitly empty so no structural/discovery schema reaches the
  // provider and no acquisition path spends work preparing the cancelled task.
  const effectiveAllowedToolNames = factorySkip
    ? []
    : carrierWork && (options.allowedToolNames?.length ?? 0) > 0
      // Structural carriers are part of the action harness, not business
      // capabilities the caller must remember to enumerate. Preserve both:
      // `call_tool` carries admitted local reads/controls while `work_call`
      // exclusively carries business writes. Stripping call_tool here left
      // the prompt advertising a direct read door that the final tool policy
      // silently removed (live Codex action lane, 2026-08-20).
      ? [...new Set([
          ...(options.allowedToolNames ?? []),
          'call_tool',
          'work_call',
          ...(hostFreshPlanning ? ['plan_task'] : []),
        ])]
      : options.allowedToolNames;
  // Prior-input retrieval here exists only to recover MCP/JIT scope. It is not
  // the provider transcript: runTurn still supplies the normal conversation
  // history to the model. An exact plain proof has no MCP/JIT scope to recover.
  const historicalPriorUserInputs = !plainConversationSurface
    && options.sessionId
    && !parentAuthorityDeclined
    ? recentPriorUserInputsForScope(options.sessionId, currentUserInput)
    : [];
  const priorUserInputs = parentAuthorityDeclined
    // The ordinary transcript and typed continuation still tell Clem what was
    // declined. None of those prior turns may reopen JIT/MCP tool authority.
    ? []
    : [
        options.taskContinuation?.parentInput ?? '',
        ...historicalPriorUserInputs,
      ].filter((value, index, all) => value.trim() && all.indexOf(value) === index);
  const directNamedWorkflowRun = uniqueWorkflowRunRequest(scopeUserInput, priorUserInputs);
  // A current accepted source that uniquely identifies an existing workflow
  // already has the complete resource identity needed by workflow_run. Keep
  // that one control on its ordinary direct admission path; sending it through
  // local planning would add discovery/work_call while ultimately reopening
  // the same accepted-source + queue boundary. Prior/LRU promotion alone is
  // not enough: unrelated turns remain plan-bound.
  const routesPlanBoundLocalCapabilityForTurn = (name: string): boolean => (
    routesPlanBoundLocalCapability(name)
    && !(name === 'workflow_run' && directNamedWorkflowRun)
  );
  const mcpToolScope: McpToolScope = effectiveAllowedToolNames !== undefined
    ? {
        reason: declinedContinuation
          ? 'continuity: user declined the prior task; local and external tool authority denied for this turn'
          : factorySkip
            ? 'compiled direct_reply; local and external tool authority denied for this turn'
          : 'explicit local tool allowlist; external MCP authority denied',
        authority: 'none',
        allowedServerSlugs: [],
        toolPatterns: [],
        maxTools: 0,
      }
    : options.mcpToolScope ?? (
        options.sessionId
          ? resolveMcpToolScopeWithRecall({
              userInput: scopeUserInput,
              priorUserInputs,
              standingCapabilityHints: composioStandingPolicyCapabilityHints(),
              configuredServerNames: enabledExternalServerNames(),
              // The turn's resolved candidates ride in as advisory matches so
              // the MCP scope sees exactly what the JIT surface sees.
              ...(options.turnCandidates?.matches.length
                ? { learnedMatches: options.turnCandidates.matches }
                : {}),
              // A contentless go-ahead ("go", "ok") is an ANSWER, and an answer
              // must not be scoped as if it were a fresh topic with no keywords.
              // Structural, so it never depends on a list of ways to say yes.
              awaitingAnswer: Boolean(
                options.taskContinuation
                && options.taskContinuation.disposition !== 'declined'
                && options.taskContinuation.disposition !== 'declined_with_new_task'
              )
                || (!options.taskContinuationResolved
                  && priorTurnEndedAwaitingClarification(options.sessionId)),
              ...(options.taskContinuation
                && options.taskContinuation.disposition !== 'declined_with_new_task'
                ? { answerDisposition: options.taskContinuation.disposition }
                : {}),
            })
          : resolveMcpToolScope({
              userInput: scopeUserInput,
              standingCapabilityHints: composioStandingPolicyCapabilityHints(),
            })
      );
  // T1: thread the current input so the fail-open MCP surface can rank the
  // user's connected tools by semantic relevance (run-start only; ignored by
  // keyword family scopes). Respects a caller-provided queryText.
  if (!factorySkip && scopeUserInput.trim() && !mcpToolScope.queryText) {
    mcpToolScope.queryText = scopeUserInput;
  }
  const actionToolSearchCandidateSources = carrierWork
    ? buildAuthorizedToolSearchCandidateSources(
        mcpToolScope,
        hostFreshPlanning?.identity,
      )
    : undefined;
  const planningDisclosure = hostFreshPlanning
    ? async (
        candidates: readonly ToolSearchPlanningDisclosureCandidate[],
        control?: Readonly<{ signal: AbortSignal; deadlineAt: number }>,
      ) => {
        const staged = await stageDisclosedPlanningProviderCandidates({
          ...hostFreshPlanning.identity,
          candidates,
          signal: control?.signal,
          deadlineAt: control?.deadlineAt,
        });
        if (control && (control.signal.aborted || Date.now() >= control.deadlineAt)) {
          return { version: 1 as const, refs: Object.freeze({}), blockers: Object.freeze({}) };
        }
        const refs = await disclosePrimaryModelPlanningCapabilities({
          authority: hostFreshPlanning.authority,
          candidates,
          signal: control?.signal,
          deadlineAt: control?.deadlineAt,
        });
        if (control && (control.signal.aborted || Date.now() >= control.deadlineAt)) {
          return { version: 1 as const, refs: Object.freeze({}), blockers: Object.freeze({}) };
        }
        return {
          version: 1 as const,
          refs,
          blockers: staged.blockers,
        };
      }
    : undefined;
  if (carrierWork) {
    // The role kernel lands independently of this subtraction slice. Optional
    // capability detection keeps this patch apply/testable alone; once the
    // kernel is present, the positive broker fact is what arms exact-role
    // discovery instead of legacy task-wide compatibility.
    const roleKernel = discoveryGovernor as typeof discoveryGovernor & {
      initializeRoles?: (input: {
        sessionId: string;
        sourceUserSeq: number;
        requirements: readonly { roleKey: string; clauseIndex: number; text: string; resolved: boolean }[];
        brokerCoverage?: 'builtins_only' | 'authorized_external_v1';
      }) => unknown;
    };
    // ROLES REGISTER ON THE ACCEPTED TASK'S DISCOVERY AUTHORITY, so the task
    // row must exist first. Agent construction is not the same point in every
    // lane: this one builds at the spine's capability_resolve node, UPSTREAM of
    // runTurn's baseline initializeTask, while the Claude lane arms the task
    // immediately before arming roles. Arming roles against a task that does
    // not exist is a governor invariant violation — it threw and took every
    // act-route turn on this lane down with it, in the CLI and desktop dock as
    // well as in tests. Pair them here exactly as the Claude lane does.
    // Nothing is bypassed: initializeTask independently verifies that
    // (sessionId, sourceUserSeq) names a real accepted user input, and
    // knownCapability only ever tightens policy, so it cannot downgrade a
    // capability already proven this turn.
    discoveryGovernor.initializeTask({
      sessionId: options.sessionId!,
      sourceUserSeq: options.sourceUserSeq!,
      knownCapability: false,
    });
    roleKernel.initializeRoles?.({
      sessionId: options.sessionId!,
      sourceUserSeq: options.sourceUserSeq!,
      requirements: (options.turnCandidates?.requirements ?? []) as readonly {
        roleKey: string;
        clauseIndex: number;
        text: string;
        resolved: boolean;
      }[],
      brokerCoverage: toolSearchBrokerCoverage(actionToolSearchCandidateSources),
    });
  }
  // Batch-shape directive: on a data-heavy turn (MCP data servers in scope)
  // inject the standing lane rule (run_worker per item / parallel reads /
  // direct read). Multi-item detection reads the CONVERSATION, not just the
  // current message — the count usually lives in the assistant's own prior
  // proposal ("research these 18 firms?") answered with a bare "yes"
  // (live 2026-07-07: current-message-only detection serialized 18 firms).
  // '' (byte-identical prompt) on non-data turns or when the kill-switch is off.
  // Fan-out classification changes only action tools/directives. The exact
  // plain surface advertises neither, so do not reread conversation events or
  // classify a batch that cannot be executed on this turn.
  const multiItem = !plainConversationSurface
    && !declinedContinuation
    && typeof scopeUserInput === 'string'
    ? detectMultiItemIntentFromConversation(
        scopeUserInput,
        declinedParentWithNewTask
          ? []
          : options.sessionId
            ? recentConversationTextsForFanout(options.sessionId, currentUserInput)
            : priorUserInputs,
      )
    : undefined;
  // `draft_plan` is both an optional planning affordance and the recovery path
  // when CONFIRM_FIRST_REQUIRED asks the parent to surface a reviewed batch
  // scope. It must therefore remain structurally reachable on every turn.
  // Wording classifiers are intentionally advisory and may have false
  // negatives; none of them may remove a safety-recovery capability. Tool
  // availability does not invoke the Planner — its description keeps ordinary
  // Q&A and direct execution in the primary loop.
  // Plain conversation and action-carrier lanes never include draft_plan in
  // structuralTools. Building its nested planner agent anyway eagerly expands
  // the full local runtime schema surface, only to discard it below. Keep the
  // construction aligned with the sole lane that can actually advertise it.
  const plannerTool = !factorySkip && !carrierWork
    ? buildPlannerTool()
    : null;
  // Fresh host planning already carries one provider-neutral topology card and
  // the lean rubric's fan-out rule. Repeating the 1.9KiB batch mandate before
  // any capability is disclosed made the cold planning surface exceed its
  // competitive byte ceiling without adding authority or behavior.
  const batchShapeMandate = hostFreshPlanning ? '' : batchShapeDirective({
    mcpServersInScope: mcpToolScope.allowedServerSlugs?.length ?? 0,
    allowAllMcp: !!mcpToolScope.allowAll,
    fanoutPreferred: options.allowToolJit === true && !!multiItem?.isMultiItem,
    multiItem: multiItem?.isMultiItem
      ? { count: multiItem.itemCount, kind: multiItem.itemKind, carried: !!multiItem.carriedFromPrior }
      : undefined,
  });
  if (options.sessionId) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'mcp_tool_scope',
        data: {
          reason: mcpToolScope.reason,
          allowAll: !!mcpToolScope.allowAll,
          allowedServerSlugs: mcpToolScope.allowedServerSlugs ?? [],
          maxTools: mcpToolScope.maxTools ?? null,
          // Shape telemetry: did the shared batch directive fire this turn?
          batchShapeMandate: !!batchShapeMandate,
        },
      });
    } catch {
      // Scope telemetry should never block agent construction.
    }
  }

  // Engine-over-prompt A/B substrate (Phase 0c): pick the rubric variant in force
  // and tag the run so it is attributable to an arm. Emitted at agent construction
  // (i.e. PER TURN, like mcp_tool_scope) — A/B aggregation should dedupe to one row
  // per session. Default 'legacy' → byte-identical to before. The extra row on the
  // default path is intended telemetry. Must never block construction.
  const rubricChoice = selectOrchestratorRubric(options.sessionId);
  if (options.sessionId) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'rubric_variant',
        data: {
          variant: rubricChoice.variant,
          requested: rubricChoice.requested,
          fellBack: rubricChoice.fellBack,
          // A/B attribution: `arm` + `experiment` let scripts/measure-rubric-ab.ts
          // segment real traffic; `lane` scopes the readout (this is the codex/
          // native orchestrator lane — the Claude brain runs its own lean rubric).
          experiment: rubricChoice.experiment,
          arm: rubricChoice.arm,
          lane: 'codex',
        },
      });
    } catch {
      // Variant telemetry should never block agent construction.
    }
  }

  // Worker agents are lazy and keyed by their exact packet capability lease.
  // The old eager singleton paid worker construction on every ordinary chat
  // and, more importantly, froze workers to the parent turn's broad/selected
  // MCP view while ignoring the exact resolvedTools packet. A live 10-item SEO
  // fan-out could therefore name three proven tools yet reach only one.
  type BuiltWorkerAgent = Awaited<ReturnType<typeof buildWorkerAgent>>;
  const workerAgentCache = new Map<string, Promise<BuiltWorkerAgent>>();
  const workerAgentForPacket = async (
    input: WorkerToolInput,
    model: string,
  ): Promise<{ agent: BuiltWorkerAgent; scope: McpToolScope | null | undefined }> => {
    const scope = workerPacketMcpToolScope({
      buildScope: mcpToolScope,
      runtimeScope: harnessRunContextStorage.getStore()?.mcpToolScope,
      resolvedTools: input.resolvedTools,
      externalMcpToolNames: input.externalMcpToolNames,
    });
    const scopeKey = scope === undefined
      ? 'scope:inherit'
      : scope === null
        ? 'scope:deny'
        : `scope:exact:${JSON.stringify(scope)}`;
    const key = `${model}\0${scopeKey}`;
    let pending = workerAgentCache.get(key);
    if (!pending) {
      // A worker dispatches under the PARENT's accepted source, so it must be
      // built with that identity or it cannot know it is under contract and
      // will assemble a surface the admission wall refuses.
      pending = buildWorkerAgent({
        model,
        workerInput: input,
        mcpToolScope: scope,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(Number.isSafeInteger(options.sourceUserSeq) && (options.sourceUserSeq ?? 0) > 0
          ? { sourceUserSeq: options.sourceUserSeq }
          : {}),
      });
      workerAgentCache.set(key, pending);
    }
    try {
      return { agent: await pending, scope };
    } catch (error) {
      if (workerAgentCache.get(key) === pending) workerAgentCache.delete(key);
      throw error;
    }
  };
  // FIX 1.2 — bound each worker to its own turn budget so a thrashing worker
  // self-terminates cheaply (the SDK soft-converts MaxTurnsExceeded to a string
  // result, so a capped worker NEVER throws into the parent batch — siblings
  // keep running). Env-tunable; on by default (CLEMMY_WORKER_THRASH_GUARD=off
  // reverts to the SDK default turn budget and skips the cap).
  //
  // Default 8, calibrated against harness.db (2026-06-02): a focused single-job
  // agent (the WorkflowStep analog — the closest measurable proxy, since worker
  // nested runs carry no harness hooks so their turns aren't logged directly)
  // completes in 1–3 turns (avg 1.1, max 3). The ONLY workers that ever hit the
  // SDK default of 10 were mis-scoped (one worker crammed with 8 sends each) —
  // an anti-pattern the structured one-item packet now prevents. 8 sits above
  // legit single-item work (1–3, complex sequential ≤~7) and below 10, catching
  // mis-scoped/runaway workers ~2 turns earlier. The precise thrash control is
  // the per-worker loop-guard (identical-call soft block@5..11, escalate@12), not this cap;
  // the cap is the outer runaway bound. `worker_capped` telemetry (hooks.ts)
  // records cap-hits so this can be recalibrated from real data.
  const workerMaxTurns = (() => {
    const n = Number.parseInt(getRuntimeEnv('CLEMMY_WORKER_MAX_TURNS', '8') ?? '8', 10);
    return Number.isFinite(n) && n >= 2 ? n : 8;
  })();
  const runWorkerToolDescription = [
      'Spawn stateless Workers over 1..N items using a structured parent-planned job packet. For 2+ independent same-shape items, pass them ALL in `items` in ONE call — the harness runs them as a concurrency-bounded pool with an honest per-item ledger (scrape, classify, summarize, fetch, transform, create N records, send N messages with different bodies).',
      'Each worker gets its own isolated context — use this to keep your own context from ballooning over hundreds of items, and to run the work concurrently instead of sequentially.',
      'Input: one packet (objective, resolvedTools, externalMcpToolNames, context, instructions, expectedOutput) that applies to every item, plus `items` (the full list) or `item` (a single identifier). Put every external MCP capability in the typed exact `externalMcpToolNames` array (`server__tool`); resolvedTools carries schemas/commands/instructions but does not widen that lease. Workers are isolated and cannot see your prior tool outputs unless you paste the needed details into the packet. Include intent when the items should use a user-configured worker category such as design, writing, research, code, or analysis.',
      'When to use: 3+ independent items of the same kind. The Worker returns a tight result you aggregate. TRIP-WIRE: if you catch yourself about to call the same research/enrichment/read/write tool a 3rd time for a DIFFERENT item in one turn, STOP and fan the REMAINING items out with run_worker instead of looping serially (serial piles every item\'s payload into your context and is exactly what tripped the loop guard and got the last batch cancelled).',
      `On LARGE fan-outs, results MAY return as compact digests with the full output parked and shard summaries attached — when they do, synthesize from those and drill into a specific item with ${toolCallHint('tool_output_query', { call_id: '<call id>' })} only where an exact figure is needed.`,
      'For durable multi-wave or multi-phase work, include workManifest. Its phases are per-item worker stages; exclude parent-only ranking, merge, final synthesis, and reporting. Declare the canonical item universe and graph on the first wave; reconcile later labels (for example sheet rows) back to those ids with aliases. The harness checkpoints logical progress and refuses accidental scope inflation before spawning workers.',
      'CRITICAL: a worker result beginning with "ERROR:" means that item FAILED — it was NOT done. Never summarize a batch as complete if any worker returned ERROR. Report exactly which items succeeded and which failed, including the worker reason, and treat the run as needs-attention rather than success.',
      'COMPOSE → SINGLE COMMIT for external mutations: workers may execute reads and reason, but the Composio gateway mechanically refuses worker writes/sends. Require each worker to return one exact {id, composioSlug, args, account_alias?} payload. Validate and aggregate every returned payload, then call run_batch action="propose" ONCE; its immutable pending batch is the one payload the user approves and the parent executes. Never approve a summary before the workers materialize the final payloads, and never ask workers to call run_batch or pending_action tools.',
      'When NOT to use: tasks that need cross-item memory or a single coherent output stream — those stay on you.',
    ].join(' ');
  const runWorkerAsToolOptions = {
    toolName: 'run_worker',
    toolDescription: runWorkerToolDescription,
    parameters: WorkerToolInputSchema,
    inputBuilder: buildWorkerJobPrompt,
    ...(workerThrashGuardEnabled() ? { runOptions: { maxTurns: workerMaxTurns } } : {}),
  };
  const runWorkerTool = tool({
    name: 'run_worker',
    description: runWorkerToolDescription,
    parameters: WorkerToolCallSchema,
    strict: true,
    isEnabled: async () => !hostFreshPlanning
      || actionExpectedWorkRequired(hostFreshPlanning.identity),
    execute: async (callParams, runContext, details) => {
      const call = callParams as WorkerToolCall;
      const callItems = workerCallItems(call);
      if (!callItems || callItems.length === 0) {
        return 'ERROR: run_worker needs `item` (one identifier) or `items` (the full list for a parallel batch).';
      }
      // Advisory-only cost note for browser-per-item fan-outs (live 2026-07-23).
      const heavyAdvisory = maybeHeavyPerItemToolAdvisory(
        extractSessionId(runContext) ?? undefined,
        callItems.length,
        JSON.stringify(call),
      );
      const knownDeadSig = fanoutUniformFailure(extractSessionId(runContext) ?? '');
      if (knownDeadSig) {
        return `ERROR: workers were NOT started — parallel fan-out already failed uniformly this run (${knownDeadSig}). Process the remaining items inline; workers stay refused until the underlying failure changes.`;
      }
      const manifestSessionId = extractSessionId(runContext) ?? '';
      const manifestSourceUserSeq = harnessRunContextStorage.getStore()?.sourceUserSeq
        ?? extractSourceUserSeq(runContext);
      const quantifiedManifestGate = evaluateQuantifiedWorkManifestGate({
        sessionId: manifestSessionId,
        sourceUserSeq: manifestSourceUserSeq,
        items: callItems,
        workManifest: call.workManifest as WorkerManifestDescriptor | null | undefined,
      });
      if (!quantifiedManifestGate.ok) return `ERROR: ${quantifiedManifestGate.error}`;
      let manifestBinding: PreparedWorkerManifest | undefined;
      if (call.workManifest && manifestSessionId) {
        const prepared = prepareWorkerManifest({
          sessionId: manifestSessionId,
          sourceUserSeq: manifestSourceUserSeq,
          items: callItems,
          descriptor: call.workManifest as WorkerManifestDescriptor,
          objective: call.objective,
        });
        if (!prepared.ok) return `ERROR: workers were NOT started — ${prepared.error}`;
        manifestBinding = prepared.binding;
      }
      // A durable completion is materially different from a fresh worker run.
      // Preserve that truth at the tool boundary so the brain does not mistake
      // receipt reuse for another execution and keep asking for the same batch.
      // We still return the persisted work-products below: after a daemon
      // restart they may be the only synthesis material in the brain's context.
      const durableReusedItems = new Set<string>();
      let durablePhaseComplete = false;
      if (workerResumeIdempotencyEnabled() && manifestSessionId && manifestBinding) {
        const reuse = summarizePreparedWorkerReuse(manifestSessionId, manifestBinding, callItems);
        for (const item of reuse.completedItems) durableReusedItems.add(item);
        durablePhaseComplete = reuse.phaseComplete;
      }
      const allRequestedItemsReused = durableReusedItems.size === callItems.length;
      const durableReuseGuidance = allRequestedItemsReused && manifestBinding
        ? durablePhaseComplete
          ? `Manifest guidance: the complete "${manifestBinding.phase}" phase is already proven for ${manifestBinding.manifestId} contract ${manifestBinding.contractVersion}. Do not call run_worker again for this phase; synthesize the user-facing result now from the returned work-products and durable evidence.`
          : `Manifest guidance: this requested slice is already proven for ${manifestBinding.manifestId}/${manifestBinding.phase} contract ${manifestBinding.contractVersion}. Do not repeat these items; continue only with canonical items that remain incomplete.`
        : null;
      const { items: _batch, ...packetRaw } = call;
      const packetBase = bindWorkerPacketExpectedWork({
        packet: packetRaw,
        sessionId: manifestSessionId,
        sourceUserSeq: manifestSourceUserSeq,
        items: callItems,
      });
      if (callItems.length > 1) {
        // Deterministic batch (2026-07-21): the harness owns the parallelism so
        // a brain that would have serialized N run_worker calls no longer pays
        // N× wall time. Per-item worker slots keep provider throttling honest;
        // per-item callId suffixes keep tool_outputs/reduce-tier rows distinct.
        const specs = callItems.map((item, index) => {
          const workerInput = { ...packetBase, item } as WorkerToolInput;
          return { item, index, input: workerInput, packetKey: workerPacketKey(workerInput) };
        });
        const outputContext = getToolOutputContext();
        const batchHarnessContext = harnessRunContextStorage.getStore();
        if (!manifestBinding && (!manifestSessionId || !batchHarnessContext?.dispatchLease)) {
          return 'ERROR: workers were NOT started — an ordinary batch needs an exact accepted-source dispatch lease so concurrent/restart execution can be fenced durably.';
        }
        let exactBatchKey: string;
        try {
          exactBatchKey = workerBatchKey({
            sessionId: manifestSessionId,
            sourceUserSeq: manifestSourceUserSeq,
            workflowRunId: outputContext?.workflowRunId,
            manifestScopeId: manifestBinding
              ? `${manifestBinding.manifestId}:${manifestBinding.contractVersion}:${manifestBinding.phase}`
              : undefined,
            logicalCallId: outputContext?.callId ?? details?.toolCall?.callId,
            packetKeys: specs.map((entry) => entry.packetKey),
          });
        } catch (error) {
          if (error instanceof WorkerBatchIdentityError) {
            return `ERROR: workers were NOT started — ${error.message}.`;
          }
          throw error;
        }
        const previewRoute = resolveChatWorkerModel(specs[0]!.input);
        const previewModel = getSessionWorkerModelOverride(manifestSessionId)
          ?? previewRoute.model
          ?? resolveRoleModel('worker').modelId;
        const previewProvider = resolveEffectiveProviderForModel(previewModel);
        let batch: WorkerBatchExecutionResult<string>;
        try {
          batch = await runResumableWorkerBatch({
            batchKey: exactBatchKey,
            items: specs,
            maxConcurrency: workerBatchPoolWidth({ provider: previewProvider, modelId: previewModel }),
            deadlineAt: currentToolAbortDeadlineAt(),
            callerSignal: currentToolAbortSignal() ?? (details as { signal?: AbortSignal } | undefined)?.signal,
            ...(!manifestBinding && batchHarnessContext?.dispatchLease ? {
              durableOwner: {
                sessionId: manifestSessionId,
                parentLease: batchHarnessContext.dispatchLease,
              },
            } : {}),
            beforeGeneration: (lease) => {
              if (manifestBinding && manifestSessionId) {
                fencePreparedWorkerInFlight(manifestSessionId, manifestBinding, callItems, lease.generationId);
              }
            },
            execute: async (spec, lease) => {
              const perDetails = {
                ...(details as Record<string, unknown> | undefined),
                signal: lease.signal,
                ...(details?.toolCall?.callId
                  ? { toolCall: { ...details.toolCall, callId: `${details.toolCall.callId}-i${spec.index}` } }
                  : {}),
              };
              try {
                return String(await runOneOrchestratorWorker(
                  spec.input,
                  runContext,
                  perDetails,
                  manifestBinding,
                  lease,
                ) ?? '');
              } catch (err) {
                if (
                  err instanceof KillRequested
                  || err instanceof AgentRuntimeCancelledError
                  || isWorkerBatchGenerationCancellation(err, lease.signal)
                ) throw err;
                return `ERROR: worker for "${spec.item}" failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
              }
            },
            failed: workerResultIndicatesFailure,
            failureReason: (output) => output.split('\n')[0]?.slice(0, 300) ?? '',
          });
        } catch (error) {
          if (error instanceof WorkerBatchOwnershipConflictError) {
            return 'ERROR: workers were NOT started — this exact batch already has a live durable owner. Wait for that generation to settle; do not start overlapping work.';
          }
          throw error;
        }
        const outs = batch.items.map((entry) => entry.output ?? null);
        if (batch.status === 'parked') {
          return [
            ...(heavyAdvisory ? [heavyAdvisory] : []),
            `Batch parked safely before the unchanged run_worker deadline: ${batch.remainder.settled.length}/${callItems.length} settled; ${batch.remainder.failed.length} failed; ${batch.remainder.in_flight.length} in_flight; ${batch.remainder.pending.length} pending (not attempted). No worker body remains active. Re-run the exact same items to reuse settled receipts and continue only the remainder.`,
            renderWorkerBatchRemainder(batch.remainder),
            ...batch.items
              .filter((entry) => entry.output !== undefined)
              .map((entry) => `--- item: ${entry.item} ---\n${entry.output}`),
          ].join('\n\n');
        }
        const rendered = callItems.map((item, index) => {
          const text = outs[index] ?? `ERROR: worker for "${item}" crashed before returning a result.`;
          return { item, text, failed: workerResultIndicatesFailure(text) };
        });
        const failedItems = rendered.filter((r) => r.failed);
        const memoSessionId = extractSessionId(runContext) ?? '';
        if (failedItems.length === 0 && memoSessionId) clearFanoutUniformFailure(memoSessionId);
        const uniform = failedItems.length === rendered.length ? uniformFailureSignature(failedItems.map((f) => f.text)) : null;
        // Self-heal: uniform "unknown model" = the endpoint's real catalog
        // speaking — memo the dead id and invite an immediate retry (see
        // worker-tools.ts twin).
        if (uniform && looksLikeUnknownModelError(uniform)) {
          const deadModel = resolveRoleModel('worker', call.intent || undefined).modelId;
          markByoModelNotServed(deadModel);
          const healed = repairByoRoutedModelId(deadModel);
          if (healed !== deadModel) {
            return `Batch failed: ALL ${rendered.length} workers died because the configured worker model "${deadModel}" is not served by the BYO endpoint. It has been AUTO-CORRECTED to "${healed}" — call run_worker again NOW with the same items; it will dispatch on the corrected model.`;
          }
        }
        // Fleet resilience twin of the unknown-model heal: a uniform RATE LIMIT
        // benches the routed model for a cooldown and invites an immediate
        // retry, which spawn-time selection will route to the next healthy
        // candidate — instead of declaring fan-out down for a transient 429.
        // Classify on RAW texts, never the normalized signature — normalization
        // rewrites "429" to "<n>" and blinded this branch to real Moonshot 429s
        // (live 2026-07-22: 30/30 workers died rate-limited, no bench, no switch).
        if (uniform && (workerFailureLooksRateLimited(uniform) || failedItems.some((f) => workerFailureLooksRateLimited(f.text)))) {
          const benched = resolveRoleModel('worker', call.intent || undefined).modelId;
          markWorkerModelCoolingDown(benched);
          const next = pickWorkerModelWithFallover([benched, resolveRoleModel('worker').modelId, MODELS.primary]);
          if (next.falloverFrom) {
            return `Batch failed: ALL ${rendered.length} workers hit a rate limit on worker model "${benched}". It is benched for a cooldown and fan-out has AUTO-SWITCHED to "${next.model}" — call run_worker again NOW with the same items; they will dispatch on the healthy model.`;
          }
        }
        if (uniform && memoSessionId) {
          markFanoutUniformFailure(memoSessionId, uniform);
          // Abort = coverage boundary: the items transfer to inline execution
          // and must not count against fan-out coverage (see worker-tools.ts).
          try {
            appendEvent({ sessionId: memoSessionId, turn: 0, role: 'system', type: 'fanout_run_boundary', data: { reason: 'uniform_failure_abort', signature: uniform } });
          } catch { /* best-effort */ }
        }
        const header = failedItems.length === 0
          ? allRequestedItemsReused && manifestBinding
            ? `Durable receipt: all ${rendered.length}/${rendered.length} requested items were already complete for ${manifestBinding.manifestId}/${manifestBinding.phase} contract ${manifestBinding.contractVersion}. No worker ran and no action was repeated.`
            : durableReusedItems.size > 0
              ? `Batch complete: ${rendered.length}/${rendered.length} items succeeded (${durableReusedItems.size} reused from durable evidence; ${rendered.length - durableReusedItems.size} newly executed).`
              : `Batch complete: ${rendered.length}/${rendered.length} items succeeded.`
          : uniform
            ? `PARALLEL FAN-OUT IS DOWN for this run: ALL ${rendered.length} items failed IDENTICALLY (${uniform}). This is an infrastructure failure, not an item problem — do NOT call run_worker again this turn. Process the remaining work inline and TELL THE USER the run degraded to sequential (and why).`
            : `Batch finished with FAILURES: ${rendered.length - failedItems.length}/${rendered.length} succeeded; FAILED items: ${failedItems.map((f) => f.item).join(', ')}. Report these honestly — they were NOT done.`;
        return [
          ...(heavyAdvisory ? [heavyAdvisory] : []),
          header,
          ...rendered.map((r) => `--- item: ${r.item} ---\n${r.text}`),
          ...(durableReuseGuidance ? [durableReuseGuidance] : []),
        ].join('\n\n');
      }
      const singleResult = await runOneOrchestratorWorker(
        { ...packetBase, item: callItems[0] } as WorkerToolInput,
        runContext,
        details,
        manifestBinding,
      );
      if (!allRequestedItemsReused || !manifestBinding) return singleResult;
      return [
        `Durable receipt: this item was already complete for ${manifestBinding.manifestId}/${manifestBinding.phase} contract ${manifestBinding.contractVersion}. No worker ran and no action was repeated.`,
        singleResult,
        durableReuseGuidance,
      ].filter(Boolean).join('\n\n');
    },
  }) as Tool<RuntimeContextValue>;

  // Per-worker tool-call budget (2026-07-22 live: 30 nested workers SHARED the
  // parent turn's counter — the first ~23 items drained it and the last 7 had
  // their scrapes refused with "tool-call limit exceeded". The SDK lane already
  // gives each worker its own generous counter (sub-agents.ts); this is the
  // orchestrator-lane twin). The counter bounds a single runaway worker; the
  // real limits remain per-worker maxTurns, the pool cap, and the run token
  // budget. Parent context fields (sessionId, sourceUserSeq) carry through.
  let workerBudgetScopeSeq = 0;
  const invokeWorkerWithOwnBudget = async (
    nestedTool: { invoke: (ctx: any, payload: string, det: any) => Promise<unknown> },
    ctx: any,
    payload: string,
    det: any,
    maxTurnsForItem: number,
    mcpToolScopeOverride?: McpToolScope | null,
    dispatchLeaseOverride?: DispatchLeaseRef,
  ): Promise<unknown> => {
    const parent = harnessRunContextStorage.getStore();
    const sessionId = parent?.sessionId ?? extractSessionId(ctx) ?? '';
    const counter = new ToolCallsCounter(Math.max(defaultToolCallsPerTurn(), maxTurnsForItem * 4));
    return withHarnessRunContext(
      {
        sessionId,
        counter,
        // Worker identity is authority, not a loop-guard side effect. Keep it
        // present even when CLEMMY_WORKER_THRASH_GUARD=off so the central
        // Composio gateway can enforce compose -> parent batch commit.
        workerScope: true,
        ...(parent?.sourceUserSeq ? { sourceUserSeq: parent.sourceUserSeq } : {}),
        ...(mcpToolScopeOverride !== undefined
          ? { mcpToolScope: mcpToolScopeOverride }
          : parent?.mcpToolScope !== undefined
            ? { mcpToolScope: parent.mcpToolScope }
            : {}),
        ...(dispatchLeaseOverride
          ? { dispatchLease: dispatchLeaseOverride }
          : parent?.dispatchLease
            ? { dispatchLease: parent.dispatchLease }
            : {}),
        ...(parent?.runAttemptId ? { runAttemptId: parent.runAttemptId } : {}),
        ...(workerThrashGuardEnabled()
          ? { guardrailScopeId: `${sessionId}::wkr:${Date.now()}-${(workerBudgetScopeSeq = (workerBudgetScopeSeq + 1) % 1_000_000)}` }
          : {}),
      },
      () => nestedTool.invoke(ctx, payload, det),
    );
  };

  const runOneOrchestratorWorker = async (
    params: WorkerToolInput,
    // Same loosely-typed pair the @openai/agents execute callback receives —
    // threaded through unchanged for the single-item path and per-item for a batch.
    runContext: any,
    details: any,
    manifestBinding?: PreparedWorkerManifest,
    batchLease?: WorkerBatchExecutionLease,
  ) => {
    {
      const input = params as WorkerToolInput;
      // Wave 4 Stage 1: packet key for durable-resume idempotency (see below).
      const packetKey = workerPacketKey(input);
      const route = resolveChatWorkerModel(input);
      const sessionId = extractSessionId(runContext);
      const sourceUserSeq = harnessRunContextStorage.getStore()?.sourceUserSeq;
      const assertWorkerMayStart = (): void => {
        batchLease?.assertCurrent();
        if (!sessionId) return;
        assertNotKilled(
          sessionId,
          Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
            ? { sourceUserSeq: sourceUserSeq as number }
            : undefined,
        );
      };
      const turn = extractTurn(runContext);
      const toolCallId = details?.toolCall?.callId ?? null;
      // Workflow-level worker pin (owner ask, 2026-07-24): a step session
      // registered by the workflow runner overrides the global worker role.
      let workerModel = getSessionWorkerModelOverride(sessionId)
        ?? route.model
        ?? resolveRoleModel('worker').modelId;
      let workerProvider = resolveEffectiveProviderForModel(workerModel);
      // A byo-routed id no BYO provider serves would 400 on dispatch — repair to
      // the backend's real primary id (no-op for owned ids / non-byo providers).
      if (workerProvider === 'byo') workerModel = repairByoRoutedModelId(workerModel);
      // Fleet resilience: a rate-limited worker model is benched for a cooldown
      // window — route this item to the next healthy candidate instead of
      // burning a slot on a known-429 model. Chain stays inside the models this
      // session already legitimately uses (routed → default worker binding →
      // session primary), so provider-isolation promises hold.
      const workerPick = pickWorkerModelWithFallover([
        workerModel,
        resolveRoleModel('worker').modelId,
        MODELS.primary,
      ]);
      if (workerPick.falloverFrom) {
        workerModel = workerPick.model;
        workerProvider = resolveEffectiveProviderForModel(workerModel);
        if (workerProvider === 'byo') workerModel = repairByoRoutedModelId(workerModel);
      }
      // P6: throttle concurrent worker fan-out per session so N parallel run_worker
      // calls can't open N provider calls at once and storm a rate limit. Bounds BOTH
      // worker lanes (this wraps before the route branch). Released in the finally.
      // worker_queued/worker_spawned mirror the SDK lane's emits (worker-tools.ts)
      // so Codex-brain swarms are just as visible on the NowStrip/Slack/Discord.
      const releaseWorkerSlot = await acquireWorkerSlot(sessionId ?? '', (info) => {
        try {
          recordOperationalEvent({
            source: 'harness',
            type: 'worker_queued',
            sessionId: sessionId ?? undefined,
            actor: 'run_worker',
            payload: { item: input.item, lane: 'orchestrator', ...info },
          });
        } catch { /* telemetry is best-effort */ }
      }, {
        modelId: workerModel,
        provider: workerProvider,
        assertCanStart: assertWorkerMayStart,
        signal: batchLease?.signal,
      });
      try {
      const appendWorkerRoute = (data: Record<string, unknown>) => {
        if (!sessionId) return;
        try {
          appendEvent({
            sessionId,
            turn,
            role: 'system',
            type: 'worker_model_routed',
            data: {
              ...data,
              toolCallId,
            },
          });
        } catch {
          // Routing telemetry should never block worker fan-out.
        }
      };
      // Move 5: durable per-worker completion record — restart-surviving coverage
      // + spend for a long 100-subagent run (the in-memory fanout ledger is lost
      // on a daemon restart). Best-effort; never blocks fan-out.
      const workerRouteStartedAt = Date.now();
      const appendWorkerResult = (data: {
        item: string;
        ok: boolean;
        model?: string | null;
        toolUses?: string[];
        tokens?: number;
        reason?: string;
        preRun?: boolean;
        checkpointManifest?: boolean;
      }): void => {
        if (!sessionId) return;
        const { preRun, checkpointManifest = true, ...eventData } = data;
        let resultEvent: ReturnType<typeof appendEvent> | undefined;
        batchLease?.assertCurrent();
        try {
          resultEvent = appendEvent({ sessionId, turn, role: 'system', type: 'worker_result', data: { ...eventData, packetKey, toolCallId, ...(batchLease ? { batchKey: batchLease.batchKey, generationId: batchLease.generationId } : {}) } });
        } catch { /* durable trace is best-effort */ }
        if (manifestBinding && checkpointManifest) {
          batchLease?.assertCurrent();
          try {
            checkpointPreparedWorker(
              sessionId,
              manifestBinding,
              input.item,
              data.ok ? 'succeeded' : 'failed',
              {
                attemptId: batchLease ? `${batchLease.generationId}:${packetKey}` : toolCallId ?? packetKey,
                ...(data.ok && resultEvent
                  ? { evidence: [{ kind: 'worker_result', ref: `event:${resultEvent.seq}` }] }
                  : {}),
                ...(data.reason ? { reason: data.reason } : {}),
              },
            );
          } catch { /* manifest visibility is best-effort */ }
        }
        // Provider-call accounting is owned by the Claude SDK adapter or the
        // RouterModelProvider target wrapper. This logical worker_result is a
        // durable UI/restart mirror and must not create a second spend row.
        if (preRun) return;
      };
      const workerResultReason = (value: unknown): string => {
        const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : String(value ?? '');
        return raw.split('\n')[0].slice(0, 400);
      };
      // Stage 3 reduce tier: what this call RETURNS to the parent brain. Past
      // ~8 results in a fan-out window, a compact parked digest replaces the
      // verbatim payload and shard summaries ride along in-band; small
      // fan-outs and ERROR results are byte-identical to today.
      const reduceReturn = async (output: unknown, reuseParkedOutput = false): Promise<string> => {
        const text = typeof output === 'string' ? output : String(output ?? '');
        return buildWorkerReturn({
          sessionId,
          parentRunId: getToolOutputContext()?.workflowRunId || sessionId || '',
          item: input.item,
          text,
          callId: toolCallId ?? `call_w_${workerRouteStartedAt}_${packetKey.slice(0, 12)}`,
          ...(reuseParkedOutput ? { reuseParkedOutput: true } : {}),
        });
      };
      const appendWorkerResultFromOutput = (
        output: unknown,
        data: { model?: string | null; toolUses?: string[]; tokens?: number } = {},
      ): void => {
        const text = typeof output === 'string' ? output : String(output ?? '');
        const ok = !workerResultIndicatesFailure(text);
        appendWorkerResult({
          item: input.item,
          ok,
          ...data,
          ...(ok ? {} : { reason: workerResultReason(text) }),
        });
      };
      const workerResultTokens = (usage: unknown): number => {
        const u = usage as Record<string, unknown> | undefined;
        if (!u || typeof u !== 'object') return 0;
        const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
        return n('input_tokens') + n('output_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
      };
      // Subagent-runs visibility spine (parity with worker-tools.ts's SDK-brain
      // lane): record WHO ran (provider+model+role), WHAT they did (task +
      // work-product), OUTCOME — attributed to the workflow run when spawned inside
      // a step, else the chat session. This @openai/agents (Codex/GLM-BYO) lane
      // never recorded, so the Agents panel was empty on those brains. Fail-open;
      // never blocks fan-out. Derives ok/capped from the worker output text (the
      // same "ERROR:" / turn-cap signals the in-memory ledger reads).
      const recordWorkerSubagent = (outputText: string, ranModel: string | null | undefined): void => {
        try {
          const ctx = getToolOutputContext();
          const parentRunId = ctx?.workflowRunId || sessionId;
          if (!parentRunId) return;
          const text = outputText ?? '';
          const ok = !workerResultIndicatesFailure(text);
          const capped = !ok && /MaxTurnsExceeded|hit its turn cap/i.test(text);
          const model = ranModel || workerModel;
          const provider = resolveEffectiveProviderForModel(model);
          recordSubagentRun({
            id: `w-${workerRouteStartedAt}-${Math.random().toString(36).slice(2, 8)}`,
            parentRunId,
            parentKind: ctx?.workflowRunId ? 'workflow' : 'session',
            workflowName: ctx?.workflowName,
            stepId: ctx?.stepId,
            role: input.intent || undefined,
            provider,
            model,
            task: input.item,
            packetKey,
            status: capped ? 'capped' : ok ? 'ok' : 'error',
            output: text,
            startedAt: new Date(workerRouteStartedAt).toISOString(),
            finishedAt: new Date().toISOString(),
          });
        } catch { /* visibility trace is best-effort */ }
      };
      // Forward-only receipt for an interrupted ordinary batch. It is narrower
      // than the session-wide replay guard: exact source-bound batchKey + exact
      // packet + recoverable content-addressed output are all required.
      if (
        batchLease
        && sessionId
        && completedWorkerBatchPacket(sessionId, batchLease.batchKey, packetKey)
      ) {
        const ctx = getToolOutputContext();
        const parentRunId = ctx?.workflowRunId || sessionId;
        const prior = findCompletedSubagentOutput(parentRunId, input.item, packetKey);
        if (prior?.trim()) {
          appendWorkerResult({
            item: input.item,
            ok: true,
            model: workerModel,
            toolUses: [],
            reason: 'resume: reused exact interrupted-batch receipt',
            preRun: true,
            checkpointManifest: false,
          });
          return await reduceReturn(prior, true);
        }
      }
      // Manifest identity survives a changed model packet and a daemon restart.
      // If this exact logical item already has evidence-backed success on the
      // active contract, reuse its persisted output and never dispatch it again.
      // A missing auxiliary payload is not permission to repeat an external
      // action: return the durable evidence receipt truthfully instead.
      if (workerResumeIdempotencyEnabled() && sessionId && manifestBinding) {
        const completed = completedPreparedWorker(sessionId, manifestBinding, input.item);
        if (completed) {
          const ctx = getToolOutputContext();
          const parentRunId = ctx?.workflowRunId || sessionId;
          let prior: string | null = null;
          for (const completedPacketKey of completed.packetKeys) {
            prior = findCompletedSubagentOutput(parentRunId, input.item, completedPacketKey);
            if (prior?.trim()) break;
          }
          const reused = prior?.trim()
            ? prior
            : [
                `Durable manifest success reused for "${input.item}" (${manifestBinding.manifestId}/${manifestBinding.phase}, contract ${manifestBinding.contractVersion}).`,
                'The original worker payload is unavailable after restart; the completed action was NOT executed again.',
                `Preserved evidence: ${completed.state.evidence.map((entry) => `${entry.kind}:${entry.ref}`).join(', ')}.`,
              ].join(' ');
          appendWorkerResult({
            item: input.item,
            ok: true,
            model: workerModel,
            toolUses: [],
            reason: 'resume: reused durable manifest success',
            preRun: true,
            checkpointManifest: false,
          });
          return await reduceReturn(reused, Boolean(prior?.trim()));
        }
      }
      // Wave 4 Stage 1 — durable-resume idempotency, checked BEFORE the fuzzy
      // cap-guard so an exact-packet ok match (the stronger signal) wins: a worker
      // that genuinely COMPLETED must not be refused-as-failed on resume because a
      // same-domain sibling capped (adversarial review F1). REUSE the prior
      // work-product instead of re-executing (which would redo the work + re-issue
      // its external writes). ONLY short-circuit when the real output is
      // recoverable — else fall through and re-execute rather than pass a
      // placeholder off as success (F4); the duplicate-send wall backstops any
      // repeated send. Fail-open; kill-switch CLEMMY_WORKER_RESUME_IDEMPOTENCY.
      if (workerResumeIdempotencyEnabled() && sessionId && workerAlreadyCompletedForPacket(sessionId, packetKey)) {
        const ctx = getToolOutputContext();
        const parentRunId = ctx?.workflowRunId || sessionId;
        const prior = findCompletedSubagentOutput(parentRunId, input.item, packetKey);
        if (prior && prior.trim()) {
          // preRun:true → durable worker_result is written but no phantom
          // route-outcome metric is recorded (this worker did not actually run).
          appendWorkerResult({
            item: input.item,
            ok: true,
            model: workerModel,
            toolUses: [],
            reason: 'resume: reused prior completed result',
            preRun: true,
            checkpointManifest: false,
          });
          return await reduceReturn(prior, true);
        }
        // No recoverable output → do NOT claim success; re-execute below.
      }

      // HARD respawn guard (covers BOTH worker lanes — placed before the route
      // branch). If THIS item already hit its turn cap (worker_capped) earlier in
      // this run, refuse to re-spawn it: a re-run with the same packet just caps
      // again, which is the non-converging loop observed live 2026-06-22 (N=3
      // research fan-out, 12+ min, manual cancel). The ERROR: prefix routes the
      // item into the EXISTING fanout-ledger ok=false -> N-of-M honest-partial
      // path (hooks.ts:362, background-tasks.ts fanoutCoverageBlock). The wording
      // MUST NOT contain "hit its turn cap" / "MaxTurnsExceeded" or hooks.ts:380
      // would self-fire a spurious worker_capped. Gated under the existing thrash
      // guard; workerItemAlreadyCapped is fail-open so it can never block fan-out.
      if (workerThrashGuardEnabled() && sessionId && workerItemAlreadyCapped(sessionId, input.item)) {
        const message = `ERROR: worker for "${input.item}" already exhausted its worker turn budget on a prior attempt this run and was NOT re-spawned (a re-run with the same packet would exhaust again). Report this item as failed / needs-attention; do not retry it.`;
        appendWorkerResult({ item: input.item, ok: false, model: workerModel, toolUses: [], reason: workerResultReason(message), preRun: true });
        return message;
      }
      // Dev-only forced 429 (CLEMMY_FAULT_INJECT_WORKER_MODEL): prove the
      // worker-model fallover loop live — the injected failure is the ONLY fake
      // part; uniform detection, bench, auto-switch, and the healthy re-batch
      // all run for real. Inert in production (env unset).
      if (faultInjectWorkerModel() === workerModel) {
        const message = injectedWorkerRateLimitText(input.item, workerModel);
        appendWorkerResult({ item: input.item, ok: false, model: workerModel, toolUses: [], reason: workerResultReason(message), preRun: true });
        return message;
      }
      // Stage 4 fan-out slice: never SPAWN past an exhausted run token window.
      // The parent loop parks honestly at its own boundary, but a single turn
      // fanning out N workers re-checks nothing between spawns — this durable
      // pre-spawn check is that boundary. Refusal (not a kill): the item routes
      // into the honest N-of-M partial path; idempotent reuse above stays free.
      const fanoutBudget = sessionId ? fanoutBudgetStatus(sessionId) : null;
      if (fanoutBudget?.exceeded) {
        const message = `ERROR: worker for "${input.item}" was NOT started — this run's token budget is exhausted (${formatTokens(fanoutBudget.usedWindow)}/${formatTokens(fanoutBudget.ceiling)} uncached tokens used). Report this item as not-attempted; a fresh budget window opens on the run's next pass.`;
        appendWorkerResult({ item: input.item, ok: false, model: workerModel, toolUses: [], reason: workerResultReason(message), preRun: true });
        return message;
      }
      // The slot may have been acquired before the durable pre-run checks above.
      // Stop must still win at the final provider-dispatch edge.
      assertWorkerMayStart();
      // Announce a real spawn only after every pre-run reuse/refusal gate. A
      // restart replay that reuses a persisted result must not look like the
      // worker ran twice in the UI or proof ledger.
      try {
        recordOperationalEvent({
          source: 'harness',
          type: 'worker_spawned',
          sessionId: sessionId ?? undefined,
          actor: 'run_worker',
          payload: { item: input.item, model: workerModel, provider: workerProvider, lane: 'orchestrator' },
        });
      } catch { /* telemetry is best-effort */ }
      if (sessionId) {
        try {
          appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_started', data: { item: input.item, packetKey, ...(batchLease ? { batchKey: batchLease.batchKey, generationId: batchLease.generationId } : {}), model: workerModel, provider: workerProvider, role: input.intent || undefined, lane: 'orchestrator' } });
        } catch { /* telemetry is best-effort */ }
        if (manifestBinding) {
          try {
            checkpointPreparedWorker(sessionId, manifestBinding, input.item, 'running', {
              attemptId: batchLease ? `${batchLease.generationId}:${packetKey}` : toolCallId ?? packetKey,
            });
          } catch { /* manifest visibility is best-effort */ }
        }
      }
      if (claudeAgentSdkWorkerEnabled(workerModel)) {
        // Pass the PARENT chat session so the Claude SDK worker's gates +
        // plan-scope + execution lane aggregate across the fan-out (one batch
        // approval covers all workers).
        try {
          assertWorkerMayStart();
          const sdkResult = await runClaudeAgentSdkWorker(
            input,
            workerModel,
            sessionId,
            sourceUserSeq,
            harnessRunContextStorage.getStore()?.mcpToolScope,
            batchLease?.dispatchLease ?? harnessRunContextStorage.getStore()?.dispatchLease,
            batchLease?.signal,
          );
          batchLease?.assertCurrent();
          appendWorkerRoute({
            ...(route.trace ?? {
              seam: 'chat',
              attemptedIntent: input.intent ?? null,
              matchedIntent: null,
              item: input.item,
              modelId: workerModel,
              provider: 'claude',
              source: 'default',
            }),
            modelId: workerModel,
            provider: 'claude',
            transport: 'claude_agent_sdk_worker',
            sdkSessionId: sdkResult.sdkSessionId ?? null,
            sdkModel: sdkResult.model ?? null,
            toolUses: sdkResult.toolUses,
          });
          // Derive ok from the result, NOT hard-coded — a capped/blocked/empty
          // worker returns an "ERROR:" envelope NORMALLY (the same signal the
          // in-memory honest-partial ledger reads), so the durable coverage map
          // must agree or it would over-report success after a restart.
          const workerOk = !workerResultIndicatesFailure(sdkResult.text);
          recordWorkerSubagent(sdkResult.text ?? '', sdkResult.model ?? workerModel);
          appendWorkerResult({
            item: input.item,
            ok: workerOk,
            reason: workerOk ? undefined : (sdkResult.text ?? '').split('\n')[0]?.slice(0, 200),
            model: sdkResult.model ?? workerModel,
            toolUses: sdkResult.toolUses,
            tokens: workerResultTokens(sdkResult.usage),
          });
          return await reduceReturn(sdkResult.text ?? '');
        } catch (err) {
          if (isWorkerBatchGenerationCancellation(err, batchLease?.signal)) throw err;
          // Claude SDK worker overloaded OR its auth expired BEFORE committing
          // anything (no tool ran, nothing streamed) → fall THIS item over to the
          // nested worker lane on the next brain (Codex→GLM via RouterModelProvider,
          // which handles any further hop). committed=true → rethrow (a re-run could
          // double-act). Kill-switch CLEMMY_BRAIN_FALLOVER.
          const next = (workerBrainFalloverEnabled() && isCommitSafeWorkerFallover(err))
            ? falloverBrainModelIds('claude')[0]
            : undefined;
          if (!next) {
            appendWorkerResult({ item: input.item, ok: false, model: workerModel, toolUses: [], reason: workerResultReason(err) });
            recordWorkerSubagent(`ERROR: ${workerResultReason(err)}`, workerModel);
            throw err;
          }
          appendWorkerRoute({
            seam: 'chat', item: input.item, attemptedIntent: input.intent ?? null,
            modelId: next.modelId, provider: next.provider,
            transport: 'worker_fallover_from_claude', source: 'fallover', toolUses: [],
          });
          const fbOptions = workerThrashGuardEnabled()
            ? { ...runWorkerAsToolOptions, runOptions: { maxTurns: resolveWorkerMaxTurns(input.intent, workerMaxTurns) } }
            : runWorkerAsToolOptions;
          if (!runContext) throw new Error('run_worker requires an SDK run context');
          try {
            assertWorkerMayStart();
            const scopedWorker = await workerAgentForPacket(input, next.modelId);
            const output = await invokeWorkerWithOwnBudget(
              scopedWorker.agent.asTool(fbOptions),
              runContext,
              JSON.stringify(input),
              details,
              resolveWorkerMaxTurns(input.intent, workerMaxTurns),
              scopedWorker.scope,
              batchLease?.dispatchLease,
            );
            batchLease?.assertCurrent();
            recordWorkerSubagent(typeof output === 'string' ? output : String(output ?? ''), next.modelId);
            appendWorkerResultFromOutput(output, { model: next.modelId, toolUses: [] });
            return await reduceReturn(output);
          } catch (fallbackErr) {
            if (isWorkerBatchGenerationCancellation(fallbackErr, batchLease?.signal)) throw fallbackErr;
            appendWorkerResult({ item: input.item, ok: false, model: next.modelId, toolUses: [], reason: workerResultReason(fallbackErr) });
            recordWorkerSubagent(`ERROR: ${workerResultReason(fallbackErr)}`, next.modelId);
            throw fallbackErr;
          }
        }
      }
      // The role trace describes the model originally selected; repair/bench
      // logic above may have changed what will actually cross the provider
      // boundary. Persist the effective route, while retaining the selection
      // source/intent fields for diagnosis. A successful repaired GLM worker
      // must never be recorded as the stale gpt-* id that first triggered the
      // provider rejection.
      appendWorkerRoute({
        ...(route.trace ?? {
          seam: 'chat',
          attemptedIntent: input.intent ?? null,
          matchedIntent: null,
          item: input.item,
          source: 'default',
        }),
        modelId: workerModel,
        provider: workerProvider,
        transport: 'host_harness',
      });
      // Dispatch with the REPAIRED model id — cloning with route.model (or the
      // build-time default) bypassed repairByoRoutedModelId, so telemetry showed
      // the repair while the actual provider call still 400'd (live 2026-07-22,
      // 12/12 workers dead on gpt-5.4 -> z.ai).
      if (!runContext) throw new Error('run_worker requires an SDK run context');
      try {
        const scopedWorker = await workerAgentForPacket(input, workerModel);
        // Intent-aware cap on the nested lane too (non-Claude worker setups).
        // asTool captures runOptions at BUILD time, so rebuild per call.
        const nestedAsToolOptions = workerThrashGuardEnabled()
          ? { ...runWorkerAsToolOptions, runOptions: { maxTurns: resolveWorkerMaxTurns(input.intent, workerMaxTurns) } }
          : runWorkerAsToolOptions;
        const nestedWorkerTool = scopedWorker.agent.asTool(nestedAsToolOptions);
        assertWorkerMayStart();
        const output = await invokeWorkerWithOwnBudget(
          nestedWorkerTool,
          runContext,
          JSON.stringify(input),
          details,
          resolveWorkerMaxTurns(input.intent, workerMaxTurns),
          scopedWorker.scope,
          batchLease?.dispatchLease,
        );
        batchLease?.assertCurrent();
        recordWorkerSubagent(typeof output === 'string' ? output : String(output ?? ''), workerModel);
        appendWorkerResultFromOutput(output, { model: workerModel, toolUses: [] });
        return await reduceReturn(output);
      } catch (err) {
        if (isWorkerBatchGenerationCancellation(err, batchLease?.signal)) throw err;
        appendWorkerResult({ item: input.item, ok: false, model: workerModel, toolUses: [], reason: workerResultReason(err) });
        recordWorkerSubagent(`ERROR: ${workerResultReason(err)}`, workerModel);
        // Infra-shaped failure (credentials/auth/provider config): every sibling
        // dies identically — return an actionable envelope instead of a raw
        // throw so the model stops fanning out, finishes inline, and TELLS the
        // user the run degraded to sequential (mirrors worker-tools.ts).
        const reason = workerResultReason(err);
        if (/missing credentials|no default model provider|api key|apikey|unauthorized|invalid_grant|token_revoked|sign-?in expired/i.test(reason)) {
          return `ERROR: worker for "${input.item}" failed before starting: ${reason} `
            + 'PARALLEL FAN-OUT IS UNAVAILABLE this run (worker model backend has no usable credentials — this will fail identically for every item). '
            + 'Do NOT call run_worker again this turn. Process the remaining items inline instead, and TELL THE USER in your reply that parallel fan-out was unavailable (and why).';
        }
        // Rate-limit / quota exhaustion on the worker BACKEND (e.g. an out-of-tokens
        // Codex/BYO worker model whose own transparent retries are spent) — every
        // sibling on the same backend hits it identically, so a re-fan-out just
        // re-thrashes. Degrade to sequential on the ORCHESTRATOR's brain (which may be
        // a different, healthy provider; if it's the same exhausted brain, the chat
        // lane's model.rate_limited fallover takes over one level up — a Codex 429 /
        // usage-limit classifies model.rate_limited, already fallover-eligible). Accurate
        // wording (NOT "no credentials") so the user hears "rate-limited", not "signed out".
        if (/rate.?limit|too many requests|quota|insufficient_quota|out of (?:tokens|quota|credits)|overloaded|resource_exhausted/i.test(reason)) {
          return `ERROR: worker for "${input.item}" failed before starting: ${reason} `
            + 'PARALLEL FAN-OUT IS UNAVAILABLE this run (worker model backend is rate-limited / out of quota — this will fail identically for every item). '
            + 'Do NOT call run_worker again this turn. Process the remaining items inline instead, and TELL THE USER in your reply that parallel fan-out was unavailable (and why).';
        }
        throw err;
      }
      } finally {
        releaseWorkerSlot();
      }
    }
  };

  // Read-only Composio discovery tool. Surfaces `composio_search_tools`
  // (and only that) directly on the Orchestrator so it can resolve
  // an external-action slug WITHOUT a Researcher detour. This is the
  // Updated 2026-05-20: the Orchestrator now ALSO carries
  // `composio_execute_tool` for the recall-HIT fast path. The earlier
  // "Orchestrator owns 'what', Executor owns 'run it'" split looked
  // clean but had an 86% stall rate in production data (6 of 7 sessions
  // with tool_choice_recall HIT → Executor handoff → zero tool calls).
  // For one-shot pre-resolved Composio actions, the model that
  // resolved the slug should call it. Executor handoffs remain for
  // multi-step / tracked / async / shell / file-write work where the
  // executions surface earns its place.
  //
  // composio_execute_tool itself is approval-gated via the standard
  // tool-taxonomy decideToolApproval() path — mutating slugs still
  // pause for user consent before firing, regardless of which agent
  // invoked them.
  const allCoreTools = factorySkip
    ? []
    : await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const byName = (n: string) =>
    allCoreTools.find((t) => (t as { name?: string }).name === n) as
      | Tool<RuntimeContextValue>
      | undefined;
  // Discovery + direct-execute surfaces:
  //   - composio_search_tools: Composio action discovery
  //   - composio_execute_tool: direct execute on recall HIT (added 2026-05-20)
  //   - desktop_status: direct read-only answer for local app version/status
  //   - local_cli_list / local_cli_probe: $PATH scan + cheap probe for CLIs
  //   - skill_list / skill_read: on-demand skill instruction loading
  //   - tool_choice_recall / _remember / _invalidate: per-machine memory
  //     of which tool actually works for a given intent
  // DERIVED from the single tool registry (TOOL-REGISTRY-PLAN-2026-07-07, step 2):
  // the curated ~130-name array was deleted — membership is now every registry
  // tool whose lanes include 'orchestrator' (deriveOrchestratorDiscoveryNames).
  // Per-tool provenance (the incident history that grew this list) now lives in
  // tool-registry.ts. byName still resolves each name to its live Tool and no-ops
  // to undefined for flag-gated tools (for example spaces ⇒ absent from
  // getCoreTools ⇒ filtered out), so the surface stays byte-identical under a flag
  // exactly as before. Order is the registry's deterministic (alphabetical)
  // declaration order; the dedup below and the JIT ranker treat this as a
  // membership set, and a conformance test pins the SET.
  const discoveryTools: Tool<RuntimeContextValue>[] = [...deriveOrchestratorDiscoveryNames()]
    .map(byName)
    .filter((t): t is Tool<RuntimeContextValue> => Boolean(t));

  // De-duplicate. The registry derivation already yields a unique set, so this is
  // now a defensive no-op kept to preserve the downstream contract.
  const seenDiscoveryNames = new Set<string>();
  const dedupedDiscoveryTools = discoveryTools.filter((t) => {
    const name = (t as { name?: string }).name;
    if (!name || seenDiscoveryNames.has(name)) return false;
    seenDiscoveryNames.add(name);
    return true;
  });
  const localMemoryScope = factorySkip ? null : localMemoryBuiltinScope(scopeUserInput);
  const scopedDiscoveryTools = localMemoryScope
    ? dedupedDiscoveryTools.filter((toolRef) => localMemoryScope.has((toolRef as { name?: string }).name ?? ''))
    : dedupedDiscoveryTools;
  const actionScopedDiscoveryTools = carrierWork
    ? scopedDiscoveryTools.filter((toolRef) => {
        const name = (toolRef as { name?: string }).name ?? '';
        return !name || actionControlAdmitted(name);
      })
    : scopedDiscoveryTools;

  // Phase 1 Tool-RAG: retrieve only the built-in discovery tools this turn plausibly
  // needs (CORE + semantic top-K). Structural tools (planner/approval/question/worker)
  // are ALWAYS kept (added below). Lane admission (options.allowToolJit) covers
  // interactive chat always, and the autonomous respond lanes when the deferred
  // tool-search surface is on (recovery there is the model calling
  // tool_search → call_tool — no user needed). The legacy JIT pruner below still
  // runs ONLY when tool-search is inactive, which by construction only happens on
  // chat lanes — an unattended lane never gets pruning without catalog recovery.
  // Off / no-query / no-embeddings / no-signal → full surface (byte-identical).
  // The ranking query folds in recent prior-turn texts so bare follow-ups inherit
  // intent. Never throws into construction.
  // Resolved EARLY so JIT can stand down when the deferred surface governs: with
  // tool-search active, first-class = structural + hot set and everything else is
  // catalog-reachable — JIT's semantic top-K over the same tools is pure waste
  // (measured 10.5s cold on 2026-07-08: it embedded+ranked 127 built-ins, dropped
  // 61, and the switch then rebuilt the surface its own way) and can even prune a
  // session-LRU tool the hot set wanted first-class.
  const searchDecision = resolveToolSearchDecision({
    allowLane: !factorySkip && options.allowToolJit === true,
    sessionId: options.sessionId,
  });
  const jitDecision = resolveToolJitDecision({
    allowLane: !factorySkip && options.allowToolJit === true && !searchDecision.active,
    sessionId: options.sessionId,
  });
  const sessionMount = composeSessionFromStore(options.sessionId ?? '', {
    toolAllowlist: options.allowedToolNames,
  });
  const discoveryReachable = actionScopedDiscoveryTools
    .map((toolRef) => (toolRef as { name?: string }).name ?? '')
    .filter(Boolean);
  let jitDiscoveryTools = actionScopedDiscoveryTools;
  let jitDropped = 0;
  let jitReason = searchDecision.active ? 'jit-superseded-by-tool-search' : jitDecision.active ? 'jit-active-no-reduction' : 'jit-inactive';
  if (jitDecision.active && scopeUserInput.trim()) {
    try {
      const jitQuery = [scopeUserInput, ...priorUserInputs.slice(0, 3)]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');
      const selection = await selectToolsForTurn({
        userInput: jitQuery,
        tools: actionScopedDiscoveryTools.map((t) => ({
          name: (t as { name?: string }).name ?? '',
          description: (t as { description?: string }).description ?? '',
        })),
        recallPinned: [
          ...recallPinnedBuiltinTools(jitQuery),
          // Candidates resolved for the accepted turn: the carrier each one
          // needs must survive pruning or the brain cannot reach it.
          ...(options.turnCandidates?.pinnedTools ?? []),
        ],
      });
      pinCompositionTools(selection.exposed, sessionMount, discoveryReachable);
      jitReason = selection.reason;
      if (selection.reduced) {
        jitDiscoveryTools = actionScopedDiscoveryTools.filter((t) =>
          selection.exposed.has((t as { name?: string }).name ?? ''),
        );
        jitDropped = selection.droppedCount;
      }
    } catch {
      // JIT selection must never break construction — fall back to the full surface.
      jitDiscoveryTools = actionScopedDiscoveryTools;
      jitReason = 'jit-error-fellback';
    }
  }
  // Telemetry. Emit when there was a real reduction.
  if (options.sessionId && jitDropped > 0) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'tool_jit_scope',
        data: {
          jitActive: jitDecision.active,
          droppedCount: jitDropped,
          exposedCount: jitDiscoveryTools.length,
          reason: jitReason,
        },
      });
    } catch {
      // JIT telemetry should never block agent construction.
    }
  }

  // Schema-on-demand (SCHEMA-ON-DEMAND-PLAN-2026-07-07, Phase 1), behind
  // CLEMMY_CODEX_TOOL_SEARCH (default ON since v1.3.0; =off restores the full
  // first-class surface byte-identically). When active on an interactive chat lane:
  // first-class tools = structural + the tiny acquisition/recovery kernel + a
  // bounded set of explicitly named / proven / actually-used tools; every other
  // discovery tool leaves the schema surface and
  // appears only in the catalog block, reachable THIS turn via call_tool. The catalog
  // is injected via the SAME instructions-trailer mechanism as batchShapeMandate (a
  // per-turn re-render), not baked into a separate cacheable prefix.
  let firstClassDiscovery = jitDiscoveryTools;
  let callTool: Tool<RuntimeContextValue> | null = null;
  let workCallOptions: BuildWorkCallOptions | null = null;
  // Assigned after the capability universe seals (the agent does not exist yet
  // when the dispatcher is built). Until then it fails closed: a production
  // dispatcher can never interpret missing authority as unlimited authority.
  let admitBuiltinAcquisition = (targetName: string): BuiltinCapabilityAdmissionResult => ({
    ok: false,
    kind: 'requires_readmission',
    outside: [targetName],
    reason: 'the orchestrator capability universe or binding revision is not sealed',
  });
  let catalogBlock: string | null = null;
  let searchFirstClassCount = 0;
  let searchCatalogCount = 0;
  let searchFirstClassTokens = 0;
  let searchCatalogTokens = 0;
  if (searchDecision.active) {
    try {
      const excludes = new Set(options.excludeToolNames ?? []);
      const availableNames = new Set(
        actionScopedDiscoveryTools
          .map((toolRef) => (toolRef as { name?: string }).name ?? '')
          .filter(Boolean),
      );
      const explicitAllowed = options.allowedToolNames
        ? new Set(options.allowedToolNames)
        : null;
      const policyAllowed = new Set([...availableNames].filter((name) =>
        !excludes.has(name) && (!carrierWork || !explicitAllowed || explicitAllowed.has(name)),
      ));
      const searchQuery = [scopeUserInput, ...priorUserInputs.slice(0, 3)]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');
      const hot = resolveHotSet(options.sessionId, searchQuery, { allowedNames: policyAllowed });
      pinCompositionHotTools(hot, sessionMount, policyAllowed);
      // Exact caller/candidate resolution is already the answer to discovery.
      // Promote those registry names directly instead of charging another
      // tool_search/model beat. This is bounded by the caller/candidate set and
      // contains no operation vocabulary or prompt-noun matching.
      if (carrierWork) {
        for (const name of options.turnCandidates?.pinnedTools ?? []) {
          if (policyAllowed.has(name)) hot.add(name);
        }
        for (const name of explicitAllowed ?? []) {
          if (policyAllowed.has(name) && actionTopologyRoleFor(name) === 'control') hot.add(name);
        }
      }
      const surface = resolveToolSurface({
        surface: 'orchestrator',
        lane: 'chat',
        availableNames,
        excludeNames: excludes,
        promotedNames: hot,
        // The explicit local-memory scope intentionally suppresses call_tool,
        // so every policy-allowed memory tool must stay directly reachable.
        // General turns have the dispatcher and can safely defer.
        deferralEnabled: !localMemoryScope,
        reason: 'Codex schema-on-demand surface',
      });
      const firstClassNames = new Set(surface.firstClass);
      const deferredNames = new Set(surface.deferred);
      const actionBusinessNames = new Set([...policyAllowed]
        .filter((name) => actionTopologyRoleFor(name) === 'business'));
      const actionControlNames = new Set([...policyAllowed]
        .filter((name) => actionTopologyRoleFor(name) === 'control'));
      // A reviewed Clementine-local capability can keep its ordinary
      // graph-neutral topology while using work_call when it is selected into
      // a fresh plan. That includes exact project reads: work_call owns the
      // requirement binding/cardinality reservation, while unrelated reads
      // retain call_tool. Ref issuance still revalidates the current schema.
      const localPlanningCapabilityNames = new Set([...policyAllowed]
        .filter((name) => routesPlanBoundLocalCapabilityForTurn(name)));
      const workCallBuiltinNames = new Set([
        ...actionBusinessNames,
        ...localPlanningCapabilityNames,
      ]);
      const visibleFirstClassNames = carrierWork
        ? new Set([...firstClassNames].filter((name) => (
            actionControlNames.has(name)
            && actionControlContextFor(name) !== 'task_recovery'
            // Planning binds BUSINESS work. Hot-set controls stay first-class:
            // a uniquely named saved workflow is invoked with workflow_run, not
            // reconstructed through tool_search (live 2026-08-29: planning
            // stripped every control except tool_search, so "run my platform 49
            // workflow" became a Composio hunt).
            // On an action turn these exact mutations must cross work_call's
            // requirement binder. Their ordinary graph-neutral control
            // exposure is unchanged on non-action turns.
            && !localPlanningCapabilityNames.has(name)
          )))
        : firstClassNames;
      const deferredActionControlNames = new Set([...actionControlNames]
        .filter((name) => !visibleFirstClassNames.has(name)));
      // Registry-declared BUSINESS READS ride the control dispatcher too: a
      // read duplicates nothing, so the frozen contract protects nothing on
      // it (the admission wall's doctrine). Writes stay behind work_call.
      const dispatchableActionReadNames = new Set([...policyAllowed]
        .filter((name) => isRegistryDeclaredRead(name) && !visibleFirstClassNames.has(name)));
      const discoverableNames = carrierWork
        ? new Set([...actionBusinessNames, ...deferredActionControlNames])
        : deferredNames;
      firstClassDiscovery = actionScopedDiscoveryTools
        .filter((t) => visibleFirstClassNames.has((t as { name?: string }).name ?? ''))
        // The static tool_search instance searches the entire registry. On the
        // schema-on-demand lane replace it with a turn-scoped instance so every
        // result is guaranteed to be reachable through this turn's one carrier.
        .map((t) => {
          if ((t as { name?: string }).name !== 'tool_search') return t;
          return carrierWork
            ? buildScopedLocalToolSearch(
                discoverableNames,
                'work_call',
                (name) => localPlanningCapabilityNames.has(name)
                  ? 'work_call'
                  : actionTopologyRoleFor(name) === 'control' || isRegistryDeclaredRead(name)
                    ? 'call_tool'
                    : 'work_call',
                actionToolSearchCandidateSources,
                planningDisclosure,
              )
            : buildScopedLocalToolSearch(discoverableNames, 'call_tool');
        });
      // Suppress the generic dispatcher ONLY on the local-memory-scoped turn
      // (memory tools are first-class there; a generic door invites off-scope
      // calls). Everywhere else keep call_tool even when the deferred set is
      // empty — it still carries the MCP-namespaced dispatch path and the
      // first-class-wrap fallback that avoids the not_reachable loop.
      const dispatcherOptions: BuildCallToolOptions = {
        reachableBuiltinNames: carrierWork ? workCallBuiltinNames : discoverableNames,
        firstClassNames: carrierWork ? new Set<string>() : firstClassNames,
        deniedNames: excludes,
        mcpToolScope,
        // The dispatcher is built before the agent exists; the gate cell is
        // assigned after sealing so each built-in acquisition must append
        // or reuse a monotonic binding revision on THIS agent before the
        // inner dispatch. MCP tools retain their separate scope authority.
        admitBuiltinAcquisition: (targetName) => admitBuiltinAcquisition(targetName),
      };
      workCallOptions = carrierWork
        ? {
            ...dispatcherOptions,
            frozenContract,
            ...(hostFreshPlanning ? {
              requireHostPlan: true,
              hostPlanningReady: () => {
                const planning = snapshotPrimaryModelPlanningContext(hostFreshPlanning.authority);
                return Boolean(planning && planning.capabilities.length > 0);
              },
              hostPlanningReadCapabilityResolver: (request) => (
                inspectPrimaryModelPlanningReadCapability({
                  authority: hostFreshPlanning.authority,
                  identity: {
                    sessionId: request.sessionId,
                    sourceUserSeq: request.sourceUserSeq,
                  },
                  operationId: request.operationId,
                })
              ),
              hostSingleActionPlanCapabilityResolver: (request) => (
                inspectPrimaryModelPlanningSingleActionCapability({
                  authority: hostFreshPlanning.authority,
                  identity: {
                    sessionId: request.sessionId,
                    sourceUserSeq: request.sourceUserSeq,
                  },
                  capabilityRef: request.requirementId,
                  operationId: request.operationId,
                  effect: request.effect,
                })
              ),
            } : {}),
            catalogIdentifiers: [...workCallBuiltinNames],
            destinationFamily: frozenDestinationFamily,
            ...(options.turnCandidates?.sourceStrategyBinding
              ? { sourceStrategyBinding: options.turnCandidates.sourceStrategyBinding }
              : {}),
          }
        : null;
      callTool = localMemoryScope
        ? null
        : carrierWork
          ? buildCallTool({
              reachableBuiltinNames: new Set([
                ...[...deferredActionControlNames]
                  .filter((name) => !localPlanningCapabilityNames.has(name)),
                ...[...dispatchableActionReadNames]
                  .filter((name) => !localPlanningCapabilityNames.has(name)),
              ]),
              firstClassNames: visibleFirstClassNames,
              deniedNames: excludes,
              mcpToolScope: {
                authority: 'none',
                reason: 'action control dispatcher never carries external/provider business work',
                allowedServerSlugs: [],
                toolPatterns: [],
                maxTools: 0,
              },
              admitBuiltinAcquisition: (targetName) => admitBuiltinAcquisition(targetName),
              controlOnlyBuiltins: true,
            })
          : buildCallTool(dispatcherOptions);
      const catalogText = buildCompactToolCatalog({ allowedNames: discoverableNames });
      searchCatalogCount = discoverableNames.size;
      searchCatalogTokens = Math.round(catalogText.length / 4);
      catalogBlock = hostFreshPlanning ? null : [
        // Leads with an unambiguous "you HAVE access" — live 2026-07-08 a model
        // read the name-only listing as evidence it had NO tool access and
        // refused the task outright (A_zero_tools stall). The catalog must be
        // impossible to misread as a capability restriction.
        carrierWork
          ? frozenContract
            ? '[tool-catalog] Full tool access. Hot controls and graph-neutral local reads use `call_tool`; plan-selected local reads and business WRITES/MCP/Composio use `work_call`. Reads never need approval. One `tool_search` is the discovery door — do not open sibling search tools. If the packet already resolved a capability, invoke it. The host already froze the work contract; every `work_call` uses proposal:null.'
            : hostFreshPlanning
              ? '[tool-catalog] Full tool access. The planning card contains only exact live refs. If any required ref is absent, use `tool_search` first; its exact results disclose capabilityRef values without business I/O. When the request is exactly one fully specified, dependency-free, cardinality-once action, emit that one proposal-free `work_call` alone; the host compiles its existing durable one-action contract without another model-authored plan. For compound, dependent, multi-action, ambiguous, each/set, admin, destructive, or unknown-effect work, keep ownership of the topology and call `plan_task` first. It may stand alone, or be followed in that same frame by exactly one proposal-free `work_call` for a dependency-root read/compute operation from the draft. After activation, route every plan-selected local read and business operation through proposal-free `work_call`; keep unrelated graph-neutral reads on `call_tool`. Reads never need approval.'
              : '[tool-catalog] Full tool access. Hot controls and graph-neutral local reads use `call_tool`; plan-selected local reads and business WRITES/MCP/Composio use `work_call`. Reads never need approval. One `tool_search` is the discovery door — do not open sibling search tools. If the packet already resolved a capability, invoke it. First `work_call` fuses the proposal with the first inner call; later calls use proposal:null.'
          : '[tool-catalog] Full tool access this turn. First-class tools have schemas; everything else is reachable through `tool_search` then `call_tool`. That is the only discovery door — do not open sibling search tools. If you already know the exact name, `call_tool` it. External MCP names are `<server>__<tool>`. The inner tool controls approval.',
        catalogText,
      ].join('\n');
    } catch (err) {
      // Never break construction — fall back to the full first-class surface.
      firstClassDiscovery = jitDiscoveryTools;
      callTool = null;
      catalogBlock = null;
    }
  }

  if (carrierWork && !workCallOptions) {
    const excludes = new Set(options.excludeToolNames ?? []);
    const explicitAllowed = options.allowedToolNames ? new Set(options.allowedToolNames) : null;
    const businessNames = new Set(actionScopedDiscoveryTools
      .map((toolRef) => (toolRef as { name?: string }).name ?? '')
      .filter((name) => name
        && !excludes.has(name)
        && (!explicitAllowed || explicitAllowed.has(name))
        && actionTopologyRoleFor(name) === 'business'));
    const localPlanningCapabilityNames = new Set(actionScopedDiscoveryTools
      .map((toolRef) => (toolRef as { name?: string }).name ?? '')
      .filter((name) => name
        && !excludes.has(name)
        && (!explicitAllowed || explicitAllowed.has(name))
        && routesPlanBoundLocalCapabilityForTurn(name)));
    const workCallBuiltinNames = new Set([
      ...businessNames,
      ...localPlanningCapabilityNames,
    ]);
    workCallOptions = {
      reachableBuiltinNames: workCallBuiltinNames,
      firstClassNames: new Set<string>(),
      deniedNames: excludes,
      mcpToolScope,
      frozenContract,
      ...(hostFreshPlanning ? {
        requireHostPlan: true,
        hostPlanningReady: () => {
          const planning = snapshotPrimaryModelPlanningContext(hostFreshPlanning.authority);
          return Boolean(planning && planning.capabilities.length > 0);
        },
        hostPlanningReadCapabilityResolver: (request) => (
          inspectPrimaryModelPlanningReadCapability({
            authority: hostFreshPlanning.authority,
            identity: {
              sessionId: request.sessionId,
              sourceUserSeq: request.sourceUserSeq,
            },
            operationId: request.operationId,
          })
        ),
        hostSingleActionPlanCapabilityResolver: (request) => (
          inspectPrimaryModelPlanningSingleActionCapability({
            authority: hostFreshPlanning.authority,
            identity: {
              sessionId: request.sessionId,
              sourceUserSeq: request.sourceUserSeq,
            },
            capabilityRef: request.requirementId,
            operationId: request.operationId,
            effect: request.effect,
          })
        ),
      } : {}),
      catalogIdentifiers: [...workCallBuiltinNames],
      destinationFamily: frozenDestinationFamily,
      ...(options.turnCandidates?.sourceStrategyBinding
        ? { sourceStrategyBinding: options.turnCandidates.sourceStrategyBinding }
        : {}),
    };
    firstClassDiscovery = actionScopedDiscoveryTools
      .filter((toolRef) => {
        const name = (toolRef as { name?: string }).name ?? '';
        return name
          && !excludes.has(name)
          && (!explicitAllowed || explicitAllowed.has(name))
          && actionTopologyRoleFor(name) === 'control'
          && !localPlanningCapabilityNames.has(name);
      })
      .map((toolRef) => (toolRef as { name?: string }).name === 'tool_search'
        ? buildScopedLocalToolSearch(
            workCallBuiltinNames,
            'work_call',
            undefined,
            actionToolSearchCandidateSources,
            planningDisclosure,
          )
        : toolRef);
    callTool = null;
  }

  // Every accepted-turn authority/catalog byte is volatile across turns. Keep
  // it visible and frozen for this Agent activation, but place it AFTER the
  // identity/rubric cache boundary. Calling this whole block "static" made a
  // catalog or frozen-plan revision silently revise the stable prefix.
  const volatileInstructions = [
    batchShapeMandate,
    carrierWork
      ? frozenContract
        ? [
            '[action-work] This exact accepted turn requires durable action authority. Use hot controls directly, and deferred controls plus local READS through the `call_tool` carrier (reads never need a proposal); `run_worker` stays direct for multi-item fan-out (each worker settles its own business calls). Route every business WRITE through `work_call`.',
            formatFrozenWorkAuthority(frozenContract),
            formatFrozenNodeBindings(resolveFrozenNodeBindings({
              contract: frozenContract,
              catalogIdentifiers: workCallOptions?.catalogIdentifiers,
              destinationFamily: workCallOptions?.destinationFamily,
              sourceStrategyBinding: workCallOptions?.sourceStrategyBinding,
            })),
            'If the intended work is ambiguous or cannot be reached safely, talk to the user naturally.',
          ].filter(Boolean).join('\n')
        : hostFreshPlanning
          ? '[action-planning] You are the one foreground reasoning loop. Resolve missing operation refs with `tool_search`; search is metadata/schema discovery only and returns exact citable capabilityRef values. If the request is exactly one fully specified, dependency-free, cardinality-once local_write or external_write, emit exactly one proposal-free `work_call` alone after resolution. The host compiles that sole action through the existing durable plan_task kernel; do not author plan prose for it. You still own readiness and all compound judgment: for dependent, multi-action, ambiguous, each/set, admin, destructive, or unknown-effect work, call `plan_task` first with a brief settled conversational preamble and one compact provider-neutral draft. It may stand alone. To save one foreground step, it may instead have exactly one sibling after it in the same frame: the proposal-free `work_call` bound to a dependency-root read/compute operation declared in that draft. Never combine plan_task with search, writes, admin/unknown effects, dependent work, or additional calls. After activation, plan_task disappears and the proposal-free work_call plus run_worker surfaces remain. Direct conversation, independent read-only answers, and a uniquely named existing workflow (`workflow_run` / `workflow_get`) do not need plan_task.'
          : '[action-work] This exact accepted turn requires durable action authority. Use hot controls directly and deferred controls through their control-only `call_tool` carrier; `run_worker` stays direct for multi-item fan-out (each worker settles its own business calls). Route every business operation through `work_call`. The first `work_call` must fuse one complete provider-neutral topology proposal with its first real inner call—do not spend a separate planning/model round. Subsequent business calls bind a frozen requirement with proposal:null. If the intended work is ambiguous or cannot be reached safely, talk to the user naturally.'
      : null,
    catalogBlock,
    renderCapabilityCandidateCard(options.turnCandidates),
  ].filter(Boolean).join('\n\n');
  const acceptedActionRubric = carrierWork && rubricChoice.variant === 'lean'
    ? ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN
    : rubricChoice.instructions;
  const instructions = harnessInstructions(acceptedActionRubric, {
    sessionId: options.sessionId ?? undefined,
    focusInput: scopeUserInput || undefined,
    volatileInstructions,
  });
  const structuralTools = factorySkip
    ? []
    : carrierWork
    // run_worker stays DIRECT on action turns: it is the fan-out coordination
    // primitive (control role), not a business operation — dropping it made
    // every act-routed multi-item task unable to fan out at all (live
    // 2026-08-11, long-horizon-manifest run 4).
    ? hostFreshPlanning
      // A missing connection or an evidence deficit can become known only
      // after discovery/read results return. Keep the foreground question
      // control on the fresh planning surface so that exact host evidence can
      // produce one visible, resumable choice instead of falling back to the
      // background-agent check-in tool with the same public name.
      ? [buildPlanTaskTool({ planning: hostFreshPlanning }), buildAskUserQuestionTool(), runWorkerTool]
      : [buildRequestApprovalTool(), buildAskUserQuestionTool(), runWorkerTool]
    : localMemoryScope
    ? [plannerTool!, buildAskUserQuestionTool()]
    : [
        plannerTool!,
        buildRequestApprovalTool(),
        buildAskUserQuestionTool(),
        runWorkerTool,
      ];
  // Structural capabilities are constructed here because their exact tool
  // objects carry orchestration-specific pause/continuation behavior. The
  // registry may also list one of those names on the orchestrator lane so it
  // remains discoverable to other catalog consumers; that must not put a
  // second implementation with the same function name on this Agent. Keep the
  // structural object authoritative and leave the host runner's general
  // duplicate-name refusal intact for every other malformed surface.
  const structuralToolNames = new Set(structuralTools
    .map((toolRef) => (toolRef as { name?: string }).name ?? '')
    .filter(Boolean));
  const nonStructuralDiscovery = firstClassDiscovery.filter((toolRef) => {
    const name = (toolRef as { name?: string }).name ?? '';
    return !name || !structuralToolNames.has(name);
  });
  const assembledTools = [
    ...structuralTools,
    ...(carrierWork && workCallOptions ? [buildWorkCall(workCallOptions)] : []),
    ...(callTool ? [callTool] : []),
    ...nonStructuralDiscovery,
  ];
  searchFirstClassCount = assembledTools.length;
  searchFirstClassTokens = Math.round(
    assembledTools.reduce((sum, t) => {
      const anyT = t as { name?: string; parameters?: unknown };
      return sum + JSON.stringify(anyT.parameters ?? {}).length + (anyT.name?.length ?? 0);
    }, 0) / 4,
  );
  if (options.sessionId && searchDecision.active) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'tool_search_scope',
        data: {
          active: searchDecision.active,
          firstClassCount: searchFirstClassCount,
          catalogCount: searchCatalogCount,
          estFirstClassTokens: searchFirstClassTokens,
          estCatalogTokens: searchCatalogTokens,
        },
      });
    } catch {
      // Telemetry never blocks agent construction.
    }
  }
  const toolPolicy = resolveEffectiveToolPolicy({
    surface: 'orchestrator',
    lane: options.allowToolJit === true ? 'chat' : 'execution',
    tools: assembledTools.map((toolRef) => toolRef as Tool<RuntimeContextValue>),
    allowedToolNames: effectiveAllowedToolNames,
    excludeToolNames: options.excludeToolNames,
    reason: 'orchestrator local harness tools',
  });
  if (options.sessionId) {
    try {
      appendEvent({
        sessionId: options.sessionId,
        turn: 0,
        role: 'system',
        type: 'tool_policy_resolved',
        data: {
          ...toolPolicy.diagnostics,
          ...(factorySkip
            ? {
                shortCircuitReason: declinedContinuation ? 'declined_continuation' : 'direct_reply',
                semanticAcquisitionSkipped: true,
                schemaWarmSkipped: true,
                advertisedSchemaCount: 0,
                catalogCount: 0,
              }
            : {}),
        },
      });
    } catch {
      // Tool policy telemetry is diagnostic only.
    }
  }

  const accountQuestionActionExpected = Boolean(
    actionWork || (hostFreshPlanning && options.acceptedRoute === 'act'),
  );
  const accountSelectionRequirements: readonly AccountSelectionRequirement[] =
    accountQuestionActionExpected && hostFreshPlanning && options.acceptedRoute === 'act'
      ? (options.turnCandidates?.requirements ?? []).map((requirement) => Object.freeze({
          roleKey: requirement.roleKey,
          text: requirement.text,
          resolved: requirement.resolved,
        }))
      : [];

  const agent = new Agent<RuntimeContextValue, any>({
    name: 'Clem',
    handoffDescription:
      'Routes work. Plans, decides, and hands off to sub-agents. Cannot mutate state directly.',
    // Function form so the SDK re-renders persistent memory context
    // (SOUL, MEMORY, IDENTITY, working memory, facts, goals) each
    // turn — vault edits and new facts surface immediately without
    // restarting the daemon.
    instructions,
    // Per-call override (dormant — no caller passes it yet) so worker-model
    // routing survives a workflow-step conversion onto the harness loop.
    model: options.model ?? resolveRoleModel('brain').modelId,
    // Dynamic per-turn reasoning effort needs the SDK to honor agent.modelSettings,
    // which it only does when modelSettings was passed at CONSTRUCTION (it sets a
    // private `_modelSettingsExplicitlyConfigured` flag then). So we seed the
    // gpt-5.5 default here (effort:'none' + verbosity:'low') and runTurn mutates
    // only reasoning.effort per turn — no reaching into SDK internals. When the
    // feature is off we pass nothing, so the SDK's own per-model default rides
    // (byte-identical to before). See runtime/harness/reasoning-effort.ts.
    ...(dynamicReasoningEnabled()
      ? { modelSettings: { reasoning: { effort: 'none' as const }, text: { verbosity: 'low' as const } } }
      : {}),
    // Plain-text DECISION contract: no SDK structured outputType. The model
    // ends its turn with prose plus an optional marker, and the loop parses or
    // repairs that. Reintroducing response_format here recreates the observed
    // D_decision_unparsed/schema-validation failures where useful work was
    // discarded because the final envelope was not perfect JSON.
    // T2.1 — wrapToolForHarness adds the per-tool timeout + mid-turn
    // kill check + pre-increment limit check. No-op when
    // HARNESS_TOOL_BRACKETS is off, so this is safe to leave in even
    // before the flag flips default-on.
    tools: toolPolicy.tools
      .map((t) => wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>),
    // A real pause is terminal. A YOLO approval-shaped ask is intentionally
    // non-halting, so this must inspect the tool result instead of using a static
    // stop-at-name list.
    toolUseBehavior: carrierWork
      ? (context, toolResults) => userChoiceToolUseBehavior(
          context,
          toolResults as OrchestratorToolResult[],
          // A host-fresh planning surface is also used for catalog-only and read
          // turns. Only an action carrier plus an exact host-frozen unresolved
          // requirement may turn a planning blocker into a host-authored account
          // question; otherwise the complete result stays with the model.
          {
            actionExpectedWork: accountQuestionActionExpected,
            accountSelectionRequirements,
          },
        )
      : userChoiceToolUseBehavior,
    // Provider-backed MCP servers are deliberately not attached to the model
    // SDK. Discovery stays available through the inert catalog, and an exact
    // selected name executes through call_tool/work_call so the host owns the
    // logical call, physical crossing, approval, and terminal settlement.
    // Phase 2: handoffs intentionally omitted. Sub-agents are tools
    // (run_researcher / run_writer / run_reviewer / run_executor /
    // run_deployer). This puts the Orchestrator in control of every
    // sub-agent invocation lifecycle — when a sub-agent stalls or
    // fabricates, the parent sees the result, can retry, can reroute,
    // and is never silently bypassed by an SDK handoff transfer.
    inputGuardrails: harnessInputGuardrails,
    outputGuardrails: harnessOutputGuardrails,
  });
  bindAgentMcpToolScope(agent, mcpToolScope);
  // Clem 4, Stage 4 activation slice 2: seal the admitted CATALOG UNIVERSE —
  // the full scoped discovery set (every deferred tool with its real schema)
  // plus the structural/dispatcher tools — and record the active surface as
  // binding revision 1. A schema-on-demand acquisition is then a monotonic
  // revision WITHIN the sealed universe, never a widening; MCP tools stay
  // under their own bound scope authority and compose at enforcement. Active
  // instances win name collisions (the turn-scoped tool_search ships a
  // different schema than the static registry instance, and the fingerprint
  // must describe what actually dispatches). The call_tool dispatch boundary
  // refuses unless acquisition succeeds against this exact authority.
  try {
    const budgetSettings = getHarnessBudgetSettings();
    const universeByName = new Map<string, SealableToolLike>();
    for (const toolRef of [
      ...actionScopedDiscoveryTools,
      ...assembledTools,
      ...toolPolicy.tools,
    ] as unknown as SealableToolLike[]) {
      const name = typeof toolRef.name === 'string' ? toolRef.name : '';
      if (name) universeByName.set(name, toolRef); // later (active) instances win
    }
    const sealed = sealAgentCapabilityUniverse({
      sessionId: options.sessionId ?? 'unbound',
      universeTools: [...universeByName.values()],
      activeToolNames: toolPolicy.tools
        .map((toolRef) => (toolRef as { name?: string }).name ?? '')
        .filter(Boolean),
      policyHash: createHash('sha256')
        .update(JSON.stringify(getProactivityPolicySnapshot().policy), 'utf-8')
        .digest('hex'),
      budget: {
        maxUncachedTokens: budgetSettings.maxRunTokens > 0 ? budgetSettings.maxRunTokens : 10_000_000,
        maxModelCalls: budgetSettings.maxTurns > 0 ? budgetSettings.maxTurns * 4 : 200,
        maxToolCalls: budgetSettings.toolCallsPerTurn > 0 ? budgetSettings.toolCallsPerTurn * (budgetSettings.maxTurns > 0 ? budgetSettings.maxTurns : 50) : 500,
        maxElapsedMs: budgetSettings.maxConversationWallMs > 0 ? budgetSettings.maxConversationWallMs : 3_600_000,
      },
    });
    if (sealed.ok) {
      bindAgentCapabilityEnvelope(agent, sealed.envelope);
      bindAgentCapabilityRevision(agent, sealed.revision);
      // Every call_tool acquisition from here on must become a revision within
      // the sealed universe before its inner tool can dispatch. Refusals flow
      // back as typed requires_readmission results; warning-and-continue is
      // forbidden at this authority boundary.
      admitBuiltinAcquisition = (targetName) => appendAgentCapabilityBinding(agent, targetName);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[orchestrator] capability universe refused to seal: ${sealed.errors.join('; ')}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[orchestrator] capability universe sealing threw:', err instanceof Error ? err.message : err);
  }
  return agent;
}

/** Default max turns for the orchestrator role. */
export const ORCHESTRATOR_MAX_TURNS = DEFAULT_MAX_TURNS.orchestrator;
