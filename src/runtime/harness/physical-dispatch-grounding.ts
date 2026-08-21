/**
 * Claim-linked grounding required immediately before physical-dispatch
 * reservation. Missing, malformed, stale, or mismatched grounding refuses
 * with zero reservation and zero provider invocation.
 */
import { capabilityManifestDigest } from './capability-manifest.js';
import type { BoundNodeCapability } from './graph-node-capability.js';
import { readClaimLinkedSemanticInterpretation } from '../semantic-boundary/interpret-accepted-source.js';
import {
  groundingReceiptDigest,
  type GroundingReceiptV1,
} from '../semantic-boundary/plan-grounding.js';
import { isHostAuthorityIdentity } from '../semantic-boundary/host-authority.js';

export type PhysicalDispatchGrounding = {
  identity: string;
  receiptDigest: string;
  proposalDigest: string;
  catalogDigest: string;
};

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function hexDigest(value: unknown): value is string {
  return nonBlank(value) && /^[a-f0-9]{64}$/i.test(value);
}

export function validatePhysicalDispatchGrounding(input: {
  record: {
    validationOutcome?: string;
    groundingIdentity?: string;
    groundingReceiptDigest?: string;
    groundingProposalDigest?: string;
    groundingCatalogDigest?: string;
    groundingShownDigest?: string;
    groundingOverallVerdict?: GroundingReceiptV1['overallVerdict'];
    groundingVerdicts?: GroundingReceiptV1['operations'];
    groundingInputTokens?: number;
    groundingOutputTokens?: number;
    groundingLatencyMs?: number;
  } | null | undefined;
  nodeId: string;
  binding: BoundNodeCapability;
  /** Durable claim identity — required for host-authority recompute. */
  identity?: { sessionId: string; sourceUserSeq: number };
}): PhysicalDispatchGrounding {
  const record = input.record;
  if (!record || record.validationOutcome !== 'admitted') {
    throw new Error('call_authority_refused:grounding_receipt_missing');
  }
  if (
    !nonBlank(record.groundingIdentity)
    || !hexDigest(record.groundingReceiptDigest)
    || !hexDigest(record.groundingProposalDigest)
    || !hexDigest(record.groundingCatalogDigest)
    || !hexDigest(record.groundingShownDigest)
    || !record.groundingOverallVerdict
    || !Array.isArray(record.groundingVerdicts)
    || record.groundingVerdicts.length === 0
  ) {
    throw new Error('call_authority_refused:grounding_receipt_missing');
  }
  if (isHostAuthorityIdentity(record.groundingIdentity)) {
    // Host deterministic-bind authority is accepted ONLY when the plan
    // re-proves itself: a from-scratch recompute over durable inputs the
    // model cannot write must reproduce the persisted digests. Until the
    // compile lane installs that verifier, every host-namespace record is
    // unproven and refuses closed.
    const verified = verifyHostCompiledGrounding({ record: record as HostCompiledGroundingRecord, identity: input.identity });
    if (!verified.ok) {
      throw new Error(`call_authority_refused:${verified.reason}`);
    }
  }
  const persisted: GroundingReceiptV1 = {
    modelIdentity: record.groundingIdentity,
    catalogSnapshotDigest: record.groundingCatalogDigest,
    shownDescriptorDigest: record.groundingShownDigest,
    proposalDigest: record.groundingProposalDigest,
    overallVerdict: record.groundingOverallVerdict,
    operations: record.groundingVerdicts,
    inputTokens: record.groundingInputTokens ?? 0,
    outputTokens: record.groundingOutputTokens ?? 0,
    latencyMs: record.groundingLatencyMs ?? 0,
    digest: record.groundingReceiptDigest,
  };
  if (groundingReceiptDigest(persisted) !== persisted.digest) {
    throw new Error('call_authority_refused:grounding_receipt_digest_mismatch');
  }
  if (persisted.overallVerdict !== 'entailed') {
    throw new Error('call_authority_refused:grounding_not_entailed');
  }
  const verdict = persisted.operations.find((entry) => entry.operationId === input.nodeId);
  if (!verdict || verdict.verdict !== 'entailed') {
    throw new Error('call_authority_refused:grounding_receipt_missing');
  }
  if (verdict.capabilityRef !== input.binding.capabilityId) {
    throw new Error('call_authority_refused:grounding_capability_mismatch');
  }
  if (!nonBlank(input.binding.manifestDigest) || verdict.manifestDigest !== input.binding.manifestDigest) {
    throw new Error('call_authority_refused:grounding_manifest_mismatch');
  }
  const manifest = input.binding.manifest;
  if (!manifest) {
    throw new Error('call_authority_refused:unknown_manifest');
  }
  if (capabilityManifestDigest(manifest) !== input.binding.manifestDigest) {
    throw new Error('call_authority_refused:stale_fingerprint');
  }
  if (manifest.operationId !== input.binding.toolName) {
    throw new Error('call_authority_refused:operation_mismatch');
  }
  const account = input.binding.account ?? '';
  if (!nonBlank(account) || account !== manifest.accountId) {
    throw new Error('call_authority_refused:account_mismatch');
  }
  const liveFingerprint = input.binding.liveFingerprint ?? input.binding.schemaDigest;
  if (manifest.definitionFingerprint !== liveFingerprint) {
    throw new Error('call_authority_refused:schema_drift');
  }
  if (manifest.effect !== input.binding.effect) {
    throw new Error('call_authority_refused:effect_mismatch');
  }
  return {
    identity: persisted.modelIdentity,
    receiptDigest: persisted.digest,
    proposalDigest: persisted.proposalDigest,
    catalogDigest: persisted.catalogSnapshotDigest,
  };
}

export function requirePhysicalDispatchGrounding(input: {
  sessionId: string;
  sourceUserSeq: number;
  nodeId: string;
  binding: BoundNodeCapability;
}): PhysicalDispatchGrounding {
  const linked = readClaimLinkedSemanticInterpretation(input.sessionId, input.sourceUserSeq);
  return validatePhysicalDispatchGrounding({
    record: linked?.record,
    nodeId: input.nodeId,
    binding: input.binding,
    identity: { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq },
  });
}

export type HostCompiledGroundingRecord = {
  groundingIdentity?: string;
  groundingProposalDigest?: string;
  groundingCatalogDigest?: string;
  hostCompileDigest?: string;
  hostCompilerVersion?: string;
  inputHash?: string;
  audienceHash?: string;
  policyRevision?: string;
};

export type HostCompiledGroundingVerifier = (input: {
  record: HostCompiledGroundingRecord;
  identity?: { sessionId: string; sourceUserSeq: number };
}) => { ok: true } | { ok: false; reason: string };

let hostCompiledGroundingVerifier: HostCompiledGroundingVerifier | null = null;

/** Installed by the host deterministic-compile module at configure time. The
 *  verifier RECOMPUTES the compile from durable inputs; installation is the
 *  only path to acceptance — absent a verifier, host-namespace authority is
 *  structurally unproven and refuses closed. */
export function installHostCompiledGroundingVerifier(verifier: HostCompiledGroundingVerifier | null): void {
  hostCompiledGroundingVerifier = verifier;
}

function verifyHostCompiledGrounding(input: {
  record: HostCompiledGroundingRecord;
  identity?: { sessionId: string; sourceUserSeq: number };
}): { ok: true } | { ok: false; reason: string } {
  if (!hostCompiledGroundingVerifier) return { ok: false, reason: 'host_authority_unproven' };
  try {
    return hostCompiledGroundingVerifier(input);
  } catch {
    return { ok: false, reason: 'host_authority_unproven' };
  }
}
