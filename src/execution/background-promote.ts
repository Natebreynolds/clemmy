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
import { createBackgroundTask, type BackgroundTaskRecord } from './background-tasks.js';

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
  if (/^\/?(background|bg)\b/.test(lower)) return true;
  if (/\b(run|queue|start).{0,40}\b(background|overnight|as a job)\b/.test(lower)) return true;
  if (/\b(keep working|don't stop|do not stop|long-running|longer running|overnight|take your time)\b/.test(lower)) return true;
  if (/\b(from start to finish|end to end|get it done|finish this|finish it all)\b/.test(lower)) {
    return /\b(build|implement|migrate|refactor|wire|ship|deploy|fix|create|set up|setup|finish)\b/.test(lower);
  }
  return hasAutomaticDataPipelineShape(lower);
}

function hasAutomaticDataPipelineShape(lower: string): boolean {
  // Skip obvious pure questions/explanations. These can mention several services
  // without asking Clementine to move data through them.
  if (/^(what|why|how|when|who|where|explain|summarize|tell me about)\b/.test(lower)) return false;

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
  return message.trim()
    .replace(/^\/?(background|bg)\s*[:\-]?\s*/i, '')
    .trim();
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
   * The interactive session that spawned this task. REQUIRED for report-back —
   * the daemon feeds the result back into this session's transcript on
   * completion. Without it the result is notification-only.
   */
  sessionId: string;
  userId?: string;
  channel?: string;
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
  return createBackgroundTask({
    title: deriveTitle(input.message) || deriveTitle(prompt),
    prompt,
    originSessionId: input.sessionId,
    userId: input.userId,
    channel: input.channel,
    model: input.model ?? MODELS.deep,
    maxMinutes: input.maxMinutes ?? loadProactivityPolicy().defaultLongTaskMinutes,
    source: input.source ?? 'gateway',
  });
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
