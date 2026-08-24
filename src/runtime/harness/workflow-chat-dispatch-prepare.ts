/**
 * Trusted chat-dispatch preparation for a queued workflow run.
 *
 * Shared by the workflow_run tool and host-owned named-workflow dispatch
 * so both write the same private async_work_dispatch_prepared edge.
 */
import {
  appendEvent,
  listEvents,
  type AppendEventInput,
  type EventRow,
} from './eventlog.js';
import { workflowOriginReplyTargetForSource } from '../workflow-origin-authority.js';
import {
  exactOriginDeliveryTargetDigest,
  sameExactOriginDeliveryTarget,
} from '../exact-origin-delivery.js';
import {
  createWorkflowChatDispatchPreparedReceipt,
  recordWorkflowChatDispatchPreparation,
  type WorkflowChatDispatchPreparationAuthority,
  type WorkflowChatDispatchPreparedReceipt,
} from '../../execution/workflow-origin-group.js';

type WorkflowDispatchEventAppender = (input: AppendEventInput) => EventRow;
let appendWorkflowDispatchEvent: WorkflowDispatchEventAppender = appendEvent;

/** Test seam for proving a queue success cannot become a safe ACK when the
 * load-bearing graph event fails to persist. */
export function _setWorkflowDispatchEventAppenderForTests(
  appender?: WorkflowDispatchEventAppender | null,
): void {
  appendWorkflowDispatchEvent = appender ?? appendEvent;
}

export function prepareWorkflowChatDispatch(
  authority: WorkflowChatDispatchPreparationAuthority,
): WorkflowChatDispatchPreparedReceipt {
  const source = listEvents(authority.originSessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === authority.sourceUserSeq);
  const sourceTarget = workflowOriginReplyTargetForSource({
    sessionId: authority.originSessionId,
    sourceUserSeq: authority.sourceUserSeq,
  });
  if (
    !source
    || source.role !== 'user'
    || source.data.synthetic === true
    || !sourceTarget
    || authority.replyTargetDigest !== exactOriginDeliveryTargetDigest(sourceTarget)
    || !sameExactOriginDeliveryTarget(authority.replyTarget, sourceTarget)
  ) {
    throw new Error('workflow dispatch preparation is not bound to an exact accepted human source');
  }
  const evidenceFor = (event: EventRow) => ({
    eventId: event.id,
    eventSeq: event.seq,
    preparedAt: event.createdAt,
  });
  const existing = listEvents(authority.originSessionId, { types: ['async_work_dispatch_prepared'] })
    .find((event) => (
      event.data.sourceGroupId === authority.sourceGroupId
      && event.data.runId === authority.runId
    ));
  if (existing) {
    const winner = createWorkflowChatDispatchPreparedReceipt(
      existing.data as unknown as WorkflowChatDispatchPreparationAuthority,
      evidenceFor(existing),
    );
    if (
      existing.role !== 'system'
      || existing.turn !== source.turn
      || existing.parentEventId !== source.id
      || winner.preparationDigest !== authority.preparationDigest
    ) {
      throw new Error('workflow dispatch preparation has a conflicting durable winner');
    }
    return recordWorkflowChatDispatchPreparation(winner);
  }

  const event = appendWorkflowDispatchEvent({
    sessionId: authority.originSessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatch_prepared',
    parentEventId: source.id,
    data: { ...authority },
  });
  const persisted = createWorkflowChatDispatchPreparedReceipt(
    event.data as unknown as WorkflowChatDispatchPreparationAuthority,
    evidenceFor(event),
  );
  if (
    event.role !== 'system'
    || event.turn !== source.turn
    || event.parentEventId !== source.id
    || persisted.preparationDigest !== authority.preparationDigest
  ) {
    throw new Error('workflow dispatch preparation did not persist with its exact source identity');
  }
  return recordWorkflowChatDispatchPreparation(persisted);
}
