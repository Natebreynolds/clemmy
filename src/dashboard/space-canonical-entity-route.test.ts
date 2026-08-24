import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { CanonicalEntityStoreWrite } from '../execution/canonical-entity-store.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-canonical-route-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const express = (await import('express')).default;
const Database = (await import('better-sqlite3')).default;
const { registerSpaceRoutes } = await import('./space-routes.js');
const { spaceStore } = await import('../spaces/store.js');
const {
  closeWorkspaceDb,
  indexWorkspaceRecord,
  openWorkspaceDb,
} = await import('../spaces/workspace-db.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const {
  appendCanonicalCoveragePage,
  commitCanonicalEntityBatch,
  createCanonicalDataset,
  getCanonicalDataset,
} = await import('../execution/canonical-entity-store.js');
const { putWorkflowSurfaceBinding } = await import('../spaces/workflow-surface-binding-store.js');
const {
  projectCanonicalEntityStoreToWorkspace,
} = await import('../spaces/canonical-entity-workspace-store-projection.js');

let server: Server | undefined;
let base = '';
let entityDb: InstanceType<typeof Database> | undefined;

function requireWrite<T>(result: CanonicalEntityStoreWrite<T>): T {
  if (!result.ok) throw new Error(`${result.kind}: ${result.message}`);
  return result.value;
}

function seedCanonicalProjection(): void {
  const workspace = spaceStore.save({ id: 'entity-workspace', title: 'Canonical Records' });
  indexWorkspaceRecord(workspace, { emitOperational: false, appendStateEvent: false });
  writeWorkflow('entity-refresh', {
    name: 'Entity Refresh',
    description: 'Typed route fixture',
    enabled: true,
    trigger: { schedule: '0 */2 * * *', timezone: 'UTC' },
    steps: [],
  });
  const workspaceDb = openWorkspaceDb();
  const identity = {
    version: 1 as const,
    bindingId: 'binding:entities',
    workflowId: 'entity-refresh',
    workspaceId: 'entity-workspace',
    runId: 'run:entities:1',
    datasetId: 'dataset:entities',
  };
  const storedBinding = putWorkflowSurfaceBinding({
    db: workspaceDb,
    binding: {
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
    },
  });
  if (!storedBinding.ok) throw new Error(storedBinding.errors.join('; '));
  entityDb = new Database(path.join(TEST_HOME, 'state', 'canonical-route-entities.db'));
  const partitions = ['partition:a', 'partition:b', 'partition:c'];
  let dataset = requireWrite(createCanonicalDataset({
    datasetId: identity.datasetId,
    universe: { kind: 'closed', partitionIds: partitions },
    denominator: { kind: 'exact', total: 3 },
    createdAt: '2026-08-22T08:00:00.000Z',
    db: entityDb,
  }));
  const batch = requireWrite(commitCanonicalEntityBatch({
    datasetId: identity.datasetId,
    expectedResolutionRevision: dataset.resolutionRevision,
    expectedResolutionDigest: dataset.resolutionDigest,
    observations: [{
      entityKind: 'generic-unit',
      origin: { sourceId: 'source:directory', recordId: 'record:one' },
      observedAt: '2026-08-22T08:01:00.000Z',
      fields: {
        name: {
          value: 'Example Record',
          provenance: {
            sourceId: 'source:directory',
            recordId: 'record:one',
            path: 'record.name',
          },
          confidence: 0.9,
          observedAt: '2026-08-22T08:01:00.000Z',
        },
      },
      exactIdentifiers: [{ namespace: 'source-record-id', value: 'example-record' }],
    }],
    policy: {
      policyId: 'policy:route:v1',
      mergeThreshold: 10,
      distinctThreshold: 2,
      ambiguityMargin: 1,
      weights: { defaultExactIdentifierMatch: 10, defaultCompoundSignalMatch: 4 },
      exclusiveIdentifierNamespaces: ['source-record-id'],
    },
    committedAt: '2026-08-22T08:02:00.000Z',
    db: entityDb,
  }));
  dataset = getCanonicalDataset(identity.datasetId, entityDb)!;
  const coverage = appendCanonicalCoveragePage({
    datasetId: identity.datasetId,
    expectedCoverageRevision: dataset.coverageRevision,
    expectedCoverageDigest: dataset.coverageDigest,
    page: {
      partitionId: partitions[0]!,
      inputCursor: null,
      outputCursor: null,
      exhaustion: 'exhausted',
      denominator: { kind: 'exact', total: 1 },
      itemIds: ['item:one'],
    },
    committedAt: '2026-08-22T08:03:00.000Z',
    db: entityDb,
  });
  if (!coverage.ok) throw new Error(`${coverage.kind}: ${coverage.message}`);
  dataset = getCanonicalDataset(identity.datasetId, entityDb)!;
  const projected = projectCanonicalEntityStoreToWorkspace({
    version: 1,
    identity,
    expectedBindingDigest: storedBinding.digest,
    expectedDatasetAuthority: {
      version: 1,
      contractDigest: dataset.contractDigest,
      resolutionRevision: dataset.resolutionRevision,
      resolutionRoot: dataset.resolutionDigest,
      coverageRevision: dataset.coverageRevision,
      coverageRoot: dataset.coverageDigest,
    },
    runReceipts: [{
      receiptId: 'receipt:run:one',
      sequence: 0,
      ordinal: 0,
      at: '2026-08-22T08:00:00.000Z',
      identity,
      status: 'running',
    }],
    partitionReceipts: [
      ...partitions.map((partitionId, index) => ({
        receiptId: `receipt:declare:${partitionId}`,
        sequence: index + 1,
        ordinal: 0,
        at: '2026-08-22T08:00:30.000Z',
        identity,
        kind: 'declared' as const,
        partitionId,
      })),
      {
        receiptId: 'receipt:partition:a:running',
        sequence: 4,
        ordinal: 0,
        at: '2026-08-22T08:03:30.000Z',
        identity,
        kind: 'status' as const,
        partitionId: 'partition:a',
        state: 'running' as const,
        attempt: 1,
      },
    ],
    batchLineage: [{
      version: 1,
      batchId: batch.batchId,
      partitionId: 'partition:a',
      attempt: 1,
      sequence: 5,
      ordinal: 0,
    }],
    coveragePosition: { version: 1, sequence: 6, ordinal: 0 },
    entityDb,
    workspaceDb,
  });
  if (!projected.ok) throw new Error(projected.errors.join('; '));
}

before(async () => {
  spaceStore.save({ id: 'empty-workspace', title: 'Empty Workspace' });
  seedCanonicalProjection();
  const app = express();
  app.use(express.json());
  registerSpaceRoutes(app, (request) => request.get('x-test-auth') === 'yes');
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  entityDb?.close();
  closeWorkspaceDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function request(pathname: string, authorized = true) {
  const response = await fetch(`${base}${pathname}`, {
    headers: authorized ? { 'x-test-auth': 'yes' } : {},
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null) as Record<string, unknown> | null,
  };
}

test('canonical entity projection route is authenticated and unavailable is neutral structured data', async () => {
  const unauthorized = await request(
    '/api/console/spaces/empty-workspace/canonical-entity-projection',
    false,
  );
  assert.equal(unauthorized.status, 401);

  const available = await request(
    '/api/console/spaces/empty-workspace/canonical-entity-projection',
  );
  assert.equal(available.status, 200);
  assert.deepEqual(available.body, {
    version: 1,
    status: 'unavailable',
    workspaceId: 'empty-workspace',
    reason: 'canonical_binding_not_configured',
  });

  const missing = await request('/api/console/spaces/not-here/canonical-entity-projection');
  assert.equal(missing.status, 404);
});

test('canonical entity projection route serves normalized keyset pages pinned to one head', async () => {
  const first = await request(
    '/api/console/spaces/entity-workspace/canonical-entity-projection?limit=2',
  );
  assert.equal(first.status, 200);
  assert.equal(first.body?.status, 'available');
  const head = first.body?.head as Record<string, unknown>;
  const records = head.records as Record<string, unknown>;
  assert.equal(records.canonicalRecords, 1);
  assert.equal(records.mergedObservations, 0);
  const recurrence = first.body?.recurrence as Record<string, unknown>;
  assert.equal(recurrence.configurationOnly, true);
  assert.equal('active' in recurrence, false);
  assert.equal('nextOccurrenceAt' in recurrence, false);
  assert.deepEqual(recurrence.trigger, {
    kind: 'cron',
    expression: '0 */2 * * *',
    timezone: 'UTC',
  });
  const firstPartitions = first.body?.partitions as {
    items: Array<{ partitionId: string }>;
    hasMore: boolean;
    nextCursor?: string;
  };
  assert.deepEqual(firstPartitions.items.map((item) => item.partitionId), [
    'partition:a',
    'partition:b',
  ]);
  assert.equal(firstPartitions.hasMore, true);
  assert.ok(firstPartitions.nextCursor);

  const second = await request(
    `/api/console/spaces/entity-workspace/canonical-entity-projection?limit=2&cursor=${encodeURIComponent(firstPartitions.nextCursor!)}`,
  );
  assert.equal(second.status, 200);
  const secondPartitions = second.body?.partitions as {
    items: Array<{ partitionId: string }>;
    hasMore: boolean;
  };
  assert.deepEqual(secondPartitions.items.map((item) => item.partitionId), ['partition:c']);
  assert.equal(secondPartitions.hasMore, false);

  const foreign = await request(
    `/api/console/spaces/empty-workspace/canonical-entity-projection?cursor=${encodeURIComponent(firstPartitions.nextCursor!)}`,
  );
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body?.code, 'CANONICAL_PROJECTION_FOREIGN_BINDING');
});

test('canonical entity projection route rejects malformed and multi-value pagination queries', async () => {
  for (const pathname of [
    '/api/console/spaces/entity-workspace/canonical-entity-projection?limit=0',
    '/api/console/spaces/entity-workspace/canonical-entity-projection?limit=101',
    '/api/console/spaces/entity-workspace/canonical-entity-projection?limit=nope',
    '/api/console/spaces/entity-workspace/canonical-entity-projection?limit=1&limit=2',
    '/api/console/spaces/entity-workspace/canonical-entity-projection?cursor=a&cursor=b',
    '/api/console/spaces/entity-workspace/canonical-entity-projection?cursor=%25%25%25',
  ]) {
    const response = await request(pathname);
    assert.equal(response.status, 400, pathname);
    assert.match(String(response.body?.error ?? ''), /invalid/i, pathname);
  }
});
