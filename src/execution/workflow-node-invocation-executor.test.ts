/** Run: node scripts/run-tests-isolated.mjs src/execution/workflow-node-invocation-executor.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-read-executor-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const {
  bindPreparedWorkflowNodeCallAuthority,
  executeWorkflowNodeRead,
  prepareWorkflowNodeCall,
  prepareWorkflowNodeRead,
  workflowNodeCallAuthorityProofOwnsPrepared,
} = await import('./workflow-node-invocation-executor.js');
const {
  createWorkflowNodeInvocationPlan,
  workflowNodeReviewedLiteralDigest,
} = await import('../memory/workflow-node-invocation-plan.js');
const {
  canonicalCatalogIdentityOf,
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
} = await import('../runtime/harness/host-capability-catalog-factory.js');
const {
  attachSemanticContract,
  capabilityManifestDigest,
} = await import('../runtime/harness/capability-manifest.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const resultFacts = await import('../runtime/harness/result-facts.js');
import type { WorkflowNodeReadExecutionIdentityV1 } from './workflow-node-invocation-executor.js';
import type {
  WorkflowNodeArgumentBindingV1,
  WorkflowNodeInvocationEffectV1,
  WorkflowNodeInvocationPlanV1,
} from '../memory/workflow-node-invocation-plan.js';
import type {
  HostCapabilityCatalogFactory,
  RegisteredHostCapability,
} from '../runtime/harness/host-capability-catalog-factory.js';
import type { CapabilityManifestV1 } from '../runtime/harness/capability-manifest.js';
import type { IndependentCapabilityObservation } from '../runtime/harness/independent-capability-observation.js';
import type { GraphNodeCapabilityInvoke } from '../runtime/harness/graph-node-capability.js';

test.after(() => {
  installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.afterEach(() => {
  installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
});

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

function manifest(input: {
  manifestId?: string;
  operationId?: string;
  operationVersion?: string;
  definitionFingerprint?: string;
  accountId?: string;
  effect?: WorkflowNodeInvocationEffectV1;
  delegatedFrom?: string;
} = {}): CapabilityManifestV1 {
  return attachSemanticContract({
    version: 1,
    manifestId: input.manifestId ?? 'manifest.alpha',
    providerKind: 'local_registry',
    operationId: input.operationId ?? 'operation.alpha',
    providerIdentity: 'runtime.alpha',
    providerVersion: 'runtime.1',
    operationVersion: input.operationVersion ?? '1',
    definitionFingerprint: input.definitionFingerprint ?? digest('schema.alpha'),
    effect: input.effect ?? 'read',
    accountId: input.accountId ?? 'account.alpha',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'bounded_read',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-22T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    ...(input.delegatedFrom ? { delegatedFrom: input.delegatedFrom } : {}),
    advisoryRoles: ['lookup'],
  });
}

function registered(input: {
  capabilityId?: string;
  manifest?: CapabilityManifestV1;
  delegatedFrom?: string;
  crossing?: () => void;
} = {}): RegisteredHostCapability {
  const exactManifest = input.manifest ?? manifest();
  return {
    capabilityId: input.capabilityId ?? 'capability.alpha',
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: exactManifest.definitionFingerprint,
    effect: exactManifest.effect,
    account: exactManifest.accountId,
    advisoryRoles: exactManifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    liveFingerprint: exactManifest.definitionFingerprint,
    ...(input.delegatedFrom ? { delegatedFrom: input.delegatedFrom } : {}),
    manifest: exactManifest,
    invoke: async () => {
      input.crossing?.();
      return { records: [{ id: 'record.1' }] };
    },
  };
}

function planFor(
  entry: RegisteredHostCapability,
  input: {
    arguments?: Record<string, WorkflowNodeArgumentBindingV1>;
    effect?: WorkflowNodeInvocationEffectV1;
    continuation?: WorkflowNodeInvocationPlanV1['continuation'];
  } = {},
): WorkflowNodeInvocationPlanV1 {
  const identity = canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  return createWorkflowNodeInvocationPlan({
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
      effect: input.effect ?? identity.effect as WorkflowNodeInvocationEffectV1,
      invokePortId: identity.invokePortId,
      argumentCompiler: { ...identity.argumentCompiler },
    },
    arguments: input.arguments ?? {
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
    continuation: input.continuation ?? { kind: 'none' },
  });
}

function observationFor(
  entry: RegisteredHostCapability,
  overrides: Partial<IndependentCapabilityObservation> = {},
): IndependentCapabilityObservation {
  const identity = canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  return {
    operationId: identity.operationId,
    accountId: identity.account,
    definitionFingerprint: identity.liveFingerprint,
    providerVersion: identity.providerVersion,
    operationVersion: identity.schemaVersion,
    observedAt: NOW,
    origin: 'independent',
    ...overrides,
  };
}

function executionIdentity(
  plan: WorkflowNodeInvocationPlanV1,
  label = 'alpha',
): WorkflowNodeReadExecutionIdentityV1 {
  return {
    workflowId: `workflow.${label}`,
    workflowRevision: 3,
    workflowDigest: digest(`workflow.${label}.revision.3`),
    runId: `run.${label}`,
    runOccurrenceId: `occurrence.${label}`,
    nodeId: `node.${label}`,
    nodeAttempt: 1,
    invocationPlanDigest: plan.bindingDigest,
    bindingSnapshotDigest: digest(`binding.snapshot.${label}`),
    controlDigest: digest(`control.${label}`),
  };
}

function prepareInput(input: {
  entry?: RegisteredHostCapability;
  plan?: WorkflowNodeInvocationPlanV1;
  identity?: WorkflowNodeReadExecutionIdentityV1;
  factory?: HostCapabilityCatalogFactory | null;
  workflowInputs?: Record<string, unknown>;
  stepOutputs?: Record<string, unknown>;
  partitionItem?: unknown;
  continuationCursor?: unknown;
  observe?: (operationId: string, accountId: string) => IndependentCapabilityObservation | null;
  cancelled?: boolean;
  signal?: AbortSignal;
} = {}) {
  const entry = input.entry ?? registered();
  const plan = input.plan ?? planFor(entry);
  return {
    plan,
    identity: input.identity ?? executionIdentity(plan),
    arguments: {
      workflowInputs: input.workflowInputs ?? { scope: 'scope.alpha' },
      stepOutputs: input.stepOutputs ?? {},
      ...(input.partitionItem !== undefined ? { partitionItem: input.partitionItem } : {}),
      ...(input.continuationCursor !== undefined ? { continuationCursor: input.continuationCursor } : {}),
    },
    cancelled: input.cancelled,
    signal: input.signal,
    catalogFactory: input.factory === undefined
      ? createHostCapabilityCatalogFactory([entry])
      : input.factory,
    observe: input.observe ?? (() => observationFor(entry)),
    now: NOW,
  };
}

function installExecutionFixture(input: {
  label: string;
  invoke?: GraphNodeCapabilityInvoke;
}) {
  const exactManifest = manifest({
    manifestId: `manifest.${input.label}`,
    operationId: `operation.${input.label}`,
    definitionFingerprint: digest(`schema.${input.label}`),
    accountId: `account.${input.label}`,
  });
  let portBodies = 0;
  let catalogBodies = 0;
  const exactInvoke: GraphNodeCapabilityInvoke = async (context) => {
    portBodies += 1;
    if (input.invoke) return input.invoke(context);
    return { records: [{ id: `record.${input.label}` }] };
  };
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(exactManifest),
    { invoke: exactInvoke },
  ).ok, true);
  const entry = registered({
    capabilityId: `capability.${input.label}`,
    manifest: exactManifest,
    crossing: () => {
      catalogBodies += 1;
      throw new Error('catalog callback cannot own a workflow tool crossing');
    },
  });
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory([entry]));
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
  return {
    entry,
    plan: planFor(entry),
    portBodies: () => portBodies,
    catalogBodies: () => catalogBodies,
  };
}

function workflowSession(label: string): string {
  return eventlog.createSession({
    id: `workflow-executor-${label}`,
    kind: 'workflow',
  }).id;
}

test('exact typed sources produce one immutable deterministic pre-kernel call contract', () => {
  let crossings = 0;
  const entry = registered({ crossing: () => { crossings += 1; } });
  const literal = { mode: 'reviewed', flags: ['a', 'b'] };
  const plan = planFor(entry, {
    arguments: {
      zeta: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'object',
      },
      alpha: {
        source: { kind: 'upstream_output', stepId: 'node.prior', path: 'payload.value' },
        required: true,
        type: 'string',
      },
      item: {
        source: { kind: 'partition_item', path: 'key' },
        required: true,
        type: 'number',
      },
      literal: {
        source: {
          kind: 'reviewed_literal',
          value: literal,
          valueDigest: workflowNodeReviewedLiteralDigest(literal),
          reviewRef: 'review.alpha',
          reviewDigest: digest('review.alpha'),
        },
        required: true,
        type: 'object',
      },
    },
  });
  const input = prepareInput({
    entry,
    plan,
    workflowInputs: { scope: { z: 3, a: { y: 2, x: 1 } } },
    stepOutputs: { 'node.prior': { payload: { value: 'prior.value' } } },
    partitionItem: { key: 7 },
  });
  const first = prepareWorkflowNodeRead(input);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(JSON.parse(JSON.stringify(first.prepared.canonicalArgs)), {
    alpha: 'prior.value',
    item: 7,
    literal: { flags: ['a', 'b'], mode: 'reviewed' },
    zeta: { a: { x: 1, y: 2 }, z: 3 },
  });
  assert.equal(Object.isFrozen(first.prepared), true);
  assert.equal(Object.isFrozen(first.prepared.identity), true);
  assert.equal(Object.isFrozen(first.prepared.canonicalArgs), true);
  assert.equal(Object.isFrozen((first.prepared.canonicalArgs.zeta as { a: object }).a), true);
  assert.match(first.prepared.logicalCallId, /^workflow-logical:[a-f0-9]{64}$/);

  const replay = prepareWorkflowNodeRead(prepareInput({
    entry,
    plan,
    workflowInputs: { scope: { a: { x: 1, y: 2 }, z: 3 } },
    stepOutputs: { 'node.prior': { payload: { value: 'prior.value' } } },
    partitionItem: { key: 7 },
  }));
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.prepared.logicalCallId, first.prepared.logicalCallId);
    assert.equal(replay.prepared.canonicalArgumentDigest, first.prepared.canonicalArgumentDigest);
  }
  assert.equal(crossings, 0);
});

test('ordinary writes and high-risk admin calls seal exact bytes into an opaque workflow_v3 authority checkpoint', () => {
  let bodies = 0;
  const ordinaryEntry = registered({
    capabilityId: 'capability.write.ordinary',
    manifest: manifest({
      manifestId: 'manifest.write.ordinary',
      operationId: 'operation.write.ordinary',
      definitionFingerprint: digest('schema.write.ordinary'),
      accountId: 'account.write.ordinary',
      effect: 'external_write',
    }),
    crossing: () => { bodies += 1; },
  });
  const ordinaryPlan = planFor(ordinaryEntry, { effect: 'external_write' });
  const ordinary = prepareWorkflowNodeCall(prepareInput({
    entry: ordinaryEntry,
    plan: ordinaryPlan,
  }));
  assert.equal(ordinary.kind, 'authority_checkpoint');
  if (ordinary.kind === 'authority_checkpoint') {
    assert.equal(ordinary.effect, 'external_write');
    assert.equal(ordinary.prepared.binding.effect, 'external_write');
    assert.equal(ordinary.prepared.invocationPlanDigest, ordinaryPlan.bindingDigest);
    assert.deepEqual(ordinary.requirement, {
      version: 1,
      authorityKind: 'workflow_v3_call',
      effect: 'external_write',
      mutating: true,
      consent: 'evaluate_exact_call',
      recovery: {
        notStarted: 'resume',
        possiblyStarted: 'reconcile_never_blind_retry',
        settled: 'replay_exact_settlement',
      },
    });
    assert.equal(Object.isFrozen(ordinary.requirement), true);
    assert.equal(Object.isFrozen(ordinary.requirement.recovery), true);
    assert.equal(ordinary.executable, false);
    assert.equal(ordinary.authority.authorityKind, 'workflow_v3_call');
    assert.equal(ordinary.authority.durability, 'process_checkpoint');
    assert.equal(ordinary.authority.executionState, 'not_armed');
    assert.equal(ordinary.authority.workflow.runOccurrenceId, 'occurrence.alpha');
    assert.equal(ordinary.authority.call.canonicalArgumentDigest, ordinary.prepared.canonicalArgumentDigest);
    assert.equal(ordinary.authority.capability.accountId, 'account.write.ordinary');
    assert.equal(ordinary.authority.obligation.requirementId, 'requirement.records');
    assert.equal(ordinary.authority.obligation.effect, 'external_write');
    assert.equal(
      workflowNodeCallAuthorityProofOwnsPrepared(ordinary.proof, ordinary.prepared),
      true,
    );
    assert.equal(
      workflowNodeCallAuthorityProofOwnsPrepared(
        { ...ordinary.proof },
        ordinary.prepared,
      ),
      false,
      'a structural proof clone is inert',
    );
    assert.equal(
      workflowNodeCallAuthorityProofOwnsPrepared(
        JSON.parse(JSON.stringify(ordinary.proof)) as typeof ordinary.proof,
        ordinary.prepared,
      ),
      false,
      'a JSON-round-tripped proof is inert',
    );
    assert.equal(
      workflowNodeCallAuthorityProofOwnsPrepared(
        ordinary.proof,
        structuredClone(ordinary.prepared),
      ),
      false,
      'a structural prepared-call clone is inert',
    );
    assert.deepEqual(
      bindPreparedWorkflowNodeCallAuthority(structuredClone(ordinary.prepared)),
      { ok: false, reason: 'prepared_call_not_authentic' },
      'a structural prepared-call clone cannot mint a fresh proof',
    );
  }

  const adminEntry = registered({
    capabilityId: 'capability.admin.high-risk',
    manifest: manifest({
      manifestId: 'manifest.admin.high-risk',
      operationId: 'operation.admin.high-risk',
      definitionFingerprint: digest('schema.admin.high-risk'),
      accountId: 'account.admin.high-risk',
      effect: 'admin',
    }),
    crossing: () => { bodies += 1; },
  });
  const adminPlan = planFor(adminEntry, { effect: 'admin' });
  const highRisk = prepareWorkflowNodeCall(prepareInput({ entry: adminEntry, plan: adminPlan }));
  assert.equal(highRisk.kind, 'authority_checkpoint');
  if (highRisk.kind === 'authority_checkpoint') {
    assert.equal(highRisk.requirement.authorityKind, 'workflow_v3_call');
    assert.equal(highRisk.requirement.consent, 'exact_user_grant');
    assert.deepEqual(highRisk.requirement.recovery, {
      notStarted: 'resume',
      possiblyStarted: 'reconcile_never_blind_retry',
      settled: 'replay_exact_settlement',
    });
    assert.equal(highRisk.executable, false);
    assert.equal(highRisk.authority.obligation.effect, 'admin');
  }

  const publicRead = prepareWorkflowNodeRead(prepareInput({
    entry: ordinaryEntry,
    plan: ordinaryPlan,
  }));
  assert.equal(publicRead.ok, false);
  if (!publicRead.ok) {
    assert.equal(publicRead.block.code, 'invocation_plan_invalid');
    assert.equal(publicRead.provenNoCrossing, true);
  }
  assert.equal(bodies, 0, 'preparation, high-risk pause and read compatibility never own a body');
});

test('workflow_v3 authority binds exact workflow, arguments, capability, and read/write obligation identity', () => {
  const readEntry = registered();
  const readPlan = planFor(readEntry);
  const readPrepared = prepareWorkflowNodeCall(prepareInput({ entry: readEntry, plan: readPlan }));
  assert.equal(readPrepared.kind, 'ready');
  if (readPrepared.kind !== 'ready') return;
  const readAuthority = bindPreparedWorkflowNodeCallAuthority(readPrepared.prepared);
  assert.equal(readAuthority.ok, true);
  if (!readAuthority.ok) return;
  assert.equal(readAuthority.binding.obligation.effect, 'read');
  assert.equal(readAuthority.binding.obligation.requirementId, readPlan.requirementId);

  const writeEntry = registered({
    capabilityId: 'capability.write.exact',
    manifest: manifest({
      manifestId: 'manifest.write.exact',
      operationId: 'operation.write.exact',
      definitionFingerprint: digest('schema.write.exact'),
      accountId: 'account.write.exact',
      effect: 'external_write',
    }),
  });
  const writePlan = planFor(writeEntry, { effect: 'external_write' });
  const exact = prepareWorkflowNodeCall(prepareInput({
    entry: writeEntry,
    plan: writePlan,
    workflowInputs: { scope: 'scope.exact' },
    identity: executionIdentity(writePlan, 'authority-exact'),
  }));
  const otherArgs = prepareWorkflowNodeCall(prepareInput({
    entry: writeEntry,
    plan: writePlan,
    workflowInputs: { scope: 'scope.other' },
    identity: executionIdentity(writePlan, 'authority-exact'),
  }));
  const otherOccurrence = prepareWorkflowNodeCall(prepareInput({
    entry: writeEntry,
    plan: writePlan,
    workflowInputs: { scope: 'scope.exact' },
    identity: {
      ...executionIdentity(writePlan, 'authority-exact'),
      runOccurrenceId: 'occurrence.authority-other',
    },
  }));
  assert.equal(exact.kind, 'authority_checkpoint');
  assert.equal(otherArgs.kind, 'authority_checkpoint');
  assert.equal(otherOccurrence.kind, 'authority_checkpoint');
  if (
    exact.kind !== 'authority_checkpoint'
    || otherArgs.kind !== 'authority_checkpoint'
    || otherOccurrence.kind !== 'authority_checkpoint'
  ) return;
  assert.notEqual(exact.authority.authorityBindingDigest, otherArgs.authority.authorityBindingDigest);
  assert.notEqual(exact.authority.authorityBindingDigest, otherOccurrence.authority.authorityBindingDigest);
  assert.equal(workflowNodeCallAuthorityProofOwnsPrepared(exact.proof, otherArgs.prepared), false);
  assert.equal(workflowNodeCallAuthorityProofOwnsPrepared(exact.proof, otherOccurrence.prepared), false);
  assert.equal(workflowNodeCallAuthorityProofOwnsPrepared(readAuthority.proof, exact.prepared), false);

  const exactIdentity = executionIdentity(writePlan, 'authority-exact');
  const workflowDrifts: Array<[string, WorkflowNodeReadExecutionIdentityV1]> = [
    ['workflow revision', { ...exactIdentity, workflowRevision: exactIdentity.workflowRevision + 1 }],
    ['workflow digest', { ...exactIdentity, workflowDigest: digest('workflow.digest.other') }],
    ['run id', { ...exactIdentity, runId: 'run.authority-other' }],
    ['node id', { ...exactIdentity, nodeId: 'node.authority-other' }],
    ['node attempt', { ...exactIdentity, nodeAttempt: exactIdentity.nodeAttempt + 1 }],
    ['binding snapshot', { ...exactIdentity, bindingSnapshotDigest: digest('binding.snapshot.other') }],
    ['control', { ...exactIdentity, controlDigest: digest('control.other') }],
  ];
  for (const [label, identity] of workflowDrifts) {
    const drifted = prepareWorkflowNodeCall(prepareInput({
      entry: writeEntry,
      plan: writePlan,
      workflowInputs: { scope: 'scope.exact' },
      identity,
    }));
    assert.equal(drifted.kind, 'authority_checkpoint', label);
    if (drifted.kind !== 'authority_checkpoint') continue;
    assert.notEqual(
      drifted.authority.authorityBindingDigest,
      exact.authority.authorityBindingDigest,
      `${label} must change authority identity`,
    );
    assert.equal(
      workflowNodeCallAuthorityProofOwnsPrepared(exact.proof, drifted.prepared),
      false,
      `${label} cannot borrow the exact proof`,
    );
  }

  const otherObligationPlan = createWorkflowNodeInvocationPlan({
    requirementId: 'requirement.records.write.other',
    logicalCapabilityId: writePlan.logicalCapabilityId,
    binding: writePlan.binding,
    arguments: writePlan.arguments,
    evidence: writePlan.evidence,
    completeness: writePlan.completeness,
    continuation: writePlan.continuation,
  });
  const obligationDrift = prepareWorkflowNodeCall(prepareInput({
    entry: writeEntry,
    plan: otherObligationPlan,
    workflowInputs: { scope: 'scope.exact' },
    identity: executionIdentity(otherObligationPlan, 'authority-exact'),
  }));
  assert.equal(obligationDrift.kind, 'authority_checkpoint');
  if (obligationDrift.kind === 'authority_checkpoint') {
    assert.notEqual(
      exact.authority.obligation.obligationDigest,
      obligationDrift.authority.obligation.obligationDigest,
    );
    assert.notEqual(
      exact.authority.authorityBindingDigest,
      obligationDrift.authority.authorityBindingDigest,
    );
    assert.equal(
      workflowNodeCallAuthorityProofOwnsPrepared(exact.proof, obligationDrift.prepared),
      false,
    );
  }

  const otherCapability = registered({
    capabilityId: 'capability.write.other-account',
    manifest: manifest({
      manifestId: 'manifest.write.other-account',
      operationId: 'operation.write.exact',
      definitionFingerprint: digest('schema.write.exact'),
      accountId: 'account.write.other',
      effect: 'external_write',
    }),
  });
  const otherPlan = planFor(otherCapability, { effect: 'external_write' });
  const capabilityDrift = prepareWorkflowNodeCall(prepareInput({
    entry: otherCapability,
    plan: otherPlan,
    workflowInputs: { scope: 'scope.exact' },
    identity: executionIdentity(otherPlan, 'authority-exact'),
  }));
  assert.equal(capabilityDrift.kind, 'authority_checkpoint');
  if (capabilityDrift.kind === 'authority_checkpoint') {
    assert.notEqual(
      exact.authority.authorityBindingDigest,
      capabilityDrift.authority.authorityBindingDigest,
    );
    assert.equal(
      workflowNodeCallAuthorityProofOwnsPrepared(exact.proof, capabilityDrift.prepared),
      false,
    );
  }
  assert.equal(Object.isFrozen(exact.authority), true);
  assert.equal(Object.isFrozen(exact.authority.workflow), true);
  assert.equal(Object.isFrozen(exact.authority.capability), true);
  assert.equal(Object.isFrozen(exact.authority.obligation), true);
});

test('one exact read crosses the immutable port once and replays its durable result after restart', async () => {
  const installed = installExecutionFixture({ label: 'execute-replay' });
  const sessionId = workflowSession('execute-replay');
  const exactInput = {
    ...prepareInput({
      entry: installed.entry,
      plan: installed.plan,
      identity: executionIdentity(installed.plan, 'execute-replay'),
    }),
    sessionId,
  };
  const first = await executeWorkflowNodeRead(exactInput);
  assert.equal(first.ok, true, JSON.stringify(first));
  if (!first.ok) return;
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.result, { records: [{ id: 'record.execute-replay' }] });
  assert.equal(installed.portBodies(), 1);
  assert.equal(installed.catalogBodies(), 0);

  const beforeRestart = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls WHERE session_id = ?) AS logical_n,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND io_claimed_at IS NOT NULL AND state = 'returned') AS physical_n,
      (SELECT COUNT(*) FROM logical_call_settlements WHERE session_id = ?) AS settlement_n
  `).get(sessionId, sessionId, sessionId) as {
    logical_n: number;
    physical_n: number;
    settlement_n: number;
  };
  assert.deepEqual(beforeRestart, { logical_n: 1, physical_n: 1, settlement_n: 1 });

  eventlog.closeEventLog();
  const replay = await executeWorkflowNodeRead(exactInput);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  if (!replay.ok) return;
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.activationId, first.activationId);
  assert.equal(replay.logicalCallId, first.logicalCallId);
  assert.ok(replay.resultHandleId);
  assert.equal(installed.portBodies(), 1, 'restart replay must not cross the immutable port again');
  assert.equal(installed.catalogBodies(), 0);
  assert.equal(eventlog.openEventLog().pragma('foreign_key_check').length, 0);
});

test('authored evidence paths and the step result share one exact payload owner while durable results retain the envelope', async () => {
  const payload = { records: [{ id: 'record.mcp-evidence' }] };
  const cases: Array<{
    label: string;
    result: unknown;
    expectedOwner?: 'root' | 'sealed_invoke_result' | 'mcp_structured_content' | 'mcp_text_json';
    expectedReason?: 'mcp_envelope_malformed';
    expectedPhase?: 'kernel' | 'evidence';
  }> = [{
    label: 'mcp-structured',
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: structuredClone(payload),
      isError: false,
    },
    expectedOwner: 'mcp_structured_content',
  }, {
    label: 'mcp-text-compatibility',
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
    expectedOwner: 'mcp_text_json',
  }, {
    label: 'sealed-invoke-mcp-text',
    result: {
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      complete: true,
    },
    expectedOwner: 'mcp_text_json',
  }, {
    label: 'sealed-invoke-root',
    result: { result: structuredClone(payload), complete: true },
    expectedOwner: 'sealed_invoke_result',
  }, {
    label: 'mcp-conflict',
    result: {
      content: [{ type: 'text', text: JSON.stringify({ records: [{ id: 'record.other' }] }) }],
      structuredContent: structuredClone(payload),
    },
    expectedReason: 'mcp_envelope_malformed',
    expectedPhase: 'kernel',
  }, {
    label: 'mcp-malformed',
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: 'not-an-object',
    },
    expectedReason: 'mcp_envelope_malformed',
    expectedPhase: 'kernel',
  }, {
    label: 'ordinary-root',
    result: structuredClone(payload),
    expectedOwner: 'root',
  }];

  for (const scenario of cases) {
    const view = resultFacts.projectProviderResultEvidenceView(scenario.result);
    if (scenario.expectedOwner) {
      assert.equal(view.kind, 'provider_payload', scenario.label);
      if (view.kind === 'provider_payload') {
        assert.equal(view.owner, scenario.expectedOwner, scenario.label);
        assert.deepEqual(view.payload, payload, scenario.label);
      }
    } else {
      assert.equal(view.kind, 'no_evidence', scenario.label);
      if (view.kind === 'no_evidence') assert.equal(view.reason, scenario.expectedReason, scenario.label);
    }

    const installed = installExecutionFixture({
      label: scenario.label,
      invoke: async () => structuredClone(scenario.result),
    });
    const exactInput = {
      ...prepareInput({
        entry: installed.entry,
        plan: installed.plan,
        identity: executionIdentity(installed.plan, scenario.label),
      }),
      sessionId: workflowSession(scenario.label),
    };
    const executed = await executeWorkflowNodeRead(exactInput);
    assert.equal(executed.ok, Boolean(scenario.expectedOwner), JSON.stringify(executed));
    if (executed.ok) {
      assert.equal(executed.status, 'completed', scenario.label);
      // The step receives the owner-projected payload — the value its
      // evidence was verified against — never the transport envelope.
      assert.deepEqual(executed.result, payload, scenario.label);
    } else {
      assert.equal(executed.phase, scenario.expectedPhase ?? 'evidence', scenario.label);
      if (executed.phase === 'evidence') {
        assert.ok(executed.evidenceReasons?.includes('required_path_missing:records'), scenario.label);
        assert.deepEqual(executed.result, scenario.result, scenario.label);
      }
    }
    assert.equal(installed.portBodies(), 1, scenario.label);
  }
});

test('concurrent reentry never redispatches a claimed body and the winning call still settles', async () => {
  let releaseBody: (() => void) | undefined;
  let bodyEntered: (() => void) | undefined;
  const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
  const entered = new Promise<void>((resolve) => { bodyEntered = resolve; });
  const installed = installExecutionFixture({
    label: 'concurrent-reentry',
    invoke: async () => {
      bodyEntered?.();
      await bodyGate;
      return { records: [{ id: 'record.concurrent-reentry' }] };
    },
  });
  const sessionId = workflowSession('concurrent-reentry');
  const exactInput = {
    ...prepareInput({
      entry: installed.entry,
      plan: installed.plan,
      identity: executionIdentity(installed.plan, 'concurrent-reentry'),
    }),
    sessionId,
  };
  const winnerPromise = executeWorkflowNodeRead(exactInput);
  await entered;

  let reentry: Awaited<ReturnType<typeof executeWorkflowNodeRead>>;
  try {
    reentry = await executeWorkflowNodeRead(exactInput);
    assert.equal(reentry.ok, false);
    if (!reentry.ok) {
      assert.equal(reentry.phase, 'kernel');
      assert.equal(reentry.block.code, 'workflow_call_blocked');
      assert.equal(reentry.block.message, 'prior_crossing_unknown_no_redispatch');
      assert.equal(reentry.provenNoCrossing, false);
    }
    assert.equal(installed.portBodies(), 1);
    const state = eventlog.openEventLog().prepare(`
      SELECT state FROM accepted_turn_call_authorities WHERE session_id = ?
    `).get(sessionId) as { state: string };
    assert.equal(state.state, 'open', 'reentry must not poison the body owner');
  } finally {
    releaseBody?.();
  }

  const winner = await winnerPromise;
  assert.equal(winner.ok, true, JSON.stringify(winner));
  if (winner.ok) assert.equal(winner.status, 'completed');
  assert.equal(installed.portBodies(), 1);
  assert.equal(installed.catalogBodies(), 0);
  const closed = eventlog.openEventLog().prepare(`
    SELECT state, close_reason FROM accepted_turn_call_authorities WHERE session_id = ?
  `).get(sessionId) as { state: string; close_reason: string };
  assert.deepEqual(closed, { state: 'closed', close_reason: 'workflow_completed' });
});

test('settled but incomplete evidence replays without a second body and never becomes node completion', async () => {
  const installed = installExecutionFixture({
    label: 'incomplete-evidence',
    invoke: async () => ({ records: [] }),
  });
  const sessionId = workflowSession('incomplete-evidence');
  const exactInput = {
    ...prepareInput({
      entry: installed.entry,
      plan: installed.plan,
      identity: executionIdentity(installed.plan, 'incomplete-evidence'),
    }),
    sessionId,
  };
  const first = await executeWorkflowNodeRead(exactInput);
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.equal(first.status, 'incomplete');
    assert.equal(first.phase, 'evidence');
    assert.equal(first.provenNoCrossing, false);
    assert.ok(first.evidenceReasons?.includes('non_empty_path_failed:records'));
    assert.ok(first.evidenceReasons?.includes('min_items_failed:records'));
  }
  assert.equal(installed.portBodies(), 1);

  const replay = await executeWorkflowNodeRead(exactInput);
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.status, 'incomplete');
    assert.equal(replay.phase, 'evidence');
    assert.equal(replay.provenNoCrossing, false);
  }
  assert.equal(installed.portBodies(), 1, 'incomplete evidence must not trigger a blind replay');
  assert.equal(installed.catalogBodies(), 0);
});

test('pre-aborted cancellation does not consult the catalog or observer', () => {
  let snapshots = 0;
  let observations = 0;
  let crossings = 0;
  const entry = registered({ crossing: () => { crossings += 1; } });
  const plan = planFor(entry);
  const base = createHostCapabilityCatalogFactory([entry]);
  const factory: HostCapabilityCatalogFactory = {
    ...base,
    snapshot() {
      snapshots += 1;
      return base.snapshot();
    },
  };
  const controller = new AbortController();
  controller.abort();
  const result = prepareWorkflowNodeRead(prepareInput({
    entry,
    plan,
    factory,
    signal: controller.signal,
    observe: () => {
      observations += 1;
      return observationFor(entry);
    },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.block.code, 'cancelled');
  assert.deepEqual({ snapshots, observations, crossings }, { snapshots: 0, observations: 0, crossings: 0 });
});

test('cancellation observed after preparation creates no authority root and crosses no port', async () => {
  const installed = installExecutionFixture({ label: 'cancel-before-arm' });
  const sessionId = workflowSession('cancel-before-arm');
  const controller = new AbortController();
  const result = await executeWorkflowNodeRead({
    ...prepareInput({
      entry: installed.entry,
      plan: installed.plan,
      identity: executionIdentity(installed.plan, 'cancel-before-arm'),
      signal: controller.signal,
      observe: () => {
        controller.abort();
        return observationFor(installed.entry);
      },
    }),
    sessionId,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.phase, 'authority');
    assert.equal(result.block.code, 'workflow_call_blocked');
    assert.equal(result.provenNoCrossing, true);
  }
  const roots = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM workflow_node_invocation_activations WHERE session_id = ?
  `).get(sessionId) as { n: number };
  assert.equal(roots.n, 0);
  assert.equal(installed.portBodies(), 0);
  assert.equal(installed.catalogBodies(), 0);
});

test('stale binding fails before authority creation and never reaches either invoke callback', async () => {
  const installed = installExecutionFixture({ label: 'stale-binding' });
  const sessionId = workflowSession('stale-binding');
  const drifted = registered({
    capabilityId: installed.entry.capabilityId,
    manifest: manifest({
      manifestId: installed.entry.manifest?.manifestId,
      operationId: installed.entry.manifest?.operationId,
      definitionFingerprint: digest('schema.stale-binding.changed'),
      accountId: installed.entry.account,
    }),
  });
  const result = await executeWorkflowNodeRead({
    ...prepareInput({
      entry: installed.entry,
      plan: installed.plan,
      identity: executionIdentity(installed.plan, 'stale-binding'),
      factory: createHostCapabilityCatalogFactory([drifted]),
      observe: () => observationFor(drifted),
    }),
    sessionId,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.phase, 'pre_crossing');
    assert.equal(result.block.code, 'schema_drift');
    assert.equal(result.provenNoCrossing, true);
  }
  const roots = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM workflow_node_invocation_activations WHERE session_id = ?
  `).get(sessionId) as { n: number };
  assert.equal(roots.n, 0);
  assert.equal(installed.portBodies(), 0);
  assert.equal(installed.catalogBodies(), 0);
});

test('identity, plan, catalog, observation and typed-source blockers all prove zero crossing', () => {
  let crossings = 0;
  const entry = registered({ crossing: () => { crossings += 1; } });
  const plan = planFor(entry);
  const staleEntry = registered({
    crossing: () => { crossings += 1; },
    manifest: manifest({ definitionFingerprint: digest('schema.changed') }),
  });
  const computeEntry = registered({
    capabilityId: 'capability.compute',
    crossing: () => { crossings += 1; },
    manifest: manifest({ manifestId: 'manifest.compute', operationId: 'operation.compute', effect: 'compute' }),
  });
  const computePlan = planFor(computeEntry, { effect: 'compute' });
  const cursorPlan = planFor(entry, {
    arguments: {
      cursor: {
        source: { kind: 'continuation_cursor' },
        required: false,
        type: 'string',
      },
    },
    continuation: {
      kind: 'cursor',
      cursorArgument: 'cursor',
      nextCursorPath: 'next',
      exhaustedPath: 'exhausted',
      maxPages: 4,
    },
  });
  const objectPlan = planFor(entry, {
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'object',
      },
    },
  });
  const largePlan = objectPlan;

  const cases: Array<{
    label: string;
    expected: string;
    input: ReturnType<typeof prepareInput>;
  }> = [
    {
      label: 'invalid exact identity',
      expected: 'execution_identity_invalid',
      input: prepareInput({ entry, plan, identity: { ...executionIdentity(plan), nodeAttempt: 0 } }),
    },
    {
      label: 'plan digest mismatch',
      expected: 'invocation_plan_digest_mismatch',
      input: prepareInput({ entry, plan, identity: { ...executionIdentity(plan), invocationPlanDigest: digest('other.plan') } }),
    },
    {
      label: 'catalog unavailable',
      expected: 'live_catalog_unavailable',
      input: prepareInput({ entry, plan, factory: null }),
    },
    {
      label: 'capability missing',
      expected: 'capability_missing',
      input: prepareInput({ entry, plan, factory: createHostCapabilityCatalogFactory([]) }),
    },
    {
      label: 'schema drift',
      expected: 'schema_drift',
      input: prepareInput({
        entry,
        plan,
        factory: createHostCapabilityCatalogFactory([staleEntry]),
        observe: () => observationFor(staleEntry),
      }),
    },
    {
      label: 'stale observation',
      expected: 'live_observation_stale',
      input: prepareInput({
        entry,
        plan,
        observe: () => observationFor(entry, { observedAt: NOW - 60 * 60 * 1000 }),
      }),
    },
    {
      label: 'compute contract',
      expected: 'compute_contract_unrepresented',
      input: prepareInput({ entry: computeEntry, plan: computePlan }),
    },
    {
      label: 'continuation runtime',
      expected: 'continuation_runtime_unrepresented',
      input: prepareInput({ entry, plan: cursorPlan }),
    },
    {
      label: 'missing typed source',
      expected: 'argument_source_missing',
      input: prepareInput({ entry, plan, workflowInputs: {} }),
    },
    {
      label: 'typed source mismatch',
      expected: 'argument_source_type_mismatch',
      input: prepareInput({ entry, plan, workflowInputs: { scope: 4 } }),
    },
    {
      label: 'non-JSON typed source',
      expected: 'canonical_arguments_invalid',
      input: prepareInput({ entry, plan: objectPlan, workflowInputs: { scope: new Date(0) } }),
    },
    {
      label: 'canonical argument byte cap',
      expected: 'canonical_arguments_too_large',
      input: prepareInput({
        entry,
        plan: largePlan,
        workflowInputs: { scope: { value: 'x'.repeat(8_000_100) } },
      }),
    },
  ];

  for (const fixture of cases) {
    const result = prepareWorkflowNodeRead(fixture.input);
    assert.equal(result.ok, false, fixture.label);
    if (!result.ok) {
      assert.equal(result.block.code, fixture.expected, fixture.label);
      assert.equal(result.provenNoCrossing, true, fixture.label);
      assert.equal(result.phase, 'pre_crossing', fixture.label);
    }
  }
  assert.equal(crossings, 0);
});

test('compiled arguments reject accessors without evaluating them', () => {
  let getterReads = 0;
  let crossings = 0;
  const entry = registered({ crossing: () => { crossings += 1; } });
  const plan = planFor(entry, {
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'object',
      },
    },
  });
  const scope = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(scope, 'unsafe', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'value';
    },
  });
  const result = prepareWorkflowNodeRead(prepareInput({ entry, plan, workflowInputs: { scope } }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.block.code, 'canonical_arguments_invalid');

  const accessorArray: unknown[] = ['safe'];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'unsafe';
    },
  });
  const arrayPlan = planFor(entry, {
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'array',
      },
    },
  });
  const arrayResult = prepareWorkflowNodeRead(prepareInput({
    entry,
    plan: arrayPlan,
    workflowInputs: { scope: accessorArray },
  }));
  assert.equal(arrayResult.ok, false);
  if (!arrayResult.ok) assert.equal(arrayResult.block.code, 'canonical_arguments_invalid');
  assert.deepEqual({ getterReads, crossings }, { getterReads: 0, crossings: 0 });
});
