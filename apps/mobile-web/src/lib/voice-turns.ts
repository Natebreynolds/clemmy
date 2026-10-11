/**
 * Voice mode's reading of the conversation: what Clem said that has not been
 * heard yet, and whether the spoken turn is still running. Pure; voice-mode.ts
 * owns the microphone and the speaker.
 * Kept portable from console-web/lib/voice-turns.ts for mobile parity.
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

export interface VoiceUtterance {
  key: string;
  text: string;
  messageId: string;
  sourceText: string;
  status?: string;
  kind: 'tool-intent' | 'progress' | 'first' | 'answer';
  draftId?: string;
}

const readableText = (message: VoiceChatMessage) => message.text?.trim() || message.approval?.preview?.ask?.trim() || '';

/** Queued or playing speech remains bound to the exact message that permitted
 * it. A withdrawn/replaced answer or tool intent is no longer speakable. */
export function voiceUtteranceCurrent(utterance: VoiceUtterance, messages: readonly VoiceChatMessage[]): boolean {
  const message = messages.find(message => message.id === utterance.messageId);
  if (!message || message.role !== 'assistant' || readableText(message) !== utterance.sourceText || message.status !== utterance.status) return false;
  if (utterance.kind === 'tool-intent') {
    const draft = message.answerDraft;
    return Boolean(draft && draft.id === utterance.draftId && draft.phase === 'withdrawn' && draft.withdrawn === 'tool_call');
  }
  if (message.answerDraft) return false;
  if (utterance.kind === 'progress') return Boolean(message.checkIn);
  if (message.checkIn) return false;
  return utterance.kind === 'first' ? message.status === 'thinking' : Boolean(message.status && FINISHED_STATUSES.has(message.status));
}

/** Read delivered replies and canonical progress. Completion-answer drafts,
 * including complete sentences and checking drafts, wait for terminal delivery
 * to replace answerDraft. Review may still retract any provisional wording. */
export function voiceUtterances(
  messages: readonly VoiceChatMessage[],
  heard: Map<string, string>,
  baseline: ReadonlySet<string>,
): VoiceUtterance[] {
  const out: VoiceUtterance[] = [];
  const said = new Set([...heard.values()].map((value) => value.trim()));
  const utterance = (message: VoiceChatMessage, key: string, text: string, kind: VoiceUtterance['kind']): VoiceUtterance => ({
    key, text, messageId: message.id, sourceText: readableText(message), status: message.status, kind,
    ...(kind === 'tool-intent' ? { draftId: message.answerDraft!.id } : {}),
  });
  const say = (message: VoiceChatMessage, key: string, text: string, kind: VoiceUtterance['kind']): void => {
    const words = text.trim();
    if (!words || heard.has(key) || said.has(words)) return;
    said.add(words);
    out.push(utterance(message, key, text, kind));
  };
  for (const message of messages) {
    if (message.role !== 'assistant' || baseline.has(message.id)) continue;
    const draft = message.answerDraft;
    if (draft) {
      // Explicit tool-call withdrawal is the engine's progress projection,
      // distinct from a provisional completion answer awaiting review.
      if (draft.phase !== 'withdrawn' || draft.withdrawn !== 'tool_call') continue;
      const before = draftSaid(heard, message.id);
      const sofar = before.draftId === draft.id ? before.said : '';
      if (sofar.length >= SPOKEN_PER_MESSAGE_MAX) continue;
      const part = nextSpokenPart(message.text, sofar, true);
      if (part.trim()) {
        out.push(utterance(message, `${message.id}:draft:${draft.id}:part:${partCount(heard, message.id, draft.id)}`, part, 'tool-intent'));
        said.add(part.trim());
      }
      continue;
    }
    const text = readableText(message);
    if (!text) continue;
    if (message.checkIn) {
      say(message, `${message.id}:progress`, text, 'progress');
    } else if (message.status === 'thinking') {
      say(message, `${message.id}:first`, text, 'first');
    } else if (message.status && FINISHED_STATUSES.has(message.status)) {
      const { said: read } = draftSaid(heard, message.id);
      const rest = read && message.text.startsWith(read) ? message.text.slice(read.length) : text;
      if (read.length < SPOKEN_PER_MESSAGE_MAX) say(message, `${message.id}:answer`, rest, 'answer');
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
