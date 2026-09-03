/**
 * HOST-owned chat turn stepping — the Runner de-ownership cut.
 *
 * Drop-in for the `RunRunnerFn` seam both production chat-turn owners in
 * loop.ts consume (`runTurn` and the approval-resume path). Instead of
 * handing the whole turn to `@openai/agents` Runner.run — a second harness
 * that loops model→tools→model, owns retries and maxTurns, and decides when
 * the user's turn is done — the HOST:
 *
 *   1. calls `codexOneStep` (ONE model.getResponse through the credential
 *      router: Codex OAuth under AUTH_MODE=codex_oauth — never a raw
 *      OPENAI_API_KEY),
 *   2. executes the returned tool-call intents itself via the SAME tool
 *      objects the Runner used (`agent.tools[].invoke`), emitting the SAME
 *      lifecycle events on the SAME runner emitter so every existing
 *      event-log hook fires unchanged,
 *   3. decides whether to call the model again, bounded by the owner's
 *      existing maxTurns budget,
 *   4. pauses BEFORE any tool whose `needsApproval` says so, handing the
 *      owner the same `RunOutcome` interruption contract — and on resume
 *      executes the approved call exactly ONCE (never re-fired by a retry;
 *      there is no pre-content replay in this runner at all).
 *
 * A model-side limit is thrown as `MaxTurnsExceededError` so the owner's
 * existing mapping returns `limit_exceeded` to the HOST — this module never
 * writes events itself and can never produce an awaiting_user_input.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  GuardrailExecutionError,
  InputGuardrailTripwireTriggered,
  OutputGuardrailTripwireTriggered,
  RunContext,
  runToolInputGuardrails,
  runToolOutputGuardrails,
} from '@openai/agents';
import { toSmartString } from '@openai/agents-core/utils';
import { admitModelStep, codexOneStep } from './codex-one-step.js';
import { materializeStrictNullableFields } from '../schema-normalizer.js';
import type { Agent, AgentInputItem, ModelRequest } from '@openai/agents';
import {
  boundAgentCapabilityEnvelope,
  boundAgentCapabilityRevision,
  toolSchemaFingerprint,
} from '../../agents/capability-envelope.js';
import type { InterruptionInfo, RunOutcome, RunRunnerFn } from './loop.js';
import { acceptedTaskIdFor } from './attempt-identity.js';
import {
  durableLogicalCallContract,
  durableLogicalCallRecoveryMaterial,
} from './logical-call-contract.js';
import {
  InvalidArgumentsPreDispatchResult,
  settleAdmittedLogicalCallPreDispatchRefusal,
} from './attempt-settlement.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { renderFailureWithRetainedWork } from './retained-work-terminal.js';
import {
  canonicalGatewayCarrier,
  readModelCarrier,
  resolveProvenOperation,
} from './carrier-reader.js';
import { currentAcceptedSourceCatalogManifestScope } from './accepted-source-catalog-scope.js';
import {
  KillRequested,
  ToolCallsLimitExceeded,
  harnessToolBracketsEnabled,
  harnessRunContextStorage,
  isHarnessBoundFunctionTool,
  timeoutForTool,
  withHarnessRunContext,
} from './brackets.js';
import {
  activateDispatchLease,
  revokeDispatchLeaseBeforeRecovery,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import {
  EXACT_CHECKPOINT_REENTRY_BUDGET,
  exactCheckpointFrameCallIds,
  exactCheckpointReentryKey,
  noteExactCheckpointReentry,
} from './exact-checkpoint-reentry.js';
import pino from 'pino';
import { appendEvent, getSession, isKillRequested, listEvents, openEventLog } from './eventlog.js';
import * as approvalRegistry from './approval-registry.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import {
  isPromiseShapedReply,
  judgeObjectiveComplete,
  shouldRunObjectiveJudge,
  type ObjectiveJudgeVerdict,
} from './objective-judge.js';
import { gatherSessionSkills, summarizeToolCallsForJudge } from './skill-execution.js';
import {
  MAX_WATCHER_CHECKS,
  MAX_WATCHER_INJECTIONS,
  runWatcherJudge,
  shouldStartWatcherCheck,
  watcherCheckIntervalTools,
  watcherJudgeEnabled,
  type WatcherVerdict,
} from './watcher-judge.js';
import { objectiveMayRequireMultipleResults } from './tool-evidence.js';
import {
  isHostDurableContinuationPendingError,
  type HostDurableContinuationPendingError,
} from './host-durable-continuation.js';

const hostTurnLogger = pino({ name: 'clementine.harness.host-turn-runner' });

/**
 * Bounded in-turn honoring of the model's own `CONTINUE:` marker. The host
 * lane runs one turn per accepted source and reduces the turn to a terminal,
 * so "more tool calls next turn" has no next turn: live 2026-09-01 an
 * authoring turn spent its frames on discovery, wrote "CONTINUE: … ready to
 * submit via one workflow_update call next turn", and the run finished as a
 * successful answer with nothing written. The marker now keeps THIS turn open
 * for the calls it promised, a bounded number of times.
 */
export const MAX_HOST_CONTINUE_MARKER_CONTINUATIONS = 3;

/** The text a refused call frame hands back to the model. The `before
 * dispatch (<token>)` shape is what the no-progress projection keys its stage
 * on, so a corrected retry is progress and an identical one is the loop
 * floor. A refusal that names only a category is a dead end: the model cannot
 * repair what it cannot see (live 2026-09-01: "requires plan sibling" for a
 * malformed read carrier). */
export function hostFrameRefusalDirective(
  reason: HostModelFrameRefusal,
  /** What the host actually knows, so the refusal is a door and not a category:
   * the reads proven this turn (which need no plan) and the operation the
   * model named that could not be proven. Live 2026-09-02 (grok-4.6): "check
   * that the inner operation name and arguments are exact" named no door, the
   * model retried the same call, and the turn died. */
  context?: { provenReads?: readonly string[]; offendingOperation?: string | null },
): string {
  const base = `The host refused this exact call frame before dispatch (${reason}). No tool body was entered.`;
  const provenReads = [...new Set((context?.provenReads ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, 12);
  const exactReadDoor = provenReads.length > 0
    ? ` These operations are PROVEN READS this turn and need no plan — call ONE of them exactly: ${provenReads.join(', ')}.`
      + ' Exact carrier: work_call {"name":"composio_execute_tool","args_json":"{\\"tool_slug\\":\\"<one of those>\\",\\"arguments\\":\\"<that operation\'s arguments as ONE JSON string>\\"}"}.'
    : ' If this was a read, put the exact operation tool_search disclosed under tool_slug and its arguments as ONE JSON string under arguments: work_call {"name":"composio_execute_tool","args_json":"{\\"tool_slug\\":\\"<slug>\\",\\"arguments\\":\\"<JSON string>\\"}"}.';
  const offending = context?.offendingOperation?.trim()
    ? ` The host could not prove "${context.offendingOperation.trim()}" as a read this turn.`
    : '';
  if (reason === 'host_work_call_inner_operation_unidentified') {
    return `${base} The work_call carried an inner call whose operation the host could not identify.${exactReadDoor}`;
  }
  if (reason === 'host_planned_work_call_requires_plan_sibling') {
    return `${base} A write or send through work_call needs its plan: call plan_task naming this operation first.${offending}${exactReadDoor}`;
  }
  return base;
}

/**
 * Completion judge on the host lane. The objective judge — the independent,
 * cross-family check of the final reply against the ORIGINAL request — lived
 * only in the legacy core (loop.ts runConversationCore), which the host engine
 * never enters, so every live host_v1 reply shipped unjudged (2026-09-01).
 * Same gate (shouldRunObjectiveJudge), same judge (judgeObjectiveComplete,
 * hedged across families), same bounded continuation: a NOT DONE verdict rides
 * the one-shot directive channel and the turn keeps working; a done, failed-
 * open or awaiting-user verdict completes. Test seam: _setHostObjectiveJudgeForTests.
 */
export const MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS = 2;
type HostObjectiveJudge = typeof judgeObjectiveComplete;
let hostObjectiveJudge: HostObjectiveJudge = judgeObjectiveComplete;
export function _setHostObjectiveJudgeForTests(judge: HostObjectiveJudge | null): void {
  hostObjectiveJudge = judge ?? judgeObjectiveComplete;
}
/** Host controls are not business evidence for the judge gate. */
const HOST_JUDGE_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'tool_search', 'recall_tool_result', 'workflow_step_result', 'plan_task', 'ask_user_question', 'retry_host',
]);
import {
  ModelStreamStalledError,
  sizedFirstByteStallMs,
  modelStallFalloverGraceMs,
  modelStreamStallMs,
  modelStreamStallRetries,
} from './model-stall-policy.js';
import {
  actionTopologyRoleForRuntimeCall,
  classifyRuntimeToolEffect,
  isDelegationPrimitiveRuntimeCall,
  isUnscopedShellRuntimeCall,
  resolveProviderCarrierLocalReadControl,
  runtimeToolAuthorityBinding,
  trustedRuntimeEffectCarrier,
  unwrapRuntimeEffectiveToolIdentity,
  type RuntimeToolEffect,
  type TrustedRuntimeEffectCarrier,
} from './tool-effect.js';
import { provenCapabilityEntriesForTurn } from './capability-resolution.js';
import {
  completeCarrierArguments,
  completeDirectCarrierArguments,
  isRegisteredCarrierGateway,
} from './carrier-completion.js';
import {
  catalogOperationIdentitiesEqual,
  isPlainOrClementineLocalTool,
} from './runtime-tool-identity.js';
import { classifyDiscoveryCall } from './discovery-boundary.js';
import { hostControlFrameFor, hostReadOnlyExecutionContractFor, isRegistryDeclaredTool } from '../../tools/tool-registry.js';
import { readPersistedHealth } from '../../integrations/cli-catalog/auth-health.js';
import {
  isHostPlanRequiredWorkCall,
  releasePreparedHostWorkCallForRepair,
} from '../../tools/work-call.js';
import { tryHostDispatchNamedWorkflow } from './named-workflow-host-dispatch.js';
import {
  prepareHostWorkCall,
  resolveHostPlanningReadCapability,
  resolveHostSingleActionPlanCapability,
} from '../../tools/work-call-mode.js';
import { hostSingleActionPlanTaskInput } from '../../tools/plan-tools.js';
import {
  acceptedTurnCallAuthorityFor,
  armHostCallAuthority,
  armHostReadOnlyCallAuthority,
  poisonAcceptedTurnCallAuthorityInTransaction,
  withHostCallAttestation,
  withHostReadOnlyCallAttestation,
  HOST_CALL_AUTHORITY_SURFACE_VERSION,
  type HostCallAttestation,
  type HostReadOnlyCallAttestation,
} from './accepted-turn-call-authority.js';
import {
  invokeHostToolCall,
} from './host-tool-invocation.js';
import {
  committedMutationVerificationHoldForOwner,
  recoverCommittedMutationVerificationsForSource,
  executeFrozenMutationVerification,
  type CommittedMutationVerificationHold,
} from './mutation-verification-executor.js';
import type { HostTurnEngineMode } from './turn-engine-selection.js';
import {
  canonicalCatalogIdentityOf,
  canonicalResolvedCapabilityId,
  freezeCatalogSnapshotForSource,
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
  resolveProvenLiveReadCatalogEntry,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  actionExpectedWorkRequired,
  loadExpectedWorkCallBindingState,
} from './expected-work-admission.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { expectedTaskFor } from './resolution-ledger.js';
import {
  classifyHostModelFrame,
  type HostModelFrameDisposition,
  type HostModelFrameRefusal,
} from './host-model-frame-policy.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';
import { loadShippedImplementations } from './shipped-implementation-identity.js';
import { inspectDurableMaterialSourceContinuation } from './task-continuity-runtime.js';
import {
  sourceStrategyBindingsEqual,
  turnPreflightDecisionsEqual,
} from './turn-control.js';
import {
  admitSourceStrategyPhysicalDispatch,
  classifyMaterialSourceManifestPurpose,
  evaluateSourceStrategyIdentityAdmission,
  inspectExactSourceStrategyDecisionForSource,
  physicalSourceCapabilityIdentityFromCatalog,
  withSourceStrategyRequirement,
  type MaterialSourceManifestPurpose,
  type PhysicalSourceCapabilityIdentityV1,
} from './source-strategy-admission.js';
import { mintCurrentRequestSourceArgumentAuthority } from './source-strategy-argument-authority.js';
import {
  withNestedCallAdmission,
} from './nested-tool-approval-admission.js';
import {
  evaluatePreparedHostWorkCallConsent,
  evaluateUncoveredHostMutationConsent,
  durableHostApprovalResolutionMatches,
  hostInteractiveConsentApprovalResumeKey,
  parseHostInteractiveConsentSubjectV1,
  type HostInteractiveConsentSubjectV1,
} from './host-interactive-consent.js';
import { evaluateAuthoredWorkflowMutationConsent } from './authored-workflow-write-authority.js';
import { mintAuthoredCallAuthority } from './authored-call-authority.js';
import { settledPlanTaskActivationWinner } from './plan-task-post-settlement.js';
import { pendingAcceptedReadPlan } from './accepted-task-terminal-preparation.js';
import {
  MAX_WORKFLOW_STEP_RESULT_CONTINUATIONS,
  missingWorkflowStepResultContinuation,
  workflowStepDecisionEndedWithoutResult,
} from './workflow-step-result-continuation.js';
import {
  recordModelRequestDispatchProvenance,
} from './model-request-provenance.js';
import { canonicalPromptCacheRequest } from './prompt-cache-observation.js';
import {
  acceptedModelBatchHistoryDigest,
  admitAcceptedModelBatch,
  finalizeAcceptedModelBatch,
  reopenAcceptedModelBatch,
  type AcceptedModelBatchRef,
} from './accepted-model-batch-checkpoint.js';
import {
  buildHostToolDispositionResult,
  buildUserRejectedHostResult,
  describeCanonicalHostModelResult,
  HOST_TOOL_DISPOSITION_PROTOCOL,
  recordHostModelResultReceipts,
  type HostToolDisposition,
  type HostToolDispositionOutput,
} from './host-model-result-receipt.js';
import {
  recordLogicalModelResultProjectionReceipt,
} from './logical-model-result-projection-receipt.js';
import {
  AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
} from './live-read-planning-authority.js';
import {
  evaluateQuantifiedWorkManifestGate,
  type QuantifiedWorkManifestGateInput,
} from './quantified-work-manifest.js';
import { bareTerminalToolName } from './terminal-tool.js';
import {
  initializeNoProgressGovernor,
  isCanonicalNoProgressAskArguments,
  observeNoProgress,
  NO_PROGRESS_RETRY_BUDGET,
  parseNoProgressGovernorState,
  type NoProgressGovernorState,
} from './no-progress-governor.js';
import { parseExactPlanTaskRefusal } from './plan-task-result-contract.js';
import { toOrchestratorDecision } from './turn-decision.js';
import {
  projectHostNoProgressAttempt,
  projectHostNoProgressAuthority,
} from './host-no-progress-projection.js';
import { inspectConversationProtocol } from './conversation-protocol.js';
const HOST_STATE_VERSION = 5;
const HOST_STATE_KEY = '__clemHostInterrupt';
const HOST_RECOVERY_STATE_VERSION = 1;
const HOST_RECOVERY_STATE_KEY = '__clemHostRecovery';
const HOST_READ_ONLY_SURFACE_VERSION = 'configured_harness_function_surface_v1';
const HOST_PREPARATION_REPAIR_DIAGNOSTIC_MAX_CHARS = 8_192;

/** Preserve a host-owned preparation repair for the next model step without
 * interpreting provider/tool vocabulary or admitting unbounded result bytes.
 * Keeping both ends retains the envelope's error/detail prefix and its repair
 * suffix when an unusually large frozen-plan card must be clipped. */
export function boundedHostPreparationRepairDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const diagnostic = value.trim();
  if (!diagnostic) return undefined;
  if (diagnostic.length <= HOST_PREPARATION_REPAIR_DIAGNOSTIC_MAX_CHARS) return diagnostic;
  const marker = '\n...[host preparation diagnostic truncated]...\n';
  const retained = HOST_PREPARATION_REPAIR_DIAGNOSTIC_MAX_CHARS - marker.length;
  const head = Math.ceil(retained / 2);
  const tail = Math.floor(retained / 2);
  return `${diagnostic.slice(0, head)}${marker}${diagnostic.slice(-tail)}`;
}

/** Separate argument repair from capability retirement. The work-call
 * admission kernel owns the bounded attempt/repair budget; the no-progress
 * capability governor must not reinterpret a current schema repair as proof
 * that the selected capability is unavailable. */
export function hostPreparationRefusalProgress(
  recovery: 'repair_arguments' | 'stop_and_explain',
): { countsCapabilityRefusal: boolean; retireSemanticFrame: boolean } {
  return recovery === 'repair_arguments'
    ? { countsCapabilityRefusal: false, retireSemanticFrame: false }
    : { countsCapabilityRefusal: true, retireSemanticFrame: true };
}

/** A returned nested carrier is model-repairable only when its immutable
 * settlement proves that no host or provider body was entered. Returned text
 * is deliberately absent from this predicate: it supplies the diagnostic
 * only after the durable execution/outcome authority has classified the
 * attempt. */
export function isReturnedPreDispatchHostRefusalSettlement(
  returnedAttempt: {
    outcome: { kind: string; directive?: { action?: string } };
  },
  settlement: {
  executionKind: string;
  outcome: { kind: string; directive?: { action?: string } };
  physicalCrossingCount: number;
  hostCrossingCount: number;
  },
): boolean {
  return returnedAttempt.outcome.kind === 'invalid_arguments'
    && returnedAttempt.outcome.directive?.action === 'repair_arguments'
    && settlement.outcome.kind === 'invalid_arguments'
    && settlement.outcome.directive?.action === 'repair_arguments'
    && settlement.executionKind === 'refused_pre_dispatch'
    && settlement.physicalCrossingCount === 0
    // One in-process crossing is the nested host carrier itself. It proves the
    // nominal local validator ran; no provider/body crossing left the process.
    && settlement.hostCrossingCount === 1;
}

export function aggregateHostPreparationRefusalProgress(
  refusals: ReadonlyArray<{
    callId: string;
    recovery: 'repair_arguments' | 'stop_and_explain';
  }>,
): {
  hasTypedRefusal: boolean;
  countingCallIds: string[];
  retireSemanticFrame: boolean;
} {
  const countingCallIds = refusals
    .filter((entry) => hostPreparationRefusalProgress(entry.recovery).countsCapabilityRefusal)
    .map((entry) => entry.callId)
    .sort();
  return {
    hasTypedRefusal: refusals.length > 0,
    countingCallIds,
    // An untyped conflict retains the old fail-closed retirement. For typed
    // refusals, aggregation is any-stop and therefore sibling-order neutral.
    retireSemanticFrame: refusals.length === 0 || countingCallIds.length > 0,
  };
}

/**
 * Public copy for a durable stop-and-explain settlement. It is deliberately
 * value-opaque: provider/tool names and arguments are model input, not safe
 * terminal presentation authority.
 */
export const HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT =
  'I stopped before doing anything external: this step was not set up with permission to use its tool. That is a setup problem on my side, not a missing login or a disconnected account. Nothing was sent or changed. Run it again and I will retry; if it repeats, tell me and I will dig in.';

export const HOST_MODEL_LIMIT_BLOCKED_TEXT =
  'I reached the bounded model-response limit before I could complete this task. I stopped at the durable checkpoint instead of asking you to manufacture a continuation.';

export const HOST_MODEL_STALL_BLOCKED_TEXT =
  'The model transport stopped responding before it completed this step. I stopped at the durable checkpoint; no later model or tool step was started.';

export const HOST_MODEL_INCOMPLETE_BLOCKED_TEXT =
  'The model finished this step without a complete assistant answer or executable tool request. I stopped at the durable checkpoint instead of treating an empty or filtered response as completed work.';

export const HOST_UNSUPPORTED_CAPABILITY_BLOCKED_TEXT =
  'This turn includes an execution capability that the host runner cannot yet project without losing authority or fidelity. I stopped before contacting the model or executing a tool.';

export const HOST_TOOL_DEADLINE_BLOCKED_TEXT =
  'The tool did not finish inside its bounded execution window. I stopped at the durable call checkpoint and did not ask the model to retry it blindly.';

export const HOST_TOOL_UNCERTAIN_BLOCKED_TEXT =
  'The tool stopped after execution may have begun. I preserved the call as uncertain and blocked replay; its effect must be reconciled before continuing.';

function boundedVerificationSurface(value: string, max = 180): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Host-authored user truth for the distinct post-write/readback state. It is
 * intentionally not the generic effect-unknown copy: every listed owner has a
 * redeemable successful write settlement and cannot be dispatched again. */
export function committedWriteVerificationHeldText(
  holds: readonly CommittedMutationVerificationHold[],
): string {
  const visible = holds.slice(0, 4);
  return [
    'The write is committed and will not be repeated. Its exact readback verification is pending or failed, so I stopped before any later action.',
    ...visible.map((hold) => {
      const resource = hold.resourceId
        ? ` Resource: ${boundedVerificationSurface(hold.resourceId)}.`
        : '';
      const verifier = hold.verifierLogicalCallId
        ? ` Verifier: ${boundedVerificationSurface(hold.verifierLogicalCallId)}.`
        : '';
      const recovery = hold.recoveryKind === 'user_action'
        ? ' Reconnect or refresh the exact readback capability, then resume; the write will not repeat.'
        : hold.recoveryKind === 'automatic'
          ? ' Host-owned retry remains pending; no user approval is required.'
          : ' The bounded verifier attempts are exhausted; inspect the readback failure before resuming.';
      return `- ${boundedVerificationSurface(hold.requirementId)}: ${hold.status}; committed result ${boundedVerificationSurface(hold.resultHandleId)}.${resource}${verifier} ${boundedVerificationSurface(hold.reason)}.${recovery}`;
    }),
    ...(holds.length > visible.length
      ? [`- ${holds.length - visible.length} additional committed write verification hold(s).`]
      : []),
  ].join('\n');
}

export const HOST_RESULT_CHECKPOINT_BLOCKED_TEXT =
  'I completed the bounded tool attempt, but its durable tool-result checkpoint could not be verified. I stopped before sending those result bytes to another model or starting another step. The recorded call state must be reconciled, then this task can resume.';

export const HOST_LOCAL_CONTINUATION_UNAVAILABLE_TEXT =
  'I could not durably finish this local step after a bounded internal retry. No uncertain external action is pending. Please retry this request.';

// Plain voice (owner, 2026-09-01: "I would expect more conventional tone with
// Clem"). These stay value-opaque — no tool names, no model prose — but they
// read as a person saying what happened and what she needs. The machine
// reason rides separately on the terminal (blockedReason/blockedDetail).
export const HOST_NO_PROGRESS_BLOCKED_TEXT =
  'I got stuck: I hit the same wall twice in a row, so I stopped rather than loop. Nothing was sent or changed, and everything I already gathered is kept. Tell me how you want to proceed, or ask me to try a different way.';

export const HOST_NO_PROGRESS_KNOWN_RESULT_BLOCKED_TEXT =
  'I could not finish this step: the same call kept ending the same way, so I stopped rather than repeat it. Nothing was sent or changed, and what I already gathered is kept. Point me at what to change and I will pick it back up.';

function hostNoProgressBlockedText(state: NoProgressGovernorState | null): string {
  return state?.lastConsequence?.effectState === 'known_terminal'
    ? HOST_NO_PROGRESS_KNOWN_RESULT_BLOCKED_TEXT
    : HOST_NO_PROGRESS_BLOCKED_TEXT;
}

/**
 * The reply for a governor terminal that lands on a COMPLETED model answer.
 *
 * The governor may refuse to grant new user-input/approval authority from
 * prose — that gate is real. Deleting what the model wrote is a separate act,
 * and it is the defect the owner named: "The model should always own the
 * response, not the harness. Those are harness replies and that tells me the
 * model wasn't given a path to completion."
 *
 * Live 2026-09-03, platform-49 run 6: the model finished its reads, wrote a
 * 616-token answer, and the host replaced it with "I got stuck: I hit the same
 * wall twice in a row" and committed delivered:false. Her findings were never
 * shown and never stored. The turn is still blocked and still non-resumable —
 * only the words are hers. An empty/whitespace answer keeps the host copy,
 * because then there genuinely are no words to hand over.
 */
function modelOwnedTerminalText(
  modelText: string | undefined,
  state: NoProgressGovernorState | null,
): string {
  const spoken = typeof modelText === 'string' ? modelText.trim() : '';
  return spoken.length > 0 ? spoken : hostNoProgressBlockedText(state);
}

export const HOST_PROGRESS_PROJECTION_BLOCKED_TEXT =
  'I couldn\'t verify whether this task made progress, so I stopped before another model or tool step. Please retry this turn.';

export const HOST_CHECKPOINT_ADMISSION_EXHAUSTED_BLOCKED_TEXT =
  'I kept coming back to the same saved checkpoint and it would not reopen, so I stopped instead of retrying it forever. Nothing was sent or changed, and the work I already did is kept. Ask me again and I will start this step fresh.';

export const HOST_DUPLICATE_MODEL_CALL_BLOCKED_TEXT =
  'The model repeated an already-committed tool call identifier. I kept the first durable result and stopped before preparing or executing the duplicate. Retry this request from the saved checkpoint; no second effect was started.';

const HOST_NO_PROGRESS_RECOVERY_DIRECTIVE = [
  'BOUNDED CONTROL RECOVERY — the prior fully settled control step did not establish a new executable path.',
  'Use the results already present to call one available planning control, ask for the missing input, or explain the blocker.',
  'Do not perform another discovery, dependency, provider, or business call, and do not combine planning with work.',
].join(' ');

export function hostNoProgressRecoveryDirective(state: NoProgressGovernorState): string {
  const consequence = state.lastConsequence;
  if (!consequence) return HOST_NO_PROGRESS_RECOVERY_DIRECTIVE;
  if (consequence.recovery === 'ask_user' && consequence.userInput) {
    return [
      'EXACT USER INPUT REQUIRED — the host proved that only the user can supply this value.',
      `Ask exactly: ${consequence.userInput.question}`,
      consequence.userInput.choices.length > 0
        ? `Offer only these choices: ${JSON.stringify(consequence.userInput.choices)}.`
        : 'Do not invent choices.',
      'Use ask_user_question once with purpose exactly "clarification". Do not call discovery, planning, provider, or business tools.',
    ].join(' ');
  }
  if (consequence.recovery === 'stop_factual') {
    return [
      `FACTUAL RESULT — the host validated consequence stage ${consequence.stage}.`,
      'Give one concise factual answer from the exact result already present.',
      'Do not call a tool, ask the user to continue an internal repair, or claim an unobserved effect.',
    ].join(' ');
  }
  if (
    consequence.stage === 'plan_incomplete:missing_write'
    && consequence.recoveryToolNames.length === 1
    && consequence.recoveryToolNames[0] === 'tool_search'
  ) {
    return [
      'BOUNDED AUTO RECOVERY — the accepted plan is missing an exact write and the current planning card has no write repair.',
      'Call tool_search exactly once for the exact missing write capability named by the accepted request.',
      'Do not call plan_task until that search returns a citable write, and do not call a dependency, provider, or business tool.',
    ].join(' ');
  }
  if (
    consequence.stage === 'plan_not_required:graph_neutral'
    && consequence.recoveryToolNames.length === 1
    && consequence.recoveryToolNames[0] === 'call_tool'
  ) {
    return [
      'BOUNDED AUTO RECOVERY — plan_task proved this is graph-neutral read work.',
      'Call call_tool exactly once with the exact read operation and schema already present in the result.',
      'Do not call plan_task, tool_search, a write, or any other tool.',
    ].join(' ');
  }
  if (
    consequence.stage === 'plan_not_required:unique_workflow'
    && consequence.recoveryToolNames.length === 1
    && consequence.recoveryToolNames[0] === 'workflow_run'
  ) {
    return [
      'BOUNDED AUTO RECOVERY — plan_task proved the accepted request uniquely names an existing workflow.',
      'Call workflow_run exactly once with the exact workflowName present in the plan_task result.',
      'Do not call plan_task, workflow_get, tool_search, or any other tool.',
    ].join(' ');
  }
  if (
    (consequence.stage.startsWith('semantic_admission:')
      || consequence.stage === 'plan_binding:verification_successor_required')
    && consequence.recoveryToolNames.length === 1
    && consequence.recoveryToolNames[0] === 'tool_search'
  ) {
    return [
      `BOUNDED AUTO RECOVERY — the host validated consequence stage ${consequence.stage}.`,
      'Call tool_search exactly once for the exact missing capability or verifier named by the refusal.',
      'Do not call plan_task until that search returns a citable ref, and do not call a provider or business tool.',
    ].join(' ');
  }
  if (
    consequence.recovery === 'retry_host'
    && consequence.recoveryToolNames.length === 1
    && consequence.recoveryToolNames[0] === 'plan_task'
  ) {
    // Live 2026-09-01: the refusal said "recoveryTool: retry_host" and the
    // model called call_tool({name:'retry_host'}) — the action is host-owned
    // and the only edge the model walks is the identical plan_task call.
    return [
      `BOUNDED AUTO RECOVERY — the host refused its own internal step at consequence stage ${consequence.stage}; your proposal was admitted.`,
      'Call plan_task exactly once with the IDENTICAL arguments as the refused call. retry_host is not a tool.',
      'Do not call call_tool, tool_search, a provider, or a business tool, and do not change the plan.',
    ].join(' ');
  }
  if (
    (consequence.stage.startsWith('semantic_admission:')
      || consequence.stage === 'plan_binding:verification_successor_required')
    && consequence.recoveryToolNames.length === 1
    && consequence.recoveryToolNames[0] === 'plan_task'
  ) {
    return [
      `BOUNDED AUTO RECOVERY — the host validated consequence stage ${consequence.stage}.`,
      'Call plan_task exactly once with the exact disclosed capabilities and correction named by the refusal.',
      'Do not rediscover, substitute capabilities, or call a provider or business tool.',
    ].join(' ');
  }
  if (
    consequence.stage === 'plan_incomplete:missing_write'
    && consequence.recoveryToolNames.length === 1
    && consequence.recoveryToolNames[0] === 'plan_task'
  ) {
    return [
      'BOUNDED AUTO RECOVERY — the accepted plan is missing a write already present in the exact result.',
      'Call plan_task exactly once with that matching disclosed write bound to the correct write topology operation.',
      'Do not call tool_search, substitute an unrelated write, or claim that the user must continue this internal repair.',
    ].join(' ');
  }
  if (
    consequence.stage.startsWith('schema_invalid')
    && consequence.recoveryToolNames.length === 1
  ) {
    // Directive and surface derive from the same consequence: the surface is
    // exactly the refused carrier, so the text must never send the model to a
    // control that surface does not contain.
    return [
      'BOUNDED AUTO RECOVERY — the last call was refused before dispatch because its arguments did not match the exact schema; the refusal lists the exact failing paths and required shape.',
      `Call ${consequence.recoveryToolNames[0]} exactly once with one corrected JSON object for the same operation.`,
      'Do not call tool_search, plan_task, or another operation.',
    ].join(' ');
  }
  return [
    `BOUNDED AUTO RECOVERY — the host validated consequence stage ${consequence.stage}.`,
    'Use the exact result already present and make one corrective call from the restricted tool surface.',
    'Do not repeat discovery or claim that the user must continue an internal repair.',
  ].join(' ');
}

export const HOST_CAPABILITY_UNAVAILABLE_TEXT =
  'That exact capability is unavailable for this request after two safe, no-effect attempts. I kept the conversation intact; choose another available capability or adjust the request before trying again.';

/** Work-queue carriers that already started the nominated run. Inspect
 * (`workflow_get`) and ask (`ask_user_question`) are not these. Live
 * 2026-08-29 seq 97439: ask_user_question after plan_not_required spent the
 * continuation and the user saw a check-in receipt instead of workflow_run.
 * Live sess-desktop-39e981: dispatch_background_task DID queue work — spending
 * on that carrier still forbids a second injection. */
function uniqueRunQueueCarrierIssued(item: unknown): boolean {
  const row = item as { type?: unknown; name?: unknown; arguments?: unknown };
  if (row.type !== 'function_call' || typeof row.name !== 'string') return false;
  const unwrapped = unwrapRuntimeEffectiveToolIdentity(row.name, row.arguments);
  const name = unwrapped.toolName ?? row.name;
  const tail = name.split('__').at(-1) ?? name;
  return tail === 'workflow_run' || tail === 'dispatch_background_task';
}

/** After plan_task uniquely names an existing workflow, the model must call
 * workflow_run — not complete, inspect, or invent a gate. Live OPEN-THE-GATES C:
 * sess-desktop-ca4779 returned plan_not_required with the exact name, then
 * zero workflow_run. */
export function pendingUniqueWorkflowNameFromHistory(
  history: readonly AgentInputItem[],
): string | null {
  let workflowName: string | null = null;
  let queued = false;
  const planCallIds = new Set<string>();
  for (const item of history) {
    if (workflowName && uniqueRunQueueCarrierIssued(item)) queued = true;
    const row = item as unknown as { type?: unknown; callId?: unknown; name?: unknown };
    if (
      row.type === 'function_call'
      && typeof row.callId === 'string'
      && row.name === 'plan_task'
    ) {
      planCallIds.add(row.callId);
      continue;
    }
    if (
      row.type !== 'function_call_result'
      || typeof row.callId !== 'string'
      || !planCallIds.has(row.callId)
    ) continue;
    const text = functionResultText(item as AgentInputItem);
    if (!text) continue;
    const refusal = parseExactPlanTaskRefusal(text);
    if (
      refusal
      && refusal.payload.code === 'plan_not_required'
      && typeof refusal.payload.workflowName === 'string'
      && refusal.payload.workflowName.trim()
      && (refusal.recoveryTool === 'workflow_run' || refusal.recoveryTool === null)
    ) {
      workflowName = refusal.payload.workflowName.trim();
      queued = false;
    }
  }
  return queued ? null : workflowName;
}

/**
 * The write operations this turn's accepted graph actually bound.
 *
 * A plan-bound refusal is only actionable if it can say WHAT is bound. These
 * identities are host-declared — read straight from the frozen graph, never
 * from model text — so echoing them repairs the call without granting it
 * anything: every gate still runs on the retry.
 */
export function plannedWriteOperationIds(sessionId: string, sourceUserSeq: number): string[] {
  try {
    const expected = expectedTaskFor(sessionId, sourceUserSeq);
    if (expected.status !== 'ok') return [];
    const goals = expected.graph.classification?.goalConstraints;
    const destinations: readonly { binding?: { operationId?: string } }[] = goals?.destinations?.length
      ? goals.destinations
      : (goals?.destination ? [goals.destination] : []);
    return [...new Set(destinations
      .map((entry) => entry.binding?.operationId)
      .filter((operationId): operationId is string => Boolean(operationId)))];
  } catch {
    // Repair guidance is an aid, never a gate. Losing it must never change
    // whether a call is refused.
    return [];
  }
}

/**
 * Retirement terminal WITH the host's own measured cause. Live 2026-08-25
 * (Discord, "top 5 opportunities → sheet"): eleven discovery searches, four
 * minutes, then the bare retirement line — while the CLI auth-health store
 * already knew the one CLI the request needed was not signed in. The user's
 * verdict on that shape: an assistant who says "I couldn't, go figure out
 * why" gets fired.
 *
 * Value-opaque rule holds: only HOST-declared facts are echoed — registry
 * tool names (never a model-invented name) and CLI health entries the host
 * itself measured. Model args are used solely to SELECT among host entries,
 * never quoted.
 */
export function capabilityUnavailableTextFor(
  calls: readonly { name: string; argumentsJson: string }[],
): string {
  const parts: string[] = [HOST_CAPABILITY_UNAVAILABLE_TEXT];
  try {
    const names = new Set<string>();
    const argTokens = new Set<string>();
    for (const call of calls) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(call.argumentsJson); } catch { /* opaque args stay opaque */ }
      const effective = parsed && typeof parsed === 'object'
        ? unwrapRuntimeEffectiveToolIdentity(call.name, parsed as Record<string, unknown>).toolName
        : call.name;
      for (const candidate of [call.name, effective]) {
        if (candidate && isRegistryDeclaredTool(candidate)) names.add(candidate);
      }
      const collect = (value: unknown, depth: number): void => {
        if (depth > 4) return;
        if (typeof value === 'string') {
          // Nested args often arrive as COMPACT JSON-in-a-string, where
          // whitespace splitting leaves `"command":"sf` fused; split on
          // every non-token character so `sf` matches the health entry `sf`.
          for (const token of value.split(/[^A-Za-z0-9._-]+/).slice(0, 48)) {
            if (token && token.length <= 40) argTokens.add(token);
          }
          return;
        }
        if (Array.isArray(value)) { for (const entry of value.slice(0, 32)) collect(entry, depth + 1); return; }
        if (value && typeof value === 'object') {
          for (const entry of Object.values(value as Record<string, unknown>).slice(0, 32)) collect(entry, depth + 1);
        }
      };
      collect(parsed, 0);
    }
    if (names.size > 0) {
      parts.push(`The retired request used ${[...names].sort().join(', ')}.`);
    }
    const health = readPersistedHealth();
    const causes: string[] = [];
    for (const entry of Object.values(health)) {
      if (!entry.installed || entry.authStatus === 'ok') continue;
      if (!argTokens.has(entry.command)) continue;
      const status = entry.authStatus === 'signed_out'
        ? 'is signed out'
        : entry.authStatus === 'error'
          ? 'is failing its sign-in probe'
          : 'has an unverified sign-in';
      causes.push(`the ${entry.command} CLI ${status} (last checked ${entry.checkedAt})`);
    }
    if (causes.length > 0) {
      parts.push(`One measured cause on this machine: ${causes.sort().join('; ')}. Signing that CLI back in should unblock this request.`);
    }
  } catch { /* the bare terminal is still an honest terminal */ }
  return parts.join(' ');
}

class UnsupportedHostCapabilityError extends Error {
  constructor(readonly capabilityKind: string) {
    super(`unsupported host-runner capability surface: ${capabilityKind}`);
    this.name = 'UnsupportedHostCapabilityError';
  }
}

class HostCallAuthorityBoundaryError extends Error {
  constructor(readonly boundaryKind: string) {
    super(`host call-authority boundary refused: ${boundaryKind}`);
    this.name = 'HostCallAuthorityBoundaryError';
  }
}

interface PendingHostCall {
  callId: string;
  name: string;
  /** Mutable: the resume owner writes user-edited args onto rawItem.arguments. */
  rawItem: { name: string; arguments: string; callId: string };
  decision?: 'approved' | 'rejected';
  /** V3: exact reducer subject for a high-consequence planned mutation. */
  consentSubject?: HostInteractiveConsentSubjectV1;
}

export interface HostNoProgressCheckpoint {
  state: NoProgressGovernorState;
  /** First history item not yet reduced. An approval pause may leave an open
   * admitted call at this index; its result is paired before reduction. */
  historyCursor: number;
  recoveryOnly: boolean;
  recoveryDirectiveWritten: boolean;
}

function parseHostNoProgressCheckpoint(
  value: unknown,
  historyLength: number,
): HostNoProgressCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('paused host state has an invalid no-progress checkpoint');
  }
  const candidate = value as Record<string, unknown>;
  const state = parseNoProgressGovernorState(candidate.state);
  const historyCursor = Number(candidate.historyCursor);
  if (
    !state
    || !Number.isSafeInteger(historyCursor)
    || historyCursor < 0
    || historyCursor > historyLength
    || typeof candidate.recoveryOnly !== 'boolean'
    || typeof candidate.recoveryDirectiveWritten !== 'boolean'
    // Recovery-only mode follows a metered miss or a typed consequence; a
    // fresh full budget with no consequence cannot be recovery-only.
    || (candidate.recoveryOnly
      && state.retriesRemaining === NO_PROGRESS_RETRY_BUDGET
      && state.lastConsequence === null)
  ) throw new Error('paused host state has an invalid no-progress checkpoint');
  return {
    state,
    historyCursor,
    recoveryOnly: candidate.recoveryOnly,
    recoveryDirectiveWritten: candidate.recoveryDirectiveWritten,
  };
}

function parseAcceptedModelBatchRef(value: unknown): AcceptedModelBatchRef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('paused host state has an invalid accepted model-batch reference');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sessionId !== 'string' || !candidate.sessionId
    || !Number.isSafeInteger(candidate.sourceUserSeq) || Number(candidate.sourceUserSeq) <= 0
    || typeof candidate.acceptedTaskId !== 'string' || !candidate.acceptedTaskId
    || !Number.isSafeInteger(candidate.batchOrdinal) || Number(candidate.batchOrdinal) <= 0
    || typeof candidate.batchId !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.batchId)
    || typeof candidate.authorityDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.authorityDigest)
  ) throw new Error('paused host state has an invalid accepted model-batch reference');
  return {
    sessionId: candidate.sessionId,
    sourceUserSeq: Number(candidate.sourceUserSeq),
    acceptedTaskId: candidate.acceptedTaskId,
    batchOrdinal: Number(candidate.batchOrdinal),
    batchId: candidate.batchId,
    authorityDigest: candidate.authorityDigest,
  };
}

type HostRecoveryPhase = 'admit' | 'finalize' | 'continue';

/**
 * Private host-owned recovery state.  It is deliberately a different wire
 * type from HostInterruptState: no approval card, user decision, or
 * interruption API can be minted from local checkpoint bookkeeping.
 */
export class HostRecoveryState {
  constructor(
    public readonly sessionId: string,
    public readonly sourceUserSeq: number,
    public readonly phase: HostRecoveryPhase,
    /** Balanced history before the accepted call-bearing frame. */
    public readonly history: AgentInputItem[],
    /** Exact already-accepted model frame; never re-requested from a model. */
    public readonly frameHistory: AgentInputItem[],
    /** Exact already-built results for finalize recovery. */
    public readonly resultItems: AgentInputItem[],
    public readonly lastResponseId: string | undefined,
    public readonly responseId: string | undefined,
    public readonly turnEngine: HostTurnEngineMode,
    public readonly noProgressCheckpoint: HostNoProgressCheckpoint | undefined,
    public readonly stepIndex: number,
    public readonly acceptedModelBatchRef?: AcceptedModelBatchRef,
  ) {}

  static isHostState(blob: string): boolean {
    return blob.trimStart().startsWith(`{"${HOST_RECOVERY_STATE_KEY}"`);
  }

  static fromString(blob: string): HostRecoveryState {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    if (parsed[HOST_RECOVERY_STATE_KEY] !== HOST_RECOVERY_STATE_VERSION) {
      throw new Error('recovery state is not a host-owned checkpoint recovery');
    }
    const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId
      ? parsed.sessionId
      : null;
    const sourceUserSeq = Number(parsed.sourceUserSeq);
    const phase = parsed.phase === 'admit'
      || parsed.phase === 'finalize'
      || parsed.phase === 'continue'
      ? parsed.phase
      : null;
    const history = Array.isArray(parsed.history) ? parsed.history as AgentInputItem[] : null;
    const frameHistory = Array.isArray(parsed.frameHistory)
      ? parsed.frameHistory as AgentInputItem[]
      : null;
    const resultItems = Array.isArray(parsed.resultItems)
      ? parsed.resultItems as AgentInputItem[]
      : null;
    const lastResponseId = typeof parsed.lastResponseId === 'string' && parsed.lastResponseId
      ? parsed.lastResponseId
      : undefined;
    const responseId = typeof parsed.responseId === 'string' && parsed.responseId
      ? parsed.responseId
      : undefined;
    const turnEngine = parsed.turnEngine === 'host_v1'
      || parsed.turnEngine === 'host_v1_read_only'
      ? parsed.turnEngine
      : null;
    const stepIndex = Number(parsed.stepIndex);
    if (
      !sessionId
      || !Number.isSafeInteger(sourceUserSeq)
      || sourceUserSeq <= 0
      || !phase
      || !history
      || !frameHistory
      || !resultItems
      || !turnEngine
      || !Number.isSafeInteger(stepIndex)
      || stepIndex < 0
      || inspectConversationProtocol(history).status !== 'valid'
    ) throw new Error('host checkpoint recovery state is malformed');
    const callIds = frameHistory.flatMap((item) => {
      const row = item as unknown as { type?: unknown; callId?: unknown };
      return row.type === 'function_call' && typeof row.callId === 'string' && row.callId
        ? [row.callId]
        : [];
    });
    const ref = parseAcceptedModelBatchRef(parsed.acceptedModelBatchRef);
    if (phase === 'continue') {
      if (
        frameHistory.length !== 0
        || resultItems.length !== 0
        || !ref
        || ref.sessionId !== sessionId
        || ref.sourceUserSeq !== sourceUserSeq
      ) throw new Error('host checkpoint continuation payload is inconsistent');
    } else {
      if (
        callIds.length === 0
        || new Set(callIds).size !== callIds.length
        || frameHistory.some((item) => (
          (item as unknown as { type?: unknown }).type === 'function_call_result'
        ))
      ) throw new Error('host checkpoint recovery frame is not one exact open model batch');
      const openInspection = inspectConversationProtocol([...history, ...frameHistory]);
      const unmatched = openInspection.issues.filter((issue) => issue.code === 'unmatched_function_call');
      if (
        unmatched.length !== callIds.length
        || openInspection.issues.length !== callIds.length
        || callIds.some((callId) => !unmatched.some((issue) => issue.callId === callId))
      ) throw new Error('host checkpoint recovery frame does not exactly extend its balanced history');
      if (
        phase === 'admit'
          ? resultItems.length !== 0 || ref !== undefined
          : !ref
            || ref.sessionId !== sessionId
            || ref.sourceUserSeq !== sourceUserSeq
            || resultItems.length !== callIds.length
            || inspectConversationProtocol([...history, ...frameHistory, ...resultItems]).status !== 'valid'
      ) throw new Error('host checkpoint recovery phase payload is inconsistent');
    }
    return new HostRecoveryState(
      sessionId,
      sourceUserSeq,
      phase,
      history,
      frameHistory,
      resultItems,
      lastResponseId,
      responseId,
      turnEngine,
      parseHostNoProgressCheckpoint(parsed.noProgressCheckpoint, history.length),
      stepIndex,
      ref,
    );
  }

  toString(): string {
    return JSON.stringify({
      [HOST_RECOVERY_STATE_KEY]: HOST_RECOVERY_STATE_VERSION,
      sessionId: this.sessionId,
      sourceUserSeq: this.sourceUserSeq,
      phase: this.phase,
      history: this.history,
      frameHistory: this.frameHistory,
      resultItems: this.resultItems,
      ...(this.lastResponseId ? { lastResponseId: this.lastResponseId } : {}),
      ...(this.responseId ? { responseId: this.responseId } : {}),
      turnEngine: this.turnEngine,
      ...(this.noProgressCheckpoint
        ? { noProgressCheckpoint: this.noProgressCheckpoint }
        : {}),
      stepIndex: this.stepIndex,
      ...(this.acceptedModelBatchRef
        ? { acceptedModelBatchRef: this.acceptedModelBatchRef }
        : {}),
    });
  }
}

/**
 * Host-native paused-turn state. Duck-typed to the exact surface the
 * approval-resume owner already consumes from the SDK's RunState:
 * `getInterruptions()`, `approve(item)`, `reject(item)` — including the
 * owner's edit-and-approve flow, which mutates `item.rawItem.arguments`
 * before calling approve().
 */
export class HostInterruptState {
  constructor(
    public readonly history: AgentInputItem[],
    public readonly pending: PendingHostCall[],
    /**
     * The last response id this host ACCEPTED. Carried across a pause so an
     * approval resume continues from the same accepted identity rather than
     * reporting none — a rejected response never sets it, so its absence after
     * a resume would mean the identity was lost, not that nothing was accepted.
     */
    public readonly lastResponseId?: string,
    /** Exact host mode owns resume. V1 blobs predate the production host and
     * therefore decode to the read-only engine. */
    public readonly turnEngine: HostTurnEngineMode = 'host_v1_read_only',
    /** V4: exact accepted-source progress budget and unreduced history edge. */
    public readonly noProgressCheckpoint?: HostNoProgressCheckpoint,
    /** V5: the exact still-open model batch that owns a paused approval. */
    public readonly acceptedModelBatchRef?: AcceptedModelBatchRef,
  ) {}

  static isHostState(blob: string): boolean {
    return blob.trimStart().startsWith(`{"${HOST_STATE_KEY}"`);
  }

  static fromString(blob: string): HostInterruptState {
    const parsed = JSON.parse(blob) as {
      [HOST_STATE_KEY]?: number;
      history?: AgentInputItem[];
      pending?: PendingHostCall[];
      lastResponseId?: unknown;
      turnEngine?: unknown;
      noProgressCheckpoint?: unknown;
      acceptedModelBatchRef?: unknown;
    };
    const version = parsed[HOST_STATE_KEY];
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== HOST_STATE_VERSION) {
      throw new Error('paused state is not a host-owned interrupt state');
    }
    // Backward compatible: accepted response identity was optional in V1, and
    // an absent field must decode to `undefined` rather than fail the resume.
    const accepted = typeof parsed.lastResponseId === 'string' && parsed.lastResponseId
      ? parsed.lastResponseId
      : undefined;
    const turnEngine: HostTurnEngineMode = version === 1
      ? 'host_v1_read_only'
      : parsed.turnEngine === 'host_v1'
        ? 'host_v1'
        : parsed.turnEngine === 'host_v1_read_only'
          ? 'host_v1_read_only'
          : (() => { throw new Error('paused host state has no exact engine identity'); })();
    const pending = parsed.pending ?? [];
    if (version >= 3) {
      for (const call of pending) {
        if (call.consentSubject !== undefined) {
          const parsedSubject = parseHostInteractiveConsentSubjectV1(call.consentSubject);
          if (!parsedSubject || parsedSubject.logicalToolCallId !== call.callId) {
            throw new Error('paused host state has an invalid exact consent subject');
          }
          call.consentSubject = parsedSubject;
        }
      }
    } else {
      // V1/V2 remain readable, but historical bytes cannot acquire V3 grant
      // authority merely by carrying an unrecognized lookalike field.
      for (const call of pending) delete call.consentSubject;
    }
    return new HostInterruptState(
      parsed.history ?? [],
      pending,
      accepted,
      turnEngine,
      version >= 4
        ? parseHostNoProgressCheckpoint(
            parsed.noProgressCheckpoint,
            (parsed.history ?? []).length,
          )
        : undefined,
      version === HOST_STATE_VERSION
        ? parseAcceptedModelBatchRef(parsed.acceptedModelBatchRef)
        : undefined,
    );
  }

  toString(): string {
    return JSON.stringify({
      [HOST_STATE_KEY]: HOST_STATE_VERSION,
      history: this.history,
      pending: this.pending,
      turnEngine: this.turnEngine,
      ...(this.lastResponseId !== undefined ? { lastResponseId: this.lastResponseId } : {}),
      ...(this.noProgressCheckpoint
        ? { noProgressCheckpoint: this.noProgressCheckpoint }
        : {}),
      ...(this.acceptedModelBatchRef
        ? { acceptedModelBatchRef: this.acceptedModelBatchRef }
        : {}),
    });
  }

  getInterruptions(): Array<{
    rawItem: PendingHostCall['rawItem'];
    toolName: string;
    approvalResumeKey?: string;
  }> {
    return this.pending
      .filter((call) => !call.decision)
      .map((call) => ({
        rawItem: call.rawItem,
        toolName: call.name,
        ...(call.consentSubject
          ? {
              approvalResumeKey: hostInteractiveConsentApprovalResumeKey(call.consentSubject)
                ?? undefined,
            }
          : {}),
      }));
  }

  approve(item: unknown): void {
    const raw = (item as { rawItem?: PendingHostCall['rawItem'] } | null)?.rawItem;
    const match = this.pending.find((call) => call.rawItem === raw);
    if (match) match.decision = 'approved';
  }

  reject(item: unknown): void {
    const raw = (item as { rawItem?: PendingHostCall['rawItem'] } | null)?.rawItem;
    const match = this.pending.find((call) => call.rawItem === raw);
    if (match) match.decision = 'rejected';
  }
}

type EmitterLike = { emit?: (event: string, ...args: unknown[]) => unknown };

type FunctionToolLike = {
  type?: string;
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
  deferLoading?: boolean;
  providerData?: Record<string, unknown>;
  invoke?: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  needsApproval?: (runContext: unknown, input: unknown, callId?: string) => Promise<boolean> | boolean;
  inputGuardrails?: unknown[];
  outputGuardrails?: unknown[];
};

export type HostCallScheduleClass = 'parallel' | 'barrier';

interface HostCallInvocationObservation {
  /** True only after execution has crossed the local pre-invocation phase. */
  invocationEntered: boolean;
}

export type HostCallExecutionAttempt<R> =
  | { status: 'returned'; value: R; invocationEntered: boolean }
  | {
      status: 'durable_continuation_pending';
      error: HostDurableContinuationPendingError;
      invocationEntered: true;
    }
  | { status: 'tool_calls_limit'; error: ToolCallsLimitExceeded; invocationEntered: false }
  | { status: 'failed'; error: unknown; invocationEntered: boolean };

export interface HostToolCallsLimitCheckpoint {
  history: AgentInputItem[];
  lastResponseId?: string;
}

const hostToolCallsLimitCheckpoints = new WeakMap<
  ToolCallsLimitExceeded,
  HostToolCallsLimitCheckpoint
>();

/** Exact partial host history associated with a propagated tool-call ceiling.
 * The exception object is the authority: arbitrary error text can never mint a
 * checkpoint or enter the resumable budget path. */
export function hostToolCallsLimitCheckpointFor(
  error: unknown,
): HostToolCallsLimitCheckpoint | null {
  return error instanceof ToolCallsLimitExceeded
    ? hostToolCallsLimitCheckpoints.get(error) ?? null
    : null;
}

/**
 * Execute deterministic waves while retaining every started call's outcome.
 * Once one call fails, no new call is assigned; already-running reads drain so
 * their exact results can still be paired in model order. Undefined entries
 * are calls that provably never entered execution.
 */
export async function mapHostCallAttemptsWithBarriersInOrder<T, R>(
  values: readonly T[],
  concurrency: number,
  classify: (value: T) => HostCallScheduleClass,
  fn: (value: T) => Promise<HostCallExecutionAttempt<R>>,
  stopAfterReturned?: (value: R) => boolean,
): Promise<Array<HostCallExecutionAttempt<R> | undefined>> {
  if (values.length === 0) return [];
  const attempts = new Array<HostCallExecutionAttempt<R> | undefined>(values.length);
  let parallelWave: Array<{ value: T; index: number }> = [];
  let stopped = false;

  const runOne = async (entry: { value: T; index: number }): Promise<void> => {
    let attempt: HostCallExecutionAttempt<R>;
    try {
      attempt = await fn(entry.value);
    } catch (error) {
      // The caller normally captures its own invocation phase. If the
      // scheduler contract itself is violated, it cannot prove that execution
      // stayed local, so preserve the pair and choose reconciliation.
      attempt = { status: 'failed', error, invocationEntered: true };
    }
    attempts[entry.index] = attempt;
    if (
      attempt.status !== 'returned'
      || (attempt.status === 'returned' && stopAfterReturned?.(attempt.value) === true)
    ) stopped = true;
  };

  const flushParallelWave = async (): Promise<void> => {
    if (parallelWave.length === 0 || stopped) {
      parallelWave = [];
      return;
    }
    const wave = parallelWave;
    parallelWave = [];
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopped) return;
        const index = nextIndex;
        if (index >= wave.length) return;
        nextIndex += 1;
        await runOne(wave[index]!);
      }
    };
    const workerCount = Math.min(
      wave.length,
      Math.max(1, Math.floor(concurrency)),
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  };

  for (let index = 0; index < values.length; index += 1) {
    if (stopped) break;
    const value = values[index]!;
    let schedule: HostCallScheduleClass;
    try {
      schedule = classify(value);
    } catch (error) {
      attempts[index] = { status: 'failed', error, invocationEntered: false };
      stopped = true;
      break;
    }
    if (schedule === 'parallel') {
      parallelWave.push({ value, index });
      continue;
    }
    await flushParallelWave();
    if (stopped) break;
    await runOne({ value, index });
  }
  await flushParallelWave();
  return attempts;
}

async function functionTools(
  agent: Agent<any, any>,
  runContext: RunContext<unknown>,
  allowExplicitNamespace = false,
): Promise<FunctionToolLike[]> {
  const getAllTools = (agent as {
    getAllTools?: (context: RunContext<unknown>) => Promise<unknown[]>;
  }).getAllTools;
  const tools = typeof getAllTools === 'function'
    ? await getAllTools.call(agent, runContext)
    : (agent as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  const functions = tools.filter((tool): tool is FunctionToolLike =>
    Boolean(tool)
    && typeof (tool as { name?: unknown }).name === 'string'
    && ((tool as { type?: unknown }).type === undefined || (tool as { type?: unknown }).type === 'function'));
  if (functions.length !== tools.length) {
    throw new UnsupportedHostCapabilityError('non_function_tool');
  }
  for (const tool of functions) {
    const hasExplicitNamespace = Object.getOwnPropertySymbols(tool).some((symbol) =>
      symbol.description === 'functionToolNamespace'
      && typeof (tool as unknown as Record<symbol, unknown>)[symbol] === 'string');
    if (hasExplicitNamespace && !allowExplicitNamespace) {
      throw new UnsupportedHostCapabilityError('function_namespace');
    }
  }
  return functions;
}

function serializedTools(tools: FunctionToolLike[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
    strict: tool.strict === true,
    ...(tool.deferLoading === true ? { deferLoading: true } : {}),
    ...(tool.providerData ? { providerData: tool.providerData } : {}),
  }));
}

/** Canonical JSON for content-addressing the model-visible callable surface.
 * Tool schemas are JSON data; a cyclic/non-JSON value cannot be attested and
 * therefore refuses before any model step. */
function canonicalSurfaceJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'undefined') return 'null';
  if (typeof value !== 'object') {
    throw new HostCallAuthorityBoundaryError('non_json_tool_surface');
  }
  if (ancestors.has(value)) throw new HostCallAuthorityBoundaryError('cyclic_tool_surface');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalSurfaceJson(entry, ancestors)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalSurfaceJson(record[key], ancestors)}`
    )).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function hostSurfaceDigest(value: unknown): string {
  return createHash('sha256').update(canonicalSurfaceJson(value), 'utf8').digest('hex');
}

function parsedArgs(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function materializedArgumentsJson(tool: FunctionToolLike | undefined, raw: string): string {
  if (!tool) return raw;
  const parsed = parsedArgs(raw);
  if (!parsed) return raw;
  const materialized = materializeStrictNullableFields(
    parsed,
    tool.parameters ?? { type: 'object', properties: {} },
  );
  return JSON.stringify(materialized);
}

type StructuredToolOutput =
  | { type: 'text'; text: string; providerData?: Record<string, unknown> }
  | {
      type: 'image';
      image: string | { fileId: string };
      detail?: string;
      providerData?: Record<string, unknown>;
    }
  | {
      type: 'file';
      file:
        | string
        | { data: string | Uint8Array; mediaType: string; filename: string }
        | { url: string; filename?: string }
        | { id: string; filename?: string };
      providerData?: Record<string, unknown>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function inlineMediaType(value: Record<string, unknown>): string | undefined {
  return nonEmptyString(value.mediaType)
    ? value.mediaType
    : nonEmptyString(value.mimeType)
      ? value.mimeType
      : undefined;
}

function inlineData(data: string | Uint8Array, mediaType?: string): string {
  if (typeof data === 'string' && data.startsWith('data:')) return data;
  const base64 = typeof data === 'string' ? data : Buffer.from(data).toString('base64');
  return mediaType ? `data:${mediaType};base64,${base64}` : base64;
}

function normalizeImageOutput(value: Record<string, unknown>): StructuredToolOutput | null {
  let image: string | { fileId: string } | undefined;
  const topLevelMediaType = inlineMediaType(value);
  if (nonEmptyString(value.image)) {
    image = value.image;
  } else if (isRecord(value.image)) {
    const imageValue = value.image;
    const mediaType = inlineMediaType(imageValue) ?? topLevelMediaType;
    if (nonEmptyString(imageValue.url)) image = imageValue.url;
    else if (nonEmptyString(imageValue.data)) image = inlineData(imageValue.data, mediaType);
    else if (imageValue.data instanceof Uint8Array && imageValue.data.length > 0) {
      image = inlineData(imageValue.data, mediaType);
    } else if (nonEmptyString(imageValue.fileId)) image = { fileId: imageValue.fileId };
    else if (nonEmptyString(imageValue.id)) image = { fileId: imageValue.id };
  }
  if (!image && nonEmptyString(value.imageUrl)) image = value.imageUrl;
  if (!image && nonEmptyString(value.fileId)) image = { fileId: value.fileId };
  if (!image && nonEmptyString(value.data)) image = inlineData(value.data, topLevelMediaType);
  if (!image && value.data instanceof Uint8Array && value.data.length > 0) {
    image = inlineData(value.data, topLevelMediaType);
  }
  if (!image) return null;
  return {
    type: 'image',
    image,
    ...(nonEmptyString(value.detail) ? { detail: value.detail } : {}),
    ...(isRecord(value.providerData) ? { providerData: value.providerData } : {}),
  };
}

function normalizeFileOutput(value: Record<string, unknown>): StructuredToolOutput | null {
  const direct = value.file;
  let file: Extract<StructuredToolOutput, { type: 'file' }>['file'] | undefined;
  if (nonEmptyString(direct)) {
    file = direct;
  } else if (isRecord(direct)) {
    if (
      (nonEmptyString(direct.data) || (direct.data instanceof Uint8Array && direct.data.length > 0))
      && nonEmptyString(direct.mediaType)
      && nonEmptyString(direct.filename)
    ) {
      file = {
        data: direct.data as string | Uint8Array,
        mediaType: direct.mediaType,
        filename: direct.filename,
      };
    } else if (nonEmptyString(direct.url)) {
      file = { url: direct.url, ...(nonEmptyString(direct.filename) ? { filename: direct.filename } : {}) };
    } else if (nonEmptyString(direct.id) || nonEmptyString(direct.fileId)) {
      file = {
        id: nonEmptyString(direct.id) ? direct.id : direct.fileId as string,
        ...(nonEmptyString(direct.filename) ? { filename: direct.filename } : {}),
      };
    }
  }
  const mediaType = inlineMediaType(value);
  const filename = nonEmptyString(value.filename) ? value.filename : undefined;
  if (!file && (nonEmptyString(value.fileData) || (value.fileData instanceof Uint8Array && value.fileData.length > 0))) {
    if (mediaType && filename) {
      file = { data: value.fileData as string | Uint8Array, mediaType, filename };
    }
  }
  if (!file && nonEmptyString(value.fileUrl)) {
    file = { url: value.fileUrl, ...(filename ? { filename } : {}) };
  }
  if (!file && nonEmptyString(value.fileId)) {
    file = { id: value.fileId, ...(filename ? { filename } : {}) };
  }
  if (!file) return null;
  return {
    type: 'file',
    file,
    ...(isRecord(value.providerData) ? { providerData: value.providerData } : {}),
  };
}

function normalizeStructuredToolOutput(value: unknown): StructuredToolOutput | null {
  if (!isRecord(value)) return null;
  if (value.type === 'text' && typeof value.text === 'string') {
    return {
      type: 'text',
      text: value.text,
      ...(isRecord(value.providerData) ? { providerData: value.providerData } : {}),
    };
  }
  if (value.type === 'image') return normalizeImageOutput(value);
  if (value.type === 'file') return normalizeFileOutput(value);
  return null;
}

function structuredToolOutputs(value: unknown): StructuredToolOutput[] | null {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return null;
  const normalized = values.map(normalizeStructuredToolOutput);
  return normalized.every((item): item is StructuredToolOutput => item !== null)
    ? normalized
    : null;
}

function structuredInputItem(output: StructuredToolOutput): Record<string, unknown> {
  if (output.type === 'text') {
    return {
      type: 'input_text',
      text: output.text,
      ...(output.providerData ? { providerData: output.providerData } : {}),
    };
  }
  if (output.type === 'image') {
    const image = typeof output.image === 'string'
      ? output.image
      : { id: output.image.fileId };
    return {
      type: 'input_image',
      image,
      ...(output.detail ? { detail: output.detail } : {}),
      ...(output.providerData ? { providerData: output.providerData } : {}),
    };
  }
  let file: string | { url: string } | { id: string };
  let filename: string | undefined;
  if (typeof output.file === 'string') {
    file = output.file;
  } else if ('data' in output.file) {
    file = inlineData(output.file.data, output.file.mediaType);
    filename = output.file.filename;
  } else if ('url' in output.file) {
    file = { url: output.file.url };
    filename = output.file.filename;
  } else {
    file = { id: output.file.id };
    filename = output.file.filename;
  }
  return {
    type: 'input_file',
    file,
    ...(filename ? { filename } : {}),
    ...(output.providerData ? { providerData: output.providerData } : {}),
  };
}

function resultText(result: unknown): string {
  return toSmartString(result);
}

function functionResultItem(callId: string, name: string, output: unknown): AgentInputItem {
  const structured = structuredToolOutputs(output);
  return {
    type: 'function_call_result',
    callId,
    name,
    status: 'completed',
    output: structured
      ? structured.map(structuredInputItem)
      : { type: 'text', text: resultText(output) },
  } as unknown as AgentInputItem;
}

function functionResultText(item: AgentInputItem): string | null {
  const candidate = item as unknown as {
    type?: unknown;
    output?: unknown;
  };
  if (candidate.type !== 'function_call_result') return null;
  const output = candidate.output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const text = (output as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  if (Array.isArray(output)) {
    for (const part of output) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}

function hostToolDispositionOutput(item: AgentInputItem): HostToolDispositionOutput | null {
  const text = functionResultText(item);
  if (!text) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const marker = decoded as Partial<HostToolDispositionOutput>;
  if (
    marker.protocol !== HOST_TOOL_DISPOSITION_PROTOCOL
    || typeof marker.frameDigest !== 'string'
    || !marker.frameDigest
    || !Number.isSafeInteger(marker.frameIndex)
    || (marker.frameIndex ?? -1) < 0
    || !Number.isSafeInteger(marker.frameSize)
    || (marker.frameSize ?? 0) <= 0
    || (marker.disposition !== 'refused_pre_dispatch'
      && marker.disposition !== 'not_started')
  ) return null;
  return marker as HostToolDispositionOutput;
}

/**
 * Anti-thrash evidence about the CURRENT request — never a permanent verdict
 * on a capability.
 *
 * These counts used to be read from the WHOLE conversation. Two refusals retire
 * a frame (see recordZeroCrossingRefusal), and history outlives a turn, so a
 * frame retired once stayed retired for the rest of the conversation. The model
 * was then refused before it could act, and the refusal text told the user to
 * "choose another available capability" — with no path back.
 *
 * That makes a remedy structurally unusable. Observed live: Clem correctly
 * reported a signed-out account and named the fix; the user performed it and
 * said so; the next turn refused without probing anything, because the frame
 * had already been retired by the turn that produced the advice.
 *
 * A new user message is new evidence: it may have reconnected an account,
 * granted a scope, or corrected an argument. Counting refusals that predate it
 * would judge the new world by the old one. Refusals therefore accumulate only
 * within the turn that earned them — the guard still stops a model looping on a
 * dead call, and the user can always unblock it by acting.
 */
function priorZeroCrossingRefusalCounts(
  history: readonly AgentInputItem[],
): Map<string, number> {
  const counts = new Map<string, number>();
  let start = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if ((history[index] as { role?: unknown }).role === 'user') {
      start = index;
      break;
    }
  }
  for (const item of history.slice(start)) {
    const marker = hostToolDispositionOutput(item);
    if (
      marker?.disposition === 'refused_pre_dispatch'
      && marker.countsRefusal === true
    ) {
      counts.set(marker.frameDigest, (counts.get(marker.frameDigest) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * One HOST-owned model/tool loop. The exported wrapper below installs the
 * exact physical-attempt lease before entering this body and revokes it at
 * every exit (success, approval pause, typed stop, cancellation, or error).
 */
const runHostTurn: RunRunnerFn = async (runner, agent, itemsOrState, opts) => {
  const emitter = runner as unknown as EmitterLike;
  const contextValue = (opts as { context?: unknown }).context ?? {};
  const runContext = new RunContext(contextValue as never);
  const emit = (event: string, ...args: unknown[]): void => {
    // Lifecycle listeners are part of the execution boundary, not optional
    // telemetry. In particular, loop.ts installs ToolCallsCounter on
    // agent_tool_start when brackets are disabled; swallowing that listener's
    // ToolCallsLimitExceeded would execute the (limit + 1)th tool.
    emitter.emit?.(event, ...args);
  };
  let tools: FunctionToolLike[] = [];
  let toolByName = new Map<string, FunctionToolLike>();
  let configuredToolRefs = new Set<FunctionToolLike>();
  let schemas: unknown[] = [];
  const refreshTools = async (): Promise<void> => {
    const outputType = (agent as { outputType?: unknown }).outputType;
    if (outputType !== undefined && outputType !== 'text') {
      throw new UnsupportedHostCapabilityError('structured_output');
    }
    if ((agent as { prompt?: unknown }).prompt != null) {
      throw new UnsupportedHostCapabilityError('hosted_prompt');
    }
    const getHandoffs = (agent as {
      getHandoffs?: (context: RunContext<unknown>) => Promise<unknown[]> | unknown[];
    }).getHandoffs;
    const handoffs = typeof getHandoffs === 'function'
      ? await getHandoffs.call(agent, runContext)
      : (agent as { handoffs?: unknown }).handoffs;
    if (Array.isArray(handoffs) && handoffs.length > 0) {
      throw new UnsupportedHostCapabilityError('handoff');
    }
    const configuredTools = (agent as { tools?: unknown }).tools;
    configuredToolRefs = new Set(
      Array.isArray(configuredTools)
        ? configuredTools.filter((tool): tool is FunctionToolLike =>
            Boolean(tool)
            && typeof (tool as { name?: unknown }).name === 'string'
            && ((tool as { type?: unknown }).type === undefined
              || (tool as { type?: unknown }).type === 'function'))
        : [],
    );
    tools = await functionTools(agent, runContext, hostProduction);
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new UnsupportedHostCapabilityError('duplicate_function_name');
    }
    toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    schemas = serializedTools(tools);
    armExactHostSurface();
  };
  const signal = (opts as { signal?: AbortSignal }).signal;
  const requestedHostEngine = (opts as { hostTurnEngine?: unknown }).hostTurnEngine;
  const resumedTurnEngine = itemsOrState instanceof HostInterruptState
    || itemsOrState instanceof HostRecoveryState
    ? itemsOrState.turnEngine
    : undefined;
  const optionTurnEngine: HostTurnEngineMode | undefined = requestedHostEngine === 'host_v1'
    || requestedHostEngine === 'host_v1_read_only'
    ? requestedHostEngine
    : (opts as { hostReadOnlyCanary?: unknown }).hostReadOnlyCanary === true
      ? 'host_v1_read_only'
      : undefined;
  if (resumedTurnEngine && optionTurnEngine && resumedTurnEngine !== optionTurnEngine) {
    throw new HostCallAuthorityBoundaryError('persisted_engine_mismatch');
  }
  // The persisted mode selects the owner in loop.ts; the owner threads that
  // exact mode back here. Keeping enforcement opt-in at this seam preserves
  // isolated RunRunnerFn fixtures that exercise pause mechanics without a
  // durable accepted-source authority.
  const hostTurnEngine = optionTurnEngine;
  const hostReadOnlyCanary = hostTurnEngine === 'host_v1_read_only';
  const hostProduction = hostTurnEngine === 'host_v1';
  const hostJudgeCompletion = hostProduction
    && (opts as { hostJudgeCompletion?: unknown }).hostJudgeCompletion === true;
  const configuredHostApprovalId = (opts as { hostApprovalId?: unknown }).hostApprovalId;
  const configuredHostApprovalIds = (opts as { hostApprovalIds?: unknown }).hostApprovalIds;
  const hostApprovalIds = new Set<string>();
  const hostApprovalId = typeof configuredHostApprovalId === 'string'
    && configuredHostApprovalId.trim()
    ? configuredHostApprovalId.trim()
    : null;
  if (hostApprovalId) hostApprovalIds.add(hostApprovalId);
  if (Array.isArray(configuredHostApprovalIds)) {
    for (const value of configuredHostApprovalIds) {
      if (typeof value === 'string' && value.trim()) hostApprovalIds.add(value.trim());
    }
  }
  const configuredPreviousResponseId = (opts as { hostPreviousResponseId?: unknown }).hostPreviousResponseId;
  const hostPreviousResponseId = typeof configuredPreviousResponseId === 'string'
    && configuredPreviousResponseId.trim()
    ? configuredPreviousResponseId
    : undefined;
  const maxTurns = Number((opts as { maxTurns?: unknown }).maxTurns) > 0
    ? Number((opts as { maxTurns?: unknown }).maxTurns)
    : 20;
  const configuredToolConcurrency = Number((opts as {
    toolExecution?: { maxFunctionToolConcurrency?: unknown };
  }).toolExecution?.maxFunctionToolConcurrency);
  const maxToolConcurrency = Number.isFinite(configuredToolConcurrency) && configuredToolConcurrency > 0
    ? Math.floor(configuredToolConcurrency)
    : 8;
  const configuredHostToolDeadlineMs = Number((opts as {
    hostToolDeadlineMs?: unknown;
  }).hostToolDeadlineMs);
  const allowUnownedToolInvocationForTests = (
    (opts as { allowUnownedToolInvocationForTests?: unknown })
      .allowUnownedToolInvocationForTests === true
    && process.env.CLEMMY_TEST_ISOLATED_HOME === '1'
  );
  const hostToolDeadlineMs = (toolName: string): number => (
    Number.isSafeInteger(configuredHostToolDeadlineMs) && configuredHostToolDeadlineMs > 0
      ? configuredHostToolDeadlineMs
      : timeoutForTool(toolName)
  );

  const exactHostIdentity = (): {
    sessionId: string;
    sourceUserSeq: number;
    maxLogicalCalls: number;
  } => {
    const projected = contextValue && typeof contextValue === 'object'
      ? contextValue as { sessionId?: unknown; sourceUserSeq?: unknown }
      : null;
    const projectedSessionId = typeof projected?.sessionId === 'string'
      ? projected.sessionId.trim()
      : '';
    const projectedSourceUserSeq = typeof projected?.sourceUserSeq === 'number'
      && Number.isSafeInteger(projected.sourceUserSeq)
      && projected.sourceUserSeq > 0
      ? projected.sourceUserSeq
      : 0;
    const ambient = harnessRunContextStorage.getStore();
    if (
      !projectedSessionId
      || projectedSourceUserSeq <= 0
      || !ambient
      || ambient.sessionId !== projectedSessionId
      || ambient.sourceUserSeq !== projectedSourceUserSeq
      || !Number.isSafeInteger(ambient.counter.limit)
      || ambient.counter.limit <= 0
    ) {
      throw new HostCallAuthorityBoundaryError('accepted_source_context_mismatch');
    }
    return {
      sessionId: projectedSessionId,
      sourceUserSeq: projectedSourceUserSeq,
      maxLogicalCalls: ambient.counter.limit,
    };
  };

  const poisonExactHostAuthority = (sessionId: string, sourceUserSeq: number, reason: string): void => {
    const current = acceptedTurnCallAuthorityFor(sessionId, sourceUserSeq);
    if (
      current.status !== 'ok'
      || (current.authority.authorityKind !== 'host_v1_read_only'
        && current.authority.authorityKind !== 'host_v1')
    ) return;
    try {
      const db = openEventLog();
      db.transaction(() => {
        poisonAcceptedTurnCallAuthorityInTransaction(db, { sessionId, sourceUserSeq, reason });
      }).immediate();
    } catch {
      // The caller still blocks before the next model/body edge. A storage
      // failure cannot be repaired by dispatching with ambient authority.
    }
  };

  const currentHostSurfaceRevision = () => {
    const currentSchemas = serializedTools(tools);
    const envelope = boundAgentCapabilityEnvelope(agent as object);
    const revision = boundAgentCapabilityRevision(agent as object);
    const catalogEntries = currentSchemas
      .map((schema, index) => ({ name: tools[index]!.name, schema }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const bindingEntries = tools
      .map((tool, index) => ({
        name: tool.name,
        schema: currentSchemas[index],
        configured: configuredToolRefs.has(tool),
        attested: configuredToolRefs.has(tool) && isHarnessBoundFunctionTool(tool),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      envelope,
      revision,
      catalogRevisionDigest: hostSurfaceDigest({
        version: 1,
        sealedCatalogDigest: envelope?.envelopeDigest ?? null,
        modelVisibleTools: catalogEntries,
      }),
      bindingRevisionDigest: hostSurfaceDigest({
        version: 1,
        sealedBindingRevisionDigest: revision?.revisionDigest ?? null,
        exactConfiguredSurface: bindingEntries,
      }),
    };
  };

  let productionCatalogSnapshot: {
    phase: 'graph_neutral' | 'frozen';
    digest: string;
    entries: readonly RegisteredHostCapability[];
  } | null = null;
  const nestedCallAdmissions = new Map<string, object>();
  // Writes the authored-consent evaluator decided `proceed` for, by logical
  // call id. The port invoke mints the adapter's call authority from this
  // grant plus the exact manifest and the schema-validated arguments.
  const authoredCallGrants = new Map<string, { coverageContractId: string }>();
  const freshPlanControlConfigured = (): boolean => {
    const controls = [...configuredToolRefs].filter((tool) => (
      tool.name === 'plan_task'
      && isHarnessBoundFunctionTool(tool)
      && hostControlFrameFor(tool.name) === 'sole'
    ));
    return controls.length === 1;
  };
  const settledFreshPlanControl = (identity: {
    sessionId: string;
    sourceUserSeq: number;
  }): boolean => {
    try {
      // A typed `{ok:false}` repair is a normally settled local control, but it
      // is not the plan that may phase the host surface. Only the exact
      // receipt-linked `{ok:true}` winner has transition authority.
      return settledPlanTaskActivationWinner(identity).status === 'ok';
    } catch {
      return false;
    }
  };
  const currentProductionHostSurface = () => {
    const envelope = boundAgentCapabilityEnvelope(agent as object);
    const revision = boundAgentCapabilityRevision(agent as object);
    if (Boolean(envelope) !== Boolean(revision)) {
      throw new HostCallAuthorityBoundaryError('incomplete_capability_revision');
    }
    if (envelope && revision?.envelopeDigest !== envelope.envelopeDigest) {
      throw new HostCallAuthorityBoundaryError('capability_revision_mismatch');
    }
    if (tools.length > 0 && (!envelope || !revision)) {
      throw new HostCallAuthorityBoundaryError('capability_envelope_missing');
    }
    for (const tool of tools) {
      const capabilities = envelope?.capabilities.filter((entry) => entry.name === tool.name) ?? [];
      if (
        capabilities.length !== 1
        || capabilities[0]!.schemaFingerprint !== toolSchemaFingerprint(tool)
        || !revision?.bound.includes(tool.name)
      ) throw new HostCallAuthorityBoundaryError('model_surface_not_exactly_bound');
    }
    const identity = exactHostIdentity();
    const freshPlan = freshPlanControlConfigured();
    // `plan_task` is intentionally retired from the rebuilt model surface once
    // its exact winner activates expected work. That retirement is not a new
    // call-authority posture: the immutable host root was admitted under the
    // progressive planning catalog and must keep that same root digest across
    // a fresh-process resume. Requiring the process-local tool to still be
    // configured made a completed plan re-arm as an ordinary frozen catalog,
    // poisoning an otherwise byte-identical root before terminal publication.
    // The settled activation winner is durable, source-bound phase authority;
    // neither current tool membership nor prompt reconstruction may replace it.
    const settledPlanControl = settledFreshPlanControl(identity);
    const progressivePlanningRoot = freshPlan || settledPlanControl;
    const planActivated = progressivePlanningRoot && actionExpectedWorkRequired(identity);
    const emptyModelSurface = tools.length === 0;
    // A fresh foreground action begins under a graph-neutral host call root.
    // Catalog discovery is metadata only; freezing here would persist an empty
    // snapshot before plan_task can publish the model-selected manifests. The
    // one settled plan_task activates expected-work and is the sole transition
    // into the durable catalog snapshot used by later business calls.
    const frozen = !emptyModelSurface && (!freshPlan || planActivated)
      ? peekHostCapabilityCatalogFactory()
        ? freezeCatalogSnapshotForSource({
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
          })
        : null
      : null;
    if (frozen && !frozen.ok) {
      throw new HostCallAuthorityBoundaryError(`catalog_snapshot_${frozen.reason}`);
    }
    const snapshot = emptyModelSurface
      ? {
          phase: 'frozen' as const,
          digest: hostSurfaceDigest({ version: 1, entries: [] }),
          entries: [] as readonly RegisteredHostCapability[],
        }
      : freshPlan && !planActivated
      ? {
          phase: 'graph_neutral' as const,
          digest: hostSurfaceDigest({ version: 1, posture: 'foreground_plan_task_graph_neutral' }),
          entries: [] as readonly RegisteredHostCapability[],
        }
      : frozen && frozen.ok
      ? { phase: 'frozen' as const, digest: frozen.digest, entries: frozen.entries }
      : {
          phase: 'frozen' as const,
          digest: hostSurfaceDigest({ version: 1, entries: [] }),
          entries: [] as readonly RegisteredHostCapability[],
        };
    if (productionCatalogSnapshot) {
      const same = productionCatalogSnapshot.phase === snapshot.phase
        && productionCatalogSnapshot.digest === snapshot.digest;
      const exactPlanTransition = productionCatalogSnapshot.phase === 'graph_neutral'
        && snapshot.phase === 'frozen'
        && progressivePlanningRoot
        && planActivated
        && settledPlanControl;
      if (!same && !exactPlanTransition) {
        throw new HostCallAuthorityBoundaryError('catalog_snapshot_changed');
      }
    }
    productionCatalogSnapshot = snapshot;
    // The accepted host root is deliberately graph-neutral and immutable.
    // Exact manifests join only through the post-plan snapshot above; their
    // identity is then re-proved by exactProductionHostCall and the graph/work
    // ledgers. Keeping this root digest stable avoids inventing a second call
    // authority when plan_task phases the model-visible surface.
    const rootCatalogDigest = progressivePlanningRoot
      ? hostSurfaceDigest({ version: 1, posture: 'foreground_plan_task_progressive_catalog' })
      : snapshot.digest;
    const sealedUniverse = envelope?.capabilities
      .map((entry) => ({ ...entry }))
      .sort((left, right) => left.name.localeCompare(right.name)) ?? [];
    return {
      envelope,
      revision,
      snapshot,
      catalogRevisionDigest: hostSurfaceDigest({
        version: 1,
        envelopeDigest: envelope?.envelopeDigest ?? null,
        sealedUniverse,
        frozenCatalogDigest: rootCatalogDigest,
      }),
      bindingRevisionDigest: hostSurfaceDigest({
        version: 1,
        envelopeDigest: envelope?.envelopeDigest ?? null,
        attemptId: envelope?.attemptId ?? identity.sessionId,
        frozenCatalogDigest: rootCatalogDigest,
      }),
    };
  };

  const armExactHostSurface = (): void => {
    if (!hostReadOnlyCanary && !hostProduction) return;
    const identity = exactHostIdentity();
    if (hostProduction) {
      const surface = currentProductionHostSurface();
      const current = acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
      // Production host_v1 owns only fresh chat and its own persisted resume
      // state. A source that already has graph authority belongs to the typed
      // executor. Refuse before arming the host root, model I/O, logical-call
      // admission, or any physical body; never reinterpret that source as a
      // hybrid host-executed graph call.
      if (
        (current.status === 'ok' && current.authority.authorityKind !== 'host_v1')
        || (current.status === 'missing'
          && expectedTaskFor(identity.sessionId, identity.sourceUserSeq).status === 'ok')
      ) {
        throw new HostCallAuthorityBoundaryError('preaccepted_graph_execution_owner');
      }
      const armed = armHostCallAuthority({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        catalogRevisionDigest: surface.catalogRevisionDigest,
        bindingRevisionDigest: surface.bindingRevisionDigest,
        // A recovery runner may intentionally have a smaller process-local
        // ToolCallsCounter (for example the four-call terminal/report-back
        // slice after a twelve-call foreground action). The accepted root's
        // maxima are immutable source authority, not a per-entry allowance.
        // Re-adopt them exactly when the same verified host root already
        // exists; the smaller ambient counter and current concurrency setting
        // continue to constrain this physical entry independently. Replacing
        // the root maxima with the recovery slice poisoned a fully settled
        // task as `host surface changed after admission` before publication.
        maxLogicalCalls: current.status === 'ok'
          && current.authority.authorityKind === 'host_v1'
          ? current.authority.maxLogicalCalls!
          : identity.maxLogicalCalls,
        maxParallelCalls: current.status === 'ok'
          && current.authority.authorityKind === 'host_v1'
          ? current.authority.maxParallelCalls!
          : Math.min(maxToolConcurrency, identity.maxLogicalCalls),
      });
      if (armed.status === 'armed' || armed.status === 'existing') return;
      if (armed.status === 'conflict') {
        poisonExactHostAuthority(
          identity.sessionId,
          identity.sourceUserSeq,
          'host surface changed after admission',
        );
      }
      throw new HostCallAuthorityBoundaryError(`authority_${armed.status}`);
    }
    const surface = currentHostSurfaceRevision();
    const { envelope, revision } = surface;
    if (Boolean(envelope) !== Boolean(revision)) {
      throw new HostCallAuthorityBoundaryError('incomplete_capability_revision');
    }
    if (envelope && revision?.envelopeDigest !== envelope.envelopeDigest) {
      throw new HostCallAuthorityBoundaryError('capability_revision_mismatch');
    }
    const armed = armHostReadOnlyCallAuthority({
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      surfaceVersion: HOST_READ_ONLY_SURFACE_VERSION,
      catalogRevisionDigest: surface.catalogRevisionDigest,
      bindingRevisionDigest: surface.bindingRevisionDigest,
      maxLogicalCalls: identity.maxLogicalCalls,
      maxParallelCalls: Math.min(maxToolConcurrency, identity.maxLogicalCalls),
    });
    if (armed.status === 'armed' || armed.status === 'existing') return;
    if (armed.status === 'conflict') {
      poisonExactHostAuthority(
        identity.sessionId,
        identity.sourceUserSeq,
        'host read-only surface changed after admission',
      );
    }
    throw new HostCallAuthorityBoundaryError(`authority_${armed.status}`);
  };
  const agentModel = (agent as { model?: unknown }).model;
  const modelId = typeof agentModel === 'string' && agentModel.trim() ? agentModel : undefined;
  const resolveModel = agentModel && typeof agentModel === 'object'
    && typeof (agentModel as { getResponse?: unknown }).getResponse === 'function'
    ? () => agentModel as never
    : undefined;
  const modelSettings = ((agent as { modelSettings?: unknown }).modelSettings ?? {}) as never;
  // The owners inject per-call context through callModelInputFilter (the
  // Runner applied it before every model request). The host applies the SAME
  // filter to the SAME shape, so context packets and instruction overlays
  // reach the model unchanged.
  const inputFilter = (opts as {
    callModelInputFilter?: (args: {
      modelData: { input: AgentInputItem[]; instructions?: string };
      agent: Agent<any, any>;
      context: unknown;
    }) => Promise<{ input: AgentInputItem[]; instructions?: string }>
      | { input: AgentInputItem[]; instructions?: string };
  }).callModelInputFilter;
  const resolveInstructions = async (): Promise<string | undefined> => {
    const getSystemPrompt = (agent as {
      getSystemPrompt?: (context: RunContext<unknown>) => Promise<string | undefined> | string | undefined;
    }).getSystemPrompt;
    if (typeof getSystemPrompt === 'function') {
      return await getSystemPrompt.call(agent, runContext);
    }
    const configured = (agent as { instructions?: unknown }).instructions;
    if (typeof configured === 'function') {
      const resolved = await (configured as (
        context: RunContext<unknown>,
        currentAgent: Agent<any, any>,
      ) => Promise<string> | string)(runContext, agent);
      return typeof resolved === 'string' ? resolved : undefined;
    }
    return typeof configured === 'string' ? configured : undefined;
  };

  const runInputGuardrails = async (input: AgentInputItem[]): Promise<void> => {
    const guardrails = (agent as { inputGuardrails?: unknown }).inputGuardrails;
    if (!Array.isArray(guardrails)) return;
    for (const candidate of guardrails) {
      const guardrail = candidate as {
        name?: unknown;
        execute?: (args: {
          agent: Agent<any, any>;
          input: AgentInputItem[];
          context: RunContext<unknown>;
        }) => Promise<{ tripwireTriggered: boolean; outputInfo: unknown }>;
      };
      if (typeof guardrail.execute !== 'function') continue;
      let output: { tripwireTriggered: boolean; outputInfo: unknown };
      try {
        output = await guardrail.execute({ agent, input, context: runContext });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new GuardrailExecutionError(
          `Input guardrail failed to complete: ${cause.message}`,
          cause,
        );
      }
      if (output.tripwireTriggered) {
        throw new InputGuardrailTripwireTriggered(
          `Input guardrail triggered: ${JSON.stringify(output.outputInfo)}`,
          {
            guardrail: { type: 'input', name: String(guardrail.name ?? 'input_guardrail') },
            output,
          },
        );
      }
    }
  };

  const runOutputGuardrails = async (output: string): Promise<string> => {
    const guardrails = (agent as { outputGuardrails?: unknown }).outputGuardrails;
    if (!Array.isArray(guardrails)) return output;
    for (const candidate of guardrails) {
      const guardrail = candidate as {
        name?: unknown;
        execute?: (args: {
          agent: Agent<any, any>;
          agentOutput: string;
          context: RunContext<unknown>;
          details: { output: AgentInputItem[] };
        }) => Promise<{ tripwireTriggered: boolean; outputInfo: unknown }>;
      };
      if (typeof guardrail.execute !== 'function') continue;
      let decision: { tripwireTriggered: boolean; outputInfo: unknown };
      try {
        decision = await guardrail.execute({
          agent,
          agentOutput: output,
          context: runContext,
          details: { output: history },
        });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new GuardrailExecutionError(
          `Output guardrail failed to complete: ${cause.message}`,
          cause,
        );
      }
      if (decision.tripwireTriggered) {
        throw new OutputGuardrailTripwireTriggered(
          `Output guardrail triggered: ${JSON.stringify(decision.outputInfo)}`,
          {
            guardrail: { type: 'output', name: String(guardrail.name ?? 'output_guardrail') },
            agentOutput: output,
            agent,
            output: decision,
          },
        );
      }
    }
    return output;
  };

  const history: AgentInputItem[] = [];
  let pendingFromResume: PendingHostCall[] = [];
  const resumedHostState = itemsOrState instanceof HostInterruptState;
  const resumedRecoveryState = itemsOrState instanceof HostRecoveryState
    ? itemsOrState
    : undefined;
  let resumedResponseId: string | undefined;
  let resumedAcceptedModelBatchRef: AcceptedModelBatchRef | undefined;
  if (resumedHostState) {
    history.push(...itemsOrState.history);
    pendingFromResume = itemsOrState.pending;
    // A pause does not discard what was already accepted.
    resumedResponseId = itemsOrState.lastResponseId;
    resumedAcceptedModelBatchRef = itemsOrState.acceptedModelBatchRef;
  } else if (resumedRecoveryState) {
    history.push(...resumedRecoveryState.history);
    resumedResponseId = resumedRecoveryState.lastResponseId;
    resumedAcceptedModelBatchRef = resumedRecoveryState.acceptedModelBatchRef;
  } else {
    history.push(...(itemsOrState as AgentInputItem[]));
  }
  if (resumedRecoveryState) {
    const identity = exactHostIdentity();
    if (
      !hostProduction
      || resumedRecoveryState.sessionId !== identity.sessionId
      || resumedRecoveryState.sourceUserSeq !== identity.sourceUserSeq
    ) throw new HostCallAuthorityBoundaryError('checkpoint_recovery_source_mismatch');
  }
  const zeroCrossingRefusalCounts = priorZeroCrossingRefusalCounts(history);
  const retiredZeroCrossingFrames = new Set(
    [...zeroCrossingRefusalCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([digest]) => digest),
  );
  // A successful plan_task followed by prose is not a completed host turn.
  // Give the already-bound read carrier one deterministic model step before
  // terminal reduction; a second stop is handled by the delivery hold floor.
  let acceptedReadPlanContinuationUsed = false;
  let acceptedUniqueWorkflowContinuationUsed = false;
  let workflowStepResultContinuationsUsed = 0;
  let continueMarkerContinuationsUsed = 0;
  let pendingHostModelDirective: string | undefined;
  // TRAJECTORY WATCHER state (host_v1). Budgets are the shared watcher-judge
  // constants so this mount cannot outspend the legacy one.
  const hostWatcherEnabled = watcherJudgeEnabled();
  const hostWatcherIntervalTools = watcherCheckIntervalTools();
  const hostWatcherSteer: { pending: WatcherVerdict | null } = { pending: null };
  let hostWatcherChecksUsed = 0;
  let hostWatcherInjectionsUsed = 0;
  let hostWatcherLastCheckedAt = 0;
  let hostWatcherCheckInFlight = false;
  let lastContinueMarkerNote: string | undefined;
  let objectiveJudgeContinuations = 0;
  const resumedNoProgressCheckpoint = itemsOrState instanceof HostInterruptState
    || itemsOrState instanceof HostRecoveryState
    ? itemsOrState.noProgressCheckpoint
    : undefined;
  let noProgressState = resumedNoProgressCheckpoint?.state ?? null;
  let noProgressHistoryCursor = resumedNoProgressCheckpoint?.historyCursor
    ?? history.length;
  let noProgressRecoveryOnly = resumedNoProgressCheckpoint?.recoveryOnly ?? false;
  let noProgressRecoveryDirectiveWritten =
    resumedNoProgressCheckpoint?.recoveryDirectiveWritten ?? false;
  const currentNoProgressCheckpoint = (): HostNoProgressCheckpoint | undefined => (
    noProgressState
      ? {
          state: noProgressState,
          historyCursor: noProgressHistoryCursor,
          recoveryOnly: noProgressRecoveryOnly,
          recoveryDirectiveWritten: noProgressRecoveryDirectiveWritten,
        }
      : undefined
  );

  if (!resumedHostState && !resumedRecoveryState) await runInputGuardrails(history);

  emit('agent_start', runContext, agent);

  // Seeded from the resumed state so a pause/resume — and any block after it —
  // reports the identity this host last ACCEPTED. Only an admitted response
  // may replace it; a rejected one leaves it exactly as it was.
  let lastResponseId: string | undefined = resumedResponseId ?? hostPreviousResponseId;
  let latestAcceptedModelBatchRef = resumedAcceptedModelBatchRef;
  let currentHostStepIndex = resumedRecoveryState?.stepIndex ?? 0;
  const propagateToolCallsLimit = (error: ToolCallsLimitExceeded): never => {
    hostToolCallsLimitCheckpoints.set(error, {
      history: [...history],
      ...(lastResponseId !== undefined ? { lastResponseId } : {}),
    });
    throw error;
  };
  /**
   * GUIDE, NOT GATE — one last-word turn before a resumable harness terminal.
   *
   * A harness-authored terminal means the model was never given a path to
   * completion (live 2026-09-02: two pre-dispatch refusals, then a dead turn,
   * then prose the model never wrote). Before the host ends a turn for a
   * resumable, non-safety reason it hands the reply to the model ONCE, with
   * what it observed and three exits. The next exhaustion is terminal. Safety
   * floors (uncertain external effect, duplicate committed call, write
   * verification) never get this turn: they are the verifiable hard gates.
   */
  let lastWordTurnUsed = false;
  let consecutiveFrameRefusals = 0;
  /** The refusal check behind a RETIRED frame, captured before its
   *  diagnostic-less receipts hide it — so the terminal can still say why. */
  let lastRetiredFrameRefusalDetail: string | undefined;
  const LAST_WORD_EXCLUDED_REASONS: ReadonlySet<string> = new Set([
    'tool_effect_uncertain',
    'model_reused_committed_call_id',
    'write_committed_verification_pending',
    'write_verification_retry_pending',
  ]);
  const journalHostGuide = (kind: string, data: Record<string, unknown>): void => {
    if (!hostProduction) return;
    try {
      const identity = exactHostIdentity();
      appendEvent({
        sessionId: identity.sessionId,
        turn: 0,
        role: 'system',
        type: 'guardrail_tripped',
        data: { kind, sourceUserSeq: identity.sourceUserSeq, ...data },
      });
    } catch { /* telemetry never blocks the turn */ }
  };
  const retainedWorkSummary = (): string => {
    if (!hostProduction) return '';
    try {
      const identity = exactHostIdentity();
      return renderFailureWithRetainedWork({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        fallbackText: '',
      }).trim().slice(0, 1200);
    } catch {
      return '';
    }
  };
  const tryLastWordTurn = (reason: string, observed: readonly string[]): boolean => {
    if (!hostProduction || lastWordTurnUsed || LAST_WORD_EXCLUDED_REASONS.has(reason)) return false;
    lastWordTurnUsed = true;
    const retained = retainedWorkSummary();
    const directive = [
      `HOST CHECKPOINT (${reason}) — the harness will not re-ask again after this. You own the reply now.`,
      observed.length > 0 ? `Observed: ${observed.join(' | ').slice(0, 1500)}` : '',
      retained,
      'Do exactly ONE of: (1) answer the user in plain words with what you already have; (2) ask the user ONE specific question; (3) name the single exact tool call you are blocked on (tool + arguments) and stop.',
      'Do not repeat a refused call unchanged, and do not describe internal errors — speak to the user.',
    ].filter(Boolean).join(' ');
    pendingHostModelDirective = [pendingHostModelDirective, directive].filter(Boolean).join(' ');
    journalHostGuide('last_word_turn', { reason, observed: observed.slice(0, 8) });
    hostTurnLogger.warn({ reason, observed: observed.slice(0, 4) }, 'host handed the reply to the model before a terminal');
    return true;
  };

  const blockedOutcome = (
    text = HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT,
    reason = 'durable_stop_and_explain',
    resumable = true,
  ): RunOutcome => {
    const renderedText = hostProduction
      ? (() => {
          const identity = exactHostIdentity();
          return renderFailureWithRetainedWork({
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
            fallbackText: text,
          });
        })()
      : text;
    emit('agent_end', runContext, agent, renderedText);
    // SAY WHY: the machine reason already travels on `terminal.reason`; the
    // committer must persist it instead of the literal 'blocked'. For a
    // no-progress terminal the reason alone ("exhausted") hides what the host
    // kept refusing, so the last frame's refusal check (or the governor's
    // last consequence stage) rides along as bounded machine detail.
    const blockedDetail = reason === 'control_no_progress_exhausted'
      ? lastHostRefusalDetail(history)
        ?? lastRetiredFrameRefusalDetail
        ?? (noProgressState?.lastConsequence?.stage
          ? boundedBlockedDetail(noProgressState.lastConsequence.stage)
          : undefined)
      : reason === 'continue_marker_exhausted' && lastContinueMarkerNote
        ? boundedBlockedDetail(lastContinueMarkerNote)
        : undefined;
    // Never silent by construction: every blocked terminal names its reason
    // in the process log (live 2026-09-02: a stalled turn ended with no line).
    hostTurnLogger.warn({ reason, resumable, ...(blockedDetail ? { blockedDetail } : {}) }, 'host blocked terminal');
    const outcome: HostRunOutcome = {
      history,
      lastResponseId,
      finalOutput: renderedText,
      terminal: {
        status: 'blocked',
        reason,
        ...(resumable ? {} : { resumable: false as const }),
      },
      ...(blockedDetail ? { blockedDetail } : {}),
    };
    return outcome;
  };

  /** The request this turn is judged against: the accepted source event's
   * text, else the last user message of the initial input. */
  const judgedObjective = (): string => {
    try {
      const identity = exactHostIdentity();
      const accepted = listEvents(identity.sessionId, {
        sinceSeq: identity.sourceUserSeq - 1,
        types: ['user_input_received'],
        limit: 1,
      }).find((event) => event.seq === identity.sourceUserSeq);
      const display = typeof accepted?.data.displayText === 'string' ? accepted.data.displayText : '';
      const text = display.trim() ? display : (typeof accepted?.data.text === 'string' ? accepted.data.text : '');
      if (text.trim()) return text;
    } catch { /* fall through to the initial input */ }
    if (!Array.isArray(itemsOrState)) return '';
    for (let index = itemsOrState.length - 1; index >= 0; index -= 1) {
      const item = itemsOrState[index] as { role?: unknown; content?: unknown };
      if (item.role !== 'user') continue;
      if (typeof item.content === 'string' && item.content.trim()) return item.content;
      if (Array.isArray(item.content)) {
        const text = item.content
          .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''))
          .join('\n')
          .trim();
        if (text) return text;
      }
    }
    return '';
  };

  /** Run the completion judge on a final reply. 'continue' means the judge
   * asked for more work and the directive is armed; 'done' means deliver. */
  const judgeHostCompletion = async (
    replyText: string,
    frameHistory: readonly AgentInputItem[],
    responseId: string | undefined,
  ): Promise<'continue' | 'done'> => {
    const objective = judgedObjective();
    if (!objective.trim()) return 'done';
    const identity = exactHostIdentity();
    const decision = toOrchestratorDecision(replyText);
    const businessCalls = history.filter((item) => {
      const row = item as { type?: unknown; name?: unknown };
      return row.type === 'function_call' && !HOST_JUDGE_CONTROL_TOOL_NAMES.has(String(row.name ?? ''));
    });
    let openApprovalCard = false;
    try { openApprovalCard = approvalRegistry.listPending({ sessionId: identity.sessionId }).length > 0; } catch { /* no card */ }
    // Same gate as the legacy core: a completion claim with NO business tool
    // evidence, a promise-shaped reply, or a compound ask that one tool cannot
    // certify — settled tool results are their own evidence otherwise.
    const gate = shouldRunObjectiveJudge({
      optIn: true,
      actionIntent: classifyMessageIntent(objective).intent === 'action',
      meaningfulToolEvidence: businessCalls.length > 0,
      multiResultObjective: objectiveMayRequireMultipleResults(objective),
      acceptedExecutionEvidence: false,
      continuationsUsed: objectiveJudgeContinuations,
      maxContinuations: MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS,
      // A plain reply with no marker or envelope IS the done shape
      // (turn-decision.ts returns null for it); ASK: keeps its own reading.
      nextAction: decision?.nextAction ?? 'completed',
      promiseShaped: isPromiseShapedReply(decision?.reply ?? replyText),
      openApprovalCard,
    });
    if (!gate) return 'done';
    const judgedReply = decision?.reply?.trim() ? decision.reply : replyText;
    let verdict: ObjectiveJudgeVerdict;
    try {
      verdict = await hostObjectiveJudge(objective, judgedReply, {
        skills: gatherSessionSkills(identity.sessionId),
        toolCallSummary: summarizeToolCallsForJudge(identity.sessionId),
      });
    } catch (error) {
      verdict = {
        done: true,
        reason: `judge threw — accepting completion: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
        failedOpen: true,
      };
    }
    const continuation = !verdict.done && !verdict.awaitingUser;
    try {
      appendEvent({
        sessionId: identity.sessionId,
        turn: 0,
        role: 'system',
        type: 'goal_alignment_judged',
        data: {
          lane: 'host_v1',
          kind: 'completion',
          fulfills: verdict.done,
          reason: verdict.reason.slice(0, 600),
          ...(verdict.failedOpen ? { failedOpen: true } : {}),
          ...(verdict.selfJudge ? { selfJudge: true } : {}),
          ...(verdict.awaitingUser ? { awaitingUser: true } : {}),
          continuation,
          continuationsUsed: objectiveJudgeContinuations,
        },
      });
    } catch { /* telemetry never blocks the reply */ }
    hostTurnLogger.info({
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      done: verdict.done,
      failedOpen: verdict.failedOpen === true,
      selfJudge: verdict.selfJudge === true,
      continuation,
      reason: verdict.reason.slice(0, 200),
    }, 'host completion judge');
    if (!continuation) return 'done';
    objectiveJudgeContinuations += 1;
    // The reply stays in history (the model must see what it claimed); the
    // judge's gaps ride the one-shot directive, never canonical history.
    history.push(...frameHistory);
    if (responseId !== undefined) lastResponseId = responseId;
    pendingHostModelDirective = [
      `COMPLETION JUDGE (an independent check of your last reply against the original request) says NOT DONE: ${verdict.reason.slice(0, 400)}`,
      'Close these specific gaps now with tool calls and verifiable evidence, then give the final result.',
      'If a part is genuinely impossible, say so with the concrete blocker instead of declaring done without it.',
    ].join(' ');
    return 'continue';
  };

  /**
   * Spend one unit of the exact-checkpoint retry budget for this frame, and
   * say whether it is now exhausted.
   *
   * Every entry point that can re-enter a held checkpoint converges here: the
   * 15 s scanner, this runner's own immediate re-entry in loop.ts, and the
   * legacy approval-resume admission. Counting a caller's DISPATCH instead of
   * the failed attempt bounded only the scanner and left the other two looping
   * (live 09-01/09-02: 1,054, 1,006 and 454 re-entries under a budget of 5).
   * The key is the scanner's key exactly — same session, source, phase and
   * frame call ids — so both owners spend one shared count.
   */
  const spendCheckpointRetryBudget = (
    frameHistory: readonly AgentInputItem[],
    phase: 'admit' | 'finalize',
  ): { count: number; exhausted: boolean } => {
    try {
      const identity = exactHostIdentity();
      return noteExactCheckpointReentry(exactCheckpointReentryKey(identity.sessionId, {
        sourceUserSeq: identity.sourceUserSeq,
        phase,
        frameCallIds: exactCheckpointFrameCallIds(frameHistory),
      }));
    } catch {
      // No exact identity means no durable checkpoint to loop on. Never let
      // the bookkeeping itself decide a terminal.
      return { count: 0, exhausted: false };
    }
  };

  const recoveryOutcome = (input: {
    phase: Exclude<HostRecoveryPhase, 'continue'>;
    baseHistory: AgentInputItem[];
    frameHistory: readonly AgentInputItem[];
    resultItems?: readonly AgentInputItem[];
    responseId?: string;
    acceptedModelBatchRef?: AcceptedModelBatchRef;
    stepIndexOverride?: number;
    reason: string;
    /** Set false ONLY for a hold that is pending BY DESIGN and advances on its
     * own durable cursor (a paging async read re-enters the same key while
     * genuinely progressing). Every other hold is a failed retry and is
     * bounded: defaulting to bounded means a new failure reason added later
     * cannot silently reintroduce an unbounded loop. */
    boundedRetry?: boolean;
  }): RunOutcome => {
    const identity = exactHostIdentity();
    if (input.phase === 'finalize' && !input.acceptedModelBatchRef) {
      throw new HostCallAuthorityBoundaryError('checkpoint_recovery_batch_ref_missing');
    }
    // A hold invites the next caller back for this exact frame. When the
    // underlying state can never advance the invitation never converges, so
    // past the shared budget this becomes a typed terminal instead: a blocked
    // outcome carries no serializedRecoveryState, and loop.ts re-enters only
    // `outcome.hold && outcome.serializedRecoveryState`.
    if (input.boundedRetry !== false) {
      const spend = spendCheckpointRetryBudget(input.frameHistory, input.phase);
      if (spend.exhausted) {
        hostTurnLogger.error({
          reason: input.reason,
          phase: input.phase,
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          attempt: spend.count,
          budget: EXACT_CHECKPOINT_REENTRY_BUDGET,
        }, 'exact checkpoint retry budget spent; stopping with a typed terminal');
        return blockedOutcome(
          HOST_CHECKPOINT_ADMISSION_EXHAUSTED_BLOCKED_TEXT,
          'exact_checkpoint_admission_exhausted',
        );
      }
    }
    const state = new HostRecoveryState(
      identity.sessionId,
      identity.sourceUserSeq,
      input.phase,
      [...input.baseHistory],
      [...input.frameHistory],
      [...(input.resultItems ?? [])],
      lastResponseId,
      input.responseId,
      hostTurnEngine ?? 'host_v1',
      currentNoProgressCheckpoint(),
      input.stepIndexOverride
        ?? (input.phase === 'finalize' ? currentHostStepIndex + 1 : currentHostStepIndex),
      input.acceptedModelBatchRef,
    );
    hostTurnLogger.error({
      reason: input.reason,
      phase: input.phase,
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      batchOrdinal: input.acceptedModelBatchRef?.batchOrdinal ?? null,
    }, 'host retained exact checkpoint recovery ownership');
    return {
      history: [...input.baseHistory],
      lastResponseId,
      finalOutput: undefined,
      hold: { owner: 'host', wake: 'recovery', reason: 'recovery_pending' },
      serializedRecoveryState: state.toString(),
    } satisfies RunOutcome;
  };

  const recoveryContinuationOutcome = (
    ref: AcceptedModelBatchRef | undefined,
    reason: string,
  ): RunOutcome => {
    if (!ref) {
      throw new HostCallAuthorityBoundaryError('checkpoint_recovery_batch_ref_missing');
    }
    const identity = exactHostIdentity();
    const state = new HostRecoveryState(
      identity.sessionId,
      identity.sourceUserSeq,
      'continue',
      [...history],
      [],
      [],
      lastResponseId,
      undefined,
      hostTurnEngine ?? 'host_v1',
      currentNoProgressCheckpoint(),
      currentHostStepIndex + 1,
      ref,
    );
    hostTurnLogger.info({
      reason,
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      batchOrdinal: ref.batchOrdinal,
    }, 'host checkpoint recovery is ready for ordinary same-source continuation');
    return {
      history: [...history],
      lastResponseId,
      finalOutput: undefined,
      hold: { owner: 'host', wake: 'recovery', reason: 'recovery_pending' },
      serializedRecoveryState: state.toString(),
    } satisfies RunOutcome;
  };

  const committedVerificationHoldOutcome = (
    holds: readonly CommittedMutationVerificationHold[],
    ref: AcceptedModelBatchRef | undefined,
  ): RunOutcome => {
    if (
      holds.length > 0
      && holds.every((hold) => hold.recoveryKind === 'automatic' && hold.verifierOnlyRetryable)
      && ref
    ) {
      // The result frame is already checkpointed. Retain a daemon-wakeable host
      // continuation so the next generation runs only the remaining readback;
      // no user retry or fresh model-authored write is required.
      return recoveryContinuationOutcome(ref, 'write_verification_retry_pending');
    }
    return blockedOutcome(
      committedWriteVerificationHeldText(holds),
      'write_committed_verification_pending',
    );
  };

  const approvalRecoveryOutcome = (
    reason: string,
    ref: AcceptedModelBatchRef | undefined = resumedAcceptedModelBatchRef,
  ): RunOutcome => {
    hostTurnLogger.error({ reason }, 'host retained paused approval during local checkpoint recovery');
    return {
      history,
      lastResponseId,
      finalOutput: undefined,
      hold: { owner: 'host', wake: 'recovery', reason: 'recovery_pending' },
      // This is the same already-existing approval state, not a newly minted
      // card. The owner persists it without emitting approval_requested.
      serializedState: new HostInterruptState(
        history,
        pendingFromResume,
        lastResponseId,
        hostTurnEngine ?? 'host_v1_read_only',
        currentNoProgressCheckpoint(),
        ref,
      ).toString(),
    } satisfies RunOutcome;
  };

  const completedOutcome = async (text: string): Promise<RunOutcome> => {
    const guarded = await runOutputGuardrails(text);
    emit('agent_end', runContext, agent, guarded);
    return {
      history,
      lastResponseId,
      finalOutput: guarded,
    } satisfies RunOutcome;
  };

  let resumedToolSurfaceUnavailable = false;
  if (resumedHostState) {
    try {
      await refreshTools();
    } catch {
      // A resumed approval has not entered any pending call yet. Pair the
      // admitted frame below after the common disposition helpers exist.
      resumedToolSurfaceUnavailable = true;
    }
  }

  const runOneModelStep = async (
    modelInput: AgentInputItem[],
    instructions: string | undefined,
    modelSchemas: readonly unknown[] = schemas,
  ): Promise<Awaited<ReturnType<typeof codexOneStep>>> => {
    const ambient = harnessRunContextStorage.getStore();
    const killTarget = ambient?.runAttemptId
      ? { attemptId: ambient.runAttemptId, sourceUserSeq: ambient.sourceUserSeq }
      : ambient?.sourceUserSeq
        ? { sourceUserSeq: ambient.sourceUserSeq }
        : undefined;
    if (ambient?.sessionId && isKillRequested(ambient.sessionId, killTarget)) {
      throw new KillRequested(ambient.sessionId);
    }

    const controller = new AbortController();
    const callerAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(signal?.reason);
    };
    if (signal?.aborted) callerAbort();
    else signal?.addEventListener('abort', callerAbort, { once: true });
    // The USER's own stop authority for this step: the caller signal plus the
    // kill latch. The watchdog's deadline abort below is NOT this — it retires
    // one attempt so the fallback boundary can rescue the step on another
    // brain, and that rescue stays cancellable by the person through here.
    const cancelAuthority = new AbortController();
    const cancelAuthorityFromCaller = (): void => {
      if (!cancelAuthority.signal.aborted) cancelAuthority.abort(signal?.reason);
    };
    if (signal?.aborted) cancelAuthorityFromCaller();
    else signal?.addEventListener('abort', cancelAuthorityFromCaller, { once: true });
    if (ambient) {
      ambient.callerCancelSignal = cancelAuthority.signal;
      ambient.modelFalloverInFlightAt = 0;
    }

    let stallTimer: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setInterval> | undefined;
    let rejectCallerAbort: (() => void) | undefined;
    const streamMs = modelStreamStallMs();
    // Sized to the prompt: a 100k-token prefill is not a hang (model-stall-policy.ts).
    const firstByteMs = sizedFirstByteStallMs(modelInput);
    const falloverGraceMs = modelStallFalloverGraceMs();
    // How long the host waits after retiring an attempt for the fallback
    // boundary to stamp that a rescue started. No stamp ⇒ nothing to wait for.
    const FALLOVER_SWITCH_DETECT_MS = 5_000;
    let lastSemanticActivityAt = Date.now();
    let sawActionableActivity = false;
    let escalatedAt = 0;
    let escalatedError: ModelStreamStalledError | undefined;
    const stall = new Promise<never>((_, reject) => {
      if (streamMs <= 0) return;
      const preContentMs = firstByteMs > 0 ? firstByteMs : streamMs;
      const tickMs = Math.min(15_000, Math.max(10, Math.floor(Math.min(preContentMs, streamMs) / 4)));
      stallTimer = setInterval(() => {
        const activeBufferedProviderRequests = [
          ...(ambient?.bufferedProviderRequests ?? []),
        ].filter((request) => request.active);
        const bufferedProviderRequestInFlight = !sawActionableActivity
          && activeBufferedProviderRequests.length > 0;
        const oldestBufferedProviderRequestAt = bufferedProviderRequestInFlight
          ? Math.min(...activeBufferedProviderRequests.map((request) => request.startedAt))
          : 0;
        const privateActivityAt = ambient?.privateModelActivityAt ?? 0;
        const observedActivityAt = Math.max(
          lastSemanticActivityAt,
          privateActivityAt,
          oldestBufferedProviderRequestAt,
        );
        const windowMs = sawActionableActivity || bufferedProviderRequestInFlight
          ? streamMs
          : preContentMs;
        if (escalatedAt === 0) {
          if (Date.now() - observedActivityAt < windowMs) return;
          // ESCALATE, do not reject: abort the stalled attempt with a typed
          // deadline reason so the fallback boundary can switch brains, then
          // keep this step alive while a rescue is in flight. Rejecting in the
          // same tick as the abort orphaned every rescue (live 2026-09-02: an
          // 11-minute silent turn with two healthy brains never consulted).
          const error = new ModelStreamStalledError(
            Math.max(1, Math.round(windowMs / 1000)),
            !sawActionableActivity,
            bufferedProviderRequestInFlight,
          );
          escalatedError = error;
          escalatedAt = Date.now();
          hostTurnLogger.error({
            seconds: error.seconds,
            preContent: error.preContent,
            bufferedProviderRequestInFlight,
            falloverGraceMs,
          }, 'host model step stalled — retiring the attempt so the brain chain can rescue it');
          if (!controller.signal.aborted) controller.abort(error);
          if (falloverGraceMs <= 0) reject(error);
          return;
        }
        const switched = (ambient?.modelFalloverInFlightAt ?? 0) > escalatedAt;
        if (!switched) {
          if (Date.now() - escalatedAt > FALLOVER_SWITCH_DETECT_MS) {
            hostTurnLogger.error({ seconds: escalatedError?.seconds }, 'no rescue brain took the stalled model step');
            reject(escalatedError!);
          }
          return;
        }
        // A rescue is streaming: its activity refreshes the clock. Only its
        // own silence, past the grace, ends the step.
        if (Date.now() - Math.max(observedActivityAt, escalatedAt) < falloverGraceMs) return;
        hostTurnLogger.error({ falloverGraceMs }, 'rescue brain stalled after the watchdog retired the first attempt');
        reject(escalatedError!);
      }, tickMs);
    });
    const killed = new Promise<never>((_, reject) => {
      if (!ambient?.sessionId) return;
      killTimer = setInterval(() => {
        try {
          if (!isKillRequested(ambient.sessionId, killTarget)) return;
          const error = new KillRequested(ambient.sessionId);
          if (!controller.signal.aborted) controller.abort(error);
          if (!cancelAuthority.signal.aborted) cancelAuthority.abort(error);
          reject(error);
        } catch {
          // The kill poll is best-effort; the exact lease remains the hard
          // late-dispatch fence if storage is temporarily unreadable.
        }
      }, 250);
    });
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      const rejectAbort = (): void => {
        const reason = signal.reason;
        reject(reason instanceof KillRequested
          ? reason
          : new KillRequested(ambient?.sessionId ?? 'unknown'));
      };
      rejectCallerAbort = rejectAbort;
      if (signal.aborted) rejectAbort();
      else signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const hostProjection = canonicalPromptCacheRequest({
      ...(instructions !== undefined ? { systemInstructions: instructions } : {}),
      input: modelInput,
      modelSettings,
      tools: modelSchemas as never,
      toolsExplicitlyProvided: true,
      outputType: 'text',
      handoffs: [],
      tracing: false,
    });
    try {
      return await Promise.race([
        codexOneStep({
          input: modelInput,
          tools: modelSchemas as never,
          ...(modelId !== undefined ? { modelId } : {}),
          ...(resolveModel ? { resolveModel } : {}),
          ...(instructions !== undefined ? { systemInstructions: instructions } : {}),
          modelSettings,
          signal: controller.signal,
          stream: true,
          ...(hostProduction
            ? {
                beforeModelDispatch: (request: ModelRequest) => {
                  const identity = exactHostIdentity();
                  const provenance = recordModelRequestDispatchProvenance({
                    sessionId: identity.sessionId,
                    sourceUserSeq: identity.sourceUserSeq,
                    request,
                    hostProjection,
                  });
                  if (provenance.removedOptionalLayer) {
                    console.warn(
                      '[clem] model_request_optional_layer_removed:',
                      provenance.removedOptionalLayer,
                    );
                  }
                },
              }
            : {}),
          onActivity: (activity) => {
            lastSemanticActivityAt = Date.now();
            if (activity === 'actionable') sawActionableActivity = true;
          },
        }),
        stall,
        killed,
        aborted,
      ]);
    } finally {
      if (stallTimer) clearInterval(stallTimer);
      if (killTimer) clearInterval(killTimer);
      signal?.removeEventListener('abort', callerAbort);
      signal?.removeEventListener('abort', cancelAuthorityFromCaller);
      if (rejectCallerAbort) signal?.removeEventListener('abort', rejectCallerAbort);
    }
  };

  const exactHostReadOnlyCallAttestation = (
    name: string,
    args: Record<string, unknown> | null,
    tool: FunctionToolLike | undefined,
    logicalToolCallId: string,
  ): HostReadOnlyCallAttestation | null => {
    if (!hostReadOnlyCanary || !args || !tool) return null;
    if (
      !harnessToolBracketsEnabled()
      || !configuredToolRefs.has(tool)
      || !isHarnessBoundFunctionTool(tool)
      || tool.name !== name
      || logicalToolCallId !== logicalToolCallId.trim()
      || !logicalToolCallId
      || logicalToolCallId.length > 512
    ) return null;
    const identity = exactHostIdentity();
    const surface = currentHostSurfaceRevision();
    const { envelope, revision } = surface;
    const capabilities = envelope?.capabilities.filter((entry) => entry.name === name) ?? [];
    const decision = classifyRuntimeToolEffect(name, args);
    const root = acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
    const acceptedTaskId = acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq);
    const contract = durableLogicalCallContract(acceptedTaskId, name, args);
    if (
      !envelope
      || !revision
      || envelope.attemptId !== identity.sessionId
      || revision.envelopeDigest !== envelope.envelopeDigest
      || !revision.bound.includes(name)
      || capabilities.length !== 1
      || capabilities[0]!.accountIdentity !== ''
      || capabilities[0]!.effectClass !== 'read'
      || capabilities[0]!.schemaFingerprint !== toolSchemaFingerprint(tool)
      || decision.effect !== 'read'
      || decision.source !== 'registry'
      || hostReadOnlyExecutionContractFor(name) !== 'pure_local'
      || root.status !== 'ok'
      || root.authority.authorityKind !== 'host_v1_read_only'
      || root.authority.state !== 'open'
      || root.authority.identity.acceptedTaskId !== acceptedTaskId
      || root.authority.surfaceVersion !== HOST_READ_ONLY_SURFACE_VERSION
      || root.authority.catalogRevisionDigest !== surface.catalogRevisionDigest
      || root.authority.bindingRevisionDigest !== surface.bindingRevisionDigest
      || !contract
    ) return null;
    return {
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      acceptedTaskId,
      sourceEventId: root.authority.sourceEventId,
      sourceEventDigest: root.authority.sourceEventDigest,
      logicalToolCallId,
      toolName: contract.toolName,
      argumentDigest: contract.argumentDigest,
      engineVersion: root.authority.engineVersion,
      surfaceVersion: root.authority.surfaceVersion,
      authorityDigest: root.authority.authorityDigest,
      authorityRevision: root.authority.revision,
      surfaceDigest: root.authority.surfaceDigest,
      catalogRevisionDigest: surface.catalogRevisionDigest,
      bindingRevisionDigest: surface.bindingRevisionDigest,
    };
  };

  /**
   * READ-FAST-PATH descent (2026-08-26 gauntlet, hole 12): a read-effect
   * provider call whose exact operation this turn already PROVED (the
   * capability_resolution proof ledger: status proven, live connection) gets
   * a cheap shape check — schema + connection + host effect classification,
   * all already computed at this boundary — and dispatches through its
   * carrier. The frozen-manifest membership proof is the WRITE bar, not the
   * read bar: demanding it for reads made the model unable to even LOOK at
   * the target it must plan against (GOOGLEDRIVE_FIND_FILE, effect 'read',
   * refused live at this exact wall). Writes keep the full wall unchanged.
   */
  interface LiveReadDiscoveryNomination {
    manifestDigest: string;
    accountIdentity: string;
    providerKind: string;
    providerInputSchemaDigest: string;
    definitionFingerprint: string;
    providerOperationVersion: string;
    providerOutputSchemaDigest: string | null;
    invokePortId: string;
  }

  const provenTurnReadDescent = (
    name: string,
    args: Record<string, unknown> | null,
    tool?: FunctionToolLike,
  ): {
    effectiveName: string;
    capabilityId: string;
    accountIdentity?: string;
    liveReadDiscovery?: LiveReadDiscoveryNomination;
    planningManifestDigest?: string;
  } | null => {
    if (!hostProduction || !args) return null;
    const effectiveName = unwrapRuntimeEffectiveToolIdentity(name, args).toolName?.trim() ?? '';
    if (!effectiveName) return null;
    try {
      const identity = exactHostIdentity();
      const entries = provenCapabilityEntriesForTurn({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
      });
      const proven = entries.find((entry) => entry.effectClass === 'read'
        && catalogOperationIdentitiesEqual(entry.identifier, effectiveName));
      if (proven) {
        return {
          effectiveName,
          capabilityId: canonicalResolvedCapabilityId(
            proven.identifier.trim().toLowerCase(),
            proven.accountIdentity,
          ),
          ...(proven.accountIdentity ? { accountIdentity: proven.accountIdentity } : {}),
        };
      }

      // Provider-neutral live-read acquisition records its exact same-turn
      // registry nomination as capability_discovered rather than fabricating
      // a provider-shaped capability_resolution row. Accept only one
      // self-consistent opaque ref from this accepted source. The caller below
      // must still reopen that exact current catalog entry and match its
      // manifest, effect, account, definition, schema and immutable invoke
      // port before dispatch.
      const discovered = new Map<string, LiveReadDiscoveryNomination>();
      let conflictingDiscovery = false;
      for (const event of listEvents(identity.sessionId, { types: ['capability_discovered'] })) {
        if (event.data.sourceUserSeq !== identity.sourceUserSeq) continue;
        const rows = Array.isArray(event.data.capabilities) ? event.data.capabilities : [];
        for (const raw of rows) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const row = raw as Record<string, unknown>;
          const descriptor = row.descriptor;
          const providerDefinition = row.providerDefinition;
          const definition = providerDefinition as Record<string, unknown> | null;
          const providerOutputSchemaDigest = definition?.providerOutputSchemaDigest;
          if (
            row.kind !== AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE
            || typeof row.providerKind !== 'string'
            || !row.providerKind.trim()
            || row.effectClass !== 'read'
            || typeof row.identifier !== 'string'
            || !catalogOperationIdentitiesEqual(row.identifier, effectiveName)
            || typeof row.capabilityRef !== 'string'
            || !row.capabilityRef.trim()
            || typeof row.manifestDigest !== 'string'
            || !/^[a-f0-9]{64}$/.test(row.manifestDigest)
            || typeof row.accountIdentity !== 'string'
            || !row.accountIdentity.trim()
            || !descriptor
            || typeof descriptor !== 'object'
            || Array.isArray(descriptor)
            || (descriptor as Record<string, unknown>).id !== row.capabilityRef
            || (descriptor as Record<string, unknown>).effect !== 'read'
            || (descriptor as Record<string, unknown>).manifestDigest !== row.manifestDigest
            || (descriptor as Record<string, unknown>).accountScope !== row.accountIdentity
            || !providerDefinition
            || typeof providerDefinition !== 'object'
            || Array.isArray(providerDefinition)
            || (providerDefinition as Record<string, unknown>).version !== 1
            || typeof (providerDefinition as Record<string, unknown>).providerInputSchemaDigest !== 'string'
            || !/^[a-f0-9]{64}$/.test(
              (providerDefinition as Record<string, unknown>).providerInputSchemaDigest as string,
            )
            || typeof (providerDefinition as Record<string, unknown>).definitionFingerprint !== 'string'
            || !/^[a-f0-9]{64}$/.test(
              (providerDefinition as Record<string, unknown>).definitionFingerprint as string,
            )
            || typeof (providerDefinition as Record<string, unknown>).providerOperationVersion !== 'string'
            || !((providerDefinition as Record<string, unknown>).providerOperationVersion as string).trim()
            || (providerOutputSchemaDigest !== null
              && (
                typeof providerOutputSchemaDigest !== 'string'
                || !/^[a-f0-9]{64}$/.test(providerOutputSchemaDigest)
              ))
            || typeof (providerDefinition as Record<string, unknown>).invokePortId !== 'string'
            || !((providerDefinition as Record<string, unknown>).invokePortId as string).trim()
          ) continue;
          const nomination: LiveReadDiscoveryNomination = {
            manifestDigest: row.manifestDigest,
            accountIdentity: row.accountIdentity,
            providerKind: row.providerKind,
            providerInputSchemaDigest:
              (providerDefinition as Record<string, unknown>).providerInputSchemaDigest as string,
            definitionFingerprint:
              (providerDefinition as Record<string, unknown>).definitionFingerprint as string,
            providerOperationVersion:
              (providerDefinition as Record<string, unknown>).providerOperationVersion as string,
            providerOutputSchemaDigest: providerOutputSchemaDigest as string | null,
            invokePortId: (providerDefinition as Record<string, unknown>).invokePortId as string,
          };
          const prior = discovered.get(row.capabilityRef);
          if (prior && JSON.stringify(prior) !== JSON.stringify(nomination)) {
            conflictingDiscovery = true;
            continue;
          }
          discovered.set(row.capabilityRef, nomination);
        }
      }
      if (conflictingDiscovery || discovered.size > 1) return null;
      if (discovered.size === 1) {
        const [capabilityId, liveReadDiscovery] = [...discovered.entries()][0]!;
        return {
          effectiveName,
          capabilityId,
          accountIdentity: liveReadDiscovery.accountIdentity,
          liveReadDiscovery,
        };
      }

      // Cross-turn warm reads have no same-source discovery row by design:
      // the exact current manifest is instead revalidated onto this source's
      // opaque bounded foreground planning card. Only the exact configured
      // work_call object can reopen that nomination. Final authority remains
      // below, where the catalog entry and every manifest identity field are
      // checked again before dispatch.
      const planning = resolveHostPlanningReadCapability(tool, {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        operationId: effectiveName,
      });
      return planning
        ? {
            effectiveName,
            capabilityId: planning.capabilityId,
            planningManifestDigest: planning.manifestDigest,
          }
        : null;
    } catch {
      return null;
    }
  };

  interface ExactProductionHostCall {
    attestation: HostCallAttestation;
    manifest?: CapabilityManifestV1;
    effect: Exclude<RuntimeToolEffect, 'unknown'>;
    boundary: 'nested_owned' | 'host_owned_local' | 'host_owned_external';
    logicalToolName: string;
    logicalArgs: Record<string, unknown>;
    sourceCapability?: PhysicalSourceCapabilityIdentityV1;
    sourcePurpose?: MaterialSourceManifestPurpose;
    trustedEffectCarrier?: TrustedRuntimeEffectCarrier;
    validateBeforeConsent?: () => InvalidArgumentsPreDispatchResult | null;
    prepareBeforePhysical?: () => Promise<void | InvalidArgumentsPreDispatchResult>;
    invoke: (signal: AbortSignal) => Promise<unknown>;
  }

  /** The exact operation id when the current accepted-source catalog scope
   * (a workflow step's literal operation ids) names it; null otherwise. */
  const acceptedSourceLiteralOperation = (operationName: string): string | null => {
    const scope = currentAcceptedSourceCatalogManifestScope();
    if (!scope) return null;
    const operationId = operationName.trim().toUpperCase();
    return operationId && scope.operationIds.has(operationId) ? operationId : null;
  };

  let lastExactProductionMiss = '';
  // ONE effect decision per call. The frame decides each call's effect once
  // (the proven read wins over the spelling classifier, host-model-frame
  // materialization below) and every later checkpoint — scheduling,
  // admission, approval arming — reads that decision instead of
  // re-classifying. Census 2026-09-01: one read was classified six times and
  // the proven read won at only two of them, so a read the classifier called
  // a write still serialized as a barrier and armed consent as 'unknown'.
  let currentFrameEffects = new Map<string, RuntimeToolEffect>();
  // One JIT read-provisioning attempt per carried operation per turn.
  const jitReadProvisionAttempted = new Set<string>();
  const exactProductionHostCall = (
    name: string,
    args: Record<string, unknown> | null,
    argumentsJson: string,
    tool: FunctionToolLike | undefined,
    logicalToolCallId: string,
    runContextForCall: RunContext<unknown>,
    details: unknown,
  ): ExactProductionHostCall | null => {
    const miss = (reason: string): null => {
      lastExactProductionMiss = reason;
      return null;
    };
    lastExactProductionMiss = '';
    if (!hostProduction || !args || !tool) return miss('host_or_args_or_tool_missing');
    // A trusted provider carrier can contain an exact local read/control name
    // when a model confuses adjacent discovery surfaces. Preserve the original
    // accepted logical contract, but execute it through the already-sealed
    // local surface. Direct active controls stay direct; deferred controls use
    // the configured acquisition carrier, whose own scope/schema checks remain
    // authoritative. No unknown, business, or mutating inner name enters here.
    const carriedLocalControl = resolveProviderCarrierLocalReadControl(name, args);
    if (carriedLocalControl) {
      const directTool = toolByName.get(carriedLocalControl.toolName);
      const acquisitionTool = toolByName.get('call_tool');
      const routedName = directTool ? carriedLocalControl.toolName : 'call_tool';
      const routedTool = directTool ?? acquisitionTool;
      if (!routedTool) return miss('provider_carried_local_control_route_missing');
      const routedArgs = directTool
        ? carriedLocalControl.args
        : {
            name: carriedLocalControl.toolName,
            args_json: JSON.stringify(carriedLocalControl.args),
          };
      const routedArgumentsJson = JSON.stringify(routedArgs);
      const routedDetails = {
        ...(details && typeof details === 'object'
          ? details as Record<string, unknown>
          : {}),
        toolCall: {
          type: 'function_call' as const,
          callId: logicalToolCallId,
          name: routedName,
          arguments: routedArgumentsJson,
        },
      };
      return exactProductionHostCall(
        routedName,
        routedArgs,
        routedArgumentsJson,
        routedTool,
        logicalToolCallId,
        runContextForCall,
        routedDetails,
      );
    }
    if (
      !harnessToolBracketsEnabled()
      || tool.name !== name
      || logicalToolCallId !== logicalToolCallId.trim()
      || !logicalToolCallId
      || logicalToolCallId.length > 512
    ) return miss('harness_bound_identity_mismatch');
    // Carrier provenance: the wrapToolForHarness-attested configured object is
    // the ordinary bar. A read-effect call whose exact operation this turn
    // proved may descend without it (read-fast-path); every mutation keeps the
    // attested-carrier requirement.
    const attestedCarrier = configuredToolRefs.has(tool) && isHarnessBoundFunctionTool(tool);
    const readDescent = provenTurnReadDescent(name, args, tool);
    if (!attestedCarrier && !readDescent) return miss('attested_carrier_and_proven_read_descent_missing');
    const identity = exactHostIdentity();
    const surface = currentProductionHostSurface();
    const envelope = surface.envelope;
    const revision = surface.revision;
    const capability = envelope?.capabilities.filter((entry) => entry.name === name) ?? [];
    const decision = classifyRuntimeToolEffect(name, args);
    const effective = unwrapRuntimeEffectiveToolIdentity(name, args);
    const effectiveName = effective.toolName?.trim() ?? '';
    const root = acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
    const acceptedTaskId = acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq);
    const contract = durableLogicalCallContract(acceptedTaskId, name, args);
    const exactHostRoot = root.status === 'ok'
      && root.authority.authorityKind === 'host_v1'
      && root.authority.surfaceVersion === HOST_CALL_AUTHORITY_SURFACE_VERSION
      && root.authority.catalogRevisionDigest === surface.catalogRevisionDigest
      && root.authority.bindingRevisionDigest === surface.bindingRevisionDigest
      && root.authority.graphEventId === undefined
      && root.authority.graphHash === undefined;
    if (!envelope) return miss('envelope_missing');
    if (!revision) return miss('revision_missing');
    if (envelope.attemptId !== identity.sessionId) return miss('envelope_attempt_mismatch');
    if (revision.envelopeDigest !== envelope.envelopeDigest) return miss('revision_envelope_digest_mismatch');
    if (!revision.bound.includes(name)) return miss(`wrapper_not_bound:${name}`);
    if (capability.length !== 1) return miss(`wrapper_capability_count:${capability.length}`);
    if (capability[0]!.accountIdentity !== '') return miss('wrapper_account_identity_not_empty');
    if (capability[0]!.schemaFingerprint !== toolSchemaFingerprint(tool)) return miss('wrapper_schema_fingerprint_mismatch');
    if (!effectiveName) return miss('effective_inner_name_missing');
    if (root.status !== 'ok') return miss(`accepted_turn_authority:${root.status}`);
    if (!exactHostRoot) return miss('host_v1_root_mismatch');
    if (root.authority.state !== 'open') return miss(`authority_state:${root.authority.state}`);
    if (root.authority.identity.acceptedTaskId !== acceptedTaskId) return miss('accepted_task_mismatch');
    if (!contract) return miss('logical_call_contract_missing');

    const exactEntryMatches = (entry: RegisteredHostCapability): boolean => {
      const manifest = currentCapabilityManifest(entry.manifest);
      const canonical = canonicalCatalogIdentityOf(entry);
      return Boolean(
        manifest
        && canonical
        && entry.toolName === manifest.operationId
        && manifest.operationId === effectiveName
        && entry.manifestDigest === capabilityManifestDigest(manifest)
        && entry.schemaVersion === manifest.operationVersion
        && entry.schemaDigest === manifest.definitionFingerprint
        && (entry.account ?? manifest.accountId) === manifest.accountId
        && entry.effect === manifest.effect
        && entry.effect === decision.effect
        && canonical.invokePortId === manifest.invokePortId
      );
    };
    const candidates = decision.effect === 'unknown'
      ? []
      : surface.snapshot.entries.filter(exactEntryMatches);
    if (candidates.length > 1) return miss('catalog_snapshot_ambiguous');
    // THE READ BAR (owner 2026-09-01: "simplify read vs write once and for
    // all"). A snapshot miss opens the read path: the current callable read
    // for this operation — and, when the proof names one, this account —
    // binds. The frozen snapshot, byte-identical spelling, the discovery
    // record's nine digests and the planning card's manifest digest are the
    // WRITE bar (idempotency, reconciliation, exact artifact); replayed onto
    // reads they refused a spreadsheet batch read (08-29), two transports of one
    // read (workflow:1788024507349) and a chat-history read (09-01) that the
    // host had itself just proved. A worker session with no
    // same-turn proof still binds its current catalog read.
    const provenReadCandidate = candidates.length === 0
      ? resolveProvenLiveReadCatalogEntry({
          capabilityId: readDescent?.capabilityId
            ?? canonicalResolvedCapabilityId(effectiveName.trim().toLowerCase()),
          effectiveName: readDescent?.effectiveName ?? effectiveName,
          accountIdentity: readDescent?.accountIdentity
            ?? readDescent?.liveReadDiscovery?.accountIdentity,
        }) ?? undefined
      : undefined;
    // G2 (gate 10): the accepted source literally named this operation (a
    // workflow step's own catalog scope), yet it is neither in the frozen
    // snapshot nor a proven live read. That is a host provisioning fault,
    // not a call the model can correct or substitute; name it so the turn
    // stops and explains instead of looping through generic refusals until
    // the no-progress governor terminalizes it as an internal error.
    if (candidates.length === 0 && !provenReadCandidate) {
      const literalOperation = acceptedSourceLiteralOperation(effectiveName);
      if (literalOperation) return miss(literalOperationNotFrozenReason(literalOperation));
    }
    const dispatchEffect: HostCallAttestation['effect'] | null = provenReadCandidate
      ? 'read'
      : decision.effect === 'unknown'
        ? null
        : decision.effect;
    if (!dispatchEffect) {
      return miss(`effect_unknown:${effectiveName || name}:${decision.source}`);
    }

    const common = {
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      acceptedTaskId,
      sourceEventId: root.authority.sourceEventId,
      sourceEventDigest: root.authority.sourceEventDigest,
      logicalToolCallId,
      toolName: contract.toolName,
      argumentDigest: contract.argumentDigest,
      effect: dispatchEffect,
      engineVersion: root.authority.engineVersion,
      surfaceVersion: root.authority.surfaceVersion,
      authorityDigest: root.authority.authorityDigest,
      authorityRevision: root.authority.revision,
      surfaceDigest: root.authority.surfaceDigest,
      catalogRevisionDigest: surface.catalogRevisionDigest,
      bindingRevisionDigest: surface.bindingRevisionDigest,
    } as const;

    // Adapter provenance is translated before it reaches this shared kernel.
    // Unknown authority classes are refused at this boundary; they never
    // inherit the local envelope as a fallback. A same-turn proven live read
    // carries catalog-manifest authority even when the name classifier could
    // not decide (OPEN-THE-GATES live miss: effect_unknown then catalog miss).
    const authorityBinding = provenReadCandidate
      ? 'catalog_manifest' as const
      : runtimeToolAuthorityBinding(decision);
    if (authorityBinding === 'unknown') return miss(`authority_binding_unknown:${decision.source}`);
    const catalogEntry = candidates[0] ?? provenReadCandidate;
    if (authorityBinding === 'catalog_manifest' || catalogEntry) {
      const manifest = currentCapabilityManifest(catalogEntry?.manifest);
      if (!catalogEntry || !manifest) {
        return miss(
          `catalog_entry_or_manifest_missing:candidates=${candidates.length}`
          + `:proven=${readDescent ? readDescent.capabilityId : 'none'}`,
        );
      }
      const port = resolveProductionPortsForManifest(manifest);
      if (!port || manifest.invokePortId !== canonicalCatalogIdentityOf(catalogEntry)?.invokePortId) {
        return miss('production_port_or_invoke_identity_mismatch');
      }
      const manifestDigest = capabilityManifestDigest(manifest);
      const binding = {
        bindingKind: 'catalog_manifest' as const,
        capabilityId: catalogEntry.capabilityId,
        ...(catalogEntry.providerInputSchemaDigest
          ? { providerInputSchemaDigest: catalogEntry.providerInputSchemaDigest }
          : {}),
        schemaFingerprint: manifest.definitionFingerprint,
        accountId: manifest.accountId,
        invokePortId: manifest.invokePortId,
        operationId: manifest.operationId,
        manifestId: manifest.manifestId,
        manifestDigest,
      };
      const bindingDigest = hostSurfaceDigest({ version: 1, ...binding, effect: dispatchEffect });
      const effectiveArgs = effective.args && typeof effective.args === 'object' && !Array.isArray(effective.args)
        ? effective.args as Record<string, unknown>
        : {};
      const sourceCapability = physicalSourceCapabilityIdentityFromCatalog({
        manifest,
        ...(catalogEntry.sourceSchemaFingerprint
          ? { sourceSchemaFingerprint: catalogEntry.sourceSchemaFingerprint }
          : {}),
      });
      const sourcePurpose = classifyMaterialSourceManifestPurpose(manifest.purpose);
      const validateForegroundPayload = (): InvalidArgumentsPreDispatchResult | null => {
        const validation = catalogEntry.validateForegroundPayload?.(effectiveArgs);
        if (!validation || validation.ok) return null;
        // The proof validator's host-authored, value-free repair key rides
        // the same nominal carrier so both mint paths (pre-approval marker
        // and preparation settlement) key repair progress identically.
        const repairKey = 'repairKey' in validation && typeof validation.repairKey === 'string'
          ? validation.repairKey
          : undefined;
        return new InvalidArgumentsPreDispatchResult(
          validation.repair,
          validation.schemaAvailable,
          repairKey,
        );
      };
      // Native MCP must cross the local exact carrier for both accepted
      // work_call and direct call_tool. Bypassing call_tool here would skip its
      // fresh, separately-accounted metadata proof and invoke the port body
      // without the exact last-edge revalidation.
      const preserveExternalCarrier = isPlainOrClementineLocalTool(name, 'work_call')
        || (
          manifest.providerKind === 'native_mcp'
          && manifest.provenance.issuer === 'host:native-mcp-live-materializer:v1'
          && isPlainOrClementineLocalTool(name, 'call_tool')
        );
      const attestation = { ...common, ...binding, bindingDigest };
      // Pre-dispatch account preparation is keyed on manifest and port facts,
      // never on a provider name: this kernel must not learn which service a
      // manifest adapts. An externally-defined manifest whose port declares
      // no preflight crossing of its own is prepared through the shipped
      // attested transport immediately before its business dispatch; a port
      // that owns admitPreparation/prepareInvocation already performs that
      // crossing itself, and locally reviewed manifests carry no external
      // definition at all.
      const shippedTransportPreparation = Boolean(manifest.externalDefinition)
        && typeof port.prepareInvocation !== 'function';
      return {
        attestation,
        manifest,
        effect: dispatchEffect,
        boundary: preserveExternalCarrier ? 'nested_owned' : 'host_owned_external',
        logicalToolName: manifest.operationId,
        logicalArgs: effectiveArgs,
        ...(sourceCapability ? { sourceCapability } : {}),
        sourcePurpose,
        trustedEffectCarrier: trustedRuntimeEffectCarrier(name, args),
        ...(catalogEntry.validateForegroundPayload
          ? { validateBeforeConsent: validateForegroundPayload }
          : {}),
        ...(!preserveExternalCarrier
          && (shippedTransportPreparation || catalogEntry.validateForegroundPayload)
          ? {
              prepareBeforePhysical: async () => {
                const validation = validateForegroundPayload();
                if (validation) return validation;
                if (shippedTransportPreparation) {
                  await loadShippedImplementations().prepareComposioDispatch({
                    operationId: manifest.operationId,
                    accountId: manifest.accountId,
                  });
                }
              },
            }
          : {}),
        invoke: preserveExternalCarrier
          ? async (callSignal) => {
              const invokeCarrier = () => tool.invoke!(
                runContextForCall,
                argumentsJson,
                { ...(details as Record<string, unknown>), signal: callSignal },
              );
              const admission = nestedCallAdmissions.get(logicalToolCallId);
              if (!admission) return invokeCarrier();
              try {
                return await withNestedCallAdmission(admission, invokeCarrier);
              } finally {
                nestedCallAdmissions.delete(logicalToolCallId);
              }
            }
          : async () => port.invoke({
              // A write the authored-consent evaluator granted carries the
              // host's call authority: the exact manifest bound above plus the
              // arguments this turn schema-validated. Reads and ungranted
              // calls pass none, exactly as before.
              ...(authoredCallGrants.has(logicalToolCallId)
                ? {
                    authority: mintAuthoredCallAuthority({
                      manifest,
                      canonicalArgs: effectiveArgs,
                      grant: {
                        coverageContractId: authoredCallGrants.get(logicalToolCallId)!.coverageContractId,
                        sessionId: identity.sessionId,
                        sourceUserSeq: identity.sourceUserSeq,
                        acceptedTaskId,
                        logicalCallId: logicalToolCallId,
                      },
                    }),
                  }
                : {}),
              nodeId: logicalToolCallId,
              role: 'foreground',
              payload: effectiveArgs,
              identity: {
                sessionId: identity.sessionId,
                sourceUserSeq: identity.sourceUserSeq,
                acceptedTaskId,
              },
              binding: {
                capabilityId: catalogEntry.capabilityId,
                toolName: manifest.operationId,
                schemaVersion: manifest.operationVersion,
                schemaDigest: manifest.definitionFingerprint,
                args: effectiveArgs,
                account: manifest.accountId,
                effect: manifest.effect,
                ...(manifest.destination ? { destination: manifest.destination } : {}),
                manifestDigest,
                providerKind: manifest.providerKind,
                liveFingerprint: manifest.definitionFingerprint,
                manifest,
                invoke: port.invoke,
              },
            }),
      };
    }

    if (authorityBinding !== 'local_envelope') return miss(`authority_binding:${authorityBinding}`);
    const effectClass = capability[0]!.effectClass;
    const localEffect: HostCallAttestation['effect'] | null = decision.effect === 'read'
      || decision.effect === 'compute'
      || decision.effect === 'host_only'
      || (decision.effect === 'local_write' && (effectClass === 'write' || effectClass === 'send'))
      ? decision.effect
      : null;
    if (!localEffect) return miss(`local_effect_mismatch:${decision.effect}:${effectClass}`);
    const binding = {
      bindingKind: 'local_envelope' as const,
      capabilityId: capability[0]!.name,
      schemaFingerprint: capability[0]!.schemaFingerprint,
      accountId: '',
      invokePortId: `configured-wrapper:${capability[0]!.schemaFingerprint}`,
      operationId: name,
      manifestId: '',
      manifestDigest: '',
    };
    const bindingDigest = hostSurfaceDigest({ version: 1, ...binding, effect: localEffect });
    const preserveLocalCarrier = isPlainOrClementineLocalTool(name, 'call_tool')
      || isPlainOrClementineLocalTool(name, 'work_call');
    return {
      attestation: { ...common, ...binding, bindingDigest },
      effect: localEffect,
      boundary: preserveLocalCarrier ? 'nested_owned' : 'host_owned_local',
      logicalToolName: name,
      logicalArgs: args,
      invoke: async (callSignal) => {
        const invokeCarrier = () => tool.invoke!(
          runContextForCall,
          argumentsJson,
          { ...(details as Record<string, unknown>), signal: callSignal },
        );
        if (!isPlainOrClementineLocalTool(name, 'work_call')) return invokeCarrier();
        const admission = nestedCallAdmissions.get(logicalToolCallId);
        if (!admission) return invokeCarrier();
        try {
          return await withNestedCallAdmission(admission, invokeCarrier);
        } finally {
          nestedCallAdmissions.delete(logicalToolCallId);
        }
      },
    };
  };

  type ExactMaterialSourceGate =
    | { status: 'unscoped' }
    | {
        status: 'delegated';
        requirement: {
          role: 'source' | 'collection';
          effect: 'read';
          bindingRequired: boolean;
        };
        expectedBinding?: import('./turn-control.js').TurnSourceStrategyBindingV1;
      }
    | { status: 'refused'; reason: string };

  /** Read-only material-source admission. This runs before approval is
   * surfaced and again at the last edge before invocation. It never mints a
   * logical call, physical row, approval, or provider crossing. */
  const exactMaterialSourceGate = (input: {
    exactProduction: ExactProductionHostCall;
    sessionId: string;
    sourceUserSeq: number;
  }): ExactMaterialSourceGate => {
    const { exactProduction, sessionId, sourceUserSeq } = input;
    if (!exactProduction.sourcePurpose) return { status: 'unscoped' };
    try {
      const materialSource = inspectDurableMaterialSourceContinuation({
        sessionId,
        sourceUserSeq,
      });
      if (materialSource.status === 'refused') {
        return {
          status: 'refused',
          reason: `material_source_continuation_${materialSource.reason}`,
        };
      }
      if (materialSource.status === 'variant') {
        return {
          status: 'refused',
          reason: 'material_source_variant_unconfirmed',
        };
      }
      // No durable A/Q/B lineage means this is an ordinary exact current read,
      // not a material-source continuation. Provider purpose vocabulary is
      // descriptive here and cannot manufacture (or withhold) authority: the
      // catalog/manifest/account/schema/port proof above remains the complete
      // dispatch bar. Any malformed, variant, or verified continuation was
      // already separated above and still traverses the full binding gate.
      if (materialSource.status === 'not_applicable') {
        return { status: 'unscoped' };
      }
      const structuralRole = exactProduction.sourcePurpose.status === 'source_requirement'
        ? exactProduction.sourcePurpose.role
        : undefined;
      const decisionInspection = inspectExactSourceStrategyDecisionForSource(
        sessionId,
        sourceUserSeq,
      );
      if (decisionInspection.status === 'invalid') {
        return { status: 'refused', reason: 'material_source_decision_invalid' };
      }
      if (!exactProduction.sourceCapability) {
        return { status: 'refused', reason: 'material_source_physical_identity_missing' };
      }
      if (
        decisionInspection.status !== 'ok'
        || !turnPreflightDecisionsEqual(decisionInspection.decision, materialSource.decision)
      ) {
        return { status: 'refused', reason: 'material_source_consuming_decision_mismatch' };
      }
      const requirement = {
        role: structuralRole ?? 'collection',
        effect: 'read' as const,
        bindingRequired: true,
      };
      const admission = evaluateSourceStrategyIdentityAdmission({
        requirementEffect: requirement.effect,
        requirementRole: requirement.role,
        decision: decisionInspection.decision,
        capability: exactProduction.sourceCapability,
        bindingRequired: true,
      });
      if (
        admission.status !== 'admitted'
        || !sourceStrategyBindingsEqual(admission.binding, materialSource.binding)
      ) {
        return {
          status: 'refused',
          reason: admission.status === 'refused'
            ? `material_source_${admission.kind}`
            : admission.status === 'not_applicable'
              ? `material_source_${admission.reason}`
              : 'material_source_consuming_binding_mismatch',
        };
      }
      return {
        status: 'delegated',
        requirement,
        expectedBinding: materialSource.binding,
      };
    } catch {
      return { status: 'refused', reason: 'material_source_authority_unreadable' };
    }
  };

  /** A large direct run_worker call is graph-neutral coordination, but it is
   * not unplanned when the existing quantified-work gate proves that the
   * packet covers this accepted request's exact full item contract and carries
   * the required durable manifest. This check grants only host-side fan-out
   * admission; the worker body re-runs the same gate and its children remain
   * compose-only. Small/ad-hoc worker calls keep the ordinary uncovered-
   * mutation repair path. */
  const exactQuantifiedWorkerControl = (input: {
    name: string;
    args: Record<string, unknown>;
    sessionId: string;
    sourceUserSeq: number;
  }): boolean => {
    if (!isPlainOrClementineLocalTool(input.name, 'run_worker')) return false;
    const items = Array.isArray(input.args.items)
      ? input.args.items.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : typeof input.args.item === 'string' && input.args.item.trim()
        ? [input.args.item]
        : [];
    if (items.length === 0) return false;
    const workManifest = input.args.workManifest;
    if (!workManifest || typeof workManifest !== 'object' || Array.isArray(workManifest)) return false;
    try {
      const gateInput: QuantifiedWorkManifestGateInput = {
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        items,
        workManifest: workManifest as QuantifiedWorkManifestGateInput['workManifest'],
      };
      const gate = evaluateQuantifiedWorkManifestGate(gateInput);
      return gate.ok && gate.required && gate.expectedCount === items.length;
    } catch {
      return false;
    }
  };

  const readOnlyCanaryRefusal = (
    name: string,
    args: Record<string, unknown> | null,
    argumentsJson: string,
    tool: FunctionToolLike | undefined,
    logicalToolCallId: string,
    details: unknown = {},
  ): string | undefined => {
    if ((!hostReadOnlyCanary && !hostProduction) || !args) return undefined;
    // The first live cut may use only the configured tool objects assembled by
    // Clem. Orchestrator construction passes every one of those objects through
    // wrapToolForHarness; dynamically appended tools do not yet carry the same
    // immutable capability/account binding used by this first read-only
    // surface. The host deadline now bounds them, but timing safety cannot
    // substitute for catalog provenance, so the canary remains conservative.
    if (
      !harnessToolBracketsEnabled()
      || !tool
      || (
        (!configuredToolRefs.has(tool) || !isHarnessBoundFunctionTool(tool))
        // READ-FAST-PATH: a read-effect call whose exact operation this turn
        // proved (capability_resolution ledger) is never killed at the
        // provenance wall — the effect classification this boundary already
        // computed IS the read bar. Mutations keep the full wall.
        && !provenTurnReadDescent(name, args, tool)
      )
    ) {
      return `Tool '${name}' was refused before dispatch because the selected host engine only admits configured harness-bounded tools. No local or external mutation was attempted.`;
    }
    if (hostProduction) {
      if (exactProductionHostCall(
        name,
        args,
        argumentsJson,
        tool,
        logicalToolCallId,
        runContext,
        details,
      )) return undefined;
      // Name the operations this turn actually bound.
      //
      // Live 2026-08-26: the plan bound one write operation, the model read the
      // exact schemas, decided a different (correct, non-deprecated) operation
      // was the right one, and was refused. It then guessed a THIRD, was
      // refused again, and gave up — because the refusal described a category
      // of problem without naming the one fact that resolves it. An error that
      // names its own repair gets repaired; this one could not be.
      //
      // Value-opaque rule holds: these are HOST-declared identities from the
      // accepted graph, never model text, and naming them grants nothing —
      // every gate still runs on the next call.
      const refusalIdentity = exactHostIdentity();
      const boundOperations = plannedWriteOperationIds(
        refusalIdentity.sessionId,
        refusalIdentity.sourceUserSeq,
      ).filter((operationId) => operationId !== name.toUpperCase());
      // Live 2026-09-01: with no plan bound at all, the refusal named a
      // category ("capability, effect, account, schema, or invoke binding")
      // and no door; the model retried until the governor exhausted. Name the
      // one walkable edge for each effect class.
      // A sealed workflow step has no plan_task door: its operations were
      // proven into the frame before the model spoke. Name THOSE, so a wrong
      // slug (a stuttered provider prefix on a prepared operation, 2026-09-02)
      // is repaired on the next call instead of walking the model into a
      // chat-lane ritual it cannot perform.
      const provenOperations = boundOperations.length > 0
        ? []
        : [...new Set([
            ...provenCapabilityEntriesForTurn({
              sessionId: refusalIdentity.sessionId,
              sourceUserSeq: refusalIdentity.sourceUserSeq,
            })
              .filter((entry) => typeof entry.identifier === 'string')
              .map((entry) => entry.identifier.trim().toUpperCase()),
            ...(currentAcceptedSourceCatalogManifestScope()?.operationIds ?? []),
          ].filter((operationId) => operationId && operationId !== name.toUpperCase()))];
      const repair = boundOperations.length > 0
        ? ` This turn bound: ${boundOperations.join(', ')}. Use one of those exactly, or call plan_task again to amend the plan before retrying.`
        : provenOperations.length > 0
          ? ` The operations proven for this step are: ${provenOperations.join(', ')}. Use one of those exactly, with tool_slug spelled exactly as listed.`
          : ' No operation is bound to this turn yet. If this call writes or sends: call tool_search for the exact operation, then plan_task naming it, then work_call — that is the door for a write no plan has bound. If it only reads: call tool_search and retry with the exact operation name it returns.';
      const literalOperation = literalOperationNotFrozenOperation(lastExactProductionMiss);
      if (literalOperation) {
        return `Tool '${name}' was refused before dispatch because this step names the operation ${literalOperation} but the host did not provision it into this run's frozen catalog. Failed check: ${lastExactProductionMiss}. This is a host provisioning fault, not an argument error: no correction or substitute capability can be dispatched, and no local or external mutation was attempted.`;
      }
      const miss = lastExactProductionMiss ? ` Failed check: ${lastExactProductionMiss}.` : '';
      return `Tool '${name}' was refused before dispatch because its exact capability, effect, account, schema, or invoke binding is absent or changed.${miss} No local or external mutation was attempted.${repair}`;
    }
    // The first live host cut dispatches only a direct, active capability whose
    // exact configured object, callable schema, immutable envelope and current
    // binding revision all agree. A heuristic `compute` label is deliberately
    // insufficient: shell, native MCP, host controls, opaque providers and
    // generic carriers remain zero-body until their own resolved capability or
    // explicit pure-host contract co-travels with this boundary.
    if (exactHostReadOnlyCallAttestation(name, args, tool, logicalToolCallId)) return undefined;
    return `Tool '${name}' was refused before dispatch by the read-only canary because its exact attested pure-local read contract is absent or does not match the configured object. No local or external mutation was attempted.`;
  };

  // JIT READ EDGE: a carried provider operation the model selected is absent
  // from this turn's frozen snapshot and was never proven this turn. The host
  // holds the exact provider definition, so provision it once per turn and let
  // the caller re-run the exact production check: a READ then binds through
  // the proven-live-read path; a WRITE stays behind the frozen/authored bar.
  // Nothing is synthesized from the model's spelling — the definition must
  // exist and revalidate byte-exactly, or the original refusal stands.
  const jitProvisionCarriedOperation = async (
    callName: string,
    parsedArguments: Record<string, unknown> | null,
  ): Promise<boolean> => {
    const carried = unwrapRuntimeEffectiveToolIdentity(callName, parsedArguments).toolName?.trim() ?? '';
    const carriedOperation = carried && carried !== callName ? carried : '';
    if (!carriedOperation || jitReadProvisionAttempted.has(carriedOperation)) return false;
    jitReadProvisionAttempted.add(carriedOperation);
    const jitIdentity = exactHostIdentity();
    if (isReviewedLiveReadIdentity(carriedOperation)) {
      // Supply only: the exact production check re-runs after acquisition and
      // still proves candidate, account and effect; writes never enter here.
      let acquired: Awaited<ReturnType<HostJitLiveReadAcquirer>>;
      try {
        acquired = await hostJitLiveReadAcquirer({
          ownerId: jitIdentity.sessionId,
          nodeId: `jit:${jitIdentity.sourceUserSeq}`,
          operationId: carriedOperation,
          deadlineAt: Date.now() + HOST_JIT_READ_PROVISION_BUDGET_MS,
        });
      } catch (error) {
        acquired = { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
      }
      hostTurnLogger.info({
        sessionId: jitIdentity.sessionId,
        sourceUserSeq: jitIdentity.sourceUserSeq,
        operationId: carriedOperation,
        status: acquired.status,
        ...(acquired.detail ? { detail: acquired.detail } : {}),
      }, 'host jit live-read acquisition');
      return acquired.status !== 'unavailable';
    }
    const acceptedEvent = listEvents(jitIdentity.sessionId, {
      sinceSeq: jitIdentity.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === jitIdentity.sourceUserSeq);
    const acceptedDisplay = typeof acceptedEvent?.data.displayText === 'string'
      ? acceptedEvent.data.displayText
      : '';
    const acceptedText = acceptedDisplay.trim()
      ? acceptedDisplay
      : (typeof acceptedEvent?.data.text === 'string' ? acceptedEvent.data.text : '');
    let provisioned: Awaited<ReturnType<HostJitReadProvisioner>>;
    try {
      provisioned = await hostJitReadProvisioner({
        sessionId: jitIdentity.sessionId,
        sourceUserSeq: jitIdentity.sourceUserSeq,
        acceptedInput: acceptedText,
        operationIds: [carriedOperation],
        deadlineAt: Date.now() + HOST_JIT_READ_PROVISION_BUDGET_MS,
      });
    } catch (error) {
      provisioned = {
        ok: false,
        code: 'jit_read_provision_failed',
        identifier: carriedOperation,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    hostTurnLogger.info({
      sessionId: jitIdentity.sessionId,
      sourceUserSeq: jitIdentity.sourceUserSeq,
      operationId: carriedOperation,
      ok: provisioned.ok,
      ...(provisioned.ok ? {} : { code: provisioned.code, detail: provisioned.detail }),
    }, 'host jit read provisioning');
    return provisioned.ok;
  };

  const executeCall = async (
    call: { callId: string; name: string; argumentsJson: string },
    observation: HostCallInvocationObservation = { invocationEntered: false },
  ): Promise<{
    historyItem: AgentInputItem;
    tool?: FunctionToolLike;
    output: unknown;
    argumentsJson: string;
    effect: RuntimeToolEffect;
    hostRefusal?: string;
    /** A refusal the model cannot repair: the host stops and explains. */
    hostFault?: HostFaultTerminal;
    settlementRequiresReconciliation?: true;
    committedVerificationHolds?: readonly CommittedMutationVerificationHold[];
  }> => {
    const executionContext = harnessRunContextStorage.getStore();
    if (executionContext?.hostOwnsToolAccounting) {
      // One charge for every model-emitted execution intent, independent of
      // whether the selected carrier is a wrapped built-in, native MCP, CLI,
      // or a nested dispatcher. Inner wrappers observe the context bit and do
      // not double-charge the same intent.
      if (executionContext.counter.willExceed()) {
        throw new ToolCallsLimitExceeded(executionContext.counter.limit);
      }
      executionContext.counter.increment();
    }
    const tool = toolByName.get(call.name);
    const argumentsJson = materializedArgumentsJson(tool, call.argumentsJson);
    const parsedArguments = parsedArgs(argumentsJson);
    let admittedEffect: RuntimeToolEffect = currentFrameEffects.get(call.callId)
      ?? (parsedArguments ? classifyRuntimeToolEffect(call.name, parsedArguments).effect : 'unknown');
    let canaryRefusal = readOnlyCanaryRefusal(
      call.name,
      parsedArguments,
      argumentsJson,
      tool,
      call.callId,
    );
    if (
      canaryRefusal
      && lastExactProductionMiss.startsWith('catalog_entry_or_manifest_missing')
      && await jitProvisionCarriedOperation(call.name, parsedArguments)
    ) {
      // Re-run the exact check against the now-provisioned definition; the
      // refusal (and the miss it names) is recomposed, never edited.
      canaryRefusal = readOnlyCanaryRefusal(
        call.name,
        parsedArguments,
        argumentsJson,
        tool,
        call.callId,
      );
    }
    // Read synchronously: sibling reads share a bounded pool, and the exact
    // miss belongs to the refusal composed on the line above.
    const literalFaultOperation = canaryRefusal
      ? literalOperationNotFrozenOperation(lastExactProductionMiss)
      : null;
    const hostFault: HostFaultTerminal | undefined = literalFaultOperation
      ? {
          reason: literalOperationNotFrozenReason(literalFaultOperation),
          text: hostLiteralOperationNotFrozenBlockedText(literalFaultOperation),
        }
      : undefined;
    const toolCallItem = {
      type: 'function_call' as const,
      callId: call.callId,
      name: call.name,
      arguments: argumentsJson,
    };
    const details = { toolCall: toolCallItem };
    const inputGuardrail = !canaryRefusal && tool && parsedArguments
      ? await runToolInputGuardrails({
          guardrails: tool.inputGuardrails as never,
          context: runContext,
          agent,
          toolCall: toolCallItem as never,
        })
      : { type: 'allow' as const };
    emit('agent_tool_start', runContext, agent, tool ?? { name: call.name }, details);
    let output: unknown;
    let hostRefusal: string | undefined;
    let returnedPreDispatchRefusal = false;
    let settlementRequiresReconciliation = false;
    let committedVerificationHolds: CommittedMutationVerificationHold[] = [];
    if (canaryRefusal) {
      output = canaryRefusal;
      hostRefusal = canaryRefusal;
    } else if (!tool || typeof tool.invoke !== 'function') {
      output = `Tool '${call.name}' not found. Use tool_search to retrieve the current schema, then invoke it through the advertised carrier.`;
      hostRefusal = String(output);
    } else if (!parsedArguments) {
      output = `Tool '${call.name}' received invalid arguments. Supply exactly one JSON object that matches the advertised schema before retrying.`;
      hostRefusal = String(output);
    } else if (inputGuardrail.type === 'reject') {
      output = inputGuardrail.message;
      hostRefusal = String(output);
    } else {
      // FunctionTool.invoke already applies that tool's errorFunction. Any
      // error still escaping invoke is fatal authority/control data (kill,
      // cap, stale lease, explicit raise_exception, or an unhandled defect)
      // and must reach loop.ts's canonical error reducer. Turning it into
      // prose here would let the model reason past a revoked boundary.
      let exactAttestation: HostReadOnlyCallAttestation | null = null;
      let exactProduction: ExactProductionHostCall | null = null;
      if (hostReadOnlyCanary) {
        // Guardrails and approval predicates are awaited outside the body. Mint
        // the proof again at the last synchronous edge so a wrapper/schema,
        // catalog, binding, source or root drift cannot ride an earlier check
        // through the logical-admission or host-crossing transaction.
        exactAttestation = exactHostReadOnlyCallAttestation(
          call.name,
          parsedArguments,
          tool,
          call.callId,
        );
        if (!exactAttestation) {
          const identity = exactHostIdentity();
          poisonExactHostAuthority(
            identity.sessionId,
            identity.sourceUserSeq,
            'host read-only call binding changed before body',
          );
          throw new HostCallAuthorityBoundaryError('call_binding_changed_before_body');
        }
      } else if (hostProduction) {
        exactProduction = exactProductionHostCall(
          call.name,
          parsedArguments,
          argumentsJson,
          tool,
          call.callId,
          runContext,
          details,
        );
        if (!exactProduction) {
          const identity = exactHostIdentity();
          poisonExactHostAuthority(
            identity.sessionId,
            identity.sourceUserSeq,
            'host call binding changed before body',
          );
          throw new HostCallAuthorityBoundaryError('call_binding_changed_before_body');
        }
        admittedEffect = exactProduction.effect;
      }
      const ambient = harnessRunContextStorage.getStore();
      const exactSource = ambient
        && ambient.dispatchLease
        && ambient.sessionId
        && Number.isSafeInteger(ambient.sourceUserSeq)
        && (ambient.sourceUserSeq ?? 0) > 0
        ? {
            sessionId: ambient.sessionId,
            sourceUserSeq: ambient.sourceUserSeq as number,
            parentLease: ambient.dispatchLease,
          }
        : null;
      const invoke = async (): Promise<unknown> => {
        if (!exactSource) {
          if (!allowUnownedToolInvocationForTests) {
            throw new HostCallAuthorityBoundaryError('host_invocation_authority_missing');
          }
          observation.invocationEntered = true;
          return tool.invoke!(runContext, argumentsJson, details);
        }
        const exactAmbient = ambient!;
        const effect = exactProduction?.effect
          ?? classifyRuntimeToolEffect(call.name, parsedArguments).effect;
        const boundary = exactProduction?.boundary ?? (
          configuredToolRefs.has(tool)
            && hostReadOnlyExecutionContractFor(call.name) === 'pure_local'
            ? 'host_owned_local' as const
            : isHarnessBoundFunctionTool(tool)
              ? 'nested_owned' as const
              : !configuredToolRefs.has(tool)
                ? 'host_owned_external' as const
                : null
        );
        if (!boundary) {
          throw new HostCallAuthorityBoundaryError('unwrapped_execution_site_unknown');
        }
        const killTarget = exactAmbient.runAttemptId
          ? { attemptId: exactAmbient.runAttemptId, sourceUserSeq: exactSource.sourceUserSeq }
          : { sourceUserSeq: exactSource.sourceUserSeq };
        const materialGate = exactProduction
          ? exactMaterialSourceGate({
              exactProduction,
              sessionId: exactSource.sessionId,
              sourceUserSeq: exactSource.sourceUserSeq,
            })
          : { status: 'unscoped' as const };
        if (materialGate.status === 'refused') {
          throw new HostCallAuthorityBoundaryError(materialGate.reason);
        }
        const invokeThroughHostBoundary = async (): Promise<unknown> => {
          // A preserved work_call must enter the logical wall as the trusted
          // carrier. That wall deliberately defers the write-binding question
          // until work_call has admitted the named requirement. The durable
          // logical contract still unwraps these exact outer bytes to the
          // attested inner operation/digest, so this grants no second identity.
          const preserveWorkCallCarrier = Boolean(
            exactProduction
            && boundary === 'nested_owned'
            && isPlainOrClementineLocalTool(call.name, 'work_call'),
          );
          const expectedWork = loadExpectedWorkCallBindingState({
            sessionId: exactSource.sessionId,
            sourceUserSeq: exactSource.sourceUserSeq,
            logicalToolCallId: call.callId,
          });
          // Once exact expected work is durably bound, that row is the single
          // business-role owner for both the inner settlement and this host
          // adoption. Registry control is only a default for graph-neutral
          // calls; it cannot relabel an accepted Workspace/workflow operation
          // after admission has frozen its requirement and effect.
          const businessCall = expectedWork.status === 'ok'
            || (
              actionTopologyRoleForRuntimeCall(call.name, parsedArguments) === 'business'
              && classifyDiscoveryCall(call.name, parsedArguments) === null
            );
          const deadlineMs = hostToolDeadlineMs(call.name);
          observation.invocationEntered = true;
          const invoked = await invokeHostToolCall({
            identity: {
              sessionId: exactSource.sessionId,
              sourceUserSeq: exactSource.sourceUserSeq,
              modelCallId: call.callId,
              toolName: preserveWorkCallCarrier
                ? call.name
                : exactProduction?.logicalToolName ?? call.name,
              args: preserveWorkCallCarrier
                ? parsedArguments
                : exactProduction?.logicalArgs ?? parsedArguments,
              turn: exactAmbient.turn,
            },
            parentLease: exactSource.parentLease,
            effect,
            boundary,
            businessCall,
            trustedEffectCarrier: exactProduction?.trustedEffectCarrier,
            deadlineMs,
            callerSignal: signal,
            isKillRequested: () => isKillRequested(exactSource.sessionId, killTarget),
            ...(exactProduction?.prepareBeforePhysical && boundary === 'host_owned_external'
              ? { beforePhysicalPreparation: exactProduction.prepareBeforePhysical }
              : {}),
            ...(exactProduction
              && boundary === 'host_owned_external'
              && materialGate.status === 'delegated'
              ? {
                  beforePhysicalAdmission: (physical: {
                    sessionId: string;
                    sourceUserSeq: number;
                    acceptedTaskId: string;
                    logicalToolCallId: string;
                    tool: string;
                    args?: unknown;
                    lease: DispatchLeaseRef;
                  }) => {
                    const argumentAuthority = mintCurrentRequestSourceArgumentAuthority({
                      sessionId: physical.sessionId,
                      sourceUserSeq: physical.sourceUserSeq,
                      acceptedTaskId: physical.acceptedTaskId,
                      logicalToolCallId: physical.logicalToolCallId,
                      tool: physical.tool,
                      args: physical.args,
                      lease: physical.lease,
                    });
                    if (!argumentAuthority) {
                      throw new HostCallAuthorityBoundaryError(
                        'material_source_argument_authority_missing',
                      );
                    }
                    const admission = admitSourceStrategyPhysicalDispatch({
                      sessionId: physical.sessionId,
                      sourceUserSeq: physical.sourceUserSeq,
                      ...(exactProduction.sourceCapability
                        ? { capability: exactProduction.sourceCapability }
                        : {}),
                      tool: physical.tool,
                      args: physical.args,
                      argumentAuthority,
                    });
                    const ordinarySource = materialGate.requirement.bindingRequired === false
                      && admission.status === 'not_applicable'
                      && admission.reason === 'no_binding';
                    const confirmedSource = materialGate.requirement.bindingRequired === true
                      && admission.status === 'admitted'
                      && Boolean(materialGate.expectedBinding)
                      && sourceStrategyBindingsEqual(admission.binding, materialGate.expectedBinding);
                    if (!ordinarySource && !confirmedSource) {
                      throw new HostCallAuthorityBoundaryError(
                        admission.status === 'refused'
                          ? `material_source_${admission.kind}`
                          : 'material_source_physical_admission_changed',
                      );
                    }
                  },
                }
              : {}),
            invoke: ({ signal: callSignal }) => exactProduction
              ? exactProduction.invoke(callSignal)
              : tool.invoke!(
                  runContext,
                  argumentsJson,
                  { ...details, signal: callSignal },
                ),
          });
          if (preserveWorkCallCarrier) {
            const redeemed = redeemDurableLogicalCallSettlementForHost({
              sessionId: exactSource.sessionId,
              sourceUserSeq: exactSource.sourceUserSeq,
              acceptedTaskId: acceptedTaskIdFor(
                exactSource.sessionId,
                exactSource.sourceUserSeq,
              ),
              logicalToolCallId: call.callId,
            });
            returnedPreDispatchRefusal = redeemed.status === 'ok'
              && isReturnedPreDispatchHostRefusalSettlement(
                invoked.settlement,
                redeemed.settlement,
              );
          }
          // Nested carriers can return an SDK-laundered error value after the
          // exact inner settlement has already proved that a mutation is
          // uncertain. The immutable settlement, never returned provider
          // prose, owns that effect decision. Carry it to frame pairing so the
          // model receives the canonical effect_unknown marker and cannot
          // reason from (or retry after) a misleading ordinary result.
          settlementRequiresReconciliation =
            invoked.settlement.outcome.directive.requiresReconciliation === true;
          if (
            preserveWorkCallCarrier
            && (effect === 'local_write' || effect === 'external_write' || effect === 'admin')
            && (invoked.settlement.outcome.kind === 'succeeded'
              || invoked.settlement.outcome.kind === 'empty_result')
          ) {
            // Verification is host-derived runtime work. It gets its own
            // deterministic logical call and traverses this same kernel after
            // the mutation has durably settled; the model emits no readback
            // node or tool call and receives no second dispatch authority.
            try {
              await executeFrozenMutationVerification({
                sessionId: exactSource.sessionId,
                sourceUserSeq: exactSource.sourceUserSeq,
                ownerLogicalToolCallId: call.callId,
                parentLease: exactSource.parentLease,
                turn: exactAmbient.turn,
                deadlineMs,
                callerSignal: signal,
                isKillRequested: () => isKillRequested(exactSource.sessionId, killTarget),
              });
            } catch (error) {
              // The owner mutation is already durably successful at this edge.
              // A verifier failure is a separate read-only continuation, never
              // evidence that the write is uncertain and never authority to
              // re-enter the original work_call.
              const recovered = await recoverCommittedMutationVerificationsForSource({
                sessionId: exactSource.sessionId,
                sourceUserSeq: exactSource.sourceUserSeq,
                parentLease: exactSource.parentLease,
                turn: exactAmbient.turn,
                deadlineMs,
                callerSignal: signal,
                isKillRequested: () => isKillRequested(exactSource.sessionId, killTarget),
              });
              const projected = recovered.status === 'held'
                ? recovered.holds.find((hold) => hold.ownerLogicalToolCallId === call.callId) ?? null
                : recovered.status === 'verified'
                  ? null
                  : committedMutationVerificationHoldForOwner({
                      sessionId: exactSource.sessionId,
                      sourceUserSeq: exactSource.sourceUserSeq,
                      ownerLogicalToolCallId: call.callId,
                      observedFailure: error,
                    });
              const boundRequirement = expectedWork.status === 'ok'
                ? expectedWork.binding.requirementId
                : call.callId;
              committedVerificationHolds = recovered.status === 'verified'
                ? []
                : [projected ?? {
                    ownerLogicalToolCallId: call.callId,
                    requirementId: boundRequirement,
                    effect: effect as 'local_write' | 'external_write' | 'admin',
                    resultHandleId: invoked.settlement.resultHandleId ?? 'durable-result-handle-unavailable',
                    status: 'failed',
                    reason: String(error instanceof Error ? error.message : error)
                      .replace(/\s+/g, ' ').slice(0, 300),
                    recoveryKind: 'exhausted',
                    verifierOnlyRetryable: false,
                  }];
              hostTurnLogger.warn({
                ownerLogicalToolCallId: call.callId,
                holds: committedVerificationHolds,
              }, 'committed write retained while exact verification is held');
            }
          }
          return invoked.value;
        };
        if (
          boundary === 'nested_owned'
          && (
            isDelegationPrimitiveRuntimeCall(call.name, parsedArguments)
            || isUnscopedShellRuntimeCall(call.name, parsedArguments)
          )
        ) {
          const materialSource = inspectDurableMaterialSourceContinuation({
            sessionId: exactSource.sessionId,
            sourceUserSeq: exactSource.sourceUserSeq,
          });
          if (materialSource.status !== 'not_applicable') {
            throw new HostCallAuthorityBoundaryError('material_source_carrier_not_propagated');
          }
        }
        if (materialGate.status === 'delegated') {
          return withSourceStrategyRequirement(
            materialGate.requirement,
            invokeThroughHostBoundary,
          );
        }
        return invokeThroughHostBoundary();
      };
      output = exactAttestation
        ? await withHostReadOnlyCallAttestation(exactAttestation, invoke)
        : exactProduction
          ? await withHostCallAttestation(exactProduction.attestation, invoke)
          : await invoke();
    }
    if (tool && !canaryRefusal) {
      output = await runToolOutputGuardrails({
        guardrails: tool.outputGuardrails as never,
        context: runContext,
        agent,
        toolCall: toolCallItem as never,
        toolOutput: output,
      });
    }
    const text = resultText(output);
    if (!hostRefusal && returnedPreDispatchRefusal) hostRefusal = text;
    emit('agent_tool_end', runContext, agent, tool ?? { name: call.name }, text, details);
    return {
      historyItem: functionResultItem(call.callId, call.name, output),
      ...(tool ? { tool } : {}),
      output,
      argumentsJson: call.argumentsJson,
      effect: admittedEffect,
      ...(hostRefusal ? { hostRefusal } : {}),
      ...(hostFault ? { hostFault } : {}),
      ...(settlementRequiresReconciliation
        ? { settlementRequiresReconciliation: true as const }
        : {}),
      ...(committedVerificationHolds.length > 0
        ? { committedVerificationHolds }
        : {}),
    };
  };

  type CanonicalHostCall = {
    callId: string;
    name: string;
    argumentsJson: string;
  };
  type ExecutedHostCall = Awaited<ReturnType<typeof executeCall>>;

  const dispositionSourceScope = (): Record<string, unknown> => {
    try {
      const identity = exactHostIdentity();
      const root = acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
      return {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId: acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq),
        rootAuthorityDigest: root.status === 'ok' ? root.authority.authorityDigest : null,
      };
    } catch {
      const projected = contextValue && typeof contextValue === 'object'
        ? contextValue as { sessionId?: unknown; sourceUserSeq?: unknown; turn?: unknown }
        : {};
      return {
        sessionId: typeof projected.sessionId === 'string' ? projected.sessionId : null,
        sourceUserSeq: typeof projected.sourceUserSeq === 'number' ? projected.sourceUserSeq : null,
        turn: typeof projected.turn === 'number' ? projected.turn : null,
      };
    }
  };

  const semanticFrameDigest = (calls: readonly CanonicalHostCall[]): string => (
    hostSurfaceDigest({
      protocol: HOST_TOOL_DISPOSITION_PROTOCOL,
      source: dispositionSourceScope(),
      calls: calls.map((call) => {
        let argumentsJson = call.argumentsJson;
        try {
          argumentsJson = materializedArgumentsJson(
            toolByName.get(call.name),
            call.argumentsJson,
          );
        } catch {
          // The raw admitted JSON remains safe digest material. Failure to
          // materialize belongs to the local, zero-crossing disposition.
        }
        return { name: call.name, argumentsJson };
      }),
    })
  );

  const executeCallAttempt = async (
    call: CanonicalHostCall,
  ): Promise<HostCallExecutionAttempt<ExecutedHostCall>> => {
    const observation: HostCallInvocationObservation = { invocationEntered: false };
    try {
      const value = await executeCall(call, observation);
      return {
        status: 'returned',
        value,
        invocationEntered: observation.invocationEntered,
      };
    } catch (error) {
      if (isHostDurableContinuationPendingError(error) && observation.invocationEntered) {
        return {
          status: 'durable_continuation_pending',
          error,
          invocationEntered: true,
        };
      }
      // A host/lifecycle counter trip before invoke is turn control, not a tool
      // failure. Keep it typed so the scheduler can stop assigning work, drain
      // already-started siblings, and pair their exact results before the
      // original exception reaches loop.ts. A same-named error thrown after
      // invoke remains ordinary crossing-state evidence and is never softened.
      if (error instanceof ToolCallsLimitExceeded && !observation.invocationEntered) {
        return {
          status: 'tool_calls_limit',
          error,
          invocationEntered: false,
        };
      }
      // The terminal a user sees for this path says the technical details are
      // in the activity log. They were not: the error was carried on the
      // attempt, used to choose a disposition, and then dropped. A turn could
      // fail with no recoverable account of why, anywhere.
      hostTurnLogger.error(
        {
          tool: call.name,
          callId: call.callId,
          invocationEntered: observation.invocationEntered,
          err: error instanceof Error
            ? { message: error.message, stack: error.stack }
            : { message: String(error) },
        },
        'host tool call failed',
      );
      return {
        status: 'failed',
        error,
        invocationEntered: observation.invocationEntered,
      };
    }
  };

  /**
   * One crossing-state disposition. The error's class, message, tool name and
   * provider never decide recovery. Before invoke, local control proves no
   * effect. After invoke, only an exact durable refused_pre_dispatch settlement
   * with zero host/provider crossings permits model-led repair; every missing,
   * unreadable, conflicting, or crossed state is reconciliation-owned.
   */
  const failedCallCrossingDisposition = (
    call: CanonicalHostCall,
    attempt: Extract<HostCallExecutionAttempt<ExecutedHostCall>, { status: 'failed' }>,
  ): 'zero_crossing' | 'effect_may_have_started' => {
    if (!attempt.invocationEntered) return 'zero_crossing';
    try {
      const identity = exactHostIdentity();
      const redeemed = redeemDurableLogicalCallSettlementForHost({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId: acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq),
        logicalToolCallId: call.callId,
      });
      if (redeemed.status !== 'ok') return 'effect_may_have_started';
      const settlement = redeemed.settlement;
      if (
        settlement.executionKind === 'refused_pre_dispatch'
        && settlement.physicalCrossingCount === 0
        && settlement.hostCrossingCount === 0
      ) return 'zero_crossing';
      // A DECLARED-READ call with zero crossings that left the machine has no
      // external effect to reconcile: the settlement is host-authored at mint
      // (never the model, never a name heuristic), physicalCrossingCount
      // means bytes crossed OUT, and a read that died mid-execution changed
      // nothing anywhere. Live 2026-08-25: tool_search — local, non-mutating,
      // zero physical crossings — hit a TimeoutError and the turn ended with
      // "its effect must be reconciled", killing two workflow dispatches.
      // Three bounds keep this narrow: a mutating or business call keeps
      // reconciliation ownership even with zero recorded crossings (a partial
      // local write is real), and the settlement's OWN recovery verdict must
      // say the failure is transient-retryable — a failed control barrier
      // (e.g. a plan that was not admitted) settles with a different
      // directive and must still block its fused frame.
      if (
        settlement.recovery.mutating === false
        && settlement.recovery.businessCall === false
        && settlement.physicalCrossingCount === 0
        && settlement.outcome.directive.action === 'retry_with_backoff'
      ) return 'zero_crossing';
      return 'effect_may_have_started';
    } catch {
      return 'effect_may_have_started';
    }
  };

  const dispositionResult = (input: {
    call: CanonicalHostCall;
    disposition: HostToolDisposition;
    frameDigest: string;
    frameIndex: number;
    frameSize: number;
    retired?: boolean;
    countsRefusal?: boolean;
    diagnostic?: string;
    repairKey?: string;
  }): AgentInputItem => {
    return buildHostToolDispositionResult({
      callId: input.call.callId,
      toolName: input.call.name,
      disposition: input.disposition,
      frameDigest: input.frameDigest,
      frameIndex: input.frameIndex,
      frameSize: input.frameSize,
      countsRefusal: input.countsRefusal,
      retired: input.retired,
      diagnostic: input.diagnostic,
      repairKey: input.repairKey,
    });
  };

  const executeCallAttempts = async (
    calls: readonly CanonicalHostCall[],
  ): Promise<Array<HostCallExecutionAttempt<ExecutedHostCall> | undefined>> => (
    mapHostCallAttemptsWithBarriersInOrder(
      calls,
      maxToolConcurrency,
      (call) => {
        const tool = toolByName.get(call.name);
        const argumentsJson = materializedArgumentsJson(tool, call.argumentsJson);
        const argumentsValue = parsedArgs(argumentsJson);
        if (!argumentsValue) return 'barrier';
        const effect = currentFrameEffects.get(call.callId)
          ?? classifyRuntimeToolEffect(call.name, argumentsValue).effect;
        return effect === 'read' || effect === 'compute' ? 'parallel' : 'barrier';
      },
      executeCallAttempt,
      (executed) => (executed.committedVerificationHolds?.length ?? 0) > 0,
    )
  );

  interface PairedCallAttempts {
    resultItems: AgentInputItem[];
    returned: ExecutedHostCall[];
    frameDigest: string;
    zeroCrossingRefusal: boolean;
    /** First host fault in the frame; the runner stops and explains after
     * the paired refusal is committed to canonical history. */
    hostFault?: HostFaultTerminal;
    effectUnknown: boolean;
    committedVerificationHolds: CommittedMutationVerificationHold[];
    toolCallsLimit?: ToolCallsLimitExceeded;
    durableContinuationPending?: { callId: string; reason: string };
  }

  const pairCallAttempts = (
    calls: readonly CanonicalHostCall[],
    attempts: readonly (HostCallExecutionAttempt<ExecutedHostCall> | undefined)[],
  ): PairedCallAttempts => {
    const frameDigest = semanticFrameDigest(calls);
    const durableContinuations = attempts.flatMap((attempt, index) => (
      attempt?.status === 'durable_continuation_pending'
        ? [{ callId: calls[index]!.callId, reason: attempt.error.reason }]
        : []
    ));
    const soleDurableContinuation = calls.length === 1 && durableContinuations.length === 1
      ? durableContinuations[0]!
      : undefined;
    const crossings = calls.map((call, index) => {
      const attempt = attempts[index];
      return attempt?.status === 'failed'
        ? failedCallCrossingDisposition(call, attempt)
        : null;
    });
    const toolCallsLimit = attempts.find(
      (attempt): attempt is Extract<HostCallExecutionAttempt<ExecutedHostCall>, { status: 'tool_calls_limit' }> =>
        attempt?.status === 'tool_calls_limit',
    )?.error;
    const settlementReconciliation = attempts.map((attempt) => (
      attempt?.status === 'returned'
      && attempt.value.settlementRequiresReconciliation === true
    ));
    const effectUnknown = crossings.some((crossing) => crossing === 'effect_may_have_started')
      || settlementReconciliation.some(Boolean)
      || (durableContinuations.length > 0 && soleDurableContinuation === undefined);
    const committedVerificationHolds = attempts.flatMap((attempt) => (
      attempt?.status === 'returned'
        ? [...(attempt.value.committedVerificationHolds ?? [])]
        : []
    ));
    const hostRefusals = attempts.map((attempt) => (
      attempt?.status === 'returned' && attempt.value.hostRefusal
        ? attempt.value.hostRefusal
        : null
    ));
    const hostFault = attempts.flatMap((attempt) => (
      attempt?.status === 'returned' && attempt.value.hostFault
        ? [attempt.value.hostFault]
        : []
    ))[0];
    const zeroCrossingRefusal = !effectUnknown
      && (crossings.some((crossing) => crossing === 'zero_crossing')
        || hostRefusals.some((refusal) => refusal !== null));
    let refusalMarkerWritten = false;
    const returned: ExecutedHostCall[] = [];
    const resultItems = calls.map((call, index): AgentInputItem | null => {
      const attempt = attempts[index];
      const hostRefusal = hostRefusals[index];
      if (attempt?.status === 'durable_continuation_pending' && soleDurableContinuation) {
        return null;
      }
      if (settlementReconciliation[index]) {
        return dispositionResult({
          call,
          disposition: 'effect_unknown',
          frameDigest,
          frameIndex: index,
          frameSize: calls.length,
        });
      }
      if (hostRefusal) {
        const countsRefusal = !effectUnknown && !refusalMarkerWritten;
        refusalMarkerWritten = true;
        return dispositionResult({
          call,
          disposition: 'refused_pre_dispatch',
          frameDigest,
          frameIndex: index,
          frameSize: calls.length,
          countsRefusal,
          diagnostic: hostRefusal,
        });
      }
      if (attempt?.status === 'returned') {
        returned.push(attempt.value);
        return attempt.value.historyItem;
      }
      if (!attempt || attempt.status === 'tool_calls_limit') {
        return dispositionResult({
          call,
          disposition: 'not_started',
          frameDigest,
          frameIndex: index,
          frameSize: calls.length,
        });
      }
      const crossing = crossings[index];
      if (crossing === 'zero_crossing') {
        const countsRefusal = !effectUnknown && !refusalMarkerWritten;
        refusalMarkerWritten = true;
        return dispositionResult({
          call,
          disposition: 'refused_pre_dispatch',
          frameDigest,
          frameIndex: index,
          frameSize: calls.length,
          countsRefusal,
        });
      }
      return dispositionResult({
        call,
        disposition: 'effect_unknown',
        frameDigest,
        frameIndex: index,
        frameSize: calls.length,
      });
    }).filter((item): item is AgentInputItem => item !== null);
    return {
      resultItems,
      returned,
      frameDigest,
      zeroCrossingRefusal,
      effectUnknown,
      committedVerificationHolds,
      ...(hostFault ? { hostFault } : {}),
      ...(toolCallsLimit ? { toolCallsLimit } : {}),
      ...(soleDurableContinuation
        ? { durableContinuationPending: soleDurableContinuation }
        : {}),
    };
  };

  const pairLocallyRefusedFrame = (
    calls: readonly CanonicalHostCall[],
    retired = false,
    // A plain string is the diagnostic alone; the object form also carries
    // the host-authored repair key of a schema refusal.
    diagnosticsByCallId?: ReadonlyMap<string, string | { diagnostic: string; repairKey?: string }>,
    countingCallIds?: ReadonlySet<string>,
  ): PairedCallAttempts => {
    const frameDigest = semanticFrameDigest(calls);
    const explicitCountingIndex = countingCallIds
      ? calls.findIndex((call) => countingCallIds.has(call.callId))
      : 0;
    const countingIndex = explicitCountingIndex < 0 && (countingCallIds?.size ?? 0) > 0
      ? 0
      : explicitCountingIndex;
    const repairFor = (callId: string): { diagnostic?: string; repairKey?: string } => {
      const entry = diagnosticsByCallId?.get(callId);
      if (!entry) return {};
      if (typeof entry === 'string') return { diagnostic: entry };
      return {
        ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
        ...(entry.repairKey ? { repairKey: entry.repairKey } : {}),
      };
    };
    return {
      frameDigest,
      zeroCrossingRefusal: true,
      effectUnknown: false,
      committedVerificationHolds: [],
      returned: [],
      resultItems: calls.map((call, index) => dispositionResult({
        call,
        disposition: 'refused_pre_dispatch',
        frameDigest,
        frameIndex: index,
        frameSize: calls.length,
        retired,
        // A typed repair_arguments preparation result is instruction for a
        // current capability, not evidence that the capability is absent.
        // The caller disables this marker for that exact recovery class.
        countsRefusal: index === countingIndex,
        ...repairFor(call.callId),
      })),
    };
  };

  /**
   * Every accepted call-bearing response is admitted before classification,
   * consent, preparation, or execution.  This is the common lifecycle parent
   * for local tools, host controls, external carriers, workflows, and
   * Spaces; result kind never decides whether the frame gets a checkpoint.
   */
  type OpenAcceptedToolFrame = {
    ref?: AcceptedModelBatchRef;
  };

  type AcceptedFrameAdmission =
    | { status: 'ready'; frame: OpenAcceptedToolFrame }
    | { status: 'held'; outcome: RunOutcome };

  const preAdmitAcceptedToolFrame = (input: {
    frameHistory: readonly AgentInputItem[];
    responseId?: string;
  }): AcceptedFrameAdmission => {
    if (!hostProduction) return { status: 'ready', frame: {} };
    const identity = exactHostIdentity();
    const request = {
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      preHistory: history,
      frameHistory: input.frameHistory,
      ...(lastResponseId ? { previousResponseId: lastResponseId } : {}),
      ...(input.responseId ? { providerResponseId: input.responseId } : {}),
    };
    let admitted = admitAcceptedModelBatch(request);
    if (admitted.status === 'unavailable') {
      // The retry is exact and idempotent.  No classification or body edge has
      // happened, so a transient local transaction failure cannot create a
      // duplicate effect.
      admitted = admitAcceptedModelBatch(request);
    }
    if (admitted.status === 'admitted' || admitted.status === 'existing') {
      return { status: 'ready', frame: { ref: admitted.admission } };
    }
    hostTurnLogger.error({
      status: admitted.status,
      reason: 'reason' in admitted ? admitted.reason : 'accepted model batch has no reference',
    }, 'accepted model batch pre-admission failed before tool execution');
    return {
      status: 'held',
      outcome: recoveryOutcome({
        phase: 'admit',
        baseHistory: [...history],
        frameHistory: input.frameHistory,
        responseId: input.responseId,
        reason: 'host_model_batch_admission_unavailable',
      }),
    };
  };

  type HostResultCommit =
    | { status: 'committed' }
    | {
        status: 'reconciliation_required';
        reason: 'host_result_checkpoint_reconciliation_required';
      }
    | {
        status: 'safe_stop';
        reason:
          | 'host_result_receipt_commit_failed'
          | 'host_result_checkpoint_unavailable'
          | 'host_result_checkpoint_mismatch';
      };

  const commitAcceptedToolFrameResults = (input: {
    frame: OpenAcceptedToolFrame;
    resultItems: readonly AgentInputItem[];
    expectedHistory: readonly AgentInputItem[];
  }): HostResultCommit => {
    if (!hostProduction || !input.frame.ref) return { status: 'committed' };
    const ref = input.frame.ref;
    const hostReceiptItems: AgentInputItem[] = [];
    for (const item of input.resultItems) {
      let projection = recordLogicalModelResultProjectionReceipt({
        admission: ref,
        resultItem: item,
      });
      if (projection.status === 'unavailable') {
        // Exact idempotent metadata insert/readback only.  Result bytes and
        // tool bodies already exist outside this retry and cannot re-enter.
        projection = recordLogicalModelResultProjectionReceipt({
          admission: ref,
          resultItem: item,
        });
      }
      if (projection.status === 'recorded' || projection.status === 'existing') {
        continue;
      }
      if (projection.status === 'not_applicable') {
        // Only a canonical host-authored no-effect result with no logical or
        // observer identity may use the older host receipt lane.  An ordinary
        // result missing its settlement is unavailable evidence, never an
        // ambient host result.
        if (!describeCanonicalHostModelResult(item)) {
          hostTurnLogger.error({ status: projection.status, reason: projection.reason },
            'non-logical model result is not an exact host projection');
          return { status: 'safe_stop', reason: 'host_result_receipt_commit_failed' };
        }
        hostReceiptItems.push(item);
        continue;
      }
      hostTurnLogger.error({
        status: projection.status,
        reason: 'reason' in projection
          ? projection.reason
          : 'logical result projection receipt did not settle',
      },
        'logical model result projection receipt is unavailable before checkpoint');
      return { status: 'safe_stop', reason: 'host_result_receipt_commit_failed' };
    }
    if (hostReceiptItems.length > 0) {
      let receiptError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          recordHostModelResultReceipts({ admission: ref, resultItems: hostReceiptItems });
          receiptError = undefined;
          break;
        } catch (error) {
          receiptError = error;
        }
      }
      if (receiptError !== undefined) {
        hostTurnLogger.error({
          err: receiptError instanceof Error
            ? { message: receiptError.message, stack: receiptError.stack }
            : String(receiptError),
        }, 'host model result receipt commit failed after exact retry');
        return { status: 'safe_stop', reason: 'host_result_receipt_commit_failed' };
      }
    }

    let finalized = finalizeAcceptedModelBatch(ref, { committedResultItems: input.resultItems });
    if (finalized.status !== 'committed' && finalized.status !== 'existing') {
      // A second exact finalization is a readback-safe retry only.  Tool bodies
      // are outside this block and can never be re-entered from bookkeeping.
      finalized = finalizeAcceptedModelBatch(ref, { committedResultItems: input.resultItems });
    }
    if (finalized.status !== 'committed' && finalized.status !== 'existing') {
      // Read back only.  Generic restart recovery is allowed to synthesize a
      // missing result from durable evidence; this live commit owns exact
      // already-built result bytes and must never replace them with a different
      // immutable checkpoint after a transient insert/readback error.
      const reopened = reopenAcceptedModelBatch(ref);
      if (reopened.status === 'checkpointed') {
        finalized = { status: 'existing', checkpoint: reopened.checkpoint };
      }
    }
    if (finalized.status !== 'committed' && finalized.status !== 'existing') {
      hostTurnLogger.error({
        status: finalized.status,
        reason: 'reason' in finalized
          ? finalized.reason
          : 'accepted model batch has no checkpoint',
      }, 'accepted model batch finalization failed after exact retry/readback');
      return { status: 'safe_stop', reason: 'host_result_checkpoint_unavailable' };
    }
    if (
      finalized.checkpoint.historyDigest
      !== acceptedModelBatchHistoryDigest(input.expectedHistory)
    ) {
      return {
        status: 'safe_stop',
        reason: 'host_result_checkpoint_mismatch',
      };
    }
    if (finalized.checkpoint.disposition !== 'ready') {
      return {
        status: 'reconciliation_required',
        reason: 'host_result_checkpoint_reconciliation_required',
      };
    }
    return { status: 'committed' };
  };

  let checkpointRecoveryFrameInProgress = false;
  const commitAdmittedToolFrame = (input: {
    acceptedFrame: OpenAcceptedToolFrame;
    frameHistory: readonly AgentInputItem[];
    resultItems?: readonly AgentInputItem[];
    responseId?: string;
  }): RunOutcome | undefined => {
    if (input.resultItems && input.resultItems.length > 0) {
      const committed = commitAcceptedToolFrameResults({
        frame: input.acceptedFrame,
        resultItems: input.resultItems,
        expectedHistory: [...history, ...input.frameHistory, ...input.resultItems],
      });
      if (committed.status === 'reconciliation_required') {
        // The checkpoint already sealed these exact balanced bytes.  Adopt
        // them into the public outcome before blocking, but never dispatch a
        // second model step for an uncertain effect.
        history.push(...input.frameHistory, ...input.resultItems);
        if (input.responseId !== undefined) lastResponseId = input.responseId;
        return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
      }
      if (committed.status === 'safe_stop') {
        return recoveryOutcome({
          phase: 'finalize',
          baseHistory: [...history],
          frameHistory: input.frameHistory,
          resultItems: input.resultItems,
          responseId: input.responseId,
          acceptedModelBatchRef: input.acceptedFrame.ref,
          reason: committed.reason,
        });
      }
    }
    history.push(...input.frameHistory, ...(input.resultItems ?? []));
    latestAcceptedModelBatchRef = input.acceptedFrame.ref;
    if (input.responseId !== undefined) lastResponseId = input.responseId;
    if (checkpointRecoveryFrameInProgress && (input.resultItems?.length ?? 0) > 0) {
      return recoveryContinuationOutcome(
        input.acceptedFrame.ref,
        'accepted_frame_checkpoint_recovered',
      );
    }
    return undefined;
  };

  const commitResultsForResumedFrame = (
    acceptedFrame: OpenAcceptedToolFrame,
    resultItems: readonly AgentInputItem[],
  ): RunOutcome | undefined => {
    const committed = commitAcceptedToolFrameResults({
      frame: acceptedFrame,
      resultItems,
      expectedHistory: [...history, ...resultItems],
    });
    if (committed.status === 'reconciliation_required') {
      // The paused frame is already in history; append only its exact sealed
      // results before returning the reconciliation-owned terminal.
      history.push(...resultItems);
      return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
    }
    if (committed.status === 'safe_stop') {
      const resultCallIds = new Set(resultItems.flatMap((item) => {
        const row = item as unknown as { type?: unknown; callId?: unknown };
        return row.type === 'function_call_result' && typeof row.callId === 'string'
          ? [row.callId]
          : [];
      }));
      const firstCallIndex = history.findIndex((item) => {
        const row = item as unknown as { type?: unknown; callId?: unknown };
        return row.type === 'function_call'
          && typeof row.callId === 'string'
          && resultCallIds.has(row.callId);
      });
      if (firstCallIndex < 0) {
        throw new HostCallAuthorityBoundaryError('resumed_host_result_call_lineage_missing');
      }
      let frameStart = firstCallIndex;
      while (frameStart > 0) {
        const prior = history[frameStart - 1] as unknown as { type?: unknown };
        if (prior.type !== 'reasoning') break;
        frameStart -= 1;
      }
      return recoveryOutcome({
        phase: 'finalize',
        baseHistory: history.slice(0, frameStart),
        frameHistory: history.slice(frameStart),
        resultItems,
        responseId: resumedResponseId,
        acceptedModelBatchRef: acceptedFrame.ref,
        reason: committed.reason,
      });
    }
    history.push(...resultItems);
    latestAcceptedModelBatchRef = acceptedFrame.ref;
    return undefined;
  };

  const recordZeroCrossingRefusal = (frameDigest: string): number => {
    const count = (zeroCrossingRefusalCounts.get(frameDigest) ?? 0) + 1;
    zeroCrossingRefusalCounts.set(frameDigest, count);
    if (count >= 2) retiredZeroCrossingFrames.add(frameDigest);
    return count;
  };

  const finalOutputFromToolBehavior = async (
    results: Awaited<ReturnType<typeof executeCall>>[],
  ): Promise<string | undefined> => {
    const callableResults = results
      .filter((result): result is typeof result & { tool: FunctionToolLike } => Boolean(result.tool))
      .map((result) => ({
        type: 'function_output' as const,
        tool: result.tool,
        output: result.output,
        runItem: { rawItem: result.historyItem },
        ...('argumentsJson' in result && typeof result.argumentsJson === 'string'
          ? { argumentsJson: result.argumentsJson }
          : {}),
      }));
    if (callableResults.length === 0) return undefined;
    const behavior = (agent as { toolUseBehavior?: unknown }).toolUseBehavior ?? 'run_llm_again';
    if (behavior === 'run_llm_again') return undefined;
    if (behavior === 'stop_on_first_tool') return resultText(callableResults[0]!.output);
    if (behavior && typeof behavior === 'object' && 'stopAtToolNames' in behavior) {
      const names = (behavior as { stopAtToolNames?: unknown }).stopAtToolNames;
      if (!Array.isArray(names)) return undefined;
      const stopped = callableResults.find((result) => names.includes(result.tool.name));
      return stopped ? resultText(stopped.output) : undefined;
    }
    if (typeof behavior === 'function') {
      const decision = await (behavior as (
        context: RunContext<unknown>,
        toolResults: unknown[],
      ) => Promise<{
        isFinalOutput: boolean;
        isInterrupted?: boolean;
        finalOutput?: unknown;
      }> | {
        isFinalOutput: boolean;
        isInterrupted?: boolean;
        finalOutput?: unknown;
      })(runContext, callableResults);
      if (decision.isInterrupted) {
        throw new Error('Host toolUseBehavior returned an interruption after tool execution.');
      }
      return decision.isFinalOutput ? resultText(decision.finalOutput) : undefined;
    }
    throw new Error('Invalid agent toolUseBehavior.');
  };

  const terminalBehaviorEligibleMixedResults = (
    results: readonly ExecutedHostCall[],
  ): boolean => results.length > 0 && results.every(
    (result) => result.effect === 'read' || result.effect === 'compute',
  );

  const executeCalls = async (
    calls: readonly CanonicalHostCall[],
  ): Promise<PairedCallAttempts> => {
    // A model response may mix independent reads with stateful effects. Only
    // calls the host can prove read/compute share the bounded pool; mutations,
    // host controls and unknowns are exclusive barriers. Every started outcome
    // and every provably unstarted sibling is retained, then paired in model
    // order before this frame can enter canonical history.
    return pairCallAttempts(calls, await executeCallAttempts(calls));
  };

  type FreshPlanReadFrame = Extract<
    HostModelFrameDisposition,
    { kind: 'fresh_plan_then_root_read' }
  >;

  type HostOwnedSingleActionFrame = Extract<
    HostModelFrameDisposition,
    { kind: 'host_owned_single_action_plan' }
  >;

  const activatedSingleActionRequirement = (
    frame: HostOwnedSingleActionFrame,
  ): boolean => {
    try {
      const identity = exactHostIdentity();
      if (
        !actionExpectedWorkRequired(identity)
        || !settledFreshPlanControl(identity)
      ) return false;
      const loaded = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
      if (loaded.status !== 'ok' || loaded.contract.operations.length !== 1) return false;
      const operation = loaded.contract.operations[0]!;
      return operation.id === frame.requirementId
        && operation.effect === frame.effect
        && operation.dependsOn.length === 0
        && operation.dataFrom.length === 0
        && operation.cardinality.kind === 'once';
    } catch {
      return false;
    }
  };

  /** Compile the sole exact Auto candidate by invoking the configured
   * plan_task object as an internal control. The synthetic result never enters
   * model history; its ordinary durable logical settlement/preamble/activation
   * receipts are the only facts that may phase the host surface. */
  const activateHostOwnedSingleActionPlan = async (
    frame: HostOwnedSingleActionFrame,
  ): Promise<boolean> => {
    const workTool = toolByName.get(frame.call.name);
    const outerArgs = frame.call.argumentsValue;
    if (!workTool || !outerArgs || !freshPlanControlConfigured()) return false;
    const identity = exactHostIdentity();
    const resolved = await resolveHostSingleActionPlanCapability(workTool, {
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      requirementId: frame.requirementId,
      operationId: frame.call.effectiveName ?? '',
      effect: frame.effect,
      outerArgs,
    });
    if (!resolved) return false;
    const planInput = hostSingleActionPlanTaskInput(resolved);
    if (!planInput) return false;
    const planTool = toolByName.get('plan_task');
    if (!planTool) return false;
    const logicalToolCallId = `host-auto-plan-${createHash('sha256')
      .update(JSON.stringify({
        version: 1,
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        capabilityRef: resolved.capabilityRef,
        operationId: resolved.operationId,
        effect: resolved.effect,
      }), 'utf8')
      .digest('hex')}`;
    const planCall: CanonicalHostCall = {
      callId: logicalToolCallId,
      name: 'plan_task',
      argumentsJson: JSON.stringify(planInput),
    };
    let planReady = false;
    try {
      const exactPlan = exactProductionHostCall(
        planCall.name,
        planInput,
        planCall.argumentsJson,
        planTool,
        planCall.callId,
        runContext,
        {
          toolCall: {
            type: 'function_call',
            callId: planCall.callId,
            name: planCall.name,
            arguments: planCall.argumentsJson,
          },
        },
      );
      planReady = Boolean(
        exactPlan
        && exactPlan.effect === 'host_only'
        && exactPlan.boundary === 'host_owned_local',
      );
      if (planReady && typeof planTool.needsApproval === 'function') {
        planReady = await planTool.needsApproval(
          runContext,
          planInput,
          planCall.callId,
        ) !== true;
      }
    } catch {
      planReady = false;
    }
    if (!planReady) return false;
    const attempt = await executeCallAttempt(planCall);
    return attempt.status === 'returned'
      && !attempt.value.hostRefusal
      && activatedSingleActionRequirement(frame);
  };

  const activatedRootRequirement = (
    frame: FreshPlanReadFrame,
    exact: ExactProductionHostCall,
  ): boolean => {
    try {
      const identity = exactHostIdentity();
      if (
        !actionExpectedWorkRequired(identity)
        || !settledFreshPlanControl(identity)
      ) return false;
      const loaded = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
      if (loaded.status !== 'ok') return false;
      const operation = loaded.contract.operations.filter((candidate) => (
        candidate.id === frame.requirementId
      ));
      if (operation.length !== 1) return false;
      const root = operation[0]!;
      return (root.effect === 'read' || root.effect === 'compute')
        && root.effect === frame.prePlanEffect
        && root.effect === exact.effect
        && root.dependsOn.length === 0
        && root.dataFrom.length === 0
        && exact.logicalToolName === frame.sibling.effectiveName;
    } catch {
      return false;
    }
  };

  /** The one sanctioned two-call control frame. plan_task is executed as a
   * true barrier; only its complete synchronous settlement/delivery/activation
   * makes the sibling eligible for a fresh approval and exact-binding scan.
   * No pre-plan sibling predicate or logical-call admission runs. */
  const executeFreshPlanThenRootRead = async (
    frame: FreshPlanReadFrame,
  ): Promise<PairedCallAttempts> => {
    const calls: readonly CanonicalHostCall[] = [frame.plan, frame.sibling];
    let planTool: FunctionToolLike | undefined;
    let planArgs: Record<string, unknown> | null = null;
    let planReady = false;
    try {
      planTool = toolByName.get(frame.plan.name);
      planArgs = frame.plan.argumentsValue;
      const planToolCall = {
        type: 'function_call' as const,
        callId: frame.plan.callId,
        name: frame.plan.name,
        arguments: frame.plan.argumentsJson,
      };
      const exactPlan = exactProductionHostCall(
        frame.plan.name,
        planArgs,
        frame.plan.argumentsJson,
        planTool,
        frame.plan.callId,
        runContext,
        { toolCall: planToolCall },
      );
      planReady = Boolean(
        planTool
        && planArgs
        && exactPlan
        && exactPlan.effect === 'host_only'
        && exactPlan.boundary === 'host_owned_local',
      );
      if (planReady && typeof planTool?.needsApproval === 'function') {
        planReady = await planTool.needsApproval(
          runContext,
          planArgs!,
          frame.plan.callId,
        ) !== true;
      }
    } catch {
      planReady = false;
    }
    if (!planReady) {
      const reason = lastExactProductionMiss || 'plan_control_approval_unavailable';
      return pairLocallyRefusedFrame(
        calls,
        false,
        new Map([[frame.plan.callId,
          `The exact host plan control was refused before dispatch (${reason}). No provider call was attempted.`]]),
      );
    }

    const planAttempt = await executeCallAttempt(frame.plan);
    if (planAttempt.status !== 'returned') {
      return pairCallAttempts(calls, [planAttempt, undefined]);
    }

    let siblingReady = false;
    try {
      const siblingTool = toolByName.get(frame.sibling.name);
      const siblingArgs = frame.sibling.argumentsValue;
      const siblingToolCall = {
        type: 'function_call' as const,
        callId: frame.sibling.callId,
        name: frame.sibling.name,
        arguments: frame.sibling.argumentsJson,
      };
      let exactSibling = exactProductionHostCall(
        frame.sibling.name,
        siblingArgs,
        frame.sibling.argumentsJson,
        siblingTool,
        frame.sibling.callId,
        runContext,
        { toolCall: siblingToolCall },
      );
      siblingReady = Boolean(
        siblingTool
        && siblingArgs
        && exactSibling
        && exactSibling.effect === frame.prePlanEffect
        && (exactSibling.effect === 'read' || exactSibling.effect === 'compute')
        && activatedRootRequirement(frame, exactSibling),
      );
      if (siblingReady && exactSibling && siblingArgs) {
        const identity = exactHostIdentity();
        const materialGate = exactMaterialSourceGate({
          exactProduction: exactSibling,
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
        });
        siblingReady = materialGate.status !== 'refused';
        if (
          siblingReady
          && (
            isDelegationPrimitiveRuntimeCall(frame.sibling.name, siblingArgs)
            || isUnscopedShellRuntimeCall(frame.sibling.name, siblingArgs)
          )
        ) {
          siblingReady = inspectDurableMaterialSourceContinuation({
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
          }).status === 'not_applicable';
        }
        if (siblingReady && typeof siblingTool?.needsApproval === 'function') {
          siblingReady = await siblingTool.needsApproval(
            runContext,
            siblingArgs,
            frame.sibling.callId,
          ) !== true;
        }
        // Re-prove after the awaited approval predicate and immediately before
        // the invocation seam. This grants no execution; it only decides
        // whether the sibling can proceed to the common crossing owner.
        if (siblingReady) {
          exactSibling = exactProductionHostCall(
            frame.sibling.name,
            siblingArgs,
            frame.sibling.argumentsJson,
            siblingTool,
            frame.sibling.callId,
            runContext,
            { toolCall: siblingToolCall },
          );
          siblingReady = Boolean(
            exactSibling
            && exactSibling.effect === frame.prePlanEffect
            && activatedRootRequirement(frame, exactSibling),
          );
        }
      }
    } catch {
      siblingReady = false;
    }
    if (!siblingReady) {
      return pairCallAttempts(calls, [
        planAttempt,
        { status: 'failed', error: undefined, invocationEntered: false },
      ]);
    }

    const siblingAttempt = await executeCallAttempt(frame.sibling);
    return pairCallAttempts(calls, [planAttempt, siblingAttempt]);
  };

  let recoveredToolFrame = resumedRecoveryState?.phase === 'admit'
    ? {
        history: resumedRecoveryState.frameHistory,
        calls: resumedRecoveryState.frameHistory.flatMap((item) => {
          const row = item as unknown as {
            type?: unknown;
            callId?: unknown;
            name?: unknown;
            arguments?: unknown;
          };
          return row.type === 'function_call'
            && typeof row.callId === 'string'
            && typeof row.name === 'string'
            && typeof row.arguments === 'string'
            ? [{
                callId: row.callId,
                name: row.name,
                argumentsJson: row.arguments,
              }]
            : [];
        }),
        responseId: resumedRecoveryState.responseId,
      }
    : undefined;
  let recoveredAcceptedFrame: OpenAcceptedToolFrame | undefined;
  if (recoveredToolFrame) {
    const preAdmission = preAdmitAcceptedToolFrame({
      frameHistory: recoveredToolFrame.history,
      responseId: recoveredToolFrame.responseId,
    });
    if (preAdmission.status === 'held') return preAdmission.outcome;
    recoveredAcceptedFrame = preAdmission.frame;
  }

  if (resumedRecoveryState?.phase === 'finalize') {
    const ref = resumedRecoveryState.acceptedModelBatchRef!;
    const openHistory = [...history, ...resumedRecoveryState.frameHistory];
    const expectedHistory = [...openHistory, ...resumedRecoveryState.resultItems];
    let reopened = reopenAcceptedModelBatch(ref, { openHistory });
    if (reopened.status === 'unavailable') {
      reopened = reopenAcceptedModelBatch(ref, { openHistory });
    }
    if (reopened.status === 'checkpointed') {
      if (reopened.checkpoint.disposition === 'reconciliation_required') {
        // The reconciliation checkpoint already owns one exact balanced
        // call/result transcript.  Recovery must expose those sealed bytes to
        // the caller before returning the block; otherwise a restart appears
        // to lose the result even though the durable checkpoint retained it.
        history.splice(0, history.length, ...reopened.checkpoint.history);
        lastResponseId = reopened.checkpoint.lastResponseId ?? lastResponseId;
        return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
      }
      if (
        reopened.checkpoint.historyDigest
        !== acceptedModelBatchHistoryDigest(expectedHistory)
      ) {
        return recoveryOutcome({
          phase: 'finalize',
          baseHistory: [...history],
          frameHistory: resumedRecoveryState.frameHistory,
          resultItems: resumedRecoveryState.resultItems,
          responseId: resumedRecoveryState.responseId,
          acceptedModelBatchRef: ref,
          stepIndexOverride: resumedRecoveryState.stepIndex,
          reason: 'host_result_checkpoint_mismatch',
        });
      }
      history.splice(0, history.length, ...reopened.checkpoint.history);
      lastResponseId = reopened.checkpoint.lastResponseId ?? lastResponseId;
    } else if (reopened.status === 'open') {
      const committed = commitAcceptedToolFrameResults({
        frame: { ref },
        resultItems: resumedRecoveryState.resultItems,
        expectedHistory,
      });
      if (committed.status === 'reconciliation_required') {
        history.splice(0, history.length, ...expectedHistory);
        if (resumedRecoveryState.responseId !== undefined) {
          lastResponseId = resumedRecoveryState.responseId;
        }
        return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
      }
      if (committed.status === 'safe_stop') {
        return recoveryOutcome({
          phase: 'finalize',
          baseHistory: [...history],
          frameHistory: resumedRecoveryState.frameHistory,
          resultItems: resumedRecoveryState.resultItems,
          responseId: resumedRecoveryState.responseId,
          acceptedModelBatchRef: ref,
          stepIndexOverride: resumedRecoveryState.stepIndex,
          reason: committed.reason,
        });
      }
      history.push(...resumedRecoveryState.frameHistory, ...resumedRecoveryState.resultItems);
      if (resumedRecoveryState.responseId !== undefined) {
        lastResponseId = resumedRecoveryState.responseId;
      }
    } else {
      return recoveryOutcome({
        phase: 'finalize',
        baseHistory: [...history],
        frameHistory: resumedRecoveryState.frameHistory,
        resultItems: resumedRecoveryState.resultItems,
        responseId: resumedRecoveryState.responseId,
        acceptedModelBatchRef: ref,
        stepIndexOverride: resumedRecoveryState.stepIndex,
        reason: 'reason' in reopened ? reopened.reason : 'accepted batch reopen unavailable',
      });
    }
    return recoveryContinuationOutcome(ref, 'accepted_result_checkpoint_recovered');
  }

  // Resume: settle the user's decisions FIRST — the approved tool executes
  // exactly once, a rejection becomes a visible tool result, and only then
  // may the model take its next step. There is no replay path here, so an
  // approved external write can never fire twice from this runner.
  let resumedAcceptedFrame: OpenAcceptedToolFrame = {
    ...(resumedAcceptedModelBatchRef ? { ref: resumedAcceptedModelBatchRef } : {}),
  };
  let resumedAdmissionCallIds: readonly string[] | undefined;
  let resumedFrameArgumentsEdited = false;
  if (hostProduction && pendingFromResume.length > 0) {
    if (resumedAcceptedFrame.ref) {
      let reopened = reopenAcceptedModelBatch(resumedAcceptedFrame.ref, { openHistory: history });
      if (reopened.status === 'unavailable') {
        reopened = reopenAcceptedModelBatch(resumedAcceptedFrame.ref, { openHistory: history });
      }
      if (reopened.status === 'checkpointed') {
        if (reopened.checkpoint.disposition === 'reconciliation_required') {
          history.splice(0, history.length, ...reopened.checkpoint.history);
          lastResponseId = reopened.checkpoint.lastResponseId ?? lastResponseId;
          return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
        }
        history.splice(0, history.length, ...reopened.checkpoint.history);
        lastResponseId = reopened.checkpoint.lastResponseId ?? lastResponseId;
        pendingFromResume = [];
      } else if (reopened.status !== 'open') {
        hostTurnLogger.error({
          status: reopened.status,
          reason: reopened.reason,
        }, 'paused accepted model batch could not be reopened before approval resume');
        return approvalRecoveryOutcome(
          'host_result_checkpoint_unavailable',
          resumedAcceptedFrame.ref,
        );
      } else {
        resumedAdmissionCallIds = reopened.admission.callIds;
      }
    } else {
      // V1–V4 compatibility: those blobs predate the out-of-band batch ref.
      // Reconstruct the exact call-bearing tail and admit it now, still before
      // approval revalidation, preparation, or body execution.
      const pendingIds = new Set(pendingFromResume.map((pending) => pending.callId));
      const firstCallIndex = history.findIndex((item) => {
        const row = item as unknown as { type?: unknown; callId?: unknown };
        return row.type === 'function_call'
          && typeof row.callId === 'string'
          && pendingIds.has(row.callId);
      });
      if (firstCallIndex < 0) {
        throw new HostCallAuthorityBoundaryError('resumed_host_result_call_lineage_missing');
      }
      let frameStart = firstCallIndex;
      while (frameStart > 0) {
        const prior = history[frameStart - 1] as unknown as { type?: unknown };
        if (prior.type !== 'reasoning') break;
        frameStart -= 1;
      }
      const identity = exactHostIdentity();
      const request = {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        preHistory: history.slice(0, frameStart),
        frameHistory: history.slice(frameStart),
        ...(lastResponseId ? { providerResponseId: lastResponseId } : {}),
      };
      let admitted = admitAcceptedModelBatch(request);
      if (admitted.status === 'unavailable') admitted = admitAcceptedModelBatch(request);
      if (admitted.status !== 'admitted' && admitted.status !== 'existing') {
        const spend = spendCheckpointRetryBudget(request.frameHistory, 'admit');
        hostTurnLogger.error({
          status: admitted.status,
          reason: 'reason' in admitted ? admitted.reason : 'accepted model batch has no reference',
          attempt: spend.count,
          budget: EXACT_CHECKPOINT_REENTRY_BUDGET,
        },
          'legacy paused frame could not be pre-admitted before approval resume');
        // Same shared budget as the common path above: this entry point reaches
        // the identical failure without passing through preAdmitAcceptedToolFrame.
        if (spend.exhausted) {
          return blockedOutcome(
            HOST_CHECKPOINT_ADMISSION_EXHAUSTED_BLOCKED_TEXT,
            'exact_checkpoint_admission_exhausted',
          );
        }
        return approvalRecoveryOutcome('host_model_batch_admission_unavailable');
      }
      resumedAcceptedFrame = { ref: admitted.admission };
      resumedAdmissionCallIds = admitted.admission.callIds;
    }

    if (pendingFromResume.length > 0) {
      const callIds = resumedAdmissionCallIds ?? [];
      const admittedCalls = callIds.map((callId) => history.filter((item) => {
        const row = item as unknown as { type?: unknown; callId?: unknown };
        return row.type === 'function_call' && row.callId === callId;
      }));
      if (
        callIds.length !== pendingFromResume.length
        || admittedCalls.some((matches) => matches.length !== 1)
      ) {
        return approvalRecoveryOutcome(
          'host_result_checkpoint_mismatch',
          resumedAcceptedFrame.ref,
        );
      }
      for (let index = 0; index < pendingFromResume.length; index += 1) {
        const pending = pendingFromResume[index]!;
        const admitted = admittedCalls[index]![0] as unknown as {
          callId?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (
          pending.callId !== callIds[index]
          || pending.rawItem.callId !== admitted.callId
          || pending.name !== admitted.name
          || pending.rawItem.name !== admitted.name
        ) {
          return approvalRecoveryOutcome(
            'host_result_checkpoint_mismatch',
            resumedAcceptedFrame.ref,
          );
        }
        if (pending.rawItem.arguments !== admitted.arguments) {
          // An approval edit is input for a NEW model frame, not authority to
          // execute different bytes under the old accepted batch.  Pair the
          // old frame as no-effect below and let the model reissue the edit.
          resumedFrameArgumentsEdited = true;
          pendingHostModelDirective = [
            'APPROVAL EDIT — the user changed the arguments after the prior model frame was admitted.',
            `Issue one fresh ${pending.name} call with these exact approved argument bytes: ${pending.rawItem.arguments}`,
            'Do not reuse the prior call id.',
          ].join(' ');
          pending.rawItem.arguments = String(admitted.arguments);
        }
      }
    }
  }
  let resumeSurfaceFallback = false;
  const settlePendingCallBeforeDispatch = (
    pending: PendingHostCall,
    reason: string,
  ): boolean => {
    try {
      const identity = exactHostIdentity();
      const acceptedTaskId = acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq);
      const row = openEventLog().prepare(`
        SELECT accepted_task_id, tool_name, argument_digest, state
          FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(identity.sessionId, identity.sourceUserSeq, pending.callId) as {
        accepted_task_id: string;
        tool_name: string;
        argument_digest: string;
        state: 'open' | 'settled';
      } | undefined;
      // A call refused before the common logical admission wall is owned by
      // the host-result receipt lane. There is no durable identity to settle.
      if (!row) return true;
      if (row.accepted_task_id !== acceptedTaskId) return false;
      if (row.state === 'settled') return true;
      if (row.state !== 'open') return false;
      const args = parsedArgs(pending.rawItem.arguments);
      if (!args) return false;
      // Reconstruct only the contract already present in the accepted outer
      // bytes. This handles direct calls and trusted work_call/provider-gateway
      // carriers without consulting a refreshed tool surface or inventing new
      // provider arguments after an approval pause.
      const recovery = durableLogicalCallRecoveryMaterial(
        acceptedTaskId,
        pending.name,
        args,
      );
      if (
        !recovery
        || recovery.toolName !== row.tool_name
        || recovery.argumentDigest !== row.argument_digest
      ) return false;
      const work = loadExpectedWorkCallBindingState({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        logicalToolCallId: pending.callId,
      });
      const effect = work.status === 'ok'
        ? work.binding.effect
        : classifyRuntimeToolEffect(recovery.toolName, recovery.args).effect;
      settleAdmittedLogicalCallPreDispatchRefusal({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        logicalToolCallId: pending.callId,
        toolName: recovery.toolName,
        args: recovery.args,
        lane: 'agents_runner',
        mutating: effect === 'local_write'
          || effect === 'external_write'
          || effect === 'admin',
        reason,
      });
      return true;
    } catch {
      return false;
    }
  };
  if (resumedToolSurfaceUnavailable) {
    const calls = pendingFromResume.map((pending): CanonicalHostCall => ({
      callId: pending.callId,
      name: pending.name,
      argumentsJson: pending.rawItem.arguments,
    }));
    if (calls.length > 0) {
      const settled = pendingFromResume.every((pending) => (
        settlePendingCallBeforeDispatch(pending, 'approved_tool_surface_unavailable_before_dispatch')
      ));
      if (!settled) {
        return approvalRecoveryOutcome(
          'resumed_pre_dispatch_settlement_unavailable',
          resumedAcceptedFrame.ref,
        );
      }
      const paired = pairLocallyRefusedFrame(calls);
      const resultCommitBlock = commitResultsForResumedFrame(
        resumedAcceptedFrame,
        paired.resultItems,
      );
      if (resultCommitBlock) return resultCommitBlock;
      recordZeroCrossingRefusal(paired.frameDigest);
    }
    pendingFromResume = [];
    resumeSurfaceFallback = true;
  }
  const undecidedOnResume = pendingFromResume.filter((pending) => !pending.decision);
  if (undecidedOnResume.length > 0) {
    // Do not partially settle a paused batch. In particular, executing an
    // already-approved/non-approval sibling before returning another pause
    // would replay that sibling on the next resume.
    const interruptions: InterruptionInfo[] = undecidedOnResume.map((pending) => ({
      toolName: pending.name,
      args: parsedArgs(pending.rawItem.arguments),
      rawArgs: pending.rawItem.arguments,
      ...(pending.consentSubject
        ? {
            approvalResumeKey: hostInteractiveConsentApprovalResumeKey(pending.consentSubject)
              ?? undefined,
          }
        : {}),
    }));
    return {
      history,
      lastResponseId,
      finalOutput: undefined,
      hasInterruptions: true,
      interruptions,
      serializedState: new HostInterruptState(
        history,
        pendingFromResume,
        lastResponseId,
        hostTurnEngine ?? 'host_v1_read_only',
        currentNoProgressCheckpoint(),
        resumedAcceptedFrame.ref,
      ).toString(),
    } satisfies RunOutcome;
  }
  if (pendingFromResume.length > 0) {
    const calls = pendingFromResume.map((pending): CanonicalHostCall => ({
      callId: pending.callId,
      name: pending.name,
      argumentsJson: pending.rawItem.arguments,
    }));

    const preparedMutations: Array<{ pending: PendingHostCall; preparation: object }> = [];
    let resumeFrameRepair = resumedFrameArgumentsEdited;
    let resumeFrameRejected = pendingFromResume.some((pending) => pending.decision === 'rejected');

    // Every mutation in a paused frame is re-materialized under the original
    // accepted source. Process-local nested tokens intentionally do not
    // survive serialization, including tokens for ordinary siblings that did
    // not themselves prompt. Scan/evaluate the whole frame before any body so
    // a later mismatch cannot leave an earlier sibling partially executed.
    for (const pending of pendingFromResume) {
      const tool = toolByName.get(pending.name);
      let argumentsJson = pending.rawItem.arguments;
      let args: Record<string, unknown> | null = null;
      try {
        argumentsJson = materializedArgumentsJson(tool, argumentsJson);
        args = parsedArgs(argumentsJson);
      } catch {
        resumeFrameRepair = true;
        break;
      }
      const effect = args ? classifyRuntimeToolEffect(pending.name, args).effect : 'unknown';
      const mutation = effect === 'local_write' || effect === 'external_write' || effect === 'admin';
      if (!mutation) continue;
      // Legacy/non-production HostInterruptState remains a pure SDK resume:
      // it has no accepted source or durable logical row to re-materialize.
      // A rejection is still paired visibly below and never executes a body.
      if (!hostProduction) continue;
      if (!tool || !args) {
        resumeFrameRepair = true;
        break;
      }

      const identity = exactHostIdentity();
      const acceptedTaskId = acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq);
      const currentContract = durableLogicalCallContract(acceptedTaskId, pending.name, args);
      const priorSettlement = redeemDurableLogicalCallSettlementForHost({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId: pending.callId,
      });
      const exactSettledReplay = priorSettlement.status === 'ok'
        && currentContract !== null
        && currentContract.toolName === priorSettlement.settlement.toolName
        && currentContract.argumentDigest === priorSettlement.settlement.argumentDigest;
      const matchingApprovalIds = pending.consentSubject
        ? [...hostApprovalIds].filter((approvalId) => (
            durableHostApprovalResolutionMatches({
              approvalId,
              persistedSubject: pending.consentSubject!,
              outerToolName: pending.name,
              outerRawArguments: argumentsJson,
            })
          ))
        : [];
      const exactApprovalId = matchingApprovalIds.length === 1
        ? matchingApprovalIds[0]!
        : null;
      // A V3 high-consequence call may be re-prepared only after its durable
      // approval row has independently reproduced the persisted subject and
      // the current raw outer payload. Edited arguments, an expired/rejected
      // row, or a sibling approval ID therefore become one paired model
      // repair before we try to reopen the old logical identity. Reopening
      // first would turn an ordinary scope change into an authority-conflict
      // terminal even though physical I/O is still provably zero.
      if (
        pending.consentSubject
        && pending.decision === 'approved'
        && !exactApprovalId
      ) {
        resumeFrameRepair = true;
        break;
      }
      if (exactSettledReplay) {
        continue;
      }

      const exactProduction = exactProductionHostCall(
        pending.name,
        args,
        argumentsJson,
        tool,
        pending.callId,
        runContext,
        {
          toolCall: {
            type: 'function_call',
            callId: pending.callId,
            name: pending.name,
            arguments: argumentsJson,
          },
        },
      );
      if (
        !exactProduction
        || !isPlainOrClementineLocalTool(pending.name, 'work_call')
        || !isHostPlanRequiredWorkCall(tool)
      ) {
        resumeFrameRepair = true;
        break;
      }
      const prepared = await withHostCallAttestation(
        exactProduction.attestation,
        () => prepareHostWorkCall(tool, {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          logicalToolCallId: pending.callId,
          outerArgs: args!,
          runContext,
          details: {
            toolCall: {
              type: 'function_call',
              callId: pending.callId,
              name: pending.name,
              arguments: argumentsJson,
            },
          },
        }),
      );
      if (prepared.status !== 'prepared') {
        resumeFrameRepair = true;
        break;
      }
      preparedMutations.push({ pending, preparation: prepared.preparation });

      if (pending.decision === 'rejected') continue;
      const consent = await evaluatePreparedHostWorkCallConsent({
        preparation: prepared.preparation,
        ...(pending.consentSubject && exactApprovalId
          ? {
              durableApproval: {
                approvalId: exactApprovalId,
                persistedSubject: pending.consentSubject,
                outerToolName: pending.name,
                outerRawArguments: argumentsJson,
              },
            }
          : {}),
      });
      if (
        consent.status !== 'decided'
        || consent.decision.kind !== 'proceed'
        || (pending.consentSubject && consent.decision.basis !== 'exact_user_grant')
      ) {
        resumeFrameRepair = true;
        break;
      }
      if (consent.nestedAdmission) {
        nestedCallAdmissions.set(pending.callId, consent.nestedAdmission);
      }
    }

    if (resumeFrameRepair || resumeFrameRejected) {
      const released = !hostProduction || (preparedMutations.every(({ preparation }) => (
        releasePreparedHostWorkCallForRepair(
          preparation,
          resumeFrameRejected
            ? 'user_rejected_before_dispatch'
            : 'approval_scope_changed_before_dispatch',
        )
      )) && pendingFromResume.every((pending) => (
        settlePendingCallBeforeDispatch(
          pending,
          resumeFrameRejected
            ? 'user_rejected_before_dispatch'
            : 'approval_scope_changed_before_dispatch',
        )
      )));
      for (const pending of pendingFromResume) nestedCallAdmissions.delete(pending.callId);
      if (!released) {
        return approvalRecoveryOutcome(
          'resumed_prepared_frame_release_failed',
          resumedAcceptedFrame.ref,
        );
      }
      if (resumeFrameRejected && !resumeFrameRepair) {
        const frameDigest = semanticFrameDigest(calls);
        const resultCommitBlock = commitResultsForResumedFrame(
          resumedAcceptedFrame,
          pendingFromResume.map((pending, index) => (
            pending.decision === 'rejected'
              ? buildUserRejectedHostResult(pending.callId, pending.name)
              : dispositionResult({
                  call: calls[index]!,
                  disposition: 'not_started',
                  frameDigest,
                  frameIndex: index,
                  frameSize: calls.length,
                })
          )),
        );
        if (resultCommitBlock) return resultCommitBlock;
      } else {
        const paired = pairLocallyRefusedFrame(calls);
        const resultCommitBlock = commitResultsForResumedFrame(
          resumedAcceptedFrame,
          paired.resultItems,
        );
        if (resultCommitBlock) return resultCommitBlock;
        recordZeroCrossingRefusal(paired.frameDigest);
      }
      pendingFromResume = [];
    }

    if (pendingFromResume.length === 0) {
      // The paired rejection/repair is ordinary model input; continue below.
    } else {
      const approvedAttempts = await executeCallAttempts(calls);
      const paired = pairCallAttempts(calls, approvedAttempts);
      const resultCommitBlock = commitResultsForResumedFrame(
        resumedAcceptedFrame,
        paired.resultItems,
      );
      if (resultCommitBlock) return resultCommitBlock;
      if (paired.committedVerificationHolds.length > 0) {
        return committedVerificationHoldOutcome(
          paired.committedVerificationHolds,
          resumedAcceptedFrame.ref,
        );
      }
      if (paired.effectUnknown) {
        return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
      }
      if (paired.toolCallsLimit) propagateToolCallsLimit(paired.toolCallsLimit);
      if (paired.zeroCrossingRefusal) recordZeroCrossingRefusal(paired.frameDigest);
      if (paired.hostFault) return blockedOutcome(paired.hostFault.text, paired.hostFault.reason, false);
      const finalOutput = !paired.zeroCrossingRefusal
        || terminalBehaviorEligibleMixedResults(paired.returned)
        ? await finalOutputFromToolBehavior(paired.returned)
        : undefined;
      if (finalOutput !== undefined) return await completedOutcome(finalOutput);
    }
  }

  if (hostProduction && !resumedHostState && !resumedRecoveryState) {
    let namedWorkflowDispatchInput: {
      sessionId: string;
      sourceUserSeq: number;
      userText: string;
    } | null = null;
    try {
      const identity = exactHostIdentity();
      const accepted = listEvents(identity.sessionId, {
        sinceSeq: identity.sourceUserSeq - 1,
        types: ['user_input_received'],
        limit: 1,
      }).find((event) => event.seq === identity.sourceUserSeq);
      const display = typeof accepted?.data.displayText === 'string'
        ? accepted.data.displayText.trim()
        : '';
      const text = typeof accepted?.data.text === 'string' ? accepted.data.text.trim() : '';
      const userText = display || text;
      if (userText) {
        namedWorkflowDispatchInput = {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          userText,
        };
      }
    } catch {
      // Isolated runner fixtures have no accepted-source identity.
    }
    if (namedWorkflowDispatchInput) {
      // Queue preparation is a durable side effect. Keep it and the terminal
      // projection outside the identity-probe catch: once the shared workflow
      // admission path wins, an output/settlement failure must propagate into
      // recovery rather than fall through to a second model/dispatch attempt.
      const uniqueDispatch = tryHostDispatchNamedWorkflow({
        ...namedWorkflowDispatchInput,
        route: 'act',
      });
      if (uniqueDispatch.status === 'dispatched' || uniqueDispatch.status === 'blocked') {
        return await completedOutcome(uniqueDispatch.message);
      }
    }
  }

  let remainingPreContentStallRetries = modelStreamStallRetries();
  let committedVerificationRecoveryChecked = false;
  for (let stepIndex = currentHostStepIndex; ; stepIndex += 1) {
    currentHostStepIndex = stepIndex;
    const recoveryFrameThisStep = recoveredToolFrame;
    const consumingRecoveredFrame = recoveryFrameThisStep !== undefined;
    checkpointRecoveryFrameInProgress = consumingRecoveredFrame;
    if (!consumingRecoveredFrame && stepIndex >= maxTurns) {
      return blockedOutcome(HOST_MODEL_LIMIT_BLOCKED_TEXT, 'max_turns');
    }
    try {
      await refreshTools();
    } catch (error) {
      if (consumingRecoveredFrame) {
        const recoverySurfaceFailure = error instanceof HostCallAuthorityBoundaryError
          ? error.boundaryKind
          : error instanceof UnsupportedHostCapabilityError
            ? `unsupported_${error.capabilityKind}`
            : error instanceof Error
              ? `${error.name}:${error.message}`.replace(/\s+/gu, ' ').trim().slice(0, 240)
              : String(error).replace(/\s+/gu, ' ').trim().slice(0, 240);
        hostTurnLogger.error({
          recoverySurfaceFailure,
          err: error instanceof Error
            ? { name: error.name, message: error.message }
            : { message: String(error) },
        }, 'host checkpoint recovery could not reconstruct its exact tool surface');
        // This is bookkeeping for an already-accepted model response, not a
        // fresh attempt. Keep the exact frame privately owned if its callable
        // surface cannot be reconstructed yet; never expose a public authority
        // or retry terminal, and never ask a model to emit the call again.
        return recoveryOutcome({
          phase: 'admit',
          baseHistory: [...history],
          frameHistory: recoveryFrameThisStep.history,
          responseId: recoveryFrameThisStep.responseId,
          stepIndexOverride: resumedRecoveryState?.stepIndex ?? currentHostStepIndex,
          reason: `recovery_surface_unavailable:${recoverySurfaceFailure}`,
        });
      } else if (resumeSurfaceFallback) {
        // The pending approval frame has already been paired as a proven
        // no-effect refusal. Give the model its ordinary bounded response path
        // with an empty callable surface; a later refresh may recover, but an
        // unavailable surface never becomes public blocked/authority prose.
        tools = [];
        toolByName = new Map();
        configuredToolRefs = new Set();
        schemas = [];
      } else if (error instanceof HostCallAuthorityBoundaryError) {
        return blockedOutcome(HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT, error.boundaryKind);
      } else if (error instanceof UnsupportedHostCapabilityError) {
        return blockedOutcome(
          HOST_UNSUPPORTED_CAPABILITY_BLOCKED_TEXT,
          `unsupported_capability:${error.capabilityKind}`,
        );
      } else {
        throw error;
      }
    }
    if (hostProduction && !consumingRecoveredFrame && !committedVerificationRecoveryChecked) {
      committedVerificationRecoveryChecked = true;
      const identity = exactHostIdentity();
      const ambient = harnessRunContextStorage.getStore();
      if (!ambient?.dispatchLease) {
        return blockedOutcome(
          'I could not safely inspect the durable write-verification checkpoint. I stopped before starting another action.',
          'write_verification_recovery_unavailable',
        );
      }
      const killTarget = ambient.runAttemptId
        ? { attemptId: ambient.runAttemptId, sourceUserSeq: identity.sourceUserSeq }
        : { sourceUserSeq: identity.sourceUserSeq };
      const recoveredVerification = await recoverCommittedMutationVerificationsForSource({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        parentLease: ambient.dispatchLease,
        turn: ambient.turn,
        deadlineMs: hostToolDeadlineMs('work_call'),
        callerSignal: signal,
        isKillRequested: () => isKillRequested(identity.sessionId, killTarget),
      });
      if (recoveredVerification.status === 'unavailable') {
        return blockedOutcome(
          'I could not safely inspect the durable write-verification checkpoint. I stopped before starting another action.',
          'write_verification_recovery_unavailable',
        );
      }
      if (recoveredVerification.status === 'held') {
        return committedVerificationHoldOutcome(
          recoveredVerification.holds,
          latestAcceptedModelBatchRef,
        );
      }
      if (recoveredVerification.status === 'verified' && recoveredVerification.verified.length > 0) {
        const facts = recoveredVerification.verified.map((proof) => (
          `${boundedVerificationSurface(proof.ownerLogicalToolCallId)} -> ${boundedVerificationSurface(proof.resourceId)}`
        ));
        pendingHostModelDirective = [
          pendingHostModelDirective,
          'HOST VERIFICATION RECOVERY — the retained write result is committed and its deterministic readback now verifies it.',
          `Verified owner/resource: ${facts.join(', ')}.`,
          'Use the retained result already in history and continue only unfinished downstream requirements. Do not issue or retry the owner write.',
        ].filter(Boolean).join(' ');
      }
    }
    let modelStepSchemas: readonly unknown[] = schemas;
    let permittedNoProgressRecoveryToolNames: ReadonlySet<string> | null = null;
    // TRAJECTORY WATCHER — the mid-run "is this still the thing the user asked
    // for?" check. It has existed for a while but only in the legacy core
    // (loop.ts) and the workflow lane, and a live chat turn runs host_v1 which
    // never enters either — so a turn that drifted at tool-call 3 burned the
    // whole turn before the END-of-turn completion judge could bounce it, and
    // that bounce costs a full re-loop. Same component, same contract:
    // NON-BLOCKING (fired in the background, never on the critical path),
    // GOAL-ONLY, advisory, silent when unsure, fail-open, and bounded by the
    // shared check/injection budgets. A resolved drift verdict rides the
    // ordinary one-shot directive at THIS continuation boundary.
    if (hostProduction && hostWatcherEnabled) {
      const drift = hostWatcherSteer.pending;
      if (drift && !drift.onTrack && hostWatcherInjectionsUsed < MAX_WATCHER_INJECTIONS) {
        hostWatcherSteer.pending = null;
        hostWatcherInjectionsUsed += 1;
        pendingHostModelDirective = [
          pendingHostModelDirective,
          `TRAJECTORY WATCHER (an independent check of the work so far against the ORIGINAL request) says OFF TRACK: ${drift.miss.slice(0, 300)}`,
          drift.steer.slice(0, 300),
        ].filter(Boolean).join(' ');
        try {
          appendEvent({
            sessionId: exactHostIdentity().sessionId,
            turn: 0,
            role: 'system',
            type: 'goal_alignment_judged',
            data: {
              lane: 'host_v1',
              kind: 'watcher',
              fulfills: false,
              reason: drift.miss.slice(0, 600),
              steer: drift.steer.slice(0, 300),
              continuation: true,
            },
          });
        } catch { /* telemetry never blocks the turn */ }
      }
      const watcherToolCalls = history.filter((item) => {
        const row = item as { type?: unknown; name?: unknown };
        return row.type === 'function_call'
          && !HOST_JUDGE_CONTROL_TOOL_NAMES.has(String(row.name ?? ''));
      }).length;
      if (shouldStartWatcherCheck({
        enabled: true,
        totalToolCalls: watcherToolCalls,
        lastCheckedAtToolCalls: hostWatcherLastCheckedAt,
        checkIntervalTools: hostWatcherIntervalTools,
        injectionsUsed: hostWatcherInjectionsUsed,
        maxInjections: MAX_WATCHER_INJECTIONS,
        checksUsed: hostWatcherChecksUsed,
        maxChecks: MAX_WATCHER_CHECKS,
        checkInFlight: hostWatcherCheckInFlight,
      })) {
        hostWatcherCheckInFlight = true;
        hostWatcherChecksUsed += 1;
        hostWatcherLastCheckedAt = watcherToolCalls;
        const watcherObjective = judgedObjective();
        const watcherSessionId = exactHostIdentity().sessionId;
        void (async () => {
          try {
            const verdict = await runWatcherJudge({
              objective: watcherObjective,
              toolCallSummary: summarizeToolCallsForJudge(watcherSessionId),
              latestAssistantNote: '',
              toolCallCount: watcherToolCalls,
            });
            if (verdict && !verdict.onTrack) hostWatcherSteer.pending = verdict;
          } catch { /* the watcher is silent on any failure */ }
          finally { hostWatcherCheckInFlight = false; }
        })();
      }
    }
    let modelInputDirective = pendingHostModelDirective;
    let writingNoProgressRecoveryDirective = false;
    if (!consumingRecoveredFrame) {
      if (
        hostProduction
        && !actionExpectedWorkRequired(exactHostIdentity())
      ) {
      const identity = exactHostIdentity();
      const taskKey = acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq);
      if (noProgressState && noProgressState.taskKey !== taskKey) {
        return blockedOutcome(
          hostNoProgressBlockedText(noProgressState),
          'control_no_progress_exhausted',
          false,
        );
      }
      const authority = projectHostNoProgressAuthority(identity);
      if (authority.status === 'ok') {
        if (!noProgressState) {
          noProgressState = initializeNoProgressGovernor({
            taskKey,
            authority: authority.authority,
          });
          noProgressHistoryCursor = history.length;
        } else if (noProgressHistoryCursor < history.length) {
          const historyDelta = history.slice(noProgressHistoryCursor);
          const attempt = projectHostNoProgressAttempt({
            ...identity,
            historyDelta,
          });
          if (attempt.status === 'ok') {
            // Advance exactly once, and only after every call in the delta has
            // a committed paired result. Arbitrary new call/result handles do
            // not appear in the authority projection.
            noProgressHistoryCursor = history.length;
            const decision = observeNoProgress(noProgressState, {
              taskKey,
              attemptClass: attempt.attemptClass,
              authority: authority.authority,
              ...(attempt.consequence ? { consequence: attempt.consequence } : {}),
            });
            noProgressState = decision.state;
            if (decision.action === 'terminalize') {
              // GUIDE, NOT GATE: the model gets one last-word turn with what
              // the governor observed before the harness ends the turn with
              // prose the model never wrote. The next exhaustion is terminal.
              const lastRefusal = lastHostRefusalDetail(history);
              if (tryLastWordTurn('control_no_progress_exhausted', [
                `the no-progress governor exhausted its budget (${decision.state.lastConsequence?.stage ?? 'no consequence stage'})`,
                ...(lastRefusal ? [`last refusal: ${lastRefusal}`] : []),
              ])) {
                noProgressRecoveryOnly = false;
                noProgressRecoveryDirectiveWritten = false;
              } else {
                return blockedOutcome(
                  hostNoProgressBlockedText(decision.state),
                  'control_no_progress_exhausted',
                  false,
                );
              }
            }
            if (decision.action === 'reconcile') {
              return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
            }
            if (decision.action === 'recover') {
              noProgressRecoveryOnly = true;
              noProgressRecoveryDirectiveWritten = false;
              if (!latestAcceptedModelBatchRef) {
                return blockedOutcome(
                  hostNoProgressBlockedText(decision.state),
                  'control_no_progress_exhausted',
                  false,
                );
              }
              return recoveryContinuationOutcome(
                latestAcceptedModelBatchRef,
                `no_progress_host_recovery:${decision.state.lastConsequence?.stage ?? 'unknown'}`,
              );
            }
            if (
              decision.reason === 'retry_available'
              || decision.reason === 'consequence_progress'
              || decision.reason === 'user_input_required'
            ) {
              // A consequence-free dependency lookup is already-landed data,
              // not a new provider/execution path.  Keep the ordinary model
              // surface for its one bounded synthesis step so the model can
              // read/query that result or simply answer.  Restricting this
              // case to plan/ask controls caused a successful calendar read's
              // file_query result to disappear from the usable surface and
              // forced the model into an unrelated plan_task.  Discovery and
              // every typed repair/ask consequence remain recovery-only; the
              // governor still terminalizes the next no-gain attempt.
              noProgressRecoveryOnly = !(
                decision.reason === 'retry_available'
                && attempt.attemptClass === 'dependency_lookup'
                && attempt.consequence === undefined
              );
              if (!noProgressRecoveryOnly) {
                noProgressRecoveryDirectiveWritten = false;
              }
            } else if (decision.reason === 'authority_progress') {
              noProgressRecoveryOnly = false;
              noProgressRecoveryDirectiveWritten = false;
            }
          } else if (attempt.status === 'unavailable') {
            hostTurnLogger.error({ reason: attempt.reason }, 'no-progress attempt projection unavailable');
            return blockedOutcome(
              HOST_PROGRESS_PROJECTION_BLOCKED_TEXT,
              'control_progress_projection_unavailable',
            );
          } else if (!historyDelta.some((item) => (
            (item as { type?: unknown } | null)?.type === 'function_call'
          ))) {
            // Host-authored continuation/directive items are not attempts and
            // must not be reconsidered with the next paired tool frame.
            noProgressHistoryCursor = history.length;
          } else {
            hostTurnLogger.error('no-progress history delta was not fully paired');
            return blockedOutcome(
              HOST_PROGRESS_PROJECTION_BLOCKED_TEXT,
              'control_progress_projection_unavailable',
            );
          }
        }
      } else {
        hostTurnLogger.error({ reason: authority.reason }, 'no-progress authority projection unavailable');
        return blockedOutcome(
          HOST_PROGRESS_PROJECTION_BLOCKED_TEXT,
          'control_progress_projection_unavailable',
        );
      }

      if (noProgressRecoveryOnly) {
        const consequence = noProgressState?.lastConsequence;
        const exactRecoveryToolNames = new Set(consequence?.recoveryToolNames ?? []);
        const recoveryTools = tools.filter((tool) => consequence?.recovery === 'ask_user'
          ? bareTerminalToolName(tool.name) === 'ask_user_question'
          : consequence?.recovery === 'stop_factual'
            ? false
            : exactRecoveryToolNames.size > 0
              ? exactRecoveryToolNames.has(tool.name)
              : hostControlFrameFor(tool.name) === 'sole'
                || bareTerminalToolName(tool.name) === 'ask_user_question');
        permittedNoProgressRecoveryToolNames = new Set(recoveryTools.map((tool) => tool.name));
        modelStepSchemas = serializedTools(recoveryTools);
        if (!noProgressRecoveryDirectiveWritten) {
          modelInputDirective = noProgressState
            ? hostNoProgressRecoveryDirective(noProgressState)
            : HOST_NO_PROGRESS_RECOVERY_DIRECTIVE;
          writingNoProgressRecoveryDirective = true;
        }
      }
      } else {
        // A settled plan phases the surface into admitted task work. The
        // discovery governor no longer owns that graph and cannot meter it.
        noProgressState = null;
        noProgressHistoryCursor = history.length;
        noProgressRecoveryOnly = false;
        noProgressRecoveryDirectiveWritten = false;
      }
    }
    // THE MODEL NEVER RECEIVES CANONICAL HISTORY, filter or no filter.
    //
    // The filtered branch already cloned; the unfiltered branch aliased, so on
    // every turn without a `callModelInputFilter` the durable projection and
    // the request payload were the same array. A provider adapter that
    // normalises, annotates or truncates its input in place would then be
    // editing history that has already been accepted — silently, and only on
    // the configuration that looks simplest.
    let modelInput: AgentInputItem[] = [];
    let instructions: string | undefined;
    if (!consumingRecoveredFrame) {
      modelInput = structuredClone(history);
      // Match Agent.getSystemPrompt semantics: dynamic instructions are
      // re-evaluated before EVERY model step so newly written memory/context is
      // visible without restarting the daemon.
      instructions = await resolveInstructions();
      if (inputFilter) {
        // Context projection is an authority boundary. If it cannot be built,
        // stop the step: dispatching the unfiltered history would silently
        // remove constraints and private/contextual overlays.
        const filtered = await inputFilter({
          // Match the SDK boundary: filters receive a clone and cannot mutate
          // the canonical history that will be persisted/replayed.
          modelData: {
            input: structuredClone(history),
            ...(instructions !== undefined ? { instructions } : {}),
          },
          agent,
          context: contextValue,
        });
        if (!filtered || !Array.isArray(filtered.input)) {
          throw new Error('callModelInputFilter must return a model input object with an input array.');
        }
        // The model also receives a clone: mutations in a provider adapter may
        // not flow backwards into the filter output or durable host history.
        modelInput = structuredClone(filtered.input);
        instructions = typeof filtered.instructions === 'undefined'
          ? instructions
          : filtered.instructions;
      }
      if (modelInputDirective) {
        // Host recovery/continuation guidance is a one-shot request layer.  It is
        // never canonical conversation history, so it cannot create an
        // uncheckpointed edge between two accepted tool batches.
        modelInput.push({ role: 'user', content: modelInputDirective });
      }
    }
    let step: Awaited<ReturnType<typeof codexOneStep>>;
    let ranModelStep = false;
    if (recoveryFrameThisStep) {
      step = {
        text: '',
        toolCalls: recoveryFrameThisStep.calls,
        output: recoveryFrameThisStep.history as never,
        limitHit: false,
        stopReason: 'tool_calls',
        terminationEvidence: 'recognized',
        ...(recoveryFrameThisStep.responseId
          ? { responseId: recoveryFrameThisStep.responseId }
          : {}),
      };
      recoveredToolFrame = undefined;
    } else try {
      step = await runOneModelStep(modelInput, instructions, modelStepSchemas);
      ranModelStep = true;
      // A frame that produced output restores the pre-content stall retry: the
      // budget bounds ONE frame's silence, not the whole turn (live 2026-09-02:
      // a 12-read turn spent its single retry early and the next long think
      // became 'transport stopped responding').
      remainingPreContentStallRetries = modelStreamStallRetries();
    } catch (error) {
      // Match loop.ts: a pre-content stall with no paid request in flight is
      // retryable. Swallowing it as blockedOutcome killed the rescue brain
      // after GLM/Grok first-content-timeout (OPEN-THE-GATES 5.1, live
      // sess-desktop-8e7470 / 2bc15b). The silenced brain is already marked,
      // so the next step preselects rescue. Mid-stream stalls and buffered
      // paid requests still fail closed.
      if (
        error instanceof ModelStreamStalledError
        && error.preContent
        && !error.bufferedProviderRequestInFlight
        && remainingPreContentStallRetries > 0
      ) {
        remainingPreContentStallRetries -= 1;
        stepIndex -= 1;
        continue;
      }
      if (error instanceof ModelStreamStalledError) {
        return blockedOutcome(HOST_MODEL_STALL_BLOCKED_TEXT, 'model_stalled');
      }
      throw error;
    }
    if (ranModelStep && writingNoProgressRecoveryDirective) {
      noProgressRecoveryDirectiveWritten = true;
    }
    if (ranModelStep && pendingHostModelDirective === modelInputDirective) {
      pendingHostModelDirective = undefined;
    }
    // ADMIT BEFORE COMMIT.
    //
    // The response used to be appended to `history` — and its id adopted as
    // `lastResponseId` — before anything decided whether the step was blocked.
    // Because `blockedOutcome` returns that same `history`, a filtered,
    // truncated, cancelled or errored response was persisted by the very act
    // of rejecting it, and the loop replayed those bytes into the next model
    // request. Rejected content became future context.
    //
    // Nothing is pushed until the step is admitted, so a block returns exactly
    // the pre-step history and the previously accepted response id. There is
    // no rollback to get wrong: the commit simply has not happened yet.
    const admission = admitModelStep(step);
    if (!admission.admitted) {
      return blockedOutcome(
        admission.reason === 'provider_limit_hit'
          ? HOST_MODEL_LIMIT_BLOCKED_TEXT
          : HOST_MODEL_INCOMPLETE_BLOCKED_TEXT,
        admission.reason,
      );
    }

    // The admitted frame is the only response projection with authority.
    // Persisting `step.output` or executing `step.toolCalls` would re-open the
    // split-brain bug where validation inspected one normalization while the
    // host consumed another.
    if (admission.frame.kind === 'completed') {
      const noProgressRecovery = noProgressRecoveryOnly
        ? noProgressState?.lastConsequence?.recovery
        : undefined;
      if (noProgressRecovery === 'ask_user') {
        // Exact user-input authority belongs to one canonical
        // ask_user_question call. Prose cannot substitute a broader question
        // or publish before the call boundary validates options and purpose.
        // But withholding AUTHORITY is not a reason to delete the model's
        // WORDS: the turn stays blocked and non-resumable, and the reply is
        // what she actually wrote.
        return blockedOutcome(
          modelOwnedTerminalText(admission.frame.text, noProgressState),
          'control_no_progress_exhausted',
          false,
        );
      }
      if (noProgressRecovery === 'stop_factual') {
        const decision = toOrchestratorDecision(admission.frame.text);
        if (
          decision?.nextAction === 'awaiting_user_input'
          || decision?.nextAction === 'awaiting_approval'
        ) {
          // A known terminal may be explained once, but it cannot convert
          // itself into new user work or resumable authority. Same rule as
          // above: refuse the authority, keep the model's words.
          return blockedOutcome(
            modelOwnedTerminalText(admission.frame.text, noProgressState),
            'control_no_progress_exhausted',
            false,
          );
        }
      }
      if (hostProduction && !acceptedReadPlanContinuationUsed) {
        const identity = exactHostIdentity();
        const pendingReadPlan = pendingAcceptedReadPlan(identity);
        if (pendingReadPlan) {
          acceptedReadPlanContinuationUsed = true;
          pendingHostModelDirective = [
            'ACCEPTED PLAN EXECUTION — the exact read-only plan is already pinned.',
            `Call work_call now for the ready requirement${pendingReadPlan.readyRequirementIds.length === 1 ? '' : 's'}: ${pendingReadPlan.readyRequirementIds.join(', ')}.`,
            'Do not call tool_search or plan_task again. Do not answer or declare completion until the bound read settles and you can report its actual result.',
          ].join(' ');
          continue;
        }
      }
      if (hostProduction && !acceptedUniqueWorkflowContinuationUsed) {
        const workflowName = pendingUniqueWorkflowNameFromHistory(history);
        if (workflowName) {
          acceptedUniqueWorkflowContinuationUsed = true;
          pendingHostModelDirective = [
            'ACCEPTED WORKFLOW — this request uniquely names an existing workflow.',
            `Call workflow_run now with name "${workflowName}".`,
            'Do not plan_task. Do not workflow_get. Do not answer or declare completion until workflow_run settles.',
          ].join(' ');
          continue;
        }
      }
      if (hostProduction) {
        const identity = exactHostIdentity();
        const missingWorkflowResult = missingWorkflowStepResultContinuation({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          endedWithoutResult: workflowStepDecisionEndedWithoutResult(
            toOrchestratorDecision(admission.frame.text),
          ),
          used: workflowStepResultContinuationsUsed,
          // The host loop is zero-based; the shared completion fence uses the
          // one-based completed-step count used by the legacy conversation
          // loop and approval-resume path.
          stepIndex: stepIndex + 1,
          maxSteps: maxTurns,
        });
        if (missingWorkflowResult) {
          workflowStepResultContinuationsUsed += 1;
          pendingHostModelDirective = missingWorkflowResult.directive;
          hostTurnLogger.info({
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
            attempt: workflowStepResultContinuationsUsed,
            maxAttempts: MAX_WORKFLOW_STEP_RESULT_CONTINUATIONS,
            settlementStatus: missingWorkflowResult.auditStatus,
            settlementReason: missingWorkflowResult.auditReason,
          }, 'host retained the accepted workflow step for its required structured result');
          continue;
        }
      }
      if (hostProduction) {
        const decision = toOrchestratorDecision(admission.frame.text);
        // The bare CONTINUE: shape (turn-decision.ts): done:false,
        // awaiting_handoff_result, reply null, the note in reason. A narrated
        // envelope or an ASK: keeps its own reading.
        const bareContinue = Boolean(
          decision
          && decision.done === false
          && decision.nextAction === 'awaiting_handoff_result'
          && decision.reply === null,
        );
        if (bareContinue && continueMarkerContinuationsUsed >= MAX_HOST_CONTINUE_MARKER_CONTINUATIONS) {
          // Budget spent on the same promise. Delivering the note as the
          // answer was a silent success (the chat showed "ready to submit …"
          // as the reply, nothing written). Typed, resumable, names the edge.
          const note = (decision?.reason ?? '').replace(/\s+/g, ' ').trim();
          lastContinueMarkerNote = note.slice(0, 400) || undefined;
          history.push(...admission.frame.history);
          if (step.responseId !== undefined) lastResponseId = step.responseId;
          // GUIDE, NOT GATE: one last-word turn before the harness answers
          // for the model. A further bare CONTINUE after it is terminal.
          if (tryLastWordTurn('continue_marker_exhausted', [
            `you wrote CONTINUE ${MAX_HOST_CONTINUE_MARKER_CONTINUATIONS + 1} times without making the call`
              + (note ? ` (${note.slice(0, 200)})` : ''),
          ])) {
            continue;
          }
          return blockedOutcome(
            `I planned the next step ${MAX_HOST_CONTINUE_MARKER_CONTINUATIONS + 1} times without making the call`
              + (note ? ` (${note.slice(0, 300)})` : '')
              + '. Nothing was written. Say "continue" and I will make those calls now, or tell me what to change.',
            'continue_marker_exhausted',
            true,
          );
        }
        if (bareContinue && decision) {
          continueMarkerContinuationsUsed += 1;
          pendingHostModelDirective = [
            'CONTINUE HONORED — there is no next turn: this turn stays open until you stop calling tools.',
            'Make the tool calls you said you still have now, in this turn, then give the final result.',
            'Do not restate the plan and do not write CONTINUE again.',
          ].join(' ');
          hostTurnLogger.info({
            sessionId: exactHostIdentity().sessionId,
            attempt: continueMarkerContinuationsUsed,
            maxAttempts: MAX_HOST_CONTINUE_MARKER_CONTINUATIONS,
            note: (decision.reason ?? '').slice(0, 200),
          }, 'host kept the turn open for a CONTINUE marker');
          continue;
        }
      }
      if (hostJudgeCompletion) {
        const judged = await judgeHostCompletion(admission.frame.text, admission.frame.history, step.responseId);
        if (judged === 'continue') continue;
      }
      history.push(...admission.frame.history);
      if (step.responseId !== undefined) lastResponseId = step.responseId;
      return await completedOutcome(admission.frame.text);
    }

    const canonicalCalls = admission.frame.calls;
    const repeatsCommittedCallId = canonicalCalls.some((call) => history.some((item) => {
      const row = item as unknown as { type?: unknown; callId?: unknown };
      return (row.type === 'function_call' || row.type === 'function_call_result')
        && row.callId === call.callId;
    }));
    // A call id is one canonical conversation edge. Even an exact settled
    // replay cannot append a second call/result pair: the next model request
    // would have two visible result owners for one id. Keep the already-
    // checkpointed pair as the sole truth and stop before preparation, consent,
    // execution, transcript mutation, or adoption of this duplicate response.
    if (repeatsCommittedCallId) {
      return blockedOutcome(
        HOST_DUPLICATE_MODEL_CALL_BLOCKED_TEXT,
        'model_reused_committed_call_id',
      );
    }
    const batchAdmission: AcceptedFrameAdmission = recoveredAcceptedFrame
      ? { status: 'ready', frame: recoveredAcceptedFrame }
      : preAdmitAcceptedToolFrame({
          frameHistory: admission.frame.history,
          responseId: step.responseId,
        });
    recoveredAcceptedFrame = undefined;
    if (batchAdmission.status === 'held') return batchAdmission.outcome;
    const acceptedFrame = batchAdmission.frame;
    const exactAskInput = noProgressRecoveryOnly
      && noProgressState?.lastConsequence?.recovery === 'ask_user'
      ? noProgressState.lastConsequence.userInput
      : undefined;
    const nonCanonicalNoProgressAsk = exactAskInput !== undefined && (
      canonicalCalls.length !== 1
      || bareTerminalToolName(canonicalCalls[0]!.name) !== 'ask_user_question'
      || !isCanonicalNoProgressAskArguments(
        parsedArgs(canonicalCalls[0]!.argumentsJson),
        exactAskInput,
      )
    );
    if (
      permittedNoProgressRecoveryToolNames
      && (
        nonCanonicalNoProgressAsk
        || canonicalCalls.some((call) => !permittedNoProgressRecoveryToolNames!.has(call.name))
      )
    ) {
      // The recovery request exposed no dependency/provider/business schema.
      // A model-authored call outside that exact subset is paired locally and
      // terminalized before approval, preparation, or body invocation.
      const paired = pairLocallyRefusedFrame(canonicalCalls);
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      recordZeroCrossingRefusal(paired.frameDigest);
      return blockedOutcome(
        hostNoProgressBlockedText(noProgressState),
        'control_no_progress_exhausted',
        false,
      );
    }
    const canonicalFrameDigest = semanticFrameDigest(canonicalCalls);
    if (retiredZeroCrossingFrames.has(canonicalFrameDigest)) {
      // A semantically repeated frame with fresh ids takes the ordinary
      // admitted/receipt path. Reused ids were already stopped above.
      // The retired receipts carry no diagnostic, so capture the refusal check
      // the model actually saw BEFORE they land in history (say why).
      lastRetiredFrameRefusalDetail = lastHostRefusalDetail(history) ?? lastRetiredFrameRefusalDetail;
      const paired = pairLocallyRefusedFrame(canonicalCalls, true);
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      // GUIDE, NOT GATE: after the model's last word, an exact repeat of a
      // retired frame is the typed terminal WITH its detail — never harness
      // prose passed off as a completed answer.
      if (lastWordTurnUsed) {
        return blockedOutcome(
          hostNoProgressBlockedText(noProgressState),
          'control_no_progress_exhausted',
          false,
        );
      }
      return await completedOutcome(capabilityUnavailableTextFor(canonicalCalls));
    }
    let frameDisposition: HostModelFrameDisposition;
    // What the host proved this turn — the ONLY authority a carrier's shape is
    // read against (chat disclosure), or the operations a sealed workflow step
    // froze into its scope before the model spoke. Computed once per frame so
    // the refusal directive can name the proven reads too.
    let turnProvenEntries: Array<{ kind: string; identifier: string; effectClass?: string }> = [];
    if (hostProduction) {
      try {
        const completionIdentity = exactHostIdentity();
        turnProvenEntries = provenCapabilityEntriesForTurn({
          sessionId: completionIdentity.sessionId,
          sourceUserSeq: completionIdentity.sourceUserSeq,
        });
      } catch { /* no accepted identity: nothing proven this turn */ }
      if (turnProvenEntries.length === 0) {
        try {
          const scope = currentAcceptedSourceCatalogManifestScope();
          if (scope) {
            turnProvenEntries = [...scope.operationIds].map((identifier) => ({ kind: 'frozen_scope', identifier }));
          }
        } catch { /* no sealed scope either */ }
      }
    }
    try {
      const frameCalls = canonicalCalls.map((call) => {
        const tool = toolByName.get(call.name);
        let argumentsJson = materializedArgumentsJson(tool, call.argumentsJson);
        // Complete a structurally wrong provider carrier from facts the host
        // already holds (carrier-completion.ts, provider-neutral): the one operation
        // proven this turn, the `arguments` wrapper, one serialization. The
        // completed bytes are what this frame classifies AND dispatches, so the
        // settlement and the learned pin record the working shape.
        const directGateway = isRegisteredCarrierGateway(call.name);
        if (
          hostProduction
          && tool
          && (isPlainOrClementineLocalTool(call.name, 'work_call') || isPlainOrClementineLocalTool(call.name, 'call_tool') || directGateway)
        ) {
          const provenEntries = turnProvenEntries;
          const completed = directGateway
            ? completeDirectCarrierArguments(call.name, argumentsJson, provenEntries)
            : completeCarrierArguments(argumentsJson, provenEntries);
          if (completed) {
            argumentsJson = completed.argumentsJson;
            (call as { argumentsJson: string }).argumentsJson = completed.argumentsJson;
            hostTurnLogger.info({
              sessionId: exactHostIdentity().sessionId,
              callId: call.callId,
              carrier: call.name,
              toolSlug: completed.toolSlug,
              changes: completed.changes,
            }, 'host completed a provider carrier from the turn\'s proven disclosure');
          }
        }
        let argumentsValue = parsedArgs(argumentsJson);
        // The fused frame is classified before plan_task has materialized its
        // selected catalog rows. At this scheduling-only edge, an exact
        // same-source discovery receipt may therefore be the sole current
        // authority that the sibling is a read. Reuse the same proof predicate
        // as the production call boundary; plan activation and the last-edge
        // exactProductionHostCall still re-open the full catalog/manifest/
        // account/schema/port identity before any provider dispatch.
        let provenRead = argumentsValue
          ? provenTurnReadDescent(call.name, argumentsValue, tool)
          : null;
        // READ ANYTHING THE MODEL OUTPUTS; RESOLVE IT AGAINST PROOF. Every
        // brain spells a carrier differently. When the exact descent above did
        // not recognize the shape, read it tolerantly (carrier-reader.ts) and
        // resolve the operation it names against the turn's proven entries. A
        // proven READ is rebuilt into the canonical gateway carrier and
        // re-proven by the same descent — shape was never the gate, proof is,
        // and the dispatcher below still re-proves operation, account, schema
        // and effect before any provider I/O. Live 2026-09-02 (grok-4.6): a
        // proven sheet read in an unrecognized shape was refused twice as
        // "needs a plan" and the turn died.
        if (
          !provenRead
          && hostProduction
          && tool
          && (isPlainOrClementineLocalTool(call.name, 'work_call') || isPlainOrClementineLocalTool(call.name, 'call_tool') || directGateway)
        ) {
          const carrier = readModelCarrier(call.name, argumentsValue ?? argumentsJson);
          const resolved = resolveProvenOperation(carrier.operation, turnProvenEntries);
          if (resolved && resolved.effectClass === 'read') {
            const canonical = canonicalGatewayCarrier(argumentsValue, resolved.identifier, carrier.arguments);
            argumentsJson = directGateway ? canonical.innerJson : canonical.argumentsJson;
            (call as { argumentsJson: string }).argumentsJson = argumentsJson;
            argumentsValue = parsedArgs(argumentsJson);
            hostTurnLogger.info({
              callId: call.callId,
              carrier: call.name,
              operation: resolved.identifier,
              match: resolved.match,
              shape: carrier.shape,
            }, 'host read a provider carrier against the turn\'s proof');
            provenRead = argumentsValue
              ? provenTurnReadDescent(call.name, argumentsValue, tool)
              : null;
          }
        }
        const effectiveName = provenRead?.effectiveName ?? (argumentsValue
          ? unwrapRuntimeEffectiveToolIdentity(call.name, argumentsValue).toolName
          : null);
        const classifiedEffect = argumentsValue
          ? classifyRuntimeToolEffect(call.name, argumentsValue).effect
          : 'unknown' as const;
        return {
          callId: call.callId,
          name: call.name,
          argumentsJson,
          argumentsValue,
          effectiveName,
          effect: provenRead ? 'read' as const : classifiedEffect,
          proposalFreeWorkCarrier: Boolean(
            tool
            && isHostPlanRequiredWorkCall(tool)
            && isPlainOrClementineLocalTool(call.name, 'work_call'),
          ),
        };
      });
      currentFrameEffects = new Map(frameCalls.map((frameCall) => [frameCall.callId, frameCall.effect]));
      frameDisposition = classifyHostModelFrame({
        calls: frameCalls,
        planActivated: hostProduction
          ? actionExpectedWorkRequired(exactHostIdentity())
          : false,
        allowFreshPlanReadFusion: hostProduction,
      });
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error)
        .replace(/\s+/gu, ' ').trim().slice(0, 240) || 'frame_materialization_failed';
      const paired = pairLocallyRefusedFrame(
        canonicalCalls,
        false,
        new Map([[canonicalCalls[0]!.callId,
          `The host could not materialize the exact admitted frame (${detail}). No tool body was entered.`]]),
      );
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      recordZeroCrossingRefusal(paired.frameDigest);
      consecutiveFrameRefusals += 1;
      journalHostGuide('frame_refused', {
        reason: 'frame_materialization_failed',
        detail,
        calls: canonicalCalls.map((call) => ({
          callId: call.callId,
          name: call.name,
          argumentsJson: call.argumentsJson.slice(0, 2000),
        })),
        consecutiveFrameRefusals,
      });
      hostTurnLogger.warn({ detail, calls: canonicalCalls.map((call) => call.name) }, 'host could not materialize a call frame');
      if (consecutiveFrameRefusals >= 2) {
        tryLastWordTurn('frame_refused', [`the host could not materialize ${consecutiveFrameRefusals} consecutive call frames (${detail})`]);
      }
      continue;
    }
    if (frameDisposition.kind === 'refused') {
      const reason = frameDisposition.reason;
      // The directive lands on the call that CAUSED the refusal (live
      // 2026-09-02: a two-call frame was refused for its work_call and the
      // explanation was attached to the sibling workflow_get).
      const workCallReason = reason === 'host_planned_work_call_requires_plan_sibling'
        || reason === 'host_work_call_inner_operation_unidentified';
      const offending = (workCallReason
        ? canonicalCalls.find((call) => isPlainOrClementineLocalTool(call.name, 'work_call'))
        : undefined) ?? canonicalCalls[0]!;
      let offendingOperation: string | null = null;
      try {
        const offendingArgs = parsedArgs(offending.argumentsJson);
        offendingOperation = offendingArgs
          ? unwrapRuntimeEffectiveToolIdentity(offending.name, offendingArgs).toolName
          : null;
      } catch { /* diagnostic only */ }
      const provenReads = turnProvenEntries
        .filter((entry) => entry.effectClass === 'read')
        .map((entry) => entry.identifier);
      const paired = pairLocallyRefusedFrame(
        canonicalCalls,
        false,
        new Map([[offending.callId, hostFrameRefusalDirective(reason, { provenReads, offendingOperation })]]),
        new Set([offending.callId]),
      );
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      recordZeroCrossingRefusal(paired.frameDigest);
      consecutiveFrameRefusals += 1;
      // Journaled with the RAW shape, so the next unknown dialect is learned
      // from one run instead of reconstructed from receipts.
      journalHostGuide('frame_refused', {
        reason,
        retryMode: 'replan',
        offendingCallId: offending.callId,
        offendingOperation,
        provenReads: provenReads.slice(0, 12),
        calls: canonicalCalls.map((call) => ({
          callId: call.callId,
          name: call.name,
          argumentsJson: call.argumentsJson.slice(0, 2000),
        })),
        consecutiveFrameRefusals,
      });
      hostTurnLogger.warn({
        reason,
        offendingCallId: offending.callId,
        offendingOperation,
        calls: canonicalCalls.map((call) => call.name),
        consecutiveFrameRefusals,
      }, 'host refused a call frame before dispatch');
      if (consecutiveFrameRefusals >= 2) {
        tryLastWordTurn('frame_refused', [
          `the host refused ${consecutiveFrameRefusals} consecutive call frames before dispatch (${reason})`,
          ...(offendingOperation ? [`the operation you named, "${offendingOperation}", is not proven this turn`] : []),
          ...(provenReads.length > 0 ? [`proven reads this turn: ${provenReads.slice(0, 12).join(', ')}`] : []),
        ]);
      }
      continue;
    }
    if (frameDisposition.kind === 'host_owned_single_action_plan') {
      const activated = hostProduction
        ? await activateHostOwnedSingleActionPlan(frameDisposition)
        : false;
      if (!activated) {
        const paired = pairLocallyRefusedFrame(canonicalCalls);
        const resultCommitBlock = commitAdmittedToolFrame({
          acceptedFrame,
          frameHistory: admission.frame.history,
          resultItems: paired.resultItems,
          responseId: step.responseId,
        });
        if (resultCommitBlock) return resultCommitBlock;
        recordZeroCrossingRefusal(paired.frameDigest);
        continue;
      }
      // From here onward the original model call uses the ordinary common
      // preparation/consent/lease/execution path under the newly activated
      // durable graph. The hidden control result is intentionally not history.
      frameDisposition = { kind: 'ordinary' };
    }
    /* Retain the legacy direct/effective policy assertion as a consistency
     * check for registry classes not yet migrated to hostModelFrameClass. */
    let soleControls: Array<{ call: CanonicalHostCall; carried: boolean }>;
    try {
      soleControls = canonicalCalls.flatMap((call) => {
        const tool = toolByName.get(call.name);
        const argumentsJson = materializedArgumentsJson(tool, call.argumentsJson);
        const argumentsValue = parsedArgs(argumentsJson);
        const directPolicy = hostControlFrameFor(call.name);
        const effective = argumentsValue
          ? unwrapRuntimeEffectiveToolIdentity(call.name, argumentsValue).toolName
          : null;
        const effectivePolicy = effective ? hostControlFrameFor(effective) : null;
        return directPolicy === 'sole' || effectivePolicy === 'sole'
          ? [{ call, carried: directPolicy !== 'sole' }]
          : [];
      });
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error)
        .replace(/\s+/gu, ' ').trim().slice(0, 240) || 'control_consistency_check_failed';
      const paired = pairLocallyRefusedFrame(
        canonicalCalls,
        false,
        new Map([[canonicalCalls[0]!.callId,
          `The host could not revalidate the exact control frame (${detail}). No tool body was entered.`]]),
      );
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
    }
    if (soleControls.some((entry) => entry.carried)) {
      const paired = pairLocallyRefusedFrame(
        canonicalCalls,
        false,
        new Map([[canonicalCalls[0]!.callId,
          'The host refused an indirect control carrier before dispatch (host_control_requires_direct_first_class_call). No tool body was entered.']]),
      );
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
    }
    if (
      frameDisposition.kind !== 'fresh_plan_then_root_read'
      && soleControls.length > 0
      && (soleControls.length !== 1 || canonicalCalls.length !== 1)
    ) {
      const paired = pairLocallyRefusedFrame(
        canonicalCalls,
        false,
        new Map([[canonicalCalls[0]!.callId,
          'The host refused a non-fused control frame before dispatch (host_control_requires_sole_call_frame). No tool body was entered.']]),
      );
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
    }

    if (frameDisposition.kind === 'fresh_plan_then_root_read') {
      const frame = await executeFreshPlanThenRootRead(frameDisposition);
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: frame.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      if (frame.committedVerificationHolds.length > 0) {
        return committedVerificationHoldOutcome(
          frame.committedVerificationHolds,
          acceptedFrame.ref,
        );
      }
      if (frame.effectUnknown) {
        return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
      }
      if (frame.toolCallsLimit) propagateToolCallsLimit(frame.toolCallsLimit);
      if (frame.zeroCrossingRefusal) {
        recordZeroCrossingRefusal(frame.frameDigest);
        if (frame.hostFault) return blockedOutcome(frame.hostFault.text, frame.hostFault.reason, false);
        if (terminalBehaviorEligibleMixedResults(frame.returned)) {
          const finalOutput = await finalOutputFromToolBehavior(frame.returned);
          if (finalOutput !== undefined) return await completedOutcome(finalOutput);
        }
        continue;
      }
      // A frame that executed is progress: the refusal streak ends here.
      consecutiveFrameRefusals = 0;
      const finalOutput = await finalOutputFromToolBehavior(frame.returned);
      if (finalOutput !== undefined) return await completedOutcome(finalOutput);
      continue;
    }

    // Approval check happens BEFORE any execution in this batch, mirroring
    // the SDK contract the resume owner depends on: the paused tool's body
    // has never run.
    const pendingBatch: PendingHostCall[] = [];
    const preparedInBatch: object[] = [];
    const preApprovalRepairDiagnostics = new Map<
      string,
      { diagnostic: string; repairKey?: string }
    >();
    const preApprovalTypedRefusals = new Map<
      string,
      'repair_arguments' | 'stop_and_explain'
    >();
    let preApprovalRefused = false;
    for (const [callIndex, call] of canonicalCalls.entries()) {
      try {
      const tool = toolByName.get(call.name);
      const argumentsJson = materializedArgumentsJson(tool, call.argumentsJson);
      const parsedArguments = parsedArgs(argumentsJson);
      let approvalExactProduction: ExactProductionHostCall | null = null;
      const canaryRefusal = readOnlyCanaryRefusal(
        call.name,
        parsedArguments,
        argumentsJson,
        tool,
        call.callId,
      );
      if (!canaryRefusal && hostProduction && parsedArguments && tool) {
        const approvalToolCallItem = {
          type: 'function_call' as const,
          callId: call.callId,
          name: call.name,
          arguments: argumentsJson,
        };
        let exactProduction = exactProductionHostCall(
          call.name,
          parsedArguments,
          argumentsJson,
          tool,
          call.callId,
          runContext,
          { toolCall: approvalToolCallItem },
        );
        if (
          !exactProduction
          && lastExactProductionMiss.startsWith('catalog_entry_or_manifest_missing')
          && await jitProvisionCarriedOperation(call.name, parsedArguments)
        ) {
          exactProduction = exactProductionHostCall(
            call.name,
            parsedArguments,
            argumentsJson,
            tool,
            call.callId,
            runContext,
            { toolCall: approvalToolCallItem },
          );
        }
        approvalExactProduction = exactProduction;
        if (!approvalExactProduction) {
          preApprovalRefused = true;
          break;
        }
        const identity = exactHostIdentity();
        const materialGate = exactMaterialSourceGate({
          exactProduction: approvalExactProduction,
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
        });
        if (materialGate.status === 'refused') {
          preApprovalRefused = true;
          break;
        }
        const schemaRefusal = approvalExactProduction.validateBeforeConsent?.();
        if (schemaRefusal) {
          preApprovalRepairDiagnostics.set(call.callId, {
            diagnostic: schemaRefusal.output,
            ...(schemaRefusal.repairKey ? { repairKey: schemaRefusal.repairKey } : {}),
          });
          preApprovalTypedRefusals.set(call.callId, 'repair_arguments');
          preApprovalRefused = true;
          break;
        }
      }
      if (
        !canaryRefusal
        && hostProduction
        && parsedArguments
        && (
          isDelegationPrimitiveRuntimeCall(call.name, parsedArguments)
          || isUnscopedShellRuntimeCall(call.name, parsedArguments)
        )
      ) {
        const identity = exactHostIdentity();
        const materialSource = inspectDurableMaterialSourceContinuation({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
        });
        if (materialSource.status !== 'not_applicable') {
          preApprovalRefused = true;
          break;
        }
      }
      const runtimeEffect = currentFrameEffects.get(call.callId)
        ?? (parsedArguments ? classifyRuntimeToolEffect(call.name, parsedArguments).effect : 'unknown');
      const quantifiedWorkerControl = Boolean(
        !canaryRefusal
        && hostProduction
        && parsedArguments
        && (() => {
          const identity = exactHostIdentity();
          return exactQuantifiedWorkerControl({
            name: call.name,
            args: parsedArguments,
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
          });
        })(),
      );
      const mutation = Boolean(
        !canaryRefusal
        && hostProduction
        && parsedArguments
        && approvalExactProduction
        && !quantifiedWorkerControl
        && ['local_write', 'external_write', 'admin'].includes(runtimeEffect),
      );
      let needs = false;
      let consentOwned = quantifiedWorkerControl;
      let consentSubject: HostInteractiveConsentSubjectV1 | undefined;
      if (mutation && parsedArguments && tool && approvalExactProduction) {
        consentOwned = true;
        const authoredWorkflowConsent = acceptedFrame.ref
          ? await evaluateAuthoredWorkflowMutationConsent({
              attestation: approvalExactProduction.attestation,
              args: approvalExactProduction.logicalArgs,
              acceptedBatch: acceptedFrame.ref,
              callIndex,
            })
          : null;
        const consent = await (isPlainOrClementineLocalTool(call.name, 'work_call')
          && isHostPlanRequiredWorkCall(tool)
          ? (async () => {
              const identity = exactHostIdentity();
              const prepared = await withHostCallAttestation(
                approvalExactProduction.attestation,
                () => prepareHostWorkCall(tool, {
                  sessionId: identity.sessionId,
                  sourceUserSeq: identity.sourceUserSeq,
                  logicalToolCallId: call.callId,
                  outerArgs: parsedArguments,
                  runContext,
                  details: {
                    toolCall: {
                      type: 'function_call',
                      callId: call.callId,
                      name: call.name,
                      arguments: argumentsJson,
                    },
                  },
                }),
              );
              if (prepared.status !== 'prepared') {
                if (prepared.status === 'refused') {
                  const diagnostic = boundedHostPreparationRepairDiagnostic(prepared.output);
                  if (diagnostic) preApprovalRepairDiagnostics.set(call.callId, { diagnostic });
                  preApprovalTypedRefusals.set(call.callId, prepared.recovery);
                }
                return null;
              }
              preparedInBatch.push(prepared.preparation);
              const evaluated = await evaluatePreparedHostWorkCallConsent({
                preparation: prepared.preparation,
              });
              return evaluated;
            })()
          : authoredWorkflowConsent ?? evaluateUncoveredHostMutationConsent({
              attestation: approvalExactProduction.attestation,
              args: approvalExactProduction.logicalArgs,
            }));
        if (!consent || consent.status !== 'decided') {
          preApprovalRefused = true;
          break;
        }
        switch (consent.decision.kind) {
          case 'proceed':
            needs = false;
            if (consent.nestedAdmission) {
              nestedCallAdmissions.set(call.callId, consent.nestedAdmission);
            }
            // An authored-step grant is the write's consent; the port invoke
            // mints the adapter's call authority from it (see
            // authored-call-authority.ts) so a consented generic external
            // write no longer dies inside the shipped adapter.
            if (
              authoredWorkflowConsent
              && consent === authoredWorkflowConsent
              && authoredWorkflowConsent.status === 'decided'
              && authoredWorkflowConsent.coverage
            ) {
              authoredCallGrants.set(call.callId, {
                coverageContractId: authoredWorkflowConsent.coverage.contractId,
              });
            }
            break;
          case 'needs_user':
            if (consent.decision.need !== 'approval' || !consent.consentSubject) {
              preApprovalRefused = true;
              break;
            }
            needs = true;
            consentSubject = consent.consentSubject;
            break;
          case 'repair':
          case 'refuse':
          case 'reconcile':
            preApprovalRefused = true;
            break;
        }
        if (preApprovalRefused) break;
      }
      if (
        !consentOwned
        && !canaryRefusal
        && parsedArguments
        && tool
        && typeof tool.needsApproval === 'function'
      ) {
        try {
          needs = await tool.needsApproval(runContext, parsedArguments, call.callId) === true;
        } catch {
          // Approval predicates are an effect boundary. A broken predicate
          // must require confirmation, never authorize execution.
          needs = true;
        }
      }
      const pending: PendingHostCall = {
        callId: call.callId,
        name: call.name,
        rawItem: { name: call.name, arguments: argumentsJson, callId: call.callId },
        ...(consentSubject ? { consentSubject } : {}),
      };
      // Non-approval siblings are pre-authorized, but remain serialized with
      // the batch so none disappear while an approval sibling is paused.
      if (!needs) pending.decision = 'approved';
      pendingBatch.push(pending);
      } catch {
        preApprovalRefused = true;
        break;
      }
    }
    if (preApprovalRefused) {
      const refusalProgress = aggregateHostPreparationRefusalProgress(
        [...preApprovalTypedRefusals].map(([callId, recovery]) => ({ callId, recovery })),
      );
      const countingCallIds = refusalProgress.hasTypedRefusal
        ? new Set(refusalProgress.countingCallIds)
        : undefined;
      const released = preparedInBatch.every((candidate) => (
        releasePreparedHostWorkCallForRepair(candidate, 'sibling_frame_replanned_before_dispatch')
      ));
      for (const call of canonicalCalls) nestedCallAdmissions.delete(call.callId);
      if (!released) {
        throw new HostCallAuthorityBoundaryError('prepared_frame_release_failed');
      }
      const paired = pairLocallyRefusedFrame(
        canonicalCalls,
        false,
        preApprovalRepairDiagnostics,
        countingCallIds,
      );
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      if (refusalProgress.retireSemanticFrame) {
        recordZeroCrossingRefusal(paired.frameDigest);
      }
      continue;
    }
    const approvals = pendingBatch.filter((pending) => !pending.decision);
    if (approvals.length > 0) {
      const resultCommitBlock = commitAdmittedToolFrame({
        acceptedFrame,
        frameHistory: admission.frame.history,
        responseId: step.responseId,
      });
      if (resultCommitBlock) return resultCommitBlock;
      const state = new HostInterruptState(
        history,
        pendingBatch,
        lastResponseId,
        hostTurnEngine ?? 'host_v1_read_only',
        currentNoProgressCheckpoint(),
        acceptedFrame.ref,
      );
      return {
        history,
        lastResponseId,
        finalOutput: undefined,
        hasInterruptions: true,
        interruptions: approvals.map((pending) => ({
          toolName: pending.name,
          args: parsedArgs(pending.rawItem.arguments),
          rawArgs: pending.rawItem.arguments,
          ...(pending.consentSubject
            ? {
                approvalResumeKey: hostInteractiveConsentApprovalResumeKey(pending.consentSubject)
                  ?? undefined,
              }
            : {}),
        })),
        serializedState: state.toString(),
      } satisfies RunOutcome;
    }

    const frame = await executeCalls(canonicalCalls);
    if (frame.durableContinuationPending) {
      return recoveryOutcome({
        phase: 'admit',
        baseHistory: [...history],
        frameHistory: admission.frame.history,
        responseId: step.responseId,
        reason: 'durable_async_read_continuation_pending',
        // A paging read re-enters the same key on purpose and advances on its
        // own durable claim cursor. It is progress, not a stuck retry.
        boundedRetry: false,
      });
    }
    const resultCommitBlock = commitAdmittedToolFrame({
      acceptedFrame,
      frameHistory: admission.frame.history,
      resultItems: frame.resultItems,
      responseId: step.responseId,
    });
    if (resultCommitBlock) return resultCommitBlock;
    if (frame.committedVerificationHolds.length > 0) {
      return committedVerificationHoldOutcome(
        frame.committedVerificationHolds,
        acceptedFrame.ref,
      );
    }
    if (frame.effectUnknown) {
      return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
    }
    if (frame.toolCallsLimit) propagateToolCallsLimit(frame.toolCallsLimit);
    if (frame.zeroCrossingRefusal) {
      recordZeroCrossingRefusal(frame.frameDigest);
      // A host fault is durable in canonical history now; stop and explain
      // rather than hand the model a refusal it cannot repair.
      if (frame.hostFault) return blockedOutcome(frame.hostFault.text, frame.hostFault.reason, false);
      if (terminalBehaviorEligibleMixedResults(frame.returned)) {
        const finalOutput = await finalOutputFromToolBehavior(frame.returned);
        if (finalOutput !== undefined) return await completedOutcome(finalOutput);
      }
      continue;
    }
    const finalOutput = await finalOutputFromToolBehavior(frame.returned);
    if (finalOutput !== undefined) return await completedOutcome(finalOutput);
  }

};

/**
 * The HOST-owned replacement for defaultRunRunner. Same caller seam, no
 * Runner.run. One invocation is one physical authority generation; there are
 * deliberately no hidden model retries inside this wrapper.
 */
export const hostRunRunner: RunRunnerFn = async (runner, agent, itemsOrState, opts) => {
  const parent = harnessRunContextStorage.getStore();
  const scopeId = parent
    ? `${parent.dispatchLease?.scopeId
      ?? parent.behaviorScopeId
      ?? parent.sessionId}::host-runner:${randomUUID()}`
    : undefined;
  const lease: DispatchLeaseRef | undefined =
    parent && scopeId && getSession(parent.sessionId)
      ? activateDispatchLease({
          sessionId: parent.sessionId,
          scopeId,
          runAttemptId: parent.runAttemptId,
          parentLease: parent.dispatchLease,
        })
      : undefined;
  const physicalContext = parent
    ? {
        ...parent,
        ...(lease ? { dispatchLease: lease } : {}),
        // With wrapper accounting enabled, the host must cover native MCP and
        // every other FunctionTool that never passed through wrapToolForHarness.
        // With brackets disabled, loop.ts's legacy agent_tool_start listener
        // remains the single counter owner.
        hostOwnsToolAccounting: harnessToolBracketsEnabled(),
      }
    : parent;
  try {
    return physicalContext
      ? await withHarnessRunContext(
          physicalContext,
          () => runHostTurn(runner, agent, itemsOrState, opts),
        )
      : await runHostTurn(runner, agent, itemsOrState, opts);
  } finally {
    // Exact-generation and idempotent. Await before any caller recovery can
    // retry or fall over to another model/provider lane.
    await revokeDispatchLeaseBeforeRecovery(lease);
  }
};

// ---------------------------------------------------------------------------
// Host terminal reasons and bounded machine detail (SAY WHY; gates 10/11).
// Declared after the runner so the ring-owned regions above keep their line
// positions; every use runs after module initialization.
// ---------------------------------------------------------------------------

/** Machine reason prefix for the host fault where the accepted source (a
 * workflow step) literally names an operation that the host never provisioned
 * into this run's frozen catalog. The model cannot repair a provisioning gap,
 * so the turn stops and explains instead of entering a repair loop that the
 * no-progress governor would only terminalize as an opaque "internal error".
 * Live 2026-08-31: one run refused the same literally named read 15 times. */
/**
 * JIT READ EDGE (2026-09-01): a provider READ the accepted source never named
 * is not a refusal the model can correct — the host holds the exact provider
 * definition and can provision it on the spot (Platform 49 died calling the
 * spreadsheet-info read it needed for a required `sheet_id`). Writes stay
 * behind the frozen/authored bar: provisioning only makes a READ dispatchable
 * through the existing proven-live-read path. One attempt per operation per
 * turn, bounded wall time, and the provider definition must revalidate
 * exactly — nothing is synthesized from the model's spelling.
 */
export type HostJitReadProvisioner = (input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedInput: string;
  operationIds: readonly string[];
  deadlineAt: number;
}) => Promise<{ ok: true } | { ok: false; code: string; identifier: string; detail?: string }>;
const HOST_JIT_READ_PROVISION_BUDGET_MS = 20_000;
const productionHostJitReadProvisioner: HostJitReadProvisioner = async (input) => {
  const { provisionExactWorkflowProviderOperations } = await import('../../tools/tool-search-provider-sources.js');
  return provisionExactWorkflowProviderOperations(input);
};
let hostJitReadProvisioner: HostJitReadProvisioner = productionHostJitReadProvisioner;
export function _setHostJitReadProvisionerForTests(provisioner: HostJitReadProvisioner | null): void {
  hostJitReadProvisioner = provisioner ?? productionHostJitReadProvisioner;
}

/** A reviewed-CLI or live-read identity (`salesforce_sf_soql_query`) is
 * lowercase snake_case; a provider slug is UPPERCASE. The JIT read edge routes
 * the former through the attested live-read registry (the same acquisition
 * the workflow compiler uses), never through the provider materializer that
 * uppercases it into a slug that does not exist (live 2026-09-01: a chat
 * reviewed-CLI read dead-ended unless tool_search had run first). */
export function isReviewedLiveReadIdentity(operationId: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(operationId.trim());
}

type HostJitLiveReadAcquirer = (input: {
  ownerId: string;
  nodeId: string;
  operationId: string;
  deadlineAt: number;
}) => Promise<{ status: 'present' | 'acquired' | 'unavailable'; detail?: string }>;
const productionHostJitLiveReadAcquirer: HostJitLiveReadAcquirer = async (input) => {
  const { ensureLiveReadCapabilityForOperation } = await import('../../execution/workflow-live-call-compiler.js');
  return ensureLiveReadCapabilityForOperation({ ...input, expectedEffect: 'read' });
};
let hostJitLiveReadAcquirer: HostJitLiveReadAcquirer = productionHostJitLiveReadAcquirer;
export function _setHostJitLiveReadAcquirerForTests(acquirer: HostJitLiveReadAcquirer | null): void {
  hostJitLiveReadAcquirer = acquirer ?? productionHostJitLiveReadAcquirer;
}
export const HOST_LITERAL_OPERATION_NOT_FROZEN_REASON_PREFIX = 'literal_workflow_operation_not_frozen:';

export function literalOperationNotFrozenReason(operationId: string): string {
  return `${HOST_LITERAL_OPERATION_NOT_FROZEN_REASON_PREFIX}${operationId}`;
}

/** The operation named by a literal-operation host-fault reason, or null. */
export function literalOperationNotFrozenOperation(reason: string | undefined): string | null {
  if (!reason || !reason.startsWith(HOST_LITERAL_OPERATION_NOT_FROZEN_REASON_PREFIX)) return null;
  const operationId = reason.slice(HOST_LITERAL_OPERATION_NOT_FROZEN_REASON_PREFIX.length).trim();
  return operationId || null;
}

export function hostLiteralOperationNotFrozenBlockedText(operationId: string): string {
  return `This step names the operation ${boundedVerificationSurface(operationId, 120)}, but the host did not provision it into this run's frozen catalog, so it cannot be called here. I stopped before any external action and nothing was changed. Once that operation is provisioned or its account reconnected, rerun the step.`;
}

/** Bounded machine detail persisted beside a blocked terminal's reason. */
export const HOST_BLOCKED_DETAIL_MAX_CHARS = 160;

/** A pre-dispatch refusal the model cannot repair. The runner commits the
 * paired refusal frame, then stops and explains with this reason/text. */
interface HostFaultTerminal {
  reason: string;
  text: string;
}

/** A host turn outcome may carry bounded machine detail beside its terminal
 * reason (for example the last pre-dispatch refusal check that exhausted the
 * no-progress governor). It rides outside `terminal` so the exact terminal
 * identity pins stay byte-stable; the conversation reducer persists it as
 * `blockedDetail` metadata, never as user-facing prose. */
export type HostRunOutcome = RunOutcome & { blockedDetail?: string };

export function hostBlockedTerminalDetail(outcome: RunOutcome): string | undefined {
  const detail = (outcome as { blockedDetail?: unknown }).blockedDetail;
  return typeof detail === 'string' && detail.trim() ? detail : undefined;
}

function boundedBlockedDetail(value: string): string {
  return boundedVerificationSurface(value, HOST_BLOCKED_DETAIL_MAX_CHARS);
}

/** Reduce one host refusal diagnostic to its machine check when it has one:
 * the canary/binding refusal names `Failed check: <token>.`, frame and plan
 * control refusals name `before dispatch (<token>)`; a provider schema
 * refusal already starts with its `[provider-dispatch:...]` class. */
function hostRefusalDiagnosticDetail(diagnostic: string): string {
  const failedCheck = /Failed check: (\S+?)\.(?:\s|$)/u.exec(diagnostic);
  if (failedCheck?.[1]) return failedCheck[1];
  const frameRefusal = /before dispatch \(([^)]+)\)/u.exec(diagnostic);
  if (frameRefusal?.[1]) return frameRefusal[1];
  return diagnostic;
}

/** The most recent tool frame's host refusal, as bounded machine detail. Only
 * one run of tool results is inspected — the latest one — so an older refusal
 * can never be reported past a later frame that dispatched cleanly. Items
 * after that run (the model's give-up text, a host directive) are skipped:
 * live 2026-09-01 a run that ended on the model's text after two refused
 * write frames persisted only the governor stage, and the actual check
 * (`plan_scope_missing_or_changed`) had to be reconstructed from timestamps. */
export function lastHostRefusalDetail(history: readonly AgentInputItem[]): string | undefined {
  let insideResultRun = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!;
    if ((item as { type?: unknown }).type !== 'function_call_result') {
      if (insideResultRun) break;
      continue;
    }
    insideResultRun = true;
    const text = (functionResultText(item) ?? '').trim();
    if (!text) continue;
    let diagnostic: string | null = null;
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as { protocol?: unknown; disposition?: unknown; diagnostic?: unknown };
        if (parsed && parsed.protocol === 'host_tool_disposition_v1') {
          if (parsed.disposition !== 'refused_pre_dispatch' || typeof parsed.diagnostic !== 'string') continue;
          diagnostic = parsed.diagnostic;
        }
      } catch { /* not a host disposition marker */ }
    }
    if (diagnostic === null) {
      if (!text.startsWith('[provider-dispatch:')) continue;
      diagnostic = text;
    }
    const detail = boundedBlockedDetail(hostRefusalDiagnosticDetail(diagnostic));
    if (detail) return detail;
  }
  return undefined;
}
