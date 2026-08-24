/** Run: npx tsx --test src/execution/workflow-node-invocation-admission.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-invocation-admission-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  admitWorkflowNodeInvocation,
  compileWorkflowNodeInvocationArguments,
  resolveWorkflowNodeInvocation,
} = await import('./workflow-node-invocation-admission.js');
const { createWorkflowNodeInvocationPlan } = await import('../memory/workflow-node-invocation-plan.js');
const {
  canonicalCatalogIdentityOf,
  createHostCapabilityCatalogFactory,
} = await import('../runtime/harness/host-capability-catalog-factory.js');
const {
  attachSemanticContract,
  capabilityManifestDigest,
} = await import('../runtime/harness/capability-manifest.js');
import type { RegisteredHostCapability } from '../runtime/harness/host-capability-catalog-factory.js';
import type { CapabilityManifestV1 } from '../runtime/harness/capability-manifest.js';
import type { IndependentCapabilityObservation } from '../runtime/harness/independent-capability-observation.js';
import type {
  WorkflowNodeInvocationEffectV1,
  WorkflowNodeInvocationPlanV1,
} from '../memory/workflow-node-invocation-plan.js';

test.after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

const NOW = Date.parse('2026-08-22T12:00:00.000Z');
const IDENTITY = {
  workflowId: 'workflow.alpha',
  workflowRevision: 1,
  workflowDigest: digest('workflow.revision.1'),
  runId: 'run.alpha',
  runOccurrenceId: 'occurrence.1',
  nodeId: 'node.1',
  nodeAttempt: 1,
  invocationPlanDigest: '',
  bindingSnapshotDigest: digest('binding.snapshot.1'),
  controlDigest: digest('control.1'),
};

function manifest(input: {
  manifestId?: string;
  providerKind?: CapabilityManifestV1['providerKind'];
  operationId?: string;
  operationVersion?: string;
  schemaDigest?: string;
  accountId?: string;
  effect?: 'read' | 'compute' | 'external_write';
  delegatedFrom?: string;
  purpose?: string;
} = {}): CapabilityManifestV1 {
  return attachSemanticContract({
    version: 1,
    manifestId: input.manifestId ?? 'manifest.alpha',
    providerKind: input.providerKind ?? 'local_registry',
    operationId: input.operationId ?? 'operation.alpha',
    providerIdentity: 'runtime.alpha',
    providerVersion: 'runtime.1',
    operationVersion: input.operationVersion ?? '1',
    definitionFingerprint: input.schemaDigest ?? digest('schema.alpha'),
    effect: input.effect ?? 'read',
    accountId: input.accountId ?? 'account.alpha',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: input.purpose ?? 'read_bounded_records',
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
  schemaDigest?: string;
  liveFingerprint?: string;
  account?: string;
  effect?: RegisteredHostCapability['effect'];
  invokePort?: () => void;
} = {}): RegisteredHostCapability {
  const exactManifest = input.manifest ?? manifest();
  return {
    capabilityId: input.capabilityId ?? 'capability.alpha',
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: input.schemaDigest ?? exactManifest.definitionFingerprint,
    effect: input.effect ?? exactManifest.effect,
    account: input.account ?? exactManifest.accountId,
    advisoryRoles: exactManifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    liveFingerprint: input.liveFingerprint ?? exactManifest.definitionFingerprint,
    ...(input.delegatedFrom ? { delegatedFrom: input.delegatedFrom } : {}),
    manifest: exactManifest,
    invoke: async () => {
      input.invokePort?.();
      return { records: [{ id: 'record.1' }] };
    },
  };
}

function planFor(
  entry: RegisteredHostCapability,
  input: {
    effect?: WorkflowNodeInvocationEffectV1;
    predecessor?: WorkflowNodeInvocationPlanV1['predecessor'];
    continuation?: WorkflowNodeInvocationPlanV1['continuation'];
    completeness?: WorkflowNodeInvocationPlanV1['completeness'];
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
    ...(input.predecessor ? { predecessor: input.predecessor } : {}),
    arguments: input.continuation?.kind === 'cursor'
      ? {
          cursor: {
            source: { kind: 'continuation_cursor' },
            required: false,
            type: 'string',
          },
        }
      : {
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
    completeness: input.completeness ?? {
      kind: 'terminal_result',
      evidencePaths: ['records'],
    },
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

function resolveWith(
  invocationPlan: WorkflowNodeInvocationPlanV1,
  entries: RegisteredHostCapability[],
  observationEntry: RegisteredHostCapability = entries[0],
) {
  return resolveWorkflowNodeInvocation({
    plan: invocationPlan,
    identity: { ...IDENTITY, invocationPlanDigest: invocationPlan.bindingDigest },
    catalogFactory: createHostCapabilityCatalogFactory(entries),
    observe: () => observationFor(observationEntry),
    now: NOW,
  });
}

test('cold exact binding resolves, but lineage-free admission performs zero physical crossings on replay', () => {
  let crossings = 0;
  const entry = registered({ invokePort: () => { crossings += 1; } });
  const invocationPlan = planFor(entry);
  const factory = createHostCapabilityCatalogFactory([entry]);
  const input = {
    plan: invocationPlan,
    identity: { ...IDENTITY, invocationPlanDigest: invocationPlan.bindingDigest },
    catalogFactory: factory,
    observe: () => observationFor(entry),
    now: NOW,
  };

  const resolved = resolveWorkflowNodeInvocation(input);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.resolved.bindingRole, 'approved_binding');

  const first = admitWorkflowNodeInvocation(input);
  const replay = admitWorkflowNodeInvocation(input);
  assert.equal(first.block.code, 'workflow_activation_lineage_unrepresented');
  assert.deepEqual(replay.block, first.block);
  assert.equal(crossings, 0);
});

test('exact provider-neutral mutations resolve without provider exceptions and never invoke during admission', () => {
  let crossings = 0;
  for (const providerKind of ['local_registry', 'composio', 'native_mcp', 'reviewed_cli'] as const) {
    const entry = registered({
      capabilityId: `capability.${providerKind}`,
      manifest: manifest({
        manifestId: `manifest.${providerKind}`,
        operationId: `operation.${providerKind}`,
        providerKind,
        effect: 'external_write',
        purpose: 'persist_records',
      }),
      invokePort: () => { crossings += 1; },
    });
    const invocationPlan = planFor(entry, { effect: 'external_write' });
    const resolved = resolveWith(invocationPlan, [entry]);
    assert.equal(resolved.ok, true, providerKind);
    if (resolved.ok) {
      assert.equal(resolved.resolved.plan.binding.effect, 'external_write');
      assert.equal(resolved.resolved.liveIdentity.providerKind, providerKind);
      assert.equal(resolved.resolved.identity.nodeAttempt, 1);
    }
  }
  assert.equal(crossings, 0, 'resolution is never mutation authority or dispatch');
});

test('admission requires the complete v51 workflow identity and exact plan digest before catalog access', () => {
  let snapshots = 0;
  const entry = registered();
  const invocationPlan = planFor(entry);
  const baseFactory = createHostCapabilityCatalogFactory([entry]);
  const catalogFactory = {
    ...baseFactory,
    snapshot: () => {
      snapshots += 1;
      return baseFactory.snapshot();
    },
  };
  const exact = { ...IDENTITY, invocationPlanDigest: invocationPlan.bindingDigest };
  const invalid: Array<Partial<typeof exact>> = [
    { workflowId: '' },
    { workflowRevision: 0 },
    { workflowDigest: 'not-a-digest' },
    { runId: '' },
    { runOccurrenceId: '' },
    { nodeId: '' },
    { nodeAttempt: 0 },
    { invocationPlanDigest: 'not-a-digest' },
    { bindingSnapshotDigest: 'not-a-digest' },
    { controlDigest: 'not-a-digest' },
  ];
  for (const mutation of invalid) {
    const result = resolveWorkflowNodeInvocation({
      plan: invocationPlan,
      identity: { ...exact, ...mutation },
      catalogFactory,
      observe: () => observationFor(entry),
      now: NOW,
    });
    assert.equal(result.ok, false, JSON.stringify(mutation));
    if (!result.ok) assert.equal(result.block.code, 'invocation_identity_invalid');
  }
  const mismatched = resolveWorkflowNodeInvocation({
    plan: invocationPlan,
    identity: { ...exact, invocationPlanDigest: digest('another.valid.plan') },
    catalogFactory,
    observe: () => observationFor(entry),
    now: NOW,
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.block.code, 'invocation_plan_digest_mismatch');
  assert.equal(snapshots, 0);
});

test('an exact recorded successor resolves only from its reviewed effective binding', () => {
  const predecessor = registered({ capabilityId: 'capability.old', manifest: manifest({ manifestId: 'manifest.old' }) });
  const successorManifest = manifest({
    manifestId: 'manifest.new',
    operationId: 'operation.new',
    delegatedFrom: predecessor.capabilityId,
  });
  const successor = registered({
    capabilityId: 'capability.new',
    manifest: successorManifest,
    delegatedFrom: predecessor.capabilityId,
  });
  const invocationPlan = planFor(successor, {
    predecessor: {
      capabilityId: predecessor.capabilityId,
      manifestId: predecessor.manifest!.manifestId,
      manifestDigest: predecessor.manifestDigest!,
    },
  });
  const resolved = resolveWith(invocationPlan, [successor]);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.resolved.capability.capabilityId, 'capability.new');
    assert.equal(resolved.resolved.bindingRole, 'approved_successor');
  }
});

test('unrecorded and ambiguous successor lineage fail closed', () => {
  const prior = registered({ capabilityId: 'capability.prior', manifest: manifest({ manifestId: 'manifest.prior' }) });
  const invocationPlan = planFor(prior);
  const first = registered({
    capabilityId: 'capability.next.a',
    manifest: manifest({ manifestId: 'manifest.next.a', delegatedFrom: prior.capabilityId }),
    delegatedFrom: prior.capabilityId,
  });
  const second = registered({
    capabilityId: 'capability.next.b',
    manifest: manifest({ manifestId: 'manifest.next.b', delegatedFrom: prior.capabilityId }),
    delegatedFrom: prior.capabilityId,
  });

  const unique = resolveWith(invocationPlan, [first], first);
  assert.equal(unique.ok, false);
  if (!unique.ok) assert.equal(unique.block.code, 'successor_not_recorded');

  const ambiguous = resolveWith(invocationPlan, [first, second], first);
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.block.code, 'capability_ambiguous');
});

test('missing, operation, schema, account, effect, port, and manifest drift each fail closed', () => {
  const exact = registered();
  const invocationPlan = planFor(exact);

  const missing = resolveWith(invocationPlan, [], exact);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.block.code, 'capability_missing');

  const matrix: Array<{
    expected: string;
    entry: RegisteredHostCapability;
  }> = [
    {
      expected: 'operation_drift',
      entry: registered({ manifest: manifest({ operationId: 'operation.changed' }) }),
    },
    {
      expected: 'schema_drift',
      entry: registered({ schemaDigest: digest('schema.changed'), liveFingerprint: digest('live.changed') }),
    },
    { expected: 'account_drift', entry: registered({ account: 'account.changed' }) },
    { expected: 'effect_drift', entry: registered({ effect: 'external_write' }) },
    {
      expected: 'port_drift',
      entry: registered({
        manifest: attachSemanticContract({
          ...manifest(),
          invokePortId: 'invoke.changed',
        }),
      }),
    },
    {
      expected: 'manifest_drift',
      entry: registered({ manifest: manifest({ purpose: 'read_records_with_changed_contract' }) }),
    },
  ];
  for (const item of matrix) {
    const result = resolveWith(invocationPlan, [item.entry], item.entry);
    assert.equal(result.ok, false, item.expected);
    if (!result.ok) assert.equal(result.block.code, item.expected);
  }
});

test('independent observation must be present, fresh, and identity-exact', () => {
  const entry = registered();
  const invocationPlan = planFor(entry);
  const factory = createHostCapabilityCatalogFactory([entry]);
  const base = {
    plan: invocationPlan,
    identity: { ...IDENTITY, invocationPlanDigest: invocationPlan.bindingDigest },
    catalogFactory: factory,
    now: NOW,
  };

  const missing = resolveWorkflowNodeInvocation({ ...base, observe: () => null });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.block.code, 'live_observation_missing');

  const stale = resolveWorkflowNodeInvocation({
    ...base,
    observe: () => observationFor(entry, { observedAt: NOW - 60_001 }),
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.block.code, 'live_observation_stale');

  const drift = resolveWorkflowNodeInvocation({
    ...base,
    observe: () => observationFor(entry, { definitionFingerprint: digest('observed.changed') }),
  });
  assert.equal(drift.ok, false);
  if (!drift.ok) assert.equal(drift.block.code, 'live_observation_drift');
});

test('cancellation and compute refuse before catalog; cursor plans require exact live observation before invoke', () => {
  let snapshots = 0;
  let crossings = 0;
  const readEntry = registered({ invokePort: () => { crossings += 1; } });
  const catalogFactory = {
    register() {},
    forget() {},
    clear() {},
    catalog: () => createHostCapabilityCatalogFactory().catalog(),
    snapshot: () => {
      snapshots += 1;
      return [readEntry];
    },
    get: () => readEntry,
  };
  const cancelledPlan = planFor(readEntry);
  const cancelled = resolveWorkflowNodeInvocation({
    plan: cancelledPlan,
    identity: { ...IDENTITY, invocationPlanDigest: cancelledPlan.bindingDigest },
    cancelled: true,
    catalogFactory,
  });
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.block.code, 'cancelled');
  assert.equal(snapshots, 0);

  const computeEntry = registered({ manifest: manifest({ effect: 'compute' }) });
  const computePlan = planFor(computeEntry, { effect: 'compute' });
  const compute = resolveWorkflowNodeInvocation({
    plan: computePlan,
    identity: { ...IDENTITY, invocationPlanDigest: computePlan.bindingDigest },
    catalogFactory,
  });
  assert.equal(compute.ok, false);
  if (!compute.ok) assert.equal(compute.block.code, 'compute_contract_unrepresented');
  assert.equal(snapshots, 0);

  const cursorPlan = planFor(readEntry, {
      completeness: {
        kind: 'finite_exhaustive',
        exhaustedPath: 'page.exhausted',
        evidencePaths: ['records'],
      },
      continuation: {
        kind: 'cursor',
        cursorArgument: 'cursor',
        nextCursorPath: 'page.next',
        exhaustedPath: 'page.exhausted',
        maxPages: 20,
      },
    });
  const cursor = resolveWorkflowNodeInvocation({
    plan: cursorPlan,
    identity: { ...IDENTITY, invocationPlanDigest: cursorPlan.bindingDigest },
    catalogFactory,
  });
  assert.equal(cursor.ok, false);
  if (!cursor.ok) assert.equal(cursor.block.code, 'live_observation_missing');
  assert.equal(snapshots, 1);
  assert.equal(crossings, 0);
});

test('argument compilation resolves typed runtime sources without mutating the persisted plan', () => {
  const entry = registered();
  const base = planFor(entry);
  const exact = createWorkflowNodeInvocationPlan({
    ...base,
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'string',
      },
      records: {
        source: { kind: 'upstream_output', stepId: 'seed', path: 'records' },
        required: true,
        type: 'array',
      },
      partition: {
        source: { kind: 'partition_item', path: 'record' },
        required: true,
        type: 'object',
      },
    },
  });
  const before = structuredClone(exact);
  const compiled = compileWorkflowNodeInvocationArguments(exact, {
    workflowInputs: { scope: 'bounded' },
    stepOutputs: { seed: { records: [{ id: 'record.1' }] } },
    partitionItem: { record: { id: 'record.2' } },
  });
  assert.equal(compiled.ok, true);
  if (compiled.ok) {
    assert.deepEqual(compiled.args, {
      scope: 'bounded',
      records: [{ id: 'record.1' }],
      partition: { id: 'record.2' },
    });
    assert.match(compiled.argumentDigest, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(exact, before);
});

test('typed source path traversal rejects accessors without evaluating them', () => {
  const entry = registered();
  const exact = createWorkflowNodeInvocationPlan({
    ...planFor(entry),
    arguments: {
      records: {
        source: { kind: 'upstream_output', stepId: 'seed', path: 'records' },
        required: true,
        type: 'array',
      },
    },
  });
  let getterReads = 0;
  const seed = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(seed, 'records', {
    enumerable: true,
    get() {
      getterReads += 1;
      return [{ id: 'unsafe' }];
    },
  });
  const compiled = compileWorkflowNodeInvocationArguments(exact, {
    workflowInputs: {},
    stepOutputs: { seed },
  });
  assert.deepEqual(compiled, { ok: false, reason: 'missing_source', argument: 'records' });
  assert.equal(getterReads, 0);
});
