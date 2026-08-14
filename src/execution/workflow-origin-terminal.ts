import {
  listEvents,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { commitTurnOutcome, type DeliveryCommitResult } from '../runtime/harness/delivery-committer.js';
import {
  turnOutcomeId,
  type TurnIdentity,
  type TurnOutcome,
} from '../runtime/harness/turn-outcome.js';
import type { ExactWorkflowRunOriginRecord } from '../tools/workflow-run-queue.js';
import type { ExactOriginDeliveryTarget } from '../runtime/exact-origin-delivery.js';
import {
  PUBLIC_RUN_FAILURE_TEXT,
  publicReplyText,
} from '../runtime/harness/public-presentation.js';
export { resolveWorkflowOriginReplyTarget } from '../runtime/workflow-origin-authority.js';

export type WorkflowOriginReplyTarget = ExactOriginDeliveryTarget;

export type WorkflowOriginTerminalOutcome = 'done' | 'blocked' | 'failed';

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

function workflowTurnOutcome(
  identity: TurnIdentity,
  status: WorkflowOriginTerminalOutcome,
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
  return {
    ...common,
    status: 'failed',
    resumable: false,
    presentation: { kind: 'error', text },
  };
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
  if (input.outcome === 'failed') return false;

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
export function commitWorkflowOriginTerminal(input: {
  observer: ExactWorkflowRunOriginRecord;
  /** Primary concrete run used by the durable full-result pointer. */
  runId: string;
  /** Stable logical reducer identity. Multi-run source groups use their group
   * id here while the public idempotency key remains the accepted source. */
  identityRunId?: string;
  evidenceRunIds?: readonly string[];
  outcome: WorkflowOriginTerminalOutcome;
  detail: string;
}): DeliveryCommitResult | null {
  const source = exactAcceptedSource(input.observer);
  if (!source) return null;
  const identity: TurnIdentity = {
    sessionId: input.observer.originSessionId,
    turn: source.turn,
    sourceUserSeq: source.seq,
    runId: input.identityRunId ?? input.runId,
  };
  const text = renderWorkflowOriginTerminalText(input.detail, input.runId);
  const renderedDetail = publicReplyText(input.detail, '');
  return commitTurnOutcome(workflowTurnOutcome(
    identity,
    renderedDetail ? workflowTerminalProposalOutcome(input.outcome) : 'failed',
    text,
    input.evidenceRunIds ?? [input.runId],
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
