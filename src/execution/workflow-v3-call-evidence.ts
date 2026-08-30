import { createHash } from 'node:crypto';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  readWorkflowV3CallAuthority,
} from '../runtime/harness/accepted-turn-call-authority.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { durableLogicalCallContract } from '../runtime/harness/logical-call-contract.js';
import { redeemDurableLogicalCallSettlementForHost } from '../runtime/harness/logical-call-settlement-store.js';
import { redeemSuccessfulSettlementResultForHost } from '../runtime/harness/result-handle.js';
import {
  projectWorkflowCallCommitOutput,
  type WorkflowCallCommitEvidenceV1,
  type WorkflowCallCommitOutputV1,
} from './workflow-call-receipts.js';

export interface WorkflowV3CallSlot {
  workflowSlug: string;
  runId: string;
  stepId: string;
}

interface WorkflowV3CallRow {
  activation_id: string;
  activation_digest: string;
  authority_root_id: string;
  session_id: string;
  source_event_seq: number;
  logical_call_id: string;
  authority_binding_digest: string;
  requirement_id: string;
  effect: 'host_only' | 'local_write' | 'external_write' | 'admin';
  canonical_argument_digest: string;
  operation_id: string;
  schema_digest: string;
  manifest_digest: string;
}

export type WorkflowV3CallInspection =
  | { status: 'missing' }
  | { status: 'in_flight'; row: WorkflowV3CallRow; providerCrossed: boolean }
  | { status: 'committed'; row: WorkflowV3CallRow; providerResultDigest: string }
  | { status: 'uncertain'; row: WorkflowV3CallRow }
  | { status: 'failed'; row: WorkflowV3CallRow; providerCrossed: boolean }
  | { status: 'conflict'; reason: string; row?: WorkflowV3CallRow };

function exactRows(slot: WorkflowV3CallSlot): WorkflowV3CallRow[] {
  if (!slot.workflowSlug.trim() || !slot.runId.trim() || !slot.stepId.trim()) {
    throw new Error('workflow-v3 call slot identity is incomplete');
  }
  return openEventLog().prepare(`
    SELECT activation.activation_id,
           activation.activation_digest,
           activation.authority_root_id,
           activation.session_id,
           activation.source_event_seq,
           activation.logical_call_id,
           binding.authority_binding_digest,
           binding.requirement_id,
           binding.effect,
           binding.canonical_argument_digest,
           binding.operation_id,
           binding.schema_digest,
           binding.manifest_digest
      FROM workflow_node_invocation_activations activation
      JOIN workflow_v3_call_activation_bindings binding USING (activation_id)
     WHERE activation.workflow_id = ?
       AND activation.run_id = ?
       AND activation.node_id = ?
     ORDER BY activation.activated_at, activation.activation_id
  `).all(slot.workflowSlug, slot.runId, slot.stepId) as WorkflowV3CallRow[];
}

function inspectRow(
  row: WorkflowV3CallRow,
  expected?: { tool: string; args: Record<string, unknown> },
): WorkflowV3CallInspection {
  const authority = readWorkflowV3CallAuthority(row.activation_id);
  if (authority.status !== 'ok' || !authority.authority.workflow) {
    return {
      status: 'conflict',
      reason: authority.status === 'ok'
        ? 'workflow-v3 authority lost its workflow lineage'
        : `workflow-v3 authority is ${authority.status}: ${authority.reason}`,
      row,
    };
  }
  const workflow = authority.authority.workflow;
  if (
    workflow.activationId !== row.activation_id
    || workflow.activationDigest !== row.activation_digest
    || workflow.authorityRootId !== row.authority_root_id
    || workflow.logicalCallId !== row.logical_call_id
  ) {
    return { status: 'conflict', reason: 'workflow-v3 activation and authority lineage disagree', row };
  }
  if (expected) {
    const contract = durableLogicalCallContract(row.authority_root_id, expected.tool, expected.args);
    if (!contract) return { status: 'conflict', reason: 'expected workflow-v3 call is not contractible', row };
    if (row.operation_id !== expected.tool.trim()) {
      return { status: 'conflict', reason: 'workflow-v3 operation differs from the expected tool', row };
    }
  }
  const settlement = redeemDurableLogicalCallSettlementForHost({
    sessionId: row.session_id,
    sourceUserSeq: row.source_event_seq,
    acceptedTaskId: row.authority_root_id,
    logicalToolCallId: row.logical_call_id,
  });
  const crossings = openEventLog().prepare(`
    SELECT state, relation, execution_site
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).all(row.session_id, row.source_event_seq, row.logical_call_id) as Array<{
    state: string;
    relation: string;
    execution_site: string | null;
  }>;
  const businessCrossings = crossings.filter((crossing) =>
    crossing.relation !== 'probe' && crossing.execution_site === null);
  const providerCrossed = businessCrossings.length > 0;
  if (settlement.status === 'missing') {
    return authority.authority.state === 'open'
      ? { status: 'in_flight', row, providerCrossed }
      : { status: 'conflict', reason: 'closed workflow-v3 authority has no logical settlement', row };
  }
  if (settlement.status !== 'ok') {
    return {
      status: 'conflict',
      reason: `workflow-v3 logical settlement is ${settlement.status}: ${settlement.reason}`,
      row,
    };
  }
  const durable = settlement.settlement;
  const expectedContract = expected
    ? durableLogicalCallContract(row.authority_root_id, expected.tool, expected.args)
    : null;
  if (
    durable.identity.acceptedTaskId !== row.authority_root_id
    || durable.identity.logicalToolCallId !== row.logical_call_id
    || durable.executionKind !== 'provider_execution'
    || durable.recovery.businessCall !== true
    || durable.recovery.mutating !== (row.effect !== 'host_only')
    || durable.recovery.requirementId !== row.requirement_id
    || (expectedContract && (
      durable.toolName !== expectedContract.toolName
      || durable.argumentDigest !== expectedContract.argumentDigest
    ))
  ) {
    return { status: 'conflict', reason: 'workflow-v3 settlement differs from its activation binding', row };
  }
  if (
    durable.outcome.kind === 'uncertain_write'
    && row.effect !== 'host_only'
    && durable.outcome.directive.requiresReconciliation
    && providerCrossed
  ) return { status: 'uncertain', row };
  if (!['succeeded', 'empty_result'].includes(durable.outcome.kind)) {
    return { status: 'failed', row, providerCrossed };
  }
  if (
    authority.authority.state !== 'closed'
    || authority.authority.closeReason !== 'workflow_completed'
    || businessCrossings.length !== 1
    || businessCrossings[0]?.state !== 'returned'
  ) {
    return { status: 'conflict', reason: 'successful workflow-v3 settlement lacks one closed returned provider crossing', row };
  }
  const result = redeemSuccessfulSettlementResultForHost({
    sessionId: row.session_id,
    sourceUserSeq: row.source_event_seq,
    acceptedTaskId: row.authority_root_id,
    logicalToolCallId: row.logical_call_id,
  });
  if (
    result.status !== 'ok'
    || result.value.resultHandleId !== durable.resultHandleId
    || result.value.toolName !== durable.toolName
  ) {
    return {
      status: 'conflict',
      reason: result.status === 'ok'
        ? 'workflow-v3 retained result differs from its logical settlement'
        : `workflow-v3 retained result is ${result.status}: ${result.reason}`,
      row,
    };
  }
  return { status: 'committed', row, providerResultDigest: result.value.rawPayloadSha256 };
}

export function inspectWorkflowV3Call(
  slot: WorkflowV3CallSlot,
  expected?: { tool: string; args: Record<string, unknown> },
): WorkflowV3CallInspection {
  try {
    const rows = exactRows(slot);
    if (rows.length === 0) return { status: 'missing' };
    if (rows.length !== 1) {
      return { status: 'conflict', reason: `workflow-v3 call slot has ${rows.length} activations` };
    }
    return inspectRow(rows[0]!, expected);
  } catch (error) {
    return {
      status: 'conflict',
      reason: error instanceof Error ? error.message : 'workflow-v3 call evidence is unreadable',
    };
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(closedCanonicalJson(value), 'utf8').digest('hex');
}

function committedOutput(
  slot: WorkflowV3CallSlot,
  expectedTool: string,
  expectedArgs: Record<string, unknown>,
): { ok: true; output: WorkflowCallCommitOutputV1 } | { ok: false; missing: boolean; reason: string } {
  const inspected = inspectWorkflowV3Call(slot, { tool: expectedTool, args: expectedArgs });
  if (inspected.status !== 'committed') {
    return {
      ok: false,
      missing: inspected.status === 'missing',
      reason: inspected.status === 'missing'
        ? 'workflow-v3 call activation is missing'
        : inspected.status === 'conflict' ? inspected.reason
          : `workflow-v3 call is ${inspected.status}`,
    };
  }
  const row = inspected.row;
  const receiptDigest = sha256({
    domain: 'workflow-v3-call-commit-receipt',
    version: 1,
    activationId: row.activation_id,
    activationDigest: row.activation_digest,
    authorityRootId: row.authority_root_id,
    authorityBindingDigest: row.authority_binding_digest,
    manifestDigest: row.manifest_digest,
    logicalCallId: row.logical_call_id,
    providerResultDigest: inspected.providerResultDigest,
  });
  try {
    return {
      ok: true,
      output: projectWorkflowCallCommitOutput({
        mutationReceiptId: `workflow-v3-call:v1:${receiptDigest}`,
        canonicalTool: expectedTool,
        dispatchSchemaFingerprint: row.schema_digest,
        expectedArgs,
        providerReadyArgs: expectedArgs,
        providerReadyArgsDigest: row.canonical_argument_digest,
        providerResultDigest: inspected.providerResultDigest,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      missing: false,
      reason: error instanceof Error ? error.message : 'workflow-v3 call projection failed',
    };
  }
}

/** Rebuild a public exact-send envelope only from canonical v3 settlement and
 * retained-result truth. Mutable step-journal/provider bytes are candidates,
 * never authority, and a repair performs no provider invocation. */
export function redeemWorkflowV3ScheduledSendOutput(
  slot: WorkflowV3CallSlot,
  expectedTool: string,
  expectedArgs: Record<string, unknown>,
  candidate: unknown,
):
  | {
      ok: true;
      output: WorkflowCallCommitOutputV1;
      evidence: WorkflowCallCommitEvidenceV1;
      repairedProjection: boolean;
    }
  | { ok: false; missing: boolean; reason: string } {
  const committed = committedOutput(slot, expectedTool, expectedArgs);
  if (!committed.ok) return committed;
  return {
    ok: true,
    output: committed.output,
    evidence: committed.output.callEvidence,
    repairedProjection: sha256(candidate) !== sha256(committed.output),
  };
}

export interface WorkflowV3RunMutationRequeueAssessment {
  safeToFreshRun: boolean;
  blocking: Array<{
    stepId: string;
    status: 'in_flight' | 'uncertain' | 'committed' | 'failed_after_crossing' | 'conflict';
    activationId: string;
  }>;
}

/** A new run cannot inherit a source run's v3 call identity. Any successful,
 * uncertain, or still-crossing mutation therefore blocks a blind whole-run
 * retry; this reads the existing canonical ledger and creates no replacement. */
export function assessWorkflowV3RunMutationRequeue(input: {
  workflowSlug: string;
  runId: string;
}): WorkflowV3RunMutationRequeueAssessment {
  const rows = openEventLog().prepare(`
    SELECT activation.node_id AS step_id
      FROM workflow_node_invocation_activations activation
      JOIN workflow_v3_call_activation_bindings binding USING (activation_id)
     WHERE activation.workflow_id = ?
       AND activation.run_id = ?
       AND binding.effect != 'host_only'
     ORDER BY activation.activated_at, activation.activation_id
  `).all(input.workflowSlug, input.runId) as Array<{ step_id: string }>;
  const blocking: WorkflowV3RunMutationRequeueAssessment['blocking'] = [];
  for (const { step_id: stepId } of rows) {
    const inspected = inspectWorkflowV3Call({ ...input, stepId });
    if (inspected.status === 'committed' || inspected.status === 'uncertain') {
      blocking.push({
        stepId,
        status: inspected.status,
        activationId: inspected.row.activation_id,
      });
    } else if (inspected.status === 'in_flight' && inspected.providerCrossed) {
      blocking.push({
        stepId,
        status: 'in_flight',
        activationId: inspected.row.activation_id,
      });
    } else if (inspected.status === 'failed' && inspected.providerCrossed) {
      blocking.push({
        stepId,
        status: 'failed_after_crossing',
        activationId: inspected.row.activation_id,
      });
    } else if (inspected.status === 'conflict') {
      blocking.push({ stepId, status: 'conflict', activationId: inspected.row?.activation_id ?? 'unknown' });
    }
  }
  return { safeToFreshRun: blocking.length === 0, blocking };
}
