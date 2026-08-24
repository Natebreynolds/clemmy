import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  applyCoveragePage,
  createDatasetCoverageState,
  createEntityResolutionState,
  upsertEntityObservationBatch,
  type DatasetCoverageState,
  type EntityObservationInput,
  type EntityResolutionPolicy,
} from '../execution/canonical-entity-resolution.js';
import {
  adaptCanonicalEntityTruthToWorkspaceProjection,
  canonicalEntityResolutionStateDigest,
  summarizeCanonicalResolutionBatchForWorkspace,
  summarizeDatasetCoverageForWorkspace,
  type AdaptCanonicalEntityWorkspaceProjectionInputV1,
  type CanonicalResolutionProjectionSummaryV1,
  type CanonicalResolutionProjectionReceiptV1,
  type CanonicalWorkspaceProjectionIdentityV1,
  type DatasetCoverageProjectionSummaryV1,
  type DatasetCoverageProjectionReceiptV1,
  type WorkflowPartitionProjectionReceiptV1,
  type WorkflowRunProjectionReceiptV1,
} from './canonical-entity-workspace-projection.js';
import {
  buildWorkspaceRunProjection,
  canonicalWorkspaceProjectionJson,
  workflowSurfaceBindingDigest,
  type WorkflowSurfaceBindingV1,
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

const identity: CanonicalWorkspaceProjectionIdentityV1 = {
  version: 1,
  bindingId: binding.bindingId,
  workflowId: binding.workflowId,
  workspaceId: binding.workspaceId,
  runId: 'run:alpha',
  datasetId: 'dataset:alpha',
};

const policy: EntityResolutionPolicy = {
  policyId: 'policy:alpha',
  mergeThreshold: 10,
  distinctThreshold: 2,
  ambiguityMargin: 1,
  weights: {
    defaultExactIdentifierMatch: 10,
    defaultCompoundSignalMatch: 4,
  },
  exclusiveIdentifierNamespaces: ['index'],
};

function at(sequence: number): string {
  return new Date(Date.parse('2026-08-22T08:00:00.000Z') + sequence * 1_000).toISOString();
}

function observation(input: {
  recordId: string;
  label: string;
  exactValues: readonly string[];
}): EntityObservationInput {
  return {
    entityKind: 'unit',
    origin: { sourceId: 'source:alpha', recordId: input.recordId },
    observedAt: '2026-08-22T08:00:00.000Z',
    fields: {
      label: {
        value: input.label,
        provenance: {
          sourceId: 'source:alpha',
          recordId: input.recordId,
          path: 'label',
        },
        confidence: 0.8,
        observedAt: '2026-08-22T08:00:00.000Z',
      },
    },
    exactIdentifiers: input.exactValues.map((value) => ({ namespace: 'index', value })),
  };
}

const firstObservation = observation({
  recordId: 'record:first',
  label: 'private-body-first',
  exactValues: ['key:shared'],
});
const secondObservation = observation({
  recordId: 'record:second',
  label: 'private-body-second',
  exactValues: ['key:shared'],
});
const quarantinedObservation = observation({
  recordId: 'record:quarantined',
  label: 'private-body-quarantined',
  exactValues: ['key:left', 'key:right'],
});

const emptyResolutionState = createEntityResolutionState();
const batchInputs = [
  firstObservation,
  secondObservation,
  quarantinedObservation,
  firstObservation,
] as const;
const batch = upsertEntityObservationBatch(
  emptyResolutionState,
  batchInputs,
  policy,
);
const batchSummary = summarizeCanonicalResolutionBatchForWorkspace(
  batch,
  emptyResolutionState,
  batchInputs,
  policy,
);

function runReceipt(
  receiptId = 'receipt:run',
  sequence = 0,
  status: WorkflowRunProjectionReceiptV1['status'] = 'running',
): WorkflowRunProjectionReceiptV1 {
  return {
    receiptId,
    sequence,
    ordinal: 0,
    at: at(sequence),
    identity,
    status,
  };
}

function declaredReceipt(
  partitionId: string,
  sequence: number,
  ordinal = 0,
): WorkflowPartitionProjectionReceiptV1 {
  return {
    receiptId: `receipt:declare:${partitionId}`,
    sequence,
    ordinal,
    at: at(sequence),
    identity,
    kind: 'declared',
    partitionId,
  };
}

function statusReceipt(
  partitionId: string,
  sequence: number,
  ordinal = 0,
  state: Extract<WorkflowPartitionProjectionReceiptV1, { kind: 'status' }>['state'] = 'completed',
  attempt = 1,
): WorkflowPartitionProjectionReceiptV1 {
  return {
    receiptId: `receipt:status:${partitionId}:${attempt}:${state}:${sequence}:${ordinal}`,
    sequence,
    ordinal,
    at: at(sequence),
    identity,
    kind: 'status',
    partitionId,
    state,
    attempt,
  };
}

function resolutionReceipt(
  partitionId = 'partition:a',
  sequence = 3,
): CanonicalResolutionProjectionReceiptV1 {
  return {
    receiptId: 'receipt:resolution:alpha',
    sequence,
    ordinal: 0,
    at: at(sequence),
    identity,
    partitionId,
    attempt: 1,
    summary: batchSummary,
    artifactRef: 'artifact:normalized:alpha',
    provenanceSummaryRef: 'provenance:summary:alpha',
    quarantineReviewRef: 'review:queue:alpha',
  };
}

function advanceCoverage(
  state: DatasetCoverageState,
  page: Parameters<typeof applyCoveragePage>[1],
): DatasetCoverageState {
  const result = applyCoveragePage(state, page);
  if (!result.ok) assert.fail(result.reason);
  return result.state;
}

function completeCoverageState(): DatasetCoverageState {
  let state = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a', 'partition:b'] },
    { kind: 'exact', total: 3 },
  );
  state = advanceCoverage(state, {
    partitionId: 'partition:a',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 2 },
    itemIds: ['item:a', 'item:b'],
  });
  return advanceCoverage(state, {
    partitionId: 'partition:b',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 1 },
    itemIds: ['item:c'],
  });
}

function coverageReceipt(
  state: DatasetCoverageState,
  sequence: number,
): DatasetCoverageProjectionReceiptV1 {
  return {
    receiptId: 'receipt:coverage:alpha',
    sequence,
    ordinal: 0,
    at: at(sequence),
    identity,
    summary: summarizeDatasetCoverageForWorkspace(state),
    observedPartitionIds: Object.keys(state.partitions).sort(),
    evidenceRef: 'coverage:evidence:alpha',
  };
}

function completeInput(): AdaptCanonicalEntityWorkspaceProjectionInputV1 {
  return {
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    runReceipts: [runReceipt()],
    partitionReceipts: [
      declaredReceipt('partition:a', 1, 0),
      declaredReceipt('partition:b', 1, 1),
      statusReceipt('partition:a', 2, 0, 'running'),
      statusReceipt('partition:b', 2, 1, 'running'),
      statusReceipt('partition:a', 4, 0),
      statusReceipt('partition:b', 4, 1),
    ],
    resolutionReceipts: [resolutionReceipt()],
    coverageReceipt: coverageReceipt(completeCoverageState(), 5),
  };
}

function requireSuccess(input: AdaptCanonicalEntityWorkspaceProjectionInputV1) {
  const result = adaptCanonicalEntityTruthToWorkspaceProjection(input);
  if (!result.ok) assert.fail(result.errors.join('; '));
  return result.value;
}

function durableResolutionSummary(
  content: Omit<CanonicalResolutionProjectionSummaryV1, 'summaryId'>,
): CanonicalResolutionProjectionSummaryV1 {
  const digest = createHash('sha256')
    .update(canonicalWorkspaceProjectionJson(content), 'utf8')
    .digest('hex');
  return {
    ...content,
    summaryId: `canonical-resolution-projection:v1:${digest}`,
  };
}

function durableCoverageSummary(
  content: Omit<DatasetCoverageProjectionSummaryV1, 'summaryId'>,
): DatasetCoverageProjectionSummaryV1 {
  const digest = createHash('sha256')
    .update(canonicalWorkspaceProjectionJson(content), 'utf8')
    .digest('hex');
  return {
    ...content,
    summaryId: `dataset-coverage-projection:v1:${digest}`,
  };
}

function digestLabel(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

test('projects additive canonical truth without embedding entity bodies or taking workflow authority', () => {
  assert.deepEqual(batchSummary, {
    version: 1,
    summaryId: batchSummary.summaryId,
    batchId: batch.batchId,
    previousResolutionStateDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    nextResolutionStateDigest: canonicalEntityResolutionStateDigest(batch.state),
    uniqueObservationCount: 3,
    observationsCommitted: 3,
    canonicalRecordsCreated: 1,
    mergedObservations: 1,
    quarantinedObservations: 1,
    replayedObservations: 0,
    duplicateObservationIdentities: 1,
    duplicateObservations: 1,
    provenanceAssertions: 3,
    provenanceOrigins: 3,
    quarantineReasons: { conflicting_exact_identifier: 1 },
  });

  const projected = requireSuccess(completeInput());
  const snapshot = buildWorkspaceRunProjection(binding, [...projected.facts]);
  assert.equal(projected.coverage.status, 'complete');
  assert.equal(snapshot.projection.coverage.status, 'complete');
  assert.equal(snapshot.projection.records.observationsCommitted, 3);
  assert.equal(snapshot.projection.records.canonicalRecords, 1);
  assert.equal(snapshot.projection.records.duplicateObservations, 1);
  assert.equal(projected.resolution.quarantinedObservations, 1);
  assert.equal(projected.resolution.mergedObservations, 1);
  assert.equal(
    projected.resolution.initialStateDigest,
    canonicalEntityResolutionStateDigest(emptyResolutionState),
  );
  assert.equal(
    projected.resolution.finalStateDigest,
    canonicalEntityResolutionStateDigest(batch.state),
  );
  assert.deepEqual(projected.resolution.quarantineReasons, {
    conflicting_exact_identifier: 1,
  });
  assert.deepEqual(projected.resolution.quarantineReviewRefs, ['review:queue:alpha']);
  assert.equal(projected.facts.some((fact) => fact.kind === 'schedule'), false);
  assert.equal(snapshot.projection.schedule.authority, 'workflow');

  const projectionJson = JSON.stringify(snapshot.projection);
  const adapterJson = JSON.stringify(projected);
  for (const secret of [
    'private-body-first',
    'private-body-second',
    'private-body-quarantined',
    'record:first',
    'record:second',
    'record:quarantined',
    'key:shared',
    'partition:a',
    'partition:b',
  ]) {
    assert.equal(projectionJson.includes(secret), false, `${secret} leaked into projection JSON`);
    if (!secret.startsWith('partition:')) {
      assert.equal(adapterJson.includes(secret), false, `${secret} leaked into adapter output`);
    }
  }
  assert.equal(projectionJson.includes('artifact:normalized:alpha'), true);
  assert.equal(projectionJson.includes('provenance:summary:alpha'), true);
});

test('summaries distinguish replay, semantic duplicates, quarantine, merge, and new records', () => {
  const twoInputs = [firstObservation, secondObservation];
  const committed = upsertEntityObservationBatch(createEntityResolutionState(), twoInputs, policy);
  const replay = upsertEntityObservationBatch(committed.state, twoInputs, policy);
  const committedSummary = summarizeCanonicalResolutionBatchForWorkspace(
    committed,
    emptyResolutionState,
    twoInputs,
    policy,
  );
  const replaySummary = summarizeCanonicalResolutionBatchForWorkspace(
    replay,
    committed.state,
    twoInputs,
    policy,
  );

  assert.equal(committedSummary.canonicalRecordsCreated, 1);
  assert.equal(committedSummary.mergedObservations, 1);
  assert.equal(committedSummary.duplicateObservations, 0);
  assert.equal(replaySummary.observationsCommitted, 0);
  assert.equal(replaySummary.canonicalRecordsCreated, 0);
  assert.equal(replaySummary.mergedObservations, 0);
  assert.equal(replaySummary.quarantinedObservations, 0);
  assert.equal(replaySummary.replayedObservations, 2);
  assert.equal(replaySummary.duplicateObservations, 0);
  assert.equal(replaySummary.provenanceAssertions, 0);

  const replayWithDuplicateInput = summarizeCanonicalResolutionBatchForWorkspace(
    upsertEntityObservationBatch(
      batch.state,
      [firstObservation, secondObservation, quarantinedObservation, firstObservation],
      policy,
    ),
    batch.state,
    batchInputs,
    policy,
  );
  assert.equal(replayWithDuplicateInput.duplicateObservationIdentities, 1);
  assert.equal(replayWithDuplicateInput.duplicateObservations, 0);
  assert.equal(replayWithDuplicateInput.observationsCommitted, 0);

  const permuted = upsertEntityObservationBatch(
    createEntityResolutionState(),
    [...twoInputs].reverse(),
    policy,
  );
  assert.deepEqual(
    summarizeCanonicalResolutionBatchForWorkspace(
      permuted,
      emptyResolutionState,
      [...twoInputs].reverse(),
      policy,
    ),
    committedSummary,
  );

  const baseMultiField = observation({
    recordId: 'record:multi-field',
    label: 'private-body-multi-field',
    exactValues: ['key:multi-field'],
  });
  const multiField: EntityObservationInput = {
    ...baseMultiField,
    fields: {
      ...baseMultiField.fields,
      marker: {
        value: 'private-marker',
        provenance: {
          sourceId: 'source:alpha',
          recordId: 'record:multi-field',
          path: 'marker',
        },
        confidence: 0.7,
        observedAt: '2026-08-22T08:00:00.000Z',
      },
    },
  };
  const multiFieldBatch = upsertEntityObservationBatch(
    emptyResolutionState,
    [multiField],
    policy,
  );
  const multiFieldSummary = summarizeCanonicalResolutionBatchForWorkspace(
    multiFieldBatch,
    emptyResolutionState,
    [multiField],
    policy,
  );
  assert.equal(multiFieldSummary.provenanceAssertions, 2);
  assert.equal(multiFieldSummary.provenanceOrigins, 1);
});

test('receipt replay and permutation produce one deterministic snapshot and digest', () => {
  const source = completeInput();
  const first = requireSuccess(source);
  const permuted = requireSuccess({
    ...source,
    runReceipts: [...source.runReceipts, ...source.runReceipts].reverse(),
    partitionReceipts: [...source.partitionReceipts, source.partitionReceipts[0]!].reverse(),
    resolutionReceipts: [...source.resolutionReceipts, source.resolutionReceipts[0]!],
  });
  assert.deepEqual(permuted, first);
  assert.equal(permuted.sourceDigest, first.sourceDigest);
});

test('state-digest chaining rejects overlapping independent batches and accepts one continuation', () => {
  const firstBatch = upsertEntityObservationBatch(
    emptyResolutionState,
    [firstObservation],
    policy,
  );
  const overlappingBatch = upsertEntityObservationBatch(
    emptyResolutionState,
    [firstObservation, secondObservation],
    policy,
  );
  const continuingBatch = upsertEntityObservationBatch(
    firstBatch.state,
    [firstObservation, secondObservation],
    policy,
  );
  const firstSummary = summarizeCanonicalResolutionBatchForWorkspace(
    firstBatch,
    emptyResolutionState,
    [firstObservation],
    policy,
  );
  const overlappingSummary = summarizeCanonicalResolutionBatchForWorkspace(
    overlappingBatch,
    emptyResolutionState,
    [firstObservation, secondObservation],
    policy,
  );
  const continuingSummary = summarizeCanonicalResolutionBatchForWorkspace(
    continuingBatch,
    firstBatch.state,
    [firstObservation, secondObservation],
    policy,
  );
  const partialCoverage = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a'] },
    { kind: 'exact', total: 2 },
  );
  const receiptFor = (
    receiptId: string,
    sequence: number,
    summary: CanonicalResolutionProjectionSummaryV1,
  ): CanonicalResolutionProjectionReceiptV1 => ({
    receiptId,
    sequence,
    ordinal: 0,
    at: at(sequence),
    identity,
    partitionId: 'partition:a',
    attempt: 1,
    summary,
    artifactRef: `artifact:${receiptId}`,
    provenanceSummaryRef: `provenance:${receiptId}`,
  });
  const base: AdaptCanonicalEntityWorkspaceProjectionInputV1 = {
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    runReceipts: [runReceipt()],
    partitionReceipts: [
      declaredReceipt('partition:a', 1),
      statusReceipt('partition:a', 2, 0, 'running'),
    ],
    resolutionReceipts: [],
    coverageReceipt: coverageReceipt(partialCoverage, 5),
  };

  const rejected = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...base,
    resolutionReceipts: [
      receiptFor('receipt:chain:first', 3, firstSummary),
      receiptFor('receipt:chain:overlap', 4, overlappingSummary),
    ],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.errors.join('; '), /does not continue/);

  const accepted = requireSuccess({
    ...base,
    resolutionReceipts: [
      receiptFor('receipt:chain:first', 3, firstSummary),
      receiptFor('receipt:chain:continuing', 4, continuingSummary),
    ],
  });
  const snapshot = buildWorkspaceRunProjection(binding, [...accepted.facts]);
  assert.equal(snapshot.projection.records.observationsCommitted, 2);
  assert.equal(snapshot.projection.records.canonicalRecords, 1);
  assert.equal(accepted.resolution.replayedObservations, 1);
  const reversedChain = requireSuccess({
    ...base,
    resolutionReceipts: [
      receiptFor('receipt:chain:continuing', 4, continuingSummary),
      receiptFor('receipt:chain:first', 3, firstSummary),
    ],
  });
  assert.deepEqual(reversedChain, accepted);

  const { summaryId: _firstSummaryId, ...firstContent } = firstSummary;
  const renamedFirst = durableResolutionSummary({
    ...firstContent,
    batchId: `entity-resolution-batch:v1:${'1'.repeat(64)}`,
  });
  const renamed = requireSuccess({
    ...base,
    resolutionReceipts: [
      receiptFor('receipt:chain:first', 3, renamedFirst),
      receiptFor('receipt:chain:continuing', 4, continuingSummary),
    ],
  });
  assert.deepEqual(renamed.facts, accepted.facts);
  assert.deepEqual(renamed.resolution, accepted.resolution);
  assert.notEqual(renamed.sourceDigest, accepted.sourceDigest);
});

test('batch summary rejects tampered retained authority and duplicate membership', () => {
  const observationId = batch.results[0]!.decision.observationId;
  const decisions = { ...batch.state.decisions };
  delete decisions[observationId];
  assert.throws(
    () => summarizeCanonicalResolutionBatchForWorkspace({
      ...batch,
      state: { ...batch.state, decisions },
    }, emptyResolutionState, batchInputs, policy),
    /does not match its deterministic source transition/,
  );
  assert.throws(
    () => summarizeCanonicalResolutionBatchForWorkspace({
      ...batch,
      duplicateObservationIds: [
        ...batch.duplicateObservationIds,
        `entity-observation:v1:${'0'.repeat(64)}`,
      ],
    }, emptyResolutionState, batchInputs, policy),
    /does not match its deterministic source transition/,
  );
  assert.throws(
    () => summarizeCanonicalResolutionBatchForWorkspace({
      ...batch,
      results: [{ ...batch.results[0]!, idempotent: true }, ...batch.results.slice(1)],
    }, emptyResolutionState, batchInputs, policy),
    /does not match its deterministic source transition/,
  );
});

test('more than one thousand workflow partitions remain outside projection JSON', () => {
  const partitionIds = Array.from({ length: 1_205 }, (_, index) => (
    `partition:${index.toString().padStart(4, '0')}`
  ));
  const state = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds },
    { kind: 'exact', total: 1_205 },
  );
  const projected = requireSuccess({
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    runReceipts: [runReceipt()],
    partitionReceipts: partitionIds.map((partitionId, index) => (
      declaredReceipt(partitionId, index + 1)
    )),
    resolutionReceipts: [],
    coverageReceipt: coverageReceipt(state, partitionIds.length + 1),
  });
  const snapshot = buildWorkspaceRunProjection(binding, [...projected.facts]);

  assert.equal(snapshot.partitions.length, 1_205);
  assert.equal(snapshot.projection.coverage.status, 'partial');
  assert.equal(snapshot.projection.coverage.declaredPartitions, 1_205);
  assert.equal(snapshot.projection.coverage.pendingPartitions, 1_205);
  const projectionJson = JSON.stringify(snapshot.projection);
  assert.equal(projectionJson.includes('partition:0000'), false);
  assert.equal(projectionJson.includes('partition:1204'), false);
  assert.ok(projectionJson.length < 10_000);
});

test('partial and unknown coverage remain non-complete, including a repeated-cursor cycle', () => {
  const partial = summarizeDatasetCoverageForWorkspace(createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a'] },
    { kind: 'exact', total: 1 },
  ));
  assert.equal(partial.status, 'partial');
  assert.ok(partial.reasons.includes('required_partitions_unseen'));

  const unknown = summarizeDatasetCoverageForWorkspace(createDatasetCoverageState(
    identity.datasetId,
    { kind: 'unknown' },
    { kind: 'unknown' },
  ));
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.denominator.kind, 'unknown');
  const unknownProjected = requireSuccess({
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    runReceipts: [runReceipt()],
    partitionReceipts: [],
    resolutionReceipts: [],
    coverageReceipt: {
      ...coverageReceipt(
        createDatasetCoverageState(identity.datasetId, { kind: 'unknown' }, { kind: 'unknown' }),
        1,
      ),
    },
  });
  assert.equal(unknownProjected.coverage.status, 'unknown');
  assert.equal(
    buildWorkspaceRunProjection(binding, [...unknownProjected.facts]).projection.coverage.status,
    'partial',
  );

  let cycle = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a'] },
    { kind: 'exact', total: 4 },
  );
  for (const page of [
    { inputCursor: null, outputCursor: 'cursor:a', exhaustion: 'more', itemIds: ['item:1'] },
    { inputCursor: 'cursor:a', outputCursor: 'cursor:b', exhaustion: 'more', itemIds: ['item:2'] },
    { inputCursor: 'cursor:b', outputCursor: 'cursor:a', exhaustion: 'more', itemIds: ['item:3'] },
    { inputCursor: 'cursor:a', outputCursor: null, exhaustion: 'exhausted', itemIds: ['item:4'] },
  ] as const) {
    cycle = advanceCoverage(cycle, {
      partitionId: 'partition:a',
      ...page,
      denominator: { kind: 'exact', total: 4 },
    });
  }
  const cycleSummary = summarizeDatasetCoverageForWorkspace(cycle);
  assert.equal(cycleSummary.sourceStatus, 'complete');
  assert.equal(cycleSummary.status, 'unknown');
  assert.equal(cycleSummary.exhaustion, 'unknown');
  assert.ok(cycleSummary.reasons.includes('cursor_cycle_detected'));
  const cycleProjected = requireSuccess({
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    runReceipts: [runReceipt()],
    partitionReceipts: [
      declaredReceipt('partition:a', 1),
      statusReceipt('partition:a', 2, 0, 'running'),
      statusReceipt('partition:a', 3),
    ],
    resolutionReceipts: [],
    coverageReceipt: coverageReceipt(cycle, 4),
  });
  assert.equal(cycleProjected.coverage.status, 'unknown');
  assert.equal(
    buildWorkspaceRunProjection(binding, [...cycleProjected.facts]).projection.coverage.status,
    'partial',
  );
});

test('coverage summaries reject caller-authored or unbounded reason vocabularies', () => {
  const source = completeInput();
  const { summaryId: _summaryId, ...validContent } = source.coverageReceipt.summary;
  const forged = durableCoverageSummary({
    ...validContent,
    status: 'partial',
    sourceStatus: 'partial',
    exhaustion: 'not_exhausted',
    reasons: ['caller_sensitive_label'],
  });
  const result = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    coverageReceipt: {
      ...source.coverageReceipt,
      summary: forged,
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join('; '), /Coverage reason .* unsupported/);
});

test('observed coverage membership must be workflow-declared even for an unknown universe', () => {
  let state = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'unknown' },
    { kind: 'unknown' },
  );
  state = advanceCoverage(state, {
    partitionId: 'partition:observed',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 1 },
    itemIds: ['item:observed'],
  });
  const base = {
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    runReceipts: [runReceipt()],
    partitionReceipts: [],
    resolutionReceipts: [],
    coverageReceipt: coverageReceipt(state, 2),
  } satisfies AdaptCanonicalEntityWorkspaceProjectionInputV1;

  const rejected = adaptCanonicalEntityTruthToWorkspaceProjection(base);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.errors.join('; '), /observed undeclared partition/);

  const accepted = requireSuccess({
    ...base,
    partitionReceipts: [declaredReceipt('partition:observed', 1)],
  });
  assert.equal(accepted.coverage.observedPartitions, 1);
  assert.equal(JSON.stringify(accepted).includes('item:observed'), false);
});

test('identity mismatch, corrupt counts, duplicate batches, and causal collisions fail closed', () => {
  const source = completeInput();
  const mismatch = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    runReceipts: [{
      ...source.runReceipts[0]!,
      identity: { ...identity, runId: 'run:other' },
    }],
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.kind, 'identity_mismatch');

  const receipt = source.resolutionReceipts[0]!;
  const corruptCounts = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    resolutionReceipts: [{
      ...receipt,
      summary: {
        ...receipt.summary,
        canonicalRecordsCreated: receipt.summary.canonicalRecordsCreated + 1,
      },
    }],
  });
  assert.equal(corruptCounts.ok, false);
  if (!corruptCounts.ok) assert.equal(corruptCounts.kind, 'corrupt_truth');

  const duplicateBatch = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    resolutionReceipts: [receipt, {
      ...receipt,
      receiptId: 'receipt:resolution:other',
      sequence: receipt.sequence,
      ordinal: receipt.ordinal + 1,
    }],
  });
  assert.equal(duplicateBatch.ok, false);
  if (!duplicateBatch.ok) assert.match(duplicateBatch.errors.join('; '), /multiple durable receipts/);

  const collision = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    runReceipts: [source.runReceipts[0]!, {
      ...source.runReceipts[0]!,
      receiptId: 'receipt:run:collision',
      status: 'held',
    }],
  });
  assert.equal(collision.ok, false);
  if (!collision.ok) assert.match(collision.errors.join('; '), /owned by multiple receipts/);

  const conflictingReplay = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    runReceipts: [source.runReceipts[0]!, {
      ...source.runReceipts[0]!,
      status: 'held',
    }],
  });
  assert.equal(conflictingReplay.ok, false);
  if (!conflictingReplay.ok) assert.match(conflictingReplay.errors.join('; '), /reused with different bytes/);

  const wrongDataset = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    coverageReceipt: {
      ...source.coverageReceipt,
      identity: { ...identity, datasetId: 'dataset:other' },
    },
  });
  assert.equal(wrongDataset.ok, false);
  if (!wrongDataset.ok) assert.equal(wrongDataset.kind, 'identity_mismatch');

  const otherDatasetSummary = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    coverageReceipt: coverageReceipt(createDatasetCoverageState(
      'dataset:other',
      { kind: 'closed', partitionIds: ['partition:a', 'partition:b'] },
      { kind: 'exact', total: 2 },
    ), 5),
  });
  assert.equal(otherDatasetSummary.ok, false);
  if (!otherDatasetSummary.ok) assert.equal(otherDatasetSummary.kind, 'identity_mismatch');

  const wrongBindingRevision = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    bindingDigest: '0'.repeat(64),
  });
  assert.equal(wrongBindingRevision.ok, false);
  if (!wrongBindingRevision.ok) assert.equal(wrongBindingRevision.kind, 'identity_mismatch');
});

test('partition declarations causally precede status and resolution receipts', () => {
  const partialCoverage = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a'] },
    { kind: 'exact', total: 1 },
  );
  const base: AdaptCanonicalEntityWorkspaceProjectionInputV1 = {
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    runReceipts: [runReceipt()],
    partitionReceipts: [declaredReceipt('partition:a', 2)],
    resolutionReceipts: [],
    coverageReceipt: coverageReceipt(partialCoverage, 3),
  };

  const earlyStatus = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...base,
    partitionReceipts: [
      statusReceipt('partition:a', 1),
      declaredReceipt('partition:a', 2),
    ],
  });
  assert.equal(earlyStatus.ok, false);
  if (!earlyStatus.ok) assert.match(earlyStatus.errors.join('; '), /before its declaration/);

  const earlyResolution = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...base,
    resolutionReceipts: [resolutionReceipt('partition:a', 1)],
  });
  assert.equal(earlyResolution.ok, false);
  if (!earlyResolution.ok) assert.match(earlyResolution.errors.join('; '), /precedes its partition declaration/);

  const lateUnrelatedDeclaration = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...completeInput(),
    partitionReceipts: [
      declaredReceipt('partition:a', 1),
      statusReceipt('partition:a', 2, 0, 'running'),
      statusReceipt('partition:a', 3),
      declaredReceipt('partition:b', 8),
      statusReceipt('partition:b', 9, 0, 'running'),
      statusReceipt('partition:b', 10),
    ],
    resolutionReceipts: [],
    coverageReceipt: coverageReceipt(completeCoverageState(), 4),
  });
  assert.equal(lateUnrelatedDeclaration.ok, false);
  if (!lateUnrelatedDeclaration.ok) {
    assert.match(lateUnrelatedDeclaration.errors.join('; '), /Coverage evidence must follow/);
  }
});

test('run and partition terminals reject regression while a new attempt may resume', () => {
  const source = completeInput();
  const singlePartitionCoverage = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a'] },
    { kind: 'exact', total: 0 },
  );
  const runRegression = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    runReceipts: [
      runReceipt('receipt:run:running', 0, 'running'),
      runReceipt('receipt:run:completed', 6, 'completed'),
      runReceipt('receipt:run:regressed', 7, 'running'),
    ],
  });
  assert.equal(runRegression.ok, false);
  if (!runRegression.ok) assert.match(runRegression.errors.join('; '), /regressed from terminal/);

  const partitionRegression = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    partitionReceipts: [
      ...source.partitionReceipts,
      statusReceipt('partition:a', 6, 0, 'running', 1),
    ],
    coverageReceipt: coverageReceipt(completeCoverageState(), 7),
  });
  assert.equal(partitionRegression.ok, false);
  if (!partitionRegression.ok) assert.match(partitionRegression.errors.join('; '), /regressed after terminal/);

  const afterTerminal = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    resolutionReceipts: [
      ...source.resolutionReceipts,
      {
        ...source.resolutionReceipts[0]!,
        receiptId: 'receipt:resolution:after-terminal',
        sequence: 5,
      },
    ],
    coverageReceipt: coverageReceipt(completeCoverageState(), 6),
  });
  assert.equal(afterTerminal.ok, false);
  if (!afterTerminal.ok) assert.match(afterTerminal.errors.join('; '), /outside its active partition attempt/);

  const partitionAfterRunTerminal = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    runReceipts: [
      runReceipt('receipt:run:running', 0, 'running'),
      runReceipt('receipt:run:completed', 3, 'completed'),
    ],
    partitionReceipts: [
      declaredReceipt('partition:a', 1),
      statusReceipt('partition:a', 2, 0, 'running'),
      statusReceipt('partition:a', 4, 0, 'completed'),
    ],
    resolutionReceipts: [],
    coverageReceipt: coverageReceipt(singlePartitionCoverage, 5),
  });
  assert.equal(partitionAfterRunTerminal.ok, false);
  if (!partitionAfterRunTerminal.ok) {
    assert.match(partitionAfterRunTerminal.errors.join('; '), /outside active workflow run authority/);
  }

  for (const priorState of ['running', 'completed', 'skipped'] as const) {
    const priorAttempt = [
      statusReceipt('partition:a', 2, 0, 'running', 1),
      ...(priorState === 'running'
        ? []
        : [statusReceipt('partition:a', 3, 0, priorState, 1)]),
    ];
    const invalidAttempt = adaptCanonicalEntityTruthToWorkspaceProjection({
      ...source,
      partitionReceipts: [
        declaredReceipt('partition:a', 1),
        ...priorAttempt,
        statusReceipt('partition:a', 4, 0, 'running', 2),
      ],
      resolutionReceipts: [],
      coverageReceipt: coverageReceipt(singlePartitionCoverage, 5),
    });
    assert.equal(invalidAttempt.ok, false);
    if (!invalidAttempt.ok) {
      assert.match(invalidAttempt.errors.join('; '), /cannot begin a new attempt/);
    }
  }

  const partialCoverage = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a'] },
    { kind: 'exact', total: 3 },
  );
  const resumed = requireSuccess({
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: canonicalEntityResolutionStateDigest(emptyResolutionState),
    runReceipts: [runReceipt()],
    partitionReceipts: [
      declaredReceipt('partition:a', 1),
      statusReceipt('partition:a', 2, 0, 'running', 1),
      statusReceipt('partition:a', 3, 0, 'failed', 1),
      statusReceipt('partition:a', 4, 0, 'running', 2),
      statusReceipt('partition:a', 6, 0, 'completed', 2),
    ],
    resolutionReceipts: [{
      ...resolutionReceipt('partition:a', 5),
      attempt: 2,
    }],
    coverageReceipt: coverageReceipt(partialCoverage, 7),
  });
  assert.equal(resumed.facts.some((fact) => (
    fact.kind === 'partition_status' && fact.attempt === 2 && fact.state === 'completed'
  )), true);
});

test('unknown partition receipt kinds fail closed instead of becoming status facts', () => {
  const source = completeInput();
  const result = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    partitionReceipts: [
      ...source.partitionReceipts,
      {
        ...statusReceipt('partition:a', 6, 0, 'running', 2),
        kind: 'future_state',
      } as unknown as WorkflowPartitionProjectionReceiptV1,
    ],
    coverageReceipt: coverageReceipt(completeCoverageState(), 7),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join('; '), /invalid kind/);
});

test('partition universe digest catches same-size identity substitution', () => {
  const source = completeInput();
  const mismatchedUniverse = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a', 'partition:c'] },
    { kind: 'exact', total: 2 },
  );
  const result = adaptCanonicalEntityTruthToWorkspaceProjection({
    ...source,
    coverageReceipt: coverageReceipt(mismatchedUniverse, 5),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, 'identity_mismatch');
    assert.match(result.errors.join('; '), /different partition universes/);
  }
});

test('aggregate count overflow fails closed before Workspace reduction', () => {
  const huge = (
    batchId: string,
    previousResolutionStateDigest: string,
    nextResolutionStateDigest: string,
  ): CanonicalResolutionProjectionSummaryV1 => (
    durableResolutionSummary({
      version: 1,
      batchId,
      previousResolutionStateDigest,
      nextResolutionStateDigest,
      uniqueObservationCount: Number.MAX_SAFE_INTEGER,
      observationsCommitted: Number.MAX_SAFE_INTEGER,
      canonicalRecordsCreated: Number.MAX_SAFE_INTEGER,
      mergedObservations: 0,
      quarantinedObservations: 0,
      replayedObservations: 0,
      duplicateObservationIdentities: 0,
      duplicateObservations: 0,
      provenanceAssertions: Number.MAX_SAFE_INTEGER,
      provenanceOrigins: Number.MAX_SAFE_INTEGER,
      quarantineReasons: {},
    })
  );
  const coverage = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a'] },
    { kind: 'exact', total: 1 },
  );
  const anchor = canonicalEntityResolutionStateDigest(emptyResolutionState);
  const afterFirst = digestLabel('state:huge:after-first');
  const afterSecond = digestLabel('state:huge:after-second');
  const result = adaptCanonicalEntityTruthToWorkspaceProjection({
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: anchor,
    runReceipts: [runReceipt()],
    partitionReceipts: [
      declaredReceipt('partition:a', 1),
      statusReceipt('partition:a', 2, 0, 'running'),
    ],
    resolutionReceipts: [
      {
        ...resolutionReceipt('partition:a', 3),
        receiptId: 'receipt:resolution:huge:a',
        summary: huge('batch:huge:a', anchor, afterFirst),
        quarantineReviewRef: undefined,
      },
      {
        ...resolutionReceipt('partition:a', 4),
        receiptId: 'receipt:resolution:huge:b',
        summary: huge('batch:huge:b', afterFirst, afterSecond),
        quarantineReviewRef: undefined,
      },
    ],
    coverageReceipt: coverageReceipt(coverage, 5),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join('; '), /safe integer range/);
});

test('large reference sets preserve totals while projection samples stay bounded', () => {
  const receiptCount = 300;
  const anchor = canonicalEntityResolutionStateDigest(emptyResolutionState);
  const summaries = Array.from({ length: receiptCount }, (_, index) => {
    const suffix = index.toString().padStart(3, '0');
    const previousResolutionStateDigest = index === 0
      ? anchor
      : digestLabel(`state:review:${(index - 1).toString().padStart(3, '0')}`);
    const nextResolutionStateDigest = digestLabel(`state:review:${suffix}`);
    const summary = durableResolutionSummary({
      version: 1,
      batchId: `batch:review:${suffix}`,
      previousResolutionStateDigest,
      nextResolutionStateDigest,
      uniqueObservationCount: 1,
      observationsCommitted: 1,
      canonicalRecordsCreated: 0,
      mergedObservations: 0,
      quarantinedObservations: 1,
      replayedObservations: 0,
      duplicateObservationIdentities: 0,
      duplicateObservations: 0,
      provenanceAssertions: 1,
      provenanceOrigins: 1,
      quarantineReasons: { conflicting_exact_identifier: 1 },
    });
    return {
      receiptId: `receipt:review:${suffix}`,
      sequence: index + 3,
      ordinal: 0,
      at: at(index + 3),
      identity,
      partitionId: 'partition:a',
      attempt: 1,
      summary,
      artifactRef: `artifact:review:${suffix}`,
      provenanceSummaryRef: `provenance:review:${suffix}`,
      quarantineReviewRef: `review:ref:${suffix}`,
    } satisfies CanonicalResolutionProjectionReceiptV1;
  });
  const coverage = createDatasetCoverageState(
    identity.datasetId,
    { kind: 'closed', partitionIds: ['partition:a'] },
    { kind: 'exact', total: receiptCount },
  );
  const projected = requireSuccess({
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: anchor,
    runReceipts: [runReceipt()],
    partitionReceipts: [
      declaredReceipt('partition:a', 1),
      statusReceipt('partition:a', 2, 0, 'running'),
    ],
    resolutionReceipts: summaries,
    coverageReceipt: coverageReceipt(coverage, receiptCount + 3),
  });
  const snapshot = buildWorkspaceRunProjection(binding, [...projected.facts]);

  assert.equal(projected.resolution.quarantinedObservations, receiptCount);
  assert.equal(projected.resolution.quarantineReviewRefCount, receiptCount);
  assert.equal(projected.resolution.quarantineReviewRefs.length, 256);
  assert.equal(snapshot.projection.records.artifactRefCount, receiptCount);
  assert.equal(snapshot.projection.records.artifactRefs.length, 256);
  assert.equal(snapshot.projection.provenanceSummaryRefCount, receiptCount);
  assert.equal(snapshot.projection.provenanceSummaryRefs.length, 256);

  const changedTailReceipts = summaries.map((receipt, index) => (
    index === receiptCount - 1
      ? { ...receipt, quarantineReviewRef: 'review:ref:tail-changed' }
      : receipt
  ));
  const changedTail = requireSuccess({
    version: 1,
    binding,
    bindingDigest: workflowSurfaceBindingDigest(binding),
    identity,
    resolutionStateAnchorDigest: anchor,
    runReceipts: [runReceipt()],
    partitionReceipts: [
      declaredReceipt('partition:a', 1),
      statusReceipt('partition:a', 2, 0, 'running'),
    ],
    resolutionReceipts: changedTailReceipts,
    coverageReceipt: coverageReceipt(coverage, receiptCount + 3),
  });
  assert.deepEqual(changedTail.facts, projected.facts);
  assert.deepEqual(changedTail.resolution, projected.resolution);
  assert.notEqual(changedTail.sourceDigest, projected.sourceDigest);
});
