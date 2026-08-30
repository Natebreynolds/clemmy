import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const mode = process.env.CLEM_WORKFLOW_CRASH_MODE;
const label = process.env.CLEM_WORKFLOW_CRASH_LABEL;
const counterFile = process.env.CLEM_WORKFLOW_CRASH_COUNTER;
if (!mode || !label || !counterFile) {
  throw new Error('workflow crash fixture requires mode, label, and counter path');
}
const fixtureLabel = label;
const fixtureCounterFile = counterFile;

const eventlog = await import('../runtime/harness/eventlog.js');
const authority = await import('../runtime/harness/accepted-turn-call-authority.js');
const kernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const plans = await import('../memory/workflow-node-invocation-plan.js');

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function installCapability() {
  const definitionFingerprint = digest(`workflow-process-crash-schema:${label}`);
  const exactManifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.workflow-process-crash.${label}`,
    providerKind: 'local_registry',
    operationId: `operation.workflow-process-crash.${label}`,
    providerIdentity: 'runtime.process-crash-fixture',
    providerVersion: 'runtime.process-crash.1',
    operationVersion: '1',
    definitionFingerprint,
    effect: 'read',
    accountId: `account.workflow-process-crash.${label}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: {
      issuer: 'host.process-crash-fixture',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });

  const portIdentity = ports.productionPortIdentityFromManifest(exactManifest);
  const registered = ports.registerFixtureCapabilityPort(portIdentity, {
    invoke: async () => {
      appendFileSync(fixtureCounterFile, `${JSON.stringify({ pid: process.pid, label: fixtureLabel })}\n`, 'utf8');
      return { records: [{ id: `record.${fixtureLabel}` }], complete: true };
    },
  });
  if (!registered.ok) throw new Error(`fixture port registration failed: ${registered.reason}`);

  const entry: import('../runtime/harness/host-capability-catalog-factory.js').RegisteredHostCapability = {
    capabilityId: exactManifest.manifestId,
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: exactManifest.definitionFingerprint,
    effect: exactManifest.effect,
    account: exactManifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    liveFingerprint: exactManifest.definitionFingerprint,
    manifest: exactManifest,
    invoke: async () => {
      throw new Error('catalog invoke must never own the workflow process-crash crossing');
    },
  };
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  const observedAt = Date.now();
  const observed = observations.registerIndependentCapabilityObservation({
    operationId: exactManifest.operationId,
    accountId: exactManifest.accountId,
    definitionFingerprint: exactManifest.definitionFingerprint,
    providerVersion: exactManifest.providerVersion,
    operationVersion: exactManifest.operationVersion,
    observedAt,
    origin: 'independent',
    observe: () => ({
      operationId: exactManifest.operationId,
      accountId: exactManifest.accountId,
      definitionFingerprint: exactManifest.definitionFingerprint,
      providerVersion: exactManifest.providerVersion,
      operationVersion: exactManifest.operationVersion,
      observedAt: Date.now(),
    }),
  });
  if (!observed.ok) throw new Error(`fixture observation failed: ${observed.reason}`);

  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  if (!identity) throw new Error('fixture catalog identity is absent');
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: 'requirement.records',
    logicalCapabilityId: 'capability.records.read',
    binding: {
      capabilityId: identity.capabilityId,
      manifestId: identity.manifestId,
      manifestDigest: identity.manifestDigest,
      operationId: identity.operationId,
      operationVersion: identity.schemaVersion,
      schemaDigest: identity.schemaDigest,
      providerVersion: identity.providerVersion,
      liveFingerprint: identity.liveFingerprint,
      accountId: identity.account,
      effect: 'read',
      invokePortId: identity.invokePortId,
      argumentCompiler: { ...identity.argumentCompiler },
    },
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'string',
      },
    },
    evidence: {
      requiredPaths: ['records'],
      nonEmptyPaths: ['records'],
      minItems: { records: 1 },
    },
    completeness: { kind: 'terminal_result', evidencePaths: ['records'] },
    continuation: { kind: 'none' },
  });
  return { plan };
}

type AuthorityRef = import('../runtime/harness/accepted-turn-call-authority.js')
  .WorkflowReadOnlyCallAuthorityRef;

function requiredRef(): AuthorityRef {
  const raw = process.env.CLEM_WORKFLOW_CRASH_REF;
  if (!raw) throw new Error('workflow crash fixture requires an authority ref');
  return JSON.parse(raw) as AuthorityRef;
}

function inspect(ref: AuthorityRef) {
  const db = eventlog.openEventLog();
  const state = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS logical_n,
      (SELECT state FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS logical_state,
      (SELECT COUNT(*) FROM run_dispatch_leases
        WHERE session_id = ? AND source_user_seq = ?
          AND accepted_task_id = ? AND logical_tool_call_id = ?) AS lease_n,
      (SELECT lease_id FROM run_dispatch_leases
        WHERE session_id = ? AND source_user_seq = ?
          AND accepted_task_id = ? AND logical_tool_call_id = ?) AS lease_id,
      (SELECT scope_id FROM run_dispatch_leases
        WHERE session_id = ? AND source_user_seq = ?
          AND accepted_task_id = ? AND logical_tool_call_id = ?) AS lease_scope_id,
      (SELECT revoked_at FROM run_dispatch_leases
        WHERE session_id = ? AND source_user_seq = ?
          AND accepted_task_id = ? AND logical_tool_call_id = ?) AS lease_revoked_at,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS physical_n,
      (SELECT state FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS physical_state,
      (SELECT io_claimed_at FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS io_claimed_at,
      (SELECT lease_scope_id FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS physical_lease_scope_id,
      (SELECT lease_id FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS physical_lease_id,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS settlement_n,
      (SELECT result_handle_id FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?) AS result_handle_id
  `).get(
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.authorityRootId, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.authorityRootId, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.authorityRootId, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.authorityRootId, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
    ref.sessionId, ref.sourceEventSeq, ref.logicalCallId,
  ) as Record<string, unknown>;
  const root = authority.readWorkflowReadOnlyCallAuthority(ref.activationId);
  return {
    ...state,
    authority_state: root.status === 'ok' ? root.authority.state : root.status,
    authority_close_reason: root.status === 'ok' ? root.authority.closeReason : null,
  };
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`WORKFLOW_CRASH_FIXTURE:${JSON.stringify({ pid: process.pid, ...payload })}\n`);
}

const installed = installCapability();

if (mode === 'prepare') {
  const sessionId = `workflow-process-crash-${label}`;
  const session = eventlog.getSession(sessionId)
    ?? eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const armed = authority.armWorkflowReadOnlyCallAuthority({
    sessionId: session.id,
    workflowId: `workflow.${label}`,
    workflowRevision: 1,
    workflowDigest: digest(`workflow:${label}`),
    runId: `run.${label}`,
    runOccurrenceId: `occurrence.${label}`,
    nodeId: `node.${label}`,
    nodeAttempt: 1,
    invocationPlanDigest: installed.plan.bindingDigest,
    bindingSnapshotDigest: digest(`bindings:${label}`),
    controlDigest: digest(`control:${label}`),
    logicalCallId: `logical.${label}`,
  });
  if (armed.status !== 'armed') throw new Error(`workflow authority did not arm: ${armed.status}`);
  emit({ ref: armed.ref, state: inspect(armed.ref) });
  eventlog.closeEventLog();
} else if (mode === 'inspect') {
  const ref = requiredRef();
  emit({ state: inspect(ref) });
  eventlog.closeEventLog();
} else if (mode === 'execute') {
  const ref = requiredRef();
  const crashPoint = process.env.CLEM_WORKFLOW_CRASH_POINT;
  if (crashPoint) {
    kernel.setWorkflowCallKernelCrashPointForTests(
      crashPoint as import('../runtime/harness/workflow-read-only-call-kernel.js').WorkflowCallKernelCrashPoint,
    );
    const marker = process.env.CLEM_WORKFLOW_CRASH_MARKER;
    if (!marker) throw new Error('crashing workflow fixture requires a marker path');
    writeFileSync(marker, JSON.stringify({ pid: process.pid, crashPoint }), 'utf8');
  }
  const result = await kernel.executeWorkflowReadOnlyCall({
    activationId: ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  emit({ result, state: inspect(ref) });
  eventlog.closeEventLog();
} else {
  throw new Error(`unknown workflow crash fixture mode: ${mode}`);
}
