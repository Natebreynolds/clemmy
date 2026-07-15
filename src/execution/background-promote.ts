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
import { createBackgroundTask, requestBackgroundDrain, type BackgroundReportBackTarget, type BackgroundTaskRecord } from './background-tasks.js';
import { requestKill, listEvents } from '../runtime/harness/eventlog.js';
import { getActiveGoalForSession, bindBackgroundRunGoal } from '../agents/plan-proposals.js';

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
  if (hasDirectDurableDirective(intentText)) return true;
  return hasAutomaticDataPipelineShape(lower);
}

function startsAsForegroundDiscussion(text: string): boolean {
  return /^(?:please\s+)?(?:summarize|review|discuss|explain|tell me about|walk me through)\b/.test(text);
}

function hasDirectDurableDirective(text: string): boolean {
  if (/^\/?(background|bg)\b/.test(text)) return true;
  if (/\b(run|queue|start).{0,40}\b(background|overnight|as a job)\b/.test(text)) return true;
  if (/\b(?:move|take|send|put)\s+(?:this|it|that|the request|the task)\s+(?:to|into)\s+the\s+background\b/.test(text)) return true;
  if (/\b(?:do|finish)\s+(?:this|it|that|the request|the task)\s+in\s+the\s+background\b/.test(text)) return true;
  if (/\b(?:in the background|overnight|as a job|keep working|don't stop|do not stop|longer running|take your time)\b/.test(text)) return true;
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
 * The promotion gate the interactive surfaces should call. Promote only when
 * there is durable intent AND a non-empty instruction once the command prefix is
 * stripped — so a bare "/background" (no actual task) does NOT queue a
 * content-free worker; it falls through to a normal turn instead.
 */
export function shouldPromoteToDurable(message: string): boolean {
  return hasDurableExecutionIntent(message) && stripBackgroundPrefix(message).trim().length > 0;
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
export function enqueueDurableChatTask(input: EnqueueDurableChatTaskInput): BackgroundTaskRecord {
  // A composed prompt (the agreed plan from dispatch_background_task) is used
  // verbatim; otherwise strip a keyword prefix from the raw user message.
  const prompt = input.composedPrompt?.trim()
    || stripBackgroundPrefix(input.message)
    || input.message;
  const task = createBackgroundTask({
    title: deriveTitle(input.message) || deriveTitle(prompt),
    prompt,
    originSessionId: input.sessionId,
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

/** Resolve the objective of the in-flight / just-run task for this session: the
 *  pinned goal if any, else the most recent real user request (never the
 *  background-it control itself). Null when there's nothing to background. */
function resolveBackgroundableObjective(sessionId: string): string | null {
  try {
    const goal = getActiveGoalForSession(sessionId);
    const goalObj = goal ? (goal.approvedPlan ?? goal.plan).objective?.trim() : '';
    if (goalObj) return goalObj;
  } catch { /* fall through to recent input */ }
  try {
    const inputs = listEvents(sessionId, { types: ['user_input_received'] })
      .map((e) => String((e.data as { text?: string } | undefined)?.text ?? '').trim())
      .filter((t) => t.length > 0 && !detectBackgroundItIntent(t))
      // Synthetic harness inputs (stall-retry directives etc.) are not the
      // user's ask — they'd hijack the objective the same way a short answer did.
      .filter((t) => !/^Your previous response could not be parsed/i.test(t));
    if (inputs.length === 0) return null;
    // The TASK statement is almost never the LAST message — clarification
    // answers land after it ("Facebook please" became a background task title,
    // live 2026-07-08). Anchor on the most SUBSTANTIVE recent input (longest of
    // the last 6) and append any later short answers as qualifiers, so the
    // objective reads "pull the last 5 social posts… — Facebook please".
    const recent = inputs.slice(-6);
    let anchorIdx = 0;
    for (let i = 1; i < recent.length; i += 1) if (recent[i].length > recent[anchorIdx].length) anchorIdx = i;
    const qualifiers = recent.slice(anchorIdx + 1).filter((t) => t.length <= 120);
    return qualifiers.length > 0 ? `${recent[anchorIdx]} — ${qualifiers.join('; ')}` : recent[anchorIdx];
  } catch {
    return null;
  }
}

export interface BackgroundItResult { handled: true; text: string; taskId: string; }

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
export function detachRunningTurnToBackground(sessionId: string): BackgroundItResult | null {
  const objective = resolveBackgroundableObjective(sessionId);
  if (!objective) return null;
  // Stop the foreground run so the same work doesn't run twice.
  try { requestKill(sessionId, 'moved to background by user'); } catch { /* best effort */ }
  const composedPrompt = [
    `Objective: ${objective}`,
    '',
    'You are CONTINUING this task in the background — the user just moved it here from a live chat.',
    `Your progress so far is recorded in session "${sessionId}". Call session_history with that id FIRST to see what is already done, then continue from there — do NOT redo completed work.`,
    'Work through to completion, then report the result back.',
  ].join('\n');
  const task = enqueueDurableChatTask({ message: objective, composedPrompt, sessionId, source: 'desktop', goal: { objective } });
  return {
    handled: true,
    taskId: task.id,
    text: `On it — moving "${task.title}" to the background now. It picks up where it was and reports back here when it's done. You're free to move on to something else.`,
  };
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
