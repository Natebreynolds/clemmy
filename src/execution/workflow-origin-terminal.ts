import { workflowOriginCompletionReviewRequired, reviewWorkflowOriginCompletion } from './workflow-origin-completion-review.js';
import {
  listEvents,
  getRunAttemptBySourceUserSeq,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import {
  assessAcceptedSourceDelivery,
  commitTurnOutcome,
  type DeliveryCommitResult,
  type DeliveryGap,
} from '../runtime/harness/delivery-committer.js';
import {
  assertPublicPresentationText,
  presentationEventFromCompletionData,
  turnOutcomeId,
  type TurnIdentity,
  type TurnOutcome,
} from '../runtime/harness/turn-outcome.js';
import {
  evaluateTerminalDelivery,
  type EvaluateTerminalDeliveryOptions,
} from '../runtime/harness/terminal-delivery-judge.js';
import type { ExactWorkflowRunOriginRecord } from '../tools/workflow-run-queue.js';
import type { ExactOriginDeliveryTarget } from '../runtime/exact-origin-delivery.js';
import {
  PUBLIC_RUN_FAILURE_TEXT,
  publicReplyText,
  publicUserInputText,
} from '../runtime/harness/public-presentation.js';
import {
  RETAINED_WORK_TERMINAL_HEADER,
  renderFailureWithRetainedWork,
} from '../runtime/harness/retained-work-terminal.js';
export { resolveWorkflowOriginReplyTarget } from '../runtime/workflow-origin-authority.js';

export type WorkflowOriginReplyTarget = ExactOriginDeliveryTarget;

export type WorkflowOriginTerminalOutcome = 'done' | 'blocked' | 'failed' | 'cancelled';

export interface WorkflowOriginTerminalInput {
  observer: ExactWorkflowRunOriginRecord;
  /** Primary concrete run used by the durable full-result pointer. */
  runId: string;
  /** Stable logical reducer identity. Multi-run source groups use their group
   * id here while the public idempotency key remains the accepted source. */
  identityRunId?: string;
  evidenceRunIds?: readonly string[];
  outcome: WorkflowOriginTerminalOutcome;
  detail: string;
  /** A multi-run reducer removed member-scoped retained-work sections before
   * aggregation. Re-project the exact origin's authoritative inventory once,
   * after the complete aggregate has been rendered. */
  reprojectRetainedWorkFromOrigin?: boolean;
}

export type ReviewWorkflowOriginTerminalOptions = EvaluateTerminalDeliveryOptions;

const MAX_ORIGIN_TERMINAL_CHARS = 1_800;
const WORKFLOW_BLOCKED_DELIVERY_CONCERN =
  'The workflow checkpoint reported a result that still needs attention.';

function exactAcceptedSource(observer: ExactWorkflowRunOriginRecord): EventRow | null {
  const source = listEvents(observer.originSessionId, {
    sinceSeq: observer.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  })[0];
  return source?.seq === observer.sourceUserSeq
    && source.role === 'user'
    && source.data.synthetic !== true
    ? source
    : null;
}

export function renderWorkflowOriginTerminalText(detail: string, runId: string): string {
  // The workflow/report model owns successful terminal prose. Empty or unsafe
  // bytes are a genuine presentation failure: use the shared failed-model
  // floor and publish a typed failure below, never a workflow-specific script.
  const compact = publicReplyText(detail, PUBLIC_RUN_FAILURE_TEXT);
  if (compact.length <= MAX_ORIGIN_TERMINAL_CHARS) return compact;
  const suffix = `\n\nFull result: workflow_run_status run_id="${runId}"`;
  const available = Math.max(1, MAX_ORIGIN_TERMINAL_CHARS - suffix.length - 1);
  return `${compact.slice(0, available).trimEnd()}…${suffix}`;
}

/** Render one member before it enters a multi-run public aggregate. A retained
 * inventory is terminal within its member's copy, not within the aggregate;
 * remove it here so it cannot swallow summaries for later sealed members. The
 * final origin terminal re-projects authoritative retained work once. */
export function renderWorkflowOriginTerminalGroupMemberText(
  detail: string,
  runId: string,
): { text: string; removedRetainedWork: boolean } {
  const text = renderWorkflowOriginTerminalText(detail, runId);
  const retainedWorkIndex = text.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  return retainedWorkIndex < 0
    ? { text, removedRetainedWork: false }
    : {
        text: text.slice(0, retainedWorkIndex).trimEnd(),
        removedRetainedWork: true,
      };
}

function workflowTurnOutcome(
  identity: TurnIdentity,
  status: WorkflowOriginTerminalOutcome | 'needs_input',
  text: string,
  evidenceRunIds: readonly string[],
): TurnOutcome {
  const evidenceRefs = [...new Set(evidenceRunIds.map((id) => id.trim()).filter(Boolean))]
    .map((id) => ({ kind: 'source' as const, id }));
  const common = {
    version: 2 as const,
    id: turnOutcomeId(identity),
    identity,
    evidenceRefs: evidenceRefs.length > 0
      ? evidenceRefs
      : [{ kind: 'source' as const, id: identity.runId ?? 'workflow-run' }],
  };
  if (status === 'done') {
    return {
      ...common,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text },
    };
  }
  if (status === 'blocked') {
    return {
      ...common,
      status: 'blocked',
      resumable: true,
      presentation: { kind: 'blocked', text },
    };
  }
  if (status === 'needs_input') {
    return {
      ...common,
      status: 'needs_input',
      resumable: true,
      needs: { kind: 'input' },
      presentation: { kind: 'question', text },
    };
  }
  if (status === 'cancelled') {
    return {
      ...common,
      status: 'cancelled',
      resumable: false,
      presentation: { kind: 'stopped', text },
    };
  }
  return {
    ...common,
    status: 'failed',
    resumable: false,
    presentation: { kind: 'error', text },
  };
}

interface PreparedWorkflowOriginTerminal {
  source: EventRow;
  identity: TurnIdentity;
  text: string;
  renderedDetail: string;
  evidenceRunIds: readonly string[];
  deliveryConcern: DeliveryGap | null;
}

function preparedWorkflowOriginTerminal(
  input: WorkflowOriginTerminalInput,
): PreparedWorkflowOriginTerminal | null {
  const source = exactAcceptedSource(input.observer);
  if (!source) return null;
  const renderedText = renderWorkflowOriginTerminalText(input.detail, input.runId);
  // A blocked/failed workflow detail can carry a retained-work inventory from
  // its child step session. At the origin boundary that inventory must be
  // re-projected against the exact accepted origin source before it becomes
  // public. Doing this before the terminal's first writer also gives the
  // report-back verifier one canonical string to compare on every retry.
  const text = input.outcome !== 'done'
    && (
      input.reprojectRetainedWorkFromOrigin === true
      || renderedText.includes(RETAINED_WORK_TERMINAL_HEADER)
    )
    ? renderFailureWithRetainedWork({
        sessionId: input.observer.originSessionId,
        sourceUserSeq: source.seq,
        fallbackText: renderedText,
      })
    : renderedText;
  const parentAttempt = getRunAttemptBySourceUserSeq(input.observer.originSessionId, source.seq);
  return {
    source,
    identity: {
      sessionId: input.observer.originSessionId,
      turn: source.turn,
      sourceUserSeq: source.seq,
      // Immutable workflow settlement uses the child/group run identity. The
      // exact parent attempt is separate and wins eventlog's owner lookup.
      runId: input.identityRunId ?? input.runId,
      ...(parentAttempt ? { attemptId: parentAttempt.attemptId } : {}),
    },
    text,
    renderedDetail: publicReplyText(input.detail, ''),
    evidenceRunIds: input.evidenceRunIds ?? [input.runId],
    deliveryConcern: input.outcome === 'blocked'
      ? { reason: WORKFLOW_BLOCKED_DELIVERY_CONCERN }
      : null,
  };
}

/** Exact public text the origin-terminal committer will propose. Report-back
 * retries use this instead of independently rendering the pre-canonical child
 * detail, so an already-durable winner is acknowledged idempotently. */
export function workflowOriginTerminalExpectedText(
  input: WorkflowOriginTerminalInput,
): string | null {
  return preparedWorkflowOriginTerminal(input)?.text ?? null;
}

function existingWorkflowOriginTerminal(
  prepared: PreparedWorkflowOriginTerminal,
): DeliveryCommitResult | null {
  const expectedOutcomeId = turnOutcomeId(prepared.identity);
  for (const event of listEvents(prepared.identity.sessionId, {
    types: ['conversation_completed'],
  })) {
    let presentation;
    try {
      presentation = presentationEventFromCompletionData(event.data);
    } catch {
      continue;
    }
    if (
      presentation?.outcomeId === expectedOutcomeId
      && presentation.identity.sessionId === prepared.identity.sessionId
      && presentation.identity.turn === prepared.identity.turn
      && presentation.identity.sourceUserSeq === prepared.identity.sourceUserSeq
    ) {
      return { event, inserted: false, presentation };
    }
  }
  return null;
}

function workflowOriginTerminalRowExists(
  prepared: PreparedWorkflowOriginTerminal,
): boolean {
  return listEvents(prepared.identity.sessionId, {
    types: ['conversation_completed'],
  }).some((event) => event.turn === prepared.identity.turn
    && event.data.sourceUserSeq === prepared.identity.sourceUserSeq);
}

function workflowOriginTerminalAssessment(
  prepared: PreparedWorkflowOriginTerminal,
  input: WorkflowOriginTerminalInput,
) {
  if (!prepared.renderedDetail || workflowTerminalProposalOutcome(input.outcome) !== 'done') {
    return null;
  }
  return assessAcceptedSourceDelivery({
    sessionId: prepared.identity.sessionId,
    sourceUserSeq: prepared.identity.sourceUserSeq,
    proposedReply: prepared.text,
    deliveryConcern: prepared.deliveryConcern,
  });
}

/** Synchronous topology check used by the report-back coordinator. A clean
 * completion remains on the old zero-latency path; only a real shared delivery
 * gap needs the asynchronous different-family judge before publication. */
export function workflowOriginTerminalNeedsAsyncJudge(
  input: WorkflowOriginTerminalInput,
): boolean {
  const prepared = preparedWorkflowOriginTerminal(input);
  if (!prepared || workflowOriginTerminalRowExists(prepared)) return false;
  return workflowOriginCompletionReviewRequired(input, prepared.text)
    || Boolean(workflowOriginTerminalAssessment(prepared, input)?.deliveryGap);
}

/** A checkpoint is not allowed to make its own publish-time hold decision.
 * `blocked` therefore enters the shared committer as a completed proposal with
 * an explicit concern; the committer alone decides whether real work earns a
 * qualified completion or whether the source still needs a human hold. */
function workflowTerminalProposalOutcome(
  outcome: WorkflowOriginTerminalOutcome,
): WorkflowOriginTerminalOutcome {
  return outcome === 'blocked' ? 'done' : outcome;
}

/** Validate the public winner without mistaking a shared-committer
 * qualification for corrupt workflow evidence. Exact legacy winners remain
 * readable, but a changed status/text must carry the committer's allowlisted
 * disclosure/verification marker. A genuine workflow failure is never
 * eligible for qualification. */
export function workflowOriginTerminalCommitMatches(input: {
  committed: DeliveryCommitResult;
  outcome: WorkflowOriginTerminalOutcome;
  expectedText: string;
}): boolean {
  const { presentation } = input.committed;
  if (
    presentation.status === input.outcome
    && presentation.text === input.expectedText
  ) return true;
  if (
    presentation.status === 'failed'
    && presentation.text === PUBLIC_RUN_FAILURE_TEXT
    && input.expectedText === PUBLIC_RUN_FAILURE_TEXT
  ) return true;
  if (input.outcome === 'failed' || input.outcome === 'cancelled') return false;

  if (
    presentation.status === 'needs_input'
    && input.committed.event.data.terminalJudgeDisposition === 'ask'
  ) return true;
  if (
    presentation.status === 'done'
    && input.committed.event.data.terminalJudgeDisposition === 'deliver'
  ) return true;

  if (
    presentation.status === 'done'
    && input.committed.event.data.deliveryDisclosure === 'unverified_completion'
  ) {
    return presentation.text === input.expectedText
      || presentation.text.startsWith(`${input.expectedText}\n\n`);
  }
  if (
    presentation.status === 'blocked'
    && (
      input.committed.event.data.blockedReason === 'verification_required'
      || (
        typeof input.committed.event.data.verificationDetail === 'string'
        && input.committed.event.data.verificationDetail.trim().length > 0
      )
    )
  ) {
    // A done proposal can be replaced by the committer's bounded hold prose.
    // A pre-disclosed blocked checkpoint asks the committer to retain its own
    // authored account, so that path must still match exactly.
    return input.outcome === 'done' || presentation.text === input.expectedText;
  }
  return false;
}

/** Commit the workflow's checkpointed result as the one terminal owned by the
 * original human source. No synthetic input and no second model turn exist in
 * this path; retries converge through commitTurnOutcome's durable turn key. */
export function commitWorkflowOriginTerminal(
  input: WorkflowOriginTerminalInput,
): DeliveryCommitResult | null {
  const prepared = preparedWorkflowOriginTerminal(input);
  if (!prepared) return null;
  if (!workflowOriginTerminalRowExists(prepared)
    && workflowOriginCompletionReviewRequired(input, prepared.text)) return null;
  return commitTurnOutcome(workflowTurnOutcome(
    prepared.identity,
    prepared.renderedDetail ? workflowTerminalProposalOutcome(input.outcome) : 'failed',
    prepared.text,
    prepared.evidenceRunIds,
  ), {
    ...(input.outcome === 'blocked'
      ? {
          // The checkpoint's own prose already accounts for why the workflow
          // needs attention. Preserve it on either shared-rule branch.
          presentationAlreadyDiscloses: true,
          deliveryConcern: { reason: WORKFLOW_BLOCKED_DELIVERY_CONCERN },
        }
      : {}),
    legacyReason: 'workflow_async_terminal',
    metadata: {
      transport: 'workflow_report_back',
    },
  });
}

/** Assess then judge one workflow-origin terminal before publication. This
 * lane has no same-run continuation after the durable workflow checkpoint, so
 * all RESUME capabilities are false. The shared evaluator consequently refuses
 * RESUME and this function retains the current conservative committer fallback.
 * No workflow-specific model, provider, or transport is selected here. */
export async function reviewAndCommitWorkflowOriginTerminal(
  input: WorkflowOriginTerminalInput,
  options: ReviewWorkflowOriginTerminalOptions = {},
): Promise<DeliveryCommitResult | null> {
  const prepared = preparedWorkflowOriginTerminal(input);
  if (!prepared) return null;
  const existing = existingWorkflowOriginTerminal(prepared);
  if (existing) return existing;
  // A legacy or corrupt first-writer is still a durable winner. Let the shared
  // committer decode/fail it on the synchronous path; never spend a judge call
  // after publication already occurred.
  if (workflowOriginTerminalRowExists(prepared)) return commitWorkflowOriginTerminal(input);
  // Captured optional completion review belongs to the actual joined child
  // result and exact public reply, never the earlier queue acknowledgement.
  // Revalidation after await fences stale child bytes/objectives/terminals.
  const completion = await reviewWorkflowOriginCompletion(input, prepared.text);
  if (completion === 'stale') return null;
  if (completion === 'reviewed' || completion === 'unavailable') {
    return commitWorkflowOriginTerminal(input);
  }
  const assessment = workflowOriginTerminalAssessment(prepared, input);
  if (!assessment?.deliveryGap) return commitWorkflowOriginTerminal(input);

  const decision = await evaluateTerminalDelivery({
    objective: publicUserInputText(prepared.source.data) || 'Complete the accepted workflow request.',
    authoredText: prepared.text,
    deliveryConcern: {
      reason: assessment.deliveryGap.reason ?? 'terminal evidence is incomplete',
      ...(assessment.deliveryGap.missing?.length
        ? { missing: assessment.deliveryGap.missing }
        : {}),
    },
    settlementAudit: assessment.settlementAudit,
    priorConsecutiveResumes: 0,
    // A workflow checkpoint is already outside the model runner. There is no
    // live same-run tool continuation to honor, so advertising RESUME here
    // would create a control edge that does not exist.
    recoveryCapability: {
      liveContinuation: false,
      toolsAvailable: false,
      externalStateInspection: false,
    },
  }, options);

  if (decision.status !== 'decided' || decision.verb === 'resume') {
    return commitWorkflowOriginTerminal(input);
  }
  try {
    assertPublicPresentationText(decision.publicText);
  } catch {
    // A syntactically valid judge verdict can still contain private protocol.
    // Treat it exactly like unavailable judgment; never rewrite its words.
    return commitWorkflowOriginTerminal(input);
  }
  const metadata = {
    transport: 'workflow_report_back',
    terminalJudgeDisposition: decision.verb,
    terminalJudgeReason: decision.reason,
    terminalJudgeFamily: decision.judge.judgeFamily,
    terminalJudgeResumeCount: decision.consecutiveResumeCount,
  };
  if (decision.verb === 'ask') {
    return commitTurnOutcome(workflowTurnOutcome(
      prepared.identity,
      'needs_input',
      decision.publicText,
      prepared.evidenceRunIds,
    ), {
      legacyReason: 'awaiting_user_input',
      metadata,
    });
  }
  return commitTurnOutcome(workflowTurnOutcome(
    prepared.identity,
    'done',
    decision.publicText,
    prepared.evidenceRunIds,
  ), {
    presentationAlreadyDiscloses: true,
    deliveryConcern: {
      reason: assessment.deliveryGap.reason ?? 'terminal evidence is incomplete',
      ...(assessment.deliveryGap.missing?.length
        ? { missing: assessment.deliveryGap.missing }
        : {}),
    },
    terminalJudgeDisposition: 'deliver',
    legacyReason: 'workflow_async_terminal',
    metadata,
  });
}
