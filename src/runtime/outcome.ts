/**
 * Unified report-back: the ONE Outcome contract + delivery mechanism every
 * async lane (background task, workflow run, cron, …) uses to report back to the
 * conversation that started it. North-star Move 4 (`docs/north-star-unification.md`).
 *
 * Before this, each lane had its own near-identical `enqueue*OutcomeTurn` —
 * same mechanism (append a synthetic turn + stage it into the conversation
 * snapshot the orchestrator replays + idempotency by id-prefix), differing only
 * in label/guidance wording. That duplication is collapsed here, so:
 *   • every surface (desktop, Discord, mobile) renders the SAME structure, and
 *   • adding a new lane (or a new status like needs_input) is one call, not a
 *     new copy of the plumbing.
 *
 * Delivery is best-effort and idempotent: a completed run must never fail on a
 * session write, and a retried/double completion must not post twice. A
 * non-terminal needs_input outcome is allowed to be followed by one terminal
 * outcome for the same source id, so a parked background task can still report
 * completion after the user answers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../memory/session-store.js';
import { HarnessSession } from './harness/session.js';
import { appendEvent, getSession as getHarnessSession, listEvents, type EventRow } from './harness/eventlog.js';
import type { RunConversationOptions } from './harness/loop.js';
import { appendGoalLedgerForSession } from '../agents/plan-proposals.js';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import pino from 'pino';

const logger = pino({ name: 'clementine-next.outcome' });

// Kept lean to what lanes actually produce today (done/blocked/failed) plus
// needs_input — the north-star "ask for clarity" status. The evidence fields
// below are deliberately execution facts, not another model verdict: manifests,
// saved artifact references, committed-write receipts, and the latest concrete
// tool failure. They let the model explain a partial/blocked run without the
// harness replacing useful work with a generic status sentence.
export type OutcomeStatus = 'done' | 'blocked' | 'failed' | 'needs_input';

export interface OutcomeWorkEvidence {
  label: string;
  completed: number;
  total: number;
  evidenceCount?: number;
}

export interface OutcomeArtifactEvidence {
  kind: string;
  ref: string;
  /** A provider readback or equivalent binding check verified this reference. */
  verified?: boolean;
}

export interface OutcomeToolFailureEvidence {
  tool?: string;
  summary: string;
}

/** Bounded, deterministic execution evidence shared by every async lane. */
export interface OutcomeEvidence {
  work?: OutcomeWorkEvidence[];
  artifacts?: OutcomeArtifactEvidence[];
  committedExternalActions?: number;
  lastToolFailure?: OutcomeToolFailureEvidence;
}

/** The single shape every lane produces to report back. */
export interface Outcome {
  status: OutcomeStatus;
  /** One-line headline of what happened (optional — `detail` alone is fine). */
  summary?: string;
  /** The full result body / preview. Truncated on render. */
  detail?: string;
  /** Runtime-owned facts that survive weak or generic model prose. */
  evidence?: OutcomeEvidence;
  /** The one remaining dependency, separate from completed work. */
  blocker?: string;
  /** Concrete action that unblocks/resumes this exact saved run. */
  nextAction?: string;
  /** True when the same durable run can continue after `nextAction`. */
  resumable?: boolean;
}

export interface DeliverContext {
  /** The conversation to report back into. No-op when absent (cron/autonomous
   *  spawns with no session to wake). */
  originSessionId?: string;
  /** Lane label used in the idempotency prefix + headline, e.g. 'background
   *  task', 'workflow run'. */
  sourceLabel: string;
  /** The run/task id. */
  sourceId: string;
  /** Human title (workflow name, task title). */
  title?: string;
  /** How the agent fetches the full result, e.g. `background_task_status('id')`. */
  statusHint?: string;
  /** Per-status head-word overrides, for back-compat with a lane's existing
   *  prefix wording (e.g. workflow renders `blocked` as "needs attention"). */
  headWord?: Partial<Record<OutcomeStatus, string>>;
  /** Detail truncation cap. */
  maxDetailChars?: number;
  /**
   * Report-back v2 (2026-06-11): when true and the origin is an IDLE chat
   * session, fire ONE proactive conversation turn so Clementine SPEAKS the
   * outcome into the conversation immediately ("test passed — fire it now or
   * wait for the schedule?") instead of waiting for the user's next message.
   * Falls back to the passive synthetic-turn staging whenever the session is
   * busy, non-chat, or anything errors. Best-effort by construction.
   */
  proactiveTurn?: boolean;
}

/**
 * Delivery acknowledgement for callers that own a durable completion marker.
 *
 * `deliverOutcome()` intentionally keeps its historical boolean contract
 * (true only when this call appended a turn). Workflow report-back also needs
 * to distinguish an idempotent duplicate from an actual write failure: both
 * were previously `false`, which let a failed origin write be mistaken for a
 * completed delivery or made a successful retry impossible to acknowledge.
 */
export interface OutcomeDeliveryAcknowledgement {
  acknowledged: boolean;
  written: boolean;
  disposition: 'delivered' | 'already_delivered' | 'not_applicable' | 'failed';
}

/** Pure gate for the proactive report-back turn: only an idle CHAT session
 *  qualifies — a session mid-turn (recent event) must not get a colliding
 *  turn, and workflow/agent sessions have no human watching them. */
export function shouldProactivelyReport(
  sessionKind: string | null,
  lastEventAgeMs: number | null,
  idleThresholdMs = 60_000,
): boolean {
  if (sessionKind !== 'chat') return false;
  if (lastEventAgeMs !== null && lastEventAgeMs < idleThresholdMs) return false;
  return true;
}

const DEFAULT_HEAD_WORDS: Record<OutcomeStatus, string> = {
  done: 'completed',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  needs_input: 'NEEDS INPUT',
};

const DEFAULT_MAX_DETAIL = 4000;

/** The idempotency / UI-detect prefix every outcome turn starts with. */
export function outcomePrefix(ctx: DeliverContext): string {
  return `[${ctx.sourceLabel} ${ctx.sourceId} `;
}

function guidanceFor(status: OutcomeStatus, statusHint?: string): string {
  const ref = statusHint ? ` Details via ${statusHint}.` : '';
  switch (status) {
    case 'done':
      return `This ran in the background and just finished — continue from here.${statusHint ? ` Full result via ${statusHint}.` : ''}`;
    case 'failed':
      return `This run stopped and did NOT complete the full objective. Preserve and report any execution evidence above; do not describe proven work as lost, and do not replay side effects.${ref}`;
    case 'blocked':
      return `This needs attention. Preserve and report the completed work above, name only the remaining dependency, and resume this saved work after it is resolved instead of starting over.${ref}`;
    case 'needs_input':
      return `This needs user input to continue. Preserve and report the completed work above, ask for the exact remaining action, then resume this saved work; do not guess or restart.${ref}`;
  }
}

function boundedText(value: string | undefined, max: number): string {
  return (value ?? '').trim().slice(0, max);
}

function renderOutcomeEvidence(evidence: OutcomeEvidence | undefined): string {
  if (!evidence) return '';
  const lines: string[] = [];
  for (const work of (evidence.work ?? []).slice(0, 4)) {
    const label = boundedText(work.label, 160) || 'Logical work';
    const completed = Math.max(0, Math.trunc(work.completed));
    const total = Math.max(0, Math.trunc(work.total));
    const refs = typeof work.evidenceCount === 'number'
      ? ` · ${Math.max(0, Math.trunc(work.evidenceCount))} evidence reference${Math.trunc(work.evidenceCount) === 1 ? '' : 's'}`
      : '';
    lines.push(`- ${label}: ${completed}/${total} complete${refs}`);
  }
  for (const artifact of (evidence.artifacts ?? []).slice(0, 8)) {
    const ref = boundedText(artifact.ref, 500);
    if (!ref) continue;
    const kind = boundedText(artifact.kind, 80) || 'artifact';
    lines.push(`- Saved ${kind}: ${ref}${artifact.verified ? ' (read back)' : ''}`);
  }
  if (typeof evidence.committedExternalActions === 'number' && evidence.committedExternalActions > 0) {
    const count = Math.max(0, Math.trunc(evidence.committedExternalActions));
    lines.push(`- ${count} committed external action receipt${count === 1 ? '' : 's'}`);
  }
  const failureSummary = boundedText(evidence.lastToolFailure?.summary, 700);
  if (failureSummary) {
    const tool = boundedText(evidence.lastToolFailure?.tool, 120);
    lines.push(`- Last concrete tool failure${tool ? ` (${tool})` : ''}: ${failureSummary}`);
  }
  return lines.length > 0 ? `Execution evidence:\n${lines.join('\n')}` : '';
}

/** Render the canonical report-back text. The head + prefix are stable (UI and
 *  idempotency depend on them); the body is the unified card. */
export function renderOutcomeText(outcome: Outcome, ctx: DeliverContext): string {
  const word = ctx.headWord?.[outcome.status] ?? DEFAULT_HEAD_WORDS[outcome.status];
  const head = `${outcomePrefix(ctx)}${word}]${ctx.title ? ` ${ctx.title}` : ''}`;
  const cap = ctx.maxDetailChars ?? DEFAULT_MAX_DETAIL;

  const parts: string[] = [];
  if (outcome.summary && outcome.summary.trim()) parts.push(outcome.summary.trim());
  const evidence = renderOutcomeEvidence(outcome.evidence);
  // On incomplete work, runtime-owned facts lead the free-form report. That
  // way a weak "task did not complete" sentence can never hide 119/120 saved
  // items or an already-written artifact. Successful runs keep Clementine's
  // own report first and use the evidence block as support.
  if (outcome.status !== 'done' && evidence) parts.push(evidence);
  if (outcome.detail && outcome.detail.trim() && outcome.detail.trim() !== outcome.summary?.trim()) {
    const d = outcome.detail.trim();
    parts.push(d.length > cap ? `${d.slice(0, cap)}\n…[truncated]` : d);
  }
  if (outcome.status === 'done' && evidence) parts.push(evidence);
  const blocker = boundedText(outcome.blocker, 1000);
  if (blocker) parts.push(`Remaining dependency:\n${blocker}`);
  const nextAction = boundedText(outcome.nextAction, 700);
  if (nextAction) {
    parts.push(`${outcome.resumable ? 'Resume action' : 'Next safe action'}:\n${nextAction}`);
  }
  parts.push(`(${guidanceFor(outcome.status, ctx.statusHint)})`);

  return `${head}\n\n${parts.join('\n\n')}`;
}

function outcomeHeadWord(status: OutcomeStatus, ctx: DeliverContext): string {
  return ctx.headWord?.[status] ?? DEFAULT_HEAD_WORDS[status];
}

function needsInputPrefix(ctx: DeliverContext): string {
  return `${outcomePrefix(ctx)}${outcomeHeadWord('needs_input', ctx)}]`;
}

function isDuplicateOutcomeText(text: string, outcome: Outcome, ctx: DeliverContext, renderedText: string): boolean {
  const idPrefix = outcomePrefix(ctx);
  if (!text.startsWith(idPrefix)) return false;

  const isNeedsInput = text.startsWith(needsInputPrefix(ctx));
  if (outcome.status === 'needs_input') {
    // A source can park more than once over its lifetime (question A, resume,
    // later question B). Dedup only exact replay of the same parked prompt;
    // terminal outcomes below still dedupe by source id.
    return isNeedsInput && text === renderedText;
  }
  return !isNeedsInput;
}

function sessionStoreHasOutcome(store: SessionStore, sessionId: string, outcome: Outcome, ctx: DeliverContext, renderedText: string): boolean {
  return store.get(sessionId).turns.some((t) => typeof t.text === 'string' && isDuplicateOutcomeText(t.text, outcome, ctx, renderedText));
}

function harnessEventLogHasOutcome(sessionId: string, outcome: Outcome, ctx: DeliverContext, renderedText: string): boolean {
  try {
    return listEvents(sessionId, { types: ['user_input_received'], desc: true, limit: 200 })
      .some((event) => typeof event.data?.text === 'string' && isDuplicateOutcomeText(event.data.text, outcome, ctx, renderedText));
  } catch {
    return false;
  }
}

function appendGoalEvidence(sessionId: string, outcome: Outcome, ctx: DeliverContext): void {
  try {
    const head = (outcome.summary ?? outcome.detail ?? '').trim();
    if (head) {
      appendGoalLedgerForSession(
        sessionId,
        `${ctx.sourceLabel} "${ctx.title ?? ctx.sourceId}" ${outcome.status}: ${head.slice(0, 120)}`,
      );
    }
  } catch { /* goal ledger is best-effort */ }
}

function proactiveGoalTail(status: OutcomeStatus, goalObjective?: string): string {
  const objective = goalObjective?.trim();
  if (!objective) return '';
  const head = ` This conversation has a pinned goal ("${objective.slice(0, 120)}"). `;
  if (status === 'done') {
    return head
      + 'If this outcome unblocks the next step of that goal, CONTINUE the goal work now (do not just narrate); '
      + 'if it does not, relay briefly and stop.';
  }
  if (status === 'needs_input') {
    return head
      + 'The answer may unblock that goal, but do not continue goal work until the user answers.';
  }
  return head
    + 'If this blocks the goal, say that plainly; do not continue or re-run anything in this turn.';
}

export function renderProactiveOutcomeDirective(
  outcome: Pick<Outcome, 'status'>,
  ctx: Pick<DeliverContext, 'sourceLabel' | 'sourceId'>,
  goalObjective?: string,
): string {
  const ref = `[${ctx.sourceLabel} ${ctx.sourceId}]`;
  const goalTail = proactiveGoalTail(outcome.status, goalObjective);
  switch (outcome.status) {
    case 'needs_input':
      return `A ${ctx.sourceLabel} you started from this conversation needs your input (see the latest ${ref} NEEDS INPUT note in context). `
        + 'Ask the user for the required input or action NOW in one concise but COMPLETE update: preserve any completed progress and key evidence in the note, then name the exact remaining dependency. '
        + 'Do not guess, do not replay prior work or side effects, and do not describe the whole objective as finished. The saved task will resume from its checkpoint after the user responds.'
        + goalTail;
    case 'failed':
      return `A ${ctx.sourceLabel} you started from this conversation FAILED (see the latest ${ref} FAILED note in context). `
        + 'Relay it NOW without erasing partial success: first state any completed work, saved artifacts, or committed actions from the note; then name what stopped and the next safe action. '
        + 'Do not re-run anything in this turn and never imply that proven work disappeared.'
        + goalTail;
    case 'blocked':
      // 'blocked' is a LANE, not one shape: a run that couldn't produce its
      // deliverable AND a run that completed but tripped a quality advisory
      // both land here. The directive must not assert "a prerequisite is
      // missing" for a delivered result (live 2026-07-23: a completed run
      // with a judge advisory was relayed as BLOCKED-missing-prerequisite,
      // contradicting the "✓ completed — please review" note one line up).
      return `A ${ctx.sourceLabel} you started from this conversation NEEDS ATTENTION (see the latest ${ref} note in context). `
        + 'Relay the note\'s substance NOW in one concise but COMPLETE message, matching what it actually says and preserving completed progress: '
        + 'if it delivered a result with a quality warning, lead with the result and what to review; '
        + 'if a prerequisite was missing, lead with what is missing and what decision or action is needed. '
        + 'Always include saved artifacts or completed item counts from the execution-evidence block. '
        + 'Never call the work failed or blocked if the note says it completed. Do not replay prior work or side effects in this turn.'
        + goalTail;
    case 'done':
      return `A ${ctx.sourceLabel} you started from this conversation just finished (see the latest ${ref} note in context). `
        + 'Relay the outcome to the user NOW in one short message: lead with pass/fail and the key evidence. '
        + 'If it passed and the workflow is enabled, end by asking: fire it off now, or wait for the next scheduled run? '
        + 'If it failed, say exactly what you will fix. Do not re-run anything in this turn.'
        + goalTail;
  }
}

function isSyntheticOutcomeForSource(
  event: Pick<EventRow, 'type' | 'data'>,
  ctx: Pick<DeliverContext, 'sourceLabel' | 'sourceId'>,
): boolean {
  const data = event.data;
  return event.type === 'user_input_received'
    && data?.synthetic === true
    && data?.source === 'outcome'
    && data?.sourceLabel === ctx.sourceLabel
    && data?.sourceId === ctx.sourceId;
}

export function proactiveReportLastEventAgeMs(
  events: Array<Pick<EventRow, 'type' | 'data' | 'createdAt'>>,
  ctx: Pick<DeliverContext, 'sourceLabel' | 'sourceId'>,
  nowMs = Date.now(),
): number | null {
  let latestMs: number | null = null;
  for (const event of events) {
    if (isSyntheticOutcomeForSource(event, ctx)) continue;
    const ts = Date.parse(event.createdAt);
    if (!Number.isFinite(ts)) continue;
    latestMs = latestMs === null ? ts : Math.max(latestMs, ts);
  }
  return latestMs === null ? null : Math.max(0, nowMs - latestMs);
}

function maybeScheduleProactiveReport(sessionId: string, outcome: Outcome, ctx: DeliverContext): void {
  if (!ctx.proactiveTurn) return;
  // Fire-and-forget: a proactive relay failure must never affect the run
  // or the passive staging above (which remains the guaranteed baseline).
  void (async () => {
    try {
      const hs = HarnessSession.load(sessionId);
      if (!hs) return;
      const { listEvents } = await import('./harness/eventlog.js');
      const recentEvents = listEvents(sessionId, { limit: 20, desc: true });
      const ageMs = proactiveReportLastEventAgeMs(recentEvents, ctx);
      // A needs_input outcome is a BLOCKING QUESTION, not a report — the
      // idle gate exists so finished-work reports don't interrupt, but a
      // question IS the conversation now. Deferring it strands the user
      // staring at "waiting for your input" with no question in the chat
      // (live 2026-07-22: a user chatted "how is it going" while his own
      // parked question sat in the defer queue). Chat origins fire the
      // question immediately, busy or not.
      const blockingQuestion = outcome.status === 'needs_input' && hs.sessionRow.kind === 'chat';
      if (!blockingQuestion && !shouldProactivelyReport(hs.sessionRow.kind, ageMs)) {
        // A non-chat origin never speaks — skip for good. A BUSY chat must
        // not be skipped: quick runs routinely finish inside the 60s window
        // after their own dispatch, which made every desktop report-back
        // silently vanish (live 2026-07-21). Defer and re-check until idle.
        if (hs.sessionRow.kind === 'chat' && proactiveReportDeferEnabled()) {
          enqueueDeferredProactiveReport(sessionId, outcome, ctx);
          logger.info(
            { sourceId: ctx.sourceId, sessionId, ageMs, status: outcome.status },
            'proactive report deferred — origin chat is mid-conversation; will speak once idle',
          );
        } else {
          logger.info(
            { sourceId: ctx.sourceId, sessionId, kind: hs.sessionRow.kind, status: outcome.status },
            'proactive report skipped (non-chat origin; passive staging remains)',
          );
        }
        return;
      }
      await fireProactiveReportTurnImpl(sessionId, outcome, ctx);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, sourceId: ctx.sourceId },
        'proactive report-back turn failed (passive staging + notification remain)',
      );
    }
  })();
}

async function fireProactiveReportTurn(sessionId: string, outcome: Outcome, ctx: DeliverContext): Promise<void> {
  const [{ runConversation }, { buildOrchestratorAgent }, { buildChatFalloverWiring }] = await Promise.all([
    import('./harness/loop.js'),
    import('../agents/orchestrator.js'),
    import('./harness/respond-bridge.js'),
  ]);
  // If the origin session has an active goal, this finished sub-work may
  // unblock it — tell the model to continue the goal rather than just
  // narrate. This is the EVENT-DRIVEN half of self-resumption (the
  // heartbeat in goal-resume.ts is the fallback for stalls/sleep).
  let goalObjective = '';
  try {
    const { getActiveGoalForSession } = await import('../agents/plan-proposals.js');
    const goal = getActiveGoalForSession(sessionId);
    if (goal) {
      const plan = goal.approvedPlan ?? goal.plan;
      goalObjective = plan.objective ?? '';
    }
  } catch { /* goal read is best-effort */ }
  const directive = renderProactiveOutcomeDirective(outcome, ctx, goalObjective);
  const agent = await buildOrchestratorAgent({ userInput: directive, sessionId });
  // W1c — the report-back already runs on the DEFAULT brain (= the origin
  // chat's brain, since no model override). Give it the same chat
  // step-boundary fallover as a normal chat turn so a transient on that
  // brain doesn't drop the report. Best-effort; absent = today's behavior.
  const fallover = buildChatFalloverWiring({ userInput: directive, sessionId, buildAgent: buildOrchestratorAgent });
  // Record the machine directive as a SYNTHETIC user turn (same flags the
  // passive outcome turn above carries) so the desktop transcript never
  // shows "Relay the outcome to the user NOW…" as if the user typed it —
  // the user-facing read paths skip data.synthetic. The model still
  // receives the directive via runConversation's `input`; passing
  // reuseRecordedUserInput stops the loop from re-logging it as a plain
  // (un-flagged) user turn. Best-effort — the surrounding catch covers it.
  await runRecordedProactiveReportTurn({
    sessionId,
    directive,
    outcome,
    ctx,
    conversationOptions: {
      agent,
      judgeCompletion: false,
      falloverModelIds: fallover.falloverModelIds,
      rebuildAgentForBrain: fallover.rebuildAgentForBrain,
    },
  }, runConversation);
}

type ProactiveReportConversationOptions = Omit<
  RunConversationOptions,
  'sessionId' | 'input' | 'reuseRecordedUserInput' | 'sourceUserSeq'
>;

/**
 * Accept the synthetic directive before starting its model turn and bind that
 * turn to the exact row returned by appendEvent. Looking up the session's
 * latest input inside runConversation is unsafe: a concurrent human message
 * can arrive between these two operations and must remain a different turn.
 */
async function runRecordedProactiveReportTurn(
  input: {
    sessionId: string;
    directive: string;
    outcome: Pick<Outcome, 'status'>;
    ctx: Pick<DeliverContext, 'sourceLabel' | 'sourceId'>;
    conversationOptions: ProactiveReportConversationOptions;
  },
  runConversationImpl: (options: RunConversationOptions) => Promise<unknown>,
): Promise<EventRow> {
  const directiveSource = appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: input.directive,
      synthetic: true,
      source: 'outcome',
      sourceLabel: input.ctx.sourceLabel,
      sourceId: input.ctx.sourceId,
      status: input.outcome.status,
      deliveryPhase: 'directive',
    },
  });
  await runConversationImpl({
    ...input.conversationOptions,
    sessionId: input.sessionId,
    input: input.directive,
    reuseRecordedUserInput: true,
    sourceUserSeq: directiveSource.seq,
  });
  return directiveSource;
}

let fireProactiveReportTurnImpl: typeof fireProactiveReportTurn = fireProactiveReportTurn;
export function setProactiveReportFireForTest(fn: typeof fireProactiveReportTurn | null): void {
  fireProactiveReportTurnImpl = fn ?? fireProactiveReportTurn;
}

export const __test__ = {
  runRecordedProactiveReportTurn,
};

// ---------------------------------------------------------------------------
// Deferred proactive reports (2026-07-21): a proactive report that finds its
// origin chat mid-conversation is DEFERRED (durable, restart-safe) and re-fired
// by the daemon tick once the chat goes idle — never silently skipped. The
// passive staged turn above remains the guaranteed baseline either way; this
// queue only upgrades delivery from "on your next message" to "spoken now".
// Same durable-due-marker pattern as goal-resume.ts (no bare setTimeout).

interface DeferredProactiveReport {
  sessionId: string;
  outcome: Outcome;
  ctx: Omit<DeliverContext, 'proactiveTurn'>;
  createdAt: string;
  attempts: number;
}

const DEFERRED_REPORTS_FILE = path.join(BASE_DIR, 'state', 'deferred-proactive-reports.json');
/** Past this age the user has plainly moved on — the passive turn covers it. */
const DEFERRED_REPORT_MAX_AGE_MS = 30 * 60_000;

function proactiveReportDeferEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_PROACTIVE_REPORT_DEFER', 'on') || 'on').trim().toLowerCase() !== 'off';
}

function loadDeferredReports(): DeferredProactiveReport[] {
  try {
    const raw = fs.readFileSync(DEFERRED_REPORTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.sessionId === 'string') : [];
  } catch {
    return [];
  }
}

function saveDeferredReports(entries: DeferredProactiveReport[]): void {
  try {
    fs.mkdirSync(path.dirname(DEFERRED_REPORTS_FILE), { recursive: true });
    fs.writeFileSync(DEFERRED_REPORTS_FILE, JSON.stringify(entries, null, 1));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'deferred proactive report save failed');
  }
}

function enqueueDeferredProactiveReport(sessionId: string, outcome: Outcome, ctx: DeliverContext): void {
  try {
    const { proactiveTurn: _drop, ...serializableCtx } = ctx;
    const entries = loadDeferredReports().filter(
      // One live deferral per source: a newer outcome for the same work replaces
      // the older one (a needs_input superseded by done must not speak twice).
      (e) => !(e.sessionId === sessionId && e.ctx.sourceLabel === ctx.sourceLabel && e.ctx.sourceId === ctx.sourceId),
    );
    entries.push({ sessionId, outcome, ctx: serializableCtx, createdAt: new Date().toISOString(), attempts: 0 });
    saveDeferredReports(entries);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, sourceId: ctx.sourceId }, 'deferred proactive report enqueue failed');
  }
}

/**
 * Daemon tick: fire every deferred proactive report whose origin chat has gone
 * idle; drop entries past the age bound (the passive turn already covers them).
 * At-most-once per entry: an entry is removed from the queue before its turn
 * runs, so a crash mid-turn costs the upgrade, never a duplicate.
 */
export async function processDeferredProactiveReports(): Promise<void> {
  if (!proactiveReportDeferEnabled()) return;
  const entries = loadDeferredReports();
  if (entries.length === 0) return;
  const keep: DeferredProactiveReport[] = [];
  const fire: DeferredProactiveReport[] = [];
  for (const entry of entries) {
    const ageMs = Date.now() - Date.parse(entry.createdAt);
    if (!Number.isFinite(ageMs) || ageMs > DEFERRED_REPORT_MAX_AGE_MS) {
      logger.info(
        { sourceId: entry.ctx.sourceId, sessionId: entry.sessionId, attempts: entry.attempts },
        'deferred proactive report aged out (passive staging already delivered it)',
      );
      continue;
    }
    try {
      const hs = HarnessSession.load(entry.sessionId);
      if (!hs) continue;
      const recentEvents = listEvents(entry.sessionId, { limit: 20, desc: true });
      const idleAgeMs = proactiveReportLastEventAgeMs(recentEvents, entry.ctx);
      if (shouldProactivelyReport(hs.sessionRow.kind, idleAgeMs)) fire.push(entry);
      else if (hs.sessionRow.kind === 'chat') keep.push({ ...entry, attempts: entry.attempts + 1 });
      // non-chat: drop silently — it can never qualify.
    } catch {
      keep.push({ ...entry, attempts: entry.attempts + 1 });
    }
  }
  saveDeferredReports(keep);
  for (const entry of fire) {
    try {
      logger.info(
        { sourceId: entry.ctx.sourceId, sessionId: entry.sessionId, attempts: entry.attempts },
        'deferred proactive report firing — origin chat is idle now',
      );
      await fireProactiveReportTurnImpl(entry.sessionId, entry.outcome, { ...entry.ctx, proactiveTurn: true });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, sourceId: entry.ctx.sourceId },
        'deferred proactive report turn failed (passive staging remains)',
      );
    }
  }
}

/**
 * Deliver an Outcome back to the conversation that started the work. For
 * harness-owned conversations, append a synthetic event to the harness eventlog;
 * for legacy desktop/mobile conversations, append to SessionStore. In both
 * cases, stage into the HarnessSession snapshot when one exists so the
 * orchestrator sees the report-back on its next turn. Idempotent by id-prefix
 * across retries / daemon restarts. Best-effort: never throws, never blocks the
 * run.
 *
 * Returns true if a turn was written, false if it was a no-op (no origin
 * session) or a duplicate.
 */
export function deliverOutcomeWithAcknowledgement(
  outcome: Outcome,
  ctx: DeliverContext,
): OutcomeDeliveryAcknowledgement {
  try {
    const sessionId = ctx.originSessionId;
    if (!sessionId) {
      return { acknowledged: true, written: false, disposition: 'not_applicable' };
    }
    const idPrefix = outcomePrefix(ctx);
    const text = renderOutcomeText(outcome, ctx);

    // Harness chats are the canonical desktop/Discord conversation store. Writing
    // their report-backs to sessions.json creates a same-raw-id "desktop:" ghost
    // that loses the original harness transcript on reopen.
    const harnessRow = getHarnessSession(sessionId);
    if (harnessRow) {
      if (harnessEventLogHasOutcome(sessionId, outcome, ctx, text)) {
        return { acknowledged: true, written: false, disposition: 'already_delivered' };
      }
      appendEvent({
        sessionId,
        turn: 0,
        role: 'user',
        type: 'user_input_received',
        data: {
          text,
          synthetic: true,
          source: 'outcome',
          sourceLabel: ctx.sourceLabel,
          sourceId: ctx.sourceId,
          status: outcome.status,
          deliveryPhase: 'passive',
          ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
          ...(outcome.blocker ? { blocker: outcome.blocker } : {}),
          ...(outcome.nextAction ? { nextAction: outcome.nextAction } : {}),
          ...(outcome.resumable !== undefined ? { resumable: outcome.resumable } : {}),
        },
      });
      try {
        const hs = HarnessSession.load(sessionId);
        if (hs) hs.injectSyntheticUserTurn(idPrefix, text);
      } catch { /* a harness snapshot write must never affect run state */ }
      logger.info({ sourceId: ctx.sourceId, sessionId, status: outcome.status, store: 'harness' }, 'Outcome delivered to origin session');
      appendGoalEvidence(sessionId, outcome, ctx);
      maybeScheduleProactiveReport(sessionId, outcome, ctx);
      return { acknowledged: true, written: true, disposition: 'delivered' };
    }

    const store = new SessionStore();
    if (sessionStoreHasOutcome(store, sessionId, outcome, ctx, text)) {
      return { acknowledged: true, written: false, disposition: 'already_delivered' };
    }
    store.appendTurn(sessionId, { role: 'user', text, createdAt: new Date().toISOString() });
    // Stage into the harness conversation snapshot so the desktop/Discord
    // orchestrator (which replays the snapshot, not this SessionStore) sees the
    // outcome on its next turn. Best-effort + idempotent.
    try {
      const hs = HarnessSession.load(sessionId);
      if (hs) hs.injectSyntheticUserTurn(idPrefix, text);
    } catch { /* a harness-store write must never affect run state */ }
    logger.info({ sourceId: ctx.sourceId, sessionId, status: outcome.status }, 'Outcome delivered to origin session');
    // Async-lane work (workflow run, background task) that reports back into a
    // session with an active goal becomes goal evidence — one ledger line so
    // the goal's progress timeline reflects sub-work it dispatched. Best-effort.
    appendGoalEvidence(sessionId, outcome, ctx);
    maybeScheduleProactiveReport(sessionId, outcome, ctx);
    return { acknowledged: true, written: true, disposition: 'delivered' };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, sourceId: ctx.sourceId },
      'deliverOutcome failed (best-effort; run + notification unaffected)',
    );
    return { acknowledged: false, written: false, disposition: 'failed' };
  }
}

export function deliverOutcome(outcome: Outcome, ctx: DeliverContext): boolean {
  return deliverOutcomeWithAcknowledgement(outcome, ctx).written;
}
