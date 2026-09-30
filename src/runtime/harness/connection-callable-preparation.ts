/** Sign-in does not restore a reviewed operation. Before resuming its model,
 * reobserve the exact provider definition and the server-selected account.
 * This prepares metadata only; ordinary per-call authority and consent remain. */
import { revalidateSelectedComposioDefinitions } from '../../integrations/composio/selected-definition-revalidation.js';
import { acceptedPlanExecution } from './accepted-plan-execution.js';
import { readConnectionExecutionActivation } from './connection-execution-activation-proof.js';
import { connectionDependencyIdentity } from './connection-execution-pause-proof.js';
import { readConnectionContinuationAccount } from './connection-setup.js';
import { appendEvent, openEventLog, withEventPublicationTransaction } from './eventlog.js';
import { currentReviewedProviderIdentity, reviewedProviderIdentityMismatch } from './reviewed-provider-identity.js';
import { ConnectionPreparationHoldError } from './connection-preparation-hold.js';

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

export async function prepareConnectionExecutionCapability(input: {
  sessionId: string; requestId: string; assertOwned: () => void;
}): Promise<void> {
  input.assertOwned();
  const db = openEventLog();
  const marker = readConnectionExecutionActivation(db, input);
  const dependency = connectionDependencyIdentity(db, input);
  if (!marker || !dependency || dependency.source_user_seq !== marker.activation.executionSourceUserSeq
    || dependency.subject_provider !== 'authorized_composio' || typeof dependency.subject_capability_ref !== 'string') {
    throw new Error('The connection has no exact retained operation to verify.');
  }
  const { activation } = marker;
  const execution = acceptedPlanExecution(input.sessionId, activation.executionSourceUserSeq);
  const bindings = execution?.artifact.structuredPlan?.preparedBindings;
  const binding = Array.isArray(bindings) ? bindings.find(row => object(row)
    && row.capabilityRef === dependency.subject_capability_ref) : undefined;
  if (!object(binding) || !object(binding.identity) || binding.identity.providerKind !== 'composio'
    || binding.identity.operationId !== dependency.subject_capability) {
    throw new ConnectionPreparationHoldError('operation_outside_reviewed_plan');
  }
  const reviewed = binding.identity;
  const account = readConnectionContinuationAccount({ sessionId: input.sessionId, connectionRequestId: input.requestId },
    activation.verificationBinding);
  if (reviewed.account !== account) throw new ConnectionPreparationHoldError('reviewed_account_changed');
  const current = currentReviewedProviderIdentity(dependency.subject_capability_ref);
  if (!current.ok || reviewedProviderIdentityMismatch(current, reviewed)) {
    throw new ConnectionPreparationHoldError('reviewed_operation_changed');
  }
  const manifest = current.entry.manifest;
  if (!manifest?.definitionFingerprint || !manifest.operationVersion || !manifest.externalDefinition?.providerOutputSchemaObserved) {
    throw new ConnectionPreparationHoldError('reviewed_definition_incomplete');
  }
  // A cached callable row is not enough after reconnect. This existing exact
  // provider path forces an account snapshot and schema refresh, without a
  // model discovery turn or a business operation.
  const result = await revalidateSelectedComposioDefinitions([{
    identifier: current.canonical.operationId,
    accountIdentity: account,
    schemaDigest: current.canonical.providerInputSchemaDigest,
    definitionFingerprint: manifest.definitionFingerprint,
    providerOperationVersion: manifest.operationVersion,
    outputSchemaDigest: manifest.externalDefinition.providerOutputSchemaDigest ?? null,
    invokePortId: current.canonical.invokePortId,
    verificationContract: manifest.externalDefinition.verification ?? null,
    operationSemantics: manifest.operationSemantics ?? null,
  }]);
  input.assertOwned();
  if (!result.ok) throw new ConnectionPreparationHoldError(result.refusal.code);
  const fresh = result.definitions.get(current.canonical.operationId.toLowerCase());
  // A provider version-label successor is useful to fresh planning, but it
  // cannot silently replace the exact identity of this reviewed execution.
  if (!fresh || fresh.definitionFingerprint !== manifest.definitionFingerprint
    || fresh.providerOperationVersion !== manifest.operationVersion || fresh.accountIdentity !== account) {
    throw new ConnectionPreparationHoldError('reviewed_operation_changed');
  }
  withEventPublicationTransaction(() => {
    input.assertOwned();
    const now = currentReviewedProviderIdentity(dependency.subject_capability_ref as string);
    if (!now.ok || reviewedProviderIdentityMismatch(now, reviewed)) {
      throw new ConnectionPreparationHoldError('reviewed_operation_changed');
    }
    const status = db.prepare(`SELECT status FROM dependency_requests WHERE request_id = ? AND session_id = ?`)
      .get(input.requestId, input.sessionId) as { status: string } | undefined;
    if (status?.status === 'satisfied') return; // freshly checked again; no duplicate notification
    if (status?.status !== 'open') throw new Error('The connection request is no longer open.');
    db.prepare(`UPDATE dependency_requests SET status = 'satisfied', satisfied_at = ?
      WHERE request_id = ? AND session_id = ? AND status = 'open'`)
      .run(new Date().toISOString(), input.requestId, input.sessionId);
    appendEvent({ sessionId: input.sessionId, turn: 0, role: 'system', type: 'connection_request_satisfied',
      parentEventId: marker.eventId, data: { kind: 'reviewed_execution_callable', requestId: input.requestId,
        sourceUserSeq: activation.executionSourceUserSeq, deliverySourceUserSeq: activation.deliverySourceUserSeq,
        capabilityRef: dependency.subject_capability_ref, plan: execution!.claim.ref,
        accountId: account, definitionFingerprint: fresh.definitionFingerprint,
        providerOperationVersion: fresh.providerOperationVersion, verificationBinding: activation.verificationBinding } });
  });
}
