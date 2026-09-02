/** Run: npx tsx --test src/runtime/harness/workflow-read-only-call-kernel.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-read-kernel-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const approvals = await import('./approval-registry.js');
const dispatch = await import('./dispatch-ledger.js');
const kernel = await import('./workflow-read-only-call-kernel.js');
const manifests = await import('./capability-manifest.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const ports = await import('./production-capability-ports.js');
const plans = await import('../../memory/workflow-node-invocation-plan.js');

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const digest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');
let serial = 0;

function manifest(effect: 'read' | 'compute' = 'read', operationId?: string) {
  const suffix = `${effect}-${++serial}`;
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.${suffix}`,
    providerKind: 'local_registry',
    operationId: operationId ?? `operation.${suffix}`,
    providerIdentity: 'runtime.test',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest(`schema:${suffix}`),
    effect,
    accountId: `account.${suffix}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-22T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
}

function installCapability(
  effect: 'read' | 'compute' = 'read',
  operationId?: string,
  invokeOverride?: () => Promise<unknown>,
) {
  const exactManifest = manifest(effect, operationId);
  let portBodies = 0;
  let catalogBodies = 0;
  const portInvoke = async () => {
    portBodies += 1;
    return invokeOverride
      ? invokeOverride()
      : { records: [{ id: 'record.1' }], complete: true };
  };
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(exactManifest),
    { invoke: portInvoke },
  ).ok, true);
  const entry: catalogs.RegisteredHostCapability = {
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
      catalogBodies += 1;
      throw new Error('catalog invoke must not own the workflow crossing');
    },
  };
  const factory = catalogs.createHostCapabilityCatalogFactory([entry]);
  catalogs.installHostCapabilityCatalogFactory(factory);
  const now = Date.now();
  assert.equal(observations.registerIndependentCapabilityObservation({
    operationId: exactManifest.operationId,
    accountId: exactManifest.accountId,
    definitionFingerprint: exactManifest.definitionFingerprint,
    providerVersion: exactManifest.providerVersion,
    operationVersion: exactManifest.operationVersion,
    observedAt: now,
    origin: 'independent',
    observe: () => ({
      operationId: exactManifest.operationId,
      accountId: exactManifest.accountId,
      definitionFingerprint: exactManifest.definitionFingerprint,
      providerVersion: exactManifest.providerVersion,
      operationVersion: exactManifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
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
      effect,
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
  return {
    exactManifest,
    plan,
    portBodies: () => portBodies,
    catalogBodies: () => catalogBodies,
  };
}

function arm(
  plan: plans.WorkflowNodeInvocationPlanV1,
  label: string,
  overrides: Partial<authority.ArmWorkflowReadOnlyCallAuthorityInput> = {},
) {
  const sessionId = `workflow-session-${label}`;
  const session = eventlog.getSession(sessionId)
    ?? eventlog.createSession({ id: sessionId, kind: 'workflow' });
  return authority.armWorkflowReadOnlyCallAuthority({
    sessionId: session.id,
    workflowId: `workflow.${label}`,
    workflowRevision: 1,
    workflowDigest: digest(`workflow:${label}`),
    runId: `run.${label}`,
    runOccurrenceId: `occurrence.${label}`,
    nodeId: `node.${label}`,
    nodeAttempt: 1,
    invocationPlanDigest: plan.bindingDigest,
    bindingSnapshotDigest: digest(`bindings:${label}`),
    controlDigest: digest(`control:${label}`),
    logicalCallId: `logical.${label}`,
    ...overrides,
  });
}

function kernelState(ref: authority.WorkflowReadOnlyCallAuthorityRef) {
  return eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS logical_n,
      (SELECT state FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS logical_state,
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
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS physical_n,
      (SELECT state FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS physical_state,
      (SELECT io_claimed_at FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS io_claimed_at,
      (SELECT lease_scope_id FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS physical_lease_scope_id,
      (SELECT lease_id FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS physical_lease_id,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS settlement_n,
      (SELECT result_handle_id FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?
          AND logical_tool_call_id = ?) AS result_handle_id
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
  ) as {
    logical_n: number;
    logical_state: string | null;
    lease_n: number;
    lease_id: string | null;
    lease_scope_id: string | null;
    lease_revoked_at: string | null;
    physical_n: number;
    physical_state: string | null;
    io_claimed_at: string | null;
    physical_lease_scope_id: string | null;
    physical_lease_id: string | null;
    settlement_n: number;
    result_handle_id: string | null;
  };
}

function frozenLeaseContract(ref: authority.WorkflowReadOnlyCallAuthorityRef) {
  return eventlog.openEventLog().prepare(`
    SELECT lease.recovery_effect, lease.recovery_business_call,
           lease.recovery_tool_name, lease.recovery_argument_digest,
           lease.recovery_argument_cipher,
           call.tool_name AS logical_tool_name,
           call.argument_digest AS logical_argument_digest
      FROM run_dispatch_leases lease
      JOIN logical_tool_calls call
        ON call.session_id = lease.session_id
       AND call.source_user_seq = lease.source_user_seq
       AND call.accepted_task_id = lease.accepted_task_id
       AND call.logical_tool_call_id = lease.logical_tool_call_id
     WHERE lease.session_id = ? AND lease.source_user_seq = ?
       AND lease.accepted_task_id = ? AND lease.logical_tool_call_id = ?
  `).get(
    ref.sessionId,
    ref.sourceEventSeq,
    ref.authorityRootId,
    ref.logicalCallId,
  ) as {
    recovery_effect: string;
    recovery_business_call: number;
    recovery_tool_name: string;
    recovery_argument_digest: string;
    recovery_argument_cipher: string;
    logical_tool_name: string;
    logical_argument_digest: string;
  } | undefined;
}

async function crashAt(
  point: kernel.WorkflowCallKernelCrashPoint,
  ref: authority.WorkflowReadOnlyCallAuthorityRef,
  plan: plans.WorkflowNodeInvocationPlanV1,
): Promise<void> {
  kernel.setWorkflowCallKernelCrashPointForTests(point);
  await assert.rejects(
    kernel.executeWorkflowReadOnlyCall({
      activationId: ref.activationId,
      invocationPlan: plan,
      args: { scope: 'current' },
    }),
    new RegExp(`forced workflow kernel crash: ${point}`),
  );
}

function approvedAuthorization(label: string) {
  const session = eventlog.createSession({ id: `approval-session-${label}`, kind: 'chat' });
  const resumeKey = `one-shot:${digest(`approval-resume:${label}`)}`;
  const registered = approvals.registerResumable({
    sessionId: session.id,
    subject: `Authorize exact workflow activation ${label}`,
    tool: 'workflow_node_read',
    args: { occurrence: label, ceiling: 'read' },
    resumeKey,
  });
  assert.equal(registered.created, true);
  const resolved = approvals.resolve(registered.row.approvalId, 'approved', 'user.fixture');
  assert.equal(resolved.ok, true);
  if (!resolved.ok) throw new Error(resolved.reason);
  const row = resolved.row;
  assert.ok(row.resumeKey);
  assert.ok(row.resolver);
  assert.ok(row.resolvedAt);
  return {
    approvalId: row.approvalId,
    resumeKey: row.resumeKey,
    decisionDigest: authority.oneShotActivationAuthorizationDecisionDigest({
      approvalId: row.approvalId,
      approvalSessionId: row.sessionId,
      resumeKey: row.resumeKey,
      requestedAt: row.requestedAt,
      expiresAt: row.expiresAt,
      subject: row.subject,
      tool: row.tool,
      args: row.args,
      resolver: row.resolver,
      resolvedAt: row.resolvedAt,
    }),
  };
}

test('one real workflow activation owns one immutable-port read through both settlements and terminal closure', async () => {
  const installed = installCapability('read');
  const armed = arm(installed.plan, 'success');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  assert.equal(armed.authority.authorityKind, 'workflow_v1_read_only');
  assert.equal(armed.authority.identity.sourceTurn, 0);
  assert.equal(armed.ref.logicalCallId, 'logical.success');

  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM events
    WHERE session_id = ? AND type = 'workflow_node_invocation_activated'
      AND role = 'system'`).get(armed.ref.sessionId) as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM events
    WHERE session_id = ? AND type = 'user_input_received'`).get(armed.ref.sessionId) as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM accepted_task_resolutions
    WHERE session_id = ?`).get(armed.ref.sessionId) as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM events
    WHERE session_id = ? AND type = 'turn_graph_compiled'`).get(armed.ref.sessionId) as { n: number }).n, 0);

  const result = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(Object.keys(result), [
    'status',
    'activationId',
    'authorityRootId',
    'logicalCallId',
    'physicalDispatchId',
    'result',
  ], 'the read adapter must preserve its established public result bytes');
  assert.equal(installed.portBodies(), 1);
  assert.equal(installed.catalogBodies(), 0, 'catalog callback is not the immutable invocation port');

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_n,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?
          AND io_claimed_at IS NOT NULL AND state = 'returned') AS physical_n,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?) AS settlement_n
  `).get(
    armed.ref.sessionId,
    armed.ref.sourceEventSeq,
    armed.ref.sessionId,
    armed.ref.sourceEventSeq,
    armed.ref.sessionId,
    armed.ref.sourceEventSeq,
  ) as { logical_n: number; physical_n: number; settlement_n: number };
  assert.deepEqual(counts, { logical_n: 1, physical_n: 1, settlement_n: 1 });
  const closed = authority.readWorkflowReadOnlyCallAuthority(armed.ref.activationId);
  assert.equal(closed.status, 'ok');
  if (closed.status === 'ok') {
    assert.equal(closed.authority.state, 'closed');
    assert.equal(closed.authority.closeReason, 'workflow_completed');
  }
  assert.equal(db.pragma('foreign_key_check').length, 0);

  const replay = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(Object.keys(replay), [
    'status',
    'activationId',
    'authorityRootId',
    'logicalCallId',
    'result',
    'resultHandleId',
  ], 'the read replay adapter must preserve its established public result bytes');
  if (replay.status === 'replayed') {
    assert.deepEqual(replay.result, { records: [{ id: 'record.1' }], complete: true });
    assert.match(replay.resultHandleId, /^rh_/);
  }
  assert.equal(installed.portBodies(), 1, 'terminal replay cannot cross the immutable port again');
});

test('an advisory learned pin stays inert until the ordinary workflow call kernel owns the exact read', async () => {
  const installed = installCapability('read');
  const armed = arm(installed.plan, 'learned-pin-handoff');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  const workflowName = 'Kernel Pin Handoff';
  const stepId = 'read_records';
  const learnedSlug = 'PROOF_LIST_RECORDS';
  const toolChoices = await import('../../memory/tool-choice-store.js');
  const certifiedBindings = await import('../../memory/workflow-certified-binding.js');
  const runner = await import('../../execution/workflow-runner.js');
  toolChoices.rememberToolChoice({
    intent: certifiedBindings.workflowStepPinIntent(workflowName, stepId),
    description: 'Previously successful workflow read route.',
    choice: {
      kind: 'composio',
      identifier: learnedSlug,
      invocationTemplate: JSON.stringify({ scope: 'current' }),
      testedAt: new Date().toISOString(),
      testEvidence: 'prior read completed successfully',
    },
  });

  const before = kernelState(armed.ref);
  assert.deepEqual({
    logical_n: before.logical_n,
    lease_n: before.lease_n,
    physical_n: before.physical_n,
    settlement_n: before.settlement_n,
    result_handle_id: before.result_handle_id,
  }, {
    logical_n: 0,
    lease_n: 0,
    physical_n: 0,
    settlement_n: 0,
    result_handle_id: null,
  });
  const hint = runner.workflowRunnerInternalsForTest.renderWorkflowToolPin(workflowName, stepId);
  assert.match(hint, /LEARNED TOOL PIN/);
  assert.match(hint, new RegExp(learnedSlug));
  assert.equal(installed.portBodies(), 0, 'memory lookup/render cannot invoke the immutable provider port');
  assert.deepEqual(kernelState(armed.ref), before, 'memory lookup/render cannot mint or settle call authority');

  const completed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const after = kernelState(armed.ref);
  assert.deepEqual({
    logical_n: after.logical_n,
    logical_state: after.logical_state,
    lease_n: after.lease_n,
    physical_n: after.physical_n,
    physical_state: after.physical_state,
    settlement_n: after.settlement_n,
  }, {
    logical_n: 1,
    logical_state: 'settled',
    lease_n: 1,
    physical_n: 1,
    physical_state: 'returned',
    settlement_n: 1,
  });
  assert.ok(after.io_claimed_at);
  assert.ok(after.result_handle_id, 'the ordinary harness settlement owns the retained result handle');
  assert.ok(after.lease_revoked_at, 'terminal closure revokes the one exact call lease');
  assert.equal(installed.portBodies(), 1);
  assert.equal(installed.catalogBodies(), 0);
  const redeemed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(redeemed.status, 'replayed');
  if (redeemed.status === 'replayed') assert.equal(redeemed.resultHandleId, after.result_handle_id);
  assert.equal(installed.portBodies(), 1, 'result redemption cannot open a second provider body');
});

test('provider operation casing stays sealed while logical and physical admission share one canonical name', async () => {
  const installed = installCapability('read', 'READ_RECORDS_V1');
  const armed = arm(installed.plan, 'uppercase-operation');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  const result = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(installed.portBodies(), 1);
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT l.tool_name AS logical_name, p.tool_name AS physical_name
      FROM logical_tool_calls l
      JOIN physical_dispatches p
        ON p.session_id = l.session_id
       AND p.source_user_seq = l.source_user_seq
       AND p.logical_tool_call_id = l.logical_tool_call_id
     WHERE l.session_id = ? AND l.source_user_seq = ?
  `).get(armed.ref.sessionId, armed.ref.sourceEventSeq), {
    logical_name: 'read_records_v1',
    physical_name: 'read_records_v1',
  });
  assert.equal(installed.exactManifest.operationId, 'READ_RECORDS_V1');
});

test('a concurrent reentry never redispatches or poisons the winning workflow call', async () => {
  let enteredBody!: () => void;
  let releaseBody!: () => void;
  const entered = new Promise<void>((resolve) => { enteredBody = resolve; });
  const release = new Promise<void>((resolve) => { releaseBody = resolve; });
  const installed = installCapability('read', undefined, async () => {
    enteredBody();
    await release;
    return { records: [{ id: 'record.concurrent' }], complete: true };
  });
  const armed = arm(installed.plan, 'concurrent-reentry');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  const first = kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  await entered;
  const reentry = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(reentry.status, 'blocked');
  if (reentry.status === 'blocked') {
    assert.equal(reentry.reason, 'prior_crossing_unknown_no_redispatch');
    assert.equal(reentry.zeroBody, false);
  }
  const stillOpen = authority.readWorkflowReadOnlyCallAuthority(armed.ref.activationId);
  assert.equal(stillOpen.status, 'ok');
  if (stillOpen.status === 'ok') assert.equal(stillOpen.authority.state, 'open');
  const heldLease = kernelState(armed.ref);
  assert.equal(heldLease.lease_n, 1);
  assert.equal(heldLease.lease_revoked_at, null, 'observer cannot revoke the winner generation');
  assert.equal(heldLease.physical_lease_scope_id, heldLease.lease_scope_id);
  assert.equal(heldLease.physical_lease_id, heldLease.lease_id);
  assert.equal(installed.portBodies(), 1);

  releaseBody();
  const completed = await first;
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const closed = authority.readWorkflowReadOnlyCallAuthority(armed.ref.activationId);
  assert.equal(closed.status, 'ok');
  if (closed.status === 'ok') {
    assert.equal(closed.authority.state, 'closed');
    assert.equal(closed.authority.closeReason, 'workflow_completed');
  }
  const terminalLease = kernelState(armed.ref);
  assert.equal(terminalLease.lease_id, heldLease.lease_id);
  assert.ok(terminalLease.lease_revoked_at, 'only the terminal winner revokes its generation');
});

test('restart before physical reservation reuses one call lease, then reserves and invokes exactly once', async (t) => {
  t.after(() => kernel.setWorkflowReadOnlyCallKernelCrashPointForTests(null));
  const installed = installCapability('read');
  const armed = arm(installed.plan, 'crash-before-reservation');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  await crashAt('after_call_lease', armed.ref, installed.plan);
  const crashed = kernelState(armed.ref);
  assert.deepEqual({
    logical_n: crashed.logical_n,
    logical_state: crashed.logical_state,
    lease_n: crashed.lease_n,
    physical_n: crashed.physical_n,
    settlement_n: crashed.settlement_n,
  }, {
    logical_n: 1,
    logical_state: 'open',
    lease_n: 1,
    physical_n: 0,
    settlement_n: 0,
  });
  assert.ok(crashed.lease_id);
  assert.equal(crashed.lease_revoked_at, null);
  const frozen = frozenLeaseContract(armed.ref);
  assert.ok(frozen);
  assert.deepEqual({
    effect: frozen.recovery_effect,
    business: frozen.recovery_business_call,
    tool: frozen.recovery_tool_name,
    digest: frozen.recovery_argument_digest,
  }, {
    effect: 'read',
    business: 1,
    tool: frozen.logical_tool_name,
    digest: frozen.logical_argument_digest,
  });
  assert.ok(frozen.recovery_argument_cipher.length > 0, 'canonical args are sealed for exact restart');
  assert.equal(installed.portBodies(), 0);

  const resumed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  const settled = kernelState(armed.ref);
  assert.equal(settled.lease_n, 1, 'restart cannot mint a replacement generation');
  assert.equal(settled.lease_id, crashed.lease_id, 'restart must adopt the stored lease id');
  assert.equal(settled.physical_n, 1);
  assert.equal(settled.physical_lease_scope_id, settled.lease_scope_id);
  assert.equal(settled.physical_lease_id, settled.lease_id);
  assert.equal(settled.logical_state, 'settled');
  assert.equal(settled.physical_state, 'returned');
  assert.equal(settled.settlement_n, 1);
  assert.ok(settled.lease_revoked_at, 'terminal closure revokes the exact call lease');
  assert.equal(installed.portBodies(), 1);
});

test('restart from reserved-unclaimed claims the same leased crossing and invokes exactly once', async (t) => {
  t.after(() => kernel.setWorkflowReadOnlyCallKernelCrashPointForTests(null));
  const installed = installCapability('read');
  const armed = arm(installed.plan, 'crash-after-reservation');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  await crashAt('after_physical_reservation', armed.ref, installed.plan);
  const reserved = kernelState(armed.ref);
  assert.equal(reserved.lease_n, 1);
  assert.equal(reserved.physical_n, 1);
  assert.equal(reserved.physical_state, 'started');
  assert.equal(reserved.io_claimed_at, null);
  assert.equal(reserved.physical_lease_scope_id, reserved.lease_scope_id);
  assert.equal(reserved.physical_lease_id, reserved.lease_id);
  assert.equal(reserved.lease_revoked_at, null);
  assert.equal(installed.portBodies(), 0);

  const resumed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  const settled = kernelState(armed.ref);
  assert.equal(settled.lease_n, 1);
  assert.equal(settled.lease_id, reserved.lease_id);
  assert.equal(settled.physical_n, 1);
  assert.ok(settled.io_claimed_at);
  assert.equal(settled.physical_state, 'returned');
  assert.equal(settled.settlement_n, 1);
  assert.ok(settled.lease_revoked_at);
  assert.equal(installed.portBodies(), 1);
});

test('restart from claimed-unknown holds the current lease and never redispatches', async (t) => {
  t.after(() => kernel.setWorkflowReadOnlyCallKernelCrashPointForTests(null));
  const installed = installCapability('read');
  const armed = arm(installed.plan, 'crash-after-claim');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  await crashAt('after_io_claim', armed.ref, installed.plan);
  const claimed = kernelState(armed.ref);
  assert.equal(claimed.lease_n, 1);
  assert.equal(claimed.physical_n, 1);
  assert.equal(claimed.physical_state, 'started');
  assert.ok(claimed.io_claimed_at);
  assert.equal(claimed.physical_lease_scope_id, claimed.lease_scope_id);
  assert.equal(claimed.physical_lease_id, claimed.lease_id);
  assert.equal(claimed.lease_revoked_at, null);
  assert.equal(installed.portBodies(), 0);

  const resumed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(resumed.status, 'blocked');
  if (resumed.status === 'blocked') {
    assert.equal(resumed.reason, 'prior_crossing_unknown_no_redispatch');
    assert.equal(resumed.zeroBody, false);
  }
  const held = kernelState(armed.ref);
  assert.equal(held.lease_n, 1);
  assert.equal(held.lease_id, claimed.lease_id);
  assert.equal(held.lease_revoked_at, null, 'an observer must not revoke the winner lease');
  assert.equal(held.physical_n, 1);
  assert.equal(held.physical_state, 'started');
  assert.equal(held.settlement_n, 0);
  assert.equal(installed.portBodies(), 0, 'unknown claim cannot be interpreted as permission to call');
});

test('restart from physical-terminal/logical-missing holds for durable readback and never reports false success', async (t) => {
  t.after(() => kernel.setWorkflowReadOnlyCallKernelCrashPointForTests(null));
  const installed = installCapability('read');
  const armed = arm(installed.plan, 'crash-after-physical');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  await crashAt('after_physical_settlement', armed.ref, installed.plan);
  const terminal = kernelState(armed.ref);
  assert.equal(terminal.lease_n, 1);
  assert.equal(terminal.physical_n, 1);
  assert.equal(terminal.physical_state, 'returned');
  assert.ok(terminal.io_claimed_at);
  assert.equal(terminal.logical_state, 'open');
  assert.equal(terminal.settlement_n, 0);
  assert.equal(terminal.result_handle_id, null);
  assert.equal(terminal.lease_revoked_at, null);
  assert.equal(installed.portBodies(), 1);

  const resumed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(resumed.status, 'blocked', 'terminal crossing alone is not completion proof');
  if (resumed.status === 'blocked') {
    assert.equal(resumed.reason, 'prior_crossing_unknown_no_redispatch');
    assert.equal(resumed.zeroBody, false);
  }
  const held = kernelState(armed.ref);
  assert.equal(held.lease_n, 1);
  assert.equal(held.lease_id, terminal.lease_id);
  assert.equal(held.lease_revoked_at, null);
  assert.equal(held.physical_n, 1);
  assert.equal(held.settlement_n, 0);
  assert.equal(installed.portBodies(), 1, 'readback/retained-result proof is required before adoption');
});

test('restart from logical-settled redeems the exact handle, closes, and revokes with zero new crossing', async (t) => {
  t.after(() => kernel.setWorkflowReadOnlyCallKernelCrashPointForTests(null));
  const expected = { records: [{ id: 'record.1' }], complete: true };
  const installed = installCapability('read');
  const armed = arm(installed.plan, 'crash-after-logical');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  await crashAt('after_logical_settlement', armed.ref, installed.plan);
  const durable = kernelState(armed.ref);
  assert.equal(durable.logical_state, 'settled');
  assert.equal(durable.physical_state, 'returned');
  assert.equal(durable.lease_n, 1);
  assert.equal(durable.physical_n, 1);
  assert.equal(durable.settlement_n, 1);
  assert.ok(durable.result_handle_id);
  assert.equal(durable.lease_revoked_at, null, 'lease remains live until root closure');
  const open = authority.readWorkflowReadOnlyCallAuthority(armed.ref.activationId);
  assert.equal(open.status, 'ok');
  if (open.status === 'ok') assert.equal(open.authority.state, 'open');
  assert.equal(installed.portBodies(), 1);

  const resumed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(resumed.status, 'replayed', JSON.stringify(resumed));
  if (resumed.status === 'replayed') {
    assert.deepEqual(resumed.result, expected);
    assert.equal(resumed.resultHandleId, durable.result_handle_id);
  }
  const closed = authority.readWorkflowReadOnlyCallAuthority(armed.ref.activationId);
  assert.equal(closed.status, 'ok');
  if (closed.status === 'ok') {
    assert.equal(closed.authority.state, 'closed');
    assert.equal(closed.authority.closeReason, 'workflow_completed');
  }
  const recovered = kernelState(armed.ref);
  assert.equal(recovered.lease_n, 1);
  assert.equal(recovered.lease_id, durable.lease_id);
  assert.ok(recovered.lease_revoked_at);
  assert.equal(recovered.physical_n, 1);
  assert.equal(recovered.settlement_n, 1);
  assert.equal(installed.portBodies(), 1);

  const replay = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(kernelState(armed.ref), recovered, 'closed replay is ledger- and lease-free');
  assert.equal(installed.portBodies(), 1);
});

test('cancellation is exact at the I/O boundary: pre-claim closes zero-body and post-claim settles the real body', async () => {
  const preClaim = installCapability('read');
  const preClaimRoot = arm(preClaim.plan, 'cancel-before-claim');
  assert.equal(preClaimRoot.status, 'armed');
  if (preClaimRoot.status !== 'armed') return;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const cancelled = await kernel.executeWorkflowReadOnlyCall({
    activationId: preClaimRoot.ref.activationId,
    invocationPlan: preClaim.plan,
    args: { scope: 'current' },
    signal: alreadyAborted.signal,
  });
  assert.equal(cancelled.status, 'blocked');
  if (cancelled.status === 'blocked') assert.equal(cancelled.zeroBody, true);
  assert.equal(preClaim.portBodies(), 0);
  const cancelledRoot = authority.readWorkflowReadOnlyCallAuthority(preClaimRoot.ref.activationId);
  assert.equal(cancelledRoot.status, 'ok');
  if (cancelledRoot.status === 'ok') {
    assert.equal(cancelledRoot.authority.state, 'closed');
    assert.equal(cancelledRoot.authority.closeReason, 'workflow_cancelled');
  }

  let enteredBody!: () => void;
  let releaseBody!: () => void;
  const entered = new Promise<void>((resolve) => { enteredBody = resolve; });
  const release = new Promise<void>((resolve) => { releaseBody = resolve; });
  const postClaim = installCapability('read', undefined, async () => {
    enteredBody();
    await release;
    return { records: [{ id: 'record.after-abort' }], complete: true };
  });
  const postClaimRoot = arm(postClaim.plan, 'cancel-after-claim');
  assert.equal(postClaimRoot.status, 'armed');
  if (postClaimRoot.status !== 'armed') return;
  const controller = new AbortController();
  const inFlight = kernel.executeWorkflowReadOnlyCall({
    activationId: postClaimRoot.ref.activationId,
    invocationPlan: postClaim.plan,
    args: { scope: 'current' },
    signal: controller.signal,
  });
  await entered;
  controller.abort();
  releaseBody();
  const settled = await inFlight;
  assert.equal(settled.status, 'completed', JSON.stringify(settled));
  assert.equal(postClaim.portBodies(), 1);
});

test('a thrown immutable-port read settles both ledgers and conflicts the root exactly once', async () => {
  const installed = installCapability('read', undefined, async () => {
    throw new Error('fixture provider read failed');
  });
  const armed = arm(installed.plan, 'provider-failure');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  const failed = await kernel.executeWorkflowReadOnlyCall({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed') assert.equal(failed.zeroBody, false);
  assert.equal(installed.portBodies(), 1);
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT
      (SELECT state FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS physical_state,
      (SELECT state FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_state,
      (SELECT state FROM accepted_turn_call_authorities
        WHERE session_id = ? AND source_user_seq = ?) AS root_state,
      (SELECT close_reason FROM accepted_turn_call_authorities
        WHERE session_id = ? AND source_user_seq = ?) AS close_reason
  `).get(
    armed.ref.sessionId, armed.ref.sourceEventSeq,
    armed.ref.sessionId, armed.ref.sourceEventSeq,
    armed.ref.sessionId, armed.ref.sourceEventSeq,
    armed.ref.sessionId, armed.ref.sourceEventSeq,
  ), {
    physical_state: 'threw',
    logical_state: 'settled',
    root_state: 'conflict',
    close_reason: 'workflow_failed',
  });
});

test('one-shot activation authorization is consumed atomically and closed arm replay returns its canonical ref', () => {
  const installed = installCapability('read');
  const authorization = approvedAuthorization('authorized');
  const armed = arm(installed.plan, 'authorized', {
    oneShotActivationAuthorization: authorization,
  });
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;

  const consumed = approvals.get(authorization.approvalId);
  assert.ok(consumed?.consumedAt);
  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT one_shot_authorization_approval_id AS approval_id,
           one_shot_authorization_resume_key AS resume_key,
           one_shot_authorization_decision_digest AS decision_digest
      FROM workflow_node_invocation_activations
     WHERE activation_id = ?
  `).get(armed.ref.activationId), {
    approval_id: authorization.approvalId,
    resume_key: authorization.resumeKey,
    decision_digest: authorization.decisionDigest,
  });
  const activationEvent = eventlog.listEvents(armed.ref.sessionId, {
    types: ['workflow_node_invocation_activated'],
  })[0];
  assert.deepEqual(activationEvent?.data.oneShotActivationAuthorization, authorization);

  const existing = arm(installed.plan, 'authorized', {
    oneShotActivationAuthorization: authorization,
  });
  assert.equal(existing.status, 'existing');
  if (existing.status !== 'existing') return;
  assert.equal(existing.ref.activationId, armed.ref.activationId);

  const cancelled = authority.closeWorkflowReadOnlyCallAuthority({
    activationId: armed.ref.activationId,
    outcome: 'cancelled',
  });
  assert.equal(cancelled.status, 'closed');
  const closedReplay = arm(installed.plan, 'authorized', {
    oneShotActivationAuthorization: authorization,
  });
  assert.equal(closedReplay.status, 'existing_closed');
  if (closedReplay.status === 'existing_closed') {
    assert.equal(closedReplay.ref.activationId, armed.ref.activationId);
    assert.equal(closedReplay.authority.state, 'closed');
  }
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('one-shot authorization mismatch and activation failure leave the exact approval unconsumed', () => {
  const installed = installCapability('read');
  const mismatched = approvedAuthorization('mismatch');
  const refused = arm(installed.plan, 'mismatch', {
    oneShotActivationAuthorization: {
      ...mismatched,
      decisionDigest: digest('foreign-decision'),
    },
  });
  assert.equal(refused.status, 'conflict');
  assert.equal(approvals.get(mismatched.approvalId)?.consumedAt, null);

  const rolledBack = approvedAuthorization('rollback');
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER abort_workflow_activation_rehearsal
    BEFORE INSERT ON workflow_node_invocation_activations
    BEGIN SELECT RAISE(ABORT, 'fixture activation abort'); END;
  `);
  try {
    const failed = arm(installed.plan, 'rollback', {
      oneShotActivationAuthorization: rolledBack,
    });
    assert.equal(failed.status, 'storage_error');
  } finally {
    db.exec('DROP TRIGGER abort_workflow_activation_rehearsal');
  }
  assert.equal(approvals.get(rolledBack.approvalId)?.consumedAt, null);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM workflow_node_invocation_activations
    WHERE one_shot_authorization_approval_id = ?`).get(rolledBack.approvalId) as { n: number }).n, 0);
});

test('forged ALS, direct ledger bypass, foreign plan and compute binding all refuse with zero bodies', async () => {
  const installed = installCapability('read');
  const direct = arm(installed.plan, 'direct');
  assert.equal(direct.status, 'armed');
  if (direct.status !== 'armed') return;
  assert.throws(() => authority.withWorkflowReadOnlyCallAttestation({
    kind: 'workflow_v1_read_only_call_attestation',
    activationId: direct.ref.activationId,
    authorityRootId: direct.ref.authorityRootId,
    logicalCallId: direct.ref.logicalCallId,
  }, () => undefined), /not authentic/);
  const bypass = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: direct.ref.sessionId,
      sourceUserSeq: direct.ref.sourceEventSeq,
      acceptedTaskId: direct.ref.authorityRootId,
      logicalToolCallId: direct.ref.logicalCallId,
      physicalDispatchId: 'forged-direct-dispatch',
      ordinal: 0,
    },
    tool: installed.exactManifest.operationId,
    args: { scope: 'current' },
  });
  assert.equal(bypass.status, 'conflict');
  assert.equal((eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM physical_dispatches
    WHERE session_id = ?`).get(direct.ref.sessionId) as { n: number }).n, 0);
  assert.equal(installed.portBodies(), 0);

  const foreign = arm(installed.plan, 'foreign');
  assert.equal(foreign.status, 'armed');
  if (foreign.status !== 'armed') return;
  const changed = structuredClone(installed.plan);
  changed.binding.operationId = 'operation.foreign';
  const foreignResult = await kernel.executeWorkflowReadOnlyCall({
    activationId: foreign.ref.activationId,
    invocationPlan: changed,
    args: { scope: 'current' },
  });
  assert.equal(foreignResult.status, 'blocked');
  if (foreignResult.status === 'blocked') assert.equal(foreignResult.zeroBody, true);
  assert.equal(installed.portBodies(), 0);

  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  const compute = installCapability('compute');
  const computeRoot = arm(compute.plan, 'compute');
  assert.equal(computeRoot.status, 'armed');
  if (computeRoot.status !== 'armed') return;
  const computeResult = await kernel.executeWorkflowReadOnlyCall({
    activationId: computeRoot.ref.activationId,
    invocationPlan: compute.plan,
    args: { scope: 'current' },
  });
  assert.equal(computeResult.status, 'blocked');
  if (computeResult.status === 'blocked') assert.equal(computeResult.zeroBody, true);
  assert.equal(compute.portBodies(), 0);
});

test('a node keeps its attempt for the same content address and opens the next attempt only past a zero-body close', async () => {
  const installed = installCapability();
  const base = {
    workflowId: 'workflow.attempt-chooser',
    workflowRevision: 1,
    workflowDigest: digest('workflow:attempt-chooser'),
    runId: 'run.attempt-chooser',
    runOccurrenceId: 'occurrence.attempt-chooser',
    nodeId: 'node.attempt-chooser',
    invocationPlanDigest: installed.plan.bindingDigest,
    bindingSnapshotDigest: digest('bindings:attempt-chooser'),
    controlDigest: digest('control:attempt-chooser'),
  };
  const rebound = { ...base, bindingSnapshotDigest: digest('bindings:attempt-chooser:acquired') };
  // Nothing recorded yet: attempt 1.
  assert.equal(authority.nextWorkflowNodeAttempt(base), 1);
  const first = arm(installed.plan, 'attempt-chooser', { nodeAttempt: 1 });
  assert.equal(first.status, 'armed', JSON.stringify(first));
  if (first.status !== 'armed') return;
  // Same content on a later tick: the same attempt (the authority replays it).
  assert.equal(authority.nextWorkflowNodeAttempt(base), 1);
  // Drifted content while attempt 1 is still OPEN: collide, never a new attempt.
  assert.equal(authority.nextWorkflowNodeAttempt(rebound), 1);
  // Attempt 1 closes with zero body (blocked before any physical dispatch).
  const aborted = new AbortController();
  aborted.abort();
  const blocked = await kernel.executeWorkflowReadOnlyCall({
    activationId: first.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
    signal: aborted.signal,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(installed.portBodies(), 0);
  // Now the drifted content opens attempt 2, and arming it is not a conflict.
  assert.equal(authority.nextWorkflowNodeAttempt(rebound), 2);
  const second = arm(installed.plan, 'attempt-chooser', {
    nodeAttempt: 2,
    bindingSnapshotDigest: rebound.bindingSnapshotDigest,
    logicalCallId: 'logical.attempt-chooser.2',
  });
  assert.equal(second.status, 'armed', JSON.stringify(second));
  if (second.status !== 'armed') return;
  // The first content address still maps to its own attempt.
  assert.equal(authority.nextWorkflowNodeAttempt(base), 1);
  // Attempt 2 crosses a real body; further drift collides with it (one
  // occurrence never opens a second physical call under drifted content).
  const completed = await kernel.executeWorkflowReadOnlyCall({
    activationId: second.ref.activationId,
    invocationPlan: installed.plan,
    args: { scope: 'current' },
  });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(installed.portBodies(), 1);
  assert.equal(authority.nextWorkflowNodeAttempt({ ...base, controlDigest: digest('control:other') }), 2);
});
