/** Canonical host checkpoint wire codecs. Observational decoding only: this
 * module opens no stores and grants no approval, execution or replay authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentInputItem } from '@openai/agents';
import type { AcceptedModelBatchRef } from './accepted-model-batch-checkpoint.js';
import type { CapabilityRiskAttestationV1 } from './interactive-consent-policy.js';
import type { HostTurnEngineMode } from './turn-engine-selection.js';
import { inspectConversationProtocol } from './conversation-protocol.js';
import { NO_PROGRESS_RETRY_BUDGET, parseNoProgressGovernorState, type NoProgressGovernorState } from './no-progress-governor.js';
import { assertHostConnectionProgress, type HostConnectionProgress } from './host-connection-progress.js';
import { hostInteractiveConsentApprovalResumeKey, parseHostInteractiveConsentSubjectV1, type HostInteractiveConsentSubjectV1 } from './host-interactive-consent-subject.js';

const HOST_STATE_VERSION = 7;
const HOST_STATE_KEY = '__clemHostInterrupt';
const HOST_RECOVERY_STATE_VERSION = 1;
const HOST_RECOVERY_STATE_KEY = '__clemHostRecovery';
export const MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS = 2;

export interface PendingHostCall {
  callId: string;
  name: string;
  /** Mutable: the resume owner writes user-edited args onto rawItem.arguments. */
  rawItem: { name: string; arguments: string; callId: string };
  /**
   * V6: the exact bytes the pre-approval loop ADMITTED for this call —
   * strict-nullable materialization and any host carrier completion already
   * applied, the same bytes its durable argument digest was minted from.
   * rawItem.arguments starts equal to it; the only later writer of
   * rawItem.arguments is the owner's edit-and-approve flow, so an approval
   * edit is exactly a divergence from this snapshot. The checkpointed model
   * history keeps the RAW bytes and is never the "unchanged" reference.
   */
  admittedArgumentsJson?: string;
  decision?: 'approved' | 'rejected';
  /**
   * Set only in memory at resume, beside a 'rejected' decision: the owner
   * answered the card with a change. It is model input for one fresh call,
   * never authority, and a serialized pause never carries it.
   */
  changeRequest?: string;
  /** V3: exact reducer subject for a high-consequence mutation. */
  consentSubject?: HostInteractiveConsentSubjectV1;
  /** Display-only reducer facts; the exact consentSubject remains authority. */
  consentCall?: Pick<CapabilityRiskAttestationV1, 'effect' | 'accountId' | 'risk'>;
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

export interface HostCompletionReviewFeedback {
  version: 1;
  /** 'disclose': the review could not pass and the repairs are spent; the
   *  next reply is Clem's own account of it to the owner, not a revision. */
  phase?: 'plan' | 'disclose';
  sessionId: string;
  sourceUserSeq: number;
  objective: string;
  objectiveDigest: string;
  reply: string;
  replyDigest: string;
  reason: string;
  /** Repair guidance for the next candidate, never transferable approval of
   *  a changed reply or permission to omit whole-objective review. */
  repairScope?: 'claims' | 'reply_format';
  quotes?: string[];
}

export function parseHostCompletionReviewFeedback(value: unknown): HostCompletionReviewFeedback | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('paused host state has invalid completion-review feedback');
  }
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || (row.phase !== undefined && row.phase !== 'plan' && row.phase !== 'disclose') || typeof row.sessionId !== 'string' || !row.sessionId
    || !Number.isSafeInteger(row.sourceUserSeq) || Number(row.sourceUserSeq) <= 0
    || typeof row.objective !== 'string' || typeof row.reply !== 'string'
    || typeof row.reason !== 'string' || !row.reason.trim()
    || row.objectiveDigest !== createHash('sha256').update(row.objective, 'utf8').digest('hex')
    || row.replyDigest !== createHash('sha256').update(row.reply, 'utf8').digest('hex')) {
    throw new Error('paused host state has invalid completion-review feedback');
  }
  if (row.repairScope !== undefined && row.repairScope !== 'claims' && row.repairScope !== 'reply_format') throw new Error('paused host state has invalid completion-review feedback');
  if (row.quotes !== undefined && (!Array.isArray(row.quotes) || row.quotes.some((quote) => typeof quote !== 'string'))) {
    throw new Error('paused host state has invalid completion-review feedback');
  }
  return { version: 1, sessionId: row.sessionId, sourceUserSeq: Number(row.sourceUserSeq),
    objective: row.objective, objectiveDigest: String(row.objectiveDigest),
    reply: row.reply, replyDigest: String(row.replyDigest), reason: row.reason,
    ...(row.phase === 'plan' || row.phase === 'disclose' ? { phase: row.phase as 'plan' | 'disclose' } : {}),
    ...(row.repairScope === 'claims' || row.repairScope === 'reply_format' ? { repairScope: row.repairScope as 'claims' | 'reply_format' } : {}),
    ...(Array.isArray(row.quotes) ? { quotes: (row.quotes as string[]).slice(0, 24) } : {}) };
}

export type HostRecoveryPhase = 'admit' | 'finalize' | 'continue';

export function parseConnectionProgress(raw: unknown, expected: {
  sessionId?: string; sourceUserSeq?: number; turnEngine: HostTurnEngineMode;
  stepIndex?: number; ref?: AcceptedModelBatchRef;
  objectiveJudgeContinuations: number;
  noProgressCheckpoint?: HostNoProgressCheckpoint;
  completionReviewFeedback?: HostCompletionReviewFeedback;
}): HostConnectionProgress | undefined {
  if (raw === undefined) return undefined;
  const value = raw as HostConnectionProgress;
  assertHostConnectionProgress(value);
  if (value.recovery.turnEngine !== expected.turnEngine
    || (expected.sessionId !== undefined && value.batch.sessionId !== expected.sessionId)
    || (expected.sourceUserSeq !== undefined && value.batch.sourceUserSeq !== expected.sourceUserSeq)
    || (expected.stepIndex !== undefined && value.recovery.stepIndex !== expected.stepIndex)
    || value.recovery.objectiveJudgeContinuations !== expected.objectiveJudgeContinuations
    || !isDeepStrictEqual(value.recovery.noProgressCheckpoint, expected.noProgressCheckpoint)
    || !isDeepStrictEqual(value.recovery.completionReviewFeedback, expected.completionReviewFeedback)
    || (expected.ref && (['sessionId', 'sourceUserSeq', 'acceptedTaskId', 'batchOrdinal', 'batchId', 'authorityDigest'] as const)
      .some(key => value.batch[key] !== expected.ref![key]))
    || (!expected.sessionId && !expected.ref)) {
    throw new Error('The retained connection progress does not match its host checkpoint.');
  }
  return JSON.parse(JSON.stringify(value)) as HostConnectionProgress;
}


function parseHostObjectiveJudgeContinuations(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 0 || value > MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS) {
    throw new Error('paused host state has an invalid objective-judge continuation count');
  }
  return value;
}

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
    public readonly objectiveJudgeContinuations: number = 0,
    public readonly completionReviewFeedback?: HostCompletionReviewFeedback,
    public readonly connectionProgress?: HostConnectionProgress,
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
      parseHostObjectiveJudgeContinuations(parsed.objectiveJudgeContinuations),
      parseHostCompletionReviewFeedback(parsed.completionReviewFeedback),
      parseConnectionProgress(parsed.connectionProgress, { sessionId, sourceUserSeq, turnEngine, stepIndex, ref,
        objectiveJudgeContinuations: parseHostObjectiveJudgeContinuations(parsed.objectiveJudgeContinuations),
        noProgressCheckpoint: parseHostNoProgressCheckpoint(parsed.noProgressCheckpoint, history.length),
        completionReviewFeedback: parseHostCompletionReviewFeedback(parsed.completionReviewFeedback) }),
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
      objectiveJudgeContinuations: this.objectiveJudgeContinuations,
      ...(this.completionReviewFeedback ? { completionReviewFeedback: this.completionReviewFeedback } : {}),
      ...(this.connectionProgress ? { connectionProgress: this.connectionProgress } : {}),
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
    /** The completion-judge budget belongs to the accepted source, not a re-entry. */
    public readonly objectiveJudgeContinuations: number = 0,
    public readonly completionReviewFeedback?: HostCompletionReviewFeedback,
    /** V7 preserves old unkeyed native cards while keying newly created pauses. */
    public readonly nativeApprovalKeys: boolean = true,
    public readonly connectionProgress?: HostConnectionProgress,
  ) {
    // At construction a pending call's bytes ARE the bytes the pause admitted:
    // the pause loop builds rawItem from its admitted arguments, and a pre-V6
    // blob persisted exactly those. An edit can only arrive later, through
    // rawItem.arguments, so the snapshot is taken here once and never again.
    for (const call of pending) call.admittedArgumentsJson ??= call.rawItem.arguments;
  }

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
      objectiveJudgeContinuations?: unknown;
      completionReviewFeedback?: unknown;
      nativeApprovalKeys?: unknown;
      connectionProgress?: unknown;
    };
    const version = parsed[HOST_STATE_KEY];
    if (
      version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5
      && version !== 6 && version !== HOST_STATE_VERSION
    ) {
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
    // A change request exists only in memory at resume; stored bytes that
    // carry one are not the owner's words.
    for (const call of pending) delete call.changeRequest;
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
    if (version >= 6) {
      for (const call of pending) {
        if (typeof call.admittedArgumentsJson !== 'string') {
          throw new Error('paused host state has no exact admitted argument bytes');
        }
      }
    } else {
      // A pre-V6 pause persisted exactly its admitted bytes as rawItem.arguments;
      // the constructor snapshots them. A lookalike field carries no authority.
      for (const call of pending) delete call.admittedArgumentsJson;
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
      version >= 5
        ? parseAcceptedModelBatchRef(parsed.acceptedModelBatchRef)
        : undefined,
      parseHostObjectiveJudgeContinuations(parsed.objectiveJudgeContinuations),
      parseHostCompletionReviewFeedback(parsed.completionReviewFeedback),
      version < 7 ? false : typeof parsed.nativeApprovalKeys === 'boolean'
        ? parsed.nativeApprovalKeys
        : (() => { throw new Error('paused host state has no native approval identity mode'); })(),
      parseConnectionProgress(parsed.connectionProgress, { turnEngine,
        ref: version >= 5 ? parseAcceptedModelBatchRef(parsed.acceptedModelBatchRef) : undefined,
        objectiveJudgeContinuations: parseHostObjectiveJudgeContinuations(parsed.objectiveJudgeContinuations),
        noProgressCheckpoint: version >= 4 ? parseHostNoProgressCheckpoint(parsed.noProgressCheckpoint, (parsed.history ?? []).length) : undefined,
        completionReviewFeedback: parseHostCompletionReviewFeedback(parsed.completionReviewFeedback) }),
    );
  }

  toString(): string {
    return JSON.stringify({
      [HOST_STATE_KEY]: HOST_STATE_VERSION,
      nativeApprovalKeys: this.nativeApprovalKeys,
      history: this.history,
      pending: this.pending,
      turnEngine: this.turnEngine,
      objectiveJudgeContinuations: this.objectiveJudgeContinuations,
      ...(this.completionReviewFeedback ? { completionReviewFeedback: this.completionReviewFeedback } : {}),
      ...(this.connectionProgress ? { connectionProgress: this.connectionProgress } : {}),
      ...(this.lastResponseId !== undefined ? { lastResponseId: this.lastResponseId } : {}),
      ...(this.noProgressCheckpoint
        ? { noProgressCheckpoint: this.noProgressCheckpoint }
        : {}),
      ...(this.acceptedModelBatchRef
        ? { acceptedModelBatchRef: this.acceptedModelBatchRef }
        : {}),
    });
  }

  approvalResumeKey(call: PendingHostCall): string | undefined {
    if (call.consentSubject) return hostInteractiveConsentApprovalResumeKey(call.consentSubject) ?? undefined;
    if (!this.nativeApprovalKeys || !this.acceptedModelBatchRef) return undefined; // legacy pauses retain their existing compatibility path
    return `host-approval:v1:${createHash('sha256').update(JSON.stringify({
      batch: this.acceptedModelBatchRef,
      callId: call.callId,
      tool: call.name,
      arguments: call.admittedArgumentsJson ?? call.rawItem.arguments,
    })).digest('hex')}`;
  }

  getInterruptions(): Array<{
    rawItem: PendingHostCall['rawItem'];
    toolName: string;
    approvalResumeKey?: string;
    consentCall?: PendingHostCall['consentCall'];
  }> {
    return this.pending
      .filter((call) => !call.decision)
      .map((call) => ({
        rawItem: call.rawItem,
        toolName: call.name,
        ...(call.consentCall ? { consentCall: call.consentCall } : {}),
        ...(this.approvalResumeKey(call) ? { approvalResumeKey: this.approvalResumeKey(call) } : {}),
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
  /** The owner answered this card with a change instead of a decision: the
   *  exact call is rejected, and their words become model input for a fresh
   *  call. They never authorize any bytes. */
  requestChange(item: unknown, request: string): void {
    const raw = (item as { rawItem?: PendingHostCall['rawItem'] } | null)?.rawItem;
    const match = this.pending.find((call) => call.rawItem === raw);
    const text = request.trim().slice(0, 2_000);
    if (!match || !text) return;
    match.decision = 'rejected';
    match.changeRequest = text;
  }

}
