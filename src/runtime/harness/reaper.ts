/**
 * Approval reaper — periodic sweep that expires past-due rows from
 * pending_approvals and surfaces them to the user so a stuck approval
 * never sits forever.
 *
 * Why this exists: the audit on 2026-05-18 found 3 orphan paused
 * sessions where the user expected the approval to land but it never
 * did. Without a reaper, a session can sit in `__interrupt_state`
 * indefinitely; the user has no signal that the work was lost.
 *
 * The reaper:
 *   1. Calls approvalRegistry.expireStaleApprovals() every TICK_MS.
 *   2. For each row that just expired, clears the session's
 *      interrupt state, marks the session 'cancelled' (so future
 *      messages start fresh instead of trying to resume), and posts
 *      a user-facing notification explaining what was lost so the
 *      user can re-ask.
 *
 * Lifecycle:
 *   - Started from the daemon bootstrap (daemon/runner.ts) via
 *     `startApprovalReaper()`.
 *   - Stopped via the returned disposer on daemon shutdown.
 *
 * Flag: behavior is always on once started — the reaper expiry TTL is
 * configured per-approval (DEFAULT_APPROVAL_TTL_MS = 24h). To disable
 * the reaper entirely, simply don't call startApprovalReaper().
 */

import pino from 'pino';
import * as approvalRegistry from './approval-registry.js';
import { HarnessSession } from './session.js';
import { addNotification } from '../notifications.js';
import { randomUUID } from 'node:crypto';

const logger = pino({ name: 'clementine-next.approval-reaper' });

const DEFAULT_TICK_MS = 60_000; // sweep once a minute

let activeInterval: NodeJS.Timeout | null = null;

interface StartOptions {
  /** Sweep cadence; defaults to 60s. */
  tickMs?: number;
  /** Test injection — fire immediately and return the disposer with
   *  no setInterval scheduled. */
  immediate?: boolean;
}

/**
 * Start the periodic reaper. Idempotent — calling twice is a no-op.
 * Returns a disposer that stops the timer.
 */
export function startApprovalReaper(opts: StartOptions = {}): () => void {
  if (activeInterval) {
    logger.debug('approval-reaper already running; ignoring duplicate start');
    return () => stopApprovalReaper();
  }
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const tick = (): void => {
    try {
      reapOnce();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'reaper tick failed');
    }
  };
  if (opts.immediate) {
    tick();
  } else {
    activeInterval = setInterval(tick, tickMs);
    activeInterval.unref?.();
  }
  return () => stopApprovalReaper();
}

export function stopApprovalReaper(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
}

/**
 * Single reaper sweep. Exposed for tests + the "run once now" admin
 * path. Returns the list of rows that were just expired so callers
 * can inspect the effect.
 */
export function reapOnce(): approvalRegistry.PendingApprovalRow[] {
  const expired = approvalRegistry.expireStaleApprovals(new Date());
  for (const row of expired) {
    // Clear the SDK interrupt state so the next user message in this
    // session starts a fresh turn instead of trying to resume the
    // long-dead pause.
    try {
      const session = HarnessSession.load(row.sessionId);
      if (session) {
        session.clearInterruptState();
        session.markStatus('cancelled');
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, sessionId: row.sessionId },
        'reaper failed to clear interrupt state',
      );
    }

    // Surface the loss to the user. Without this, the user has no
    // way to know "I asked you to do X 25 hours ago and you silently
    // gave up." The notification is the trail back to action.
    try {
      addNotification({
        id: `approval-expired-${row.approvalId}-${randomUUID().slice(0, 8)}`,
        kind: 'system',
        title: 'Approval expired',
        body: `The approval on **${row.subject}** expired without a reply. The session was cancelled. Re-ask and I'll redo it.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: {
          approvalId: row.approvalId,
          sessionId: row.sessionId,
          subject: row.subject,
          tool: row.tool,
        },
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, approvalId: row.approvalId },
        'reaper failed to deliver expiry notification',
      );
    }

    logger.info(
      { approvalId: row.approvalId, sessionId: row.sessionId, subject: row.subject },
      'approval expired',
    );
  }
  return expired;
}
