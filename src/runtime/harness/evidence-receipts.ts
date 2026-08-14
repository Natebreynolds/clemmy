/**
 * Typed, host-issued evidence receipts.
 *
 * A parented tool occurrence proves WHERE bytes came from. It does not prove
 * what they MEAN. Nothing stops a caller from pointing at a perfectly authentic
 * read and labelling it "the read-back matched" — which is the same circularity
 * as a `satisfied: true` flag, just with a call id attached.
 *
 * So meaning is computed here, by the host, from the bytes themselves:
 *
 *   collection      record identities + aggregate digest + no continuation
 *   derivation      source digest → output digest
 *   commit          the external-write ledger receipt, bound to task and target
 *   readback        expected digest vs observed digest, compared here
 *   reconciliation  before/after target digests
 *   send            a durable provider receipt, because a send cannot be re-read
 *
 * The caller supplies bytes and identity; it never supplies the verdict. A
 * generic successful read therefore cannot satisfy six different obligations by
 * being labelled six different ways.
 *
 * Integrity: a receipt binds the exact content digest of the evidence at issue
 * time. If those bytes are later replaced, redemption fails closed rather than
 * honouring a reference whose meaning has changed underneath it. Evidence
 * truncated at write can never prove completeness or an exact comparison,
 * because the bytes needed to check it are gone.
 */
import { createHash } from 'node:crypto';
import {
  appendEvent,
  insertInternalEventInTransaction,
  listEvents,
  openEventLog,
  publishCommittedInternalEvent,
  resolveToolOutputForAuthority,
  type EventRow,
} from './eventlog.js';
import {
  manifestIdMatches,
  type ObligationManifest,
  type ObligationManifestNode,
} from './obligation-manifest.js';
import {
  redeemSuccessfulSettlementResultForHost,
  type SuccessfulSettlementResultEvidence,
} from './result-handle.js';
import { inspectProviderEnvelope } from './provider-read-evidence.js';

export const EVIDENCE_RECEIPT_EVENT = 'evidence_receipt' as const;

export type EvidenceReceiptKind =
  | 'observation'
  | 'collection'
  | 'derivation'
  | 'commit'
  | 'readback'
  | 'reconciliation'
  | 'send';

export interface EvidenceReceiptIdentity {
  sessionId: string;
  sourceUserSeq: number;
  physicalAttemptId: string;
  /** The tool occurrence whose bytes back this receipt. */
  callId: string;
  tool: string;
  effect: string;
}

export interface IssuedReceipt {
  receiptId: string;
  kind: EvidenceReceiptKind;
}

export interface ReceiptIssueFailure {
  receiptId?: undefined;
  error: string;
}

export type IssueResult = IssuedReceipt | ReceiptIssueFailure;

export interface HostReadReceipt extends IssuedReceipt {
  kind: 'observation' | 'collection';
  obligation: 'source_observed' | 'source_completeness';
  manifestId: string;
  nodeId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  resultHandleId: string;
  recordIdentities: string[];
  aggregateDigest: string;
}

export type HostReadReceiptIssueResult =
  | { status: 'issued' | 'replayed'; receipt: HostReadReceipt }
  | { status: 'missing' | 'refused' | 'conflict' | 'storage_error'; reason: string };

export function digestOf(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input) ?? 'null';
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// ── Normalized host read authority ──────────────────────────────────────────

const HOST_RECEIPT_PROTOCOL_VERSION = 1 as const;

interface AcceptedAuthorityRow {
  accepted_task_id: string;
  graph_id: string;
  graph_hash: string;
  state: 'armed' | 'manifested_verifying' | 'terminal' | 'conflict';
  manifest_id: string | null;
}

interface NormalizedReceiptRow {
  receipt_id: string;
  protocol_version: number;
  semantic_digest: string;
  kind: 'observation' | 'collection';
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  manifest_id: string;
  node_id: string;
  obligation: 'source_observed' | 'source_completeness';
  logical_tool_call_id: string;
  physical_dispatch_id: string;
  result_handle_id: string;
  tool_name: string;
  operation_mode: 'point_read' | 'collection_read';
  raw_payload_sha256: string;
  raw_byte_count: number;
  record_identities_json: string;
  aggregate_digest: string;
  completeness: 'complete' | 'partial' | 'unknown';
  continuation_outstanding: number;
  cursor_repeated: number;
  receipt_event_id: string;
  issued_at: string;
}

interface ReadReceiptFacts {
  kind: 'observation' | 'collection';
  obligation: 'source_observed' | 'source_completeness';
  operationMode: 'point_read' | 'collection_read';
  recordIdentities: string[];
  aggregateDigest: string;
  completeness: 'complete' | 'partial' | 'unknown';
  continuationOutstanding: boolean;
  cursorRepeated: boolean;
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 220);
}

function scalarIdentity(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;
  const normalized = new Map(Object.keys(value).map((key) => [key.replace(/[^a-z0-9]/gi, '').toLowerCase(), key]));
  for (const candidate of ['id', 'recordid', 'uuid', 'uid', 'key', 'identifier']) {
    const key = normalized.get(candidate);
    if (!key) continue;
    const identity = value[key];
    if (
      typeof identity === 'string'
      || typeof identity === 'number'
      || typeof identity === 'boolean'
    ) {
      return `${candidate}:${String(identity)}`;
    }
  }
  return undefined;
}

function valueAtRecordPath(payload: unknown, path: string | null): unknown {
  if (path === null) return undefined;
  if (path === '') return payload;
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, payload);
}

function recordsFromResult(result: SuccessfulSettlementResultEvidence): unknown[] | null {
  const records = valueAtRecordPath(result.rawPayload, result.handle.recordPath);
  if (!Array.isArray(records)) return result.handle.recordPath === null ? null : [];
  return records;
}

function identitiesFromRecords(records: readonly unknown[]): string[] {
  return records.map((record) => scalarIdentity(record) ?? `sha256:${digestOf(record)}`);
}

function readFacts(
  node: ObligationManifestNode,
  result: SuccessfulSettlementResultEvidence,
): { ok: true; facts: ReadReceiptFacts } | { ok: false; reason: string } {
  if (node.effectKind !== 'read') {
    return { ok: false, reason: 'manifest node is not a read and cannot mint read evidence' };
  }
  if (node.operationMode !== 'point_read' && node.operationMode !== 'collection_read') {
    return { ok: false, reason: `read node has unsupported evidence mode '${node.operationMode}'` };
  }
  if (!result.handle.success) {
    return { ok: false, reason: 'settlement result was not successful' };
  }
  if (inspectProviderEnvelope(result.rawPayload).verdict !== 'clean') {
    return { ok: false, reason: 'raw provider envelope is contradictory or was not fully inspected' };
  }
  // The manifest names the obligation this node owes. A collection-shaped
  // read under a resolved-operation contract owes durable OBSERVATION, not
  // source exhaustion — the manifest attached 'source_observed' for it, and a
  // provider with no completeness signal and no cursor can still discharge
  // that. Any node still owing 'source_completeness' keeps the strict gate.
  const observationSufficient = node.operationMode === 'collection_read'
    && node.obligations.includes('source_observed')
    && !node.obligations.includes('source_completeness');
  const records = recordsFromResult(result);
  const recordIdentities = records === null
    ? (node.operationMode === 'point_read' || observationSufficient ? [] : null)
    : identitiesFromRecords(records);
  if (recordIdentities === null) {
    return { ok: false, reason: 'collection result exposes no durable record collection' };
  }
  if (records !== null && records.length !== result.handle.recordCount) {
    return { ok: false, reason: 'durable record count does not match the raw collection' };
  }
  const continuationOutstanding = result.handle.continuationRef !== null;
  const cursorRepeated = result.handle.continuationRepeated;
  if (node.operationMode === 'collection_read') {
    if (!observationSufficient && result.handle.completeness !== 'complete') {
      return { ok: false, reason: `collection result is ${result.handle.completeness}, not complete` };
    }
    if (observationSufficient && result.handle.completeness === 'partial') {
      return { ok: false, reason: 'the provider itself reported this collection result as partial' };
    }
    if (continuationOutstanding) {
      return { ok: false, reason: 'collection result still has an outstanding continuation' };
    }
    if (cursorRepeated) {
      return { ok: false, reason: 'collection result repeated a prior cursor' };
    }
  }
  return {
    ok: true,
    facts: {
      kind: node.operationMode === 'point_read' || observationSufficient
        ? 'observation'
        : 'collection',
      obligation: node.operationMode === 'point_read' || observationSufficient
        ? 'source_observed'
        : 'source_completeness',
      operationMode: node.operationMode,
      recordIdentities,
      aggregateDigest: digestOf(recordIdentities),
      completeness: result.handle.completeness,
      continuationOutstanding,
      cursorRepeated,
    },
  };
}

function authorityManifest(
  db: ReturnType<typeof openEventLog>,
  input: { sessionId: string; sourceUserSeq: number; manifestId: string },
  options: { issuing: boolean },
):
  | { ok: true; authority: AcceptedAuthorityRow; manifest: ObligationManifest }
  | { ok: false; status: 'missing' | 'refused' | 'conflict'; reason: string } {
  const authority = db.prepare(`
    SELECT accepted_task_id, graph_id, graph_hash, state, manifest_id
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as AcceptedAuthorityRow | undefined;
  if (!authority) return { ok: false, status: 'missing', reason: 'accepted task authority is missing' };
  if (authority.state === 'conflict') {
    return { ok: false, status: 'conflict', reason: 'accepted task authority is conflicted' };
  }
  if (
    (options.issuing && authority.state !== 'manifested_verifying')
    || (!options.issuing && !['manifested_verifying', 'terminal'].includes(authority.state))
  ) {
    return { ok: false, status: 'refused', reason: `accepted task authority is ${authority.state}` };
  }
  if (authority.manifest_id !== input.manifestId) {
    return { ok: false, status: 'conflict', reason: 'caller manifest is not the accepted manifest' };
  }
  const rows = db.prepare(`
    SELECT data_json FROM events
     WHERE session_id = ? AND type = 'obligation_manifest'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
  `).all(input.sessionId, input.sourceUserSeq) as Array<{ data_json: string }>;
  if (rows.length !== 1) {
    return {
      ok: false,
      status: rows.length === 0 ? 'missing' : 'conflict',
      reason: `accepted task has ${rows.length} manifest mirror rows`,
    };
  }
  let manifest: ObligationManifest;
  try {
    const data = JSON.parse(rows[0]!.data_json) as { manifest?: ObligationManifest };
    if (!data.manifest) throw new Error('manifest payload is absent');
    manifest = data.manifest;
  } catch (error) {
    return { ok: false, status: 'conflict', reason: `manifest mirror is unreadable: ${boundedReason(error)}` };
  }
  if (
    !manifestIdMatches(manifest)
    || manifest.readiness !== 'ready'
    || manifest.manifestId !== input.manifestId
    || manifest.identity.sessionId !== input.sessionId
    || manifest.identity.sourceUserSeq !== input.sourceUserSeq
    || manifest.graphId !== authority.graph_id
    || manifest.graphHash !== authority.graph_hash
  ) {
    return { ok: false, status: 'conflict', reason: 'manifest mirror conflicts with accepted task authority' };
  }
  return { ok: true, authority, manifest };
}

function receiptBody(input: {
  sessionId: string;
  sourceUserSeq: number;
  authority: AcceptedAuthorityRow;
  manifestId: string;
  node: ObligationManifestNode;
  result: SuccessfulSettlementResultEvidence;
  facts: ReadReceiptFacts;
}): Record<string, unknown> {
  return {
    protocolVersion: HOST_RECEIPT_PROTOCOL_VERSION,
    kind: input.facts.kind,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.authority.accepted_task_id,
    manifestId: input.manifestId,
    nodeId: input.node.nodeId,
    obligation: input.facts.obligation,
    logicalToolCallId: input.result.logicalToolCallId,
    physicalDispatchId: input.result.physicalDispatchId,
    resultHandleId: input.result.resultHandleId,
    toolName: input.result.toolName,
    operationMode: input.facts.operationMode,
    rawPayloadSha256: input.result.rawPayloadSha256,
    rawByteCount: input.result.rawByteCount,
    recordIdentities: input.facts.recordIdentities,
    aggregateDigest: input.facts.aggregateDigest,
    completeness: input.facts.completeness,
    continuationOutstanding: input.facts.continuationOutstanding,
    cursorRepeated: input.facts.cursorRepeated,
  };
}

function hostReceiptFromRow(row: NormalizedReceiptRow): HostReadReceipt | null {
  try {
    const identities = JSON.parse(row.record_identities_json) as unknown;
    if (!Array.isArray(identities) || identities.some((value) => typeof value !== 'string')) return null;
    return {
      receiptId: row.receipt_id,
      kind: row.kind,
      obligation: row.obligation,
      manifestId: row.manifest_id,
      nodeId: row.node_id,
      logicalToolCallId: row.logical_tool_call_id,
      physicalDispatchId: row.physical_dispatch_id,
      resultHandleId: row.result_handle_id,
      recordIdentities: identities,
      aggregateDigest: row.aggregate_digest,
    };
  } catch {
    return null;
  }
}

function normalizedBodyFromRow(row: NormalizedReceiptRow): Record<string, unknown> | null {
  const receipt = hostReceiptFromRow(row);
  if (!receipt) return null;
  return {
    protocolVersion: row.protocol_version,
    kind: row.kind,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    manifestId: row.manifest_id,
    nodeId: row.node_id,
    obligation: row.obligation,
    logicalToolCallId: row.logical_tool_call_id,
    physicalDispatchId: row.physical_dispatch_id,
    resultHandleId: row.result_handle_id,
    toolName: row.tool_name,
    operationMode: row.operation_mode,
    rawPayloadSha256: row.raw_payload_sha256,
    rawByteCount: row.raw_byte_count,
    recordIdentities: receipt.recordIdentities,
    aggregateDigest: row.aggregate_digest,
    completeness: row.completeness,
    continuationOutstanding: row.continuation_outstanding === 1,
    cursorRepeated: row.cursor_repeated === 1,
  };
}

function poisonAcceptedAuthority(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  sourceUserSeq: number,
): void {
  db.prepare(`
    UPDATE accepted_task_authority
       SET state = 'conflict', revision = revision + 1, updated_at = ?
     WHERE session_id = ? AND source_user_seq = ?
       AND state = 'manifested_verifying'
  `).run(new Date().toISOString(), sessionId, sourceUserSeq);
}

/**
 * A frozen expected-work operation is named by its semantic requirement
 * (`read-source`, or `read-source:item:<digest>`), while the settlement/result
 * handle is keyed by the concrete logical invocation. Historical manifests
 * happened to use the logical call id for both. Resolve either shape through
 * the immutable accepted-operation join instead of guessing that the two
 * identifiers are interchangeable.
 */
function logicalCallIdForManifestNode(
  db: ReturnType<typeof openEventLog>,
  input: { sessionId: string; sourceUserSeq: number },
  node: ObligationManifestNode,
): string | null {
  const rows = db.prepare(`
    SELECT logical_tool_call_id, resolved_tool
      FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
       AND (operation_id = ? OR logical_tool_call_id = ?)
     ORDER BY CASE WHEN operation_id = ? THEN 0 ELSE 1 END
     LIMIT 2
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    node.operationId,
    node.operationId,
    node.operationId,
  ) as Array<{ logical_tool_call_id: string; resolved_tool: string }>;
  const matching = [...new Set(rows
    .filter((row) => row.resolved_tool === node.resolvedTool)
    .map((row) => row.logical_tool_call_id))];
  return matching.length === 1 ? matching[0]! : null;
}

/**
 * Issue point-observation or complete-collection evidence from durable host
 * authority only. The caller names the accepted task and manifest node; every
 * verdict, identity, continuation fact and byte digest is derived here.
 */
export function issueHostReadEvidenceForManifestNode(input: {
  sessionId: string;
  sourceUserSeq: number;
  manifestId: string;
  nodeId: string;
}): HostReadReceiptIssueResult {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !input.manifestId.trim()
    || !input.nodeId.trim()
  ) {
    return { status: 'refused', reason: 'exact task and manifest-node identity is required' };
  }
  let mirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const transaction = db.transaction((): HostReadReceiptIssueResult => {
      const manifestState = authorityManifest(db, input, { issuing: true });
      if (!manifestState.ok) {
        return { status: manifestState.status, reason: manifestState.reason };
      }
      const node = manifestState.manifest.nodes.find((entry) => entry.nodeId === input.nodeId);
      if (!node) return { status: 'refused', reason: 'manifest does not declare that node' };
      if (node.effectKind !== 'read') {
        return { status: 'refused', reason: 'manifest node is not a read operation' };
      }
      const logicalToolCallId = logicalCallIdForManifestNode(db, input, node);
      if (!logicalToolCallId) {
        return { status: 'conflict', reason: 'manifest operation has no unique accepted logical call' };
      }
      const result = redeemSuccessfulSettlementResultForHost({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: manifestState.authority.accepted_task_id,
        logicalToolCallId,
      });
      if (result.status !== 'ok') {
        return {
          status: result.status === 'storage_error' ? 'storage_error' : 'refused',
          reason: `manifest read has no authoritative settled result: ${result.reason}`,
        };
      }
      if (result.value.toolName !== node.resolvedTool) {
        return { status: 'conflict', reason: 'manifest capability differs from the settled result' };
      }
      const derived = readFacts(node, result.value);
      if (!derived.ok) return { status: 'refused', reason: derived.reason };
      if (!node.obligations.includes(derived.facts.obligation)) {
        return {
          status: 'conflict',
          reason: `manifest node does not declare derived obligation '${derived.facts.obligation}'`,
        };
      }
      const body = receiptBody({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        authority: manifestState.authority,
        manifestId: input.manifestId,
        node,
        result: result.value,
        facts: derived.facts,
      });
      const semanticDigest = digestOf(body);
      const receiptId = `evidence:v${HOST_RECEIPT_PROTOCOL_VERSION}:${semanticDigest}`;
      const existing = db.prepare(`
        SELECT * FROM evidence_receipts
         WHERE session_id = ? AND source_user_seq = ?
           AND manifest_id = ? AND node_id = ? AND obligation = ?
      `).get(
        input.sessionId,
        input.sourceUserSeq,
        input.manifestId,
        input.nodeId,
        derived.facts.obligation,
      ) as NormalizedReceiptRow | undefined;
      if (existing) {
        const projected = hostReceiptFromRow(existing);
        const existingBody = normalizedBodyFromRow(existing);
        if (
          projected
          && existingBody
          && existing.receipt_id === receiptId
          && existing.semantic_digest === semanticDigest
          && digestOf(existingBody) === semanticDigest
        ) {
          return { status: 'replayed', receipt: projected };
        }
        poisonAcceptedAuthority(db, input.sessionId, input.sourceUserSeq);
        return { status: 'conflict', reason: 'a different read receipt already owns this obligation' };
      }

      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: manifestState.manifest.identity.turn,
        role: 'system',
        type: EVIDENCE_RECEIPT_EVENT,
        data: {
          protocolVersion: HOST_RECEIPT_PROTOCOL_VERSION,
          receiptId,
          kind: derived.facts.kind,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: manifestState.authority.accepted_task_id,
          manifestId: input.manifestId,
          nodeId: input.nodeId,
          obligation: derived.facts.obligation,
          logicalToolCallId: result.value.logicalToolCallId,
          physicalDispatchId: result.value.physicalDispatchId,
          resultHandleId: result.value.resultHandleId,
          recordCount: derived.facts.recordIdentities.length,
          aggregateDigest: derived.facts.aggregateDigest,
          rawPayloadSha256: result.value.rawPayloadSha256,
        },
      });
      db.prepare(`
        INSERT INTO evidence_receipts
          (receipt_id, protocol_version, semantic_digest, kind,
           session_id, source_user_seq, accepted_task_id, manifest_id,
           node_id, obligation, logical_tool_call_id, physical_dispatch_id,
           result_handle_id, tool_name, operation_mode, raw_payload_sha256,
           raw_byte_count, record_identities_json, aggregate_digest,
           completeness, continuation_outstanding, cursor_repeated,
           receipt_event_id, issued_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId,
        semanticDigest,
        derived.facts.kind,
        input.sessionId,
        input.sourceUserSeq,
        manifestState.authority.accepted_task_id,
        input.manifestId,
        input.nodeId,
        derived.facts.obligation,
        result.value.logicalToolCallId,
        result.value.physicalDispatchId,
        result.value.resultHandleId,
        result.value.toolName,
        derived.facts.operationMode,
        result.value.rawPayloadSha256,
        result.value.rawByteCount,
        JSON.stringify(derived.facts.recordIdentities),
        derived.facts.aggregateDigest,
        derived.facts.completeness,
        derived.facts.continuationOutstanding ? 1 : 0,
        derived.facts.cursorRepeated ? 1 : 0,
        mirror.id,
        mirror.createdAt,
      );
      const inserted = db.prepare('SELECT * FROM evidence_receipts WHERE receipt_id = ?')
        .get(receiptId) as NormalizedReceiptRow | undefined;
      const projected = inserted ? hostReceiptFromRow(inserted) : null;
      if (!projected) throw new Error('committed evidence receipt could not be read back');
      return { status: 'issued', receipt: projected };
    });
    const outcome = transaction.immediate();
    if (outcome.status === 'issued' && mirror) publishCommittedInternalEvent(mirror);
    return outcome;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export interface RedeemedHostReadReceipt {
  ok: true;
  receipt: HostReadReceipt & {
    acceptedTaskId: string;
    toolName: string;
    rawPayloadSha256: string;
    rawByteCount: number;
  };
}

/** Revalidate normalized receipt, manifest, settlement, handle and raw bytes. */
export function redeemHostReadEvidenceReceipt(
  sessionId: string,
  receiptId: string,
  expect: {
    expectKind?: 'observation' | 'collection';
    sourceUserSeq?: number;
    manifestId?: string;
    nodeId?: string;
    obligation?: 'source_observed' | 'source_completeness';
    physicalDispatchId?: string;
  } = {},
): RedeemedHostReadReceipt | UnredeemableReceipt {
  try {
    const db = openEventLog();
    const row = db.prepare('SELECT * FROM evidence_receipts WHERE receipt_id = ?')
      .get(receiptId) as NormalizedReceiptRow | undefined;
    if (!row) return { ok: false, reason: 'no such normalized evidence receipt' };
    if (row.session_id !== sessionId) return { ok: false, reason: 'receipt belongs to another session' };
    if (expect.expectKind && row.kind !== expect.expectKind) {
      return { ok: false, reason: `receipt is a '${row.kind}', not a '${expect.expectKind}'` };
    }
    if (expect.sourceUserSeq !== undefined && row.source_user_seq !== expect.sourceUserSeq) {
      return { ok: false, reason: 'receipt belongs to a different accepted task' };
    }
    if (expect.manifestId !== undefined && row.manifest_id !== expect.manifestId) {
      return { ok: false, reason: 'receipt belongs to a different manifest' };
    }
    if (expect.nodeId !== undefined && row.node_id !== expect.nodeId) {
      return { ok: false, reason: 'receipt belongs to a different manifest node' };
    }
    if (expect.obligation !== undefined && row.obligation !== expect.obligation) {
      return { ok: false, reason: 'receipt proves a different obligation' };
    }
    if (
      expect.physicalDispatchId !== undefined
      && row.physical_dispatch_id !== expect.physicalDispatchId
    ) {
      return { ok: false, reason: 'receipt belongs to a different physical dispatch' };
    }
    const manifestState = authorityManifest(db, {
      sessionId,
      sourceUserSeq: row.source_user_seq,
      manifestId: row.manifest_id,
    }, { issuing: false });
    if (!manifestState.ok) return { ok: false, reason: manifestState.reason };
    if (manifestState.authority.accepted_task_id !== row.accepted_task_id) {
      return { ok: false, reason: 'receipt accepted-task owner no longer matches authority' };
    }
    const node = manifestState.manifest.nodes.find((entry) => entry.nodeId === row.node_id);
    const logicalToolCallId = node
      ? logicalCallIdForManifestNode(db, {
          sessionId,
          sourceUserSeq: row.source_user_seq,
        }, node)
      : null;
    if (!node || logicalToolCallId !== row.logical_tool_call_id || node.resolvedTool !== row.tool_name) {
      return { ok: false, reason: 'receipt no longer matches its exact manifest operation' };
    }
    const result = redeemSuccessfulSettlementResultForHost({
      sessionId,
      sourceUserSeq: row.source_user_seq,
      acceptedTaskId: row.accepted_task_id,
      logicalToolCallId: row.logical_tool_call_id,
    });
    if (result.status !== 'ok') {
      return { ok: false, reason: `backing settlement result is ${result.status}: ${result.reason}` };
    }
    const derived = readFacts(node, result.value);
    if (!derived.ok) return { ok: false, reason: derived.reason };
    const body = receiptBody({
      sessionId,
      sourceUserSeq: row.source_user_seq,
      authority: manifestState.authority,
      manifestId: row.manifest_id,
      node,
      result: result.value,
      facts: derived.facts,
    });
    const semanticDigest = digestOf(body);
    const storedBody = normalizedBodyFromRow(row);
    if (
      !storedBody
      || row.protocol_version !== HOST_RECEIPT_PROTOCOL_VERSION
      || row.receipt_id !== `evidence:v${HOST_RECEIPT_PROTOCOL_VERSION}:${semanticDigest}`
      || row.semantic_digest !== semanticDigest
      || digestOf(storedBody) !== semanticDigest
      || row.result_handle_id !== result.value.resultHandleId
      || row.physical_dispatch_id !== result.value.physicalDispatchId
      || row.raw_payload_sha256 !== result.value.rawPayloadSha256
      || row.raw_byte_count !== result.value.rawByteCount
    ) {
      return { ok: false, reason: 'normalized receipt content no longer matches its authority' };
    }
    const mirror = db.prepare(`
      SELECT session_id, type, data_json FROM events WHERE id = ?
    `).get(row.receipt_event_id) as { session_id: string; type: string; data_json: string } | undefined;
    if (!mirror || mirror.session_id !== sessionId || mirror.type !== EVIDENCE_RECEIPT_EVENT) {
      return { ok: false, reason: 'normalized receipt mirror is missing or mismatched' };
    }
    try {
      const data = JSON.parse(mirror.data_json) as Record<string, unknown>;
      if (
        data.receiptId !== row.receipt_id
        || data.sourceUserSeq !== row.source_user_seq
        || data.manifestId !== row.manifest_id
        || data.nodeId !== row.node_id
        || data.resultHandleId !== row.result_handle_id
      ) {
        return { ok: false, reason: 'normalized receipt mirror conflicts with authority' };
      }
    } catch {
      return { ok: false, reason: 'normalized receipt mirror is unreadable' };
    }
    const projected = hostReceiptFromRow(row);
    if (!projected) return { ok: false, reason: 'normalized receipt identities are unreadable' };
    return {
      ok: true,
      receipt: {
        ...projected,
        acceptedTaskId: row.accepted_task_id,
        toolName: row.tool_name,
        rawPayloadSha256: row.raw_payload_sha256,
        rawByteCount: row.raw_byte_count,
      },
    };
  } catch (error) {
    return { ok: false, reason: `receipt store unreadable: ${boundedReason(error)}` };
  }
}

/**
 * Bind a receipt to the exact bytes behind it.
 *
 * Refuses when the occurrence is not authoritative, belongs to another accepted
 * task, or was truncated at write — truncated bytes cannot support any claim
 * that depends on seeing all of them.
 */
function bindEvidence(
  identity: EvidenceReceiptIdentity,
  options: { requireUntruncated: boolean },
): { contentDigest: string; output: string } | { error: string } {
  const resolution = resolveToolOutputForAuthority(identity.sessionId, identity.callId);
  if (resolution.status !== 'ok') {
    return { error: `evidence ${identity.callId} resolves as '${resolution.status}', not authoritative` };
  }
  const record = (resolution as { record: { output: string; truncatedAtWrite: boolean; tool: string | null } }).record;
  const boundSource = (resolution as { sourceUserSeq?: number | null }).sourceUserSeq;
  if (boundSource !== null && boundSource !== undefined && boundSource !== identity.sourceUserSeq) {
    return { error: `evidence ${identity.callId} belongs to accepted source ${boundSource}` };
  }
  const boundEffect = (resolution as { effect?: string | null }).effect;
  if (boundEffect && boundEffect !== identity.effect) {
    return { error: `evidence ${identity.callId} has effect '${boundEffect}', not '${identity.effect}'` };
  }
  if (record.tool && identity.tool && record.tool !== identity.tool) {
    return { error: `evidence ${identity.callId} came from '${record.tool}', not '${identity.tool}'` };
  }
  if (options.requireUntruncated && record.truncatedAtWrite) {
    return { error: `evidence ${identity.callId} was truncated at write and cannot prove completeness` };
  }
  return { contentDigest: digestOf(record.output), output: record.output };
}

function issue(
  identity: EvidenceReceiptIdentity,
  kind: EvidenceReceiptKind,
  payload: Record<string, unknown>,
  options: { requireUntruncated: boolean },
): IssueResult {
  const bound = bindEvidence(identity, options);
  if ('error' in bound) return { error: bound.error };

  const receiptId = `receipt:${kind}:${digestOf({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    physicalAttemptId: identity.physicalAttemptId,
    callId: identity.callId,
    kind,
    payload,
  })}`;

  try {
    appendEvent({
      sessionId: identity.sessionId,
      turn: 0,
      role: 'system',
      type: EVIDENCE_RECEIPT_EVENT,
      data: {
        receiptId,
        kind,
        sourceUserSeq: identity.sourceUserSeq,
        physicalAttemptId: identity.physicalAttemptId,
        callId: identity.callId,
        tool: identity.tool,
        effect: identity.effect,
        contentDigest: bound.contentDigest,
        ...payload,
      },
    });
  } catch (error) {
    return { error: `receipt could not be persisted: ${String(error)}` };
  }
  return { receiptId, kind };
}

// ── Issuers. Each COMPUTES its verdict; none accepts one. ────────────────────

/** A collection is complete only when the source was exhausted. */
export function issueCollectionReceipt(input: {
  identity: EvidenceReceiptIdentity;
  recordIdentities: readonly string[];
  continuationOutstanding: boolean;
}): IssueResult {
  if (input.continuationOutstanding) {
    return { error: 'a collection with an outstanding continuation is not complete' };
  }
  return issue(input.identity, 'collection', {
    recordIdentities: [...input.recordIdentities],
    aggregateDigest: digestOf([...input.recordIdentities].sort()),
    continuationOutstanding: false,
  }, { requireUntruncated: true });
}

/** The output must be derived from a source this run actually collected. */
export function issueDerivationReceipt(input: {
  identity: EvidenceReceiptIdentity;
  sourceReceiptId: string;
  output: unknown;
}): IssueResult {
  const source = redeemEvidenceReceipt(input.identity.sessionId, input.sourceReceiptId, {
    expectKind: 'collection',
    sourceUserSeq: input.identity.sourceUserSeq,
  });
  if (!source.ok) return { error: `derivation cites an unredeemable source: ${source.reason}` };
  return issue(input.identity, 'derivation', {
    sourceReceiptId: input.sourceReceiptId,
    sourceDigest: source.receipt.aggregateDigest,
    outputDigest: digestOf(input.output),
  }, { requireUntruncated: true });
}

/** A commit is proved by the external-write ledger, not by a hopeful string. */
export function issueCommitReceipt(input: {
  identity: EvidenceReceiptIdentity;
  ledgerRef: string;
  target: string;
}): IssueResult {
  const ledgered = listEvents(input.identity.sessionId, { types: ['external_write_succeeded'] })
    .some((event) => {
      const data = event.data as Record<string, unknown>;
      return data?.canonicalCallId === input.ledgerRef || data?.callId === input.ledgerRef;
    });
  if (!ledgered) {
    return { error: `no external-write ledger entry for '${input.ledgerRef}'` };
  }
  return issue(input.identity, 'commit', {
    ledgerRef: input.ledgerRef,
    target: input.target,
  }, { requireUntruncated: false });
}

/** The comparison happens HERE. "I looked" cannot be passed in as "it matched". */
export function issueReadbackReceipt(input: {
  identity: EvidenceReceiptIdentity;
  expected: unknown;
  observed: unknown;
  target: string;
}): IssueResult {
  const expectedDigest = digestOf(input.expected);
  const observedDigest = digestOf(input.observed);
  if (expectedDigest !== observedDigest) {
    return { error: 'the read-back did not match the derived representation' };
  }
  return issue(input.identity, 'readback', {
    expectedDigest, observedDigest, matched: true, target: input.target,
  }, { requireUntruncated: true });
}

/** Reconciliation is a before/after fact about the destination. */
export function issueReconciliationReceipt(input: {
  identity: EvidenceReceiptIdentity;
  before: unknown;
  after: unknown;
  staleRemaining: number;
  target: string;
}): IssueResult {
  if (input.staleRemaining > 0) {
    return { error: `${input.staleRemaining} rows from a previous artifact remain in the destination` };
  }
  return issue(input.identity, 'reconciliation', {
    beforeDigest: digestOf(input.before),
    afterDigest: digestOf(input.after),
    staleRemaining: 0,
    target: input.target,
  }, { requireUntruncated: true });
}

/** An irreversible send is proved by a durable provider receipt. */
export function issueSendReceipt(input: {
  identity: EvidenceReceiptIdentity;
  providerReceiptId: string;
  target: string;
}): IssueResult {
  if (!input.providerReceiptId.trim()) {
    return { error: 'an irreversible send with no durable provider receipt is unverified' };
  }
  return issue(input.identity, 'send', {
    providerReceiptId: input.providerReceiptId, target: input.target,
  }, { requireUntruncated: false });
}

// ── Redemption ───────────────────────────────────────────────────────────────

export interface RedeemedReceipt {
  ok: true;
  receipt: Record<string, unknown> & { kind: EvidenceReceiptKind; aggregateDigest?: string };
}
export interface UnredeemableReceipt { ok: false; reason: string }

/**
 * Redeem a receipt, re-checking everything that could have changed since issue.
 *
 * The content digest is recomputed from the CURRENT durable bytes: if the
 * underlying output was replaced after the receipt was written, the receipt no
 * longer describes what is there, and it fails closed.
 */
export function redeemEvidenceReceipt(
  sessionId: string,
  receiptId: string,
  expect: {
    expectKind?: EvidenceReceiptKind;
    sourceUserSeq?: number;
    physicalAttemptId?: string;
    effect?: string;
  } = {},
): RedeemedReceipt | UnredeemableReceipt {
  // New task-scoped authority is normalized. Its event is only a mirror and
  // legacy tool_output rows are never consulted for an armed accepted task.
  try {
    const db = openEventLog();
    const normalized = db.prepare(
      'SELECT kind, source_user_seq, physical_dispatch_id FROM evidence_receipts WHERE receipt_id = ?',
    ).get(receiptId) as {
      kind: 'observation' | 'collection';
      source_user_seq: number;
      physical_dispatch_id: string;
    } | undefined;
    if (normalized) {
      if (expect.expectKind && normalized.kind !== expect.expectKind) {
        return { ok: false, reason: `receipt is a '${normalized.kind}', not a '${expect.expectKind}'` };
      }
      if (expect.effect !== undefined && expect.effect !== 'read') {
        return { ok: false, reason: `normalized read receipt cannot prove effect '${expect.effect}'` };
      }
      const redeemed = redeemHostReadEvidenceReceipt(sessionId, receiptId, {
        expectKind: normalized.kind,
        ...(expect.sourceUserSeq === undefined ? {} : { sourceUserSeq: expect.sourceUserSeq }),
        ...(expect.physicalAttemptId === undefined
          ? {}
          : { physicalDispatchId: expect.physicalAttemptId }),
      });
      return redeemed.ok
        ? { ok: true, receipt: { ...redeemed.receipt } as RedeemedReceipt['receipt'] }
        : redeemed;
    }
    const armed = db.prepare(`
      SELECT 1 FROM accepted_task_authority
       WHERE session_id = ?
         AND (? IS NULL OR source_user_seq = ?)
       LIMIT 1
    `).get(
      sessionId,
      expect.sourceUserSeq ?? null,
      expect.sourceUserSeq ?? null,
    );
    if (armed) {
      return { ok: false, reason: 'legacy event/tool-output receipts cannot authorize an armed accepted task' };
    }
  } catch (error) {
    return { ok: false, reason: `receipt store unreadable: ${boundedReason(error)}` };
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = listEvents(sessionId, { types: [EVIDENCE_RECEIPT_EVENT] })
      .map((event) => event.data as Record<string, unknown>)
      .filter((data) => data?.receiptId === receiptId);
  } catch (error) {
    return { ok: false, reason: `receipt store unreadable: ${String(error)}` };
  }
  if (rows.length === 0) return { ok: false, reason: 'no such receipt' };
  if (rows.length > 1) return { ok: false, reason: 'receipt id is ambiguous' };
  const receipt = rows[0];

  if (expect.expectKind && receipt.kind !== expect.expectKind) {
    return { ok: false, reason: `receipt is a '${String(receipt.kind)}', not a '${expect.expectKind}'` };
  }
  if (expect.sourceUserSeq !== undefined && receipt.sourceUserSeq !== expect.sourceUserSeq) {
    return { ok: false, reason: 'receipt belongs to a different accepted task' };
  }
  if (expect.physicalAttemptId !== undefined && receipt.physicalAttemptId !== expect.physicalAttemptId) {
    return { ok: false, reason: 'receipt belongs to a different physical attempt' };
  }
  if (expect.effect !== undefined && receipt.effect !== expect.effect) {
    return { ok: false, reason: `receipt records effect '${String(receipt.effect)}', not '${expect.effect}'` };
  }

  // Integrity: the bytes must still be the bytes.
  const resolution = resolveToolOutputForAuthority(sessionId, String(receipt.callId ?? ''));
  if (resolution.status !== 'ok') {
    return { ok: false, reason: `backing evidence now resolves as '${resolution.status}'` };
  }
  const current = (resolution as { record: { output: string } }).record.output;
  if (digestOf(current) !== receipt.contentDigest) {
    return { ok: false, reason: 'backing evidence changed after the receipt was issued' };
  }

  return { ok: true, receipt: receipt as RedeemedReceipt['receipt'] };
}

/** Which receipt kind proves which obligation. */
export const OBLIGATION_RECEIPT_KIND: Record<string, EvidenceReceiptKind> = {
  source_observed: 'observation',
  source_completeness: 'collection',
  derivation_from_current_source: 'derivation',
  commit_effect: 'commit',
  verify_committed_readback: 'readback',
  verify_committed_receipt: 'send',
  stale_destination_reconciled: 'reconciliation',
};
