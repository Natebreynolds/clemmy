import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkspaceRunProjection,
  validateWorkspaceRunProjectionSnapshot,
  validateWorkflowSurfaceBinding,
  workflowSurfaceBindingDigest,
  workspaceRunProjectionSnapshotDigest,
  type WorkflowSurfaceBindingV1,
  type WorkspaceProjectionFactV1,
} from './workflow-surface-binding.js';

const binding: WorkflowSurfaceBindingV1 = {
  version: 1,
  bindingId: 'binding:alpha',
  workflowId: 'workflow:alpha',
  workspaceId: 'workspace:alpha',
  revision: 1,
  role: 'primary',
  projectionVersion: 1,
  scheduleAuthority: 'workflow',
  state: 'active',
  createdAt: '2026-08-22T08:00:00.000Z',
  updatedAt: '2026-08-22T08:00:00.000Z',
};

test('workflow surface binding admits only an explicit workflow-owned schedule relationship', () => {
  assert.deepEqual(validateWorkflowSurfaceBinding(binding), { ok: true, errors: [] });
  assert.equal(workflowSurfaceBindingDigest(binding).length, 64);
  const invalid = validateWorkflowSurfaceBinding({
    ...binding,
    scheduleAuthority: 'workspace',
    workflowId: ' inferred from prose ',
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' | '), /scheduleAuthority must be workflow/);
  assert.match(invalid.errors.join(' | '), /workflowId must be a canonical/);
});

const facts: WorkspaceProjectionFactV1[] = [
  { factId: 'fact:01', sequence: 1, ordinal: 0, kind: 'run_status', runId: 'run:1', status: 'running', at: '2026-08-22T08:01:00.000Z' },
  { factId: 'fact:03', sequence: 2, ordinal: 1, kind: 'partition_declared', partitionId: 'segment:b', at: '2026-08-22T08:02:00.000Z' },
  { factId: 'fact:02', sequence: 2, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:a', at: '2026-08-22T08:02:00.000Z' },
  {
    factId: 'fact:04',
    sequence: 3,
    ordinal: 0,
    kind: 'record_batch_committed',
    partitionId: 'segment:a',
    observationCount: 3,
    canonicalRecordCount: 2,
    artifactRef: 'artifact:a',
    provenanceSummaryRef: 'provenance:a',
    at: '2026-08-22T08:03:00.000Z',
  },
  {
    factId: 'fact:05',
    sequence: 4,
    ordinal: 0,
    kind: 'partition_status',
    partitionId: 'segment:a',
    state: 'completed',
    attempt: 1,
    at: '2026-08-22T08:04:00.000Z',
  },
  {
    factId: 'fact:06',
    sequence: 5,
    ordinal: 0,
    kind: 'partition_status',
    partitionId: 'segment:b',
    state: 'completed',
    attempt: 1,
    at: '2026-08-22T08:05:00.000Z',
  },
  {
    factId: 'fact:07',
    sequence: 6,
    ordinal: 0,
    kind: 'coverage_evidence',
    status: 'complete',
    declaredPartitions: 2,
    evidenceRef: 'coverage:1',
    at: '2026-08-22T08:06:00.000Z',
  },
  { factId: 'fact:08', sequence: 7, ordinal: 0, kind: 'schedule', enabled: true, nextOccurrenceAt: '2026-08-23T08:00:00.000Z', at: '2026-08-22T08:07:00.000Z' },
  { factId: 'fact:09', sequence: 8, ordinal: 0, kind: 'run_status', runId: 'run:1', status: 'completed', at: '2026-08-22T08:08:00.000Z' },
];

test('projection is deterministic, idempotent, and keeps the workflow as schedule owner', () => {
  const forward = buildWorkspaceRunProjection(binding, facts);
  const permuted = buildWorkspaceRunProjection(binding, [...facts].reverse().concat(facts[3]!));
  assert.deepEqual(permuted, forward);
  assert.equal(workspaceRunProjectionSnapshotDigest(permuted), workspaceRunProjectionSnapshotDigest(forward));
  assert.equal(forward.projection.schedule.authority, 'workflow');
  assert.equal(forward.projection.schedule.enabled, true);
  assert.equal(forward.projection.coverage.status, 'complete');
  assert.equal(forward.projection.records.observationsCommitted, 3);
  assert.equal(forward.projection.records.canonicalRecords, 2);
  assert.deepEqual(forward.partitions.map((partition) => partition.partitionId), ['segment:a', 'segment:b']);
  assert.deepEqual(validateWorkspaceRunProjectionSnapshot(forward), { ok: true, errors: [] });
});

test('complete coverage fails closed without a denominator or with unfinished partitions', () => {
  assert.throws(
    () => buildWorkspaceRunProjection(binding, [{
      factId: 'fact:missing-denominator',
      sequence: 1,
      ordinal: 0,
      kind: 'coverage_evidence',
      status: 'complete',
      evidenceRef: 'coverage:missing-denominator',
      at: '2026-08-22T08:01:00.000Z',
    }]),
    /explicit declared partition count/,
  );
  assert.throws(
    () => buildWorkspaceRunProjection(binding, [
      { factId: 'fact:declare-a', sequence: 1, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:a', at: '2026-08-22T08:01:00.000Z' },
      {
        factId: 'fact:contradictory',
        sequence: 2,
        ordinal: 0,
        kind: 'coverage_evidence',
        status: 'complete',
        declaredPartitions: 1,
        evidenceRef: 'coverage:contradictory',
        at: '2026-08-22T08:02:00.000Z',
      },
    ]),
    /contradicts durable partition state/,
  );
});

test('projection refuses undeclared partitions and backwards attempts', () => {
  assert.throws(
    () => buildWorkspaceRunProjection(binding, [{
      factId: 'fact:status-undeclared',
      sequence: 1,
      ordinal: 0,
      kind: 'partition_status',
      partitionId: 'segment:a',
      state: 'running',
      attempt: 1,
      at: '2026-08-22T08:01:00.000Z',
    }]),
    /was not declared/,
  );
  assert.throws(
    () => buildWorkspaceRunProjection(binding, [
      { factId: 'fact:declare', sequence: 1, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:a', at: '2026-08-22T08:01:00.000Z' },
      { factId: 'fact:attempt-2', sequence: 2, ordinal: 0, kind: 'partition_status', partitionId: 'segment:a', state: 'running', attempt: 2, at: '2026-08-22T08:02:00.000Z' },
      { factId: 'fact:attempt-1', sequence: 3, ordinal: 0, kind: 'partition_status', partitionId: 'segment:a', state: 'running', attempt: 1, at: '2026-08-22T08:03:00.000Z' },
    ]),
    /attempt moved backwards/,
  );
});

test('projection rejects unknown fact bytes and conflicting fact identity', () => {
  assert.throws(
    () => buildWorkspaceRunProjection(binding, [{
      factId: 'fact:unknown',
      sequence: 1,
      ordinal: 0,
      kind: 'partition_declared',
      partitionId: 'segment:a',
      at: '2026-08-22T08:01:00.000Z',
      unexpected: true,
    } as WorkspaceProjectionFactV1]),
    /unknown field unexpected/,
  );
  assert.throws(
    () => buildWorkspaceRunProjection(binding, [
      { factId: 'fact:collision', sequence: 1, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:a', at: '2026-08-22T08:01:00.000Z' },
      { factId: 'fact:collision', sequence: 1, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:b', at: '2026-08-22T08:01:00.000Z' },
    ]),
    /reused with different bytes/,
  );
});

test('durable sequence, not timestamp or input order, owns causal projection order', () => {
  const sameInstant = '2026-08-22T08:01:00.000Z';
  const snapshot = buildWorkspaceRunProjection(binding, [
    { factId: 'fact:status', sequence: 9, ordinal: 0, kind: 'partition_status', partitionId: 'segment:a', state: 'running', attempt: 1, at: sameInstant },
    { factId: 'fact:declare', sequence: 8, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:a', at: sameInstant },
  ]);
  assert.equal(snapshot.partitions[0]?.state, 'running');
  assert.throws(
    () => buildWorkspaceRunProjection(binding, [
      { factId: 'fact:first', sequence: 8, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:a', at: sameInstant },
      { factId: 'fact:second', sequence: 8, ordinal: 0, kind: 'partition_declared', partitionId: 'segment:b', at: sameInstant },
    ]),
    /position 8:0 is claimed by multiple facts/,
  );
});

test('projection count accumulation fails closed before integer precision is lost', () => {
  assert.throws(
    () => buildWorkspaceRunProjection(binding, [
      {
        factId: 'fact:overflow-declare',
        sequence: 1,
        ordinal: 0,
        kind: 'partition_declared',
        partitionId: 'segment:overflow',
        at: '2026-08-22T08:01:00.000Z',
      },
      {
        factId: 'fact:overflow-a',
        sequence: 2,
        ordinal: 0,
        kind: 'record_batch_committed',
        partitionId: 'segment:overflow',
        observationCount: Number.MAX_SAFE_INTEGER,
        canonicalRecordCount: 0,
        at: '2026-08-22T08:02:00.000Z',
      },
      {
        factId: 'fact:overflow-b',
        sequence: 3,
        ordinal: 0,
        kind: 'record_batch_committed',
        partitionId: 'segment:overflow',
        observationCount: 1,
        canonicalRecordCount: 0,
        at: '2026-08-22T08:03:00.000Z',
      },
    ]),
    /observationsCommitted exceeds the safe integer range/,
  );
});
