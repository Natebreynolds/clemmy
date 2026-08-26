/** Run: node scripts/run-tests-isolated.mjs src/execution/workflow-runner-v3-call.integration.red.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-runner-v3-call-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const runner = await import('./workflow-runner.js');
const plans = await import('../memory/workflow-node-invocation-plan.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const catalog = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const kernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const definitions = await import('./workflow-run-definition.js');
const validator = await import('./workflow-validator.js');
const workflowGraph = await import('./workflow-graph.js');
const workflowStore = await import('../memory/workflow-store.js');

import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import type { WorkflowNodeInvocationEffectV1 } from '../memory/workflow-node-invocation-plan.js';

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function fixture(label: string, effect: WorkflowNodeInvocationEffectV1 = 'host_only') {
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.${label}`,
    providerKind: 'local_registry',
    operationId: `operation.${label}`,
    providerIdentity: `runtime.${label}`,
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest(`schema.${label}`),
    effect,
    accountId: `account.${label}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'bounded_read',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'runner.v3.test', issuedAt: '2026-08-25T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['write'],
  });
  let bodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async () => {
        bodies += 1;
        return { records: [{ id: label }] };
      },
    },
  ).ok, true);
  const entry: catalog.RegisteredHostCapability = {
    capabilityId: `capability.${label}`,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => { throw new Error('catalog callback cannot own runner v3 I/O'); },
  };
  const identity = catalog.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: `requirement.${label}`,
    logicalCapabilityId: `logical.${label}`,
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
      effect: manifest.effect,
      invokePortId: identity.invokePortId,
      argumentCompiler: { ...identity.argumentCompiler },
    },
    arguments: {
      scope: { source: { kind: 'workflow_input', key: 'scope' }, required: true, type: 'string' },
    },
    evidence: { requiredPaths: ['records'], nonEmptyPaths: ['records'], minItems: { records: 1 } },
    completeness: { kind: 'terminal_result', evidencePaths: ['records'] },
    continuation: { kind: 'none' },
  });
  const step: WorkflowStepInput = {
    id: `step.${label}`,
    prompt: '',
    sideEffect: effect === 'read' || effect === 'host_only' ? 'read' : 'write',
    call: { tool: manifest.operationId, args: { scope: '{{input.scope}}' } },
    invocationPlan: plan,
  };
  const workflow: WorkflowDefinition = {
    name: `workflow.${label}`,
    description: 'Production-shaped exact structured call.',
    enabled: false,
    trigger: { manual: true },
    inputs: { scope: { type: 'string', required: true } },
    steps: [step],
  };
  catalog.installHostCapabilityCatalogFactory(catalog.createHostCapabilityCatalogFactory([entry]));
  assert.equal(observations.registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  const ctx = {
    workflow,
    workflowSlug: workflow.name,
    runId: `run.${label}`,
    inputs: { scope: 'exact' },
    stepOutputs: {},
    assistant: new Proxy({}, { get: () => { throw new Error('model/raw fallback was consulted'); } }),
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof runner.executeStep>[1];
  return { manifest, plan, step, workflow, ctx, bodies: () => bodies };
}

type InstalledFixture = ReturnType<typeof fixture>;

function exactSessionId(installed: InstalledFixture): string {
  return `workflow:${installed.ctx.runId}:${installed.step.id}`;
}

async function parkOnExactConsent(installed: InstalledFixture) {
  let parked: unknown;
  try {
    await runner.executeStep(installed.step, installed.ctx);
  } catch (error) {
    parked = error;
  }
  assert.ok(parked instanceof runner.ParkRunSignal, String(parked));
  const rows = approvals.listPending({ sessionId: exactSessionId(installed), status: 'pending' });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.tool, 'workflow_v3_call');
  assert.equal(row.args?.operationId, installed.plan.binding.operationId);
  assert.equal(row.args?.accountId, installed.plan.binding.accountId);
  assert.equal(row.args?.effect, installed.plan.binding.effect);
  assert.match(String(row.args?.authorityBindingDigest), /^[a-f0-9]{64}$/);
  assert.match(String(row.args?.canonicalArgumentDigest), /^[a-f0-9]{64}$/);
  return row;
}

function approve(row: Awaited<ReturnType<typeof parkOnExactConsent>>): void {
  const resolved = approvals.resolve(row.approvalId, 'approved', 'runner-v3-integration-test');
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
}

function adoptOccurrence(
  target: InstalledFixture,
  owner: InstalledFixture,
): void {
  target.step.id = owner.step.id;
  target.workflow.name = owner.workflow.name;
  target.workflow.steps = [target.step];
  target.ctx.workflow = target.workflow;
  target.ctx.workflowSlug = owner.ctx.workflowSlug;
  target.ctx.runId = owner.ctx.runId;
}

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
});

test('production structured host-safe call enters one exact v3 activation and replays one body', async () => {
  const installed = fixture('host-safe');
  const result = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(result, { records: [{ id: 'host-safe' }] });
  assert.equal(installed.bodies(), 1);
  const replay = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(replay, result);
  assert.equal(installed.bodies(), 1, 'settled exact result replays without a second body');
  const db = eventlog.openEventLog();
  const lineage = db.prepare(`
    SELECT a.workflow_id, a.workflow_revision, a.workflow_digest,
           a.run_id, a.run_occurrence_id, a.node_id, a.node_attempt,
           a.invocation_plan_digest, b.requirement_id, b.effect,
           root.authority_kind
      FROM workflow_node_invocation_activations a
      JOIN workflow_v3_call_activation_bindings b USING (activation_id)
      JOIN accepted_turn_call_authorities root
        ON root.workflow_activation_id = a.activation_id
     WHERE a.session_id = ?
  `).get(exactSessionId(installed)) as Record<string, unknown>;
  assert.equal(lineage.workflow_id, installed.ctx.workflowSlug);
  assert.equal(lineage.workflow_revision, 1);
  assert.equal(lineage.workflow_digest, definitions.workflowDefinitionHash(installed.workflow));
  assert.equal(lineage.run_id, installed.ctx.runId);
  assert.equal(lineage.run_occurrence_id, installed.ctx.runId);
  assert.equal(lineage.node_id, installed.step.id);
  assert.equal(lineage.node_attempt, 1);
  assert.equal(lineage.invocation_plan_digest, installed.plan.bindingDigest);
  assert.equal(lineage.requirement_id, installed.plan.requirementId);
  assert.equal(lineage.effect, 'host_only');
  assert.equal(lineage.authority_kind, 'workflow_v3_call');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM accepted_turn_call_authorities
     WHERE session_id = ? AND authority_kind = 'workflow_v3_call'
  `).get(exactSessionId(installed)) as { n: number }).n, 1);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?
  `).get(exactSessionId(installed)) as { n: number }).n, 1);
});

test('exact call+plan validates, survives persistence/graph compilation, and executes after reload', async () => {
  const installed = fixture('validated-persisted');
  const validation = validator.validateWorkflowDefinition(installed.workflow);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const compiled = workflowGraph.compileWorkflowStepsToGraph(installed.workflow.steps);
  const graphValidation = workflowGraph.validateWorkflowGraph(compiled);
  assert.equal(graphValidation.ok, true, graphValidation.errors.join('\n'));
  assert.equal(compiled.nodes[0]?.call?.tool, installed.plan.binding.operationId);
  assert.equal(compiled.nodes[0]?.invocationPlan?.bindingDigest, installed.plan.bindingDigest);

  const persisted = workflowStore.writeWorkflow(installed.workflow.name, installed.workflow);
  assert.equal(persisted.data.steps[0]?.call?.tool, installed.plan.binding.operationId);
  assert.equal(persisted.data.steps[0]?.invocationPlan?.bindingDigest, installed.plan.bindingDigest);
  const loadedStep = persisted.data.steps[0];
  const loadedCtx = {
    ...installed.ctx,
    workflow: persisted.data,
    workflowSlug: persisted.name,
  } as Parameters<typeof runner.executeStep>[1];
  const result = await runner.executeStep(loadedStep, loadedCtx);
  assert.deepEqual(result, { records: [{ id: 'validated-persisted' }] });
  assert.equal(installed.bodies(), 1);

  // Dropping the invocationPlan no longer refuses the step outright: it
  // downgrades from an exact v3 call to a bare call, which is its own valid,
  // gated dispatch lane (60db67d8 required an invocationPlan on every call;
  // restored — see executeWorkflowBareCallNode in workflow-runner.ts).
  const missingPlan = structuredClone(installed.workflow);
  delete missingPlan.steps[0].invocationPlan;
  const missingValidation = validator.validateWorkflowDefinition(missingPlan);
  assert.equal(missingValidation.ok, true, missingValidation.errors.join('\n'));

  const mismatched = structuredClone(installed.workflow);
  mismatched.steps[0].call!.tool = 'operation.not-the-plan';
  const mismatchValidation = validator.validateWorkflowDefinition(mismatched);
  assert.equal(mismatchValidation.ok, false);
  assert.ok(mismatchValidation.errors.some((error) => /must exactly match/.test(error)));

  const standaloneRead = structuredClone(installed.workflow);
  delete standaloneRead.steps[0].call;
  const readManifest = fixture('validated-standalone-read', 'read');
  standaloneRead.steps[0].invocationPlan = readManifest.plan;
  standaloneRead.steps[0].sideEffect = 'read';
  const standaloneValidation = validator.validateWorkflowDefinition(standaloneRead);
  assert.equal(standaloneValidation.ok, true, standaloneValidation.errors.join('\n'));

  const standaloneMutation = structuredClone(installed.workflow);
  delete standaloneMutation.steps[0].call;
  standaloneMutation.steps[0].sideEffect = 'read';
  const mutationValidation = validator.validateWorkflowDefinition(standaloneMutation);
  assert.equal(mutationValidation.ok, false);
  assert.ok(mutationValidation.errors.some((error) => /standalone invocationPlan effect must be read/.test(error)));
});

test('read call uses the shared read kernel, replays, and attributes its exact obligation', async () => {
  const installed = fixture('read', 'read');
  const first = await runner.executeStep(installed.step, installed.ctx);
  const replay = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(first, { records: [{ id: 'read' }] });
  assert.deepEqual(replay, first);
  assert.equal(installed.bodies(), 1);
  const db = eventlog.openEventLog();
  const settlement = db.prepare(`
    SELECT s.requirement_id, s.mutating, root.authority_kind
      FROM logical_call_settlements s
      JOIN accepted_turn_call_authorities root
        ON root.session_id = s.session_id
       AND root.source_user_seq = s.source_user_seq
     WHERE s.session_id = ?
  `).get(exactSessionId(installed)) as Record<string, unknown>;
  assert.equal(settlement.requirement_id, installed.plan.requirementId);
  assert.equal(settlement.mutating, 0);
  assert.equal(settlement.authority_kind, 'workflow_v1_read_only');
});

test('external write consumes exact consent atomically, attributes its obligation, and replays', async () => {
  const installed = fixture('write', 'external_write');
  const row = await parkOnExactConsent(installed);
  assert.equal(installed.bodies(), 0);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM workflow_v3_call_activation_bindings WHERE session_id = ?
  `).get(exactSessionId(installed)) as { n: number }).n, 0, 'pending consent is non-executable');
  approve(row);
  const result = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(result, { records: [{ id: 'write' }] });
  assert.equal(installed.bodies(), 1);
  assert.ok(approvals.get(row.approvalId)?.consumedAt, 'activation atomically consumes the exact grant');
  const replay = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(replay, result);
  assert.equal(installed.bodies(), 1);
  const db = eventlog.openEventLog();
  const settlement = db.prepare(`
    SELECT s.requirement_id, s.mutating, b.effect
      FROM logical_call_settlements s
      JOIN accepted_turn_call_authorities root
        ON root.session_id = s.session_id
       AND root.source_user_seq = s.source_user_seq
      JOIN workflow_v3_call_activation_bindings b
        ON b.activation_id = root.workflow_activation_id
     WHERE s.session_id = ?
  `).get(exactSessionId(installed)) as Record<string, unknown>;
  assert.equal(settlement.requirement_id, installed.plan.requirementId);
  assert.equal(settlement.mutating, 1);
  assert.equal(settlement.effect, 'external_write');
});

test('admin is zero-body and rootless until its exact approval is consumed with activation', async () => {
  const installed = fixture('admin', 'admin');
  const row = await parkOnExactConsent(installed);
  const db = eventlog.openEventLog();
  assert.equal(installed.bodies(), 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM accepted_turn_call_authorities
     WHERE session_id = ? AND authority_kind = 'workflow_v3_call'
  `).get(exactSessionId(installed)) as { n: number }).n, 0);
  approve(row);
  const result = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(result, { records: [{ id: 'admin' }] });
  assert.equal(installed.bodies(), 1);
  assert.ok(approvals.get(row.approvalId)?.consumedAt);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM accepted_turn_call_authorities
     WHERE session_id = ? AND authority_kind = 'workflow_v3_call'
  `).get(exactSessionId(installed)) as { n: number }).n, 1);
});

test('legacy name/args call and invalid exact identity refuse with zero body and no synthetic turn', async () => {
  const legacy = fixture('legacy-refused');
  delete legacy.step.invocationPlan;
  // Dropping the invocationPlan makes this a bare call — no exact compiler
  // proof exists for it, so it dispatches through the ordinary gated composio
  // gateway (executeWorkflowBareCallNode) instead of refusing outright
  // (60db67d8 required an invocationPlan on every call; restored). The
  // synthetic fixture tool has no real composio connection, so the gateway's
  // own prepared-definition gate refuses it before any provider dispatch —
  // proof the restored lane is GATED, not raw. Unlike an exact-kernel
  // refusal, the gateway lane mints its session/turn identity BEFORE
  // dispatch (pre-60db67d8 behavior), so a session now exists here.
  await assert.rejects(
    runner.executeStep(legacy.step, legacy.ctx),
    (error: unknown) => error instanceof runner.WorkflowCapabilityBlockedError,
  );
  assert.equal(legacy.bodies(), 0);
  assert.ok(eventlog.getSession(exactSessionId(legacy)));

  const invalid = fixture('identity-refused');
  invalid.ctx.workflowSlug = 'invalid workflow slug';
  await assert.rejects(
    runner.executeStep(invalid.step, invalid.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      && /invocation_identity_invalid|execution_identity_invalid/.test(error.reason),
  );
  assert.equal(invalid.bodies(), 0);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?
  `).get(exactSessionId(invalid)) as { n: number }).n, 0);
});

test('call-vs-plan and rendered-args drift refuse before any body', async () => {
  // Direction pin (2026-08-26): the restored bare-call lane must never become
  // an escape hatch for a step that HAS a plan. A stale/mismatched plan
  // refuses through the strict typed v3 kernel exactly as before — it must
  // never silently fall back to the gated composio gateway.
  let gatewayReached = false;
  runner._setBeforeWorkflowCallGatewayForTests(() => { gatewayReached = true; });
  try {
    const toolDrift = fixture('tool-drift');
    toolDrift.step.call!.tool = 'operation.foreign';
    await assert.rejects(
      runner.executeStep(toolDrift.step, toolDrift.ctx),
      (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
        && /operation_drift/.test(error.reason),
    );
    assert.equal(toolDrift.bodies(), 0);
    assert.equal(gatewayReached, false, 'a step with an invocationPlan must never fall back to bare dispatch');
  } finally {
    runner._setBeforeWorkflowCallGatewayForTests(null);
  }

  const argsDrift = fixture('args-source-drift');
  argsDrift.step.call!.args = { scope: 'not-the-typed-source' };
  await assert.rejects(
    runner.executeStep(argsDrift.step, argsDrift.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      && /argument_drift/.test(error.reason),
  );
  assert.equal(argsDrift.bodies(), 0);
});

test('same occurrence refuses changed args, account/plan, and effect without another body or root', async () => {
  const owner = fixture('drift-owner');
  await runner.executeStep(owner.step, owner.ctx);
  assert.equal(owner.bodies(), 1);

  owner.ctx.inputs.scope = 'changed-after-activation';
  await assert.rejects(
    runner.executeStep(owner.step, owner.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      && /activation_conflict/.test(error.reason),
  );
  assert.equal(owner.bodies(), 1, 'argument drift cannot open a second physical call');
  owner.ctx.inputs.scope = 'exact';

  const accountPlanDrift = fixture('drift-account', 'host_only');
  adoptOccurrence(accountPlanDrift, owner);
  assert.notEqual(accountPlanDrift.plan.binding.accountId, owner.plan.binding.accountId);
  await assert.rejects(
    runner.executeStep(accountPlanDrift.step, accountPlanDrift.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      && /activation_conflict/.test(error.reason),
  );
  assert.equal(accountPlanDrift.bodies(), 0);

  const effectDrift = fixture('drift-effect', 'external_write');
  adoptOccurrence(effectDrift, owner);
  const approval = await parkOnExactConsent(effectDrift);
  approve(approval);
  await assert.rejects(
    runner.executeStep(effectDrift.step, effectDrift.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      && /activation_conflict/.test(error.reason),
  );
  assert.equal(effectDrift.bodies(), 0);
  assert.equal(approvals.get(approval.approvalId)?.consumedAt, null, 'conflicting root leaves consent unconsumed');

  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM accepted_turn_call_authorities
     WHERE session_id = ? AND authority_kind = 'workflow_v3_call'
  `).get(exactSessionId(owner)) as { n: number }).n, 1);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?
  `).get(exactSessionId(owner)) as { n: number }).n, 1);
});

test('not-started external write resumes after restart and settled output then replays', async () => {
  const installed = fixture('resume-not-started', 'external_write');
  const row = await parkOnExactConsent(installed);
  approve(row);
  kernel.setWorkflowCallKernelCrashPointForTests('after_physical_reservation');
  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    /after_physical_reservation/,
  );
  assert.equal(installed.bodies(), 0);
  eventlog.closeEventLog();
  kernel.setWorkflowCallKernelCrashPointForTests(null);
  const resumed = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(resumed, { records: [{ id: 'resume-not-started' }] });
  assert.equal(installed.bodies(), 1);
  eventlog.closeEventLog();
  const replay = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(replay, resumed);
  assert.equal(installed.bodies(), 1);
});

test('claimed external write restart holds for reconciliation and never blind-retries', async () => {
  const installed = fixture('hold-claimed', 'external_write');
  const row = await parkOnExactConsent(installed);
  approve(row);
  kernel.setWorkflowCallKernelCrashPointForTests('after_io_claim');
  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    /after_io_claim/,
  );
  assert.equal(installed.bodies(), 0);
  eventlog.closeEventLog();
  kernel.setWorkflowCallKernelCrashPointForTests(null);
  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessHeldSignal
      && error.state.hold.wake === 'recovery'
      && error.state.sourceStatus === 'dispatched',
  );
  assert.equal(installed.bodies(), 0, 'claimed write cannot be redispatched by the runner');
});

test('structured call source contains no direct Composio dispatch or synthetic identity fallback', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/execution/workflow-runner.ts'), 'utf8');
  const start = source.indexOf('async function executeWorkflowCallNode(');
  const end = source.indexOf('/** Redeem every exact scheduled-send projection', start);
  assert.ok(start >= 0 && end > start);
  const lane = source.slice(start, end);
  assert.doesNotMatch(lane, /dispatchComposioTool|ensureWorkflowCallIdentity|withHarnessRunContext|executeWorkflowCallMutation/);
});
