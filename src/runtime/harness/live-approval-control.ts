import {
  appendEvent,
  claimHarnessChatRequest,
  getActiveRunAttempt,
  getHarnessChatRequestReceipt,
  getLatestEventSeq,
  getRunAttemptSourceUserEvent,
  listEvents,
  type EventRow,
  type HarnessChatRequestReceipt,
} from './eventlog.js';
import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
import { withApprovalControlCommit, type resolve } from './approval-registry.js';
import { presentationEventFromCompletionData, type PresentationEvent } from './turn-outcome.js';

export interface LiveApprovalControlResult {
  receipt: HarnessChatRequestReceipt;
  source: EventRow;
  presentation: PresentationEvent;
  replayed: boolean;
}

/** A decision releases an existing executor; it never claims an execution lease.
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
    const owner = getActiveRunAttempt(input.sessionId);
    const ownerSource = owner && getRunAttemptSourceUserEvent(owner);
    if (!owner || !ownerSource) return null;
    const prepared = input.prepare();
    if (!prepared) return null;
    const claim = claimHarnessChatRequest({ ...input, sinceSeq: getLatestEventSeq(input.sessionId) });
    const source = appendEvent({
      sessionId: input.sessionId, turn: 0, role: 'user', type: 'user_input_received', parentEventId: ownerSource.id,
      data: {
        ...prepared.sourceData, text: input.text, displayText: input.text, synthetic: true,
        clientRequestId: input.requestId, requestId: input.requestId, runId: claim.receipt.runId,
        liveApprovalControl: { version: 1, ownerAttemptId: owner.attemptId, ownerSourceUserSeq: ownerSource.seq },
      },
    });
    prepared.commit(source, resolveDecision);
    return { receipt: claim.receipt, source, presentation: terminal(source), replayed: false };
  });
}
