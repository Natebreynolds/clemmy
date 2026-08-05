/**
 * Durable background promotion for interactive chat turns (gap C1).
 *
 * A long autonomous chat turn ("build me a site, take your time and finish
 * it") used to run FOREGROUND on every surface: the desktop dock fired it in a
 * `setImmediate` inside the request handler, Discord in an IIFE. That run was
 * ephemeral and in-process — invisible on the Tasks board, killed (not
 * resumed) on a daemon restart, with no durable wall-clock budget or watchdog.
 *
 * The daemon already has a battle-tested durable lane (`createBackgroundTask`
 * → `processBackgroundTasks` → resume-on-restart → `enqueueBackgroundTaskOutcomeTurn`
 * report-back → watchdog → auto-surfaces on `GET /api/console/board`). The only
 * thing missing was the ROUTING DECISION on the interactive surfaces. This
 * module is that decision, shared so desktop, Discord, and the gateway (mobile)
 * promote identically — honoring the desktop↔Discord parity directive.
 *
 * The trigger is either EXPLICIT user intent (see `hasDurableExecutionIntent`)
 * or a high-confidence unattended workload shape: a broad, multi-system,
 * multi-step data pipeline with batch enrichment and an external destination.
 * Plain asks still run foreground unchanged. The auto path is intentionally
 * narrower than "complex" so ordinary builds, questions, and one-off lookups
 * do not disappear into the background.
 */
import { MODELS } from '../config.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { deriveTitle } from '../memory/derive-title.js';
import { createBackgroundTask, listBackgroundTasks, requestBackgroundDrain, type BackgroundReportBackTarget, type BackgroundTaskRecord } from './background-tasks.js';
import {
  clearKill,
  getActiveRunAttempt,
  getLatestEventSeq,
  getRunAttemptSourceUserEvent,
  getSession as getHarnessSession,
  requestKill,
  type RunAttemptRef,
} from '../runtime/harness/eventlog.js';
import { getActiveObjective } from '../memory/focus.js';
import { getActiveGoalForSession, bindBackgroundRunGoal } from '../agents/plan-proposals.js';
import { effectiveTurnObjective } from '../runtime/harness/turn-control.js';
import { checkpointCapsule, endHandoff, projectCapsuleFromDurableState, stepHandoff } from './continuation-capsule.js';
import { handoffRank, reservedBackgroundTaskId } from './handoff-store.js';
import { HarnessSession } from '../runtime/harness/session.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';

/**
 * Explicit or high-confidence intent to run this work as a durable background job.
 * Keyword/regex matcher (NOT a model call): a `/background` prefix, an explicit
 * "run … in the background / overnight / as a job", a "keep working / don't
 * stop / take your time", a finish-it-all phrase paired with a build verb, or
 * an obvious unattended data/enrichment pipeline across multiple systems.
 *
 * Conservative by design — a plain "build me a site" or "pull 5 Salesforce
 * accounts" returns false and keeps running foreground. (Moved from
 * gateway/router.ts so the gateway, desktop dock, and Discord share one
 * decision.)
 */
export function hasDurableExecutionIntent(message: string): boolean {
  const lower = message.toLowerCase().replace(/\s+/g, ' ').trim();
  const intentText = stripNegatedDurableIntent(lower);
  // Generated chat prompts can contain a transcript, machine summary, or other
  // source material after the user's leading directive. Never let phrases in
  // that embedded content (live bug: "large, long-running matters") decide the
  // execution lane for a conversational summarize/review/discuss request.
  // Explicit durable wording in the leading directive still wins.
  const leadingDirective = intentText.slice(0, 400);
  if (startsAsForegroundDiscussion(leadingDirective)) {
    return hasDirectDurableDirective(leadingDirective);
  }
  // "Keep working on it HERE and I'll WATCH the updates" is a request to stay
  // in the current surface, not to background — the soft continuation phrases
  // ("keep working", "take your time") must not outrank it. An explicit
  // background directive still wins. Live 2026-07-23: a Workspace chat turn
  // saying exactly that was promoted to a durable task.
  if (hasForegroundWatchIntent(intentText)) return hasExplicitBackgroundDirective(intentText);
  return hasDirectDurableDirective(intentText);
  // E6.1: the service/verb "data pipeline shape" classifier is RETIRED from
  // routing. Automatic durable disposition now comes from the typed
  // WorkDisposition the planner proposes and the runtime validates
  // deterministically (execution/work-disposition.ts): real canonical item
  // identities that cannot finish inside one bounded activation window make
  // the work durable, whatever nouns the request used. Explicit user
  // directives above still decide their own lane.
}

/**
 * Explicit "stay here, I'll watch" intent — the user wants to SEE the work
 * happen live on the surface they're already on. Vetoes the soft continuation
 * triggers in `hasSoftDurableDirective`; never vetoes an explicit background
 * directive.
 */
export function hasForegroundWatchIntent(message: string): boolean {
  const lower = message.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\b(?:work(?:ing)?|do(?:ing)?|continue|fix(?:ing)?|edit(?:ing)?|updat(?:e|ing)|build(?:ing)?)\b[^.?!]{0,40}\b(?:right\s+)?here\b/.test(lower)) return true;
  if (/\b(?:i(?:'|’)?ll|i will|let me|i(?:'|’)?m going to|and i(?:'|’)?ll|ill)\s+(?:just\s+)?watch\b/.test(lower)) return true;
  if (/\bwatch\s+(?:the|your|you|it|them|each)\b[^.?!]{0,40}\b(?:update|edit|change|progress|work|happen)/.test(lower)) return true;
  if (/\b(?:as you (?:make|go|work)|in real ?time|live updates?|stay (?:here|in this (?:chat|session|space|workspace|window)))\b/.test(lower)) return true;
  return false;
}

function startsAsForegroundDiscussion(text: string): boolean {
  return /^(?:please\s+)?(?:summarize|review|discuss|explain|tell me about|walk me through)\b/.test(text);
}

/**
 * Information-seeking, as opposed to a request. "Can/could/would/will you …"
 * is a REQUEST wearing a question mark, so it is excluded here and flows
 * through the ordinary directive rules.
 */
export function isInformationQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (/^(?:ok(?:ay)?[,.!\s]+)?(?:please\s+)?(?:can|could|would|will)\s+(?:you|u)\b/.test(trimmed)) return false;
  if (/\?\s*$/.test(trimmed)) return true;
  return /^(?:ok(?:ay)?[,.!\s]+)?(?:so\s+)?(?:what|what's|whats|how|hows|how's|why|when|where|who|whose|which|is there|are there|is it|was|were|does|did|do i|do we|any update|status)\b/.test(trimmed);
}

/** Any not-yet-settled task this interactive session already spawned. Failure
 *  to read the board answers false — uncertainty must never LOCK promotion,
 *  only certainty may redirect it. */
export function hasActiveBackgroundTaskForSession(sessionId: string): boolean {
  try {
    return listBackgroundTasks({})
      .some((task) => task.originSessionId === sessionId
        && (task.status === 'pending' || task.status === 'running'
          || task.status === 'awaiting_approval' || task.status === 'cancelling'));
  } catch {
    return false;
  }
}

function hasDirectDurableDirective(text: string): boolean {
  return hasExplicitBackgroundDirective(text) || hasSoftDurableDirective(text);
}

/** The user literally named the background lane. Never vetoed by watch intent. */
function hasExplicitBackgroundDirective(text: string): boolean {
  if (/^\/?(background|bg)\b/.test(text)) return true;
  if (/\b(run|queue|start).{0,40}\b(background|overnight|as a job)\b/.test(text)) return true;
  if (/\b(?:move|take|send|put)\s+(?:this|it|that|the request|the task)\s+(?:to|into)\s+the\s+background\b/.test(text)) return true;
  if (/\b(?:do|finish)\s+(?:this|it|that|the request|the task)\s+in\s+the\s+background\b/.test(text)) return true;
  if (/\b(?:in the background|overnight|as a job)\b/.test(text)) return true;
  return false;
}

/** Durable-shaped phrasing that does NOT name the background lane — overridable
 *  by an explicit "I'll watch it here" (see hasForegroundWatchIntent). */
function hasSoftDurableDirective(text: string): boolean {
  if (/\b(?:keep working|don't stop|do not stop|longer running|take your time)\b/.test(text)) return true;
  // "long-running" is descriptive in ordinary source material. Treat it as
  // routing intent only when it modifies the task/work itself.
  if (/\b(?:this|that|it|task|job|request|work|process|run)\b.{0,30}\blong[- ]running\b/.test(text)
    || /\blong[- ]running\b.{0,30}\b(?:task|job|request|work|process|run)\b/.test(text)) return true;
  if (/\b(from start to finish|end to end|get it done|finish this|finish it all)\b/.test(text)) {
    // "finish" must NOT be in this verb list: "finish this" would then satisfy
    // its own guard, and a bare question like "what needs to be done to finish
    // this task?" would read as durable work intent (live 2026-08-04).
    return /\b(build|implement|migrate|refactor|wire|ship|deploy|fix|create|set up|setup)\b/.test(text);
  }
  return false;
}

function stripNegatedDurableIntent(lower: string): string {
  return lower
    .replace(/\b(?:do not|don't|dont|never)\b[^.?!;]{0,180}\b(?:background|overnight|as a job|background tasks?)\b/g, ' ')
    .replace(/\b(?:do not|don't|dont|never)\s+(?:run|queue|start|launch|create|move|take|send|put|do|finish)\b.{0,80}\b(?:background|overnight|as a job|background tasks?)\b/g, ' ')
    .replace(/\bwithout\s+(?:running|queueing|queuing|starting|launching|creating|moving|taking|sending|putting|doing|finishing)\b.{0,80}\b(?:background|overnight|as a job|background tasks?)\b/g, ' ')
    .replace(/\bno\s+background\s+tasks?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countHits(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

/** Strip a leading `/background` / `bg:` command prefix from the user's message. */
export function stripBackgroundPrefix(message: string): string {
  const stripped = message.trim()
    .replace(/^\/?(background|bg)\s*[:\-]?\s*/i, '')
    .replace(
      /^(?:live validation only:\s*)?(?:please\s+)?(?:(?:move|take|send|put)\s+(?:this|it|that|the request|the task)\s+(?:to|into)\s+the\s+background|(?:run|queue|start|do|finish)\s+(?:this|it|that|the request|the task)\s+(?:in|as|to)?\s*(?:the\s+)?background)\s*(?:(?:[:.,;!-]+|\band\b)\s*)?/i,
      '',
    )
    .trim();
  return stripped;
}

/**
 * Workspace (space) chat sessions — `spaceSessionId` in console-web mints them
 * as `space-<slug>` — are interactive by nature: the user is looking AT the
 * live surface being edited, so watching the work IS the product there.
 */
export function isSpaceSession(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('space-');
}

/**
 * The promotion gate the interactive surfaces should call. Promote only when
 * there is durable intent AND a non-empty instruction once the command prefix is
 * stripped — so a bare "/background" (no actual task) does NOT queue a
 * content-free worker; it falls through to a normal turn instead.
 *
 * In a space session (opts.sessionId), soft durable phrasing and pipeline shape
 * never promote — edits stay foreground where the user watches them land. Only
 * an explicit background directive ("/background", "run this in the background")
 * still promotes: the user owns the designation.
 */
/**
 * Which lane this request belongs in, and why.
 *
 * `background` — the user NAMED the lane. Their instruction, so it is followed.
 * `confirm`    — this only LOOKS like an unattended pipeline. Clementine
 *                inferred it; the user never asked for it.
 * `foreground` — an ordinary turn.
 *
 * The distinction is the whole point. Inferring "multi-system data pipeline"
 * from service and verb keywords is a guess about SHAPE, and it says nothing
 * about whether the request is specified well enough to run unattended for
 * twenty minutes. Live 2026-08-03: "find me 10 personal injury firms on page 2
 * that fit scorpion's ICP, scrape SEO data, create a google sheet" matched on
 * `seo` + `sheets` + `scrape`/`create` and dispatched instantly — never asking
 * page 2 of what search, in which geography, what that ICP is, which metrics,
 * or which sheet. Four unanswered questions, all guessed, twenty minutes spent
 * before anyone could find out the guesses were wrong.
 *
 * Deciding to run unattended is the user's call to make, not an inference to
 * act on. So an inferred pipeline no longer auto-dispatches: it stays in the
 * conversation, where the ordinary turn can align first, and the user can still
 * say "run that in the background" — which lands in `background` immediately.
 */
export type DurableExecutionLane = 'background' | 'confirm' | 'foreground';

export interface DurableExecutionDecision {
  lane: DurableExecutionLane;
  /** Short, private rationale. Useful in telemetry; never shown as prose. */
  reason: string;
}

export function durableExecutionDecision(
  message: string,
  opts?: { sessionId?: string },
): DurableExecutionDecision {
  if (stripBackgroundPrefix(message).trim().length === 0) {
    return { lane: 'foreground', reason: 'empty_instruction' };
  }
  const lower = message.toLowerCase().replace(/\s+/g, ' ').trim();
  const intentText = stripNegatedDurableIntent(lower);

  // An information question is a conversation turn, never a work order. Live
  // 2026-08-04 (desktop): "Okay what needs to be done to finish this task?"
  // matched the finish-this soft directive and minted a background task TITLED
  // with the question. Only an explicitly named lane overrides this — a
  // request shape ("can you …") is not a question for this purpose.
  if (isInformationQuestion(intentText) && !hasExplicitBackgroundDirective(intentText)) {
    return { lane: 'foreground', reason: 'question_stays_conversational' };
  }

  // A continuation of work this session ALREADY runs in the background must
  // steer that run, not mint a sibling. Live 2026-08-04 (desktop): "Okay keep
  // working and get this done, reminder, do not do any accounts that are
  // customer…" — a policy reminder for the active task — became a SECOND
  // background task titled with the reminder text. Explicit lane naming wins;
  // a lookup failure falls through to the ordinary rules (never blocks).
  if (
    opts?.sessionId
    && isContinuationDirective(message)
    && !hasExplicitBackgroundDirective(intentText)
    && hasActiveBackgroundTaskForSession(opts.sessionId)
  ) {
    return { lane: 'foreground', reason: 'continuation_of_active_run' };
  }

  // A space session has always required the user to name the lane explicitly.
  if (isSpaceSession(opts?.sessionId)) {
    return hasExplicitBackgroundDirective(intentText)
      ? { lane: 'background', reason: 'explicit_directive' }
      : { lane: 'foreground', reason: 'space_requires_explicit_directive' };
  }

  // The user named the lane — including the soft continuations ("keep working",
  // "take your time"), which are still the user choosing to let it run long.
  if (hasDurableExecutionIntentDirective(message)) {
    return { lane: 'background', reason: 'explicit_directive' };
  }

  // E6.1: shape inference by service/verb nouns is RETIRED. A request whose
  // TYPED plan proves it exceeds one bounded activation becomes durable
  // through admitWorkDisposition at the planning seam — this decision only
  // reads explicit user intent, so an unlisted carrier can never be
  // misrouted by vocabulary.
  return { lane: 'foreground', reason: 'no_durable_intent' };
}

/**
 * Only an explicitly-requested background job auto-dispatches.
 *
 * Callers treat `true` as "enqueue without asking", so an inferred pipeline
 * must not return true here — that is exactly the fire-and-forget this fixes.
 */
export function shouldPromoteToDurable(message: string, opts?: { sessionId?: string }): boolean {
  return durableExecutionDecision(message, opts).lane === 'background';
}

/** The directive half of `hasDurableExecutionIntent`, without the shape guess. */
function hasDurableExecutionIntentDirective(message: string): boolean {
  const lower = message.toLowerCase().replace(/\s+/g, ' ').trim();
  const intentText = stripNegatedDurableIntent(lower);
  const leadingDirective = intentText.slice(0, 400);
  if (startsAsForegroundDiscussion(leadingDirective)) {
    return hasDirectDurableDirective(leadingDirective);
  }
  if (hasForegroundWatchIntent(intentText)) return hasExplicitBackgroundDirective(intentText);
  return hasDirectDurableDirective(intentText);
}

export interface EnqueueDurableChatTaskInput {
  /** The user's message (a leading background prefix is stripped automatically). */
  message: string;
  /**
   * A fully-composed worker prompt (the AGREED objective + plan), used VERBATIM
   * as the task prompt when present — skips the keyword-prefix stripping. This is
   * the path the `dispatch_background_task` tool uses to hand the conversation's
   * agreed plan to the runner; `message` then serves only as the title source.
   */
  composedPrompt?: string;
  /**
   * Rich goal contract for the run (objective/criteria/next actions). When
   * absent, a default goal is bound from `message` — EVERY durable task is
   * goal-bound at creation (completion validation + deliverable probes +
   * single-owner resume all key off it).
   */
  goal?: { objective: string; successCriteria?: string[]; nextActions?: string[] };
  /**
   * The interactive session that spawned this task. REQUIRED for report-back —
   * the daemon feeds the result back into this session's transcript on
   * completion. Without it the result is notification-only.
   */
  sessionId: string;
  /** Exact foreground provenance when this task is a user-requested handoff.
   * Persisted on the task so a lost response can safely rejoin it. */
  foregroundHandoff?: BackgroundTaskRecord['foregroundHandoff'];
  /** A task id reserved from durable identity before the task existed. */
  explicitId?: string;
  userId?: string;
  channel?: string;
  reportBackTarget?: BackgroundReportBackTarget;
  /** Worker model override; defaults to the deep-reasoning model. */
  model?: string;
  /** Surface that promoted the turn (for board/notification attribution). */
  source?: BackgroundTaskRecord['source'];
  /** Soft wall-clock budget; defaults to the proactivity policy's long-task minutes. */
  maxMinutes?: number;
}

/**
 * Promote an interactive chat turn into the durable background-task lane.
 * Mirrors the exact createBackgroundTask contract the gateway already used, so
 * every surface enqueues identically. Returns the queued task (status:'pending')
 * — the daemon's processBackgroundTasks loop picks it up on its next tick, and
 * it appears on the Tasks board immediately.
 */
/** A directive that continues existing work rather than naming a new task. */
export function isContinuationDirective(message: string): boolean {
  const lower = message.toLowerCase().replace(/\s+/g, ' ').trim();
  return /\b(?:keep working|keep going|keep at it|keep it going|carry on|continue)\b/.test(lower)
    || /\bfinish\s+(?:it|this|that)\b/.test(lower);
}

export function enqueueDurableChatTask(input: EnqueueDurableChatTaskInput): BackgroundTaskRecord {
  // A composed prompt (the agreed plan from dispatch_background_task) is used
  // verbatim; otherwise strip a keyword prefix from the raw user message.
  const prompt = input.composedPrompt?.trim()
    || stripBackgroundPrefix(input.message)
    || input.message;
  // A continuation directive ("keep working on it") names no objective of its
  // own — the goal the session is already pursuing is the real subject, and a
  // raw-message title reads as chat scaffolding on the Tasks board (live
  // 2026-07-23: a task titled "You can keep working on it here please and ill
  // watch the…"). Prefer the active goal's objective for the title then.
  let title = deriveTitle(input.message) || deriveTitle(prompt);
  if (isContinuationDirective(input.message)) {
    try {
      const goal = getActiveGoalForSession(input.sessionId);
      const goalObjective = goal ? ((goal.approvedPlan ?? goal.plan).objective ?? '').trim() : '';
      if (goalObjective) title = deriveTitle(goalObjective) || title;
    } catch { /* raw-message title stands */ }
  }
  const task = createBackgroundTask({
    title,
    prompt,
    originSessionId: input.sessionId,
    foregroundHandoff: input.foregroundHandoff,
    ...(input.explicitId ? { explicitId: input.explicitId } : {}),
    userId: input.userId,
    channel: input.channel,
    reportBackTarget: input.reportBackTarget,
    model: input.model ?? MODELS.deep,
    maxMinutes: input.maxMinutes ?? loadProactivityPolicy().defaultLongTaskMinutes,
    source: input.source ?? 'gateway',
  });
  // GOAL-BIND AT CREATION — a property of backgrounding itself, not of which
  // path queued it. Live 2026-07-08: an auto-promoted task ran with NO goal
  // (only two of five entry paths bound one), so no completion validation and
  // no deliverable probes ran — a zero-tools hallucination marked itself
  // "done" having done nothing, and single-owner resume didn't apply either.
  // Callers with richer contracts pass `goal`; everyone else gets the message
  // as the objective. Best-effort like bindBackgroundRunGoal itself.
  try {
    bindBackgroundRunGoal(task.runSessionId, {
      objective: input.goal?.objective ?? stripBackgroundPrefix(input.message) ?? input.message,
      successCriteria: input.goal?.successCriteria,
      nextActions: input.goal?.nextActions,
      originatingRequest: input.message,
      channel: input.channel,
    });
  } catch { /* prompt-only fallback — never blocks the task */ }
  // Kick the daemon to drain THIS task now rather than on its next 15s tick — the
  // single choke point for every create path (dispatch_background_task, chat/mobile/
  // discord auto-promotion), so a backgrounded task actually fires, turns RUNNING on
  // the board, and registers a harness session to expand — instead of sitting pending.
  requestBackgroundDrain(1);
  return task;
}

// ── User-initiated "background it" control (the Claude Code ctrl+b model) ──────
//
// An ALWAYS-available user control to push the CURRENTLY-RUNNING foreground task
// to the background — the user decides WHEN, so there's no system guessing about
// timing. Handled at the inbound-message layer (before the model), like the
// needs_input / continue controls, so it works even mid-run.

/** Detect the explicit "push the running task to the background" control. Tight
 *  on purpose — only clear imperative forms — so it never eats a normal message
 *  that merely mentions "background". */
export function detectBackgroundItIntent(message: string): boolean {
  const m = message.trim().toLowerCase().replace(/[.!]+$/, '');
  return /^\/?(background (?:it|this)|run (?:it|this) in the background|take (?:it|this) to the background|move (?:it|this) to the background|do (?:it|this) in the background|send (?:it|this) to the background|finish (?:it|this) in the background)$/.test(m);
}

/** Resolve only from the exact user event durably bound to this attempt. A
 * reusable session's "latest" text is not ownership: under a stale click it
 * may already belong to a newer turn. During the one-release compatibility
 * window, an immediately-following acknowledgement can still recover the
 * objective from an older persisted alignment row. */
export function resolveBackgroundableObjective(
  sessionId: string,
  attempt: Pick<RunAttemptRef, 'sessionId' | 'attemptId'>,
): { objective: string; sourceUserSeq: number } | null {
  const source = getRunAttemptSourceUserEvent(attempt);
  if (!source) return null;
  const data = source.data as { text?: unknown; displayText?: unknown };
  const displayText = typeof data.displayText === 'string' ? data.displayText.trim() : '';
  const recordedText = typeof data.text === 'string' ? data.text.trim() : '';
  const fallback = displayText || recordedText;
  if (!fallback) return null;

  const aligned = effectiveTurnObjective(sessionId, fallback, source.seq).trim();
  // Title/objective truth (live 2026-07-23): a handoff triggered by a
  // CONVERSATIONAL turn ("you can keep working on it here please…") has no
  // legacy aligned objective, so effectiveTurnObjective returns the
  // raw utterance — and the background task got NAMED after the user's last
  // sentence instead of what the work IS. Precedence, all effect-anchored:
  //   1. the session's live GOAL contract (what this attempt executes against)
  //   2. the exact-turn legacy-aligned objective (upgrade compatibility)
  //   3. the active FOCUS (the durable "what am I working on" record)
  //   4. the session TITLE (already objective-derived)
  //   5. the utterance (last resort — today's fallback)
  let objective = aligned !== fallback ? aligned : '';
  try {
    const goal = getActiveGoalForSession(sessionId);
    const goalObj = goal ? (goal.approvedPlan ?? goal.plan).objective?.trim() : '';
    if (goalObj) objective = goalObj;
  } catch { /* the aligned turn objective remains authoritative */ }
  if (!objective) {
    try {
      objective = getActiveObjective()?.trim() ?? '';
    } catch { /* focus store is optional context */ }
  }
  if (!objective) {
    try {
      const title = getHarnessSession(sessionId)?.title?.trim() ?? '';
      // A derived session title is objective-ish; a bare id or "New chat" is not.
      if (title && !/^(new chat|untitled)/i.test(title) && !/^sess-/.test(title)) objective = title;
    } catch { /* session title is optional context */ }
  }
  if (!objective) objective = fallback;
  return objective ? { objective, sourceUserSeq: source.seq } : null;
}

export interface BackgroundItResult {
  handled: true;
  text: string;
  taskId: string;
  attemptId: string;
  replayed: boolean;
}

export interface ForegroundBackgroundTarget {
  attemptId: string;
  runId?: string | null;
  /** Server-projected scope proof for HTTP callers. Trusted in-process channel
   * controls may omit it because they already hold the concrete attempt. */
  runScopeId?: string | null;
}

function foregroundRunScopeId(
  sessionId: string,
  attempt: { attemptId: string; runId?: string | null },
): string {
  return `${sessionId}::brain:${attempt.runId ?? attempt.attemptId}`;
}

function backgroundItResult(
  task: BackgroundTaskRecord,
  attemptId: string,
  replayed: boolean,
): BackgroundItResult {
  return {
    handled: true,
    taskId: task.id,
    attemptId,
    replayed,
    text: `On it — moving "${task.title}" to the background now. It picks up where it was and reports back here when it's done. You're free to move on to something else.`,
  };
}

/**
 * Handle the "background it" control: STOP the in-flight foreground run (so it
 * doesn't double-execute) and continue the SAME objective as a goal-bound
 * background task that RESUMES from this session's recorded progress, then free
 * the chat. Returns null when there's no resolvable objective to background (the
 * caller then treats the message as an ordinary turn). Shared by every surface.
 *
 * Continuation is STRUCTURAL. Before the handoff is acknowledged, a durable
 * capsule is checkpointed and the handoff state machine is advanced, and the
 * background task carries their identities. What is already done comes from
 * that capsule, not from asking the model to read history and infer it —
 * bounded origin history remains context. requestKill still stops the
 * foreground at its next tool-call edge, so ≤1 in-flight foreground action may
 * still complete; the durable handoff record is what guarantees exactly one
 * OWNER from that point on.
 */
export function detachRunningTurnToBackground(
  sessionId: string,
  target: ForegroundBackgroundTarget,
  options: {
    source?: BackgroundTaskRecord['source'];
    channel?: string;
    userId?: string;
  } = {},
): BackgroundItResult | null {
  if (!target.attemptId?.trim()) return null;

  // Durable idempotency across a double-click, lost HTTP response, or daemon
  // restart. Rejoin the task even after its foreground attempt has settled.
  const existing = listBackgroundTasks({ includeArchived: true }).find((task) => (
    task.originSessionId === sessionId
    && task.foregroundHandoff?.sessionId === sessionId
    && task.foregroundHandoff.attemptId === target.attemptId
  ));
  if (existing) {
    const handoff = existing.foregroundHandoff!;
    if (target.runId !== undefined && target.runId !== (handoff.runId ?? null)) return null;
    if (target.runScopeId && target.runScopeId !== foregroundRunScopeId(sessionId, handoff)) return null;
    return backgroundItResult(existing, target.attemptId, true);
  }

  // Validate ownership at the mutation boundary. The HTTP/Discord caller may
  // also project an identity, but only this synchronous check prevents a stale
  // attempt-A control from killing or cloning the newer attempt B.
  const active = getActiveRunAttempt(sessionId);
  if (
    !active
    || active.attemptId !== target.attemptId
    || (target.runId !== undefined && target.runId !== active.runId)
    || (target.runScopeId && target.runScopeId !== foregroundRunScopeId(sessionId, active))
  ) return null;
  // An approval pause is stateful inside the foreground executor. Spawning a
  // fresh worker cannot safely inherit that pending decision and could bypass
  // or duplicate it, so the user must decide/reject it before handoff.
  if (isBackgroundHandoffApprovalBlocked(sessionId)) return null;
  const resolved = resolveBackgroundableObjective(sessionId, active);
  if (!resolved) return null;
  const throughSeq = getLatestEventSeq(sessionId);

  // ORDER IS THE INVARIANT. The durable transfer intent and the capsule are
  // written FIRST; only then is the foreground fenced. Fencing first means a
  // crash in the window between the kill and the enqueue leaves a stopped
  // foreground and no background task — the user's work has no owner at all,
  // and nothing durable records that it ever changed hands. With the intent
  // durable first, the worst crash leaves a recorded handoff that boot
  // reconciliation converges to exactly one owner.
  //
  // The logical task id is derived from the accepted attempt, so a double-click,
  // a lost response, or a restart rejoins this exact task.
  const logicalTaskId = `handoff:${sessionId}:${active.attemptId}`;
  const handoffIdentity = {
    logicalTaskId,
    acceptedAttemptId: active.attemptId,
    sessionId,
    sourceUserSeq: resolved.sourceUserSeq,
  };
  const requested = stepHandoff({ ...handoffIdentity, state: 'requested' });
  // Every ladder write is a value to act on, never fire-and-forget. A refusal
  // means someone else owns this attempt's transfer: the only safe answers are
  // to follow them or to decline, and admitting a worker anyway is how one
  // accepted turn ends up with two.
  const existingRung = requested.ok ? requested.record : requested.current;
  if (!existingRung || existingRung.state === 'terminal') return null;
  if (!requested.ok && handoffRank(existingRung.state) >= handoffRank('background_admitted')) {
    // Already admitted elsewhere. The task lookup above did not see it, so the
    // honest answer is to decline rather than mint a rival owner.
    return null;
  }

  const capsule = checkpointCapsule({
    ...projectCapsuleFromDurableState(logicalTaskId, sessionId, active.attemptId, {
      objective: resolved.objective,
      sourceUserSeq: resolved.sourceUserSeq,
      // History below this boundary is context; later turns in the reusable
      // origin chat are not this task's input.
      throughSeq,
    }),
    ...(existingRung.capsuleId ? { capsuleId: existingRung.capsuleId } : {}),
  });
  if (existingRung.state === 'requested') {
    const checkpointed = stepHandoff({ ...handoffIdentity, capsuleId: capsule.capsuleId, state: 'capsule_checkpointed' });
    if (!checkpointed.ok) return null;
  }

  const composedPrompt = [
    `Objective: ${resolved.objective}`,
    '',
    'You are CONTINUING this task in the background — the user just moved it here from a live chat.',
    'The durable continuation capsule below is authoritative for what is already done. '
      + 'The bounded origin history is context, not proof of completion; do not redo completed work.',
    'Work through to completion, then report the result back.',
  ].join('\n');
  try {
    // The id was decided by the accepted attempt, not minted here, so two
    // processes racing this exact detach contend for ONE task file instead of
    // each creating a runnable worker that will report back separately.
    const task = enqueueDurableChatTask({
      message: resolved.objective,
      composedPrompt,
      sessionId,
      source: options.source ?? 'desktop',
      channel: options.channel,
      userId: options.userId,
      explicitId: reservedBackgroundTaskId(active.attemptId),
      goal: { objective: resolved.objective },
      foregroundHandoff: {
        sessionId,
        attemptId: active.attemptId,
        ...(active.runId ? { runId: active.runId } : {}),
        sourceUserSeq: resolved.sourceUserSeq,
        throughSeq,
        capsuleId: capsule.capsuleId,
        // The worker validates against these before it resumes; a capsule that
        // no longer matches is a continuation nobody verified.
        capsuleDigest: capsule.digest,
        logicalTaskId,
      },
    });
    const admitted = stepHandoff({
      ...handoffIdentity,
      capsuleId: capsule.capsuleId,
      backgroundTaskId: task.id,
      state: 'background_admitted',
    });
    if (!admitted.ok && admitted.current?.state === 'terminal') return null;

    // Fence the foreground only once its durable replacement is admitted. The
    // fence RUNG itself is written by the terminal committer, where the
    // foreground actually stops — asserting it here would claim a boundary this
    // call has not reached.
    requestKill(sessionId, 'moved to background by user', active);
    return backgroundItResult(task, active.attemptId, false);
  } catch (error) {
    // Both halves matter. Clearing the latch returns the turn to the live
    // foreground; ending the handoff stops boot reconciliation from later
    // resurrecting a transfer that already failed and was handed back.
    try { clearKill(sessionId, active); } catch { /* preserve original error */ }
    try {
      endHandoff(handoffIdentity, `admission failed: ${error instanceof Error ? error.message : String(error)}`);
    } catch { /* preserve original error */ }
    throw error;
  }
}

/**
 * A background handoff cannot safely carry an in-process approval interrupt.
 * Keep this check shared so channel surfaces can explain the refusal before
 * asking the mutation boundary to perform it. Any inability to read approval
 * state fails closed: uncertainty here must never duplicate a pending action.
 */
export function isBackgroundHandoffApprovalBlocked(sessionId: string): boolean {
  try {
    const pendingApproval = approvalRegistry
      .listPending({ sessionId, status: 'pending' })
      .some((row) => approvalRegistry.isActionable(row));
    if (pendingApproval) return true;
    return Boolean(HarnessSession.load(sessionId)?.loadInterruptState());
  } catch {
    return true;
  }
}

/**
 * The conversational confirmation shown in the originating chat the instant a
 * turn is promoted. Tells the user three things that earn trust: it survives a
 * window close / restart, it reports back HERE, and it's watchable on the board.
 */
export function renderDurableTaskQueued(task: Pick<BackgroundTaskRecord, 'id' | 'title'>): string {
  return [
    `On it — I've started "${task.title}" as a background task, so it keeps running even if you close this window or I restart.`,
    `I'll report back right here the moment it's done (or if it gets stuck), and you can watch it live on the Tasks board.`,
  ].join(' ');
}
