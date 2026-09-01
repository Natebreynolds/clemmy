import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import { toSmartString } from '@openai/agents-core/utils';
import type { AcceptedModelBatchRef } from './accepted-model-batch-checkpoint.js';
import { openEventLog } from './eventlog.js';

export const HOST_TOOL_DISPOSITION_PROTOCOL = 'host_tool_disposition_v1' as const;
export const USER_REJECTED_HOST_RESULT_TEXT =
  'The user rejected this action. Do not retry it; continue without it or explain what changes.';

export type DurableHostModelResultDisposition =
  | 'refused_pre_dispatch'
  | 'not_started'
  | 'user_rejected';

export type HostToolDisposition =
  | 'refused_pre_dispatch'
  | 'not_started'
  | 'effect_unknown';

export interface HostToolDispositionOutput {
  protocol: typeof HOST_TOOL_DISPOSITION_PROTOCOL;
  disposition: HostToolDisposition;
  frameDigest: string;
  frameIndex: number;
  frameSize: number;
  countsRefusal?: true;
  effect: 'none' | 'may_have_started';
  retry: 'replan' | 'do_not_retry';
  requiresReconciliation: boolean;
  message: string;
  /** Exact host-authored repair detail. It is sealed by digest in the receipt,
   * never duplicated into the receipt row itself. */
  diagnostic?: string;
  /** Host-authored, value-free digest of the exact failing-path set behind a
   * pre-dispatch argument refusal (hex, 16-64 chars). Sealed by digest like
   * `diagnostic`; the no-progress projection reads it to key repair progress
   * without parsing prose. */
  repairKey?: string;
}

export type CanonicalHostModelResultClass =
  | DurableHostModelResultDisposition
  | 'effect_unknown';

type HarnessDb = ReturnType<typeof openEventLog>;
type ItemRecord = Record<string, unknown>;

export interface HostModelResultReceiptRow {
  receipt_id: string;
  session_id: string;
  source_user_seq: number;
  source_event_id: string;
  accepted_task_id: string;
  batch_ordinal: number;
  batch_id: string;
  call_id: string;
  tool_name: string;
  disposition: DurableHostModelResultDisposition;
  frame_digest: string | null;
  frame_index: number | null;
  frame_size: number | null;
  counts_refusal: number;
  retry_mode: 'replan' | 'do_not_retry';
  output_bytes: number;
  output_sha256: string;
  recorded_at: string;
}

export interface HostModelResultReceipt {
  receiptId: string;
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  acceptedTaskId: string;
  batchOrdinal: number;
  batchId: string;
  callId: string;
  toolName: string;
  disposition: DurableHostModelResultDisposition;
  frameDigest: string | null;
  frameIndex: number | null;
  frameSize: number | null;
  countsRefusal: boolean;
  retryMode: 'replan' | 'do_not_retry';
  outputBytes: number;
  outputSha256: string;
  recordedAt: string;
  receiptDigest: string;
}

interface CanonicalHostResultDescriptor {
  callId: string;
  toolName: string;
  disposition: DurableHostModelResultDisposition;
  frameDigest: string | null;
  frameIndex: number | null;
  frameSize: number | null;
  countsRefusal: boolean;
  retryMode: 'replan' | 'do_not_retry';
  outputBytes: number;
  outputSha256: string;
  item: AgentInputItem;
}

const SHA256 = /^[a-f0-9]{64}$/;
/** Host-authored repair keys are hex digests (or a bounded prefix of one). */
const REPAIR_KEY = /^[a-f0-9]{16,64}$/;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The exact deterministic JSON serializer used both when the result item is
 * built and when its model-visible `output` field is sealed. */
export function canonicalModelResultJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('host model result contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return 'null';
  if (typeof value !== 'object') throw new Error('host model result is not JSON-serializable');
  if (ancestors.has(value)) throw new Error('host model result is cyclic');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalModelResultJson(entry, ancestors)).join(',')}]`;
    }
    const record = value as ItemRecord;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalModelResultJson(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function textResultItem(callId: string, toolName: string, output: unknown): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: toolName,
    status: 'completed',
    output: { type: 'text', text: toSmartString(output) },
  } as AgentInputItem;
}

function dispositionMessage(
  disposition: HostToolDisposition,
  retry: 'replan' | 'do_not_retry',
): string {
  if (disposition === 'effect_unknown') {
    return 'Execution may have started. Do not retry this call; reconciliation is required.';
  }
  if (retry === 'do_not_retry') {
    return 'This exact call is unavailable for this request. Do not retry it; use another capability or explain the limitation.';
  }
  return disposition === 'not_started'
    ? 'This call was not started because another call in the same frame could not safely proceed. No effect occurred; replan from the paired results.'
    : 'This call was refused before execution. No effect occurred; correct the call or choose another capability.';
}

export function buildHostToolDispositionResult(input: {
  callId: string;
  toolName: string;
  disposition: HostToolDisposition;
  frameDigest: string;
  frameIndex: number;
  frameSize: number;
  countsRefusal?: boolean;
  retired?: boolean;
  diagnostic?: string;
  repairKey?: string;
}): AgentInputItem {
  const unknown = input.disposition === 'effect_unknown';
  const retry = unknown || input.retired === true ? 'do_not_retry' : 'replan';
  const output: HostToolDispositionOutput = {
    protocol: HOST_TOOL_DISPOSITION_PROTOCOL,
    disposition: input.disposition,
    frameDigest: input.frameDigest,
    frameIndex: input.frameIndex,
    frameSize: input.frameSize,
    ...(input.countsRefusal ? { countsRefusal: true as const } : {}),
    effect: unknown ? 'may_have_started' : 'none',
    retry,
    requiresReconciliation: unknown,
    message: dispositionMessage(input.disposition, retry),
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
    ...(input.repairKey ? { repairKey: input.repairKey } : {}),
  };
  return textResultItem(input.callId, input.toolName, output);
}

export function buildUserRejectedHostResult(callId: string, toolName: string): AgentInputItem {
  return textResultItem(callId, toolName, USER_REJECTED_HOST_RESULT_TEXT);
}

function itemRecord(item: AgentInputItem): ItemRecord {
  return item as unknown as ItemRecord;
}

export function canonicalModelResultOutputBytes(item: AgentInputItem): string {
  const row = itemRecord(item);
  if (row.type !== 'function_call_result' || row.output === undefined) {
    throw new Error('host receipt requires a function-call result output');
  }
  return canonicalModelResultJson(row.output);
}

function exactItemMatches(left: AgentInputItem, right: AgentInputItem): boolean {
  return canonicalModelResultJson(left) === canonicalModelResultJson(right);
}

export function describeCanonicalHostModelResult(
  item: AgentInputItem,
): CanonicalHostResultDescriptor | null {
  const row = itemRecord(item);
  const callId = typeof row.callId === 'string' ? row.callId.trim() : '';
  const toolName = typeof row.name === 'string' ? row.name.trim() : '';
  if (
    row.type !== 'function_call_result'
    || row.status !== 'completed'
    || !callId || !toolName
    || !row.output || typeof row.output !== 'object' || Array.isArray(row.output)
  ) return null;
  const output = row.output as ItemRecord;
  if (output.type !== 'text' || typeof output.text !== 'string') return null;

  const rejected = buildUserRejectedHostResult(callId, toolName);
  if (exactItemMatches(item, rejected)) {
    const outputBytes = canonicalModelResultOutputBytes(item);
    return {
      callId,
      toolName,
      disposition: 'user_rejected',
      frameDigest: null,
      frameIndex: null,
      frameSize: null,
      countsRefusal: false,
      retryMode: 'do_not_retry',
      outputBytes: Buffer.byteLength(outputBytes, 'utf8'),
      outputSha256: sha256(outputBytes),
      item,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.text) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const marker = parsed as Partial<HostToolDispositionOutput>;
  if (
    marker.protocol !== HOST_TOOL_DISPOSITION_PROTOCOL
    || (marker.disposition !== 'refused_pre_dispatch' && marker.disposition !== 'not_started')
    || typeof marker.frameDigest !== 'string' || !SHA256.test(marker.frameDigest)
    || !Number.isSafeInteger(marker.frameIndex) || Number(marker.frameIndex) < 0
    || !Number.isSafeInteger(marker.frameSize) || Number(marker.frameSize) <= 0
    || Number(marker.frameIndex) >= Number(marker.frameSize)
    || (marker.retry !== 'replan' && marker.retry !== 'do_not_retry')
    || marker.effect !== 'none'
    || marker.requiresReconciliation !== false
    || (marker.countsRefusal !== undefined && marker.countsRefusal !== true)
    || (marker.diagnostic !== undefined
      && (typeof marker.diagnostic !== 'string' || !marker.diagnostic))
    || (marker.repairKey !== undefined
      && (typeof marker.repairKey !== 'string' || !REPAIR_KEY.test(marker.repairKey)))
    || (marker.disposition === 'not_started'
      && (marker.retry !== 'replan' || marker.countsRefusal !== undefined))
  ) return null;
  const rebuilt = buildHostToolDispositionResult({
    callId,
    toolName,
    disposition: marker.disposition,
    frameDigest: marker.frameDigest,
    frameIndex: Number(marker.frameIndex),
    frameSize: Number(marker.frameSize),
    countsRefusal: marker.countsRefusal === true,
    retired: marker.retry === 'do_not_retry',
    ...(typeof marker.diagnostic === 'string' ? { diagnostic: marker.diagnostic } : {}),
    ...(typeof marker.repairKey === 'string' ? { repairKey: marker.repairKey } : {}),
  });
  if (!exactItemMatches(item, rebuilt)) return null;
  const outputBytes = canonicalModelResultOutputBytes(item);
  return {
    callId,
    toolName,
    disposition: marker.disposition,
    frameDigest: marker.frameDigest,
    frameIndex: Number(marker.frameIndex),
    frameSize: Number(marker.frameSize),
    countsRefusal: marker.countsRefusal === true,
    retryMode: marker.retry,
    outputBytes: Buffer.byteLength(outputBytes, 'utf8'),
    outputSha256: sha256(outputBytes),
    item,
  };
}

/**
 * Classify the exact reserved host projection carried by one model-visible
 * result.  Durable host-result receipts intentionally exclude
 * `effect_unknown`, but accepted-batch validation still has to distinguish
 * that exact reconciliation projection from an arbitrary tool payload.
 */
export function canonicalHostModelResultClass(
  item: AgentInputItem,
): CanonicalHostModelResultClass | null {
  const durable = describeCanonicalHostModelResult(item);
  if (durable) return durable.disposition;

  const row = itemRecord(item);
  const callId = typeof row.callId === 'string' ? row.callId.trim() : '';
  const toolName = typeof row.name === 'string' ? row.name.trim() : '';
  const output = row.output && typeof row.output === 'object' && !Array.isArray(row.output)
    ? row.output as ItemRecord
    : null;
  if (
    row.type !== 'function_call_result'
    || row.status !== 'completed'
    || !callId
    || !toolName
    || output?.type !== 'text'
    || typeof output.text !== 'string'
  ) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.text) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const marker = parsed as Partial<HostToolDispositionOutput>;
  if (
    marker.protocol !== HOST_TOOL_DISPOSITION_PROTOCOL
    || marker.disposition !== 'effect_unknown'
    || typeof marker.frameDigest !== 'string'
    || !SHA256.test(marker.frameDigest)
    || !Number.isSafeInteger(marker.frameIndex)
    || Number(marker.frameIndex) < 0
    || !Number.isSafeInteger(marker.frameSize)
    || Number(marker.frameSize) <= 0
    || Number(marker.frameIndex) >= Number(marker.frameSize)
    || marker.countsRefusal !== undefined
    || marker.effect !== 'may_have_started'
    || marker.retry !== 'do_not_retry'
    || marker.requiresReconciliation !== true
    || marker.diagnostic !== undefined
    || marker.repairKey !== undefined
  ) return null;
  const rebuilt = buildHostToolDispositionResult({
    callId,
    toolName,
    disposition: 'effect_unknown',
    frameDigest: marker.frameDigest,
    frameIndex: Number(marker.frameIndex),
    frameSize: Number(marker.frameSize),
  });
  return exactItemMatches(item, rebuilt) ? 'effect_unknown' : null;
}

function receiptIdentity(input: {
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  acceptedTaskId: string;
  batchOrdinal: number;
  batchId: string;
  descriptor: CanonicalHostResultDescriptor;
}): Record<string, unknown> {
  return {
    protocol: 'clementine.host_model_result_receipt.v1',
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    sourceEventId: input.sourceEventId,
    acceptedTaskId: input.acceptedTaskId,
    batchOrdinal: input.batchOrdinal,
    batchId: input.batchId,
    callId: input.descriptor.callId,
    toolName: input.descriptor.toolName,
    disposition: input.descriptor.disposition,
    frameDigest: input.descriptor.frameDigest,
    frameIndex: input.descriptor.frameIndex,
    frameSize: input.descriptor.frameSize,
    countsRefusal: input.descriptor.countsRefusal,
    retryMode: input.descriptor.retryMode,
    outputBytes: input.descriptor.outputBytes,
    outputSha256: input.descriptor.outputSha256,
  };
}

export function hostModelResultReceiptDigest(row: HostModelResultReceiptRow): string {
  return sha256(canonicalModelResultJson({
    receiptId: row.receipt_id,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    sourceEventId: row.source_event_id,
    acceptedTaskId: row.accepted_task_id,
    batchOrdinal: row.batch_ordinal,
    batchId: row.batch_id,
    callId: row.call_id,
    toolName: row.tool_name,
    disposition: row.disposition,
    frameDigest: row.frame_digest,
    frameIndex: row.frame_index,
    frameSize: row.frame_size,
    countsRefusal: row.counts_refusal,
    retryMode: row.retry_mode,
    outputBytes: row.output_bytes,
    outputSha256: row.output_sha256,
    recordedAt: row.recorded_at,
  }));
}

export function hostModelResultReceiptFromRow(row: HostModelResultReceiptRow): HostModelResultReceipt {
  return {
    receiptId: row.receipt_id,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    sourceEventId: row.source_event_id,
    acceptedTaskId: row.accepted_task_id,
    batchOrdinal: row.batch_ordinal,
    batchId: row.batch_id,
    callId: row.call_id,
    toolName: row.tool_name,
    disposition: row.disposition,
    frameDigest: row.frame_digest,
    frameIndex: row.frame_index,
    frameSize: row.frame_size,
    countsRefusal: row.counts_refusal === 1,
    retryMode: row.retry_mode,
    outputBytes: row.output_bytes,
    outputSha256: row.output_sha256,
    recordedAt: row.recorded_at,
    receiptDigest: hostModelResultReceiptDigest(row),
  };
}

export function hostModelResultReceiptRowsForCall(
  db: HarnessDb,
  sessionId: string,
  callId: string,
): HostModelResultReceiptRow[] {
  return db.prepare(`
    SELECT * FROM host_model_result_receipts
     WHERE session_id = ? AND call_id = ?
     ORDER BY source_user_seq, receipt_id
  `).all(sessionId, callId) as HostModelResultReceiptRow[];
}

export function hostModelResultReceiptForAdmissionCall(input: {
  db: HarnessDb;
  sessionId: string;
  sourceUserSeq: number;
  batchOrdinal: number;
  batchId: string;
  callId: string;
}): HostModelResultReceipt | null {
  const rows = input.db.prepare(`
    SELECT * FROM host_model_result_receipts
     WHERE session_id = ? AND source_user_seq = ?
       AND batch_ordinal = ? AND batch_id = ? AND call_id = ?
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    input.batchOrdinal,
    input.batchId,
    input.callId,
  ) as HostModelResultReceiptRow[];
  return rows.length === 1 ? hostModelResultReceiptFromRow(rows[0]!) : null;
}

export function resultItemFromHostModelResultReceipt(
  receipt: HostModelResultReceipt,
): AgentInputItem {
  const item = receipt.disposition === 'user_rejected'
    ? buildUserRejectedHostResult(receipt.callId, receipt.toolName)
    : buildHostToolDispositionResult({
        callId: receipt.callId,
        toolName: receipt.toolName,
        disposition: receipt.disposition,
        frameDigest: receipt.frameDigest ?? '',
        frameIndex: receipt.frameIndex ?? -1,
        frameSize: receipt.frameSize ?? 0,
        countsRefusal: receipt.countsRefusal,
        retired: receipt.retryMode === 'do_not_retry',
      });
  const output = canonicalModelResultOutputBytes(item);
  if (
    Buffer.byteLength(output, 'utf8') !== receipt.outputBytes
    || sha256(output) !== receipt.outputSha256
  ) throw new Error('host model result receipt does not reconstruct its exact output');
  return item;
}

export function hostModelResultReceiptMatchesItem(
  receipt: HostModelResultReceipt,
  item: AgentInputItem,
): boolean {
  const descriptor = describeCanonicalHostModelResult(item);
  return descriptor !== null
    && descriptor.callId === receipt.callId
    && descriptor.toolName === receipt.toolName
    && descriptor.disposition === receipt.disposition
    && descriptor.frameDigest === receipt.frameDigest
    && descriptor.frameIndex === receipt.frameIndex
    && descriptor.frameSize === receipt.frameSize
    && descriptor.countsRefusal === receipt.countsRefusal
    && descriptor.retryMode === receipt.retryMode
    && descriptor.outputBytes === receipt.outputBytes
    && descriptor.outputSha256 === receipt.outputSha256;
}

export function recordHostModelResultReceipts(input: {
  admission: AcceptedModelBatchRef;
  resultItems: readonly AgentInputItem[];
  now?: () => string;
}): HostModelResultReceipt[] {
  const descriptors = input.resultItems.map(describeCanonicalHostModelResult);
  if (descriptors.some((candidate) => candidate === null)) {
    throw new Error('host result receipt writer received a noncanonical or business result');
  }
  if (descriptors.length === 0) return [];
  const exact = descriptors as CanonicalHostResultDescriptor[];
  if (new Set(exact.map((entry) => entry.callId)).size !== exact.length) {
    throw new Error('host result receipt writer received duplicate call ids');
  }
  const db = openEventLog();
  const transact = db.transaction((): HostModelResultReceipt[] => {
    const root = db.prepare(`
      SELECT source_event_id, accepted_task_id, authority_digest, state
        FROM accepted_turn_call_authorities
       WHERE session_id = ? AND source_user_seq = ?
    `).get(input.admission.sessionId, input.admission.sourceUserSeq) as {
      source_event_id: string;
      accepted_task_id: string;
      authority_digest: string;
      state: string;
    } | undefined;
    if (
      !root || root.state !== 'open'
      || root.accepted_task_id !== input.admission.acceptedTaskId
      || root.authority_digest !== input.admission.authorityDigest
    ) throw new Error('host result receipt has no exact open accepted source root');
    const recordedAt = input.now?.() ?? new Date().toISOString();
    const receipts: HostModelResultReceipt[] = [];
    for (const descriptor of exact) {
      const identity = receiptIdentity({
        sessionId: input.admission.sessionId,
        sourceUserSeq: input.admission.sourceUserSeq,
        sourceEventId: root.source_event_id,
        acceptedTaskId: input.admission.acceptedTaskId,
        batchOrdinal: input.admission.batchOrdinal,
        batchId: input.admission.batchId,
        descriptor,
      });
      const receiptId = sha256(canonicalModelResultJson(identity));
      db.prepare(`
        INSERT INTO host_model_result_receipts
          (receipt_id, session_id, source_user_seq, source_event_id,
           accepted_task_id, batch_ordinal, batch_id, call_id, tool_name,
           disposition, frame_digest, frame_index, frame_size, counts_refusal,
           retry_mode, output_bytes, output_sha256, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, source_user_seq, call_id) DO NOTHING
      `).run(
        receiptId,
        input.admission.sessionId,
        input.admission.sourceUserSeq,
        root.source_event_id,
        input.admission.acceptedTaskId,
        input.admission.batchOrdinal,
        input.admission.batchId,
        descriptor.callId,
        descriptor.toolName,
        descriptor.disposition,
        descriptor.frameDigest,
        descriptor.frameIndex,
        descriptor.frameSize,
        descriptor.countsRefusal ? 1 : 0,
        descriptor.retryMode,
        descriptor.outputBytes,
        descriptor.outputSha256,
        recordedAt,
      );
      const row = db.prepare(`
        SELECT * FROM host_model_result_receipts
         WHERE session_id = ? AND source_user_seq = ? AND call_id = ?
      `).get(
        input.admission.sessionId,
        input.admission.sourceUserSeq,
        descriptor.callId,
      ) as HostModelResultReceiptRow | undefined;
      if (!row || row.receipt_id !== receiptId) {
        throw new Error('host result receipt conflicts with an existing call receipt');
      }
      const receipt = hostModelResultReceiptFromRow(row);
      if (!hostModelResultReceiptMatchesItem(receipt, descriptor.item)) {
        throw new Error('host result receipt did not preserve the exact committed result item');
      }
      receipts.push(receipt);
    }
    return receipts;
  });
  return transact.immediate();
}
