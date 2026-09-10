/**
 * Outbound channel starts must never be a boot gate.
 *
 * 2026-09-10: a packaged 3.18.1 daemon crash-looped four times in five minutes.
 * Discord's gateway handshake exceeded its timeout, `await client.login()`
 * rejected, and because that await sits inside startDaemon's `onReady` the
 * rejection unwound through `main().catch` → `process.exit(1)` — killing a
 * daemon that had already bound its listeners, finished boot reconciliation and
 * was serving the app. Every restart then replayed ~35s of boot work over a
 * 1.1GB harness.db, which the owner experienced as "loading very slow and
 * spaces wont load".
 *
 * The readiness boundary in daemon/runner.ts is right to be fatal about a FAILED
 * BIND — a daemon that cannot open its own door must not be reported healthy.
 * But an outbound session to a third party is a different class: it says nothing
 * about this daemon's health, and every other subsystem keeps working without
 * it. `startWebhookServer` already draws exactly this line for its own outbound
 * legs ("Mobile relay unavailable; phone access stays LAN-only"); Discord and
 * Slack simply never got it.
 *
 * So: degrade with a named consequence, then keep trying. This lives in its own
 * module rather than in index.ts because index.ts is a CLI entrypoint whose
 * import runs `main()` — a behavioral pin could not reach it there, which is a
 * large part of how this defect survived a green suite for two months.
 */
import pino from 'pino';
import { isSurvivableSocketError } from './process.js';

const logger = pino({ name: 'clementine-next.optional-channel' });

export const CHANNEL_RETRY_BASE_MS = 30_000;
export const CHANNEL_RETRY_MAX_MS = 15 * 60_000;

export interface OptionalChannelOptions {
  /** Injected in tests so a pin never waits on a real 30s timer. `run` returns
   *  the retry's promise so a test can await the whole chain deterministically;
   *  production ignores it and lets the timer fire. */
  schedule?: (run: () => Promise<void>, delayMs: number) => void;
  /** Bounds the retry chain in tests; unbounded (undefined) in production —
   *  a channel that is down all afternoon should still reconnect at 15:00. */
  maxAttempts?: number;
}

function defaultSchedule(run: () => Promise<void>, delayMs: number): void {
  const timer = setTimeout(() => { void run(); }, delayMs);
  // Never hold the process open for a pending reconnect.
  timer.unref?.();
}

/**
 * Start an outbound channel client. A failure degrades the channel and schedules
 * a capped-backoff retry; it never rejects, so it can never fail the daemon's
 * readiness boundary.
 */
export async function startOptionalChannel(
  channel: string,
  consequence: string,
  start: () => Promise<void>,
  options: OptionalChannelOptions = {},
  attempt = 1,
): Promise<void> {
  const schedule = options.schedule ?? defaultSchedule;
  try {
    await start();
    if (attempt > 1) logger.info({ channel, attempt }, `${channel} reconnected`);
  } catch (err) {
    // A transport timeout/reset is the expected flake here. Anything else is
    // still not worth the daemon: by this point it is bound and serving, so a
    // broken channel is a degraded feature, not a dead process.
    if (options.maxAttempts !== undefined && attempt >= options.maxAttempts) {
      logger.warn({ err, channel, attempt }, `${channel} unavailable; ${consequence} — retries exhausted`);
      return;
    }
    const delay = Math.min(CHANNEL_RETRY_BASE_MS * 2 ** (attempt - 1), CHANNEL_RETRY_MAX_MS);
    logger.warn(
      { err, channel, attempt, retryInMs: delay, transport: isSurvivableSocketError(err) },
      `${channel} unavailable; ${consequence} — retrying in the background`,
    );
    schedule(() => startOptionalChannel(channel, consequence, start, options, attempt + 1), delay);
  }
}
