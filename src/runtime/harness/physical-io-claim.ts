/**
 * Sole owner of provider-I/O ownership on a physical crossing.
 *
 * A reservation says a crossing may happen; a claim says the provider call is
 * ours to make. Both facts live on `physical_dispatches` so they cannot
 * disagree. Callers get opaque answers — they cannot supply a row, a fence, or
 * a state and have it believed.
 *
 * The invariant this module exists to hold: at most one activation ever claims
 * a given reservation. After a claim, recovery reconciles; it never redispatches.
 */
import { openEventLog } from './eventlog.js';
import {
  canonicalGraphNodeLeaseKey,
  parseCanonicalOwnerFence,
} from './canonical-graph-node-lease.js';
import type { ResolvedCallAuthorityV1 } from './resolved-call-authority.js';
import {
  workflowReadOnlyPhysicalClaimAttestationMatches,
  workflowV3PhysicalClaimAttestationMatches,
} from './accepted-turn-call-authority.js';
import {
  workflowReadPagePhysicalClaimAttestationMatches,
  workflowReadPagePreparationClaimAttestationMatches,
} from './workflow-paginated-read-authority.js';

export interface PhysicalIoClaimIdentity {
  sessionId: string;
  sourceUserSeq: number;
  physicalDispatchId: string;
}

/** Why a claim was refused. Every value means "do not invoke". */
export type PhysicalIoClaimRefusal =
  | 'no_reservation'
  | 'already_claimed'
  | 'authority_mismatch'
  | 'lease_not_current'
  | 'malformed_owner_fence';

export type PhysicalIoClaimResult =
  | { claimed: true }
  | { claimed: false; reason: PhysicalIoClaimRefusal };

interface LeaseRow {
  owner: string;
  fence: number;
  revision: number;
  expiresAt: number;
  released: number;
}

/**
 * Has provider I/O already been claimed for this exact reservation?
 *
 * `true` is the do-not-redispatch fact: the only safe recovery is reconciliation.
 */
export function physicalIoClaimed(identity: PhysicalIoClaimIdentity): boolean {
  try {
    const row = openEventLog().prepare(
      `SELECT io_claimed_at AS claimedAt FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?`,
    ).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.physicalDispatchId,
    ) as { claimedAt: string | null } | undefined;
    return typeof row?.claimedAt === 'string' && row.claimedAt.length > 0;
  } catch {
    // An unreadable ledger is not permission to call a provider twice.
    return true;
  }
}

/**
 * Claim provider I/O for one reservation, or refuse.
 *
 * There is deliberately no unauthorized branch. A crossing with no resolved
 * call authority cannot claim I/O, because nothing would bind the claim to an
 * account, schema, effect or argument digest.
 *
 * A legitimate takeover is allowed and needs no separate path: it is simply a
 * claim whose lease is current while the reservation is still unclaimed.
 */
export function claimPhysicalIo(input: {
  identity: PhysicalIoClaimIdentity;
  authority: ResolvedCallAuthorityV1;
  /**
   * The lease generation this activation currently holds.
   *
   * Ownership is ephemeral, so it is judged against the live lease rather than
   * the fence frozen into `authority` when the crossing was first reserved.
   * Otherwise a crash would leave an unclaimed reservation that its legitimate
   * successor could neither invoke nor take over.
   */
  currentOwnerFence: string;
}): PhysicalIoClaimResult {
  const { identity, authority } = input;
  if (
    authority.acceptedSource.sessionId !== identity.sessionId
    || authority.acceptedSource.sourceUserSeq !== identity.sourceUserSeq
    || authority.physicalDispatchId !== identity.physicalDispatchId
  ) {
    return { claimed: false, reason: 'authority_mismatch' };
  }
  const fence = parseCanonicalOwnerFence(input.currentOwnerFence);
  if (!fence || !parseCanonicalOwnerFence(authority.ownerFence)) {
    return { claimed: false, reason: 'malformed_owner_fence' };
  }

  const db = openEventLog();
  const claimedAt = new Date().toISOString();
  const outcome = db.transaction((): PhysicalIoClaimResult => {
    const reservation = db.prepare(
      `SELECT io_claimed_at AS claimedAt FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?`,
    ).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.physicalDispatchId,
    ) as { claimedAt: string | null } | undefined;
    if (!reservation) return { claimed: false, reason: 'no_reservation' };
    if (reservation.claimedAt) return { claimed: false, reason: 'already_claimed' };

    const lease = db.prepare(
      `SELECT owner, fence, revision, expires_at AS expiresAt, released
         FROM graph_node_leases WHERE lease_key = ?`,
    ).get(canonicalGraphNodeLeaseKey({
      sessionId: authority.acceptedSource.sessionId,
      sourceUserSeq: authority.acceptedSource.sourceUserSeq,
      graphId: authority.graphId,
      nodeId: authority.nodeId,
    })) as LeaseRow | undefined;
    if (
      !lease
      || lease.owner !== fence.owner
      || lease.fence !== fence.fence
      || lease.released === 1
      || lease.expiresAt <= Date.now()
    ) {
      return { claimed: false, reason: 'lease_not_current' };
    }
    // The generation may advance by one while this activation holds the lease
    // (renewal); anything further means another owner has taken it.
    if (lease.revision !== fence.revision && lease.revision !== fence.revision + 1) {
      return { claimed: false, reason: 'lease_not_current' };
    }

    // Compare-and-set: only the activation that observes an unclaimed row wins.
    const changes = db.prepare(
      `UPDATE physical_dispatches
          SET io_claimed_at = ?, io_owner = ?, io_fence = ?, io_revision = ?
        WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
          AND io_claimed_at IS NULL`,
    ).run(
      claimedAt,
      fence.owner,
      fence.fence,
      lease.revision,
      identity.sessionId,
      identity.sourceUserSeq,
      identity.physicalDispatchId,
    ).changes;
    return changes === 1 ? { claimed: true } : { claimed: false, reason: 'already_claimed' };
  }).immediate();
  return outcome;
}

/**
 * Workflow read-only I/O claim.
 *
 * This deliberately does not pretend a workflow activation owns a graph lease.
 * The exact immutable activation/root plus its unforgeable ALS proof is the
 * owner; the same physical row CAS remains the one provider-I/O linearization
 * point. Graph claim bytes and lease behavior above remain untouched.
 */
export function claimWorkflowPhysicalIo(input: {
  identity: PhysicalIoClaimIdentity & {
    authorityRootId: string;
    logicalCallId: string;
  };
  activationId: string;
  activationDigest: string;
  authorityDigest: string;
  authorityRevision: number;
  toolName: string;
}): PhysicalIoClaimResult {
  const { identity } = input;
  const attestationInput = {
    sessionId: identity.sessionId,
    sourceEventSeq: identity.sourceUserSeq,
    authorityRootId: identity.authorityRootId,
    activationId: input.activationId,
    activationDigest: input.activationDigest,
    authorityDigest: input.authorityDigest,
    authorityRevision: input.authorityRevision,
    logicalCallId: identity.logicalCallId,
    physicalToolName: input.toolName,
  };
  if (
    !workflowReadOnlyPhysicalClaimAttestationMatches(attestationInput)
    && !workflowV3PhysicalClaimAttestationMatches(attestationInput)
  ) return { claimed: false, reason: 'authority_mismatch' };

  const db = openEventLog();
  const claimedAt = new Date().toISOString();
  return db.transaction((): PhysicalIoClaimResult => {
    const row = db.prepare(`
      SELECT p.accepted_task_id, p.logical_tool_call_id, p.tool_name,
             p.state AS physical_state, p.io_claimed_at,
             a.authority_kind, a.authority_digest, a.revision,
             a.state AS authority_state, a.workflow_activation_id,
             a.workflow_activation_digest, a.workflow_logical_call_id,
             a.workflow_node_attempt,
             w.authority_root_id, w.logical_call_id AS activation_logical_call_id
        FROM physical_dispatches p
        JOIN accepted_turn_call_authorities a
          ON a.session_id = p.session_id
         AND a.source_user_seq = p.source_user_seq
        JOIN workflow_node_invocation_activations w
          ON w.activation_id = a.workflow_activation_id
       WHERE p.session_id = ? AND p.source_user_seq = ?
         AND p.physical_dispatch_id = ?
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.physicalDispatchId,
    ) as {
      accepted_task_id: string;
      logical_tool_call_id: string;
      tool_name: string;
      physical_state: string;
      io_claimed_at: string | null;
      authority_kind: string;
      authority_digest: string;
      revision: number;
      authority_state: string;
      workflow_activation_id: string | null;
      workflow_activation_digest: string | null;
      workflow_logical_call_id: string | null;
      workflow_node_attempt: number | null;
      authority_root_id: string;
      activation_logical_call_id: string;
    } | undefined;
    if (!row) return { claimed: false, reason: 'no_reservation' };
    if (row.io_claimed_at) return { claimed: false, reason: 'already_claimed' };
    if (
      row.physical_state !== 'started'
      || !['workflow_v1_read_only', 'workflow_v3_call'].includes(row.authority_kind)
      || row.authority_state !== 'open'
      || row.accepted_task_id !== identity.authorityRootId
      || row.authority_root_id !== identity.authorityRootId
      || row.logical_tool_call_id !== identity.logicalCallId
      || row.activation_logical_call_id !== identity.logicalCallId
      || row.workflow_logical_call_id !== identity.logicalCallId
      || row.tool_name !== input.toolName
      || row.workflow_activation_id !== input.activationId
      || row.workflow_activation_digest !== input.activationDigest
      || row.authority_digest !== input.authorityDigest
      || row.revision !== input.authorityRevision
      || !Number.isSafeInteger(row.workflow_node_attempt)
      || (row.workflow_node_attempt ?? 0) <= 0
    ) return { claimed: false, reason: 'authority_mismatch' };

    const changes = db.prepare(`
      UPDATE physical_dispatches
         SET io_claimed_at = ?, io_owner = ?, io_fence = ?, io_revision = ?
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
         AND state = 'started' AND io_claimed_at IS NULL
    `).run(
      claimedAt,
      input.activationId,
      row.workflow_node_attempt,
      row.revision,
      identity.sessionId,
      identity.sourceUserSeq,
      identity.physicalDispatchId,
    ).changes;
    return changes === 1 ? { claimed: true } : { claimed: false, reason: 'already_claimed' };
  }).immediate();
}

/** Sequential page child of one workflow_v2_paginated_read activation. The
 * page reservation and opaque ALS proof replace graph lease identity; the same
 * physical row CAS remains the only provider-I/O linearization point. */
function claimWorkflowPaginatedIo(input: {
  identity: PhysicalIoClaimIdentity & {
    authorityRootId: string;
    logicalCallId: string;
  };
  activationId: string;
  activationDigest: string;
  authorityDigest: string;
  authorityRevision: number;
  pageOrdinal: number;
  toolName: string;
}, relation: 'business' | 'probe'): PhysicalIoClaimResult {
  const { identity } = input;
  const attestationInput = {
    sessionId: identity.sessionId,
    sourceEventSeq: identity.sourceUserSeq,
    authorityRootId: identity.authorityRootId,
    activationId: input.activationId,
    activationDigest: input.activationDigest,
    authorityDigest: input.authorityDigest,
    authorityRevision: input.authorityRevision,
    pageOrdinal: input.pageOrdinal,
    logicalCallId: identity.logicalCallId,
    physicalDispatchId: identity.physicalDispatchId,
    toolName: input.toolName,
  };
  const attested = relation === 'probe'
    ? workflowReadPagePreparationClaimAttestationMatches(attestationInput)
    : workflowReadPagePhysicalClaimAttestationMatches(attestationInput);
  if (!attested) return { claimed: false, reason: 'authority_mismatch' };

  const db = openEventLog();
  const claimedAt = new Date().toISOString();
  return db.transaction((): PhysicalIoClaimResult => {
    const row = db.prepare(`
      SELECT p.accepted_task_id, p.logical_tool_call_id, p.tool_name, p.relation,
             p.state AS physical_state, p.io_claimed_at,
             a.authority_kind, a.authority_digest, a.revision,
             a.state AS authority_state, a.workflow_activation_digest,
             w.authority_root_id, w.activation_digest, w.node_attempt,
             w.aggregate_state, pg.state AS page_state,
             pg.logical_call_id AS page_logical_call_id,
             pg.physical_dispatch_id AS page_physical_dispatch_id
        FROM physical_dispatches p
        JOIN accepted_turn_call_authorities a
          ON a.session_id = p.session_id AND a.source_user_seq = p.source_user_seq
        JOIN workflow_paginated_read_activations w
          ON w.authority_root_id = a.accepted_task_id
        JOIN workflow_paginated_read_pages pg
          ON pg.activation_id = w.activation_id
         AND pg.page_ordinal = ?
       WHERE p.session_id = ? AND p.source_user_seq = ?
         AND p.physical_dispatch_id = ?
    `).get(
      input.pageOrdinal,
      identity.sessionId,
      identity.sourceUserSeq,
      identity.physicalDispatchId,
    ) as {
      accepted_task_id: string;
      logical_tool_call_id: string;
      tool_name: string;
      relation: string;
      physical_state: string;
      io_claimed_at: string | null;
      authority_kind: string;
      authority_digest: string;
      revision: number;
      authority_state: string;
      workflow_activation_digest: string | null;
      authority_root_id: string;
      activation_digest: string;
      node_attempt: number;
      aggregate_state: string;
      page_state: string;
      page_logical_call_id: string;
      page_physical_dispatch_id: string;
    } | undefined;
    if (!row) return { claimed: false, reason: 'no_reservation' };
    if (row.io_claimed_at) return { claimed: false, reason: 'already_claimed' };
    if (
      row.physical_state !== 'started'
      || row.authority_kind !== 'workflow_v2_paginated_read'
      || row.authority_state !== 'open'
      || row.aggregate_state !== 'open'
      || row.page_state !== 'reserved'
      || (relation === 'probe' ? row.relation !== 'probe' : row.relation === 'probe')
      || row.accepted_task_id !== identity.authorityRootId
      || row.authority_root_id !== identity.authorityRootId
      || row.logical_tool_call_id !== identity.logicalCallId
      || row.page_logical_call_id !== identity.logicalCallId
      || (relation === 'business' && row.page_physical_dispatch_id !== identity.physicalDispatchId)
      || row.tool_name !== input.toolName
      || row.workflow_activation_digest !== input.activationDigest
      || row.activation_digest !== input.activationDigest
      || row.authority_digest !== input.authorityDigest
      || row.revision !== input.authorityRevision
      || !Number.isSafeInteger(row.node_attempt) || row.node_attempt <= 0
    ) return { claimed: false, reason: 'authority_mismatch' };
    const changes = db.prepare(`
      UPDATE physical_dispatches
         SET io_claimed_at = ?, io_owner = ?, io_fence = ?, io_revision = ?
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
         AND state = 'started' AND io_claimed_at IS NULL
    `).run(
      claimedAt,
      `${input.activationId}:page:${input.pageOrdinal}`,
      row.node_attempt,
      row.revision,
      identity.sessionId,
      identity.sourceUserSeq,
      identity.physicalDispatchId,
    ).changes;
    return changes === 1 ? { claimed: true } : { claimed: false, reason: 'already_claimed' };
  }).immediate();
}

export function claimWorkflowPaginatedPhysicalIo(input: Parameters<typeof claimWorkflowPaginatedIo>[0]): PhysicalIoClaimResult {
  return claimWorkflowPaginatedIo(input, 'business');
}

export function claimWorkflowPaginatedPreparationPhysicalIo(
  input: Parameters<typeof claimWorkflowPaginatedIo>[0],
): PhysicalIoClaimResult {
  return claimWorkflowPaginatedIo(input, 'probe');
}
