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
 * This closes the report-back gap: runConversation marks the session in-flight
 * on entry and clears it in a finally on ANY exit, so a marker that survives a
 * restart unambiguously means "this run was killed mid-flight". On boot we
 * surface each such chat run with a non-silent conversation_completed, and when
 * the safety bar proves no external write happened, auto-resume through the
 * normal harness spine.
 *
 * Chat-only by construction (the marker is only set for kind='chat'); workflow/
 * agent/execution sessions have their own resume paths and are never touched.
 * Entirely best-effort and flag-gated (CLEMMY_CHAT_RESTART_RECOVERY).
 */
import { listSessions, listEvents, appendEvent, type SessionRow } from './eventlog.js';
import { rehydrateFanoutLedger } from './fanout-ledger.js';
import { HarnessSession } from './session.js';
import { addNotification } from '../notifications.js';

function enabled(): boolean {
  return (process.env.CLEMMY_CHAT_RESTART_RECOVERY ?? 'on').toLowerCase() !== 'off';
}

// ── Auto-resume (2026-07-09) ─────────────────────────────────────────────────
// Surfacing the banner closed the SILENT-death gap; auto-resume closes the
// still-waiting gap: a run interrupted by a restart (crash, update, watchdog)
// used to sit parked until the user noticed and typed `continue` — verified
// live that the resume itself works on a healthy daemon. Resume AUTOMATICALLY
// when it is provably safe:
//   - the interrupted turn recorded NO external_write since the in-flight
//     marker (a resume can never double-act a send/write it can't see), and
//   - the interruption is fresh (age cap — don't resurrect ancient runs), and
//   - bounded per boot (a restart loop must not fan out resumes).
// Ineligible runs keep today's banner + manual `continue` exactly as-is.
// Kill-switch CLEMMY_CHAT_AUTO_RESUME=off restores banner-only for all.
const AUTO_RESUME_MAX_PER_BOOT = 3;
const AUTO_RESUME_MAX_AGE_MS = 2 * 60 * 60_000;
const AUTO_RESUME_REPLY =
  'This run was interrupted by a restart — resuming it automatically now. (Reply `stop` if you no longer want it.)';

function autoResumeEnabled(): boolean {
  return (process.env.CLEMMY_CHAT_AUTO_RESUME ?? 'on').toLowerCase() !== 'off';
}

/** A dispatcher the daemon supplies at boot: run one continuation turn on the
 *  session through the normal harness spine. Injected (not imported) so this
 *  module stays free of the respond-bridge dependency. */
export type ResumeDispatcher = (sessionId: string, directive: string) => Promise<void>;

export const AUTO_RESUME_DIRECTIVE = [
  'The previous run in this session was interrupted by a daemon restart and has been automatically resumed.',
  'First inspect the replayed tool outputs and audit events from the interrupted run. Successful tool results are durable: never repeat a completed mutation, including space_save, and never restart the task from scratch.',
  'Treat an earlier question as resolved when a later user_input_received event answers it; do not reopen that question.',
  'A successful space_save can be the final action or an intermediate checkpoint. If the durable results already satisfy the request, use at most read-only verification and report the result now. Otherwise continue only work that the objective and event trail show is clearly unfinished, starting from the last durable boundary.',
].join('\n');

/** External-write count in the interrupted window. Any count >0 blocks
 *  auto-resume (double-act risk); null means the check failed, which also
 *  blocks auto-resume because safety could not be proven. */
function countExternalWritesSince(sessionId: string, sinceIso: string): number | null {
  try {
    const writes = listEvents(sessionId, { types: ['external_write'] });
    return writes.filter((ev) => String(ev.createdAt ?? '') >= sinceIso).length;
  } catch {
    return null; // can't prove safety → keep the manual banner
  }
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
const REPLAY_PRIMER_PREFIX = '[restart-recovery]';
const MAX_NOTIFICATIONS = 10;
const CHAT_SCAN_PAGE_SIZE = 500;

export interface RestartRecoveryRecord {
  sessionId: string;
  title?: string;
  inFlightSince: string;
  replayPrepared: boolean;
  replayPrimerChanged: boolean;
  snapshotItemsBefore: number;
  snapshotItemsAfter: number;
  lastResponseIdPresent: boolean;
  noticeRecorded: boolean;
  notified: boolean;
  markerCleared: boolean;
  /** True when the restart recovery decision was recorded in the event log. */
  decisionRecorded: boolean;
  /** True when this run met the safety bar and a resume was dispatched. */
  autoResumed: boolean;
  /** Why auto-resume did NOT run (for the boot log / forensics). */
  autoResumeSkipped?: 'disabled' | 'no_dispatcher' | 'external_write' | 'too_old' | 'boot_cap';
  errors: string[];
}

export interface RestartRecoverySummary {
  enabled: boolean;
  scanned: number;
  recovered: number;
  notified: number;
  records: RestartRecoveryRecord[];
}

export interface RestartRecoveryOptions {
  /**
   * Only markers written before this process started can prove a restart
   * interruption. The HTTP surface becomes reachable before the boot scan runs,
   * so markers at/after this cutoff belong to live work in this process and must
   * remain untouched.
   */
  bootCutoffMs?: number;
}

function listChatSessionsForRecovery(): SessionRow[] {
  const rows: SessionRow[] = [];
  for (let offset = 0; ; offset += CHAT_SCAN_PAGE_SIZE) {
    const page = listSessions({ kind: 'chat', limit: CHAT_SCAN_PAGE_SIZE, offset });
    rows.push(...page);
    if (page.length < CHAT_SCAN_PAGE_SIZE) break;
  }
  return rows;
}

function buildReplayPrimer(sessionId: string, inFlightSince: string): string {
  return [
    `${REPLAY_PRIMER_PREFIX} The previous assistant run in this chat was interrupted by a daemon restart before it finished.`,
    `Session: ${sessionId}`,
    `Interrupted run started at: ${inFlightSince}`,
    'When the user asks to continue, resume from the replayed conversation, tool outputs, and audit log. Do not restart from scratch; reconstruct the last known state, state any uncertainty briefly, then continue the interrupted task.',
  ].join('\n');
}

/**
 * Scan chat sessions for an in-flight marker left by a run that was killed
 * mid-flight (daemon restart). For each: emit a non-silent conversation_completed
 * so report-back never fails silently, send a bounded notification, and clear the
 * marker. Returns a structured recovery summary. Never throws.
 */
export function recoverInterruptedChatRuns(
  now: () => number = Date.now,
  dispatchResume?: ResumeDispatcher,
  options: RestartRecoveryOptions = {},
): RestartRecoverySummary {
  if (!enabled()) return { enabled: false, scanned: 0, recovered: 0, notified: 0, records: [] };

  let rows;
  try {
    rows = listChatSessionsForRecovery();
  } catch {
    return { enabled: true, scanned: 0, recovered: 0, notified: 0, records: [] };
  }

  let recovered = 0;
  let notified = 0;
  let autoResumes = 0;
  const records: RestartRecoveryRecord[] = [];
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

    // A marker is restart evidence only when it predates this daemon process.
    // Boot can spend minutes connecting channels before reaching this scan while
    // the HTTP console is already accepting chats. Never claim, clear, or replay
    // a marker created during that window. Malformed/equal timestamps also stay
    // preserved because prior-process ownership cannot be proven.
    if (options.bootCutoffMs !== undefined) {
      const sinceMs = Date.parse(since);
      if (!Number.isFinite(sinceMs) || sinceMs >= options.bootCutoffMs) continue;
    }

    const record: RestartRecoveryRecord = {
      sessionId: row.id,
      ...(row.title ? { title: row.title } : {}),
      inFlightSince: since,
      replayPrepared: false,
      replayPrimerChanged: false,
      snapshotItemsBefore: 0,
      snapshotItemsAfter: 0,
      lastResponseIdPresent: false,
      noticeRecorded: false,
      notified: false,
      markerCleared: false,
      decisionRecorded: false,
      autoResumed: false,
      errors: [],
    };

    // Auto-resume decision (see the safety bar above). Decided up front so the
    // in-session notice tells the truth about what happens next.
    const ageMs = now() - Date.parse(since);
    const externalWritesSinceInterrupt = countExternalWritesSince(row.id, since);
    if (!autoResumeEnabled()) record.autoResumeSkipped = 'disabled';
    else if (!dispatchResume) record.autoResumeSkipped = 'no_dispatcher';
    else if (autoResumes >= AUTO_RESUME_MAX_PER_BOOT) record.autoResumeSkipped = 'boot_cap';
    else if (!Number.isFinite(ageMs) || ageMs > AUTO_RESUME_MAX_AGE_MS) record.autoResumeSkipped = 'too_old';
    else if (externalWritesSinceInterrupt === null || externalWritesSinceInterrupt > 0) record.autoResumeSkipped = 'external_write';
    const willAutoResume = record.autoResumeSkipped === undefined;
    try {
      // Wave 4 Stage 1 (durable swarm resume): rebuild the in-memory fan-out
      // coverage ledger from the durable worker_result log (per-process, wiped by
      // the restart) so a resumed chat swarm still reports honest "M of N". The
      // per-worker idempotency guard separately skips re-executing completed
      // workers. Best-effort; a rehydrate error must never block recovery.
      try { rehydrateFanoutLedger(row.id); } catch { /* best-effort */ }
      record.snapshotItemsBefore = sess.toInputItems().length;
      record.lastResponseIdPresent = !!sess.previousResponseId();
      record.replayPrimerChanged = sess.setContextPrimer(REPLAY_PRIMER_PREFIX, buildReplayPrimer(row.id, since));
      record.snapshotItemsAfter = sess.toInputItems().length;
      record.replayPrepared = true;
    } catch (err) {
      record.errors.push(`replay_primer: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Durable audit of the safety decision. This is intentionally separate from
    // the visible notice below: consumers can reconstruct why a run auto-resumed
    // or stayed manual without parsing human-facing copy or daemon boot logs.
    try {
      appendEvent({
        sessionId: row.id,
        turn: 0,
        role: 'system',
        type: 'restart_recovery_decision',
        data: {
          interruptedAt: since,
          ageMs: Number.isFinite(ageMs) ? ageMs : null,
          eligible: willAutoResume,
          autoResume: willAutoResume,
          autoResumeSkipped: record.autoResumeSkipped ?? null,
          externalWritesSinceInterrupt,
          writeCheckFailed: externalWritesSinceInterrupt === null,
          hasDispatcher: !!dispatchResume,
          bootCap: AUTO_RESUME_MAX_PER_BOOT,
          bootResumeOrdinal: willAutoResume ? autoResumes + 1 : null,
          replayPrepared: record.replayPrepared,
          replayPrimerChanged: record.replayPrimerChanged,
          snapshotItemsBefore: record.snapshotItemsBefore,
          snapshotItemsAfter: record.snapshotItemsAfter,
          lastResponseIdPresent: record.lastResponseIdPresent,
        },
      });
      record.decisionRecorded = true;
    } catch (err) {
      record.errors.push(`decision_event: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Non-silent in-session notice (the dock replays it). The text tells the
    // truth about what happens next: auto-resuming, or waiting for `continue`.
    const noticeReply = willAutoResume ? AUTO_RESUME_REPLY : INTERRUPTED_REPLY;
    try {
      appendEvent({
        sessionId: row.id,
        turn: 0,
        role: 'system',
        type: 'conversation_completed',
        data: {
          steps: 0,
          reason: 'interrupted_by_restart',
          summary: noticeReply,
          reply: noticeReply,
          interruptedAt: since,
          autoResume: willAutoResume,
          ...(record.autoResumeSkipped ? { autoResumeSkipped: record.autoResumeSkipped } : {}),
          replayPrepared: record.replayPrepared,
          replayPrimerChanged: record.replayPrimerChanged,
          snapshotItemsBefore: record.snapshotItemsBefore,
          snapshotItemsAfter: record.snapshotItemsAfter,
          lastResponseIdPresent: record.lastResponseIdPresent,
        },
      });
      record.noticeRecorded = true;
    } catch (err) {
      record.errors.push(`notice_event: ${err instanceof Error ? err.message : String(err)}`);
    }

    const tick = now();
    // Bounded proactive notification so the user is told even off-session.
    // An auto-resumed run notifies only if the resume FAILS (below) — a
    // successful resume delivers its own answer, and "it broke + it's fixed"
    // as two pings is noise.
    if (!willAutoResume && notified < MAX_NOTIFICATIONS) {
      try {
        addNotification({
          id: `${tick}-chat-interrupted-${row.id}`,
          kind: 'system',
          title: 'A chat task was interrupted by a restart',
          body: `${INTERRUPTED_REPLY} (session ${row.id})`,
          createdAt: new Date(tick).toISOString(),
          read: false,
          metadata: {
            sessionId: row.id,
            reason: 'interrupted_by_restart',
            replayPrepared: record.replayPrepared,
          },
        });
        notified += 1;
        record.notified = true;
      } catch (err) {
        record.errors.push(`notification: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      sess.clearRunInFlight();
      record.markerCleared = true;
    } catch {
      record.errors.push('marker_clear: failed');
    }

    // Dispatch the resume AFTER the marker is cleared (a resume that itself gets
    // interrupted re-marks in-flight and is re-evaluated — including the
    // external-write guard — on the next boot; naturally bounded). Fire-and-
    // forget: boot must not block on model turns. A dispatch FAILURE falls back
    // to the manual banner + notification so the user is never left waiting on
    // a resume that silently died.
    if (willAutoResume && dispatchResume) {
      autoResumes += 1;
      record.autoResumed = true;
      const sessionId = row.id;
      void dispatchResume(sessionId, AUTO_RESUME_DIRECTIVE).catch(() => {
        try {
          appendEvent({
            sessionId,
            turn: 0,
            role: 'system',
            type: 'conversation_completed',
            data: { steps: 0, reason: 'interrupted_by_restart', summary: INTERRUPTED_REPLY, reply: INTERRUPTED_REPLY, autoResume: false, autoResumeFailed: true },
          });
          addNotification({
            id: `${now()}-chat-resume-failed-${sessionId}`,
            kind: 'system',
            title: 'Automatic resume failed — a chat task needs you',
            body: `${INTERRUPTED_REPLY} (session ${sessionId})`,
            createdAt: new Date(now()).toISOString(),
            read: false,
            metadata: { sessionId, reason: 'auto_resume_failed' },
          });
        } catch { /* best-effort fallback */ }
      });
    }

    recovered += 1;
    records.push(record);
  }

  return { enabled: true, scanned: rows.length, recovered, notified, records };
}

/**
 * Back-compat wrapper used by daemon boot logging. Prefer
 * recoverInterruptedChatRuns() when the caller needs a visible recovery plan.
 * Pass `dispatchResume` to enable safe auto-resume (see the safety bar above).
 */
export function reportInterruptedChatRuns(
  now: () => number = Date.now,
  dispatchResume?: ResumeDispatcher,
  options: RestartRecoveryOptions = {},
): number {
  const summary = recoverInterruptedChatRuns(now, dispatchResume, options);
  return summary.recovered;
}

export function restartRecoveryPrimerPrefixForTests(): string {
  return REPLAY_PRIMER_PREFIX;
}
