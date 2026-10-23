import { proactiveReplySettled, type HeartbeatPresentation } from '@clem/chat-engine';
/** From Clem on Home: what the heartbeats brought the owner, as one stream
 *  (server: src/dashboard/from-clem.ts). */
import { apiGet, apiPost } from './api';
import { usePoll } from './poll';

export interface FromClemRow {
  key: string;
  heartbeat: string;
  heartbeatTitle: string;
  at: string;
  asks: boolean;
  /** Clem's own words about it, once she has written them. */
  say?: string;
  /** Short answers she offers for an item waiting on the owner. */
  choices?: string[];
  text: string;
  detail?: string;
  voiceDigest: string;
  answer?: { kind: 'words'; questionId: string } | { kind: 'yes_no'; planProposalId: string } | { kind: 'brain_outage'; outageId: string };
  done?: { notificationId: string };
  /** A part of Clementine Clem offers to help set up, and where it lives. */
  setup?: { ability: string; place: string; placeName: string };
  /** The workflow run whose report this is. */
  run?: { runId: string; workflow?: string };
  /** A report she already wrote: `say` is the report itself. */
  authored?: boolean;
  handoff?: {state:'not_started'|'dispatched'|'needs_attention'|'settled';sessionId?:string;reason?:string};
}

/** Where a report's run opens, when its workflow is known. */
export function fromClemRunHref(row: Pick<FromClemRow, 'run'>): string | null {
  const run = row.run;
  if (!run?.runId || !run.workflow) return null;
  return `/automate?workflow=${encodeURIComponent(run.workflow)}&run=${encodeURIComponent(run.runId)}`;
}

export interface FromClemPulse {
  heartbeat: string;
  title: string;
  enabled: boolean | null;
  availability?: 'available'|'unavailable';
  presentation?: HeartbeatPresentation;
  lastAt?: string;
  summary?: string;
}

export interface FromClem {
  rows: FromClemRow[];
  pulses: FromClemPulse[];
  covers: { questionIds: string[]; planProposalIds: string[]; notificationIds: string[] };
}

export const getFromClem = () => apiGet<FromClem>('/api/console/home/from-clem');

export type FromClemReplyOutcome =
  | { outcome: 'gone' }
  | { outcome: 'changed' }
  | { outcome: 'unclear' }
  | { outcome: 'started'; sessionId: string; runId: string }
  | { outcome: 'approved' | 'declined' | 'cleared' | 'later' | 'rule_added' }
  | { outcome: 'answered'; questionId: string };

/** The owner's reply to one row, in their own words. One reply, one id: a
 *  retried send is the same answer, and the version the owner saw goes with
 *  it, so a changed item is shown again rather than acted on. */
export const replyFromClem = (key: string, text: string, voiceDigest?: string, decision?: 'do_it' | 'done' | 'not_now' | 'never', choiceIndex?: number) =>
  apiPost<FromClemReplyOutcome>('/api/console/home/from-clem/reply', {
    key, text, requestId: newReplyId(), ...(voiceDigest ? { voiceDigest } : {}), ...(decision ? { decision } : {}),
    // A tapped choice says which one: the host checks it against the choices
    // it showed, and the tap is the owner's approval of that action.
    ...(typeof choiceIndex === 'number' ? { choiceIndex } : {}),
  });

function newReplyId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? random.replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** What the reply did, said plainly. Clem's own reaction comes from her, in the conversation. */
export function replyOutcomeText(outcome: FromClemReplyOutcome, heartbeatTitle: string): string {
  switch (outcome.outcome) {
    case 'answered': return 'Sent.';
    case 'started': return 'Started a conversation.';
    case 'approved': return 'Approved.';
    case 'declined': return 'Declined.';
    case 'cleared': return 'Cleared.';
    case 'later': return 'Back tomorrow morning.';
    case 'rule_added': return `Saved as a rule for ${heartbeatTitle}.`;
    case 'unclear': return 'That didn’t settle it. Try “do it”, “not now” or “never”, or say what you want.';
    case 'changed': return 'This changed while you were replying. Have another look.';
    default: return 'Already handled.';
  }
}
/** Inline feedback uses the same receipt meanings as Home. */
export function replyOutcomeNotice(outcome: FromClemReplyOutcome, sourceName: string): { tone: 'success' | 'error' | 'info'; text: string } {
  return { tone: outcome.outcome === 'changed' || outcome.outcome === 'gone' ? 'error'
    : proactiveReplySettled(outcome.outcome) ? 'success' : 'info', text: replyOutcomeText(outcome, sourceName) };
}
export const useFromClem = (enabled = true) => usePoll(['home-from-clem'], getFromClem, 20_000, { enabled });

/** What came of a "do it" given on one of Clem's items. */
export type FromClemTurnOutcome =
  | { state: 'working' }
  | { state: 'not_found' }
  | { state: 'done' | 'needs_you' | 'stopped'; text: string; sessionId: string };

export const getFromClemOutcome = (runId: string, since: string) =>
  apiGet<FromClemTurnOutcome>(`/api/console/home/from-clem/outcome?runId=${encodeURIComponent(runId)}&since=${encodeURIComponent(since)}`);

/** How an outcome reads beside the item it came from. */
export function tapOutcomeHeadline(outcome: FromClemTurnOutcome | undefined): { tone: 'info' | 'success' | 'warning' | 'error'; text: string } {
  switch (outcome?.state) {
    case 'done': return { tone: 'success', text: 'Done' };
    case 'needs_you': return { tone: 'warning', text: 'Clem needs one more thing' };
    case 'stopped': return { tone: 'error', text: 'This didn’t finish' };
    case 'not_found': return { tone: 'error', text: 'Couldn’t confirm this turn — check the conversation before trying again' };
    default: return { tone: 'info', text: 'Clem is working on it…' };
  }
}

/** Home's other lists, without what From Clem already shows. */
export function withoutFromClem<T extends { questionId?: string; planProposalId?: string; notifId?: string }>(
  items: readonly T[],
  covers: FromClem['covers'] | undefined,
): T[] {
  if (!covers) return [...items];
  const questions = new Set(covers.questionIds);
  const plans = new Set(covers.planProposalIds);
  const notifications = new Set(covers.notificationIds);
  return items.filter((item) => !(item.questionId && questions.has(item.questionId))
    && !(item.planProposalId && plans.has(item.planProposalId))
    && !(item.notifId && notifications.has(item.notifId)));
}

/** The heartbeats Clem runs that have looked at anything, newest look first. */
export function recentPulses(pulses: readonly FromClemPulse[]): FromClemPulse[] {
  return pulses.filter((pulse) => pulse.enabled !== false && (pulse.lastAt || pulse.availability === 'unavailable' || pulse.presentation))
    .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}
