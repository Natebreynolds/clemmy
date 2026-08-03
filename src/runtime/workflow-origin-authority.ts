import { getSession } from './harness/eventlog.js';
import {
  exactOriginDeliveryTargetDigest,
  exactOriginDeliveryTargetFromSessionSnapshot,
  normalizeExactOriginDeliveryTarget,
  type ExactOriginDeliveryTarget,
} from './exact-origin-delivery.js';
import { listEvents } from './harness/eventlog.js';

/** Resolve the precise reply route while the initiating source is being
 * admitted. Callers persist the returned value; completion must never re-read
 * mutable channel/session bindings to decide where an old intent belongs. */
export function resolveWorkflowOriginReplyTarget(
  sessionId: string,
): ExactOriginDeliveryTarget | null {
  const session = getSession(sessionId);
  if (!session || session.kind !== 'chat') return null;
  return exactOriginDeliveryTargetFromSessionSnapshot({
    channel: session.channel,
    metadata: session.metadata,
  });
}

/** Load the immutable route captured on one exact accepted human source. */
export function workflowOriginReplyTargetForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ExactOriginDeliveryTarget | null {
  const source = listEvents(input.sessionId, {
    sinceSeq: input.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  })[0];
  if (
    !source
    || source.seq !== input.sourceUserSeq
    || source.sessionId !== input.sessionId
    || source.type !== 'user_input_received'
    || source.role !== 'user'
    || source.data.synthetic === true
  ) return null;
  const target = normalizeExactOriginDeliveryTarget(source.data.originReplyTarget);
  const digest = typeof source.data.originReplyTargetDigest === 'string'
    ? source.data.originReplyTargetDigest
    : '';
  return target && digest === exactOriginDeliveryTargetDigest(target) ? target : null;
}
