import { openCanonicalArguments } from './authority-argument-seal.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { openEventLog } from './eventlog.js';
import {
  bindingDigestOf,
  loadSealedNodeBinding,
} from './host-capability-catalog-factory.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import {
  exactVerificationContentMatches,
  mutationVerificationDigest,
  projectMutationVerificationIntent,
  projectReadbackVerificationResult,
  setVerificationPointer,
  verificationTargetDigest,
  verifierLogicalCallId,
  verifierLogicalCallAttemptId,
  type CanonicalRangeValuesV1,
  type MutationVerificationRecipeV1,
} from './mutation-verification-contract.js';
import {
  exactProviderDataEnvelopeAcknowledged,
  exactProviderDataPayload,
} from './provider-read-evidence.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { durableLogicalCallContract } from './logical-call-contract.js';

interface WorkBindingRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  contract_id: string;
  requirement_id: string;
  tool_name: string;
  argument_digest: string;
  effect_kind: string;
}

export interface PreparedFrozenMutationVerificationV1 {
  recipe: MutationVerificationRecipeV1;
  ownerLogicalToolCallId: string;
  ownerPhysicalDispatchId: string;
  ownerResultHandleId: string;
  ownerResultSha256: string;
  resourceId: string;
  targetDigest: string;
  expectedContent: CanonicalRangeValuesV1 | null;
  verifierArgs: Record<string, unknown>;
  verifierLogicalCallId: string;
}

export interface VerifiedFrozenMutationVerificationV1
  extends PreparedFrozenMutationVerificationV1 {
  verifierPhysicalDispatchId: string;
  verifierResultHandleId: string;
  verifierResultSha256: string;
}

export const MAX_FROZEN_MUTATION_VERIFICATION_ATTEMPTS = 3;

export type FrozenMutationVerificationPreparation =
  | { status: 'prepared'; verification: PreparedFrozenMutationVerificationV1 }
  | { status: 'not_applicable' }
  | { status: 'unverified'; reason: string };

export type FrozenMutationVerificationProof =
  | ({ status: 'verified' } & VerifiedFrozenMutationVerificationV1)
  | { status: 'not_applicable' }
  | { status: 'unverified'; reason: string };

export interface VerifiedMutationProgressFactV1 {
  requirementId: string;
  proof: MutationVerificationRecipeV1['proof'];
  resourceId: string;
  resourceFamily: string;
  /** Only an identity proof over a handle projected from the authoritative
   * mutation result proves that this turn created the resource. */
  createdResource: boolean;
}

export type FrozenMutationProgressV1 =
  | { status: 'not_applicable' }
  | { status: 'none_verified'; incompleteRequirementIds: string[] }
  | { status: 'complete'; verified: VerifiedMutationProgressFactV1[] }
  | {
      status: 'partial';
      verified: VerifiedMutationProgressFactV1[];
      incompleteRequirementIds: string[];
    };

function canonicalEqual(left: unknown, right: unknown): boolean {
  return mutationVerificationDigest(left) === mutationVerificationDigest(right);
}

function workBindingForLogicalCall(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): WorkBindingRow | null {
  return openEventLog().prepare(`
    SELECT accepted_task_id, logical_tool_call_id, contract_id, requirement_id,
           tool_name, argument_digest, effect_kind
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(
    input.sessionId,
    input.sourceUserSeq,
    input.logicalToolCallId,
  ) as WorkBindingRow | undefined ?? null;
}

function successfulLogicalCallsForRequirement(input: {
  sessionId: string;
  sourceUserSeq: number;
  contractId: string;
  requirementId: string;
}): string[] {
  const rows = openEventLog().prepare(`
    SELECT b.logical_tool_call_id
      FROM expected_work_call_bindings b
      JOIN logical_call_settlements s
        ON s.session_id = b.session_id
       AND s.source_user_seq = b.source_user_seq
       AND s.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ?
       AND b.contract_id = ? AND b.requirement_id = ?
       AND s.outcome_kind IN ('succeeded', 'empty_result')
       AND s.continues_requirement = 0
     ORDER BY b.logical_tool_call_id
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    input.contractId,
    input.requirementId,
  ) as Array<{ logical_tool_call_id: string }>;
  return rows.map((row) => row.logical_tool_call_id);
}

/** Reopen only the provider-ready arguments sealed by the existing typed
 * physical-authority kernel. A logical digest or model carrier is never used
 * as a substitute for these bytes. */
function providerArgumentsForSuccessfulCall(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  physicalDispatchId: string;
}): Record<string, unknown> | null {
  const row = openEventLog().prepare(`
    SELECT p.accepted_task_id, p.logical_tool_call_id, p.tool_name,
           p.argument_digest, p.state,
           lease.recovery_tool_name, lease.recovery_argument_digest,
           lease.recovery_argument_cipher
      FROM physical_dispatches p
      JOIN run_dispatch_leases lease
        ON lease.session_id = p.session_id
       AND lease.scope_id = p.lease_scope_id
       AND lease.lease_id = p.lease_id
     WHERE p.session_id = ? AND p.source_user_seq = ?
       AND p.physical_dispatch_id = ?
  `).get(
    input.sessionId,
    input.sourceUserSeq,
    input.physicalDispatchId,
  ) as {
    accepted_task_id: string;
    logical_tool_call_id: string;
    tool_name: string;
    argument_digest: string;
    state: string;
    recovery_tool_name: string | null;
    recovery_argument_digest: string | null;
    recovery_argument_cipher: string | null;
  } | undefined;
  if (
    !row
    || row.logical_tool_call_id !== input.logicalToolCallId
    || row.state !== 'returned'
    || row.recovery_tool_name !== row.tool_name
    || row.recovery_argument_digest !== row.argument_digest
    || !row.recovery_argument_cipher
  ) return null;
  const reopened = openCanonicalArguments(row.recovery_argument_cipher);
  if (!reopened) return null;
  // The existing recovery seal uses one provider-neutral `{args: ...}` shell
  // for nested carriers. Reopen either the root or that one exact shell and
  // let the immutable logical digest select; names/provider schemas never do.
  const candidates: Record<string, unknown>[] = [reopened];
  if (
    Object.keys(reopened).length === 1
    && reopened.args
    && typeof reopened.args === 'object'
    && !Array.isArray(reopened.args)
  ) candidates.push(reopened.args as Record<string, unknown>);
  const matching = candidates.filter((candidate) => (
    durableLogicalCallContract(row.accepted_task_id, row.tool_name, candidate)?.argumentDigest
      === row.argument_digest
  ));
  return matching.length === 1 ? matching[0]! : null;
}

function exactOwnerRecipe(input: {
  sessionId: string;
  sourceUserSeq: number;
  ownerLogicalToolCallId: string;
}): { row: WorkBindingRow; recipe: MutationVerificationRecipeV1 } | null {
  const row = workBindingForLogicalCall({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    logicalToolCallId: input.ownerLogicalToolCallId,
  });
  if (!row || row.effect_kind === 'read' || row.effect_kind === 'compute') return null;
  const sealed = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, row.requirement_id);
  if (!sealed?.verification) return null;
  const { verification: _verification, bindingDigest: _bindingDigest, ...base } = sealed;
  if (
    bindingDigestOf(base) !== sealed.verification.ownerBindingDigest
    || sealed.verification.acceptedTaskId !== row.accepted_task_id
    || sealed.verification.workContractId !== row.contract_id
    || sealed.verification.ownerRequirementId !== row.requirement_id
    || sealed.logicalToolName !== row.tool_name
  ) return null;
  return { row, recipe: sealed.verification };
}

export function prepareFrozenMutationVerification(input: {
  sessionId: string;
  sourceUserSeq: number;
  ownerLogicalToolCallId: string;
}): FrozenMutationVerificationPreparation {
  try {
    const owner = exactOwnerRecipe(input);
    if (!owner) return { status: 'not_applicable' };
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: owner.row.accepted_task_id,
      logicalToolCallId: input.ownerLogicalToolCallId,
    });
    if (redeemed.status !== 'ok') {
      return { status: 'unverified', reason: `mutation result is ${redeemed.status}: ${redeemed.reason}` };
    }
    if (redeemed.value.toolName !== owner.row.tool_name) {
      return { status: 'unverified', reason: 'mutation result belongs to a different operation' };
    }
    const providerArguments = providerArgumentsForSuccessfulCall({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      logicalToolCallId: input.ownerLogicalToolCallId,
      physicalDispatchId: redeemed.value.physicalDispatchId,
    });
    if (!providerArguments) {
      return { status: 'unverified', reason: 'mutation provider-ready arguments are not durably reconstructable' };
    }
    const intent = projectMutationVerificationIntent({
      contract: owner.recipe.mutation,
      providerArguments,
      authoritativeResult: exactProviderDataPayload(redeemed.value.rawPayload),
      phase: 'settled_result',
      providerAcknowledged: exactProviderDataEnvelopeAcknowledged(redeemed.value.rawPayload),
    });
    if (!intent.ok) return { status: 'unverified', reason: intent.reason };
    const verifierArgs = structuredClone(owner.recipe.verifierStaticArgs) as Record<string, unknown>;
    for (const [key, value] of Object.entries(intent.verifierStaticArgs)) verifierArgs[key] = value;
    if (!setVerificationPointer(
      verifierArgs,
      owner.recipe.verifierContract.requestTargetPointers[0],
      intent.resourceId,
    )) return { status: 'unverified', reason: 'verifier target arguments cannot be instantiated' };
    const targetDigest = verificationTargetDigest(intent.resourceId);
    const logicalCallId = verifierLogicalCallId({
      acceptedTaskId: owner.recipe.acceptedTaskId,
      workContractId: owner.recipe.workContractId,
      ownerRequirementId: owner.recipe.ownerRequirementId,
      ownerBindingDigest: owner.recipe.ownerBindingDigest,
      recipeDigest: owner.recipe.recipeDigest,
      proof: owner.recipe.proof,
      targetDigest,
    });
    return {
      status: 'prepared',
      verification: {
        recipe: owner.recipe,
        ownerLogicalToolCallId: input.ownerLogicalToolCallId,
        ownerPhysicalDispatchId: redeemed.value.physicalDispatchId,
        ownerResultHandleId: redeemed.value.resultHandleId,
        ownerResultSha256: redeemed.value.rawPayloadSha256,
        resourceId: intent.resourceId,
        targetDigest,
        expectedContent: intent.expectedContent,
        verifierArgs,
        verifierLogicalCallId: logicalCallId,
      },
    };
  } catch (error) {
    return {
      status: 'unverified',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300),
    };
  }
}

export function proveFrozenMutationVerification(input: {
  sessionId: string;
  sourceUserSeq: number;
  ownerLogicalToolCallId: string;
}): FrozenMutationVerificationProof {
  const prepared = prepareFrozenMutationVerification(input);
  if (prepared.status !== 'prepared') return prepared;
  const proof = prepared.verification;
  const logicalContract = durableLogicalCallContract(
    proof.recipe.acceptedTaskId,
    proof.recipe.verifier.operationId,
    proof.verifierArgs,
  );
  if (!logicalContract) return { status: 'unverified', reason: 'verifier logical contract is unsafe' };
  let lastReason = 'verifier capability receipt is missing or changed';
  for (let ordinal = 0; ordinal < MAX_FROZEN_MUTATION_VERIFICATION_ATTEMPTS; ordinal += 1) {
    const logicalCallId = verifierLogicalCallAttemptId(proof.verifierLogicalCallId, ordinal);
    const hostBinding = loadHostCallCapabilityBinding({
      db: openEventLog(),
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      logicalToolCallId: logicalCallId,
    });
    if (
      hostBinding.status !== 'ok'
      || hostBinding.binding.acceptedTaskId !== proof.recipe.acceptedTaskId
      || hostBinding.binding.toolName !== logicalContract.toolName
      || hostBinding.binding.effectiveArgumentDigest !== logicalContract.argumentDigest
      || hostBinding.binding.effect !== 'read'
      || hostBinding.binding.bindingKind !== 'catalog_manifest'
      || hostBinding.binding.capabilityId !== proof.recipe.verifier.capabilityId
      || hostBinding.binding.schemaFingerprint !== proof.recipe.verifier.schemaDigest
      || hostBinding.binding.accountId !== proof.recipe.verifier.account
      || hostBinding.binding.invokePortId !== proof.recipe.verifier.invokePortId
      || hostBinding.binding.operationId !== proof.recipe.verifier.operationId
      || hostBinding.binding.manifestId !== proof.recipe.verifier.manifestId
      || hostBinding.binding.manifestDigest !== proof.recipe.verifier.manifestDigest
    ) continue;
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: proof.recipe.acceptedTaskId,
      logicalToolCallId: logicalCallId,
    });
    if (redeemed.status !== 'ok') {
      lastReason = `verifier result is ${redeemed.status}: ${redeemed.reason}`;
      continue;
    }
    if (redeemed.value.toolName !== logicalContract.toolName) {
      lastReason = 'verifier result belongs to a different operation';
      continue;
    }
    const projected = projectReadbackVerificationResult({
      contract: proof.recipe.verifierContract,
      providerArguments: proof.verifierArgs,
      authoritativeResult: exactProviderDataPayload(redeemed.value.rawPayload),
      requireContent: proof.recipe.proof === 'exact_content_v1',
      providerAcknowledged: exactProviderDataEnvelopeAcknowledged(redeemed.value.rawPayload),
    });
    if (!projected.ok) {
      lastReason = projected.reason;
      continue;
    }
    if (projected.resourceId !== proof.resourceId) {
      lastReason = 'verified resource id changed during re-proof';
      continue;
    }
    if (
      proof.recipe.proof === 'exact_content_v1'
      && !exactVerificationContentMatches(proof.expectedContent, projected.observedContent)
    ) {
      lastReason = 'readback content does not equal the exact mutation intent';
      continue;
    }
    return {
      status: 'verified',
      ...proof,
      verifierLogicalCallId: logicalCallId,
      verifierPhysicalDispatchId: redeemed.value.physicalDispatchId,
      verifierResultHandleId: redeemed.value.resultHandleId,
      verifierResultSha256: redeemed.value.rawPayloadSha256,
    };
  }
  return { status: 'unverified', reason: lastReason };
}

/**
 * Project only facts the exact frozen mutation receipts prove for one accepted
 * business graph. This is deliberately opt-in to external writes carrying a
 * sealed recipe; local writes and legacy mutations are not reinterpreted.
 *
 * The projection is presentation-neutral. Callers may use it to prevent a
 * partial terminal from claiming the whole graph completed, but it grants no
 * dispatch, settlement, or requirement-discharge authority.
 */
export function frozenMutationProgress(input: {
  sessionId: string;
  sourceUserSeq: number;
}): FrozenMutationProgressV1 {
  try {
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok') return { status: 'not_applicable' };
    const operations = loaded.contract.operations.filter((operation) => operation.effect === 'external_write');
    const recipeBacked = operations.filter((operation) =>
      Boolean(loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, operation.id)?.verification));
    if (recipeBacked.length === 0) return { status: 'not_applicable' };

    const verified: VerifiedMutationProgressFactV1[] = [];
    const incompleteRequirementIds: string[] = [];
    for (const operation of operations) {
      const sealed = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, operation.id);
      if (!sealed?.verification) {
        incompleteRequirementIds.push(operation.id);
        continue;
      }
      const proofs = successfulLogicalCallsForRequirement({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        contractId: loaded.contract.contractId,
        requirementId: operation.id,
      }).map((ownerLogicalToolCallId) => proveFrozenMutationVerification({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        ownerLogicalToolCallId,
      })).filter((proof): proof is Extract<FrozenMutationVerificationProof, { status: 'verified' }> =>
        proof.status === 'verified');

      // V1 recipes cover once-cardinality mutations. Anything other than one
      // exact proof is not safe to summarize as completed.
      if (proofs.length !== 1) {
        incompleteRequirementIds.push(operation.id);
        continue;
      }
      const proof = proofs[0]!;
      verified.push({
        requirementId: operation.id,
        proof: proof.recipe.proof,
        resourceId: proof.resourceId,
        resourceFamily: proof.recipe.mutation.resourceFamily,
        createdResource: proof.recipe.proof === 'resource_identity_v1'
          && proof.recipe.mutation.target.source === 'authoritative_result',
      });
    }
    if (verified.length === 0) return { status: 'none_verified', incompleteRequirementIds };
    return incompleteRequirementIds.length === 0
      ? { status: 'complete', verified }
      : { status: 'partial', verified, incompleteRequirementIds };
  } catch {
    return { status: 'not_applicable' };
  }
}

/** Last-edge target gate for a provider-ready mutation. It applies only when
 * the exact frozen mutation contract says its target comes from provider
 * arguments and one dependency carries a compatible verified resource. */
export function exactVerifiedMutationTargetAdmission(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  providerArguments: Record<string, unknown>;
}): { status: 'not_applicable' | 'admitted' } | { status: 'refused'; reason: string } {
  try {
    const current = exactOwnerRecipe({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      ownerLogicalToolCallId: input.logicalToolCallId,
    });
    if (!current || current.recipe.mutation.target.source !== 'provider_arguments') {
      return { status: 'not_applicable' };
    }
    const loaded = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
    if (loaded.status !== 'ok' || loaded.contract.contractId !== current.row.contract_id) {
      return { status: 'refused', reason: 'exact mutation target contract is unavailable' };
    }
    const operation = loaded.contract.operations.find((entry) => entry.id === current.row.requirement_id);
    if (!operation) return { status: 'refused', reason: 'exact mutation target requirement is unavailable' };
    const compatible: Array<Extract<FrozenMutationVerificationProof, { status: 'verified' }>> = [];
    for (const dependencyId of operation.dependsOn) {
      for (const logicalCallId of successfulLogicalCallsForRequirement({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        contractId: current.row.contract_id,
        requirementId: dependencyId,
      })) {
        const proof = proveFrozenMutationVerification({
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          ownerLogicalToolCallId: logicalCallId,
        });
        if (
          proof.status === 'verified'
          && proof.recipe.mutation.resourceFamily === current.recipe.mutation.resourceFamily
          && proof.recipe.mutation.producedHandleKind === current.recipe.mutation.producedHandleKind
          && proof.recipe.verifier.providerKind === current.recipe.verifier.providerKind
          && proof.recipe.verifier.account === current.recipe.verifier.account
        ) compatible.push(proof);
      }
    }
    if (compatible.length !== 1) {
      return {
        status: 'refused',
        reason: compatible.length === 0
          ? 'no exact verified dependency target exists for this mutation'
          : 'multiple verified dependency targets make this mutation ambiguous',
      };
    }
    const intent = projectMutationVerificationIntent({
      contract: current.recipe.mutation,
      providerArguments: input.providerArguments,
      authoritativeResult: null,
      phase: 'pre_dispatch',
    });
    if (!intent.ok) return { status: 'refused', reason: intent.reason };
    return intent.resourceId === compatible[0]!.resourceId
      ? { status: 'admitted' }
      : { status: 'refused', reason: 'provider-ready mutation target does not match the verified dependency id byte-for-byte' };
  } catch (error) {
    return {
      status: 'refused',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300),
    };
  }
}
