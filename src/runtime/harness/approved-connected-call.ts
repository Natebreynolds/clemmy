import { approvedComposioPreparationProjection } from './approved-composio-preparation-projection.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { claimApprovedComposioPhysicalIo } from './physical-io-claim.js';
/** Exact approved SDK bridge. Process handles are only references: every edge
 * reopens the immutable decision and its current claim/attempt/generation. */
import { randomUUID } from 'node:crypto';
import { openEventLog, insertInternalEventInTransaction, publishCommittedInternalEvent, withEventPublicationTransaction } from './eventlog.js';
import { harnessRunContextStorage } from './brackets.js';
import { currentDispatchLease, assertDispatchLeaseCurrent } from './dispatch-lease.js';
import { getPendingAction, verifyPendingActionResumeExecutionCapability } from './pending-actions.js';
import { approvedActionIntentId, type ApprovedActionCompletionIntent } from './approved-action-completion-proof.js';
import { assertCurrentApprovedComposioOwnerInTransaction, approvedActionProviderBindingId,
  APPROVED_ACTION_PROVIDER_BINDING_EVENT, type ApprovedActionProviderBinding } from './approved-action-provider-binding-proof.js';
import { currentApprovedComposioPreparation, registerApprovedComposioPreparation, registerApprovedComposioDispatchPermit,
  inspectApprovedComposioDispatchPermit, APPROVED_COMPOSIO_DISPATCH_PROTOCOL,
  type ApprovedComposioPreparation, type ApprovedComposioPreparationIdentity, type ApprovedComposioResolvedIdentity,
  type ApprovedComposioDispatchPermit, type ApprovedComposioPermitIdentity } from './approved-connected-call-context.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';

function currentClaim(owner: ApprovedComposioPreparationIdentity): void {
  const context = harnessRunContextStorage.getStore();
  const capability = context?.pendingActionExecution;
  const action = capability ? getPendingAction(capability.pendingActionId) : null;
  if (!context || context.sessionId !== owner.sessionId || context.sourceUserSeq !== owner.sourceUserSeq
    || context.runAttemptId !== owner.attemptId || !capability || !action
    || action.status !== 'executing' || action.approvedBy !== 'human'
    || !verifyPendingActionResumeExecutionCapability({ capability, sessionId: owner.sessionId,
      toolName: action.toolName, payload: action.payload })) throw new Error('Exact approved SDK execution claim is no longer current.');
  const intentRow = openEventLog().prepare('SELECT intent_json FROM approved_action_completion_intents_v1 WHERE intent_id=?')
    .get(owner.intentId) as {intent_json:string}|undefined;
  const intent = intentRow ? JSON.parse(intentRow.intent_json) as ApprovedActionCompletionIntent : null;
  if (!intent || action.id !== intent.pendingActionId || action.approvalId !== intent.approvalId
    || action.payloadHash !== intent.payloadHash || action.executionClaimTokenHash !== intent.claimHash
    || action.sourceUserSeq !== intent.originalSourceUserSeq || action.executionAuthority !== null)
    throw new Error('Exact approved SDK action/claim binding changed.');
  const projected=approvedComposioPreparationProjection(action.payload);
  const projectedContract=projected ? durableLogicalCallContract(owner.acceptedTaskId,projected.toolSlug,projected.args) : null;
  if (!projected || projected.connectedAccountId!==owner.connectedAccountId || projectedContract?.toolName!==owner.toolName
    || projectedContract.argumentDigest!==owner.preparationArgumentDigest)
    throw new Error('Exact approved SDK preparation projection no longer matches the claimed record.');
  assertDispatchLeaseCurrent(owner.lease);
}

export function prepareApprovedComposioCall(input: {
  sessionId:string; sourceUserSeq:number; lease: import('./dispatch-lease.js').DispatchLeaseRef;
}): ApprovedComposioPreparation | null {
  const row = openEventLog().prepare('SELECT intent_json FROM approved_action_completion_intents_v1 WHERE session_id=? AND source_user_seq=?')
    .get(input.sessionId,input.sourceUserSeq) as {intent_json:string}|undefined;
  if (!row) return null;
  const intent = JSON.parse(row.intent_json) as ApprovedActionCompletionIntent;
  if (intent.providerDispatchProtocol !== APPROVED_COMPOSIO_DISPATCH_PROTOCOL) return null;
  const action = getPendingAction(intent.pendingActionId);
  const payload = action?.payload as Record<string,unknown>|null;
  if (!payload || typeof payload.connected_account_id !== 'string') throw new Error('Exact approved SDK account is missing.');
  const projected = approvedComposioPreparationProjection(payload);
  const preparationContract = projected ? durableLogicalCallContract(intent.acceptedTaskId,projected.toolSlug,projected.args) : null;
  if (!preparationContract || preparationContract.toolName !== intent.toolName) throw new Error('Approved SDK raw selectors/carrier projection are not exact.');
  const owner: ApprovedComposioPreparationIdentity = {
    protocol: APPROVED_COMPOSIO_DISPATCH_PROTOCOL, intentId:approvedActionIntentId(intent),
    sessionId:input.sessionId,sourceUserSeq:input.sourceUserSeq,acceptedTaskId:intent.acceptedTaskId,
    logicalToolCallId:intent.logicalToolCallId,attemptId:intent.attemptId,toolName:intent.toolName,
    rawArgumentDigest:intent.argumentDigest,preparationArgumentDigest:preparationContract.argumentDigest,effect:intent.effect as 'external_write'|'admin',
    connectedAccountId:payload.connected_account_id,lease:input.lease,
  };
  currentClaim(owner);
  assertCurrentApprovedComposioOwnerInTransaction(openEventLog(),owner,false);
  return registerApprovedComposioPreparation(owner);
}

/** Gateway-only issuer: caller must first reopen its actual private SDK token.
 * Resolved values alone are not an invocation permit: the final client verifies
 * its own token and current observations again after its asynchronous edge. */
export function prepareApprovedComposioDispatch(resolved: ApprovedComposioResolvedIdentity): ApprovedComposioDispatchPermit | undefined {
  const preparation = currentApprovedComposioPreparation();
  if (!preparation) return undefined;
  currentClaim(preparation);
  const lease = currentDispatchLease();
  if (!lease || lease.sessionId !== preparation.sessionId || lease.runAttemptId !== preparation.attemptId
    || lease.sourceUserSeq !== preparation.sourceUserSeq || lease.acceptedTaskId !== preparation.acceptedTaskId
    || lease.logicalToolCallId !== preparation.logicalToolCallId
    || (lease.scopeId === preparation.lease.scopeId
      ? lease.leaseId !== preparation.lease.leaseId
      : lease.parentScopeId !== preparation.lease.scopeId || lease.parentLeaseId !== preparation.lease.leaseId)) throw new Error('Approved SDK child generation has no exact parent.');
  const owner = {...preparation,lease};
  const intent = assertCurrentApprovedComposioOwnerInTransaction(openEventLog(),owner,true);
  const logical = openEventLog().prepare('SELECT * FROM logical_tool_calls WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
    .get(owner.sessionId,owner.sourceUserSeq,owner.logicalToolCallId) as Record<string,unknown>|undefined;
  if (!logical || logical.state !== 'open' || logical.tool_name !== owner.toolName
    || logical.raw_argument_digest !== owner.rawArgumentDigest || logical.argument_digest !== resolved.effectiveArgumentDigest
    || (logical.refinement_event_id ?? null) !== resolved.refinementEventId
    || resolved.connectedAccountId !== owner.connectedAccountId
    || resolved.providerOperationId.toLowerCase() !== owner.toolName
    || ![resolved.providerArgumentDigest,resolved.providerInputSchemaDigest,
      resolved.accountIdentityDigest,resolved.providerOwnerIdentityDigest,resolved.effectiveArgumentDigest].every(x=>/^[a-f0-9]{64}$/.test(x))
    || !/^[a-f0-9]{32}$/.test(resolved.schemaFingerprint)
    || !resolved.providerOperationVersion || intent.providerDispatchProtocol !== owner.protocol)
    throw new Error('Approved SDK resolved operation/account/schema/refinement changed.');
  return registerApprovedComposioDispatchPermit(preparation,resolved,`dispatch:${randomUUID()}`,lease);
}

export function assertApprovedComposioPermitCurrent(permit: ApprovedComposioDispatchPermit): Readonly<ApprovedComposioPermitIdentity> {
  const state = inspectApprovedComposioDispatchPermit(permit);
  if (!state) throw new Error('Approved SDK physical permit is not registered.');
  currentClaim(state);
  assertCurrentApprovedComposioOwnerInTransaction(openEventLog(),state,true);
  return state;
}

/** Runs only inside the ledger's managed IMMEDIATE reservation transaction. */
export function persistApprovedComposioBindingInTransaction(permit: ApprovedComposioDispatchPermit): void {
  const state = assertApprovedComposioPermitCurrent(permit);
  const db = openEventLog();
  const intent = assertCurrentApprovedComposioOwnerInTransaction(db,state,true);
  const binding: ApprovedActionProviderBinding = {
    version:1,protocol:state.protocol,intentId:state.intentId,sessionId:state.sessionId,sourceUserSeq:state.sourceUserSeq,
    acceptedTaskId:state.acceptedTaskId,originalSourceUserSeq:intent.originalSourceUserSeq,approvalId:intent.approvalId,
    pendingActionId:intent.pendingActionId,payloadHash:intent.payloadHash,approvalSnapshotDigest:intent.approvalSnapshotDigest,
    claimHash:intent.claimHash,logicalToolCallId:state.logicalToolCallId,attemptId:state.attemptId,toolName:state.toolName,
    rawArgumentDigest:state.rawArgumentDigest,effectiveArgumentDigest:state.effectiveArgumentDigest,refinementEventId:state.refinementEventId,
    providerOperationId:state.providerOperationId,providerOperationVersion:state.providerOperationVersion,
    providerArgumentDigest:state.providerArgumentDigest,providerInputSchemaDigest:state.providerInputSchemaDigest,
    schemaFingerprint:state.schemaFingerprint,connectedAccountId:state.connectedAccountId,accountIdentityDigest:state.accountIdentityDigest,
    providerOwnerIdentityDigest:state.providerOwnerIdentityDigest,invokePortId:state.invokePortId,effect:state.effect,
    physicalDispatchId:state.physicalDispatchId,leaseScopeId:state.lease.scopeId,leaseId:state.lease.leaseId,
  };
  const bindingId = approvedActionProviderBindingId(binding);
  const mirror = insertInternalEventInTransaction(db,{sessionId:state.sessionId,turn:intent.turn,role:'system',type:APPROVED_ACTION_PROVIDER_BINDING_EVENT,
    data:{sourceUserSeq:state.sourceUserSeq,bindingId,binding:JSON.parse(closedCanonicalJson(binding)) as ApprovedActionProviderBinding}});
  db.prepare(`INSERT INTO approved_action_provider_bindings_v1
    (binding_id,intent_id,session_id,source_user_seq,logical_tool_call_id,physical_dispatch_id,binding_json,binding_event_id,prepared_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(bindingId,state.intentId,state.sessionId,state.sourceUserSeq,state.logicalToolCallId,
      state.physicalDispatchId,closedCanonicalJson(binding),mirror.id,mirror.createdAt);
  publishCommittedInternalEvent(mirror);
}

/** Terminal SDK edge, after all awaits and current observation/token checks.
 * This synchronous managed CAS consumes the nominal permit before raw I/O. */
export function claimApprovedComposioIo(permit: ApprovedComposioDispatchPermit): void {
  withEventPublicationTransaction(()=>{
    assertApprovedComposioPermitCurrent(permit);
    claimApprovedComposioPhysicalIo(permit);
  });
}
