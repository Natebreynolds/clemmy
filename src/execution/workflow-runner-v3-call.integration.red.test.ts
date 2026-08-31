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
const workflowEvents = await import('./workflow-events.js');
const workflowQueue = await import('../tools/workflow-run-queue.js');
const composioSchemas = await import('../tools/composio-schema-cache.js');

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

/**
 * Same production-shaped fixture as `fixture()` above, but the step carries
 * NO invocationPlan — the owner's own salesforce-quarterly-to-sheets shape
 * (a bare GOOGLESHEETS_BATCH_UPDATE call). Proves compileWorkflowBareCall
 * InvocationPlan resolves the identical live catalog entry a plan-carrying
 * step would have been authored against, and that the compiled plan then
 * rides the exact same executeExactWorkflowV3CallNode path.
 */
function bareFixture(
  label: string,
  effect: WorkflowNodeInvocationEffectV1 = 'external_write',
  opts?: {
    requiresApproval?: boolean;
    operationId?: string;
    providerResult?: unknown;
    providerErrorAfterBody?: string;
  },
) {
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.${label}`,
    providerKind: 'local_registry',
    operationId: opts?.operationId ?? `operation.${label}`,
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
  const providerArgs: Array<Record<string, unknown>> = [];
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async (input) => {
        bodies += 1;
        providerArgs.push(structuredClone(input.binding.args));
        if (opts?.providerErrorAfterBody) throw new Error(opts.providerErrorAfterBody);
        // compileWorkflowBareCallInvocationPlan hardcodes evidencePaths:
        // ['data'] (the composio-shaped {data: ...} convention
        // acquireWorkflowReadOnlyOperationAuthority's own plans use), unlike
        // fixture()'s plan-carrying manifest above which declares its own
        // evidence contract over 'records'.
        return structuredClone(opts?.providerResult ?? { data: { id: label } });
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
  const step: WorkflowStepInput = {
    id: `step.${label}`,
    prompt: '',
    sideEffect: effect === 'read' || effect === 'host_only' ? 'read' : 'write',
    ...(opts?.requiresApproval ? { requiresApproval: true } : {}),
    // No invocationPlan — this is the bare shape.
    call: { tool: manifest.operationId, args: { scope: '{{input.scope}}' } },
  };
  const workflow: WorkflowDefinition = {
    name: `workflow.${label}`,
    description: 'Bare structured call, compiled from the live catalog at execution.',
    enabled: false,
    trigger: { manual: true },
    inputs: { scope: { type: 'string', required: true } },
    steps: [step],
  };
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
  return { manifest, entry, step, workflow, ctx, bodies: () => bodies, providerArgs };
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
  composioSchemas.resetToolSchemaCache();
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
  // downgrades from a persisted exact plan to a bare call. Runtime compiles a
  // fresh exact plan from the live catalog, then uses the same v3 kernel.
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

test('dropped-invocationPlan call converges (compiled from the live catalog) and invalid exact identity refuses with zero body', async () => {
  const legacy = fixture('legacy-refused');
  delete legacy.step.invocationPlan;
  // Dropping the invocationPlan makes this a bare call. It used to dispatch
  // through a separate gateway and refuse there for lack of a real composio
  // connection, minting a
  // FABRICATED user_input_received turn on the way (pre-2026-08-26
  // convergence). Now it compiles its own invocation plan from the live
  // catalog at execution (compileLiveCatalogWorkflowCallPlan) and rides
  // the exact same kernel a plan-carrying call uses — this fixture's
  // operation IS registered (fixture() installs it), so it DISPATCHES for
  // real, with the kernel's own real activation lineage and no chat turn.
  const result = await runner.executeStep(legacy.step, legacy.ctx);
  assert.deepEqual(result, { records: [{ id: 'legacy-refused' }] });
  assert.equal(legacy.bodies(), 1);
  assert.ok(eventlog.getSession(exactSessionId(legacy)));
  assert.equal(eventlog.listEvents(exactSessionId(legacy), { types: ['user_input_received'] }).length, 0);

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

test('bare call refuses live effect escalation before consent, activation, or provider I/O', async () => {
  const installed = bareFixture('bare-effect-escalation', 'external_write');
  installed.step.sideEffect = 'read';

  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      // Matches the REASON, not one wording of it: an authored read that
      // resolves to a live write must be refused as an escalation. The gate was
      // narrowed to refuse escalation ONLY (a live effect smaller than declared
      // is safer than what was approved), so the message names escalation
      // explicitly and no longer conflates it with 'drift'.
      && /escalation refused/i.test(error.reason)
      && /MORE effect than was declared/i.test(error.reason),
  );
  assert.equal(installed.bodies(), 0);
  const sessionId = `workflow:${installed.ctx.runId}:${installed.step.id}`;
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM workflow_node_invocation_activations WHERE session_id = ?
  `).get(sessionId) as { n: number }).n, 0);
  assert.equal(approvals.listPending({ sessionId, status: 'any' }).length, 0);
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
  assert.doesNotMatch(source, /async function executeWorkflowBareCallNode\(/);
  assert.doesNotMatch(source, /async function ensureWorkflowCallIdentity\(/);
  const start = source.indexOf('async function executeWorkflowCallNode(');
  const end = source.indexOf('/** Redeem every exact scheduled-send projection', start);
  assert.ok(start >= 0 && end > start);
  const lane = source.slice(start, end);
  assert.doesNotMatch(lane, /dispatchComposioTool|ensureWorkflowCallIdentity|withHarnessRunContext|executeWorkflowCallMutation/);
});

// ─── Bare-call convergence (2026-08-26) ────────────────────────────────
// ff05c19a restored bare-call dispatch through the gated composio gateway,
// but that gateway lane minted its own identity by appending a FABRICATED
// user_input_received event purely to satisfy the settlement spine — two
// execution kernels for one concept. These pins prove the replacement: a
// bare call compiles its own invocation plan from the live catalog at
// execution (compileWorkflowBareCallInvocationPlan — the same live-catalog-
// resolution precedent space-read-authority.ts already uses for workspace
// reads) and then rides the identical executeExactWorkflowV3CallNode path a
// plan-carrying step has always used. No chat turn is minted for this lane.

test('BARE CALL CONSENT — an ungated bare mutation waits on one exact v3 approval, then executes once and replays without a second body', async () => {
  const installed = bareFixture('bare-owner-write', 'external_write');
  const sessionId = `workflow:${installed.ctx.runId}:${installed.step.id}`;

  let parked: unknown;
  try {
    await runner.executeStep(installed.step, installed.ctx);
  } catch (error) {
    parked = error;
  }
  assert.ok(parked instanceof runner.ParkRunSignal, String(parked));
  assert.equal(installed.bodies(), 0, 'no provider body runs before exact human consent');

  const pending = approvals.listPending({ sessionId, status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, 'workflow_v3_call');
  assert.equal(pending[0].args?.operationId, installed.manifest.operationId);
  assert.equal(pending[0].args?.accountId, installed.manifest.accountId);
  assert.equal(pending[0].args?.effect, 'external_write');
  assert.equal(pending[0].resolution, null);
  assert.equal(pending[0].resolver, null);

  const approved = approvals.resolve(pending[0].approvalId, 'approved', 'runner-v3-integration-test');
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const result = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(result, { data: { id: 'bare-owner-write' } });
  assert.equal(installed.bodies(), 1);

  // No fabricated chat turn — this is the fix's whole point. The old
  // ensureWorkflowCallIdentity appended a synthetic user_input_received
  // ("Workflow step X: execute SLUG") to satisfy the settlement spine; the
  // converged kernel needs no chat turn at all.
  assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] }).length, 0);

  // Real lineage instead: the same durable activation row a plan-carrying
  // call produces (see the 'production structured host-safe call' pin above).
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM workflow_node_invocation_activations WHERE session_id = ?
  `).get(sessionId) as { n: number }).n, 1);

  // The exact grant is the human-resolved row above. Merely compiling a saved
  // workflow call is not user/workflow activation authority, so this lane must
  // never manufacture `system:workflow-autonomous_default_mutation` consent.
  const grants = approvals.listPending({ sessionId, status: 'any' });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].resolution, 'approved');
  assert.equal(grants[0].resolver, 'runner-v3-integration-test');
  assert.ok(grants[0].consumedAt);

  // Replays without a second body, exactly like a plan-carrying call.
  const replay = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(replay, result);
  assert.equal(installed.bodies(), 1, 'settled exact result replays without a second body');
});

test('BARE CALL RECOVERY — a mutating body that commits then loses its response is reconciliation-held and never redispatched', async () => {
  const installed = bareFixture('bare-lost-response', 'external_write', {
    providerErrorAfterBody: 'response channel closed after provider commit',
  });
  const sessionId = `workflow:${installed.ctx.runId}:${installed.step.id}`;

  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    (error: unknown) => error instanceof runner.ParkRunSignal,
  );
  const pending = approvals.listPending({ sessionId, status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(approvals.resolve(pending[0]!.approvalId, 'approved', 'runner-v3-integration-test').ok, true);

  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessHeldSignal
      && error.state.hold.wake === 'recovery'
      && error.state.sourceStatus === 'dispatched',
  );
  assert.equal(installed.bodies(), 1, 'the unacknowledged mutation body crossed once');

  const db = eventlog.openEventLog();
  const durable = db.prepare(`
    SELECT settlement.outcome_kind,
           settlement.requires_reconciliation,
           authority.state AS authority_state,
           physical.state AS physical_state
      FROM workflow_node_invocation_activations activation
      JOIN accepted_turn_call_authorities authority
        ON authority.workflow_activation_id = activation.activation_id
      JOIN logical_call_settlements settlement
        ON settlement.session_id = activation.session_id
       AND settlement.source_user_seq = activation.source_event_seq
       AND settlement.logical_tool_call_id = activation.logical_call_id
      JOIN physical_dispatches physical
        ON physical.session_id = activation.session_id
       AND physical.source_user_seq = activation.source_event_seq
       AND physical.logical_tool_call_id = activation.logical_call_id
       AND physical.relation != 'probe'
     WHERE activation.session_id = ?
  `).get(sessionId) as Record<string, unknown>;
  assert.equal(durable.outcome_kind, 'uncertain_write');
  assert.equal(durable.requires_reconciliation, 1);
  assert.equal(durable.authority_state, 'open', 'recovery authority remains open');
  assert.equal(durable.physical_state, 'threw');

  eventlog.closeEventLog();
  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessHeldSignal
      && error.state.hold.wake === 'recovery',
  );
  assert.equal(installed.bodies(), 1, 'durable reentry never repeats the provider mutation');
});

test('BARE CALL CONSENT — a durable queue source string is presentation metadata, not mutation authority', async () => {
  const installed = bareFixture('bare-source-string-nonauthority', 'external_write');
  installed.workflow.enabled = true;
  workflowStore.writeWorkflow(installed.workflow.name, installed.workflow);
  const queued = workflowQueue.queueWorkflowRun(
    installed.workflow.name,
    installed.ctx.inputs,
    { source: 'mobile', dedupe: false },
  );
  assert.equal(queued.status, 'queued', queued.message);
  assert.ok(queued.id);
  installed.ctx.runId = queued.id!;
  const sessionId = `workflow:${installed.ctx.runId}:${installed.step.id}`;

  let parked: unknown;
  try {
    await runner.executeStep(installed.step, installed.ctx);
  } catch (error) {
    parked = error;
  }
  assert.ok(parked instanceof runner.ParkRunSignal, String(parked));
  assert.equal(installed.bodies(), 0);
  const pending = approvals.listPending({ sessionId, status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].resolution, null);
  assert.equal(pending[0].resolver, null);
  assert.equal(
    approvals.listPending({ sessionId, status: 'any' })
      .some((row) => row.resolver === 'system:workflow-autonomous_default_mutation'),
    false,
  );
});

test('BARE CALL CONSENT — exact scheduled-send authority still crosses once and settled replay adds zero bodies', async () => {
  const providerResult = { data: { receipt_id: 'raw-provider-only' } };
  const installed = bareFixture('bare-exact-scheduled-send', 'external_write', {
    operationId: 'CHATCO_SEND_MESSAGE',
    providerResult,
  });
  installed.step.sideEffect = 'send';
  installed.step.call!.args = {
    destination: 'fixed-destination',
    body: 'Fixed scheduled payload.',
  };
  installed.step.output = {
    type: 'object',
    required_keys: ['providerResult', 'callEvidence'],
    non_empty: [
      'providerResult.kind',
      'providerResult.resultId',
      'providerResult.digest',
      'callEvidence.evidenceId',
      'callEvidence.mutationReceiptId',
      'callEvidence.canonicalTool',
      'callEvidence.kind',
      'callEvidence.status',
      'callEvidence.dispatchSchemaFingerprint',
      'callEvidence.expectedArgsDigest',
      'callEvidence.providerReadyArgsDigest',
      'callEvidence.providerResultDigest',
      'callEvidence.payloadDigest',
      'callEvidence.target.digest',
    ],
  };
  installed.workflow.enabled = true;
  installed.workflow.allowSends = true;
  installed.workflow.trigger = { schedule: '0 9 * * 1-5', timezone: 'UTC' };
  installed.workflow.inputs = {};
  installed.workflow.steps = [installed.step];
  installed.ctx.inputs = {};

  composioSchemas.rememberToolSchema('CHATCO_SEND_MESSAGE', {
    type: 'object',
    required: ['destination', 'body'],
    properties: {
      destination: { type: 'string' },
      body: { type: 'string' },
    },
  }, Date.now());
  const persisted = workflowStore.writeWorkflow(installed.workflow.name, installed.workflow);
  installed.ctx.workflow = persisted.data;
  installed.ctx.workflowSlug = persisted.name;
  const occurrenceAtMs = 1_785_000_720_000;
  const queued = workflowQueue.queueWorkflowRun(persisted.data.name, {}, {
    source: 'schedule',
    workflowSlug: persisted.name,
    triggerReceiptId: `workflow-schedule:v1:${persisted.name}:${occurrenceAtMs}`,
    dedupe: false,
  });
  assert.equal(queued.status, 'queued', queued.message);
  assert.ok(queued.id);
  installed.ctx.runId = queued.id!;
  const sessionId = `workflow:${installed.ctx.runId}:${installed.step.id}`;

  const result = await runner.executeStep(installed.step, installed.ctx) as {
    providerResult: { kind: string; resultId: string; digest: string };
    callEvidence: { kind: string; mutationReceiptId: string; providerResultDigest: string };
  };
  assert.equal(result.providerResult.kind, 'workflow_call_provider_result');
  assert.match(result.providerResult.resultId, /^workflow-call-result:v1:[a-f0-9]{64}$/);
  assert.equal(result.providerResult.digest, result.callEvidence.providerResultDigest);
  assert.equal(result.callEvidence.kind, 'workflow_call_commit');
  assert.match(result.callEvidence.mutationReceiptId, /^workflow-v3-call:v1:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('raw-provider-only'), false);
  assert.equal(installed.bodies(), 1);
  const grants = approvals.listPending({ sessionId, status: 'any' });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].resolver, 'system:workflow-scheduled_send_authority');
  assert.ok(grants[0].consumedAt);

  const replay = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(replay, result);
  assert.equal(installed.bodies(), 1, 'the exact scheduled occurrence replays its settlement');
});

test('BARE CALL CONVERGENCE — a bare read compiles and executes through the shared kernel with zero consent friction', async () => {
  // GET is affirmative read evidence; a slug ending in READ is deliberately
  // treated as a possible state mutation (for example MARK_AS_READ).
  const installed = bareFixture('get-bare-records', 'read');
  const sessionId = `workflow:${installed.ctx.runId}:${installed.step.id}`;
  const result = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(result, { data: { id: 'get-bare-records' } });
  assert.equal(installed.bodies(), 1);
  assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] }).length, 0);
  assert.equal(approvals.listPending({ sessionId, status: 'any' }).length, 0, 'a read needs no consent grant, autonomous or otherwise');
});

test('BARE CALL CONVERGENCE — forEach reads own distinct ordinal-bound v3 occurrences and replay zero provider bodies', async () => {
  const installed = bareFixture('get-partitioned-records', 'read');
  installed.step.forEach = 'source';
  installed.step.dependsOn = ['source'];
  installed.step.call!.args = { scope: '{{item.scope}}' };
  installed.ctx.stepOutputs = {
    source: [
      { id: 'shared-display-key', scope: 'north' },
      { id: 'shared-display-key', scope: 'south' },
    ],
  };

  const first = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(
    installed.providerArgs.map((args) => args.scope).sort(),
    ['north', 'south'],
  );
  assert.equal(installed.bodies(), 2);
  assert.equal(Array.isArray(first), true);

  const db = eventlog.openEventLog();
  const occurrences = db.prepare(`
    SELECT session_id, run_occurrence_id, node_id, node_attempt, logical_call_id
      FROM workflow_node_invocation_activations
     WHERE workflow_id = ? AND run_id = ?
     ORDER BY node_id
  `).all(installed.ctx.workflowSlug, installed.ctx.runId) as Array<Record<string, unknown>>;
  assert.equal(occurrences.length, 2);
  assert.equal(new Set(occurrences.map((row) => row.session_id)).size, 2);
  assert.equal(new Set(occurrences.map((row) => row.node_id)).size, 2);
  assert.equal(new Set(occurrences.map((row) => row.logical_call_id)).size, 2);
  assert.deepEqual(new Set(occurrences.map((row) => row.run_occurrence_id)), new Set([installed.ctx.runId]));
  assert.deepEqual(new Set(occurrences.map((row) => row.node_attempt)), new Set([1]));
  for (const occurrence of occurrences) {
    assert.equal(
      eventlog.listEvents(String(occurrence.session_id), { types: ['user_input_received'] }).length,
      0,
      'a partition is a host-derived workflow occurrence, not a fabricated chat turn',
    );
  }

  eventlog.closeEventLog();
  const durableResume = workflowEvents.computeResumeState(
    installed.ctx.workflowSlug,
    installed.ctx.runId,
  );
  installed.ctx.completedItems = durableResume.completedItems.get(installed.step.id) ?? new Map();
  assert.equal(installed.ctx.completedItems.size, 2, 'duplicate display keys retain two durable partition completions');
  const replay = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(replay, first);
  assert.equal(installed.bodies(), 2, 'both settled partitions replay after the durable store is reopened');
});

test('BARE CALL CONVERGENCE — a logically settled forEach read resumes after restart without another provider body', async () => {
  const installed = bareFixture('get-partition-crash-replay', 'read');
  installed.step.forEach = 'source';
  installed.step.dependsOn = ['source'];
  installed.step.call!.args = { scope: '{{item.scope}}' };
  installed.ctx.stepOutputs = { source: [{ id: 'one', scope: 'only' }] };

  kernel.setWorkflowCallKernelCrashPointForTests('after_logical_settlement');
  const interrupted = await runner.executeStep(installed.step, installed.ctx) as {
    blocked?: unknown;
    failed_items?: Array<{ error?: unknown }>;
  };
  assert.equal(interrupted.blocked, true);
  assert.match(String(interrupted.failed_items?.[0]?.error), /after_logical_settlement/);
  assert.equal(installed.bodies(), 1);

  eventlog.closeEventLog();
  const resumed = await runner.executeStep(installed.step, installed.ctx);
  assert.equal(Array.isArray(resumed), true);
  assert.equal(installed.bodies(), 1, 'restart reuses the exact logical settlement for this partition');
});

test('BARE CALL CONSENT — requiresApproval without a declarative gate refuses before grant, activation, or provider body', async () => {
  const installed = bareFixture('bare-approval-ungated', 'external_write', { requiresApproval: true });
  installed.step.sideEffect = 'send';
  const sessionId = `workflow:${installed.ctx.runId}:${installed.step.id}`;
  assert.equal(
    runner.workflowRunnerInternalsForTest.shouldUseDeclarativeStepApproval(installed.workflow, installed.step),
    false,
    'fixture must exercise the missing-gate branch rather than a rejected human decision',
  );

  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      && /requires_approval_gate_missing/.test(error.reason),
  );
  assert.equal(installed.bodies(), 0);
  assert.equal(approvals.listPending({ sessionId, status: 'any' }).length, 0);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM workflow_node_invocation_activations WHERE session_id = ?
  `).get(sessionId) as { n: number }).n, 0);
});

test('BARE CALL CONVERGENCE — a bare call requiring approval is gated once by the runner\'s existing declarative gate, then dispatches with no second v3 prompt', async () => {
  // requiresApproval on a bare call is gated BEFORE executeWorkflowCallNode
  // is ever reached, by executeStep's own pre-existing declarative gate
  // (shouldUseDeclarativeStepApproval / awaitDeclarativeStepApproval) —
  // unchanged by this convergence. Asking the v3 kernel's own consent
  // primitive a SECOND time for the same step would be a redundant double
  // approval, so resolveWorkflowBareCallV3Consent mints the kernel's grant
  // itself once the declarative gate has already resolved, naming that gate
  // as the policy — it never re-invokes awaitExactWorkflowV3Authorization.
  const installed = bareFixture('bare-requires-approval', 'external_write', { requiresApproval: true });
  const gateSessionId = `workflow-gate:${installed.ctx.runId}:${installed.step.id}`;
  const v3SessionId = `workflow:${installed.ctx.runId}:${installed.step.id}`;
  let parked: unknown;
  try {
    await runner.executeStep(installed.step, installed.ctx);
  } catch (error) {
    parked = error;
  }
  assert.ok(parked instanceof runner.ParkRunSignal, String(parked));
  const gateRows = approvals.listPending({ sessionId: gateSessionId, status: 'pending' });
  assert.equal(gateRows.length, 1);
  assert.equal(gateRows[0].tool, 'workflow_approval_gate');
  assert.equal(installed.bodies(), 0, 'no body runs while the declarative gate is pending');
  assert.equal(approvals.listPending({ sessionId: v3SessionId, status: 'any' }).length, 0, 'no v3 grant exists yet — the declarative gate has not resolved');

  const resolved = approvals.resolve(gateRows[0].approvalId, 'approved', 'runner-v3-integration-test');
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const result = await runner.executeStep(installed.step, installed.ctx);
  assert.deepEqual(result, { data: { id: 'bare-requires-approval' } });
  assert.equal(installed.bodies(), 1);

  // Exactly one v3 grant exists, minted (not asked) after the declarative
  // gate resolved — never a second human-facing prompt.
  const v3Grants = approvals.listPending({ sessionId: v3SessionId, status: 'any' });
  assert.equal(v3Grants.length, 1);
  assert.equal(v3Grants[0].resolution, 'approved');
  assert.equal(v3Grants[0].resolver, 'system:workflow-declarative_gate_approved');
  assert.ok(v3Grants[0].consumedAt);
});

test('BARE CALL CONVERGENCE — an operation absent from the live catalog refuses by name and never dispatches', async () => {
  catalog.installHostCapabilityCatalogFactory(catalog.createHostCapabilityCatalogFactory([]));
  const step: WorkflowStepInput = {
    id: 'step.unregistered',
    prompt: '',
    sideEffect: 'write',
    call: { tool: 'OPERATION_NEVER_REGISTERED', args: {} },
  };
  const workflow: WorkflowDefinition = {
    name: 'workflow.unregistered-bare-call',
    description: '',
    enabled: false,
    trigger: { manual: true },
    inputs: {},
    steps: [step],
  };
  const ctx = {
    workflow,
    workflowSlug: workflow.name,
    runId: 'run.unregistered',
    inputs: {},
    stepOutputs: {},
    assistant: new Proxy({}, { get: () => { throw new Error('model/raw fallback was consulted'); } }),
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof runner.executeStep>[1];
  await assert.rejects(
    runner.executeStep(step, ctx),
    (error: unknown) => error instanceof runner.WorkflowCapabilityBlockedError
      && error.reason === 'not-connected'
      && error.tool === 'OPERATION_NEVER_REGISTERED'
      && /OPERATION_NEVER_REGISTERED/.test(error.message),
  );
});

test('BARE CALL CONVERGENCE — an operation ambiguous in the live catalog refuses by name and never dispatches', async () => {
  const installed = bareFixture('bare-ambiguous', 'external_write');
  const primary = catalog.peekHostCapabilityCatalogFactory()!.snapshot()[0]!;
  const duplicate: catalog.RegisteredHostCapability = {
    ...primary,
    capabilityId: `${primary.capabilityId}.duplicate`,
    account: 'account.bare-ambiguous.duplicate',
  };
  catalog.installHostCapabilityCatalogFactory(catalog.createHostCapabilityCatalogFactory([primary, duplicate]));
  await assert.rejects(
    runner.executeStep(installed.step, installed.ctx),
    (error: unknown) => error instanceof runner.WorkflowCapabilityBlockedError
      && error.reason === 'ambiguous-account'
      && /operation\.bare-ambiguous/.test(error.message),
  );
  assert.equal(installed.bodies(), 0);
});

test('BARE CALL ACCOUNT GATE — choosing B dispatches only B and restart replay does not duplicate it', async () => {
  const operationId = 'operation.account-choice';
  const accountA = bareFixture('account-choice-a', 'read', { operationId });
  const accountB = bareFixture('account-choice-b', 'read', { operationId });
  catalog.installHostCapabilityCatalogFactory(
    catalog.createHostCapabilityCatalogFactory([accountA.entry, accountB.entry]),
  );

  let blocked: InstanceType<typeof runner.WorkflowCapabilityBlockedError> | undefined;
  try {
    await runner.executeStep(accountA.step, accountA.ctx);
  } catch (error) {
    if (error instanceof runner.WorkflowCapabilityBlockedError) blocked = error;
    else throw error;
  }
  assert.ok(blocked, 'two current accounts must park before any body');
  assert.equal(blocked.reason, 'ambiguous-account');
  assert.deepEqual(blocked.accountChoiceSet?.candidates, [
    { capabilityId: accountA.entry.capabilityId, accountId: accountA.manifest.accountId },
    { capabilityId: accountB.entry.capabilityId, accountId: accountB.manifest.accountId },
  ]);
  assert.equal(accountA.bodies(), 0);
  assert.equal(accountB.bodies(), 0);

  const choiceSet = blocked.accountChoiceSet!;
  const selectedBCtx = {
    ...accountA.ctx,
    capabilityResume: {
      stepId: accountA.step.id,
      tool: operationId,
      toolkit: 'operation',
      reason: 'ambiguous-account',
      message: blocked.message,
      blockedAt: '2026-08-30T18:00:00.000Z',
      retryAt: '2026-08-30T18:01:00.000Z',
      retryCount: 1,
      provenNoDispatch: true,
      state: 'retrying',
      accountChoiceSet: choiceSet,
      accountSelection: {
        capabilityId: accountB.entry.capabilityId,
        accountId: accountB.manifest.accountId,
        choiceSetDigest: choiceSet.digest,
        selectedAt: '2026-08-30T18:00:05.000Z',
        selectedBy: 'chat:test-user-choice',
      },
    },
  } as Parameters<typeof runner.executeStep>[1];

  const result = await runner.executeStep(accountA.step, selectedBCtx);
  assert.deepEqual(result, { data: { id: 'account-choice-b' } });
  assert.equal(accountA.bodies(), 0, 'account A must never dispatch after B was chosen');
  assert.equal(accountB.bodies(), 1);

  // Close/reopen the durable kernel to model a daemon restart. Settlement
  // replay returns B's exact result and does not cross either provider again.
  eventlog.closeEventLog();
  const replay = await runner.executeStep(accountA.step, selectedBCtx);
  assert.deepEqual(replay, result);
  assert.equal(accountA.bodies(), 0);
  assert.equal(accountB.bodies(), 1);
});
