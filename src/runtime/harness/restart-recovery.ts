/**
 * Restart recovery for in-flight CHAT runs.
 *
 * A harness chat run executes in an in-process loop (runConversation) with no
 * boot-time resumer — unlike background tasks/workflows, which the daemon
 * re-spawns on boot. So a daemon restart MID-RUN previously killed a long chat
 * task SILENTLY: the user got no result and no notice (only completed turns
 * survived in the event log). That violates the north-star "long-running without
 * failing" + "reports back without fail".
 *
 * This closes the report-back gap (not full auto-resume): runConversation marks
 * the session in-flight on entry and clears it in a finally on ANY exit, so a
 * marker that survives a restart unambiguously means "this run was killed
 * mid-flight". On boot we surface each such chat run with a non-silent
 * conversation_completed (so the session shows it, and a `continue` resumes with
 * full replayed context) plus a bounded notification, then clear the marker.
 *
 * Chat-only by construction (the marker is only set for kind='chat'); workflow/
 * agent/execution sessions have their own resume paths and are never touched.
 * Entirely best-effort and flag-gated (CLEMMY_CHAT_RESTART_RECOVERY).
 */
import { listSessions, appendEvent, type SessionRow } from './eventlog.js';
import { HarnessSession } from './session.js';
import { addNotification } from '../notifications.js';

function enabled(): boolean {
  return (process.env.CLEMMY_CHAT_RESTART_RECOVERY ?? 'on').toLowerCase() !== 'off';
}

/**
 * Set/clear the in-flight marker on a CHAT session. Set BEFORE a run and cleared
 * in a finally on ANY exit (return or throw); only a hard process death between
 * leaves it set — exactly the "killed mid-run" case the boot scan surfaces so a
 * long chat run never dies silently. Chat-only + best-effort + flag-gated: a
 * marker write must never affect the run. Shared by EVERY chat lane — the Codex
 * orchestrator (runConversation) AND the active Claude Agent SDK brain — so
 * "reports back without fail" holds on whichever brain is live.
 */
export function markRunInFlight(sessionId: string, on: boolean): void {
  if (!enabled()) return;
  try {
    const sess = HarnessSession.load(sessionId);
    if (!sess || sess.kind !== 'chat') return;
    if (on) sess.setRunInFlight();
    else sess.clearRunInFlight();
  } catch {
    /* best-effort — the recovery marker must never break a run */
  }
}

const INTERRUPTED_REPLY =
  'This run was interrupted by a restart before it finished. Reply `continue` to pick up where it left off.';
const MAX_NOTIFICATIONS = 10;
const CHAT_SCAN_PAGE_SIZE = 500;

function listChatSessionsForRecovery(): SessionRow[] {
  const rows: SessionRow[] = [];
  for (let offset = 0; ; offset += CHAT_SCAN_PAGE_SIZE) {
    const page = listSessions({ kind: 'chat', limit: CHAT_SCAN_PAGE_SIZE, offset });
    rows.push(...page);
    if (page.length < CHAT_SCAN_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Scan chat sessions for an in-flight marker left by a run that was killed
 * mid-flight (daemon restart). For each: emit a non-silent conversation_completed
 * so report-back never fails silently, send a bounded notification, and clear the
 * marker. Returns how many runs were recovered. Never throws.
 */
export function reportInterruptedChatRuns(now: () => number = Date.now): number {
  if (!enabled()) return 0;

  let rows;
  try {
    rows = listChatSessionsForRecovery();
  } catch {
    return 0;
  }

  let recovered = 0;
  let notified = 0;
  for (const row of rows) {
    let sess: HarnessSession | null = null;
    try {
      sess = HarnessSession.load(row.id);
    } catch {
      continue;
    }
    if (!sess) continue;

    let since: string | null = null;
    try {
      since = sess.runInFlightSince();
    } catch {
      since = null;
    }
    if (!since) continue; // not interrupted — completed runs clear their marker

    // Non-silent in-session notice (the dock replays it; `continue` resumes).
    try {
      appendEvent({
        sessionId: row.id,
        turn: 0,
        role: 'system',
        type: 'conversation_completed',
        data: {
          steps: 0,
          reason: 'interrupted_by_restart',
          summary: INTERRUPTED_REPLY,
          reply: INTERRUPTED_REPLY,
          interruptedAt: since,
        },
      });
    } catch {
      /* best-effort */
    }

    // Bounded proactive notification so the user is told even off-session.
    if (notified < MAX_NOTIFICATIONS) {
      try {
        addNotification({
          id: `${now()}-chat-interrupted-${row.id}`,
          kind: 'system',
          title: 'A chat task was interrupted by a restart',
          body: `${INTERRUPTED_REPLY} (session ${row.id})`,
          createdAt: new Date(now()).toISOString(),
          read: false,
          metadata: { sessionId: row.id, reason: 'interrupted_by_restart' },
        });
        notified += 1;
      } catch {
        /* best-effort */
      }
    }

    try {
      sess.clearRunInFlight();
    } catch {
      /* best-effort */
    }
    recovered += 1;
  }

  return recovered;
}
