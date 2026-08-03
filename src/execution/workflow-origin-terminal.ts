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
import { publicReplyText } from '../runtime/harness/public-presentation.js';
export { resolveWorkflowOriginReplyTarget } from '../runtime/workflow-origin-authority.js';

export type WorkflowOriginReplyTarget = ExactOriginDeliveryTarget;

export type WorkflowOriginTerminalOutcome = 'done' | 'blocked' | 'failed';

const MAX_ORIGIN_TERMINAL_CHARS = 1_800;

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
  const fallback = `The workflow finished, but its result could not be displayed safely. Review workflow_run_status run_id="${runId}".`;
  const compact = publicReplyText(detail, fallback);
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
  return commitTurnOutcome(workflowTurnOutcome(
    identity,
    input.outcome,
    text,
    input.evidenceRunIds ?? [input.runId],
  ), {
    legacyReason: 'workflow_async_terminal',
    metadata: {
      transport: 'workflow_report_back',
      blockedReason: input.outcome === 'blocked' ? 'workflow_needs_attention' : undefined,
    },
  });
}
