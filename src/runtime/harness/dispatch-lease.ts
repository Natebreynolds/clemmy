import { randomUUID } from 'node:crypto';
import {
  listEvents,
  openEventLog,
  type EventRow,
} from './eventlog.js';
import {
  externalWriteAdmissionKey,
  uncompensatedExternalWriteEvents,
  withExternalWriteAdmissionLock,
} from './external-write-admission.js';

/**
 * Authority for one physical provider/Runner attempt. Cancellation remains
 * best-effort transport cleanup; this generation is the deterministic boundary
 * that prevents an abandoned attempt from dispatching a late tool call.
 */
export interface DispatchLeaseRef {
  sessionId: string;
  scopeId: string;
  leaseId: string;
  /** Durable outer request identity, when the caller owns one. */
  runAttemptId?: string;
  /** Optional durable parent generation. Internal provider-query attempts use
   * this so revoking the caller's shared lease invalidates every child even if
   * a transport outlives its wrapper. */
  parentScopeId?: string;
  parentLeaseId?: string;
}

export type DispatchRecoveryLedgerBaseline =
  | { readable: true; afterSeq: number }
  | { readable: false };

export type DispatchRecoveryLedgerCheck =
  | { safeToReplay: true; evidence: EventRow[] }
  | {
      safeToReplay: false;
      reason: 'external_write' | 'ledger_unreadable';
      evidence: EventRow[];
    };

export class StaleDispatchLeaseError extends Error {
  readonly code = 'STALE_DISPATCH_LEASE';

  constructor(readonly lease: DispatchLeaseRef) {
    super(
      `Dispatch refused: provider attempt ${lease.leaseId} is no longer authoritative `
      + `for ${lease.scopeId}.`,
    );
    this.name = 'StaleDispatchLeaseError';
  }
}

export function activateDispatchLease(input: {
  sessionId: string;
  scopeId: string;
  runAttemptId?: string;
  parentLease?: DispatchLeaseRef;
}): DispatchLeaseRef {
  if (input.parentLease) {
    if (input.parentLease.sessionId !== input.sessionId) {
      throw new Error('Dispatch lease parent must belong to the same session.');
    }
    assertDispatchLeaseCurrent(input.parentLease);
  }
  const lease: DispatchLeaseRef = {
    sessionId: input.sessionId,
    scopeId: input.scopeId,
    leaseId: randomUUID(),
    ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
    ...(input.parentLease ? {
      parentScopeId: input.parentLease.scopeId,
      parentLeaseId: input.parentLease.leaseId,
    } : {}),
  };
  openEventLog().prepare(`
    INSERT INTO run_dispatch_leases
      (
        scope_id, session_id, lease_id, run_attempt_id,
        parent_scope_id, parent_lease_id,
        activated_at, revoked_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(scope_id) DO UPDATE SET
      session_id = excluded.session_id,
      lease_id = excluded.lease_id,
      run_attempt_id = excluded.run_attempt_id,
      parent_scope_id = excluded.parent_scope_id,
      parent_lease_id = excluded.parent_lease_id,
      activated_at = excluded.activated_at,
      revoked_at = NULL
  `).run(
    lease.scopeId,
    lease.sessionId,
    lease.leaseId,
    lease.runAttemptId ?? null,
    lease.parentScopeId ?? null,
    lease.parentLeaseId ?? null,
    new Date().toISOString(),
  );
  return lease;
}

/** Idempotent and exact-generation scoped: an old cleanup cannot revoke a
 * newer retry that already replaced it. */
export function revokeDispatchLease(lease: DispatchLeaseRef | undefined): void {
  if (!lease) return;
  openEventLog().prepare(`
    UPDATE run_dispatch_leases
       SET revoked_at = COALESCE(revoked_at, ?)
     WHERE scope_id = ?
       AND session_id = ?
       AND lease_id = ?
  `).run(new Date().toISOString(), lease.scopeId, lease.sessionId, lease.leaseId);
}

/**
 * Revoke a physical attempt at the same durable serialization boundary used
 * by external-write reservation. This closes the cross-process check/revoke
 * race for stdio MCP children:
 *
 * - if a write owns admission first, its reservation becomes durable before
 *   recovery can inspect the ledger;
 * - if revocation owns admission first, the stale write observes the revoked
 *   generation before it can reserve or dispatch.
 *
 * Callers must await this before cancellation, retry, fallover, or any other
 * recovery that could replay work.
 */
export async function revokeDispatchLeaseBeforeRecovery(
  lease: DispatchLeaseRef | undefined,
): Promise<void> {
  if (!lease) return;
  await withExternalWriteAdmissionLock(
    externalWriteAdmissionKey(lease.sessionId),
    async () => {
      revokeDispatchLease(lease);
    },
  );
}

/**
 * Bind a possible physical-attempt replay to a durable action-ledger window.
 * The caller captures this immediately before provider work, then checks it
 * only after `revokeDispatchLeaseBeforeRecovery` has completed.
 */
export function captureDispatchRecoveryLedgerBaseline(
  sessionId: string,
): DispatchRecoveryLedgerBaseline {
  try {
    const tail = listEvents(sessionId, { limit: 1, desc: true });
    return { readable: true, afterSeq: tail[0]?.seq ?? 0 };
  } catch {
    return { readable: false };
  }
}

/**
 * A retry is safe only when the post-baseline ledger is readable and contains
 * no successful, orphaned, or still-reserved external write. Exact
 * proven-no-dispatch failure rows may compensate their matching reservation.
 */
export function checkDispatchRecoveryLedger(
  sessionId: string,
  baseline: DispatchRecoveryLedgerBaseline | undefined,
): DispatchRecoveryLedgerCheck {
  if (!baseline?.readable) {
    return { safeToReplay: false, reason: 'ledger_unreadable', evidence: [] };
  }
  try {
    const evidence = listEvents(sessionId, {
      sinceSeq: baseline.afterSeq,
      types: [
        'external_write',
        'external_write_succeeded',
        'external_write_failed',
        'external_write_orphaned',
      ],
    });
    const unsafeTerminal = evidence.some(
      (event) =>
        event.type === 'external_write_succeeded'
        || event.type === 'external_write_orphaned',
    );
    if (unsafeTerminal || uncompensatedExternalWriteEvents(evidence).length > 0) {
      return {
        safeToReplay: false,
        reason: 'external_write',
        evidence,
      };
    }
    return { safeToReplay: true, evidence };
  } catch {
    return { safeToReplay: false, reason: 'ledger_unreadable', evidence: [] };
  }
}

export function isDispatchLeaseCurrent(lease: DispatchLeaseRef | undefined): boolean {
  // Compatibility for explicitly out-of-band tool calls. Production model
  // attempts install a lease at their runner/SDK boundary.
  if (!lease) return true;
  const lookup = openEventLog().prepare(`
    SELECT lease.scope_id,
           lease.lease_id,
           lease.parent_scope_id,
           lease.parent_lease_id,
           lease.revoked_at,
           lease.run_attempt_id,
           attempt.attempt_id,
           attempt.session_id AS attempt_session_id,
           attempt.finished_at AS attempt_finished_at
      FROM run_dispatch_leases AS lease
      LEFT JOIN run_attempts AS attempt
        ON attempt.attempt_id = lease.run_attempt_id
     WHERE lease.scope_id = ?
       AND lease.session_id = ?
       AND lease.lease_id = ?
  `);
  type LeaseRow = {
    scope_id: string;
    lease_id: string;
    parent_scope_id: string | null;
    parent_lease_id: string | null;
    revoked_at: string | null;
    run_attempt_id: string | null;
    attempt_id: string | null;
    attempt_session_id: string | null;
    attempt_finished_at: string | null;
  };
  let scopeId = lease.scopeId;
  let leaseId = lease.leaseId;
  const seen = new Set<string>();
  while (true) {
    const lineageKey = `${scopeId}\0${leaseId}`;
    if (seen.has(lineageKey)) return false;
    seen.add(lineageKey);
    const row = lookup.get(scopeId, lease.sessionId, leaseId) as LeaseRow | undefined;
    if (!row || row.revoked_at !== null) return false;
    if (
      row.run_attempt_id !== null
      && (
        row.attempt_id !== row.run_attempt_id
        || row.attempt_session_id !== lease.sessionId
        || row.attempt_finished_at !== null
      )
    ) return false;
    if (row.parent_scope_id === null && row.parent_lease_id === null) return true;
    if (!row.parent_scope_id || !row.parent_lease_id) return false;
    scopeId = row.parent_scope_id;
    leaseId = row.parent_lease_id;
  }
}

export function assertDispatchLeaseCurrent(
  lease: DispatchLeaseRef | undefined,
): void {
  if (lease && !isDispatchLeaseCurrent(lease)) {
    throw new StaleDispatchLeaseError(lease);
  }
}

export function serializeDispatchLease(lease: DispatchLeaseRef | undefined): string | undefined {
  return lease ? JSON.stringify(lease) : undefined;
}

export function parseDispatchLease(value: string | undefined): DispatchLeaseRef | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<DispatchLeaseRef>;
    if (
      typeof parsed.sessionId !== 'string'
      || !parsed.sessionId
      || typeof parsed.scopeId !== 'string'
      || !parsed.scopeId
      || typeof parsed.leaseId !== 'string'
      || !parsed.leaseId
      || (parsed.runAttemptId !== undefined && typeof parsed.runAttemptId !== 'string')
      || (
        parsed.parentScopeId !== undefined
        && (typeof parsed.parentScopeId !== 'string' || !parsed.parentScopeId)
      )
      || (
        parsed.parentLeaseId !== undefined
        && (typeof parsed.parentLeaseId !== 'string' || !parsed.parentLeaseId)
      )
      || ((parsed.parentScopeId === undefined) !== (parsed.parentLeaseId === undefined))
    ) {
      throw new Error('invalid dispatch lease shape');
    }
    return {
      sessionId: parsed.sessionId,
      scopeId: parsed.scopeId,
      leaseId: parsed.leaseId,
      ...(parsed.runAttemptId ? { runAttemptId: parsed.runAttemptId } : {}),
      ...(parsed.parentScopeId && parsed.parentLeaseId ? {
        parentScopeId: parsed.parentScopeId,
        parentLeaseId: parsed.parentLeaseId,
      } : {}),
    };
  } catch (cause) {
    throw new Error(
      'CLEMENTINE_MCP_DISPATCH_LEASE_JSON is present but invalid; refusing to start an unfenced MCP tool surface.',
      { cause },
    );
  }
}
