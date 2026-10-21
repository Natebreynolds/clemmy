/** Display-only steering receipts. Neither adoption nor a receipt grants work
 * or establishes that the addition was fulfilled. */
export interface SteerReceipt {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  noteSeq: number;
  clientRequestId?: string;
  /** Presentation-only caller echo; canonical request identity stays above. */
  clientEchoId?: string;
  state: 'accepted' | 'adopted' | 'unhandled';
  changedAtSeq: number;
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 240 && /^[A-Za-z0-9:._/-]+$/.test(value);
export function readSteerReceipt(value: unknown): SteerReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(key => !['version', 'sessionId', 'sourceUserSeq', 'noteSeq', 'clientRequestId', 'clientEchoId', 'state', 'changedAtSeq'].includes(key))
    || r.version !== 1 || !identifier(r.sessionId) || !positive(r.sourceUserSeq) || !positive(r.noteSeq)
    || r.sourceUserSeq >= r.noteSeq || !positive(r.changedAtSeq) || r.changedAtSeq < r.noteSeq
    || (r.clientRequestId !== undefined && (typeof r.clientRequestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(r.clientRequestId)))
    || (r.clientEchoId !== undefined && (typeof r.clientEchoId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(r.clientEchoId)))
    || typeof r.state !== 'string' || !['accepted', 'adopted', 'unhandled'].includes(r.state)
    || (r.state === 'accepted' && r.changedAtSeq !== r.noteSeq)
    || (r.state !== 'accepted' && r.changedAtSeq === r.noteSeq)) return null;
  return { version: 1, sessionId: r.sessionId, sourceUserSeq: r.sourceUserSeq, noteSeq: r.noteSeq,
    state: r.state as SteerReceipt['state'], changedAtSeq: r.changedAtSeq,
    ...(r.clientRequestId ? { clientRequestId: r.clientRequestId as string } : {}),
    ...(r.clientEchoId ? { clientEchoId: r.clientEchoId as string } : {}) };
}
interface SteerMessage {
  id: string; role: 'user' | 'assistant'; text: string;
  steer?: 'pending' | 'delivered' | 'failed' | 'queued' | 'held'; steerReceipt?: SteerReceipt;
  idempotencyKey?: string; requestSessionId?: string | null; steerNoteSeq?: number;
  pending?: 'sending' | 'failed'; pendingError?: string;
  /** An addition the run ended without reading: sent on as its own message,
   *  or held for the owner's tap. */
  steerFollowUp?: 'sent' | 'held';
}
interface ReceiptEvent { type: string; sessionId?: string; seq: number; role?: string; data?: Record<string, unknown> }
/** Admission is a display acknowledgement, independent of whether bounded
 * evidence can establish host adoption. This never authorizes execution. */
export function hasSteerAdmission(message?: Pick<SteerMessage, 'steer' | 'steerReceipt' | 'requestSessionId' | 'steerNoteSeq'>): boolean {
  return Boolean(message?.steerReceipt || (message?.steer === 'delivered'
    && identifier(message.requestSessionId) && positive(message.steerNoteSeq)));
}
export function applySteerReceiptEvent<T extends SteerMessage>(messages: T[], event: ReceiptEvent, sessionId?: string | null): T[] {
  if (!sessionId || event.sessionId !== sessionId || !positive(event.seq)) return messages;
  const data = event.data ?? {};
  const note = event.type === 'user_steer_note' && event.role === 'user' && typeof data.text === 'string' && data.text.trim();
  const raw = note ? [data.steerReceipt] : event.type === 'user_steer_receipt' ? data.receipts
    : event.type === 'conversation_completed' ? data.steerReceipts : undefined;
  if (!Array.isArray(raw) || raw.length > 64) return messages;
  let next = messages;
  // An older or bounded projection may have the durable user row without a
  // verified handling receipt. Keep the words, without claiming adoption.
  if (note && !readSteerReceipt(data.steerReceipt)) {
    const index = messages.findIndex(message => message.role === 'user' && message.requestSessionId === sessionId
      && (message.steerNoteSeq === event.seq || (message.steer && message.idempotencyKey
        && (message.idempotencyKey === data.clientRequestId || message.idempotencyKey === data.clientEchoId))));
    if (index >= 0 && messages[index]!.steerReceipt) return messages;
    const row = { ...(index >= 0 ? messages[index] : { id: `steer-${event.seq}`, role: 'user', text: data.text }),
      steer: 'delivered', steerNoteSeq: event.seq, requestSessionId: sessionId, pending: undefined } as T;
    return index >= 0 ? messages.map((message, i) => i === index ? row : message) : [...messages, row];
  }
  for (const value of raw) {
    const receipt = readSteerReceipt(value);
    if (!receipt || receipt.sessionId !== sessionId || (note && receipt.noteSeq !== event.seq)
      || (!note && receipt.changedAtSeq > event.seq)
      || (event.type === 'conversation_completed' && receipt.sourceUserSeq !== data.sourceUserSeq)) continue;
    if (next.some(message => message.steerReceipt?.sessionId === sessionId && message.steerReceipt.noteSeq === receipt.noteSeq
      && message.steerReceipt.sourceUserSeq !== receipt.sourceUserSeq)) continue;
    const index = next.findIndex(message => message.role === 'user' && (message.steerReceipt
      ? message.steerReceipt.sessionId === sessionId && message.steerReceipt.noteSeq === receipt.noteSeq
        && message.steerReceipt.sourceUserSeq === receipt.sourceUserSeq
      : Boolean(message.steer && message.requestSessionId === sessionId
        && ((message.idempotencyKey && (message.idempotencyKey === receipt.clientRequestId || message.idempotencyKey === receipt.clientEchoId))
          || message.steerNoteSeq === receipt.noteSeq))));
    if (index < 0 && !note) continue;
    const previous = index >= 0 ? next[index] : undefined;
    if (previous?.steerReceipt && previous.steerReceipt.changedAtSeq >= receipt.changedAtSeq) continue;
    const row = { ...(previous ?? { id: `steer-${receipt.noteSeq}`, role: 'user', text: data.text }),
      steer: 'delivered', steerReceipt: receipt, steerNoteSeq: receipt.noteSeq, pending: undefined, pendingError: undefined, ...(previous ? {} : { requestSessionId: sessionId }) } as T;
    next = index < 0 ? [...next, row] : next.map((message, i) => i === index ? row : message);
  }
  return next;
}
/** The request id an unread addition goes on with: fixed to the note, so the
 *  daemon runs it once whichever window sends it. */
export function steerFollowUpRequestId(receipt: Pick<SteerReceipt, 'sessionId' | 'noteSeq'>): string {
  return `steer-followup:${receipt.sessionId.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120)}:${receipt.noteSeq}`;
}

/**
 * The owner's additions a run ended without reading, that this view sent
 * itself and has not followed up. Live 2026-10-21: "we cant even write notes?"
 * reached the daemon 24 s before the run ended, no step read it, and it sat
 * under "your message is kept" with nothing to send it on. A row only seen in
 * history (no request id of this view's) is never sent on its own: opening an
 * old chat does not fire an old message.
 */
export function unhandledSteerFollowUps<T extends SteerMessage>(messages: readonly T[]): T[] {
  return messages.filter((message) => message.role === 'user' && message.steerReceipt?.state === 'unhandled'
    && !message.steerFollowUp && Boolean(message.idempotencyKey) && message.text.trim().length > 0);
}

export function steerReceiptLabel(message: { steer?: string; steerReceipt?: SteerReceipt; steerFollowUp?: 'sent' | 'held' }): string {
  if (message.steerFollowUp === 'sent') return 'Clem had finished, so this went as its own message';
  if (message.steerFollowUp === 'held') return 'Clem finished before reading this';
  if (message.steerReceipt?.state === 'adopted') return 'Added to this run’s context';
  if (message.steerReceipt?.state === 'unhandled') return 'Run ended — use of this addition wasn’t confirmed; your message is kept';
  if (message.steerReceipt?.state === 'accepted' || message.steer === 'delivered') return 'Received for this run';
  return message.steer === 'pending' ? 'Reaching her mid-run…'
    : message.steer === 'queued' ? 'Sends when Clem finishes'
    : message.steer === 'held' ? 'Not sent yet'
    : message.steer === 'failed' ? 'Couldn’t confirm this addition — check the run before resending' : '';
}
