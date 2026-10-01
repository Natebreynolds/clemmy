/**
 * From Clem, live. Reads the heartbeats' records into the stream (the desktop
 * and the phone share this), has Clem put each item in her own words once, and
 * acts on the owner's reply to any of them.
 *
 * Her words are written by the brain the owner chose, one short message per
 * item, and kept against what the item says: a changed item is said again, a
 * gone one is forgotten. Until a message exists the heartbeat's own text is
 * shown. A reply is read by the same brain into a decision; the host then
 * takes the one path that already settles that kind of item.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../tools/shared.js';
import { buildFromClem, type FromClem, type FromClemRow } from './from-clem.js';
import { needsYouReferents, notificationNeedsYou } from './needs-you.js';
import { peekTurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-port-registry.js';
import { CLEM_REPLY_PURPOSE, CLEM_VOICE_PURPOSE, type ClemReplyResult, type TurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-model-port.js';

const logger = pino({ name: 'clementine.from-clem' });
const VOICE_FILE = path.join(BASE_DIR, 'state', 'from-clem-voice.json');
const MAX_VOICES_PER_PASS = 4;
const VOICE_PASS_MS = 60_000;
const FIRST_VOICE_PASS_DELAY_MS = 45_000;
const MAX_KEPT_VOICES = 300;

// ── her words, kept ───────────────────────────────────────────────────────────
interface VoiceEntry { digest: string; message: string; model: string; at: string }
interface VoiceFile { version: 1; entries: Record<string, VoiceEntry> }

function loadVoices(): VoiceFile {
  try {
    if (!existsSync(VOICE_FILE)) return { version: 1, entries: {} };
    const raw = JSON.parse(readFileSync(VOICE_FILE, 'utf-8')) as Partial<VoiceFile>;
    return raw.version === 1 && raw.entries && typeof raw.entries === 'object' ? { version: 1, entries: raw.entries } : { version: 1, entries: {} };
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
  return (key: string, digest: string): string | undefined => {
    const entry = file.entries[key];
    return entry && entry.digest === digest ? entry.message : undefined;
  };
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
  return buildFromClem({
    heartbeats: (await listHeartbeats()).map((row) => ({
      id: row.id, title: row.title, enabled: row.enabled,
      ...(row.lastFinding ? { lastFinding: { at: row.lastFinding.at, summary: row.lastFinding.summary } } : {}),
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
  });
}

type VoicePort = Pick<TurnSemanticModelPort, 'voiceProactiveItem'>;

/**
 * Write Clem's words for the rows that have none (or whose item changed),
 * a few at a time, and forget words for rows that are gone.
 */
export async function voiceFromClemRows(
  rows: readonly FromClemRow[],
  deps: { port: () => VoicePort | null; now?: () => number; max?: number } = { port: () => peekTurnSemanticModelPort() },
): Promise<number> {
  const file = loadVoices();
  const live = new Set(rows.map((row) => row.key));
  let changed = false;
  for (const key of Object.keys(file.entries)) {
    if (!live.has(key)) { delete file.entries[key]; changed = true; }
  }
  const port = deps.port();
  let written = 0;
  if (port?.voiceProactiveItem) {
    const pending = rows.filter((row) => file.entries[row.key]?.digest !== row.voiceDigest).slice(0, deps.max ?? MAX_VOICES_PER_PASS);
    for (const row of pending) {
      try {
        const result = await port.voiceProactiveItem({
          purpose: CLEM_VOICE_PURPOSE,
          item: { source: row.heartbeatTitle, title: row.text, detail: row.detail ?? '', waitingOnOwner: row.asks, at: row.at },
          now: new Date(deps.now?.() ?? Date.now()).toISOString(),
          evidenceDigest: row.voiceDigest,
        });
        if (!result.message) continue;
        file.entries[row.key] = {
          digest: row.voiceDigest, message: result.message.slice(0, 600), model: result.modelIdentity,
          at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        };
        written += 1;
        changed = true;
      } catch (error) {
        logger.warn({ key: row.key, err: error instanceof Error ? error.message : String(error) }, 'from clem: could not write the message; the item keeps its own words');
        break;
      }
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
  | { outcome: 'unclear'; decision: 'unclear' }
  | { outcome: 'started'; decision: ClemReplyResult['decision']; sessionId: string }
  | { outcome: 'approved' | 'declined' | 'cleared' | 'later' | 'rule_added'; decision: ClemReplyResult['decision'] }
  | { outcome: 'answered'; questionId: string };

export interface FromClemReplyDeps {
  read: () => Promise<FromClem>;
  port: () => Pick<TurnSemanticModelPort, 'readClemReply'> | null;
  answerQuestion: (questionId: string, text: string) => boolean;
  markRead: (notificationId: string) => void;
  addRule: (heartbeat: string, text: string) => void;
  approvePlan: (planProposalId: string) => boolean;
  rejectPlan: (planProposalId: string, reason: string) => boolean;
  snoozePlan: (planProposalId: string) => void;
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
export async function replyToFromClem(key: string, text: string, deps: FromClemReplyDeps): Promise<FromClemReplyOutcome> {
  const reply = text.trim();
  const row = (await deps.read()).rows.find((candidate) => candidate.key === key);
  if (!row || !reply) return { outcome: 'gone' };
  if (row.answer?.kind === 'words') {
    return deps.answerQuestion(row.answer.questionId, reply) ? { outcome: 'answered', questionId: row.answer.questionId } : { outcome: 'gone' };
  }
  const port = deps.port();
  if (!port?.readClemReply) return { outcome: 'unclear', decision: 'unclear' };
  const said = row.say ?? row.text;
  const read = await port.readClemReply({ purpose: CLEM_REPLY_PURPOSE, said, facts: factsOf(row), reply, evidenceDigest: row.voiceDigest });
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
      return { outcome: 'cleared', decision: read.decision };
    case 'not_now':
      if (planId) { deps.snoozePlan(planId); return { outcome: 'later', decision: read.decision }; }
      if (notificationId) deps.markRead(notificationId);
      return { outcome: 'later', decision: read.decision };
    case 'never':
      if (planId) deps.rejectPlan(planId, reply);
      if (notificationId) deps.markRead(notificationId);
      deps.addRule(row.heartbeat, reply);
      return { outcome: 'rule_added', decision: read.decision };
    default:
      return { outcome: 'unclear', decision: 'unclear' };
  }
}

/** Starts a desktop conversation for the owner's "do it" without waiting for it. */
export function startFromClemTurn(input: { title: string; message: string; displayMessage: string }, createSession: (title: string) => string): string {
  if (!respondImpl) throw new Error('no turn runner is bound');
  const sessionId = createSession(input.title);
  const respond = respondImpl;
  void respond({ sessionId, channel: 'desktop', message: input.message, displayMessage: input.displayMessage }).catch((error: unknown) => {
    logger.warn({ sessionId, err: error instanceof Error ? error.message : String(error) }, 'from clem: the reply turn failed');
  });
  return sessionId;
}
