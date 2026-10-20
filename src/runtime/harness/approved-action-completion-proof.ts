import { settlementSemanticDigest } from './settlement-semantic-digest.js';
import type { CommitLogicalCallSettlementInput, LogicalCallExecutionKind } from './logical-call-settlement-store.js';
/** Exact-call completion, never proof of the original business objective.
 * This leaf is deliberately independent of eventlog and execution modules so
 * the canonical terminal writer can re-open its evidence in its transaction. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { readDurableResultPayload } from './result-payload-storage.js';
import { settlementCrossingAuthorityDigest, type SettlementCrossingAuthorityEntry } from './settlement-crossing-authority.js';

export const APPROVED_ACTION_INTENT_EVENT = 'approved_action_completion_intent' as const;
export const APPROVED_ACTION_RECEIPT_EVENT = 'approved_action_completion_receipt' as const;
export const approvedActionProofDigest = (value: unknown): string => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');

export interface ApprovedActionCompletionIntent {
  version: 1;
  scope: 'exact_approved_call';
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  turn: number;
  acceptedTaskId: string;
  graphEventId: string;
  graphId: string;
  graphHash: string;
  originalSourceUserSeq: number | null;
  approvalId: string;
  pendingActionId: string;
  payloadHash: string;
  executionAuthorityDigest: string;
  approvalSnapshotDigest: string;
  claimHash: string;
  attemptId: string;
  logicalToolCallId: string;
  toolName: string;
  argumentDigest: string;
  effect: string;
  /** Cached schema is bound as observation only, never execution authority. */
  observedSchemaFingerprint: string | null;
}
export interface ApprovedActionCompletionReceipt {
  version: 1;
  scope: 'exact_approved_call';
  intentId: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  settlementEventId: string;
  settlementDigest: string;
  resultHandleId: string;
  rawPayloadSha256: string;
  rawByteCount: number;
}
type Row = Record<string, unknown>;
export const approvedActionIntentId = (intent: ApprovedActionCompletionIntent): string => `approved-action-intent:v1:${approvedActionProofDigest(intent)}`;
export const approvedActionReceiptId = (receipt: ApprovedActionCompletionReceipt): string => `approved-action-receipt:v1:${approvedActionProofDigest(receipt)}`;
const requireProof = (condition: unknown, reason: string): void => { if (!condition) throw new Error(`approved action completion: ${reason}`); };

/** Exact-source Stop survives physical finally clearing its transient latch.
 * A later unrelated attempt or Stop cannot change a retained terminal winner. */
export function approvedActionDecisionWasStoppedInTransaction(
  db: Database.Database,
  input: { sessionId: string; sourceUserSeq: number; stopBefore?: string },
): boolean {
  const cutoff = input.stopBefore ?? null;
  const cancelled = db.prepare(`SELECT 1 FROM run_attempts WHERE session_id=? AND source_user_seq=?
    AND status='cancelled' AND (? IS NULL OR finished_at IS NULL OR finished_at<=?) LIMIT 1`)
    .get(input.sessionId, input.sourceUserSeq, cutoff, cutoff);
  const stop = db.prepare(`SELECT 1 FROM run_kill_requests k WHERE k.session_id=?
    AND (k.scope_key='session:*' OR k.attempt_id IN (SELECT a.attempt_id FROM run_attempts a
      WHERE a.session_id=k.session_id AND a.source_user_seq=?)
      OR (k.attempt_id IS NULL AND k.run_id IN (SELECT a.run_id FROM run_attempts a
        WHERE a.session_id=k.session_id AND a.source_user_seq=? AND a.run_id IS NOT NULL)))
    AND (? IS NULL OR k.requested_at<=?) LIMIT 1`)
    .get(input.sessionId, input.sourceUserSeq, input.sourceUserSeq, cutoff, cutoff);
  const legacyStop = db.prepare('SELECT 1 FROM kill_switches WHERE session_id=? AND (? IS NULL OR requested_at<=?)')
    .get(input.sessionId, cutoff, cutoff);
  return Boolean(cancelled || stop || legacyStop);
}

/** No currently-live lease is required after success: the executor has already
 * revoked its own generation. Its retained exact parentage must still agree. */
export function proveApprovedActionCompletionInTransaction(
  db: Database.Database,
  input: { sessionId: string; sourceUserSeq: number; allowStopped?: boolean; stopBefore?: string },
): { intent: ApprovedActionCompletionIntent; intentId: string; receipt: ApprovedActionCompletionReceipt } {
  const row = db.prepare(`SELECT * FROM approved_action_completion_intents_v1 WHERE session_id=? AND source_user_seq=?`)
    .get(input.sessionId, input.sourceUserSeq) as Row | undefined;
  requireProof(row, 'pre-dispatch intent is missing');
  const intent = JSON.parse(String(row!.intent_json)) as ApprovedActionCompletionIntent;
  const intentId = approvedActionIntentId(intent);
  requireProof(row!.intent_id === intentId && intent.sessionId === input.sessionId && intent.sourceUserSeq === input.sourceUserSeq
    && intent.version === 1 && intent.scope === 'exact_approved_call'
    && intent.acceptedTaskId === `task:${input.sessionId}#${input.sourceUserSeq}`
    && intent.logicalToolCallId === `approved-action:${intent.pendingActionId}:${intent.sourceUserSeq}:${intent.claimHash}`
    && /^[a-f0-9]{64}$/.test(intent.claimHash), 'intent identity is not exact');
  const source = db.prepare('SELECT * FROM events WHERE session_id=? AND seq=?').get(input.sessionId, input.sourceUserSeq) as Row | undefined;
  const data = source ? JSON.parse(String(source.data_json)) as Row : null;
  requireProof(source?.id === intent.sourceEventId && source?.role === 'user' && source?.type === 'user_input_received'
    && source?.turn === intent.turn && data?.synthetic === true && data.source === 'approval_resume'
    && data.approvalId === intent.approvalId && data.decision === 'approve', 'source is not this exact synthetic decision');
  const decisions = db.prepare(`SELECT seq FROM events WHERE session_id=? AND type='user_input_received'
    AND json_valid(data_json) AND json_extract(data_json,'$.approvalId')=? AND json_extract(data_json,'$.decision')='approve' LIMIT 2`)
    .all(input.sessionId, intent.approvalId) as Row[];
  requireProof(decisions.length === 1 && decisions[0]!.seq === input.sourceUserSeq, 'decision is ambiguous');
  const card = db.prepare('SELECT * FROM pending_approvals WHERE approval_id=?').get(intent.approvalId) as Row | undefined;
  const args = card?.args_json ? JSON.parse(String(card.args_json)) as Row : null;
  requireProof(card?.session_id === input.sessionId && card?.status === 'resolved' && card?.resolution === 'approved'
    && approvedActionProofDigest(args) === intent.approvalSnapshotDigest
    && args?.pendingActionId === intent.pendingActionId, 'approved card changed');
  const snapshot = args?.pendingAction as Row | undefined;
  requireProof(snapshot?.id === intent.pendingActionId && snapshot.payloadHash === intent.payloadHash
    && approvedActionProofDigest(snapshot.executionAuthority ?? null) === intent.executionAuthorityDigest, 'frozen payload/account snapshot changed');
  const authority = db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?')
    .get(input.sessionId, input.sourceUserSeq) as Row | undefined;
  requireProof(authority?.accepted_task_id === intent.acceptedTaskId && authority.graph_event_id === intent.graphEventId
    && authority.graph_id === intent.graphId && authority.graph_hash === intent.graphHash
    && authority.work_contract_id === null && authority.expected_work_required === 1
    && ['armed','manifested_verifying','terminal'].includes(String(authority.state)), 'own graph authority changed');
  const graph = db.prepare('SELECT data_json FROM events WHERE id=? AND session_id=? AND type=?')
    .get(intent.graphEventId, input.sessionId, 'turn_graph_compiled') as Row | undefined;
  const graphData = graph ? JSON.parse(String(graph.data_json)) as Row : null;
  requireProof(graphData?.graphHash === intent.graphHash && graphData.graphId === intent.graphId
    && graphData.sourceUserSeq === input.sourceUserSeq, 'retained graph is missing');
  const attempt = db.prepare('SELECT * FROM run_attempts WHERE attempt_id=? AND session_id=? AND source_user_seq=?')
    .get(intent.attemptId, input.sessionId, input.sourceUserSeq) as Row | undefined;
  requireProof(attempt && ['active','completed','interrupted', ...(input.allowStopped ? ['cancelled'] : [])].includes(String(attempt.status)), 'attempt was cancelled or replaced');
  if (!input.allowStopped) {
    requireProof(!approvedActionDecisionWasStoppedInTransaction(db, input), 'owner stopped this decision');
  }
  const intentEvent = db.prepare('SELECT * FROM events WHERE id=? AND session_id=? AND type=?')
    .get(row!.intent_event_id, input.sessionId, APPROVED_ACTION_INTENT_EVENT) as Row | undefined;
  const intentData = intentEvent ? JSON.parse(String(intentEvent.data_json)) as Row : null;
  requireProof(intentData?.intentId === intentId && closedCanonicalJson(intentData.intent) === closedCanonicalJson(intent)
    && Number(intentEvent!.seq) > input.sourceUserSeq, 'intent mirror changed');
  const logical = db.prepare('SELECT * FROM logical_tool_calls WHERE session_id=? AND source_user_seq=?')
    .all(input.sessionId, input.sourceUserSeq) as Row[];
  requireProof(logical.length === 1 && logical[0]!.logical_tool_call_id === intent.logicalToolCallId
    && logical[0]!.accepted_task_id === intent.acceptedTaskId && logical[0]!.tool_name === intent.toolName
    && (logical[0]!.argument_digest === intent.argumentDigest || logical[0]!.raw_argument_digest === intent.argumentDigest)
    && logical[0]!.state === 'settled' && logical[0]!.outcome_kind === 'succeeded'
    && String(intentEvent!.created_at) <= String(logical[0]!.opened_at), 'exact call did not settle successfully');
  const settlement = db.prepare('SELECT s.*,l.accepted_task_id FROM logical_call_settlements s JOIN logical_tool_calls l USING(session_id,source_user_seq,logical_tool_call_id) WHERE s.session_id=? AND s.source_user_seq=? AND s.logical_tool_call_id=?')
    .get(input.sessionId, input.sourceUserSeq, intent.logicalToolCallId) as Row | undefined;
  requireProof(settlement?.outcome_kind === 'succeeded' && settlement.accepted_task_id === intent.acceptedTaskId
    && settlement.settlement_event_id === logical[0]!.settlement_event_id && settlement.requires_reconciliation === 0
    && settlement.continues_requirement === 0 && settlement.result_handle_id
    && Number(settlement.physical_crossing_count) + Number(settlement.host_crossing_count ?? 0) === 1,
    'successful single-dispatch settlement is missing');
  // Same canonical settlement projection as logical-call-settlement-store.
  // Recompute it here rather than importing that admission/dispatch graph into
  // the synchronous eventlog validator or trusting a stored digest by itself.
  const semantic = settlementSemanticDigest({
    toolName: String(logical[0]!.tool_name), argumentDigest: String(logical[0]!.argument_digest),
    executionKind: settlement!.execution_kind as LogicalCallExecutionKind,
    resultHandleId: String(settlement!.result_handle_id),
    outcome: { kind: settlement!.outcome_kind, evidence: settlement!.outcome_evidence,
      ...(settlement!.provider_status != null ? { providerStatus: settlement!.provider_status } : {}),
      ...(settlement!.outcome_detail != null ? { detail: settlement!.outcome_detail } : {}),
      directive: { action: settlement!.recovery_action, retrySameCandidate: settlement!.retry_same_candidate === 1,
        eliminatesCandidate: settlement!.eliminates_candidate === 1, opensDiscoveryEpoch: settlement!.discovery_epoch_requested === 1,
        requiresReconciliation: settlement!.requires_reconciliation === 1 } } as CommitLogicalCallSettlementInput['outcome'],
    recovery: { businessCall: settlement!.business_call === 1, mutating: settlement!.mutating === 1,
      ...(settlement!.requirement_id != null ? { requirementId: String(settlement!.requirement_id) } : {}),
      continuesRequirement: settlement!.continues_requirement === 1,
      ...(settlement!.governor_evidence_kind ? { governorEvidence: { kind: settlement!.governor_evidence_kind,
        detail: settlement!.governor_evidence_detail, onlyIfProgressClaimed: settlement!.governor_requires_progress === 1 } } : {}),
    } as CommitLogicalCallSettlementInput['recovery'],
    ...(settlement!.progress_key_digest != null ? { progressDigest: String(settlement!.progress_key_digest) } : {}),
  });
  requireProof(semantic === settlement!.semantic_digest && settlement!.protocol_version === 1
    && settlement!.crossing_authority_version === 2, 'settlement semantic digest changed');
  const crossings = db.prepare('SELECT * FROM physical_dispatches WHERE session_id=? AND source_user_seq=?')
    .all(input.sessionId, input.sourceUserSeq) as Row[];
  const crossing = crossings[0];
  requireProof(crossings.length === 1 && crossing?.logical_tool_call_id === intent.logicalToolCallId
    && crossing.accepted_task_id === intent.acceptedTaskId && crossing.state === 'returned'
    && crossing.argument_digest === intent.argumentDigest && crossing.settle_event_id, 'crossing is missing, multiple or uncertain');
  const frozen = db.prepare(`SELECT * FROM logical_call_settlement_crossings WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=? ORDER BY ordinal`)
    .all(input.sessionId,input.sourceUserSeq,intent.logicalToolCallId) as Row[];
  const projection = (r: Row, frozenRow = false): SettlementCrossingAuthorityEntry => ({
    physicalDispatchId: String(r.physical_dispatch_id), ordinal: Number(r.ordinal),
    relation: r.relation as SettlementCrossingAuthorityEntry['relation'],
    ...(r.retry_of ? { retryOf: String(r.retry_of) } : {}), toolName: String(r.tool_name), argumentDigest: String(r.argument_digest),
    terminalState: (frozenRow ? r.terminal_state : r.state) as SettlementCrossingAuthorityEntry['terminalState'],
    ...(r.execution_site === 'host' ? { executionSite: 'host' as const } : {}),
  });
  requireProof(frozen.length === 1 && settlementCrossingAuthorityDigest(frozen.map(r=>projection(r,true)),2) === settlement!.physical_crossings_digest
    && settlementCrossingAuthorityDigest(crossings.map(r=>projection(r)),2) === settlement!.physical_crossings_digest,
    'frozen/live crossing digest changed');
  const mirrorRow = db.prepare('SELECT * FROM events WHERE id=?').get(settlement!.settlement_event_id) as Row | undefined;
  const mirror = mirrorRow ? JSON.parse(String(mirrorRow.data_json)) as Row : null;
  requireProof(mirrorRow?.session_id === input.sessionId && mirrorRow.role === 'system' && mirrorRow.type === 'tool_attempt_settled'
    && mirror?.protocolVersion === 1 && mirror.crossingAuthorityVersion === 2
    && mirror.sourceUserSeq === input.sourceUserSeq && mirror.acceptedTaskId === intent.acceptedTaskId
    && mirror.logicalToolCallId === intent.logicalToolCallId && mirror.tool === logical[0]!.tool_name
    && mirror.argumentDigest === logical[0]!.argument_digest && mirror.semanticDigest === semantic
    && mirror.executionKind === settlement!.execution_kind && mirror.kind === settlement!.outcome_kind
    && mirror.evidence === settlement!.outcome_evidence && mirror.action === settlement!.recovery_action
    && mirror.businessCall === (settlement!.business_call === 1) && mirror.mutating === (settlement!.mutating === 1)
    && (mirror.requirementId ?? null) === (settlement!.requirement_id ?? null)
    && mirror.physicalDispatchCount === settlement!.physical_crossing_count
    && mirror.physicalCrossingsDigest === settlement!.physical_crossings_digest
    && JSON.stringify(mirror.physicalDispatchIds) === JSON.stringify([crossing!.physical_dispatch_id])
    && mirror.resultHandleId === settlement!.result_handle_id && (mirror.progressKeyDigest ?? null) === (settlement!.progress_key_digest ?? null)
    && (mirror.progressClaimed ?? false) === (settlement!.progress_claimed === 1), 'settlement mirror changed');
  const lease = db.prepare('SELECT * FROM run_dispatch_leases WHERE session_id=? AND scope_id=? AND lease_id=?')
    .get(input.sessionId, crossing!.lease_scope_id, crossing!.lease_id) as Row | undefined;
  requireProof(lease?.run_attempt_id === intent.attemptId && lease.source_user_seq === input.sourceUserSeq
    && lease.accepted_task_id === intent.acceptedTaskId && lease.logical_tool_call_id === intent.logicalToolCallId,
    'retained dispatch lease is foreign');
  const raw = db.prepare(`SELECT * FROM durable_result_handles WHERE handle_id=? AND session_id=? AND source_user_seq=? AND logical_tool_call_id=? AND scope_kind='authoritative'`)
    .get(settlement!.result_handle_id, input.sessionId, input.sourceUserSeq, intent.logicalToolCallId) as Row | undefined;
  requireProof(raw?.accepted_task_id === intent.acceptedTaskId && raw.success === 1 && raw.rejection_reason === null
    && raw.tool_name === intent.toolName
    && raw.physical_dispatch_id === crossing!.physical_dispatch_id && raw.argument_digest === intent.argumentDigest,
    'retained result is missing or foreign');
  const payload = readDurableResultPayload({ rawLocation: raw!.raw_location as string | null,
    rawPayloadJson: raw!.raw_payload_json as string | null, rawPayloadSha256: raw!.raw_payload_sha256 as string | null,
    rawByteCount: Number(raw!.raw_byte_count), rejectionReason: raw!.rejection_reason as string | null });
  requireProof(payload.status === 'ok', 'retained result bytes are not intact');
  return { intent, intentId, receipt: { version: 1, scope: 'exact_approved_call', intentId, sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq, acceptedTaskId: intent.acceptedTaskId, logicalToolCallId: intent.logicalToolCallId,
    physicalDispatchId: String(crossing!.physical_dispatch_id), settlementEventId: String(settlement!.settlement_event_id),
    settlementDigest: String(settlement!.semantic_digest), resultHandleId: String(raw!.handle_id),
    rawPayloadSha256: String(raw!.raw_payload_sha256), rawByteCount: Number(raw!.raw_byte_count) } };
}

export function assertApprovedActionCompletionReceipt(db: Database.Database,
  authority: { session_id: string; source_user_seq: number; host_completion_receipt_id: string | null; host_completion_event_id: string | null },
  options: { allowStopped?: boolean; stopBefore?: string } = {}): void {
  const proved = proveApprovedActionCompletionInTransaction(db, {
    sessionId: authority.session_id, sourceUserSeq: authority.source_user_seq, ...options });
  const row = db.prepare('SELECT * FROM approved_action_completion_receipts_v1 WHERE session_id=? AND source_user_seq=?')
    .get(authority.session_id, authority.source_user_seq) as Row | undefined;
  const id = approvedActionReceiptId(proved.receipt);
  requireProof(row?.receipt_id === id && row.receipt_id === authority.host_completion_receipt_id
    && row.receipt_event_id === authority.host_completion_event_id
    && row.receipt_json === closedCanonicalJson(proved.receipt), 'receipt is not bound to this authority');
  const event = db.prepare('SELECT data_json FROM events WHERE id=? AND session_id=? AND type=?')
    .get(row!.receipt_event_id, authority.session_id, APPROVED_ACTION_RECEIPT_EVENT) as Row | undefined;
  const data = event ? JSON.parse(String(event.data_json)) as Row : null;
  requireProof(data?.receiptId === id && closedCanonicalJson(data.receipt) === closedCanonicalJson(proved.receipt), 'receipt mirror changed');
}
