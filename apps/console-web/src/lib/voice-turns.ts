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
  answerDraft?: { id: string; phase?: string; withdrawn?: string };
  checkIn?: unknown;
  approval?: { preview?: { ask?: string } };
}

export const FINISHED_STATUSES = new Set(['complete', 'awaiting-reply', 'awaiting-approval', 'awaiting-plan', 'failed']);

/** What Clem said that has not been read aloud yet, in order: what she says
 *  she is about to do before her tools run (a draft set aside for a tool
 *  call), her progress notes, her first words while she works, and her
 *  answer, a question or a card's ask. A message the owner saw before voice
 *  mode started is never read; a draft still being written or sent back by
 *  review is not read; a stop the owner pressed is not read back; the same
 *  words are never said twice in a row. */
export function voiceUtterances(
  messages: readonly VoiceChatMessage[],
  heard: Map<string, string>,
  baseline: ReadonlySet<string>,
): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  const said = new Set(heard.values());
  const say = (key: string, text: string): void => {
    if (heard.has(key) || said.has(text)) return;
    said.add(text);
    out.push({ key, text });
  };
  for (const message of messages) {
    if (message.role !== 'assistant' || baseline.has(message.id)) continue;
    const draft = message.answerDraft;
    if (draft) {
      if (draft.phase === 'withdrawn' && draft.withdrawn === 'tool_call' && message.text.trim()) {
        say(`${message.id}:before-tools:${draft.id}`, message.text.trim());
      }
      continue;
    }
    const text = (message.text?.trim() || message.approval?.preview?.ask?.trim() || '');
    if (!text) continue;
    if (message.checkIn) {
      say(`${message.id}:progress`, text);
    } else if (message.status === 'thinking') {
      say(`${message.id}:first`, text);
    } else if (message.status && FINISHED_STATUSES.has(message.status)) {
      say(`${message.id}:answer`, text);
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

/** What the owner said, without the transcriber's own markup for sounds that
 *  are not words: "[SOUND]", "(upbeat music)", "*chuckles*". Empty when that
 *  markup is all there was, so background noise never becomes a message. */
export function spokenWords(transcript: string): string {
  const words = (transcript ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(words) ? words : '';
}
