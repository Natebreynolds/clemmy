/** Optional, independently owned card wording. Never reopens a turn or executes a tool. */
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { openEventLog, getUserInputEventAtSequence, readValidatedTerminalEvent, type EventRow } from './eventlog.js';
import { PENDING_ACTIONS_DIR, pendingActionPayloadHash, type PendingActionRecord } from './pending-actions.js';
import { pendingActionResultBinding } from './pending-action-public-result.js';
import { normalizePendingActionResultBinding } from '../../shared/pending-action-result-binding.js';
import { presentationEventFromCompletionData } from './turn-outcome.js';
import { approvedActionProofDigest, approvedActionReceiptId, assertApprovedActionCompletionReceipt,
  proveApprovedActionCompletionInTransaction } from './approved-action-completion-proof.js';
import { readDurableResultPayload } from './result-payload-storage.js';
import { peekTurnSemanticModelPort } from '../semantic-boundary/turn-semantic-port-registry.js';
import { approvedActionResultProjectionAuthorship } from '../semantic-boundary/approved-action-result-authorship.js';
import { actionBus } from '../action-bus.js';
import { createStandaloneModelAccountingJob, standaloneModelAccountingJobBinding, withStandaloneModelAccountingJob } from '../usage-log.js';
import { recordStandaloneModelAccountingJobObservation } from './model-transport-observation.js';
import { runOwnedHostStopNarration } from './host-stop-narration-lifecycle.js';
import {
  APPROVED_ACTION_RESULT_PROJECTION_JOBS_TABLE as JOBS,
  APPROVED_ACTION_RESULT_PROJECTION_RESULTS_TABLE as RESULTS,
  APPROVED_ACTION_RESULT_PROJECTION_MAX_RAW_BYTES as MAX_RAW,
  APPROVED_ACTION_RESULT_PROJECTION_MAX_TEXT as MAX_TEXT,
  approvedActionResultProjectionId, normalizeApprovedActionResultProjectionBinding, normalizeApprovedActionResultProjectionAuthorshipData,
  projectionBindingDigest, projectionTextDigest,
  type ApprovedActionResultProjectionBinding, type ApprovedActionResultProjection, type ApprovedActionResultProjectionStatus,
} from './approved-action-result-projection-data.js';

export * from './approved-action-result-projection-data.js';
const logger = pino({ name: 'clementine.approved-action-result-projection' });
const MAX_BYTES = 65_536;
const DEADLINE_MS = 20_000;
type SqlRow = Record<string, unknown>;
interface JobRow {
  projection_id: string; session_id: string; source_user_seq: number; original_source_user_seq: number;
  terminal_event_id: string; evidence_digest: string; binding_json: string; binding_digest: string;
  status: string; claim_id: string | null; usage_job_id: string | null;
  claim_process_id: number | null; claim_daemon_id: string | null; transport_closed_at: string | null;
  transport_closed_kind: 'call_settled' | 'process_dead' | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}
type Action = Pick<PendingActionRecord, 'id' | 'sessionId' | 'sourceUserSeq' | 'approvalId' | 'payloadHash' | 'status'
  | 'updatedAt' | 'resultSummary' | 'title' | 'toolName' | 'kind' | 'payload' | 'executionAuthority' | 'executionClaimTokenHash' | 'approvedBy'>;
interface Evidence { binding: ApprovedActionResultProjectionBinding; asked: string; action: Action; rawJson: string }
const same = (a: unknown, b: unknown) => closedCanonicalJson(a) === closedCanonicalJson(b);

/** This reader intentionally has no legacy defaulting/consent inference. Only
 * future executed records with explicit human approval can get optional words.
 * Read the already-existing file through a capped descriptor, not readFileSync
 * after a racy size check. No directories or stores are initialized here. */
function readBoundedAction(id: string): Action | null {
  if (!/^pa-[A-Za-z0-9-]{1,160}$/.test(id)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path.join(PENDING_ACTIONS_DIR, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 2 || before.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(before.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.ino !== before.ino || after.dev !== before.dev) return null;
    const raw = bytes.subarray(0, count).toString('utf8');
    if (!Buffer.from(raw).equals(bytes.subarray(0, count))) return null;
    const record = JSON.parse(raw) as Action;
    if (!record || record.id !== id || record.status !== 'executed' || record.approvedBy !== 'human'
      || typeof record.sessionId !== 'string' || typeof record.approvalId !== 'string'
      || !Number.isSafeInteger(record.sourceUserSeq) || Number(record.sourceUserSeq) < 1
      || typeof record.title !== 'string' || typeof record.toolName !== 'string' || typeof record.kind !== 'string'
      || typeof record.resultSummary !== 'string' || Buffer.byteLength(record.resultSummary) > 16_000
      || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) return null;
    return record;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Bound every raw/evidence projection before canonical validators decrypt or
 * parse it. Oversized/spilled results retain their ordinary neutral result;
 * optional narration never reads a spill file or an unbounded source tail. */
function boundedProofInputs(db: Database.Database, sessionId: string, sourceUserSeq: number, originalSourceUserSeq: number, approvalId: string, terminalEventId: string): void {
  const source = db.prepare('SELECT turn,length(CAST(data_json AS BLOB)) AS bytes FROM events WHERE session_id=? AND seq=?')
    .get(sessionId, sourceUserSeq) as { turn: number; bytes: number } | undefined;
  const original = db.prepare('SELECT length(CAST(data_json AS BLOB)) AS bytes FROM events WHERE session_id=? AND seq=?')
    .get(sessionId, originalSourceUserSeq) as { bytes: number } | undefined;
  if (!source || source.bytes > MAX_BYTES || !original || original.bytes > 16_000) throw new Error('projection_input_bound');
  const sizes = db.prepare('SELECT length(CAST(data_json AS BLOB)) AS bytes FROM events WHERE session_id=? AND turn=? LIMIT 97')
    .all(sessionId, source.turn) as { bytes: number }[];
  if (sizes.length > 96 || sizes.some(row => row.bytes > MAX_BYTES) || sizes.reduce((sum, row) => sum + row.bytes, 0) > 262_144) throw new Error('projection_input_bound');
  const jsonChecks = [
    ['SELECT length(CAST(args_json AS BLOB)) AS bytes FROM pending_approvals WHERE approval_id=?', [approvalId]],
    ['SELECT length(CAST(intent_json AS BLOB)) AS bytes FROM approved_action_completion_intents_v1 WHERE session_id=? AND source_user_seq=?', [sessionId, sourceUserSeq]],
    ['SELECT length(CAST(receipt_json AS BLOB)) AS bytes FROM approved_action_completion_receipts_v1 WHERE session_id=? AND source_user_seq=?', [sessionId, sourceUserSeq]],
  ] as const;
  for (const [sql, params] of jsonChecks) {
    const row = db.prepare(sql).get(...params) as { bytes: number } | undefined;
    if (!row || !Number.isSafeInteger(row.bytes) || row.bytes > MAX_BYTES) throw new Error('projection_input_bound');
  }
  for (const table of ['logical_tool_calls', 'logical_call_settlement_crossings', 'approved_action_provider_bindings_v1']) {
    const rows = db.prepare(`SELECT 1 FROM ${table} WHERE session_id=? AND source_user_seq=? LIMIT 4`).all(sessionId, sourceUserSeq);
    if (rows.length > (table === 'logical_tool_calls' ? 1 : 2)) throw new Error('projection_input_bound');
  }
  const provider = db.prepare('SELECT length(CAST(binding_json AS BLOB)) AS bytes FROM approved_action_provider_bindings_v1 WHERE session_id=? AND source_user_seq=? LIMIT 2')
    .all(sessionId, sourceUserSeq) as { bytes: number }[];
  if (provider.some(row => row.bytes > MAX_BYTES)) throw new Error('projection_input_bound');
  // Canonical proofs follow these exact immutable pointers, even when corrupt
  // evidence claims another turn. Fence their sizes before the readers parse.
  const pointers = db.prepare(`SELECT graph_event_id AS id FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?
    UNION SELECT host_completion_event_id FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?
    UNION SELECT intent_event_id FROM approved_action_completion_intents_v1 WHERE session_id=? AND source_user_seq=?
    UNION SELECT receipt_event_id FROM approved_action_completion_receipts_v1 WHERE session_id=? AND source_user_seq=?
    UNION SELECT settlement_event_id FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?
    UNION SELECT refinement_event_id FROM logical_tool_calls WHERE session_id=? AND source_user_seq=?
    UNION SELECT start_event_id FROM physical_dispatches WHERE session_id=? AND source_user_seq=?
    UNION SELECT binding_event_id FROM approved_action_provider_bindings_v1 WHERE session_id=? AND source_user_seq=? LIMIT 33`)
    .all(...Array.from({length:8},()=>[sessionId,sourceUserSeq]).flat()) as { id: string | null }[];
  if (pointers.length > 32) throw new Error('projection_input_bound');
  for (const id of [terminalEventId,...pointers.map(row=>row.id).filter((id):id is string=>typeof id==='string')]) {
    const size = db.prepare('SELECT length(CAST(data_json AS BLOB)) AS bytes FROM events WHERE id=?').get(id) as {bytes:number}|undefined;
    if (!size || size.bytes > MAX_BYTES) throw new Error('projection_input_bound');
  }
  const raw = db.prepare(`SELECT raw_byte_count,length(CAST(raw_payload_json AS BLOB)) AS bytes FROM durable_result_handles
    WHERE session_id=? AND source_user_seq=? AND scope_kind='authoritative' LIMIT 2`).all(sessionId, sourceUserSeq) as { raw_byte_count: number; bytes: number }[];
  if (raw.length !== 1 || !Number.isSafeInteger(raw[0]!.raw_byte_count) || raw[0]!.raw_byte_count < 1
    || raw[0]!.raw_byte_count > MAX_RAW || raw[0]!.bytes !== raw[0]!.raw_byte_count) throw new Error('projection_input_bound');
}

function readEvidence(db: Database.Database, input: { sessionId: string; sourceUserSeq: number; pendingActionId: string;
  terminalEventId: string; retainedWorkNeedsVerification: boolean }): Evidence | null {
  // Optional wording that never queues is invisible otherwise (live 2026-10-20:
  // no job was ever queued); the reason is diagnostics, not a user message.
  const why = (reason: string): null => {
    logger.warn({ reason, sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq, pendingActionId: input.pendingActionId },
      'approval result wording is ineligible');
    return null;
  };
  try {
    const action = readBoundedAction(input.pendingActionId);
    if (!action || action.sessionId !== input.sessionId || Number(action.sourceUserSeq) >= input.sourceUserSeq) return why('action_mismatch');
    boundedProofInputs(db, input.sessionId, input.sourceUserSeq, action.sourceUserSeq!, action.approvalId!, input.terminalEventId);
    const source = getUserInputEventAtSequence(input.sessionId, input.sourceUserSeq);
    const original = getUserInputEventAtSequence(input.sessionId, action.sourceUserSeq!);
    if (!source || !original || original.role !== 'user' || original.data.synthetic === true) return why('source_or_original_unavailable');
    const authority = db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?')
      .get(input.sessionId, input.sourceUserSeq) as SqlRow | undefined;
    if (!authority || authority.state !== 'terminal' || authority.terminal_event_id !== input.terminalEventId) return why('authority_not_terminal');
    const terminal = readValidatedTerminalEvent(input.terminalEventId, input.sessionId, input.sourceUserSeq);
    const presentation = presentationEventFromCompletionData(terminal.data);
    if (presentation?.status !== 'done' || presentation.identity.sessionId !== source.sessionId
      || presentation.identity.sourceUserSeq !== source.seq || presentation.identity.turn !== source.turn) return why('presentation_not_done');
    const expected = pendingActionResultBinding(action, source);
    const stored = normalizePendingActionResultBinding(terminal.data.pendingActionResultBinding);
    if (!expected || !stored || !same(expected, stored)) return why('result_binding_mismatch');
    // The terminal's retained winner is checked at its own publication time.
    // A later Stop can cancel this optional job, never rewrite action success.
    const proof = proveApprovedActionCompletionInTransaction(db, { sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq, stopBefore: terminal.createdAt });
    assertApprovedActionCompletionReceipt(db, {
      session_id: input.sessionId, source_user_seq: input.sourceUserSeq,
      host_completion_receipt_id: authority.host_completion_receipt_id as string | null,
      host_completion_event_id: authority.host_completion_event_id as string | null,
    }, { stopBefore: terminal.createdAt });
    if (proof.intent.pendingActionId !== action.id || proof.intent.approvalId !== action.approvalId
      || proof.intent.originalSourceUserSeq !== action.sourceUserSeq || proof.intent.payloadHash !== action.payloadHash
      || proof.intent.claimHash !== action.executionClaimTokenHash
      || approvedActionProofDigest(action.executionAuthority ?? null) !== proof.intent.executionAuthorityDigest
      || pendingActionPayloadHash(action.toolName, action.payload, action.executionAuthority ?? null) !== action.payloadHash) return why('completion_proof_mismatch');
    const raw = db.prepare('SELECT * FROM durable_result_handles WHERE handle_id=?').get(proof.receipt.resultHandleId) as SqlRow;
    const payload = readDurableResultPayload({ rawLocation: raw.raw_location as string | null,
      rawPayloadJson: raw.raw_payload_json as string | null, rawPayloadSha256: raw.raw_payload_sha256 as string | null,
      rawByteCount: Number(raw.raw_byte_count), rejectionReason: raw.rejection_reason as string | null });
    if (payload.status !== 'ok' || payload.storage !== 'inline') return why('raw_payload_not_inline');
    const originalDigest = approvedActionProofDigest({ id: original.id, seq: original.seq, sessionId: original.sessionId,
      turn: original.turn, role: original.role, type: original.type, data: original.data });
    const binding = normalizeApprovedActionResultProjectionBinding({ version: 1, sessionId: input.sessionId,
      sourceUserSeq: source.seq, attemptId: proof.intent.attemptId, originalSourceUserSeq: original.seq, originalSourceDigest: originalDigest,
      sourceDigest: approvedActionProofDigest({ id: source.id, seq: source.seq, data: source.data }),
      terminalEventId: terminal.id, terminalDigest: approvedActionProofDigest(terminal.data),
      approvalId: action.approvalId, pendingActionId: action.id, payloadHash: action.payloadHash,
      recordUpdatedAt: action.updatedAt, resultSummaryDigest: projectionTextDigest(action.resultSummary!),
      approvalSnapshotDigest: proof.intent.approvalSnapshotDigest, executionAuthorityDigest: proof.intent.executionAuthorityDigest,
      claimHash: proof.intent.claimHash, intentId: proof.intentId, completionReceiptId: approvedActionReceiptId(proof.receipt),
      completionReceiptDigest: approvedActionProofDigest(proof.receipt), logicalToolCallId: proof.intent.logicalToolCallId,
      settlementDigest: proof.receipt.settlementDigest, resultHandleId: proof.receipt.resultHandleId,
      rawPayloadSha256: proof.receipt.rawPayloadSha256, rawByteCount: proof.receipt.rawByteCount,
      retainedWorkNeedsVerification: input.retainedWorkNeedsVerification });
    if (!binding) return why('binding_invalid');
    const asked = original.data.displayText ?? original.data.text ?? original.data.message;
    return { binding, asked: typeof asked === 'string' ? asked.slice(0, 1_200) : '', action, rawJson: payload.rawJson };
  } catch (error) { return why(error instanceof Error ? error.message : String(error)); }
}

export function enqueueApprovedActionResultProjectionInTransaction(db: Database.Database, input: {
  action: PendingActionRecord; source: EventRow; terminal: EventRow; retainedWorkNeedsVerification: boolean;
}): 'queued' | 'existing' | 'ineligible' {
  if (!db.inTransaction || input.action.sessionId !== input.source.sessionId || input.terminal.sessionId !== input.source.sessionId) return 'ineligible';
  const evidence = readEvidence(db, { sessionId: input.source.sessionId, sourceUserSeq: input.source.seq,
    pendingActionId: input.action.id, terminalEventId: input.terminal.id,
    retainedWorkNeedsVerification: input.retainedWorkNeedsVerification });
  if (!evidence || !same(pendingActionResultBinding(input.action, input.source), pendingActionResultBinding(evidence.action, input.source))) return 'ineligible';
  const binding = evidence.binding, digest = projectionBindingDigest(binding), id = approvedActionResultProjectionId(binding);
  const changed = db.prepare(`INSERT INTO ${JOBS}(projection_id,session_id,source_user_seq,original_source_user_seq,
    terminal_event_id,evidence_digest,binding_json,binding_digest,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,'queued',?) ON CONFLICT(session_id,source_user_seq) DO NOTHING`)
    .run(id,binding.sessionId,binding.sourceUserSeq,binding.originalSourceUserSeq,binding.terminalEventId,digest,
      closedCanonicalJson(binding),digest,new Date().toISOString());
  return changed.changes === 1 ? 'queued' : 'existing';
}

function decodeJob(row: JobRow): ApprovedActionResultProjectionBinding | null {
  if (typeof row.binding_json !== 'string' || Buffer.byteLength(row.binding_json) > 16_384) return null;
  try {
    const binding = normalizeApprovedActionResultProjectionBinding(JSON.parse(row.binding_json));
    return binding && row.projection_id === approvedActionResultProjectionId(binding)
      && row.evidence_digest === projectionBindingDigest(binding) && row.binding_digest === row.evidence_digest
      && row.session_id === binding.sessionId && row.source_user_seq === binding.sourceUserSeq
      && row.original_source_user_seq === binding.originalSourceUserSeq && row.terminal_event_id === binding.terminalEventId ? binding : null;
  } catch { return null; }
}
function currentEvidence(row: JobRow): Evidence | null {
  const binding = decodeJob(row);
  if (!binding) return null;
  const evidence = readEvidence(openEventLog(), { sessionId: binding.sessionId, sourceUserSeq: binding.sourceUserSeq,
    pendingActionId: binding.pendingActionId, terminalEventId: binding.terminalEventId,
    retainedWorkNeedsVerification: binding.retainedWorkNeedsVerification });
  return evidence && same(binding, evidence.binding) ? evidence : null;
}

export function readApprovedActionResultProjection(action: Pick<PendingActionRecord, 'id' | 'sessionId' | 'approvalId' | 'payloadHash' | 'updatedAt' | 'status' | 'resultSummary'>,
  terminal: EventRow): ApprovedActionResultProjection | null {
  if (action.status !== 'executed' || !action.sessionId || terminal.sessionId !== action.sessionId) return null;
  try {
    const row = openEventLog().prepare(`SELECT * FROM ${JOBS} WHERE terminal_event_id=? AND session_id=? AND status='published'`)
      .get(terminal.id, action.sessionId) as JobRow | undefined;
    if (!row) return null;
    const binding = decodeJob(row);
    if (!binding || binding.pendingActionId !== action.id || binding.approvalId !== action.approvalId
      || binding.payloadHash !== action.payloadHash || binding.recordUpdatedAt !== action.updatedAt
      || typeof action.resultSummary !== 'string' || Buffer.byteLength(action.resultSummary) > 16_000
      || binding.resultSummaryDigest !== projectionTextDigest(action.resultSummary)
      || Buffer.byteLength(JSON.stringify(terminal.data)) > MAX_BYTES
      || binding.terminalDigest !== approvedActionProofDigest(terminal.data)
      || !currentEvidence(row)) return null;
    const result = openEventLog().prepare(`SELECT * FROM ${RESULTS} WHERE projection_id=?`).get(row.projection_id) as SqlRow | undefined;
    if (!result || result.evidence_digest !== row.evidence_digest || result.usage_job_id !== row.usage_job_id
      || result.published_at !== row.finished_at || typeof result.text !== 'string' || !result.text.trim()
      || result.text.length > MAX_TEXT || result.text_digest !== projectionTextDigest(result.text)
      || typeof result.published_at !== 'string' || !Number.isFinite(Date.parse(result.published_at))) return null;
    if (typeof result.authorship_json !== 'string' || Buffer.byteLength(result.authorship_json)>4_096) return null;
    const authorship=normalizeApprovedActionResultProjectionAuthorshipData(JSON.parse(result.authorship_json));
    if(!authorship || authorship.operationId!==row.projection_id || authorship.revisionDigest!==row.evidence_digest
      || authorship.usageJobId!==row.usage_job_id || authorship.textDigest!==result.text_digest) return null;
    return { id: row.projection_id, revision: 1, evidenceDigest: row.evidence_digest,
      textDigest: result.text_digest as string, text: result.text, publishedAt: result.published_at };
  } catch { return null; }
}

export function readApprovedActionResultProjectionStatus(action: Parameters<typeof readApprovedActionResultProjection>[0],
  terminal: EventRow): ApprovedActionResultProjectionStatus | null {
  if(action.status!=='executed' || !action.sessionId || terminal.sessionId!==action.sessionId) return null;
  try {
    const row=openEventLog().prepare(`SELECT * FROM ${JOBS} WHERE terminal_event_id=? AND session_id=?`)
      .get(terminal.id,action.sessionId) as JobRow|undefined;
    if(!row || !['queued','started','published','failed','cancelled','unknown'].includes(row.status)) return null;
    const binding=decodeJob(row);
    if(!binding || binding.pendingActionId!==action.id || binding.approvalId!==action.approvalId
      || binding.payloadHash!==action.payloadHash || binding.recordUpdatedAt!==action.updatedAt
      || typeof action.resultSummary!=='string' || Buffer.byteLength(action.resultSummary)>16_000
      || binding.resultSummaryDigest!==projectionTextDigest(action.resultSummary)
      || Buffer.byteLength(JSON.stringify(terminal.data))>MAX_BYTES || binding.terminalDigest!==approvedActionProofDigest(terminal.data)
      || !currentEvidence(row)) return null;
    return {id:row.projection_id,revision:1,evidenceDigest:row.evidence_digest,
      status:row.status as ApprovedActionResultProjectionStatus['status'],transportClosed:row.transport_closed_at!==null};
  } catch {return null;}
}

let enabled = false;
const daemonInstance = randomUUID();
let timer: ReturnType<typeof setInterval> | null = null;
let scheduled = false;
let draining: Promise<void> | null = null;
let running: { row: JobRow; claimId: string; controller: AbortController } | null = null;
const openTransportClaims = new Set<string>();
function stopped(row: JobRow): boolean {
  const db = openEventLog();
  const binding = decodeJob(row);
  if (!binding) return true;
  const attempt = db.prepare('SELECT attempt_id,run_id FROM run_attempts WHERE session_id=? AND source_user_seq=? AND attempt_id=?')
    .get(row.session_id,row.source_user_seq,binding.attemptId) as { attempt_id: string; run_id: string | null } | undefined;
  return !attempt || !!db.prepare(`SELECT 1 FROM run_kill_requests WHERE session_id=? AND requested_at>=?
    AND (scope_key='session:*' OR attempt_id=? OR (attempt_id IS NULL AND run_id IS NOT NULL AND run_id=?)) LIMIT 1`)
    .get(row.session_id,row.created_at,attempt.attempt_id,attempt.run_id)
    || !!db.prepare('SELECT 1 FROM kill_switches WHERE session_id=? AND requested_at>=?').get(row.session_id,row.created_at);
}
function finish(row: JobRow, claimId: string, status: 'failed' | 'cancelled' | 'unknown'): void {
  try { openEventLog().prepare(`UPDATE ${JOBS} SET status=?,finished_at=? WHERE projection_id=? AND claim_id=? AND status='started'`)
    .run(status,new Date().toISOString(),row.projection_id,claimId); } catch { /* A crash/IO error remains started, never queued. */ }
}
async function drainOne(): Promise<void> {
  if (!enabled) return;
  const db = openEventLog();
  const row = db.prepare(`SELECT * FROM ${JOBS} WHERE status='queued' ORDER BY created_at,projection_id LIMIT 1`).get() as JobRow | undefined;
  if (!row) return;
  const port = peekTurnSemanticModelPort();
  if (!port?.voiceApprovedActionResultProjection) return;
  const evidence = currentEvidence(row);
  if (!evidence || stopped(row)) {
    db.prepare(`UPDATE ${JOBS} SET status='cancelled',finished_at=? WHERE projection_id=? AND status='queued'`)
      .run(new Date().toISOString(),row.projection_id); return;
  }
  const claimId = randomUUID(), startedAt = new Date().toISOString();
  if (db.prepare(`UPDATE ${JOBS} SET status='started',claim_id=?,claim_process_id=?,claim_daemon_id=?,started_at=? WHERE projection_id=? AND status='queued'`)
    .run(claimId,process.pid,daemonInstance,startedAt,row.projection_id).changes !== 1) return;
  const controller = new AbortController();
  running = { row, claimId, controller };
  const job = createStandaloneModelAccountingJob({ operation: 'approval_result_projection', operationId: row.projection_id,
    revisionDigest: row.evidence_digest });
  const accounting = standaloneModelAccountingJobBinding(job);
  if (!accounting || db.prepare(`UPDATE ${JOBS} SET usage_job_id=? WHERE projection_id=? AND claim_id=? AND status='started' AND usage_job_id IS NULL`)
    .run(accounting.usageJobId,row.projection_id,claimId).changes !== 1) {
    finish(row,claimId,'unknown'); running = null; return;
  }
  const deadlineAt = Date.now() + DEADLINE_MS;
  const assertOwned = () => {
    if (!enabled || running?.claimId !== claimId || controller.signal.aborted || Date.now() >= deadlineAt) throw new Error('projection_closed');
    const current = db.prepare(`SELECT status,claim_id,usage_job_id FROM ${JOBS} WHERE projection_id=?`).get(row.projection_id) as SqlRow | undefined;
    if (current?.status !== 'started' || current.claim_id !== claimId || current.usage_job_id !== accounting.usageJobId
      || stopped(row)) throw new Error('projection_closed');
  };
  recordStandaloneModelAccountingJobObservation(job,{phase:'job_started'});
  let invoked = false;
  let transportClosed = false;
  const closeTransport = () => {
    if(transportClosed) return;
    transportClosed=true;
    openTransportClaims.delete(claimId);
    try { db.prepare(`UPDATE ${JOBS} SET transport_closed_at=?,transport_closed_kind='call_settled' WHERE projection_id=? AND claim_id=?
      AND transport_closed_at IS NULL AND status IN ('started','unknown')`).run(new Date().toISOString(),row.projection_id,claimId); }
    catch { /* Keep an unknown owner when actual host-promise closure could not be retained. */ }
  };
  try {
    // Lazy boundary avoids importing the harness/admission graph into the
    // schema/reader leaves. Never run this independent job under B's ALS.
    const { harnessRunContextStorage } = await import('./brackets.js');
    assertOwned();
    if (!currentEvidence(row)) throw new Error('projection_evidence_changed');
    const result = await runOwnedHostStopNarration({ signal: controller.signal, deadlineMs: DEADLINE_MS,
      assertOwned, isStopped: () => stopped(row), work: async scope => {
      invoked = true;
      openTransportClaims.add(claimId);
      let returned=false;
      try { const value=await harnessRunContextStorage.exit(() => withStandaloneModelAccountingJob(job, () => port.voiceApprovedActionResultProjection!({
        purpose: 'approval_result_projection', signal: scope.signal, deadlineAt, checkActive: scope.assertCurrent,
        onRequestSettled: closeTransport,
        asked: evidence.asked,
        action: { title: evidence.action.title.slice(0,200), kind: evidence.action.toolName === 'run_shell_command' || evidence.action.kind === 'shell_command'
          ? 'command_on_this_computer' : 'connected_app_change' },
        result: { preview: evidence.rawJson.slice(0,4_000), rawByteCount: evidence.binding.rawByteCount,
          truncated: evidence.rawJson.length > 4_000, retainedWorkNeedsVerification: evidence.binding.retainedWorkNeedsVerification,
          independentReadback: false }, evidenceDigest: row.evidence_digest,
      }))); returned=true; return value; } finally {
        recordStandaloneModelAccountingJobObservation(job,{phase:'job_finished',outcome:returned?'returned':'failed'});
      }
    } });
    assertOwned();
    const text = result?.message?.trim();
    const authorship=result ? approvedActionResultProjectionAuthorship(result) : undefined;
    // A nominal successful original response also proves its host request
    // returned. A caller-described result or timeout race never proves this.
    if(authorship) closeTransport();
    if (!text || text.length > MAX_TEXT || result?.evidenceDigest !== row.evidence_digest
      || typeof result.modelIdentity !== 'string' || !result.modelIdentity.trim() || result.modelIdentity.length > 256
      || result.choices?.length || !authorship || authorship.textDigest!==projectionTextDigest(text)
      || authorship.usageJobId!==accounting.usageJobId || authorship.operationId!==row.projection_id
      || authorship.revisionDigest!==row.evidence_digest) { finish(row,claimId,transportClosed ? 'failed' : 'unknown'); return; }
    const published = db.transaction(() => {
      assertOwned();
      if (!currentEvidence(row)) return false;
      const at = new Date().toISOString();
      db.prepare(`INSERT INTO ${RESULTS}(projection_id,evidence_digest,text_digest,text,model_identity,authorship_json,usage_job_id,published_at)
        -- model_identity is configured-role diagnostics, not provider/account proof.
        VALUES(?,?,?,?,?,?,?,?)`).run(row.projection_id,row.evidence_digest,projectionTextDigest(text),text,result.modelIdentity,
          closedCanonicalJson(authorship),accounting.usageJobId,at);
      if (db.prepare(`UPDATE ${JOBS} SET status='published',finished_at=? WHERE projection_id=? AND claim_id=? AND status='started'`)
        .run(at,row.projection_id,claimId).changes !== 1) throw new Error('projection_publication_lost');
      return true;
    }).immediate();
    if (!published) finish(row,claimId,'cancelled');
    if (published) {
      recordStandaloneModelAccountingJobObservation(job,{phase:'operation_receipt',receiptDigest:projectionTextDigest(text)});
      const b=evidence.binding;
      actionBus.emit({kind:'approval.result_updated',sessionId:b.sessionId,approvalId:b.approvalId,pendingActionId:b.pendingActionId,
        payloadHash:b.payloadHash,recordUpdatedAt:b.recordUpdatedAt,projectionId:row.projection_id});
    }
  } catch { finish(row,claimId, !invoked || transportClosed ? 'cancelled' : 'unknown');
    if(!invoked) recordStandaloneModelAccountingJobObservation(job,{phase:'job_finished',outcome:'failed'});
  } finally { running = null; }
}
export function kickApprovedActionResultProjectionDrain(): void {
  if (!enabled || scheduled || draining || openTransportClaims.size > 0) return;
  scheduled = true;
  // A timer created inside an accepted turn would retain its ALS. Exit those
  // scopes at semantic dispatch via the nominal standalone accounting wrapper;
  // the job owns no accepted-source/model/tool admission scope.
  setImmediate(() => {
    scheduled = false;
    if (!enabled || draining || openTransportClaims.size > 0) return;
    draining = drainOne().catch(() => {}).finally(() => { draining = null; });
  });
}
export function startApprovedActionResultProjectionDrain(): void {
  if (enabled) return;
  // A previous process may have sent its model request. Never retry that row.
  openEventLog().prepare(`UPDATE ${JOBS} SET status='unknown',finished_at=? WHERE status='started'`).run(new Date().toISOString());
  // ESRCH proves only process death, not successful generation or known cost.
  // A live/reused/permission-denied PID remains an unverified optional owner.
  const unknown = openEventLog().prepare(`SELECT projection_id,claim_id,claim_process_id FROM ${JOBS}
    WHERE status='unknown' AND transport_closed_at IS NULL ORDER BY created_at LIMIT 100`).all() as Array<Pick<JobRow,'projection_id'|'claim_id'|'claim_process_id'>>;
  for (const row of unknown) {
    if (!Number.isSafeInteger(row.claim_process_id) || Number(row.claim_process_id) < 1) continue;
    try { process.kill(row.claim_process_id!,0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') openEventLog().prepare(`UPDATE ${JOBS} SET transport_closed_at=?,transport_closed_kind='process_dead'
        WHERE projection_id=? AND claim_id=? AND status='unknown' AND transport_closed_at IS NULL`)
        .run(new Date().toISOString(),row.projection_id,row.claim_id);
    }
  }
  enabled = true;
  timer = setInterval(kickApprovedActionResultProjectionDrain,5_000); timer.unref?.();
  kickApprovedActionResultProjectionDrain();
}
export function stopApprovedActionResultProjectionDrain(): void {
  enabled = false;
  if (timer) clearInterval(timer); timer = null;
  if (running) { running.controller.abort(new Error('projection_shutdown')); finish(running.row,running.claimId,'unknown'); }
}
/** Isolated fixtures can wait for the owned request; this never starts work. */
export async function waitForApprovedActionResultProjectionDrain(): Promise<void> {
  if (scheduled) await new Promise<void>(resolve => setImmediate(resolve));
  await draining;
}
