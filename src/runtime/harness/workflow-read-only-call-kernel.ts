/**
 * Provider-neutral one-call workflow orchestration kernel.
 *
 * The existing public adapter remains workflow_v1_read_only byte-for-byte.
 * Callers provide only the durable activation id, exact content-addressed plan
 * and compiled canonical args. A module-owned authority port supplies the
 * effect bound and opaque attestation; no caller can inject an invoke callback
 * or impersonate a graph. Future mutation authority can reuse the logical /
 * physical / settlement spine only after workflow_v3_call is durable.
 */
import { createHash } from 'node:crypto';

import {
  armWorkflowReadOnlyCallAuthority,
  closeWorkflowReadOnlyCallAuthority,
  closeWorkflowV3CallAuthority,
  mintWorkflowReadOnlyCallAttestation,
  mintWorkflowV3CallAttestation,
  poisonWorkflowReadOnlyCallAuthority,
  poisonWorkflowV3CallAuthority,
  readWorkflowReadOnlyCallAuthority,
  readWorkflowV3CallAuthority,
  withWorkflowReadOnlyCallAttestation,
  withWorkflowV3CallAttestation,
  type AcceptedTurnCallAuthorityReadResult,
  type WorkflowReadOnlyCallAttestationProof,
  type WorkflowV3CallAttestationProof,
} from './accepted-turn-call-authority.js';
import {
  admitLogicalCall,
  beginWorkflowPreparationPhysicalDispatch,
  beginPhysicalDispatch,
  settlePhysicalDispatch,
  type PhysicalCrossingIdentity,
} from './dispatch-ledger.js';
import { claimWorkflowPhysicalIo } from './physical-io-claim.js';
import {
  commitLogicalCallSettlement,
  redeemDurableLogicalCallSettlementForHost,
} from './logical-call-settlement-store.js';
import { classifyAttemptOutcome } from './attempt-outcome.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
  type CanonicalCatalogIdentityV1,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import { currentCapabilityManifest } from './capability-manifest.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';
import {
  createWorkflowNodeInvocationPlan,
  parseWorkflowNodeInvocationPlan,
  type WorkflowNodeArgumentBindingV1,
  type WorkflowNodeInvocationEffectV1,
  type WorkflowNodeInvocationValueTypeV1,
} from '../../memory/workflow-node-invocation-plan.js';
import {
  activateDispatchLease,
  isDispatchLeaseCurrent,
  revokeDispatchLease,
  runWithDispatchLease,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import { durableLogicalCallRecoveryMaterial } from './logical-call-contract.js';
import { openCanonicalArguments } from './authority-argument-seal.js';
import { openEventLog } from './eventlog.js';

export type ExecuteWorkflowCallKernelResult =
  | {
      status: 'completed';
      activationId: string;
      authorityRootId: string;
      logicalCallId: string;
      physicalDispatchId: string;
      result: unknown;
    }
  | {
      status: 'replayed';
      activationId: string;
      authorityRootId: string;
      logicalCallId: string;
      result: unknown;
      resultHandleId: string;
    }
  | {
      status: 'blocked' | 'failed';
      reason: string;
      zeroBody: boolean;
      activationId: string;
    };

/** Read compatibility name retained for existing imports. */
export type ExecuteWorkflowReadOnlyCallResult = ExecuteWorkflowCallKernelResult;

interface WorkflowCallMintedAttestation<Proof extends object> {
  status: 'minted';
  proof: Proof;
  ref: {
    sessionId: string;
    sourceEventSeq: number;
    authorityRootId: string;
    activationId: string;
    activationDigest: string;
    logicalCallId: string;
    authorityDigest: string;
    authorityRevision: number;
  };
  toolName: string;
  argumentDigest: string;
}

type WorkflowCallAttestationResult<Proof extends object> =
  | WorkflowCallMintedAttestation<Proof>
  | { status: 'missing' | 'closed' | 'conflict' | 'storage_error'; reason: string };

interface WorkflowCallAuthorityPort<Proof extends object> {
  authorityKind: string;
  effect: WorkflowNodeInvocationEffectV1;
  mutating: boolean;
  operationLabel: string;
  read(activationId: string): AcceptedTurnCallAuthorityReadResult;
  mint(input: {
    activationId: string;
    invocationPlan: unknown;
    args: Record<string, unknown>;
  }): WorkflowCallAttestationResult<Proof>;
  withAttestation<T>(proof: Proof, work: () => T): T;
  close(input: {
    activationId: string;
    outcome: 'completed' | 'failed' | 'cancelled' | 'blocked';
  }): WorkflowCallAuthorityCloseResult;
  poison(input: { activationId: string; reason: string }): unknown;
}

type WorkflowCallAuthorityCloseResult =
  | { status: 'closed' | 'replayed'; authority: unknown }
  | { status: 'not_ready' | 'missing' | 'conflict' | 'storage_error'; reason: string };

const READ_ONLY_WORKFLOW_CALL_AUTHORITY_PORT: WorkflowCallAuthorityPort<
  WorkflowReadOnlyCallAttestationProof
> = Object.freeze({
  authorityKind: 'workflow_v1_read_only',
  effect: 'read',
  mutating: false,
  operationLabel: 'workflow read',
  read: readWorkflowReadOnlyCallAuthority,
  mint: mintWorkflowReadOnlyCallAttestation,
  withAttestation: withWorkflowReadOnlyCallAttestation,
  close: closeWorkflowReadOnlyCallAuthority,
  poison: poisonWorkflowReadOnlyCallAuthority,
});

function workflowV3CallAuthorityPort(
  effect: Exclude<WorkflowNodeInvocationEffectV1, 'read' | 'compute'>,
): WorkflowCallAuthorityPort<WorkflowV3CallAttestationProof> {
  return Object.freeze({
    authorityKind: 'workflow_v3_call',
    effect,
    mutating: effect === 'local_write' || effect === 'external_write' || effect === 'admin',
    operationLabel: 'workflow v3 call',
    read: readWorkflowV3CallAuthority,
    mint: mintWorkflowV3CallAttestation,
    withAttestation: withWorkflowV3CallAttestation,
    close: closeWorkflowV3CallAuthority,
    poison: poisonWorkflowV3CallAuthority,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function physicalDispatchId(input: {
  activationDigest: string;
  logicalCallId: string;
  toolName: string;
  argumentDigest: string;
}): string {
  return `workflow-dispatch:${sha256(JSON.stringify({
    version: 1,
    ...input,
  }))}`;
}

function preparationPhysicalDispatchId(input: {
  activationDigest: string;
  logicalCallId: string;
  toolName: string;
  argumentDigest: string;
  sequence: number;
}): string {
  return `workflow-preparation-dispatch:${sha256(JSON.stringify({
    version: 1,
    ...input,
  }))}`;
}

function nextWorkflowPreparationSequence(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalCallId: string;
}): number {
  const row = openEventLog().prepare(`
    SELECT COUNT(*) AS n
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id = ? AND relation = 'probe'
  `).get(input.sessionId, input.sourceUserSeq, input.logicalCallId) as { n: number };
  return row.n + 1;
}

function workflowCallLeaseScope(input: {
  activationId: string;
  activationDigest: string;
  authorityRootId: string;
  logicalCallId: string;
}): string {
  return `workflow-call:v1:${sha256(JSON.stringify({
    version: 1,
    ...input,
  }))}`;
}

interface WorkflowCallLeaseRow {
  scope_id: string;
  session_id: string;
  lease_id: string;
  run_attempt_id: string | null;
  parent_scope_id: string | null;
  parent_lease_id: string | null;
  source_user_seq: number | null;
  accepted_task_id: string | null;
  logical_tool_call_id: string | null;
  recovery_effect: string | null;
  recovery_business_call: number | null;
  recovery_tool_name: string | null;
  recovery_argument_digest: string | null;
  recovery_argument_cipher: string | null;
  recovery_turn: number | null;
  revoked_at: string | null;
}

type WorkflowCallLeaseSelection =
  | { status: 'ok'; lease: DispatchLeaseRef; created: boolean }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Select the one durable generation owned by this activation. A restart adopts
 * the stored lease id; replacing it under the same deterministic scope would
 * make the already-reserved physical row permanently foreign.
 *
 * The logical row must already exist. Schema v53 deliberately rejects a
 * call-bound lease whose exact logical contract has not first been admitted.
 */
function selectWorkflowCallLease(input: {
  sessionId: string;
  sourceUserSeq: number;
  activationId: string;
  activationDigest: string;
  authorityRootId: string;
  logicalCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  effect: WorkflowNodeInvocationEffectV1;
  allowCreate: boolean;
}): WorkflowCallLeaseSelection {
  const material = durableLogicalCallRecoveryMaterial(
    input.authorityRootId,
    input.toolName,
    input.args,
  );
  if (!material) return { status: 'conflict', reason: 'workflow call recovery material is unsafe' };
  const scopeId = workflowCallLeaseScope({
    activationId: input.activationId,
    activationDigest: input.activationDigest,
    authorityRootId: input.authorityRootId,
    logicalCallId: input.logicalCallId,
  });
  const db = openEventLog();
  const select = db.prepare(`
    SELECT scope_id, session_id, lease_id, run_attempt_id,
           parent_scope_id, parent_lease_id,
           source_user_seq, accepted_task_id, logical_tool_call_id,
           recovery_effect, recovery_business_call, recovery_tool_name,
           recovery_argument_digest, recovery_argument_cipher, recovery_turn,
           revoked_at
      FROM run_dispatch_leases
     WHERE scope_id = ?
  `);
  const validate = (row: WorkflowCallLeaseRow, created: boolean): WorkflowCallLeaseSelection => {
    const reopened = row.recovery_argument_cipher
      ? openCanonicalArguments(row.recovery_argument_cipher)
      : null;
    const reopenedMaterial = reopened?.args
      ? durableLogicalCallRecoveryMaterial(
          input.authorityRootId,
          row.recovery_tool_name ?? '',
          reopened.args,
        )
      : null;
    if (
      row.scope_id !== scopeId
      || row.session_id !== input.sessionId
      || row.run_attempt_id !== null
      || row.parent_scope_id !== null
      || row.parent_lease_id !== null
      || row.source_user_seq !== input.sourceUserSeq
      || row.accepted_task_id !== input.authorityRootId
      || row.logical_tool_call_id !== input.logicalCallId
      || row.recovery_effect !== input.effect
      || row.recovery_business_call !== 1
      || row.recovery_tool_name !== material.toolName
      || row.recovery_argument_digest !== material.argumentDigest
      || row.recovery_turn !== null
      || row.revoked_at !== null
      || !reopenedMaterial
      || reopenedMaterial.toolName !== material.toolName
      || reopenedMaterial.argumentDigest !== material.argumentDigest
    ) return { status: 'conflict', reason: 'workflow call lease conflicts with its frozen activation contract' };
    const lease: DispatchLeaseRef = {
      sessionId: row.session_id,
      scopeId: row.scope_id,
      leaseId: row.lease_id,
      sourceUserSeq: row.source_user_seq,
      acceptedTaskId: row.accepted_task_id,
      logicalToolCallId: row.logical_tool_call_id,
    };
    if (!isDispatchLeaseCurrent(lease)) {
      return { status: 'conflict', reason: 'workflow call lease is no longer current' };
    }
    return { status: 'ok', lease, created };
  };
  try {
    return db.transaction((): WorkflowCallLeaseSelection => {
      const existing = select.get(scopeId) as WorkflowCallLeaseRow | undefined;
      if (existing) return validate(existing, false);
      if (!input.allowCreate) {
        return { status: 'missing', reason: 'workflow call lease is missing' };
      }
      const created = activateDispatchLease({
        sessionId: input.sessionId,
        scopeId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.authorityRootId,
        logicalToolCallId: input.logicalCallId,
        recovery: {
          effect: input.effect,
          businessCall: true,
          material,
        },
      });
      const stored = select.get(scopeId) as WorkflowCallLeaseRow | undefined;
      if (!stored || stored.lease_id !== created.leaseId) {
        throw new Error('workflow call lease readback changed generation');
      }
      return validate(stored, true);
    }).immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

function exactPhysicalLeaseMatches(
  identity: PhysicalCrossingIdentity,
  lease: DispatchLeaseRef,
): boolean {
  try {
    const row = openEventLog().prepare(`
      SELECT accepted_task_id, logical_tool_call_id, lease_scope_id, lease_id
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.physicalDispatchId,
    ) as {
      accepted_task_id: string;
      logical_tool_call_id: string;
      lease_scope_id: string | null;
      lease_id: string | null;
    } | undefined;
    return Boolean(
      row
      && isDispatchLeaseCurrent(lease)
      && row.accepted_task_id === identity.acceptedTaskId
      && row.logical_tool_call_id === identity.logicalToolCallId
      && row.lease_scope_id === lease.scopeId
      && row.lease_id === lease.leaseId
    );
  } catch {
    return false;
  }
}

/** Keep the final lease-current check and the workflow I/O CAS inside one
 * database write lock. The activation attestation remains the claim owner;
 * the call lease is the generation that makes that owner current now. */
function claimWorkflowPhysicalIoUnderLease(input: {
  claim: Parameters<typeof claimWorkflowPhysicalIo>[0];
  physicalIdentity: PhysicalCrossingIdentity;
  lease: DispatchLeaseRef;
}): ReturnType<typeof claimWorkflowPhysicalIo> {
  try {
    const db = openEventLog();
    return db.transaction((): ReturnType<typeof claimWorkflowPhysicalIo> => {
      if (!exactPhysicalLeaseMatches(input.physicalIdentity, input.lease)) {
        return { claimed: false, reason: 'lease_not_current' };
      }
      return claimWorkflowPhysicalIo(input.claim);
    }).immediate();
  } catch {
    return { claimed: false, reason: 'lease_not_current' };
  }
}

export type WorkflowCallKernelCrashPoint =
  | 'after_call_lease'
  | 'after_physical_reservation'
  | 'after_io_claim'
  | 'after_physical_settlement'
  | 'after_logical_settlement';

/** Read compatibility name retained for existing tests/imports. */
export type WorkflowReadOnlyCallKernelCrashPoint = WorkflowCallKernelCrashPoint;

let testCrashPoint: WorkflowCallKernelCrashPoint | null = null;

/** Provider-neutral crash seam. It is intentionally test-home only. */
export function setWorkflowCallKernelCrashPointForTests(
  point: WorkflowCallKernelCrashPoint | null,
): void {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') {
    throw new Error('workflow kernel crash points require an isolated test home');
  }
  testCrashPoint = point;
}

/** Process-crash seam for durable-boundary acceptance tests only. */
export function setWorkflowReadOnlyCallKernelCrashPointForTests(
  point: WorkflowReadOnlyCallKernelCrashPoint | null,
): void {
  setWorkflowCallKernelCrashPointForTests(point);
}

function crashForTest(point: WorkflowCallKernelCrashPoint): void {
  if (testCrashPoint !== point) return;
  testCrashPoint = null;
  throw new Error(`forced workflow kernel crash: ${point}`);
}

function poison<Proof extends object>(
  port: WorkflowCallAuthorityPort<Proof>,
  activationId: string,
  reason: string,
): void {
  port.poison({ activationId, reason });
}

/** Terminal root closure and generation revocation commit together. The SQL
 * order still matters (close first, revoke second), while the surrounding
 * IMMEDIATE transaction removes a crash window that could leave a completed
 * workflow with a live provider generation. */
function closeWorkflowAndRevokeLease<Proof extends object>(input: {
  activationId: string;
  outcome: 'completed' | 'failed';
  lease: DispatchLeaseRef;
  port: WorkflowCallAuthorityPort<Proof>;
}): WorkflowCallAuthorityCloseResult {
  try {
    const db = openEventLog();
    return db.transaction((): WorkflowCallAuthorityCloseResult => {
      const closed = input.port.close({
        activationId: input.activationId,
        outcome: input.outcome,
      });
      if (closed.status !== 'closed' && closed.status !== 'replayed') return closed;
      revokeDispatchLease(input.lease);
      const revoked = db.prepare(`
        SELECT revoked_at
          FROM run_dispatch_leases
         WHERE session_id = ? AND scope_id = ? AND lease_id = ?
      `).get(
        input.lease.sessionId,
        input.lease.scopeId,
        input.lease.leaseId,
      ) as { revoked_at: string | null } | undefined;
      if (!revoked?.revoked_at) throw new Error('workflow terminal call lease did not revoke');
      return closed;
    }).immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

function exactPortBinding(input: {
  capabilityId: string;
  args: Record<string, unknown>;
}): {
  capability: RegisteredHostCapability;
  invoke: RegisteredHostCapability['invoke'];
  admitPreparation?: () => void;
  prepareInvocation?: () => Promise<unknown>;
  invokeWithPreparation?: <T>(proof: unknown, work: () => Promise<T>) => Promise<T>;
} | null {
  const capability = peekHostCapabilityCatalogFactory()?.get(input.capabilityId);
  if (!capability?.manifest) return null;
  const port = resolveProductionPortsForManifest(capability.manifest);
  if (!port) return null;
  if (
    Boolean(port.prepareInvocation) !== Boolean(port.invokeWithPreparation)
    || Boolean(port.prepareInvocation) !== Boolean(port.admitPreparation)
  ) return null;
  return {
    capability,
    invoke: port.invoke,
    ...(port.admitPreparation ? { admitPreparation: port.admitPreparation } : {}),
    ...(port.prepareInvocation ? { prepareInvocation: port.prepareInvocation } : {}),
    ...(port.invokeWithPreparation ? { invokeWithPreparation: port.invokeWithPreparation } : {}),
  };
}

/**
 * Execute the one exact call owned by a durable workflow-node activation.
 *
 * `zeroBody` reports the fact operators care about: every blocked result before
 * the physical I/O CAS is guaranteed not to have entered the immutable port.
 * Once the CAS wins, an exception is a real failed body and is settled as such.
 */
async function executeWorkflowCallKernel<Proof extends object>(input: {
  activationId: string;
  invocationPlan: unknown;
  args: Record<string, unknown>;
  /** Cancellation is honored only before the provider-I/O CAS. After the CAS
   * wins, the kernel must observe and settle the body instead of abandoning an
  * outcome-unknown crossing. GraphNodeCapabilityInvoke has no signal today. */
  signal?: AbortSignal;
}, port: WorkflowCallAuthorityPort<Proof>): Promise<ExecuteWorkflowCallKernelResult> {
  const current = port.read(input.activationId);
  if (current.status !== 'ok') {
    return {
      status: 'blocked',
      reason: current.reason,
      zeroBody: true,
      activationId: input.activationId,
    };
  }
  const workflow = current.authority.workflow;
  if (!workflow || current.authority.authorityKind !== port.authorityKind) {
    return {
      status: 'blocked',
      reason: `activation is not owned by ${port.authorityKind} authority`,
      zeroBody: true,
      activationId: input.activationId,
    };
  }
  const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
  if (
    !parsed.ok
    || parsed.plan.bindingDigest !== workflow.invocationPlanDigest
    || parsed.plan.binding.effect !== port.effect
  ) {
    if (current.authority.state === 'open') {
      poison(port, input.activationId, 'workflow invocation plan is malformed or differs at execution');
    }
    return {
      status: 'blocked',
      reason: 'workflow invocation plan is malformed or differs from its activation',
      zeroBody: true,
      activationId: input.activationId,
    };
  }
  const recoveryMaterial = durableLogicalCallRecoveryMaterial(
    workflow.authorityRootId,
    parsed.plan.binding.operationId,
    input.args,
  );
  if (!recoveryMaterial) {
    if (current.authority.state === 'open') {
      poison(port, input.activationId, 'workflow invocation arguments are not contractible');
    }
    return {
      status: 'blocked',
      reason: 'workflow invocation arguments are not contractible',
      zeroBody: true,
      activationId: input.activationId,
    };
  }

  // A crash can leave the logical settlement durable while the activation is
  // still open. Adopt only an exact successful read, redeem its retained raw
  // bytes, close the root, and then revoke the same physical generation. No
  // live registry lookup, logical re-admission, or provider crossing is needed.
  const durable = redeemDurableLogicalCallSettlementForHost({
    sessionId: current.authority.identity.sessionId,
    sourceUserSeq: current.authority.identity.sourceUserSeq,
    acceptedTaskId: current.authority.identity.acceptedTaskId,
    logicalToolCallId: workflow.logicalCallId,
  });
  if (durable.status !== 'missing') {
    if (durable.status !== 'ok') {
      return {
        status: 'blocked',
        reason: `workflow logical settlement is ${durable.status}: ${durable.reason}`,
        zeroBody: false,
        activationId: input.activationId,
      };
    }
    const businessCrossings = durable.status === 'ok'
      ? durable.settlement.crossings.filter((crossing) => crossing.relation !== 'probe')
      : [];
    const preparationCrossings = durable.status === 'ok'
      ? durable.settlement.crossings.filter((crossing) => crossing.relation === 'probe')
      : [];
    if (
      durable.settlement.toolName !== recoveryMaterial.toolName
      || durable.settlement.argumentDigest !== recoveryMaterial.argumentDigest
      || durable.settlement.executionKind !== 'provider_execution'
      || durable.settlement.recovery.businessCall !== true
      || durable.settlement.recovery.mutating !== port.mutating
      || durable.settlement.recovery.requirementId !== parsed.plan.requirementId
      || !['succeeded', 'empty_result'].includes(durable.settlement.outcome.kind)
      || durable.settlement.physicalCrossingCount !== durable.settlement.crossings.length
      || durable.settlement.hostCrossingCount !== 0
      || businessCrossings.length !== 1
      || businessCrossings[0]?.terminalState !== 'returned'
      || preparationCrossings.some((crossing) =>
        crossing.terminalState !== 'returned' && crossing.terminalState !== 'threw')
    ) {
      if (current.authority.state === 'open') {
        poison(port, input.activationId, 'workflow logical settlement conflicts with its activation contract');
      }
      return {
        status: 'blocked',
        reason: 'workflow logical settlement conflicts with its activation contract',
        zeroBody: false,
        activationId: input.activationId,
      };
    }
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: current.authority.identity.sessionId,
      sourceUserSeq: current.authority.identity.sourceUserSeq,
      acceptedTaskId: current.authority.identity.acceptedTaskId,
      logicalToolCallId: workflow.logicalCallId,
    });
    if (
      redeemed.status !== 'ok'
      || redeemed.value.toolName !== recoveryMaterial.toolName
      || redeemed.value.outcomeKind !== durable.settlement.outcome.kind
      || redeemed.value.resultHandleId !== durable.settlement.resultHandleId
    ) {
      const reason = redeemed.status === 'ok'
        ? 'redeemed workflow result conflicts with its settlement'
        : `workflow result is ${redeemed.status}: ${redeemed.reason}`;
      if (current.authority.state === 'open') poison(port, input.activationId, reason);
      return {
        status: 'blocked',
        reason,
        zeroBody: false,
        activationId: input.activationId,
      };
    }

    if (current.authority.state === 'open') {
      const lease = selectWorkflowCallLease({
        sessionId: current.authority.identity.sessionId,
        sourceUserSeq: current.authority.identity.sourceUserSeq,
        activationId: workflow.activationId,
        activationDigest: workflow.activationDigest,
        authorityRootId: workflow.authorityRootId,
        logicalCallId: workflow.logicalCallId,
        toolName: recoveryMaterial.toolName,
        args: input.args,
        effect: port.effect,
        allowCreate: false,
      });
      if (lease.status !== 'ok') {
        return {
          status: 'blocked',
          reason: `settled workflow call lease is ${lease.status}: ${lease.reason}`,
          zeroBody: false,
          activationId: input.activationId,
        };
      }
      const crossing = businessCrossings[0]!;
      const crossingIdentity: PhysicalCrossingIdentity = {
        sessionId: current.authority.identity.sessionId,
        sourceUserSeq: current.authority.identity.sourceUserSeq,
        acceptedTaskId: workflow.authorityRootId,
        logicalToolCallId: workflow.logicalCallId,
        physicalDispatchId: crossing.physicalDispatchId,
        ordinal: crossing.ordinal,
        relation: crossing.relation,
        ...(crossing.retryOf ? { retryOf: crossing.retryOf } : {}),
      };
      if (!exactPhysicalLeaseMatches(crossingIdentity, lease.lease)) {
        return {
          status: 'blocked',
          reason: 'settled workflow crossing does not name its exact current call lease',
          zeroBody: false,
          activationId: input.activationId,
        };
      }
      const closed = closeWorkflowAndRevokeLease({
        activationId: input.activationId,
        outcome: 'completed',
        lease: lease.lease,
        port,
      });
      if (closed.status !== 'closed' && closed.status !== 'replayed') {
        return {
          status: 'blocked',
          reason: 'reason' in closed ? closed.reason : 'workflow terminal closure did not commit',
          zeroBody: false,
          activationId: input.activationId,
        };
      }
    } else if (
      current.authority.state !== 'closed'
      || current.authority.closeReason !== 'workflow_completed'
    ) {
      return {
        status: 'blocked',
        reason: 'workflow successful settlement has a non-completed authority root',
        zeroBody: false,
        activationId: input.activationId,
      };
    }
    return {
      status: 'replayed',
      activationId: workflow.activationId,
      authorityRootId: workflow.authorityRootId,
      logicalCallId: workflow.logicalCallId,
      result: redeemed.value.rawPayload,
      resultHandleId: redeemed.value.resultHandleId,
    };
  }
  if (current.authority.state === 'closed') {
    return {
      status: 'blocked',
      reason: 'closed workflow call has no redeemable logical settlement',
      zeroBody: true,
      activationId: input.activationId,
    };
  }
  if (input.signal?.aborted) {
    port.close({ activationId: input.activationId, outcome: 'cancelled' });
    return {
      status: 'blocked',
      reason: `${port.operationLabel} was cancelled before admission`,
      zeroBody: true,
      activationId: input.activationId,
    };
  }
  const minted = port.mint(input);
  if (minted.status !== 'minted') {
    if (minted.status === 'conflict') poison(port, input.activationId, minted.reason);
    return {
      status: 'blocked',
      reason: minted.reason,
      zeroBody: true,
      activationId: input.activationId,
    };
  }

  // Resolve the immutable registered port after minting and immediately before
  // the synchronous reservation+claim edge. No await occurs between these
  // facts, so registry drift cannot slip into the body after admission.
  const exactPort = exactPortBinding({
    capabilityId: parsed.plan.binding.capabilityId,
    args: input.args,
  });
  if (!exactPort) {
    poison(port, input.activationId, 'workflow exact immutable invoke port disappeared before reservation');
    return {
      status: 'blocked',
      reason: 'workflow exact immutable invoke port is unavailable',
      zeroBody: true,
      activationId: input.activationId,
    };
  }
  if (exactPort.admitPreparation) {
    try {
      exactPort.admitPreparation();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      poison(port, input.activationId, `workflow provider preparation refused locally: ${reason}`);
      return {
        status: 'blocked',
        reason,
        zeroBody: true,
        activationId: input.activationId,
      };
    }
  }

  const dispatchId = physicalDispatchId({
    activationDigest: minted.ref.activationDigest,
    logicalCallId: minted.ref.logicalCallId,
    toolName: minted.toolName,
    argumentDigest: minted.argumentDigest,
  });
  const identity: PhysicalCrossingIdentity = {
    sessionId: minted.ref.sessionId,
    sourceUserSeq: minted.ref.sourceEventSeq,
    acceptedTaskId: minted.ref.authorityRootId,
    logicalToolCallId: minted.ref.logicalCallId,
    physicalDispatchId: dispatchId,
    ordinal: 0,
  };

  if (input.signal?.aborted) {
    port.close({ activationId: input.activationId, outcome: 'cancelled' });
    return {
      status: 'blocked',
      reason: `${port.operationLabel} was cancelled before physical reservation`,
      zeroBody: true,
      activationId: input.activationId,
    };
  }

  return port.withAttestation(minted.proof, async () => {
    const admitted = admitLogicalCall({
      identity: {
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedTaskId: identity.acceptedTaskId,
        logicalToolCallId: identity.logicalToolCallId,
      },
      tool: minted.toolName,
      args: input.args,
    });
    if (admitted.status !== 'inserted' && admitted.status !== 'replayed') {
      return {
        status: 'blocked',
        reason: `workflow logical admission refused: ${admitted.reason}`,
        zeroBody: true,
        activationId: input.activationId,
      };
    }
    const selectedLease = selectWorkflowCallLease({
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      activationId: minted.ref.activationId,
      activationDigest: minted.ref.activationDigest,
      authorityRootId: identity.acceptedTaskId,
      logicalCallId: identity.logicalToolCallId,
      toolName: minted.toolName,
      args: input.args,
      effect: port.effect,
      allowCreate: true,
    });
    if (selectedLease.status !== 'ok') {
      poison(port, input.activationId, `workflow call lease refused: ${selectedLease.reason}`);
      return {
        status: 'blocked',
        reason: selectedLease.reason,
        zeroBody: true,
        activationId: input.activationId,
      };
    }
    crashForTest('after_call_lease');

    return runWithDispatchLease(selectedLease.lease, async () => {
      const settleFailedProviderCrossing = (
        crossing: PhysicalCrossingIdentity,
        error: unknown,
        businessCall: boolean,
      ): ExecuteWorkflowCallKernelResult => {
        const physical = settlePhysicalDispatch({
          identity: crossing,
          tool: minted.toolName,
          outcome: 'threw',
          turn: 0,
          dispatchLease: selectedLease.lease,
        });
        const reason = String(error instanceof Error ? error.message : error)
          .replace(/\s+/g, ' ').trim().slice(0, 160) || `${port.operationLabel} invocation threw`;
        const logical = physical.status === 'inserted' || physical.status === 'replayed'
          ? commitLogicalCallSettlement({
              identity: {
                sessionId: identity.sessionId,
                sourceUserSeq: identity.sourceUserSeq,
                acceptedTaskId: identity.acceptedTaskId,
                logicalToolCallId: identity.logicalToolCallId,
              },
              contract: { toolName: minted.toolName, args: input.args },
              execution: { kind: 'provider_execution' },
              outcome: classifyAttemptOutcome({ executionFailed: true }),
              recovery: {
                businessCall,
                mutating: port.mutating,
                requirementId: parsed.plan.requirementId,
              },
              observer: { lane: 'agents_runner', callId: identity.logicalToolCallId, turn: 0 },
            })
          : null;
        if (!logical || (logical.status !== 'committed' && logical.status !== 'replayed')) {
          const settlementReason = logical && 'reason' in logical
            ? logical.reason
            : 'reason' in physical ? physical.reason : 'settlement did not commit';
          poison(port, input.activationId, `workflow failed-call settlement refused: ${settlementReason}`);
        } else {
          const closed = closeWorkflowAndRevokeLease({
            activationId: input.activationId,
            outcome: 'failed',
            lease: selectedLease.lease,
            port,
          });
          if (closed.status !== 'closed' && closed.status !== 'replayed') {
            const closeReason = 'reason' in closed
              ? closed.reason
              : 'workflow failed-call terminal closure did not commit';
            poison(port, input.activationId, `workflow failed-call terminal closure refused: ${closeReason}`);
          }
        }
        return {
          status: 'failed',
          reason,
          zeroBody: !businessCall,
          activationId: input.activationId,
        };
      };

      let preparedProof: unknown;
      let preparationReady = false;
      if (exactPort.prepareInvocation) {
        const preparationSequence = nextWorkflowPreparationSequence({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          logicalCallId: identity.logicalToolCallId,
        });
        const preparationIdentity: PhysicalCrossingIdentity = {
          ...identity,
          physicalDispatchId: preparationPhysicalDispatchId({
            activationDigest: minted.ref.activationDigest,
            logicalCallId: minted.ref.logicalCallId,
            toolName: minted.toolName,
            argumentDigest: minted.argumentDigest,
            sequence: preparationSequence,
          }),
        };
        const preparation = beginWorkflowPreparationPhysicalDispatch({
          identity: preparationIdentity,
          tool: minted.toolName,
          args: input.args,
          dispatchLease: selectedLease.lease,
          activationId: minted.ref.activationId,
          activationDigest: minted.ref.activationDigest,
          authorityDigest: minted.ref.authorityDigest,
          authorityRevision: minted.ref.authorityRevision,
        });
        if (preparation.status !== 'inserted') {
          return {
            status: 'blocked',
            reason: preparation.status === 'replayed'
              ? 'prior preparation crossing is already owned; retry under a fresh workflow invocation'
              : preparation.reason,
            zeroBody: true,
            activationId: input.activationId,
          };
        }
        if (!exactPhysicalLeaseMatches(preparation.identity, selectedLease.lease)) {
          poison(port, input.activationId, 'workflow preparation reservation has a foreign or stale call lease');
          return {
            status: 'blocked',
            reason: 'workflow preparation reservation has a foreign or stale call lease',
            zeroBody: true,
            activationId: input.activationId,
          };
        }
        const preparationClaim = claimWorkflowPhysicalIoUnderLease({
          physicalIdentity: preparation.identity,
          lease: selectedLease.lease,
          claim: {
            identity: {
              sessionId: identity.sessionId,
              sourceUserSeq: identity.sourceUserSeq,
              physicalDispatchId: preparation.identity.physicalDispatchId,
              authorityRootId: identity.acceptedTaskId,
              logicalCallId: identity.logicalToolCallId,
            },
            activationId: minted.ref.activationId,
            activationDigest: minted.ref.activationDigest,
            authorityDigest: minted.ref.authorityDigest,
            authorityRevision: minted.ref.authorityRevision,
            toolName: minted.toolName,
          },
        });
        if (!preparationClaim.claimed) {
          if (preparationClaim.reason !== 'already_claimed') {
            poison(port, input.activationId, `workflow preparation I/O claim refused: ${preparationClaim.reason}`);
          }
          return {
            status: 'blocked',
            reason: preparationClaim.reason === 'already_claimed'
              ? 'prior preparation crossing is already in flight or terminal'
              : `workflow preparation I/O claim refused: ${preparationClaim.reason}`,
            zeroBody: true,
            activationId: input.activationId,
          };
        }
        try {
          preparedProof = await exactPort.prepareInvocation();
        } catch (error) {
          return settleFailedProviderCrossing(preparation.identity, error, false);
        }
        const preparedSettlement = settlePhysicalDispatch({
          identity: preparation.identity,
          tool: minted.toolName,
          outcome: 'returned',
          turn: 0,
          dispatchLease: selectedLease.lease,
        });
        if (preparedSettlement.status !== 'inserted' && preparedSettlement.status !== 'replayed') {
          poison(port, input.activationId, `workflow preparation settlement refused: ${preparedSettlement.reason}`);
          return {
            status: 'failed',
            reason: preparedSettlement.reason,
            zeroBody: true,
            activationId: input.activationId,
          };
        }
        preparationReady = true;
      }

      const begun = beginPhysicalDispatch({
        identity,
        tool: minted.toolName,
        args: input.args,
        dispatchLease: selectedLease.lease,
      });
      if (begun.status !== 'inserted' && begun.status !== 'replayed') {
        poison(port, input.activationId, `workflow physical reservation refused: ${begun.reason}`);
        return {
          status: 'blocked',
          reason: begun.reason,
          zeroBody: true,
          activationId: input.activationId,
        };
      }
      if (!exactPhysicalLeaseMatches(begun.identity, selectedLease.lease)) {
        poison(port, input.activationId, 'workflow physical reservation has a foreign or stale call lease');
        return {
          status: 'blocked',
          reason: 'workflow physical reservation has a foreign or stale call lease',
          zeroBody: true,
          activationId: input.activationId,
        };
      }
      crashForTest('after_physical_reservation');
      const claim = claimWorkflowPhysicalIoUnderLease({
        physicalIdentity: begun.identity,
        lease: selectedLease.lease,
        claim: {
          identity: {
            sessionId: identity.sessionId,
            sourceUserSeq: identity.sourceUserSeq,
            physicalDispatchId: identity.physicalDispatchId,
            authorityRootId: identity.acceptedTaskId,
            logicalCallId: identity.logicalToolCallId,
          },
          activationId: minted.ref.activationId,
          activationDigest: minted.ref.activationDigest,
          authorityDigest: minted.ref.authorityDigest,
          authorityRevision: minted.ref.authorityRevision,
          toolName: minted.toolName,
        },
      });
      if (!claim.claimed) {
        // A concurrent/restarted reentry can observe the winner's durable I/O
        // claim. It must not redispatch, poison the shared root, or revoke the
        // exact lease while the owning body may still settle beneath it.
        if (claim.reason !== 'already_claimed') {
          poison(port, input.activationId, `workflow physical I/O claim refused: ${claim.reason}`);
        }
        return {
          status: 'blocked',
          reason: claim.reason === 'already_claimed'
            ? 'prior_crossing_unknown_no_redispatch'
            : `workflow physical I/O claim refused: ${claim.reason}`,
          // already_claimed means this reentry did not call, but the durable
          // occurrence did cross (or crashed at that edge). Never claim global
          // zero-body truth in that recovery state.
          zeroBody: claim.reason !== 'already_claimed',
          activationId: input.activationId,
        };
      }
      crashForTest('after_io_claim');

      let result: unknown;
      try {
        const invokeBusiness = () => exactPort.invoke({
            nodeId: workflow.nodeId,
            role: parsed.plan.requirementId,
            payload: structuredClone(input.args),
            identity: {
              sessionId: identity.sessionId,
              sourceUserSeq: identity.sourceUserSeq,
              acceptedTaskId: identity.acceptedTaskId,
            },
            binding: {
              capabilityId: exactPort.capability.capabilityId,
              toolName: exactPort.capability.toolName,
              schemaVersion: exactPort.capability.schemaVersion,
              schemaDigest: exactPort.capability.schemaDigest,
              args: structuredClone(input.args),
              account: exactPort.capability.account,
              effect: exactPort.capability.effect,
              destination: exactPort.capability.destination,
              manifestDigest: exactPort.capability.manifestDigest,
              providerKind: exactPort.capability.providerKind,
              liveFingerprint: exactPort.capability.liveFingerprint,
              delegatedFrom: exactPort.capability.delegatedFrom,
              manifest: exactPort.capability.manifest,
              reconcile: exactPort.capability.reconcile,
              invoke: exactPort.invoke,
            },
          });
        if (exactPort.invokeWithPreparation) {
          if (!preparationReady) {
            throw new Error('workflow exact port preparation did not become ready');
          }
          result = await exactPort.invokeWithPreparation(preparedProof, invokeBusiness);
        } else {
          result = await invokeBusiness();
        }
      } catch (error) {
        return settleFailedProviderCrossing(begun.identity, error, true);
      }

      const physical = settlePhysicalDispatch({
        identity: begun.identity,
        tool: minted.toolName,
        outcome: 'returned',
        turn: 0,
        dispatchLease: selectedLease.lease,
      });
      if (physical.status !== 'inserted' && physical.status !== 'replayed') {
        poison(port, input.activationId, `workflow returned-call physical settlement refused: ${physical.reason}`);
        return {
          status: 'failed',
          reason: physical.reason,
          zeroBody: false,
          activationId: input.activationId,
        };
      }
      crashForTest('after_physical_settlement');
      const logical = commitLogicalCallSettlement({
        identity: {
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedTaskId: identity.acceptedTaskId,
          logicalToolCallId: identity.logicalToolCallId,
        },
        contract: { toolName: minted.toolName, args: input.args },
        execution: { kind: 'provider_execution' },
        result: { payload: result },
        outcome: classifyAttemptOutcome({ envelopeSuccessful: true }),
        recovery: {
          businessCall: true,
          mutating: port.mutating,
          requirementId: parsed.plan.requirementId,
        },
        observer: { lane: 'agents_runner', callId: identity.logicalToolCallId, turn: 0 },
      });
      if (logical.status !== 'committed' && logical.status !== 'replayed') {
        poison(port, input.activationId, `workflow returned-call logical settlement refused: ${logical.reason}`);
        return {
          status: 'failed',
          reason: logical.reason,
          zeroBody: false,
          activationId: input.activationId,
        };
      }
      crashForTest('after_logical_settlement');
      const closed = closeWorkflowAndRevokeLease({
        activationId: input.activationId,
        outcome: 'completed',
        lease: selectedLease.lease,
        port,
      });
      if (closed.status !== 'closed' && closed.status !== 'replayed') {
        const closeReason = 'reason' in closed ? closed.reason : 'workflow terminal closure did not commit';
        poison(port, input.activationId, `workflow terminal closure refused: ${closeReason}`);
        return {
          status: 'failed',
          reason: closeReason,
          zeroBody: false,
          activationId: input.activationId,
        };
      }
      return {
        status: 'completed',
        activationId: input.activationId,
        authorityRootId: identity.acceptedTaskId,
        logicalCallId: identity.logicalToolCallId,
        physicalDispatchId: identity.physicalDispatchId,
        result,
      };
    });
  });
}

/**
 * Existing workflow_v1_read_only entry point. The provider-neutral kernel is
 * deliberately not exported with an injectable authority port: only a
 * module-owned durable authority adapter may reach physical I/O.
 */
export async function executeWorkflowReadOnlyCall(input: {
  activationId: string;
  invocationPlan: unknown;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ExecuteWorkflowReadOnlyCallResult> {
  return executeWorkflowCallKernel(input, READ_ONLY_WORKFLOW_CALL_AUTHORITY_PORT);
}

/** workflow_v3 adapter over the same logical/physical/claim/settlement kernel.
 * The selected effect is read only from the exact content-addressed plan; no
 * caller-supplied port or effect override can enter the kernel. */
export async function executeWorkflowV3Call(input: {
  activationId: string;
  invocationPlan: unknown;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ExecuteWorkflowCallKernelResult> {
  const parsed = parseWorkflowNodeInvocationPlan(input.invocationPlan);
  if (
    !parsed.ok
    || parsed.plan.binding.effect === 'read'
    || parsed.plan.binding.effect === 'compute'
  ) {
    return {
      status: 'blocked',
      reason: 'workflow v3 execution requires an exact non-read invocation plan',
      zeroBody: true,
      activationId: input.activationId,
    };
  }
  return executeWorkflowCallKernel(input, workflowV3CallAuthorityPort(parsed.plan.binding.effect));
}

export type AcquireWorkflowReadOnlyOperationAuthorityResult =
  | { status: 'armed'; activationId: string; invocationPlan: unknown }
  | { status: 'refused'; reason: string };

function planValueTypeOf(value: unknown): WorkflowNodeInvocationValueTypeV1 | null {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return null;
}

/**
 * ADDITIVE mint seam: activate this kernel for one exact catalog-registered
 * READ operation and hand back the durable activation address. Reads that live
 * outside the typed workflow lane (Workspace data refreshes) use it to redeem
 * the same shared durable kernel instead of a raw provider gateway.
 *
 * The returned address grants nothing by itself. Execution still reopens the
 * activation and, at attestation time, re-verifies the live catalog binding,
 * the immutable production invoke port, and a fresh independent observation —
 * so a capability that is stale, retired, or unproven refuses at redemption
 * exactly as it would for a typed workflow node.
 */
export function acquireWorkflowReadOnlyOperationAuthority(input: {
  sessionId: string;
  workflowId: string;
  runId: string;
  runOccurrenceId: string;
  nodeId: string;
  requirementId: string;
  logicalCapabilityId: string;
  operationId: string;
  args: Record<string, unknown>;
}): AcquireWorkflowReadOnlyOperationAuthorityResult {
  const factory = peekHostCapabilityCatalogFactory();
  if (!factory) {
    return { status: 'refused', reason: 'no host capability catalog is installed' };
  }
  const candidates: CanonicalCatalogIdentityV1[] = [];
  for (const entry of factory.snapshot()) {
    if (!entry.manifest || !currentCapabilityManifest(entry.manifest)) continue;
    const identity = canonicalCatalogIdentityOf(entry);
    if (!identity || identity.operationId !== input.operationId || identity.effect !== 'read') continue;
    candidates.push(identity);
  }
  if (candidates.length === 0) {
    return {
      status: 'refused',
      reason: `no current read capability is registered for "${input.operationId}"`,
    };
  }
  const distinct = new Set(candidates.map((identity) => identity.capabilityId));
  if (distinct.size > 1) {
    return {
      status: 'refused',
      reason: `${distinct.size} read capabilities are registered for "${input.operationId}"; the binding is ambiguous`,
    };
  }
  const identity = candidates[0]!;

  const argumentContract: Record<string, WorkflowNodeArgumentBindingV1> = {};
  for (const [key, value] of Object.entries(input.args)) {
    const type = planValueTypeOf(value);
    if (!type) {
      return {
        status: 'refused',
        reason: `argument "${key}" is not a plan-representable JSON value`,
      };
    }
    argumentContract[key] = {
      source: { kind: 'workflow_input', key },
      required: true,
      type,
    };
  }

  let invocationPlan: unknown;
  let invocationPlanDigest: string;
  try {
    const plan = createWorkflowNodeInvocationPlan({
      requirementId: input.requirementId,
      logicalCapabilityId: input.logicalCapabilityId,
      binding: {
        capabilityId: identity.capabilityId,
        manifestId: identity.manifestId,
        manifestDigest: identity.manifestDigest,
        operationId: identity.operationId,
        operationVersion: identity.schemaVersion,
        schemaDigest: identity.schemaDigest,
        providerVersion: identity.providerVersion,
        liveFingerprint: identity.liveFingerprint,
        accountId: identity.account,
        effect: 'read',
        invokePortId: identity.invokePortId,
        argumentCompiler: {
          id: identity.argumentCompiler.id,
          version: identity.argumentCompiler.version,
        },
      },
      arguments: argumentContract,
      // The caller treats the settled provider bytes as one opaque terminal
      // observation; it does not redeem per-path evidence the way the typed
      // executor lane does, so the contract stays minimal and truthful.
      evidence: { requiredPaths: [], nonEmptyPaths: [], minItems: {} },
      completeness: { kind: 'terminal_result', evidencePaths: ['data'] },
      continuation: { kind: 'none' },
    });
    invocationPlan = plan;
    invocationPlanDigest = plan.bindingDigest;
  } catch (error) {
    return { status: 'refused', reason: boundedReason(error) };
  }

  const armed = armWorkflowReadOnlyCallAuthority({
    sessionId: input.sessionId,
    workflowId: input.workflowId,
    workflowRevision: 1,
    workflowDigest: sha256(JSON.stringify({
      version: 1,
      workflowId: input.workflowId,
      operationId: input.operationId,
      invocationPlanDigest,
    })),
    runId: input.runId,
    runOccurrenceId: input.runOccurrenceId,
    nodeId: input.nodeId,
    nodeAttempt: 1,
    invocationPlanDigest,
    bindingSnapshotDigest: sha256(JSON.stringify({ version: 1, identity })),
    controlDigest: sha256(JSON.stringify({
      version: 1,
      requirementId: input.requirementId,
      logicalCapabilityId: input.logicalCapabilityId,
    })),
    logicalCallId: `logical:${input.runId}:${input.nodeId}`,
  });
  if ('reason' in armed) return { status: 'refused', reason: armed.reason };
  if (armed.status === 'existing_closed') {
    return { status: 'refused', reason: 'this exact workflow node attempt already closed its activation' };
  }
  return { status: 'armed', activationId: armed.ref.activationId, invocationPlan };
}
