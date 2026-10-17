/**
 * Noticing — the runtime half: what the tick reads, where its state lives,
 * the policy the owner edits, the model it thinks with, how it asks, and how
 * the owner's answer in their own words becomes a decision and, on a yes, an
 * ordinary turn.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { withDaemonRuntimePhase } from '../daemon/phase.js';
import { listGoalRecords } from '../memory/goals-list.js';
import { listActiveFacts } from '../memory/facts.js';
import { createCheckIn, getCheckIn, type CheckInRecord } from './check-ins.js';
import { isQuietHoursActive, loadProactivityPolicy, saveProactivityPolicy } from './proactivity-policy.js';
import { acceptUserInputForRun, claimHarnessChatRequestInTransaction, createSession,
  getHarnessChatRequestReceipt, getLatestEventSeq, getRunAttemptBySourceUserSeq, getSession,
  isKillRequested, listSessions, listEvents, openEventLog, withEventPublicationTransaction,
  type EventRow } from '../runtime/harness/eventlog.js';
import { withFileLockSyncStrict } from '../runtime/atomic-json.js';
import { exactTerminalForAcceptedSource } from '../runtime/harness/accepted-source-terminal.js';
import { noticingApprovedTaskDigest, readAcceptedNoticingTask,
  type NoticingApprovedTaskPacket } from '../runtime/harness/noticing-approved-task.js';
import type { AssistantRequest } from '../types.js';
import { peekTurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-port-registry.js';
import { createStandaloneModelAccountingJob, standaloneModelAccountingJobBinding, withStandaloneModelAccountingJob,
  type StandaloneModelAccountingJob, type StandaloneModelAccountingJobBinding } from '../runtime/usage-log.js';
import { recordStandaloneModelAccountingJobObservation } from '../runtime/harness/model-transport-observation.js';
import { NOTICING_ANSWER_PURPOSE, NOTICING_PROPOSAL_PURPOSE } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import {
  DEFAULT_NOTICING_CONFIG,
  NOTICING_ID,
  NOTICING_SESSION_ID,
  NoticingAnswerV1Schema,
  emptyNoticingState,
  compactGoalOutcomeProgressForNoticing,
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
function readOptionalJson(file: string): { present: boolean; value: unknown } {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, value: null };
    throw error;
  }
  return { present: true, value: JSON.parse(text) as unknown };
}
export function readNoticingStateStrict(): { present: boolean; state: NoticingState } {
    const read = readOptionalJson(STATE_FILE);
    if (!read.present) return { present: false, state: emptyNoticingState() };
    const raw = read.value as Partial<NoticingState> | null;
    if (!raw || raw.version !== 1 || (raw.proposals !== undefined && (!raw.proposals || typeof raw.proposals !== 'object' || Array.isArray(raw.proposals)))
      || (raw.standingAnswers !== undefined && !Array.isArray(raw.standingAnswers))
      || (raw.thinking !== undefined && !Array.isArray(raw.thinking))) throw new Error('Noticing state is unavailable.');
    const empty = emptyNoticingState();
    return { present: true, state: { ...empty, ...raw, proposals: raw.proposals ?? {}, standingAnswers: raw.standingAnswers ?? [],
      thinking: raw.thinking ?? [], metrics: { ...empty.metrics, ...(raw.metrics ?? {}) } } };
}
export function loadNoticingState(): NoticingState {
  try { return readNoticingStateStrict().state; }
  catch { return emptyNoticingState(); }
}
function readNoticingRulesStrict(): { present: boolean; rules: string[] } {
  const read = readOptionalJson(path.join(BASE_DIR, 'state', 'heartbeats.json'));
  if (!read.present) return { present: false, rules: [] };
  const raw = read.value as { version?: unknown; contracts?: Record<string, { rules?: unknown }> } | null;
  if (!raw || raw.version !== 1 || !raw.contracts || typeof raw.contracts !== 'object' || Array.isArray(raw.contracts)) {
    throw new Error('Noticing rules are unavailable.');
  }
  const contract = raw.contracts[NOTICING_ID];
  if (contract === undefined) return { present: true, rules: [] };
  if (!contract || !Array.isArray(contract.rules) || !contract.rules.every(rule => rule
    && typeof rule === 'object' && typeof rule.id === 'string' && typeof rule.text === 'string')) {
    throw new Error('Noticing rules are unavailable.');
  }
  return { present: true, rules: contract.rules.map(rule => rule.text) };
}
function writeNoticingState(state: NoticingState): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function proposalIdentity(record: NoticingProposalRecord): string {
  return digest({ id: record.id, checkInId: record.checkInId, title: record.title, action: record.action,
    why: record.why, evidence: record.evidence, goalId: record.goalId, createdAt: record.createdAt });
}

/** A slow tick cannot erase an answer/handoff committed while it was thinking. */
export function saveNoticingState(state: NoticingState): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  withFileLockSyncStrict(STATE_FILE, () => {
    const current = readNoticingStateStrict().state;
    const incomingGeneration = digest({ proposals: state.proposals, standingAnswers: state.standingAnswers });
    for (const [id, retained] of Object.entries(current.proposals)) {
      const incoming = state.proposals[id];
      if (!incoming) {
        state.proposals[id] = retained;
        continue;
      }
      if (proposalIdentity(incoming) !== proposalIdentity(retained)) continue;
      if (retained.answer) {
        incoming.answer = retained.answer;
        incoming.status = retained.status;
      }
      if (retained.handoff) incoming.handoff = retained.handoff;
    }
    state.standingAnswers = [...current.standingAnswers, ...state.standingAnswers]
      .filter((item, index, all) => all.findIndex(other => digest(other) === digest(item)) === index).slice(0, 100);
    for (const key of ['itemsAcknowledged', 'doIt', 'notNow', 'never'] as const) {
      state.metrics[key] = Math.max(state.metrics[key], current.metrics[key]);
    }
    if (digest({ proposals: state.proposals, standingAnswers: state.standingAnswers }) !== incomingGeneration) {
      delete state.decisionReuse;
    }
    writeNoticingState(state);
  });
}

function updateNoticingState<T>(work: (state: NoticingState) => T): T {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  return withFileLockSyncStrict(STATE_FILE, () => {
    const state = readNoticingStateStrict().state;
    const result = work(state);
    writeNoticingState(state);
    return result;
  });
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
  const retainedGoals = listGoalRecords().filter((g) => g.status === 'active' || g.status === 'blocked');
  const { readGoalOutcomeProgress, unavailableGoalOutcomeProgress } = await import('./goal-outcome-progress.js');
  const outcomeProgress = (() => {
    try {
      return readGoalOutcomeProgress({ goals: retainedGoals, proposals: Object.values(readNoticingStateStrict().state.proposals) });
    } catch {
      return Object.fromEntries(retainedGoals.map((goal) => [goal.id, unavailableGoalOutcomeProgress()]));
    }
  })();
  const goals = retainedGoals.map((g) => ({ id: g.id, title: clip(g.title, 120), status: g.status, priority: g.priority, updatedAt: g.updatedAt,
      ...(g.targetDate ? { targetDate: g.targetDate } : {}),
      progressNotes: (g.progressNotes ?? []).slice(-4).map((n) => clip(n)),
      nextActions: (g.nextActions ?? []).slice(0, 5).map((n) => clip(n)),
      blockers: (g.blockers ?? []).slice(0, 4).map((n) => clip(n)),
      outcomeProgress: compactGoalOutcomeProgressForNoticing(outcomeProgress[g.id] ?? unavailableGoalOutcomeProgress()) }));
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
  // What Home already asks the owner about, from every other part of Clem.
  let alreadyAskingOwner: NonNullable<NoticingObservation['alreadyAskingOwner']> = [];
  try {
    const { readFromClem } = await import('../dashboard/from-clem-runtime.js');
    alreadyAskingOwner = (await readFromClem({ includeSetup: false })).rows
      .filter((row) => row.asks && row.heartbeat !== 'noticing')
      .slice(0, 12)
      .map((row) => ({ from: clip(row.heartbeatTitle, 60), about: clip([row.text, row.detail ?? ''].filter(Boolean).join(' — '), 240) }));
  } catch { alreadyAskingOwner = []; }
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
    ...(alreadyAskingOwner.length > 0 ? { alreadyAskingOwner } : {}),
  };
}

// ── the model ─────────────────────────────────────────────────────────────────
async function runNoticingModelJob<T>(identity: Pick<StandaloneModelAccountingJobBinding, 'operation' | 'operationId' | 'revisionDigest'>,
  work: () => Promise<T>, capture?: (job: StandaloneModelAccountingJob) => void): Promise<{ value: T; modelAccountingJobId?: string }> {
  const job = createStandaloneModelAccountingJob(identity);
  capture?.(job);
  recordStandaloneModelAccountingJobObservation(job, { phase: 'job_started' });
  try {
    const value = await withStandaloneModelAccountingJob(job, work);
    recordStandaloneModelAccountingJobObservation(job, { phase: 'job_finished', outcome: 'returned' });
    return { value, modelAccountingJobId: standaloneModelAccountingJobBinding(job)?.usageJobId };
  } catch (error) {
    recordStandaloneModelAccountingJobObservation(job, { phase: 'job_finished', outcome: 'failed' });
    throw error;
  }
}
async function proposeWithConfiguredModel(input: Parameters<Parameters<typeof runNoticingTick>[0]['propose']>[0],
  tickId: string, capture: (job: StandaloneModelAccountingJob) => void) {
  const port = peekTurnSemanticModelPort();
  if (!port?.noticing) return null;
  const { value: reply, modelAccountingJobId } = await runNoticingModelJob({ operation: 'noticing_proposal',
    operationId: tickId, revisionDigest: input.evidenceDigest }, () => port.noticing!({
    purpose: NOTICING_PROPOSAL_PURPOSE,
    observation: input.observation,
    rules: input.rules,
    standingAnswers: input.standingAnswers.map((a) => ({ about: a.about, said: a.text })),
    recentProposals: input.recentProposals,
    evidenceDigest: input.evidenceDigest,
  }), capture);
  const parsed = NoticingAnswerV1Schema.safeParse(reply.answer);
  return parsed.success
    ? { answer: parsed.data, modelIdentity: reply.modelIdentity, modelAccountingJobId }
    : { answer: null, modelIdentity: reply.modelIdentity, modelAccountingJobId, error: `the model's answer was not well-formed: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
}

/** The owner's words, read into a decision. No regex on their text. */
export async function readNoticingAnswer(proposal: Pick<NoticingProposalRecord, 'title' | 'action'>, text: string,
  accounting?: { checkInId: string; answerDigest: string; capture: (job: StandaloneModelAccountingJob) => void },
): Promise<{ status: 'read' | 'unavailable'; decision: NoticingDecision; instruction?: string; modelIdentity?: string; modelAccountingJobId?: string }> {
  const port = peekTurnSemanticModelPort();
  if (!port?.readNoticingAnswer) return { status: 'unavailable', decision: 'unclear' };
  const digest = createHash('sha256').update(JSON.stringify({ title: proposal.title, action: proposal.action, text })).digest('hex');
  const call = () => port.readNoticingAnswer!({ purpose: NOTICING_ANSWER_PURPOSE, proposal: { title: proposal.title, action: proposal.action }, answer: text, evidenceDigest: digest });
  const { value: reply, modelAccountingJobId } = accounting
    ? await runNoticingModelJob({ operation: 'noticing_answer', operationId: accounting.checkInId,
      revisionDigest: accounting.answerDigest }, call, accounting.capture)
    : { value: await call(), modelAccountingJobId: undefined };
  if (reply.evidenceDigest !== digest || !['do_it', 'not_now', 'never', 'unclear'].includes(reply.decision)) {
    return { status: 'unavailable', decision: 'unclear', modelIdentity: reply.modelIdentity, modelAccountingJobId };
  }
  return { status: 'read', decision: reply.decision, ...(reply.instruction ? { instruction: reply.instruction } : {}), modelIdentity: reply.modelIdentity, modelAccountingJobId };
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
  (request: AssistantRequest): Promise<unknown>;
}
let respondImpl: NoticingRespond | null = null;
export function bindNoticingRespond(respond: NoticingRespond | null): void { respondImpl = respond; }

/** Settle every answered proposal: read the owner's words, and on a yes
 * start the work as an ordinary chat turn the owner can watch. */
let settlingAnswers: Promise<number> | null = null;
export function settleNoticingAnswers(now = Date.now()): Promise<number> {
  if (settlingAnswers) return settlingAnswers;
  settlingAnswers = settleNoticingAnswersOnce(now).finally(() => { settlingAnswers = null; });
  return settlingAnswers;
}

function answerIdentity(record: NoticingProposalRecord, checkIn: CheckInRecord): string {
  return digest({ proposalId: record.id, checkInId: checkIn.id,
    answer: checkIn.answer, answeredAt: checkIn.answeredAt });
}
function exactAnsweredCheckIn(record: NoticingProposalRecord, checkIn: CheckInRecord): boolean {
  const current = getCheckIn(checkIn.id);
  return record.checkInId === checkIn.id && current?.status === 'answered'
    && current.agentSlug === 'clementine' && current.contextSummary === `noticing:${record.id}`
    && current.answer === checkIn.answer && current.answeredAt === checkIn.answeredAt;
}
function setHandoff(record: NoticingProposalRecord, answerDigest: string,
  state: NonNullable<NoticingProposalRecord['handoff']>['state'], now: number,
  patch: Partial<NonNullable<NoticingProposalRecord['handoff']>> = {}): void {
  record.handoff = { ...patch, version: 1, answerDigest, state, updatedAt: new Date(now).toISOString() };
}

async function settleNoticingAnswersOnce(now: number): Promise<number> {
  let settled = 0;
  for (const record of Object.values(loadNoticingState().proposals)) {
    if (!record.checkInId) continue;
    if (record.status !== 'open' && record.status !== 'answered') continue;
    const checkIn = getCheckIn(record.checkInId);
    if (!checkIn || typeof checkIn.answer !== 'string' || !checkIn.answeredAt
      || !exactAnsweredCheckIn(record, checkIn)) continue;
    const answerDigest = answerIdentity(record, checkIn);
    if (!record.handoff && getHarnessChatRequestReceipt(`noticing-answer:${answerDigest}`)) {
      updateNoticingState(state => {
        const current = state.proposals[record.id];
        if (current && !current.handoff && proposalIdentity(current) === proposalIdentity(record)) {
          setHandoff(current, answerDigest, 'dispatched', now);
        }
      });
      record.handoff = loadNoticingState().proposals[record.id]?.handoff;
    }
    // Older versions could start a turn before saving the answer. Its absence
    // from the new journal is not proof that those effects never happened.
    if (record.answer?.decision && record.answer.decision !== 'unclear' && !record.handoff) {
      updateNoticingState(state => {
        const current = state.proposals[record.id];
        if (!current || current.handoff || proposalIdentity(current) !== proposalIdentity(record)) return;
        setHandoff(current, answerDigest, current.answer?.decision === 'do_it' ? 'needs_attention' : 'settled', now,
          current.answer?.decision === 'do_it' ? { reason: 'This earlier approval has no bound start record. Open the earlier chat and inspect its work before asking to continue; I will not start it again automatically.' } : {});
      });
      continue;
    }
    const alreadyRead = record.handoff?.answerDigest === answerDigest
      && record.answer?.text === checkIn.answer && record.handoff.state !== 'not_started';
    if (!alreadyRead && !(record.answer?.text === checkIn.answer && record.answer.decision === 'do_it'
      && record.handoff?.answerDigest === answerDigest)) {
      let read: Awaited<ReturnType<typeof readNoticingAnswer>>;
      let answerJob: StandaloneModelAccountingJob | undefined;
      try { read = await readNoticingAnswer(record, checkIn.answer,
        { checkInId: checkIn.id, answerDigest, capture: job => { answerJob = job; } }); }
      catch { read = { status: 'unavailable', decision: 'unclear' }; }
      const acceptedRead = updateNoticingState(state => {
        const current = state.proposals[record.id];
        if (!current || proposalIdentity(current) !== proposalIdentity(record)
          || !exactAnsweredCheckIn(current, checkIn)) return false;
        if (current.handoff?.answerDigest === answerDigest && current.answer?.text === checkIn.answer
          && (current.handoff.state !== 'not_started' || current.answer?.decision === 'do_it')) return false;
        if (read.status === 'unavailable') {
          setHandoff(current, answerDigest, 'not_started', now,
            { reason: 'I could not read your answer yet. No work was started; I will check again when the model is available.' });
          return false;
        }
        recordNoticingAnswer(state, { proposalId: record.id, text: checkIn.answer!, decision: read.decision,
          ...(read.instruction ? { instruction: read.instruction } : {}), at: checkIn.answeredAt! });
        if (read.modelAccountingJobId && current.answer) current.answer.modelAccountingJobId = read.modelAccountingJobId;
        setHandoff(current, answerDigest, read.decision === 'unclear' ? 'needs_attention'
          : read.decision === 'do_it' ? 'not_started' : 'settled', now,
          read.decision === 'unclear' ? { reason: 'I could not tell whether you want this proposal started. Open a chat and say what you want to do; no work was started.' } : {});
        return true;
      });
      if (acceptedRead && answerJob) {
        try {
          const retained = readNoticingStateStrict().state.proposals[record.id]?.answer;
          if (retained?.modelAccountingJobId === read.modelAccountingJobId) recordStandaloneModelAccountingJobObservation(answerJob,
            { phase: 'operation_receipt', receiptDigest: digest(retained) });
        } catch { /* Missing receipt proof remains unknown; answer behavior is unchanged. */ }
      }
      if (acceptedRead) settled++;
    }
    const current = loadNoticingState().proposals[record.id];
    if (current?.answer?.decision !== 'do_it' || current.answer.text !== checkIn.answer
      || current.handoff?.answerDigest !== answerDigest) continue;
    try { await startProposalTurn(current, checkIn, answerDigest, now); }
    catch (error) {
      logger.warn({ proposalId: record.id, err: error instanceof Error ? error.message : String(error) }, 'noticing: approved proposal needs recovery');
      updateNoticingState(state => {
        const current = state.proposals[record.id];
        if (!current || current.handoff?.answerDigest !== answerDigest) return;
        setHandoff(current, answerDigest, 'needs_attention', now, { ...current.handoff,
          reason: 'The approved task could not be confirmed. Open its existing chat to inspect progress before retrying; I did not start a second copy.' });
      });
    }
  }
  return settled;
}

function refreshHandoff(recordId: string, answerDigest: string, source: EventRow, requestId: string, now: number): void {
  const terminal = exactTerminalForAcceptedSource(source);
  const attempt = getRunAttemptBySourceUserSeq(source.sessionId, source.seq);
  const stopped = isKillRequested(source.sessionId, { sourceUserSeq: source.seq });
  const state = terminal?.presentation.status === 'done' ? 'settled'
    : terminal || stopped || !attempt || attempt.status !== 'active' ? 'needs_attention' : 'dispatched';
  const reason = state === 'settled' ? undefined
    : stopped || terminal?.presentation.status === 'cancelled' || attempt?.status === 'cancelled'
      ? 'You stopped this task. Open its existing chat to inspect completed and uncertain work before continuing.'
    : terminal ? 'This task needs your attention. Open its existing chat for the retained result or question.'
    : state === 'dispatched' ? 'The approved task is in its existing chat.'
    : 'The request was accepted, but its start or result is not confirmed. Open its existing chat before retrying; no second copy was started.';
  updateNoticingState(stateFile => {
    const record = stateFile.proposals[recordId];
    if (record?.handoff?.answerDigest !== answerDigest) return;
    setHandoff(record, answerDigest, state, now, { sessionId: source.sessionId,
      sourceUserSeq: source.seq, requestId, ...(reason ? { reason } : {}) });
  });
}

async function startProposalTurn(record: NoticingProposalRecord, checkIn: CheckInRecord,
  answerDigest: string, now: number): Promise<void> {
  const requestId = `noticing-answer:${answerDigest}`;
  const prior = getHarnessChatRequestReceipt(requestId);
  if (!prior && record.handoff?.state === 'needs_attention') return;
  if (!prior && !respondImpl) {
    updateNoticingState(state => {
      const current = state.proposals[record.id];
      if (current?.handoff?.answerDigest === answerDigest) setHandoff(current, answerDigest, 'not_started', now,
        { reason: 'The chat runner is not available yet. No task was accepted or started; I will try when it is available.' });
    });
    return;
  }
  const accepted = updateNoticingState(state => {
    const current = state.proposals[record.id];
    const answer = current?.answer;
    if (!current || proposalIdentity(current) !== proposalIdentity(record)
      || answer?.decision !== 'do_it' || !exactAnsweredCheckIn(current, checkIn)) return null;
    const sessionId = `sess-noticing-${answerDigest.slice(0, 32)}`;
    const runId = `noticing-run:${answerDigest}`;
    return withEventPublicationTransaction(() => {
      const existing = getHarnessChatRequestReceipt(requestId);
      if (existing) {
        const source = listEvents(existing.sessionId, { types: ['user_input_received'], sinceSeq: existing.sinceSeq })
          .find(event => (event.data.noticingApprovedTask as { requestId?: string } | undefined)?.requestId === requestId);
        if (existing.sessionId !== sessionId || existing.runId !== runId || !source
          || !readAcceptedNoticingTask({ sessionId, sourceUserSeq: source.seq })) throw new Error('Approved task receipt has no exact retained source.');
        return { inserted: false, source, runId };
      }
      const goal = current.goalId ? listGoalRecords().find(goal => goal.id === current.goalId) ?? null : null;
      const packet: NoticingApprovedTaskPacket = {
        version: 1,
        proposal: { id: current.id, checkInId: checkIn.id, title: current.title, action: current.action,
          why: current.why, evidence: [...current.evidence], goalId: current.goalId, createdAt: current.createdAt },
        checkIn: { id: checkIn.id, question: checkIn.question,
          ...(checkIn.contextSummary ? { contextSummary: checkIn.contextSummary } : {}),
          answer: checkIn.answer!, answeredAt: checkIn.answeredAt! },
        decision: { kind: 'do_it', ...(answer.instruction ? { instruction: answer.instruction } : {}) },
        constraints: { rules: readNoticingRulesStrict().rules,
          standingAnswers: structuredClone(state.standingAnswers) },
        goal: goal ? { ...goal } : null,
      };
      const inputHash = noticingApprovedTaskDigest(packet);
      const session = getSession(sessionId);
      if (session && session.metadata?.noticingRequestId !== requestId) throw new Error('Approved task chat identity is already in use.');
      if (!session) createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: current.title,
        metadata: { source: 'noticing', proposalId: current.id, noticingRequestId: requestId } });
      const claimed = claimHarnessChatRequestInTransaction(openEventLog(), { requestId, sessionId, runId,
        inputHash, sinceSeq: getLatestEventSeq(sessionId) });
      if (!claimed.inserted) throw new Error('Approved task acceptance changed.');
      const source = acceptUserInputForRun({ sessionId, turn: 1, role: 'user', data: {
        text: checkIn.answer, displayText: checkIn.answer, runId, source: 'noticing_answer',
        noticingApprovedTask: { requestId, digest: inputHash, packet },
      } });
      setHandoff(current, answerDigest, 'dispatched', now, { sessionId, sourceUserSeq: source.seq, requestId,
        reason: 'The approved task was accepted in this chat; completion is not yet confirmed.' });
      return { inserted: true, source, runId };
    });
  });
  if (!accepted) return;
  if (!accepted.inserted) {
    refreshHandoff(record.id, answerDigest, accepted.source, requestId, now);
    return;
  }
  // The durable receipt is spent before entering the runner. Crash, Stop or
  // an unknown callback result can never grant another automatic dispatch.
  await respondImpl!({ sessionId: accepted.source.sessionId, channel: 'desktop',
    message: checkIn.answer!, sourceUserSeq: accepted.source.seq, runId: accepted.runId });
  refreshHandoff(record.id, answerDigest, accepted.source, requestId, Date.now());
}

// ── ticking ───────────────────────────────────────────────────────────────────
let inFlight: Promise<NoticingTickResult> | null = null;

export function runNoticingTickNow(options: { source: string } = { source: 'heartbeat' }): Promise<NoticingTickResult> {
  if (inFlight) return inFlight;
  const capturedRules = readNoticingRulesStrict();
  const policy = noticingPolicy();
  const tickId = `ntc-${Date.now().toString(36)}`;
  const rules = capturedRules.rules;
  const generation = (snapshot: ReturnType<typeof readNoticingStateStrict>, rules: ReturnType<typeof readNoticingRulesStrict>) =>
    digest({ present: snapshot.present, proposals: snapshot.state.proposals,
      standingAnswers: snapshot.state.standingAnswers, ruleFilePresent: rules.present, rules: rules.rules });
  let publicationGeneration: string | undefined;
  let tickJob: StandaloneModelAccountingJob | undefined;
  inFlight = settleNoticingAnswers().catch(() => 0).then(() => runNoticingTick({
    now: () => Date.now(),
    tickId,
    source: options.source,
    config: { ...DEFAULT_NOTICING_CONFIG, dailyCap: policy.dailyCap },
    rules,
    observe: () => observeForNoticing(),
    propose: input => proposeWithConfiguredModel(input, tickId, job => { tickJob = job; }),
    ask: askViaCheckIn,
    isAnswered: (checkInId) => {
      const row = getCheckIn(checkInId);
      if (row?.status === 'answered' && typeof row.answer === 'string') {
        return { answered: true, text: row.answer, ...(row.answeredAt ? { at: row.answeredAt } : {}) };
      }
      return { answered: false, ...(row && row.status !== 'open' && row.status !== 'answered' ? { closed: true } : {}) };
    },
    loadState: () => {
      const snapshot = readNoticingStateStrict();
      publicationGeneration = generation(snapshot, capturedRules);
      return snapshot.state;
    },
    publicationStillCurrent: () => publicationGeneration !== undefined
      && publicationGeneration === generation(readNoticingStateStrict(), readNoticingRulesStrict()),
    saveState: saveNoticingState,
  })).then((result) => {
    if (tickJob && result.modelAccountingJobId) {
      try {
        const retained = readNoticingStateStrict().state.thinking.find(row => row.tickId === tickId
          && row.modelAccountingJobId === result.modelAccountingJobId);
        if (retained) recordStandaloneModelAccountingJobObservation(tickJob,
          { phase: 'operation_receipt', receiptDigest: digest(retained) });
      } catch { /* An unavailable retained receipt cannot become proof from this result. */ }
    }
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
  const proposals = Object.values(state.proposals).map(proposal => {
    if (!proposal.answer) return proposal;
    const { modelAccountingJobId: _accounting, ...answer } = proposal.answer;
    return { ...proposal, answer };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = state.thinking[0];
  return {
    id: NOTICING_ID,
    title: 'Noticing',
    purpose: 'Looks across your goals and what is happening — runs, waits, drafts, the calendar, recent conversations, what she remembers — and proposes one thing worth doing, with its evidence. She acts only when you say so.',
    enabled: policy.enabled,
    cadenceMinutes: policy.cadenceMinutes,
    dailyCap: policy.dailyCap,
    quietHoursActive: policy.quietHoursActive,
    running: inFlight !== null || settlingAnswers !== null,
    ...(state.lastTickAt ? { lastTickAt: state.lastTickAt } : {}),
    ...(due.nextAt ? { nextTickAt: due.nextAt } : {}),
    ...(latest ? { lastFinding: { at: latest.at, summary: latest.summary, quiet: latest.quiet, durationMs: latest.durationMs } } : {}),
    ...(latest?.error ? { lastError: { at: latest.at, reason: latest.error } } : {}),
    metrics: state.metrics,
    openItems: proposals.filter((p) => p.status === 'open' || (p.handoff && p.handoff.state !== 'settled')),
    recentlyRetired: proposals.filter((p) => p.status !== 'open' && (!p.handoff || p.handoff.state === 'settled')).slice(0, 20),
    thinking: state.thinking.map(({ modelAccountingJobId: _accounting, ...thinking }) => thinking),
    standingAnswers: state.standingAnswers,
  };
}
export { NOTICING_SESSION_ID };
