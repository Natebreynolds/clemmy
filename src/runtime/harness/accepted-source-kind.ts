import type { EventRow } from './eventlog.js';

/** An in-place approval acknowledgement belongs to an existing executor. Its
 * own public reply is durable, but it neither replaces that job nor owns work.
 * Do not treat arbitrary synthetic inputs or malformed markers as controls.
 */
export function isLiveApprovalAcknowledgement(event: EventRow): boolean {
  const control = event.data.liveApprovalControl as Record<string, unknown> | undefined;
  return event.type === 'user_input_received' && event.role === 'user'
    && event.data.synthetic === true && typeof event.parentEventId === 'string'
    && !!event.parentEventId && !!control && control.version === 1
    && typeof control.ownerAttemptId === 'string' && !!control.ownerAttemptId.trim()
    && Number.isSafeInteger(control.ownerSourceUserSeq)
    && Number(control.ownerSourceUserSeq) > 0 && Number(control.ownerSourceUserSeq) < event.seq;
}
