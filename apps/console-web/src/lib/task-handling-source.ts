/** A reply may explain only the accepted request it actually belongs to.
 * Client timestamps, a session's latest turn and message ids are not owners. */
export function taskHandlingSource(message: {
  role: 'user' | 'assistant';
  status?: string;
  checkIn?: boolean;
  acceptedSource?: { sessionId: string; sourceUserSeq: number; turn: number };
}, conversationSessionId?: string, retainedHistorySources?: ReadonlySet<string>): { sessionId: string; sourceUserSeq: number } | null {
  if (message.role !== 'assistant' || message.checkIn
    || !['complete', 'failed', 'stopped'].includes(message.status ?? '')) return null;
  const source = message.acceptedSource;
  if (!source || !source.sessionId?.trim() || !Number.isSafeInteger(source.sourceUserSeq)
    || source.sourceUserSeq <= 0 || !Number.isSafeInteger(source.turn) || source.turn < 0) return null;
  // A merged history can contain validated ancestor execution sessions. Only
  // the exact server-retained source triple may cross the current-head guard.
  // The normal live path supplies no allowlist and remains session-bound.
  if (conversationSessionId && source.sessionId !== conversationSessionId
    && !retainedHistorySources?.has(JSON.stringify([source.sessionId, source.sourceUserSeq, source.turn]))) return null;
  return { sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq };
}
