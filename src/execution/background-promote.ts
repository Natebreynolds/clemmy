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
  if (hasDirectDurableDirective(intentText)) return true;
  return hasAutomaticDataPipelineShape(lower);
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
    return /\b(build|implement|migrate|refactor|wire|ship|deploy|fix|create|set up|setup|finish)\b/.test(text);
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

function hasAutomaticDataPipelineShape(lower: string): boolean {
  // Skip obvious pure questions/explanations. These can mention several services
  // without asking Clementine to move data through them.
  if (/^(?:please\s+)?(?:what|why|how|when|who|where|explain|summarize|tell me about)\b/.test(lower)) return false;

  const serviceHits = countHits(lower, [
    /\bsalesforce\b/,
    /\b(?:sf|sfdx)\s+(?:cli|data|org|query)\b/,
    /\bcli\b/,
    /\bapify\b/,
    /\bmcp\b/,
    /\bairtable\b/,
    /\bcrm\b/,
    /\bgoogle\s+(?:reviews?|business|maps?|search)\b/,
    /\bdataforseo\b/,
    /\bseo\b/,
    /\bhubspot\b/,
    /\blinkedin\b/,
    /\bsheets?\b|\bgoogle\s+sheets?\b/,
  ]);

  const actionHits = countHits(lower, [
    /\bpull\b|\bfetch\b|\bquery\b|\bexport\b|\bimport\b|\bcollect\b|\bgather\b/,
    /\bscrape\b|\bscrap\b|\bcrawl\b/,
    /\benrich\b|\banaly[sz]e\b|\bscore\b|\bclassify\b|\bclean\b|\bdedupe\b/,
    /\brun\b|\buse\b|\bvia\b/,
    /\badd\b|\bwrite\b|\bupdate\b|\bcreate\b|\binsert\b|\bappend\b|\bsync\b|\bpush\b|\bload\b/,
  ]);

  const batchHits = countHits(lower, [
    /\bfull\s+data\b|\ball\s+(?:of\s+)?(?:the\s+)?data\b/,
    /\ball\s+(?:of\s+)?(?:the\s+)?(?:[\w-]+\s+){0,3}(?:records?|accounts?|leads?|prospects?|companies?)\b/,
    /\bevery\s+(?:[\w-]+\s+){0,3}(?:records?|accounts?|leads?|prospects?|companies?)\b/,
    /\bbulk\b|\bbatch\b|\bat\s+scale\b/,
    /\b\d+\+?\s+(?:different\s+)?(?:actors?|sources?|records?|accounts?|leads?|prospects?|companies?)\b/,
    /\bmultiple\s+(?:actors?|sources?|systems?|records?|accounts?|leads?)\b/,
  ]);

  const pipelineHits = countHits(lower, [
    /\bthen\b|\band\s+then\b|\bafter\b|\bfinally\b|\bonce\b/,
    /\bfrom\b.{0,80}\b(?:to|into)\b/,
    /\b(?:add|write|update|create|insert|append|sync|push|load)\b.{0,50}\b(?:to|into|in)\b/,
    /\bsub-?agents?\b|\bworkers?\b|\bfan\s*out\b|\bactors?\b/,
  ]);

  const destinationHit = /\b(?:add|write|update|create|insert|append|sync|push|load)\b.{0,80}\b(?:airtable|crm|sheet|database|table|records?)\b/.test(lower)
    || /\b(?:to|into)\s+(?:my\s+)?(?:airtable|crm|sheet|database)\b/.test(lower);

  if (destinationHit && serviceHits >= 2 && batchHits >= 1 && pipelineHits >= 1 && actionHits >= 2) return true;
  if (serviceHits >= 3 && actionHits >= 2 && batchHits >= 1 && pipelineHits >= 1) return true;
  if (lower.length >= 180 && serviceHits >= 2 && actionHits >= 3 && batchHits >= 1) return true;

  return false;
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
export function shouldPromoteToDurable(message: string, opts?: { sessionId?: string }): boolean {
  if (stripBackgroundPrefix(message).trim().length === 0) return false;
  if (isSpaceSession(opts?.sessionId)) {
    const lower = message.toLowerCase().replace(/\s+/g, ' ').trim();
    return hasExplicitBackgroundDirective(stripNegatedDurableIntent(lower));
  }
  return hasDurableExecutionIntent(message);
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
 * may already belong to a newer turn. Confirmation turns are expanded through
 * their persisted preflight decision so "go ahead" retains the agreed ask. */
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
  // execute-phase aligned objective, so effectiveTurnObjective returns the
  // raw utterance — and the background task got NAMED after the user's last
  // sentence instead of what the work IS. Precedence, all effect-anchored:
  //   1. the session's live GOAL contract (what this attempt executes against)
  //   2. the exact-turn ALIGNED objective (a real execute-phase decision)
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
 * Dedup across the origin→background boundary is SOFT and BOUNDED, not hard:
 * requestKill stops the foreground at its NEXT assertNotKilled (tool-call edge),
 * so one already-in-flight foreground tool call can still complete; and the
 * background task avoids redo only by being told to read session_history first
 * (LLM-honored). So the overlap is bounded to ≤1 in-flight foreground action +
 * soft progress-diffing — acceptable for v1 (this is the resume-not-restart
 * tradeoff). A hard cross-session idempotency key would be the stronger fix.
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

  // Latch the exact foreground attempt before making its durable replacement.
  // If persistence fails synchronously, release only this latch so foreground
  // work is not silently lost. enqueue's drain yields after this call stack.
  requestKill(sessionId, 'moved to background by user', active);
  const composedPrompt = [
    `Objective: ${resolved.objective}`,
    '',
    'You are CONTINUING this task in the background — the user just moved it here from a live chat.',
    `Your progress so far is recorded in session "${sessionId}" through event ${throughSeq}. Call session_history with session_id="${sessionId}" and through_seq=${throughSeq} FIRST to see what is already done, then continue from there — do NOT read later turns or redo completed work.`,
    'Work through to completion, then report the result back.',
  ].join('\n');
  try {
    const task = enqueueDurableChatTask({
      message: resolved.objective,
      composedPrompt,
      sessionId,
      source: options.source ?? 'desktop',
      channel: options.channel,
      userId: options.userId,
      goal: { objective: resolved.objective },
      foregroundHandoff: {
        sessionId,
        attemptId: active.attemptId,
        ...(active.runId ? { runId: active.runId } : {}),
        sourceUserSeq: resolved.sourceUserSeq,
        throughSeq,
      },
    });
    return backgroundItResult(task, active.attemptId, false);
  } catch (error) {
    try { clearKill(sessionId, active); } catch { /* preserve original error */ }
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
