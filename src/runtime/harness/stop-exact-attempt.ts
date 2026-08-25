/**
 * Stop ONE durable chat attempt — the single Stop primitive every surface
 * shares.
 *
 * Extracted from the desktop console route so the mobile app can stop a live
 * turn at all. Before this, the phone's engine `stop()` was stream-detach only:
 * the screen went quiet and the backend kept burning — model calls, tool calls,
 * external writes — with no way to reach the kill latch from mobile. Stopping
 * work is not a desktop feature.
 *
 * Semantics, unchanged from the desktop original and shared by construction:
 *  - The kill latch is EXACT: it names the attempt and run id, so a stale
 *    button click can never widen into a session-wide kill.
 *  - Approval rows predate attempt ids, so only the session's currently-active
 *    attempt clears its time-bounded approvals/interrupt state; on a stale
 *    attempt the latch still lands and nothing else is touched.
 *  - Cascade: background tasks this session spawned (or that run AS it) die
 *    with the stop. Without this the task row kept polling "Working now" after
 *    the user explicitly stopped the chat that owned it (live 2026-07-08), and
 *    its external writes kept landing.
 */
import {
  getActiveRunAttempt,
  requestKill,
  type RunAttemptRef,
} from './eventlog.js';
import * as approvalRegistry from './approval-registry.js';
import { HarnessSession } from './session.js';
import { listBackgroundTasks, cancelBackgroundTask } from '../../execution/background-tasks.js';

export function stopExactHarnessAttempt(
  sessionId: string,
  attempt: RunAttemptRef,
  reason: string,
  resolver: string,
): { cancelledApprovals: number; cancelledTasks: number } {
  requestKill(sessionId, reason, {
    attemptId: attempt.attemptId,
    runId: attempt.runId,
  });
  const current = getActiveRunAttempt(sessionId);
  if (!current || current.attemptId !== attempt.attemptId) return { cancelledApprovals: 0, cancelledTasks: 0 };

  const pending = approvalRegistry.listPending({ sessionId, status: 'pending' })
    .filter((row) => row.requestedAt >= attempt.startedAt);
  let cancelledApprovals = 0;
  for (const row of pending) {
    if (approvalRegistry.resolve(
      row.approvalId,
      'cancelled_by_user',
      resolver,
    ).ok) cancelledApprovals += 1;
  }
  if (cancelledApprovals > 0) {
    try {
      HarnessSession.load(sessionId)?.clearInterruptState({ emitEvent: false });
    } catch { /* the durable kill and approval resolutions remain authoritative */ }
  }
  let cancelledTasks = 0;
  try {
    for (const task of listBackgroundTasks()) {
      const t = task as { id: string; status: string; sessionId?: string; originSessionId?: string; runSessionId?: string };
      const linked = t.sessionId === sessionId || t.originSessionId === sessionId || t.runSessionId === sessionId;
      const active = t.status === 'pending' || t.status === 'running' || t.status === 'awaiting_approval';
      if (linked && active) {
        cancelBackgroundTask(t.id, 'Cancelled with its chat session when the user stopped the run.');
        cancelledTasks += 1;
      }
    }
  } catch { /* best effort — the stale-runner sweeper still interrupts them later */ }
  return { cancelledApprovals, cancelledTasks };
}
