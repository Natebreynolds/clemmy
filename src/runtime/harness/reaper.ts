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
  /** Run one sweep immediately before scheduling the periodic timer. */
  runImmediately?: boolean;
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
    if (opts.runImmediately ?? true) tick();
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
  // 1) TTL-based expiry (24h default) — long fallback for "user is
  // away for the day" cases.
  const expired = approvalRegistry.expireStaleApprovals(new Date());

  // 2) Session-status-aware reap: if a pending approval is tied to a
  // session that's no longer active (cancelled / completed / failed)
  // AND the approval is old enough to be a real orphan, cancel it so
  // the dashboard "NEEDS YOU" surface stops showing it.
  //
  // Two guards added 2026-05-21 after sess-mpf4pkru where this reaper
  // killed a LIVE workflow_schedule approval that had just been
  // requested in a new turn. Root cause: session.markStatus('completed')
  // fires when a turn ends, but a NEW user message starts another turn
  // on the same session without resetting status back to 'active'. So
  // the second turn's approvals point at a session row showing
  // 'completed' even though the run is mid-flight.
  //
  // Guard 1 — `MIN_APPROVAL_AGE_MS`: don't reap approvals younger than
  // 90s. A genuinely orphan approval will still be there 90s later;
  // killing one that fresh is almost certainly a race against the
  // session's revival.
  //
  // Guard 2 — interrupt-state present: if the session has a saved
  // RunState blob, the SDK is actively paused on this very approval.
  // It's by definition alive.
  const MIN_APPROVAL_AGE_MS = 90_000;
  const now = Date.now();
  try {
    const stillPending = approvalRegistry.listPending({ status: 'pending' });
    for (const row of stillPending) {
      // Guard 1: skip freshly-registered approvals.
      const requestedAtMs = Date.parse(row.requestedAt);
      if (Number.isFinite(requestedAtMs) && now - requestedAtMs < MIN_APPROVAL_AGE_MS) continue;

      let dead = false;
      try {
        const session = HarnessSession.load(row.sessionId);
        if (!session) {
          dead = true;
        } else if (
          session.sessionRow.status === 'completed'
          || session.sessionRow.status === 'cancelled'
          || session.sessionRow.status === 'failed'
        ) {
          // Guard 2: even if status looks dead, the run might be paused
          // on this exact approval. Interrupt state is the source of
          // truth for "is the SDK still alive on this session".
          if (session.loadInterruptState()) {
            dead = false;
          } else {
            dead = true;
          }
        }
      } catch {
        // Session row malformed / missing — treat as dead.
        dead = true;
      }
      if (!dead) continue;
      const result = approvalRegistry.resolve(row.approvalId, 'cancelled_by_user', 'reaper-dead-session');
      if (result.ok && result.row) {
        expired.push(result.row);
        logger.info(
          { approvalId: row.approvalId, sessionId: row.sessionId, subject: row.subject },
          'approval cancelled — session no longer active',
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'session-status reap pass failed',
    );
  }

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
      // Reports-back (P1): don't let a failed cleanup stay invisible. If
      // the interrupt state couldn't be cleared, the session may be wedged
      // — tell the user instead of leaving a ghost pause only in the logs.
      try {
        addNotification({
          id: `interrupt-clear-failed-${row.approvalId}-${randomUUID().slice(0, 8)}`,
          kind: 'system',
          title: 'Session cleanup failed after approval expired',
          body: `The expired approval on **${row.subject}** could not be cleared from its session, which may leave it stuck. If that session stops responding, restart the daemon.`,
          createdAt: new Date().toISOString(),
          read: false,
          metadata: { approvalId: row.approvalId, sessionId: row.sessionId },
        });
      } catch {
        /* best-effort — the warning above is still in the logs */
      }
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
