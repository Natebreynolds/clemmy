import type { ChatMessage } from '@clem/chat-engine';

export interface ObservedChatRunControl {
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
}

/** A delayed Stop warning belongs to its source even after busy clears. */
export function stopQualificationOwnsChat(owner: { sessionId: string; key: string | null;
  sourceUserSeq: number | null; acceptedSeqAtStop: number }, current: {
  sessionId: string | null; busy: boolean; cancelKey: string | null; activeSourceUserSeq?: number | null;
  messages: readonly Pick<ChatMessage, 'idempotencyKey' | 'acceptedSource'>[];
}): boolean {
  if (current.sessionId !== owner.sessionId) return false;
  if (current.busy && (owner.key ? current.cancelKey !== owner.key : current.activeSourceUserSeq !== owner.sourceUserSeq)) return false;
  const owned = owner.sourceUserSeq ?? (owner.key
    ? current.messages.find(message => message.idempotencyKey === owner.key
      && message.acceptedSource?.sessionId === owner.sessionId)?.acceptedSource?.sourceUserSeq : undefined);
  const latest = current.messages.reduce((seq, message) => message.acceptedSource?.sessionId === owner.sessionId
    ? Math.max(seq, message.acceptedSource.sourceUserSeq) : seq, 0);
  return latest <= (owned ?? owner.acceptedSeqAtStop);
}

/** A keyless phone follows one accepted source, never whichever attempt
 * happens to be active later in the reusable conversation. */
export function sourceBoundChatControl(value: unknown, sessionId: string, sourceUserSeq: number): ObservedChatRunControl | null {
  const row = value as Partial<ObservedChatRunControl> | null;
  if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0 || !row
    || row.sessionId !== sessionId || row.sourceUserSeq !== sourceUserSeq
    || typeof row.attemptId !== 'string' || !row.attemptId.trim()) return null;
  return { sessionId, sourceUserSeq, attemptId: row.attemptId };
}

export async function stopObservedChatTurn(input: {
  sessionId: string;
  sourceUserSeq: number | null;
  stillCurrent(): boolean;
  readControl(sessionId: string, sourceUserSeq: number): Promise<{ activeRun?: unknown }>;
  cancelExact(sessionId: string, attemptId: string): Promise<{ ok: boolean }>;
}): Promise<boolean> {
  if (!input.stillCurrent()) return false;
  if (!Number.isSafeInteger(input.sourceUserSeq) || Number(input.sourceUserSeq) <= 0) {
    throw new Error('Could not confirm this run’s live controls. Refresh the conversation before trying Stop again.');
  }
  let response: { activeRun?: unknown };
  try { response = await input.readControl(input.sessionId, input.sourceUserSeq!); }
  catch {
    if (!input.stillCurrent()) return false;
    throw new Error('Could not confirm this run’s live controls. Refresh the conversation before trying Stop again.');
  }
  if (!input.stillCurrent()) return false;
  const control = sourceBoundChatControl(response.activeRun, input.sessionId, input.sourceUserSeq!);
  if (!control) throw new Error('This run’s live controls changed. Stop was not confirmed; refresh the conversation before trying again.');
  try {
    const result = await input.cancelExact(control.sessionId, control.attemptId);
    if (!result.ok) throw new Error('Cancellation was not confirmed.');
  } catch {
    if (!input.stillCurrent()) return false;
    throw new Error('Stop was not confirmed for this run. Refresh the conversation before trying again.');
  }
  return true;
}
