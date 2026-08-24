/**
 * Closed authority formats.
 *
 * Three separate families with separate types, digests and parsers. They exist
 * because the historical envelope hashed an *activation* fact — `ownerFence` —
 * into what is supposed to be stable business authority, which made a legitimate
 * lease takeover unable to satisfy its own reservation.
 *
 * Rewriting the historical digest in place would reinterpret persistent security
 * authority, so nothing here mutates `callAuthorityDigestOf`. Legacy bytes stay
 * exactly as written and are readable only as evidence; new stable authority is
 * a distinct, domain-separated format that cannot collide with either legacy
 * family.
 *
 * The three families are deliberately not unified behind one mutable version
 * constant: a single parser is how v1 became unreadable in the first place.
 */
import { createHash } from 'node:crypto';

/** Historical envelope, version 1. Includes `ownerFence`. Frozen forever. */
export const LEGACY_OWNER_FENCED_V1 = 'legacy_owner_fenced_v1' as const;
/** Current accidental version-2 encoding. Also includes `ownerFence`. */
export const PROVISIONAL_OWNER_FENCED_V2 = 'provisional_owner_fenced_v2' as const;
/** Stable business authority. Excludes every activation-ownership fact. */
export const STABLE_BUSINESS_V3 = 'stable_business_v3' as const;

export type AuthorityFormat =
  | typeof LEGACY_OWNER_FENCED_V1
  | typeof PROVISIONAL_OWNER_FENCED_V2
  | typeof STABLE_BUSINESS_V3;

/** Domain separation: the same bytes must never digest alike across formats. */
const STABLE_BUSINESS_V3_DOMAIN = 'clementine:resolved-business-authority:v3';
const RESERVATION_CLAIM_SEAL_DOMAIN = 'clementine:reservation-claim-seal:v1';

/** Why a stored authority row may not authorize new execution. Closed set. */
export type AuthorityQuarantineCode =
  | 'provisional_owner_fenced'
  | 'unknown_format'
  | 'malformed_envelope'
  | 'digest_mismatch'
  | 'missing_sealed_row'
  | 'plaintext_leak'
  | 'cipher_mismatch'
  | 'orphan_row'
  | 'digest_collision'
  | 'ambiguous_version';

/**
 * Activation ownership, deliberately separate from business authority.
 * A business digest is not a bearer token; these facts live with the
 * reservation/claim transition and change on every legitimate takeover.
 */
export interface ReservationClaimSeal {
  physicalDispatchId: string;
  owner: string;
  fence: number;
  leaseRevision: number;
  leaseExpiresAt: number;
}

export function reservationClaimSealDigestOf(seal: ReservationClaimSeal): string {
  return createHash('sha256').update(JSON.stringify({
    domain: RESERVATION_CLAIM_SEAL_DOMAIN,
    physicalDispatchId: seal.physicalDispatchId,
    owner: seal.owner,
    fence: seal.fence,
    leaseRevision: seal.leaseRevision,
    leaseExpiresAt: seal.leaseExpiresAt,
  }), 'utf8').digest('hex');
}

/**
 * Every immutable business field of a crossing.
 *
 * Activation owner, fence, lease revision, expiry and takeover state are
 * absent by construction: two owners of the same business crossing must agree
 * on this digest, or recovery can never resume what a crash reserved.
 */
export interface StableBusinessAuthorityV3 {
  acceptedSource: { sessionId: string; sourceUserSeq: number };
  acceptedTaskId: string;
  claimEventId: string;
  semanticProvenanceDigest: string;
  goalRevision: number;
  graphId: string;
  graphHash: string;
  nodeId: string;
  logicalCallId: string;
  physicalDispatchId: string;
  ordinal: number;
  relation: string;
  operationId: string;
  capabilityRef: string;
  manifestId: string;
  manifestDigest: string;
  providerKind: string;
  providerIdentity: string;
  operationVersion: string;
  liveProviderVersion: string;
  liveFingerprint: string;
  accountId: string;
  resolvedEffect: string;
  destination?: unknown;
  canonicalArgumentDigest: string;
  logicalArgumentDigest: string;
  argumentCompiler: unknown;
  observationId: string;
  observationDigest: string;
  observationObservedAt: number;
  observationOrigin: string;
  observerImplementationId?: string;
  invokePortId: string;
  reconcilePortId?: string;
  invokeImplementationDigest: string;
  reconcileImplementationDigest?: string;
  transportImplementationDigest: string;
  providerClientDigest?: string;
  reconciliationPolicy: string;
  idempotency: unknown;
  evidenceContract: unknown;
  policySnapshotDigest: string;
  catalogSnapshotDigest: string;
  /** Cross-format links are forbidden: a predecessor names its exact format. */
  predecessor?: StableBusinessPredecessorRef;
}

/** A retry may only name a predecessor in the same format, by exact identity. */
export interface StableBusinessPredecessorRef {
  format: typeof STABLE_BUSINESS_V3;
  digest: string;
  physicalDispatchId: string;
}

/** Canonical field order. Adding a business field here changes every digest. */
export function stableBusinessAuthorityDigestOf(authority: StableBusinessAuthorityV3): string {
  return createHash('sha256').update(JSON.stringify({
    domain: STABLE_BUSINESS_V3_DOMAIN,
    format: STABLE_BUSINESS_V3,
    acceptedSource: authority.acceptedSource,
    acceptedTaskId: authority.acceptedTaskId,
    claimEventId: authority.claimEventId,
    semanticProvenanceDigest: authority.semanticProvenanceDigest,
    goalRevision: authority.goalRevision,
    graphId: authority.graphId,
    graphHash: authority.graphHash,
    nodeId: authority.nodeId,
    logicalCallId: authority.logicalCallId,
    physicalDispatchId: authority.physicalDispatchId,
    ordinal: authority.ordinal,
    relation: authority.relation,
    operationId: authority.operationId,
    capabilityRef: authority.capabilityRef,
    manifestId: authority.manifestId,
    manifestDigest: authority.manifestDigest,
    providerKind: authority.providerKind,
    providerIdentity: authority.providerIdentity,
    operationVersion: authority.operationVersion,
    liveProviderVersion: authority.liveProviderVersion,
    liveFingerprint: authority.liveFingerprint,
    accountId: authority.accountId,
    resolvedEffect: authority.resolvedEffect,
    destination: authority.destination ?? null,
    canonicalArgumentDigest: authority.canonicalArgumentDigest,
    logicalArgumentDigest: authority.logicalArgumentDigest,
    argumentCompiler: authority.argumentCompiler,
    observationId: authority.observationId,
    observationDigest: authority.observationDigest,
    observationObservedAt: authority.observationObservedAt,
    observationOrigin: authority.observationOrigin,
    observerImplementationId: authority.observerImplementationId ?? null,
    invokePortId: authority.invokePortId,
    reconcilePortId: authority.reconcilePortId ?? null,
    invokeImplementationDigest: authority.invokeImplementationDigest,
    reconcileImplementationDigest: authority.reconcileImplementationDigest ?? null,
    transportImplementationDigest: authority.transportImplementationDigest,
    providerClientDigest: authority.providerClientDigest ?? null,
    reconciliationPolicy: authority.reconciliationPolicy,
    idempotency: authority.idempotency,
    evidenceContract: authority.evidenceContract,
    policySnapshotDigest: authority.policySnapshotDigest,
    catalogSnapshotDigest: authority.catalogSnapshotDigest,
    predecessor: authority.predecessor
      ? {
          format: authority.predecessor.format,
          digest: authority.predecessor.digest,
          physicalDispatchId: authority.predecessor.physicalDispatchId,
        }
      : null,
  }), 'utf8').digest('hex');
}

/**
 * A stored envelope decoded as evidence only.
 *
 * There is deliberately no path from this type into reserve/claim/invoke: the
 * type system is the enforcement, not a runtime flag someone can flip.
 */
export interface DecodedAuthorityEvidence {
  format: AuthorityFormat;
  /** Exactly the digest that was written. Never recomputed or rehashed. */
  originalAuthorityDigest: string;
  ownerFence?: string;
  quarantine?: AuthorityQuarantineCode;
  raw: Readonly<Record<string, unknown>>;
}

function frozen(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...value });
}

/**
 * Classify a stored envelope without ever promoting it to execution authority.
 *
 * An unreadable or ambiguous row is quarantined, never guessed at: a wrong
 * guess here would authorize a provider crossing on bytes we cannot explain.
 */
export function classifyStoredAuthority(input: {
  json: string;
  storedDigest?: string;
}): DecodedAuthorityEvidence {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(input.json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        format: LEGACY_OWNER_FENCED_V1,
        originalAuthorityDigest: input.storedDigest ?? '',
        quarantine: 'malformed_envelope',
        raw: frozen({}),
      };
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return {
      format: LEGACY_OWNER_FENCED_V1,
      originalAuthorityDigest: input.storedDigest ?? '',
      quarantine: 'malformed_envelope',
      raw: frozen({}),
    };
  }

  const digest = typeof parsed.authorityDigest === 'string' ? parsed.authorityDigest : '';
  const originalAuthorityDigest = input.storedDigest ?? digest;
  const ownerFence = typeof parsed.ownerFence === 'string' ? parsed.ownerFence : undefined;
  const version = parsed.version;

  // A stable-v3 envelope is self-describing and carries no ownership.
  if (parsed.format === STABLE_BUSINESS_V3) {
    return {
      format: STABLE_BUSINESS_V3,
      originalAuthorityDigest,
      ...(ownerFence ? { quarantine: 'ambiguous_version' as const, ownerFence } : {}),
      raw: frozen(parsed),
    };
  }

  if (version === 1) {
    return {
      format: LEGACY_OWNER_FENCED_V1,
      originalAuthorityDigest,
      ...(ownerFence ? { ownerFence } : {}),
      ...(digest && input.storedDigest && digest !== input.storedDigest
        ? { quarantine: 'digest_mismatch' as const }
        : {}),
      raw: frozen(parsed),
    };
  }

  if (version === 2) {
    // Provisional: shipped as "v2" but still fences the business authority, so
    // it is quarantined until its provenance is mechanically proven disposable.
    return {
      format: PROVISIONAL_OWNER_FENCED_V2,
      originalAuthorityDigest,
      ...(ownerFence ? { ownerFence } : {}),
      quarantine: 'provisional_owner_fenced',
      raw: frozen(parsed),
    };
  }

  return {
    format: LEGACY_OWNER_FENCED_V1,
    originalAuthorityDigest,
    ...(ownerFence ? { ownerFence } : {}),
    quarantine: typeof version === 'number' ? 'unknown_format' : 'ambiguous_version',
    raw: frozen(parsed),
  };
}

/** Only a clean stable-v3 record may ever back new provider I/O. */
export function authorityMayAuthorizeExecution(evidence: DecodedAuthorityEvidence): boolean {
  return evidence.format === STABLE_BUSINESS_V3 && evidence.quarantine === undefined;
}
