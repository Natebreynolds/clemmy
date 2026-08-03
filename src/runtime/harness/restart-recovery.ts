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
 * surface each such chat run with an exact typed terminal when user action is
 * required, and when the safety bar proves no external write happened,
 * auto-resume through the normal harness spine without fabricating a terminal.
 *
 * Chat-only by construction (the marker is only set for kind='chat'); workflow/
 * agent/execution sessions have their own resume paths and are never touched.
 * Entirely best-effort and flag-gated (CLEMMY_CHAT_RESTART_RECOVERY).
 */
import {
  appendEvent,
  clearKill,
  finishRunAttempt,
  getLatestRunAttempt,
  getRunAttemptSourceUserEvent,
  isKillRequested,
  listEvents,
  listSessions,
  openEventLog,
  type EventRow,
  type RunAttemptRecord,
  type SessionRow,
} from './eventlog.js';
import { uncompensatedExternalWriteEvents } from './external-write-admission.js';
import { commitTurnOutcome } from './delivery-committer.js';
import { HarnessSession } from './session.js';
import {
  presentationEventFromCompletionData,
  turnOutcomeId,
  type TurnIdentity,
  type TurnOutcome,
} from './turn-outcome.js';
import { addNotification } from '../notifications.js';
import {
  readActiveWorkflowOriginGroup,
  readPendingWorkflowChatDispatchOwnership,
  workflowOriginSourceGroupId,
  type PendingWorkflowChatDispatchOwnership,
} from '../../tools/workflow-run-queue.js';

function enabled(): boolean {
  return (process.env.CLEMMY_CHAT_RESTART_RECOVERY ?? 'on').toLowerCase() !== 'off';
}

// ── Auto-resume (2026-07-09) ─────────────────────────────────────────────────
// Surfacing the banner closed the SILENT-death gap; auto-resume closes the
// still-waiting gap: a run interrupted by a restart (crash, update, watchdog)
// used to sit parked until the user noticed and typed `continue` — verified
// live that the resume itself works on a healthy daemon. Resume AUTOMATICALLY
// when it is provably safe:
//   - the interrupted turn has NO landed or unresolved external write since
//     the in-flight marker (a resume can never double-act a send/write), and
//   - the interruption is fresh (age cap — don't resurrect ancient runs), and
//   - bounded per boot (a restart loop must not fan out resumes).
// Ineligible runs keep today's banner + manual `continue` exactly as-is.
// Kill-switch CLEMMY_CHAT_AUTO_RESUME=off restores banner-only for all.
const AUTO_RESUME_MAX_PER_BOOT = 3;
const AUTO_RESUME_MAX_AGE_MS = 2 * 60 * 60_000;

function autoResumeEnabled(): boolean {
  return (process.env.CLEMMY_CHAT_AUTO_RESUME ?? 'on').toLowerCase() !== 'off';
}

/** A dispatcher the daemon supplies at boot: run one continuation turn on the
 *  session through the normal harness spine. Injected (not imported) so this
 *  module stays free of the respond-bridge dependency. */
export type ResumeDispatcher = (
  sessionId: string,
  directive: string,
  sourceUserSeq: number,
) => Promise<void>;

/** Distinguish an ordinary resume failure from the narrow crash window where
 * the resumed turn durably transferred this exact source to an activated
 * workflow group, then threw before its Promise resolved. The loop owns the
 * canonical cross-store verifier; import it lazily to avoid a static cycle
 * (`loop` already imports this recovery module).
 *
 * An active group without exactly one verified public edge is ambiguous, not
 * permission to publish a foreground failure terminal. Throw so the caller
 * leaves the original marker armed for deterministic reconciliation. */
async function transferredWorkflowDispatchForSource(
  identity: TurnIdentity,
): Promise<{ sourceGroupId: string; sourceGroupDigest: string; runIds: string[] } | null> {
  const sourceGroupId = workflowOriginSourceGroupId({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
  });
  const active = readActiveWorkflowOriginGroup(sourceGroupId);
  if (!active) return null;
  const { verifiedWorkflowRunDispatchReceipts } = await import('./loop.js');
  const receipts = verifiedWorkflowRunDispatchReceipts(
    identity.sessionId,
    identity.turn,
    identity.sourceUserSeq,
  );
  if (
    receipts.length !== 1
    || receipts[0].sourceGroupId !== active.sealed.sourceGroupId
    || receipts[0].sourceGroupDigest !== active.sealed.sourceGroupDigest
    || receipts[0].sourceUserSeq !== identity.sourceUserSeq
  ) {
    throw new Error(
      `Activated workflow dispatch ${sourceGroupId} has no exact public source edge.`,
    );
  }
  return {
    sourceGroupId: receipts[0].sourceGroupId,
    sourceGroupDigest: receipts[0].sourceGroupDigest,
    runIds: [...receipts[0].runIds],
  };
}

export const AUTO_RESUME_DIRECTIVE = [
  'The previous run in this session was interrupted by a daemon restart and has been automatically resumed.',
  'First inspect the replayed tool outputs and audit events from the interrupted run. Successful tool results are durable: never repeat a completed mutation, including space_save, and never restart the task from scratch.',
  'Treat an earlier question as resolved when a later user_input_received event answers it; do not reopen that question.',
  'A successful space_save can be the final action or an intermediate checkpoint. If the durable results already satisfy the request, use at most read-only verification and report the result now. Otherwise continue only work that the objective and event trail show is clearly unfinished, starting from the last durable boundary.',
].join('\n');

function externalWriteRiskIdentity(event: {
  seq: number;
  data: Record<string, unknown>;
}): string {
  const data = event.data;
  for (const key of ['canonicalCallId', 'callId']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return `call:${value.trim()}`;
  }
  for (const key of ['correlationFingerprint', 'payloadFingerprint']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      return `fingerprint:${value.trim().toLowerCase()}`;
    }
  }
  return `event:${event.seq}`;
}

/** Landed-or-unresolved external-write count in the interrupted window. Exact
 *  proven-no-effect failures compensate only their matching reservation.
 *  Explicit success/orphan outcomes independently block replay, including when
 *  older telemetry omitted the reservation. Any count >0 blocks auto-resume
 *  (double-act risk); null means the check failed and therefore also blocks. */
function countExternalWritesSince(sessionId: string, sinceIso: string): number | null {
  try {
    const window = listEvents(sessionId, {
      types: [
        'external_write',
        'external_write_failed',
        'external_write_succeeded',
        'external_write_orphaned',
      ],
    }).filter((event) => String(event.createdAt ?? '') >= sinceIso);
    const unresolvedReservations = uncompensatedExternalWriteEvents(
      window.filter((event) =>
        event.type === 'external_write' || event.type === 'external_write_failed'),
    );
    const risks = new Set(unresolvedReservations.map(externalWriteRiskIdentity));
    for (const event of window) {
      if (event.type === 'external_write_succeeded' || event.type === 'external_write_orphaned') {
        risks.add(externalWriteRiskIdentity(event));
      }
    }
    return risks.size;
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

/**
 * Clear a terminal run's coarse chat marker without stealing recovery
 * ownership from a different durable attempt that is still active. The SQL
 * predicate and metadata update run as one statement, so a concurrently
 * accepted attempt either blocks this clear or re-arms itself after it.
 *
 * A matching owner attempt is allowed because most surface wrappers settle
 * their run_attempt row immediately after the inner graph commits its public
 * terminal. Direct callers without an attempt id may clear only when no
 * attempt-backed run is active for the session.
 */
export function clearRunInFlightAfterTerminal(
  sessionId: string,
  ownerAttemptId?: string,
  sourceUserSeq?: number,
): boolean {
  if (!enabled()) return false;
  try {
    // A terminal candidate must never erase the only coarse owner of a queue
    // admission that has not reached immutable source-group activation. The
    // loop supplies the exact accepted source; missing/corrupt queue evidence
    // fails closed by returning false.
    if (sourceUserSeq !== undefined && readPendingWorkflowChatDispatchOwnership({
      sessionId,
      sourceUserSeq,
    })) {
      return false;
    }
    const owner = ownerAttemptId?.trim() || null;
    const result = openEventLog().prepare(
      `UPDATE sessions
          SET metadata_json = json_remove(metadata_json, '$.__run_in_flight'),
              updated_at = ?
        WHERE id = ?
          AND kind = 'chat'
          AND json_type(metadata_json, '$.__run_in_flight') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM run_attempts AS active
             WHERE active.session_id = sessions.id
               AND active.finished_at IS NULL
               AND (? IS NULL OR active.attempt_id != ?)
          )`,
    ).run(new Date().toISOString(), sessionId, owner, owner);
    return result.changes === 1;
  } catch {
    return false;
  }
}

const INTERRUPTED_REPLY =
  'This run was interrupted by a restart before it finished. Reply `continue` to pick up where it left off.';
const PREPARED_DISPATCH_HELD_REPLY =
  'This run was interrupted after background work was admitted but before its dispatch could be finalized. Reply `continue` to resume the same accepted work safely.';
const STOPPED_REPLY =
  'This run was stopped as requested. A restart happened before it could finish shutting down, but it will not resume.';
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
  /** True when boot found the exact terminal already committed by this turn
   * and only reconciled the stale attempt/marker left by the crash. */
  terminalReconciled: boolean;
  terminalEventSeq?: number;
  /** Durable non-executable queue ownership that prevented this scan from
   * publishing a manual terminal or clearing the interrupted source marker. */
  preparedDispatchOwnershipPreserved: boolean;
  preparedDispatchSourceGroupId?: string;
  preparedDispatchPhase?: PendingWorkflowChatDispatchOwnership['phase'];
  preparedDispatchRunIds: string[];
  /** Why auto-resume did NOT run (for the boot log / forensics). */
  autoResumeSkipped?: 'disabled' | 'no_dispatcher' | 'external_write' | 'too_old' | 'boot_cap' | 'user_stopped' | 'identity_missing';
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

/** Recover the exact accepted-turn identity when the interrupted runtime wrote
 * one. Pre-attempt legacy sessions can still carry a durable user input, so use
 * that exact event as the compatibility identity rather than inventing a turn. */
function recoveryTurnIdentity(
  sessionId: string,
  attempt: RunAttemptRecord | null,
): TurnIdentity | null {
  if (attempt) {
    const bound = getRunAttemptSourceUserEvent(attempt);
    const source = bound ?? (attempt.sourceUserSeq
      ? listEvents(sessionId, {
          sinceSeq: attempt.sourceUserSeq - 1,
          types: ['user_input_received'],
          limit: 1,
        }).find((event) => event.seq === attempt.sourceUserSeq)
      : undefined);
    return source ? { sessionId, turn: source.turn, sourceUserSeq: source.seq } : null;
  }
  const source = listEvents(sessionId, {
    types: ['user_input_received'],
    desc: true,
    limit: 1,
  }).at(-1);
  return source
    ? { sessionId, turn: source.turn, sourceUserSeq: source.seq }
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveEventSeq(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Find a public terminal that belongs to this exact interrupted turn.
 *
 * A session can contain many completed turns, and physical attempt/run ids can
 * change during fallover. Only the accepted user event and its exact turn own
 * the terminal. A contradictory typed row fails closed rather than authorizing
 * replay of work that may already have completed.
 */
function exactCommittedTerminal(
  sessionId: string,
  attempt: RunAttemptRecord | null,
  identity: TurnIdentity | null,
): EventRow | null {
  void attempt; // physical attempt metadata is intentionally non-authoritative
  if (!identity) return null;
  const expectedSourceUserSeq = identity.sourceUserSeq;

  const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
  for (const terminal of terminals) {
    const data = terminal.data;
    const presentationIdentity = objectRecord(objectRecord(data.presentation)?.identity);
    const terminalKey = nonEmptyString(data.terminalKey);
    const turnKeyMatch = terminalKey?.match(/^turn:(\d+)$/);
    const claimedSourceUserSeqs = [
      positiveEventSeq(data.sourceUserSeq),
      positiveEventSeq(presentationIdentity?.sourceUserSeq),
      turnKeyMatch ? positiveEventSeq(Number(turnKeyMatch[1])) : null,
    ].filter((value): value is number => value !== null);
    if (!claimedSourceUserSeqs.includes(expectedSourceUserSeq)) continue;

    const typed = Object.prototype.hasOwnProperty.call(data, 'presentation')
      || Object.prototype.hasOwnProperty.call(data, 'turnOutcome');
    if (typed) {
      const presentation = presentationEventFromCompletionData(data);
      if (!presentation) throw new Error('Typed terminal could not be decoded.');
      if (presentation.identity.sessionId === identity.sessionId
        && presentation.identity.sourceUserSeq === expectedSourceUserSeq
        && presentation.identity.turn === identity.turn
        && terminal.turn === identity.turn) {
        return terminal;
      }
      continue;
    }
    // Explicit pre-typed compatibility: require both the exact source claim and
    // the exact accepted event turn. Never settle from attempt/run proximity.
    if (terminal.turn === identity.turn) return terminal;
  }
  return null;
}

function runAttemptStatusForTerminal(
  terminal: EventRow,
): 'completed' | 'cancelled' | 'failed' {
  const status = nonEmptyString(objectRecord(terminal.data.turnOutcome)?.status)
    ?? nonEmptyString(objectRecord(terminal.data.presentation)?.status);
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'completed';
}

function commitRestartRecoveryTerminal(
  identity: TurnIdentity,
  terminal: 'continue' | 'stopped',
  reply: string,
  legacyReason: string,
): ReturnType<typeof commitTurnOutcome> {
  const outcome: TurnOutcome = terminal === 'stopped'
    ? {
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'cancelled',
        resumable: false,
        presentation: { kind: 'stopped', text: reply },
      }
    : {
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'continue' },
        presentation: { kind: 'continue', text: reply },
      };
  return commitTurnOutcome(outcome, {
    legacyReason,
    metadata: { steps: 0 },
  });
}

/**
 * Scan chat sessions for an in-flight marker left by a run that was killed
 * mid-flight (daemon restart). For each: commit an exact typed terminal when
 * user action is required or emit nonterminal resume state when work continues,
 * send a bounded notification where appropriate, and clear the marker. Returns
 * a structured recovery summary. Never throws.
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
      terminalReconciled: false,
      preparedDispatchOwnershipPreserved: false,
      preparedDispatchRunIds: [],
      errors: [],
    };

    let interruptedAttempt: RunAttemptRecord | null = null;
    let userStopped = false;
    try {
      interruptedAttempt = getLatestRunAttempt(row.id);
      userStopped = isKillRequested(row.id, interruptedAttempt ?? undefined);
    } catch {
      // A failed kill read must not invent a stop. The ordinary conservative
      // external-write/age checks still decide whether resume is safe.
    }
    const recoveryIdentity = recoveryTurnIdentity(row.id, interruptedAttempt);
    let pendingDispatchOwnership: PendingWorkflowChatDispatchOwnership | null = null;
    if (recoveryIdentity) {
      try {
        pendingDispatchOwnership = readPendingWorkflowChatDispatchOwnership(recoveryIdentity);
        if (pendingDispatchOwnership) {
          record.preparedDispatchOwnershipPreserved = true;
          record.preparedDispatchSourceGroupId = pendingDispatchOwnership.sourceGroupId;
          record.preparedDispatchPhase = pendingDispatchOwnership.phase;
          record.preparedDispatchRunIds = [...pendingDispatchOwnership.runIds];
        }
      } catch (err) {
        // Queue authority is part of the no-terminal/no-clear proof. If it
        // cannot be read exactly, preserve the marker for a later recovery
        // pass instead of orphaning potentially admitted work.
        record.errors.push(`prepared_dispatch_check: ${err instanceof Error ? err.message : String(err)}`);
        records.push(record);
        continue;
      }
    }

    // The brain can commit its exact public terminal and then die before its
    // finally block settles the attempt or clears runInFlight. The terminal is
    // the authoritative no-replay boundary. Reconcile that narrow crash window
    // before preparing a primer, publishing a restart notice, or dispatching a
    // continuation. Never use runId/latest-event proximity: either can belong
    // to another logical turn in this reusable chat session.
    let committedTerminal: EventRow | null = null;
    let terminalCheckFailed = false;
    try {
      committedTerminal = exactCommittedTerminal(row.id, interruptedAttempt, recoveryIdentity);
    } catch (err) {
      terminalCheckFailed = true;
      record.errors.push(`terminal_reconcile_check: ${err instanceof Error ? err.message : String(err)}`);
    }
    // If durable terminal state cannot be read, preserve the marker and leave
    // the turn inert for a later scan. Dispatching when the no-replay check is
    // unavailable could duplicate a completed mutation or answer.
    if (terminalCheckFailed) {
      records.push(record);
      continue;
    }
    if (committedTerminal && pendingDispatchOwnership) {
      // This is contradictory legacy/crash evidence: a manual terminal cannot
      // supersede an admitted source group that never activated. Retain both
      // the exact marker and attempt so a repair can resume/finalize the same
      // accepted source; never turn the earlier terminal into orphan authority.
      record.errors.push('terminal_reconcile: terminal coexists with unactivated workflow dispatch ownership');
      records.push(record);
      continue;
    }
    if (committedTerminal) {
      record.terminalReconciled = true;
      record.terminalEventSeq = committedTerminal.seq;
      try {
        if (interruptedAttempt) {
          finishRunAttempt(interruptedAttempt, runAttemptStatusForTerminal(committedTerminal));
        } else {
          clearKill(row.id);
        }
      } catch (err) {
        record.errors.push(`attempt_reconcile: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        sess.clearRunInFlight();
        record.markerCleared = true;
      } catch {
        record.errors.push('marker_clear: failed');
      }
      try {
        appendEvent({
          sessionId: row.id,
          turn: 0,
          role: 'system',
          type: 'restart_recovery_decision',
          data: {
            phase: 'terminal_reconciled',
            interruptedAt: since,
            interruptedAttemptId: interruptedAttempt?.attemptId ?? null,
            interruptedRunId: interruptedAttempt?.runId ?? null,
            sourceUserSeq: recoveryIdentity?.sourceUserSeq ?? null,
            terminalEventSeq: committedTerminal.seq,
            autoResume: false,
          },
        });
        record.decisionRecorded = true;
      } catch (err) {
        record.errors.push(`decision_event: ${err instanceof Error ? err.message : String(err)}`);
      }
      recovered += 1;
      records.push(record);
      continue;
    }

    // Auto-resume decision (see the safety bar above). Decided before the
    // recovery state is published or a manual terminal is committed.
    const ageMs = now() - Date.parse(since);
    const externalWritesSinceInterrupt = countExternalWritesSince(row.id, since);
    if (!recoveryIdentity) record.autoResumeSkipped = 'identity_missing';
    else if (userStopped) record.autoResumeSkipped = 'user_stopped';
    else if (!autoResumeEnabled()) record.autoResumeSkipped = 'disabled';
    else if (!dispatchResume) record.autoResumeSkipped = 'no_dispatcher';
    else if (autoResumes >= AUTO_RESUME_MAX_PER_BOOT) record.autoResumeSkipped = 'boot_cap';
    else if (!Number.isFinite(ageMs) || ageMs > AUTO_RESUME_MAX_AGE_MS) record.autoResumeSkipped = 'too_old';
    else if (externalWritesSinceInterrupt === null || externalWritesSinceInterrupt > 0) record.autoResumeSkipped = 'external_write';
    const willAutoResume = record.autoResumeSkipped === undefined;
    if (!userStopped) {
      try {
        record.snapshotItemsBefore = sess.toInputItems().length;
        record.lastResponseIdPresent = !!sess.previousResponseId();
        record.replayPrimerChanged = sess.setContextPrimer(REPLAY_PRIMER_PREFIX, buildReplayPrimer(row.id, since));
        record.snapshotItemsAfter = sess.toInputItems().length;
        record.replayPrepared = true;
      } catch (err) {
        record.errors.push(`replay_primer: ${err instanceof Error ? err.message : String(err)}`);
      }
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
          userStopped,
          interruptedAttemptId: interruptedAttempt?.attemptId ?? null,
          interruptedRunId: interruptedAttempt?.runId ?? null,
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
          preparedDispatchOwnershipPreserved: record.preparedDispatchOwnershipPreserved,
          preparedDispatchSourceGroupId: record.preparedDispatchSourceGroupId ?? null,
          preparedDispatchPhase: record.preparedDispatchPhase ?? null,
          preparedDispatchRunIds: record.preparedDispatchRunIds,
        },
      });
      record.decisionRecorded = true;
    } catch (err) {
      record.errors.push(`decision_event: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Commit user-facing text only for an honest terminal. Automatic recovery
    // remains nonterminal until the resumed brain reports its real outcome.
    const noticeReply = pendingDispatchOwnership
      ? PREPARED_DISPATCH_HELD_REPLY
      : userStopped
        ? STOPPED_REPLY
        : INTERRUPTED_REPLY;
    const noticeReason = pendingDispatchOwnership
      ? 'prepared_workflow_dispatch_interrupted'
      : userStopped
        ? 'stopped_before_restart'
        : 'interrupted_by_restart';
    try {
      if (!willAutoResume && recoveryIdentity && pendingDispatchOwnership) {
        // A needs-input TurnOutcome is terminal for this accepted source. It
        // cannot be committed while a pre-activation queue member still owns
        // that same source, because the next boot would reconcile the terminal
        // and erase the only restart handle. Publish guidance as nonterminal
        // pause state and retain the original marker/attempt instead.
        appendEvent({
          sessionId: row.id,
          turn: recoveryIdentity.turn,
          role: 'system',
          type: 'run_paused',
          data: {
            reason: noticeReason,
            interruptedAt: since,
            sourceUserSeq: recoveryIdentity.sourceUserSeq,
            sourceGroupId: pendingDispatchOwnership.sourceGroupId,
            phase: pendingDispatchOwnership.phase,
            runIds: pendingDispatchOwnership.runIds,
            resumable: true,
            guidance: noticeReply,
          },
        });
      } else if (!willAutoResume && recoveryIdentity) {
        commitRestartRecoveryTerminal(
          recoveryIdentity,
          userStopped ? 'stopped' : 'continue',
          noticeReply,
          noticeReason,
        );
      } else if (willAutoResume) {
        // Automatic resume is progress, not a final TurnOutcome. Publishing a
        // conversation_completed here would create a false terminal before the
        // resumed brain's real answer and reintroduce the two-writer race.
        appendEvent({
          sessionId: row.id,
          turn: 0,
          role: 'system',
          type: 'run_resumed',
          data: {
            reason: 'restart_auto_resume',
            interruptedAt: since,
            autoResume: true,
          },
        });
      } else {
        // A pre-attempt legacy marker with no durable accepted user event has no
        // honest TurnIdentity. Keep the recovery state visible without
        // inventing ownership or publishing a fake terminal.
        appendEvent({
          sessionId: row.id,
          turn: 0,
          role: 'system',
          type: 'run_paused',
          data: { reason: 'restart_recovery_identity_missing', interruptedAt: since },
        });
      }
      record.noticeRecorded = true;
    } catch (err) {
      record.errors.push(`notice_event: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Publication/recovery state is the durability boundary. If it failed,
    // preserve the original marker and do not notify or dispatch as though the
    // turn were safely parked. A later boot can retry the exact source.
    if (!record.noticeRecorded) {
      records.push(record);
      continue;
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
          title: userStopped ? 'A stopped chat task finished shutting down' : 'A chat task was interrupted by a restart',
          body: `${noticeReply} (session ${row.id})`,
          createdAt: new Date(tick).toISOString(),
          read: false,
          metadata: {
            sessionId: row.id,
            reason: noticeReason,
            replayPrepared: record.replayPrepared,
            preparedDispatchOwnershipPreserved: record.preparedDispatchOwnershipPreserved,
            preparedDispatchSourceGroupId: record.preparedDispatchSourceGroupId,
            preparedDispatchRunIds: record.preparedDispatchRunIds,
          },
        });
        notified += 1;
        record.notified = true;
      } catch (err) {
        record.errors.push(`notification: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!willAutoResume && !pendingDispatchOwnership) {
      try {
        sess.clearRunInFlight();
        record.markerCleared = true;
      } catch {
        record.errors.push('marker_clear: failed');
      }
    }

    if (userStopped && !pendingDispatchOwnership) {
      try {
        if (interruptedAttempt) finishRunAttempt(interruptedAttempt, 'cancelled');
        else clearKill(row.id);
      } catch (err) {
        record.errors.push(`kill_cleanup: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Keep the original marker armed across dispatch. The resumed runtime owns
    // the same accepted source and clears it only after its real terminal is
    // durable; this closes both clear→dispatch and accept→marker crash windows.
    // Fire-and-forget: boot must not block on model turns. A dispatch failure
    // commits the manual continue terminal only when no unactivated workflow
    // admission still owns this exact source.
    if (willAutoResume && dispatchResume && recoveryIdentity) {
      autoResumes += 1;
      record.autoResumed = true;
      const sessionId = row.id;
      void dispatchResume(
        sessionId,
        AUTO_RESUME_DIRECTIVE,
        recoveryIdentity.sourceUserSeq,
      ).catch(async (error: unknown) => {
        try {
          // Raw dispatch diagnostics remain private; the user-facing terminal
          // is stable constant copy committed through the typed boundary.
          appendEvent({
            sessionId,
            turn: 0,
            role: 'system',
            type: 'restart_recovery_decision',
            data: {
              phase: 'dispatch_failed',
              autoResume: false,
              error: error instanceof Error ? error.message : String(error),
              interruptedAttemptId: interruptedAttempt?.attemptId ?? null,
              interruptedRunId: interruptedAttempt?.runId ?? null,
            },
          });
        } catch { /* diagnostics are private and best-effort */ }
        try {
          const failedOwnership = readPendingWorkflowChatDispatchOwnership(recoveryIdentity);
          const transferredDispatch = failedOwnership
            ? null
            : await transferredWorkflowDispatchForSource(recoveryIdentity);
          const failedReply = failedOwnership
            ? PREPARED_DISPATCH_HELD_REPLY
            : INTERRUPTED_REPLY;
          if (failedOwnership) {
            appendEvent({
              sessionId,
              turn: recoveryIdentity.turn,
              role: 'system',
              type: 'run_paused',
              data: {
                reason: 'prepared_workflow_dispatch_resume_failed',
                sourceUserSeq: recoveryIdentity.sourceUserSeq,
                sourceGroupId: failedOwnership.sourceGroupId,
                phase: failedOwnership.phase,
                runIds: failedOwnership.runIds,
                resumable: true,
                guidance: failedReply,
              },
            });
          } else if (transferredDispatch) {
            // The dispatcher Promise failed after the immutable background edge
            // won. That is successful ownership transfer, not permission to
            // publish a competing foreground terminal or clear its restart
            // marker. The workflow's real terminal will report back normally.
            appendEvent({
              sessionId,
              turn: recoveryIdentity.turn,
              role: 'system',
              type: 'run_resumed',
              data: {
                reason: 'workflow_dispatch_transferred_after_resume_error',
                sourceUserSeq: recoveryIdentity.sourceUserSeq,
                sourceGroupId: transferredDispatch.sourceGroupId,
                sourceGroupDigest: transferredDispatch.sourceGroupDigest,
                runIds: transferredDispatch.runIds,
                resumable: true,
              },
            });
          } else {
            commitRestartRecoveryTerminal(
              recoveryIdentity,
              'continue',
              failedReply,
              'interrupted_by_restart',
            );
            const failedSession = HarnessSession.load(sessionId);
            failedSession?.clearRunInFlight();
          }
          if (!transferredDispatch) {
            addNotification({
              id: `${now()}-chat-resume-failed-${sessionId}`,
              kind: 'system',
              title: 'Automatic resume failed — a chat task needs you',
              body: `${failedReply} (session ${sessionId})`,
              createdAt: new Date(now()).toISOString(),
              read: false,
              metadata: {
                sessionId,
                reason: failedOwnership
                  ? 'prepared_workflow_dispatch_resume_failed'
                  : 'auto_resume_failed',
                ...(failedOwnership ? {
                  preparedDispatchOwnershipPreserved: true,
                  preparedDispatchSourceGroupId: failedOwnership.sourceGroupId,
                  preparedDispatchRunIds: failedOwnership.runIds,
                } : {}),
              },
            });
          }
        } catch {
          // Terminal commit failed: the still-armed marker is the durable retry
          // owner. Never replace that invariant with a live-only banner.
        }
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
