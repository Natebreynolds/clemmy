/**
 * From Clem: everything Clem's heartbeats brought to the owner, in one place.
 *
 * Proactive work used to land in four piles — a Noticing proposal as a
 * question in Needs you (and again as its carrier notification), a calendar
 * finding or a work-review item as an unread notification, a workflow
 * suggestion as a plan — so nothing on Home read as Clem speaking. This reads
 * the heartbeats' own records and returns one stream: each row is what a
 * heartbeat said, in its own words, with the one way to answer it that
 * already exists (words for a proposal, yes/no for a suggestion, done for a
 * finding), newest first. A heartbeat with nothing to say still reports its last look, so a
 * quiet Clem is visibly a watching one. Pure: the route supplies the records.
 */
import { createHash } from 'node:crypto';
import type { NotificationRecord } from '../runtime/notifications.js';

export interface FromClemRow {
  /** Stable across polls: the underlying record's own id. */
  key: string;
  heartbeat: string;
  heartbeatTitle: string;
  at: string;
  /** Waiting on the owner's answer (vs. telling them something). */
  asks: boolean;
  /** Clem's own words about it, once she has written them. */
  say?: string;
  /** The record's own words: what the heartbeat wrote. */
  text: string;
  detail?: string;
  /** Changes whenever what she would be speaking about changes. */
  voiceDigest: string;
  /** How the owner answers, through the route that already settles it. */
  answer?: { kind: 'words'; questionId: string } | { kind: 'yes_no'; planProposalId: string };
  /** Marks a finding seen; its heartbeat counts it acknowledged. */
  done?: { notificationId: string };
}

export interface FromClemPulse {
  heartbeat: string;
  title: string;
  enabled: boolean;
  lastAt?: string;
  summary?: string;
}

export interface FromClem {
  rows: FromClemRow[];
  pulses: FromClemPulse[];
  /** What Home's other lists should leave out, so nothing shows twice. */
  covers: { questionIds: string[]; planProposalIds: string[]; notificationIds: string[] };
}

export interface FromClemInput {
  heartbeats: ReadonlyArray<{ id: string; title: string; enabled: boolean; lastFinding?: { at: string; summary: string; failed?: boolean } }>;
  noticingProposals: ReadonlyArray<{ id: string; title: string; why?: string; action?: string; status: string; createdAt: string; checkInId?: string; notificationId?: string }>;
  notifications: readonly NotificationRecord[];
  planProposals: ReadonlyArray<{ id: string; proposedAt: string; proposedByAgent: string; status: string; title: string; context?: string }>;
  /** Heartbeat items that are still waiting on the owner (the Needs you rule). */
  asksOwner: (notification: NotificationRecord) => boolean;
  /** Clem's words already written for this row, if any. */
  voiced?: (key: string, voiceDigest: string) => string | undefined;
}

/** Bumped when what she is asked to say changes, so every item is said again. */
const VOICE_RUBRIC = 2;

/** What she would be speaking about: a changed item is said again. */
export function fromClemVoiceDigest(row: Pick<FromClemRow, 'heartbeat' | 'text' | 'detail' | 'asks' | 'at'>): string {
  return createHash('sha256').update(JSON.stringify([VOICE_RUBRIC, row.heartbeat, row.text, row.detail ?? '', row.asks, row.at])).digest('hex').slice(0, 24);
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The heartbeat a notification came from, by its own metadata. */
function heartbeatOf(notification: NotificationRecord): string | null {
  const meta = notification.metadata ?? {};
  const heartbeat = str(meta.heartbeatId) || str(meta.watch);
  return heartbeat && str(meta.itemKey) ? heartbeat : null;
}

export function buildFromClem(input: FromClemInput): FromClem {
  const titleOf = new Map(input.heartbeats.map((row) => [row.id, row.title]));
  const title = (id: string): string => titleOf.get(id) ?? id;
  const rows: Array<Omit<FromClemRow, 'voiceDigest'>> = [];
  const covers = { questionIds: [] as string[], planProposalIds: [] as string[], notificationIds: [] as string[] };

  for (const proposal of input.noticingProposals) {
    if (proposal.status !== 'open' || !proposal.checkInId) continue;
    const questionId = `checkin:${proposal.checkInId}`;
    rows.push({
      key: `noticing:${proposal.id}`, heartbeat: 'noticing', heartbeatTitle: title('noticing'),
      at: proposal.createdAt, asks: true, text: proposal.title,
      ...(proposal.why || proposal.action
        ? { detail: [proposal.why, proposal.action ? `What I would do: ${proposal.action}` : ''].filter(Boolean).join('\n') }
        : {}),
      answer: { kind: 'words', questionId },
    });
    covers.questionIds.push(questionId);
    if (proposal.notificationId) covers.notificationIds.push(proposal.notificationId);
  }

  for (const notification of input.notifications) {
    if (notification.read) continue;
    const heartbeat = heartbeatOf(notification);
    if (!heartbeat) continue;
    rows.push({
      key: `notif:${notification.id}`, heartbeat, heartbeatTitle: title(heartbeat),
      at: notification.createdAt, asks: input.asksOwner(notification), text: notification.title,
      ...(notification.body.trim() ? { detail: notification.body.trim() } : {}),
      done: { notificationId: notification.id },
    });
    covers.notificationIds.push(notification.id);
  }

  for (const plan of input.planProposals) {
    if (plan.status !== 'pending' || plan.proposedByAgent !== 'workflow-suggestions') continue;
    rows.push({
      key: `plan:${plan.id}`, heartbeat: 'workflow-suggestions', heartbeatTitle: title('workflow-suggestions'),
      at: plan.proposedAt, asks: true, text: plan.title,
      ...(plan.context ? { detail: plan.context } : {}),
      answer: { kind: 'yes_no', planProposalId: plan.id },
    });
    covers.planProposalIds.push(plan.id);
  }

  // A stream: newest first. What waits on the owner says so on its row; a
  // fresh finding is never buried under days-old reminders.
  rows.sort((a, b) => b.at.localeCompare(a.at));
  const voicedRows: FromClemRow[] = rows.map((row) => {
    const voiceDigest = fromClemVoiceDigest(row);
    const say = input.voiced?.(row.key, voiceDigest);
    return { ...row, voiceDigest, ...(say ? { say } : {}) };
  });
  // A check that failed says when it looked, never what went wrong: the
  // reason is the heartbeat's own page's to explain, in its own words. Live
  // 10-02: another owner's home page read "Read failed: calendar read not
  // learned…" and "Could not finish: …" as Clem's latest word.
  const pulses = input.heartbeats.map((row) => ({
    heartbeat: row.id, title: row.title, enabled: row.enabled,
    ...(row.lastFinding ? { lastAt: row.lastFinding.at, ...(row.lastFinding.failed ? {} : { summary: row.lastFinding.summary }) } : {}),
  }));
  return { rows: voicedRows, pulses, covers };
}
