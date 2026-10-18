/** A reply may explain only the accepted request it actually belongs to.
 * Client timestamps, a session's latest turn and message ids are not owners. */
export function taskHandlingSource(message: {
  role: 'user' | 'assistant';
  status?: string;
  checkIn?: boolean;
  acceptedSource?: { sessionId: string; sourceUserSeq: number; turn: number };
}, conversationSessionId?: string): { sessionId: string; sourceUserSeq: number } | null {
  if (message.role !== 'assistant' || message.checkIn
    || !['complete', 'failed', 'stopped'].includes(message.status ?? '')) return null;
  const source = message.acceptedSource;
  if (!source || !source.sessionId?.trim() || !Number.isSafeInteger(source.sourceUserSeq)
    || source.sourceUserSeq <= 0 || (conversationSessionId && source.sessionId !== conversationSessionId)) return null;
  return { sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq };
}
