/**
 * Cycle-free semantic verifier for the one documented atomic-input create.
 *
 * Receipt issuance and terminal publication both consume this predicate. It
 * performs no writes and imports no eventlog/runtime store, so neither caller
 * can become a second content-evidence authority. Each caller supplies its
 * already-validated successful-settlement reader; the work/lineage/content
 * interpretation below has exactly one owner.
 */
import type Database from 'better-sqlite3';
import { documentedAtomicInputContentCommit } from '../../integrations/composio/operation-semantics.js';
import type { SealedNodeBinding } from './host-capability-catalog-factory.js';
import type { ObligationManifest } from './obligation-manifest.js';
import { verifyCanonicalDocumentedCreateResult } from './documented-create-result-evidence.js';
import {
  googleSheetsSheetFromJsonMatchesSourceRecords,
  parseGoogleSheetsSheetFromJsonContract,
} from './sheet-from-json-content-contract.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import type {
  TypedPhysicalAuthorityProof,
} from './typed-physical-authority-proof.js';

export interface AtomicContentCommitFacts {
  intendedDigest: string;
  createdId: string;
  handle: string;
  providerReceipt: string;
  physicalDispatchId: string;
  sourceLogicalToolCallId: string;
}

export interface AtomicContentCommitSettlementEvidence {
  rawPayload: unknown;
  toolName: string;
  executionSite: 'host' | 'provider';
  physicalDispatchId: string;
}

export type AtomicContentCommitProofResult =
  | { ok: true; facts: AtomicContentCommitFacts }
  | { ok: false; status: 'not_ready' | 'conflict'; reason: string };

type SuccessfulResultResolver = (logicalToolCallId: string) =>
  | { ok: true; rawPayload: unknown }
  | { ok: false; reason: string };

type SealedNodeAuthorityResolver = (input: {
  nodeId: string;
  contractId: string;
  expectedEffect: 'external_write';
}) =>
  | { ok: true; binding: SealedNodeBinding }
  | { ok: false; reason: string };

type TypedPhysicalAuthorityResolver = (input: {
  physicalDispatchId: string;
}) => TypedPhysicalAuthorityProof;

interface WorkOperation {
  id: string;
  effect: string;
  dependsOn: string[];
  dataFrom: string[];
  cardinality: { kind: string };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function parseWorkOperations(contractJson: string): WorkOperation[] | null {
  try {
    const parsed = JSON.parse(contractJson) as unknown;
    if (!plainRecord(parsed) || !Array.isArray(parsed.operations)) return null;
    const operations: WorkOperation[] = [];
    for (const value of parsed.operations) {
      if (!plainRecord(value) || !plainRecord(value.cardinality)) return null;
      const dependsOn = stringArray(value.dependsOn);
      const dataFrom = stringArray(value.dataFrom);
      if (
        typeof value.id !== 'string'
        || typeof value.effect !== 'string'
        || typeof value.cardinality.kind !== 'string'
        || !dependsOn
        || !dataFrom
      ) return null;
      operations.push({
        id: value.id,
        effect: value.effect,
        dependsOn,
        dataFrom,
        cardinality: { kind: value.cardinality.kind },
      });
    }
    return operations;
  } catch {
    return null;
  }
}

function recordsPayload(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!plainRecord(value)) return null;
  if (Array.isArray(value.records)) return value.records;
  // The exact no-retry Composio transport preserves the provider SDK's
  // canonical success envelope. Follow only that one declared wrapper: an
  // arbitrary nested `data.records` object without `successful:true` is not
  // settled source evidence and cannot authorize an atomic create.
  if (value.successful !== true || !plainRecord(value.data)) return null;
  return Array.isArray(value.data.records) ? value.data.records : null;
}

function sameExactAtomicOperation(left: string, right: string): boolean {
  return Boolean(
    documentedAtomicInputContentCommit(left)
    && documentedAtomicInputContentCommit(right)
    && left.trim().toUpperCase() === right.trim().toUpperCase(),
  );
}

/**
 * Re-prove acknowledged committed content from exact durable facts. This does
 * not claim provider readback: the returned digest is the frozen submitted
 * content digest, bound to a clean provider acknowledgement and the exact
 * settled source lineage.
 */
export function verifyAtomicContentCommit(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifest: ObligationManifest;
  node: ObligationManifest['nodes'][number];
  logicalToolCallId: string;
  created: AtomicContentCommitSettlementEvidence;
  resolveSuccessfulResult: SuccessfulResultResolver;
  resolveSealedNodeAuthority: SealedNodeAuthorityResolver;
  resolveTypedPhysicalAuthority: TypedPhysicalAuthorityResolver;
}): AtomicContentCommitProofResult {
  if (
    input.node.contentCommitMode !== 'documented_atomic_input'
    || !documentedAtomicInputContentCommit(input.node.resolvedTool)
    || input.node.effectKind !== 'external_write'
    || !input.manifest.nodes.some((node) => node.nodeId === input.node.nodeId
      && node.operationId === input.node.operationId
      && node.resolvedTool === input.node.resolvedTool
      && node.contentCommitMode === 'documented_atomic_input')
    || input.created.toolName !== input.node.resolvedTool
    || input.created.executionSite !== 'provider'
    || !input.created.physicalDispatchId.trim()
  ) return { ok: false, status: 'conflict', reason: 'manifest/call has no exact documented atomic-content semantic' };

  const verified = verifyCanonicalDocumentedCreateResult({ value: input.created.rawPayload });
  if (verified.status !== 'verified') {
    return { ok: false, status: 'conflict', reason: verified.reason };
  }
  const projected = verified.value;
  if (
    projected.binding.acceptedTaskId !== input.acceptedTaskId
    || projected.binding.logicalToolCallId !== input.logicalToolCallId
    || projected.binding.requirementId !== input.node.operationId
    || !sameExactAtomicOperation(projected.binding.operationId, input.node.resolvedTool)
    || projected.binding.effect !== 'external_write'
  ) return { ok: false, status: 'conflict', reason: 'atomic create result conflicts with manifest/call authority' };

  const binding = input.db.prepare(`
    SELECT accepted_task_id, contract_id, requirement_id, tool_name,
           argument_digest, effect_kind
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
    accepted_task_id: string;
    contract_id: string;
    requirement_id: string;
    tool_name: string;
    argument_digest: string;
    effect_kind: string;
  } | undefined;
  if (
    !binding
    || binding.accepted_task_id !== input.acceptedTaskId
    || binding.requirement_id !== input.node.operationId
    || binding.tool_name !== input.node.resolvedTool
    || binding.argument_digest !== projected.binding.argumentDigest
    || binding.effect_kind !== 'external_write'
  ) return { ok: false, status: 'conflict', reason: 'atomic create has no exact expected-work binding' };

  // Execution ownership is explicit and exclusive. A production-host call
  // freezes its module-minted capability envelope before crossing under
  // host_v1. A typed graph executor instead owns a reconstructed physical
  // ResolvedCallAuthorityV1 plus its
  // sealed graph-node binding. Missing/corrupt authority never falls through,
  // and the two execution owners can never coexist for one crossing.
  const host = loadHostCallCapabilityBinding({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    logicalToolCallId: input.logicalToolCallId,
  });
  const root = input.db.prepare(`
    SELECT authority_kind FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ? AND accepted_task_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.acceptedTaskId) as {
    authority_kind: string;
  } | undefined;
  if (!root || (root.authority_kind !== 'host_v1' && root.authority_kind !== 'turn_graph')) {
    return { ok: false, status: 'conflict', reason: 'atomic create accepted-turn authority kind is missing or unsupported' };
  }
  if (host.status === 'conflict' || host.status === 'storage_error') {
    return {
      ok: false,
      status: 'conflict',
      reason: `atomic create host authority is not exact: ${host.reason}`,
    };
  }
  const typed = input.resolveTypedPhysicalAuthority({
    physicalDispatchId: input.created.physicalDispatchId,
  });
  if (host.status === 'ok') {
    if (typed.status !== 'missing') {
      return {
        ok: false,
        status: 'conflict',
        reason: typed.status === 'ok'
          ? 'atomic create has conflicting host and typed-graph execution owners'
          : `atomic create has corrupt typed-graph execution authority beside its host owner: ${typed.reason}`,
      };
    }
    if (
      root.authority_kind !== 'host_v1'
      || host.binding.rootAuthorityKind !== 'host_v1'
      || host.binding.acceptedTaskId !== input.acceptedTaskId
      || host.binding.bindingKind !== 'catalog_manifest'
      || host.binding.toolName !== binding.tool_name
      || host.binding.operationId !== projected.binding.operationId
      || !sameExactAtomicOperation(host.binding.operationId, input.node.resolvedTool)
      || host.binding.accountId !== projected.binding.accountId
      || host.binding.providerInputSchemaDigest !== projected.binding.providerInputSchemaDigest
      || host.binding.effectiveArgumentDigest !== projected.binding.argumentDigest
      || host.binding.effect !== 'external_write'
    ) return {
      ok: false,
      status: 'conflict',
      reason: 'atomic create result conflicts with durable host account, schema, tool, or argument authority',
    };
  } else if (root.authority_kind === 'host_v1') {
    return {
      ok: false,
      status: 'conflict',
      reason: 'host_v1 atomic create is missing its mandatory pre-crossing host-call capability binding',
    };
  } else {
    if (typed.status !== 'ok') {
      return {
        ok: false,
        status: 'conflict',
        reason: `typed turn-graph atomic create authority is not exact: ${typed.reason}`,
      };
    }
    const sealed = input.resolveSealedNodeAuthority({
      nodeId: typed.authority.nodeId,
      contractId: binding.contract_id,
      expectedEffect: 'external_write',
    });
    if (!sealed.ok) {
      return { ok: false, status: 'conflict', reason: `atomic create node authority is not exact: ${sealed.reason}` };
    }
    if (
      typed.authority.acceptedTaskId !== input.acceptedTaskId
      || typed.authority.graphId !== input.manifest.graphId
      || typed.authority.graphHash !== input.manifest.graphHash
      || typed.authority.nodeId !== input.node.operationId
      || typed.authority.logicalCallId !== input.logicalToolCallId
      || typed.authority.physicalDispatchId !== input.created.physicalDispatchId
      || typed.authority.operationId !== projected.binding.operationId
      || !sameExactAtomicOperation(typed.authority.operationId, input.node.resolvedTool)
      || typed.authority.capabilityRef !== sealed.binding.capabilityId
      || typed.authority.operationVersion !== sealed.binding.schemaVersion
      || typed.authority.logicalArgumentDigest !== projected.binding.argumentDigest
      || typed.authority.accountId !== projected.binding.accountId
      || typed.authority.providerInputSchemaDigest !== projected.binding.providerInputSchemaDigest
      || typed.authority.resolvedEffect !== 'external_write'
      || sealed.binding.nodeId !== typed.authority.nodeId
      || sealed.binding.providerOperationId !== projected.binding.operationId
      || sealed.binding.toolName !== sealed.binding.providerOperationId
      || sealed.binding.logicalToolName !== binding.tool_name
      || !sameExactAtomicOperation(sealed.binding.providerOperationId, input.node.resolvedTool)
      || sealed.binding.account !== projected.binding.accountId
      || (sealed.binding.providerInputSchemaDigest ?? sealed.binding.schemaDigest)
        !== projected.binding.providerInputSchemaDigest
      || sealed.binding.argumentDigest !== projected.binding.argumentDigest
      || sealed.binding.effect !== 'external_write'
    ) return {
      ok: false,
      status: 'conflict',
      reason: 'atomic create result conflicts with sealed account, schema, tool, or argument authority',
    };
  }

  const generated = input.db.prepare(`
    SELECT contract_json FROM expected_work_generated_artifact_contracts
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
    contract_json: string;
  } | undefined;
  let contentContract: ReturnType<typeof parseGoogleSheetsSheetFromJsonContract> = null;
  try {
    contentContract = parseGoogleSheetsSheetFromJsonContract(
      generated ? JSON.parse(generated.contract_json) : null,
    );
  } catch { /* refusal below */ }
  if (
    !contentContract
    || contentContract.submittedContentDigest !== projected.binding.submittedContentDigest
    || projected.created.writtenDigest !== contentContract.submittedContentDigest
  ) return { ok: false, status: 'conflict', reason: 'atomic submitted-content contract is missing or changed' };

  const workRow = input.db.prepare(`
    SELECT accepted_task_id, contract_id, contract_json
      FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as {
    accepted_task_id: string;
    contract_id: string;
    contract_json: string;
  } | undefined;
  const operations = workRow ? parseWorkOperations(workRow.contract_json) : null;
  const createOperation = operations?.find((operation) => operation.id === input.node.operationId);
  if (
    !workRow
    || workRow.accepted_task_id !== input.acceptedTaskId
    || workRow.contract_id !== binding.contract_id
    || !createOperation
    || createOperation.effect !== 'external_write'
    || createOperation.cardinality.kind !== 'once'
    || createOperation.dataFrom.length !== 1
    || !createOperation.dependsOn.includes(createOperation.dataFrom[0]!)
  ) return { ok: false, status: 'conflict', reason: 'atomic create lineage is not one exact frozen predecessor' };

  const sourceRequirementId = createOperation.dataFrom[0]!;
  const sourceOperation = operations?.find((operation) => operation.id === sourceRequirementId);
  if (
    !sourceOperation
    || sourceOperation.effect !== 'read'
    || sourceOperation.cardinality.kind !== 'once'
  ) return {
    ok: false,
    status: 'not_ready',
    reason: 'atomic content commit requires one direct read lineage; transformed lineage needs a sealed transform proof',
  };

  const sourceRows = input.db.prepare(`
    SELECT b.logical_tool_call_id
      FROM expected_work_call_bindings b
      JOIN logical_call_settlements s
        ON s.session_id = b.session_id
       AND s.source_user_seq = b.source_user_seq
       AND s.logical_tool_call_id = b.logical_tool_call_id
     WHERE b.session_id = ? AND b.source_user_seq = ?
       AND b.contract_id = ? AND b.requirement_id = ?
       AND b.effect_kind = 'read'
       AND s.outcome_kind IN ('succeeded','empty_result')
       AND s.continues_requirement = 0
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    binding.contract_id,
    sourceRequirementId,
  ) as Array<{ logical_tool_call_id: string }>;
  if (sourceRows.length !== 1) {
    return { ok: false, status: 'conflict', reason: 'atomic content lineage source settlement is missing or ambiguous' };
  }
  const sourceLogicalToolCallId = sourceRows[0]!.logical_tool_call_id;
  const source = input.resolveSuccessfulResult(sourceLogicalToolCallId);
  const sourceRecords = source.ok ? recordsPayload(source.rawPayload) : null;
  if (!sourceRecords || !googleSheetsSheetFromJsonMatchesSourceRecords(contentContract, sourceRecords)) {
    return { ok: false, status: 'conflict', reason: source.ok
      ? 'atomic submitted rows are not all and only the settled source rows'
      : `atomic source settlement is not redeemable: ${source.reason}` };
  }

  const sourceNode = input.manifest.nodes.find((node) =>
    node.operationId === sourceRequirementId && node.effectKind === 'read');
  if (!sourceNode || !input.manifest.edges.some((edge) =>
    edge.fromNodeId === sourceNode.nodeId
    && (edge.fromObligation === 'source_observed' || edge.fromObligation === 'source_completeness')
    && edge.toNodeId === input.node.nodeId
    && edge.toObligation === 'derivation_from_current_source')) {
    return { ok: false, status: 'conflict', reason: 'atomic content manifest omits exact source derivation edge' };
  }

  const artifacts = input.db.prepare(`
    SELECT a.resource_id, a.uri, a.status
      FROM artifact_source_roots root
      JOIN run_artifacts a
        ON a.session_id = root.session_id AND a.run_scope_id = root.root_scope_id
     WHERE root.session_id = ? AND root.source_user_seq = ? AND a.source_call_id = ?
  `).all(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as Array<{
    resource_id: string | null;
    uri: string | null;
    status: string;
  }>;
  if (
    artifacts.length !== 1
    || artifacts[0]!.status !== 'bound'
    || artifacts[0]!.resource_id !== projected.created.id
    || artifacts[0]!.uri !== projected.created.handle
  ) return { ok: false, status: 'conflict', reason: 'atomic created target is not the exact bound artifact' };

  return {
    ok: true,
    facts: {
      intendedDigest: contentContract.submittedContentDigest,
      createdId: projected.created.id,
      handle: projected.created.handle,
      providerReceipt: projected.created.receipt,
      physicalDispatchId: input.created.physicalDispatchId,
      sourceLogicalToolCallId,
    },
  };
}
