import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';

import {
  appendCanonicalCoveragePage,
  commitCanonicalEntityBatch,
  createCanonicalDataset,
  getCanonicalDataset,
  type CanonicalEntityStoreWrite,
} from '../execution/canonical-entity-store.js';
import type {
  EntityObservationInput,
  EntityResolutionPolicy,
} from '../execution/canonical-entity-resolution.js';
import {
  getCanonicalEntityWorkspaceProjectionHead,
  projectCanonicalEntityStoreToWorkspace,
  type CanonicalDatasetProjectionAuthorityV1,
  type ProjectCanonicalEntityStoreToWorkspaceInputV1,
} from './canonical-entity-workspace-store-projection.js';
import type {
  CanonicalWorkspaceProjectionIdentityV1,
  WorkflowPartitionProjectionReceiptV1,
  WorkflowRunProjectionReceiptV1,
} from './canonical-entity-workspace-projection.js';
import { ensureWorkspaceSchema } from './workspace-db-schema.js';
import {
  getWorkspaceRunProjection,
  listWorkspaceRunPartitions,
  putWorkflowSurfaceBinding,
} from './workflow-surface-binding-store.js';
import type { WorkflowSurfaceBindingV1 } from './workflow-surface-binding.js';

const TEST_DIR = mkdtempSync(path.join(os.tmpdir(), 'clem-entity-space-projection-'));

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

const POLICY: EntityResolutionPolicy = {
  policyId: 'policy:generic:v1',
  mergeThreshold: 10,
  distinctThreshold: 2,
  ambiguityMargin: 1,
  weights: {
    defaultExactIdentifierMatch: 10,
    defaultCompoundSignalMatch: 4,
  },
  exclusiveIdentifierNamespaces: ['external-key'],
};

function requireOk<T>(result: CanonicalEntityStoreWrite<T>): T {
  if (!result.ok) assert.fail(`${result.kind}: ${result.message}`);
  return result.value;
}

function datasetAuthority(
  dataset: NonNullable<ReturnType<typeof getCanonicalDataset>>,
): CanonicalDatasetProjectionAuthorityV1 {
  return {
    version: 1,
    contractDigest: dataset.contractDigest,
    resolutionRevision: dataset.resolutionRevision,
    resolutionRoot: dataset.resolutionDigest,
    coverageRevision: dataset.coverageRevision,
    coverageRoot: dataset.coverageDigest,
  };
}

function observation(input: {
  recordId: string;
  signal: readonly [string, string];
  at: string;
}): EntityObservationInput {
  return {
    entityKind: 'generic-unit',
    origin: { sourceId: `source:${input.recordId}`, recordId: input.recordId },
    observedAt: input.at,
    fields: {
      label: {
        value: `value:${input.recordId}`,
        provenance: {
          sourceId: `source:${input.recordId}`,
          recordId: input.recordId,
          path: 'payload.label',
        },
        confidence: 0.8,
        observedAt: input.at,
      },
    },
    compoundSignals: [{
      name: 'descriptor',
      components: { left: input.signal[0], right: input.signal[1] },
    }],
  };
}

function insertWorkspace(db: Database.Database, workspaceId: string, rootDir: string): void {
  ensureWorkspaceSchema(db);
  db.prepare(`
    INSERT INTO workspaces (id, slug, title, status, root_dir, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `).run(
    workspaceId,
    workspaceId.replaceAll(':', '-'),
    'Projection Test Workspace',
    rootDir,
    '2026-08-22T08:00:00.000Z',
    '2026-08-22T08:00:00.000Z',
  );
}

function bindingFor(identity: CanonicalWorkspaceProjectionIdentityV1): WorkflowSurfaceBindingV1 {
  return {
    version: 1,
    bindingId: identity.bindingId,
    workflowId: identity.workflowId,
    workspaceId: identity.workspaceId,
    revision: 1,
    role: 'primary',
    projectionVersion: 1,
    scheduleAuthority: 'workflow',
    state: 'active',
    createdAt: '2026-08-22T08:00:00.000Z',
    updatedAt: '2026-08-22T08:00:00.000Z',
  };
}

function runReceipt(
  identity: CanonicalWorkspaceProjectionIdentityV1,
  status: WorkflowRunProjectionReceiptV1['status'] = 'running',
  sequence = 0,
): WorkflowRunProjectionReceiptV1 {
  return {
    receiptId: `receipt:run:${status}:${sequence}`,
    sequence,
    ordinal: 0,
    at: '2026-08-22T08:00:00.000Z',
    identity,
    status,
  };
}

function declarationReceipts(
  identity: CanonicalWorkspaceProjectionIdentityV1,
  partitionIds: readonly string[],
): WorkflowPartitionProjectionReceiptV1[] {
  return partitionIds.map((partitionId, index) => ({
    receiptId: `receipt:declare:${partitionId}`,
    sequence: index + 1,
    ordinal: 0,
    at: '2026-08-22T08:00:01.000Z',
    identity,
    kind: 'declared' as const,
    partitionId,
  }));
}

test('file-backed entity truth projects by exact roots, survives restart, and normalizes more than 1000 partitions', () => {
  const directory = path.join(TEST_DIR, 'large-restart');
  const entityPath = path.join(directory, 'entities.db');
  const workspacePath = path.join(directory, 'workspaces.db');
  const workspaceRoot = path.join(directory, 'space');
  const partitionIds = Array.from(
    { length: 1_005 },
    (_, index) => `partition:${String(index).padStart(4, '0')}`,
  );
  const identity: CanonicalWorkspaceProjectionIdentityV1 = {
    version: 1,
    bindingId: 'binding:large',
    workflowId: 'workflow:large',
    workspaceId: 'workspace:large',
    runId: 'run:large',
    datasetId: 'dataset:large',
  };
  mkdirSync(directory, { recursive: true });
  let entityDb = new Database(entityPath);
  let workspaceDb = new Database(workspacePath);
  try {
    entityDb.pragma('journal_mode = WAL');
    workspaceDb.pragma('journal_mode = WAL');
    workspaceDb.pragma('foreign_keys = ON');
    insertWorkspace(workspaceDb, identity.workspaceId, workspaceRoot);
    const storedBinding = putWorkflowSurfaceBinding({
      db: workspaceDb,
      binding: bindingFor(identity),
    });
    assert.equal(storedBinding.ok, true);
    if (!storedBinding.ok) assert.fail(storedBinding.errors.join('; '));

    let dataset = requireOk(createCanonicalDataset({
      datasetId: identity.datasetId,
      universe: { kind: 'closed', partitionIds },
      denominator: { kind: 'exact', total: partitionIds.length },
      createdAt: '2026-08-22T08:00:00.000Z',
      db: entityDb,
    }));
    const weakPolicy: EntityResolutionPolicy = {
      ...POLICY,
      policyId: 'policy:weak-seed',
      weights: { ...POLICY.weights, defaultCompoundSignalMatch: 1 },
    };
    const seed = requireOk(commitCanonicalEntityBatch({
      datasetId: identity.datasetId,
      expectedResolutionRevision: dataset.resolutionRevision,
      expectedResolutionDigest: dataset.resolutionDigest,
      observations: [
        observation({
          recordId: 'record:seed:a',
          signal: ['shared', 'signal'],
          at: '2026-08-22T08:01:00.000Z',
        }),
        observation({
          recordId: 'record:seed:b',
          signal: ['SHARED', ' SIGNAL '],
          at: '2026-08-22T08:02:00.000Z',
        }),
      ],
      policy: weakPolicy,
      committedAt: '2026-08-22T08:03:00.000Z',
      db: entityDb,
    }));
    dataset = getCanonicalDataset(identity.datasetId, entityDb)!;
    const ambiguousPolicy: EntityResolutionPolicy = {
      ...POLICY,
      policyId: 'policy:ambiguous',
      ambiguityMargin: 0,
      weights: { ...POLICY.weights, defaultCompoundSignalMatch: 10 },
    };
    const quarantined = requireOk(commitCanonicalEntityBatch({
      datasetId: identity.datasetId,
      expectedResolutionRevision: dataset.resolutionRevision,
      expectedResolutionDigest: dataset.resolutionDigest,
      observations: [observation({
        recordId: 'record:ambiguous',
        signal: [' shared ', 'SIGNAL'],
        at: '2026-08-22T08:04:00.000Z',
      })],
      policy: ambiguousPolicy,
      committedAt: '2026-08-22T08:05:00.000Z',
      db: entityDb,
    }));
    assert.equal(quarantined.summary.quarantinedObservations, 1);
    dataset = getCanonicalDataset(identity.datasetId, entityDb)!;
    const firstCoverage = appendCanonicalCoveragePage({
      datasetId: identity.datasetId,
      expectedCoverageRevision: dataset.coverageRevision,
      expectedCoverageDigest: dataset.coverageDigest,
      page: {
        partitionId: partitionIds[0]!,
        inputCursor: null,
        outputCursor: null,
        exhaustion: 'exhausted',
        denominator: { kind: 'exact', total: 1 },
        itemIds: ['item:0000'],
      },
      committedAt: '2026-08-22T08:06:00.000Z',
      db: entityDb,
    });
    assert.equal(firstCoverage.ok, true);
    dataset = getCanonicalDataset(identity.datasetId, entityDb)!;

    const declarations = declarationReceipts(identity, partitionIds);
    const runningSequence = declarations.length + 1;
    const partitionReceipts: WorkflowPartitionProjectionReceiptV1[] = [
      ...declarations,
      {
        receiptId: 'receipt:partition:running',
        sequence: runningSequence,
        ordinal: 0,
        at: '2026-08-22T08:02:30.000Z',
        identity,
        kind: 'status',
        partitionId: partitionIds[0]!,
        state: 'running',
        attempt: 1,
      },
    ];
    const request: ProjectCanonicalEntityStoreToWorkspaceInputV1 = {
      version: 1,
      identity,
      expectedBindingDigest: storedBinding.digest,
      expectedDatasetAuthority: datasetAuthority(dataset),
      runReceipts: [runReceipt(identity)],
      partitionReceipts,
      batchLineage: [
        {
          version: 1,
          batchId: seed.batchId,
          partitionId: partitionIds[0]!,
          attempt: 1,
          sequence: runningSequence + 1,
          ordinal: 0,
        },
        {
          version: 1,
          batchId: quarantined.batchId,
          partitionId: partitionIds[0]!,
          attempt: 1,
          sequence: runningSequence + 2,
          ordinal: 0,
        },
      ],
      coveragePosition: {
        version: 1,
        sequence: runningSequence + 3,
        ordinal: 0,
      },
      scheduleFacts: [{
        factId: 'fact:schedule:workflow-owned',
        sequence: runningSequence + 4,
        ordinal: 0,
        at: '2026-08-22T08:07:00.000Z',
        kind: 'schedule',
        enabled: false,
      }],
      entityDb,
      workspaceDb,
    };
    const first = projectCanonicalEntityStoreToWorkspace(request);
    assert.equal(first.ok, true, !first.ok ? first.errors.join('; ') : undefined);
    if (!first.ok) return;
    assert.equal(first.inserted, true);
    assert.equal(first.head.datasetAuthority.resolutionRevision, 2);
    assert.equal(first.head.datasetAuthority.resolutionRoot, dataset.resolutionDigest);
    assert.equal(first.head.datasetAuthority.coverageRoot, dataset.coverageDigest);
    assert.equal(first.head.source.resolutionBatchCount, 2);
    assert.equal(first.head.records.observationsCommitted, 3);
    assert.equal(first.head.records.canonicalRecordsCreated, 2);
    assert.equal(first.head.quarantine.observationCount, 1);
    assert.deepEqual(first.head.quarantine.reasons, { ambiguous_candidates: 1 });
    assert.equal(first.head.quarantine.reviewRefCount, 1);
    assert.equal(first.head.provenance.assertionCount, 3);
    assert.equal(first.head.provenance.summaryRefCount, 2);
    assert.equal(first.head.coverage.status, 'partial');
    assert.ok(first.head.coverage.reasons.includes('required_partitions_unseen'));
    assert.equal(first.snapshot.projection.schedule.authority, 'workflow');
    assert.equal(first.snapshot.projection.schedule.enabled, false);
    assert.equal(first.snapshot.partitions.length, partitionIds.length);
    assert.equal(
      (workspaceDb.prepare(`
        SELECT COUNT(*) AS count FROM workspace_run_partitions WHERE binding_id = ?
      `).get(identity.bindingId) as { count: number }).count,
      partitionIds.length,
    );
    const storedJson = workspaceDb.prepare(`
      SELECT projection_json FROM workspace_run_projections WHERE binding_id = ?
    `).get(identity.bindingId) as { projection_json: string };
    assert.equal(storedJson.projection_json.includes(partitionIds.at(-1)!), false);
    const persistedSidecar = (workspaceDb.prepare(`
        SELECT sidecar_json FROM workspace_canonical_entity_projection_heads WHERE binding_id = ?
      `).get(identity.bindingId) as { sidecar_json: string }).sidecar_json;
    assert.ok(Buffer.byteLength(persistedSidecar, 'utf8') < 128 * 1024);
    assert.equal(persistedSidecar.includes('record:seed'), false);
    assert.equal(persistedSidecar.includes('value:record'), false);

    const replay = projectCanonicalEntityStoreToWorkspace(request);
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.inserted, false);
    assert.equal(replay.ok && replay.headDigest, first.headDigest);

    entityDb.close();
    workspaceDb.close();
    entityDb = new Database(entityPath);
    workspaceDb = new Database(workspacePath);
    workspaceDb.pragma('foreign_keys = ON');
    const afterRestart = getCanonicalEntityWorkspaceProjectionHead(identity.bindingId, workspaceDb);
    assert.ok(afterRestart);
    assert.equal(afterRestart.headDigest, first.headDigest);
    assert.equal(afterRestart.datasetAuthority.resolutionRoot, dataset.resolutionDigest);
    assert.equal(getWorkspaceRunProjection(identity.bindingId, workspaceDb)?.partitions.length, partitionIds.length);
    const paged: string[] = [];
    let afterPartitionId: string | undefined;
    while (true) {
      const page = listWorkspaceRunPartitions(identity.bindingId, {
        db: workspaceDb,
        afterPartitionId,
        limit: 137,
      });
      paged.push(...page.map((entry) => entry.partitionId));
      if (page.length < 137) break;
      afterPartitionId = page.at(-1)!.partitionId;
    }
    assert.deepEqual(paged, partitionIds);
    const restartReplay = projectCanonicalEntityStoreToWorkspace({
      ...request,
      entityDb,
      workspaceDb,
    });
    assert.equal(restartReplay.ok, true);
    assert.equal(restartReplay.ok && restartReplay.inserted, false);

    const current = getCanonicalDataset(identity.datasetId, entityDb)!;
    const secondCoverage = appendCanonicalCoveragePage({
      datasetId: identity.datasetId,
      expectedCoverageRevision: current.coverageRevision,
      expectedCoverageDigest: current.coverageDigest,
      page: {
        partitionId: partitionIds[1]!,
        inputCursor: null,
        outputCursor: null,
        exhaustion: 'exhausted',
        denominator: { kind: 'exact', total: 1 },
        itemIds: ['item:0001'],
      },
      committedAt: '2026-08-22T08:08:00.000Z',
      db: entityDb,
    });
    assert.equal(secondCoverage.ok, true);
    const stale = projectCanonicalEntityStoreToWorkspace({
      ...request,
      entityDb,
      workspaceDb,
    });
    assert.deepEqual(stale.ok ? null : stale.kind, 'stale_source');
    assert.equal(
      getCanonicalEntityWorkspaceProjectionHead(identity.bindingId, workspaceDb)?.headDigest,
      first.headDigest,
    );

    const advanced = getCanonicalDataset(identity.datasetId, entityDb)!;
    const wrongCas = projectCanonicalEntityStoreToWorkspace({
      ...request,
      expectedDatasetAuthority: datasetAuthority(advanced),
      expectedHeadDigest: '0'.repeat(64),
      coveragePosition: {
        version: 1,
        sequence: runningSequence + 5,
        ordinal: 0,
      },
      entityDb,
      workspaceDb,
    });
    assert.deepEqual(wrongCas.ok ? null : wrongCas.kind, 'conflict');
    const advancedProjection = projectCanonicalEntityStoreToWorkspace({
      ...request,
      expectedDatasetAuthority: datasetAuthority(advanced),
      expectedHeadDigest: first.headDigest,
      coveragePosition: {
        version: 1,
        sequence: runningSequence + 5,
        ordinal: 0,
      },
      entityDb,
      workspaceDb,
    });
    assert.equal(
      advancedProjection.ok,
      true,
      !advancedProjection.ok ? advancedProjection.errors.join('; ') : undefined,
    );
    if (advancedProjection.ok) {
      assert.equal(advancedProjection.head.datasetAuthority.coverageRevision, 2);
      assert.equal(advancedProjection.head.coverage.status, 'partial');
      assert.notEqual(advancedProjection.headDigest, first.headDigest);
    }
    const sidecarRow = workspaceDb.prepare(`
      SELECT sidecar_json FROM workspace_canonical_entity_projection_heads
      WHERE binding_id = ?
    `).get(identity.bindingId) as { sidecar_json: string };
    const corrupted = { ...JSON.parse(sidecarRow.sidecar_json), executionAuthority: true };
    workspaceDb.prepare(`
      UPDATE workspace_canonical_entity_projection_heads
      SET sidecar_json = ? WHERE binding_id = ?
    `).run(JSON.stringify(corrupted), identity.bindingId);
    assert.throws(
      () => getCanonicalEntityWorkspaceProjectionHead(identity.bindingId, workspaceDb),
      /unsupported shape/,
    );
    const cannotBlessCorruption = projectCanonicalEntityStoreToWorkspace({
      ...request,
      expectedDatasetAuthority: datasetAuthority(advanced),
      expectedHeadDigest: advancedProjection.ok ? advancedProjection.headDigest : first.headDigest,
      coveragePosition: {
        version: 1,
        sequence: runningSequence + 5,
        ordinal: 0,
      },
      entityDb,
      workspaceDb,
    });
    assert.deepEqual(
      cannotBlessCorruption.ok ? null : cannotBlessCorruption.kind,
      'corrupt_source',
    );
  } finally {
    if (entityDb.open) entityDb.close();
    if (workspaceDb.open) workspaceDb.close();
  }
});

test('complete, unknown, and cursor-cycle coverage preserve fail-closed visual status', () => {
  const scenarios = [
    { name: 'complete', cycle: false, unknown: false },
    { name: 'unknown', cycle: false, unknown: true },
    { name: 'cycle', cycle: true, unknown: false },
  ] as const;
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const entityDb = new Database(':memory:');
    const workspaceDb = new Database(':memory:');
    try {
      const suffix = scenario.name;
      const identity: CanonicalWorkspaceProjectionIdentityV1 = {
        version: 1,
        bindingId: `binding:${suffix}`,
        workflowId: `workflow:${suffix}`,
        workspaceId: `workspace:${suffix}`,
        runId: `run:${suffix}`,
        datasetId: `dataset:${suffix}`,
      };
      workspaceDb.pragma('foreign_keys = ON');
      insertWorkspace(workspaceDb, identity.workspaceId, path.join(TEST_DIR, `space-${suffix}`));
      const storedBinding = putWorkflowSurfaceBinding({
        db: workspaceDb,
        binding: bindingFor(identity),
      });
      assert.equal(storedBinding.ok, true);
      if (!storedBinding.ok) continue;
      let dataset = requireOk(createCanonicalDataset({
        datasetId: identity.datasetId,
        universe: { kind: 'closed', partitionIds: ['partition:only'] },
        denominator: scenario.unknown ? { kind: 'unknown' } : { kind: 'exact', total: scenario.cycle ? 3 : 1 },
        createdAt: `2026-08-22T0${scenarioIndex + 1}:00:00.000Z`,
        db: entityDb,
      }));
      const append = (page: Parameters<typeof appendCanonicalCoveragePage>[0]['page'], at: string) => {
        const result = appendCanonicalCoveragePage({
          datasetId: identity.datasetId,
          expectedCoverageRevision: dataset.coverageRevision,
          expectedCoverageDigest: dataset.coverageDigest,
          page,
          committedAt: at,
          db: entityDb,
        });
        assert.equal(result.ok, true);
        dataset = getCanonicalDataset(identity.datasetId, entityDb)!;
      };
      if (scenario.cycle) {
        append({
          partitionId: 'partition:only', inputCursor: null, outputCursor: 'cursor:a',
          exhaustion: 'more', denominator: { kind: 'exact', total: 3 }, itemIds: ['item:a'],
        }, '2026-08-22T10:01:00.000Z');
        append({
          partitionId: 'partition:only', inputCursor: 'cursor:a', outputCursor: 'cursor:b',
          exhaustion: 'more', denominator: { kind: 'exact', total: 3 }, itemIds: ['item:b'],
        }, '2026-08-22T10:02:00.000Z');
        append({
          partitionId: 'partition:only', inputCursor: 'cursor:b', outputCursor: 'cursor:a',
          exhaustion: 'more', denominator: { kind: 'exact', total: 3 }, itemIds: ['item:c'],
        }, '2026-08-22T10:03:00.000Z');
      } else {
        append({
          partitionId: 'partition:only',
          inputCursor: null,
          outputCursor: null,
          exhaustion: scenario.unknown ? 'unknown' : 'exhausted',
          denominator: scenario.unknown ? { kind: 'unknown' } : { kind: 'exact', total: 1 },
          itemIds: ['item:only'],
        }, '2026-08-22T10:01:00.000Z');
      }
      const declared = declarationReceipts(identity, ['partition:only']);
      const partitionReceipts: WorkflowPartitionProjectionReceiptV1[] = [
        ...declared,
        {
          receiptId: 'receipt:partition:running',
          sequence: 2,
          ordinal: 0,
          at: '2026-08-22T10:00:30.000Z',
          identity,
          kind: 'status',
          partitionId: 'partition:only',
          state: 'running',
          attempt: 1,
        },
        ...(!scenario.cycle && !scenario.unknown ? [{
          receiptId: 'receipt:partition:completed',
          sequence: 3,
          ordinal: 0,
          at: '2026-08-22T10:01:30.000Z',
          identity,
          kind: 'status' as const,
          partitionId: 'partition:only',
          state: 'completed' as const,
          attempt: 1,
        }] : []),
      ];
      const result = projectCanonicalEntityStoreToWorkspace({
        version: 1,
        identity,
        expectedBindingDigest: storedBinding.digest,
        expectedDatasetAuthority: datasetAuthority(dataset),
        runReceipts: [runReceipt(identity)],
        partitionReceipts,
        batchLineage: [],
        coveragePosition: { version: 1, sequence: 4, ordinal: 0 },
        entityDb,
        workspaceDb,
      });
      assert.equal(result.ok, true, !result.ok ? result.errors.join('; ') : undefined);
      if (!result.ok) continue;
      assert.equal(
        getCanonicalEntityWorkspaceProjectionHead(identity.bindingId, workspaceDb)?.headDigest,
        result.headDigest,
      );
      if (scenario.name === 'complete') {
        assert.equal(result.head.coverage.status, 'complete');
        assert.equal(result.snapshot.projection.coverage.status, 'complete');
      } else {
        assert.notEqual(result.head.coverage.status, 'complete');
        assert.notEqual(result.snapshot.projection.coverage.status, 'complete');
      }
      if (scenario.cycle) {
        assert.ok(result.head.coverage.reasons.includes('cursor_cycle_detected'));
      }
    } finally {
      entityDb.close();
      workspaceDb.close();
    }
  }
});
