import type { ChatMessage, HarnessEvent } from './types.js';

type AcceptedSource = NonNullable<ChatMessage['acceptedSource']>;

/** Only a real accepted input establishes a check-in's placement. */
export function acceptedConversationSource(event: HarnessEvent, sessionId?: string | null): AcceptedSource | undefined {
  const session = event.sessionId ?? sessionId;
  if (event.type !== 'user_input_received' || event.data?.synthetic === true
    || (event.role !== undefined && event.role !== 'user')
    || !session || (sessionId && session !== sessionId)
    || !Number.isSafeInteger(event.seq) || event.seq <= 0
    || !Number.isSafeInteger(event.turn) || event.turn! < 0) return undefined;
  return { sessionId: session, sourceUserSeq: event.seq, turn: event.turn! };
}

function sameSource(a: AcceptedSource | undefined, b: AcceptedSource): boolean {
  return a?.sessionId === b.sessionId && a.sourceUserSeq === b.sourceUserSeq && a.turn === b.turn;
}

/** Public check-ins do not own turn state. Insert once in the exact source's
 * group, before its answer, including when a newer task is already running. */
export function appendConversationCheckIn(
  messages: ChatMessage[], event: HarnessEvent, sessionId?: string | null,
): ChatMessage[] {
  const d = event.data ?? {};
  const session = event.sessionId ?? sessionId;
  if (event.type !== 'conversation_check_in' || d.version !== 1 || d.kind !== 'check_in'
    || Object.keys(d).some(key => !['version', 'kind', 'sourceUserSeq', 'text'].includes(key))
    || !session || (sessionId && session !== sessionId)
    || (event.role !== undefined && event.role !== 'Clem')
    || !Number.isSafeInteger(d.sourceUserSeq) || Number(d.sourceUserSeq) <= 0
    || !Number.isSafeInteger(event.seq) || event.seq <= Number(d.sourceUserSeq)
    || !Number.isSafeInteger(event.turn) || event.turn! < 0
    || typeof d.text !== 'string' || !d.text.trim() || d.text.length > 600
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(d.text)) return messages;
  const source: AcceptedSource = { sessionId: session, sourceUserSeq: Number(d.sourceUserSeq), turn: event.turn! };
  const sourceIndex = messages.findIndex(message => message.role === 'user' && sameSource(message.acceptedSource, source));
  if (sourceIndex < 0 || messages.some(message => message.checkInSeq === event.seq && message.acceptedSource?.sessionId === session)) return messages;
  // Source identity, not matching prose or the active placeholder, selects
  // the group. Keep distinct notes with identical wording; seq is identity.
  let at = sourceIndex + 1;
  while (at < messages.length && messages[at]?.checkIn && sameSource(messages[at]?.acceptedSource, source)
    && messages[at]!.checkInSeq! < event.seq) at += 1;
  const note: ChatMessage = {
    id: `check-in-${session}-${event.seq}`, role: 'assistant', text: d.text.trim(),
    checkIn: true, checkInSeq: event.seq, acceptedSource: source,
  };
  return [...messages.slice(0, at), note, ...messages.slice(at)];
}
