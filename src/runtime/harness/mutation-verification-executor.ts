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
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { openEventLog } from './eventlog.js';
import {
  prepareFrozenMutationVerification,
  proveFrozenMutationVerification,
  MAX_FROZEN_MUTATION_VERIFICATION_ATTEMPTS,
  type PreparedFrozenMutationVerificationV1,
} from './mutation-verification-proof.js';
import { verifierLogicalCallAttemptId } from './mutation-verification-contract.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';

export type ExecuteFrozenMutationVerificationResult =
  | { status: 'not_applicable' }
  | {
      status: 'verified';
      resourceId: string;
      verifierLogicalCallId: string;
      duplicate: boolean;
    };

export interface CommittedMutationVerificationHold {
  ownerLogicalToolCallId: string;
  requirementId: string;
  effect: 'local_write' | 'external_write' | 'admin';
  resultHandleId: string;
  status: 'pending' | 'failed';
  reason: string;
  resourceId?: string;
  verifierLogicalCallId?: string;
  recoveryKind: 'automatic' | 'user_action' | 'exhausted';
  /** True means recovery may execute only the deterministic verifier call.
   * The successful owner mutation is immutable and is never an execution
   * candidate in this continuation. */
  verifierOnlyRetryable: boolean;
}

export type RecoverCommittedMutationVerificationsResult =
  | { status: 'not_pending' }
  | {
      status: 'verified';
      verified: Array<{
        ownerLogicalToolCallId: string;
        resourceId: string;
        verifierLogicalCallId: string;
      }>;
    }
  | { status: 'held'; holds: CommittedMutationVerificationHold[] }
  | { status: 'unavailable'; reason: string };

export class FrozenMutationVerificationError extends Error {
  override readonly name = 'FrozenMutationVerificationError';
  constructor(readonly reason: string) {
    super(`Frozen mutation verification failed: ${reason}`);
  }
}

interface CommittedMutationCandidate {
  accepted_task_id: string;
  logical_tool_call_id: string;
  requirement_id: string;
  effect_kind: 'local_write' | 'external_write' | 'admin';
  result_handle_id: string;
}

function boundedReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || 'verification state is unavailable';
}

function committedMutationCandidate(input: {
  sessionId: string;
  sourceUserSeq: number;
  ownerLogicalToolCallId: string;
}): CommittedMutationCandidate | null {
  try {
    return openEventLog().prepare(`
      SELECT b.accepted_task_id, b.logical_tool_call_id, b.requirement_id,
             b.effect_kind, s.result_handle_id
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s
          ON s.session_id = b.session_id
         AND s.source_user_seq = b.source_user_seq
         AND s.logical_tool_call_id = b.logical_tool_call_id
       WHERE b.session_id = ? AND b.source_user_seq = ?
         AND b.logical_tool_call_id = ?
         AND b.effect_kind IN ('local_write','external_write','admin')
         AND s.outcome_kind IN ('succeeded','empty_result')
         AND s.continues_requirement = 0
         AND s.requires_reconciliation = 0
         AND s.result_handle_id IS NOT NULL
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.ownerLogicalToolCallId,
    ) as CommittedMutationCandidate | undefined ?? null;
  } catch {
    return null;
  }
}

function verifierAttemptSettlements(
  input: { sessionId: string; sourceUserSeq: number },
  candidate: CommittedMutationCandidate,
  baseLogicalCallId: string,
) {
  return Array.from({ length: MAX_FROZEN_MUTATION_VERIFICATION_ATTEMPTS }, (_, ordinal) => {
    const logicalCallId = verifierLogicalCallAttemptId(baseLogicalCallId, ordinal);
    return {
      ordinal,
      logicalCallId,
      settlement: redeemDurableLogicalCallSettlementForHost({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: candidate.accepted_task_id,
        logicalToolCallId: logicalCallId,
      }),
    };
  });
}

function nextAutomaticVerifierAttemptId(input: {
  sessionId: string;
  sourceUserSeq: number;
  candidate: CommittedMutationCandidate;
  baseLogicalCallId: string;
}): string {
  for (const attempt of verifierAttemptSettlements(input, input.candidate, input.baseLogicalCallId)) {
    const prior = attempt.settlement;
    if (prior.status === 'missing') return attempt.logicalCallId;
    if (prior.status !== 'ok') {
      throw new FrozenMutationVerificationError(
        `verifier settlement is ${prior.status}: ${prior.reason}`,
      );
    }
    if (
      prior.settlement.outcome.kind === 'succeeded'
      || prior.settlement.outcome.kind === 'empty_result'
      || prior.settlement.outcome.directive.action === 'retry_with_backoff'
    ) continue;
    if (
      prior.settlement.outcome.directive.action === 'recover_connection'
      || prior.settlement.outcome.directive.action === 'ask_user'
    ) {
      throw new FrozenMutationVerificationError(
        `verifier requires ${prior.settlement.outcome.directive.action} before another readback attempt`,
      );
    }
    throw new FrozenMutationVerificationError(
      `verifier settled ${prior.settlement.outcome.kind}; another automatic attempt is not authorized`,
    );
  }
  throw new FrozenMutationVerificationError(
    `verifier exhausted ${MAX_FROZEN_MUTATION_VERIFICATION_ATTEMPTS} bounded readback attempts`,
  );
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

/** Re-project one known-success mutation's verification owner. The mutation
 * result handle is required, so this can never reinterpret an uncertain write
 * as committed. A null result means either no frozen verifier applies or the
 * exact readback has already proved the write. */
export function committedMutationVerificationHoldForOwner(input: {
  sessionId: string;
  sourceUserSeq: number;
  ownerLogicalToolCallId: string;
  observedFailure?: unknown;
}): CommittedMutationVerificationHold | null {
  const candidate = committedMutationCandidate(input);
  if (!candidate) return null;
  const prepared = prepareFrozenMutationVerification({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    ownerLogicalToolCallId: input.ownerLogicalToolCallId,
  });
  if (prepared.status === 'not_applicable') return null;
  if (prepared.status === 'unverified') {
    return {
      ownerLogicalToolCallId: candidate.logical_tool_call_id,
      requirementId: candidate.requirement_id,
      effect: candidate.effect_kind,
      resultHandleId: candidate.result_handle_id,
      status: 'failed',
      reason: boundedReason(input.observedFailure ?? prepared.reason),
      recoveryKind: 'exhausted',
      verifierOnlyRetryable: false,
    };
  }
  const proof = prepared.verification;
  if (proveFrozenMutationVerification({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    ownerLogicalToolCallId: input.ownerLogicalToolCallId,
  }).status === 'verified') return null;
  const attempts = verifierAttemptSettlements(input, candidate, proof.verifierLogicalCallId);
  const attempted = attempts.filter((attempt) => attempt.settlement.status !== 'missing');
  const userAction = attempted.find((attempt) => (
    attempt.settlement.status === 'ok'
    && (attempt.settlement.settlement.outcome.directive.action === 'recover_connection'
      || attempt.settlement.settlement.outcome.directive.action === 'ask_user')
  ));
  const terminalFailure = attempted.find((attempt) => (
    attempt.settlement.status !== 'ok'
    || (
      attempt.settlement.settlement.outcome.kind !== 'succeeded'
      && attempt.settlement.settlement.outcome.kind !== 'empty_result'
      && attempt.settlement.settlement.outcome.directive.action !== 'retry_with_backoff'
      && attempt.settlement.settlement.outcome.directive.action !== 'recover_connection'
      && attempt.settlement.settlement.outcome.directive.action !== 'ask_user'
    )
  ));
  const nextMissing = attempts.find((attempt) => attempt.settlement.status === 'missing');
  const observedReason = input.observedFailure === undefined
    ? ''
    : boundedReason(input.observedFailure);
  const userOpenableCatalogGate = Boolean(
    observedReason
    && /verifier (?:catalog identity|invoke port).*(?:absent|unavailable|changed)/i.test(observedReason),
  );
  const recoveryKind: CommittedMutationVerificationHold['recoveryKind'] =
    userAction || userOpenableCatalogGate
      ? 'user_action'
      : !terminalFailure && nextMissing
        ? 'automatic'
        : 'exhausted';
  const status: CommittedMutationVerificationHold['status'] = recoveryKind === 'exhausted'
    ? 'failed'
    : 'pending';
  const lastAttempt = attempted.at(-1);
  const attemptReason = userAction?.settlement.status === 'ok'
    ? `verifier requires ${userAction.settlement.settlement.outcome.directive.action}`
    : terminalFailure
      ? terminalFailure.settlement.status === 'ok'
        ? `verifier settled ${terminalFailure.settlement.settlement.outcome.kind}`
        : `verifier settlement is ${terminalFailure.settlement.status}: ${terminalFailure.settlement.reason}`
      : lastAttempt?.settlement.status === 'ok'
        ? `verifier attempt ${lastAttempt.ordinal + 1} settled ${lastAttempt.settlement.settlement.outcome.kind} without an exact proof`
        : 'the next deterministic verifier attempt has not settled';
  return {
    ownerLogicalToolCallId: candidate.logical_tool_call_id,
    requirementId: candidate.requirement_id,
    effect: candidate.effect_kind,
    resultHandleId: candidate.result_handle_id,
    status,
    reason: boundedReason(input.observedFailure ?? attemptReason),
    resourceId: proof.resourceId,
    verifierLogicalCallId: nextMissing?.logicalCallId ?? proof.verifierLogicalCallId,
    recoveryKind,
    verifierOnlyRetryable: recoveryKind === 'automatic',
  };
}

export function committedMutationVerificationHoldsForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): CommittedMutationVerificationHold[] {
  const rows = openEventLog().prepare(`
      SELECT b.logical_tool_call_id
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s
          ON s.session_id = b.session_id
         AND s.source_user_seq = b.source_user_seq
         AND s.logical_tool_call_id = b.logical_tool_call_id
       WHERE b.session_id = ? AND b.source_user_seq = ?
         AND b.effect_kind IN ('local_write','external_write','admin')
         AND s.outcome_kind IN ('succeeded','empty_result')
         AND s.continues_requirement = 0
         AND s.requires_reconciliation = 0
         AND s.result_handle_id IS NOT NULL
       ORDER BY s.settled_at, b.logical_tool_call_id
    `).all(input.sessionId, input.sourceUserSeq) as Array<{ logical_tool_call_id: string }>;
  return rows.flatMap((row) => {
    const hold = committedMutationVerificationHoldForOwner({
      ...input,
      ownerLogicalToolCallId: row.logical_tool_call_id,
    });
    return hold ? [hold] : [];
  });
}

/** Restart continuation for successful recipe-backed writes. Only the frozen
 * deterministic verifier id is eligible for execution. Owner mutation ids are
 * used solely for read-only result/recipe projection and are never passed to
 * the invocation kernel. */
export async function recoverCommittedMutationVerificationsForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
  parentLease: DispatchLeaseRef;
  turn?: number;
  deadlineMs: number;
  callerSignal?: AbortSignal;
  isKillRequested?: () => boolean;
}): Promise<RecoverCommittedMutationVerificationsResult> {
  let before: CommittedMutationVerificationHold[];
  try {
    before = committedMutationVerificationHoldsForSource(input);
  } catch (error) {
    return { status: 'unavailable', reason: boundedReason(error) };
  }
  if (before.length === 0) return { status: 'not_pending' };
  const verified: Extract<RecoverCommittedMutationVerificationsResult, { status: 'verified' }>['verified'] = [];
  const observedFailures = new Map<string, unknown>();
  for (const hold of before) {
    if (!hold.verifierOnlyRetryable || !hold.verifierLogicalCallId) continue;
    try {
      const result = await executeFrozenMutationVerification({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        ownerLogicalToolCallId: hold.ownerLogicalToolCallId,
        parentLease: input.parentLease,
        ...(input.turn === undefined ? {} : { turn: input.turn }),
        deadlineMs: input.deadlineMs,
        ...(input.callerSignal ? { callerSignal: input.callerSignal } : {}),
        ...(input.isKillRequested ? { isKillRequested: input.isKillRequested } : {}),
      });
      if (result.status === 'verified') {
        verified.push({
          ownerLogicalToolCallId: hold.ownerLogicalToolCallId,
          resourceId: result.resourceId,
          verifierLogicalCallId: result.verifierLogicalCallId,
        });
      }
    } catch (error) {
      observedFailures.set(hold.ownerLogicalToolCallId, error);
      // The exact post-attempt projection below distinguishes an unavailable
      // pre-dispatch verifier, a terminal verifier failure, and a successful
      // read whose proof still does not match. None can re-enter the write.
    }
  }
  let remaining: CommittedMutationVerificationHold[];
  try {
    remaining = committedMutationVerificationHoldsForSource(input);
  } catch (error) {
    return { status: 'unavailable', reason: boundedReason(error) };
  }
  remaining = remaining.map((hold) => {
    const observedFailure = observedFailures.get(hold.ownerLogicalToolCallId);
    if (observedFailure === undefined) return hold;
    return committedMutationVerificationHoldForOwner({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      ownerLogicalToolCallId: hold.ownerLogicalToolCallId,
      observedFailure,
    }) ?? hold;
  });
  return remaining.length > 0
    ? { status: 'held', holds: remaining }
    : { status: 'verified', verified };
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
  const alreadyVerified = proveFrozenMutationVerification({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    ownerLogicalToolCallId: input.ownerLogicalToolCallId,
  });
  if (alreadyVerified.status === 'verified') {
    return {
      status: 'verified',
      resourceId: alreadyVerified.resourceId,
      verifierLogicalCallId: alreadyVerified.verifierLogicalCallId,
      duplicate: true,
    };
  }
  const candidate = committedMutationCandidate(input);
  if (!candidate) {
    throw new FrozenMutationVerificationError('successful mutation owner/result is unavailable');
  }
  const verifierLogicalCallId = nextAutomaticVerifierAttemptId({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    candidate,
    baseLogicalCallId: proof.verifierLogicalCallId,
  });
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
    logicalToolCallId: verifierLogicalCallId,
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
      modelCallId: verifierLogicalCallId,
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
      nodeId: verifierLogicalCallId,
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
