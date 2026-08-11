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
import { toResultHandle } from './result-handle.js';
import { deriveResultHandleFactsFromRaw } from './result-facts.js';
import {
  commitLogicalCallSettlement,
  type LogicalCallSettlementResult,
} from './logical-call-settlement-store.js';

export { normalizeCallableArguments, toResultHandle };

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
export function settleToolAttempt(input: SettleToolAttemptInput): SettledToolAttempt {
  const extracted: AttemptSignals = {
    ...signalsFromResult(input.result),
    ...(input.thrown !== undefined ? signalsFromThrown(input.thrown) : {}),
    ...(input.mutating !== undefined ? { mutating: input.mutating } : {}),
    // A lane's own nominal knowledge outranks anything extracted here.
    ...(input.signals ?? {}),
  };
  if (input.mutating && extracted.acknowledged === undefined) {
    // A mutation that threw was never acknowledged — and a mutation whose
    // envelope merely says "not successful" has not proved that nothing landed
    // either. Both are uncertain until something observes the target. Treating
    // a returned failure as a clean miss is exactly how a send gets repeated.
    const returnedFailure = extracted.envelopeSuccessful === false;
    if (input.thrown !== undefined || returnedFailure) extracted.acknowledged = false;
  }

  let outcome = classifyAttemptOutcome(extracted);
  if (outcome.kind === 'succeeded' && !deriveResultHandleFactsFromRaw(input.result).success) {
    // TWO CLASSIFIERS, ONE SEAM. The dispatch failure detector deliberately
    // lets an authoritative `successful:true` win over nested error fields
    // (the DataForSEO 5-digit-status history), while the redeemability
    // inspector deliberately refuses to mint proof from a contradicted
    // envelope. Both are right; a success that cannot be redeemed is the
    // taxonomy's own `ignored_requirement` — looks like success, dropped
    // something — and must SETTLE as that, never crash the dispatch path
    // ("successful provider result did not produce redeemable result
    // authority" threw here live, 2026-08-11).
    outcome = classifyAttemptOutcome({
      ...extracted,
      envelopeSuccessful: undefined,
      droppedRequiredParameter: true,
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
  const businessCall = binding ? true : input.businessCall === true;
  const continuesRequirement = input.continuesRequirement === true;

  const physicalCrossingCount = durablePhysicalCrossingCount(identity);
  const executionKind = physicalCrossingCount > 0
    ? 'provider_execution' as const
    : extracted.preDispatch === true
      ? 'refused_pre_dispatch' as const
      : 'local_execution' as const;

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
