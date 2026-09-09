/**
 * Cycle-free canonical identity for one sealed graph-node capability binding.
 *
 * The catalog factory mints this digest and terminal publication independently
 * re-derives it inside the SQLite transaction. Keeping the closed projection
 * here prevents either side from silently omitting a newly sealed authority
 * field while avoiding the eventlog <-> catalog-factory import cycle.
 */
import { createHash } from 'node:crypto';
import type { CapabilityManifestOperationSemanticsV1 } from './capability-manifest.js';
import type { MutationVerificationRecipeV1 } from './mutation-verification-contract.js';
import type { AsyncReadContinuationRecipeV1 } from './async-read-continuation-contract.js';
import type { RuntimeToolEffect } from './tool-effect.js';
import type { ProviderAcknowledgementModeV1 } from './provider-acknowledgement-contract.js';

export interface SealedNodeBindingDigestInput {
  nodeId: string;
  capabilityId: string;
  /** Exact provider operation identity as observed in the trusted manifest. */
  providerOperationId: string;
  /** Canonical logical-call identity used by admission/settlement ledgers. */
  logicalToolName: string;
  /** @deprecated Raw provider operation identity; retained for row compatibility. */
  toolName: string;
  schemaVersion: string;
  /** Exact provider input-schema digest, distinct from schemaDigest once the
   * latter closes the full input+output+version/account definition. */
  providerInputSchemaDigest?: string;
  schemaDigest: string;
  argumentDigest: string;
  account?: string;
  effect: RuntimeToolEffect | 'none';
  destination?: { family: string; posture: string };
  /** Digested provider-neutral positive semantics copied from the exact
   * manifest. Absent legacy bindings never acquire them by replay. */
  operationSemantics?: CapabilityManifestOperationSemanticsV1;
  /** Host-derived verification work; never a semantic graph node. */
  verification?: MutationVerificationRecipeV1;
  /** Host-owned async read successor; never inferred after graph admission. */
  asyncRead?: AsyncReadContinuationRecipeV1;
  writeEvidenceMode?: ProviderAcknowledgementModeV1;
}

export function sealedNodeBindingDigestOf(binding: SealedNodeBindingDigestInput): string {
  return createHash('sha256').update(JSON.stringify({
    nodeId: binding.nodeId,
    capabilityId: binding.capabilityId,
    providerOperationId: binding.providerOperationId,
    logicalToolName: binding.logicalToolName,
    toolName: binding.toolName,
    schemaVersion: binding.schemaVersion,
    providerInputSchemaDigest: binding.providerInputSchemaDigest ?? null,
    schemaDigest: binding.schemaDigest,
    argumentDigest: binding.argumentDigest,
    account: binding.account ?? null,
    effect: binding.effect,
    destination: binding.destination ?? null,
    ...(binding.operationSemantics ? { operationSemantics: binding.operationSemantics } : {}),
    ...(binding.verification ? { verification: binding.verification } : {}),
    ...(binding.asyncRead ? { asyncRead: binding.asyncRead } : {}),
    ...(binding.writeEvidenceMode ? { writeEvidenceMode: binding.writeEvidenceMode } : {}),
  }), 'utf8').digest('hex');
}
