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

/** The most of one message read aloud; the rest stays on screen. */
export const SPOKEN_PER_MESSAGE_MAX = 900;

const SENTENCE_END = /[.!?…]["'”’)\]]*\s+|\n{2,}/g;

/** The words after `said`: up to the last complete sentence while the draft
 *  is still being written, or all of them once it is finished. */
export function nextSpokenPart(text: string, said: string, finished: boolean): string {
  if (!text.startsWith(said)) return '';
  const rest = text.slice(said.length);
  if (finished) return rest;
  let end = -1;
  for (const match of rest.matchAll(SENTENCE_END)) end = (match.index ?? 0) + match[0].length;
  return end > 0 ? rest.slice(0, end) : '';
}

/** What of one message's drafts has already been read, and from which draft. */
function draftSaid(heard: Map<string, string>, messageId: string): { draftId: string | null; said: string } {
  const prefix = `${messageId}:draft:`;
  let draftId: string | null = null;
  const parts = new Map<string, string>();
  for (const [key, text] of heard) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length).split(':part:')[0];
    draftId = id;
    parts.set(id, (parts.get(id) ?? '') + text);
  }
  return { draftId, said: draftId ? parts.get(draftId) ?? '' : '' };
}

function partCount(heard: Map<string, string>, messageId: string, draftId: string): number {
  let count = 0;
  for (const key of heard.keys()) if (key.startsWith(`${messageId}:draft:${draftId}:part:`)) count += 1;
  return count;
}

/** What Clem said that has not been read aloud yet, in order: her answer as
 *  she writes it (each complete sentence as it lands, so the reading starts
 *  with her first sentence), what she says before her tools run, her
 *  progress notes, her first words while she works, a question or a card's
 *  ask, and whatever her finished answer adds to what was already read. A
 *  message the owner saw before voice mode started is never read; a draft
 *  sent back by review stops being read; a stop the owner pressed is not read
 *  back; the same words are never said twice in a row. */
export function voiceUtterances(
  messages: readonly VoiceChatMessage[],
  heard: Map<string, string>,
  baseline: ReadonlySet<string>,
): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  const said = new Set([...heard.values()].map((value) => value.trim()));
  const say = (key: string, text: string): void => {
    const words = text.trim();
    if (!words || heard.has(key) || said.has(words)) return;
    said.add(words);
    out.push({ key, text });
  };
  for (const message of messages) {
    if (message.role !== 'assistant' || baseline.has(message.id)) continue;
    const draft = message.answerDraft;
    if (draft) {
      const forTool = draft.phase === 'withdrawn' && draft.withdrawn === 'tool_call';
      if (draft.phase === 'withdrawn' && !forTool) continue;
      const before = draftSaid(heard, message.id);
      const sofar = before.draftId === draft.id ? before.said : '';
      if (sofar.length >= SPOKEN_PER_MESSAGE_MAX) continue;
      const part = nextSpokenPart(message.text, sofar, forTool || draft.phase === 'checking');
      if (part.trim()) {
        out.push({ key: `${message.id}:draft:${draft.id}:part:${partCount(heard, message.id, draft.id)}`, text: part });
        said.add(part.trim());
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
      // The answer was read while she wrote it: add only what it adds. A
      // reviewed answer that changed is read as itself.
      const { said: read } = draftSaid(heard, message.id);
      const rest = read && message.text.startsWith(read) ? message.text.slice(read.length) : text;
      if (read.length < SPOKEN_PER_MESSAGE_MAX) say(`${message.id}:answer`, rest);
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
