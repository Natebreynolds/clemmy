import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
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
import {
  durableLogicalCallContract,
  type DurableLogicalCallRecoveryMaterial,
} from './logical-call-contract.js';
import {
  openCanonicalArguments,
  sealCanonicalArguments,
} from './authority-argument-seal.js';
import type { RuntimeToolEffect } from './tool-effect.js';

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
  /** Exact accepted-call owner for a host-owned per-call child generation.
   * These three fields are all-or-none: run/model leases remain unbound, while
   * a call lease can authorize physical rows only for this immutable tuple. */
  sourceUserSeq?: number;
  acceptedTaskId?: string;
  logicalToolCallId?: string;
}

export interface DispatchCallRecoveryContract {
  effect: RuntimeToolEffect;
  businessCall: boolean;
  material: DurableLogicalCallRecoveryMaterial;
  turn?: number;
}

const RECOVERABLE_EFFECTS = new Set<RuntimeToolEffect>([
  'read',
  'compute',
  'host_only',
  'local_write',
  'external_write',
  'admin',
  'unknown',
]);

const dispatchLeaseStorage = new AsyncLocalStorage<DispatchLeaseRef>();

/** Install the exact physical-admission generation without importing the much
 * larger harness context into provider adapters. */
export function runWithDispatchLease<T>(lease: DispatchLeaseRef, work: () => T): T {
  return dispatchLeaseStorage.run(lease, work);
}

/** Current exact physical-admission generation, when a host owns one. */
export function currentDispatchLease(): DispatchLeaseRef | undefined {
  return dispatchLeaseStorage.getStore();
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

/** A coordinator may parent a delegated worker's ordinary lease across
 * session namespaces. Metadata alone is not permission: the exact accepted
 * packet source, open parent call and host-recorded child linkage must agree. */
function delegatedWorkerLeaseParentMatches(
  sessionId: string,
  runAttemptId: string | undefined,
  parent: Pick<DispatchLeaseRef, 'sessionId' | 'scopeId' | 'leaseId'>,
): boolean {
  if (!runAttemptId) return false;
  try {
    const db = openEventLog();
    const child = db.prepare(`
      SELECT s.metadata_json, e.data_json, e.parent_event_id, e.seq
        FROM sessions s JOIN run_attempts a ON a.session_id = s.id
        JOIN events e ON e.session_id = s.id AND e.seq = a.source_user_seq
       WHERE s.id = ? AND s.kind = 'agent' AND a.attempt_id = ?
         AND a.finished_at IS NULL AND e.role = 'user' AND e.type = 'user_input_received'
    `).get(sessionId, runAttemptId) as { metadata_json: string; data_json: string; parent_event_id: string; seq: number } | undefined;
    if (!child) return false;
    const metadata = JSON.parse(child.metadata_json);
    const delegated = JSON.parse(child.data_json).delegatedWorker;
    if (!delegated || delegated.composeOnly !== true || metadata.workerScope !== true
      || metadata.source !== 'delegated_worker' || delegated.parentSessionId !== parent.sessionId
      || !Number.isSafeInteger(delegated.parentSourceUserSeq) || delegated.parentSourceUserSeq <= 0
      || delegated.parentAcceptedTaskId !== `task:${parent.sessionId}#${delegated.parentSourceUserSeq}`
      || typeof delegated.parentLogicalCallId !== 'string' || !delegated.parentLogicalCallId
      || typeof delegated.packetKey !== 'string' || !delegated.packetKey
      || typeof delegated.item !== 'string' || !delegated.item
      || !delegated.packet || delegated.packet.item !== delegated.item
      || createHash('sha256').update(JSON.stringify(delegated.packet)).digest('hex') !== delegated.packetDigest) return false;
    for (const key of ['parentSessionId', 'parentSourceUserSeq', 'parentAcceptedTaskId', 'parentLogicalCallId', 'packetKey', 'packetDigest', 'item']) {
      if (metadata[key] !== delegated[key]) return false;
    }
    const parentSource = db.prepare(`SELECT id FROM events WHERE session_id = ? AND seq = ? AND role = 'user' AND type = 'user_input_received'`)
      .get(parent.sessionId, delegated.parentSourceUserSeq) as { id: string } | undefined;
    if (parentSource?.id !== child.parent_event_id) return false;
    const call = db.prepare(`SELECT tool_name FROM logical_tool_calls
      WHERE session_id = ? AND source_user_seq = ? AND accepted_task_id = ? AND logical_tool_call_id = ? AND state = 'open'`)
      .get(parent.sessionId, delegated.parentSourceUserSeq, delegated.parentAcceptedTaskId, delegated.parentLogicalCallId) as { tool_name: string } | undefined;
    if (call?.tool_name !== 'run_worker') return false;
    // The provided generation must descend from THIS coordinator call, not
    // from an unrelated live lease in the same parent session.
    let ownerScope: string | null = parent.scopeId;
    let ownerLease: string | null = parent.leaseId;
    let ownsCall = false;
    const seen = new Set<string>();
    while (ownerScope && ownerLease) {
      const key = `${ownerScope}\0${ownerLease}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const row = db.prepare(`SELECT source_user_seq, accepted_task_id, logical_tool_call_id, parent_scope_id, parent_lease_id
        FROM run_dispatch_leases WHERE scope_id = ? AND lease_id = ? AND session_id = ? AND revoked_at IS NULL`)
        .get(ownerScope, ownerLease, parent.sessionId) as { source_user_seq: number | null; accepted_task_id: string | null;
          logical_tool_call_id: string | null; parent_scope_id: string | null; parent_lease_id: string | null } | undefined;
      if (!row) return false;
      if (row.source_user_seq === delegated.parentSourceUserSeq && row.accepted_task_id === delegated.parentAcceptedTaskId
        && row.logical_tool_call_id === delegated.parentLogicalCallId) { ownsCall = true; break; }
      ownerScope = row.parent_scope_id;
      ownerLease = row.parent_lease_id;
    }
    if (!ownsCall) return false;
    return Boolean(db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND type = 'worker_started' AND role = 'system'
      AND json_extract(data_json, '$.childSessionId') = ? AND json_extract(data_json, '$.childSourceUserSeq') = ?
      AND json_extract(data_json, '$.childAttemptId') = ? AND json_extract(data_json, '$.parentLogicalCallId') = ?
      AND json_extract(data_json, '$.packetKey') = ? AND json_extract(data_json, '$.packetDigest') = ? AND json_extract(data_json, '$.item') = ?`)
      .get(parent.sessionId, sessionId, child.seq, runAttemptId, delegated.parentLogicalCallId, delegated.packetKey, delegated.packetDigest, delegated.item));
  } catch { return false; }
}

export function activateDispatchLease(input: {
  sessionId: string;
  scopeId: string;
  runAttemptId?: string;
  parentLease?: DispatchLeaseRef;
  sourceUserSeq?: number;
  acceptedTaskId?: string;
  logicalToolCallId?: string;
  /** Required for an exact call-bound generation. These frozen bytes are the
   * only semantics restart recovery may use; recovery never consults a current
   * registry or infers effect from the tool name. */
  recovery?: DispatchCallRecoveryContract;
}): DispatchLeaseRef {
  const boundFieldCount = [
    input.sourceUserSeq,
    input.acceptedTaskId,
    input.logicalToolCallId,
  ].filter((value) => value !== undefined).length;
  if (boundFieldCount !== 0 && boundFieldCount !== 3) {
    throw new Error('Dispatch call-lease identity must be supplied as one complete tuple.');
  }
  if ((boundFieldCount === 3) !== (input.recovery !== undefined)) {
    throw new Error('Dispatch call-lease recovery contract must accompany the exact call tuple.');
  }
  if (
    boundFieldCount === 3
    && (
      !Number.isSafeInteger(input.sourceUserSeq)
      || (input.sourceUserSeq ?? 0) <= 0
      || typeof input.acceptedTaskId !== 'string'
      || !input.acceptedTaskId.trim()
      || typeof input.logicalToolCallId !== 'string'
      || input.logicalToolCallId !== input.logicalToolCallId.trim()
      || input.logicalToolCallId.length < 1
      || input.logicalToolCallId.length > 512
    )
  ) throw new Error('Dispatch call-lease identity is invalid.');
  let recoveryArgumentCipher: string | null = null;
  if (input.recovery) {
    const material = input.recovery.material;
    if (
      !RECOVERABLE_EFFECTS.has(input.recovery.effect)
      || typeof input.recovery.businessCall !== 'boolean'
      || !material.toolName.trim()
      || !/^[a-f0-9]{64}$/.test(material.argumentDigest)
      || !material.args
      || typeof material.args !== 'object'
      || Array.isArray(material.args)
      || (input.recovery.turn !== undefined
        && (!Number.isSafeInteger(input.recovery.turn) || input.recovery.turn <= 0))
    ) throw new Error('Dispatch call-lease recovery contract is invalid.');
    const recomputed = durableLogicalCallContract(
      input.acceptedTaskId as string,
      material.toolName,
      material.args,
    );
    if (
      !recomputed
      || recomputed.toolName !== material.toolName
      || recomputed.argumentDigest !== material.argumentDigest
    ) throw new Error('Dispatch call-lease recovery contract conflicts with its logical material.');
    recoveryArgumentCipher = sealCanonicalArguments({ args: material.args });
    const reopened = openCanonicalArguments(recoveryArgumentCipher);
    const reopenedArgs = reopened?.args;
    const reopenedContract = durableLogicalCallContract(
      input.acceptedTaskId as string,
      material.toolName,
      reopenedArgs,
    );
    if (
      !reopened
      || !reopenedArgs
      || typeof reopenedArgs !== 'object'
      || Array.isArray(reopenedArgs)
      || !reopenedContract
      || reopenedContract.toolName !== material.toolName
      || reopenedContract.argumentDigest !== material.argumentDigest
    ) throw new Error('Dispatch call-lease recovery arguments are not reconstructable.');
  }
  if (input.parentLease) {
    if (input.parentLease.sessionId !== input.sessionId
      && !delegatedWorkerLeaseParentMatches(input.sessionId, input.runAttemptId, input.parentLease)) {
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
    ...(boundFieldCount === 3 ? {
      sourceUserSeq: input.sourceUserSeq as number,
      acceptedTaskId: input.acceptedTaskId as string,
      logicalToolCallId: input.logicalToolCallId as string,
    } : {}),
  };
  openEventLog().prepare(`
    INSERT INTO run_dispatch_leases
      (
        scope_id, session_id, lease_id, run_attempt_id,
        parent_scope_id, parent_lease_id,
        source_user_seq, accepted_task_id, logical_tool_call_id,
        recovery_effect, recovery_business_call, recovery_tool_name,
        recovery_argument_digest, recovery_argument_cipher, recovery_turn,
        activated_at, revoked_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(scope_id) DO UPDATE SET
      session_id = excluded.session_id,
      lease_id = excluded.lease_id,
      run_attempt_id = excluded.run_attempt_id,
      parent_scope_id = excluded.parent_scope_id,
      parent_lease_id = excluded.parent_lease_id,
      source_user_seq = excluded.source_user_seq,
      accepted_task_id = excluded.accepted_task_id,
      logical_tool_call_id = excluded.logical_tool_call_id,
      recovery_effect = excluded.recovery_effect,
      recovery_business_call = excluded.recovery_business_call,
      recovery_tool_name = excluded.recovery_tool_name,
      recovery_argument_digest = excluded.recovery_argument_digest,
      recovery_argument_cipher = excluded.recovery_argument_cipher,
      recovery_turn = excluded.recovery_turn,
      activated_at = excluded.activated_at,
      revoked_at = NULL,
      revocation_reason = NULL
  `).run(
    lease.scopeId,
    lease.sessionId,
    lease.leaseId,
    lease.runAttemptId ?? null,
    lease.parentScopeId ?? null,
    lease.parentLeaseId ?? null,
    lease.sourceUserSeq ?? null,
    lease.acceptedTaskId ?? null,
    lease.logicalToolCallId ?? null,
    input.recovery?.effect ?? null,
    input.recovery ? (input.recovery.businessCall ? 1 : 0) : null,
    input.recovery?.material.toolName ?? null,
    input.recovery?.material.argumentDigest ?? null,
    recoveryArgumentCipher,
    input.recovery?.turn ?? null,
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

export const DURABLE_HOST_CONTINUATION_PENDING_REVOCATION =
  'durable_host_continuation_pending' as const;

/** Fence one generation while leaving its logical call to an exact durable
 * continuation owner. Generic revoked-call recovery must not terminalize it. */
export async function revokeDispatchLeaseForDurableHostContinuation(
  lease: DispatchLeaseRef,
): Promise<void> {
  await withExternalWriteAdmissionLock(
    externalWriteAdmissionKey(lease.sessionId),
    async () => {
      openEventLog().prepare(`
        UPDATE run_dispatch_leases
           SET revoked_at = COALESCE(revoked_at, ?),
               revocation_reason = COALESCE(revocation_reason, ?)
         WHERE scope_id = ? AND session_id = ? AND lease_id = ?
      `).run(
        new Date().toISOString(),
        DURABLE_HOST_CONTINUATION_PENDING_REVOCATION,
        lease.scopeId,
        lease.sessionId,
        lease.leaseId,
      );
    },
  );
}

export const TERMINAL_RUN_ATTEMPT_BOOT_REVOCATION_REASON =
  'terminal_run_attempt_at_daemon_boot' as const;

/**
 * DAEMON-BOOT ONLY: quarantine every unreleased dispatch generation whose
 * exact session + run-attempt owner is already terminal.
 *
 * `interruptOrphanedRunAttemptsAtBoot` first converts predecessor-owned active
 * attempts into terminal rows. This one SQL owner then fences their dispatch
 * generations across chat, workflow, execution, agent, and future session
 * kinds without inspecting provider/tool names or invoking a physical surface.
 * Missing attempts, cross-session references, still-active attempts, unbound
 * leases, and generations another owner already revoked are intentionally left
 * untouched.
 */
export function reconcileTerminalRunAttemptDispatchLeasesAtBoot(
  nowMs = Date.now(),
): number {
  const revokedAt = new Date(nowMs).toISOString();
  return openEventLog().prepare(`
    UPDATE run_dispatch_leases
       SET revoked_at = ?,
           revocation_reason = ?
     WHERE revoked_at IS NULL
       AND run_attempt_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM run_attempts AS attempt
          WHERE attempt.attempt_id = run_dispatch_leases.run_attempt_id
            AND attempt.session_id = run_dispatch_leases.session_id
            AND attempt.finished_at IS NOT NULL
            AND attempt.status != 'active'
       )
  `).run(
    revokedAt,
    TERMINAL_RUN_ATTEMPT_BOOT_REVOCATION_REASON,
  ).changes;
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
           lease.session_id,
           lease.lease_id,
           lease.parent_scope_id,
           lease.parent_lease_id,
           lease.revoked_at,
           lease.run_attempt_id,
           lease.source_user_seq,
           lease.accepted_task_id,
           lease.logical_tool_call_id,
           attempt.attempt_id,
           attempt.session_id AS attempt_session_id,
           attempt.finished_at AS attempt_finished_at
      FROM run_dispatch_leases AS lease
      LEFT JOIN run_attempts AS attempt
        ON attempt.attempt_id = lease.run_attempt_id
     WHERE lease.scope_id = ?
       AND lease.lease_id = ?
  `);
  type LeaseRow = {
    scope_id: string;
    session_id: string;
    lease_id: string;
    parent_scope_id: string | null;
    parent_lease_id: string | null;
    revoked_at: string | null;
    run_attempt_id: string | null;
    source_user_seq: number | null;
    accepted_task_id: string | null;
    logical_tool_call_id: string | null;
    attempt_id: string | null;
    attempt_session_id: string | null;
    attempt_finished_at: string | null;
  };
  let scopeId = lease.scopeId;
  let leaseId = lease.leaseId;
  let first = true;
  let previous: LeaseRow | undefined;
  const seen = new Set<string>();
  while (true) {
    const lineageKey = `${scopeId}\0${leaseId}`;
    if (seen.has(lineageKey)) return false;
    seen.add(lineageKey);
    const row = lookup.get(scopeId, leaseId) as LeaseRow | undefined;
    if (!row || row.revoked_at !== null) return false;
    if (first && row.session_id !== lease.sessionId) return false;
    if (previous && previous.session_id !== row.session_id
      && !delegatedWorkerLeaseParentMatches(previous.session_id, previous.run_attempt_id ?? undefined,
        { sessionId: row.session_id, scopeId: row.scope_id, leaseId: row.lease_id })) return false;
    if (
      first
      && (
        row.source_user_seq !== (lease.sourceUserSeq ?? null)
        || row.accepted_task_id !== (lease.acceptedTaskId ?? null)
        || row.logical_tool_call_id !== (lease.logicalToolCallId ?? null)
      )
    ) return false;
    if (
      row.run_attempt_id !== null
      && (
        row.attempt_id !== row.run_attempt_id
        || row.attempt_session_id !== row.session_id
        || row.attempt_finished_at !== null
      )
    ) return false;
    if (row.parent_scope_id === null && row.parent_lease_id === null) return true;
    if (!row.parent_scope_id || !row.parent_lease_id) return false;
    first = false;
    previous = row;
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
        parsed.sourceUserSeq !== undefined
        && (!Number.isSafeInteger(parsed.sourceUserSeq) || parsed.sourceUserSeq <= 0)
      )
      || (
        parsed.acceptedTaskId !== undefined
        && (typeof parsed.acceptedTaskId !== 'string' || !parsed.acceptedTaskId.trim())
      )
      || (
        parsed.logicalToolCallId !== undefined
        && (
          typeof parsed.logicalToolCallId !== 'string'
          || parsed.logicalToolCallId !== parsed.logicalToolCallId.trim()
          || parsed.logicalToolCallId.length < 1
          || parsed.logicalToolCallId.length > 512
        )
      )
      || ([parsed.sourceUserSeq, parsed.acceptedTaskId, parsed.logicalToolCallId]
        .filter((entry) => entry !== undefined).length !== 0
        && [parsed.sourceUserSeq, parsed.acceptedTaskId, parsed.logicalToolCallId]
          .filter((entry) => entry !== undefined).length !== 3)
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
      ...(parsed.sourceUserSeq !== undefined
        && parsed.acceptedTaskId
        && parsed.logicalToolCallId
        ? {
            sourceUserSeq: parsed.sourceUserSeq,
            acceptedTaskId: parsed.acceptedTaskId,
            logicalToolCallId: parsed.logicalToolCallId,
          }
        : {}),
    };
  } catch (cause) {
    throw new Error(
      'CLEMENTINE_MCP_DISPATCH_LEASE_JSON is present but invalid; refusing to start an unfenced MCP tool surface.',
      { cause },
    );
  }
}
