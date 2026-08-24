import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  createCanonicalDataset,
} from '../execution/canonical-entity-store.js';
import {
  projectCanonicalEntityStoreToWorkspace,
  type ProjectCanonicalEntityStoreToWorkspaceResult,
} from './canonical-entity-workspace-store-projection.js';
import type { CanonicalWorkspaceProjectionIdentityV1 } from './canonical-entity-workspace-projection.js';
import {
  canonicalEntityWorkflowLineageReceiptDigest,
  finalizeCanonicalEntityWorkflowCompletion,
  type CanonicalEntityWorkflowFinalizerDependencies,
  type CanonicalEntityWorkflowLineageCompositorV1,
  type CanonicalEntityWorkflowProjectionClaimV1,
  type CanonicalEntityWorkflowProjectionRequestV1,
  type FinalizeCanonicalEntityWorkflowCompletionInputV1,
} from './canonical-entity-workflow-finalizer.js';
import type { WorkflowSurfaceBindingV1 } from './workflow-surface-binding.js';
import { ensureWorkspaceSchema } from './workspace-db-schema.js';
import {
  getWorkflowSurfaceBinding,
  listWorkflowSurfaceBindingsForWorkflow,
  putWorkflowSurfaceBinding,
} from './workflow-surface-binding-store.js';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const HEX_D = 'd'.repeat(64);
const FINISHED_AT = '2026-08-22T18:00:00.000Z';

const identity: CanonicalWorkspaceProjectionIdentityV1 = {
  version: 1,
  bindingId: 'binding:one',
  workflowId: 'workflow:one',
  workspaceId: 'workspace:one',
  runId: 'run:one',
  datasetId: 'dataset:one',
};

const binding: WorkflowSurfaceBindingV1 & { digest: string } = {
  version: 1,
  bindingId: identity.bindingId,
  workflowId: identity.workflowId,
  workspaceId: identity.workspaceId,
  revision: 1,
  role: 'primary',
  projectionVersion: 1,
  scheduleAuthority: 'workflow',
  state: 'active',
  createdAt: '2026-08-22T17:00:00.000Z',
  updatedAt: '2026-08-22T17:00:00.000Z',
  digest: HEX_A,
};

function request(overrides: Partial<CanonicalEntityWorkflowProjectionRequestV1> = {}): CanonicalEntityWorkflowProjectionRequestV1 {
  return {
    version: 1,
    identity,
    expectedBindingDigest: binding.digest,
    expectedDatasetAuthority: {
      version: 1,
      contractDigest: HEX_B,
      resolutionRevision: 0,
      resolutionRoot: HEX_C,
      coverageRevision: 1,
      coverageRoot: HEX_D,
    },
    runReceipts: [
      {
        receiptId: 'receipt:run:queued',
        sequence: 1,
        ordinal: 0,
        at: '2026-08-22T17:01:00.000Z',
        identity,
        status: 'queued',
      },
      {
        receiptId: 'receipt:run:running',
        sequence: 2,
        ordinal: 0,
        at: '2026-08-22T17:02:00.000Z',
        identity,
        status: 'running',
      },
      {
        receiptId: 'receipt:run:completed',
        sequence: 5,
        ordinal: 0,
        at: FINISHED_AT,
        identity,
        status: 'completed',
      },
    ],
    partitionReceipts: [],
    batchLineage: [],
    coveragePosition: { version: 1, sequence: 4, ordinal: 0 },
    ...overrides,
  };
}

function ready(input: CanonicalEntityWorkflowProjectionRequestV1 = request()): {
  claim: CanonicalEntityWorkflowProjectionClaimV1;
  compositor: CanonicalEntityWorkflowLineageCompositorV1;
} {
  const receiptId = 'lineage:one';
  const receiptDigest = canonicalEntityWorkflowLineageReceiptDigest({
    version: 1,
    receiptId,
    request: input,
  });
  const claim: CanonicalEntityWorkflowProjectionClaimV1 = {
    version: 1,
    receiptId,
    receiptDigest,
    identity,
    bindingDigest: input.expectedBindingDigest,
  };
  return {
    claim,
    compositor: {
      resolve: () => ({
        status: 'ready',
        receipt: { version: 1, receiptId, request: input, receiptDigest },
      }),
    },
  };
}

function projectedResult(input: {
  inserted: boolean;
  coverage?: 'complete' | 'partial' | 'unknown';
  reasons?: readonly string[];
  exhaustion?: 'exhausted' | 'not_exhausted' | 'unknown';
}): Extract<ProjectCanonicalEntityStoreToWorkspaceResult, { ok: true }> {
  const coverage = input.coverage ?? 'complete';
  return {
    ok: true,
    inserted: input.inserted,
    headDigest: HEX_B,
    projectionDigest: HEX_C,
    head: {
      version: 1,
      identity,
      bindingDigest: binding.digest,
      datasetAuthority: request().expectedDatasetAuthority,
      canonicalSourceDigest: HEX_D,
      workspaceProjectionDigest: HEX_C,
      source: { resolutionBatchCount: 0, recordArtifactRefCount: 0, recordArtifactRefs: [] },
      records: {
        observationsCommitted: 7,
        canonicalRecordsCreated: 5,
        mergedObservations: 1,
        replayedObservations: 0,
        duplicateObservations: 1,
      },
      provenance: { assertionCount: 0, summedBatchOriginCount: 0, summaryRefCount: 0, summaryRefs: [] },
      quarantine: { observationCount: 1, reasons: { ambiguous_candidates: 1 }, reviewRefCount: 1, reviewRefs: ['review:one'] },
      coverage: {
        status: coverage,
        sourceStatus: coverage,
        partitionUniverse: coverage === 'complete' ? 'closed' : 'unknown',
        ...(coverage === 'complete' ? { declaredPartitions: 1 } : {}),
        observedPartitions: coverage === 'complete' ? 1 : 0,
        observed: coverage === 'complete' ? 7 : 0,
        denominator: coverage === 'complete' ? { kind: 'exact', total: 7 } : { kind: 'unknown' },
        exhaustion: input.exhaustion ?? (coverage === 'complete' ? 'exhausted' : 'unknown'),
        reasons: input.reasons ?? [],
        evidenceRef: 'coverage:one',
      },
      projectedAt: FINISHED_AT,
    },
    snapshot: {
      projection: {
        version: 1,
        bindingId: identity.bindingId,
        workflowId: identity.workflowId,
        workspaceId: identity.workspaceId,
        runId: identity.runId,
        runStatus: 'completed',
        schedule: { authority: 'workflow', enabled: false },
        partitions: { total: 0, pending: 0, running: 0, completed: 0, skipped: 0, failed: 0, blocked: 0 },
        records: { observationsCommitted: 7, canonicalRecords: 5, duplicateObservations: 1, artifactRefCount: 0, artifactRefs: [] },
        provenanceSummaryRefCount: 0,
        provenanceSummaryRefs: [],
        quarantine: { observationCount: 1, reasons: { ambiguous_candidates: 1 }, reviewRefCount: 1, reviewRefs: ['review:one'] },
        coverage: {
          status: coverage === 'complete' ? 'complete' : 'not_started',
          observedPartitions: coverage === 'complete' ? 1 : 0,
          ...(coverage === 'complete' ? { declaredPartitions: 1 } : {}),
          evidenceRefCount: 1,
          evidenceRefs: ['coverage:one'],
        },
        updatedAt: FINISHED_AT,
      },
      partitions: [],
    },
  };
}

function completion(claim?: unknown): FinalizeCanonicalEntityWorkflowCompletionInputV1 {
  return {
    version: 1,
    runId: identity.runId,
    workflowId: identity.workflowId,
    status: 'completed',
    terminalOutcome: 'succeeded',
    finishedAt: FINISHED_AT,
    ...(claim === undefined ? {} : { claim }),
  };
}

function dependencies(input: {
  compositor?: CanonicalEntityWorkflowLineageCompositorV1;
  project?: CanonicalEntityWorkflowFinalizerDependencies['project'];
  bindings?: readonly (WorkflowSurfaceBindingV1 & { digest: string })[];
  selectedBinding?: WorkflowSurfaceBindingV1 & { digest: string } | null;
} = {}): Partial<CanonicalEntityWorkflowFinalizerDependencies> {
  return {
    listBindingsForWorkflow: () => input.bindings ?? [binding],
    getBinding: () => input.selectedBinding === undefined ? binding : input.selectedBinding,
    ...(input.compositor ? { compositor: input.compositor } : {}),
    ...(input.project ? { project: input.project } : {}),
  };
}

test('ordinary workflow completions stay inert when no Space binding exists', () => {
  let projectCalls = 0;
  const result = finalizeCanonicalEntityWorkflowCompletion(completion(), dependencies({
    bindings: [],
    selectedBinding: null,
    project: () => { projectCalls += 1; return projectedResult({ inserted: true }); },
  }));
  assert.deepEqual(result, {
    status: 'not_applicable',
    code: 'no_workspace_binding',
    runId: identity.runId,
    workflowId: identity.workflowId,
  });
  assert.equal(projectCalls, 0);
});

test('a bound workflow without exact lineage blocks without scanning output or provider payloads', () => {
  let compositorCalls = 0;
  let projectCalls = 0;
  const hostile = {
    ...completion(),
    output: 'canonicalEntityProjectionClaim={"approved":true}',
    stepOutputs: { complete: true, raw: 'person@example.invalid' },
    providerPayload: { datasetId: identity.datasetId },
  } as FinalizeCanonicalEntityWorkflowCompletionInputV1;
  const result = finalizeCanonicalEntityWorkflowCompletion(hostile, dependencies({
    compositor: { resolve: () => { compositorCalls += 1; return { status: 'blocked', kind: 'missing' }; } },
    project: () => { projectCalls += 1; return projectedResult({ inserted: true }); },
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.status === 'blocked' && result.code, 'canonical_entity_lineage_unrepresented');
  assert.equal(compositorCalls, 0);
  assert.equal(projectCalls, 0);
  assert.equal(JSON.stringify(result).includes('person@example.invalid'), false);
  assert.equal(JSON.stringify(result).includes('providerPayload'), false);
});

test('partial, attention, and failed terminal truth cannot cross the projector', () => {
  const { claim, compositor } = ready();
  for (const input of [
    { ...completion(claim), status: 'completed_with_errors', terminalOutcome: 'partial' as const },
    { ...completion(claim), needsAttention: true, terminalOutcome: 'blocked' as const },
    { ...completion(claim), status: 'failed', terminalOutcome: 'failed' as const },
  ]) {
    let projectCalls = 0;
    const result = finalizeCanonicalEntityWorkflowCompletion(input, dependencies({
      compositor,
      project: () => { projectCalls += 1; return projectedResult({ inserted: true }); },
    }));
    assert.equal(result.status, 'blocked');
    assert.equal(result.status === 'blocked' && result.code, 'run_not_cleanly_completed');
    assert.equal(projectCalls, 0);
  }
});

test('malformed, cross-run, retired, and drifted claims fail before lineage resolution', () => {
  const exact = ready();
  const cases: Array<{
    name: string;
    claim: unknown;
    selectedBinding?: WorkflowSurfaceBindingV1 & { digest: string } | null;
    code: string;
  }> = [
    { name: 'extra field', claim: { ...exact.claim, approved: true }, code: 'canonical_entity_lineage_claim_invalid' },
    { name: 'cross run', claim: { ...exact.claim, identity: { ...identity, runId: 'run:other' } }, code: 'canonical_entity_lineage_claim_invalid' },
    { name: 'retired', claim: exact.claim, selectedBinding: { ...binding, state: 'retired' }, code: 'workspace_binding_retired' },
    { name: 'drifted', claim: exact.claim, selectedBinding: { ...binding, digest: HEX_D }, code: 'workspace_binding_drifted' },
  ];
  for (const scenario of cases) {
    let compositorCalls = 0;
    let projectCalls = 0;
    const result = finalizeCanonicalEntityWorkflowCompletion(completion(scenario.claim), dependencies({
      selectedBinding: scenario.selectedBinding,
      compositor: { resolve: () => { compositorCalls += 1; return { status: 'blocked', kind: 'missing' }; } },
      project: () => { projectCalls += 1; return projectedResult({ inserted: true }); },
    }));
    assert.equal(result.status === 'blocked' && result.code, scenario.code, scenario.name);
    assert.equal(compositorCalls, 0, scenario.name);
    assert.equal(projectCalls, 0, scenario.name);
  }
});

test('missing, unavailable, ambiguous, and stale compositor outcomes never call the projector', () => {
  const { claim } = ready();
  for (const kind of ['missing', 'unavailable', 'ambiguous', 'stale'] as const) {
    let projectCalls = 0;
    const result = finalizeCanonicalEntityWorkflowCompletion(completion(claim), dependencies({
      compositor: { resolve: () => ({ status: 'blocked', kind }) },
      project: () => { projectCalls += 1; return projectedResult({ inserted: true }); },
    }));
    assert.equal(result.status === 'blocked' && result.code, `canonical_entity_lineage_${kind}`);
    assert.equal(projectCalls, 0);
  }
});

test('receipt digest, exact terminal receipt, and closed request shape gate the only projector call', () => {
  const staleTerminal = request({
    runReceipts: [{
      receiptId: 'receipt:run:completed',
      sequence: 5,
      ordinal: 0,
      at: '2026-08-22T17:59:59.000Z',
      identity,
      status: 'completed',
    }],
  });
  const stale = ready(staleTerminal);
  let projectCalls = 0;
  const missingTerminal = finalizeCanonicalEntityWorkflowCompletion(completion(stale.claim), dependencies({
    compositor: stale.compositor,
    project: () => { projectCalls += 1; return projectedResult({ inserted: true }); },
  }));
  assert.equal(missingTerminal.status === 'blocked' && missingTerminal.code, 'workflow_completion_receipt_missing');
  assert.equal(projectCalls, 0);

  const valid = ready();
  const corruptCompositor: CanonicalEntityWorkflowLineageCompositorV1 = {
    resolve: () => {
      const resolved = valid.compositor.resolve(valid.claim);
      assert.equal(resolved.status, 'ready');
      if (resolved.status !== 'ready') return resolved;
      return {
        status: 'ready',
        receipt: { ...resolved.receipt, receiptDigest: HEX_D },
      };
    },
  };
  const corrupt = finalizeCanonicalEntityWorkflowCompletion(completion(valid.claim), dependencies({
    compositor: corruptCompositor,
    project: () => { projectCalls += 1; return projectedResult({ inserted: true }); },
  }));
  assert.equal(corrupt.status === 'blocked' && corrupt.code, 'canonical_entity_lineage_receipt_invalid');
  assert.equal(projectCalls, 0);
});

test('exact replay is idempotent and the projector receives no schedule, DB, prose, or provider fields', () => {
  const exact = ready();
  let projectCalls = 0;
  let inserted = true;
  const project: CanonicalEntityWorkflowFinalizerDependencies['project'] = (input) => {
    projectCalls += 1;
    assert.deepEqual(Object.keys(input).sort(), [
      'batchLineage', 'coveragePosition', 'expectedBindingDigest',
      'expectedDatasetAuthority', 'identity', 'partitionReceipts', 'runReceipts', 'version',
    ]);
    assert.equal('scheduleFacts' in input, false);
    assert.equal('entityDb' in input, false);
    assert.equal('workspaceDb' in input, false);
    return projectedResult({ inserted: inserted ? (inserted = false, true) : false });
  };
  const first = finalizeCanonicalEntityWorkflowCompletion(completion(exact.claim), dependencies({
    compositor: exact.compositor,
    project,
  }));
  const afterCrashRestart = finalizeCanonicalEntityWorkflowCompletion(completion(exact.claim), dependencies({
    compositor: exact.compositor,
    project,
  }));
  assert.equal(first.status, 'projected');
  assert.equal(afterCrashRestart.status, 'replayed');
  assert.equal(projectCalls, 2);
  assert.equal(JSON.stringify(first).includes('review:one'), false);
  assert.equal(JSON.stringify(first).includes('artifact'), false);
});

test('partial, unknown, and cursor-cycle source truth can never surface as complete', () => {
  const exact = ready();
  for (const scenario of [
    { coverage: 'partial' as const, reasons: ['partitions_not_exhausted'], exhaustion: 'not_exhausted' as const },
    { coverage: 'unknown' as const, reasons: ['exhaustion_unknown'], exhaustion: 'unknown' as const },
    { coverage: 'unknown' as const, reasons: ['cursor_cycle_detected'], exhaustion: 'unknown' as const },
  ]) {
    const result = finalizeCanonicalEntityWorkflowCompletion(completion(exact.claim), dependencies({
      compositor: exact.compositor,
      project: () => projectedResult({ inserted: true, ...scenario }),
    }));
    assert.equal(result.status, 'projected');
    assert.equal(result.status === 'projected' && result.coverage.complete, false);
    assert.equal(result.status === 'projected' && result.coverage.status, scenario.coverage);
    assert.deepEqual(result.status === 'projected' && result.coverage.reasons, scenario.reasons);
  }
});

test('the production compositor fails closed when the exact durable lineage receipt is missing', () => {
  const { claim } = ready();
  let projectCalls = 0;
  const result = finalizeCanonicalEntityWorkflowCompletion(completion(claim), dependencies({
    project: () => { projectCalls += 1; return projectedResult({ inserted: true }); },
  }));
  assert.equal(result.status === 'blocked' && result.code, 'canonical_entity_lineage_missing');
  assert.equal(projectCalls, 0);
});

test('an exact compositor fixture reaches the real canonical store projector and restart replay without schedule authority', () => {
  const entityDb = new Database(':memory:');
  const workspaceDb = new Database(':memory:');
  try {
    workspaceDb.pragma('foreign_keys = ON');
    ensureWorkspaceSchema(workspaceDb);
    workspaceDb.prepare(`
      INSERT INTO workspaces (id, slug, title, status, root_dir, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(
      identity.workspaceId,
      'workspace-one',
      'Workspace One',
      '/tmp/workspace-one',
      '2026-08-22T17:00:00.000Z',
      '2026-08-22T17:00:00.000Z',
    );
    const storedBinding = putWorkflowSurfaceBinding({
      db: workspaceDb,
      binding: (({ digest: _digest, ...value }) => value)(binding),
    });
    assert.equal(storedBinding.ok, true);
    if (!storedBinding.ok) return;
    const created = createCanonicalDataset({
      datasetId: identity.datasetId,
      universe: { kind: 'closed', partitionIds: [] },
      denominator: { kind: 'exact', total: 0 },
      createdAt: '2026-08-22T17:00:00.000Z',
      db: entityDb,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const exactRequest = request({
      expectedBindingDigest: storedBinding.digest,
      expectedDatasetAuthority: {
        version: 1,
        contractDigest: created.value.contractDigest,
        resolutionRevision: created.value.resolutionRevision,
        resolutionRoot: created.value.resolutionDigest,
        coverageRevision: created.value.coverageRevision,
        coverageRoot: created.value.coverageDigest,
      },
    });
    const exact = ready(exactRequest);
    const realDependencies: Partial<CanonicalEntityWorkflowFinalizerDependencies> = {
      listBindingsForWorkflow: (workflowId) => listWorkflowSurfaceBindingsForWorkflow(workflowId, workspaceDb),
      getBinding: (bindingId) => getWorkflowSurfaceBinding(bindingId, workspaceDb),
      compositor: exact.compositor,
      project: (input) => projectCanonicalEntityStoreToWorkspace({
        ...input,
        entityDb,
        workspaceDb,
      }),
    };
    const first = finalizeCanonicalEntityWorkflowCompletion(completion(exact.claim), realDependencies);
    const restartReplay = finalizeCanonicalEntityWorkflowCompletion(completion(exact.claim), realDependencies);
    assert.equal(first.status, 'projected');
    assert.equal(restartReplay.status, 'replayed');
    assert.equal(first.status === 'projected' && first.coverage.complete, true);
    const projected = workspaceDb.prepare(`
      SELECT projection_json FROM workspace_run_projections WHERE binding_id = ?
    `).get(identity.bindingId) as { projection_json: string };
    const projection = JSON.parse(projected.projection_json) as {
      schedule: { authority: string; enabled: boolean };
    };
    assert.deepEqual(projection.schedule, { authority: 'workflow', enabled: false });
  } finally {
    entityDb.close();
    workspaceDb.close();
  }
});
