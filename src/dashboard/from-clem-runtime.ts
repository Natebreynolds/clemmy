/**
 * From Clem, live. Reads the heartbeats' records into the stream (the desktop
 * and the phone share this), has Clem put each item in her own words once, and
 * acts on the owner's reply to any of them. What she says also lands in her
 * own pinned conversation, where "do it" runs.
 *
 * Her words are written by the brain the owner chose, one short message per
 * item, and kept against what the item says: a changed item is said again, a
 * gone one is forgotten. Until a message exists the heartbeat's own text is
 * shown. A reply is read by the same brain into a decision; the host then
 * takes the one path that already settles that kind of item.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../tools/shared.js';
import { buildFromClem, fromClemItemDigest, fromClemSaidUnderEarlierRubric, type FromClem, type FromClemRow } from './from-clem.js';
import { needsYouReferents, notificationNeedsYou } from './needs-you.js';
import { peekTurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-port-registry.js';
import { CLEM_REPLY_PURPOSE, CLEM_VOICE_PURPOSE, type ClemReplyResult, type TurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import { appendEvent, getSession, listEvents, updateSession } from '../runtime/harness/eventlog.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { withOwnModelRequestAttribution } from '../runtime/usage-log.js';

const logger = pino({ name: 'clementine.from-clem' });
const VOICE_FILE = path.join(BASE_DIR, 'state', 'from-clem-voice.json');
/** Items the owner moved to later, by row key → when they come back. A file
 *  of its own, so the voice pass rewriting its file never drops one. */
const LATER_FILE = path.join(BASE_DIR, 'state', 'from-clem-later.json');

const FOREVER = '9999-12-31T00:00:00.000Z';

function loadLater(): Record<string, string> {
  try {
    if (!existsSync(LATER_FILE)) return {};
    const raw = JSON.parse(readFileSync(LATER_FILE, 'utf-8')) as { version?: number; until?: Record<string, string> };
    return raw.version === 1 && raw.until && typeof raw.until === 'object' ? raw.until : {};
  } catch {
    return {};
  }
}

/** The next morning at eight, local time: "not now" means it comes back then. */
export function nextMorning(nowMs: number): string {
  const next = new Date(nowMs);
  next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  return next.toISOString();
}

/** Hide one row until the next morning, or for good when the owner said
 *  never. Expired entries are dropped on write. */
export function moveFromClemRowToLater(key: string, nowMs = Date.now(), forever = false): void {
  const until = Object.fromEntries(Object.entries(loadLater()).filter(([, at]) => Date.parse(at) > nowMs));
  until[key] = forever ? FOREVER : nextMorning(nowMs);
  mkdirSync(path.dirname(LATER_FILE), { recursive: true });
  const tmp = `${LATER_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, until }, null, 2));
  renameSync(tmp, LATER_FILE);
}

function laterNow(nowMs = Date.now()): (key: string) => boolean {
  const until = loadLater();
  return (key) => {
    const at = until[key];
    return Boolean(at) && Date.parse(at!) > nowMs;
  };
}
const MAX_VOICES_PER_PASS = 4;
const VOICE_PASS_MS = 60_000;
const FIRST_VOICE_PASS_DELAY_MS = 45_000;
const MAX_KEPT_VOICES = 300;
/** Usage owner for her words: background work, never a chat turn's cost. */
const FROM_CLEM_USAGE_SOURCE = 'background:from-clem';
/** An item whose words could not be written waits before it is asked again. */
const VOICE_RETRY_BASE_MS = 5 * 60_000;
const VOICE_RETRY_MAX_MS = 6 * 60 * 60_000;

// ── her words, kept ───────────────────────────────────────────────────────────
/** `posted` is the digest last posted to her thread, so a message lands there once. */
/** `posted` names the item (fromClemItemDigest) last posted to her thread. */
interface VoiceEntry { digest: string; message: string; choices?: string[]; model: string; at: string; posted?: string }
/** One item that could not be said backs off on its own; the rest are still said. */
interface VoiceFailure { digest: string; count: number; at: string }
/** `primer` is the digest of the raised-context text her thread last received. */
interface VoiceFile { version: 1; entries: Record<string, VoiceEntry>; failures?: Record<string, VoiceFailure>; primer?: string }

function loadVoices(): VoiceFile {
  try {
    if (!existsSync(VOICE_FILE)) return { version: 1, entries: {} };
    const raw = JSON.parse(readFileSync(VOICE_FILE, 'utf-8')) as Partial<VoiceFile>;
    if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return { version: 1, entries: {} };
    return {
      version: 1,
      entries: raw.entries,
      ...(raw.failures && typeof raw.failures === 'object' ? { failures: raw.failures } : {}),
      ...(typeof raw.primer === 'string' ? { primer: raw.primer } : {}),
    };
  } catch {
    return { version: 1, entries: {} };
  }
}
function saveVoices(file: VoiceFile): void {
  mkdirSync(path.dirname(VOICE_FILE), { recursive: true });
  const tmp = `${VOICE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, VOICE_FILE);
}
function voiced(file: VoiceFile) {
  return (key: string, digest: string): { message: string; choices?: string[] } | undefined => {
    const entry = file.entries[key];
    return entry && entry.digest === digest
      ? { message: entry.message, ...(entry.choices?.length ? { choices: entry.choices } : {}) }
      : undefined;
  };
}

/** Whether a heartbeat's latest check is the one that failed: its error was
 *  recorded at, or within the same check as, its latest finding. Checks are
 *  minutes apart, so a two-minute window cannot reach an older one. */
export function lastCheckFailed(findingAt: string, errorAt: string | undefined): boolean {
  if (!errorAt) return false;
  const finding = Date.parse(findingAt);
  const error = Date.parse(errorAt);
  if (!Number.isFinite(finding) || !Number.isFinite(error)) return false;
  return error >= finding - 2 * 60_000;
}

// ── the stream ────────────────────────────────────────────────────────────────
export async function readFromClem(): Promise<FromClem> {
  const [{ listHeartbeats }, { loadNoticingState }, { loadNotifications }, { listPlanProposals }] = await Promise.all([
    import('../agents/heartbeats.js'),
    import('../agents/noticing-runtime.js'),
    import('../runtime/notifications.js'),
    import('../agents/plan-proposals.js'),
  ]);
  const needsYouRef = needsYouReferents();
  const later = laterNow();
  const { readSetupSuggestion } = await import('./from-clem-setup.js');
  const setup = await readSetupSuggestion(later).catch(() => null);
  return buildFromClem({
    heartbeats: (await listHeartbeats()).map((row) => ({
      id: row.id, title: row.title, enabled: row.enabled,
      ...(row.lastFinding ? { lastFinding: {
        at: row.lastFinding.at,
        summary: row.lastFinding.summary,
        failed: lastCheckFailed(row.lastFinding.at, row.lastError?.at),
      } } : {}),
    })),
    noticingProposals: Object.values(loadNoticingState().proposals),
    notifications: loadNotifications(),
    planProposals: listPlanProposals({ status: 'pending' }).map((proposal) => ({
      id: proposal.id, proposedAt: proposal.proposedAt, proposedByAgent: proposal.proposedByAgent, status: proposal.status,
      title: proposal.plan?.objective || proposal.originatingRequest || proposal.id,
      ...(proposal.context ? { context: proposal.context } : {}),
    })),
    asksOwner: (notification) => notificationNeedsYou(notification, needsYouRef),
    voiced: voiced(loadVoices()),
    later,
    setup,
  });
}

// ── her thread ────────────────────────────────────────────────────────────────
/** Her own conversation: pinned, named Clem. What she raises on her own lands
 *  here, and the owner's "do it" runs here, so it reads as one assistant. */
export const CLEM_THREAD_ID = 'clem';
const RAISED_PRIMER = '[clem-raised]';
const MAX_RAISED_IN_PRIMER = 8;
const MAX_RAISED_SAY_CHARS = 600;

export interface ClemThreadDeps {
  ensure: () => void;
  /** Post keys already in her thread. A message is one item at one version,
   *  so a crash between posting and remembering it never posts it twice. */
  postedKeys: () => ReadonlySet<string>;
  post: (message: { key: string; heartbeat: string; text: string; postKey: string }) => void;
  /** True once her thread carries this text; false when there is no thread yet. */
  primer: (text: string) => boolean;
}
/** A desktop conversation's own identity: the chat route continues a thread
 *  only for the principal it belongs to, and splits anything else off. */
const CLEM_THREAD_IDENTITY = { source: 'desktop', channelId: CLEM_THREAD_ID, userId: 'desktop', clemThread: true } as const;

export const productionClemThread: ClemThreadDeps = {
  ensure: () => {
    const existing = getSession(CLEM_THREAD_ID);
    if (!existing) {
      HarnessSession.create({ id: CLEM_THREAD_ID, kind: 'chat', userId: 'desktop', title: 'Clem', metadata: { ...CLEM_THREAD_IDENTITY, pinned: true } });
      return;
    }
    const meta = (existing.metadata ?? {}) as Record<string, unknown>;
    if (meta.source !== 'desktop' || meta.channelId !== CLEM_THREAD_ID || meta.userId !== 'desktop' || meta.clemThread !== true) {
      // Keep the owner's own choices (a pin they removed stays removed).
      updateSession(CLEM_THREAD_ID, { metadata: { ...meta, ...CLEM_THREAD_IDENTITY, pinned: meta.pinned ?? true } });
    }
  },
  postedKeys: () => new Set(listEvents(CLEM_THREAD_ID, { types: ['clem_message'] })
    .map((event) => (event.data as { postKey?: unknown }).postKey)
    .filter((postKey): postKey is string => typeof postKey === 'string')),
  post: (message) => {
    appendEvent({ sessionId: CLEM_THREAD_ID, turn: 0, role: 'Clem', type: 'clem_message', data: { version: 1, ...message } });
  },
  // The model in her thread sees what she raised, so a reply there is read
  // against it. Replaced, never appended: one current block.
  primer: (text) => {
    const session = HarnessSession.load(CLEM_THREAD_ID);
    if (!session) return false;
    session.setContextPrimer(RAISED_PRIMER, text);
    return true;
  },
};

function raisedPrimer(rows: ReadonlyArray<FromClemRow & { say: string }>): string {
  if (rows.length === 0) return `${RAISED_PRIMER} Nothing I (Clem) raised with the owner on my own is open right now.`;
  return [
    `${RAISED_PRIMER} What I (Clem) raised with the owner on my own recently, newest first. A reply here may be about one of these; if it is unclear which, ask.`,
    // A report's full text is in the thread itself; the primer names it.
    ...rows.slice(0, MAX_RAISED_IN_PRIMER).map((row) => `- ${row.at} · ${row.heartbeatTitle}: ${row.say.slice(0, MAX_RAISED_SAY_CHARS)} (the record: ${[row.text, row.detail].filter(Boolean).join(' — ').slice(0, 400)})`),
  ].join('\n');
}

type VoicePort = Pick<TurnSemanticModelPort, 'voiceProactiveItem'>;

function waitingAfterFailure(failure: VoiceFailure | undefined, digest: string, nowMs: number): boolean {
  if (!failure || failure.digest !== digest) return false;
  const wait = Math.min(VOICE_RETRY_MAX_MS, VOICE_RETRY_BASE_MS * 2 ** Math.max(0, failure.count - 1));
  return nowMs - Date.parse(failure.at) < wait;
}

/**
 * Write Clem's words for the rows that have none (or whose item changed),
 * a few at a time, and forget words for rows that are gone.
 */
export async function voiceFromClemRows(
  rows: readonly FromClemRow[],
  deps: { port: () => VoicePort | null; now?: () => number; max?: number; thread?: ClemThreadDeps | null } = { port: () => peekTurnSemanticModelPort() },
): Promise<number> {
  const file = loadVoices();
  const failures = file.failures ?? {};
  const live = new Set(rows.map((row) => row.key));
  let changed = false;
  for (const key of Object.keys(file.entries)) {
    if (!live.has(key)) { delete file.entries[key]; changed = true; }
  }
  for (const key of Object.keys(failures)) {
    if (!live.has(key)) { delete failures[key]; changed = true; }
  }
  const nowMs = deps.now?.() ?? Date.now();
  // What she already wrote for the owner (a workflow's report) is her message
  // as it stands, titled: no model call to say it again.
  for (const row of rows) {
    if (!row.authored || !row.say || file.entries[row.key]?.digest === row.voiceDigest) continue;
    const prior = file.entries[row.key];
    file.entries[row.key] = {
      digest: row.voiceDigest, message: `${row.text}\n\n${row.say}`, model: 'authored', at: new Date(nowMs).toISOString(),
      ...(prior?.posted ? { posted: prior.posted } : {}),
    };
    changed = true;
  }
  const port = deps.port();
  let written = 0;
  if (port?.voiceProactiveItem) {
    const pending = rows
      .filter((row) => !row.authored && file.entries[row.key]?.digest !== row.voiceDigest && !waitingAfterFailure(failures[row.key], row.voiceDigest, nowMs))
      .slice(0, deps.max ?? MAX_VOICES_PER_PASS);
    for (const row of pending) {
      const unsaid = (reason: string): void => {
        const prior = failures[row.key];
        failures[row.key] = { digest: row.voiceDigest, count: (prior?.digest === row.voiceDigest ? prior.count : 0) + 1, at: new Date(nowMs).toISOString() };
        changed = true;
        logger.warn({ key: row.key, reason }, 'from clem: could not write the message; the item keeps its own words');
      };
      try {
        const result = await withOwnModelRequestAttribution({ sessionId: FROM_CLEM_USAGE_SOURCE }, () => port.voiceProactiveItem!({
          purpose: CLEM_VOICE_PURPOSE,
          item: { source: row.heartbeatTitle, title: row.text, detail: row.detail ?? '', waitingOnOwner: row.asks, at: row.at },
          now: new Date(nowMs).toISOString(),
          evidenceDigest: row.voiceDigest,
        }));
        if (!result.message) { unsaid('no message'); continue; }
        const prior = file.entries[row.key];
        // Already in her thread when the item is unchanged: posted for this
        // item, or posted under an earlier rubric's words for it.
        const postedItem = prior?.posted && (prior.posted === fromClemItemDigest(row)
          || (prior.posted === prior.digest && fromClemSaidUnderEarlierRubric(row, prior.digest)))
          ? fromClemItemDigest(row) : undefined;
        file.entries[row.key] = {
          digest: row.voiceDigest, message: result.message.slice(0, 600),
          ...(result.choices?.length ? { choices: result.choices.slice(0, 3).map((choice) => choice.slice(0, 40)) } : {}),
          model: result.modelIdentity, at: new Date(nowMs).toISOString(),
          ...(postedItem ? { posted: postedItem } : {}),
        };
        delete failures[row.key];
        written += 1;
        changed = true;
      } catch (error) {
        // One item that cannot be said waits on its own; the rest are still said.
        unsaid(error instanceof Error ? error.message : String(error));
      }
    }
  }
  file.failures = failures;
  // Each written message lands in her thread once, newest last, and the
  // thread's primer names what she raised.
  const thread = deps.thread === undefined ? productionClemThread : deps.thread;
  if (thread) {
    try {
      // An item is posted once. Saying it again in new words (a changed
      // rubric) is not news; a changed item is.
      const unposted = rows.filter((row) => {
        const entry = file.entries[row.key];
        return entry && entry.digest === row.voiceDigest && entry.posted !== fromClemItemDigest(row)
          && entry.posted !== entry.digest;
      }).sort((a, b) => a.at.localeCompare(b.at));
      if (unposted.length > 0) {
        thread.ensure();
        const already = thread.postedKeys();
        for (const row of unposted) {
          const entry = file.entries[row.key]!;
          const postKey = `${row.key}:${entry.digest}`;
          if (!already.has(postKey)) thread.post({ key: row.key, heartbeat: row.heartbeat, text: entry.message, postKey });
          entry.posted = fromClemItemDigest(row);
          changed = true;
        }
      }
      // What her thread knows she raised follows the stream: an item that is
      // resolved leaves it on the next pass, not only when something new posts.
      const said = rows.flatMap((row) => {
        const entry = file.entries[row.key];
        return entry && entry.digest === row.voiceDigest ? [{ ...row, say: entry.message }] : [];
      });
      const text = raisedPrimer(said);
      const digest = createHash('sha256').update(text).digest('hex').slice(0, 24);
      if (file.primer !== digest && thread.primer(text)) { file.primer = digest; changed = true; }
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'from clem: could not post to her thread');
    }
  }
  const keys = Object.keys(file.entries);
  if (keys.length > MAX_KEPT_VOICES) {
    keys.sort((a, b) => file.entries[a]!.at.localeCompare(file.entries[b]!.at))
      .slice(0, keys.length - MAX_KEPT_VOICES).forEach((key) => { delete file.entries[key]; });
    changed = true;
  }
  if (changed) saveVoices(file);
  return written;
}

let voicing: Promise<number> | null = null;
export function startFromClemVoice(): { stop: () => void } {
  // A thread written before it carried a desktop chat's identity is healed
  // once at start, so the owner's next message there continues it.
  try { if (getSession(CLEM_THREAD_ID)) productionClemThread.ensure(); } catch { /* the next post heals it */ }
  const pass = (): void => {
    if (voicing) return;
    voicing = readFromClem()
      .then((stream) => voiceFromClemRows(stream.rows))
      .catch((error: unknown) => {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'from clem: voice pass failed');
        return 0;
      })
      .finally(() => { voicing = null; });
  };
  const first = setTimeout(pass, FIRST_VOICE_PASS_DELAY_MS);
  first.unref?.();
  const timer = setInterval(pass, VOICE_PASS_MS);
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ── the owner's reply ─────────────────────────────────────────────────────────
export interface FromClemRespond {
  (request: { sessionId: string; channel: string; message: string; displayMessage?: string }): Promise<unknown>;
}
let respondImpl: FromClemRespond | null = null;
export function bindFromClemRespond(respond: FromClemRespond | null): void { respondImpl = respond; }

export type FromClemReplyOutcome =
  | { outcome: 'gone' }
  | { outcome: 'changed' }
  | { outcome: 'unclear'; decision: 'unclear' }
  | { outcome: 'started'; decision: ClemReplyResult['decision']; sessionId: string }
  | { outcome: 'approved' | 'declined' | 'cleared' | 'later' | 'rule_added'; decision: ClemReplyResult['decision'] }
  | { outcome: 'answered'; questionId: string };

export interface FromClemReplyDeps {
  read: () => Promise<FromClem>;
  port: () => Pick<TurnSemanticModelPort, 'readClemReply'> | null;
  /** `requestId` is the owner's one reply, so a retried send is the same answer. */
  answerQuestion: (questionId: string, text: string, requestId?: string) => boolean;
  markRead: (notificationId: string) => void;
  addRule: (heartbeat: string, text: string) => void;
  approvePlan: (planProposalId: string) => boolean;
  rejectPlan: (planProposalId: string, reason: string) => boolean;
  snoozePlan: (planProposalId: string) => void;
  /** Hide the row until the next morning, or for good; the item itself is
   *  untouched. */
  later: (key: string, forever?: boolean) => void;
  startTurn: (input: { title: string; message: string; displayMessage: string }) => string;
}

/** The facts behind a row, as Clem would cite them. */
function factsOf(row: FromClemRow): string {
  return [row.text, row.detail ?? ''].filter(Boolean).join('\n');
}

/**
 * Act on the owner's words about one row. A Noticing proposal is answered
 * through its own check-in (Noticing reads it and starts the work). Anything
 * else is read into a decision, and the host takes the path that already
 * settles it: a turn for "do it", the plan decision for a suggestion, read
 * for "done" or "not now", and a rule in the owner's own words for "never".
 */
export interface FromClemReplyRequest {
  /** One owner reply: a retried or double-tapped send carries the same id and
   *  gets the first answer back instead of acting again. */
  requestId?: string;
  /** The version of the item the owner was looking at when they replied. */
  seenDigest?: string;
  /** A button whose meaning is fixed ("Not now", "Don't suggest this")
   *  carries its decision, so there is nothing to read. */
  decision?: 'do_it' | 'done' | 'not_now' | 'never';
}

const replyQueues = new Map<string, Promise<unknown>>();
const recentReplies = new Map<string, Promise<FromClemReplyOutcome>>();
const MAX_RECENT_REPLIES = 200;

export function replyToFromClem(key: string, text: string, deps: FromClemReplyDeps, request: FromClemReplyRequest = {}): Promise<FromClemReplyOutcome> {
  const requestId = request.requestId?.trim() || undefined;
  const known = requestId ? recentReplies.get(requestId) : undefined;
  if (known) return known;
  // Replies to one item are taken one at a time, so a second reply (another
  // device, a second tap) is read against what the first one already did.
  const prior = replyQueues.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(() => replyOnce(key, text, deps, requestId, request.seenDigest, request.decision));
  replyQueues.set(key, run);
  run.finally(() => { if (replyQueues.get(key) === run) replyQueues.delete(key); }).catch(() => undefined);
  if (requestId) {
    recentReplies.set(requestId, run);
    if (recentReplies.size > MAX_RECENT_REPLIES) recentReplies.delete(recentReplies.keys().next().value!);
    // A reply that failed outright may be sent again under the same id.
    run.catch(() => { if (recentReplies.get(requestId) === run) recentReplies.delete(requestId); });
  }
  return run;
}

async function replyOnce(
  key: string, text: string, deps: FromClemReplyDeps, requestId: string | undefined, seenDigest: string | undefined,
  decided?: FromClemReplyRequest['decision'],
): Promise<FromClemReplyOutcome> {
  const reply = text.trim();
  const row = (await deps.read()).rows.find((candidate) => candidate.key === key);
  if (!row || !reply) return { outcome: 'gone' };
  // The owner answered the version they saw; a changed item is shown again first.
  if (seenDigest && seenDigest !== row.voiceDigest) return { outcome: 'changed' };
  if (row.answer?.kind === 'words') {
    return deps.answerQuestion(row.answer.questionId, reply, requestId) ? { outcome: 'answered', questionId: row.answer.questionId } : { outcome: 'gone' };
  }
  const said = row.say ?? row.text;
  let read: { decision: ClemReplyResult['decision']; instruction?: string | null };
  if (decided) {
    read = { decision: decided, instruction: null };
  } else {
    const port = deps.port();
    if (!port?.readClemReply) return { outcome: 'unclear', decision: 'unclear' };
    // Reading the owner's reply is work in her thread.
    read = await withOwnModelRequestAttribution({ sessionId: CLEM_THREAD_ID }, () => port.readClemReply!({
      purpose: CLEM_REPLY_PURPOSE, said, facts: factsOf(row), reply, evidenceDigest: row.voiceDigest,
    }));
  }
  // Reading the reply took a while: act only on the item as it was read.
  const current = (await deps.read()).rows.find((candidate) => candidate.key === key);
  if (!current) return { outcome: 'gone' };
  if (current.voiceDigest !== row.voiceDigest) return { outcome: 'changed' };
  const planId = row.answer?.kind === 'yes_no' ? row.answer.planProposalId : null;
  const notificationId = row.done?.notificationId ?? null;
  switch (read.decision) {
    case 'do_it': {
      if (planId && !read.instruction) {
        return deps.approvePlan(planId) ? { outcome: 'approved', decision: read.decision } : { outcome: 'gone' };
      }
      const sessionId = deps.startTurn({
        title: row.text.slice(0, 120),
        message: [`You told me: ${said}`, `What it was about: ${factsOf(row)}`, `My reply: ${reply}`].join('\n\n'),
        displayMessage: reply,
      });
      if (notificationId) deps.markRead(notificationId);
      if (planId) deps.rejectPlan(planId, `Taken up in conversation: ${reply}`);
      return { outcome: 'started', decision: read.decision, sessionId };
    }
    case 'done':
      if (planId) return deps.rejectPlan(planId, reply) ? { outcome: 'declined', decision: read.decision } : { outcome: 'gone' };
      if (notificationId) deps.markRead(notificationId);
      // An offer with no record behind it leaves until tomorrow; done for real
      // means the part is set up, and it stops being offered.
      if (!notificationId && row.setup) deps.later(row.key);
      return { outcome: 'cleared', decision: read.decision };
    case 'not_now':
      // Later is later: the item comes back tomorrow morning, never cleared.
      if (planId) deps.snoozePlan(planId);
      deps.later(row.key);
      return { outcome: 'later', decision: read.decision };
    case 'never':
      if (row.setup) { deps.later(row.key, true); return { outcome: 'cleared', decision: read.decision }; }
      if (planId) deps.rejectPlan(planId, reply);
      if (notificationId) deps.markRead(notificationId);
      deps.addRule(row.heartbeat, reply);
      return { outcome: 'rule_added', decision: read.decision };
    default:
      return { outcome: 'unclear', decision: 'unclear' };
  }
}

/** Runs the owner's "do it" in her thread, without waiting for it. */
export function startFromClemTurn(input: { title: string; message: string; displayMessage: string }, thread: Pick<ClemThreadDeps, 'ensure'> = productionClemThread): string {
  if (!respondImpl) throw new Error('no turn runner is bound');
  thread.ensure();
  const sessionId = CLEM_THREAD_ID;
  const respond = respondImpl;
  void respond({ sessionId, channel: 'desktop', message: input.message, displayMessage: input.displayMessage }).catch((error: unknown) => {
    logger.warn({ sessionId, err: error instanceof Error ? error.message : String(error) }, 'from clem: the reply turn failed');
  });
  return sessionId;
}
