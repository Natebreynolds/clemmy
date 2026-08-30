/**
 * Append-only lineage for one model-visible result projected from an immutable
 * logical-call settlement.
 *
 * The settlement/result-handle kernel remains provider-outcome authority. This
 * metadata receipt seals only the exact canonical `function_call_result` byte
 * count and SHA-256 handed back to the model, including structured/media
 * projections. It deliberately copies neither those payload bytes nor a
 * second raw-provider-payload field into SQLite.
 */
import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import type { AcceptedModelBatchRef } from './accepted-model-batch-checkpoint.js';
import {
  canonicalHostModelResultClass,
  canonicalModelResultJson,
} from './host-model-result-receipt.js';
import { inspectConversationProtocol } from './conversation-protocol.js';
import { openEventLog } from './eventlog.js';

export const LOGICAL_MODEL_RESULT_PROJECTION_RECEIPT_PROTOCOL_VERSION = 1 as const;

export type LogicalModelResultProjectionClass =
  | 'text'
  | 'structured'
  | 'media'
  | 'refused_pre_dispatch'
  | 'not_started'
  | 'user_rejected'
  | 'effect_unknown';

export type LogicalModelResultSettlementIdentityKind = 'logical' | 'observer';

type HarnessDb = ReturnType<typeof openEventLog>;
type ItemRecord = Record<string, unknown>;

export interface LogicalModelResultProjectionDescriptor {
  callId: string;
  toolName: string;
  callNamespace: string | null;
  resultClass: LogicalModelResultProjectionClass;
  resultItemBytes: number;
  resultItemSha256: string;
  item: AgentInputItem;
}

export interface LogicalModelResultProjectionReceiptRow {
  receipt_id: string;
  protocol_version: number;
  session_id: string;
  source_user_seq: number;
  source_event_id: string;
  accepted_task_id: string;
  batch_ordinal: number;
  batch_id: string;
  call_id: string;
  tool_name: string;
  call_namespace: string | null;
  settlement_identity_kind: LogicalModelResultSettlementIdentityKind;
  settlement_logical_tool_call_id: string;
  settlement_observer_call_id: string | null;
  settlement_event_id: string;
  settlement_semantic_digest: string;
  result_class: LogicalModelResultProjectionClass;
  result_item_bytes: number;
  result_item_sha256: string;
  recorded_at: string;
}

export interface LogicalModelResultProjectionReceipt {
  receiptId: string;
  protocolVersion: typeof LOGICAL_MODEL_RESULT_PROJECTION_RECEIPT_PROTOCOL_VERSION;
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  acceptedTaskId: string;
  batchOrdinal: number;
  batchId: string;
  callId: string;
  toolName: string;
  callNamespace: string | null;
  settlementIdentityKind: LogicalModelResultSettlementIdentityKind;
  settlementLogicalToolCallId: string;
  settlementObserverCallId: string | null;
  settlementEventId: string;
  settlementSemanticDigest: string;
  resultClass: LogicalModelResultProjectionClass;
  resultItemBytes: number;
  resultItemSha256: string;
  recordedAt: string;
  receiptDigest: string;
}

interface SettlementCandidate {
  logical_tool_call_id: string;
  logical_tool_name: string;
  observer_call_id: string | null;
  settlement_event_id: string;
  semantic_digest: string;
}

export interface LogicalModelResultProjectionReceiptIdentity {
  protocol: 'clementine.logical_model_result_projection_receipt.v1';
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  acceptedTaskId: string;
  batchOrdinal: number;
  batchId: string;
  callId: string;
  toolName: string;
  callNamespace: string | null;
  settlementIdentityKind: LogicalModelResultSettlementIdentityKind;
  settlementLogicalToolCallId: string;
  settlementObserverCallId: string | null;
  settlementEventId: string;
  settlementSemanticDigest: string;
  resultClass: LogicalModelResultProjectionClass;
  resultItemBytes: number;
  resultItemSha256: string;
}

export type RecordLogicalModelResultProjectionReceiptResult =
  | {
      status: 'recorded' | 'existing';
      receipt: LogicalModelResultProjectionReceipt;
    }
  | { status: 'not_applicable'; reason: string }
  | { status: 'invalid' | 'missing' | 'ambiguous' | 'conflict' | 'unavailable'; reason: string };

const SHA256 = /^[a-f0-9]{64}$/;
const RESULT_CLASSES: ReadonlySet<string> = new Set<LogicalModelResultProjectionClass>([
  'text',
  'structured',
  'media',
  'refused_pre_dispatch',
  'not_started',
  'user_rejected',
  'effect_unknown',
]);

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function itemRecord(item: AgentInputItem): ItemRecord {
  return item as unknown as ItemRecord;
}

function mediaProjection(output: unknown): boolean {
  const entries = Array.isArray(output) ? output : [output];
  return entries.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const type = (entry as ItemRecord).type;
    return type === 'image' || type === 'file' || type === 'input_image' || type === 'input_file';
  });
}

function exactTextProjection(output: unknown): boolean {
  if (typeof output === 'string') return true;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const row = output as ItemRecord;
  return row.type === 'text'
    && typeof row.text === 'string'
    && Object.keys(row).every((key) => key === 'type' || key === 'text');
}

export function logicalModelResultProjectionClass(
  item: AgentInputItem,
): LogicalModelResultProjectionClass {
  const reserved = canonicalHostModelResultClass(item);
  if (reserved) return reserved;
  const output = itemRecord(item).output;
  if (mediaProjection(output)) return 'media';
  if (exactTextProjection(output)) return 'text';
  return 'structured';
}

/** Canonical whole-item bytes. This is intentionally broader than the host
 * receipt's output-only digest: call/name/status/namespace and every projected
 * structured field are part of the immutable evidence. */
export function canonicalLogicalModelResultItemBytes(item: AgentInputItem): string {
  return canonicalModelResultJson(item);
}

export function logicalModelResultItemDigest(item: AgentInputItem): string {
  return sha256(canonicalLogicalModelResultItemBytes(item));
}

export function describeLogicalModelResultProjection(
  item: AgentInputItem,
): LogicalModelResultProjectionDescriptor | null {
  const row = itemRecord(item);
  const callId = typeof row.callId === 'string' ? row.callId.trim() : '';
  const toolName = typeof row.name === 'string' ? row.name.trim() : '';
  if (row.namespace !== undefined && typeof row.namespace !== 'string') return null;
  const callNamespace = typeof row.namespace === 'string' ? row.namespace : null;
  if (
    row.type !== 'function_call_result'
    || row.status !== 'completed'
    || !callId
    || !toolName
    || row.output === undefined
  ) return null;
  let canonicalBytes: string;
  try {
    canonicalBytes = canonicalLogicalModelResultItemBytes(item);
  } catch {
    return null;
  }
  return {
    callId,
    toolName,
    callNamespace,
    resultClass: logicalModelResultProjectionClass(item),
    resultItemBytes: Buffer.byteLength(canonicalBytes, 'utf8'),
    resultItemSha256: sha256(canonicalBytes),
    item,
  };
}

function projectionReceiptIdentity(input: {
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  acceptedTaskId: string;
  batchOrdinal: number;
  batchId: string;
  descriptor: LogicalModelResultProjectionDescriptor;
  settlementIdentityKind: LogicalModelResultSettlementIdentityKind;
  settlement: SettlementCandidate;
}): LogicalModelResultProjectionReceiptIdentity {
  return {
    protocol: 'clementine.logical_model_result_projection_receipt.v1',
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    sourceEventId: input.sourceEventId,
    acceptedTaskId: input.acceptedTaskId,
    batchOrdinal: input.batchOrdinal,
    batchId: input.batchId,
    callId: input.descriptor.callId,
    toolName: input.descriptor.toolName,
    callNamespace: input.descriptor.callNamespace,
    settlementIdentityKind: input.settlementIdentityKind,
    settlementLogicalToolCallId: input.settlement.logical_tool_call_id,
    settlementObserverCallId: input.settlement.observer_call_id,
    settlementEventId: input.settlement.settlement_event_id,
    settlementSemanticDigest: input.settlement.semantic_digest,
    resultClass: input.descriptor.resultClass,
    resultItemBytes: input.descriptor.resultItemBytes,
    resultItemSha256: input.descriptor.resultItemSha256,
  };
}

export function logicalModelResultProjectionReceiptId(
  identity: LogicalModelResultProjectionReceiptIdentity,
): string {
  return sha256(canonicalModelResultJson(identity));
}

export function logicalModelResultProjectionReceiptDigest(
  row: LogicalModelResultProjectionReceiptRow,
): string {
  return sha256(canonicalModelResultJson({
    receiptId: row.receipt_id,
    protocolVersion: row.protocol_version,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    sourceEventId: row.source_event_id,
    acceptedTaskId: row.accepted_task_id,
    batchOrdinal: row.batch_ordinal,
    batchId: row.batch_id,
    callId: row.call_id,
    toolName: row.tool_name,
    callNamespace: row.call_namespace,
    settlementIdentityKind: row.settlement_identity_kind,
    settlementLogicalToolCallId: row.settlement_logical_tool_call_id,
    settlementObserverCallId: row.settlement_observer_call_id,
    settlementEventId: row.settlement_event_id,
    settlementSemanticDigest: row.settlement_semantic_digest,
    resultClass: row.result_class,
    resultItemBytes: row.result_item_bytes,
    resultItemSha256: row.result_item_sha256,
    recordedAt: row.recorded_at,
  }));
}

function identityFromRow(
  row: LogicalModelResultProjectionReceiptRow,
): LogicalModelResultProjectionReceiptIdentity {
  return {
    protocol: 'clementine.logical_model_result_projection_receipt.v1',
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    sourceEventId: row.source_event_id,
    acceptedTaskId: row.accepted_task_id,
    batchOrdinal: row.batch_ordinal,
    batchId: row.batch_id,
    callId: row.call_id,
    toolName: row.tool_name,
    callNamespace: row.call_namespace,
    settlementIdentityKind: row.settlement_identity_kind,
    settlementLogicalToolCallId: row.settlement_logical_tool_call_id,
    settlementObserverCallId: row.settlement_observer_call_id,
    settlementEventId: row.settlement_event_id,
    settlementSemanticDigest: row.settlement_semantic_digest,
    resultClass: row.result_class,
    resultItemBytes: row.result_item_bytes,
    resultItemSha256: row.result_item_sha256,
  };
}

export function logicalModelResultProjectionReceiptFromRow(
  row: LogicalModelResultProjectionReceiptRow,
): LogicalModelResultProjectionReceipt {
  if (
    row.protocol_version !== LOGICAL_MODEL_RESULT_PROJECTION_RECEIPT_PROTOCOL_VERSION
    || !SHA256.test(row.receipt_id)
    || !SHA256.test(row.batch_id)
    || !SHA256.test(row.settlement_semantic_digest)
    || !SHA256.test(row.result_item_sha256)
    || !RESULT_CLASSES.has(row.result_class)
    || (row.settlement_identity_kind !== 'logical' && row.settlement_identity_kind !== 'observer')
  ) throw new Error('logical model result projection receipt has an invalid closed field');
  if (
    logicalModelResultProjectionReceiptId(identityFromRow(row)) !== row.receipt_id
  ) throw new Error('logical model result projection receipt does not recompute exactly');
  return {
    receiptId: row.receipt_id,
    protocolVersion: LOGICAL_MODEL_RESULT_PROJECTION_RECEIPT_PROTOCOL_VERSION,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    sourceEventId: row.source_event_id,
    acceptedTaskId: row.accepted_task_id,
    batchOrdinal: row.batch_ordinal,
    batchId: row.batch_id,
    callId: row.call_id,
    toolName: row.tool_name,
    callNamespace: row.call_namespace,
    settlementIdentityKind: row.settlement_identity_kind,
    settlementLogicalToolCallId: row.settlement_logical_tool_call_id,
    settlementObserverCallId: row.settlement_observer_call_id,
    settlementEventId: row.settlement_event_id,
    settlementSemanticDigest: row.settlement_semantic_digest,
    resultClass: row.result_class,
    resultItemBytes: row.result_item_bytes,
    resultItemSha256: row.result_item_sha256,
    recordedAt: row.recorded_at,
    receiptDigest: logicalModelResultProjectionReceiptDigest(row),
  };
}

export function logicalModelResultProjectionReceiptRowsForCall(
  db: HarnessDb,
  sessionId: string,
  callId: string,
): LogicalModelResultProjectionReceiptRow[] {
  return db.prepare(`
    SELECT * FROM logical_model_result_projection_receipts
     WHERE session_id = ? AND call_id = ?
     ORDER BY source_user_seq, batch_ordinal, receipt_id
  `).all(sessionId, callId) as LogicalModelResultProjectionReceiptRow[];
}

export function logicalModelResultProjectionReceiptForAdmissionCall(input: {
  db: HarnessDb;
  sessionId: string;
  sourceUserSeq: number;
  batchOrdinal: number;
  batchId: string;
  callId: string;
}): LogicalModelResultProjectionReceipt | null {
  const rows = input.db.prepare(`
    SELECT * FROM logical_model_result_projection_receipts
     WHERE session_id = ? AND source_user_seq = ?
       AND batch_ordinal = ? AND batch_id = ? AND call_id = ?
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    input.batchOrdinal,
    input.batchId,
    input.callId,
  ) as LogicalModelResultProjectionReceiptRow[];
  return rows.length === 1 ? logicalModelResultProjectionReceiptFromRow(rows[0]!) : null;
}

export function logicalModelResultProjectionReceiptsForSettlement(input: {
  db: HarnessDb;
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): LogicalModelResultProjectionReceipt[] {
  const rows = input.db.prepare(`
    SELECT * FROM logical_model_result_projection_receipts
     WHERE session_id = ? AND source_user_seq = ?
       AND settlement_logical_tool_call_id = ?
     ORDER BY batch_ordinal, receipt_id
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    input.logicalToolCallId,
  ) as LogicalModelResultProjectionReceiptRow[];
  return rows.map(logicalModelResultProjectionReceiptFromRow);
}

export function logicalModelResultProjectionReceiptMatchesItem(
  receipt: LogicalModelResultProjectionReceipt,
  item: AgentInputItem,
): boolean {
  const descriptor = describeLogicalModelResultProjection(item);
  return descriptor !== null
    && descriptor.callId === receipt.callId
    && descriptor.toolName === receipt.toolName
    && descriptor.callNamespace === receipt.callNamespace
    && descriptor.resultClass === receipt.resultClass
    && descriptor.resultItemBytes === receipt.resultItemBytes
    && descriptor.resultItemSha256 === receipt.resultItemSha256;
}

function exactAdmissionCall(input: {
  preHistoryJson: string;
  frameHistoryJson: string;
  callId: string;
  toolName: string;
  callNamespace: string | null;
}): boolean {
  let pre: unknown;
  let frame: unknown;
  try {
    pre = JSON.parse(input.preHistoryJson) as unknown;
    frame = JSON.parse(input.frameHistoryJson) as unknown;
  } catch {
    return false;
  }
  if (!Array.isArray(pre) || !Array.isArray(frame)) return false;
  if (inspectConversationProtocol(pre as AgentInputItem[]).status !== 'valid') return false;
  if (frame.some((candidate) => (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as ItemRecord).type === 'function_call_result'
  ))) return false;
  const calls = frame.filter((candidate) => (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as ItemRecord).type === 'function_call'
  )) as ItemRecord[];
  const callIds = calls.map((call) => call.callId);
  if (
    calls.length === 0
    || new Set(callIds).size !== calls.length
    || calls.some((call) => (
      typeof call.callId !== 'string' || !call.callId
      || typeof call.name !== 'string' || !call.name
      || (call.namespace !== undefined && typeof call.namespace !== 'string')
    ))
  ) return false;
  const combined = inspectConversationProtocol([
    ...pre as AgentInputItem[],
    ...frame as AgentInputItem[],
  ]);
  const unmatched = combined.issues.filter((issue) => issue.code === 'unmatched_function_call');
  if (
    combined.issues.length !== calls.length
    || unmatched.length !== calls.length
    || new Set(unmatched.map((issue) => issue.callId)).size !== calls.length
    || callIds.some((callId) => !unmatched.some((issue) => issue.callId === callId))
  ) return false;
  return calls.filter((row) => (
    row.callId === input.callId
    && row.name === input.toolName
    && (typeof row.namespace === 'string' ? row.namespace : null) === input.callNamespace
  )).length === 1;
}

/** Record one exact projection only after its visible call resolves to exactly
 * one immutable same-source/task logical identity. Missing/ambiguous evidence
 * is typed and never converted into a synthetic receipt. */
export function recordLogicalModelResultProjectionReceipt(input: {
  admission: AcceptedModelBatchRef;
  resultItem: AgentInputItem;
  now?: () => string;
}): RecordLogicalModelResultProjectionReceiptResult {
  const descriptor = describeLogicalModelResultProjection(input.resultItem);
  if (!descriptor) {
    return { status: 'invalid', reason: 'logical projection writer requires one completed function result' };
  }
  try {
    const db = openEventLog();
    const transact = db.transaction((): RecordLogicalModelResultProjectionReceiptResult => {
      const admission = db.prepare(`
        SELECT admission.pre_history_json, admission.frame_history_json,
               root.source_event_id
          FROM accepted_model_batch_admissions admission
          JOIN accepted_turn_call_authorities root
            ON root.session_id = admission.session_id
           AND root.source_user_seq = admission.source_user_seq
           AND root.accepted_task_id = admission.accepted_task_id
         WHERE admission.session_id = ?
           AND admission.source_user_seq = ?
           AND admission.accepted_task_id = ?
           AND admission.batch_ordinal = ?
           AND admission.batch_id = ?
           AND admission.authority_digest = ?
           AND root.authority_digest = admission.authority_digest
      `).get(
        input.admission.sessionId,
        input.admission.sourceUserSeq,
        input.admission.acceptedTaskId,
        input.admission.batchOrdinal,
        input.admission.batchId,
        input.admission.authorityDigest,
      ) as {
        pre_history_json: string;
        frame_history_json: string;
        source_event_id: string;
      } | undefined;
      if (!admission || !exactAdmissionCall({
        preHistoryJson: admission.pre_history_json,
        frameHistoryJson: admission.frame_history_json,
        callId: descriptor.callId,
        toolName: descriptor.toolName,
        callNamespace: descriptor.callNamespace,
      })) {
        return { status: 'missing', reason: 'logical projection has no exact accepted batch call' };
      }
      const settlements = db.prepare(`
        SELECT settlement.logical_tool_call_id,
               logical.tool_name AS logical_tool_name,
               settlement.observer_call_id,
               settlement.settlement_event_id,
               settlement.semantic_digest
          FROM logical_call_settlements settlement
          JOIN logical_tool_calls logical
            ON logical.session_id = settlement.session_id
           AND logical.source_user_seq = settlement.source_user_seq
           AND logical.logical_tool_call_id = settlement.logical_tool_call_id
         WHERE settlement.session_id = ?
           AND settlement.source_user_seq = ?
           AND logical.accepted_task_id = ?
           AND logical.state = 'settled'
           AND logical.settlement_event_id = settlement.settlement_event_id
           AND (settlement.logical_tool_call_id = ? OR settlement.observer_call_id = ?)
         ORDER BY settlement.logical_tool_call_id
      `).all(
        input.admission.sessionId,
        input.admission.sourceUserSeq,
        input.admission.acceptedTaskId,
        descriptor.callId,
        descriptor.callId,
      ) as SettlementCandidate[];
      if (settlements.length === 0) {
        const visibleIdentities = db.prepare(`
          SELECT logical.source_user_seq, logical.accepted_task_id,
                 logical.logical_tool_call_id, logical.tool_name,
                 logical.state, settlement.observer_call_id
            FROM logical_tool_calls logical
            LEFT JOIN logical_call_settlements settlement
              ON settlement.session_id = logical.session_id
             AND settlement.source_user_seq = logical.source_user_seq
             AND settlement.logical_tool_call_id = logical.logical_tool_call_id
           WHERE logical.session_id = ?
             AND (logical.logical_tool_call_id = ? OR settlement.observer_call_id = ?)
           ORDER BY logical.source_user_seq, logical.logical_tool_call_id
        `).all(
          input.admission.sessionId,
          descriptor.callId,
          descriptor.callId,
        ) as Array<{
          source_user_seq: number;
          accepted_task_id: string;
          logical_tool_call_id: string;
          tool_name: string;
          state: string;
          observer_call_id: string | null;
        }>;
        if (visibleIdentities.length === 0) {
          return {
            status: 'not_applicable',
            reason: 'exact accepted call has no logical or observer identity',
          };
        }
        const exactSource = visibleIdentities.filter((row) => (
          row.source_user_seq === input.admission.sourceUserSeq
          && row.accepted_task_id === input.admission.acceptedTaskId
        ));
        if (exactSource.length > 1) {
          return { status: 'ambiguous', reason: 'logical projection matches multiple open or settled identities' };
        }
        if (exactSource.length === 0) {
          return { status: 'conflict', reason: 'logical projection identity belongs to another accepted source' };
        }
        if (exactSource[0]!.tool_name !== descriptor.toolName) {
          return { status: 'conflict', reason: 'logical projection tool differs from its logical identity' };
        }
        return { status: 'missing', reason: 'logical projection identity is not durably settled' };
      }
      if (settlements.length !== 1) {
        return { status: 'ambiguous', reason: 'logical projection matches multiple settled identities' };
      }
      const settlement = settlements[0]!;
      const logicalMatch = settlement.logical_tool_call_id === descriptor.callId;
      const observerMatch = settlement.observer_call_id === descriptor.callId;
      if (!logicalMatch && !observerMatch) {
        return { status: 'missing', reason: 'logical projection identity is not visible' };
      }
      // Direct calls bind the accepted/model-visible tool name to the logical
      // tool name. A carrier (for example work_call -> a connected provider
      // operation) may deliberately reuse the same call id while recording
      // the provider operation as its logical tool. That differing name is
      // valid only when the immutable settlement independently names this
      // exact accepted call through observer_call_id.
      if (settlement.logical_tool_name !== descriptor.toolName && !observerMatch) {
        return { status: 'conflict', reason: 'logical projection tool differs without an observer mapping' };
      }
      const settlementIdentityKind: LogicalModelResultSettlementIdentityKind = logicalMatch
        && settlement.logical_tool_name === descriptor.toolName
        ? 'logical'
        : 'observer';
      const identity = projectionReceiptIdentity({
        sessionId: input.admission.sessionId,
        sourceUserSeq: input.admission.sourceUserSeq,
        sourceEventId: admission.source_event_id,
        acceptedTaskId: input.admission.acceptedTaskId,
        batchOrdinal: input.admission.batchOrdinal,
        batchId: input.admission.batchId,
        descriptor,
        settlementIdentityKind,
        settlement,
      });
      const receiptId = logicalModelResultProjectionReceiptId(identity);
      const inserted = db.prepare(`
        INSERT INTO logical_model_result_projection_receipts
          (receipt_id, protocol_version, session_id, source_user_seq,
           source_event_id, accepted_task_id, batch_ordinal, batch_id,
           call_id, tool_name, call_namespace, settlement_identity_kind,
           settlement_logical_tool_call_id, settlement_observer_call_id,
           settlement_event_id, settlement_semantic_digest, result_class,
           result_item_bytes, result_item_sha256, recorded_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, source_user_seq, call_id) DO NOTHING
      `).run(
        receiptId,
        input.admission.sessionId,
        input.admission.sourceUserSeq,
        admission.source_event_id,
        input.admission.acceptedTaskId,
        input.admission.batchOrdinal,
        input.admission.batchId,
        descriptor.callId,
        descriptor.toolName,
        descriptor.callNamespace,
        settlementIdentityKind,
        settlement.logical_tool_call_id,
        settlement.observer_call_id,
        settlement.settlement_event_id,
        settlement.semantic_digest,
        descriptor.resultClass,
        descriptor.resultItemBytes,
        descriptor.resultItemSha256,
        input.now?.() ?? new Date().toISOString(),
      );
      const row = db.prepare(`
        SELECT * FROM logical_model_result_projection_receipts
         WHERE session_id = ? AND source_user_seq = ? AND call_id = ?
      `).get(
        input.admission.sessionId,
        input.admission.sourceUserSeq,
        descriptor.callId,
      ) as LogicalModelResultProjectionReceiptRow | undefined;
      if (!row || row.receipt_id !== receiptId) {
        return { status: 'conflict', reason: 'logical projection conflicts with an existing call receipt' };
      }
      let receipt: LogicalModelResultProjectionReceipt;
      try {
        receipt = logicalModelResultProjectionReceiptFromRow(row);
      } catch (error) {
        return {
          status: 'conflict',
          reason: error instanceof Error ? error.message : 'logical projection receipt is corrupt',
        };
      }
      if (!logicalModelResultProjectionReceiptMatchesItem(receipt, descriptor.item)) {
        return { status: 'conflict', reason: 'logical projection receipt changed exact result bytes' };
      }
      return { status: inserted.changes === 1 ? 'recorded' : 'existing', receipt };
    });
    return transact.immediate();
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}
