import {
  appendEvent,
  claimHarnessChatRequest,
  getActiveRunAttempt,
  getHarnessChatRequestReceipt,
  getLatestEventSeq,
  getRunAttemptSourceUserEvent,
  getRunAttemptBySourceUserSeq,
  listEvents,
  type EventRow,
  type HarnessChatRequestReceipt,
} from './eventlog.js';
import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
import { get, listPending, isActionable, isFormalApprovalSurface, withApprovalControlCommit, type resolve } from './approval-registry.js';
import { approvalAuthorityMatchesToolCall } from './approval-authority.js';
import { presentationEventFromCompletionData, type PresentationEvent } from './turn-outcome.js';

export interface LiveApprovalControlResult {
  receipt: HarnessChatRequestReceipt;
  source: EventRow;
  presentation: PresentationEvent;
  replayed: boolean;
}

export class ApprovalControlBindingUnavailable extends Error {
  constructor() { super('The pending cards changed or their exact request could not be verified. Choose the current card before continuing.'); }
}

/** Resolve the historical owner of one exact displayed card. This is only
 * control identity: a finished attempt is never renewed or reused to execute.
 * Legacy cards without a canonical source binding keep their existing route. */
function pausedCardOwner(sessionId: string, approvalId: string) {
  const row = get(approvalId);
  if (!row || row.sessionId !== sessionId || !isActionable(row) || !isFormalApprovalSurface(row)) return null;
  const carriers = listEvents(sessionId, { types: ['approval_requested'] })
    .filter(event => event.data.approvalId === approvalId);
  if (carriers.length === 0) return null;
  let sourceUserSeq: number | undefined;
  for (const carrier of carriers) {
    const seq = carrier.data.sourceUserSeq;
    if (carrier.role !== 'Clem' || !Number.isSafeInteger(seq) || Number(seq) <= 0 || Number(seq) >= carrier.seq
      || !approvalAuthorityMatchesToolCall(row, carrier.data.tool, carrier.data.args)
      || (sourceUserSeq !== undefined && sourceUserSeq !== seq)) return null;
    sourceUserSeq = Number(seq);
  }
  const owner = getRunAttemptBySourceUserSeq(sessionId, sourceUserSeq!);
  const ownerSource = owner && getRunAttemptSourceUserEvent(owner);
  if (!owner || !ownerSource || ownerSource.role !== 'user' || ownerSource.seq !== sourceUserSeq) return null;
  return { owner, ownerSource };
}

/** A decision releases an existing executor; it never claims an execution lease.
 * A paused-card inquiry instead records that card's historical owner identity.
 * Receipt, accepted control, exact decision and terminal share one transaction.
 * Registry listeners run only after that transaction has committed.
 */
export function commitLiveApprovalControl(input: {
  sessionId: string;
  requestId: string;
  runId: string;
  inputHash: string;
  text: string;
  prepare: () => {
    sourceData?: Record<string, unknown>;
    /** Only a nonexecuting inquiry or exact frozen-payload decision may use
     * historical card ownership instead of an active executor. */
    pausedCardId?: string;
    /** The complete immutable set, not a chosen member. Inquiries cannot use
     * the decision callback and never claim a current execution attempt. */
    inquiryCardIds?: readonly string[];
    commit: (source: EventRow, resolveDecision: typeof resolve) => void;
  } | null;
}): LiveApprovalControlResult | null {
  return withApprovalControlCommit((resolveDecision) => {
    const terminal = (source: EventRow): PresentationEvent => {
      for (const event of listEvents(source.sessionId, { types: ['conversation_completed'], desc: true })) {
        const presentation = presentationEventFromCompletionData(event.data);
        if (presentation?.identity.sourceUserSeq === source.seq) return presentation;
      }
      throw new Error('Accepted approval control has no committed acknowledgement');
    };
    const prior = getHarnessChatRequestReceipt(input.requestId);
    if (prior) {
      const source = listEvents(prior.sessionId, {
        sinceSeq: prior.sinceSeq, types: ['user_input_received'],
      }).find((event) => event.data.clientRequestId === input.requestId && isLiveApprovalAcknowledgement(event));
      // Ordinary execution receipts stay with their own recovery owner. Only
      // a committed control uses this route's run-id/payload replay contract.
      if (!source) return null;
      claimHarnessChatRequest({ ...input, sinceSeq: prior.sinceSeq });
      return { receipt: prior, source, presentation: terminal(source), replayed: true };
    }
    const prepared = input.prepare();
    if (!prepared) return null;
    let inquiryCards: Array<{ approvalId: string; ownerAttemptId: string; ownerSourceUserSeq: number }> | undefined;
    if (prepared.inquiryCardIds !== undefined) {
      const ids = [...prepared.inquiryCardIds].sort();
      const current = listPending({ sessionId: input.sessionId, status: 'pending' })
        .filter(row => isActionable(row)).filter(isFormalApprovalSurface).map(row => row.approvalId).sort();
      if (prepared.pausedCardId || ids.length < 2 || new Set(ids).size !== ids.length
        || JSON.stringify(ids) !== JSON.stringify(current)) throw new ApprovalControlBindingUnavailable();
      inquiryCards = ids.map(approvalId => {
        const binding = pausedCardOwner(input.sessionId, approvalId);
        if (!binding) throw new ApprovalControlBindingUnavailable();
        return { approvalId, ownerAttemptId: binding.owner.attemptId, ownerSourceUserSeq: binding.ownerSource.seq };
      });
    }
    const paused = prepared.pausedCardId ? pausedCardOwner(input.sessionId, prepared.pausedCardId) : null;
    if (prepared.pausedCardId && !paused) return null;
    const owner = inquiryCards ? null : paused?.owner ?? getActiveRunAttempt(input.sessionId);
    const ownerSource = paused?.ownerSource ?? (owner && getRunAttemptSourceUserEvent(owner));
    if (!inquiryCards && (!owner || !ownerSource)) return null;
    const claim = claimHarnessChatRequest({ ...input, sinceSeq: getLatestEventSeq(input.sessionId) });
    const source = appendEvent({
      sessionId: input.sessionId, turn: 0, role: 'user', type: 'user_input_received', parentEventId: ownerSource?.id,
      data: {
        ...prepared.sourceData, text: input.text, displayText: input.text, synthetic: true,
        clientRequestId: input.requestId, requestId: input.requestId, runId: claim.receipt.runId,
        liveApprovalControl: inquiryCards
          ? { version: 1, mode: 'card_inquiry', cards: inquiryCards }
          : { version: 1, ownerAttemptId: owner!.attemptId, ownerSourceUserSeq: ownerSource!.seq,
            ...(paused ? { mode: 'paused_card', approvalId: prepared.pausedCardId } : {}) },
      },
    });
    prepared.commit(source, inquiryCards ? () => { throw new Error('A card inquiry cannot resolve a decision.'); } : resolveDecision);
    return { receipt: claim.receipt, source, presentation: terminal(source), replayed: false };
  });
}
