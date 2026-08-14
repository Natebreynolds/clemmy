/**
 * The one place a tool attempt is settled, for every lane.
 *
 * Claude, Codex, BYO, native MCP, Composio and code mode all end a tool call
 * here. Before this each lane settled its own way — one read a boolean off
 * prose, one read an envelope, one threw and lost the reason entirely — so the
 * same failure produced three different recoveries depending on who was
 * driving. Recovery that differs by lane is not recovery, it is luck.
 *
 * This module does two things and nothing else:
 *   1. EXTRACT structured evidence from whatever the lane got back — a returned
 *      envelope or a thrown error, both — without reading prose for meaning.
 *   2. ENACT the resulting `RecoveryDirective`: move the discovery budget,
 *      credit progress, and hand the caller a typed outcome to act on.
 */
import { openEventLog } from './eventlog.js';
import { acceptedTaskIdFor, settlementIdentityFor } from './attempt-identity.js';
import {
  classifyAttemptOutcome,
  type AttemptOutcome,
  type AttemptSignals,
} from './attempt-outcome.js';
import { callableContractIdentity, normalizeCallableArguments } from './callable-contract.js';
import { loadExpectedWorkCallBindingState } from './expected-work-admission.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { isDeterministicImplicitRetrieveContract } from './expected-work-matcher.js';
import { toResultHandle } from './result-handle.js';
import { deriveResultHandleFactsFromRaw } from './result-facts.js';
import { inspectProviderEnvelope } from './provider-read-evidence.js';
import {
  isShellPolicyDenialResult,
  type ShellExecutionOutcome,
} from '../shell-execution-outcome.js';
import {
  commitLogicalCallSettlement,
  type LogicalCallSettlementResult,
} from './logical-call-settlement-store.js';
import { beginPhysicalDispatch, settlePhysicalDispatch } from './dispatch-ledger.js';
import { actionTopologyRoleForRuntimeCall, classifyRuntimeToolEffect } from './tool-effect.js';
import { TruncatedToolOutputResult } from './tool-output-format.js';

export { normalizeCallableArguments, toResultHandle };

/** Translate the host's typed shell truth into the shared outcome vocabulary.
 * No stdout/stderr wording participates in this decision. */
export function attemptSignalsFromShellExecutionOutcome(
  shell: ShellExecutionOutcome | undefined,
): AttemptSignals {
  if (!shell) return {};
  if (shell.errorKind === 'timeout') {
    return {
      errorName: 'TimeoutError',
      mutating: shell.externalMutation,
      ...(shell.externalMutation ? { acknowledged: false } : {}),
    };
  }
  if (
    shell.dispatch === 'not_started'
    && shell.effect === 'none'
    && (shell.errorKind === 'command_not_found' || shell.errorKind === 'package_materialization_failed')
  ) {
    return {
      preDispatch: true,
      errorName: shell.errorKind === 'command_not_found'
        ? 'ShellCommandNotFoundError'
        : 'ShellPackageMaterializationError',
      executionFailed: true,
      mutating: shell.externalMutation,
    };
  }
  if (shell.errorKind !== undefined || (shell.exitCode !== undefined && shell.exitCode !== 0)) {
    return {
      executionFailed: true,
      mutating: shell.externalMutation,
      ...(shell.externalMutation ? { acknowledged: false } : {}),
    };
  }
  if (shell.exitCode === 0) {
    return {
      hostExecuted: true,
      mutating: shell.externalMutation,
      ...(shell.externalMutation ? { acknowledged: true } : {}),
    };
  }
  return {};
}

export const ATTEMPT_SETTLED_EVENT_NAME = 'tool_attempt_settled' as const;

export interface SettleToolAttemptInput {
  sessionId?: string;
  sourceUserSeq?: number;
  turn?: number;
  /**
   * Canonical arguments for this call, used only to tell a NEW step apart from
   * a repeat of one already taken.
   */
  args?: unknown;
  /** Provider-neutral label for the lane that dispatched. */
  lane: 'agents_runner' | 'native_mcp' | 'claude_sdk' | 'composio' | 'code_mode' | 'byo';
  toolName: string;
  /** Stable invocation identity, so a settlement can be correlated to its call. */
  callId?: string;
  /** The accepted task that owns this attempt. */
  acceptedTaskId?: string;
  /** The PHYSICAL attempt — one dispatch or one refusal, whatever wraps it. */
  physicalAttemptId?: string;
  /** True when the call could change something outside Clementine. */
  mutating?: boolean;
  /**
   * A business call is work the user asked for. Discovery, schema reads and
   * status probes are not: succeeding at looking around is not progress, and
   * crediting it would hand out discovery budget for doing nothing.
   */
  businessCall?: boolean;
  /** What the lane got back, if it returned. */
  result?: unknown;
  /** What the lane caught, if it threw. */
  thrown?: unknown;
  /** Signals the lane already knows nominally; these outrank extraction. */
  signals?: AttemptSignals;
  /**
   * The obligation this attempt serves.
   *
   * Pages and retries carry the SAME requirementId, which is what keeps them
   * attached to one piece of work: only first-time satisfaction of an
   * unsatisfied requirement earns progress, so following a cursor can never
   * manufacture a completed step however much the arguments change.
   */
  requirementId?: string;
  /** True when this attempt continues an obligation rather than completing it. */
  continuesRequirement?: boolean;
}

export interface SettledToolAttempt {
  outcome: AttemptOutcome;
  /** Did this settlement open a fresh discovery epoch? */
  openedDiscoveryEpoch: boolean;
  /** Did this settlement credit progress toward the next requirement? */
  creditedProgress: boolean;
  /** Durable, task-scoped raw-result authority for a successful provider call. */
  resultHandleId?: string;
  /** True when this physical attempt was already settled and this call was a
   *  duplicate that changed nothing. */
  duplicate: boolean;
}

/**
 * Close a logical call the host admitted but then refused before execution.
 *
 * This seam takes the exact durable logical id instead of consulting ambient
 * AsyncLocalStorage. That distinction matters for nested orchestrators: while a
 * child is being admitted, the ambient identity may still belong to its parent.
 * Settling through the ordinary lane helper in that window would close the
 * parent and strand the child OPEN. The caller must already have admitted the
 * child; the settlement store independently proves that row is exact, open, and
 * has zero physical crossings.
 */
export function settleAdmittedLogicalCallPreDispatchRefusal(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  toolName: string;
  args?: unknown;
  lane: SettleToolAttemptInput['lane'];
  turn?: number;
  mutating?: boolean;
  reason: string;
}): SettledToolAttempt {
  const classified = classifyAttemptOutcome({ preDispatch: true, policyRefused: true });
  const outcome: AttemptOutcome = {
    ...classified,
    detail: `work_binding:${input.reason.replace(/\s+/g, ' ').trim().slice(0, 120) || 'refused'}`,
  };
  const committed = commitLogicalCallSettlement({
    identity: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: acceptedTaskIdFor(input.sessionId, input.sourceUserSeq),
      logicalToolCallId: input.logicalToolCallId,
    },
    contract: { toolName: input.toolName, args: input.args },
    execution: { kind: 'refused_pre_dispatch' },
    outcome,
    recovery: {
      businessCall: false,
      mutating: input.mutating === true,
    },
    observer: {
      lane: input.lane,
      callId: input.logicalToolCallId,
      ...(Number.isSafeInteger(input.turn) && (input.turn ?? 0) > 0
        ? { turn: input.turn as number }
        : {}),
    },
  });
  if (committed.status !== 'committed' && committed.status !== 'replayed') {
    throw new ToolAttemptSettlementAuthorityError(committed.status, committed.reason);
  }
  return {
    outcome: committed.settlement.outcome,
    openedDiscoveryEpoch: committed.settlement.recovery.openedDiscoveryEpoch,
    creditedProgress: committed.settlement.recovery.creditedProgress,
    ...(committed.settlement.resultHandleId
      ? { resultHandleId: committed.settlement.resultHandleId }
      : {}),
    duplicate: committed.status === 'replayed',
  };
}

export type ToolAttemptSettlementAuthorityStatus = Exclude<
  LogicalCallSettlementResult['status'],
  'committed' | 'replayed'
> | 'uncorrelated';

/**
 * Settlement is authority, not telemetry. Callers must not turn a missing,
 * closed, conflicting, or unwritable logical call into an apparent duplicate
 * success: doing so loses recovery and can make a task look complete after the
 * durable ledger refused it.
 */
export class ToolAttemptSettlementAuthorityError extends Error {
  override readonly name = 'ToolAttemptSettlementAuthorityError';

  constructor(
    readonly status: ToolAttemptSettlementAuthorityStatus,
    readonly reason: string,
  ) {
    super(`Tool attempt could not settle durably (${status}): ${reason}`);
  }
}

interface SettlementAuthorityIdentity {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}

/** Resolve only a logical-call identity owned by this exact accepted task. */
function settlementAuthorityIdentity(
  input: SettleToolAttemptInput & { sessionId: string; sourceUserSeq: number },
): SettlementAuthorityIdentity | null {
  const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
  const ambient = settlementIdentityFor(input.sessionId, input.sourceUserSeq);
  if (input.acceptedTaskId && input.acceptedTaskId !== acceptedTaskId) return null;
  if (ambient && ambient.acceptedTaskId !== acceptedTaskId) return null;
  const logicalToolCallId = ambient?.logicalToolCallId
    ?? input.callId?.trim()
    // Compatibility only for a lane not yet carrying the logical id. A real
    // provider crossing is resolved from the durable ledger, never inferred
    // from this value.
    ?? input.physicalAttemptId?.trim();
  if (!logicalToolCallId) return null;
  return {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId,
  };
}

function durablePhysicalCrossingCount(identity: SettlementAuthorityIdentity): number {
  try {
    const row = openEventLog().prepare(`
      SELECT COUNT(*) AS count
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.logicalToolCallId,
    ) as { count: number };
    return row.count;
  } catch (error) {
    throw new ToolAttemptSettlementAuthorityError(
      'storage_error',
      `physical crossing authority is unreadable: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`,
    );
  }
}

/** Task-local compatibility cache in front of normalized durable settlements. */
const eliminatedCandidates = new Map<string, Set<string>>();

function taskKey(sessionId: string, sourceUserSeq: number): string {
  return `${sessionId}#${sourceUserSeq}`;
}

export function eliminateCandidateForTask(
  sessionId: string,
  sourceUserSeq: number,
  candidate: string,
): void {
  const key = taskKey(sessionId, sourceUserSeq);
  const set = eliminatedCandidates.get(key) ?? new Set<string>();
  set.add(candidate.trim().toLowerCase());
  eliminatedCandidates.set(key, set);
}

function durableEliminatedCandidatesForTask(
  sessionId: string,
  sourceUserSeq: number,
): string[] {
  try {
    return (openEventLog().prepare(`
      SELECT DISTINCT l.tool_name AS tool
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.eliminates_candidate = 1
       ORDER BY lower(l.tool_name), l.tool_name
    `).all(sessionId, sourceUserSeq) as Array<{ tool: string }>)
      .map((row) => row.tool.trim().toLowerCase())
      .filter(Boolean);
  } catch (error) {
    throw new ToolAttemptSettlementAuthorityError(
      'storage_error',
      `candidate authority is unreadable: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`,
    );
  }
}

/** Has this accepted task already proved this candidate unsuitable? */
export function candidateEliminatedForTask(
  sessionId: string,
  sourceUserSeq: number,
  candidate: string,
): boolean {
  const normalized = candidate.trim().toLowerCase();
  if (eliminatedCandidates.get(taskKey(sessionId, sourceUserSeq))?.has(normalized)) return true;
  return durableEliminatedCandidatesForTask(sessionId, sourceUserSeq).includes(normalized);
}

export function eliminatedCandidatesForTask(
  sessionId: string,
  sourceUserSeq: number,
): string[] {
  return [...new Set([
    ...(eliminatedCandidates.get(taskKey(sessionId, sourceUserSeq)) ?? []),
    ...durableEliminatedCandidatesForTask(sessionId, sourceUserSeq),
  ])].sort();
}

/**
 * Steps this task has already completed, as capability + canonical arguments.
 *
 * Progress is what earns the next search, so "progress" has to mean something
 * a loop cannot manufacture. Reading the same calendar four times is one step
 * taken four times: the task learned nothing new on attempts two through four,
 * and crediting them handed out discovery budget for going in circles.
 */
function stepIdentity(toolName: string, args: unknown): string {
  // Through the ONE contract normalizer, so a carrier re-encoding of the same
  // call cannot present itself as a different step. This was the live defect:
  // an object carrier and a string carrier of one read credited progress twice.
  return callableContractIdentity(normalizeCallableArguments(args, toolName));
}

/** Test seam only; durable normalized settlements are deliberately untouched. */
export function _resetAttemptSettlementStateForTests(): void {
  eliminatedCandidates.clear();
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Pull machine-readable facts out of a returned envelope.
 *
 * Only fields that carry their own meaning are read — a boolean that says
 * "successful", a numeric status, an emptiness that is structural. Nothing here
 * inspects wording, so a provider changing its phrasing changes nothing.
 */
function signalsFromResult(result: unknown): AttemptSignals {
  const envelope = record(result);
  if (!envelope) {
    // A bare string/array result carries no structure. Emptiness is still a
    // fact we can observe without reading meaning into the characters.
    const empty = (typeof result === 'string' && result.trim().length === 0)
      || (Array.isArray(result) && result.length === 0);
    return empty ? { emptyResult: true } : {};
  }

  const signals: AttemptSignals = {};
  const successful = envelope.successful ?? envelope.success ?? envelope.ok;
  if (typeof successful === 'boolean') signals.envelopeSuccessful = successful;
  if (typeof envelope.isError === 'boolean') signals.providerReportedError = envelope.isError;

  // Providers routinely nest the transport status under the payload. A 400
  // reported that way is still a repairable argument error, not a dead
  // capability — reading only the top level turned every one of them into
  // "this tool cannot do that" and sent the task hunting for a replacement.
  const nested = record(envelope.data) ?? record(envelope.error) ?? null;
  const status = numericStatus(
    envelope.status ?? envelope.statusCode ?? envelope.status_code
    ?? nested?.status ?? nested?.statusCode ?? nested?.status_code,
  );
  if (status !== undefined) signals.httpStatus = status;

  const code = envelope.error_code ?? envelope.errorCode ?? envelope.code;
  if (typeof code === 'string' || typeof code === 'number') signals.envelopeErrorCode = code;

  const data = envelope.data ?? envelope.result ?? envelope.items ?? envelope.results;
  if (Array.isArray(data) && data.length === 0) signals.emptyResult = true;
  else if (record(data) && Object.keys(record(data)!).length === 0) signals.emptyResult = true;

  return signals;
}

/** Pull machine-readable facts out of a thrown value — the path that used to
 *  lose the reason entirely by rendering it to prose. */
function signalsFromThrown(thrown: unknown): AttemptSignals {
  if (thrown === undefined || thrown === null) return {};
  const signals: AttemptSignals = {};
  const asRecord = record(thrown) ?? (thrown instanceof Error ? (thrown as unknown as Record<string, unknown>) : null);

  if (thrown instanceof Error || typeof (asRecord?.name) === 'string') {
    // The CLASS is nominal evidence; the message is not.
    signals.errorName = String((asRecord?.name ?? (thrown as Error).name ?? '')).trim() || undefined;
  }
  if (signals.errorName === 'ShellPolicyDenialError') {
    signals.preDispatch = true;
    signals.policyRefused = true;
  }
  const status = numericStatus(
    asRecord?.status ?? asRecord?.statusCode ?? asRecord?.status_code ?? asRecord?.httpStatus,
  );
  if (status !== undefined) signals.httpStatus = status;
  const code = asRecord?.code ?? asRecord?.errorCode;
  if (typeof code === 'string' || typeof code === 'number') signals.envelopeErrorCode = code;

  // A throw with no structure at all is a failure we cannot characterize. Say
  // so honestly rather than inventing a reason from the message.
  if (signals.errorName === undefined && signals.httpStatus === undefined) {
    signals.text = thrown instanceof Error ? thrown.message : String(thrown);
  }
  return signals;
}

/** Reason token of a `[provider-dispatch:not-started:<reason>]` refusal, in
 * any of the shapes a carrier boundary leaves it: the raw string, or a
 * one-level wrapper ({output|text|preview|result: string}). */
function providerNotStartedReason(result: unknown, toolName?: string): string | null {
  const candidates: unknown[] = [result];
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const wrapper = result as Record<string, unknown>;
    candidates.push(wrapper.output, wrapper.text, wrapper.preview, wrapper.result);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = /^\s*\[provider-dispatch:not-started:([a-z0-9_-]+)\]/i.exec(candidate);
    if (match) return match[1]!.toLowerCase();
    if (toolName === 'call_tool' || toolName === 'work_call') {
      try {
        const parsed = JSON.parse(candidate) as { error?: unknown };
        if (parsed?.error === 'arg_validation') return 'invalid-args';
      } catch { /* not a carrier refusal envelope */ }
    }
  }
  return null;
}

/** Corrective failure prose built by the tool-error layers: "⚠️ <tool>
 * FAILED…". Same one-level wrapper tolerance as the not-started marker. */
function correctiveFailureProse(result: unknown): boolean {
  const candidates: unknown[] = [result];
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const wrapper = result as Record<string, unknown>;
    candidates.push(wrapper.output, wrapper.text, wrapper.preview, wrapper.result);
  }
  return candidates.some((candidate) =>
    typeof candidate === 'string' && /^\s*⚠️\s*\S[^\n]{0,120}\bFAILED\b/.test(candidate));
}

function hasTaskIdentity(input: SettleToolAttemptInput): input is SettleToolAttemptInput & {
  sessionId: string; sourceUserSeq: number;
} {
  return Boolean(
    input.sessionId?.trim()
    && Number.isSafeInteger(input.sourceUserSeq)
    && (input.sourceUserSeq ?? 0) > 0,
  );
}

/**
 * Settle one attempt and enact its recovery.
 *
 * The directive is obeyed, not consulted: a candidate that eliminated itself
 * reopens discovery, an attempt that finished real work credits progress, and
 * everything else deliberately moves nothing.
 */
/**
 * Record the one crossing the host made into its own process.
 *
 * Deliberately fail-soft: this is EVIDENCE, and the settlement it accompanies
 * is AUTHORITY. A call the dispatch ledger declines to admit — an unbound
 * business call under an activated contract, a session whose accepted task is
 * unreadable — simply keeps the historical no-evidence behaviour instead of
 * losing its settlement. The id is derived from the logical call, so a replayed
 * settlement re-admits the same row rather than minting a second crossing.
 */
/**
 * Whether this accepted source's frozen contract is the deterministic
 * one-read retrieve shape, whose single observation binds implicitly. Fail-soft
 * by design: this only widens EVIDENCE recording, never authority, so an
 * unreadable contract simply keeps the historical no-crossing behaviour.
 */
function settlesDeterministicImplicitRetrieve(identity: SettlementAuthorityIdentity): boolean {
  try {
    const loaded = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
    return loaded.status === 'ok'
      && loaded.contract.acceptedTaskId === identity.acceptedTaskId
      && isDeterministicImplicitRetrieveContract(loaded.contract);
  } catch {
    return false;
  }
}

function recordHostExecutionCrossing(
  identity: SettlementAuthorityIdentity,
  call: { tool: string; args?: unknown; turn?: number },
): void {
  try {
    // ANNOTATE AUTHORITY, NEVER CREATE IT. Opening a crossing also admits its
    // logical parent, so recording one for a call that was never admitted
    // would manufacture the very authority the settlement is about to refuse —
    // a settlement with no admitted logical call must still fail closed.
    const parent = openEventLog().prepare(`
      SELECT accepted_task_id, state FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.logicalToolCallId,
    ) as { accepted_task_id: string; state: string } | undefined;
    if (
      !parent
      || parent.state !== 'open'
      || parent.accepted_task_id !== identity.acceptedTaskId
    ) return;
    const admitted = beginPhysicalDispatch({
      identity: {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId: identity.acceptedTaskId,
        logicalToolCallId: identity.logicalToolCallId,
        physicalDispatchId: `dispatch:host:${identity.logicalToolCallId}`,
        ordinal: 1,
      },
      tool: call.tool,
      args: call.args,
      ...(call.turn === undefined ? {} : { turn: call.turn }),
      relation: 'primary',
      executionSite: 'host',
    });
    if (admitted.status !== 'inserted') return;
    // Settle against the name the ledger actually STORED. It records the
    // normalized inner identity, which for a wrapped carrier is not the name
    // this lane was handed — settling with the raw one reads as a crossing
    // conflicting with its own start, which poisons the resolution and leaves
    // the crossing in flight so the settlement behind it can never close.
    const stored = openEventLog().prepare(`
      SELECT tool_name FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      admitted.identity.physicalDispatchId,
    ) as { tool_name: string } | undefined;
    if (!stored) return;
    settlePhysicalDispatch({
      identity: admitted.identity,
      tool: stored.tool_name,
      outcome: 'returned',
      ...(call.turn === undefined ? {} : { turn: call.turn }),
    });
  } catch {
    // An unrecordable crossing must never take the settlement down with it.
  }
}

export function settleToolAttempt(input: SettleToolAttemptInput): SettledToolAttempt {
  const extracted: AttemptSignals = {
    ...signalsFromResult(input.result),
    ...(input.thrown !== undefined ? signalsFromThrown(input.thrown) : {}),
    ...(input.mutating !== undefined ? { mutating: input.mutating } : {}),
    // A lane's own nominal knowledge outranks anything extracted here.
    ...(input.signals ?? {}),
  };
  if (input.toolName === 'run_shell_command' && isShellPolicyDenialResult(input.result)) {
    extracted.preDispatch = true;
    extracted.policyRefused = true;
  }
  // A `[provider-dispatch:not-started:*]` result is a TYPED pre-dispatch
  // refusal. The composio lane returns it as a class instance that its own
  // bracket recognizes, but the identity dies at carrier serialization
  // boundaries (work_call children receive `{output: "…"}`), and the bare
  // string then classified as a SUCCEEDED host execution — which minted a
  // host crossing and a durable result handle for a call that never
  // dispatched, and told the model its failed Apify probe had "succeeded"
  // (live 2026-08-12, seq 44256). The marker is the identity; honor it on
  // every lane.
  const notStartedReason = providerNotStartedReason(input.result, input.toolName);
  if (notStartedReason) {
    extracted.preDispatch = true;
    if (notStartedReason === 'invalid-args') extracted.argumentValidationFailed = true;
    else extracted.policyRefused = true;
  }
  // Corrective failure guidance ("⚠️ <tool> FAILED…") is built FOR THE MODEL
  // after a failure; crossing a carrier boundary as a bare string it
  // classified as a successful host execution and minted evidence for a call
  // that failed (live 2026-08-12, seq 44386: a dispatch-ledger refusal echo
  // settled succeeded with a durable handle). The prefix is the marker.
  if (extracted.executionFailed === undefined && correctiveFailureProse(input.result)) {
    extracted.executionFailed = true;
  }
  if (input.result instanceof TruncatedToolOutputResult) {
    extracted.outputTruncated = true;
  }
  if (input.mutating && extracted.acknowledged === undefined) {
    // A mutation that threw was never acknowledged — and a mutation whose
    // envelope merely says "not successful" has not proved that nothing landed
    // either. Both are uncertain until something observes the target. Treating
    // a returned failure as a clean miss is exactly how a send gets repeated.
    const returnedFailure = extracted.envelopeSuccessful === false;
    if (input.thrown !== undefined || returnedFailure) extracted.acknowledged = false;
  }

  let outcome = classifyAttemptOutcome(extracted);
  if (
    outcome.kind === 'succeeded'
    && inspectProviderEnvelope(input.result).verdict === 'contradicted'
  ) {
    outcome = classifyAttemptOutcome({
      ...extracted,
      envelopeSuccessful: undefined,
      providerReportedError: undefined,
      providerEnvelopeContradicted: true,
    });
  }
  if (!hasTaskIdentity(input)) {
    throw new ToolAttemptSettlementAuthorityError(
      'uncorrelated',
      'session and accepted source identity are required',
    );
  }
  const identity = settlementAuthorityIdentity(input);
  if (!identity) {
    throw new ToolAttemptSettlementAuthorityError(
      'uncorrelated',
      'no logical call owned by this accepted task is available',
    );
  }
  const bindingState = loadExpectedWorkCallBindingState(identity);
  if (bindingState.status === 'storage_error') {
    throw new ToolAttemptSettlementAuthorityError('storage_error', bindingState.reason);
  }
  const binding = bindingState.status === 'ok' ? bindingState.binding : undefined;
  const topologyRole = actionTopologyRoleForRuntimeCall(input.toolName, input.args);
  if (binding && topologyRole === 'control') {
    throw new ToolAttemptSettlementAuthorityError(
      'conflict',
      'a control call cannot settle or discharge immutable business work',
    );
  }
  if (
    binding
    && input.requirementId
    && input.requirementId !== binding.requirementId
  ) {
    throw new ToolAttemptSettlementAuthorityError(
      'conflict',
      'lane-supplied requirement identity conflicts with the immutable work binding',
    );
  }
  const requirementId = binding?.requirementId ?? input.requirementId;
  const businessCall = topologyRole === 'control'
    ? false
    : binding ? true : input.businessCall === true;
  const continuesRequirement = input.continuesRequirement === true;

  const priorCrossingCount = durablePhysicalCrossingCount(identity);
  const executionKind = priorCrossingCount > 0
    ? 'provider_execution' as const
    : extracted.preDispatch === true
      ? 'refused_pre_dispatch' as const
      : 'local_execution' as const;

  // THE HOST'S OWN EXECUTION IS EVIDENCE. Nothing left the machine, so there
  // was no crossing to record and therefore no durable result to redeem, no
  // observed operation to project, and no outcome the classifier could name.
  // A contract that legitimately owns local work — a local source read, a
  // local_write per item — was unprovable by construction (live 2026-08-11:
  // zero dispatches, zero handles, zero operations for a whole run).
  //
  // The host knows strictly more about this call than any provider envelope
  // could tell it: it invoked the tool and holds the exact bytes that came
  // back. Record that as the crossing it is, marked as never having left the
  // process, and let the identical downstream evidence path do the rest.
  const returnedLocalResult = executionKind === 'local_execution'
    && input.thrown === undefined
    && Object.prototype.hasOwnProperty.call(input, 'result');

  // Classify what happened independently of whether this call was admitted as
  // evidence for a frozen requirement. Binding controls authority minting; it
  // cannot turn a returned host execution into an unknown outcome.
  if (returnedLocalResult && outcome.kind === 'unknown' && extracted.executionFailed !== true) {
    outcome = classifyAttemptOutcome({ ...extracted, hostExecuted: true });
  }

  if (
    executionKind === 'local_execution'
    && businessCall
    // Scoped to work with a contract to discharge. A BOUND call has already
    // been normalized to its exact inner contract by admission, so the
    // crossing, the logical call and the durable result all describe the same
    // identity. An UNBOUND local business call qualifies only under the
    // deterministic one-read retrieve contract: that route binds implicitly
    // (no expected_work_call_bindings row ever exists), and without the
    // crossing its single requirement was unprovable by construction — the
    // host executed the read itself, minted no dispatch, no handle, no
    // observed operation, and the terminal blocked a correct answer as
    // verification_required (live 2026-08-11). The crossing recorder settles
    // against the ledger-stored normalized name, so a wrapped carrier's outer
    // name cannot desynchronize the result handle's identity.
    && (binding !== undefined
      || (settlesDeterministicImplicitRetrieve(identity)
        // The implicit-retrieve door carries exactly ONE READ. Only calls the
        // taxonomy sees as read/compute may mint host evidence through it — a
        // write-shaped carrier's local return (e.g. a pre-dispatch refusal
        // string) must never gain a crossing and masquerade as dispatched
        // work (routing-sweep fixture, 2026-08-12).
        && ['read', 'compute'].includes(classifyRuntimeToolEffect(input.toolName, input.args).effect)))
    && returnedLocalResult
    && deriveResultHandleFactsFromRaw(input.result).success
  ) {
    if (outcome.kind === 'succeeded' || outcome.kind === 'empty_result') {
      recordHostExecutionCrossing(identity, {
        tool: input.toolName,
        args: input.args,
        ...(Number.isSafeInteger(input.turn) ? { turn: input.turn as number } : {}),
      });
    }
  }

  const completedBusinessWork = outcome.kind === 'succeeded'
    && businessCall
    && !continuesRequirement;
  const progressIdentity = completedBusinessWork
    ? requirementId
      ? `requirement:${requirementId}${binding?.universeItemId ? `:item:${binding.universeItemId}` : ''}`
      : `step:${stepIdentity(input.toolName, input.args)}`
    : undefined;

  // "No rows matched" is an answer to a business query, but evidence that a
  // discovery candidate is unavailable when the call was only looking around.
  const emptyBusinessAnswer = outcome.kind === 'empty_result' && businessCall;
  const governorEvidence = outcome.directive.opensDiscoveryEpoch
    && !emptyBusinessAnswer
    && outcome.kind !== 'unknown'
    ? {
        kind: outcome.kind === 'empty_result'
          ? 'candidate_unavailable' as const
          : 'candidate_unsupported' as const,
        detail: `${input.toolName}:${outcome.kind}`,
      }
    : progressIdentity
      ? {
          kind: 'capability_satisfied' as const,
          detail: input.toolName,
          onlyIfProgressClaimed: true,
        }
      : undefined;

  const committed = commitLogicalCallSettlement({
    identity,
    contract: { toolName: input.toolName, args: input.args },
    execution: { kind: executionKind },
    ...(Object.prototype.hasOwnProperty.call(input, 'result')
      ? { result: { payload: input.result } }
      : {}),
    outcome,
    recovery: {
      businessCall,
      mutating: input.mutating === true,
      ...(requirementId ? { requirementId } : {}),
      ...(continuesRequirement ? { continuesRequirement: true } : {}),
      ...(progressIdentity ? { progressIdentity } : {}),
      ...(governorEvidence ? { governorEvidence } : {}),
    },
    observer: {
      lane: input.lane,
      ...(input.callId ? { callId: input.callId } : {}),
      ...(Number.isSafeInteger(input.turn) && (input.turn ?? 0) > 0
        ? { turn: input.turn as number }
        : {}),
    },
  });

  if (committed.status !== 'committed' && committed.status !== 'replayed') {
    throw new ToolAttemptSettlementAuthorityError(committed.status, committed.reason);
  }
  const persisted = committed.settlement;
  if (persisted.outcome.directive.eliminatesCandidate) {
    // The database row above is authority. The process-local set is only a
    // hot cache and can be cleared without forgetting the task's evidence.
    eliminateCandidateForTask(
      identity.sessionId,
      identity.sourceUserSeq,
      persisted.toolName,
    );
  }
  return {
    outcome: persisted.outcome,
    openedDiscoveryEpoch: persisted.recovery.openedDiscoveryEpoch,
    creditedProgress: persisted.recovery.creditedProgress,
    ...(persisted.resultHandleId ? { resultHandleId: persisted.resultHandleId } : {}),
    duplicate: committed.status === 'replayed',
  };
}
