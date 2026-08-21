/**
 * Call-scoped authority minted only after canonical arguments exist.
 *
 * Binding a catalog entry names a candidate. This object is the grant: it
 * freezes the accepted source, graph node, manifest, arguments, account,
 * destination, effect, evidence, and policy snapshot. Missing, stale,
 * revoked, ambiguous, or mismatched metadata refuses with zero provider calls.
 */
import { isHostAuthorityIdentity } from '../semantic-boundary/host-authority.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
  type ManifestEffect,
} from './capability-manifest.js';
import { bindingEffectFitsCeiling } from './host-capability-catalog-factory.js';
import { isPlaceholderBetaAccount } from './production-capability-catalog.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import {
  observationDigestOf,
  observationIsFresh,
  shippedObserverImplementationId,
  type CapabilityObservationOrigin,
  type IndependentCapabilityObservation,
} from './independent-capability-observation.js';
import { shippedImplementationDigest, shippedTransportDigest } from './shipped-implementation-identity.js';
import { derivePhysicalDispatchId } from './physical-crossing-identity.js';

export const RESOLVED_CALL_AUTHORITY_VERSION = 2 as const;
export const SEALED_CALL_AUTHORITY_MAX_BYTES = 64_000;
export type PhysicalAuthorityRelation = 'primary' | 'retry' | 'poll' | 'probe' | 'child';
export type RetryAuthorityReason = 'uncertain_recovery' | 'owner_lost' | 'explicit_retry';

export type CallAuthorityRefusal =
  | 'missing_canonical_args'
  | 'argument_digest_mismatch'
  | 'unknown_manifest'
  | 'stale_fingerprint'
  | 'revoked_manifest'
  | 'superseded_manifest'
  | 'ambiguous_manifest'
  | 'effect_mismatch'
  | 'destination_mismatch'
  | 'account_mismatch'
  | 'schema_drift'
  | 'server_drift'
  | 'binary_drift'
  | 'effect_exceeds_ceiling'
  | 'write_judge_required'
  | 'write_judge_mismatch'
  | 'missing_catalog_snapshot'
  | 'incomplete_identity'
  | 'missing_grounding'
  | 'grounding_mismatch'
  | 'invoke_port_mismatch'
  | 'compiler_mismatch'
  | 'observation_not_independent'
  | 'observation_stale'
  | 'observation_mismatch'
  | 'crossing_identity_mismatch'
  | 'reconcile_port_mismatch'
  | 'placeholder_account'
  | 'malformed_envelope';

export interface ResolvedCallAuthorityV1 {
  version: typeof RESOLVED_CALL_AUTHORITY_VERSION;
  acceptedSource: { sessionId: string; sourceUserSeq: number };
  acceptedTaskId: string;
  claimEventId: string;
  semanticProvenanceDigest: string;
  goalRevision: number;
  graphId: string;
  graphHash: string;
  nodeId: string;
  operationId: string;
  capabilityRef: string;
  manifestId: string;
  manifestDigest: string;
  providerKind: CapabilityManifestV1['providerKind'];
  providerIdentity: string;
  operationVersion: string;
  liveProviderVersion: string;
  canonicalArgumentDigest: string;
  logicalArgumentDigest: string;
  canonicalArgs: Record<string, unknown>;
  logicalCallId: string;
  accountId: string;
  destination?: { family: string; posture: string };
  resolvedEffect: ManifestEffect;
  argumentCompiler: { id: string; version: string };
  invokePortId: string;
  reconcilePortId?: string;
  physicalDispatchId: string;
  ordinal: number;
  relation: PhysicalAuthorityRelation;
  retryOf?: string;
  predecessorAuthorityDigest?: string;
  retryReason?: RetryAuthorityReason;
  ownerFence: string;
  observationId: string;
  observationDigest: string;
  observationObservedAt: number;
  observationOrigin: CapabilityObservationOrigin;
  observerImplementationId?: string;
  invokeImplementationDigest: string;
  reconcileImplementationDigest?: string;
  transportImplementationDigest: string;
  reconciliationPolicy: CapabilityManifestV1['reconciliation']['policy'];
  idempotency: CapabilityManifestV1['idempotency'];
  evidenceContract: CapabilityManifestV1['evidenceContract'];
  policySnapshotDigest: string;
  catalogSnapshotDigest: string;
  liveFingerprint: string;
  writeJudge?: { identity: string; digest: string };
  groundingIdentity: string;
  groundingReceiptDigest: string;
  proposalDigest: string;
  authorityDigest: string;
}

export interface MintResolvedCallAuthorityInput {
  acceptedSource: { sessionId: string; sourceUserSeq: number };
  acceptedTaskId: string;
  goalRevision: number;
  graphId: string;
  nodeId: string;
  operationId: string;
  manifest: CapabilityManifestV1 | null | undefined;
  canonicalArgumentDigest: string;
  liveFingerprint: string;
  liveProviderVersion: string;
  liveAccountId: string;
  nodeEffect: string;
  graphCeiling: string;
  graphDestination?: {
    family: string;
    posture: string;
    binding?: {
      manifestId: string;
      manifestDigest: string;
      accountId: string;
      operationId: string;
      schemaVersion: string;
      definitionFingerprint: string;
      effect: string;
      posture: string;
    };
  };
  policySnapshotDigest: string;
  catalogSnapshotDigest: string;
  writeJudge?: { identity: string; digest: string } | null;
  groundingIdentity: string;
  groundingReceiptDigest: string;
  proposalDigest: string;
  claimEventId: string;
  semanticProvenanceDigest: string;
  graphHash: string;
  capabilityRef: string;
  canonicalArgs: Record<string, unknown>;
  logicalArgs?: Record<string, unknown>;
  logicalCallId: string;
  physicalDispatchId: string;
  ordinal: number;
  relation: PhysicalAuthorityRelation;
  retryOf?: string;
  predecessorAuthorityDigest?: string;
  retryReason?: RetryAuthorityReason;
  ownerFence: string;
  observation: IndependentCapabilityObservation;
}

const WRITE_EFFECTS = new Set(['local_write', 'external_write', 'admin']);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const CLOSED_EVIDENCE_KINDS = new Set([
  'payload',
  'receipt',
  'readback',
  'source_locator',
  'collection',
  'lineage',
  'create_receipt',
  'evidence_ref',
  'durable_effect_receipt',
]);
const ACCEPTED_SOURCE_KEYS = new Set(['sessionId', 'sourceUserSeq']);
const DESTINATION_KEYS = new Set(['family', 'posture']);
const COMPILER_KEYS = new Set(['id', 'version']);
const IDEMPOTENCY_KEYS = new Set(['required', 'policy']);
const EVIDENCE_KEYS = new Set(['kinds', 'readbackRequired']);
const WRITE_JUDGE_KEYS = new Set(['identity', 'digest']);

function closedObject(value: unknown, allowed: Set<string>): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as object).every((key) => allowed.has(key));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const cloned = structuredClone(value);
  const walk = (next: unknown): unknown => {
    if (!next || typeof next !== 'object') return next;
    if (Array.isArray(next)) {
      for (const child of next) walk(child);
      return Object.freeze(next);
    }
    for (const child of Object.values(next as Record<string, unknown>)) walk(child);
    return Object.freeze(next);
  };
  return walk(cloned) as T;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

export function canonicalArgumentDigestOf(args: Record<string, unknown>): string {
  return sha256(JSON.stringify({
    domain: 'provider-args',
    version: 1,
    args,
  }));
}

export function logicalArgumentDigestOf(input: {
  acceptedTaskId: string;
  toolName: string;
  argumentDigest: string;
}): string {
  return sha256(JSON.stringify({
    domain: 'logical-contract',
    version: 1,
    acceptedTaskId: input.acceptedTaskId,
    toolName: input.toolName,
    argumentDigest: input.argumentDigest,
  }));
}

/** Per-activation fencing token. Not a formatted session/crossing string. */
export function mintOwnerFence(): string {
  return `fence:${randomUUID()}`;
}

export function callAuthorityDigestOf(authority: Omit<ResolvedCallAuthorityV1, 'authorityDigest'>): string {
  return sha256(JSON.stringify({
    version: authority.version,
    acceptedSource: authority.acceptedSource,
    acceptedTaskId: authority.acceptedTaskId,
    claimEventId: authority.claimEventId,
    semanticProvenanceDigest: authority.semanticProvenanceDigest,
    goalRevision: authority.goalRevision,
    graphId: authority.graphId,
    graphHash: authority.graphHash,
    nodeId: authority.nodeId,
    operationId: authority.operationId,
    capabilityRef: authority.capabilityRef,
    manifestId: authority.manifestId,
    manifestDigest: authority.manifestDigest,
    providerKind: authority.providerKind,
    providerIdentity: authority.providerIdentity,
    operationVersion: authority.operationVersion,
    liveProviderVersion: authority.liveProviderVersion,
    canonicalArgumentDigest: authority.canonicalArgumentDigest,
    logicalArgumentDigest: authority.logicalArgumentDigest,
    logicalCallId: authority.logicalCallId,
    accountId: authority.accountId,
    destination: authority.destination ?? null,
    resolvedEffect: authority.resolvedEffect,
    argumentCompiler: authority.argumentCompiler,
    invokePortId: authority.invokePortId,
    reconcilePortId: authority.reconcilePortId ?? null,
    physicalDispatchId: authority.physicalDispatchId,
    ordinal: authority.ordinal,
    relation: authority.relation,
    retryOf: authority.retryOf ?? null,
    predecessorAuthorityDigest: authority.predecessorAuthorityDigest ?? null,
    retryReason: authority.retryReason ?? null,
    ownerFence: authority.ownerFence,
    observationId: authority.observationId,
    observationDigest: authority.observationDigest,
    observationObservedAt: authority.observationObservedAt,
    observationOrigin: authority.observationOrigin,
    observerImplementationId: authority.observerImplementationId ?? null,
    invokeImplementationDigest: authority.invokeImplementationDigest,
    reconcileImplementationDigest: authority.reconcileImplementationDigest ?? null,
    transportImplementationDigest: authority.transportImplementationDigest,
    reconciliationPolicy: authority.reconciliationPolicy,
    idempotency: authority.idempotency,
    evidenceContract: authority.evidenceContract,
    policySnapshotDigest: authority.policySnapshotDigest,
    catalogSnapshotDigest: authority.catalogSnapshotDigest,
    liveFingerprint: authority.liveFingerprint,
    writeJudge: authority.writeJudge ?? null,
    groundingIdentity: authority.groundingIdentity ?? null,
    groundingReceiptDigest: authority.groundingReceiptDigest ?? null,
    proposalDigest: authority.proposalDigest ?? null,
  }));
}

export function mintResolvedCallAuthority(
  input: MintResolvedCallAuthorityInput,
): { ok: true; authority: ResolvedCallAuthorityV1 } | { ok: false; reason: CallAuthorityRefusal } {
  if (!input.canonicalArgs || typeof input.canonicalArgs !== 'object' || Array.isArray(input.canonicalArgs)) {
    return { ok: false, reason: 'missing_canonical_args' };
  }
  if (
    !nonBlank(input.acceptedSource.sessionId)
    || !Number.isSafeInteger(input.acceptedSource.sourceUserSeq)
    || input.acceptedSource.sourceUserSeq <= 0
    || !nonBlank(input.acceptedTaskId)
    || !nonBlank(input.graphId)
    || !nonBlank(input.nodeId)
    || !nonBlank(input.operationId)
    || !nonBlank(input.claimEventId)
    || !nonBlank(input.semanticProvenanceDigest)
    || !nonBlank(input.graphHash)
    || !nonBlank(input.capabilityRef)
    || !nonBlank(input.logicalCallId)
    || !nonBlank(input.physicalDispatchId)
    || !nonBlank(input.ownerFence)
    || !Number.isSafeInteger(input.ordinal)
    || input.ordinal <= 0
    || !nonBlank(input.relation)
    || !Number.isSafeInteger(input.goalRevision)
    || input.goalRevision < 0
    || !/^[a-f0-9]{64}$/i.test(input.semanticProvenanceDigest)
    || !/^[a-f0-9]{64}$/i.test(input.graphHash)
  ) {
    return { ok: false, reason: 'incomplete_identity' };
  }
  if (!input.observation || input.observation.origin !== 'independent') {
    return { ok: false, reason: 'observation_not_independent' };
  }
  if (!observationIsFresh(input.observation)) {
    return { ok: false, reason: 'observation_stale' };
  }
  if (!nonBlank(input.catalogSnapshotDigest) || !nonBlank(input.policySnapshotDigest)) {
    return { ok: false, reason: 'missing_catalog_snapshot' };
  }
  if (
    !nonBlank(input.groundingIdentity)
    || !nonBlank(input.groundingReceiptDigest)
    || !nonBlank(input.proposalDigest)
  ) {
    return { ok: false, reason: 'missing_grounding' };
  }
  if (
    input.groundingIdentity !== input.groundingIdentity.trim()
    || input.groundingReceiptDigest !== input.groundingReceiptDigest.trim()
    || input.proposalDigest !== input.proposalDigest.trim()
    || !/^[a-f0-9]{64}$/i.test(input.groundingReceiptDigest)
    || !/^[a-f0-9]{64}$/i.test(input.proposalDigest)
  ) {
    return { ok: false, reason: 'grounding_mismatch' };
  }
  if (!input.manifest) return { ok: false, reason: 'unknown_manifest' };
  if (input.manifest.lifecycle.state === 'revoked') return { ok: false, reason: 'revoked_manifest' };
  if (input.manifest.lifecycle.state === 'superseded') return { ok: false, reason: 'superseded_manifest' };
  const current = currentCapabilityManifest(input.manifest);
  if (!current) return { ok: false, reason: 'unknown_manifest' };
  if (current.operationId !== input.operationId) return { ok: false, reason: 'unknown_manifest' };
  if (isPlaceholderBetaAccount(current.accountId) || isPlaceholderBetaAccount(input.liveAccountId)) {
    return { ok: false, reason: 'placeholder_account' };
  }
  if (current.accountId !== input.liveAccountId) return { ok: false, reason: 'account_mismatch' };
  if (current.definitionFingerprint !== input.liveFingerprint) {
    return { ok: false, reason: 'stale_fingerprint' };
  }
  if (current.providerVersion !== input.liveProviderVersion) {
    if (current.providerKind === 'reviewed_cli') return { ok: false, reason: 'binary_drift' };
    if (current.providerKind === 'native_mcp') return { ok: false, reason: 'server_drift' };
    return { ok: false, reason: 'schema_drift' };
  }
  if (current.effect !== input.nodeEffect) {
    return { ok: false, reason: 'effect_mismatch' };
  }
  if (!nonBlank(current.argumentCompiler?.id) || !nonBlank(current.argumentCompiler?.version)) {
    return { ok: false, reason: 'compiler_mismatch' };
  }
  if (
    input.observation.operationId !== current.operationId
    || input.observation.accountId !== current.accountId
    || input.observation.definitionFingerprint !== input.liveFingerprint
    || input.observation.providerVersion !== input.liveProviderVersion
    || input.observation.operationVersion !== current.operationVersion
  ) {
    return { ok: false, reason: 'observation_mismatch' };
  }
  if (!nonBlank(current.invokePortId)) {
    return { ok: false, reason: 'invoke_port_mismatch' };
  }
  if (WRITE_EFFECTS.has(current.effect)) {
    const reconcilePortId = current.reconcilePortId ?? `reconcile:${current.invokePortId}`;
    if (!nonBlank(reconcilePortId) || reconcilePortId === current.invokePortId) {
      return { ok: false, reason: 'reconcile_port_mismatch' };
    }
  }
  if (!bindingEffectFitsCeiling({
    bindingEffect: current.effect,
    nodeEffect: input.nodeEffect,
    graphCeiling: input.graphCeiling,
  })) {
    return { ok: false, reason: 'effect_exceeds_ceiling' };
  }
  const destination = current.destination;
  const writeEffect = WRITE_EFFECTS.has(current.effect);
  const graphBinding = input.graphDestination?.binding;
  if (writeEffect && graphBinding) {
    if (
      current.manifestId !== graphBinding.manifestId
      || capabilityManifestDigest(current) !== graphBinding.manifestDigest
      || current.accountId !== graphBinding.accountId
      || current.operationId !== graphBinding.operationId
      || current.operationVersion !== graphBinding.schemaVersion
      || current.definitionFingerprint !== graphBinding.definitionFingerprint
      || current.effect !== graphBinding.effect
      || (destination?.posture ?? '') !== graphBinding.posture
    ) {
      return { ok: false, reason: 'destination_mismatch' };
    }
  } else if (writeEffect && input.graphDestination) {
    if (!destination || destination.posture !== input.graphDestination.posture) {
      return { ok: false, reason: 'destination_mismatch' };
    }
  }
  if (writeEffect) {
    if (!input.writeJudge?.identity || !input.writeJudge.digest) {
      return { ok: false, reason: 'write_judge_required' };
    }
    if (input.writeJudge.identity !== input.writeJudge.identity.trim()
      || input.writeJudge.digest !== input.writeJudge.digest.trim()
      || !SHA256_RE.test(input.writeJudge.digest)) {
      return { ok: false, reason: 'write_judge_mismatch' };
    }
    // No mixed provenance: a host-compiled plan mints BOTH its grounding and
    // its write authority; a model plan mints NEITHER under the host
    // namespace. One-of-two is a forgery shape.
    if (isHostAuthorityIdentity(input.writeJudge.identity) !== isHostAuthorityIdentity(input.groundingIdentity)) {
      return { ok: false, reason: 'write_judge_mismatch' };
    }
  }
  const canonicalArgs = freezeDeep({ ...input.canonicalArgs });
  const computedArgumentDigest = canonicalArgumentDigestOf(canonicalArgs);
  if (nonBlank(input.canonicalArgumentDigest) && input.canonicalArgumentDigest !== computedArgumentDigest) {
    return { ok: false, reason: 'argument_digest_mismatch' };
  }
  const logicalArgs = freezeDeep({ ...(input.logicalArgs ?? canonicalArgs) });
  const durableContract = durableLogicalCallContract(
    input.acceptedTaskId,
    current.operationId,
    logicalArgs,
  );
  if (!durableContract && current.effect !== 'host_only') {
    return { ok: false, reason: 'missing_canonical_args' };
  }
  const logicalArgumentDigest = durableContract
    ? durableContract.argumentDigest
    : logicalArgumentDigestOf({
      acceptedTaskId: input.acceptedTaskId,
      toolName: current.operationId,
      argumentDigest: computedArgumentDigest,
    });
  if (input.relation === 'primary' && (input.retryOf || input.predecessorAuthorityDigest || input.retryReason)) {
    return { ok: false, reason: 'crossing_identity_mismatch' };
  }
  if (input.relation === 'retry') {
    if (
      !nonBlank(input.retryOf)
      || !nonBlank(input.predecessorAuthorityDigest)
      || !nonBlank(input.retryReason)
      || !new Set(['uncertain_recovery', 'owner_lost', 'explicit_retry']).has(input.retryReason)
    ) {
      return { ok: false, reason: 'crossing_identity_mismatch' };
    }
  }
  if (
    WRITE_EFFECTS.has(current.effect)
    && (
      current.idempotency.required !== true
      || (current.idempotency.policy !== 'key_before_dispatch' && current.idempotency.policy !== 'reconcile_only')
      || !current.reconciliation
      || (current.reconciliation.policy !== 'exact_artifact' && current.reconciliation.policy !== 'uncertain_if_absent')
    )
  ) {
    return { ok: false, reason: 'crossing_identity_mismatch' };
  }
  let invokeDigest: string;
  let reconcileDigest: string | undefined;
  let observerImplementationId: string;
  let transportDigest: string;
  try {
    invokeDigest = shippedImplementationDigest('invoke');
    reconcileDigest = WRITE_EFFECTS.has(current.effect) ? shippedImplementationDigest('reconcile') : undefined;
    observerImplementationId = shippedObserverImplementationId();
    transportDigest = shippedTransportDigest();
  } catch {
    return { ok: false, reason: 'incomplete_identity' };
  }
  const sealed: Omit<ResolvedCallAuthorityV1, 'authorityDigest'> = {
    version: RESOLVED_CALL_AUTHORITY_VERSION,
    acceptedSource: {
      sessionId: input.acceptedSource.sessionId,
      sourceUserSeq: input.acceptedSource.sourceUserSeq,
    },
    acceptedTaskId: input.acceptedTaskId,
    claimEventId: input.claimEventId.trim(),
    semanticProvenanceDigest: input.semanticProvenanceDigest.trim(),
    goalRevision: input.goalRevision,
    graphId: input.graphId,
    graphHash: input.graphHash.trim(),
    nodeId: input.nodeId,
    operationId: input.operationId,
    capabilityRef: input.capabilityRef.trim(),
    manifestId: current.manifestId,
    manifestDigest: capabilityManifestDigest(current),
    providerKind: current.providerKind,
    providerIdentity: current.providerIdentity,
    operationVersion: current.operationVersion,
    liveProviderVersion: input.liveProviderVersion,
    canonicalArgumentDigest: computedArgumentDigest,
    logicalArgumentDigest,
    canonicalArgs,
    logicalCallId: input.logicalCallId.trim(),
    accountId: current.accountId,
    ...(destination ? { destination } : {}),
    resolvedEffect: current.effect,
    argumentCompiler: {
      id: current.argumentCompiler.id,
      version: current.argumentCompiler.version,
    },
    invokePortId: current.invokePortId,
    ...(WRITE_EFFECTS.has(current.effect)
      ? { reconcilePortId: current.reconcilePortId ?? `reconcile:${current.invokePortId}` }
      : {}),
    physicalDispatchId: input.physicalDispatchId.trim(),
    ordinal: input.ordinal,
    relation: input.relation,
    ...(input.retryOf ? { retryOf: input.retryOf.trim() } : {}),
    ...(input.predecessorAuthorityDigest ? { predecessorAuthorityDigest: input.predecessorAuthorityDigest } : {}),
    ...(input.retryReason ? { retryReason: input.retryReason } : {}),
    ownerFence: input.ownerFence.trim(),
    observationId: input.observation.observationId ?? `obs:${input.observation.operationId}:${input.observation.observedAt}`,
    observationDigest: observationDigestOf(input.observation),
    observationObservedAt: input.observation.observedAt,
    observationOrigin: 'independent',
    observerImplementationId: observerImplementationId,
    invokeImplementationDigest: invokeDigest,
    transportImplementationDigest: transportDigest,
    ...(WRITE_EFFECTS.has(current.effect)
      ? { reconcileImplementationDigest: reconcileDigest }
      : {}),
    reconciliationPolicy: current.reconciliation.policy,
    idempotency: {
      required: current.idempotency.required,
      policy: current.idempotency.policy,
    },
    evidenceContract: {
      kinds: [...current.evidenceContract.kinds],
      readbackRequired: current.evidenceContract.readbackRequired,
    },
    policySnapshotDigest: input.policySnapshotDigest,
    catalogSnapshotDigest: input.catalogSnapshotDigest,
    liveFingerprint: input.liveFingerprint,
    ...(input.writeJudge && WRITE_EFFECTS.has(current.effect)
      ? { writeJudge: { identity: input.writeJudge.identity, digest: input.writeJudge.digest } }
      : {}),
    groundingIdentity: input.groundingIdentity,
    groundingReceiptDigest: input.groundingReceiptDigest,
    proposalDigest: input.proposalDigest,
  };
  return { ok: true, authority: freezeDeep({ ...sealed, authorityDigest: callAuthorityDigestOf(sealed) }) };
}

export function serializeResolvedCallAuthority(authority: ResolvedCallAuthorityV1): string {
  return JSON.stringify(sealResolvedCallAuthority(authority));
}

export function sealResolvedCallAuthority(authority: ResolvedCallAuthorityV1): Record<string, unknown> {
  const { canonicalArgs: _canonicalArgs, ...rest } = authority;
  return { ...rest, argsRedacted: true };
}

const AUTHORITY_ENVELOPE_KEYS = new Set([
  'version', 'acceptedSource', 'acceptedTaskId', 'claimEventId', 'semanticProvenanceDigest',
  'goalRevision', 'graphId', 'graphHash', 'nodeId', 'operationId', 'capabilityRef',
  'manifestId', 'manifestDigest', 'providerKind', 'providerIdentity', 'operationVersion', 'liveProviderVersion',
  'canonicalArgumentDigest', 'logicalArgumentDigest', 'logicalCallId', 'accountId', 'destination',
  'resolvedEffect', 'argumentCompiler', 'invokePortId', 'reconcilePortId', 'physicalDispatchId',
  'ordinal', 'relation', 'retryOf', 'predecessorAuthorityDigest', 'retryReason', 'ownerFence',
  'observationId', 'observationDigest', 'observationObservedAt', 'observationOrigin',
  'observerImplementationId', 'invokeImplementationDigest', 'reconcileImplementationDigest',
  'transportImplementationDigest',
  'reconciliationPolicy', 'idempotency', 'evidenceContract', 'policySnapshotDigest',
  'catalogSnapshotDigest', 'liveFingerprint', 'writeJudge', 'groundingIdentity',
  'groundingReceiptDigest', 'proposalDigest', 'authorityDigest', 'argsRedacted',
]);

export const ENVELOPE_MAX_DEPTH = 32;
export const ENVELOPE_MAX_NODES = 4_096;
export const ENVELOPE_MAX_BYTES = SEALED_CALL_AUTHORITY_MAX_BYTES;

export function inspectEnvelopeCanonicalArgs(value: unknown): { ok: true } | { ok: false; reason: 'malformed' | 'oversized' } {
  try {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > ENVELOPE_MAX_BYTES) {
        return { ok: false, reason: 'oversized' };
      }
    } else {
      const serialized = JSON.stringify(value);
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > ENVELOPE_MAX_BYTES) {
        return { ok: false, reason: 'oversized' };
      }
    }
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const next = current.value;
    if (next === null || typeof next !== 'object') continue;
    if (seen.has(next)) continue;
    seen.add(next);
    nodes += 1;
    if (current.depth > ENVELOPE_MAX_DEPTH || nodes > ENVELOPE_MAX_NODES) {
      return { ok: false, reason: 'oversized' };
    }
    if (Object.prototype.hasOwnProperty.call(next, 'canonicalArgs')) {
      return { ok: false, reason: 'malformed' };
    }
    const children = Array.isArray(next) ? next : Object.values(next);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return { ok: true };
}

export function parseResolvedCallAuthority(
  raw: string,
): { ok: true; authority: ResolvedCallAuthorityV1 } | { ok: false; reason: 'malformed' | 'digest_mismatch' | 'oversized' } {
  try {
    return parseResolvedCallAuthorityInner(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function parseResolvedCallAuthorityInner(
  raw: string,
): { ok: true; authority: ResolvedCallAuthorityV1 } | { ok: false; reason: 'malformed' | 'digest_mismatch' | 'oversized' } {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > SEALED_CALL_AUTHORITY_MAX_BYTES) {
    return { ok: false, reason: 'oversized' };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!parsed || parsed.version !== RESOLVED_CALL_AUTHORITY_VERSION || !nonBlank(parsed.authorityDigest)) {
    return { ok: false, reason: 'malformed' };
  }
  if (Object.keys(parsed).some((key) => !AUTHORITY_ENVELOPE_KEYS.has(key))) {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.argsRedacted !== true) {
    return { ok: false, reason: 'malformed' };
  }
  let forbidden: ReturnType<typeof inspectEnvelopeCanonicalArgs>;
  try {
    forbidden = inspectEnvelopeCanonicalArgs(parsed);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!forbidden.ok) return { ok: false, reason: forbidden.reason };
  const envelope = parsed as Partial<ResolvedCallAuthorityV1> & { argsRedacted?: boolean };
  if (!authorityEnvelopeIsComplete(envelope)) {
    return { ok: false, reason: 'malformed' };
  }
  const recomputed = callAuthorityDigestOf(envelope as Omit<ResolvedCallAuthorityV1, 'authorityDigest'> & { authorityDigest?: string });
  if (recomputed !== envelope.authorityDigest) return { ok: false, reason: 'digest_mismatch' };
  return {
    ok: true,
    authority: freezeDeep({
      ...envelope,
      canonicalArgs: {},
    } as ResolvedCallAuthorityV1),
  };
}

function writeJudgeIsClosed(value: unknown): value is { identity: string; digest: string } {
  return closedObject(value, WRITE_JUDGE_KEYS)
    && nonBlank((value as { identity?: unknown }).identity)
    && SHA256_RE.test(String((value as { digest?: unknown }).digest));
}

function authorityEnvelopeIsComplete(parsed: Partial<ResolvedCallAuthorityV1> & { argsRedacted?: boolean }): boolean {
  const digestFields = [
    parsed.semanticProvenanceDigest,
    parsed.graphHash,
    parsed.manifestDigest,
    parsed.canonicalArgumentDigest,
    parsed.logicalArgumentDigest,
    parsed.observationDigest,
    parsed.policySnapshotDigest,
    parsed.catalogSnapshotDigest,
    parsed.liveFingerprint,
    parsed.groundingReceiptDigest,
    parsed.proposalDigest,
    parsed.authorityDigest,
    parsed.invokeImplementationDigest,
    parsed.transportImplementationDigest,
  ];
  const writeEffect = WRITE_EFFECTS.has(String(parsed.resolvedEffect));
  const writeJudgePresent = parsed.writeJudge != null;
  return Boolean(
    closedObject(parsed.acceptedSource, ACCEPTED_SOURCE_KEYS)
    && nonBlank(parsed.acceptedSource.sessionId)
    && Number.isSafeInteger(parsed.acceptedSource.sourceUserSeq)
    && parsed.acceptedSource.sourceUserSeq > 0
    && nonBlank(parsed.acceptedTaskId)
    && nonBlank(parsed.claimEventId)
    && Number.isSafeInteger(parsed.goalRevision)
    && nonBlank(parsed.graphId)
    && nonBlank(parsed.nodeId)
    && nonBlank(parsed.operationId)
    && nonBlank(parsed.capabilityRef)
    && nonBlank(parsed.manifestId)
    && nonBlank(parsed.providerKind)
    && nonBlank(parsed.providerIdentity)
    && nonBlank(parsed.operationVersion)
    && nonBlank(parsed.liveProviderVersion)
    && nonBlank(parsed.logicalCallId)
    && nonBlank(parsed.accountId)
    && nonBlank(parsed.resolvedEffect)
    && closedObject(parsed.argumentCompiler, COMPILER_KEYS)
    && nonBlank(parsed.argumentCompiler.id)
    && nonBlank(parsed.argumentCompiler.version)
    && nonBlank(parsed.invokePortId)
    && nonBlank(parsed.physicalDispatchId)
    && Number.isSafeInteger(parsed.ordinal)
    && (parsed.ordinal ?? 0) > 0
    && nonBlank(parsed.relation)
    && nonBlank(parsed.ownerFence)
    && nonBlank(parsed.observationId)
    && Number.isFinite(parsed.observationObservedAt)
    && (parsed.observationObservedAt ?? 0) > 0
    && nonBlank(parsed.observationOrigin)
    && closedObject(parsed.idempotency, IDEMPOTENCY_KEYS)
    && closedObject(parsed.evidenceContract, EVIDENCE_KEYS)
    && nonBlank(parsed.groundingIdentity)
    && nonBlank(parsed.invokeImplementationDigest)
    && nonBlank(parsed.reconciliationPolicy)
    && digestFields.every((value) => typeof value === 'string' && SHA256_RE.test(value))
    && (!parsed.predecessorAuthorityDigest || SHA256_RE.test(parsed.predecessorAuthorityDigest))
    && (!parsed.observerImplementationId || SHA256_RE.test(parsed.observerImplementationId))
    && (!parsed.reconcileImplementationDigest || SHA256_RE.test(parsed.reconcileImplementationDigest))
    && (!parsed.destination || (
      closedObject(parsed.destination, DESTINATION_KEYS)
      && nonBlank(parsed.destination.family)
      && (parsed.destination.posture === 'create_new' || parsed.destination.posture === 'named_existing')
    ))
    && new Set(['primary', 'retry', 'poll', 'probe', 'child']).has(String(parsed.relation))
    && new Set(['local_registry', 'composio', 'native_mcp', 'reviewed_cli']).has(String(parsed.providerKind))
    && new Set(['read', 'compute', 'local_write', 'external_write', 'admin', 'host_only', 'none']).has(String(parsed.resolvedEffect))
    && new Set(['independent', 'pack_attested']).has(String(parsed.observationOrigin))
    && new Set(['none', 'key_before_dispatch', 'reconcile_only']).has(String(parsed.idempotency.policy))
    && new Set(['none', 'exact_artifact', 'uncertain_if_absent']).has(String(parsed.reconciliationPolicy))
    && typeof parsed.idempotency.required === 'boolean'
    && Array.isArray(parsed.evidenceContract.kinds)
    && parsed.evidenceContract.kinds.every((kind) => CLOSED_EVIDENCE_KINDS.has(String(kind)))
    && typeof parsed.evidenceContract.readbackRequired === 'boolean'
    && (parsed.retryReason === undefined || new Set(['uncertain_recovery', 'owner_lost', 'explicit_retry']).has(parsed.retryReason))
    && (
      parsed.relation === 'retry'
      || (parsed.retryOf === undefined && parsed.predecessorAuthorityDigest === undefined && parsed.retryReason === undefined)
    )
    && (
      parsed.relation !== 'retry'
      || (
        nonBlank(parsed.retryOf)
        && nonBlank(parsed.predecessorAuthorityDigest)
        && SHA256_RE.test(parsed.predecessorAuthorityDigest)
        && nonBlank(parsed.retryReason)
        && Number.isSafeInteger(parsed.ordinal)
        && (parsed.ordinal ?? 0) > 1
      )
    )
    && (
      writeEffect
        ? writeJudgeIsClosed(parsed.writeJudge) && nonBlank(parsed.reconcileImplementationDigest)
        : !writeJudgePresent
    ),
  );
}

export function deriveRetryCallAuthority(input: {
  predecessor: ResolvedCallAuthorityV1;
  physicalDispatchId: string;
  ownerFence: string;
  reason: RetryAuthorityReason;
  predecessorCrossingState?: 'started' | 'returned' | 'threw';
}): { ok: true; authority: ResolvedCallAuthorityV1 } | { ok: false; reason: CallAuthorityRefusal } {
  const derivedPhysicalId = derivePhysicalDispatchId({
    sessionId: input.predecessor.acceptedSource.sessionId,
    sourceUserSeq: input.predecessor.acceptedSource.sourceUserSeq,
    graphId: input.predecessor.graphId,
    nodeId: input.predecessor.nodeId,
    logicalCallId: input.predecessor.logicalCallId,
    ordinal: input.predecessor.ordinal + 1,
    relation: 'retry',
  });
  if (
    !nonBlank(input.physicalDispatchId)
    || input.physicalDispatchId === input.predecessor.physicalDispatchId
    || !nonBlank(input.ownerFence)
    || input.physicalDispatchId !== derivedPhysicalId
  ) {
    return { ok: false, reason: 'crossing_identity_mismatch' };
  }
  if (input.predecessorCrossingState === 'returned' || input.predecessorCrossingState === 'threw') {
    return { ok: false, reason: 'crossing_identity_mismatch' };
  }
  if (
    WRITE_EFFECTS.has(input.predecessor.resolvedEffect)
    && input.predecessorCrossingState === 'started'
  ) {
    return { ok: false, reason: 'crossing_identity_mismatch' };
  }
  if (
    input.predecessor.relation === 'retry'
    && (!input.predecessor.retryOf || !input.predecessor.predecessorAuthorityDigest)
  ) {
    return { ok: false, reason: 'crossing_identity_mismatch' };
  }
  if (
    WRITE_EFFECTS.has(input.predecessor.resolvedEffect)
    && (
      input.predecessor.idempotency.required !== true
      || input.predecessor.idempotency.policy !== 'key_before_dispatch'
    )
  ) {
    return { ok: false, reason: 'crossing_identity_mismatch' };
  }
  const sealed: Omit<ResolvedCallAuthorityV1, 'authorityDigest'> = {
    ...input.predecessor,
    physicalDispatchId: input.physicalDispatchId.trim(),
    ordinal: input.predecessor.ordinal + 1,
    relation: 'retry',
    retryOf: input.predecessor.physicalDispatchId,
    predecessorAuthorityDigest: input.predecessor.authorityDigest,
    retryReason: input.reason,
    ownerFence: input.ownerFence.trim(),
  };
  const { authorityDigest: _ignored, ...rest } = sealed as ResolvedCallAuthorityV1;
  return { ok: true, authority: freezeDeep({ ...rest, authorityDigest: callAuthorityDigestOf(rest) }) };
}
