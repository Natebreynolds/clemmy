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
