/**
 * Noticing — the runtime half: what the tick reads, where its state lives,
 * the policy the owner edits, the model it thinks with, how it asks, and how
 * the owner's answer in their own words becomes a decision and, on a yes, an
 * ordinary turn.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { withDaemonRuntimePhase } from '../daemon/phase.js';
import { listGoalRecords } from '../memory/goals-list.js';
import { listActiveFacts } from '../memory/facts.js';
import { createCheckIn, getCheckIn } from './check-ins.js';
import { loadHeartbeatContract } from './heartbeat-contracts.js';
import { isQuietHoursActive, loadProactivityPolicy, saveProactivityPolicy } from './proactivity-policy.js';
import { createSession, listSessions, listEvents } from '../runtime/harness/eventlog.js';
import { peekTurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-port-registry.js';
import { NOTICING_ANSWER_PURPOSE, NOTICING_PROPOSAL_PURPOSE } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import {
  DEFAULT_NOTICING_CONFIG,
  NOTICING_ID,
  NOTICING_SESSION_ID,
  NoticingAnswerV1Schema,
  emptyNoticingState,
  recordNoticingAnswer,
  runNoticingTick,
  type NoticingDecision,
  type NoticingObservation,
  type NoticingProposalRecord,
  type NoticingState,
  type NoticingThinking,
  type NoticingTickResult,
} from './noticing.js';

const logger = pino({ name: 'clementine.noticing' });
const STATE_FILE = path.join(BASE_DIR, 'state', 'noticing.json');
const HEARTBEAT_MS = 60_000;
const FIRST_HEARTBEAT_DELAY_MS = 90_000;
const MAX_TEXT = 240;

// ── state ─────────────────────────────────────────────────────────────────────
export function loadNoticingState(): NoticingState {
  try {
    if (!existsSync(STATE_FILE)) return emptyNoticingState();
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<NoticingState>;
    if (raw.version !== 1) return emptyNoticingState();
    const empty = emptyNoticingState();
    return { ...empty, ...raw, proposals: raw.proposals ?? {}, standingAnswers: raw.standingAnswers ?? [],
      thinking: raw.thinking ?? [], metrics: { ...empty.metrics, ...(raw.metrics ?? {}) } };
  } catch {
    return emptyNoticingState();
  }
}
export function saveNoticingState(state: NoticingState): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

// ── policy ────────────────────────────────────────────────────────────────────
export interface NoticingPolicyView { enabled: boolean; cadenceMinutes: number; dailyCap: number; quietHoursActive: boolean }
export function noticingPolicy(): NoticingPolicyView {
  const policy = loadProactivityPolicy();
  return { enabled: policy.noticingEnabled, cadenceMinutes: policy.noticingMinutes, dailyCap: policy.noticingDailyCap, quietHoursActive: isQuietHoursActive(policy) };
}
export function setNoticingPolicy(patch: { enabled?: boolean; cadenceMinutes?: number; dailyCap?: number }): NoticingPolicyView {
  saveProactivityPolicy({
    ...(patch.enabled !== undefined ? { noticingEnabled: patch.enabled } : {}),
    ...(patch.cadenceMinutes !== undefined ? { noticingMinutes: patch.cadenceMinutes } : {}),
    ...(patch.dailyCap !== undefined ? { noticingDailyCap: patch.dailyCap } : {}),
  });
  return noticingPolicy();
}

// ── what a tick reads ─────────────────────────────────────────────────────────
const clip = (value: unknown, max = MAX_TEXT): string => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export async function observeForNoticing(now = Date.now()): Promise<NoticingObservation> {
  const since = new Date(now - 3 * 24 * 60 * 60_000).toISOString();
  const goals = listGoalRecords()
    .filter((g) => g.status === 'active' || g.status === 'blocked')
    .map((g) => ({ id: g.id, title: clip(g.title, 120), status: g.status, priority: g.priority, updatedAt: g.updatedAt,
      ...(g.targetDate ? { targetDate: g.targetDate } : {}),
      progressNotes: (g.progressNotes ?? []).slice(-4).map((n) => clip(n)),
      nextActions: (g.nextActions ?? []).slice(0, 5).map((n) => clip(n)),
      blockers: (g.blockers ?? []).slice(0, 4).map((n) => clip(n)) }));
  const { observeWork } = await import('./work-review-runtime.js');
  const work = (await observeWork()).observation;
  const { calendarWatchStatus } = await import('./calendar-watch-runtime.js');
  const calendar = calendarWatchStatus(now).openItems.slice(0, 12).map((i) => ({ kind: i.kind, subject: clip(i.subject, 120), createdAt: i.createdAt }));
  const conversations = listSessions({ kind: 'chat', updatedAfter: since, archived: false } as never)
    .filter((s) => !s.id.startsWith('watch:') && !s.id.startsWith('background:'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12)
    .map((s) => {
      const last = listEvents(s.id, { types: ['user_input_received'], desc: true, limit: 3 })
        .find((e) => e.role === 'user' && e.data.synthetic !== true);
      const text = typeof last?.data.displayText === 'string' ? last.data.displayText : typeof last?.data.text === 'string' ? last.data.text : undefined;
      return { title: clip(s.title ?? '(untitled)', 120), updatedAt: s.updatedAt, ...(text ? { lastRequest: clip(text) } : {}) };
    });
  let memories: NoticingObservation['memories'] = [];
  try {
    memories = listActiveFacts({ limit: 16, ranking: 'stanford' })
      .map((f) => ({ text: clip(f.content), ageDays: Math.max(0, Math.round((now - Date.parse(f.updatedAt)) / 86_400_000)) }));
  } catch { memories = []; }
  return {
    at: new Date(now).toISOString(),
    goals,
    work: {
      runs: work.runs.filter((r) => !r.targetStepId).slice(0, 20).map((r) => ({ workflow: r.workflow, status: r.status,
        ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), ...(r.error ? { error: clip(r.error, 160) } : {}) })),
      waits: work.chats.slice(0, 10).map((c) => ({ title: clip(c.title, 120), waitingOn: c.waitingOn, since: c.updatedAt })),
      drafts: work.drafts.slice(0, 10).map((d) => ({ name: clip(d.name, 120), modifiedAt: d.modifiedAt })),
    },
    calendar,
    conversations,
    memories,
  };
}

// ── the model ─────────────────────────────────────────────────────────────────
async function proposeWithConfiguredModel(input: Parameters<Parameters<typeof runNoticingTick>[0]['propose']>[0]) {
  const port = peekTurnSemanticModelPort();
  if (!port?.noticing) return null;
  const reply = await port.noticing({
    purpose: NOTICING_PROPOSAL_PURPOSE,
    observation: input.observation,
    rules: input.rules,
    standingAnswers: input.standingAnswers.map((a) => ({ about: a.about, said: a.text })),
    recentProposals: input.recentProposals,
    evidenceDigest: input.evidenceDigest,
  });
  const parsed = NoticingAnswerV1Schema.safeParse(reply.answer);
  return parsed.success
    ? { answer: parsed.data, modelIdentity: reply.modelIdentity }
    : { answer: null, modelIdentity: reply.modelIdentity, error: `the model's answer was not well-formed: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
}

/** The owner's words, read into a decision. No regex on their text. */
export async function readNoticingAnswer(proposal: Pick<NoticingProposalRecord, 'title' | 'action'>, text: string): Promise<{ decision: NoticingDecision; instruction?: string; modelIdentity?: string }> {
  const port = peekTurnSemanticModelPort();
  if (!port?.readNoticingAnswer) return { decision: 'unclear' };
  const digest = createHash('sha256').update(JSON.stringify({ title: proposal.title, action: proposal.action, text })).digest('hex');
  const reply = await port.readNoticingAnswer({ purpose: NOTICING_ANSWER_PURPOSE, proposal: { title: proposal.title, action: proposal.action }, answer: text, evidenceDigest: digest });
  if (reply.evidenceDigest !== digest) return { decision: 'unclear', modelIdentity: reply.modelIdentity };
  return { decision: reply.decision, ...(reply.instruction ? { instruction: reply.instruction } : {}), modelIdentity: reply.modelIdentity };
}

// ── asking ────────────────────────────────────────────────────────────────────
function askViaCheckIn(record: NoticingProposalRecord): Promise<{ checkInId: string; notificationId?: string }> {
  const goalLine = record.goalId ? ` (for your goal ${record.goalId})` : '';
  const question = [
    `${record.title}${goalLine}`,
    '',
    record.why,
    '',
    `What I would do: ${record.action}`,
    '',
    `Based on: ${record.evidence.join('; ')}`,
    '',
    'Say "do it", "not now", or tell me never to suggest this kind of thing — in your own words is fine.',
  ].join('\n');
  const checkIn = createCheckIn({ agentSlug: 'clementine', question, urgency: 'normal', contextSummary: `noticing:${record.id}` });
  return Promise.resolve({ checkInId: checkIn.id });
}

// ── answers → decisions → turns ───────────────────────────────────────────────
export interface NoticingRespond {
  (request: { sessionId: string; channel: string; message: string; displayMessage?: string }): Promise<unknown>;
}
let respondImpl: NoticingRespond | null = null;
export function bindNoticingRespond(respond: NoticingRespond | null): void { respondImpl = respond; }

/** Settle every answered proposal: read the owner's words, and on a yes
 * start the work as an ordinary chat turn the owner can watch. */
export async function settleNoticingAnswers(now = Date.now()): Promise<number> {
  const state = loadNoticingState();
  let settled = 0;
  for (const record of Object.values(state.proposals)) {
    if (!record.checkInId) continue;
    if (record.status !== 'open' && !(record.status === 'answered' && record.answer?.decision === 'unclear' && !record.answer.instruction)) continue;
    const checkIn = getCheckIn(record.checkInId);
    if (!checkIn || checkIn.status !== 'answered' || typeof checkIn.answer !== 'string') continue;
    if (record.answer && record.answer.decision !== 'unclear') continue;
    const read = await readNoticingAnswer(record, checkIn.answer);
    recordNoticingAnswer(state, { proposalId: record.id, text: checkIn.answer, decision: read.decision,
      ...(read.instruction ? { instruction: read.instruction } : {}), at: checkIn.answeredAt ?? new Date(now).toISOString() });
    settled += 1;
    if (read.decision === 'do_it') {
      try {
        await startProposalTurn(record, read.instruction);
      } catch (error) {
        logger.warn({ proposalId: record.id, err: error instanceof Error ? error.message : String(error) }, 'noticing: could not start the approved proposal');
        record.retiredReason = `could not start: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  if (settled) saveNoticingState(state);
  return settled;
}

async function startProposalTurn(record: NoticingProposalRecord, instruction?: string): Promise<void> {
  if (!respondImpl) throw new Error('no turn runner is bound');
  const session = createSession({ kind: 'chat', channel: 'desktop', title: record.title, metadata: { source: 'noticing', proposalId: record.id } as never });
  const message = instruction ? `${record.action}\n\nYou said: ${instruction}` : record.action;
  logger.info({ proposalId: record.id, sessionId: session.id }, 'noticing: the owner said do it — starting the turn');
  await respondImpl({ sessionId: session.id, channel: 'desktop', message, displayMessage: `Do it: ${record.title}` });
}

// ── ticking ───────────────────────────────────────────────────────────────────
let inFlight: Promise<NoticingTickResult> | null = null;

export function runNoticingTickNow(options: { source: string } = { source: 'heartbeat' }): Promise<NoticingTickResult> {
  if (inFlight) return inFlight;
  const contract = loadHeartbeatContract(NOTICING_ID);
  const policy = noticingPolicy();
  const tickId = `ntc-${Date.now().toString(36)}`;
  inFlight = settleNoticingAnswers().catch(() => 0).then(() => runNoticingTick({
    now: () => Date.now(),
    tickId,
    source: options.source,
    config: { ...DEFAULT_NOTICING_CONFIG, dailyCap: policy.dailyCap },
    rules: contract.rules.map((r) => r.text),
    observe: () => observeForNoticing(),
    propose: proposeWithConfiguredModel,
    ask: askViaCheckIn,
    isAnswered: (checkInId) => {
      const row = getCheckIn(checkInId);
      return row?.status === 'answered' && typeof row.answer === 'string'
        ? { answered: true, text: row.answer, ...(row.answeredAt ? { at: row.answeredAt } : {}) }
        : { answered: false };
    },
    loadState: loadNoticingState,
    saveState: saveNoticingState,
  })).then((result) => {
    logger.info({ tickId, source: options.source, produced: result.produced, quiet: result.quiet, durationMs: result.durationMs, summary: result.summary },
      result.quiet ? 'noticing: quiet tick' : 'noticing: proposed');
    return result;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

export function isNoticingDue(nowMs = Date.now()): { due: boolean; reason: string; nextAt?: string } {
  const policy = noticingPolicy();
  if (!policy.enabled) return { due: false, reason: 'disabled' };
  if (policy.quietHoursActive) return { due: false, reason: 'quiet_hours' };
  const state = loadNoticingState();
  const last = state.lastTickAt ? Date.parse(state.lastTickAt) : Number.NaN;
  if (!Number.isFinite(last)) return { due: true, reason: 'never_ticked' };
  const nextAt = last + policy.cadenceMinutes * 60_000;
  return nowMs >= nextAt ? { due: true, reason: 'cadence' } : { due: false, reason: 'not_yet', nextAt: new Date(nextAt).toISOString() };
}

export function startNoticingHeartbeat(): { stop: () => void } {
  const beat = (): void => {
    void withDaemonRuntimePhase('daemon.timer.noticing', {}, async () => {
      // Answers settle on every beat, so a "do it" starts within a minute.
      await settleNoticingAnswers().catch((error) => {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'noticing: settling answers failed');
      });
      let due: ReturnType<typeof isNoticingDue>;
      try { due = isNoticingDue(); } catch (error) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'noticing: due check failed');
        return;
      }
      if (!due.due) return;
      await runNoticingTickNow({ source: 'heartbeat' }).catch((error) => {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'noticing: tick failed');
      });
    });
  };
  const first = setTimeout(beat, FIRST_HEARTBEAT_DELAY_MS);
  first.unref?.();
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ── status for the console ────────────────────────────────────────────────────
export interface NoticingStatus {
  id: typeof NOTICING_ID;
  title: string;
  purpose: string;
  enabled: boolean;
  cadenceMinutes: number;
  dailyCap: number;
  quietHoursActive: boolean;
  running: boolean;
  lastTickAt?: string;
  nextTickAt?: string;
  lastFinding?: { at: string; summary: string; quiet: boolean; durationMs: number };
  lastError?: { at: string; reason: string };
  metrics: NoticingState['metrics'];
  openItems: NoticingProposalRecord[];
  recentlyRetired: NoticingProposalRecord[];
  thinking: NoticingThinking[];
  standingAnswers: NoticingState['standingAnswers'];
}
export function noticingStatus(nowMs = Date.now()): NoticingStatus {
  const policy = noticingPolicy();
  const state = loadNoticingState();
  const due = isNoticingDue(nowMs);
  const proposals = Object.values(state.proposals).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = state.thinking[0];
  return {
    id: NOTICING_ID,
    title: 'Noticing',
    purpose: 'Looks across your goals and what is happening — runs, waits, drafts, the calendar, recent conversations, what she remembers — and proposes one thing worth doing, with its evidence. She acts only when you say so.',
    enabled: policy.enabled,
    cadenceMinutes: policy.cadenceMinutes,
    dailyCap: policy.dailyCap,
    quietHoursActive: policy.quietHoursActive,
    running: inFlight !== null,
    ...(state.lastTickAt ? { lastTickAt: state.lastTickAt } : {}),
    ...(due.nextAt ? { nextTickAt: due.nextAt } : {}),
    ...(latest ? { lastFinding: { at: latest.at, summary: latest.summary, quiet: latest.quiet, durationMs: latest.durationMs } } : {}),
    ...(latest?.error ? { lastError: { at: latest.at, reason: latest.error } } : {}),
    metrics: state.metrics,
    openItems: proposals.filter((p) => p.status === 'open'),
    recentlyRetired: proposals.filter((p) => p.status !== 'open').slice(0, 20),
    thinking: state.thinking,
    standingAnswers: state.standingAnswers,
  };
}
export { NOTICING_SESSION_ID };
