import type { EventRow } from './eventlog.js';

/** A worker's retained result is context and presentation, never a new human
 * assignment or executor. Match only the internal closed delivery source. */
export function isBackgroundOutcomeSource(event: EventRow): boolean {
  const data = event.data;
  const bounded = (value: unknown, max: number) => typeof value === 'string'
    && value.trim().length > 0 && value === value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  return event.type === 'user_input_received' && event.role === 'user'
    && data.synthetic === true && data.source === 'outcome'
    && (data.deliveryPhase === 'passive' || data.deliveryPhase === 'report')
    && bounded(data.sourceLabel, 256) && bounded(data.sourceId, 4096);
}

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

/** Boundaries between user assignments exclude control acknowledgements and
 * settled-result delivery; those must not cut off instructions or evidence. */
export function isExecutionSourceBoundary(event: EventRow): boolean {
  return event.type === 'user_input_received' && !isLiveApprovalAcknowledgement(event)
    && !isBackgroundOutcomeSource(event);
}
