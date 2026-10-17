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
import type { HeartbeatPresentation, HeartbeatUnavailable } from '../agents/heartbeats.js';
import { isWorkflowReport } from '../runtime/notification-intent.js';

/** notify_user's own limit on what a report says. */
export const REPORT_MAX_CHARS = 2_000;
/** A report older than this stays in the inbox: news, not a backlog. */
export const REPORT_FRESH_MS = 3 * 24 * 60 * 60 * 1000;

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
  /** Short answers she offers for an item waiting on the owner. */
  choices?: string[];
  /** The record's own words: what the heartbeat wrote. */
  text: string;
  detail?: string;
  /** Changes whenever what she would be speaking about changes. */
  voiceDigest: string;
  /** How the owner answers, through the route that already settles it. */
  answer?: { kind: 'words'; questionId: string } | { kind: 'yes_no'; planProposalId: string }
    /** The chosen brain answers again after an outage: yes switches back, no
     *  keeps the backup as the brain. */
    | { kind: 'brain_outage'; outageId: string };
  /** Marks a finding seen; its heartbeat counts it acknowledged. */
  done?: { notificationId: string };
  /** A part of Clementine Clem offers to help set up, and where it lives. */
  setup?: { ability: string; place: string; placeName: string };
  /** The workflow run whose report this is. */
  run?: { runId: string; workflow?: string };
  /** Words Clem already wrote for the owner (a report); said as they are. */
  authored?: boolean;
  /** Progress of an already-answered proposal. This never reopens its old
   * question or authorizes a retry; the retained chat owns the work. */
  handoff?: { state: 'not_started' | 'dispatched' | 'needs_attention' | 'settled'; sessionId?: string; reason?: string };
  /** Identifiers the item is about (a calendar event, an account), from the
   * record's own metadata: what a tapped choice acts on. */
  ref?: Record<string, string>;
}

/** The identifiers a notification is about, from the metadata its heartbeat wrote. */
function refOf(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const ref: Record<string, string> = {};
  for (const key of ['eventId', 'connectionId', 'accountId', 'provider', 'itemKey']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) ref[key] = value.trim().slice(0, 400);
  }
  return Object.keys(ref).length > 0 ? ref : undefined;
}

export interface FromClemPulse {
  heartbeat: string;
  title: string;
  enabled: boolean | null;
  lastAt?: string;
  summary?: string;
  availability?: 'available' | 'unavailable';
  presentation?: HeartbeatPresentation;
}

export interface FromClem {
  rows: FromClemRow[];
  pulses: FromClemPulse[];
  /** What Home's other lists should leave out, so nothing shows twice. */
  covers: { questionIds: string[]; planProposalIds: string[]; notificationIds: string[] };
}

export interface FromClemInput {
  heartbeats: ReadonlyArray<{ id: string; title: string; enabled: boolean; presentation?: HeartbeatPresentation;
    lastFinding?: { at: string; summary: string; failed?: boolean } }>;
  unavailableHeartbeats?: readonly HeartbeatUnavailable[];
  noticingProposals: ReadonlyArray<{ id: string; title: string; why?: string; action?: string; status: string; createdAt: string; checkInId?: string; notificationId?: string;
    handoff?: { state: 'not_started' | 'dispatched' | 'needs_attention' | 'settled'; updatedAt: string; sessionId?: string; reason?: string } }>;
  notifications: readonly NotificationRecord[];
  planProposals: ReadonlyArray<{ id: string; proposedAt: string; proposedByAgent: string; status: string; title: string; context?: string }>;
  /** Heartbeat items that are still waiting on the owner (the Needs you rule). */
  asksOwner: (notification: NotificationRecord) => boolean;
  /** Clem's words already written for this row, if any. */
  voiced?: (key: string, voiceDigest: string) => { message: string; choices?: string[] } | undefined;
  /** Rows the owner moved to later: hidden until then, still covered, so they
   *  do not reappear in Home's other lists meanwhile. */
  later?: (key: string) => boolean;
  /** Now, for what still counts as news. */
  now?: number;
  /** The one part Clem offers to help set up next, if any. */
  setup?: {
    ability: string; name: string; unlocks: string; detail: string;
    state: 'not_set_up' | 'needs_attention'; place: string; placeName: string; since: string;
  } | null;
}

/** Bumped when what she is asked to say changes, so every item is said again. */
const VOICE_RUBRIC = 3;

type VoicedItem = Pick<FromClemRow, 'heartbeat' | 'text' | 'detail' | 'asks' | 'at' | 'handoff'>;

function itemDigestFields(row: VoicedItem): unknown[] {
  const fields: unknown[] = [row.heartbeat, row.text, row.detail ?? '', row.asks, row.at];
  if (row.handoff) fields.push(row.handoff);
  return fields;
}

/** The item itself: posted to her thread once per item, however often it is
 *  said again in new words. */
export function fromClemItemDigest(row: VoicedItem): string {
  return createHash('sha256').update(JSON.stringify(itemDigestFields(row))).digest('hex').slice(0, 24);
}

/** What she would be speaking about: a changed item is said again. */
export function fromClemVoiceDigest(row: VoicedItem, rubric = VOICE_RUBRIC): string {
  return createHash('sha256').update(JSON.stringify([rubric, ...itemDigestFields(row)])).digest('hex').slice(0, 24);
}

/** Whether words written under an earlier rubric were about this same item. */
export function fromClemSaidUnderEarlierRubric(row: VoicedItem, digest: string): boolean {
  for (let rubric = 1; rubric < VOICE_RUBRIC; rubric += 1) {
    if (fromClemVoiceDigest(row, rubric) === digest) return true;
  }
  return false;
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
    const handoff = proposal.handoff;
    if (proposal.status === 'answered' && handoff && handoff.state !== 'settled') {
      const detail = [proposal.why, handoff.reason].filter(Boolean).join('\n');
      rows.push({
        key: `noticing:${proposal.id}`, heartbeat: 'noticing', heartbeatTitle: title('noticing'),
        at: handoff.updatedAt, asks: false, text: proposal.title,
        ...(detail ? { detail } : {}),
        handoff: { state: handoff.state,
          ...(handoff.sessionId ? { sessionId: handoff.sessionId } : {}),
          ...(handoff.reason ? { reason: handoff.reason } : {}) },
      });
      if (proposal.checkInId) covers.questionIds.push(`checkin:${proposal.checkInId}`);
      if (proposal.notificationId) covers.notificationIds.push(proposal.notificationId);
      continue;
    }
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
    // A report a workflow run sent the owner with no chat of its own to report
    // into (a silent one went to its chat): her words, posted as written.
    if (isWorkflowReport(notification.metadata)) {
      if (notification.silent || !notification.body.trim()
        || !(Date.parse(notification.createdAt) >= (input.now ?? Date.now()) - REPORT_FRESH_MS)) continue;
      const meta = notification.metadata ?? {};
      const workflow = str(meta.workflow).trim();
      rows.push({
        key: `notif:${notification.id}`, heartbeat: 'workflow', heartbeatTitle: workflow || 'Workflow',
        at: notification.createdAt, asks: false, text: notification.title,
        say: notification.body.trim().slice(0, REPORT_MAX_CHARS), authored: true,
        done: { notificationId: notification.id },
        run: { runId: str(meta.workflowRunId), ...(workflow ? { workflow } : {}) },
      });
      covers.notificationIds.push(notification.id);
      continue;
    }
    const heartbeat = heartbeatOf(notification);
    if (!heartbeat) continue;
    const ref = refOf(notification.metadata as Record<string, unknown> | undefined);
    const meta = notification.metadata ?? {};
    const asks = input.asksOwner(notification);
    const outageId = str(meta.brainOutageId).trim();
    rows.push({
      key: `notif:${notification.id}`, heartbeat,
      heartbeatTitle: titleOf.get(heartbeat) ?? (str(meta.sourceTitle).trim() || heartbeat),
      at: notification.createdAt, asks, text: notification.title,
      ...(notification.body.trim() ? { detail: notification.body.trim() } : {}),
      done: { notificationId: notification.id },
      ...(asks && outageId ? { answer: { kind: 'brain_outage' as const, outageId } } : {}),
      ...(ref ? { ref } : {}),
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

  if (input.setup) {
    const setup = input.setup;
    rows.push({
      key: `setup:${setup.ability}`, heartbeat: 'setup', heartbeatTitle: 'Set up next',
      at: setup.since, asks: false,
      text: setup.state === 'needs_attention' ? `${setup.name} needs attention` : `${setup.name} is not set up yet`,
      detail: `${setup.detail} It gives you: ${setup.unlocks}. Set it up in ${setup.placeName}.`,
      setup: { ability: setup.ability, place: setup.place, placeName: setup.placeName },
    });
  }

  // What waits on the owner comes first, newest first within it; then what
  // she is only telling them, newest first; then what she offers to set up.
  rows.sort((a, b) => Number(Boolean(a.setup)) - Number(Boolean(b.setup))
    || Number(b.asks) - Number(a.asks) || b.at.localeCompare(a.at));
  const voicedRows: FromClemRow[] = rows.map((row) => {
    const voiceDigest = fromClemVoiceDigest(row);
    // Progress is shown from its retained state, never as another voiced
    // proposal that might invite the owner to authorize the same work again.
    const said = row.handoff ? undefined : input.voiced?.(row.key, voiceDigest);
    return { ...row, voiceDigest,
      ...(said && !row.authored ? { say: said.message } : {}),
      // A brain-outage ask keeps its yes/no: two outcomes the host carries
      // out exactly, never read back from her wording.
      ...(said?.choices?.length && row.asks && row.answer?.kind !== 'brain_outage' ? { choices: said.choices } : {}) };
  });
  // Attempt time and coverage remain distinct. A failed or partial read is
  // not promoted to a successful "look", and raw failure text stays on the
  // heartbeat's own page. Older callers without presentation retain their
  // explicit failed flag rather than inferring it from summary prose.
  const pulses = input.heartbeats.map((row) => ({
    heartbeat: row.id, title: row.title, enabled: row.enabled,
    ...(row.presentation ? { availability: 'available' as const, presentation: row.presentation } : {}),
    ...(row.presentation ? row.presentation.lastCheck.at ? { lastAt: row.presentation.lastCheck.at } : {}
      : row.lastFinding ? { lastAt: row.lastFinding.at } : {}),
    ...(row.lastFinding && !row.lastFinding.failed
      && (!row.presentation || row.presentation.lastCheck.state === 'recorded') ? { summary: row.lastFinding.summary } : {}),
  }));
  const unavailable: FromClemPulse[] = (input.unavailableHeartbeats ?? []).map(row => ({
    heartbeat: row.id, title: row.title, enabled: null, availability: 'unavailable',
  }));
  return { rows: input.later ? voicedRows.filter((row) => !input.later!(row.key)) : voicedRows, pulses: [...pulses, ...unavailable], covers };
}
