/** Cycle-free proof of a frozen plan's provider acknowledgement obligation.
 * Result loaders supply redeemed authoritative bytes, never model prose. The
 * proof binds those bytes to one exact selected call and claims no artifact
 * identity, content equality, independent readback, or permission to replay. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import { turnGraphHashMatches } from '../graph/turn-graph-compiler.js';
import { canonicalWorkTopologyJson, validateWorkTopology, workTopologyDigest } from '../graph/work-topology.js';
import type { AcceptedTaskWorkContractV1 } from './expected-work-contract.js';
import type { ObligationManifest, ObligationManifestNode } from './obligation-manifest.js';
import { capabilityManifestDigest, type CapabilityManifestV1 } from './capability-manifest.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { sealedNodeBindingDigestOf, type SealedNodeBindingDigestInput } from './sealed-node-binding-digest.js';
import { parseProviderAcknowledgementMode, selectProviderAcknowledgementMode } from './provider-acknowledgement-contract.js';
import { readDurableResultPayload } from './result-payload-storage.js';
import { inspectProviderEnvelope } from './provider-read-evidence.js';

function digest(value: unknown): string {
  return createHash('sha256').update(closedCanonicalJson(value)).digest('hex');
}

export interface AcknowledgedSettlementResult {
  toolName: string;
  executionSite: 'host' | 'provider';
  physicalDispatchId: string;
  resultHandleId: string;
  rawPayloadSha256: string;
  rawByteCount: number;
}

export interface ProviderAcknowledgementReceipt {
  version: 1;
  proofKind: 'provider_acknowledgement_v1';
  kind: 'commit';
  obligation: 'commit_effect';
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifestId: string;
  nodeId: string;
  workContractId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  resultHandleId: string;
  rawPayloadSha256: string;
  rawByteCount: number;
  sealedBindingDigest: string;
  hostBindingDigest: string;
  accountId: string;
  providerManifestDigest: string;
  argumentDigest: string;
  receiptId: string;
}

type Scope = {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifest: ObligationManifest;
  node: ObligationManifestNode;
};
type ProofResult = { ok: true; receipt: ProviderAcknowledgementReceipt }
  | { ok: false; reason: string };

export function proveProviderAcknowledgement(input: Scope & {
  logicalToolCallId: string;
  result: AcknowledgedSettlementResult;
}): ProofResult {
  const refuse = (reason: string): ProofResult => ({ ok: false, reason });
  try {
    const { db, node, result } = input;
    if (node.writeEvidenceMode !== 'provider_acknowledgement_v1'
      || node.effectKind !== 'external_write' || node.contentCommitMode
      || node.obligations.length !== 2 || !node.obligations.includes('commit_effect')
      || !node.obligations.includes('execution_terminal')
      || input.manifest.identity.sessionId !== input.sessionId
      || input.manifest.identity.sourceUserSeq !== input.sourceUserSeq
      || !input.manifest.nodes.some((entry) => closedCanonicalJson(entry) === closedCanonicalJson(node))
      || result.executionSite !== 'provider' || result.toolName !== node.resolvedTool
      || !/^[a-f0-9]{64}$/.test(result.rawPayloadSha256)
      || !Number.isSafeInteger(result.rawByteCount) || result.rawByteCount <= 0) {
      return refuse('provider acknowledgement scope does not match the frozen manifest');
    }
    const host = loadHostCallCapabilityBinding(input);
    if (host.status !== 'ok') return refuse(`provider acknowledgement host binding is ${host.status}`);
    const binding = host.binding;
    if (binding.acceptedTaskId !== input.acceptedTaskId || binding.effect !== 'external_write'
      || binding.bindingKind !== 'catalog_manifest' || binding.toolName !== node.resolvedTool) {
      return refuse('provider acknowledgement has no exact external host call');
    }
    const sealedRow = db.prepare(`SELECT binding_json, binding_digest FROM graph_node_bindings
      WHERE session_id = ? AND source_user_seq = ? AND node_id = ?`)
      .get(input.sessionId, input.sourceUserSeq, node.operationId) as { binding_json: string; binding_digest: string } | undefined;
    if (!sealedRow) return refuse('provider acknowledgement selection was not sealed');
    const sealed = JSON.parse(sealedRow.binding_json) as SealedNodeBindingDigestInput & { bindingDigest: string };
    const mode = parseProviderAcknowledgementMode(sealed.writeEvidenceMode);
    if (!mode || sealed.bindingDigest !== sealedRow.binding_digest
      || sealedNodeBindingDigestOf(sealed) !== sealedRow.binding_digest
      || sealed.nodeId !== node.operationId || sealed.effect !== 'external_write'
      || sealed.capabilityId !== binding.capabilityId || sealed.providerOperationId !== binding.operationId
      || sealed.toolName !== binding.operationId || sealed.logicalToolName !== binding.toolName
      || sealed.account !== binding.accountId || sealed.schemaDigest !== binding.schemaFingerprint
      || sealed.providerInputSchemaDigest !== binding.providerInputSchemaDigest
      || sealed.verification || sealed.asyncRead || sealed.operationSemantics?.atomicInputContent) {
      return refuse('provider acknowledgement selection and host account/schema authority disagree');
    }
    const work = db.prepare(`SELECT b.contract_id, b.argument_digest, b.tool_name, b.effect_kind,
        c.accepted_task_id, c.contract_json FROM expected_work_call_bindings b
      JOIN accepted_task_work_contracts c ON c.session_id = b.session_id AND c.source_user_seq = b.source_user_seq
      WHERE b.session_id = ? AND b.source_user_seq = ? AND b.logical_tool_call_id = ?
        AND b.requirement_id = ? AND b.accepted_task_id = ? AND c.contract_id = b.contract_id`)
      .get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId, node.operationId, input.acceptedTaskId) as {
        contract_id: string; argument_digest: string; tool_name: string; effect_kind: string;
        accepted_task_id: string; contract_json: string;
      } | undefined;
    if (!work || work.contract_id !== mode.workContractId || work.accepted_task_id !== input.acceptedTaskId
      || work.tool_name !== binding.toolName || work.effect_kind !== 'external_write'
      || (work.argument_digest !== binding.effectiveArgumentDigest
        && work.argument_digest !== binding.logicalRawArgumentDigest)) {
      return refuse('provider acknowledgement expected-work call is not exact');
    }
    const contract = JSON.parse(work.contract_json) as AcceptedTaskWorkContractV1;
    const { contractId, ...contractBody } = contract;
    const topology = validateWorkTopology({ version: contract.version, operations: contract.operations, universes: contract.universes });
    if (!topology.ok || contractId !== work.contract_id
      || contractId !== `expected-work:v1:${digest(contractBody)}`
      || canonicalWorkTopologyJson(contract) !== work.contract_json
      || contract.topologyHash !== workTopologyDigest(topology.topology)
      || contract.acceptedTaskId !== input.acceptedTaskId
      || contract.identity.sessionId !== input.sessionId || contract.identity.sourceUserSeq !== input.sourceUserSeq
      || contract.graphHash !== input.manifest.graphHash || contract.graphId !== input.manifest.graphId) {
      return refuse('provider acknowledgement work-contract bytes or content address changed');
    }
    const workOperation = topology.topology.operations.find((entry) => entry.id === node.operationId);
    if (workOperation?.effect !== 'external_write' || workOperation.cardinality.kind !== 'once' || workOperation.dataFrom.length) {
      return refuse('provider acknowledgement cannot discharge source derivation or repeated work');
    }
    const graphRows = db.prepare(`SELECT id, data_json FROM events WHERE session_id = ?
      AND type = 'turn_graph_compiled' AND json_extract(data_json, '$.sourceUserSeq') = ?`)
      .all(input.sessionId, input.sourceUserSeq) as Array<{ id: string; data_json: string }>;
    if (graphRows.length !== 1) return refuse('provider acknowledgement accepted graph is missing or ambiguous');
    const graph = (JSON.parse(graphRows[0]!.data_json) as { graph: TurnGraphIR }).graph;
    if (graph.compiler.graphHash !== input.manifest.graphHash || graph.graphId !== input.manifest.graphId
      || graph.identity.sessionId !== input.sessionId || graph.identity.sourceUserSeq !== input.sourceUserSeq
      || graphRows[0]!.id !== contract.graphEventId || graph.workTopology?.topologyHash !== contract.topologyHash
      || !turnGraphHashMatches(graph)) return refuse('provider acknowledgement accepted graph changed');
    const providerRow = db.prepare(`SELECT manifest_json, digest FROM capability_manifests WHERE manifest_id = ?`)
      .get(binding.manifestId) as { manifest_json: string; digest: string } | undefined;
    if (!providerRow) return refuse('provider acknowledgement exact provider manifest is missing');
    const provider = JSON.parse(providerRow.manifest_json) as CapabilityManifestV1;
    if (providerRow.digest !== binding.manifestDigest || capabilityManifestDigest(provider) !== binding.manifestDigest
      || provider.operationId !== binding.operationId || provider.accountId !== binding.accountId
      || provider.invokePortId !== binding.invokePortId
      || !selectProviderAcknowledgementMode({ graph, operationId: node.operationId, workContractId: work.contract_id, manifest: provider })) {
      return refuse('provider acknowledgement cannot replace an explicit provider or accepted-work obligation');
    }
    const crossings = db.prepare(`SELECT p.physical_dispatch_id, p.state, p.execution_site, p.argument_digest,
        p.accepted_task_id, s.outcome_kind, s.execution_kind, s.physical_crossing_count, s.host_crossing_count,
        s.result_handle_id, s.continues_requirement FROM physical_dispatches p
      JOIN logical_call_settlements s ON s.session_id = p.session_id AND s.source_user_seq = p.source_user_seq
        AND s.logical_tool_call_id = p.logical_tool_call_id
      WHERE p.session_id = ? AND p.source_user_seq = ? AND p.logical_tool_call_id = ?`)
      .all(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as Array<Record<string, unknown>>;
    const crossing = crossings[0];
    if (crossings.length !== 1 || !crossing || crossing.physical_dispatch_id !== result.physicalDispatchId
      || crossing.accepted_task_id !== input.acceptedTaskId || crossing.argument_digest !== binding.effectiveArgumentDigest
      || crossing.state !== 'returned' || (crossing.execution_site !== null && crossing.execution_site !== 'provider')
      || crossing.outcome_kind !== 'succeeded' || crossing.execution_kind !== 'provider_execution'
      || crossing.physical_crossing_count !== 1 || (crossing.host_crossing_count ?? 0) !== 0
      || crossing.result_handle_id !== result.resultHandleId || crossing.continues_requirement !== 0) {
      return refuse('provider acknowledgement requires one known successful provider execution');
    }
    const raw = db.prepare(`SELECT raw_location, raw_payload_json, raw_payload_sha256, raw_byte_count,
        rejection_reason, physical_dispatch_id, argument_digest, success, tool_name
      FROM durable_result_handles WHERE handle_id = ? AND scope_kind = 'authoritative'
        AND session_id = ? AND source_user_seq = ? AND accepted_task_id = ? AND logical_tool_call_id = ?`)
      .get(result.resultHandleId, input.sessionId, input.sourceUserSeq, input.acceptedTaskId, input.logicalToolCallId) as {
        raw_location: string; raw_payload_json: string; raw_payload_sha256: string; raw_byte_count: number;
        rejection_reason: string | null; physical_dispatch_id: string; argument_digest: string;
        success: number; tool_name: string;
      } | undefined;
    if (!raw || raw.success !== 1 || raw.rejection_reason !== null || raw.tool_name !== binding.toolName
      || raw.physical_dispatch_id !== result.physicalDispatchId || raw.argument_digest !== binding.effectiveArgumentDigest
      || raw.raw_payload_sha256 !== result.rawPayloadSha256 || raw.raw_byte_count !== result.rawByteCount) {
      return refuse('provider acknowledgement raw result authority does not match');
    }
    const bytes = readDurableResultPayload({ rawLocation: raw.raw_location,
      rawPayloadJson: raw.raw_payload_json, rawPayloadSha256: raw.raw_payload_sha256,
      rawByteCount: raw.raw_byte_count, rejectionReason: raw.rejection_reason });
    if (bytes.status !== 'ok' || inspectProviderEnvelope(bytes.value).verdict !== 'clean') {
      return refuse('provider acknowledgement raw provider bytes are corrupt or contradictory');
    }
    const body = {
      version: 1 as const, proofKind: 'provider_acknowledgement_v1' as const,
      kind: 'commit' as const, obligation: 'commit_effect' as const,
      sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, acceptedTaskId: input.acceptedTaskId,
      manifestId: input.manifest.manifestId, nodeId: node.nodeId, workContractId: work.contract_id,
      logicalToolCallId: input.logicalToolCallId, physicalDispatchId: result.physicalDispatchId,
      resultHandleId: result.resultHandleId, rawPayloadSha256: result.rawPayloadSha256, rawByteCount: result.rawByteCount,
      sealedBindingDigest: sealedRow.binding_digest, hostBindingDigest: binding.durableBindingDigest,
      accountId: binding.accountId, providerManifestDigest: binding.manifestDigest,
      argumentDigest: binding.effectiveArgumentDigest,
    };
    return { ok: true, receipt: { ...body, receiptId: `provider-acknowledgement:v1:${digest(body)}` } };
  } catch { return refuse('provider acknowledgement authority is unreadable'); }
}

/** Additive, versioned table, created only by the evidence issuer in its
 * transaction. Legacy artifact receipts and their schema are unchanged. */
export function ensureProviderAcknowledgementReceiptTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS host_provider_acknowledgement_receipts_v1 (
    receipt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL,
    manifest_id TEXT NOT NULL, node_id TEXT NOT NULL, receipt_json TEXT NOT NULL,
    receipt_event_id TEXT NOT NULL,
    UNIQUE(session_id, source_user_seq, manifest_id, node_id)
  )`);
}

export function loadProviderAcknowledgementReceipt(db: Database.Database, receiptId: string): ProviderAcknowledgementReceipt | null {
  if (!receiptId.startsWith('provider-acknowledgement:v1:')) return null;
  try {
    const row = db.prepare(`SELECT r.*, e.session_id AS event_session_id, e.type AS event_type, e.data_json
      FROM host_provider_acknowledgement_receipts_v1 r JOIN events e ON e.id = r.receipt_event_id
      WHERE receipt_id = ?`).get(receiptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const receipt = JSON.parse(String(row.receipt_json)) as ProviderAcknowledgementReceipt;
    const { receiptId: id, ...body } = receipt;
    if (id !== receiptId || id !== `provider-acknowledgement:v1:${digest(body)}`
      || receipt.version !== 1 || receipt.proofKind !== 'provider_acknowledgement_v1'
      || receipt.kind !== 'commit' || receipt.obligation !== 'commit_effect'
      || receipt.sessionId !== row.session_id || receipt.sourceUserSeq !== row.source_user_seq
      || receipt.manifestId !== row.manifest_id || receipt.nodeId !== row.node_id
      || row.event_session_id !== receipt.sessionId || row.event_type !== 'evidence_receipt'
      || closedCanonicalJson(JSON.parse(String(row.data_json))) !== closedCanonicalJson(receipt)) return null;
    return receipt;
  } catch { return null; }
}

export function providerAcknowledgementReceiptsEqual(left: ProviderAcknowledgementReceipt, right: ProviderAcknowledgementReceipt): boolean {
  return closedCanonicalJson(left) === closedCanonicalJson(right);
}
