import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import type { WorkflowEntry, WorkflowTrigger } from '../memory/workflow-store.js';
import type { CanonicalEntityWorkspaceProjectionHeadV1 } from '../spaces/canonical-entity-workspace-store-projection.js';
import type {
  WorkflowSurfaceBindingV1,
  WorkspacePartitionProjectionV1,
} from '../spaces/workflow-surface-binding.js';
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workspace-canonical-api-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  __test__,
  readWorkspaceCanonicalEntityProjectionPage,
} = await import('./workspace-canonical-entity-projection.js');
type WorkspaceCanonicalEntityProjectionSources =
  import('./workspace-canonical-entity-projection.js').WorkspaceCanonicalEntityProjectionSources;

after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function binding(overrides: Partial<WorkflowSurfaceBindingV1 & { digest: string }> = {}) {
  return {
    version: 1 as const,
    bindingId: 'binding:entities',
    workflowId: 'entity-refresh',
    workspaceId: 'entity-workspace',
    revision: 1,
    role: 'primary' as const,
    projectionVersion: 1 as const,
    scheduleAuthority: 'workflow' as const,
    state: 'active' as const,
    createdAt: '2026-08-22T08:00:00.000Z',
    updatedAt: '2026-08-22T08:00:00.000Z',
    digest: DIGEST_A,
    ...overrides,
  };
}

function head(overrides: Partial<CanonicalEntityWorkspaceProjectionHeadV1 & { headDigest: string }> = {}) {
  return {
    version: 1 as const,
    identity: {
      version: 1 as const,
      bindingId: 'binding:entities',
      workflowId: 'entity-refresh',
      workspaceId: 'entity-workspace',
      runId: 'run:entities:1',
      datasetId: 'dataset:entities',
    },
    bindingDigest: DIGEST_A,
    datasetAuthority: {
      version: 1 as const,
      contractDigest: DIGEST_B,
      resolutionRevision: 4,
      resolutionRoot: DIGEST_B,
      coverageRevision: 3,
      coverageRoot: DIGEST_C,
    },
    canonicalSourceDigest: DIGEST_B,
    workspaceProjectionDigest: DIGEST_C,
    source: {
      resolutionBatchCount: 10,
      recordArtifactRefCount: 10,
      recordArtifactRefs: Array.from({ length: 10 }, (_, index) => `artifact:${index}`),
    },
    records: {
      observationsCommitted: 42,
      canonicalRecordsCreated: 30,
      mergedObservations: 9,
      replayedObservations: 2,
      duplicateObservations: 7,
    },
    provenance: {
      assertionCount: 81,
      summedBatchOriginCount: 12,
      summaryRefCount: 10,
      summaryRefs: Array.from({ length: 10 }, (_, index) => `provenance:${index}`),
    },
    quarantine: {
      observationCount: 3,
      reasons: { ambiguous_candidates: 3 },
      reviewRefCount: 10,
      reviewRefs: Array.from({ length: 10 }, (_, index) => `quarantine:${index}`),
    },
    coverage: {
      status: 'partial' as const,
      sourceStatus: 'partial' as const,
      partitionUniverse: 'closed' as const,
      declaredPartitions: 3,
      observedPartitions: 2,
      observed: 42,
      denominator: { kind: 'exact' as const, total: 60 },
      exhaustion: 'not_exhausted' as const,
      reasons: ['partitions_not_exhausted'],
      evidenceRef: 'coverage:evidence',
    },
    projectedAt: '2026-08-22T09:00:00.000Z',
    headDigest: DIGEST_A,
    ...overrides,
  };
}

function partition(id: string): WorkspacePartitionProjectionV1 {
  return {
    version: 1,
    partitionId: id,
    state: id === 'partition:c' ? 'pending' : 'completed',
    attempt: 1,
    observationsCommitted: 14,
    canonicalRecords: 10,
    duplicateObservations: 2,
    updatedAt: '2026-08-22T09:00:00.000Z',
  };
}

function workflow(trigger: WorkflowTrigger = {
  schedule: '0 */2 * * *',
  timezone: 'America/Los_Angeles',
}): WorkflowEntry {
  return {
    name: 'entity-refresh',
    dir: '/tmp/workflows/entity-refresh',
    filePath: '/tmp/workflows/entity-refresh/SKILL.md',
    layout: 'directory',
    data: {
      name: 'Entity Refresh',
      description: 'Typed fixture',
      enabled: true,
      trigger,
      steps: [],
    },
  };
}

function sources(overrides: Partial<WorkspaceCanonicalEntityProjectionSources> = {}) {
  const rows = ['partition:a', 'partition:b', 'partition:c'].map(partition);
  const value: WorkspaceCanonicalEntityProjectionSources = {
    listBindings: () => [binding()],
    getHead: () => head(),
    listPartitions: (_bindingId, options) => rows
      .filter((row) => row.partitionId > (options.afterPartitionId ?? ''))
      .slice(0, options.limit),
    readWorkflow: () => workflow(),
    ...overrides,
  };
  return value;
}

test('canonical Workspace API view is bounded, definition-only, and keyset-paginates one pinned head', () => {
  const first = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    limit: 2,
    sources: sources(),
  });
  assert.equal(first.ok, true);
  if (!first.ok || first.value.status !== 'available') return;
  assert.deepEqual(first.value.head.records, {
    observationsCommitted: 42,
    canonicalRecords: 30,
    mergedObservations: 9,
    replayedObservations: 2,
    duplicateObservations: 7,
  });
  assert.equal(first.value.head.quarantine.observationCount, 3);
  assert.equal(first.value.head.provenance.references.length, 8);
  assert.equal(first.value.head.provenance.referencesTruncated, true);
  assert.equal(first.value.head.quarantine.references.length, 8);
  assert.equal(first.value.head.quarantine.referencesTruncated, true);
  assert.deepEqual(first.value.partitions.items.map((row) => row.partitionId), [
    'partition:a',
    'partition:b',
  ]);
  assert.equal(first.value.partitions.hasMore, true);
  assert.ok(first.value.partitions.nextCursor);
  assert.deepEqual(first.value.recurrence, {
    authority: 'workflow_definition',
    configurationOnly: true,
    definitionEnabled: true,
    trigger: {
      kind: 'cron',
      expression: '0 */2 * * *',
      timezone: 'America/Los_Angeles',
    },
  });
  const decoded = __test__.decodeCursor(first.value.partitions.nextCursor!);
  assert.equal(decoded?.workspaceId, 'entity-workspace');
  assert.equal(decoded?.bindingId, 'binding:entities');
  assert.equal(decoded?.headDigest, DIGEST_A);
  assert.equal(decoded?.afterPartitionId, 'partition:b');

  const second = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    cursor: first.value.partitions.nextCursor,
    limit: 2,
    sources: sources(),
  });
  assert.equal(second.ok, true);
  if (!second.ok || second.value.status !== 'available') return;
  assert.deepEqual(second.value.partitions.items.map((row) => row.partitionId), ['partition:c']);
  assert.equal(second.value.partitions.hasMore, false);
  assert.equal(second.value.partitions.nextCursor, undefined);
});

test('foreign, stale, corrupt, and cycling partition reads fail closed', () => {
  const first = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    limit: 1,
    sources: sources(),
  });
  assert.equal(first.ok, true);
  if (!first.ok || first.value.status !== 'available') return;
  const cursor = first.value.partitions.nextCursor!;

  const foreign = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'another-workspace',
    cursor,
    sources: sources({ listBindings: () => { throw new Error('must reject before lookup'); } }),
  });
  assert.deepEqual(foreign.ok ? null : foreign.kind, 'foreign_binding');

  const staleBinding = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    cursor,
    sources: sources({ listBindings: () => [binding({ bindingId: 'binding:new' })] }),
  });
  assert.deepEqual(staleBinding.ok ? null : staleBinding.kind, 'stale_binding');

  const staleHead = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    cursor,
    sources: sources({ getHead: () => head({ headDigest: DIGEST_B }) }),
  });
  assert.deepEqual(staleHead.ok ? null : staleHead.kind, 'stale_projection');

  const corrupt = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    sources: sources({ getHead: () => { throw new Error('malformed sidecar'); } }),
  });
  assert.deepEqual(corrupt.ok ? null : corrupt.kind, 'integrity_failure');

  const foreignHead = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    sources: sources({
      getHead: () => head({
        identity: { ...head().identity, workspaceId: 'foreign-workspace' },
      }),
    }),
  });
  assert.deepEqual(foreignHead.ok ? null : foreignHead.kind, 'foreign_binding');

  const cycle = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    cursor,
    sources: sources({
      listPartitions: (_bindingId, options) => [partition(options.afterPartitionId!)],
    }),
  });
  assert.deepEqual(cycle.ok ? null : cycle.kind, 'cursor_cycle');
});

test('absent projection data stays explicitly unavailable and never falls back to raw bodies', () => {
  let partitionReads = 0;
  const noBinding = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    sources: sources({ listBindings: () => [] }),
  });
  assert.deepEqual(noBinding, {
    ok: true,
    value: {
      version: 1,
      status: 'unavailable',
      workspaceId: 'entity-workspace',
      reason: 'canonical_binding_not_configured',
    },
  });
  const noHead = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    sources: sources({
      getHead: () => null,
      listPartitions: () => { partitionReads += 1; return []; },
    }),
  });
  assert.equal(noHead.ok && noHead.value.status, 'unavailable');
  assert.equal(noHead.ok && noHead.value.status === 'unavailable' && noHead.value.reason, 'projection_not_ready');
  assert.equal(partitionReads, 0);
});

test('typed recurrence failures are displayed as unavailable configuration, never activation truth', () => {
  const conflicting = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    sources: sources({
      readWorkflow: () => workflow({
        schedule: '0 * * * *',
        interval: {
          version: 1,
          every: 2,
          unit: 'hour',
          anchorAt: '2026-08-22T08:00:00.000Z',
          overlapPolicy: 'skip',
          catchUpPolicy: 'run_once',
        },
      }),
    }),
  });
  assert.equal(conflicting.ok, true);
  if (!conflicting.ok || conflicting.value.status !== 'available') return;
  assert.deepEqual(conflicting.value.recurrence.trigger, {
    kind: 'unavailable',
    reason: 'conflicting_trigger_configuration',
  });
  assert.equal('active' in conflicting.value.recurrence, false);
  assert.equal('nextOccurrenceAt' in conflicting.value.recurrence, false);

  let unsafeReads = 0;
  const unsafeWorkflowId = 'workflow/../../foreign';
  const unsafeKey = readWorkspaceCanonicalEntityProjectionPage({
    workspaceId: 'entity-workspace',
    sources: sources({
      listBindings: () => [binding({ workflowId: unsafeWorkflowId })],
      getHead: () => head({
        identity: { ...head().identity, workflowId: unsafeWorkflowId },
      }),
      readWorkflow: () => { unsafeReads += 1; return workflow(); },
    }),
  });
  assert.equal(unsafeKey.ok, true);
  if (!unsafeKey.ok || unsafeKey.value.status !== 'available') return;
  assert.equal(unsafeReads, 0);
  assert.deepEqual(unsafeKey.value.recurrence.trigger, {
    kind: 'unavailable',
    reason: 'workflow_definition_unavailable',
  });
});

test('API projection source has no raw entity, provider payload, or prose-inference read path', () => {
  const source = readFileSync(
    new URL('./workspace-canonical-entity-projection.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /getCanonicalEntityWorkspaceProjectionHead/);
  assert.match(source, /listWorkspaceRunPartitions/);
  assert.doesNotMatch(source, /execution\/canonical-entity-store\.js/);
  assert.doesNotMatch(source, /getWorkspaceRunProjection/);
  assert.doesNotMatch(source, /provider(?:Data|Payload)|description_body|linkedWorkflowsForSpace/);
});
