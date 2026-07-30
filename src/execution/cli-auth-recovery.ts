import pino from 'pino';
import { onCliAuthRecovered, type CliHealth } from '../integrations/cli-catalog/auth-health.js';

/**
 * Auth-recovery sweep: when a roster CLI transitions signed_out→ok (a
 * completed sign-in job or an out-of-band `railway login`), parked work
 * that was blocked on EXACTLY that CLI resumes on its own instead of
 * waiting for the user to notice and type `continue`.
 *
 * Deliberately conservative, per the plan's blast-radius contract:
 * - Workflows: one eager reap of capability-blocked runs. They already
 *   self-heal by polling (1→15 min backoff); this only shortens the wait.
 * - Background tasks: ONLY tasks carrying the structured `blockedOnCli`
 *   tag for this command, resumed through the canonical
 *   queueBackgroundTaskInputResolution verb (all transition bookkeeping
 *   holds), capped per event. A task that merely MENTIONS the CLI in
 *   text is never resumed — it may be waiting on real human input.
 */

const logger = pino({ name: 'clementine-next.cli-auth-recovery' });

/** Bound the per-event blast radius; anything beyond the cap stays parked
 *  for the user (they got the recovery notification either way). */
const MAX_AUTO_RESUMES_PER_EVENT = 5;

let registered = false;

export function registerCliAuthRecoverySweep(): void {
  if (registered) return;
  registered = true;
  onCliAuthRecovered((health) => {
    void sweepOnRecovery(health).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), cli: health.id },
        'cli auth-recovery sweep failed',
      );
    });
  });
}

async function sweepOnRecovery(health: CliHealth): Promise<void> {
  // 1) Workflows parked on a dead capability: eager reap, zero new
  //    semantics — the tick-driven poll remains the backstop.
  try {
    const { reapCapabilityBlockedRuns } = await import('./workflow-runner.js');
    reapCapabilityBlockedRuns();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'eager capability reap failed');
  }

  // 2) Background tasks tagged blockedOnCli === this command.
  const { listBackgroundTasks, queueBackgroundTaskInputResolution } = await import('./background-tasks.js');
  const tagged = listBackgroundTasks({ status: 'awaiting_input' })
    .filter((task) => task.blockedOnCli === health.command && task.pendingQuestionId);
  let resumed = 0;
  for (const task of tagged) {
    if (resumed >= MAX_AUTO_RESUMES_PER_EVENT) break;
    try {
      const record = queueBackgroundTaskInputResolution(
        task.pendingQuestionId!,
        `${health.command} is signed in again${health.username ? ` (as ${health.username})` : ''} — continue from saved progress.`,
      );
      if (record) resumed += 1;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), taskId: task.id },
        'auth-recovery resume failed for one task; it stays parked for the user',
      );
    }
  }
  if (tagged.length > 0) {
    logger.info(
      { cli: health.command, tagged: tagged.length, resumed, capped: tagged.length > resumed },
      'cli auth-recovery sweep resumed parked background tasks',
    );
  }
}
