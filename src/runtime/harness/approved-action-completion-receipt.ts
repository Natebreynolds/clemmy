/** Runtime adapter for a host-owned exact approval decision. This protocol
 * certifies execution/result observation only, never A's business deliverable. */
import { getPendingAction, pendingActionPayloadHash, pendingActionResumeLogicalCallId,
  verifyPendingActionResumeExecutionCapability, type PendingActionExecutionCapability } from './pending-actions.js';
import * as registry from './approval-registry.js';
import { getRunAttemptBySourceUserSeq, getUserInputEventAtSequence, insertInternalEventInTransaction,
  isKillRequested, openEventLog, publishCommittedInternalEvent, type EventRow } from './eventlog.js';
import { loadAcceptedTaskAuthority } from './accepted-task-authority.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { loadToolContract } from '../../tools/tool-contract-store.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { approvedActionIntentId, approvedActionReceiptId, approvedActionProofDigest,
  proveApprovedActionCompletionInTransaction, APPROVED_ACTION_INTENT_EVENT, APPROVED_ACTION_RECEIPT_EVENT,
  type ApprovedActionCompletionIntent } from './approved-action-completion-proof.js';

export function prepareApprovedActionCompletionIntent(input: {
  sessionId: string; capability: PendingActionExecutionCapability; effect: string;
}): 'prepared' | 'replayed' | 'ineligible' {
  const source = getUserInputEventAtSequence(input.sessionId, input.capability.sourceUserSeq);
  if (!source || source.data.synthetic !== true || source.data.source !== 'approval_resume') return 'ineligible';
  const action = getPendingAction(input.capability.pendingActionId);
  if (!action?.approvalId || action.toolName === 'run_batch' || action.approvedBy !== 'human'
    || !verifyPendingActionResumeExecutionCapability({ ...input, toolName: action.toolName, payload: action.payload })
    || !action.executionClaimTokenHash || source.data.approvalId !== action.approvalId) throw new Error('exact approval claim could not be retained');
  const card = registry.get(action.approvalId);
  const authority = loadAcceptedTaskAuthority(input.sessionId, source.seq);
  const attempt = getRunAttemptBySourceUserSeq(input.sessionId, source.seq);
  const contract = durableLogicalCallContract(`task:${input.sessionId}#${source.seq}`, action.toolName, action.payload);
  const snapshot = card?.args?.pendingAction as Record<string, unknown> | undefined;
  if (!card || card.sessionId !== input.sessionId || card.status !== 'resolved' || card.resolution !== 'approved'
    || card.args?.pendingActionId !== action.id || snapshot?.id !== action.id || snapshot.payloadHash !== action.payloadHash
    || pendingActionPayloadHash(action.toolName, action.payload, action.executionAuthority ?? null) !== action.payloadHash
    || approvedActionProofDigest(snapshot.executionAuthority ?? null) !== approvedActionProofDigest(action.executionAuthority ?? null)
    || authority.status !== 'ok' || authority.authority.state !== 'armed' || authority.authority.workContractId
    || !attempt || attempt.status !== 'active' || !contract
    || isKillRequested(input.sessionId, { attemptId: attempt.attemptId, sourceUserSeq: source.seq })) throw new Error('exact pre-dispatch decision authority changed');
  const intent: ApprovedActionCompletionIntent = {
    version: 1, scope: 'exact_approved_call', sessionId: input.sessionId, sourceUserSeq: source.seq,
    sourceEventId: source.id, turn: source.turn, acceptedTaskId: authority.authority.acceptedTaskId,
    graphEventId: authority.authority.graphEventId, graphId: authority.authority.graphId, graphHash: authority.authority.graphHash,
    originalSourceUserSeq: action.sourceUserSeq, approvalId: action.approvalId, pendingActionId: action.id,
    payloadHash: action.payloadHash, executionAuthorityDigest: approvedActionProofDigest(action.executionAuthority ?? null),
    approvalSnapshotDigest: approvedActionProofDigest(card.args), claimHash: action.executionClaimTokenHash,
    attemptId: attempt.attemptId, logicalToolCallId: pendingActionResumeLogicalCallId(input.capability),
    toolName: contract.toolName, argumentDigest: contract.argumentDigest, effect: input.effect,
    observedSchemaFingerprint: loadToolContract(action.toolName)?.fingerprint ?? null,
  };
  const intentId = approvedActionIntentId(intent);
  const db = openEventLog();
  let mirror: EventRow | undefined;
  const result = db.transaction(() => {
    if (isKillRequested(input.sessionId, { attemptId: attempt.attemptId, sourceUserSeq: source.seq })) throw new Error('decision was stopped');
    const prior = db.prepare('SELECT intent_id,intent_json FROM approved_action_completion_intents_v1 WHERE session_id=? AND source_user_seq=?')
      .get(input.sessionId, source.seq) as { intent_id: string; intent_json: string } | undefined;
    if (prior) {
      if (prior.intent_id !== intentId || prior.intent_json !== closedCanonicalJson(intent)) throw new Error('different exact-call intent already owns B');
      return 'replayed' as const;
    }
    if (db.prepare('SELECT 1 FROM logical_tool_calls WHERE session_id=? AND source_user_seq=? LIMIT 1').get(input.sessionId, source.seq)) throw new Error('intent must precede all B execution');
    mirror = insertInternalEventInTransaction(db, { sessionId: input.sessionId, turn: source.turn,
      role: 'system', type: APPROVED_ACTION_INTENT_EVENT, parentEventId: source.id, data: { sourceUserSeq: source.seq, intentId, intent } });
    db.prepare(`INSERT INTO approved_action_completion_intents_v1
      (intent_id,session_id,source_user_seq,intent_json,intent_event_id,prepared_at) VALUES(?,?,?,?,?,?)`)
      .run(intentId,input.sessionId,source.seq,closedCanonicalJson(intent),mirror.id,mirror.createdAt);
    return 'prepared' as const;
  }).immediate();
  if (mirror) publishCommittedInternalEvent(mirror);
  return result;
}

export function prepareApprovedActionHostCompletion(input: { sessionId: string; sourceUserSeq: number }):
  { status: 'ineligible' } | { status: 'redeemed'; receiptId: string }
  | { status: 'conflict' | 'storage_error'; reason: string } {
  let mirror: EventRow | undefined;
  try {
    const db = openEventLog();
    if (!db.prepare('SELECT 1 FROM approved_action_completion_intents_v1 WHERE session_id=? AND source_user_seq=?')
      .get(input.sessionId,input.sourceUserSeq)) return { status: 'ineligible' };
    const result = db.transaction(() => {
      const proof = proveApprovedActionCompletionInTransaction(db,input);
      const exactCall = { ...input, acceptedTaskId: proof.intent.acceptedTaskId, logicalToolCallId: proof.intent.logicalToolCallId };
      const settlement = redeemDurableLogicalCallSettlementForHost(exactCall);
      const retained = redeemSuccessfulSettlementResultForHost(exactCall);
      if (settlement.status !== 'ok' || retained.status !== 'ok'
        || settlement.settlement.semanticDigest !== proof.receipt.settlementDigest
        || retained.value.resultHandleId !== proof.receipt.resultHandleId
        || retained.value.rawPayloadSha256 !== proof.receipt.rawPayloadSha256) throw new Error('canonical settlement/result redemption failed');
      const action = getPendingAction(proof.intent.pendingActionId);
      if (!action || action.status !== 'executed' || action.approvedBy !== 'human' || action.sessionId !== input.sessionId
        || action.approvalId !== proof.intent.approvalId || action.payloadHash !== proof.intent.payloadHash
        || action.executionClaimTokenHash !== proof.intent.claimHash
        || approvedActionProofDigest(action.executionAuthority ?? null) !== proof.intent.executionAuthorityDigest
        || pendingActionPayloadHash(action.toolName,action.payload,action.executionAuthority ?? null) !== proof.intent.payloadHash) throw new Error('executed record lost its exact claim');
      const receiptId = approvedActionReceiptId(proof.receipt);
      const prior = db.prepare('SELECT * FROM approved_action_completion_receipts_v1 WHERE session_id=? AND source_user_seq=?')
        .get(input.sessionId,input.sourceUserSeq) as { receipt_id: string; receipt_json: string; receipt_event_id: string } | undefined;
      let eventId: string;
      if (prior) {
        if (prior.receipt_id !== receiptId || prior.receipt_json !== closedCanonicalJson(proof.receipt)) throw new Error('different completion already owns B');
        eventId = prior.receipt_event_id;
      } else {
        mirror = insertInternalEventInTransaction(db,{sessionId:input.sessionId,turn:proof.intent.turn,role:'system',type:APPROVED_ACTION_RECEIPT_EVENT,
          data:{sourceUserSeq:input.sourceUserSeq,receiptId,receipt:proof.receipt}});
        eventId = mirror.id;
        db.prepare(`INSERT INTO approved_action_completion_receipts_v1
          (receipt_id,session_id,source_user_seq,intent_id,receipt_json,receipt_event_id,issued_at) VALUES(?,?,?,?,?,?,?)`)
          .run(receiptId,input.sessionId,input.sourceUserSeq,proof.intentId,closedCanonicalJson(proof.receipt),eventId,mirror.createdAt);
      }
      const authority = db.prepare('SELECT state,host_completion_receipt_id,host_completion_event_id FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?')
        .get(input.sessionId,input.sourceUserSeq) as {state:string;host_completion_receipt_id:string|null;host_completion_event_id:string|null};
      if (authority.state === 'armed') {
        const changed = db.prepare(`UPDATE accepted_task_authority SET state='manifested_verifying',manifest_id=?,
          host_completion_receipt_id=?,host_completion_event_id=?,backstop_event_id=?,revision=revision+1,updated_at=?
          WHERE session_id=? AND source_user_seq=? AND state='armed' AND work_contract_id IS NULL
            AND host_completion_receipt_id IS NULL AND terminal_event_id IS NULL`)
          .run(receiptId,receiptId,eventId,eventId,new Date().toISOString(),input.sessionId,input.sourceUserSeq);
        if (changed.changes!==1) throw new Error('exact completion authority CAS lost');
      } else if (!['manifested_verifying','terminal'].includes(authority.state)
        || authority.host_completion_receipt_id!==receiptId || authority.host_completion_event_id!==eventId) throw new Error('completion authority conflicts');
      return {status:'redeemed' as const,receiptId};
    }).immediate();
    if(mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch(error) {return {status:'conflict',reason:error instanceof Error ? error.message : 'approved action proof unavailable'};}
}
