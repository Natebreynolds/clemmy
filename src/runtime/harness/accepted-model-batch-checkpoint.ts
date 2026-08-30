import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import { acceptedTurnCallAuthorityFor } from './accepted-turn-call-authority.js';
import {
  conversationProtocolItemBytesSha256,
  inspectConversationProtocol,
  migratePersistedConversationProtocol,
  type ConversationMigration,
  type MigrationEvidence,
} from './conversation-protocol.js';
import { durableConversationProtocolEvidenceForCall } from './conversation-protocol-session.js';
import { openEventLog } from './eventlog.js';
import { proveHostPlannedResolutionCoexistenceInTransaction } from './host-planned-resolution-coexistence.js';
import {
  canonicalHostModelResultClass,
  hostModelResultReceiptForAdmissionCall,
  hostModelResultReceiptMatchesItem,
  resultItemFromHostModelResultReceipt,
  type CanonicalHostModelResultClass,
} from './host-model-result-receipt.js';
import {
  logicalModelResultProjectionReceiptForAdmissionCall,
  logicalModelResultProjectionReceiptMatchesItem,
} from './logical-model-result-projection-receipt.js';

/**
 * Append-only mid-turn durability for one accepted host model/tool batch.
 *
 * This module owns no tool policy and knows no capability names.  Its only
 * inputs are the canonical admitted model frame and the accepted source.  Tool
 * outcomes are reconstructed through the shared conversation protocol from
 * the same logical settlements/result handles used by ordinary restart repair.
 */

const PROTOCOL_VERSION = 1 as const;

type HarnessDb = ReturnType<typeof openEventLog>;
type ItemRecord = Record<string, unknown>;

interface RootRow {
  accepted_task_id: string;
  authority_kind: 'host_v1' | 'host_v1_read_only' | string;
  authority_digest: string;
  source_event_digest: string;
  source_turn: number;
  engine_version: string;
  state: 'open' | 'closed' | 'conflict';
}

interface ExecutionBinding {
  graphEventId: string;
  graphHash: string;
  workContractId: string;
}

interface AdmissionRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  batch_ordinal: number;
  batch_id: string;
  protocol_version: number;
  authority_digest: string;
  source_event_digest: string;
  source_turn: number;
  engine_version: string;
  graph_event_id: string | null;
  graph_hash: string | null;
  work_contract_id: string | null;
  previous_response_id: string | null;
  provider_response_id: string | null;
  accepted_response_digest: string;
  pre_history_json: string;
  pre_history_digest: string;
  pre_history_item_count: number;
  frame_history_json: string;
  frame_history_digest: string;
  frame_history_item_count: number;
  call_ids_json: string;
  call_count: number;
  admitted_at: string;
}

interface CheckpointRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  batch_ordinal: number;
  batch_id: string;
  protocol_version: number;
  authority_digest: string;
  graph_event_id: string | null;
  graph_hash: string | null;
  work_contract_id: string | null;
  disposition: 'ready' | 'reconciliation_required';
  history_json: string;
  history_digest: string;
  history_item_count: number;
  last_response_id: string | null;
  committed_at: string;
}

export interface AcceptedModelBatchRef {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  batchOrdinal: number;
  batchId: string;
  authorityDigest: string;
}

export interface AcceptedModelBatchAdmission extends AcceptedModelBatchRef {
  protocolVersion: typeof PROTOCOL_VERSION;
  sourceEventDigest: string;
  sourceTurn: number;
  engineVersion: string;
  executionBinding: ExecutionBinding | null;
  previousResponseId?: string;
  providerResponseId?: string;
  acceptedResponseDigest: string;
  preHistoryDigest: string;
  frameHistoryDigest: string;
  callIds: string[];
  admittedAt: string;
}

export interface AcceptedModelBatchCheckpoint extends AcceptedModelBatchRef {
  protocolVersion: typeof PROTOCOL_VERSION;
  executionBinding: ExecutionBinding | null;
  disposition: 'ready' | 'reconciliation_required';
  history: AgentInputItem[];
  historyDigest: string;
  lastResponseId?: string;
  committedAt: string;
}

/**
 * Private, process-to-process capability for resuming one already-accepted
 * host source.  These bytes are control-plane data only: callers must thread
 * them out-of-band and must never append them to conversation history, model
 * input, provider requests, or public events.
 *
 * The checkpoint identity is a lower bound rather than a forever-current
 * cursor.  A same-source provider fallover may durably finish a later batch
 * before re-entering the host; reopening that later append-only descendant is
 * valid, while a different root or a rewritten same ordinal is not.
 */
export interface AcceptedModelBatchRestartToken {
  protocol: 'clementine.accepted_model_batch_restart.v1';
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  authorityDigest: string;
  resumeFromBatchOrdinal: number;
  resumeFromBatchId: string;
  resumeFromHistoryDigest: string;
}

export type AdmitAcceptedModelBatchResult =
  | { status: 'admitted' | 'existing'; admission: AcceptedModelBatchAdmission }
  | { status: 'invalid' | 'conflict' | 'unavailable'; reason: string };

export type FinalizeAcceptedModelBatchResult =
  | { status: 'committed' | 'existing'; checkpoint: AcceptedModelBatchCheckpoint }
  | { status: 'evidence_unavailable' | 'conflict' | 'unavailable'; reason: string };

export type ReopenAcceptedModelBatchResult =
  | { status: 'open'; admission: AcceptedModelBatchAdmission }
  | { status: 'checkpointed'; checkpoint: AcceptedModelBatchCheckpoint }
  | { status: 'conflict' | 'unavailable'; reason: string };

export type RecoverAcceptedModelBatchResult =
  | { status: 'ready'; checkpoint: AcceptedModelBatchCheckpoint }
  | { status: 'reconciliation_required'; checkpoint: AcceptedModelBatchCheckpoint; reason: string }
  | { status: 'missing' | 'evidence_unavailable' | 'conflict' | 'unavailable'; reason: string };

export type PrepareAcceptedModelBatchRestartResult =
  | {
      status: 'ready' | 'reconciliation_required';
      checkpoint: AcceptedModelBatchCheckpoint;
      token: AcceptedModelBatchRestartToken;
      reason?: string;
    }
  | { status: 'missing' | 'evidence_unavailable' | 'conflict' | 'unavailable'; reason: string };

function exactJson(value: unknown): string {
  const bytes = JSON.stringify(value);
  if (typeof bytes !== 'string') throw new Error('value has no exact JSON byte representation');
  return bytes;
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function acceptedModelBatchHistoryDigest(history: readonly AgentInputItem[]): string {
  return sha256(exactJson(history));
}

function itemRecord(item: AgentInputItem): ItemRecord {
  return item as unknown as ItemRecord;
}

function functionCalls(history: readonly AgentInputItem[]): Array<{
  callId: string;
  name: string;
}> {
  const calls: Array<{ callId: string; name: string }> = [];
  for (const item of history) {
    const record = itemRecord(item);
    if (record.type !== 'function_call') continue;
    if (typeof record.callId !== 'string' || !record.callId) {
      throw new Error('admitted model frame has a function call without an exact call id');
    }
    if (typeof record.name !== 'string' || !record.name) {
      throw new Error(`admitted function call ${record.callId} has no exact name`);
    }
    calls.push({ callId: record.callId, name: record.name });
  }
  return calls;
}

function parseHistory(raw: string): AgentInputItem[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('persisted model-batch history is not an array');
  return parsed as AgentInputItem[];
}

function parseCallIds(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('persisted model-batch call ids are invalid');
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new Error('persisted model-batch call ids are not unique');
  }
  return parsed;
}

function executionBindingFromRow(row: {
  graph_event_id: string | null;
  graph_hash: string | null;
  work_contract_id: string | null;
}): ExecutionBinding | null {
  if (row.graph_event_id === null && row.graph_hash === null && row.work_contract_id === null) {
    return null;
  }
  if (!row.graph_event_id || !row.graph_hash || !row.work_contract_id) {
    throw new Error('persisted model-batch execution binding is incomplete');
  }
  return {
    graphEventId: row.graph_event_id,
    graphHash: row.graph_hash,
    workContractId: row.work_contract_id,
  };
}

function sameExecutionBinding(
  left: ExecutionBinding | null,
  right: ExecutionBinding | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.graphEventId === right.graphEventId
      && left.graphHash === right.graphHash
      && left.workContractId === right.workContractId;
}

/**
 * An accepted frame is admitted before classification, preparation, consent,
 * or body execution.  A frame immediately following `plan_task` can therefore
 * be admitted while the accepted source is still graph-neutral, then observe
 * the exact immutable plan binding once the already-settled plan activation is
 * published.  Finalization has always admitted that one monotonic transition;
 * recovery/reopen must apply the identical relational proof or it can strand
 * an otherwise durable result after the body has returned.
 *
 * No other drift is accepted: a non-null binding must remain byte-for-byte
 * identical, and null -> bound requires the complete same-source settled-plan
 * coexistence proof (including its contract, activation receipt, delivery,
 * result handle, and crossing evidence).
 */
function sameExecutionBindingOrProvenPlanActivation(input: {
  db: HarnessDb;
  row: {
    session_id: string;
    source_user_seq: number;
    graph_event_id: string | null;
    graph_hash: string | null;
    work_contract_id: string | null;
  };
  current: ExecutionBinding | null;
}): boolean {
  const persisted = executionBindingFromRow(input.row);
  if (sameExecutionBinding(persisted, input.current)) return true;
  return persisted === null
    && input.current !== null
    && proveHostPlannedResolutionCoexistenceInTransaction({
      db: input.db,
      sessionId: input.row.session_id,
      sourceUserSeq: input.row.source_user_seq,
      phase: 'existing',
    });
}

function currentExecutionBinding(
  db: HarnessDb,
  sessionId: string,
  sourceUserSeq: number,
  acceptedTaskId: string,
): ExecutionBinding | null {
  const resolution = db.prepare(`
    SELECT accepted_task_id, graph_event_id, graph_hash, state
      FROM accepted_task_resolutions
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as {
    accepted_task_id: string;
    graph_event_id: string;
    graph_hash: string;
    state: 'open' | 'finalized' | 'legacy_ambiguous';
  } | undefined;
  const contract = db.prepare(`
    SELECT accepted_task_id, graph_event_id, graph_hash, contract_id
      FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as {
    accepted_task_id: string;
    graph_event_id: string;
    graph_hash: string;
    contract_id: string;
  } | undefined;

  // A plan control can durably write its immutable work contract before the
  // post-settlement activation publishes the accepted_task_resolution. That
  // intermediate state is still graph-neutral: the contract alone grants no
  // execution authority and must not prevent the plan batch from checkpointing.
  if (!resolution) return null;
  if (
    !contract
    || resolution.state === 'legacy_ambiguous'
    || resolution.accepted_task_id !== acceptedTaskId
    || contract.accepted_task_id !== acceptedTaskId
    || resolution.graph_event_id !== contract.graph_event_id
    || resolution.graph_hash !== contract.graph_hash
  ) {
    throw new Error('accepted source has an incomplete or conflicting graph/work-contract binding');
  }
  return {
    graphEventId: resolution.graph_event_id,
    graphHash: resolution.graph_hash,
    workContractId: contract.contract_id,
  };
}

function exactOpenHostRoot(input: {
  sessionId: string;
  sourceUserSeq: number;
}): RootRow | null {
  const verified = acceptedTurnCallAuthorityFor(input.sessionId, input.sourceUserSeq);
  if (
    verified.status !== 'ok'
    || (verified.authority.authorityKind !== 'host_v1'
      && verified.authority.authorityKind !== 'host_v1_read_only')
    || verified.authority.state !== 'open'
  ) return null;
  return {
    accepted_task_id: verified.authority.identity.acceptedTaskId,
    authority_kind: verified.authority.authorityKind,
    authority_digest: verified.authority.authorityDigest,
    source_event_digest: verified.authority.sourceEventDigest,
    source_turn: verified.authority.identity.sourceTurn,
    engine_version: verified.authority.engineVersion,
    state: verified.authority.state,
  };
}

function admissionFromRow(row: AdmissionRow): AcceptedModelBatchAdmission {
  const callIds = parseCallIds(row.call_ids_json);
  if (row.protocol_version !== PROTOCOL_VERSION || row.call_count !== callIds.length) {
    throw new Error('persisted model-batch admission shape is inconsistent');
  }
  return {
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    batchOrdinal: row.batch_ordinal,
    batchId: row.batch_id,
    authorityDigest: row.authority_digest,
    protocolVersion: PROTOCOL_VERSION,
    sourceEventDigest: row.source_event_digest,
    sourceTurn: row.source_turn,
    engineVersion: row.engine_version,
    executionBinding: executionBindingFromRow(row),
    ...(row.previous_response_id ? { previousResponseId: row.previous_response_id } : {}),
    ...(row.provider_response_id ? { providerResponseId: row.provider_response_id } : {}),
    acceptedResponseDigest: row.accepted_response_digest,
    preHistoryDigest: row.pre_history_digest,
    frameHistoryDigest: row.frame_history_digest,
    callIds,
    admittedAt: row.admitted_at,
  };
}

function checkpointFromRow(row: CheckpointRow): AcceptedModelBatchCheckpoint {
  const history = parseHistory(row.history_json);
  if (
    row.protocol_version !== PROTOCOL_VERSION
    || row.history_item_count !== history.length
    || acceptedModelBatchHistoryDigest(history) !== row.history_digest
  ) throw new Error('persisted model-batch checkpoint bytes are inconsistent');
  return {
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    batchOrdinal: row.batch_ordinal,
    batchId: row.batch_id,
    authorityDigest: row.authority_digest,
    protocolVersion: PROTOCOL_VERSION,
    executionBinding: executionBindingFromRow(row),
    disposition: row.disposition,
    history,
    historyDigest: row.history_digest,
    ...(row.last_response_id ? { lastResponseId: row.last_response_id } : {}),
    committedAt: row.committed_at,
  };
}

function validateAdmissionHistory(input: {
  preHistory: readonly AgentInputItem[];
  frameHistory: readonly AgentInputItem[];
}): { callIds: string[]; preHistoryJson: string; frameHistoryJson: string } {
  if (inspectConversationProtocol(input.preHistory).status !== 'valid') {
    throw new Error('model-batch admission requires balanced pre-history');
  }
  const calls = functionCalls(input.frameHistory);
  const callIds = calls.map((call) => call.callId);
  if (callIds.length === 0 || new Set(callIds).size !== callIds.length) {
    throw new Error('model-batch admission requires one or more unique function calls');
  }
  if (input.frameHistory.some((item) => itemRecord(item).type === 'function_call_result')) {
    throw new Error('model-batch admission frame cannot already contain tool results');
  }
  const combinedInspection = inspectConversationProtocol([
    ...input.preHistory,
    ...input.frameHistory,
  ]);
  const unmatched = combinedInspection.issues.filter((issue) => issue.code === 'unmatched_function_call');
  if (
    combinedInspection.issues.length !== callIds.length
    || unmatched.length !== callIds.length
    || new Set(unmatched.map((issue) => issue.callId)).size !== callIds.length
    || callIds.some((callId) => !unmatched.some((issue) => issue.callId === callId))
  ) {
    throw new Error('model-batch frame is not one exact open function-call frame');
  }
  return {
    callIds,
    preHistoryJson: exactJson(input.preHistory),
    frameHistoryJson: exactJson(input.frameHistory),
  };
}

function responseDigest(input: {
  providerResponseId?: string;
  frameHistory: readonly AgentInputItem[];
}): string {
  return sha256(exactJson({
    protocolVersion: PROTOCOL_VERSION,
    providerResponseId: input.providerResponseId ?? null,
    frameHistory: input.frameHistory,
  }));
}

function deterministicBatchId(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  batchOrdinal: number;
  authorityDigest: string;
  executionBinding: ExecutionBinding | null;
  acceptedResponseDigest: string;
  preHistoryDigest: string;
  frameHistoryDigest: string;
  callIds: readonly string[];
}): string {
  return sha256(exactJson({ protocolVersion: PROTOCOL_VERSION, ...input }));
}

function latestAdmissionRow(
  db: HarnessDb,
  sessionId: string,
  sourceUserSeq: number,
): AdmissionRow | undefined {
  return db.prepare(`
    SELECT * FROM accepted_model_batch_admissions
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY batch_ordinal DESC
     LIMIT 1
  `).get(sessionId, sourceUserSeq) as AdmissionRow | undefined;
}

function checkpointRowFor(
  db: HarnessDb,
  ref: Pick<AcceptedModelBatchRef, 'sessionId' | 'sourceUserSeq' | 'batchOrdinal'>,
): CheckpointRow | undefined {
  return db.prepare(`
    SELECT * FROM accepted_model_batch_checkpoints
     WHERE session_id = ? AND source_user_seq = ? AND batch_ordinal = ?
  `).get(ref.sessionId, ref.sourceUserSeq, ref.batchOrdinal) as CheckpointRow | undefined;
}

function exactAdmissionMatches(input: {
  row: AdmissionRow;
  root: RootRow;
  executionBinding: ExecutionBinding | null;
  previousResponseId?: string;
  providerResponseId?: string;
  acceptedResponseDigest: string;
  preHistoryDigest: string;
  frameHistoryDigest: string;
  callIds: readonly string[];
}): boolean {
  const rowBinding = executionBindingFromRow(input.row);
  return input.row.authority_digest === input.root.authority_digest
    && input.row.source_event_digest === input.root.source_event_digest
    && input.row.source_turn === input.root.source_turn
    && input.row.engine_version === input.root.engine_version
    && sameExecutionBinding(rowBinding, input.executionBinding)
    && input.row.previous_response_id === (input.previousResponseId ?? null)
    && input.row.provider_response_id === (input.providerResponseId ?? null)
    && input.row.accepted_response_digest === input.acceptedResponseDigest
    && input.row.pre_history_digest === input.preHistoryDigest
    && input.row.frame_history_digest === input.frameHistoryDigest
    && exactJson(parseCallIds(input.row.call_ids_json)) === exactJson(input.callIds);
}

export function admitAcceptedModelBatch(input: {
  sessionId: string;
  sourceUserSeq: number;
  preHistory: readonly AgentInputItem[];
  frameHistory: readonly AgentInputItem[];
  previousResponseId?: string;
  providerResponseId?: string;
  now?: () => string;
}): AdmitAcceptedModelBatchResult {
  let validated: ReturnType<typeof validateAdmissionHistory>;
  try {
    validated = validateAdmissionHistory(input);
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
  const root = exactOpenHostRoot(input);
  if (!root) return { status: 'conflict', reason: 'exact open host call root is unavailable' };

  const preHistoryDigest = sha256(validated.preHistoryJson);
  const frameHistoryDigest = sha256(validated.frameHistoryJson);
  const acceptedResponseDigest = responseDigest(input);
  const db = openEventLog();
  const transact = db.transaction((): AdmitAcceptedModelBatchResult => {
    const executionBinding = currentExecutionBinding(
      db,
      input.sessionId,
      input.sourceUserSeq,
      root.accepted_task_id,
    );
    const latest = latestAdmissionRow(db, input.sessionId, input.sourceUserSeq);
    const latestCheckpoint = latest
      ? checkpointRowFor(db, {
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          batchOrdinal: latest.batch_ordinal,
        })
      : undefined;
    if (latest && !latestCheckpoint) {
      if (exactAdmissionMatches({
        row: latest,
        root,
        executionBinding,
        previousResponseId: input.previousResponseId,
        providerResponseId: input.providerResponseId,
        acceptedResponseDigest,
        preHistoryDigest,
        frameHistoryDigest,
        callIds: validated.callIds,
      })) {
        return { status: 'existing', admission: admissionFromRow(latest) };
      }
      return {
        status: 'conflict',
        reason: 'a different admitted model batch remains uncheckpointed for this accepted source',
      };
    }

    const batchOrdinal = (latest?.batch_ordinal ?? 0) + 1;
    const batchId = deterministicBatchId({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: root.accepted_task_id,
      batchOrdinal,
      authorityDigest: root.authority_digest,
      executionBinding,
      acceptedResponseDigest,
      preHistoryDigest,
      frameHistoryDigest,
      callIds: validated.callIds,
    });
    const admittedAt = input.now?.() ?? new Date().toISOString();
    db.prepare(`
      INSERT INTO accepted_model_batch_admissions
        (session_id, source_user_seq, accepted_task_id, batch_ordinal,
         batch_id, protocol_version, authority_digest, source_event_digest,
         source_turn, engine_version, graph_event_id, graph_hash,
         work_contract_id, previous_response_id, provider_response_id,
         accepted_response_digest, pre_history_json, pre_history_digest,
         pre_history_item_count, frame_history_json, frame_history_digest,
         frame_history_item_count, call_ids_json, call_count, admitted_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.sourceUserSeq,
      root.accepted_task_id,
      batchOrdinal,
      batchId,
      root.authority_digest,
      root.source_event_digest,
      root.source_turn,
      root.engine_version,
      executionBinding?.graphEventId ?? null,
      executionBinding?.graphHash ?? null,
      executionBinding?.workContractId ?? null,
      input.previousResponseId ?? null,
      input.providerResponseId ?? null,
      acceptedResponseDigest,
      validated.preHistoryJson,
      preHistoryDigest,
      input.preHistory.length,
      validated.frameHistoryJson,
      frameHistoryDigest,
      input.frameHistory.length,
      exactJson(validated.callIds),
      validated.callIds.length,
      admittedAt,
    );
    const inserted = latestAdmissionRow(db, input.sessionId, input.sourceUserSeq);
    if (!inserted || inserted.batch_id !== batchId) {
      throw new Error('model-batch admission insert did not read back exactly');
    }
    return { status: 'admitted', admission: admissionFromRow(inserted) };
  });

  try {
    return transact.immediate();
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Re-open one exact accepted frame without minting a replacement identity.
 * Approval resume uses this before any preparation or body edge.  The optional
 * history is the paused call-bearing prefix; matching it here prevents a
 * forged or stale state blob from borrowing a live admission reference.
 */
export function reopenAcceptedModelBatch(
  ref: AcceptedModelBatchRef,
  options: { openHistory?: readonly AgentInputItem[] } = {},
): ReopenAcceptedModelBatchResult {
  const root = exactOpenHostRoot(ref);
  if (
    !root
    || root.accepted_task_id !== ref.acceptedTaskId
    || root.authority_digest !== ref.authorityDigest
  ) {
    return { status: 'conflict', reason: 'accepted model batch no longer has its exact open host root' };
  }
  try {
    const db = openEventLog();
    const row = db.prepare(`
      SELECT * FROM accepted_model_batch_admissions
       WHERE session_id = ? AND source_user_seq = ? AND batch_ordinal = ?
    `).get(ref.sessionId, ref.sourceUserSeq, ref.batchOrdinal) as AdmissionRow | undefined;
    if (
      !row
      || row.batch_id !== ref.batchId
      || row.accepted_task_id !== ref.acceptedTaskId
      || row.authority_digest !== ref.authorityDigest
    ) {
      return { status: 'conflict', reason: 'accepted model batch admission does not match its exact reference' };
    }
    const currentBinding = currentExecutionBinding(
      db,
      ref.sessionId,
      ref.sourceUserSeq,
      ref.acceptedTaskId,
    );
    const checkpoint = checkpointRowFor(db, ref);
    // A committed checkpoint seals the post-frame binding.  An open admission
    // instead retains its pre-frame binding and may advance only through the
    // exact settled-plan transition proven above.
    if (!sameExecutionBindingOrProvenPlanActivation({
      db,
      row: checkpoint ?? row,
      current: currentBinding,
    })) {
      return { status: 'conflict', reason: 'accepted model batch execution binding changed while paused' };
    }
    if (options.openHistory) {
      const admittedOpenHistory = [
        ...parseHistory(row.pre_history_json),
        ...parseHistory(row.frame_history_json),
      ];
      if (
        acceptedModelBatchHistoryDigest(admittedOpenHistory)
        !== acceptedModelBatchHistoryDigest(options.openHistory)
      ) {
        return { status: 'conflict', reason: 'paused history does not match the exact admitted model batch' };
      }
    }
    return checkpoint
      ? { status: 'checkpointed', checkpoint: checkpointFromRow(checkpoint) }
      : { status: 'open', admission: admissionFromRow(row) };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function durableEvidenceForAdmission(input: {
  db: HarnessDb;
  row: AdmissionRow;
  openHistory: readonly AgentInputItem[];
  callIds: readonly string[];
}): Record<string, MigrationEvidence> | null {
  const evidence: Record<string, MigrationEvidence> = {};
  for (const callId of input.callIds) {
    const identities = input.db.prepare(`
      SELECT DISTINCT logical.source_user_seq, logical.accepted_task_id,
             logical.logical_tool_call_id
        FROM logical_tool_calls logical
        LEFT JOIN logical_call_settlements settlement
          ON settlement.session_id = logical.session_id
         AND settlement.source_user_seq = logical.source_user_seq
         AND settlement.logical_tool_call_id = logical.logical_tool_call_id
       WHERE logical.session_id = ?
         AND (logical.logical_tool_call_id = ? OR settlement.observer_call_id = ?)
       ORDER BY logical.source_user_seq, logical.logical_tool_call_id
    `).all(input.row.session_id, callId, callId) as Array<{
      source_user_seq: number;
      accepted_task_id: string;
      logical_tool_call_id: string;
    }>;
    // Visible call ids are not globally unique across accepted sources.  The
    // settlement projector is session-scoped for legacy repair, so bind its
    // answer back to this exact admission before it can prove anything here.
    const exactIdentity = identities.length === 1
      && identities[0]!.source_user_seq === input.row.source_user_seq
      && identities[0]!.accepted_task_id === input.row.accepted_task_id
      ? identities[0]!
      : null;
    const exact = exactIdentity
      ? durableConversationProtocolEvidenceForCall({
          db: input.db,
          sessionId: input.row.session_id,
          history: input.openHistory,
          callId,
        })
      : undefined;
    if (exact) {
      // An outcome settlement proves what happened, not the exact transformed
      // bytes that were handed to the model.  Open-admission recovery may
      // reconstruct only the settlement projector's own result when an
      // append-only projection receipt proves those were the bytes originally
      // built.  A guardrail/media/structured projection whose bytes live only
      // in private HostRecoveryState must stay held until that state supplies
      // them; metadata alone is deliberately not a payload store.
      const receipt = logicalModelResultProjectionReceiptForAdmissionCall({
        db: input.db,
        sessionId: input.row.session_id,
        sourceUserSeq: input.row.source_user_seq,
        batchOrdinal: input.row.batch_ordinal,
        batchId: input.row.batch_id,
        callId,
      });
      if (
        exact.kind !== 'settled_result'
        || !receipt
        || receipt.settlementLogicalToolCallId !== exactIdentity!.logical_tool_call_id
        || !logicalModelResultProjectionReceiptMatchesItem(receipt, exact.result)
      ) return null;
      evidence[callId] = exact;
      continue;
    }
    const hostReceipt = hostModelResultReceiptForAdmissionCall({
      db: input.db,
      sessionId: input.row.session_id,
      sourceUserSeq: input.row.source_user_seq,
      batchOrdinal: input.row.batch_ordinal,
      batchId: input.row.batch_id,
      callId,
    });
    if (hostReceipt) {
      const committed = input.openHistory.find((item) => {
        const record = itemRecord(item);
        return record.type === 'function_call_result' && record.callId === callId;
      });
      let result: AgentInputItem;
      if (committed && hostModelResultReceiptMatchesItem(hostReceipt, committed)) {
        result = committed;
      } else {
        try {
          result = resultItemFromHostModelResultReceipt(hostReceipt);
        } catch {
          return null;
        }
      }
      evidence[callId] = {
        kind: 'settled_result',
        result,
        resultBytesSha256: conversationProtocolItemBytesSha256(result),
      };
      continue;
    }
    // Admission alone proves only that the model frame was accepted.  It does
    // not prove whether classification, approval, preparation or a body edge
    // happened before a crash.  Without an exact logical outcome or immutable
    // host-result receipt, recovery must hold rather than mint different
    // result bytes into the append-only checkpoint.
    return null;
  }
  return evidence;
}

function resultForCall(
  history: readonly AgentInputItem[],
  callId: string,
): AgentInputItem | undefined {
  return history.find((item) => {
    const row = itemRecord(item);
    return row.type === 'function_call_result' && row.callId === callId;
  });
}

function callForId(
  history: readonly AgentInputItem[],
  callId: string,
): AgentInputItem | undefined {
  return history.find((item) => {
    const row = itemRecord(item);
    return row.type === 'function_call' && row.callId === callId;
  });
}

function exactProjectionIdentity(
  call: AgentInputItem,
  result: AgentInputItem,
): boolean {
  const callRow = itemRecord(call);
  const resultRow = itemRecord(result);
  return resultRow.type === 'function_call_result'
    && resultRow.status === 'completed'
    && resultRow.callId === callRow.callId
    && resultRow.name === callRow.name
    && (resultRow.namespace ?? null) === (callRow.namespace ?? null);
}

/**
 * A successful result is reopened only through the authoritative result-handle
 * projector above.  A failed/non-success result has no successful payload
 * handle by design, but the live checkpoint owner still holds its exact
 * model-visible bytes and seals them with a projection receipt.  Admit that
 * projection only when the immutable settlement proves it is ordinary model
 * data rather than an unresolved mutation.
 *
 * This is deliberately effect- and provider-neutral.  A local plan refusal, a
 * connected read error, and a native carrier corrective all use the same
 * closed settlement fields.  Mutating unknown/ignored outcomes remain outside
 * this lane and therefore cannot advance past reconciliation.
 */
function settledNonSuccessProjectionDisposition(input: {
  db: HarnessDb;
  row: AdmissionRow;
  logicalToolCallId: string;
  hostClass: CanonicalHostModelResultClass | null;
}): 'ready' | 'reconciliation_required' | null {
  const rows = input.db.prepare(`
    SELECT logical.state, settlement.execution_kind, settlement.outcome_kind,
           settlement.business_call, settlement.mutating,
           settlement.physical_crossing_count, settlement.host_crossing_count,
           settlement.result_handle_id, settlement.recovery_action,
           settlement.requires_reconciliation,
           (SELECT COUNT(*) FROM physical_dispatches crossing
             WHERE crossing.session_id = settlement.session_id
               AND crossing.source_user_seq = settlement.source_user_seq
               AND crossing.logical_tool_call_id = settlement.logical_tool_call_id
               AND crossing.state <> 'returned') AS nonreturned_crossing_count
      FROM logical_tool_calls logical
      JOIN logical_call_settlements settlement
        ON settlement.session_id = logical.session_id
       AND settlement.source_user_seq = logical.source_user_seq
       AND settlement.logical_tool_call_id = logical.logical_tool_call_id
     WHERE logical.session_id = ? AND logical.source_user_seq = ?
       AND logical.accepted_task_id = ?
       AND logical.logical_tool_call_id = ?
  `).all(
    input.row.session_id,
    input.row.source_user_seq,
    input.row.accepted_task_id,
    input.logicalToolCallId,
  ) as Array<{
    state: string;
    execution_kind: string;
    outcome_kind: string;
    business_call: number;
    mutating: number;
    physical_crossing_count: number;
    host_crossing_count: number;
    result_handle_id: string | null;
    recovery_action: string;
    requires_reconciliation: number;
    nonreturned_crossing_count: number;
  }>;
  const settlement = rows.length === 1 ? rows[0]! : null;
  if (
    !settlement
    || settlement.state !== 'settled'
    // Successful bytes retain the stronger result-handle/redemption bar.
    || settlement.outcome_kind === 'succeeded'
    || settlement.outcome_kind === 'empty_result'
    || settlement.result_handle_id !== null
  ) return null;

  const mutatingSafeFailure = new Set([
    'invalid_arguments',
    'transient',
    'unsupported_capability',
    'input_required',
    'auth_failure',
    'policy_denial',
  ]).has(settlement.outcome_kind);
  const reconciliationRequired = settlement.requires_reconciliation === 1
    || settlement.outcome_kind === 'uncertain_write'
    || (
      settlement.mutating === 1
      && (
        settlement.nonreturned_crossing_count > 0
        || !mutatingSafeFailure
      )
    );
  if (reconciliationRequired) {
    return input.hostClass === 'effect_unknown'
      ? 'reconciliation_required'
      : null;
  }
  if (input.hostClass === 'effect_unknown') return null;

  if (
    input.hostClass === 'refused_pre_dispatch'
    || input.hostClass === 'not_started'
    || input.hostClass === 'user_rejected'
  ) {
    const exactPreDispatchClosure = settlement.execution_kind === 'refused_pre_dispatch'
      && settlement.physical_crossing_count === 0
      && settlement.host_crossing_count === 0;
    if (exactPreDispatchClosure) return 'ready';
    // The host's replan marker also closes one narrow post-entry failure:
    // a declared non-business read/compute whose immutable settlement says
    // no provider bytes crossed, no mutation is possible, and the recovery
    // directive is transient retry.  This is safe model feedback even though
    // the local body entered.  `not_started` and `user_rejected` retain their
    // literal zero-crossing meaning, and every mutating/uncertain timeout stays
    // outside this lane.
    return input.hostClass === 'refused_pre_dispatch'
      && settlement.mutating === 0
      && settlement.business_call === 0
      && settlement.physical_crossing_count === 0
      && settlement.requires_reconciliation === 0
      && settlement.recovery_action === 'retry_with_backoff'
      ? 'ready'
      : null;
  }
  return 'ready';
}

/** Validate exact model-visible result bytes against the durable outcome
 * owner without requiring the settlement projector to synthesize the same
 * display representation.  This is what permits structured/file/image and
 * output-guardrail projections while keeping effect provenance closed. */
function validateCommittedProjection(input: {
  db: HarnessDb;
  row: AdmissionRow;
  history: readonly AgentInputItem[];
  callIds: readonly string[];
}): ConversationMigration | null {
  if (inspectConversationProtocol(input.history).status !== 'valid') return null;
  let reconciliationRequired = false;
  let markerFrameDigest: string | null = null;
  let markerCount = 0;
  let countingRefusals = 0;

  for (let index = 0; index < input.callIds.length; index += 1) {
    const callId = input.callIds[index]!;
    const call = callForId(input.history, callId);
    const result = resultForCall(input.history, callId);
    if (!call || !result || !exactProjectionIdentity(call, result)) return null;

    const identities = input.db.prepare(`
      SELECT DISTINCT logical.source_user_seq, logical.accepted_task_id,
             logical.logical_tool_call_id
        FROM logical_tool_calls logical
        LEFT JOIN logical_call_settlements settlement
          ON settlement.session_id = logical.session_id
         AND settlement.source_user_seq = logical.source_user_seq
         AND settlement.logical_tool_call_id = logical.logical_tool_call_id
       WHERE logical.session_id = ?
         AND (logical.logical_tool_call_id = ? OR settlement.observer_call_id = ?)
       ORDER BY logical.source_user_seq, logical.logical_tool_call_id
    `).all(input.row.session_id, callId, callId) as Array<{
      source_user_seq: number;
      accepted_task_id: string;
      logical_tool_call_id: string;
    }>;
    const exactIdentity = identities.length === 1
      && identities[0]!.source_user_seq === input.row.source_user_seq
      && identities[0]!.accepted_task_id === input.row.accepted_task_id
      ? identities[0]!
      : null;
    const exact = exactIdentity
      ? durableConversationProtocolEvidenceForCall({
          db: input.db,
          sessionId: input.row.session_id,
          history: input.history,
          callId,
        })
      : undefined;
    const hostClass = canonicalHostModelResultClass(result);

    const projectionReceipt = exactIdentity
      ? logicalModelResultProjectionReceiptForAdmissionCall({
          db: input.db,
          sessionId: input.row.session_id,
          sourceUserSeq: input.row.source_user_seq,
          batchOrdinal: input.row.batch_ordinal,
          batchId: input.row.batch_id,
          callId,
      })
      : null;
    const exactProjectionReceipt = Boolean(
      projectionReceipt
      && projectionReceipt.settlementLogicalToolCallId
        === exactIdentity?.logical_tool_call_id
      && logicalModelResultProjectionReceiptMatchesItem(projectionReceipt, result)
    );
    if (
      exact
      && !exactProjectionReceipt
    ) return null;

    if (hostClass && hostClass !== 'user_rejected') {
      const output = itemRecord(result).output as ItemRecord;
      const marker = JSON.parse(String(output.text)) as {
        frameDigest: string;
        frameIndex: number;
        frameSize: number;
        countsRefusal?: true;
      };
      if (
        marker.frameIndex !== index
        || marker.frameSize !== input.callIds.length
        || (markerFrameDigest !== null && marker.frameDigest !== markerFrameDigest)
      ) return null;
      markerFrameDigest = marker.frameDigest;
      markerCount += 1;
      if (marker.countsRefusal === true) countingRefusals += 1;
    }

    if (exact) {
      if (exact.kind === 'settled_result') {
        if (hostClass === 'effect_unknown') {
          reconciliationRequired = true;
          continue;
        }
        // A successful settlement may carry any exact structured projection,
        // but never a reserved host refusal/rejection marker.
        if (hostClass !== null) return null;
        continue;
      }
      if (exact.kind === 'proven_no_crossing') {
        if (
          hostClass === 'refused_pre_dispatch'
          || hostClass === 'not_started'
          || hostClass === 'user_rejected'
        ) continue;
        // A typed pre-dispatch corrective is ordinary model data, not a
        // synthetic refusal marker.  The same exact projection receipt and
        // closed settlement class used below must prove those bytes before
        // they can advance the provider transcript.
        if (exactIdentity && exactProjectionReceipt) {
          const settledProjection = settledNonSuccessProjectionDisposition({
            db: input.db,
            row: input.row,
            logicalToolCallId: exactIdentity.logical_tool_call_id,
            hostClass,
          });
          if (settledProjection === 'ready') continue;
          if (settledProjection === 'reconciliation_required') {
            // Zero provider crossings do not prove zero effect for a host-owned
            // mutating carrier. The immutable settlement remains the stronger
            // effect authority and the exact effect_unknown projection must be
            // checkpointed into reconciliation, never left as a retryable hold.
            reconciliationRequired = true;
            continue;
          }
        }
        return null;
      }
      if (exact.kind === 'physical_crossing_unreadable') {
        if (exactIdentity && exactProjectionReceipt) {
          const settledProjection = settledNonSuccessProjectionDisposition({
            db: input.db,
            row: input.row,
            logicalToolCallId: exactIdentity.logical_tool_call_id,
            hostClass,
          });
          if (settledProjection === 'ready') continue;
          if (settledProjection === 'reconciliation_required') {
            reconciliationRequired = true;
            continue;
          }
        }
        if (hostClass !== 'effect_unknown') return null;
        reconciliationRequired = true;
        continue;
      }
      return null;
    }

    // Failed/non-success settlements intentionally have no successful result
    // handle, so the generic conversation projector cannot reconstruct their
    // payload.  During the live commit, however, the checkpoint owner holds
    // the exact bytes and the append-only projection receipt binds those bytes
    // to this exact same-source settlement.  Preserve that ordinary repair
    // result without manufacturing payload bytes during restart.
    if (exactIdentity && exactProjectionReceipt) {
      const settledProjection = settledNonSuccessProjectionDisposition({
        db: input.db,
        row: input.row,
        logicalToolCallId: exactIdentity.logical_tool_call_id,
        hostClass,
      });
      if (settledProjection === 'ready') continue;
      if (settledProjection === 'reconciliation_required') {
        reconciliationRequired = true;
        continue;
      }
    }

    // A host receipt is valid only for a call with no logical identity at all;
    // an ambiguous/cross-source identity cannot fall through into this lane.
    if (identities.length !== 0) return null;
    const receipt = hostModelResultReceiptForAdmissionCall({
      db: input.db,
      sessionId: input.row.session_id,
      sourceUserSeq: input.row.source_user_seq,
      batchOrdinal: input.row.batch_ordinal,
      batchId: input.row.batch_id,
      callId,
    });
    if (!receipt || !hostModelResultReceiptMatchesItem(receipt, result)) return null;
  }
  if (markerCount > 0 && (!markerFrameDigest || countingRefusals > 1)) return null;

  const history = [...input.history] as AgentInputItem[];
  return {
    disposition: reconciliationRequired ? 'reconciliation_required' : 'ready',
    migration: 'none',
    history,
    providerHistory: reconciliationRequired ? null : [...history],
  };
}

function reconstructAdmission(
  db: HarnessDb,
  row: AdmissionRow,
): ConversationMigration | null {
  const preHistory = parseHistory(row.pre_history_json);
  const frameHistory = parseHistory(row.frame_history_json);
  if (
    preHistory.length !== row.pre_history_item_count
    || frameHistory.length !== row.frame_history_item_count
    || acceptedModelBatchHistoryDigest(preHistory) !== row.pre_history_digest
    || acceptedModelBatchHistoryDigest(frameHistory) !== row.frame_history_digest
  ) throw new Error('model-batch admission history bytes are inconsistent');
  const callIds = parseCallIds(row.call_ids_json);
  if (callIds.length !== row.call_count) throw new Error('model-batch admission call count is inconsistent');
  const openHistory = [...preHistory, ...frameHistory];
  const evidenceByCallId = durableEvidenceForAdmission({ db, row, openHistory, callIds });
  if (!evidenceByCallId) return null;
  return migratePersistedConversationProtocol({ history: openHistory, evidenceByCallId });
}

function exactCheckpointStillReopens(input: {
  db: HarnessDb;
  root: RootRow;
  row: CheckpointRow;
}): boolean {
  if (input.row.authority_digest !== input.root.authority_digest) return false;
  const current = currentExecutionBinding(
    input.db,
    input.row.session_id,
    input.row.source_user_seq,
    input.row.accepted_task_id,
  );
  return sameExecutionBindingOrProvenPlanActivation({
    db: input.db,
    row: input.row,
    current,
  });
}

export function finalizeAcceptedModelBatch(
  ref: AcceptedModelBatchRef,
  options: {
    now?: () => string;
    /** Exact model-visible results already built by the history-commit owner.
     * When supplied, validation proves them against durable settlement/host
     * receipts and checkpoints these bytes without reordering the frame. */
    committedResultItems?: readonly AgentInputItem[];
  } = {},
): FinalizeAcceptedModelBatchResult {
  const root = exactOpenHostRoot(ref);
  if (!root || root.accepted_task_id !== ref.acceptedTaskId || root.authority_digest !== ref.authorityDigest) {
    return { status: 'conflict', reason: 'accepted model batch no longer has its exact open host root' };
  }
  const db = openEventLog();
  const transact = db.transaction((): FinalizeAcceptedModelBatchResult => {
    const row = db.prepare(`
      SELECT * FROM accepted_model_batch_admissions
       WHERE session_id = ? AND source_user_seq = ? AND batch_ordinal = ?
    `).get(ref.sessionId, ref.sourceUserSeq, ref.batchOrdinal) as AdmissionRow | undefined;
    if (
      !row
      || row.batch_id !== ref.batchId
      || row.accepted_task_id !== ref.acceptedTaskId
      || row.authority_digest !== ref.authorityDigest
    ) return { status: 'conflict', reason: 'accepted model batch admission does not match its exact reference' };

    const existing = checkpointRowFor(db, ref);
    if (existing) return { status: 'existing', checkpoint: checkpointFromRow(existing) };

    const admissionBinding = executionBindingFromRow(row);
    const currentBinding = currentExecutionBinding(
      db,
      ref.sessionId,
      ref.sourceUserSeq,
      ref.acceptedTaskId,
    );
    // The only legal null -> graph/work-contract transition is the exact
    // settled plan_task activation. Reuse the common relational proof rather
    // than treating the mere appearance of matching-looking graph rows as
    // authority. Ordinary graph-neutral batches remain null -> null.
    if (
      !admissionBinding
      && currentBinding
      && !proveHostPlannedResolutionCoexistenceInTransaction({
        db,
        sessionId: ref.sessionId,
        sourceUserSeq: ref.sourceUserSeq,
        phase: 'existing',
      })
    ) {
      return {
        status: 'conflict',
        reason: 'model batch graph/work-contract transition lacks exact settled plan authority',
      };
    }
    if (admissionBinding && !sameExecutionBinding(admissionBinding, currentBinding)) {
      return { status: 'conflict', reason: 'model batch graph/work-contract binding changed after admission' };
    }
    const reconstructed = options.committedResultItems
      ? (() => {
          const preHistory = parseHistory(row.pre_history_json);
          const frameHistory = parseHistory(row.frame_history_json);
          const callIds = parseCallIds(row.call_ids_json);
          const history = [
            ...preHistory,
            ...frameHistory,
            ...options.committedResultItems,
          ];
          if (inspectConversationProtocol(history).status !== 'valid') return null;
          const resultCallIds = options.committedResultItems.flatMap((item) => {
            const record = itemRecord(item);
            return record.type === 'function_call_result' && typeof record.callId === 'string'
              ? [record.callId]
              : [];
          });
          if (
            resultCallIds.length !== callIds.length
            || exactJson(resultCallIds) !== exactJson(callIds)
          ) return null;
          return validateCommittedProjection({
            db,
            row,
            history,
            callIds,
          });
        })()
      : reconstructAdmission(db, row);
    if (!reconstructed) {
      return { status: 'evidence_unavailable', reason: 'one or more admitted calls lack exact durable outcome evidence' };
    }
    if (
      reconstructed.disposition !== 'ready'
      && reconstructed.disposition !== 'reconciliation_required'
    ) {
      return { status: 'evidence_unavailable', reason: `model batch is ${reconstructed.disposition}` };
    }
    if (inspectConversationProtocol(reconstructed.history).status !== 'valid') {
      throw new Error('durable model-batch reconstruction is not balanced');
    }
    const historyJson = exactJson(reconstructed.history);
    const historyDigest = sha256(historyJson);
    const lastResponseId = row.provider_response_id ?? row.previous_response_id;
    const committedAt = options.now?.() ?? new Date().toISOString();
    db.prepare(`
      INSERT INTO accepted_model_batch_checkpoints
        (session_id, source_user_seq, accepted_task_id, batch_ordinal,
         batch_id, protocol_version, authority_digest, graph_event_id,
         graph_hash, work_contract_id, disposition, history_json,
         history_digest, history_item_count, last_response_id, committed_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref.sessionId,
      ref.sourceUserSeq,
      ref.acceptedTaskId,
      ref.batchOrdinal,
      ref.batchId,
      ref.authorityDigest,
      currentBinding?.graphEventId ?? null,
      currentBinding?.graphHash ?? null,
      currentBinding?.workContractId ?? null,
      reconstructed.disposition,
      historyJson,
      historyDigest,
      reconstructed.history.length,
      lastResponseId,
      committedAt,
    );
    const inserted = checkpointRowFor(db, ref);
    if (!inserted) throw new Error('model-batch checkpoint insert did not read back');
    return { status: 'committed', checkpoint: checkpointFromRow(inserted) };
  });

  try {
    return transact.immediate();
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function validateCheckpointEvidence(
  db: HarnessDb,
  admission: AdmissionRow,
  checkpoint: AcceptedModelBatchCheckpoint,
): ConversationMigration | null {
  const callIds = parseCallIds(admission.call_ids_json);
  const committed = validateCommittedProjection({
    db,
    row: admission,
    history: checkpoint.history,
    callIds,
  });
  if (committed) return committed;
  const evidenceByCallId = durableEvidenceForAdmission({
    db,
    row: admission,
    openHistory: checkpoint.history,
    callIds,
  });
  if (!evidenceByCallId) return null;
  return migratePersistedConversationProtocol({
    history: checkpoint.history,
    evidenceByCallId,
  });
}

export function recoverAcceptedModelBatchForRestart(input: {
  sessionId: string;
  sourceUserSeq: number;
}): RecoverAcceptedModelBatchResult {
  const db = openEventLog();
  let latest: AdmissionRow | undefined;
  try {
    latest = latestAdmissionRow(db, input.sessionId, input.sourceUserSeq);
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  if (!latest) return { status: 'missing', reason: 'accepted source has no durable model-batch admission' };
  const root = exactOpenHostRoot(input);
  if (!root) return { status: 'conflict', reason: 'exact open host call root is unavailable' };

  let row = checkpointRowFor(db, {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    batchOrdinal: latest.batch_ordinal,
  });
  if (!row) {
    const finalized = finalizeAcceptedModelBatch({
      sessionId: latest.session_id,
      sourceUserSeq: latest.source_user_seq,
      acceptedTaskId: latest.accepted_task_id,
      batchOrdinal: latest.batch_ordinal,
      batchId: latest.batch_id,
      authorityDigest: latest.authority_digest,
    });
    if (finalized.status === 'evidence_unavailable') return finalized;
    if (finalized.status === 'conflict') return finalized;
    if (finalized.status === 'unavailable') return finalized;
    row = checkpointRowFor(db, {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      batchOrdinal: latest.batch_ordinal,
    });
    if (!row) return { status: 'unavailable', reason: 'finalized model-batch checkpoint could not be reopened' };
  }

  try {
    if (!exactCheckpointStillReopens({ db, root, row })) {
      return { status: 'conflict', reason: 'model-batch checkpoint no longer matches its root/graph/work contract' };
    }
    const checkpoint = checkpointFromRow(row);
    const verified = validateCheckpointEvidence(db, latest, checkpoint);
    if (!verified) {
      return { status: 'evidence_unavailable', reason: 'checkpoint call evidence cannot be reopened exactly' };
    }
    if (acceptedModelBatchHistoryDigest(verified.history) !== checkpoint.historyDigest) {
      return { status: 'conflict', reason: 'checkpoint history disagrees with durable conversation reconstruction' };
    }
    if (verified.disposition === 'reconciliation_required' || checkpoint.disposition === 'reconciliation_required') {
      return {
        status: 'reconciliation_required',
        checkpoint,
        reason: 'one or more admitted calls may have crossed the physical effect boundary',
      };
    }
    if (verified.disposition !== 'ready' || checkpoint.disposition !== 'ready') {
      return { status: 'evidence_unavailable', reason: 'checkpoint is not provider-ready' };
    }
    return { status: 'ready', checkpoint };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function restartTokenForCheckpoint(
  checkpoint: AcceptedModelBatchCheckpoint,
): AcceptedModelBatchRestartToken {
  return {
    protocol: 'clementine.accepted_model_batch_restart.v1',
    sessionId: checkpoint.sessionId,
    sourceUserSeq: checkpoint.sourceUserSeq,
    acceptedTaskId: checkpoint.acceptedTaskId,
    authorityDigest: checkpoint.authorityDigest,
    resumeFromBatchOrdinal: checkpoint.batchOrdinal,
    resumeFromBatchId: checkpoint.batchId,
    resumeFromHistoryDigest: checkpoint.historyDigest,
  };
}

export function isAcceptedModelBatchRestartToken(
  value: unknown,
): value is AcceptedModelBatchRestartToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const token = value as Partial<AcceptedModelBatchRestartToken>;
  return token.protocol === 'clementine.accepted_model_batch_restart.v1'
    && typeof token.sessionId === 'string'
    && token.sessionId.length > 0
    && Number.isSafeInteger(token.sourceUserSeq)
    && Number(token.sourceUserSeq) > 0
    && typeof token.acceptedTaskId === 'string'
    && token.acceptedTaskId.length > 0
    && typeof token.authorityDigest === 'string'
    && /^[a-f0-9]{64}$/i.test(token.authorityDigest)
    && Number.isSafeInteger(token.resumeFromBatchOrdinal)
    && Number(token.resumeFromBatchOrdinal) > 0
    && typeof token.resumeFromBatchId === 'string'
    && /^[a-f0-9]{64}$/i.test(token.resumeFromBatchId)
    && typeof token.resumeFromHistoryDigest === 'string'
    && /^[a-f0-9]{64}$/i.test(token.resumeFromHistoryDigest);
}

/** Finalize/reopen the current durable batch and mint an internal-only token. */
export function prepareAcceptedModelBatchRestart(input: {
  sessionId: string;
  sourceUserSeq: number;
}): PrepareAcceptedModelBatchRestartResult {
  const recovered = recoverAcceptedModelBatchForRestart(input);
  if (recovered.status !== 'ready' && recovered.status !== 'reconciliation_required') {
    return recovered;
  }
  return {
    status: recovered.status,
    checkpoint: recovered.checkpoint,
    token: restartTokenForCheckpoint(recovered.checkpoint),
    ...(recovered.status === 'reconciliation_required' ? { reason: recovered.reason } : {}),
  };
}

/**
 * Reopen a private restart token against the append-only current winner.
 * A later ordinal is accepted only because the schema trigger proves an exact
 * checkpoint chain under the same source/root authority.  The token itself is
 * never authority to repair missing evidence or select a different source.
 */
export function recoverAcceptedModelBatchFromToken(
  token: AcceptedModelBatchRestartToken,
): RecoverAcceptedModelBatchResult {
  if (!isAcceptedModelBatchRestartToken(token)) {
    return { status: 'conflict', reason: 'accepted model-batch restart token is malformed' };
  }
  const recovered = recoverAcceptedModelBatchForRestart({
    sessionId: token.sessionId,
    sourceUserSeq: token.sourceUserSeq,
  });
  if (recovered.status !== 'ready' && recovered.status !== 'reconciliation_required') {
    return recovered;
  }
  const checkpoint = recovered.checkpoint;
  if (
    checkpoint.acceptedTaskId !== token.acceptedTaskId
    || checkpoint.authorityDigest !== token.authorityDigest
    || checkpoint.batchOrdinal < token.resumeFromBatchOrdinal
    || (
      checkpoint.batchOrdinal === token.resumeFromBatchOrdinal
      && (
        checkpoint.batchId !== token.resumeFromBatchId
        || checkpoint.historyDigest !== token.resumeFromHistoryDigest
      )
    )
  ) {
    return { status: 'conflict', reason: 'accepted model-batch restart token no longer names this exact chain' };
  }
  return recovered;
}

/** Exact JSON-byte digest for tests and cross-process crash assertions. */
export function acceptedModelBatchItemDigest(item: AgentInputItem): string {
  return conversationProtocolItemBytesSha256(item);
}
