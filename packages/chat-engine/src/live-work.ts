import type { ActivityItem, ChatMessage } from './types.js';
import { MODEL_PHASE_ACTIVITY_ID } from './reduce-activity.js';
import { friendlyStep } from './tool-labels.js';

/**
 * How a working turn reads, shared by desktop and phone so the two surfaces
 * tell one story: Clem's own sentence about what she is doing, one clock, the
 * step in hand, and once done one receipt line.
 */

/** The longest line that reads as what she is doing rather than an answer. */
export const LIVE_WORDS_MAX = 280;

/** Text a person would not write: a draft that is the tool call itself
 *  (`{"requirement_id": …}`), an array of rows, or a quoted JSON string.
 *  It is never shown as her words or as an answer in progress. */
export function looksLikeMachineText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^[{[]/.test(t)) return true;
  if (/^"[^"]*"\s*:/.test(t)) return true;
  // A sentence that leads into a call and then pastes it: mostly braces and
  // quoted keys rather than words.
  const keys = t.match(/"[A-Za-z_][\w-]*"\s*:/g)?.length ?? 0;
  return keys >= 2 && /[{}]/.test(t);
}

export interface LiveTurnText {
  /** Her words about the work, for the line at the top of the work line. */
  words: string;
  /** Whether the message text stands as the answer (in progress or final). */
  showReply: boolean;
}

/**
 * While she works, the sentence she wrote before a tool ran (a draft set aside
 * for the tool call) and her first words are what she is DOING, so they lead
 * the work line instead of sitting in the answer's place. A plain stream
 * without a draft identity is an answer, not a sentence: only a short line
 * counts as her words about the work. A draft set aside for a tool call is
 * never shown as an answer, and machine text is never shown at all.
 */
export function liveTurnText(message: Pick<ChatMessage, 'text' | 'answerDraft' | 'approval'>, live: boolean): LiveTurnText {
  const text = (message.text ?? '').trim();
  if (!text) return { words: '', showReply: false };
  const toolCallDraft = message.answerDraft?.phase === 'withdrawn' && message.answerDraft.withdrawn === 'tool_call';
  const machine = looksLikeMachineText(text);
  if (live && toolCallDraft) {
    return { words: !machine && text.length <= LIVE_WORDS_MAX ? text : '', showReply: false };
  }
  if (live && !message.answerDraft && !message.approval) {
    if (machine) return { words: '', showReply: false };
    if (text.length <= LIVE_WORDS_MAX) return { words: text, showReply: false };
  }
  return { words: '', showReply: !(live && machine) };
}

/** The step a working turn's card holds: one in the owner's apps or one that
 *  changes something, while it runs or as the last one done. Looking up memory
 *  or finding a tool is how she gets there, not what she is doing, so it takes
 *  the card only when nothing else has. */
export function stepInHand(rows: readonly ActivityItem[]): ActivityItem | undefined {
  const tools = rows.filter((row) => row.kind !== 'check' && row.id !== MODEL_PHASE_ACTIVITY_ID);
  const matters = (row: ActivityItem) => Boolean(friendlyStep(row.label).app)
    || row.effect === 'local_write' || row.effect === 'external_write' || row.kind === 'agent';
  const latest = [...tools].reverse();
  return latest.find((row) => row.status === 'running' && matters(row))
    ?? latest.find(matters)
    ?? latest.find((row) => row.status === 'running')
    ?? latest[0];
}

/** The turn's own span: from when she started thinking (the model row's
 *  start) to the last thing that settled, so the clock and "Worked" count the
 *  whole turn, not just its tool steps. */
export function turnSpan(items: readonly ActivityItem[]): { startedAt?: number; totalMs?: number } {
  const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
  const starts = items.map((item) => item.startedAt).filter(finite);
  const startedAt = starts.length > 0 ? Math.min(...starts) : undefined;
  const ends = items.map((item) => item.finishedAt).filter(finite);
  const totalMs = startedAt !== undefined && ends.length > 0 ? Math.max(0, Math.max(...ends) - startedAt) : undefined;
  return { startedAt, totalMs };
}

/** "1:07": the one clock a working turn shows. */
export function workClock(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return '';
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "58s" / "1m 12s": how long she worked, in words rather than a stopwatch. */
export function workedFor(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export type WorkOutcome = 'completed' | 'failed' | 'interrupted' | 'waiting';

/** The folded line's words ("Worked 18s · read calendar view · created
 *  draft"). The outcome leads when it is not a success, so a stopped turn never
 *  reads like a finished one; one or two steps are named instead of counted. */
export function workReceiptLine(
  outcome: WorkOutcome,
  totalMs: number | undefined,
  steps: readonly ActivityItem[],
): string {
  const worked = workedFor(totalMs);
  const highlights = [...new Set(steps.map((row) => friendlyStep(row.label).done)
    .map((done) => done.charAt(0).toLowerCase() + done.slice(1)))];
  const named = highlights.length > 0 && highlights.length <= 2 && highlights.length === steps.length;
  return [
    outcome === 'failed' ? 'Ran into trouble' : outcome === 'interrupted' ? 'Didn’t finish' : outcome === 'waiting' ? 'Waiting for you' : '',
    worked ? (outcome === 'completed' ? `Worked ${worked}` : `worked ${worked}`) : (outcome === 'completed' ? 'Worked through it' : ''),
    ...(named ? highlights : [steps.length > 0 ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : '']),
  ].filter(Boolean).join(' · ');
}

/** The apps a turn worked in, for the receipt's marks. */
export function workApps(steps: readonly ActivityItem[], limit = 3): string[] {
  return [...new Set(steps.map((row) => friendlyStep(row.label).app)
    .filter((app): app is string => Boolean(app)))].slice(0, limit);
}
