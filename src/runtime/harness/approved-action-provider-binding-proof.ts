/** SQL/hash-only proof for an exact approved SDK business crossing. No runtime
 * eventlog, admission, executor, tools or SDK imports belong in this leaf. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import type { ApprovedActionCompletionIntent } from './approved-action-completion-proof.js';

export const APPROVED_ACTION_PROVIDER_BINDING_EVENT = 'approved_action_provider_bound' as const;
export const APPROVED_COMPOSIO_PROVIDER_PROTOCOL = 'approved_composio_sdk_v1' as const;
export interface ApprovedActionProviderBinding {
  version: 1;
  protocol: typeof APPROVED_COMPOSIO_PROVIDER_PROTOCOL;
  intentId: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  originalSourceUserSeq: number | null;
  approvalId: string;
  pendingActionId: string;
  payloadHash: string;
  approvalSnapshotDigest: string;
  claimHash: string;
  logicalToolCallId: string;
  attemptId: string;
  toolName: string;
  rawArgumentDigest: string;
  effectiveArgumentDigest: string;
  refinementEventId: string | null;
  providerOperationId: string;
  providerOperationVersion: string;
  providerArgumentDigest: string;
  providerInputSchemaDigest: string;
  schemaFingerprint: string;
  connectedAccountId: string;
  accountIdentityDigest: string;
  providerOwnerIdentityDigest: string;
  invokePortId: 'composio_sdk_v3_execute';
  effect: 'external_write' | 'admin';
  physicalDispatchId: string;
  leaseScopeId: string;
  leaseId: string;
}
export const approvedActionProviderBindingDigest = (body: ApprovedActionProviderBinding): string =>
  createHash('sha256').update(closedCanonicalJson(body)).digest('hex');
export const approvedActionProviderBindingId = (body: ApprovedActionProviderBinding): string =>
  `approved-composio-binding:v1:${approvedActionProviderBindingDigest(body)}`;
export const approvedActionProviderIoOwner = (bindingId: string): string => `approved-composio-sdk:${bindingId}`;
const requireBinding = (value: unknown, reason: string): void => {
  if (!value) throw new Error(`approved SDK binding: ${reason}`);
};
type Row = Record<string, unknown>;
const DIGEST = /^[a-f0-9]{64}$/;

/** Reopen historical immutable evidence, never current account configuration.
 * A successful returned call retains its exact generation even after finally
 * revokes that lease. Fresh I/O authorization is owned by the runtime issuer. */
export function proveApprovedActionProviderBindingInTransaction(
  db: Database.Database,
  intent: ApprovedActionCompletionIntent,
  intentId: string,
): { providerBindingId: string; providerBindingDigest: string; binding: ApprovedActionProviderBinding } {
  const rows = db.prepare('SELECT * FROM approved_action_provider_bindings_v1 WHERE intent_id=? LIMIT 2')
    .all(intentId) as Row[];
  requireBinding(rows.length === 1, 'one exact provider binding is required');
  const row = rows[0]!;
  const binding = JSON.parse(String(row.binding_json)) as ApprovedActionProviderBinding;
  const digest = approvedActionProviderBindingDigest(binding);
  const id = approvedActionProviderBindingId(binding);
  requireBinding(row.binding_id === id && row.binding_json === closedCanonicalJson(binding)
    && binding.version === 1 && binding.protocol === APPROVED_COMPOSIO_PROVIDER_PROTOCOL
    && binding.intentId === intentId && row.intent_id === intentId
    && binding.sessionId === intent.sessionId && row.session_id === intent.sessionId
    && binding.sourceUserSeq === intent.sourceUserSeq && row.source_user_seq === intent.sourceUserSeq
    && binding.acceptedTaskId === intent.acceptedTaskId
    && binding.originalSourceUserSeq === intent.originalSourceUserSeq
    && binding.approvalId === intent.approvalId && binding.pendingActionId === intent.pendingActionId
    && binding.payloadHash === intent.payloadHash && binding.approvalSnapshotDigest === intent.approvalSnapshotDigest
    && binding.claimHash === intent.claimHash && binding.logicalToolCallId === intent.logicalToolCallId
    && row.logical_tool_call_id === intent.logicalToolCallId && binding.attemptId === intent.attemptId
    && binding.toolName === intent.toolName && binding.rawArgumentDigest === intent.argumentDigest
    && binding.effect === intent.effect && (binding.effect === 'external_write' || binding.effect === 'admin')
    && binding.invokePortId === 'composio_sdk_v3_execute', 'immutable owner/intent binding changed');
  requireBinding([binding.providerArgumentDigest, binding.providerInputSchemaDigest,
    binding.accountIdentityDigest, binding.providerOwnerIdentityDigest, binding.effectiveArgumentDigest]
    .every(value => typeof value === 'string' && DIGEST.test(value))
    && /^[a-f0-9]{32}$/.test(binding.schemaFingerprint), 'resolved definition/account identity is not sealed');
  requireBinding(typeof binding.providerOperationVersion === 'string' && binding.providerOperationVersion.length > 0
    && binding.providerOperationVersion.length <= 160 && typeof binding.connectedAccountId === 'string'
    && binding.connectedAccountId.length > 0, 'exact SDK version/account is missing');
  const card = db.prepare('SELECT args_json FROM pending_approvals WHERE approval_id=? AND session_id=?')
    .get(intent.approvalId, intent.sessionId) as Row | undefined;
  const args = card ? JSON.parse(String(card.args_json)) as Row : null;
  const snapshot = args?.pendingAction as Row | undefined;
  const payload = snapshot?.payload as Row | undefined;
  requireBinding(snapshot?.toolName === 'composio_execute_tool' && snapshot.executionAuthority === null
    && payload?.tool_slug === binding.providerOperationId
    && payload?.connected_account_id === binding.connectedAccountId,
    'provider operation/account is not the exact approved SDK route');
  const logical = db.prepare('SELECT * FROM logical_tool_calls WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
    .get(intent.sessionId, intent.sourceUserSeq, intent.logicalToolCallId) as Row | undefined;
  requireBinding(logical?.accepted_task_id === intent.acceptedTaskId && logical.tool_name === intent.toolName
    && logical.raw_argument_digest === intent.argumentDigest && logical.argument_digest === binding.effectiveArgumentDigest
    && (logical.refinement_event_id ?? null) === binding.refinementEventId, 'provider refinement lineage changed');
  const crossing = db.prepare('SELECT * FROM physical_dispatches WHERE session_id=? AND source_user_seq=? AND physical_dispatch_id=?')
    .get(intent.sessionId, intent.sourceUserSeq, binding.physicalDispatchId) as Row | undefined;
  requireBinding(crossing && row.physical_dispatch_id === binding.physicalDispatchId
    && crossing.logical_tool_call_id === intent.logicalToolCallId && crossing.accepted_task_id === intent.acceptedTaskId
    && crossing.tool_name === intent.toolName && crossing.argument_digest === binding.effectiveArgumentDigest
    && crossing.provider_argument_digest === binding.providerArgumentDigest
    && crossing.ordinal === 1 && crossing.relation === 'primary' && crossing.retry_of === null
    && crossing.state === 'returned' && crossing.execution_site === null
    && crossing.lease_scope_id === binding.leaseScopeId && crossing.lease_id === binding.leaseId,
    'one exact returned SDK business crossing is missing');
  requireBinding(typeof crossing!.io_claimed_at === 'string' && String(crossing!.io_claimed_at).length > 0
    && crossing!.io_owner === approvedActionProviderIoOwner(id)
    && crossing!.io_fence === 1 && crossing!.io_revision === 1,
    'exact approved SDK I/O was never claimed');
  const lease = db.prepare('SELECT * FROM run_dispatch_leases WHERE session_id=? AND scope_id=? AND lease_id=?')
    .get(intent.sessionId, binding.leaseScopeId, binding.leaseId) as Row | undefined;
  requireBinding(lease?.run_attempt_id === intent.attemptId && lease.source_user_seq === intent.sourceUserSeq
    && lease.accepted_task_id === intent.acceptedTaskId && lease.logical_tool_call_id === intent.logicalToolCallId,
    'retained SDK I/O lease generation is foreign');
  const event = db.prepare('SELECT * FROM events WHERE session_id=? AND id=?')
    .get(intent.sessionId, row.binding_event_id) as Row | undefined;
  const data = event ? JSON.parse(String(event.data_json)) as Row : null;
  requireBinding(event?.type === APPROVED_ACTION_PROVIDER_BINDING_EVENT && event.role === 'system'
    && event.turn === intent.turn && event.created_at === row.prepared_at
    && data?.sourceUserSeq === intent.sourceUserSeq && data.bindingId === id
    && closedCanonicalJson(data.binding) === closedCanonicalJson(binding)
    && String(crossing!.io_claimed_at) >= String(row.prepared_at), 'provider binding/claim mirror changed');
  return { providerBindingId: id, providerBindingDigest: digest, binding };
}

/** Fresh scheduling proof. It never admits I/O: nominal SDK state and the
 * physical reservation/claim are checked separately at the terminal edge. */
export function assertCurrentApprovedComposioOwnerInTransaction(
  db: Database.Database,
  owner: import('./approved-connected-call-context.js').ApprovedComposioPreparationIdentity,
  requireBoundLease: boolean,
): ApprovedActionCompletionIntent {
  const row = db.prepare('SELECT * FROM approved_action_completion_intents_v1 WHERE intent_id=? AND session_id=? AND source_user_seq=?')
    .get(owner.intentId, owner.sessionId, owner.sourceUserSeq) as Row | undefined;
  const intent = row ? JSON.parse(String(row.intent_json)) as ApprovedActionCompletionIntent : null;
  requireBinding(intent && row!.intent_json === closedCanonicalJson(intent)
    && `approved-action-intent:v1:${createHash('sha256').update(closedCanonicalJson(intent)).digest('hex')}` === owner.intentId
    && intent.providerDispatchProtocol === APPROVED_COMPOSIO_PROVIDER_PROTOCOL
    && intent.sessionId === owner.sessionId && intent.sourceUserSeq === owner.sourceUserSeq
    && intent.acceptedTaskId === owner.acceptedTaskId && intent.logicalToolCallId === owner.logicalToolCallId
    && intent.attemptId === owner.attemptId && intent.toolName === owner.toolName
    && intent.argumentDigest === owner.rawArgumentDigest && intent.effect === owner.effect,
    'current intent is not this exact SDK preparation');
  const intentMirror = db.prepare('SELECT * FROM events WHERE id=? AND session_id=? AND type=?')
    .get(row!.intent_event_id,owner.sessionId,'approved_action_completion_intent') as Row|undefined;
  const mirrorData = intentMirror ? JSON.parse(String(intentMirror.data_json)) as Row : null;
  requireBinding(intentMirror?.role === 'system' && intentMirror.turn === intent!.turn
    && Number(intentMirror.seq) > owner.sourceUserSeq && mirrorData?.sourceUserSeq === owner.sourceUserSeq
    && mirrorData.intentId === owner.intentId && closedCanonicalJson(mirrorData.intent) === closedCanonicalJson(intent),
    'pre-dispatch intent event mirror changed');
  const a = db.prepare('SELECT role,type,data_json FROM events WHERE session_id=? AND seq=?')
    .get(owner.sessionId, intent!.originalSourceUserSeq) as Row | undefined;
  const ad = a ? JSON.parse(String(a.data_json)) as Row : null;
  requireBinding(Number.isSafeInteger(intent!.originalSourceUserSeq) && Number(intent!.originalSourceUserSeq) > 0
    && Number(intent!.originalSourceUserSeq) < owner.sourceUserSeq && a?.role === 'user'
    && a.type === 'user_input_received' && ad?.synthetic !== true, 'original accepted source is not a real earlier owner');
  const source = db.prepare('SELECT * FROM events WHERE session_id=? AND seq=?').get(owner.sessionId,owner.sourceUserSeq) as Row | undefined;
  const data = source ? JSON.parse(String(source.data_json)) as Row : null;
  requireBinding(source?.id === intent!.sourceEventId && source.role === 'user' && source.type === 'user_input_received'
    && data?.synthetic === true && data.source === 'approval_resume' && data.approvalId === intent!.approvalId
    && data.decision === 'approve', 'current decision source changed');
  const card = db.prepare('SELECT * FROM pending_approvals WHERE approval_id=? AND session_id=?').get(intent!.approvalId,owner.sessionId) as Row | undefined;
  const args = card ? JSON.parse(String(card.args_json)) as Row : null;
  const snapshot = args?.pendingAction as Row | undefined;
  const payload = snapshot?.payload as Row | undefined;
  requireBinding(card?.status === 'resolved' && card.resolution === 'approved' && card.tool === 'request_approval'
    && createHash('sha256').update(closedCanonicalJson(args)).digest('hex') === intent!.approvalSnapshotDigest
    && args?.pendingActionId === intent!.pendingActionId && snapshot?.id === intent!.pendingActionId
    && snapshot.payloadHash === intent!.payloadHash && snapshot.toolName === 'composio_execute_tool'
    && snapshot.executionAuthority === null && payload?.connected_account_id === owner.connectedAccountId,
    'current approved account/card changed');
  const authority = db.prepare('SELECT * FROM accepted_task_authority WHERE session_id=? AND source_user_seq=?').get(owner.sessionId,owner.sourceUserSeq) as Row | undefined;
  requireBinding(authority?.accepted_task_id === owner.acceptedTaskId && authority.state === 'armed'
    && authority.expected_work_required === 1 && authority.work_contract_id === null && authority.terminal_event_id === null
    && authority.graph_event_id === intent!.graphEventId && authority.graph_hash === intent!.graphHash,
    'exact B authority is not open');
  const root = db.prepare('SELECT * FROM accepted_turn_call_authorities WHERE session_id=? AND source_user_seq=?')
    .get(owner.sessionId,owner.sourceUserSeq) as Row|undefined;
  const resolution = db.prepare('SELECT state FROM accepted_task_resolutions WHERE session_id=? AND source_user_seq=?')
    .get(owner.sessionId,owner.sourceUserSeq) as Row|undefined;
  requireBinding(root?.authority_kind === 'turn_graph' && root.state === 'open' && root.accepted_task_id === owner.acceptedTaskId
    && root.source_event_id === intent!.sourceEventId && root.source_turn === intent!.turn
    && root.graph_event_id === intent!.graphEventId && root.graph_hash === intent!.graphHash && resolution?.state === 'open',
    'exact B call root or resolution is no longer open');
  const attempt = db.prepare('SELECT * FROM run_attempts WHERE attempt_id=? AND session_id=? AND source_user_seq=?')
    .get(owner.attemptId,owner.sessionId,owner.sourceUserSeq) as Row | undefined;
  requireBinding(attempt?.status === 'active' && attempt.finished_at === null, 'exact B attempt is no longer live');
  const killed = db.prepare(`SELECT 1 FROM run_kill_requests k WHERE k.session_id=? AND
    (k.scope_key='session:*' OR k.attempt_id IN (SELECT attempt_id FROM run_attempts WHERE session_id=? AND source_user_seq=?)
    OR (k.attempt_id IS NULL AND k.run_id IN (SELECT run_id FROM run_attempts WHERE session_id=? AND source_user_seq=? AND run_id IS NOT NULL))) LIMIT 1`)
    .get(owner.sessionId,owner.sessionId,owner.sourceUserSeq,owner.sessionId,owner.sourceUserSeq);
  const originalStopped = db.prepare(`SELECT 1 FROM run_kill_requests k WHERE k.session_id=? AND
    (k.attempt_id IN (SELECT attempt_id FROM run_attempts WHERE session_id=? AND source_user_seq=?)
    OR (k.attempt_id IS NULL AND k.run_id IN (SELECT run_id FROM run_attempts WHERE session_id=? AND source_user_seq=? AND run_id IS NOT NULL))) LIMIT 1`)
    .get(owner.sessionId,owner.sessionId,intent!.originalSourceUserSeq,owner.sessionId,intent!.originalSourceUserSeq);
  requireBinding(!originalStopped && !db.prepare("SELECT 1 FROM run_attempts WHERE session_id=? AND source_user_seq=? AND status='cancelled'")
    .get(owner.sessionId,intent!.originalSourceUserSeq), 'original accepted objective was stopped');
  requireBinding(!killed && !db.prepare('SELECT 1 FROM kill_switches WHERE session_id=?').get(owner.sessionId)
    && !db.prepare("SELECT 1 FROM run_attempts WHERE session_id=? AND source_user_seq=? AND status='cancelled'").get(owner.sessionId,owner.sourceUserSeq), 'decision was stopped');
  // Walk the exact retained generation and every parent; no uptime heuristics.
  let scope = owner.lease.scopeId, leaseId = owner.lease.leaseId;
  const seen = new Set<string>();
  for (let depth=0; ;depth++) {
    requireBinding(depth < 32 && !seen.has(`${scope}\0${leaseId}`),'lease lineage is cyclic or unbounded');
    seen.add(`${scope}\0${leaseId}`);
    const lease = db.prepare('SELECT * FROM run_dispatch_leases WHERE session_id=? AND scope_id=? AND lease_id=?')
      .get(owner.sessionId,scope,leaseId) as Row | undefined;
    requireBinding(lease && lease.revoked_at === null && lease.run_attempt_id === owner.attemptId,'exact dispatch generation is not current');
    if (depth===0 && requireBoundLease) requireBinding(lease!.source_user_seq === owner.sourceUserSeq
      && lease!.accepted_task_id === owner.acceptedTaskId && lease!.logical_tool_call_id === owner.logicalToolCallId,
      'provider generation is not bound to this exact B call');
    if (lease!.parent_scope_id === null && lease!.parent_lease_id === null) break;
    requireBinding(typeof lease!.parent_scope_id === 'string' && typeof lease!.parent_lease_id === 'string','lease lineage is incomplete');
    scope=String(lease!.parent_scope_id); leaseId=String(lease!.parent_lease_id);
  }
  return intent!;
}
