/**
 * Noticing — the pure half of the heartbeat that lets Clementine say "we
 * should do this" on her own.
 *
 * On its cadence it reads only what the runtime already holds — the owner's
 * goals and their progress, the work that ran (runs, waits, drafts), the
 * calendar watch's open items, recent conversations, facts remembered — and
 * asks one model one bounded question: given what the owner is actually
 * doing, is there ONE thing worth proposing now? The answer is at most one
 * proposal, tied to a goal where it can be, with the evidence it rests on,
 * and a list of what was considered and set aside, with why.
 *
 * Everything the model said is written down as the tick's thinking, so the
 * owner can see what she read, what she weighed and why she did or did not
 * speak. Deterministic code owns only the boundaries: the cadence, the daily
 * cap, deduplication against what was already proposed, the owner's standing
 * answers ("never for this"), and quiet hours. Nothing here names a provider,
 * a tool or a kind of task.
 *
 * A proposal is a question for the owner (a check-in), answered in their own
 * words. She proposes; she acts only on a yes, through an ordinary turn.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GoalOutcomeProgress, GoalOutcomeTask, GoalWorkflowOutcome } from './goal-outcome-progress.js';

export const NOTICING_ID = 'noticing';
export const NOTICING_SESSION_ID = 'watch:noticing';

// ── what a tick reads ─────────────────────────────────────────────────────────
export interface NoticingGoalView {
  id: string;
  title: string;
  status: string;
  priority: string;
  updatedAt: string;
  targetDate?: string;
  progressNotes: string[];
  nextActions: string[];
  blockers: string[];
  /** Derived retained evidence only; never a goal-status or permission grant. */
  outcomeProgress?: NoticingGoalOutcomeProgress;
}
export interface NoticingGoalOutcomeProgress {
  version: 1;
  availability: GoalOutcomeProgress['availability'];
  summary: string;
  linkedTasks: Array<Pick<GoalOutcomeTask, 'proposalId' | 'sessionId' | 'sourceUserSeq' | 'state' | 'goalBinding'> & {
    workflows: Array<Pick<GoalWorkflowOutcome, 'runId' | 'state' | 'artifactReadback'> & {
      criteria: { total: number; passed: number; remaining: string[]; omittedRemaining: number };
    }>;
    omittedWorkflows: number;
  }>;
  omittedTasks: number;
}

/** Bounded context for one existing Noticing decision. Complete packets and
 * outcome evidence remain available through the original chat and Goals UI. */
export function compactGoalOutcomeProgressForNoticing(progress: GoalOutcomeProgress): NoticingGoalOutcomeProgress {
  const clipText = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
  // An identity is either kept exactly or omitted with its whole entry.
  const boundedId = (id: string): boolean => id.length <= 160;
  const linkedTasks = progress.linkedTasks.filter(task => boundedId(task.proposalId)
    && (task.sessionId === undefined || boundedId(task.sessionId))).slice(0, 2).map(task => {
    const workflows = task.workflows.filter(workflow => boundedId(workflow.runId)).slice(0, 2).map(workflow => {
      const remaining = workflow.criteria.remaining.slice(0, 2).map(criterion => clipText(criterion, 120));
      return { runId: workflow.runId, state: workflow.state, artifactReadback: workflow.artifactReadback,
        criteria: { total: workflow.criteria.total, passed: workflow.criteria.passed, remaining,
          omittedRemaining: Math.max(0, workflow.criteria.total - workflow.criteria.passed - remaining.length) } };
    });
    return { proposalId: task.proposalId, ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.sourceUserSeq !== undefined ? { sourceUserSeq: task.sourceUserSeq } : {}),
      state: task.state, goalBinding: task.goalBinding, workflows,
      omittedWorkflows: task.omittedWorkflows + task.workflows.length - workflows.length };
  });
  return { version: 1, availability: progress.availability, summary: clipText(progress.summary, 180), linkedTasks,
    omittedTasks: progress.omittedTasks + progress.linkedTasks.length - linkedTasks.length };
}

export interface NoticingObservation {
  at: string;
  goals: NoticingGoalView[];
  work: {
    runs: Array<{ workflow: string; status: string; finishedAt?: string; error?: string }>;
    waits: Array<{ title: string; waitingOn: string; since: string }>;
    drafts: Array<{ name: string; modifiedAt: string }>;
  };
  calendar: Array<{ kind: string; subject: string; createdAt: string }>;
  conversations: Array<{ title: string; updatedAt: string; lastRequest?: string }>;
  memories: Array<{ text: string; ageDays: number }>;
  /** What another part of Clem has already put to the owner as a question on
   * Home (a reply-needed invite, a double booking, a stuck wait): one open
   * thing is one card, so it is never proposed again from here. */
  alreadyAskingOwner?: Array<{ from: string; about: string }>;
}

// ── what the model answers ────────────────────────────────────────────────────
export const NoticingProposalV1Schema = z.object({
  title: z.string().min(1).max(160),
  /** What Clem would do, written as the request she would make of herself. */
  action: z.string().min(1).max(600),
  why: z.string().min(1).max(800),
  /** The exact observations the proposal rests on, as the owner would recognise them. */
  evidence: z.array(z.string().min(1).max(200)).min(1).max(6),
  goalId: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
});
/** What the model answers; the port binds it to the evidence digest. */
export const NoticingAnswerWireV1Schema = z.object({
  proposal: NoticingProposalV1Schema.nullable(),
  setAside: z.array(z.object({ subject: z.string().min(1).max(160), why: z.string().min(1).max(300) })).max(8),
}).strict();
export const NoticingAnswerV1Schema = NoticingAnswerWireV1Schema.extend({
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type NoticingProposalV1 = z.infer<typeof NoticingProposalV1Schema>;
export type NoticingAnswerV1 = z.infer<typeof NoticingAnswerV1Schema>;

/** The owner's answer to a proposal, read by a model from their words. */
export type NoticingDecision = 'do_it' | 'not_now' | 'never' | 'unclear';

// ── durable state ─────────────────────────────────────────────────────────────
export interface NoticingProposalRecord extends NoticingProposalV1 {
  id: string;
  /** Digest of what the proposal is about; the dedupe key. */
  shapeKey: string;
  createdAt: string;
  checkInId?: string;
  notificationId?: string;
  status: 'open' | 'answered' | 'expired' | 'retired';
  answer?: { text: string; decision: NoticingDecision; at: string; instruction?: string; modelAccountingJobId?: string };
  retiredReason?: string;
  /** Presentation/progress only. The normal accepted ingress and execution
   * ledgers, never this record, own consent, account and effect authority. */
  handoff?: {
    version: 1;
    answerDigest: string;
    state: 'not_started' | 'dispatched' | 'needs_attention' | 'settled';
    updatedAt: string;
    sessionId?: string;
    sourceUserSeq?: number;
    requestId?: string;
    reason?: string;
  };
}

export interface NoticingProposalCoverage {
  availability: 'complete' | 'partial' | 'unavailable';
  omitted: number;
}
export interface NoticingProposalSnapshot {
  proposals: NoticingProposalRecord[];
  coverage: NoticingProposalCoverage;
  unavailableGoalIds: string[];
  unknownGoalAssociation: boolean;
}

const retainedTime = z.string().refine(value => Number.isFinite(Date.parse(value)));
const retainedId = z.string().min(1).max(256);
const NoticingProposalProjectionSchema = NoticingProposalV1Schema.extend({
  id: retainedId, shapeKey: z.string().min(1), createdAt: retainedTime,
  checkInId: retainedId.optional(), notificationId: retainedId.optional(),
  status: z.enum(['open', 'answered', 'expired', 'retired']),
  retiredReason: z.string().optional(),
  answer: z.object({ text: z.string(), decision: z.enum(['do_it', 'not_now', 'never', 'unclear']),
    at: retainedTime, instruction: z.string().optional(), modelAccountingJobId: z.string().optional() }).optional(),
  handoff: z.object({ version: z.literal(1), answerDigest: z.string().min(1),
    state: z.enum(['not_started', 'dispatched', 'needs_attention', 'settled']), updatedAt: retainedTime,
    sessionId: retainedId.optional(), sourceUserSeq: z.number().int().positive().optional(),
    requestId: retainedId.optional(), reason: z.string().optional() }).optional(),
});

/** Presentation and relationship inventory only. Never repairs stored state,
 * closes a question, accepts an answer, or grants task/execution authority. */
export function projectNoticingProposalSnapshot(value: unknown): NoticingProposalSnapshot {
  const snapshot: NoticingProposalSnapshot = { proposals: [], coverage: { availability: 'complete', omitted: 0 },
    unavailableGoalIds: [], unknownGoalAssociation: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    snapshot.coverage.availability = 'unavailable'; snapshot.unknownGoalAssociation = true;
    return snapshot;
  }
  const unavailableGoals = new Set<string>();
  for (const [key, candidate] of Object.entries(value)) {
    const parsed = NoticingProposalProjectionSchema.safeParse(candidate);
    if (parsed.success && parsed.data.id === key) {
      // The validator's parsed projection keeps only declared fields; callers
      // separately whitelist public answers, retaining accounting in storage.
      snapshot.proposals.push(parsed.data);
      continue;
    }
    snapshot.coverage.availability = 'partial'; snapshot.coverage.omitted += 1;
    const goalId = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>).goalId : undefined;
    if (typeof goalId === 'string' && goalId.length > 0) unavailableGoals.add(goalId);
    else if (goalId !== null) snapshot.unknownGoalAssociation = true;
  }
  snapshot.unavailableGoalIds = [...unavailableGoals];
  snapshot.proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return snapshot;
}

export interface PublicNoticingAnswer {
  text: string;
  decision: NoticingDecision;
  at: string;
  instruction?: string;
}

/** Public presentation only. Stored answer records retain their private
 * accounting links, and future internal fields do not expand this DTO. */
export function publicNoticingAnswer(answer: NoticingProposalRecord['answer']): PublicNoticingAnswer | null {
  return answer ? { text: answer.text, decision: answer.decision, at: answer.at,
    ...(answer.instruction !== undefined ? { instruction: answer.instruction } : {}) } : null;
}

export interface NoticingStandingAnswer {
  /** The owner's words, kept as they said them. */
  text: string;
  /** The proposal they said it about. */
  about: string;
  at: string;
}
export interface NoticingThinking {
  tickId: string;
  at: string;
  source: string;
  durationMs: number;
  read: { goals: number; runs: number; waits: number; drafts: number; calendar: number; conversations: number; memories: number };
  considered: Array<{ subject: string; outcome: 'proposed' | 'set_aside' | 'duplicate' | 'standing_no' | 'capped' | 'low_confidence'; why: string }>;
  proposalId?: string;
  model?: string;
  /** Host invocation identity only; never execution or completion authority. */
  modelAccountingJobId?: string;
  quiet: boolean;
  summary: string;
  error?: string;
  modelCheck?: 'fresh' | 'no_local_evidence' | 'recent_unchanged';
}
export interface NoticingState {
  version: 1;
  lastTickAt?: string;
  lastTickId?: string;
  proposals: Record<string, NoticingProposalRecord>;
  standingAnswers: NoticingStandingAnswer[];
  thinking: NoticingThinking[];
  /** Bounded reuse of a successful proposal decision; not execution evidence. */
  decisionReuse?: { version: 1; fingerprint: string; decidedAt: string };
  metrics: {
    ticks: number; quietTicks: number; modelCalls: number; modelFailures: number;
    itemsProduced: number; itemsAcknowledged: number; itemsRetired: number;
    doIt: number; notNow: number; never: number;
  };
}
export function emptyNoticingState(): NoticingState {
  return { version: 1, proposals: {}, standingAnswers: [], thinking: [],
    metrics: { ticks: 0, quietTicks: 0, modelCalls: 0, modelFailures: 0, itemsProduced: 0, itemsAcknowledged: 0, itemsRetired: 0, doIt: 0, notNow: 0, never: 0 } };
}

export interface NoticingConfig {
  /** Proposals the owner may receive per rolling day. */
  dailyCap: number;
  /** Below this the model's proposal is set aside, not sent. */
  minConfidence: number;
  /** How long an open proposal waits for an answer. */
  openForMs: number;
  /** How long "not now" keeps the same proposal quiet. */
  notNowForMs: number;
  thinkingKept: number;
}
export const DEFAULT_NOTICING_CONFIG: NoticingConfig = {
  dailyCap: 2, minConfidence: 0.6, openForMs: 3 * 24 * 60 * 60_000, notNowForMs: 3 * 24 * 60 * 60_000, thinkingKept: 40,
};

export interface NoticingTickDeps {
  now: () => number;
  tickId: string;
  source: string;
  config: NoticingConfig;
  /** The owner's own rules for this heartbeat, in their words. */
  rules: string[];
  observe: () => Promise<NoticingObservation>;
  /** The one model call. Null when no model is available. */
  propose: (input: { observation: NoticingObservation; rules: string[]; standingAnswers: NoticingStandingAnswer[]; recentProposals: Array<{ title: string; status: string; createdAt: string }>; evidenceDigest: string })
    => Promise<{ answer: NoticingAnswerV1 | null; modelIdentity?: string; error?: string; modelAccountingJobId?: string } | null>;
  /** Open the question for the owner; returns ids the answer path needs. */
  ask: (proposal: NoticingProposalRecord) => Promise<{ checkInId: string; notificationId?: string }>;
  /** `closed`: the question was dismissed or closed without an answer
   *  (Needs you's Clean up, a reply elsewhere): the proposal is settled. */
  isAnswered: (checkInId: string) => { answered: boolean; closed?: boolean; text?: string; at?: string };
  loadState: () => NoticingState;
  saveState: (state: NoticingState) => void;
  /** Optional host fence over the state/rules captured by loadState. Reads
   * metadata only; a changed generation cannot publish a stale suggestion. */
  publicationStillCurrent?: () => boolean;
}
export interface NoticingTickResult extends NoticingThinking { produced: number; retired: number }

export function proposalShapeKey(proposal: Pick<NoticingProposalV1, 'title' | 'action' | 'goalId'>): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return createHash('sha256').update(`${norm(proposal.title)}|${norm(proposal.action)}|${proposal.goalId ?? ''}`).digest('hex').slice(0, 16);
}
function similarTitles(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  const wa = words(a); const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0; for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

export function observationDigest(observation: NoticingObservation, rules: string[]): string {
  return createHash('sha256').update(JSON.stringify({ observation, rules })).digest('hex');
}

// The normal default cadence is three hours, so this deliberately short reuse
// window helps empty/repeated local checks and a custom 30-minute cadence; it
// does not imply fewer model calls on the default cadence. Skips never renew it.
export const NOTICING_DECISION_REUSE_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function hasLocalNoticingEvidence(observation: NoticingObservation): boolean {
  return observation.goals.length > 0 || observation.work.runs.length > 0
    || observation.work.waits.length > 0 || observation.work.drafts.length > 0
    || observation.calendar.length > 0
    || observation.conversations.some(row => Boolean(row.lastRequest?.trim()))
    || observation.memories.some(row => Boolean(row.text.trim()))
    || Boolean(observation.alreadyAskingOwner?.some(row => Boolean(row.about.trim())));
}

function hasTimeSensitiveNoticingEvidence(observation: NoticingObservation): boolean {
  // Calendar items and waits have relative urgency. A target date may be in
  // an owner's local timezone or malformed legacy data: do not reinterpret
  // any of those clocks or infer deadlines by reading prose to skip a check.
  return observation.calendar.length > 0 || observation.work.waits.length > 0
    || observation.goals.some(goal => goal.targetDate !== undefined);
}

function noticingDecisionFingerprint(observation: NoticingObservation, deps: NoticingTickDeps,
  state: NoticingState, now: number): string {
  const { at: _clock, ...evidence } = observation;
  const ageDays = (at: string | undefined): number | null => {
    const timestamp = at ? Date.parse(at) : Number.NaN;
    return Number.isFinite(timestamp) ? Math.floor((now - timestamp) / DAY_MS) : null;
  };
  const proposals = Object.entries(state.proposals).sort(([a], [b]) => a.localeCompare(b)).map(([id, proposal]) => {
    const created = Date.parse(proposal.createdAt);
    const answered = proposal.answer ? Date.parse(proposal.answer.at) : Number.NaN;
    const { modelAccountingJobId: _accounting, ...answer } = proposal.answer ?? {};
    const semanticProposal = proposal.answer ? { ...proposal, answer } : proposal;
    return { id, proposal: semanticProposal,
      countsToday: created >= now - DAY_MS && proposal.status !== 'retired',
      recent: now - created < 14 * DAY_MS,
      openExpired: proposal.status === 'open' && now - created > deps.config.openForMs,
      notNowQuiet: proposal.answer?.decision === 'not_now' && now - answered < deps.config.notNowForMs,
      doItQuiet: proposal.answer?.decision === 'do_it' && now - answered < 7 * DAY_MS,
    };
  });
  // Omit the observation clock and diagnostic-only model accounting IDs.
  // Preserve all evidence, user words, handoff changes,
  // rules and policy; include relative ages and exact existing expiry floors
  // so their transitions invalidate reuse even inside the finite window.
  return createHash('sha256').update(JSON.stringify({ version: 1, evidence,
    ages: { goals: observation.goals.map(goal => ageDays(goal.updatedAt)),
      runs: observation.work.runs.map(run => ageDays(run.finishedAt)),
      drafts: observation.work.drafts.map(draft => ageDays(draft.modifiedAt)),
      conversations: observation.conversations.map(conversation => ageDays(conversation.updatedAt)) },
    rules: deps.rules, standingAnswers: state.standingAnswers, proposals, config: deps.config,
  })).digest('hex');
}

function canReuseNoticingDecision(state: NoticingState, fingerprint: string, now: number): boolean {
  const previous = state.decisionReuse;
  const decidedAt = typeof previous?.decidedAt === 'string' ? Date.parse(previous.decidedAt) : Number.NaN;
  return previous?.version === 1 && typeof previous.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(previous.fingerprint)
    && previous.fingerprint === fingerprint && Number.isFinite(decidedAt)
    && now >= decidedAt && now - decidedAt < NOTICING_DECISION_REUSE_MS;
}

/** One tick: read, think, maybe ask, write the thinking down. */
export async function runNoticingTick(deps: NoticingTickDeps): Promise<NoticingTickResult> {
  const startedAt = deps.now();
  const nowIso = new Date(startedAt).toISOString();
  const state = deps.loadState();
  const considered: NoticingThinking['considered'] = [];
  let read: NoticingThinking['read'] = { goals: 0, runs: 0, waits: 0, drafts: 0, calendar: 0, conversations: 0, memories: 0 };
  let proposalId: string | undefined;
  let model: string | undefined;
  let modelAccountingJobId: string | undefined;
  let error: string | undefined;
  let produced = 0;
  let retired = 0;
  let modelCheck: NoticingThinking['modelCheck'];
  let publicationDeferred: 'changed' | 'unavailable' | undefined;
  const publicationStillCurrent = (): boolean => {
    if (!deps.publicationStillCurrent) return true;
    try {
      if (deps.publicationStillCurrent() === true) return true;
      publicationDeferred = 'changed';
    } catch { publicationDeferred = 'unavailable'; }
    delete state.decisionReuse;
    return false;
  };
  state.metrics.ticks += 1;
  state.lastTickAt = nowIso;
  state.lastTickId = deps.tickId;

  // 1. Settle what the owner already answered, and expire what they did not.
  for (const record of Object.values(state.proposals)) {
    if (record.status !== 'open') continue;
    const answered = record.checkInId ? deps.isAnswered(record.checkInId) : { answered: false };
    if (answered.answered && answered.text !== undefined) {
      // The decision is read by a model elsewhere (the runtime); here the
      // record only moves out of "open" so it is not expired underneath.
      if (!record.answer) record.answer = { text: answered.text, decision: 'unclear', at: answered.at ?? nowIso };
      record.status = 'answered';
      state.metrics.itemsAcknowledged += 1;
      continue;
    }
    // A question closed without an answer settles its proposal now; left
    // open, it kept asking (as From Clem) about something already put away.
    if (answered.closed) {
      record.status = 'retired'; record.retiredReason = 'its question was closed without an answer'; retired += 1; state.metrics.itemsRetired += 1;
      continue;
    }
    if (startedAt - Date.parse(record.createdAt) > deps.config.openForMs) {
      record.status = 'expired'; record.retiredReason = 'no answer'; retired += 1; state.metrics.itemsRetired += 1;
    }
  }

  // 2. Read.
  let observation: NoticingObservation | null = null;
  try {
    observation = await deps.observe();
    read = { goals: observation.goals.length, runs: observation.work.runs.length, waits: observation.work.waits.length,
      drafts: observation.work.drafts.length, calendar: observation.calendar.length,
      conversations: observation.conversations.length, memories: observation.memories.length };
  } catch (err) {
    error = `could not read: ${err instanceof Error ? err.message : String(err)}`;
    observation = null;
  }

  // 3. The boundaries the model does not own: the daily cap.
  const dayAgo = startedAt - 24 * 60 * 60_000;
  const sentToday = Object.values(state.proposals).filter((p) => Date.parse(p.createdAt) >= dayAgo && p.status !== 'retired').length;
  const capped = sentToday >= deps.config.dailyCap;

  // 4. Think, unless there is nothing to read or no room to speak.
  let answer: NoticingAnswerV1 | null = null;
  // No model signed in yet is a home that is not set up, not a failure:
  // the tick is quiet and says so plainly, never as "Could not finish".
  let waitingForModel = false;
  const noLocalEvidence = observation !== null && !hasLocalNoticingEvidence(observation);
  const ordinaryTick = deps.source === 'heartbeat' || deps.source === 'boot';
  const unchanged = observation !== null && !noLocalEvidence && ordinaryTick
    && !hasTimeSensitiveNoticingEvidence(observation)
    && canReuseNoticingDecision(state, noticingDecisionFingerprint(observation, deps, state, startedAt), startedAt);
  if (noLocalEvidence) modelCheck = 'no_local_evidence';
  else if (unchanged && !capped) modelCheck = 'recent_unchanged';
  if (observation && !capped && !noLocalEvidence && !unchanged) {
    modelCheck = 'fresh';
    // Do not retain an older success through a failed fresh check, manual
    // reconsideration, model outage, malformed reply or failed publication.
    delete state.decisionReuse;
    const evidenceDigest = observationDigest(observation, deps.rules);
    const recent = Object.values(state.proposals)
      .filter((p) => startedAt - Date.parse(p.createdAt) < 14 * 24 * 60 * 60_000)
      .map((p) => ({ title: p.title, status: p.answer ? `${p.status}: ${p.answer.decision}` : p.status, createdAt: p.createdAt }));
    try {
      const reply = await deps.propose({ observation, rules: deps.rules, standingAnswers: state.standingAnswers, recentProposals: recent, evidenceDigest });
      if (reply === null) {
        waitingForModel = true;
      } else {
        state.metrics.modelCalls += 1;
        model = reply.modelIdentity;
        modelAccountingJobId = reply.modelAccountingJobId;
        if (reply.error) { error = reply.error; state.metrics.modelFailures += 1; }
        else {
          const parsed = NoticingAnswerV1Schema.safeParse(reply.answer);
          if (!parsed.success) { error = 'the model answered in an invalid shape'; state.metrics.modelFailures += 1; }
          else if (parsed.data.evidenceDigest === evidenceDigest) answer = parsed.data;
          else { error = 'the model answered for different evidence'; state.metrics.modelFailures += 1; }
        }
      }
    } catch (err) {
      error = `the model could not be asked: ${err instanceof Error ? err.message : String(err)}`;
      state.metrics.modelFailures += 1;
    }
  }

  if (!observation || noLocalEvidence || capped) delete state.decisionReuse;
  // A reply is bound to the exact evidence the model saw, but an owner may
  // have answered/dismissed another proposal or changed a rule while it was
  // thinking. Do not publish or cache that now-stale decision, or pay for an
  // immediate replacement; the next scheduled check can reconsider it.
  if (answer && !publicationStillCurrent()) answer = null;
  if (capped) considered.push({ subject: 'anything new', outcome: 'capped', why: `${sentToday} proposal${sentToday === 1 ? '' : 's'} already sent today (cap ${deps.config.dailyCap})` });
  for (const aside of answer?.setAside ?? []) considered.push({ subject: aside.subject, outcome: 'set_aside', why: aside.why });

  // 5. Judge the one proposal against the boundaries, then ask.
  if (answer?.proposal) {
    const proposal = answer.proposal;
    const shapeKey = proposalShapeKey(proposal);
    const standingNo = state.standingAnswers.find((a) => similarTitles(a.about, proposal.title));
    const duplicate = Object.values(state.proposals).find((p) => (
      (p.shapeKey === shapeKey || similarTitles(p.title, proposal.title))
      && (p.status === 'open'
        || (p.status === 'answered' && p.answer?.decision === 'not_now' && startedAt - Date.parse(p.answer.at) < deps.config.notNowForMs)
        || (p.status === 'answered' && p.answer?.decision === 'do_it' && startedAt - Date.parse(p.answer.at) < 7 * 24 * 60 * 60_000))
    ));
    if (proposal.confidence < deps.config.minConfidence) {
      considered.push({ subject: proposal.title, outcome: 'low_confidence', why: `confidence ${proposal.confidence.toFixed(2)} below ${deps.config.minConfidence}` });
    } else if (standingNo) {
      considered.push({ subject: proposal.title, outcome: 'standing_no', why: `you said "${standingNo.text}" about "${standingNo.about}"` });
    } else if (duplicate) {
      considered.push({ subject: proposal.title, outcome: 'duplicate', why: duplicate.status === 'open' ? 'already asked and waiting for your answer' : `you answered "${duplicate.answer?.text ?? duplicate.status}" ${duplicate.answer?.at ? `on ${duplicate.answer.at.slice(0, 10)}` : 'recently'}` });
    } else {
      const id = `ntc-${Date.now().toString(36)}-${shapeKey.slice(0, 6)}`;
      const record: NoticingProposalRecord = { ...proposal, id, shapeKey, createdAt: nowIso, status: 'open' };
      if (publicationStillCurrent()) try {
        const asked = await deps.ask(record);
        record.checkInId = asked.checkInId;
        if (asked.notificationId) record.notificationId = asked.notificationId;
        state.proposals[id] = record;
        proposalId = id; produced = 1; state.metrics.itemsProduced += 1;
        considered.push({ subject: proposal.title, outcome: 'proposed', why: proposal.why });
      } catch (err) {
        error = `could not ask: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  if (answer && !error && !publicationDeferred && observation) {
    state.decisionReuse = { version: 1, fingerprint: noticingDecisionFingerprint(observation, deps, state, startedAt), decidedAt: nowIso };
  }

  // 6. Write the thinking down.
  const quiet = produced === 0;
  const summary = error ? `Could not finish: ${error}`
    : publicationDeferred === 'unavailable' ? 'Quiet: current local context could not be confirmed; no suggestion was published'
    : publicationDeferred === 'changed' ? 'Quiet: local context changed while I was thinking; I will reconsider it on the next check'
    : waitingForModel ? 'Quiet: waiting until a model is set up to think with'
    : produced ? `Proposed: ${state.proposals[proposalId!]!.title}`
    : capped ? 'Quiet: today\'s proposals are used up'
    : noLocalEvidence ? 'Quiet: no local evidence to consider'
    : unchanged ? 'Quiet: local evidence is unchanged since the recent successful check'
    : considered.length ? `Quiet: considered ${considered.length} thing${considered.length === 1 ? '' : 's'}, nothing worth asking now`
    : 'Quiet: nothing new to consider';
  const thinking: NoticingThinking = { tickId: deps.tickId, at: nowIso, source: deps.source, durationMs: deps.now() - startedAt,
    read, considered, ...(proposalId ? { proposalId } : {}), ...(model ? { model } : {}),
    ...(modelAccountingJobId ? { modelAccountingJobId } : {}), quiet, summary, ...(error ? { error } : {}),
    ...(modelCheck ? { modelCheck } : {}) };
  state.thinking = [thinking, ...state.thinking].slice(0, deps.config.thinkingKept);
  if (quiet) state.metrics.quietTicks += 1;
  // Old settled proposals decay out of the record.
  for (const [id, p] of Object.entries(state.proposals)) {
    if (p.status !== 'open' && startedAt - Date.parse(p.createdAt) > 60 * 24 * 60 * 60_000) delete state.proposals[id];
  }
  deps.saveState(state);
  return { ...thinking, produced, retired };
}

/** Record what the owner answered, as read by a model from their words. */
export function recordNoticingAnswer(state: NoticingState, input: {
  proposalId: string; text: string; decision: NoticingDecision; instruction?: string; at: string;
}): NoticingProposalRecord | null {
  const record = state.proposals[input.proposalId];
  if (!record) return null;
  record.answer = { text: input.text, decision: input.decision, at: input.at, ...(input.instruction ? { instruction: input.instruction } : {}) };
  if (record.status === 'open') { record.status = 'answered'; state.metrics.itemsAcknowledged += 1; }
  if (input.decision === 'do_it') state.metrics.doIt += 1;
  if (input.decision === 'not_now') state.metrics.notNow += 1;
  if (input.decision === 'never') {
    state.metrics.never += 1;
    state.standingAnswers = [{ text: input.text, about: record.title, at: input.at }, ...state.standingAnswers].slice(0, 100);
  }
  return record;
}
