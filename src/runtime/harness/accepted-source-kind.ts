import type { EventRow } from './eventlog.js';

/** An in-place approval acknowledgement belongs to existing or historical
 * exact card owners. Paused-card and card-set inquiry markers grant no execution
 * or lease authority. Their public reply is durable but replaces no owned job.
 * Do not treat arbitrary synthetic inputs or malformed markers as controls.
 */
export function isLiveApprovalAcknowledgement(event: EventRow): boolean {
  const control = event.data.liveApprovalControl as Record<string, unknown> | undefined;
  if (event.type !== 'user_input_received' || event.role !== 'user'
    || event.data.synthetic !== true || !control || control.version !== 1) return false;
  if (control.mode === 'card_inquiry') {
    if (event.parentEventId != null || control.ownerAttemptId !== undefined || control.ownerSourceUserSeq !== undefined
      || !Array.isArray(control.cards) || control.cards.length < 2) return false;
    const ids = new Set<string>();
    return control.cards.every((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const card = value as Record<string, unknown>;
      if (typeof card.approvalId !== 'string' || !card.approvalId.trim() || ids.has(card.approvalId)) return false;
      ids.add(card.approvalId);
      return typeof card.ownerAttemptId === 'string' && !!card.ownerAttemptId.trim()
        && Number.isSafeInteger(card.ownerSourceUserSeq) && Number(card.ownerSourceUserSeq) > 0
        && Number(card.ownerSourceUserSeq) < event.seq;
    });
  }
  return typeof event.parentEventId === 'string' && !!event.parentEventId
    && (control.mode === undefined || (control.mode === 'paused_card'
      && typeof control.approvalId === 'string' && !!control.approvalId.trim()))
    && typeof control.ownerAttemptId === 'string' && !!control.ownerAttemptId.trim()
    && Number.isSafeInteger(control.ownerSourceUserSeq)
    && Number(control.ownerSourceUserSeq) > 0 && Number(control.ownerSourceUserSeq) < event.seq;
}
