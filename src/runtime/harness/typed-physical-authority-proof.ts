/**
 * Read-only reopening of one typed graph-executor crossing.
 *
 * The caller supplies its existing SQLite transaction. This module neither
 * creates authority nor consults process registries: it reconstructs the
 * exact persisted ResolvedCallAuthorityV1, reopens its sealed canonical
 * provider arguments, and joins both typed authority rows back to the one
 * returned provider crossing.
 */
import type Database from 'better-sqlite3';
import { openCanonicalArguments } from './authority-argument-seal.js';
import {
  canonicalArgumentDigestOf,
  parseResolvedCallAuthority,
  type ResolvedCallAuthorityV1,
} from './resolved-call-authority.js';
import {
  catalogSnapshotDigestOf,
  type CanonicalCatalogIdentityV1,
} from './host-capability-catalog-factory.js';

export interface TypedPhysicalAuthorityFacts {
  acceptedTaskId: string;
  graphId: string;
  graphHash: string;
  nodeId: string;
  logicalCallId: string;
  physicalDispatchId: string;
  operationId: string;
  capabilityRef: string;
  manifestId: string;
  manifestDigest: string;
  operationVersion: string;
  providerInputSchemaDigest?: string;
  logicalArgumentDigest: string;
  canonicalArgumentDigest: string;
  accountId: string;
  resolvedEffect: ResolvedCallAuthorityV1['resolvedEffect'];
  liveFingerprint: string;
  catalogSnapshotDigest: string;
  authorityDigest: string;
}

export type TypedPhysicalAuthorityProof =
  | { status: 'ok'; authority: TypedPhysicalAuthorityFacts }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

interface TypedPhysicalRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  physical_dispatch_id: string;
  ordinal: number;
  relation: string;
  retry_of: string | null;
  tool_name: string;
  argument_digest: string;
  state: string;
  execution_site: string | null;
  dispatch_authority_digest: string | null;
  dispatch_provider_argument_digest: string | null;
  row_authority_digest: string | null;
  row_provider_argument_digest: string | null;
  sealed_authority_digest: string | null;
  sealed_provider_argument_digest: string | null;
  observation_digest: string | null;
  sealed_json: string | null;
  byte_length: number | null;
  retention_class: string | null;
  argument_cipher: string | null;
}

interface CatalogSnapshotRow {
  snapshot_digest: string;
  snapshot_json: string;
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Exact absence is distinguishable from a partial/corrupt typed reservation. */
export function reopenTypedPhysicalAuthorityInTransaction(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  physicalDispatchId: string;
}): TypedPhysicalAuthorityProof {
  try {
    const row = input.db.prepare(`
      SELECT p.accepted_task_id, p.logical_tool_call_id, p.physical_dispatch_id,
             p.ordinal, p.relation, p.retry_of, p.tool_name, p.argument_digest,
             p.state, p.execution_site,
             p.authority_digest AS dispatch_authority_digest,
             p.provider_argument_digest AS dispatch_provider_argument_digest,
             a.authority_digest AS row_authority_digest,
             a.provider_argument_digest AS row_provider_argument_digest,
             s.authority_digest AS sealed_authority_digest,
             s.provider_argument_digest AS sealed_provider_argument_digest,
             s.observation_digest, s.sealed_json, s.byte_length,
             s.retention_class, s.argument_cipher
        FROM physical_dispatches p
        LEFT JOIN physical_dispatch_authority a
          ON a.session_id = p.session_id
         AND a.source_user_seq = p.source_user_seq
         AND a.physical_dispatch_id = p.physical_dispatch_id
        LEFT JOIN physical_dispatch_authority_sealed s
          ON s.session_id = p.session_id
         AND s.source_user_seq = p.source_user_seq
         AND s.physical_dispatch_id = p.physical_dispatch_id
       WHERE p.session_id = ? AND p.source_user_seq = ?
         AND p.physical_dispatch_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.physicalDispatchId,
    ) as TypedPhysicalRow | undefined;
    if (!row) return { status: 'missing', reason: 'physical crossing is missing' };

    const typedBytesPresent = Boolean(
      row.dispatch_authority_digest
      || row.dispatch_provider_argument_digest
      || row.row_authority_digest
      || row.row_provider_argument_digest
      || row.sealed_authority_digest
      || row.sealed_provider_argument_digest
      || row.sealed_json
      || row.argument_cipher,
    );
    if (!typedBytesPresent) {
      return { status: 'missing', reason: 'typed physical authority is absent' };
    }
    if (
      row.state !== 'returned'
      || row.execution_site !== null
      || !row.dispatch_authority_digest
      || !row.dispatch_provider_argument_digest
      || row.row_authority_digest !== row.dispatch_authority_digest
      || row.sealed_authority_digest !== row.dispatch_authority_digest
      || row.row_provider_argument_digest !== row.dispatch_provider_argument_digest
      || row.sealed_provider_argument_digest !== row.dispatch_provider_argument_digest
      || !row.sealed_json
      || row.byte_length !== Buffer.byteLength(row.sealed_json, 'utf8')
      || row.retention_class !== 'settled'
      || !row.argument_cipher
    ) return { status: 'conflict', reason: 'typed physical authority rows do not form one exact returned provider crossing' };

    const parsed = parseResolvedCallAuthority(row.sealed_json);
    if (!parsed.ok) {
      return { status: 'conflict', reason: `typed physical authority envelope is ${parsed.reason}` };
    }
    const authority = parsed.authority;
    const canonicalArgs = openCanonicalArguments(row.argument_cipher);
    if (!canonicalArgs) {
      return { status: 'conflict', reason: 'typed physical authority arguments cannot be reopened' };
    }
    if (
      authority.acceptedSource.sessionId !== input.sessionId
      || authority.acceptedSource.sourceUserSeq !== input.sourceUserSeq
      || authority.acceptedTaskId !== row.accepted_task_id
      || authority.logicalCallId !== row.logical_tool_call_id
      || authority.physicalDispatchId !== row.physical_dispatch_id
      || authority.ordinal !== row.ordinal
      || authority.relation !== row.relation
      || (authority.retryOf ?? null) !== row.retry_of
      || authority.operationId !== row.tool_name
      || authority.logicalArgumentDigest !== row.argument_digest
      || authority.authorityDigest !== row.dispatch_authority_digest
      || authority.canonicalArgumentDigest !== row.dispatch_provider_argument_digest
      || authority.observationDigest !== row.observation_digest
      || canonicalArgumentDigestOf(canonicalArgs) !== authority.canonicalArgumentDigest
    ) return { status: 'conflict', reason: 'typed physical authority envelope conflicts with its crossing or sealed arguments' };

    const snapshot = input.db.prepare(`
      SELECT snapshot_digest, snapshot_json
        FROM accepted_source_catalog_snapshots
       WHERE session_id = ? AND source_user_seq = ?
    `).get(input.sessionId, input.sourceUserSeq) as CatalogSnapshotRow | undefined;
    let identities: CanonicalCatalogIdentityV1[];
    try {
      identities = snapshot ? JSON.parse(snapshot.snapshot_json) as CanonicalCatalogIdentityV1[] : [];
    } catch {
      return { status: 'conflict', reason: 'typed physical authority catalog snapshot is malformed' };
    }
    if (
      !snapshot
      || !Array.isArray(identities)
      || snapshot.snapshot_digest !== authority.catalogSnapshotDigest
      || catalogSnapshotDigestOf(identities) !== snapshot.snapshot_digest
    ) return { status: 'conflict', reason: 'typed physical authority catalog snapshot digest is not exact' };
    const catalogMatches = identities.filter((identity) => (
      identity.capabilityId === authority.capabilityRef
      && identity.manifestId === authority.manifestId
      && identity.manifestDigest === authority.manifestDigest
      && identity.operationId === authority.operationId
      && identity.schemaVersion === authority.operationVersion
      && identity.liveFingerprint === authority.liveFingerprint
      && identity.account === authority.accountId
      && identity.effect === authority.resolvedEffect
      && identity.providerKind === authority.providerKind
      && identity.providerVersion === authority.liveProviderVersion
    ));
    if (catalogMatches.length !== 1) {
      return { status: 'conflict', reason: 'typed physical authority has no unique exact frozen catalog identity' };
    }
    const catalogIdentity = catalogMatches[0]!;

    return {
      status: 'ok',
      authority: {
        acceptedTaskId: authority.acceptedTaskId,
        graphId: authority.graphId,
        graphHash: authority.graphHash,
        nodeId: authority.nodeId,
        logicalCallId: authority.logicalCallId,
        physicalDispatchId: authority.physicalDispatchId,
        operationId: authority.operationId,
        capabilityRef: authority.capabilityRef,
        manifestId: authority.manifestId,
        manifestDigest: authority.manifestDigest,
        operationVersion: authority.operationVersion,
        ...(catalogIdentity.providerInputSchemaDigest
          ? { providerInputSchemaDigest: catalogIdentity.providerInputSchemaDigest }
          : {}),
        logicalArgumentDigest: authority.logicalArgumentDigest,
        canonicalArgumentDigest: authority.canonicalArgumentDigest,
        accountId: authority.accountId,
        resolvedEffect: authority.resolvedEffect,
        liveFingerprint: authority.liveFingerprint,
        catalogSnapshotDigest: authority.catalogSnapshotDigest,
        authorityDigest: authority.authorityDigest,
      },
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}
