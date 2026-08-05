/**
 * The single durable foreground-delivery boundary.
 *
 * Both brain lanes reduce their execution state to a TurnOutcome and call this
 * function. The committer writes one idempotent conversation_completed row and
 * derives every legacy field from the public PresentationEvent. It never accepts
 * arbitrary event data, so internal summaries and raw model output have no path
 * into the user-facing terminal payload.
 */
import {
  appendTerminalEventOnce,
  listEvents,
  type EventRow,
} from './eventlog.js';
import {
  InvalidTurnOutcomeError,
  assertPublicPresentationText,
  presentationEventForOutcome,
  presentationEventFromCompletionData,
  type PresentationEvent,
  type TurnIdentity,
  type TurnNeed,
  type TurnOutcome,
  type TurnOutcomeStatus,
} from './turn-outcome.js';
import { assertNoPendingWorkflowChatDispatchOwnership } from '../../tools/workflow-run-queue.js';
import { fenceAndReleaseHandoffAtTerminal } from '../../execution/continuation-capsule.js';

export interface DeliveryCommitResult {
  event: EventRow;
  inserted: boolean;
  presentation: PresentationEvent;
}

/** Transitional non-presentation fields retained on conversation_completed.
 * The committer copies only this allowlist; arbitrary model output, summaries,
 * prompts, tool payloads, and control prose cannot be smuggled in as metadata. */
const DELIVERY_METADATA_KEYS: ReadonlySet<string> = new Set([
  'steps',
  'missingReply',
  'blockedReason',
  'limitKind',
  'lastDecisionSummary',
  'verification',
  'artifactVerification',
  'artifactRunScopeId',
  'transport',
  'maxTurns',
  'planProposalId',
  'planProposalStatus',
  'planProposalNeedsUserInput',
  'queuedTaskId',
  // A stop that HANDED the work to a durable background owner is not a
  // cancellation: the id names who is still running it, so clients can link the
  // turn to live work instead of showing it as abandoned.
  'transferredToTaskId',
]);
const DELIVERY_METADATA_MAX_BYTES = 64 * 1024;

export interface DeliveryCommitOptions {
  metadata?: Readonly<Record<string, unknown>>;
  /** Compatibility classifier for legacy readers. Typed status remains the
   * control-plane authority; this value is never presentation text. */
  legacyReason?: string;
}

interface DurableTurnOutcomeProjection {
  version: 2;
  id: string;
  status: TurnOutcomeStatus;
  resumable: boolean;
  needs?: TurnNeed;
  evidenceRefs?: PresentationEvent['evidenceRefs'];
}

function legacyReason(presentation: PresentationEvent): string {
  switch (presentation.status) {
    case 'done':
      return 'success';
    case 'needs_input':
      if (presentation.needs?.kind === 'approval') return 'awaiting_approval';
      if (presentation.needs?.kind === 'continue') return 'awaiting_continue';
      return 'awaiting_user_input';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'transferred':
      return 'transferred';
  }
}

function durableOutcomeProjection(presentation: PresentationEvent): DurableTurnOutcomeProjection {
  return {
    version: 2,
    id: presentation.outcomeId,
    status: presentation.status,
    resumable: presentation.resumable,
    ...(presentation.needs ? { needs: presentation.needs } : {}),
    ...(presentation.evidenceRefs ? { evidenceRefs: presentation.evidenceRefs } : {}),
  };
}

/** Existing transports still read reply/summary/reason/delivered. Generate those
 * fields from the public projection while new readers adopt `presentation`. */
function safeDeliveryMetadata(metadata: DeliveryCommitOptions['metadata']): Record<string, unknown> {
  if (!metadata) return {};
  const selected: Record<string, unknown> = {};
  for (const key of DELIVERY_METADATA_KEYS) {
    if (metadata[key] !== undefined) selected[key] = metadata[key];
  }
  try {
    const json = JSON.stringify(selected);
    if (Buffer.byteLength(json, 'utf8') > DELIVERY_METADATA_MAX_BYTES) {
      throw new InvalidTurnOutcomeError('Delivery metadata exceeds 64 KiB. Store bulky evidence by reference.');
    }
    return JSON.parse(json) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidTurnOutcomeError) throw error;
    throw new InvalidTurnOutcomeError('Delivery metadata must be JSON-serializable.');
  }
}

export function completionDataForTurnOutcome(
  outcome: TurnOutcome,
  options: DeliveryCommitOptions = {},
): Record<string, unknown> {
  const presentation = presentationEventForOutcome(outcome);
  const identity = presentation.identity;
  const requestedLegacyReason = options.legacyReason?.trim();
  if (requestedLegacyReason && !/^[a-z0-9_]{1,80}$/.test(requestedLegacyReason)) {
    throw new InvalidTurnOutcomeError('legacyReason must be a short machine-readable label.');
  }
  const reason = requestedLegacyReason || legacyReason(presentation);
  const metadata = safeDeliveryMetadata(options.metadata);
  const data: Record<string, unknown> = {
    ...metadata,
    presentation,
    turnOutcome: durableOutcomeProjection(presentation),
    reply: presentation.text,
    summary: presentation.text.slice(0, 400),
    reason,
    // Compatibility only. New code reads turnOutcome.status; event existence is
    // the independent proof that presentation delivery committed.
    delivered: presentation.status === 'done',
    attemptId: 'attemptId' in identity ? identity.attemptId : undefined,
    runId: identity.runId,
    sourceUserSeq: identity.sourceUserSeq,
    ...(presentation.status === 'needs_input' ? { awaitingUser: true } : {}),
    ...(presentation.approvalId ? { pendingApprovalId: presentation.approvalId } : {}),
    ...(presentation.status === 'blocked' && metadata.blockedReason === undefined
      ? { blockedReason: 'blocked' }
      : {}),
  };
  // Do not serialize compatibility keys as explicit undefined values.
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) delete data[key];
  }
  return data;
}

function legacyText(event: EventRow): string {
  const reply = typeof event.data.reply === 'string' ? event.data.reply.trim() : '';
  const summary = typeof event.data.summary === 'string' ? event.data.summary.trim() : '';
  const text = reply || summary;
  if (!text) {
    throw new InvalidTurnOutcomeError('The existing terminal event has no public presentation text.');
  }
  return assertPublicPresentationText(text);
}

function normalizedReason(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase()
    : '';
}

/** A process upgraded between terminal append and retry may encounter an old
 * row with the same terminal key. The durable first writer remains authority;
 * adapt its public fields instead of returning the losing proposal. */
function presentationFromLegacyWinner(event: EventRow, proposed: PresentationEvent): PresentationEvent {
  const text = legacyText(event);
  const reason = normalizedReason(event.data.reason);
  const approvalId = typeof event.data.pendingApprovalId === 'string' && event.data.pendingApprovalId.trim()
    ? event.data.pendingApprovalId.trim()
    : undefined;

  let status: TurnOutcomeStatus = proposed.status;
  let kind: PresentationEvent['kind'] = proposed.kind;
  let needs: TurnNeed | undefined = proposed.needs;
  let resumable = proposed.resumable;

  if (approvalId || /awaiting_approval|pending_approval/.test(reason)) {
    status = 'needs_input';
    resumable = true;
    if (approvalId) {
      kind = 'approval';
      needs = { kind: 'approval' };
    } else {
      kind = 'question';
      needs = { kind: 'input' };
    }
  } else if (/awaiting_continue|limit_exceeded|max_turn|max_step|token_budget/.test(reason)) {
    status = 'needs_input';
    kind = 'continue';
    needs = { kind: 'continue' };
    resumable = true;
  } else if (event.data.awaitingUser === true || /awaiting_(?:user|input|reply)|needs_input/.test(reason)) {
    status = 'needs_input';
    kind = 'question';
    needs = { kind: 'input' };
    resumable = true;
  } else if (/transferred/.test(reason)) {
    // The foreground stopped, but the work did not. A legacy row that says
    // transferred must keep saying transferred rather than being re-read as an
    // abandoned turn by the cancelled branch below.
    status = 'transferred';
    kind = 'transferred';
    needs = undefined;
    resumable = false;
  } else if (/cancelled|canceled|aborted|stopped|rejected_by_user/.test(reason)) {
    status = 'cancelled';
    kind = 'stopped';
    needs = undefined;
    resumable = false;
  } else if (/fail|error|no_structured|exhaust/.test(reason)) {
    status = 'failed';
    kind = 'error';
    needs = undefined;
    resumable = false;
  } else if (event.data.delivered === false || /blocked|stall|abandon/.test(reason)) {
    status = 'blocked';
    kind = 'blocked';
    needs = undefined;
    resumable = false;
  } else if (event.data.delivered === true || /success|delivered|complete/.test(reason)) {
    status = 'done';
    kind = 'answer';
    needs = undefined;
    resumable = false;
  }

  return {
    version: 1,
    id: proposed.id,
    outcomeId: proposed.outcomeId,
    audience: 'user',
    phase: 'final',
    identity: proposed.identity,
    status,
    kind,
    text,
    resumable,
    ...(needs ? { needs } : {}),
    ...(approvalId ? { approvalId } : {}),
  };
}

function sameTurnIdentity(left: TurnIdentity, right: TurnIdentity): boolean {
  // Physical attempts can legitimately race or fall over while completing the
  // same accepted user turn. Only the durable source event owns publication.
  return left.sessionId === right.sessionId
    && left.turn === right.turn
    && left.sourceUserSeq === right.sourceUserSeq;
}

function assertExactAcceptedSource(identity: TurnIdentity): void {
  const accepted = listEvents(identity.sessionId, {
    sinceSeq: identity.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  })[0];
  if (!accepted || accepted.seq !== identity.sourceUserSeq) {
    throw new InvalidTurnOutcomeError(
      `Turn identity source ${identity.sourceUserSeq} is not an accepted user event in this session.`,
    );
  }
  if (accepted.turn !== identity.turn) {
    throw new InvalidTurnOutcomeError(
      `Turn identity ${identity.turn} contradicts accepted event ${identity.sourceUserSeq} turn ${accepted.turn}.`,
    );
  }
}

function isExplicitLegacyTerminal(event: EventRow): boolean {
  return !Object.prototype.hasOwnProperty.call(event.data, 'presentation')
    && !Object.prototype.hasOwnProperty.call(event.data, 'turnOutcome');
}

function assertPersistedPresentationOwnership(
  event: EventRow,
  persisted: PresentationEvent,
  proposed: PresentationEvent,
): void {
  if (event.sessionId !== persisted.identity.sessionId || event.turn !== persisted.identity.turn) {
    throw new InvalidTurnOutcomeError(
      'Persisted presentation identity contradicts its conversation_completed event.',
    );
  }
  if (!sameTurnIdentity(persisted.identity, proposed.identity)) {
    throw new InvalidTurnOutcomeError(
      'Persisted terminal winner belongs to a different turn identity.',
    );
  }
}

/**
 * Commit exactly one final public presentation for a logical user turn.
 *
 * Throws on invalid/unsafe presentation or durable write failure. A foreground
 * caller must never return success, clear recovery state, or stream the proposed
 * text until this function succeeds.
 */
export function commitTurnOutcome(
  outcome: TurnOutcome,
  options: DeliveryCommitOptions = {},
): DeliveryCommitResult {
  const proposed = presentationEventForOutcome(outcome);
  assertExactAcceptedSource(proposed.identity);
  // A prepared/held workflow admission is durable accepted work, not an error
  // or needs-input terminal. Until immutable group activation transfers that
  // ownership to the background daemon, no brain/bridge may publish a terminal
  // winner for the same source and erase its only restart handle.
  assertNoPendingWorkflowChatDispatchOwnership({
    sessionId: proposed.identity.sessionId,
    sourceUserSeq: proposed.identity.sourceUserSeq,
  });
  const data = completionDataForTurnOutcome(outcome, options);
  const terminal = appendTerminalEventOnce({
    sessionId: proposed.identity.sessionId,
    turn: proposed.identity.turn,
    role: 'system',
    data,
  }, proposed.outcomeId);
  // THE FENCE IS WRITTEN WHERE THE FOREGROUND ACTUALLY STOPS. Detach cannot
  // assert it: at that point the run is still executing and may yet complete an
  // in-flight tool call. Only the committer knows the final model/tool boundary
  // has been crossed and no further foreground work can occur for this turn,
  // which is exactly what the fence rung claims. Both brain lanes reduce through
  // here, so neither can transfer a turn without fencing and releasing it.
  try {
    fenceAndReleaseHandoffAtTerminal(proposed.identity.sessionId, proposed.identity.sourceUserSeq);
  } catch { /* the terminal is durable; ownership converges at boot reconciliation */ }
  const decoded = presentationEventFromCompletionData(terminal.event.data);
  let persisted: PresentationEvent;
  if (decoded) {
    assertPersistedPresentationOwnership(terminal.event, decoded, proposed);
    persisted = decoded;
  } else {
    // Compatibility is deliberately narrow: only a row written before typed
    // projections existed may borrow the retry's canonical identity. A row
    // containing either typed field is never reinterpreted as legacy.
    if (!isExplicitLegacyTerminal(terminal.event)) {
      throw new InvalidTurnOutcomeError('Typed terminal row could not be decoded safely.');
    }
    persisted = presentationFromLegacyWinner(terminal.event, proposed);
  }
  return {
    event: terminal.event,
    inserted: terminal.inserted,
    presentation: persisted,
  };
}
