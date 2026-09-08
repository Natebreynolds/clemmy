/**
 * Cycle-free final proof verifier for accepted-task terminal publication.
 *
 * This module deliberately accepts an existing SQLite connection and imports
 * no eventlog/runtime store. `appendEvent` calls it while the terminal event
 * insert and authority CAS are still inside one IMMEDIATE transaction, closing
 * the check-then-publish window that an outer adjudicator cannot close.
 *
 * The staged production cutover currently covers deterministic direct and
 * retrieve tasks. Direct tasks owe zero obligations. Retrieve tasks may close
 * only from the normalized v30 read-receipt chain. Every other obligation
 * fails closed until its own normalized host receipt reaches this boundary.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ObligationManifest } from './obligation-manifest.js';
import {
  exactProviderDataEnvelopeAcknowledged,
  exactProviderDataPayload,
  inspectProviderEnvelope,
} from './provider-read-evidence.js';
import {
  deriveResultHandleFactsFromRaw,
  reconcileStoredEnvelopeMetadata,
} from './result-facts.js';
import { readDurableResultPayload } from './result-payload-storage.js';
import {
  settlementCrossingAuthorityProjection,
  type SettlementCrossingAuthorityVersion,
} from './settlement-crossing-authority.js';
import { verifyAtomicContentCommit } from './atomic-content-commit-proof.js';
import type { SealedNodeBinding } from './host-capability-catalog-factory.js';
import { reopenTypedPhysicalAuthorityInTransaction } from './typed-physical-authority-proof.js';
import { openCanonicalArguments } from './authority-argument-seal.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import {
  exactVerificationContentMatches,
  mutationVerificationReceiptId,
  parseMutationVerificationRecipe,
  projectMutationVerificationIntent,
  projectReadbackVerificationResult,
  setVerificationPointer,
  verificationTargetDigest,
  verifierLogicalCallId,
  type MutationVerificationRecipeV1,
} from './mutation-verification-contract.js';
import {
  parseHostLocalWriteCommitFacts,
  proveHostLocalWorkspaceStructuredCollection,
} from './host-local-write-commit.js';
import { proveHostLocalWorkspaceDerivation } from './host-local-workspace-derivation.js';
import { registeredToolSideEffect } from '../../tools/tool-registry.js';
import { parseCapabilityManifestOperationSemantics } from './capability-manifest.js';
import { parseProviderAcknowledgementMode } from './provider-acknowledgement-contract.js';
import {
  loadProviderAcknowledgementReceipt,
  proveProviderAcknowledgement,
  providerAcknowledgementReceiptsEqual,
} from './provider-acknowledgement-proof.js';
import {
  sealedNodeBindingDigestOf,
  type SealedNodeBindingDigestInput,
} from './sealed-node-binding-digest.js';

const MAX_DURABLE_CURSOR_BYTES = 65_536;

export type TerminalPublicationProofResult =
  | { ok: true }
  | { ok: false; status: 'not_ready' | 'conflict' | 'unreadable'; reason: string };

interface TransitionRow {
  obligation_key: string;
  session_id: string;
  source_user_seq: number;
  manifest_id: string;
  node_id: string;
  obligation: string;
  receipt_id: string;
  physical_attempt_id: string;
  logical_tool_call_id: string | null;
  physical_dispatch_id: string | null;
}

interface ReceiptAuthorityRow {
  receipt_id: string;
  protocol_version: number;
  semantic_digest: string;
  kind: 'observation' | 'collection';
  receipt_session_id: string;
  receipt_source_user_seq: number;
  receipt_accepted_task_id: string;
  manifest_id: string;
  node_id: string;
  obligation: 'source_observed' | 'source_completeness';
  receipt_logical_tool_call_id: string;
  receipt_physical_dispatch_id: string;
  receipt_result_handle_id: string;
  receipt_tool_name: string;
  operation_mode: 'point_read' | 'collection_read';
  receipt_raw_payload_sha256: string;
  receipt_raw_byte_count: number;
  record_identities_json: string;
  aggregate_digest: string;
  receipt_completeness: 'complete' | 'partial' | 'unknown';
  receipt_continuation_outstanding: number;
  receipt_cursor_repeated: number;
  receipt_event_id: string;
  mirror_session_id: string;
  mirror_type: string;
  mirror_data_json: string;
  settlement_execution_kind: string;
  settlement_outcome_kind: string;
  settlement_result_handle_id: string | null;
  settlement_crossing_count: number;
  settlement_host_crossing_count: number | null;
  settlement_crossing_authority_version: number;
  settlement_crossings_digest: string;
  dispatch_execution_site: string | null;
  logical_accepted_task_id: string;
  logical_tool_name: string;
  logical_argument_digest: string;
  logical_state: string;
  handle_rowid: number;
  handle_id: string;
  handle_scope_kind: string;
  handle_session_id: string | null;
  handle_source_user_seq: number | null;
  handle_accepted_task_id: string | null;
  handle_logical_tool_call_id: string | null;
  handle_physical_dispatch_id: string | null;
  handle_tool_name: string;
  handle_argument_digest: string;
  continuation_chain_id: string;
  base_argument_digest: string;
  raw_location: string | null;
  raw_payload_json: string | null;
  handle_raw_payload_sha256: string | null;
  handle_raw_byte_count: number;
  rejection_reason: string | null;
  handle_success: number;
  record_path: string | null;
  record_count: number;
  envelope_meta_json: string | null;
  handle_completeness: 'complete' | 'partial' | 'unknown';
  projected_records_json: string;
  status_code: number | null;
  continuation_ref: string | null;
  cursor_bytes: Buffer | null;
  cursor_sha256: string | null;
  cursor_repeated: number;
  dispatch_state: string;
  dispatch_tool_name: string;
  dispatch_argument_digest: string;
  dispatch_ordinal: number;
  final_dispatch_ordinal: number;
  frozen_crossing_count: number;
  frozen_handle_crossing_count: number;
}

interface CrossingAuthorityRow {
  accepted_task_id?: string;
  physical_dispatch_id: string;
  ordinal: number;
  relation: 'primary' | 'retry' | 'poll' | 'probe' | 'child';
  retry_of: string | null;
  tool_name: string;
  argument_digest: string;
  state: 'started' | 'returned' | 'threw' | 'timed_out' | 'cancelled' | 'unknown' | null;
  execution_site: 'host' | null;
}

interface SettledResultAuthorityRow {
  accepted_task_id: string;
  logical_state: string;
  logical_tool_name: string;
  logical_argument_digest: string;
  execution_kind: string;
  outcome_kind: string;
  continues_requirement: number;
  settlement_result_handle_id: string | null;
  physical_crossing_count: number;
  host_crossing_count: number | null;
  crossing_authority_version: number;
  physical_crossings_digest: string;
  handle_id: string;
  scope_kind: string;
  handle_session_id: string | null;
  handle_source_user_seq: number | null;
  handle_accepted_task_id: string | null;
  handle_logical_tool_call_id: string | null;
  handle_physical_dispatch_id: string | null;
  handle_tool_name: string;
  handle_argument_digest: string;
  continuation_chain_id: string;
  base_argument_digest: string;
  raw_location: string | null;
  raw_payload_json: string | null;
  raw_payload_sha256: string | null;
  raw_byte_count: number;
  rejection_reason: string | null;
  success: number;
  dispatch_state: string;
  dispatch_execution_site: string | null;
  dispatch_tool_name: string;
  dispatch_argument_digest: string;
  dispatch_ordinal: number;
  final_dispatch_ordinal: number;
}

interface HostWriteReceiptAuthorityRow {
  receipt_id: string;
  kind: string;
  receipt_session_id: string;
  receipt_source_user_seq: number;
  receipt_accepted_task_id: string;
  manifest_id: string;
  node_id: string;
  obligation: string;
  logical_tool_call_id: string;
  physical_dispatch_id: string;
  created_id: string;
  handle: string;
  provider_receipt: string;
  intended_digest: string | null;
  observed_digest: string | null;
  semantic_digest: string;
  mirror_session_id: string;
  mirror_type: string;
  mirror_data_json: string;
}

interface HostSealedContentContract {
  version: 1;
  kind: 'host_sealed_artifact_content_v1';
  acceptedTaskId: string;
  graphId: string;
  graphHash: string;
  lineageNodeId: string;
  createNodeId: string;
  readbackNodeId: string;
  lineageContentDigest: string;
  intendedContentDigest: string;
  createBindingDigest: string;
  readbackBindingDigest: string;
  createEffect: 'external_write' | 'local_write';
  readbackEffect: 'read';
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function storedJsonMatches(stored: string | null, expected: unknown): boolean {
  if (stored === null) return expected === null;
  try {
    return canonical(JSON.parse(stored) as unknown) === canonical(expected);
  } catch {
    return false;
  }
}

function storedBytesMatch(stored: Buffer | null, expected: Buffer | null): boolean {
  if (stored === null || expected === null) return stored === null && expected === null;
  const bytes = Buffer.isBuffer(stored) ? stored : Buffer.from(stored as unknown as Uint8Array);
  return bytes.equals(expected);
}

function crossingProjection(
  rows: readonly CrossingAuthorityRow[],
  version: SettlementCrossingAuthorityVersion,
): Array<Record<string, unknown>> {
  return settlementCrossingAuthorityProjection(rows.map((row) => ({
    physicalDispatchId: row.physical_dispatch_id,
    ordinal: row.ordinal,
    relation: row.relation,
    retryOf: row.retry_of,
    toolName: row.tool_name,
    argumentDigest: row.argument_digest,
    terminalState: row.state,
    executionSite: row.execution_site,
  })), version);
}

function crossingProjectionDigest(
  rows: readonly CrossingAuthorityRow[],
  version: SettlementCrossingAuthorityVersion,
): string {
  return sha256Bytes(JSON.stringify(crossingProjection(rows, version)));
}

function crossingSitesAndStatesMatch(input: {
  frozen: readonly CrossingAuthorityRow[];
  live: readonly CrossingAuthorityRow[];
  version: SettlementCrossingAuthorityVersion;
  providerCount: number;
  hostCount: number;
}): boolean {
  if (input.version === 1) return true;
  return input.frozen.every((crossing) => crossing.state !== null)
    && input.live.every((crossing) => crossing.state !== null && crossing.state !== 'started')
    && input.frozen.filter((crossing) => crossing.execution_site === 'host').length === input.hostCount
    && input.live.filter((crossing) => crossing.execution_site === 'host').length === input.hostCount
    && input.frozen.filter((crossing) => crossing.execution_site === null).length === input.providerCount
    && input.live.filter((crossing) => crossing.execution_site === null).length === input.providerCount;
}

function exactCrossingAuthority(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): { frozen: CrossingAuthorityRow[]; live: CrossingAuthorityRow[] } {
  const params = [input.sessionId, input.sourceUserSeq, input.logicalToolCallId] as const;
  const frozen = input.db.prepare(`
    SELECT physical_dispatch_id, ordinal, relation, retry_of,
           tool_name, argument_digest, terminal_state AS state, execution_site
      FROM logical_call_settlement_crossings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(...params) as CrossingAuthorityRow[];
  const live = input.db.prepare(`
    SELECT accepted_task_id, physical_dispatch_id, ordinal, relation, retry_of,
           tool_name, argument_digest, state, execution_site
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(...params) as CrossingAuthorityRow[];
  return { frozen, live };
}

function digest64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function crossingAuthorityVersion(value: number): SettlementCrossingAuthorityVersion | null {
  return value === 1 || value === 2 ? value : null;
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\s/.test(value);
}

function parseHostSealedContentContract(value: unknown): HostSealedContentContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = [
    'version', 'kind', 'acceptedTaskId', 'graphId', 'graphHash', 'lineageNodeId',
    'createNodeId', 'readbackNodeId', 'lineageContentDigest', 'intendedContentDigest',
    'createBindingDigest', 'readbackBindingDigest', 'createEffect', 'readbackEffect',
  ];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) {
    return null;
  }
  if (record.version !== 1 || record.kind !== 'host_sealed_artifact_content_v1') return null;
  for (const key of ['acceptedTaskId', 'graphId', 'lineageNodeId', 'createNodeId', 'readbackNodeId'] as const) {
    if (!boundedIdentity(record[key])) return null;
  }
  for (const key of [
    'graphHash', 'lineageContentDigest', 'intendedContentDigest',
    'createBindingDigest', 'readbackBindingDigest',
  ] as const) {
    if (!digest64(record[key])) return null;
  }
  if (
    record.lineageContentDigest !== record.intendedContentDigest
    || (record.createEffect !== 'external_write' && record.createEffect !== 'local_write')
    || record.readbackEffect !== 'read'
  ) return null;
  return record as unknown as HostSealedContentContract;
}

function sealedBindingDigest(binding: Record<string, unknown>): string | null {
  if (
    !boundedIdentity(binding.nodeId)
    || !boundedIdentity(binding.capabilityId)
    || !boundedIdentity(binding.providerOperationId)
    || !boundedIdentity(binding.logicalToolName)
    || !boundedIdentity(binding.toolName)
    || !boundedIdentity(binding.schemaVersion)
    || (binding.providerInputSchemaDigest !== undefined
      && !digest64(binding.providerInputSchemaDigest))
    || !digest64(binding.schemaDigest)
    || !digest64(binding.argumentDigest)
    || typeof binding.effect !== 'string'
    || (binding.operationSemantics !== undefined
      && !parseCapabilityManifestOperationSemantics(binding.operationSemantics))
    || (binding.verification !== undefined
      && !parseMutationVerificationRecipe(binding.verification))
    || (binding.writeEvidenceMode !== undefined
      && !parseProviderAcknowledgementMode(binding.writeEvidenceMode))
  ) return null;
  return sealedNodeBindingDigestOf(binding as unknown as SealedNodeBindingDigestInput);
}

function exactManifestOperationMapping(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  operationId: string;
  logicalToolCallId: string;
  resolvedTool: string;
  effectKind: string;
}): boolean {
  const rows = input.db.prepare(`
    SELECT operation.operation_id, operation.logical_tool_call_id,
           operation.resolved_tool, operation.effect_kind,
           logical.tool_name AS logical_tool_name
      FROM accepted_task_operations operation
      JOIN logical_tool_calls logical
        ON logical.session_id = operation.session_id
       AND logical.source_user_seq = operation.source_user_seq
       AND logical.logical_tool_call_id = operation.logical_tool_call_id
       AND logical.accepted_task_id = ?
     WHERE operation.session_id = ? AND operation.source_user_seq = ?
       AND operation.operation_id = ? AND operation.logical_tool_call_id = ?
  `).all(
    input.acceptedTaskId,
    input.sessionId,
    input.sourceUserSeq,
    input.operationId,
    input.logicalToolCallId,
  ) as Array<{
    operation_id: string;
    logical_tool_call_id: string;
    resolved_tool: string;
    effect_kind: string;
    logical_tool_name: string;
  }>;
  if (rows.length !== 1) return false;
  const row = rows[0]!;
  return row.resolved_tool === input.resolvedTool
    && row.effect_kind === input.effectKind
    && row.logical_tool_name === input.resolvedTool;
}

function exactSuccessfulResult(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}): { ok: true; row: SettledResultAuthorityRow; raw: unknown } | { ok: false; reason: string } {
  const row = input.db.prepare(`
    SELECT l.accepted_task_id, l.state AS logical_state,
           l.tool_name AS logical_tool_name, l.argument_digest AS logical_argument_digest,
           s.execution_kind, s.outcome_kind, s.continues_requirement,
           s.result_handle_id AS settlement_result_handle_id,
           s.physical_crossing_count, s.host_crossing_count,
           s.crossing_authority_version, s.physical_crossings_digest,
           h.handle_id, h.scope_kind, h.session_id AS handle_session_id,
           h.source_user_seq AS handle_source_user_seq,
           h.accepted_task_id AS handle_accepted_task_id,
           h.logical_tool_call_id AS handle_logical_tool_call_id,
           h.physical_dispatch_id AS handle_physical_dispatch_id,
           h.tool_name AS handle_tool_name, h.argument_digest AS handle_argument_digest,
           h.continuation_chain_id, h.base_argument_digest,
           h.raw_location, h.raw_payload_json, h.raw_payload_sha256,
           h.raw_byte_count, h.rejection_reason, h.success,
           p.state AS dispatch_state, p.execution_site AS dispatch_execution_site,
           p.tool_name AS dispatch_tool_name, p.argument_digest AS dispatch_argument_digest,
           p.ordinal AS dispatch_ordinal,
           (SELECT MAX(p2.ordinal) FROM physical_dispatches p2
             WHERE p2.session_id = p.session_id
               AND p2.source_user_seq = p.source_user_seq
               AND p2.logical_tool_call_id = p.logical_tool_call_id) AS final_dispatch_ordinal
      FROM logical_tool_calls l
      JOIN logical_call_settlements s
        ON s.session_id = l.session_id
       AND s.source_user_seq = l.source_user_seq
       AND s.logical_tool_call_id = l.logical_tool_call_id
      JOIN durable_result_handles h ON h.handle_id = s.result_handle_id
      JOIN physical_dispatches p
        ON p.session_id = h.session_id
       AND p.source_user_seq = h.source_user_seq
       AND p.logical_tool_call_id = h.logical_tool_call_id
       AND p.physical_dispatch_id = h.physical_dispatch_id
     WHERE l.session_id = ? AND l.source_user_seq = ? AND l.logical_tool_call_id = ?
  `).get(
    input.sessionId,
    input.sourceUserSeq,
    input.logicalToolCallId,
  ) as SettledResultAuthorityRow | undefined;
  if (!row) return { ok: false, reason: 'settled result authority is missing' };
  const hostExecution = row.execution_kind === 'local_execution' && row.dispatch_execution_site === 'host';
  if (
    row.accepted_task_id !== input.acceptedTaskId
    || row.logical_state !== 'settled'
    || (row.execution_kind !== 'provider_execution' && !hostExecution)
    || !['succeeded', 'empty_result'].includes(row.outcome_kind)
    || row.continues_requirement !== 0
    || row.settlement_result_handle_id !== row.handle_id
    || row.scope_kind !== 'authoritative'
    || row.handle_session_id !== input.sessionId
    || row.handle_source_user_seq !== input.sourceUserSeq
    || row.handle_accepted_task_id !== input.acceptedTaskId
    || row.handle_logical_tool_call_id !== input.logicalToolCallId
    || row.logical_tool_name !== row.handle_tool_name
    || row.logical_argument_digest !== row.handle_argument_digest
    || row.success !== 1
    || row.rejection_reason !== null
    || row.dispatch_state !== 'returned'
    || row.dispatch_tool_name !== row.handle_tool_name
    || row.dispatch_argument_digest !== row.handle_argument_digest
    || row.dispatch_ordinal !== row.final_dispatch_ordinal
    || row.raw_location !== `tool_output:${row.handle_id}`
    || row.raw_payload_sha256 === null
  ) return { ok: false, reason: 'settlement, crossing, and result handle are not exact' };
  const authorityVersion = crossingAuthorityVersion(row.crossing_authority_version);
  if (authorityVersion === null) {
    return { ok: false, reason: 'settlement crossing authority version is invalid' };
  }
  const crossings = exactCrossingAuthority(input);
  const frozen = crossingProjection(crossings.frozen, authorityVersion);
  const live = crossingProjection(crossings.live, authorityVersion);
  const crossingCount = row.physical_crossing_count + (row.host_crossing_count ?? 0);
  if (
    crossings.frozen.length !== crossingCount
    || crossings.live.length !== crossingCount
    || crossings.live.some((crossing) => crossing.accepted_task_id !== input.acceptedTaskId)
    || !crossingSitesAndStatesMatch({
      frozen: crossings.frozen,
      live: crossings.live,
      version: authorityVersion,
      providerCount: row.physical_crossing_count,
      hostCount: row.host_crossing_count ?? 0,
    })
    || crossingProjectionDigest(crossings.frozen, authorityVersion) !== row.physical_crossings_digest
    || JSON.stringify(live) !== JSON.stringify(frozen)
  ) return { ok: false, reason: 'settlement crossing snapshot is not exact' };
  const expectedHandleId = `rh_${sha256Bytes([
    row.handle_session_id,
    row.handle_source_user_seq,
    row.handle_accepted_task_id,
    row.handle_logical_tool_call_id,
    row.handle_physical_dispatch_id,
    row.continuation_chain_id,
  ].join('|') + `|${row.handle_argument_digest}|${row.raw_payload_sha256}`).slice(0, 32)}`;
  if (row.handle_id !== expectedHandleId) return { ok: false, reason: 'result handle content address is invalid' };
  const retained = readDurableResultPayload({
    rawLocation: row.raw_location,
    rawPayloadJson: row.raw_payload_json,
    rawPayloadSha256: row.raw_payload_sha256,
    rawByteCount: row.raw_byte_count,
    rejectionReason: row.rejection_reason,
  });
  if (retained.status !== 'ok') {
    return { ok: false, reason: `settled result payload is unreadable (${retained.reason})` };
  }
  const raw = retained.value;
  if (inspectProviderEnvelope(raw).verdict !== 'clean') {
    return { ok: false, reason: 'settled result provider envelope is contradictory' };
  }
  return { ok: true, row, raw };
}

function providerArgumentsForSuccessfulCall(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
}): Record<string, unknown> | null {
  const row = input.db.prepare(`
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
    || row.accepted_task_id !== input.acceptedTaskId
    || row.logical_tool_call_id !== input.logicalToolCallId
    || row.state !== 'returned'
    || row.recovery_tool_name !== row.tool_name
    || row.recovery_argument_digest !== row.argument_digest
    || !row.recovery_argument_cipher
  ) return null;
  const reopened = openCanonicalArguments(row.recovery_argument_cipher);
  if (!reopened) return null;
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

function recordAtPath(payload: unknown, recordPath: string | null): unknown[] | null {
  if (recordPath === null) return null;
  const value = recordPath === ''
    ? payload
    : recordPath.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      return (current as Record<string, unknown>)[key];
    }, payload);
  return Array.isArray(value) ? value : [];
}

function scalarIdentity(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;
  const normalized = new Map(Object.keys(value)
    .map((key) => [key.replace(/[^a-z0-9]/gi, '').toLowerCase(), key]));
  for (const candidate of ['id', 'recordid', 'uuid', 'uid', 'key', 'identifier']) {
    const key = normalized.get(candidate);
    if (!key) continue;
    const identity = value[key];
    if (
      typeof identity === 'string'
      || typeof identity === 'number'
      || typeof identity === 'boolean'
    ) return `${candidate}:${String(identity)}`;
  }
  return undefined;
}

function identities(records: readonly unknown[]): string[] {
  return records.map((record) => scalarIdentity(record) ?? `sha256:${digest(record)}`);
}

function exactReceiptAuthority(
  db: Database.Database,
  receiptId: string,
): ReceiptAuthorityRow | undefined {
  return db.prepare(`
    SELECT
      r.receipt_id, r.protocol_version, r.semantic_digest, r.kind,
      r.session_id AS receipt_session_id,
      r.source_user_seq AS receipt_source_user_seq,
      r.accepted_task_id AS receipt_accepted_task_id,
      r.manifest_id, r.node_id, r.obligation,
      r.logical_tool_call_id AS receipt_logical_tool_call_id,
      r.physical_dispatch_id AS receipt_physical_dispatch_id,
      r.result_handle_id AS receipt_result_handle_id,
      r.tool_name AS receipt_tool_name, r.operation_mode,
      r.raw_payload_sha256 AS receipt_raw_payload_sha256,
      r.raw_byte_count AS receipt_raw_byte_count,
      r.record_identities_json, r.aggregate_digest,
      r.completeness AS receipt_completeness,
      r.continuation_outstanding AS receipt_continuation_outstanding,
      r.cursor_repeated AS receipt_cursor_repeated,
      r.receipt_event_id,
      e.session_id AS mirror_session_id, e.type AS mirror_type,
      e.data_json AS mirror_data_json,
      s.execution_kind AS settlement_execution_kind,
      s.outcome_kind AS settlement_outcome_kind,
      s.result_handle_id AS settlement_result_handle_id,
      s.physical_crossing_count AS settlement_crossing_count,
      s.host_crossing_count AS settlement_host_crossing_count,
      s.crossing_authority_version AS settlement_crossing_authority_version,
      s.physical_crossings_digest AS settlement_crossings_digest,
      l.accepted_task_id AS logical_accepted_task_id,
      l.tool_name AS logical_tool_name,
      l.argument_digest AS logical_argument_digest,
      l.state AS logical_state,
      h.rowid AS handle_rowid, h.handle_id, h.scope_kind AS handle_scope_kind,
      h.session_id AS handle_session_id,
      h.source_user_seq AS handle_source_user_seq,
      h.accepted_task_id AS handle_accepted_task_id,
      h.logical_tool_call_id AS handle_logical_tool_call_id,
      h.physical_dispatch_id AS handle_physical_dispatch_id,
      h.tool_name AS handle_tool_name,
      h.argument_digest AS handle_argument_digest,
      h.continuation_chain_id, h.base_argument_digest,
      h.raw_location, h.raw_payload_json,
      h.raw_payload_sha256 AS handle_raw_payload_sha256,
      h.raw_byte_count AS handle_raw_byte_count,
      h.rejection_reason, h.success AS handle_success,
      h.record_path, h.record_count,
      h.envelope_meta_json,
      h.completeness AS handle_completeness,
      h.projected_records_json, h.status_code,
      h.continuation_ref, h.cursor_bytes, h.cursor_sha256, h.cursor_repeated,
      p.state AS dispatch_state,
      p.execution_site AS dispatch_execution_site,
      p.tool_name AS dispatch_tool_name,
      p.argument_digest AS dispatch_argument_digest,
      p.ordinal AS dispatch_ordinal,
      (SELECT MAX(p2.ordinal)
         FROM physical_dispatches p2
        WHERE p2.session_id = s.session_id
          AND p2.source_user_seq = s.source_user_seq
          AND p2.logical_tool_call_id = s.logical_tool_call_id
      ) AS final_dispatch_ordinal,
      (SELECT COUNT(*)
         FROM logical_call_settlement_crossings sc
        WHERE sc.session_id = s.session_id
          AND sc.source_user_seq = s.source_user_seq
          AND sc.logical_tool_call_id = s.logical_tool_call_id
      ) AS frozen_crossing_count,
      (SELECT COUNT(*)
         FROM logical_call_settlement_crossings sc
        WHERE sc.session_id = s.session_id
          AND sc.source_user_seq = s.source_user_seq
          AND sc.logical_tool_call_id = s.logical_tool_call_id
          AND sc.physical_dispatch_id = h.physical_dispatch_id
      ) AS frozen_handle_crossing_count
    FROM evidence_receipts r
    JOIN logical_call_settlements s
      ON s.session_id = r.session_id
     AND s.source_user_seq = r.source_user_seq
     AND s.logical_tool_call_id = r.logical_tool_call_id
    JOIN logical_tool_calls l
      ON l.session_id = s.session_id
     AND l.source_user_seq = s.source_user_seq
     AND l.logical_tool_call_id = s.logical_tool_call_id
    JOIN durable_result_handles h ON h.handle_id = r.result_handle_id
    JOIN physical_dispatches p
      ON p.session_id = h.session_id
     AND p.source_user_seq = h.source_user_seq
     AND p.logical_tool_call_id = h.logical_tool_call_id
     AND p.physical_dispatch_id = h.physical_dispatch_id
    JOIN events e ON e.id = r.receipt_event_id
    WHERE r.receipt_id = ?
  `).get(receiptId) as ReceiptAuthorityRow | undefined;
}

function verifyReceipt(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifestId: string;
  node: ObligationManifest['nodes'][number];
  obligation: 'source_observed' | 'source_completeness';
  transition: TransitionRow;
}): TerminalPublicationProofResult {
  const row = exactReceiptAuthority(input.db, input.transition.receipt_id);
  if (!row) return { ok: false, status: 'conflict', reason: 'proof receipt has no exact normalized authority chain' };
  const expectedKind = input.obligation === 'source_observed' ? 'observation' : 'collection';
  // Obligation names the PROOF owed, the manifest node names the MODE the
  // capability actually has. A resolved-operation retrieve owes observation
  // and may legitimately ride a collection-shaped read; the node-mode equality
  // below still pins the receipt to the exact manifest capability.
  const allowedModes: readonly string[] = input.obligation === 'source_observed'
    ? ['point_read', 'collection_read']
    : ['collection_read'];
  const normalizedNodeMode = input.node.operationMode === 'finite_read'
    ? 'collection_read'
    : input.node.operationMode;
  const operationMapped = exactManifestOperationMapping({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    operationId: input.node.operationId,
    logicalToolCallId: row.receipt_logical_tool_call_id,
    resolvedTool: input.node.resolvedTool,
    effectKind: input.node.effectKind,
  });
  if (
    !operationMapped
    || row.protocol_version !== 1
    || row.kind !== expectedKind
    || row.receipt_session_id !== input.sessionId
    || row.receipt_source_user_seq !== input.sourceUserSeq
    || row.receipt_accepted_task_id !== input.acceptedTaskId
    || row.manifest_id !== input.manifestId
    || row.node_id !== input.node.nodeId
    || row.obligation !== input.obligation
    || !allowedModes.includes(row.operation_mode)
    || row.operation_mode !== normalizedNodeMode
    || row.receipt_tool_name !== input.node.resolvedTool
    || input.transition.physical_attempt_id !== row.receipt_physical_dispatch_id
    || (input.transition.logical_tool_call_id !== null
      && input.transition.logical_tool_call_id !== row.receipt_logical_tool_call_id)
    || (input.transition.physical_dispatch_id !== null
      && input.transition.physical_dispatch_id !== row.receipt_physical_dispatch_id)
  ) {
    return { ok: false, status: 'conflict', reason: 'proof transition and receipt identity disagree' };
  }
  // The host's own returned execution is redeemable evidence: its crossing is
  // recorded with executionSite 'host' and its bytes are handle-bound exactly
  // like a provider result. Any other local settlement stays refused.
  const hostExecutedEvidence = row.settlement_execution_kind === 'local_execution'
    && row.dispatch_execution_site === 'host';
  if (
    row.logical_accepted_task_id !== input.acceptedTaskId
    || row.logical_state !== 'settled'
    || (row.settlement_execution_kind !== 'provider_execution' && !hostExecutedEvidence)
    || !['succeeded', 'empty_result'].includes(row.settlement_outcome_kind)
    || row.settlement_result_handle_id !== row.receipt_result_handle_id
    || row.settlement_result_handle_id !== row.handle_id
    || row.logical_tool_name !== row.receipt_tool_name
    || row.logical_argument_digest !== row.handle_argument_digest
    || row.handle_scope_kind !== 'authoritative'
    || row.handle_session_id !== input.sessionId
    || row.handle_source_user_seq !== input.sourceUserSeq
    || row.handle_accepted_task_id !== input.acceptedTaskId
    || row.handle_logical_tool_call_id !== row.receipt_logical_tool_call_id
    || row.handle_physical_dispatch_id !== row.receipt_physical_dispatch_id
    || row.handle_tool_name !== row.receipt_tool_name
    || row.handle_success !== 1
    || row.rejection_reason !== null
    || row.dispatch_state !== 'returned'
    || row.dispatch_tool_name !== row.receipt_tool_name
    || row.dispatch_argument_digest !== row.handle_argument_digest
    || row.dispatch_ordinal !== row.final_dispatch_ordinal
    || row.frozen_handle_crossing_count !== 1
    // The frozen crossing rows cover provider AND host crossings; the
    // settlement counts them in separate columns.
    || row.frozen_crossing_count
      !== row.settlement_crossing_count + (row.settlement_host_crossing_count ?? 0)
  ) {
    return { ok: false, status: 'conflict', reason: 'receipt settlement, crossing, and result handle disagree' };
  }
  const crossingAuthority = exactCrossingAuthority({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    logicalToolCallId: row.receipt_logical_tool_call_id,
  });
  const authorityVersion = crossingAuthorityVersion(row.settlement_crossing_authority_version);
  if (authorityVersion === null) {
    return { ok: false, status: 'conflict', reason: 'settlement crossing authority version is invalid' };
  }
  const frozenCrossings = crossingProjection(crossingAuthority.frozen, authorityVersion);
  const liveCrossings = crossingProjection(crossingAuthority.live, authorityVersion);
  const totalCrossingCount = row.settlement_crossing_count
    + (row.settlement_host_crossing_count ?? 0);
  if (
    crossingAuthority.frozen.length !== totalCrossingCount
    || crossingAuthority.live.length !== totalCrossingCount
    || crossingAuthority.live.some((crossing) => crossing.accepted_task_id !== input.acceptedTaskId)
    || !crossingSitesAndStatesMatch({
      frozen: crossingAuthority.frozen,
      live: crossingAuthority.live,
      version: authorityVersion,
      providerCount: row.settlement_crossing_count,
      hostCount: row.settlement_host_crossing_count ?? 0,
    })
    || crossingProjectionDigest(crossingAuthority.frozen, authorityVersion)
      !== row.settlement_crossings_digest
    || JSON.stringify(liveCrossings) !== JSON.stringify(frozenCrossings)
  ) {
    return { ok: false, status: 'conflict', reason: 'settlement crossing snapshot is corrupt or differs from live dispatch authority' };
  }
  if (
    row.raw_location === null
    || row.handle_raw_payload_sha256 === null
    || row.receipt_raw_payload_sha256 !== row.handle_raw_payload_sha256
    || row.receipt_raw_byte_count !== row.handle_raw_byte_count
  ) {
    return { ok: false, status: 'conflict', reason: 'receipt backing bytes are missing or do not match their digest' };
  }
  const retained = readDurableResultPayload({
    rawLocation: row.raw_location,
    rawPayloadJson: row.raw_payload_json,
    rawPayloadSha256: row.handle_raw_payload_sha256,
    rawByteCount: row.handle_raw_byte_count,
    rejectionReason: row.rejection_reason,
  });
  if (retained.status !== 'ok') {
    return {
      ok: false,
      status: 'conflict',
      reason: `receipt backing payload is unreadable (${retained.reason})`,
    };
  }
  const rawPayload = retained.value;
  if (inspectProviderEnvelope(rawPayload).verdict !== 'clean') {
    return { ok: false, status: 'conflict', reason: 'receipt backing provider envelope is contradictory or uninspected' };
  }
  const facts = deriveResultHandleFactsFromRaw(rawPayload);
  const cursorBytes = facts.cursor === null ? null : Buffer.from(facts.cursor, 'utf8');
  if (cursorBytes && cursorBytes.byteLength > MAX_DURABLE_CURSOR_BYTES) {
    return { ok: false, status: 'conflict', reason: 'receipt backing cursor exceeds the durable authority bound' };
  }
  const cursorDigest = cursorBytes ? sha256Bytes(cursorBytes) : null;
  const continuationRef = cursorDigest
    ? `cont_${sha256Bytes(`${row.handle_id}|${row.base_argument_digest}|${cursorDigest}`).slice(0, 24)}`
    : null;
  const cursorRepeated = cursorDigest !== null && Boolean(input.db.prepare(`
    SELECT 1 FROM durable_result_handles
     WHERE rowid < ?
       AND scope_kind = ?
       AND session_id IS ? AND source_user_seq IS ?
       AND continuation_chain_id = ?
       AND base_argument_digest = ? AND cursor_sha256 = ?
     LIMIT 1
  `).get(
    row.handle_rowid,
    row.handle_scope_kind,
    row.handle_session_id,
    row.handle_source_user_seq,
    row.continuation_chain_id,
    row.base_argument_digest,
    cursorDigest,
  ));
  const handleScopeSalt = [
    row.handle_session_id,
    row.handle_source_user_seq,
    row.handle_accepted_task_id,
    row.handle_logical_tool_call_id,
    row.handle_physical_dispatch_id,
    row.continuation_chain_id,
  ].join('|');
  const expectedHandleId = `rh_${sha256Bytes(
    `${handleScopeSalt}|${row.handle_argument_digest}|${row.handle_raw_payload_sha256}`,
  ).slice(0, 32)}`;
  if (
    row.handle_id !== expectedHandleId
    || row.raw_location !== `tool_output:${row.handle_id}`
    || row.handle_success !== (facts.success ? 1 : 0)
    || row.record_path !== facts.recordPath
    || row.record_count !== facts.recordCount
    || !reconcileStoredEnvelopeMetadata({
      storedJson: row.envelope_meta_json,
      rederived: facts.envelopeMeta,
      rawPayload,
    }).matches
    || row.handle_completeness !== facts.completeness
    || !storedJsonMatches(row.projected_records_json, facts.projectedRecords)
    || row.status_code !== facts.statusCode
    || !storedBytesMatch(row.cursor_bytes, cursorBytes)
    || row.cursor_sha256 !== cursorDigest
    || row.continuation_ref !== continuationRef
    || row.cursor_repeated !== (cursorRepeated ? 1 : 0)
    || row.receipt_completeness !== facts.completeness
    || row.receipt_continuation_outstanding !== (continuationRef === null ? 0 : 1)
    || row.receipt_cursor_repeated !== (cursorRepeated ? 1 : 0)
  ) {
    return { ok: false, status: 'conflict', reason: 'receipt and durable handle projections do not match their raw payload' };
  }
  const records = recordAtPath(rawPayload, facts.recordPath);
  if (records === null && expectedKind === 'collection') {
    return { ok: false, status: 'conflict', reason: 'collection proof has no durable record collection' };
  }
  const derivedIdentities = identities(records ?? []);
  let storedIdentities: unknown;
  try {
    storedIdentities = JSON.parse(row.record_identities_json);
  } catch {
    return { ok: false, status: 'conflict', reason: 'receipt record identities are unreadable' };
  }
  if (
    !Array.isArray(storedIdentities)
    || storedIdentities.some((identity) => typeof identity !== 'string')
    || JSON.stringify(storedIdentities) !== JSON.stringify(derivedIdentities)
    || JSON.stringify(storedIdentities) !== row.record_identities_json
    || (records !== null && records.length !== row.record_count)
    || row.aggregate_digest !== digest(derivedIdentities)
  ) {
    return { ok: false, status: 'conflict', reason: 'receipt record projection does not match its raw payload' };
  }
  if (expectedKind === 'collection' && (
    row.receipt_completeness !== 'complete'
    || row.handle_completeness !== 'complete'
    || row.receipt_continuation_outstanding !== 0
    || row.continuation_ref !== null
    || row.receipt_cursor_repeated !== 0
    || row.cursor_repeated !== 0
  )) {
    return { ok: false, status: 'not_ready', reason: 'collection proof is incomplete or has unsafe continuation state' };
  }
  const body = {
    protocolVersion: 1,
    kind: row.kind,
    sessionId: row.receipt_session_id,
    sourceUserSeq: row.receipt_source_user_seq,
    acceptedTaskId: row.receipt_accepted_task_id,
    manifestId: row.manifest_id,
    nodeId: row.node_id,
    obligation: row.obligation,
    logicalToolCallId: row.receipt_logical_tool_call_id,
    physicalDispatchId: row.receipt_physical_dispatch_id,
    resultHandleId: row.receipt_result_handle_id,
    toolName: row.receipt_tool_name,
    operationMode: row.operation_mode,
    rawPayloadSha256: row.receipt_raw_payload_sha256,
    rawByteCount: row.receipt_raw_byte_count,
    recordIdentities: derivedIdentities,
    aggregateDigest: row.aggregate_digest,
    completeness: row.receipt_completeness,
    continuationOutstanding: row.receipt_continuation_outstanding === 1,
    cursorRepeated: row.receipt_cursor_repeated === 1,
  };
  const semanticDigest = digest(body);
  if (
    row.semantic_digest !== semanticDigest
    || row.receipt_id !== `evidence:v1:${semanticDigest}`
    || row.mirror_session_id !== input.sessionId
    || row.mirror_type !== 'evidence_receipt'
  ) {
    return { ok: false, status: 'conflict', reason: 'normalized receipt address or mirror identity is invalid' };
  }
  try {
    const mirror = JSON.parse(row.mirror_data_json) as Record<string, unknown>;
    if (
      mirror.receiptId !== row.receipt_id
      || mirror.sourceUserSeq !== input.sourceUserSeq
      || mirror.acceptedTaskId !== input.acceptedTaskId
      || mirror.manifestId !== input.manifestId
      || mirror.nodeId !== input.node.nodeId
      || mirror.obligation !== input.obligation
      || mirror.logicalToolCallId !== row.receipt_logical_tool_call_id
      || mirror.physicalDispatchId !== row.receipt_physical_dispatch_id
      || mirror.resultHandleId !== row.receipt_result_handle_id
      || mirror.aggregateDigest !== row.aggregate_digest
      || mirror.rawPayloadSha256 !== row.receipt_raw_payload_sha256
      || mirror.recordCount !== derivedIdentities.length
    ) {
      return { ok: false, status: 'conflict', reason: 'normalized receipt mirror conflicts with its row' };
    }
  } catch {
    return { ok: false, status: 'conflict', reason: 'normalized receipt mirror is unreadable' };
  }
  return { ok: true };
}

function exactSealedNodeAuthority(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  contractId: string;
  nodeId: string;
  expectedEffect: string;
  expectedBindingDigest?: string;
}): { ok: true; binding: SealedNodeBinding; logicalToolCallId: string }
  | { ok: false; reason: string } {
  const rows = input.db.prepare(`
    SELECT n.binding_json, n.binding_digest,
           b.logical_tool_call_id, b.requirement_id, b.effect_kind,
           b.tool_name, b.argument_digest
      FROM graph_node_bindings n
      JOIN expected_work_call_bindings b
        ON b.session_id = n.session_id
       AND b.source_user_seq = n.source_user_seq
       AND b.requirement_id = n.node_id
     WHERE n.session_id = ? AND n.source_user_seq = ?
       AND n.node_id = ? AND b.contract_id = ?
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    input.nodeId,
    input.contractId,
  ) as Array<{
    binding_json: string;
    binding_digest: string;
    logical_tool_call_id: string;
    requirement_id: string;
    effect_kind: string;
    tool_name: string;
    argument_digest: string;
  }>;
  if (rows.length !== 1) return { ok: false, reason: `node authority is missing or ambiguous for ${input.nodeId}` };
  const row = rows[0]!;
  let binding: Record<string, unknown>;
  try { binding = JSON.parse(row.binding_json) as Record<string, unknown>; } catch {
    return { ok: false, reason: `node binding is unreadable for ${input.nodeId}` };
  }
  const computedDigest = sealedBindingDigest(binding);
  const bindingEffect = (binding.effect === 'none' || binding.effect === 'host_only')
    ? 'compute'
    : binding.effect;
  if (
    !computedDigest
    || row.binding_digest !== computedDigest
    || binding.bindingDigest !== computedDigest
    || (input.expectedBindingDigest !== undefined && computedDigest !== input.expectedBindingDigest)
    || binding.nodeId !== input.nodeId
    || bindingEffect !== input.expectedEffect
    || row.requirement_id !== input.nodeId
    || row.effect_kind !== input.expectedEffect
    || binding.providerOperationId !== binding.toolName
    || binding.logicalToolName !== row.tool_name
    || !digest64(row.argument_digest)
  ) return { ok: false, reason: `node binding and expected-work authority disagree for ${input.nodeId}` };
  return {
    ok: true,
    binding: binding as unknown as SealedNodeBinding,
    logicalToolCallId: row.logical_tool_call_id,
  };
}

function createdPayload(raw: unknown): {
  id?: string;
  handle?: string;
  receipt?: string;
} {
  const providerPayload = exactProviderDataPayload(raw);
  if (!providerPayload || typeof providerPayload !== 'object' || Array.isArray(providerPayload)) return {};
  const record = providerPayload as Record<string, unknown>;
  const nested = record.created && typeof record.created === 'object' && !Array.isArray(record.created)
    ? record.created as Record<string, unknown>
    : record;
  return {
    ...(typeof nested.id === 'string' ? { id: nested.id } : {}),
    ...(typeof nested.handle === 'string' ? { handle: nested.handle } : {}),
    ...(typeof nested.receipt === 'string' ? { receipt: nested.receipt } : {}),
  };
}

/** Re-prove an opt-in external mutation receipt entirely inside the terminal
 * transaction. This is the cycle-free twin of the runtime verifier: it trusts
 * neither the issued receipt nor process-local catalog state, only the sealed
 * recipe plus the existing logical/dispatch/settlement/result authorities. */
function verifyFrozenMutationWriteReceipt(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  node: ObligationManifest['nodes'][number];
  receipt: HostWriteReceiptAuthorityRow;
  mutationResult: Extract<ReturnType<typeof exactSuccessfulResult>, { ok: true }>;
}): TerminalPublicationProofResult | null {
  if (input.node.effectKind !== 'external_write') return null;
  const workRows = input.db.prepare(`
    SELECT contract_id
      FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ? AND accepted_task_id = ?
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    input.acceptedTaskId,
  ) as Array<{ contract_id: string }>;
  if (workRows.length !== 1) {
    return { ok: false, status: 'conflict', reason: 'frozen mutation receipt has no unique work contract' };
  }
  const owner = exactSealedNodeAuthority({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    contractId: workRows[0]!.contract_id,
    nodeId: input.node.operationId,
    expectedEffect: 'external_write',
  });
  if (!owner.ok) {
    return { ok: false, status: 'conflict', reason: owner.reason };
  }
  if (!owner.binding.verification) return null;
  const recipe = parseMutationVerificationRecipe(owner.binding.verification);
  if (!recipe) {
    return { ok: false, status: 'conflict', reason: 'frozen mutation verification recipe is invalid' };
  }
  const bindingRecord = owner.binding as unknown as Record<string, unknown>;
  const baseBinding = { ...bindingRecord };
  delete baseBinding.bindingDigest;
  delete baseBinding.verification;
  const ownerBaseDigest = sealedBindingDigest(baseBinding);
  if (
    !ownerBaseDigest
    || recipe.acceptedTaskId !== input.acceptedTaskId
    || recipe.workContractId !== workRows[0]!.contract_id
    || recipe.ownerRequirementId !== input.node.operationId
    || recipe.ownerBindingDigest !== ownerBaseDigest
    || recipe.proof !== recipe.mutation.proof
    || owner.logicalToolCallId !== input.receipt.logical_tool_call_id
    || owner.binding.logicalToolName !== input.mutationResult.row.logical_tool_name
    || owner.binding.account !== recipe.verifier.account
    || input.mutationResult.row.execution_kind !== 'provider_execution'
    || input.mutationResult.row.dispatch_execution_site === 'host'
  ) {
    return { ok: false, status: 'conflict', reason: 'frozen mutation recipe and owner authority disagree' };
  }
  const providerArguments = providerArgumentsForSuccessfulCall({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    logicalToolCallId: owner.logicalToolCallId,
    physicalDispatchId: input.mutationResult.row.handle_physical_dispatch_id!,
  });
  if (!providerArguments) {
    return { ok: false, status: 'conflict', reason: 'mutation provider-ready arguments are not durably exact' };
  }
  const intent = projectMutationVerificationIntent({
    contract: recipe.mutation,
    providerArguments,
    authoritativeResult: exactProviderDataPayload(input.mutationResult.raw),
    phase: 'settled_result',
    providerAcknowledged: exactProviderDataEnvelopeAcknowledged(input.mutationResult.raw),
  });
  if (!intent.ok) return { ok: false, status: 'conflict', reason: intent.reason };
  const verifierArgs = JSON.parse(JSON.stringify(recipe.verifierStaticArgs)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(intent.verifierStaticArgs)) verifierArgs[key] = value;
  if (!setVerificationPointer(
    verifierArgs,
    recipe.verifierContract.requestTargetPointers[0],
    intent.resourceId,
  )) {
    return { ok: false, status: 'conflict', reason: 'frozen verifier target arguments cannot be instantiated' };
  }
  const targetDigest = verificationTargetDigest(intent.resourceId);
  const verifierCallId = verifierLogicalCallId({
    acceptedTaskId: recipe.acceptedTaskId,
    workContractId: recipe.workContractId,
    ownerRequirementId: recipe.ownerRequirementId,
    ownerBindingDigest: recipe.ownerBindingDigest,
    recipeDigest: recipe.recipeDigest,
    proof: recipe.proof,
    targetDigest,
  });
  const logical = durableLogicalCallContract(
    input.acceptedTaskId,
    recipe.verifier.operationId,
    verifierArgs,
  );
  if (!logical) return { ok: false, status: 'conflict', reason: 'frozen verifier logical contract is unsafe' };
  const hostBinding = loadHostCallCapabilityBinding({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    logicalToolCallId: verifierCallId,
  });
  if (
    hostBinding.status !== 'ok'
    || hostBinding.binding.acceptedTaskId !== input.acceptedTaskId
    || hostBinding.binding.toolName !== logical.toolName
    || hostBinding.binding.effectiveArgumentDigest !== logical.argumentDigest
    || hostBinding.binding.effect !== 'read'
    || hostBinding.binding.bindingKind !== 'catalog_manifest'
    || hostBinding.binding.capabilityId !== recipe.verifier.capabilityId
    || (hostBinding.binding.providerInputSchemaDigest ?? null)
      !== (recipe.verifier.providerInputSchemaDigest ?? null)
    || hostBinding.binding.schemaFingerprint !== recipe.verifier.schemaDigest
    || hostBinding.binding.accountId !== recipe.verifier.account
    || hostBinding.binding.invokePortId !== recipe.verifier.invokePortId
    || hostBinding.binding.operationId !== recipe.verifier.operationId
    || hostBinding.binding.manifestId !== recipe.verifier.manifestId
    || hostBinding.binding.manifestDigest !== recipe.verifier.manifestDigest
  ) {
    return { ok: false, status: 'conflict', reason: 'frozen verifier capability authority is missing or changed' };
  }
  const verifierResult = exactSuccessfulResult({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    logicalToolCallId: verifierCallId,
  });
  if (!verifierResult.ok) {
    return { ok: false, status: 'conflict', reason: verifierResult.reason };
  }
  if (
    verifierResult.row.logical_tool_name !== logical.toolName
    || verifierResult.row.execution_kind !== 'provider_execution'
    || verifierResult.row.dispatch_execution_site === 'host'
  ) {
    return { ok: false, status: 'conflict', reason: 'frozen verifier did not settle through its provider authority' };
  }
  const projected = projectReadbackVerificationResult({
    contract: recipe.verifierContract,
    providerArguments: verifierArgs,
    authoritativeResult: exactProviderDataPayload(verifierResult.raw),
    requireContent: recipe.proof === 'exact_content_v1',
    providerAcknowledged: exactProviderDataEnvelopeAcknowledged(verifierResult.raw),
  });
  if (!projected.ok) return { ok: false, status: 'conflict', reason: projected.reason };
  if (
    projected.resourceId !== intent.resourceId
    || (recipe.proof === 'exact_content_v1'
      && !exactVerificationContentMatches(intent.expectedContent, projected.observedContent))
  ) {
    return { ok: false, status: 'conflict', reason: 'frozen verifier result does not match the exact mutation intent' };
  }
  const receiptDigest = recipe.proof === 'exact_content_v1' && intent.expectedContent
    ? digest(intent.expectedContent)
    : targetDigest;
  const supportedKind = input.receipt.kind === 'commit'
    || input.receipt.kind === 'readback'
    || (input.receipt.kind === 'content_commit' && recipe.proof === 'exact_content_v1');
  const expectedReceiptId = mutationVerificationReceiptId({
    recipe,
    ownerLogicalToolCallId: owner.logicalToolCallId,
    ownerPhysicalDispatchId: input.mutationResult.row.handle_physical_dispatch_id!,
    ownerResultHandleId: input.mutationResult.row.handle_id,
    ownerResultSha256: input.mutationResult.row.raw_payload_sha256!,
    verifierLogicalCallId: verifierCallId,
    verifierPhysicalDispatchId: verifierResult.row.handle_physical_dispatch_id!,
    verifierResultHandleId: verifierResult.row.handle_id,
    verifierResultSha256: verifierResult.row.raw_payload_sha256!,
    resourceId: intent.resourceId,
    targetDigest,
  });
  if (
    !supportedKind
    || input.receipt.created_id !== intent.resourceId
    || input.receipt.handle !== intent.resourceId
    || input.receipt.provider_receipt !== expectedReceiptId
    || input.receipt.intended_digest !== receiptDigest
    || input.receipt.observed_digest !== receiptDigest
    || input.receipt.physical_dispatch_id !== input.mutationResult.row.handle_physical_dispatch_id
  ) {
    return { ok: false, status: 'conflict', reason: 'frozen mutation receipt does not match its exact verifier proof' };
  }
  return { ok: true };
}

function recordsValue(raw: unknown): unknown[] | null {
  const providerPayload = exactProviderDataPayload(raw);
  if (Array.isArray(providerPayload)) return providerPayload;
  if (!providerPayload || typeof providerPayload !== 'object' || Array.isArray(providerPayload)) return null;
  const records = (providerPayload as { records?: unknown }).records;
  return Array.isArray(records) ? records : null;
}

function verifyAtomicContentCommitInTransaction(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifest: ObligationManifest;
  node: ObligationManifest['nodes'][number];
  logicalToolCallId: string;
  createdRaw: unknown;
  createdToolName: string;
  createdExecutionSite: 'host' | 'provider';
  createdPhysicalDispatchId: string;
  createdId: string;
  handle: string;
  providerReceipt: string;
  intendedDigest: string | null;
  physicalDispatchId: string;
}): TerminalPublicationProofResult {
  const proof = verifyAtomicContentCommit({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    manifest: input.manifest,
    node: input.node,
    logicalToolCallId: input.logicalToolCallId,
    created: {
      rawPayload: input.createdRaw,
      toolName: input.createdToolName,
      executionSite: input.createdExecutionSite,
      physicalDispatchId: input.createdPhysicalDispatchId,
    },
    resolveSealedNodeAuthority(authority) {
      return exactSealedNodeAuthority({
        db: input.db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        contractId: authority.contractId,
        nodeId: authority.nodeId,
        expectedEffect: authority.expectedEffect,
      });
    },
    resolveTypedPhysicalAuthority(authority) {
      return reopenTypedPhysicalAuthorityInTransaction({
        db: input.db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        physicalDispatchId: authority.physicalDispatchId,
      });
    },
    resolveSuccessfulResult(logicalToolCallId) {
      const source = exactSuccessfulResult({
        db: input.db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
        logicalToolCallId,
      });
      return source.ok
        ? { ok: true, rawPayload: source.raw }
        : { ok: false, reason: source.reason };
    },
  });
  if (!proof.ok) return proof;
  return proof.facts.createdId === input.createdId
    && proof.facts.handle === input.handle
    && proof.facts.providerReceipt === input.providerReceipt
    && proof.facts.intendedDigest === input.intendedDigest
    && proof.facts.physicalDispatchId === input.physicalDispatchId
    ? { ok: true }
    : { ok: false, status: 'conflict', reason: 'atomic proof facts conflict with terminal receipt identity' };
}

function verifyHostSealedWriteReceipt(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifest: ObligationManifest;
  node: ObligationManifest['nodes'][number];
  obligation: string;
  transition: TransitionRow;
}): TerminalPublicationProofResult {
  if (input.node.writeEvidenceMode === 'provider_acknowledgement_v1') {
    const receipt = loadProviderAcknowledgementReceipt(input.db, input.transition.receipt_id);
    if (!receipt || input.obligation !== 'commit_effect' || receipt.obligation !== input.obligation
      || receipt.sessionId !== input.sessionId || receipt.sourceUserSeq !== input.sourceUserSeq
      || receipt.acceptedTaskId !== input.acceptedTaskId || receipt.manifestId !== input.manifest.manifestId
      || receipt.nodeId !== input.node.nodeId || receipt.physicalDispatchId !== input.transition.physical_attempt_id
      || (input.transition.logical_tool_call_id !== null && input.transition.logical_tool_call_id !== receipt.logicalToolCallId)
      || (input.transition.physical_dispatch_id !== null && input.transition.physical_dispatch_id !== receipt.physicalDispatchId)
      || !exactManifestOperationMapping({ ...input, operationId: input.node.operationId,
        logicalToolCallId: receipt.logicalToolCallId, resolvedTool: input.node.resolvedTool, effectKind: input.node.effectKind })) {
      return { ok: false, status: 'conflict', reason: 'provider acknowledgement transition does not match its exact receipt' };
    }
    const result = exactSuccessfulResult({ ...input, logicalToolCallId: receipt.logicalToolCallId });
    if (!result.ok) return { ok: false, status: 'conflict', reason: result.reason };
    const proved = proveProviderAcknowledgement({ ...input, logicalToolCallId: receipt.logicalToolCallId,
      result: {
        toolName: result.row.logical_tool_name,
        executionSite: result.row.dispatch_execution_site === 'host' ? 'host' : 'provider',
        physicalDispatchId: result.row.handle_physical_dispatch_id!,
        resultHandleId: result.row.handle_id, rawPayloadSha256: result.row.raw_payload_sha256!,
        rawByteCount: result.row.raw_byte_count!,
      },
    });
    return proved.ok && providerAcknowledgementReceiptsEqual(proved.receipt, receipt)
      ? { ok: true }
      : { ok: false, status: 'conflict', reason: proved.ok ? 'provider acknowledgement no longer matches its evidence' : proved.reason };
  }
  const receipt = input.db.prepare(`
    SELECT w.receipt_id, w.kind,
           w.session_id AS receipt_session_id,
           w.source_user_seq AS receipt_source_user_seq,
           w.accepted_task_id AS receipt_accepted_task_id,
           w.manifest_id, w.node_id, w.obligation,
           w.logical_tool_call_id, w.physical_dispatch_id,
           w.created_id, w.handle, w.provider_receipt,
           w.intended_digest, w.observed_digest, w.semantic_digest,
           e.session_id AS mirror_session_id, e.type AS mirror_type,
           e.data_json AS mirror_data_json
      FROM host_write_receipts w
      JOIN events e ON e.id = w.receipt_event_id
     WHERE w.receipt_id = ?
  `).get(input.transition.receipt_id) as HostWriteReceiptAuthorityRow | undefined;
  if (!receipt) return { ok: false, status: 'conflict', reason: 'write receipt has no normalized authority row' };
  const expectedKind = input.obligation === 'derivation_from_current_source' ? 'derivation'
    : input.obligation === 'commit_effect' ? 'commit'
      : input.obligation === 'verify_committed_readback' ? 'readback'
        : input.obligation === 'verify_committed_content' ? 'content_commit'
        : null;
  if (!expectedKind) {
    return { ok: false, status: 'not_ready', reason: `write obligation ${input.obligation} has no sealed verifier` };
  }
  if (
    receipt.kind !== expectedKind
    || receipt.receipt_session_id !== input.sessionId
    || receipt.receipt_source_user_seq !== input.sourceUserSeq
    || receipt.receipt_accepted_task_id !== input.acceptedTaskId
    || receipt.manifest_id !== input.manifest.manifestId
    || receipt.node_id !== input.node.nodeId
    || receipt.obligation !== input.obligation
    || input.transition.physical_attempt_id !== receipt.physical_dispatch_id
    || (input.transition.logical_tool_call_id !== null
      && input.transition.logical_tool_call_id !== receipt.logical_tool_call_id)
    || (input.transition.physical_dispatch_id !== null
      && input.transition.physical_dispatch_id !== receipt.physical_dispatch_id)
    || !digest64(receipt.intended_digest)
    || (input.node.contentCommitMode === 'documented_atomic_input'
      ? receipt.observed_digest !== null
      : receipt.observed_digest !== receipt.intended_digest)
  ) return { ok: false, status: 'conflict', reason: 'write transition and receipt identity disagree' };
  if (!exactManifestOperationMapping({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    operationId: input.node.operationId,
    logicalToolCallId: receipt.logical_tool_call_id,
    resolvedTool: input.node.resolvedTool,
    effectKind: input.node.effectKind,
  })) return { ok: false, status: 'conflict', reason: 'write receipt is not the exact manifest operation' };

  const body = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    manifestId: input.manifest.manifestId,
    nodeId: input.node.nodeId,
    obligation: input.obligation,
    kind: receipt.kind,
    createdId: receipt.created_id,
    handle: receipt.handle,
    providerReceipt: receipt.provider_receipt,
    intendedDigest: receipt.intended_digest,
    observedDigest: receipt.observed_digest,
    logicalToolCallId: receipt.logical_tool_call_id,
    physicalDispatchId: receipt.physical_dispatch_id,
  };
  const semanticDigest = digest(body);
  if (
    receipt.semantic_digest !== semanticDigest
    || receipt.receipt_id !== `write-evidence:v1:${semanticDigest}`
    || receipt.mirror_session_id !== input.sessionId
    || receipt.mirror_type !== 'evidence_receipt'
  ) return { ok: false, status: 'conflict', reason: 'write receipt address or mirror identity is invalid' };
  try {
    const mirror = JSON.parse(receipt.mirror_data_json) as Record<string, unknown>;
    if (
      mirror.protocolVersion !== 1
      || mirror.receiptId !== receipt.receipt_id
      || mirror.kind !== receipt.kind
      || mirror.sourceUserSeq !== input.sourceUserSeq
      || mirror.acceptedTaskId !== input.acceptedTaskId
      || mirror.manifestId !== input.manifest.manifestId
      || mirror.nodeId !== input.node.nodeId
      || mirror.obligation !== input.obligation
      || mirror.logicalToolCallId !== receipt.logical_tool_call_id
      || mirror.physicalDispatchId !== receipt.physical_dispatch_id
      || mirror.createdId !== receipt.created_id
      || mirror.providerReceipt !== receipt.provider_receipt
    ) return { ok: false, status: 'conflict', reason: 'write receipt mirror conflicts with its row' };
  } catch {
    return { ok: false, status: 'conflict', reason: 'write receipt mirror is unreadable' };
  }

  const createResult = exactSuccessfulResult({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    logicalToolCallId: receipt.logical_tool_call_id,
  });
  if (!createResult.ok) return { ok: false, status: 'conflict', reason: createResult.reason };
  const frozenMutation = verifyFrozenMutationWriteReceipt({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    node: input.node,
    receipt,
    mutationResult: createResult,
  });
  if (frozenMutation) return frozenMutation;
  // Host-local authoring returns a canonical value-opaque commit marker, not
  // a provider object. Admit that shape only after the same exact manifest,
  // logical call, sealed receipt, authoritative result handle, and host-local
  // execution checks above have all closed. Provider writes continue through
  // the independent object-payload branch below unchanged.
  const localCommit = input.node.effectKind === 'local_write'
    && createResult.row.execution_kind === 'local_execution'
    && createResult.row.dispatch_execution_site === 'host'
    && createResult.row.logical_tool_name === input.node.resolvedTool
    && registeredToolSideEffect(input.node.resolvedTool) === 'write'
    ? parseHostLocalWriteCommitFacts(createResult.raw)
    : null;
  if (localCommit) {
    const baseMatches = localCommit.createdId === receipt.created_id
      && localCommit.handle === receipt.handle
      && localCommit.receipt === receipt.provider_receipt
      && localCommit.contentDigest === receipt.intended_digest
      && localCommit.contentDigest === receipt.observed_digest
      && createResult.row.handle_physical_dispatch_id === receipt.physical_dispatch_id;
    if (!baseMatches) {
      return {
        ok: false,
        status: 'conflict',
        reason: 'local authoring commit receipt does not match its exact returned host result',
      };
    }
    if (receipt.kind === 'derivation') {
      const derivation = proveHostLocalWorkspaceDerivation({
        db: input.db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
        writeLogicalToolCallId: receipt.logical_tool_call_id,
        resolveSuccessfulResult(logicalToolCallId) {
          const result = exactSuccessfulResult({
            db: input.db,
            sessionId: input.sessionId,
            sourceUserSeq: input.sourceUserSeq,
            acceptedTaskId: input.acceptedTaskId,
            logicalToolCallId,
          });
          return result.ok
            ? {
                ok: true,
                rawPayload: result.raw,
                toolName: result.row.logical_tool_name,
                executionSite: result.row.dispatch_execution_site ?? '',
              }
            : { ok: false, reason: result.reason };
        },
      });
      if (derivation.status !== 'verified' || derivation.bundleDigest !== localCommit.contentDigest) {
        return {
          ok: false,
          status: 'conflict',
          reason: derivation.status === 'verified'
            ? 'compound Workspace derivation digest changed before terminal publication'
            : `compound Workspace derivation no longer redeems: ${derivation.reason}`,
        };
      }
      if (input.node.cardinality !== undefined && input.node.structuredCollectionLocator) {
        const collection = proveHostLocalWorkspaceStructuredCollection({
          result: createResult.raw,
          count: input.node.cardinality,
          requiredFields: input.node.requiredFields ?? [],
          locator: input.node.structuredCollectionLocator,
        });
        if (!collection) {
          return {
            ok: false,
            status: 'conflict',
            reason: 'compound Workspace structured deliverable no longer matches its frozen count and fields',
          };
        }
      }
      return { ok: true };
    }
    if (!['commit', 'readback'].includes(receipt.kind)) {
      return {
        ok: false,
        status: 'conflict',
        reason: 'local authoring commit cannot satisfy this receipt kind',
      };
    }
    return { ok: true };
  }
  const created = createdPayload(createResult.raw);
  if (
    created.id !== receipt.created_id
    || created.handle !== receipt.handle
    || created.receipt !== receipt.provider_receipt
    || !receipt.provider_receipt.trim()
    || receipt.provider_receipt === `receipt:${receipt.created_id}`
    || receipt.provider_receipt === digest(createResult.raw)
    || receipt.provider_receipt === JSON.stringify(createResult.raw)
    || createResult.row.handle_physical_dispatch_id !== receipt.physical_dispatch_id
  ) return { ok: false, status: 'conflict', reason: 'write receipt does not match the exact returned create result' };

  if (input.node.contentCommitMode === 'documented_atomic_input') {
    if (!['derivation_from_current_source', 'commit_effect', 'verify_committed_content'].includes(input.obligation)) {
      return { ok: false, status: 'conflict', reason: 'atomic content node declares an incompatible write obligation' };
    }
    return verifyAtomicContentCommitInTransaction({
      db: input.db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      manifest: input.manifest,
      node: input.node,
      logicalToolCallId: receipt.logical_tool_call_id,
      createdRaw: createResult.raw,
      createdToolName: createResult.row.dispatch_tool_name,
      createdExecutionSite: createResult.row.dispatch_execution_site === 'host' ? 'host' : 'provider',
      createdPhysicalDispatchId: createResult.row.handle_physical_dispatch_id,
      createdId: receipt.created_id,
      handle: receipt.handle,
      providerReceipt: receipt.provider_receipt,
      intendedDigest: receipt.intended_digest,
      physicalDispatchId: receipt.physical_dispatch_id,
    });
  }

  const artifactRows = input.db.prepare(`
    SELECT a.id AS artifact_id, a.status, a.resource_id, a.uri, a.source_call_id,
           c.contract_json, c.content_verified_at,
           c.verification_logical_call_id, c.verification_fingerprint
      FROM artifact_source_roots root
      JOIN run_artifacts a
        ON a.session_id = root.session_id AND a.run_scope_id = root.root_scope_id
      JOIN artifact_content_verifications c ON c.artifact_id = a.id
     WHERE root.session_id = ? AND root.source_user_seq = ?
       AND a.source_call_id = ? AND a.resource_id = ?
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    receipt.logical_tool_call_id,
    receipt.created_id,
  ) as Array<{
    artifact_id: string;
    status: string;
    resource_id: string;
    uri: string | null;
    source_call_id: string;
    contract_json: string;
    content_verified_at: string | null;
    verification_logical_call_id: string | null;
    verification_fingerprint: string | null;
  }>;
  if (artifactRows.length !== 1) {
    return { ok: false, status: 'conflict', reason: 'write artifact authority is missing or ambiguous' };
  }
  const artifact = artifactRows[0]!;
  if (
    artifact.status !== 'bound'
    || artifact.uri !== receipt.handle
    || !artifact.content_verified_at
    || !artifact.verification_logical_call_id
    || !artifact.verification_fingerprint
  ) return { ok: false, status: 'not_ready', reason: 'write artifact has no complete exact-content proof' };
  let contentContractRaw: unknown;
  try { contentContractRaw = JSON.parse(artifact.contract_json); } catch {
    return { ok: false, status: 'conflict', reason: 'write content contract is unreadable' };
  }
  const contentContract = parseHostSealedContentContract(contentContractRaw);
  if (
    !contentContract
    || contentContract.acceptedTaskId !== input.acceptedTaskId
    || contentContract.intendedContentDigest !== receipt.intended_digest
    || contentContract.lineageContentDigest !== receipt.intended_digest
  ) return { ok: false, status: 'conflict', reason: 'write content contract contradicts the receipt' };

  const workRow = input.db.prepare(`
    SELECT contract_id, graph_id, graph_hash, contract_json, accepted_task_id
      FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as {
    contract_id: string;
    graph_id: string;
    graph_hash: string;
    contract_json: string;
    accepted_task_id: string;
  } | undefined;
  if (
    !workRow
    || workRow.accepted_task_id !== input.acceptedTaskId
    || workRow.graph_id !== contentContract.graphId
    || workRow.graph_hash !== contentContract.graphHash
  ) return { ok: false, status: 'conflict', reason: 'write content contract has no exact frozen work authority' };
  let work: { contractId?: unknown; operations?: unknown };
  try { work = JSON.parse(workRow.contract_json) as { contractId?: unknown; operations?: unknown }; } catch {
    return { ok: false, status: 'conflict', reason: 'frozen work contract is unreadable' };
  }
  if (work.contractId !== workRow.contract_id || !Array.isArray(work.operations)) {
    return { ok: false, status: 'conflict', reason: 'frozen work contract identity is invalid' };
  }
  const operations = new Map<string, {
    id: string;
    effect: string;
    dependsOn: string[];
    dataFrom: string[];
  }>();
  for (const value of work.operations) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, status: 'conflict', reason: 'frozen work operation is malformed' };
    }
    const operation = value as Record<string, unknown>;
    if (
      !boundedIdentity(operation.id)
      || typeof operation.effect !== 'string'
      || !Array.isArray(operation.dependsOn)
      || operation.dependsOn.some((id) => !boundedIdentity(id))
      || !Array.isArray(operation.dataFrom)
      || operation.dataFrom.some((id) => !boundedIdentity(id))
      || operations.has(operation.id)
    ) return { ok: false, status: 'conflict', reason: 'frozen work operation authority is invalid' };
    operations.set(operation.id, {
      id: operation.id,
      effect: operation.effect,
      dependsOn: operation.dependsOn as string[],
      dataFrom: operation.dataFrom as string[],
    });
  }
  const createOperation = operations.get(contentContract.createNodeId);
  const readbackOperation = operations.get(contentContract.readbackNodeId);
  if (
    !createOperation
    || !readbackOperation
    || createOperation.effect !== contentContract.createEffect
    || !createOperation.dependsOn.includes(contentContract.lineageNodeId)
    || !createOperation.dataFrom.includes(contentContract.lineageNodeId)
    || readbackOperation.effect !== 'read'
    || !readbackOperation.dependsOn.includes(contentContract.createNodeId)
  ) return { ok: false, status: 'conflict', reason: 'write content lineage DAG is not exact' };
  const createBinding = exactSealedNodeAuthority({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    contractId: workRow.contract_id,
    nodeId: contentContract.createNodeId,
    expectedEffect: contentContract.createEffect,
    expectedBindingDigest: contentContract.createBindingDigest,
  });
  const readbackBinding = exactSealedNodeAuthority({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    contractId: workRow.contract_id,
    nodeId: contentContract.readbackNodeId,
    expectedEffect: 'read',
    expectedBindingDigest: contentContract.readbackBindingDigest,
  });
  if (!createBinding.ok || !readbackBinding.ok) {
    return {
      ok: false,
      status: 'conflict',
      reason: !createBinding.ok ? createBinding.reason : readbackBinding.ok ? '' : readbackBinding.reason,
    };
  }
  if (
    createBinding.logicalToolCallId !== receipt.logical_tool_call_id
    || readbackBinding.logicalToolCallId !== artifact.verification_logical_call_id
  ) return { ok: false, status: 'conflict', reason: 'write and readback logical bindings are not exact' };

  const ancestors = new Set<string>();
  const pending = [contentContract.lineageNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (ancestors.has(nodeId)) continue;
    const operation = operations.get(nodeId);
    if (!operation || nodeId === contentContract.createNodeId || nodeId === contentContract.readbackNodeId) {
      return { ok: false, status: 'conflict', reason: 'write lineage contains an invalid ancestor reference' };
    }
    ancestors.add(nodeId);
    for (const dependencyId of operation.dataFrom) {
      if (!operations.has(dependencyId)) {
        return { ok: false, status: 'conflict', reason: 'write lineage ancestor is missing' };
      }
      pending.push(dependencyId);
    }
  }
  const upstreamReads = [...ancestors].filter((nodeId) => operations.get(nodeId)?.effect === 'read');
  if (upstreamReads.length === 0) {
    return { ok: false, status: 'not_ready', reason: 'write derivation has no upstream source read' };
  }
  for (const nodeId of ancestors) {
    const operation = operations.get(nodeId)!;
    const authority = exactSealedNodeAuthority({
      db: input.db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      contractId: workRow.contract_id,
      nodeId,
      expectedEffect: operation.effect,
    });
    if (!authority.ok) return { ok: false, status: 'conflict', reason: authority.reason };
    const result = exactSuccessfulResult({
      db: input.db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: authority.logicalToolCallId,
    });
    if (!result.ok) return { ok: false, status: 'conflict', reason: result.reason };
    if (nodeId === contentContract.lineageNodeId) {
      const lineage = recordsValue(result.raw);
      if (!lineage || digest(lineage) !== contentContract.lineageContentDigest) {
        return { ok: false, status: 'conflict', reason: 'write lineage bytes do not match the sealed digest' };
      }
    }
  }
  const writeManifestNodeId = input.node.nodeId;
  for (const sourceOperationId of upstreamReads) {
    const sourceNode = input.manifest.nodes.find((node) =>
      node.operationId === sourceOperationId && node.effectKind === 'read');
    if (!sourceNode || !input.manifest.edges.some((edge) =>
      edge.fromNodeId === sourceNode.nodeId
      && (edge.fromObligation === 'source_observed' || edge.fromObligation === 'source_completeness')
      && edge.toNodeId === writeManifestNodeId
      && edge.toObligation === 'derivation_from_current_source')) {
      return { ok: false, status: 'conflict', reason: 'manifest omits an upstream source-to-derivation edge' };
    }
  }

  const readback = exactSuccessfulResult({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    logicalToolCallId: artifact.verification_logical_call_id,
  });
  if (!readback.ok) return { ok: false, status: 'conflict', reason: readback.reason };
  const readbackRaw = exactProviderDataPayload(readback.raw);
  if (!readbackRaw || typeof readbackRaw !== 'object' || Array.isArray(readbackRaw)) {
    return { ok: false, status: 'conflict', reason: 'write readback result is malformed' };
  }
  const readbackValue = readbackRaw as { id?: unknown; content?: unknown };
  if (
    readbackValue.id !== receipt.created_id
    || readbackValue.content === undefined
    || inspectProviderEnvelope(readbackValue.content).verdict !== 'clean'
    || digest(readbackValue.content) !== receipt.observed_digest
  ) return { ok: false, status: 'conflict', reason: 'write readback bytes do not match the exact created artifact' };
  return { ok: true };
}

function verifySettledExecutionInTransaction(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
}): TerminalPublicationProofResult {
  const operations = input.db.prepare(`
    SELECT operation_id, logical_tool_call_id
      FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
  `).all(input.sessionId, input.sourceUserSeq) as Array<{
    operation_id: string;
    logical_tool_call_id: string;
  }>;
  if (operations.length === 0) {
    return { ok: false, status: 'not_ready', reason: 'execution-terminal proof has no accepted operations' };
  }
  for (const operation of operations) {
    const state = input.db.prepare(`
      SELECT l.accepted_task_id, l.state, s.outcome_kind, s.continues_requirement,
             (SELECT COUNT(*) FROM physical_dispatches p
               WHERE p.session_id = l.session_id
                 AND p.source_user_seq = l.source_user_seq
                 AND p.logical_tool_call_id = l.logical_tool_call_id
                 AND p.state IN ('started','unknown')) AS open_dispatches
        FROM logical_tool_calls l
        JOIN logical_call_settlements s
          ON s.session_id = l.session_id
         AND s.source_user_seq = l.source_user_seq
         AND s.logical_tool_call_id = l.logical_tool_call_id
       WHERE l.session_id = ? AND l.source_user_seq = ? AND l.logical_tool_call_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      operation.logical_tool_call_id,
    ) as {
      accepted_task_id: string;
      state: string;
      outcome_kind: string;
      continues_requirement: number;
      open_dispatches: number;
    } | undefined;
    if (
      !state
      || state.accepted_task_id !== input.acceptedTaskId
      || state.state !== 'settled'
      || !['succeeded', 'empty_result'].includes(state.outcome_kind)
      || state.continues_requirement !== 0
      || state.open_dispatches !== 0
    ) return { ok: false, status: 'not_ready', reason: `accepted operation ${operation.operation_id} is not terminal` };
  }
  return { ok: true };
}

/** Verify every declared obligation and reject every undeclared transition. */
export function verifyAcceptedTaskTerminalProofInTransaction(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifest: ObligationManifest;
}): TerminalPublicationProofResult {
  try {
    const transitions = input.db.prepare(`
      SELECT obligation_key, session_id, source_user_seq, manifest_id, node_id,
             obligation, receipt_id, physical_attempt_id,
             logical_tool_call_id, physical_dispatch_id
        FROM obligation_transitions
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY obligation_key
    `).all(input.sessionId, input.sourceUserSeq) as TransitionRow[];
    const declared = input.manifest.nodes.flatMap((node) => node.obligations
      .map((obligation) => ({ node, obligation })));
    const receiptDeclared = declared.filter((entry) => entry.obligation !== 'execution_terminal');
    if (transitions.some((transition) => transition.manifest_id !== input.manifest.manifestId)) {
      return { ok: false, status: 'conflict', reason: 'proof transition names another manifest' };
    }
    const declaredKeys = new Set(receiptDeclared.map((entry) =>
      `${entry.node.nodeId}|${entry.obligation}`));
    if (transitions.some((transition) =>
      !declaredKeys.has(`${transition.node_id}|${transition.obligation}`))) {
      return { ok: false, status: 'conflict', reason: 'duplicate or undeclared proof transitions exist' };
    }
    if (transitions.length > receiptDeclared.length) {
      return { ok: false, status: 'conflict', reason: 'duplicate or undeclared proof transitions exist' };
    }
    if (transitions.length < receiptDeclared.length) {
      return { ok: false, status: 'not_ready', reason: 'one or more declared obligations are unsatisfied' };
    }
    for (const entry of receiptDeclared) {
      const matches = transitions.filter((transition) =>
        transition.node_id === entry.node.nodeId
        && transition.obligation === entry.obligation);
      if (matches.length === 0) {
        return { ok: false, status: 'not_ready', reason: `unsatisfied obligation ${entry.node.nodeId}:${entry.obligation}` };
      }
      if (matches.length !== 1) {
        return { ok: false, status: 'conflict', reason: `ambiguous proof for ${entry.node.nodeId}:${entry.obligation}` };
      }
      const transition = matches[0]!;
      const expectedKey = [
        input.sessionId,
        input.sourceUserSeq,
        input.manifest.manifestId,
        entry.node.nodeId,
        entry.obligation,
      ].join('|');
      if (
        transition.obligation_key !== expectedKey
        || transition.session_id !== input.sessionId
        || transition.source_user_seq !== input.sourceUserSeq
      ) {
        return { ok: false, status: 'conflict', reason: 'proof transition key or task identity is invalid' };
      }
      const receipt = entry.node.effectKind === 'read'
        && ['point_read', 'collection_read', 'finite_read'].includes(entry.node.operationMode)
        && (entry.obligation === 'source_observed' || entry.obligation === 'source_completeness')
        ? verifyReceipt({
            db: input.db,
            sessionId: input.sessionId,
            sourceUserSeq: input.sourceUserSeq,
            acceptedTaskId: input.acceptedTaskId,
            manifestId: input.manifest.manifestId,
            node: entry.node,
            obligation: entry.obligation,
            transition,
          })
        : (entry.node.effectKind === 'external_write' || entry.node.effectKind === 'local_write')
          ? verifyHostSealedWriteReceipt({
              db: input.db,
              sessionId: input.sessionId,
              sourceUserSeq: input.sourceUserSeq,
              acceptedTaskId: input.acceptedTaskId,
              manifest: input.manifest,
              node: entry.node,
              obligation: entry.obligation,
              transition,
            })
          : {
              ok: false as const,
              status: 'not_ready' as const,
              reason: `obligation ${entry.node.nodeId}:${entry.obligation} has no normalized terminal verifier`,
            };
      if (!receipt.ok) return receipt;
    }
    if (declared.some((entry) => entry.obligation === 'execution_terminal')) {
      const execution = verifySettledExecutionInTransaction({
        db: input.db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
      });
      if (!execution.ok) return execution;
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 'unreadable',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
    };
  }
}
