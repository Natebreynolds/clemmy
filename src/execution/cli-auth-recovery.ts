import pino from 'pino';
import { onCliAuthRecovered, onCliSignedOut, type CliHealth } from '../integrations/cli-catalog/auth-health.js';

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
  onCliSignedOut((health) => {
    void notifySignedOut(health).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), cli: health.id },
        'cli signed-out notification failed',
      );
    });
  });
}

/**
 * Proactive "your CLI login expired" notice — fired once per transition
 * INTO signed_out, daily-bucketed by deterministic id so a flapping probe
 * can never flood the inbox. Scope: connected catalog CLIs (the user's
 * explicit roster) and anything a parked task is tagged on. Workflow runs
 * that hit a dead CLI mid-run park and notify through their own
 * capability machinery — this notice exists so the user can fix the login
 * BEFORE the 8am run discovers it. Saved-but-probeless CLIs cannot
 * transition, so nothing here fires for them.
 */
async function notifySignedOut(health: CliHealth): Promise<void> {
  const { listBackgroundTasks } = await import('./background-tasks.js');
  const taggedParked = listBackgroundTasks({ status: 'awaiting_input' })
    .filter((task) => task.blockedOnCli === health.command);
  const { readConnectedClis, findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
  const connected = readConnectedClis()[health.id];
  if (!connected && taggedParked.length === 0) return; // pill-only: not on the explicit roster

  const entry = findCatalogEntry(health.id);
  const name = connected?.name ?? entry?.name ?? health.command;
  const fix = entry?.authHeadless
    ? 'One-click Sign in from Connect → Command-line tools.'
    : `Run \`${entry?.authCommand ?? connected?.authCommand ?? `${health.command} login`}\` in your terminal, or open Connect → Command-line tools.`;
  const parkedNote = taggedParked.length > 0
    ? ` ${taggedParked.length} parked task${taggedParked.length === 1 ? ' is' : 's are'} waiting on it and will resume automatically once you sign in.`
    : '';
  const { addNotification } = await import('../runtime/notifications.js');
  addNotification({
    id: `cli-auth-${health.id}-${new Date().toISOString().slice(0, 10)}`,
    kind: 'system',
    title: `${name} is signed out`,
    body: `The ${health.command} CLI lost its sign-in.${parkedNote} ${fix}`,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { kind: 'cli-auth', cliId: health.id, command: health.command, link: '/connect' },
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
