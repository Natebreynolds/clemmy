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
import type { Agent, AgentInputItem } from '@openai/agents';
import {
  boundAgentCapabilityEnvelope,
  boundAgentCapabilityRevision,
  toolSchemaFingerprint,
} from '../../agents/capability-envelope.js';
import type { InterruptionInfo, RunOutcome, RunRunnerFn } from './loop.js';
import { acceptedTaskIdFor } from './attempt-identity.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
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
import { getSession, isKillRequested, openEventLog } from './eventlog.js';
import {
  ModelStreamStalledError,
  modelFirstByteStallMs,
  modelStreamStallMs,
} from './model-stall-policy.js';
import {
  actionTopologyRoleForRuntimeCall,
  classifyRuntimeToolEffect,
  isDelegationPrimitiveRuntimeCall,
  isUnscopedShellRuntimeCall,
  runtimeToolAuthorityBinding,
  trustedRuntimeEffectCarrier,
  unwrapRuntimeEffectiveToolIdentity,
  type RuntimeToolEffect,
  type TrustedRuntimeEffectCarrier,
} from './tool-effect.js';
import { isPlainOrClementineLocalTool } from './runtime-tool-identity.js';
import { classifyDiscoveryCall } from './discovery-boundary.js';
import { hostControlFrameFor, hostReadOnlyExecutionContractFor } from '../../tools/tool-registry.js';
import {
  isHostPlanRequiredWorkCall,
  releasePreparedHostWorkCallForRepair,
} from '../../tools/work-call.js';
import { prepareHostWorkCall } from '../../tools/work-call-mode.js';
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
import type { HostTurnEngineMode } from './turn-engine-selection.js';
import {
  canonicalCatalogIdentityOf,
  freezeCatalogSnapshotForSource,
  peekHostCapabilityCatalogFactory,
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
} from './host-model-frame-policy.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';
import { inspectDurableMaterialSourceContinuation } from './task-continuity-runtime.js';
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
import { settledPlanTaskActivationWinner } from './plan-task-post-settlement.js';
const HOST_STATE_VERSION = 3;
const HOST_STATE_KEY = '__clemHostInterrupt';
const HOST_READ_ONLY_SURFACE_VERSION = 'configured_harness_function_surface_v1';

/**
 * Public copy for a durable stop-and-explain settlement. It is deliberately
 * value-opaque: provider/tool names and arguments are model input, not safe
 * terminal presentation authority.
 */
export const HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT =
  'I stopped before any provider call because this operation is not authorized by the task\'s current execution authority. Nothing external was executed or changed. The task needs a fresh verified authority binding before this operation can continue.';

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

export const HOST_CAPABILITY_UNAVAILABLE_TEXT =
  'That exact capability is unavailable for this request after two safe, no-effect attempts. I kept the conversation intact; choose another available capability or adjust the request before trying again.';

const HOST_TOOL_DISPOSITION_PROTOCOL = 'host_tool_disposition_v1' as const;

type HostToolDisposition =
  | 'refused_pre_dispatch'
  | 'not_started'
  | 'effect_unknown';

interface HostToolDispositionOutput {
  protocol: typeof HOST_TOOL_DISPOSITION_PROTOCOL;
  disposition: HostToolDisposition;
  frameDigest: string;
  frameIndex: number;
  frameSize: number;
  /** Exactly one result in a refused frame carries the restart counter. */
  countsRefusal?: true;
  effect: 'none' | 'may_have_started';
  retry: 'replan' | 'do_not_retry';
  requiresReconciliation: boolean;
  message: string;
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
    };
    const version = parsed[HOST_STATE_KEY];
    if (version !== 1 && version !== 2 && version !== 3 && version !== HOST_STATE_VERSION) {
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
    if (version === HOST_STATE_VERSION) {
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
    );
  }

  toString(): string {
    return JSON.stringify({
      [HOST_STATE_KEY]: HOST_STATE_VERSION,
      history: this.history,
      pending: this.pending,
      turnEngine: this.turnEngine,
      ...(this.lastResponseId !== undefined ? { lastResponseId: this.lastResponseId } : {}),
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

type HostCallScheduleClass = 'parallel' | 'barrier';

interface HostCallInvocationObservation {
  /** True only after execution has crossed the local pre-invocation phase. */
  invocationEntered: boolean;
}

type HostCallExecutionAttempt<R> =
  | { status: 'returned'; value: R; invocationEntered: boolean }
  | { status: 'failed'; error: unknown; invocationEntered: boolean };

/**
 * Execute deterministic waves while retaining every started call's outcome.
 * Once one call fails, no new call is assigned; already-running reads drain so
 * their exact results can still be paired in model order. Undefined entries
 * are calls that provably never entered execution.
 */
async function mapHostCallAttemptsWithBarriersInOrder<T, R>(
  values: readonly T[],
  concurrency: number,
  classify: (value: T) => HostCallScheduleClass,
  fn: (value: T) => Promise<HostCallExecutionAttempt<R>>,
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
    if (attempt.status === 'failed') stopped = true;
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
    const planActivated = freshPlan && actionExpectedWorkRequired(identity);
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
        && freshPlan
        && planActivated
        && settledFreshPlanControl(identity);
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
    const rootCatalogDigest = freshPlan
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
        maxLogicalCalls: identity.maxLogicalCalls,
        maxParallelCalls: Math.min(maxToolConcurrency, identity.maxLogicalCalls),
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
  let resumedResponseId: string | undefined;
  if (resumedHostState) {
    history.push(...itemsOrState.history);
    pendingFromResume = itemsOrState.pending;
    // A pause does not discard what was already accepted.
    resumedResponseId = itemsOrState.lastResponseId;
  } else {
    history.push(...(itemsOrState as AgentInputItem[]));
  }
  const zeroCrossingRefusalCounts = priorZeroCrossingRefusalCounts(history);
  const retiredZeroCrossingFrames = new Set(
    [...zeroCrossingRefusalCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([digest]) => digest),
  );

  if (!resumedHostState) await runInputGuardrails(history);

  emit('agent_start', runContext, agent);

  // Seeded from the resumed state so a pause/resume — and any block after it —
  // reports the identity this host last ACCEPTED. Only an admitted response
  // may replace it; a rejected one leaves it exactly as it was.
  let lastResponseId: string | undefined = resumedResponseId ?? hostPreviousResponseId;
  const blockedOutcome = (
    text = HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT,
    reason = 'durable_stop_and_explain',
  ): RunOutcome => {
    emit('agent_end', runContext, agent, text);
    return {
      history,
      lastResponseId,
      finalOutput: text,
      terminal: {
        status: 'blocked',
        reason,
      },
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

    let stallTimer: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setInterval> | undefined;
    let rejectCallerAbort: (() => void) | undefined;
    const streamMs = modelStreamStallMs();
    const firstByteMs = modelFirstByteStallMs();
    let lastSemanticActivityAt = Date.now();
    let sawActionableActivity = false;
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
        if (Date.now() - observedActivityAt < windowMs) return;
        const error = new ModelStreamStalledError(
          Math.max(1, Math.round(windowMs / 1000)),
          !sawActionableActivity,
          bufferedProviderRequestInFlight,
        );
        if (!controller.signal.aborted) controller.abort(error);
        reject(error);
      }, tickMs);
    });
    const killed = new Promise<never>((_, reject) => {
      if (!ambient?.sessionId) return;
      killTimer = setInterval(() => {
        try {
          if (!isKillRequested(ambient.sessionId, killTarget)) return;
          const error = new KillRequested(ambient.sessionId);
          if (!controller.signal.aborted) controller.abort(error);
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
    try {
      return await Promise.race([
        codexOneStep({
          input: modelInput,
          tools: schemas as never,
          ...(modelId !== undefined ? { modelId } : {}),
          ...(resolveModel ? { resolveModel } : {}),
          ...(instructions !== undefined ? { systemInstructions: instructions } : {}),
          modelSettings,
          signal: controller.signal,
          stream: true,
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
    invoke: (signal: AbortSignal) => Promise<unknown>;
  }

  const exactProductionHostCall = (
    name: string,
    args: Record<string, unknown> | null,
    argumentsJson: string,
    tool: FunctionToolLike | undefined,
    logicalToolCallId: string,
    runContextForCall: RunContext<unknown>,
    details: unknown,
  ): ExactProductionHostCall | null => {
    if (!hostProduction || !args || !tool) return null;
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
    if (
      !envelope
      || !revision
      || envelope.attemptId !== identity.sessionId
      || revision.envelopeDigest !== envelope.envelopeDigest
      || !revision.bound.includes(name)
      || capability.length !== 1
      || capability[0]!.accountIdentity !== ''
      || capability[0]!.schemaFingerprint !== toolSchemaFingerprint(tool)
      || decision.effect === 'unknown'
      || !effectiveName
      || root.status !== 'ok'
      || !exactHostRoot
      || root.authority.state !== 'open'
      || root.authority.identity.acceptedTaskId !== acceptedTaskId
      || !contract
    ) return null;

    const candidates = surface.snapshot.entries.filter((entry) => {
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
    });
    if (candidates.length > 1) return null;

    const common = {
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      acceptedTaskId,
      sourceEventId: root.authority.sourceEventId,
      sourceEventDigest: root.authority.sourceEventDigest,
      logicalToolCallId,
      toolName: contract.toolName,
      argumentDigest: contract.argumentDigest,
      effect: decision.effect,
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
    // inherit the local envelope as a fallback.
    const authorityBinding = runtimeToolAuthorityBinding(decision);
    if (authorityBinding === 'unknown') return null;
    const catalogEntry = candidates[0];
    if (authorityBinding === 'catalog_manifest' || catalogEntry) {
      const manifest = currentCapabilityManifest(catalogEntry?.manifest);
      if (!catalogEntry || !manifest) return null;
      const port = resolveProductionPortsForManifest(manifest);
      if (!port || manifest.invokePortId !== canonicalCatalogIdentityOf(catalogEntry)?.invokePortId) return null;
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
      const bindingDigest = hostSurfaceDigest({ version: 1, ...binding, effect: decision.effect });
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
      const preserveWorkCallCarrier = isPlainOrClementineLocalTool(name, 'work_call');
      const attestation = { ...common, ...binding, bindingDigest };
      return {
        attestation,
        manifest,
        effect: decision.effect,
        boundary: preserveWorkCallCarrier ? 'nested_owned' : 'host_owned_external',
        logicalToolName: manifest.operationId,
        logicalArgs: effectiveArgs,
        ...(sourceCapability ? { sourceCapability } : {}),
        sourcePurpose,
        trustedEffectCarrier: trustedRuntimeEffectCarrier(name, args),
        invoke: preserveWorkCallCarrier
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

    if (authorityBinding !== 'local_envelope') return null;
    const effectClass = capability[0]!.effectClass;
    const localEffectFits = decision.effect === 'read'
      || decision.effect === 'compute'
      || decision.effect === 'host_only'
      || (decision.effect === 'local_write' && (effectClass === 'write' || effectClass === 'send'));
    if (!localEffectFits) return null;
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
    const bindingDigest = hostSurfaceDigest({ version: 1, ...binding, effect: decision.effect });
    const preserveLocalCarrier = isPlainOrClementineLocalTool(name, 'call_tool')
      || isPlainOrClementineLocalTool(name, 'work_call');
    return {
      attestation: { ...common, ...binding, bindingDigest },
      effect: decision.effect,
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
      if (materialSource.status === 'not_applicable') {
        if (!structuralRole) {
          return exactProduction.sourcePurpose.status === 'unknown'
            ? { status: 'refused', reason: 'material_source_manifest_purpose_unknown' }
            : { status: 'unscoped' };
        }
        const identityAdmission = evaluateSourceStrategyIdentityAdmission({
          requirementEffect: 'read',
          requirementRole: structuralRole,
          decision: decisionInspection.status === 'ok' ? decisionInspection.decision : null,
          ...(exactProduction.sourceCapability
            ? { capability: exactProduction.sourceCapability }
            : {}),
          bindingRequired: false,
        });
        if (
          identityAdmission.status !== 'not_applicable'
          || identityAdmission.reason !== 'no_binding'
        ) {
          return {
            status: 'refused',
            reason: identityAdmission.status === 'refused'
              ? `material_source_${identityAdmission.kind}`
              : 'material_source_ordinary_identity_changed',
          };
        }
        return {
          status: 'delegated',
          requirement: { role: structuralRole, effect: 'read', bindingRequired: false },
        };
      }
      if (!exactProduction.sourceCapability) {
        return { status: 'refused', reason: 'material_source_physical_identity_missing' };
      }
      if (
        decisionInspection.status !== 'ok'
        || JSON.stringify(decisionInspection.decision) !== JSON.stringify(materialSource.decision)
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
        || JSON.stringify(admission.binding) !== JSON.stringify(materialSource.binding)
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
      || !configuredToolRefs.has(tool)
      || !isHarnessBoundFunctionTool(tool)
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
      return `Tool '${name}' was refused before dispatch because its exact capability, effect, account, schema, or invoke binding is absent or changed. No local or external mutation was attempted.`;
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

  const executeCall = async (
    call: { callId: string; name: string; argumentsJson: string },
    observation: HostCallInvocationObservation = { invocationEntered: false },
  ): Promise<{
    historyItem: AgentInputItem;
    tool?: FunctionToolLike;
    output: unknown;
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
    const canaryRefusal = readOnlyCanaryRefusal(
      call.name,
      parsedArguments,
      argumentsJson,
      tool,
      call.callId,
    );
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
    if (canaryRefusal) {
      output = canaryRefusal;
    } else if (!tool || typeof tool.invoke !== 'function') {
      output = `Tool '${call.name}' not found. Use tool_search to retrieve the current schema, then invoke it through the advertised carrier.`;
    } else if (!parsedArguments) {
      output = `Tool '${call.name}' received invalid arguments. Supply exactly one JSON object that matches the advertised schema before retrying.`;
    } else if (inputGuardrail.type === 'reject') {
      output = inputGuardrail.message;
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
                      && JSON.stringify(admission.binding) === JSON.stringify(materialGate.expectedBinding);
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
    emit('agent_tool_end', runContext, agent, tool ?? { name: call.name }, text, details);
    return {
      historyItem: functionResultItem(call.callId, call.name, output),
      ...(tool ? { tool } : {}),
      output,
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
      return redeemed.status === 'ok'
        && redeemed.settlement.executionKind === 'refused_pre_dispatch'
        && redeemed.settlement.physicalCrossingCount === 0
        && redeemed.settlement.hostCrossingCount === 0
        ? 'zero_crossing'
        : 'effect_may_have_started';
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
  }): AgentInputItem => {
    const unknown = input.disposition === 'effect_unknown';
    const retired = input.retired === true;
    const output: HostToolDispositionOutput = {
      protocol: HOST_TOOL_DISPOSITION_PROTOCOL,
      disposition: input.disposition,
      frameDigest: input.frameDigest,
      frameIndex: input.frameIndex,
      frameSize: input.frameSize,
      ...(input.countsRefusal ? { countsRefusal: true as const } : {}),
      effect: unknown ? 'may_have_started' : 'none',
      retry: unknown || retired ? 'do_not_retry' : 'replan',
      requiresReconciliation: unknown,
      message: unknown
        ? 'Execution may have started. Do not retry this call; reconciliation is required.'
        : retired
          ? 'This exact call is unavailable for this request. Do not retry it; use another capability or explain the limitation.'
          : input.disposition === 'not_started'
            ? 'This call was not started because another call in the same frame could not safely proceed. No effect occurred; replan from the paired results.'
            : 'This call was refused before execution. No effect occurred; correct the call or choose another capability.',
    };
    return functionResultItem(input.call.callId, input.call.name, output);
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
        const effect = classifyRuntimeToolEffect(call.name, argumentsValue).effect;
        return effect === 'read' || effect === 'compute' ? 'parallel' : 'barrier';
      },
      executeCallAttempt,
    )
  );

  interface PairedCallAttempts {
    resultItems: AgentInputItem[];
    returned: ExecutedHostCall[];
    frameDigest: string;
    zeroCrossingRefusal: boolean;
    effectUnknown: boolean;
  }

  const pairCallAttempts = (
    calls: readonly CanonicalHostCall[],
    attempts: readonly (HostCallExecutionAttempt<ExecutedHostCall> | undefined)[],
  ): PairedCallAttempts => {
    const frameDigest = semanticFrameDigest(calls);
    const crossings = calls.map((call, index) => {
      const attempt = attempts[index];
      return attempt?.status === 'failed'
        ? failedCallCrossingDisposition(call, attempt)
        : null;
    });
    const effectUnknown = crossings.some((crossing) => crossing === 'effect_may_have_started');
    const zeroCrossingRefusal = !effectUnknown
      && crossings.some((crossing) => crossing === 'zero_crossing');
    let refusalMarkerWritten = false;
    const returned: ExecutedHostCall[] = [];
    const resultItems = calls.map((call, index) => {
      const attempt = attempts[index];
      if (attempt?.status === 'returned') {
        returned.push(attempt.value);
        return attempt.value.historyItem;
      }
      if (!attempt) {
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
    });
    return {
      resultItems,
      returned,
      frameDigest,
      zeroCrossingRefusal,
      effectUnknown,
    };
  };

  const pairLocallyRefusedFrame = (
    calls: readonly CanonicalHostCall[],
    retired = false,
  ): PairedCallAttempts => {
    const frameDigest = semanticFrameDigest(calls);
    return {
      frameDigest,
      zeroCrossingRefusal: true,
      effectUnknown: false,
      returned: [],
      resultItems: calls.map((call, index) => dispositionResult({
        call,
        disposition: 'refused_pre_dispatch',
        frameDigest,
        frameIndex: index,
        frameSize: calls.length,
        retired,
        countsRefusal: index === 0,
      })),
    };
  };

  const commitAdmittedToolFrame = (input: {
    frameHistory: readonly AgentInputItem[];
    resultItems?: readonly AgentInputItem[];
    responseId?: string;
  }): void => {
    history.push(...input.frameHistory, ...(input.resultItems ?? []));
    if (input.responseId !== undefined) lastResponseId = input.responseId;
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
    if (!planReady) return pairLocallyRefusedFrame(calls);

    const planAttempt = await executeCallAttempt(frame.plan);
    if (planAttempt.status === 'failed') {
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

  // Resume: settle the user's decisions FIRST — the approved tool executes
  // exactly once, a rejection becomes a visible tool result, and only then
  // may the model take its next step. There is no replay path here, so an
  // approved external write can never fire twice from this runner.
  let resumeSurfaceFallback = false;
  if (resumedToolSurfaceUnavailable) {
    const calls = pendingFromResume.map((pending): CanonicalHostCall => ({
      callId: pending.callId,
      name: pending.name,
      argumentsJson: pending.rawItem.arguments,
    }));
    if (calls.length > 0) {
      const paired = pairLocallyRefusedFrame(calls);
      history.push(...paired.resultItems);
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
    let resumeFrameRepair = false;
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
      const released = preparedMutations.every(({ preparation }) => (
        releasePreparedHostWorkCallForRepair(
          preparation,
          resumeFrameRejected
            ? 'user_rejected_before_dispatch'
            : 'approval_scope_changed_before_dispatch',
        )
      ));
      for (const pending of pendingFromResume) nestedCallAdmissions.delete(pending.callId);
      if (!released) {
        throw new HostCallAuthorityBoundaryError('resumed_prepared_frame_release_failed');
      }
      if (resumeFrameRejected && !resumeFrameRepair) {
        const frameDigest = semanticFrameDigest(calls);
        history.push(...pendingFromResume.map((pending, index) => (
          pending.decision === 'rejected'
            ? functionResultItem(
                pending.callId,
                pending.name,
                'The user rejected this action. Do not retry it; continue without it or explain what changes.',
              )
            : dispositionResult({
                call: calls[index]!,
                disposition: 'not_started',
                frameDigest,
                frameIndex: index,
                frameSize: calls.length,
              })
        )));
      } else {
        const paired = pairLocallyRefusedFrame(calls);
        history.push(...paired.resultItems);
        recordZeroCrossingRefusal(paired.frameDigest);
      }
      pendingFromResume = [];
    }

    if (pendingFromResume.length === 0) {
      // The paired rejection/repair is ordinary model input; continue below.
    } else {
      const approvedAttempts = await executeCallAttempts(calls);
      const paired = pairCallAttempts(calls, approvedAttempts);
      history.push(...paired.resultItems);
      if (paired.effectUnknown) {
        return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
      }
      if (paired.zeroCrossingRefusal) recordZeroCrossingRefusal(paired.frameDigest);
      const finalOutput = !paired.zeroCrossingRefusal
        ? await finalOutputFromToolBehavior(paired.returned)
        : undefined;
      if (finalOutput !== undefined) return await completedOutcome(finalOutput);
    }
  }

  for (let stepIndex = 0; ; stepIndex += 1) {
    if (stepIndex >= maxTurns) {
      return blockedOutcome(HOST_MODEL_LIMIT_BLOCKED_TEXT, 'max_turns');
    }
    try {
      await refreshTools();
    } catch (error) {
      if (resumeSurfaceFallback) {
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
    // THE MODEL NEVER RECEIVES CANONICAL HISTORY, filter or no filter.
    //
    // The filtered branch already cloned; the unfiltered branch aliased, so on
    // every turn without a `callModelInputFilter` the durable projection and
    // the request payload were the same array. A provider adapter that
    // normalises, annotates or truncates its input in place would then be
    // editing history that has already been accepted — silently, and only on
    // the configuration that looks simplest.
    let modelInput: AgentInputItem[] = structuredClone(history);
    // Match Agent.getSystemPrompt semantics: dynamic instructions are
    // re-evaluated before EVERY model step so newly written memory/context is
    // visible without restarting the daemon.
    let instructions = await resolveInstructions();
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
    let step: Awaited<ReturnType<typeof codexOneStep>>;
    try {
      step = await runOneModelStep(modelInput, instructions);
    } catch (error) {
      if (error instanceof ModelStreamStalledError) {
        return blockedOutcome(HOST_MODEL_STALL_BLOCKED_TEXT, 'model_stalled');
      }
      throw error;
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
      history.push(...admission.frame.history);
      if (step.responseId !== undefined) lastResponseId = step.responseId;
      return await completedOutcome(admission.frame.text);
    }

    const canonicalCalls = admission.frame.calls;
    const canonicalFrameDigest = semanticFrameDigest(canonicalCalls);
    if (retiredZeroCrossingFrames.has(canonicalFrameDigest)) {
      const paired = pairLocallyRefusedFrame(canonicalCalls, true);
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      return await completedOutcome(HOST_CAPABILITY_UNAVAILABLE_TEXT);
    }
    let frameDisposition: HostModelFrameDisposition;
    try {
      const frameCalls = canonicalCalls.map((call) => {
        const tool = toolByName.get(call.name);
        const argumentsJson = materializedArgumentsJson(tool, call.argumentsJson);
        const argumentsValue = parsedArgs(argumentsJson);
        const effectiveName = argumentsValue
          ? unwrapRuntimeEffectiveToolIdentity(call.name, argumentsValue).toolName
          : null;
        return {
          callId: call.callId,
          name: call.name,
          argumentsJson,
          argumentsValue,
          effectiveName,
          effect: argumentsValue
            ? classifyRuntimeToolEffect(call.name, argumentsValue).effect
            : 'unknown' as const,
          proposalFreeWorkCarrier: Boolean(
            tool
            && isHostPlanRequiredWorkCall(tool)
            && isPlainOrClementineLocalTool(call.name, 'work_call'),
          ),
        };
      });
      frameDisposition = classifyHostModelFrame({
        calls: frameCalls,
        planActivated: hostProduction
          ? actionExpectedWorkRequired(exactHostIdentity())
          : false,
        allowFreshPlanReadFusion: hostProduction,
      });
    } catch {
      const paired = pairLocallyRefusedFrame(canonicalCalls);
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
    }
    if (frameDisposition.kind === 'refused') {
      const paired = pairLocallyRefusedFrame(canonicalCalls);
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
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
    } catch {
      const paired = pairLocallyRefusedFrame(canonicalCalls);
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
    }
    if (soleControls.some((entry) => entry.carried)) {
      const paired = pairLocallyRefusedFrame(canonicalCalls);
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
    }
    if (
      frameDisposition.kind !== 'fresh_plan_then_root_read'
      && soleControls.length > 0
      && (soleControls.length !== 1 || canonicalCalls.length !== 1)
    ) {
      const paired = pairLocallyRefusedFrame(canonicalCalls);
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
    }

    if (frameDisposition.kind === 'fresh_plan_then_root_read') {
      const frame = await executeFreshPlanThenRootRead(frameDisposition);
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        resultItems: frame.resultItems,
        responseId: step.responseId,
      });
      if (frame.effectUnknown) {
        return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
      }
      if (frame.zeroCrossingRefusal) {
        recordZeroCrossingRefusal(frame.frameDigest);
        continue;
      }
      const finalOutput = await finalOutputFromToolBehavior(frame.returned);
      if (finalOutput !== undefined) return await completedOutcome(finalOutput);
      continue;
    }

    // Approval check happens BEFORE any execution in this batch, mirroring
    // the SDK contract the resume owner depends on: the paused tool's body
    // has never run.
    const pendingBatch: PendingHostCall[] = [];
    const preparedInBatch: object[] = [];
    let preApprovalRefused = false;
    for (const call of canonicalCalls) {
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
        const exactProduction = exactProductionHostCall(
          call.name,
          parsedArguments,
          argumentsJson,
          tool,
          call.callId,
          runContext,
          { toolCall: approvalToolCallItem },
        );
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
      const runtimeEffect = parsedArguments
        ? classifyRuntimeToolEffect(call.name, parsedArguments).effect
        : 'unknown';
      const mutation = Boolean(
        !canaryRefusal
        && hostProduction
        && parsedArguments
        && approvalExactProduction
        && ['local_write', 'external_write', 'admin'].includes(runtimeEffect),
      );
      let needs = false;
      let consentOwned = false;
      let consentSubject: HostInteractiveConsentSubjectV1 | undefined;
      if (mutation && parsedArguments && tool && approvalExactProduction) {
        consentOwned = true;
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
              if (prepared.status !== 'prepared') return null;
              preparedInBatch.push(prepared.preparation);
              const evaluated = await evaluatePreparedHostWorkCallConsent({
                preparation: prepared.preparation,
              });
              return evaluated;
            })()
          : evaluateUncoveredHostMutationConsent({
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
      const released = preparedInBatch.every((candidate) => (
        releasePreparedHostWorkCallForRepair(candidate, 'sibling_frame_replanned_before_dispatch')
      ));
      for (const call of canonicalCalls) nestedCallAdmissions.delete(call.callId);
      if (!released) {
        throw new HostCallAuthorityBoundaryError('prepared_frame_release_failed');
      }
      const paired = pairLocallyRefusedFrame(canonicalCalls);
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        resultItems: paired.resultItems,
        responseId: step.responseId,
      });
      recordZeroCrossingRefusal(paired.frameDigest);
      continue;
    }
    const approvals = pendingBatch.filter((pending) => !pending.decision);
    if (approvals.length > 0) {
      commitAdmittedToolFrame({
        frameHistory: admission.frame.history,
        responseId: step.responseId,
      });
      const state = new HostInterruptState(
        history,
        pendingBatch,
        lastResponseId,
        hostTurnEngine ?? 'host_v1_read_only',
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
    commitAdmittedToolFrame({
      frameHistory: admission.frame.history,
      resultItems: frame.resultItems,
      responseId: step.responseId,
    });
    if (frame.effectUnknown) {
      return blockedOutcome(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
    }
    if (frame.zeroCrossingRefusal) {
      recordZeroCrossingRefusal(frame.frameDigest);
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
