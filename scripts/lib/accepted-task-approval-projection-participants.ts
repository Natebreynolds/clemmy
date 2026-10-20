import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../src/shared/closed-canonical-json.js';
import { normalizePendingActionResultBinding } from '../../src/shared/pending-action-result-binding.js';
import { presentationEventFromCompletionData } from '../../src/runtime/harness/turn-outcome.js';
import { APPROVED_ACTION_RESULT_PROJECTION_JOBS_TABLE as JOBS,
  APPROVED_ACTION_RESULT_PROJECTION_RESULTS_TABLE as RESULTS, approvedActionResultProjectionId,
  normalizeApprovedActionResultProjectionBinding, normalizeApprovedActionResultProjectionAuthorshipData,
  projectionBindingDigest, projectionTextDigest, type ApprovedActionResultProjectionBinding,
  type ApprovedActionResultProjectionAuthorshipData } from '../../src/runtime/harness/approved-action-result-projection-data.js';
import { approvalProjectionJobId, type ApprovalProjectionAccountingParticipant,
  type ApprovalProjectionModelAttempt } from './accepted-task-approval-projection-usage.js';

type Row = Record<string, unknown>;
export interface AcceptedTaskApprovalProjectionParticipants {
  jobs: ApprovalProjectionAccountingParticipant[];
  claimedJobIds: string[];
  issues: string[];
}
const digest = (value: unknown): string => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');
const record = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,255}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const seq = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const epoch = (value: unknown): number | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function json(value: unknown): Row | undefined {
  if (typeof value !== 'string') return undefined;
  try { const parsed: unknown = JSON.parse(value); return record(parsed) ? parsed : undefined; } catch { return undefined; }
}
function openReadOnly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try { db.pragma('query_only = ON'); return db; } catch (error) { db.close(); throw error; }
}
function event(db: Database.Database, session: string, column: 'id' | 'seq', value: unknown): (Row & { data: Row }) | undefined {
  const row = db.prepare(`SELECT id,seq,session_id,turn,role,type,created_at,
    CASE WHEN octet_length(data_json)<=65536 THEN data_json END AS data_json
    FROM events WHERE session_id=? AND ${column}=?`).get(session, value) as Row | undefined;
  const data = json(row?.data_json);
  return row && data ? { ...row, data } : undefined;
}

/** Reopen the exact stored accounting origin, not business-result or execution
 * authority. All reads use the caller's explicit RO connection; no runtime
 * singleton, schema installer, raw result payload or pending-action file opens. */
function proveOrigin(db: Database.Database, row: Row, accepted: ReadonlySet<string>): ApprovedActionResultProjectionBinding | null {
  const parsed = json(row.binding_json);
  const binding = normalizeApprovedActionResultProjectionBinding(parsed);
  if (!binding || !accepted.has(`${binding.sessionId}:${binding.originalSourceUserSeq}`)
    || row.projection_id !== approvedActionResultProjectionId(binding)
    || row.evidence_digest !== projectionBindingDigest(binding) || row.binding_digest !== row.evidence_digest
    || row.session_id !== binding.sessionId || row.source_user_seq !== binding.sourceUserSeq
    || row.original_source_user_seq !== binding.originalSourceUserSeq || row.terminal_event_id !== binding.terminalEventId) return null;
  const a = event(db, binding.sessionId, 'seq', binding.originalSourceUserSeq);
  const b = event(db, binding.sessionId, 'seq', binding.sourceUserSeq);
  const terminal = event(db, binding.sessionId, 'id', binding.terminalEventId);
  if (!a || !b || !terminal || a.role !== 'user' || a.type !== 'user_input_received' || a.data.synthetic === true
    || digest({ id: a.id, seq: a.seq, sessionId: a.session_id, turn: a.turn, role: a.role, type: a.type, data: a.data }) !== binding.originalSourceDigest
    || b.role !== 'user' || b.type !== 'user_input_received' || b.data.synthetic !== true || b.data.source !== 'approval_resume'
    || b.data.approvalId !== binding.approvalId || b.data.decision !== 'approve'
    || digest({ id: b.id, seq: b.seq, data: b.data }) !== binding.sourceDigest
    || terminal.role !== 'system' || terminal.type !== 'conversation_completed' || Number(terminal.seq) <= Number(b.seq)
    || digest(terminal.data) !== binding.terminalDigest) return null;
  const presentation = presentationEventFromCompletionData(terminal.data);
  const resultBinding = normalizePendingActionResultBinding(terminal.data.pendingActionResultBinding);
  if (presentation?.status !== 'done' || presentation.identity.sessionId !== binding.sessionId
    || presentation.identity.sourceUserSeq !== binding.sourceUserSeq || presentation.identity.turn !== b.turn
    || !resultBinding || resultBinding.recordStatus !== 'executed' || resultBinding.sessionId !== binding.sessionId
    || resultBinding.sourceUserSeq !== binding.sourceUserSeq || resultBinding.pendingActionId !== binding.pendingActionId
    || resultBinding.approvalId !== binding.approvalId || resultBinding.payloadHash !== binding.payloadHash
    || resultBinding.recordUpdatedAt !== binding.recordUpdatedAt || resultBinding.resultSummaryDigest !== binding.resultSummaryDigest) return null;
  const authority = db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?')
    .get(binding.sessionId, binding.sourceUserSeq) as Row | undefined;
  const intentRow = db.prepare(`SELECT intent_id,intent_event_id,CASE WHEN octet_length(intent_json)<=65536 THEN intent_json END AS bounded_json
    FROM approved_action_completion_intents_v1 WHERE intent_id=? AND session_id=? AND source_user_seq=?`)
    .get(binding.intentId, binding.sessionId, binding.sourceUserSeq) as Row | undefined;
  const receiptRow = db.prepare(`SELECT receipt_id,intent_id,receipt_event_id,CASE WHEN octet_length(receipt_json)<=65536 THEN receipt_json END AS bounded_json
    FROM approved_action_completion_receipts_v1 WHERE receipt_id=? AND session_id=? AND source_user_seq=?`)
    .get(binding.completionReceiptId, binding.sessionId, binding.sourceUserSeq) as Row | undefined;
  const intent = json(intentRow?.bounded_json), receipt = json(receiptRow?.bounded_json);
  if (!authority || authority.state !== 'terminal' || authority.terminal_event_id !== binding.terminalEventId
    || authority.host_completion_receipt_id !== binding.completionReceiptId || authority.host_completion_event_id !== receiptRow?.receipt_event_id
    || !intent || !receipt || receiptRow?.intent_id !== binding.intentId
    || binding.intentId !== `approved-action-intent:v1:${digest(intent)}`
    || binding.completionReceiptId !== `approved-action-receipt:v1:${digest(receipt)}`
    || binding.completionReceiptDigest !== digest(receipt)
    || intent.version !== 1 || intent.scope !== 'exact_approved_call' || receipt.version !== 1 || receipt.scope !== 'exact_approved_call'
    || intent.sessionId !== binding.sessionId || intent.sourceUserSeq !== binding.sourceUserSeq || intent.sourceEventId !== b.id
    || intent.turn !== b.turn || intent.acceptedTaskId !== authority.accepted_task_id
    || intent.originalSourceUserSeq !== binding.originalSourceUserSeq || intent.approvalId !== binding.approvalId
    || intent.attemptId !== binding.attemptId
    || intent.pendingActionId !== binding.pendingActionId || intent.payloadHash !== binding.payloadHash
    || intent.claimHash !== binding.claimHash || intent.approvalSnapshotDigest !== binding.approvalSnapshotDigest
    || intent.executionAuthorityDigest !== binding.executionAuthorityDigest || intent.logicalToolCallId !== binding.logicalToolCallId
    || receipt.intentId !== binding.intentId || receipt.sessionId !== binding.sessionId || receipt.sourceUserSeq !== binding.sourceUserSeq
    || receipt.acceptedTaskId !== authority.accepted_task_id || receipt.logicalToolCallId !== binding.logicalToolCallId
    || receipt.settlementDigest !== binding.settlementDigest || receipt.resultHandleId !== binding.resultHandleId
    || receipt.rawPayloadSha256 !== binding.rawPayloadSha256 || receipt.rawByteCount !== binding.rawByteCount) return null;
  const intentEvent = event(db, binding.sessionId, 'id', intentRow?.intent_event_id);
  const receiptEvent = event(db, binding.sessionId, 'id', receiptRow?.receipt_event_id);
  if (!intentEvent || !receiptEvent || intentEvent.role !== 'system' || intentEvent.type !== 'approved_action_completion_intent'
    || intentEvent.data.intentId !== binding.intentId || digest(intentEvent.data.intent) !== digest(intent)
    || receiptEvent.role !== 'system' || receiptEvent.type !== 'approved_action_completion_receipt'
    || receiptEvent.data.receiptId !== binding.completionReceiptId || digest(receiptEvent.data.receipt) !== binding.completionReceiptDigest) return null;
  const card = db.prepare(`SELECT session_id,status,resolution,CASE WHEN octet_length(args_json)<=65536 THEN args_json END AS args_json
    FROM pending_approvals WHERE approval_id=?`).get(binding.approvalId) as Row | undefined;
  const args = json(card?.args_json), snapshot = args && record(args.pendingAction) ? args.pendingAction : undefined;
  if (card?.session_id !== binding.sessionId || card.status !== 'resolved' || card.resolution !== 'approved'
    || !args || digest(args) !== binding.approvalSnapshotDigest || args.pendingActionId !== binding.pendingActionId
    || !snapshot || snapshot.id !== binding.pendingActionId || snapshot.payloadHash !== binding.payloadHash
    || digest(snapshot.executionAuthority ?? null) !== binding.executionAuthorityDigest) return null;
  return binding;
}

interface JournalEvent { row: Row; data: Row }
const parentless = ({ row, data }: JournalEvent): boolean => [row.session_id, row.workflow_run_id, row.workflow_node_run_id, row.tool_call_id]
  .every(value => value === null) && ['sourceUserSeq', 'logicalTurnId', 'runAttemptId', 'attemptId', 'acceptedSource', 'usageParentTurn']
  .every(key => !Object.hasOwn(data, key));
/** Pure inventory/clock projection only: callers must independently qualify
 * the durable job/source/tuple before these observations can bind any usage. */
export function projectApprovalProjectionPhysicalAttempts(events: readonly JournalEvent[], finishedAt: number | null,
  issue: (code: string) => void): ApprovalProjectionModelAttempt[] {
  const groups = new Map<string, JournalEvent[]>();
  for (const entry of events.filter(row => row.row.actor === 'model-transport-observation')) {
    const data = entry.data;
    if (!identity(data.modelCallId) || entry.row.model_call_id !== data.modelCallId || !seq(data.physicalAttempt)
      || data.purpose !== 'writer' || !parentless(entry)) { issue('approval_projection_invalid_physical_owner'); continue; }
    const key = JSON.stringify([data.modelCallId, data.physicalAttempt]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()].map((rows): ApprovalProjectionModelAttempt => {
    const data = rows[0]!.data;
    const starts = rows.filter(row => row.data.phase === 'adapter_attempt_created');
    const ends = rows.filter(row => row.data.phase === 'adapter_attempt_finished');
    const completed = rows.filter(row => row.data.phase === 'model_result_completed');
    const dispatches = rows.filter(row => row.data.phase === 'dispatch_started');
    const result = completed[0]?.data;
    const dispatchIds = Array.isArray(result?.dispatchIds) ? result.dispatchIds : [];
    const observedDispatchIds = dispatches.map(row => row.data.dispatchId);
    const exact = starts.length === 1 && ends.length === 1 && completed.length === 1
      && rows.every(row => row.data.journalFailed === false) && ends[0]!.data.outcome === 'returned'
      && result?.resultScope === 'original_sdk_response' && identity(result.hostResultReceiptId)
      && hash(result.providerResponseIdDigest) && dispatchIds.length > 0
      && dispatchIds.every(identity) && new Set(dispatchIds).size === dispatchIds.length
      && observedDispatchIds.length === dispatchIds.length
      && observedDispatchIds.every(identity) && new Set(observedDispatchIds).size === observedDispatchIds.length
      && dispatchIds.every(id => observedDispatchIds.includes(id))
      && dispatches.every(row => Number(starts[0]!.row.journalIndex) < Number(row.row.journalIndex)
        && Number(row.row.journalIndex) < Number(completed[0]!.row.journalIndex))
      && Number(starts[0]!.row.journalIndex) < Number(completed[0]!.row.journalIndex)
      && Number(completed[0]!.row.journalIndex) < Number(ends[0]!.row.journalIndex)
      && ends[0]!.data.resultScope === 'original_sdk_response' && ends[0]!.data.providerResponseIdDigest === result.providerResponseIdDigest;
    if (!exact) issue('approval_projection_original_response_unproved');
    const times = rows.map(row => row.data.clock === 'host_epoch_ms' && typeof row.data.at === 'number'
      && Number.isSafeInteger(row.data.at) && row.data.at >= 0 ? row.data.at : null);
    const comparable = finishedAt !== null && Number.isSafeInteger(finishedAt) && finishedAt >= 0;
    if (!comparable || times.some(at => at === null)) issue('approval_projection_late_window_unavailable');
    const late = comparable && times.some(at => at !== null && at > finishedAt!) ? true
      : comparable && times.every(at => at !== null) ? false : null;
    return { modelCallId: String(data.modelCallId), physicalAttempt: Number(data.physicalAttempt),
      outcome: ends.length !== 1 ? 'unfinished' : exact ? 'returned'
        : ends[0]!.data.outcome === 'failed' || ends[0]!.data.outcome === 'cancelled' ? 'failed' : 'unknown',
      dispatches: dispatches.length, late,
      ...(exact ? { originalResponse: { hostResultReceiptId: String(result!.hostResultReceiptId),
        providerResponseIdDigest: String(result!.providerResponseIdDigest),
        ...(hash(result!.responseOutputDigest) ? { responseOutputDigest: result!.responseOutputDigest } : {}) } } : {}) };
  });
}

function readPublication(db: Database.Database, row: Row): ApprovedActionResultProjectionAuthorshipData | null {
  const saved = db.prepare(`SELECT evidence_digest,text_digest,usage_job_id,published_at,
    CASE WHEN octet_length(text)<=2400 THEN text END AS text,
    CASE WHEN octet_length(authorship_json)<=4096 THEN authorship_json END AS authorship_json
    FROM ${RESULTS} WHERE projection_id=?`).get(row.projection_id) as Row | undefined;
  const authorship = normalizeApprovedActionResultProjectionAuthorshipData(json(saved?.authorship_json));
  if (!saved || !authorship || saved.evidence_digest !== row.evidence_digest || saved.usage_job_id !== row.usage_job_id
    || saved.published_at !== row.finished_at || typeof saved.text !== 'string' || !saved.text.trim()
    || saved.text.length > 600 || projectionTextDigest(saved.text) !== saved.text_digest || authorship.textDigest !== saved.text_digest
    || authorship.usageJobId !== row.usage_job_id || authorship.operationId !== row.projection_id
    || authorship.revisionDigest !== row.evidence_digest) return null;
  return authorship;
}

/** Optional post-terminal legs are related by immutable receipt digests, not
 * source/time/job namespace alone. No returned model text is serialized. */
export function readAcceptedTaskApprovalProjectionParticipants(home: string,
  acceptedSources: readonly { sessionId: string; sourceUserSeq: number }[],
): AcceptedTaskApprovalProjectionParticipants {
  const jobs: ApprovalProjectionAccountingParticipant[] = [], claims = new Set<string>(), issues = new Set<string>();
  const result = (): AcceptedTaskApprovalProjectionParticipants => ({ jobs,
    claimedJobIds: [...claims].sort(), issues: [...issues].sort() });
  const issue = (code: string) => { issues.add(code); };
  if (!path.isAbsolute(home) || acceptedSources.length > 256) { issue('approval_projection_source_inventory_invalid'); return result(); }
  if (!acceptedSources.length) return result();
  const accepted = new Set(acceptedSources.filter(row => identity(row.sessionId) && seq(row.sourceUserSeq))
    .map(row => `${row.sessionId}:${row.sourceUserSeq}`));
  if (accepted.size !== new Set(acceptedSources.map(row => `${row.sessionId}:${row.sourceUserSeq}`)).size) issue('approval_projection_source_identity_invalid');
  let db: Database.Database;
  try { db = openReadOnly(path.join(home, 'state', 'harness.db')); } catch { issue('approval_projection_store_unavailable'); return result(); }
  const proven: Array<{ row: Row; binding: ApprovedActionResultProjectionBinding;
    publication: ApprovedActionResultProjectionAuthorshipData | null }> = [];
  try {
    if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', JOBS)) return result();
    db.transaction(() => {
      const seen = new Set<string>();
      for (const source of acceptedSources) {
        if (!accepted.has(`${source.sessionId}:${source.sourceUserSeq}`)) continue;
        const rows = db.prepare(`SELECT projection_id,session_id,source_user_seq,original_source_user_seq,terminal_event_id,
          evidence_digest,binding_digest,status,claim_id,usage_job_id,created_at,started_at,finished_at,
          CASE WHEN octet_length(binding_json)<=16384 THEN binding_json END AS binding_json
          FROM ${JOBS} WHERE session_id=? AND original_source_user_seq=? LIMIT 257`).all(source.sessionId, source.sourceUserSeq) as Row[];
        if (rows.length > 256 || proven.length + rows.length > 256) { issue('approval_projection_job_inventory_limit'); continue; }
        for (const row of rows) {
          if (!identity(row.projection_id)) { issue('approval_projection_origin_unproved'); continue; }
          if (seen.has(row.projection_id)) continue;
          seen.add(row.projection_id);
          let binding: ApprovedActionResultProjectionBinding | null = null;
          try { binding = proveOrigin(db, row, accepted); } catch { /* malformed exact proof remains unqualified */ }
          if (!binding) { issue('approval_projection_origin_unproved'); continue; }
          if (!['queued', 'started', 'published', 'failed', 'cancelled', 'unknown'].includes(String(row.status))) {
            issue('approval_projection_status_unknown'); continue;
          }
          if (row.usage_job_id !== null && !approvalProjectionJobId(row.usage_job_id)) { issue('approval_projection_job_identity_invalid'); continue; }
          if (approvalProjectionJobId(row.usage_job_id)) claims.add(row.usage_job_id);
          let publication: ApprovedActionResultProjectionAuthorshipData | null = null;
          if (row.status === 'published') {
            try { publication = readPublication(db, row); } catch { /* missing immutable output remains unqualified */ }
            if (!publication) issue('approval_projection_authorship_unproved');
          }
          proven.push({ row, binding, publication });
        }
      }
    })();
  } catch { issue('approval_projection_schema_unavailable'); }
  finally { db.close(); }
  let operational: Database.Database | undefined;
  if (claims.size) try { operational = openReadOnly(path.join(home, 'state', 'operational-telemetry.db')); }
  catch { issue('approval_projection_accounting_store_unavailable'); }
  try {
    for (const { row, binding, publication } of proven) {
      const ownJob = approvalProjectionJobId(row.usage_job_id) ? row.usage_job_id : null;
      let attempts: ApprovalProjectionModelAttempt[] = [];
      let accountingQualified = false;
      let authoredResponseBound = false;
      if (ownJob && operational) {
        const raw = operational.prepare(`SELECT rowid AS journalIndex,actor,model_call_id,session_id,workflow_run_id,workflow_node_run_id,tool_call_id,
          CASE WHEN octet_length(payload_json)<=32768 THEN payload_json END AS payload_json
          FROM operational_events WHERE source='model' AND type='model_accounting_observed' AND json_valid(payload_json)
          AND json_extract(payload_json,'$.usageJobId')=? ORDER BY rowid LIMIT 4097`).all(ownJob) as Row[];
        if (raw.length > 4096) issue('approval_projection_accounting_inventory_limit');
        else {
          const events = raw.flatMap(row => { const data = json(row.payload_json); return data ? [{ row, data }] : []; });
          const exact = events.length === raw.length && events.every(entry => parentless(entry)
            && entry.data.version === 1 && entry.data.ownerKind === 'accounting_job'
            && entry.data.operation === 'approval_result_projection' && entry.data.operationId === row.projection_id
            && entry.data.revisionDigest === row.evidence_digest && entry.data.usageJobId === ownJob);
          if (!exact) {
            issue('approval_projection_accounting_tuple_conflict');
            // Contrary ownership is stronger than the job column's claim.
            // Do not debit this task for another job's copied namespace.
            claims.delete(ownJob);
          }
          attempts = projectApprovalProjectionPhysicalAttempts(events, epoch(row.finished_at), issue);
          if (exact) {
            const starts = events.filter(event => event.data.phase === 'job_started');
            const ends = events.filter(event => event.data.phase === 'job_finished');
            if (starts.length !== 1 || starts[0]!.row.actor !== 'approval' || starts[0]!.row.model_call_id !== null
              || ends.length !== 1 || ends[0]!.row.actor !== 'approval' || ends[0]!.row.model_call_id !== null
              || Number(starts[0]!.row.journalIndex) >= Number(ends[0]!.row.journalIndex)) issue('approval_projection_job_lifecycle_unknown');
            accountingQualified = starts.length === 1 && starts[0]!.row.actor === 'approval' && starts[0]!.row.model_call_id === null;
            if (publication) {
              const receipts = events.filter(entry => entry.data.phase === 'operation_receipt');
              const matching = attempts.filter(attempt => attempt.modelCallId === publication.modelCallId
                && attempt.physicalAttempt === publication.physicalAttempt && attempt.outcome === 'returned'
                && attempt.originalResponse?.hostResultReceiptId === publication.hostResultReceiptId
                && attempt.originalResponse.providerResponseIdDigest === publication.providerResponseIdDigest
                && attempt.originalResponse.responseOutputDigest === publication.responseOutputDigest);
              authoredResponseBound = matching.length === 1 && receipts.length === 1 && receipts[0]!.row.actor === 'approval'
                && receipts[0]!.row.model_call_id === null && receipts[0]!.data.receiptDigest === publication.textDigest;
            }
          }
        }
      }
      if (publication && !authoredResponseBound) issue('approval_projection_authorship_response_unproved');
      jobs.push({ projectionId: String(row.projection_id), usageJobId: ownJob, operation: 'approval_result_projection',
        revisionDigest: projectionBindingDigest(binding), parentAcceptedSource: `${binding.sessionId}:${binding.originalSourceUserSeq}`,
        executionAcceptedSource: `${binding.sessionId}:${binding.sourceUserSeq}`, terminalEventId: binding.terminalEventId,
        status: String(row.status), accountingQualified, authoredResponseBound,
        attempts, startedAt: epoch(row.started_at), finishedAt: epoch(row.finished_at) });
    }
  } catch { issue('approval_projection_accounting_read_unavailable'); }
  finally { operational?.close(); }
  return result();
}
