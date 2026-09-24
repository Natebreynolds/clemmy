/** Host-owned queue admission evidence. This proves one dispatch was prepared,
 * never that its child finished or that its business effects succeeded. */
import { createHash } from 'node:crypto';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import type { WorkflowChatDispatchPreparedReceipt } from '../../execution/workflow-origin-group.js';
import type { NativeRevisionProofPorts, RevisionProofInput } from './native-revision-proof-core.js';

const PREFIX = '[clementine:host-workflow-dispatch:v1]';
export function withWorkflowDispatchCommit(message: string, receipt: WorkflowChatDispatchPreparedReceipt): string {
  return `${PREFIX}${JSON.stringify(receipt)}\n${message}`;
}

export function declaresWorkflowDispatchReceipt(name: string): boolean {
  const declarations = TOOL_REGISTRY.filter(row => row.name === name);
  return declarations.length === 1 && declarations[0]!.sideEffect === 'write'
    && declarations[0]!.delegationPrimitive === true
    && declarations[0]!.localPlanning?.outputKind === 'workflow_run';
}

export function proveWorkflowDispatchCommitWithPorts(input: RevisionProofInput, ports: NativeRevisionProofPorts):
  { status: 'verified'; runId: string; receiptDigest: string; preparationDigest: string }
  | { status: 'unverified'; reason: string } {
  const refuse = (reason: string) => ({ status: 'unverified' as const, reason });
  try {
    const contract = ports.loadContract(input);
    if (!contract || contract.contractId !== input.contractId || contract.acceptedTaskId !== input.acceptedTaskId
      || contract.identity.sessionId !== input.sessionId || contract.identity.sourceUserSeq !== input.sourceUserSeq
      || contract.operations.find(row => row.id === input.requirementId)?.effect !== 'local_write') {
      return refuse('dispatch has no exact accepted requirement');
    }
    const selected = ports.loadSelection(input);
    if (!selected || selected.effect !== 'local_write' || !declaresWorkflowDispatchReceipt(selected.logicalToolName)) {
      return refuse('selected capability does not declare a host workflow dispatch');
    }
    const row = ports.db.prepare(`SELECT b.tool_name, b.argument_digest, s.settled_at
      FROM expected_work_call_bindings b JOIN logical_call_settlements s USING(session_id,source_user_seq,logical_tool_call_id)
      WHERE b.session_id=? AND b.source_user_seq=? AND b.accepted_task_id=? AND b.contract_id=?
        AND b.requirement_id=? AND b.logical_tool_call_id=? AND b.effect_kind='local_write'
        AND s.outcome_kind='succeeded' AND s.mutating=1 AND s.continues_requirement=0 AND s.requires_reconciliation=0`)
      .get(input.sessionId,input.sourceUserSeq,input.acceptedTaskId,input.contractId,input.requirementId,input.logicalToolCallId) as
      { tool_name: string; argument_digest: string; settled_at: string } | undefined;
    const host = loadHostCallCapabilityBinding({ db: ports.db, ...input });
    if (!row || row.tool_name !== selected.logicalToolName || host.status !== 'ok'
      || host.binding.acceptedTaskId !== input.acceptedTaskId || host.binding.effect !== 'local_write'
      || host.binding.bindingKind !== 'local_envelope' || host.binding.toolName !== row.tool_name
      || host.binding.effectiveArgumentDigest !== row.argument_digest) return refuse('dispatch lacks exact host settlement authority');
    const redeemed = ports.redeem(input);
    if (redeemed.status !== 'ok' || redeemed.value.executionSite !== 'host'
      || redeemed.value.toolName !== row.tool_name || redeemed.value.outcomeKind !== 'succeeded') {
      return refuse('dispatch result has no successful host provenance');
    }
    const raw = redeemed.value.rawPayload;
    if (typeof raw !== 'string' || !raw.startsWith(PREFIX)) return refuse('dispatch receipt is absent');
    const end = raw.indexOf('\n');
    const receipt = JSON.parse(raw.slice(PREFIX.length, end < 0 ? undefined : end)) as WorkflowChatDispatchPreparedReceipt;
    if (receipt.version !== 1 || receipt.receiptVersion !== 1 || receipt.originSessionId !== input.sessionId
      || receipt.sourceUserSeq !== input.sourceUserSeq || !/^[\w.:-]+$/.test(receipt.runId)
      || !/^[a-f0-9]{64}$/.test(receipt.preparationDigest) || !/^[a-f0-9]{64}$/.test(receipt.queueRequestDigest)
      || !Number.isSafeInteger(receipt.preparedEventSeq) || receipt.preparedEventSeq <= input.sourceUserSeq) {
      return refuse('dispatch receipt does not belong to this source');
    }
    const mirror = ports.db.prepare(`SELECT e.id,e.seq,e.created_at,e.data_json,e.parent_event_id,s.id AS source_id
      FROM events e JOIN events s ON s.session_id=e.session_id AND s.seq=? AND s.type='user_input_received' AND s.role='user'
      WHERE e.session_id=? AND e.id=? AND e.seq=? AND e.type='async_work_dispatch_prepared' AND e.role='system'`)
      .get(input.sourceUserSeq,input.sessionId,receipt.preparedEventId,receipt.preparedEventSeq) as
      { id: string; seq: number; created_at: string; data_json: string; parent_event_id: string; source_id: string } | undefined;
    if (!mirror || mirror.parent_event_id !== mirror.source_id || mirror.created_at !== receipt.preparedAt
      || mirror.created_at > row.settled_at) return refuse('dispatch preparation mirror is not exact');
    const { receiptVersion: _version, preparedEventId: _id, preparedEventSeq: _seq, preparedAt: _at, receiptDigest, ...authority } = receipt;
    if (closedCanonicalJson(authority) !== closedCanonicalJson(JSON.parse(mirror.data_json))) {
      return refuse('dispatch receipt differs from the persisted queue preparation');
    }
    // Same receipt address as the queue protocol; the persisted preparation,
    // not these model-visible bytes, remains the authority above.
    const hash = createHash('sha256');
    for (const part of ['clementine-workflow-chat-dispatch-prepared-receipt:v1', receipt.preparationDigest,
      mirror.id, mirror.seq, mirror.created_at]) hash.update(String(part)).update('\0');
    if (hash.digest('hex') !== receiptDigest) return refuse('dispatch receipt digest disagrees');
    return { status: 'verified', runId: receipt.runId, receiptDigest, preparationDigest: receipt.preparationDigest };
  } catch { return refuse('dispatch proof is unavailable or malformed'); }
}
