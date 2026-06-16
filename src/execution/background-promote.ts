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
 * The trigger is EXPLICIT user intent only (see `hasDurableExecutionIntent`),
 * which is itself the user's "approve once, run to completion" opt-in. Plain
 * asks still run foreground unchanged. Because the blast radius is bounded to
 * explicit intent, this ships without a rollout flag (validated behavior is the
 * default).
 */
import { MODELS } from '../config.js';
import { loadProactivityPolicy } from '../agents/proactivity-policy.js';
import { deriveTitle } from '../memory/derive-title.js';
import { createBackgroundTask, type BackgroundTaskRecord } from './background-tasks.js';

/**
 * Explicit, user-expressed intent to run this work as a durable background job.
 * Keyword/regex matcher (NOT a model call): a `/background` prefix, an explicit
 * "run … in the background / overnight / as a job", a "keep working / don't
 * stop / take your time", or a finish-it-all phrase paired with a build verb.
 *
 * Conservative by design — a plain "build me a site" returns false and keeps
 * running foreground. (Moved verbatim from gateway/router.ts so the gateway,
 * desktop dock, and Discord share one decision.)
 */
export function hasDurableExecutionIntent(message: string): boolean {
  const lower = message.toLowerCase();
  if (/^\/?(background|bg)\b/.test(lower)) return true;
  if (/\b(run|queue|start).{0,40}\b(background|overnight|as a job)\b/.test(lower)) return true;
  if (/\b(keep working|don't stop|do not stop|long-running|longer running|overnight|take your time)\b/.test(lower)) return true;
  if (/\b(from start to finish|end to end|get it done|finish this|finish it all)\b/.test(lower)) {
    return /\b(build|implement|migrate|refactor|wire|ship|deploy|fix|create|set up|setup|finish)\b/.test(lower);
  }
  return false;
}

/** Strip a leading `/background` / `bg:` command prefix from the user's message. */
export function stripBackgroundPrefix(message: string): string {
  return message.trim()
    .replace(/^\/?(background|bg)\s*[:\-]?\s*/i, '')
    .trim();
}

/**
 * The promotion gate the interactive surfaces should call. Promote only when
 * there's explicit durable intent AND a non-empty instruction once the command
 * prefix is stripped — so a bare "/background" (no actual task) does NOT queue a
 * content-free worker; it falls through to a normal turn instead.
 */
export function shouldPromoteToDurable(message: string): boolean {
  return hasDurableExecutionIntent(message) && stripBackgroundPrefix(message).trim().length > 0;
}

export interface EnqueueDurableChatTaskInput {
  /** The user's message (a leading background prefix is stripped automatically). */
  message: string;
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
  const prompt = stripBackgroundPrefix(input.message) || input.message;
  return createBackgroundTask({
    title: deriveTitle(prompt),
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
