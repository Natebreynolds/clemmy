/**
 * Voice mode's reading of the conversation: what Clem said that has not been
 * heard yet, and whether the spoken turn is still running. Pure; voice-mode.ts
 * owns the microphone and the speaker.
 */

/** The parts of a chat message voice mode reads. */
export interface VoiceChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: string;
  answerDraft?: unknown;
  checkIn?: unknown;
  approval?: { preview?: { ask?: string } };
}

export const FINISHED_STATUSES = new Set(['complete', 'awaiting-reply', 'awaiting-approval', 'awaiting-plan', 'failed']);

/** What Clem said that has not been read aloud yet, in order. A message the
 *  owner saw before voice mode started is never read; a live draft is not
 *  read until it is the answer; a stop the owner pressed is not read back. */
export function voiceUtterances(
  messages: readonly VoiceChatMessage[],
  heard: Map<string, string>,
  baseline: ReadonlySet<string>,
): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || baseline.has(message.id) || message.checkIn || message.answerDraft) continue;
    const text = (message.text?.trim() || message.approval?.preview?.ask?.trim() || '');
    if (!text) continue;
    if (message.status === 'thinking') {
      const key = `${message.id}:first`;
      if (!heard.has(key)) out.push({ key, text });
    } else if (message.status && FINISHED_STATUSES.has(message.status)) {
      const key = `${message.id}:answer`;
      if (!heard.has(key) && heard.get(`${message.id}:first`) !== text) out.push({ key, text });
    }
  }
  return out;
}

/** True while Clem's reply to the last spoken turn is still being worked on. */
export function voiceTurnRunning(messages: readonly VoiceChatMessage[]): boolean {
  const last = [...messages].reverse().find((message) => message.role === 'assistant' && !message.checkIn);
  return last?.status === 'thinking';
}

/** The spoken turn sent when the conversation had `from` messages has ended:
 *  Clem has answered after it and is no longer working. */
export function voiceTurnEnded(messages: readonly VoiceChatMessage[], from: number): boolean {
  if (voiceTurnRunning(messages)) return false;
  return messages.slice(from).some((message) => message.role === 'assistant' && !message.checkIn
    && Boolean(message.status && FINISHED_STATUSES.has(message.status)));
}

/** Where a newly shown conversation's "already seen" line sits: everything
 *  on screen, or, while a spoken turn is in flight, everything up to the
 *  owner's last message, so her answer to it is still read. */
export function voiceBaseline(messages: readonly VoiceChatMessage[], awaitingTurn: boolean): { seen: Set<string>; turnFrom: number } {
  if (!awaitingTurn) return { seen: new Set(messages.map((message) => message.id)), turnFrom: messages.length };
  const lastOwner = messages.map((message) => message.role === 'user').lastIndexOf(true);
  return { seen: new Set(messages.slice(0, lastOwner + 1).map((message) => message.id)), turnFrom: lastOwner + 1 };
}
