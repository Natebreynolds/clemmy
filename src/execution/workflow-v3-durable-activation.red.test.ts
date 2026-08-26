/** Run: node scripts/run-tests-isolated.mjs src/execution/workflow-v3-durable-activation.red.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-v3-activation-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const executor = await import('./workflow-node-invocation-executor.js');
const plans = await import('../memory/workflow-node-invocation-plan.js');
const catalog = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const authority = await import('../runtime/harness/accepted-turn-call-authority.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const kernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');

import type { CapabilityManifestV1 } from '../runtime/harness/capability-manifest.js';
import type { RegisteredHostCapability } from '../runtime/harness/host-capability-catalog-factory.js';
import type {
  WorkflowNodeInvocationEffectV1,
  WorkflowNodeInvocationPlanV1,
} from '../memory/workflow-node-invocation-plan.js';

test.after(() => {
  catalog.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  kernel.setWorkflowCallKernelCrashPointForTests(null);
  eventlog.closeEventLog();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.afterEach(() => {
  catalog.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  kernel.setWorkflowCallKernelCrashPointForTests(null);
  authority.setWorkflowV3ActivationFailurePointForTests(null);
});

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function manifest(label: string, effect: WorkflowNodeInvocationEffectV1, account = `account.${label}`): CapabilityManifestV1 {
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.${label}`,
    providerKind: 'local_registry',
    operationId: `operation.${label}`,
    providerIdentity: `runtime.${label}`,
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest(`schema.${label}`),
    effect,
    accountId: account,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'bounded_read',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-25T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['write'],
  });
}

let serial = 0;

function fixture(input: {
  label: string;
  effect?: WorkflowNodeInvocationEffectV1;
  account?: string;
}) {
  const exactManifest = manifest(input.label, input.effect ?? 'external_write', input.account);
  let bodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(exactManifest),
    {
      invoke: async () => {
        bodies += 1;
        return { records: [{ id: `record.${input.label}` }] };
      },
    },
  ).ok, true);
  const entry: RegisteredHostCapability = {
    capabilityId: `capability.${input.label}`,
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: exactManifest.definitionFingerprint,
    effect: exactManifest.effect,
    account: exactManifest.accountId,
    advisoryRoles: exactManifest.advisoryRoles,
    manifestDigest: manifests.capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    liveFingerprint: exactManifest.definitionFingerprint,
    manifest: exactManifest,
    invoke: async () => { throw new Error('catalog callback cannot own workflow v3 I/O'); },
  };
  const identity = catalog.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: `requirement.${input.label}`,
    logicalCapabilityId: `logical.${input.label}`,
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
      effect: exactManifest.effect,
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
    evidence: { requiredPaths: ['records'], nonEmptyPaths: ['records'], minItems: { records: 1 } },
    completeness: { kind: 'terminal_result', evidencePaths: ['records'] },
    continuation: { kind: 'none' },
  });
  const occurrence = `${input.label}.${++serial}`;
  const baseIdentity = {
    workflowId: `workflow.${input.label}`,
    workflowRevision: 7,
    workflowDigest: digest(`workflow.${input.label}.7`),
    runId: `run.${occurrence}`,
    runOccurrenceId: `occurrence.${occurrence}`,
    nodeId: `node.${input.label}`,
    nodeAttempt: 1,
    bindingSnapshotDigest: digest(`binding.${input.label}`),
    controlDigest: digest(`control.${input.label}`),
  } as const;
  const prepareWith = (
    selectedPlan: WorkflowNodeInvocationPlanV1,
    selectedEntry: RegisteredHostCapability,
    scope = 'exact',
  ) => {
    const selectedManifest = selectedEntry.manifest;
    assert.ok(selectedManifest, 'the fixture entry must retain its exact manifest');
    return executor.prepareWorkflowNodeCall({
    plan: selectedPlan,
    identity: {
      ...baseIdentity,
      invocationPlanDigest: selectedPlan.bindingDigest,
    },
    arguments: { workflowInputs: { scope }, stepOutputs: {} },
    catalogFactory: catalog.createHostCapabilityCatalogFactory([selectedEntry]),
    observe: () => ({
      operationId: selectedManifest.operationId,
      accountId: selectedManifest.accountId,
      definitionFingerprint: selectedManifest.definitionFingerprint,
      providerVersion: selectedManifest.providerVersion,
      operationVersion: selectedManifest.operationVersion,
      observedAt: Date.now(),
      origin: 'independent',
    }),
  });
  };
  const prepare = (scope = 'exact') => prepareWith(plan, entry, scope);
  const installLive = () => {
    catalog.installHostCapabilityCatalogFactory(catalog.createHostCapabilityCatalogFactory([entry]));
    assert.equal(observations.registerIndependentCapabilityObservation({
      operationId: exactManifest.operationId,
      accountId: exactManifest.accountId,
      definitionFingerprint: exactManifest.definitionFingerprint,
      providerVersion: exactManifest.providerVersion,
      operationVersion: exactManifest.operationVersion,
      observedAt: Date.now(),
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
  };
  return { exactManifest, entry, plan, prepare, prepareWith, installLive, bodies: () => bodies };
}

function exactAuthorization(sessionId: string, prepared: {
  prepared: executor.PreparedWorkflowNodeCallV1;
  authority: { authorityBindingDigest: string };
}) {
  const resumeKey = `workflow-v3:${prepared.prepared.logicalCallId}`;
  const registered = approvals.registerResumable({
    sessionId,
    subject: `Authorize ${prepared.prepared.operationId}`,
    tool: 'workflow_v3_call',
    args: {
      authorityBindingDigest: prepared.authority.authorityBindingDigest,
      operationId: prepared.prepared.operationId,
      accountId: prepared.prepared.binding.accountId,
      effect: prepared.prepared.binding.effect,
      canonicalArgumentDigest: prepared.prepared.canonicalArgumentDigest,
    },
    resumeKey,
  });
  const resolved = approvals.resolve(registered.row.approvalId, 'approved', 'workflow-v3-test');
  assert.equal(resolved.ok, true);
  assert.ok(resolved.row?.resolvedAt && resolved.row.resumeKey);
  return {
    approvalId: resolved.row.approvalId,
    resumeKey: resolved.row.resumeKey,
    decisionDigest: authority.oneShotActivationAuthorizationDecisionDigest({
      approvalId: resolved.row.approvalId,
      approvalSessionId: sessionId,
      resumeKey: resolved.row.resumeKey,
      requestedAt: resolved.row.requestedAt,
      expiresAt: resolved.row.expiresAt,
      subject: resolved.row.subject,
      tool: resolved.row.tool,
      args: resolved.row.args,
      resolver: resolved.row.resolver!,
      resolvedAt: resolved.row.resolvedAt,
    }),
  };
}

test('RED: an opaque checkpoint arms one durable exact v3 root, clones and drift remain zero-row', () => {
  const installed = fixture({ label: 'arm-exact' });
  const sessionId = eventlog.createSession({ id: 'workflow-v3-arm-exact', kind: 'workflow' }).id;
  const checkpoint = installed.prepare();
  assert.equal(checkpoint.kind, 'authority_checkpoint', JSON.stringify(checkpoint));
  if (checkpoint.kind !== 'authority_checkpoint') return;

  const noConsent = executor.activatePreparedWorkflowNodeCall({
    sessionId,
    prepared: checkpoint.prepared,
    proof: checkpoint.proof,
  });
  assert.equal(noConsent.status, 'blocked');
  if (noConsent.status === 'blocked') assert.equal(noConsent.reason, 'exact_one_shot_authorization_required');

  const authorization = exactAuthorization(sessionId, checkpoint);
  const clone = executor.activatePreparedWorkflowNodeCall({
    sessionId,
    prepared: structuredClone(checkpoint.prepared),
    proof: { ...checkpoint.proof },
    oneShotActivationAuthorization: authorization,
  });
  assert.equal(clone.status, 'blocked');
  if (clone.status === 'blocked') assert.equal(clone.reason, 'prepared_call_not_authentic');

  const armed = executor.activatePreparedWorkflowNodeCall({
    sessionId,
    prepared: checkpoint.prepared,
    proof: checkpoint.proof,
    oneShotActivationAuthorization: authorization,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') return;
  assert.equal(armed.executable, true);
  assert.equal(approvals.get(authorization.approvalId)?.consumedAt !== null, true);

  const reopened = executor.activatePreparedWorkflowNodeCall({
    sessionId,
    prepared: checkpoint.prepared,
    proof: checkpoint.proof,
    oneShotActivationAuthorization: authorization,
  });
  assert.ok(reopened.status === 'existing' || reopened.status === 'existing_closed', JSON.stringify(reopened));
  if (reopened.status === 'existing' || reopened.status === 'existing_closed') {
    assert.equal(reopened.activationId, armed.activationId);
    assert.equal(reopened.authorityRootId, armed.authorityRootId);
  }

  const row = eventlog.openEventLog().prepare(`
    SELECT a.authority_binding_digest, a.requirement_id, a.effect,
           a.canonical_argument_digest, a.source_argument_digest,
           a.capability_id, a.manifest_id, a.manifest_digest,
           a.operation_id, a.operation_version, a.schema_digest,
           a.provider_version, a.live_fingerprint, a.account_id,
           a.invoke_port_id, a.argument_compiler_id, a.argument_compiler_version,
           base.workflow_id, base.workflow_revision, base.workflow_digest,
           base.run_id, base.run_occurrence_id, base.node_id, base.node_attempt,
           base.invocation_plan_digest, base.binding_snapshot_digest,
           base.control_digest, base.logical_call_id,
           root.authority_kind, root.binding_revision_digest
      FROM workflow_v3_call_activation_bindings a
      JOIN workflow_node_invocation_activations base
        ON base.activation_id = a.activation_id
      JOIN accepted_turn_call_authorities root
        ON root.workflow_activation_id = a.activation_id
     WHERE a.activation_id = ?
  `).get(armed.activationId) as Record<string, unknown>;
  assert.equal(row.authority_binding_digest, checkpoint.authority.authorityBindingDigest);
  assert.equal(row.requirement_id, checkpoint.prepared.requirementId);
  assert.equal(row.effect, 'external_write');
  assert.equal(row.canonical_argument_digest, checkpoint.prepared.canonicalArgumentDigest);
  assert.equal(row.source_argument_digest, checkpoint.prepared.sourceArgumentDigest);
  assert.equal(row.capability_id, checkpoint.prepared.binding.capabilityId);
  assert.equal(row.manifest_id, checkpoint.prepared.binding.manifestId);
  assert.equal(row.manifest_digest, checkpoint.prepared.binding.manifestDigest);
  assert.equal(row.operation_id, checkpoint.prepared.binding.operationId);
  assert.equal(row.operation_version, checkpoint.prepared.binding.operationVersion);
  assert.equal(row.schema_digest, checkpoint.prepared.binding.schemaDigest);
  assert.equal(row.provider_version, checkpoint.prepared.binding.providerVersion);
  assert.equal(row.live_fingerprint, checkpoint.prepared.binding.liveFingerprint);
  assert.equal(row.account_id, checkpoint.prepared.binding.accountId);
  assert.equal(row.invoke_port_id, checkpoint.prepared.binding.invokePortId);
  assert.equal(row.argument_compiler_id, checkpoint.prepared.binding.argumentCompiler.id);
  assert.equal(row.argument_compiler_version, checkpoint.prepared.binding.argumentCompiler.version);
  assert.equal(row.workflow_id, checkpoint.prepared.identity.workflowId);
  assert.equal(row.workflow_revision, checkpoint.prepared.identity.workflowRevision);
  assert.equal(row.workflow_digest, checkpoint.prepared.identity.workflowDigest);
  assert.equal(row.run_id, checkpoint.prepared.identity.runId);
  assert.equal(row.run_occurrence_id, checkpoint.prepared.identity.runOccurrenceId);
  assert.equal(row.node_id, checkpoint.prepared.identity.nodeId);
  assert.equal(row.node_attempt, checkpoint.prepared.identity.nodeAttempt);
  assert.equal(row.invocation_plan_digest, checkpoint.prepared.invocationPlanDigest);
  assert.equal(row.binding_snapshot_digest, checkpoint.prepared.bindingSnapshotDigest);
  assert.equal(row.control_digest, checkpoint.prepared.controlDigest);
  assert.equal(row.logical_call_id, checkpoint.prepared.logicalCallId);
  assert.equal(row.authority_kind, 'workflow_v3_call');
  assert.equal(row.binding_revision_digest, checkpoint.authority.authorityBindingDigest);

  assert.throws(() => eventlog.openEventLog().prepare(`
    UPDATE workflow_v3_call_activation_bindings SET account_id = 'account.forged'
     WHERE activation_id = ?
  `).run(armed.activationId), /immutable/);
  assert.throws(() => eventlog.openEventLog().prepare(`
    DELETE FROM workflow_v3_call_activation_bindings WHERE activation_id = ?
  `).run(armed.activationId), /append-only|immutable/);

  const drifted = installed.prepare('changed');
  assert.equal(drifted.kind, 'authority_checkpoint');
  if (drifted.kind === 'authority_checkpoint') {
    const driftAttempt = executor.activatePreparedWorkflowNodeCall({
      sessionId,
      prepared: drifted.prepared,
      proof: drifted.proof,
      oneShotActivationAuthorization: authorization,
    });
    assert.equal(driftAttempt.status, 'conflict');
  }

  const accountChanged = fixture({ label: 'arm-exact', account: 'account.changed' });
  const accountCheckpoint = installed.prepareWith(accountChanged.plan, accountChanged.entry);
  assert.equal(accountCheckpoint.kind, 'authority_checkpoint');
  if (accountCheckpoint.kind === 'authority_checkpoint') {
    const accountAttempt = executor.activatePreparedWorkflowNodeCall({
      sessionId,
      prepared: accountCheckpoint.prepared,
      proof: accountCheckpoint.proof,
      oneShotActivationAuthorization: authorization,
    });
    assert.equal(accountAttempt.status, 'conflict');
  }

  const effectChanged = fixture({ label: 'arm-exact', effect: 'admin' });
  const effectCheckpoint = installed.prepareWith(effectChanged.plan, effectChanged.entry);
  assert.equal(effectCheckpoint.kind, 'authority_checkpoint');
  if (effectCheckpoint.kind === 'authority_checkpoint') {
    const effectAttempt = executor.activatePreparedWorkflowNodeCall({
      sessionId,
      prepared: effectCheckpoint.prepared,
      proof: effectCheckpoint.proof,
      oneShotActivationAuthorization: authorization,
    });
    assert.equal(effectAttempt.status, 'conflict');
  }

  const planChanged = plans.createWorkflowNodeInvocationPlan({
    requirementId: `${installed.plan.requirementId}.changed`,
    logicalCapabilityId: installed.plan.logicalCapabilityId,
    binding: installed.plan.binding,
    ...(installed.plan.predecessor ? { predecessor: installed.plan.predecessor } : {}),
    arguments: installed.plan.arguments,
    evidence: installed.plan.evidence,
    completeness: installed.plan.completeness,
    continuation: installed.plan.continuation,
    ...(installed.plan.resultProjection ? { resultProjection: installed.plan.resultProjection } : {}),
  });
  const planCheckpoint = installed.prepareWith(planChanged, installed.entry);
  assert.equal(planCheckpoint.kind, 'authority_checkpoint');
  if (planCheckpoint.kind === 'authority_checkpoint') {
    const planAttempt = executor.activatePreparedWorkflowNodeCall({
      sessionId,
      prepared: planCheckpoint.prepared,
      proof: planCheckpoint.proof,
      oneShotActivationAuthorization: authorization,
    });
    assert.equal(planAttempt.status, 'conflict');
  }
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM workflow_v3_call_activation_bindings WHERE activation_id = ?
  `).get(armed.activationId) as { n: number }).n, 1);
  assert.equal(installed.bodies(), 0);
});

test('v64 activation, exact consent, binding, and root roll back together and retry cleanly', () => {
  for (const failurePoint of ['after_activation', 'after_binding'] as const) {
    const installed = fixture({ label: `rollback-${failurePoint}` });
    const sessionId = eventlog.createSession({
      id: `workflow-v3-rollback-${failurePoint}`,
      kind: 'workflow',
    }).id;
    const checkpoint = installed.prepare();
    assert.equal(checkpoint.kind, 'authority_checkpoint', JSON.stringify(checkpoint));
    if (checkpoint.kind !== 'authority_checkpoint') continue;
    const authorization = exactAuthorization(sessionId, checkpoint);

    authority.setWorkflowV3ActivationFailurePointForTests(failurePoint);
    const failed = executor.activatePreparedWorkflowNodeCall({
      sessionId,
      prepared: checkpoint.prepared,
      proof: checkpoint.proof,
      oneShotActivationAuthorization: authorization,
    });
    authority.setWorkflowV3ActivationFailurePointForTests(null);
    assert.equal(failed.status, 'storage_error', JSON.stringify(failed));
    const rolledBack = eventlog.openEventLog().prepare(`
      SELECT
        (SELECT COUNT(*) FROM events
          WHERE session_id = ? AND type = 'workflow_node_invocation_activated') AS events,
        (SELECT COUNT(*) FROM workflow_node_invocation_activations
          WHERE session_id = ?) AS activations,
        (SELECT COUNT(*) FROM workflow_v3_call_activation_bindings
          WHERE session_id = ?) AS bindings,
        (SELECT COUNT(*) FROM accepted_turn_call_authorities
          WHERE session_id = ?) AS roots
    `).get(sessionId, sessionId, sessionId, sessionId) as {
      events: number;
      activations: number;
      bindings: number;
      roots: number;
    };
    assert.deepEqual(rolledBack, { events: 0, activations: 0, bindings: 0, roots: 0 });
    assert.equal(approvals.get(authorization.approvalId)?.consumedAt, null);

    const retry = executor.activatePreparedWorkflowNodeCall({
      sessionId,
      prepared: checkpoint.prepared,
      proof: checkpoint.proof,
      oneShotActivationAuthorization: authorization,
    });
    assert.equal(retry.status, 'armed', JSON.stringify(retry));
    assert.equal(approvals.get(authorization.approvalId)?.consumedAt !== null, true);
    const committed = eventlog.openEventLog().prepare(`
      SELECT
        (SELECT COUNT(*) FROM events
          WHERE session_id = ? AND type = 'workflow_node_invocation_activated') AS events,
        (SELECT COUNT(*) FROM workflow_node_invocation_activations
          WHERE session_id = ?) AS activations,
        (SELECT COUNT(*) FROM workflow_v3_call_activation_bindings
          WHERE session_id = ?) AS bindings,
        (SELECT COUNT(*) FROM accepted_turn_call_authorities
          WHERE session_id = ?) AS roots
    `).get(sessionId, sessionId, sessionId, sessionId) as {
      events: number;
      activations: number;
      bindings: number;
      roots: number;
    };
    assert.deepEqual(committed, { events: 1, activations: 1, bindings: 1, roots: 1 });
  }
});

test('RED: not-started resumes, claimed external write holds, and exact settlement replays', async () => {
  const resumable = fixture({ label: 'resume-not-started' });
  const resumeSession = eventlog.createSession({ id: 'workflow-v3-resume-not-started', kind: 'workflow' }).id;
  const resumeCheckpoint = resumable.prepare();
  assert.equal(resumeCheckpoint.kind, 'authority_checkpoint', JSON.stringify(resumeCheckpoint));
  if (resumeCheckpoint.kind !== 'authority_checkpoint') return;
  const resumeAuthorization = exactAuthorization(resumeSession, resumeCheckpoint);
  const resumeRoot = executor.activatePreparedWorkflowNodeCall({
    sessionId: resumeSession,
    prepared: resumeCheckpoint.prepared,
    proof: resumeCheckpoint.proof,
    oneShotActivationAuthorization: resumeAuthorization,
  });
  assert.equal(resumeRoot.status, 'armed', JSON.stringify(resumeRoot));
  if (resumeRoot.status !== 'armed') return;
  resumable.installLive();
  kernel.setWorkflowCallKernelCrashPointForTests('after_physical_reservation');
  let resumeResolved: unknown;
  let resumeCrash: unknown;
  try {
    resumeResolved = await executor.executeActivatedWorkflowNodeCall({
      activationId: resumeRoot.activationId,
      invocationPlan: resumable.plan,
      args: resumeCheckpoint.prepared.canonicalArgs as Record<string, unknown>,
    });
  } catch (error) {
    resumeCrash = error;
  }
  assert.match(String(resumeCrash), /after_physical_reservation/, JSON.stringify(resumeResolved));
  assert.equal(resumable.bodies(), 0);
  eventlog.closeEventLog();
  kernel.setWorkflowCallKernelCrashPointForTests(null);
  const resumed = await executor.executeActivatedWorkflowNodeCall({
    activationId: resumeRoot.activationId,
    invocationPlan: resumable.plan,
    args: resumeCheckpoint.prepared.canonicalArgs as Record<string, unknown>,
  });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumable.bodies(), 1);
  eventlog.closeEventLog();
  const replay = await executor.executeActivatedWorkflowNodeCall({
    activationId: resumeRoot.activationId,
    invocationPlan: resumable.plan,
    args: resumeCheckpoint.prepared.canonicalArgs as Record<string, unknown>,
  });
  assert.equal(replay.status, 'replayed', JSON.stringify(replay));
  assert.equal(resumable.bodies(), 1);

  const held = fixture({ label: 'hold-claimed' });
  const holdSession = eventlog.createSession({ id: 'workflow-v3-hold-claimed', kind: 'workflow' }).id;
  const holdCheckpoint = held.prepare();
  assert.equal(holdCheckpoint.kind, 'authority_checkpoint');
  if (holdCheckpoint.kind !== 'authority_checkpoint') return;
  const holdRoot = executor.activatePreparedWorkflowNodeCall({
    sessionId: holdSession,
    prepared: holdCheckpoint.prepared,
    proof: holdCheckpoint.proof,
    oneShotActivationAuthorization: exactAuthorization(holdSession, holdCheckpoint),
  });
  assert.equal(holdRoot.status, 'armed', JSON.stringify(holdRoot));
  if (holdRoot.status !== 'armed') return;
  held.installLive();
  kernel.setWorkflowCallKernelCrashPointForTests('after_io_claim');
  let holdResolved: unknown;
  let holdCrash: unknown;
  try {
    holdResolved = await executor.executeActivatedWorkflowNodeCall({
      activationId: holdRoot.activationId,
      invocationPlan: held.plan,
      args: holdCheckpoint.prepared.canonicalArgs as Record<string, unknown>,
    });
  } catch (error) {
    holdCrash = error;
  }
  assert.match(String(holdCrash), /after_io_claim/, JSON.stringify(holdResolved));
  assert.equal(held.bodies(), 0);
  eventlog.closeEventLog();
  kernel.setWorkflowCallKernelCrashPointForTests(null);
  const refused = await executor.executeActivatedWorkflowNodeCall({
    activationId: holdRoot.activationId,
    invocationPlan: held.plan,
    args: holdCheckpoint.prepared.canonicalArgs as Record<string, unknown>,
  });
  assert.equal(refused.status, 'blocked', JSON.stringify(refused));
  if (refused.status === 'blocked') {
    assert.equal(refused.reason, 'prior_crossing_unknown_no_redispatch');
    assert.equal(refused.zeroBody, false);
  }
  assert.equal(held.bodies(), 0, 'a claimed external write never blind-retries');
});

test('RED: admin remains non-executable until exact consent is atomically consumed with its root', () => {
  const installed = fixture({ label: 'admin-fail-closed', effect: 'admin' });
  const sessionId = eventlog.createSession({ id: 'workflow-v3-admin-fail-closed', kind: 'workflow' }).id;
  const checkpoint = installed.prepare();
  assert.equal(checkpoint.kind, 'authority_checkpoint', JSON.stringify(checkpoint));
  if (checkpoint.kind !== 'authority_checkpoint') return;
  const blocked = executor.activatePreparedWorkflowNodeCall({
    sessionId,
    prepared: checkpoint.prepared,
    proof: checkpoint.proof,
  });
  assert.equal(blocked.status, 'blocked');
  if (blocked.status === 'blocked') assert.equal(blocked.reason, 'exact_one_shot_authorization_required');

  const foreign = fixture({ label: 'admin-foreign-consent', effect: 'admin' }).prepare();
  assert.equal(foreign.kind, 'authority_checkpoint');
  if (foreign.kind !== 'authority_checkpoint') return;
  const foreignAuthorization = exactAuthorization(sessionId, foreign);
  const mismatched = executor.activatePreparedWorkflowNodeCall({
    sessionId,
    prepared: checkpoint.prepared,
    proof: checkpoint.proof,
    oneShotActivationAuthorization: foreignAuthorization,
  });
  assert.equal(mismatched.status, 'conflict');
  assert.equal(approvals.get(foreignAuthorization.approvalId)?.consumedAt, null);

  const before = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM workflow_v3_call_activation_bindings WHERE session_id = ?) AS activations,
      (SELECT COUNT(*) FROM accepted_turn_call_authorities WHERE session_id = ?) AS roots
  `).get(sessionId, sessionId) as { activations: number; roots: number };
  assert.deepEqual(before, { activations: 0, roots: 0 });

  const exact = exactAuthorization(sessionId, checkpoint);
  const armed = executor.activatePreparedWorkflowNodeCall({
    sessionId,
    prepared: checkpoint.prepared,
    proof: checkpoint.proof,
    oneShotActivationAuthorization: exact,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  assert.equal(approvals.get(exact.approvalId)?.consumedAt !== null, true);
  const after = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM workflow_v3_call_activation_bindings WHERE session_id = ?) AS activations,
      (SELECT COUNT(*) FROM accepted_turn_call_authorities WHERE session_id = ?) AS roots
  `).get(sessionId, sessionId) as { activations: number; roots: number };
  assert.deepEqual(after, { activations: 1, roots: 1 });
  assert.equal(installed.bodies(), 0);
});
