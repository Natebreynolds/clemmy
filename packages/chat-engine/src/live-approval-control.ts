/** Public control acknowledgements name an existing executor; they are not a
 * new work request or that executor's terminal. The server validates ownership.
 * This parser supplies presentation scope only, never cancellation authority. */
export interface LiveApprovalControl {
  version: 1;
  ownerAttemptId: string;
  ownerSourceUserSeq: number;
}
export function readLiveApprovalControl(event: {
  seq: number; type: string; sessionId?: string; data?: Record<string, unknown>;
}): LiveApprovalControl | null {
  if (event.type !== 'user_input_received' && event.type !== 'conversation_completed') return null;
  const data = event.data ?? {};
  const marker = data.liveApprovalControl;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const value = marker as Record<string, unknown>;
  if (value.version !== 1 || typeof value.ownerAttemptId !== 'string' || !value.ownerAttemptId.trim()
    || !Number.isSafeInteger(value.ownerSourceUserSeq) || (value.ownerSourceUserSeq as number) <= 0) return null;
  const source = event.type === 'user_input_received' ? event.seq : data.sourceUserSeq;
  if (!Number.isSafeInteger(source) || (source as number) <= (value.ownerSourceUserSeq as number)
    || (source as number) > event.seq) return null;
  if (event.type === 'user_input_received' && data.synthetic !== true) return null;
  if (event.type === 'conversation_completed') {
    if ((source as number) >= event.seq) return null;
    const presentation = data.presentation as Record<string, unknown> | undefined;
    const identity = presentation?.identity as Record<string, unknown> | undefined;
    const outcome = data.turnOutcome as Record<string, unknown> | undefined;
    if (typeof presentation?.status !== 'string'
      || (outcome && outcome.status !== presentation.status)) return null;
    if (!identity || identity.sourceUserSeq !== source
      || (event.sessionId && identity.sessionId !== event.sessionId)) return null;
  }
  return { version: 1, ownerAttemptId: value.ownerAttemptId, ownerSourceUserSeq: value.ownerSourceUserSeq as number };
}
