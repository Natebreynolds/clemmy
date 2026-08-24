import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  appendCanonicalPartitionPage,
  canonicalCoveragePresentation,
  canonicalProjectionEmptyState,
  initialCanonicalPartitionPageState,
  recurrenceConfigurationLabel,
  type WorkspaceCanonicalEntityProjectionResponse,
  type WorkspaceCanonicalPartition,
} from './workspace-canonical-entity';

function completeCoverage(): Record<string, unknown> {
  return {
    status: 'complete',
    sourceStatus: 'complete',
    partitionUniverse: 'closed',
    declaredPartitions: 2,
    observedPartitions: 2,
    observed: 20,
    denominator: { kind: 'exact', total: 20 },
    exhaustion: 'exhausted',
    reasons: [],
    evidenceRef: 'coverage:evidence',
  };
}

function partition(partitionId: string): WorkspaceCanonicalPartition {
  return {
    version: 1,
    partitionId,
    state: 'completed',
    attempt: 1,
    observationsCommitted: 10,
    canonicalRecords: 8,
    duplicateObservations: 1,
    updatedAt: '2026-08-22T09:00:00.000Z',
  };
}

function available(input: {
  digest?: string;
  bindingId?: string;
  items?: WorkspaceCanonicalPartition[];
  hasMore?: boolean;
  nextCursor?: string;
} = {}): Extract<WorkspaceCanonicalEntityProjectionResponse, { status: 'available' }> {
  return {
    version: 1,
    status: 'available',
    workspaceId: 'entity-workspace',
    head: {
      version: 1,
      identity: {
        version: 1,
        bindingId: input.bindingId ?? 'binding:entities',
        workflowId: 'entity-refresh',
        workspaceId: 'entity-workspace',
        runId: 'run:one',
        datasetId: 'dataset:entities',
      },
      headDigest: input.digest ?? 'a'.repeat(64),
      projectedAt: '2026-08-22T09:00:00.000Z',
      records: {
        observationsCommitted: 20,
        canonicalRecords: 16,
        mergedObservations: 3,
        replayedObservations: 0,
        duplicateObservations: 2,
      },
      coverage: completeCoverage() as AvailableProjectionCoverage,
      provenance: {
        assertionCount: 20,
        summedBatchOriginCount: 2,
        referenceCount: 1,
        references: ['provenance:one'],
        referencesTruncated: false,
      },
      quarantine: {
        observationCount: 1,
        reasons: { ambiguous_candidates: 1 },
        referenceCount: 1,
        references: ['quarantine:one'],
        referencesTruncated: false,
      },
    },
    recurrence: {
      authority: 'workflow_definition',
      configurationOnly: true,
      definitionEnabled: true,
      trigger: { kind: 'cron', expression: '0 */2 * * *', timezone: 'UTC' },
    },
    partitions: {
      items: input.items ?? [partition('partition:a'), partition('partition:b')],
      hasMore: input.hasMore ?? false,
      ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
    },
  };
}

type AvailableProjectionCoverage = Extract<
  WorkspaceCanonicalEntityProjectionResponse,
  { status: 'available' }
>['head']['coverage'];

test('Complete and 100% require every bounded coverage fact to agree', () => {
  const complete = canonicalCoveragePresentation(completeCoverage());
  assert.equal(complete.label, 'Complete');
  assert.equal(complete.percent, 100);

  const disagreements: Array<[string, (coverage: Record<string, unknown>) => void]> = [
    ['source status', (coverage) => { coverage.sourceStatus = 'partial'; }],
    ['partition universe', (coverage) => { coverage.partitionUniverse = 'open'; }],
    ['exhaustion', (coverage) => { coverage.exhaustion = 'unknown'; }],
    ['denominator kind', (coverage) => { coverage.denominator = { kind: 'unknown' }; }],
    ['record total', (coverage) => { coverage.observed = 19; }],
    ['partition total', (coverage) => { coverage.observedPartitions = 1; }],
    ['coverage reason', (coverage) => { coverage.reasons = ['partitions_not_exhausted']; }],
  ];
  for (const [label, mutate] of disagreements) {
    const coverage = completeCoverage();
    mutate(coverage);
    const presentation = canonicalCoveragePresentation(coverage);
    assert.notEqual(presentation.label, 'Complete', label);
    assert.notEqual(presentation.percent, 100, label);
  }

  const partialAtExactTotal = completeCoverage();
  partialAtExactTotal.status = 'partial';
  const partial = canonicalCoveragePresentation(partialAtExactTotal);
  assert.equal(partial.label, 'Partial');
  assert.equal(partial.percent, 99);

  const unknownAtExactTotal = completeCoverage();
  unknownAtExactTotal.status = 'unknown';
  const unknown = canonicalCoveragePresentation(unknownAtExactTotal);
  assert.equal(unknown.label, 'Unknown');
  assert.equal(unknown.percent, undefined);

  const cursorCycle = completeCoverage();
  cursorCycle.reasons = ['cursor_cycle_detected'];
  const cycled = canonicalCoveragePresentation(cursorCycle);
  assert.equal(cycled.label, 'Partial');
  assert.notEqual(cycled.percent, 100);
});

test('stale, cyclic, and overlapping partition pages stop without appending rows', () => {
  const first = initialCanonicalPartitionPageState(available({
    hasMore: true,
    nextCursor: 'cursor-1',
  }));
  assert.equal(first.integrity, 'ok');
  assert.equal(first.items.length, 2);

  const cycle = appendCanonicalPartitionPage(first, 'cursor-1', available({
    items: [partition('partition:c')],
    hasMore: true,
    nextCursor: 'cursor-1',
  }));
  assert.equal(cycle.integrity, 'cursor_cycle');
  assert.deepEqual(cycle.items.map((item) => item.partitionId), ['partition:a', 'partition:b']);
  assert.equal(cycle.hasMore, false);

  const stale = appendCanonicalPartitionPage(first, 'cursor-1', available({
    digest: 'b'.repeat(64),
    items: [partition('partition:c')],
  }));
  assert.equal(stale.integrity, 'stale_projection');
  assert.deepEqual(stale.items.map((item) => item.partitionId), ['partition:a', 'partition:b']);

  const overlap = appendCanonicalPartitionPage(first, 'cursor-1', available({
    items: [partition('partition:b')],
  }));
  assert.equal(overlap.integrity, 'invalid_page');
  assert.deepEqual(overlap.items.map((item) => item.partitionId), ['partition:a', 'partition:b']);
});

test('unavailable projection is a neutral empty state', () => {
  assert.deepEqual(canonicalProjectionEmptyState('canonical_binding_not_configured'), {
    tone: 'neutral',
    message: 'No canonical record workflow is bound to this Workspace.',
  });
  assert.deepEqual(canonicalProjectionEmptyState('projection_not_ready'), {
    tone: 'neutral',
    message: 'The canonical record projection has not been produced yet.',
  });
});

test('configured workflow trigger is never worded as consented or active recurrence', () => {
  const label = recurrenceConfigurationLabel({
    authority: 'workflow_definition',
    configurationOnly: true,
    definitionEnabled: true,
    trigger: { kind: 'cron', expression: '0 */2 * * *', timezone: 'UTC' },
  });
  assert.equal(label, 'Cron 0 */2 * * * · UTC');
  assert.doesNotMatch(label, /consent|active|running|next/i);

  const panel = readFileSync(
    new URL('../components/workspaces/CanonicalEntityCoveragePanel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(panel, /Configuration only — this is not proof that recurrence was consented, activated, or is running\./);
  const workspaceView = readFileSync(new URL('../screens/WorkspaceView.tsx', import.meta.url), 'utf8');
  assert.match(workspaceView, /<CanonicalEntityCoveragePanel workspaceId=\{id\} \/>/);
});
