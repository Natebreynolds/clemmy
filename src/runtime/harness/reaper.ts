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
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync as rmFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getRuntimeEnv } from '../../config.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import { reapSettledAuthorityPayloads } from './dispatch-ledger.js';
import { openEventLog } from './eventlog.js';
import { ASYNC_READ_REFINEMENT_INTENTS_TABLE } from './async-read-refinement-schema.js';
import {
  reconcileHostExternalWriteProjections,
  reconcileRevokedHostToolInvocations,
  type HostToolInvocationRecoverySweep,
} from './host-tool-invocation.js';
import { reconcileSilentAcceptedInputSessions } from './session-reconcile.js';
import { releaseSessionBrainPin } from './model-roles.js';

const logger = pino({ name: 'clementine-next.approval-reaper' });

const DEFAULT_TICK_MS = 60_000; // sweep once a minute

let activeInterval: NodeJS.Timeout | null = null;

// ── Bounded revoked-invocation recovery (B7b, gauntlet 2026-08-26) ──────────
// reconcileRevokedHostToolInvocations re-attempted the SAME 5 durably-held
// records every 60s forever (108+ identical warns and still firing at
// gauntlet end): recovery could neither settle nor abandon. The reaper now
// bounds the rescans: after CLEMMY_REVOKED_RECOVERY_MAX_RESCANS attempts a
// still-held record is QUARANTINED — a durable terminal disposition (state
// file + one operational event + one user notification), after which the
// every-tick reconcile stops. Quarantined records are re-probed on a slow
// cadence (CLEMMY_REVOKED_RECOVERY_REPROBE_MS, default hourly) so a later fix
// (e.g. the settlement kernel learning to abandon a conflicted authority) can
// still release them, and any NEW revoked candidate re-opens the sweep
// immediately — the pause never delays fresh recovery.
// MEASURED root cause of today's 5 (repro on a DB copy, 2026-08-26): every
// reconcile fails with "Tool attempt could not settle durably (closed):
// accepted-turn call authority is conflict" — the kernel refuses ANY outcome
// for a source whose accepted-turn call authority is in state 'conflict', so
// the revoked lease + open logical call can never settle. The real fix (an
// abandon outcome for a conflicted/closed authority) belongs to the settlement
// kernel (logical-call-settlement-store.ts:943 → attempt-settlement.ts throw);
// this quarantine is the reaper-side bound that stops the eternal scan.

interface HeldRecoveryEntry {
  count: number;
  reason: string;
  firstAt: string;
  lastAt: string;
  abandonedAt?: string;
}

const QUARANTINE_FILE = path.join(BASE_DIR, 'state', 'revoked-recovery-quarantine.json');
let heldRecoveryLedger: Map<string, HeldRecoveryEntry> | null = null;
let recoverySweepPausedUntil = 0;

interface RecoverySweepSeam {
  sweep: (options: { limit: number }) => HostToolInvocationRecoverySweep;
  candidateCount: () => number;
}

const productionRecoverySeam: RecoverySweepSeam = {
  sweep: (options) => reconcileRevokedHostToolInvocations(options),
  candidateCount: () => {
    try {
      const row = openEventLog().prepare(`
        SELECT COUNT(*) AS n
          FROM run_dispatch_leases lease
          JOIN logical_tool_calls call
            ON call.session_id = lease.session_id
           AND call.source_user_seq = lease.source_user_seq
           AND call.logical_tool_call_id = lease.logical_tool_call_id
         WHERE lease.revoked_at IS NOT NULL
           AND lease.source_user_seq IS NOT NULL
           AND lease.accepted_task_id IS NOT NULL
           AND lease.logical_tool_call_id IS NOT NULL
           AND call.state = 'open'
           AND NOT EXISTS (
             SELECT 1 FROM ${ASYNC_READ_REFINEMENT_INTENTS_TABLE} async_owner
              WHERE async_owner.session_id = lease.session_id
                AND async_owner.source_user_seq = lease.source_user_seq
                AND async_owner.accepted_task_id = lease.accepted_task_id
                AND async_owner.start_logical_tool_call_id = lease.logical_tool_call_id
           )
      `).get() as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0; // tables absent in partial fixtures — nothing to recover
    }
  },
};

let recoverySeam: RecoverySweepSeam = productionRecoverySeam;

function recoveryMaxRescans(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_REVOKED_RECOVERY_MAX_RESCANS', '') || '', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 5;
}

function recoveryReprobeMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_REVOKED_RECOVERY_REPROBE_MS', '') || '', 10);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 60 * 60_000; // hourly
}

function heldRecordKey(record: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  leaseScopeId: string;
  leaseId: string;
}): string {
  return [record.sessionId, record.sourceUserSeq, record.logicalToolCallId, record.leaseScopeId, record.leaseId].join('|');
}

function loadHeldRecoveryLedger(): Map<string, HeldRecoveryEntry> {
  if (heldRecoveryLedger) return heldRecoveryLedger;
  heldRecoveryLedger = new Map();
  if (!existsSync(QUARANTINE_FILE)) return heldRecoveryLedger;
  try {
    const parsed = JSON.parse(readFileSync(QUARANTINE_FILE, 'utf-8')) as {
      version?: number;
      entries?: Record<string, HeldRecoveryEntry>;
    };
    if (parsed.version === 1 && parsed.entries) {
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (entry && typeof entry.count === 'number' && typeof entry.reason === 'string') {
          heldRecoveryLedger.set(key, entry);
        }
      }
    }
  } catch {
    try { rmFileSync(QUARANTINE_FILE, { force: true }); } catch { /* best effort */ }
  }
  return heldRecoveryLedger;
}

function persistHeldRecoveryLedger(): void {
  const ledger = loadHeldRecoveryLedger();
  try {
    if (ledger.size === 0) {
      rmFileSync(QUARANTINE_FILE, { force: true });
      return;
    }
    mkdirSync(path.dirname(QUARANTINE_FILE), { recursive: true });
    writeFileSync(
      QUARANTINE_FILE,
      JSON.stringify({ version: 1, entries: Object.fromEntries(ledger) }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch { /* best-effort; the in-memory ledger still bounds this process */ }
}

function quarantinedRecoveryKeys(): string[] {
  return [...loadHeldRecoveryLedger().entries()]
    .filter(([, entry]) => entry.abandonedAt)
    .map(([key]) => key);
}

/** One recovery pass under the rescan bound. Returns nothing the caller needs;
 *  all effects are ledger/notification/log side effects. */
function runBoundedRecoverySweep(nowMs: number): void {
  const ledger = loadHeldRecoveryLedger();
  const quarantined = new Set(quarantinedRecoveryKeys());
  if (nowMs < recoverySweepPausedUntil) {
    // Paused because everything held is quarantined — but a NEW revoked
    // candidate must not wait out the pause. The count is one cheap read.
    if (recoverySeam.candidateCount() <= quarantined.size) return;
    recoverySweepPausedUntil = 0;
  }
  let recovery: HostToolInvocationRecoverySweep;
  try {
    recovery = recoverySeam.sweep({ limit: 100 });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'revoked host-tool invocation recovery sweep failed',
    );
    return;
  }
  const now = new Date(nowMs).toISOString();
  let dirty = false;
  let freshHeld = 0;
  for (const record of recovery.records) {
    const key = heldRecordKey(record);
    if (record.status === 'settled') {
      if (ledger.delete(key)) dirty = true;
      continue;
    }
    const existing = ledger.get(key);
    const entry: HeldRecoveryEntry = existing
      ? { ...existing, count: existing.count + 1, reason: record.reason ?? existing.reason, lastAt: now }
      : { count: 1, reason: record.reason ?? 'held', firstAt: now, lastAt: now };
    ledger.set(key, entry);
    dirty = true;
    if (entry.abandonedAt) continue; // already terminally disposed — no more noise
    if (entry.count >= recoveryMaxRescans()) {
      entry.abandonedAt = now;
      const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
      logger.error(
        { record, rescans: entry.count, reason: entry.reason },
        'revoked invocation recovery is permanently held — quarantining after bounded rescans',
      );
      recordOperationalEvent({
        source: 'harness',
        type: 'host_tool_recovery_abandoned',
        severity: 'error',
        actor: 'approval-reaper',
        sessionId: record.sessionId,
        payload: {
          sourceUserSeq: record.sourceUserSeq,
          logicalToolCallId: record.logicalToolCallId,
          leaseScopeId: record.leaseScopeId,
          leaseId: record.leaseId,
          rescans: entry.count,
          reason: entry.reason,
        },
      });
      try {
        addNotification({
          id: `revoked-recovery-abandoned-${digest}`,
          kind: 'system',
          title: 'A stuck tool recovery was set aside',
          body: `Recovery of an interrupted tool call could not settle after ${entry.count} attempts (${entry.reason.slice(0, 160)}). It was set aside and will be re-checked occasionally; no external action was performed by the recovery itself.`,
          createdAt: now,
          read: false,
          metadata: {
            sessionId: record.sessionId,
            logicalToolCallId: record.logicalToolCallId,
            reason: entry.reason,
            rescans: entry.count,
          },
        });
      } catch { /* notification is best-effort */ }
    } else {
      freshHeld += 1;
    }
  }
  if (dirty) persistHeldRecoveryLedger();
  if (freshHeld > 0) {
    logger.warn(
      { held: freshHeld, settled: recovery.settled, scanned: recovery.scanned },
      'revoked host-tool invocation recovery remains durably held',
    );
  } else if (recovery.settled > 0) {
    logger.info(
      { settled: recovery.settled },
      'revoked host-tool invocations reconciled without redispatch',
    );
  }
  const heldKeys = recovery.records.filter((r) => r.status === 'held').map((r) => heldRecordKey(r));
  const allHeldQuarantined = heldKeys.length > 0
    && heldKeys.every((key) => ledger.get(key)?.abandonedAt);
  if (allHeldQuarantined && recovery.settled === 0) {
    recoverySweepPausedUntil = nowMs + recoveryReprobeMs();
  }
}

export const __recoveryTest__ = {
  reset(): void {
    recoverySeam = productionRecoverySeam;
    heldRecoveryLedger = new Map();
    recoverySweepPausedUntil = 0;
    persistHeldRecoveryLedger();
  },
  setSweepForTests(seam: { sweep: () => HostToolInvocationRecoverySweep; candidateCount: () => number } | null): void {
    recoverySeam = seam
      ? { sweep: () => seam.sweep(), candidateCount: seam.candidateCount }
      : productionRecoverySeam;
  },
  maxRescans(): number {
    return recoveryMaxRescans();
  },
  quarantinedKeys(): string[] {
    return quarantinedRecoveryKeys();
  },
};

// These decisions are intentionally owned by durable product state rather than
// a paused SDK turn. The Workspace runner gate revalidates the installed
// source, entry-file hash, and schedule before every spawn, and its own TTL is
// still enforced by pass 1. A terminal chat session therefore does not make
// this exact decision orphaned.
const DURABLE_PRODUCT_APPROVAL_TOOLS = new Set([
  'space_trust_data_runner',
]);

function hasDurableProductOwner(row: Pick<approvalRegistry.PendingApprovalRow, 'tool'>): boolean {
  return !!row.tool && DURABLE_PRODUCT_APPROVAL_TOOLS.has(row.tool);
}

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
export function reapOnce(options: { nowMs?: number } = {}): approvalRegistry.PendingApprovalRow[] {
  const sweepNowMs = options.nowMs ?? Date.now();
  runBoundedRecoverySweep(sweepNowMs);
  // Projection-only crash convergence for closed direct-host provider writes.
  // This runs after revoked-call recovery so a reservation which crashed
  // before physical admission can first acquire its truthful logical
  // settlement. It never invokes a provider body and is idempotent by the
  // reservation/terminal projection CAS.
  try {
    const projection = reconcileHostExternalWriteProjections({ limit: 100 });
    if (projection.projected > 0) {
      logger.info(
        { projected: projection.projected, scanned: projection.scanned },
        'host-owned external-write projections converged without redispatch',
      );
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'host-owned external-write projection recovery failed',
    );
  }
  // B7a: accepted-input liveness. A session that accepted user input and never
  // started a turn (the sess-branch-1d43… silent no-reply) gets its durable
  // terminal here, surfaced as a notification — not just a ledger row.
  try {
    const liveness = reconcileSilentAcceptedInputSessions({ nowMs: sweepNowMs });
    for (const record of liveness.records) {
      releaseSessionBrainPin(record.sessionId);
      logger.warn(
        { sessionId: record.sessionId, sourceUserSeq: record.sourceUserSeq, ageMs: record.ageMs },
        'accepted input never started a turn — session terminalized by the liveness reaper',
      );
      recordOperationalEvent({
        source: 'harness',
        type: 'harness_run_failed',
        severity: 'warn',
        actor: 'approval-reaper',
        sessionId: record.sessionId,
        payload: {
          reason: 'accepted_input_never_started',
          sourceUserSeq: record.sourceUserSeq,
          acceptedAt: record.acceptedAt,
          ageMs: record.ageMs,
          attemptClosed: record.attemptClosed,
        },
      });
      try {
        addNotification({
          id: `liveness-no-turn-${record.sessionId}`,
          kind: 'system',
          title: 'A message was accepted but never answered',
          body: 'Clementine accepted a message but no turn ever started for it, so the conversation was closed instead of sitting silent. Send the request again and it will run fresh.',
          createdAt: new Date(sweepNowMs).toISOString(),
          read: false,
          metadata: {
            sessionId: record.sessionId,
            sourceUserSeq: record.sourceUserSeq,
            reason: 'accepted_input_never_started',
          },
        });
      } catch { /* notification is best-effort */ }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'accepted-input liveness sweep failed',
    );
  }
  try { reapSettledAuthorityPayloads(); } catch { /* authority table may not exist in a partial fixture */ }
  // 1) TTL-based expiry (24h default) — long fallback for "user is
  // away for the day" cases.
  const expired = approvalRegistry.expireStaleApprovals(new Date());

  // 2) Session-status-aware reap: if a pending approval is tied to a
  // session that's no longer active (cancelled / completed / failed)
  // AND the approval is old enough to be a real orphan, cancel it so
  // the dashboard "NEEDS YOU" surface stops showing it.
  //
  // Two guards added after the reaper regression where this reaper
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
      if (hasDurableProductOwner(row)) continue;

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
      const result = approvalRegistry.resolve(row.approvalId, 'cancelled_by_system', 'reaper-dead-session');
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
    const durableProductApproval = hasDurableProductOwner(row);
    const cancelledBySystem = row.resolution === 'cancelled_by_system';
    if (!durableProductApproval) {
      // Clear the SDK interrupt state so the next user message in this
      // session starts a fresh turn instead of trying to resume the
      // long-dead pause. Durable product-owned decisions have no SDK
      // interrupt and must not cancel their Workspace chat/session.
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
            title: cancelledBySystem
              ? 'Session cleanup failed after approval was closed'
              : 'Session cleanup failed after approval expired',
            body: cancelledBySystem
              ? `The system-closed approval on **${row.subject}** could not be cleared from its ended session, which may leave it stuck. If that session stops responding, restart the daemon.`
              : `The expired approval on **${row.subject}** could not be cleared from its session, which may leave it stuck. If that session stops responding, restart the daemon.`,
            createdAt: new Date().toISOString(),
            read: false,
            metadata: { approvalId: row.approvalId, sessionId: row.sessionId },
          });
        } catch {
          /* best-effort — the warning above is still in the logs */
        }
      }
    }

    // Surface the loss to the user. Without this, the user has no
    // way to know "I asked you to do X 25 hours ago and you silently
    // gave up." The notification is the trail back to action.
    try {
      addNotification({
        id: cancelledBySystem
          ? `approval-system-cancelled-${row.approvalId}`
          : `approval-expired-${row.approvalId}-${randomUUID().slice(0, 8)}`,
        kind: 'system',
        title: cancelledBySystem ? 'Approval closed with its ended session' : 'Approval expired',
        body: cancelledBySystem
          ? `Clementine closed the pending approval on **${row.subject}** because its owning session had already ended. This was a system cleanup, not a user decision, and no approval was granted. Start a new request if you still want the action.`
          : durableProductApproval
            ? `The approval on **${row.subject}** expired without a reply. The Workspace session remains available, but the runner remains blocked. Refresh it again to request a new exact decision.`
            : `The approval on **${row.subject}** expired without a reply. The session was cancelled. Re-ask and I'll redo it.`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: {
          approvalId: row.approvalId,
          sessionId: row.sessionId,
          subject: row.subject,
          tool: row.tool,
          approvalStatus: row.status,
          approvalResolution: row.resolution,
          recommendedAction: 'start_new_request',
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
      cancelledBySystem ? 'approval closed with ended session' : 'approval expired',
    );
  }
  return expired;
}
