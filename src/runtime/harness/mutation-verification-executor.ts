import {
  acceptedTurnCallAuthorityFor,
  withHostCallAttestation,
  type HostCallAttestation,
} from './accepted-turn-call-authority.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
} from './capability-manifest.js';
import type { DispatchLeaseRef } from './dispatch-lease.js';
import {
  canonicalCatalogIdentityOf,
  catalogIdentitiesEqual,
  freezeCatalogSnapshotForSource,
} from './host-capability-catalog-factory.js';
import { hostCallAttestationBindingDigest } from './host-call-capability-binding.js';
import { invokeHostToolCall } from './host-tool-invocation.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import {
  prepareFrozenMutationVerification,
  proveFrozenMutationVerification,
  type PreparedFrozenMutationVerificationV1,
} from './mutation-verification-proof.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';

export type ExecuteFrozenMutationVerificationResult =
  | { status: 'not_applicable' }
  | {
      status: 'verified';
      resourceId: string;
      verifierLogicalCallId: string;
      duplicate: boolean;
    };

export class FrozenMutationVerificationError extends Error {
  override readonly name = 'FrozenMutationVerificationError';
  constructor(readonly reason: string) {
    super(`Frozen mutation verification failed: ${reason}`);
  }
}

function exactVerifierEntry(input: {
  sessionId: string;
  sourceUserSeq: number;
  prepared: PreparedFrozenMutationVerificationV1;
}) {
  const frozen = freezeCatalogSnapshotForSource({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  if (!frozen.ok) return null;
  const matches = frozen.entries.filter((entry) => {
    const canonical = canonicalCatalogIdentityOf(entry);
    return canonical && catalogIdentitiesEqual(canonical, input.prepared.recipe.verifier);
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** Execute one frozen, host-derived readback through the same logical-call,
 * lease, physical-dispatch, settlement, and retained-result kernel used by
 * model-authored calls. The semantic graph remains untouched. */
export async function executeFrozenMutationVerification(input: {
  sessionId: string;
  sourceUserSeq: number;
  ownerLogicalToolCallId: string;
  parentLease: DispatchLeaseRef;
  turn?: number;
  deadlineMs: number;
  callerSignal?: AbortSignal;
  isKillRequested?: () => boolean;
}): Promise<ExecuteFrozenMutationVerificationResult> {
  const prepared = prepareFrozenMutationVerification({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    ownerLogicalToolCallId: input.ownerLogicalToolCallId,
  });
  if (prepared.status === 'not_applicable') return prepared;
  if (prepared.status !== 'prepared') throw new FrozenMutationVerificationError(prepared.reason);
  const proof = prepared.verification;
  const verifierEntry = exactVerifierEntry({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    prepared: proof,
  });
  const manifest = currentCapabilityManifest(verifierEntry?.manifest);
  const canonical = verifierEntry ? canonicalCatalogIdentityOf(verifierEntry) : null;
  if (
    !verifierEntry
    || !manifest
    || !canonical
    || !catalogIdentitiesEqual(canonical, proof.recipe.verifier)
    || verifierEntry.effect !== 'read'
    || manifest.effect !== 'read'
    || capabilityManifestDigest(manifest) !== proof.recipe.verifier.manifestDigest
  ) throw new FrozenMutationVerificationError('frozen verifier catalog identity is absent or changed');
  const port = resolveProductionPortsForManifest(manifest);
  if (!port || manifest.invokePortId !== proof.recipe.verifier.invokePortId) {
    throw new FrozenMutationVerificationError('frozen verifier invoke port is unavailable or changed');
  }
  const root = acceptedTurnCallAuthorityFor(input.sessionId, input.sourceUserSeq);
  const logical = durableLogicalCallContract(
    proof.recipe.acceptedTaskId,
    manifest.operationId,
    proof.verifierArgs,
  );
  if (
    root.status !== 'ok'
    || root.authority.authorityKind !== 'host_v1'
    || root.authority.state !== 'open'
    || root.authority.identity.acceptedTaskId !== proof.recipe.acceptedTaskId
    || !root.authority.catalogRevisionDigest
    || !root.authority.bindingRevisionDigest
    || !logical
  ) throw new FrozenMutationVerificationError('accepted host call root cannot own the verifier');
  const binding = {
    bindingKind: 'catalog_manifest' as const,
    capabilityId: canonical.capabilityId,
    ...(canonical.providerInputSchemaDigest
      ? { providerInputSchemaDigest: canonical.providerInputSchemaDigest }
      : {}),
    schemaFingerprint: canonical.schemaDigest,
    accountId: canonical.account,
    invokePortId: canonical.invokePortId,
    operationId: canonical.operationId,
    manifestId: canonical.manifestId,
    manifestDigest: canonical.manifestDigest,
    effect: 'read' as const,
  };
  const attestation: HostCallAttestation = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: proof.recipe.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: proof.verifierLogicalCallId,
    toolName: logical.toolName,
    argumentDigest: logical.argumentDigest,
    ...binding,
    bindingDigest: hostCallAttestationBindingDigest(binding),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest,
    bindingRevisionDigest: root.authority.bindingRevisionDigest,
  };
  const invoked = await withHostCallAttestation(attestation, () => invokeHostToolCall({
    identity: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      modelCallId: proof.verifierLogicalCallId,
      toolName: manifest.operationId,
      args: proof.verifierArgs,
      ...(input.turn === undefined ? {} : { turn: input.turn }),
    },
    parentLease: input.parentLease,
    effect: 'read',
    boundary: 'host_owned_external',
    businessCall: false,
    deadlineMs: input.deadlineMs,
    ...(input.callerSignal ? { callerSignal: input.callerSignal } : {}),
    ...(input.isKillRequested ? { isKillRequested: input.isKillRequested } : {}),
    invoke: () => verifierEntry.invoke({
      nodeId: proof.verifierLogicalCallId,
      role: 'host_verification',
      payload: proof.verifierArgs,
      identity: {
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: proof.recipe.acceptedTaskId,
      },
      binding: {
        capabilityId: verifierEntry.capabilityId,
        toolName: manifest.operationId,
        schemaVersion: manifest.operationVersion,
        schemaDigest: manifest.definitionFingerprint,
        args: proof.verifierArgs,
        account: manifest.accountId,
        effect: 'read',
        ...(manifest.destination ? { destination: manifest.destination } : {}),
        manifestDigest: capabilityManifestDigest(manifest),
        providerKind: manifest.providerKind,
        liveFingerprint: manifest.definitionFingerprint,
        manifest,
        invoke: port.invoke,
      },
    }),
  }));
  const verified = proveFrozenMutationVerification({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    ownerLogicalToolCallId: input.ownerLogicalToolCallId,
  });
  if (verified.status !== 'verified') {
    throw new FrozenMutationVerificationError(
      verified.status === 'unverified' ? verified.reason : 'the frozen recipe disappeared during verification',
    );
  }
  return {
    status: 'verified',
    resourceId: verified.resourceId,
    verifierLogicalCallId: verified.verifierLogicalCallId,
    duplicate: invoked.settlement.duplicate,
  };
}
