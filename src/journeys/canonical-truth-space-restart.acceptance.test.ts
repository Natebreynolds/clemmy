import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE = path.join(import.meta.dirname, 'canonical-truth-space-restart.fixture.ts');

type FixtureMode = 'prepare' | 'recover' | 'publish_terminal' | 'inspect';
type Scenario = 'complete' | 'unknown_denominator' | 'failed_partition' | 'missing_page' | 'repeated_cursor' | 'bounded_budget';
type ProviderOrder = 'forward' | 'reverse';

interface AggregateState {
  outcome: string;
  reason: string;
  coverage_state: string;
  final_exhausted_truth: string;
  page_count: number;
  total_item_count: number;
}

interface DecisionState {
  recordId: string;
  exactIdentifiers: number;
  compoundSignals: string[];
  decision: string;
  reason: string | null;
  score: number | null;
  candidateCount: number;
  matchedExact: number;
  matchedCompound: number;
  canonicalId: string | null;
}

interface RecordState {
  canonicalId: string;
  originRecordIds: string[];
  auditActions: string[];
  conflictingFields: string[];
  labelEvidence: Array<{
    value: unknown;
    sourceId: string;
    recordId: string;
    path: string;
    observedAt: string;
  }>;
}

interface FixtureState {
  pid: number;
  roles: Record<string, string>;
  provider: {
    physicalCrossings: number;
    resultHandles: number;
    pages: Array<{
      page_ordinal: number;
      state: string;
      continuation_state: string;
      provider_exhausted_truth: string;
      result_handle_id: string;
      page_receipt_digest: string;
      item_count: number;
    }>;
    aggregate: AggregateState | null;
  };
  canonical: {
    datasets: number;
    observations: number;
    decisions: number;
    records: number;
    batches: number;
    quarantines: number;
    coveragePages: number;
    dataset: null | {
      datasetId: string;
      denominator: { kind: string; total?: number };
      resolutionRevision: number;
      coverageRevision: number;
    };
    coverage: null | {
      status: string;
      observedPartitions: number;
      observed: number;
      denominator: { kind: string; total?: number };
      exhaustion: string;
      reasons: string[];
    };
    decisionsByOrigin: DecisionState[];
    recordsByOrigin: RecordState[];
    quarantine: Array<{ observationId: string; reason: string }>;
    audit: null | {
      observations: number;
      decisions: number;
      records: number;
      quarantines: number;
      resolutionBatches: number;
      coveragePartitions: number;
      coveragePages: number;
      coverageItems: number;
    };
  };
  lineageReceipts: number;
  terminal: null | {
    status: string;
    terminalOutcome: string | null;
    hasClaim: boolean;
    reportBack: null | { outcome: string; detail: string };
  };
  space: {
    heads: number;
    projections: number;
    head: null | {
      records: {
        observationsCommitted: number;
        canonicalRecordsCreated: number;
        mergedObservations: number;
        replayedObservations: number;
        duplicateObservations: number;
      };
      source: { resolutionBatchCount: number; recordArtifactRefCount: number };
      provenance: { assertionCount: number; summedBatchOriginCount: number; summaryRefCount: number };
      quarantine: { observationCount: number; reasons: Record<string, number>; reviewRefCount: number };
      coverage: {
        status: string;
        sourceStatus: string;
        partitionUniverse: string;
        declaredPartitions?: number;
        observedPartitions: number;
        observed: number;
        denominator: { kind: string; total?: number };
        exhaustion: string;
        reasons: string[];
      };
    };
    surface: null | {
      projection: {
        runStatus?: string;
        schedule: { authority: string; enabled: boolean; nextOccurrenceAt?: string };
        coverage: {
          status: string;
          declaredPartitions?: number;
          completedPartitions: number;
          skippedPartitions: number;
          failedPartitions: number;
          blockedPartitions: number;
          runningPartitions: number;
          pendingPartitions: number;
          evidenceRefCount: number;
        };
        records: {
          observationsCommitted: number;
          canonicalRecords: number;
          duplicateObservations: number;
          artifactRefCount: number;
        };
        provenanceSummaryRefCount: number;
      };
      partitions: Array<{
        state: string;
        attempt: number;
        observationsCommitted: number;
        canonicalRecords: number;
        duplicateObservations: number;
        failureRef?: string;
      }>;
      digest: string;
      bindingDigest: string;
    };
  };
}

interface FixtureOutput {
  pid: number;
  bridge?: { ok: boolean; projectionVersion: number };
  read?: {
    status: string;
    reason?: string;
    aggregate?: {
      outcome: string;
      reason: string;
      coverageState: string;
      finalExhaustedTruth: string;
      pageCount: number;
      totalItemCount: number;
    };
  };
  result?: {
    status: string;
    code?: string;
    reason?: string;
    datasetId?: string;
    observationCount?: number;
    pageCount?: number;
  };
  reconciliation?: {
    eligible: number;
    projected: number;
    replayed: number;
    blocked: number;
    failed: number;
  };
  state: FixtureState;
}

interface CasePaths {
  root: string;
  home: string;
  label: string;
  counter: string;
  context: string;
  scenario: Scenario;
  order: ProviderOrder;
}

function pathsFor(scenario: Scenario, order: ProviderOrder = 'forward'): CasePaths {
  const root = mkdtempSync(path.join(os.tmpdir(), `clem-canonical-truth-${scenario}-`));
  return {
    root,
    home: path.join(root, 'home'),
    label: `${scenario}-${order}-${randomUUID()}`,
    counter: path.join(root, 'provider-crossings.ndjson'),
    context: path.join(root, 'context.json'),
    scenario,
    order,
  };
}

function fixtureEnv(
  paths: CasePaths,
  mode: FixtureMode,
  terminalBarrier?: { ready: string; release: string },
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLEMENTINE_HOME: paths.home,
    CLEMMY_TEST_ISOLATED_HOME: '1',
    MCP_AUTO_IMPORT_ENABLED: 'false',
    CLEM_CANONICAL_TRUTH_MODE: mode,
    CLEM_CANONICAL_TRUTH_SCENARIO: paths.scenario,
    CLEM_CANONICAL_TRUTH_ORDER: paths.order,
    CLEM_CANONICAL_TRUTH_LABEL: paths.label,
    CLEM_CANONICAL_TRUTH_COUNTER: paths.counter,
    CLEM_CANONICAL_TRUTH_CONTEXT: paths.context,
    ...(terminalBarrier ? {
      CLEMENTINE_TEST_TERMINAL_PUBLISH_READY: terminalBarrier.ready,
      CLEMENTINE_TEST_TERMINAL_PUBLISH_RELEASE: terminalBarrier.release,
    } : {}),
  };
}

function outputFrom(stdout: string): FixtureOutput {
  const line = stdout.trim().split('\n')
    .findLast((candidate) => candidate.startsWith('CANONICAL_TRUTH_FIXTURE:'));
  assert.ok(line, stdout);
  return JSON.parse(line.slice('CANONICAL_TRUTH_FIXTURE:'.length)) as FixtureOutput;
}

function runFixture(paths: CasePaths, mode: FixtureMode): FixtureOutput {
  const child = spawnSync(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: REPO,
    env: fixtureEnv(paths, mode),
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return outputFrom(child.stdout);
}

async function crashAfterTerminalPublication(paths: CasePaths): Promise<number> {
  const ready = path.join(paths.root, 'terminal-published.ready');
  const release = path.join(paths.root, 'terminal-published.release');
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: REPO,
    env: fixtureEnv(paths, 'publish_terminal', { ready, release }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    const deadline = Date.now() + 90_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.fail(`terminal publisher exited before the durable barrier\n${stdout}\n${stderr}`);
      }
      if (Date.now() >= deadline) {
        assert.fail(`timed out waiting for durable terminal publication\n${stdout}\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pid = child.pid!;
    assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    assert.equal(code, null, stderr);
    assert.equal(signal, 'SIGKILL', stderr);
    return pid;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function providerRows(paths: CasePaths): Array<{ pid: number; scenario: Scenario; page: number }> {
  if (!existsSync(paths.counter)) return [];
  return readFileSync(paths.counter, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; scenario: Scenario; page: number });
}

function decisionFor(state: FixtureState, role: string): DecisionState {
  const decision = state.canonical.decisionsByOrigin.find((candidate) => candidate.recordId === role);
  assert.ok(decision, `missing canonical decision for ${role}`);
  return decision;
}

function recordFor(state: FixtureState, roles: string[]): RecordState {
  const expected = [...roles].sort();
  const record = state.canonical.recordsByOrigin.find((candidate) => (
    JSON.stringify(candidate.originRecordIds) === JSON.stringify(expected)
  ));
  assert.ok(record, `missing canonical record for ${expected.join(', ')}`);
  return record;
}

function assertSettledProvider(state: FixtureState): void {
  assert.equal(state.provider.physicalCrossings, 2);
  assert.equal(state.provider.resultHandles, 2);
  assert.deepEqual(
    state.provider.pages.map((page) => ({
      ordinal: page.page_ordinal,
      state: page.state,
      continuation: page.continuation_state,
      exhausted: page.provider_exhausted_truth,
      hasHandle: typeof page.result_handle_id === 'string',
      hasReceipt: typeof page.page_receipt_digest === 'string',
      items: page.item_count,
    })),
    [
      { ordinal: 0, state: 'settled', continuation: 'continue', exhausted: 'false', hasHandle: true, hasReceipt: true, items: 4 },
      { ordinal: 1, state: 'settled', continuation: 'exhausted', exhausted: 'true', hasHandle: true, hasReceipt: true, items: 5 },
    ],
  );
  assert.deepEqual(state.provider.aggregate, {
    outcome: 'complete',
    reason: 'provider_declared_exhausted',
    coverage_state: 'complete',
    final_exhausted_truth: 'true',
    page_count: 2,
    total_item_count: 9,
  });
}

function assertCanonicalResolution(state: FixtureState, coverage: 'complete' | 'unknown'): void {
  assert.deepEqual({
    datasets: state.canonical.datasets,
    observations: state.canonical.observations,
    decisions: state.canonical.decisions,
    records: state.canonical.records,
    batches: state.canonical.batches,
    quarantines: state.canonical.quarantines,
    coveragePages: state.canonical.coveragePages,
    lineageReceipts: state.lineageReceipts,
  }, {
    datasets: 1,
    observations: 9,
    decisions: 9,
    records: 5,
    batches: 2,
    quarantines: 2,
    coveragePages: 2,
    lineageReceipts: 1,
  });
  assert.equal(state.canonical.dataset?.resolutionRevision, 2);
  assert.equal(state.canonical.dataset?.coverageRevision, 2);
  assert.deepEqual(state.canonical.audit, {
    version: 1,
    datasetId: state.canonical.dataset?.datasetId,
    observations: 9,
    decisions: 9,
    records: 5,
    quarantines: 2,
    resolutionBatches: 2,
    coveragePartitions: 1,
    coveragePages: 2,
    coverageItems: 9,
  });

  const exact = decisionFor(state, state.roles.exactMerge!);
  assert.deepEqual({
    exactIdentifiers: exact.exactIdentifiers,
    decision: exact.decision,
    score: exact.score,
    candidateCount: exact.candidateCount,
    matchedExact: exact.matchedExact,
    matchedCompound: exact.matchedCompound,
  }, {
    exactIdentifiers: 1,
    decision: 'merge',
    score: 10,
    candidateCount: 1,
    matchedExact: 1,
    matchedCompound: 0,
  });
  const compound = decisionFor(state, state.roles.compoundMerge!);
  assert.deepEqual({
    exactIdentifiers: compound.exactIdentifiers,
    compoundSignals: compound.compoundSignals.length,
    decision: compound.decision,
    score: compound.score,
    candidateCount: compound.candidateCount,
    matchedExact: compound.matchedExact,
    matchedCompound: compound.matchedCompound,
  }, {
    exactIdentifiers: 0,
    compoundSignals: 1,
    decision: 'merge',
    score: 6,
    candidateCount: 1,
    matchedExact: 0,
    matchedCompound: 1,
  });
  const ambiguous = decisionFor(state, state.roles.ambiguityProbe!);
  assert.deepEqual({
    decision: ambiguous.decision,
    reason: ambiguous.reason,
    candidateCount: ambiguous.candidateCount,
  }, { decision: 'quarantine', reason: 'ambiguous_candidates', candidateCount: 2 });
  const conflict = decisionFor(state, state.roles.conflict!);
  assert.deepEqual({
    decision: conflict.decision,
    reason: conflict.reason,
    exactIdentifiers: conflict.exactIdentifiers,
    compoundSignals: conflict.compoundSignals.length,
  }, {
    decision: 'quarantine',
    reason: 'conflicting_exact_identifier',
    exactIdentifiers: 1,
    compoundSignals: 1,
  });
  assert.equal(decisionFor(state, state.roles.distinct!).decision, 'distinct');
  assert.deepEqual(
    state.canonical.quarantine.map((item) => item.reason).sort(),
    ['ambiguous_candidates', 'conflicting_exact_identifier'],
  );

  const exactRecord = recordFor(state, [state.roles.exactSeed!, state.roles.exactMerge!]);
  assert.deepEqual(exactRecord.auditActions, ['create', 'merge']);
  assert.deepEqual(exactRecord.conflictingFields, ['label', 'source_record_id']);
  assert.deepEqual(
    exactRecord.labelEvidence.map((evidence) => evidence.recordId).sort(),
    [state.roles.exactMerge!, state.roles.exactSeed!].sort(),
  );
  for (const evidence of exactRecord.labelEvidence) {
    assert.equal(evidence.path, 'label');
    assert.ok(evidence.sourceId.length > 0);
    assert.match(evidence.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
  const compoundRecord = recordFor(state, [state.roles.compoundSeed!, state.roles.compoundMerge!]);
  assert.deepEqual(compoundRecord.auditActions, ['create', 'merge']);
  assert.equal(recordFor(state, [state.roles.distinct!]).auditActions[0], 'create');

  if (coverage === 'complete') {
    assert.deepEqual(state.canonical.coverage, {
      version: 1,
      datasetId: state.canonical.dataset?.datasetId,
      coverageRevision: 2,
      coverageDigest: (state.canonical.coverage as unknown as { coverageDigest: string }).coverageDigest,
      observedPartitions: 1,
      cursorCycleDetected: false,
      status: 'complete',
      observed: 9,
      denominator: { kind: 'exact', total: 9 },
      exhaustion: 'exhausted',
      reasons: [],
    });
  } else {
    assert.equal(state.canonical.coverage?.status, 'unknown');
    assert.equal(state.canonical.coverage?.observed, 9);
    assert.deepEqual(state.canonical.coverage?.denominator, { kind: 'unknown' });
    assert.equal(state.canonical.coverage?.exhaustion, 'unknown');
    assert.deepEqual(state.canonical.coverage?.reasons, [
      'dataset_denominator_not_exact',
      'denominator_not_exact',
    ]);
  }
}

function assertNoTerminalProjection(state: FixtureState): void {
  assert.equal(state.terminal?.status, 'running');
  assert.equal(state.terminal?.terminalOutcome, null);
  assert.equal(state.terminal?.hasClaim, false);
  assert.equal(state.space.heads, 0);
  assert.equal(state.space.projections, 0);
  assert.equal(state.space.head, null);
  assert.equal(state.space.surface, null);
}

function assertFailedCanonicalResolution(state: FixtureState): void {
  assert.deepEqual({
    datasets: state.canonical.datasets,
    observations: state.canonical.observations,
    decisions: state.canonical.decisions,
    records: state.canonical.records,
    batches: state.canonical.batches,
    quarantines: state.canonical.quarantines,
    coveragePages: state.canonical.coveragePages,
    lineageReceipts: state.lineageReceipts,
  }, {
    datasets: 1,
    observations: 4,
    decisions: 4,
    records: 4,
    batches: 1,
    quarantines: 0,
    coveragePages: 1,
    lineageReceipts: 1,
  });
  assert.deepEqual(state.canonical.audit, {
    version: 1,
    datasetId: state.canonical.dataset?.datasetId,
    observations: 4,
    decisions: 4,
    records: 4,
    quarantines: 0,
    resolutionBatches: 1,
    coveragePartitions: 1,
    coveragePages: 1,
    coverageItems: 4,
  });
  assert.equal(state.canonical.coverage?.status, 'partial');
  assert.equal(state.canonical.coverage?.observed, 4);
  assert.deepEqual(state.canonical.coverage?.denominator, { kind: 'unknown' });
  assert.equal(state.canonical.coverage?.exhaustion, 'not_exhausted');
  assert.deepEqual(state.canonical.coverage?.reasons, [
    'dataset_denominator_not_exact',
    'denominator_not_exact',
    'partitions_not_exhausted',
  ]);
  const exactSeed = recordFor(state, [state.roles.exactSeed!]);
  assert.ok(exactSeed.labelEvidence.every((evidence) => (
    evidence.recordId === state.roles.exactSeed && evidence.path === 'label'
  )));
}

function assertFailedProjectedSpace(state: FixtureState): void {
  assert.equal(state.space.heads, 1);
  assert.equal(state.space.projections, 1);
  assert.deepEqual(state.space.head?.records, {
    observationsCommitted: 4,
    canonicalRecordsCreated: 4,
    mergedObservations: 0,
    replayedObservations: 0,
    duplicateObservations: 0,
  });
  assert.equal(state.space.head?.source.resolutionBatchCount, 1);
  assert.equal(state.space.head?.source.recordArtifactRefCount, 1);
  assert.equal(state.space.head?.provenance.assertionCount, 21);
  assert.equal(state.space.head?.provenance.summedBatchOriginCount, 4);
  assert.equal(state.space.head?.provenance.summaryRefCount, 1);
  assert.deepEqual(state.space.head?.quarantine, {
    observationCount: 0,
    reasons: {},
    reviewRefCount: 0,
    reviewRefs: (state.space.head?.quarantine as unknown as { reviewRefs: string[] }).reviewRefs,
  });
  assert.equal(state.space.head?.coverage.status, 'partial');
  assert.equal(state.space.head?.coverage.sourceStatus, 'partial');
  assert.equal(state.space.head?.coverage.declaredPartitions, 1);
  assert.equal(state.space.head?.coverage.observedPartitions, 1);
  assert.equal(state.space.head?.coverage.observed, 4);
  assert.deepEqual(state.space.head?.coverage.denominator, { kind: 'unknown' });
  assert.equal(state.space.head?.coverage.exhaustion, 'not_exhausted');
  assert.deepEqual(state.space.head?.coverage.reasons, [
    'dataset_denominator_not_exact',
    'denominator_not_exact',
    'partitions_not_exhausted',
  ]);

  const projection = state.space.surface?.projection;
  assert.equal(projection?.runStatus, 'failed');
  assert.deepEqual(projection?.schedule, { authority: 'workflow', enabled: false });
  assert.equal(projection?.coverage.status, 'failed');
  assert.equal(projection?.coverage.declaredPartitions, 1);
  assert.equal(projection?.coverage.completedPartitions, 0);
  assert.equal(projection?.coverage.failedPartitions, 1);
  assert.equal(projection?.coverage.blockedPartitions, 0);
  assert.deepEqual(projection?.records, {
    observationsCommitted: 4,
    canonicalRecords: 4,
    duplicateObservations: 0,
    artifactRefCount: 1,
    artifactRefs: (projection?.records as unknown as { artifactRefs: string[] }).artifactRefs,
  });
  assert.equal(projection?.provenanceSummaryRefCount, 1);
  assert.equal(state.space.surface?.partitions.length, 1);
  const failedPartition = state.space.surface?.partitions[0];
  assert.equal(failedPartition?.state, 'failed');
  assert.equal(failedPartition?.attempt, 1);
  assert.equal(failedPartition?.observationsCommitted, 4);
  assert.equal(failedPartition?.canonicalRecords, 4);
  assert.match(failedPartition?.failureRef ?? '', /^workflow-read-failure:[a-f0-9]{64}$/);
}

function assertProjectedSpace(state: FixtureState, coverage: 'complete' | 'unknown'): void {
  assert.equal(state.space.heads, 1);
  assert.equal(state.space.projections, 1);
  assert.deepEqual(state.space.head?.records, {
    observationsCommitted: 9,
    canonicalRecordsCreated: 5,
    mergedObservations: 2,
    replayedObservations: 0,
    duplicateObservations: 0,
  });
  assert.deepEqual(state.space.head?.source, {
    resolutionBatchCount: 2,
    recordArtifactRefCount: 2,
    recordArtifactRefs: (state.space.head?.source as unknown as { recordArtifactRefs: string[] }).recordArtifactRefs,
  });
  assert.deepEqual(state.space.head?.provenance, {
    assertionCount: 45,
    summedBatchOriginCount: 9,
    summaryRefCount: 2,
    summaryRefs: (state.space.head?.provenance as unknown as { summaryRefs: string[] }).summaryRefs,
  });
  assert.deepEqual(state.space.head?.quarantine, {
    observationCount: 2,
    reasons: { ambiguous_candidates: 1, conflicting_exact_identifier: 1 },
    reviewRefCount: 1,
    reviewRefs: (state.space.head?.quarantine as unknown as { reviewRefs: string[] }).reviewRefs,
  });
  assert.equal(state.space.head?.coverage.status, coverage);
  assert.equal(state.space.head?.coverage.sourceStatus, coverage);
  assert.equal(state.space.head?.coverage.partitionUniverse, 'closed');
  assert.equal(state.space.head?.coverage.declaredPartitions, 1);
  assert.equal(state.space.head?.coverage.observedPartitions, 1);
  assert.equal(state.space.head?.coverage.observed, 9);
  if (coverage === 'complete') {
    assert.deepEqual(state.space.head?.coverage.denominator, { kind: 'exact', total: 9 });
    assert.equal(state.space.head?.coverage.exhaustion, 'exhausted');
    assert.deepEqual(state.space.head?.coverage.reasons, []);
  } else {
    assert.deepEqual(state.space.head?.coverage.denominator, { kind: 'unknown' });
    assert.equal(state.space.head?.coverage.exhaustion, 'unknown');
    assert.deepEqual(state.space.head?.coverage.reasons, [
      'dataset_denominator_not_exact',
      'denominator_not_exact',
    ]);
  }

  const projection = state.space.surface?.projection;
  assert.equal(projection?.runStatus, 'completed');
  assert.deepEqual(projection?.schedule, { authority: 'workflow', enabled: false });
  assert.deepEqual(projection?.coverage, {
    status: coverage === 'complete' ? 'complete' : 'partial',
    declaredPartitions: 1,
    completedPartitions: 1,
    skippedPartitions: 0,
    failedPartitions: 0,
    blockedPartitions: 0,
    runningPartitions: 0,
    pendingPartitions: 0,
    partitionIndexDigest: (projection?.coverage as unknown as { partitionIndexDigest: string }).partitionIndexDigest,
    evidenceRefCount: 1,
    evidenceRefs: (projection?.coverage as unknown as { evidenceRefs: string[] }).evidenceRefs,
  });
  assert.deepEqual(projection?.records, {
    observationsCommitted: 9,
    canonicalRecords: 5,
    duplicateObservations: 0,
    artifactRefCount: 2,
    artifactRefs: (projection?.records as unknown as { artifactRefs: string[] }).artifactRefs,
  });
  assert.equal(projection?.provenanceSummaryRefCount, 2);
  assert.deepEqual(state.space.surface?.partitions.map((partition) => ({
    state: partition.state,
    attempt: partition.attempt,
    observationsCommitted: partition.observationsCommitted,
    canonicalRecords: partition.canonicalRecords,
    duplicateObservations: partition.duplicateObservations,
    failureRef: partition.failureRef,
  })), [{
    state: 'completed',
    attempt: 1,
    observationsCommitted: 9,
    canonicalRecords: 5,
    duplicateObservations: 0,
    failureRef: undefined,
  }]);
}

function authoritySnapshot(state: FixtureState): unknown {
  return {
    provider: state.provider,
    canonical: state.canonical,
    lineageReceipts: state.lineageReceipts,
    terminal: state.terminal,
    space: state.space,
  };
}

test('governing canonical truth journey: reviewed v2 identity, honest coverage, and restart-only Space rebuild', {
  timeout: 240_000,
}, async (t) => {
  const roots: string[] = [];
  t.after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  await t.test('exact, compound, conflict, ambiguity, distinct, provenance, and replay survive a fresh process', async () => {
    const paths = pathsFor('complete');
    roots.push(paths.root);
    const prepared = runFixture(paths, 'prepare');
    assert.deepEqual(prepared.bridge, { ok: true, projectionVersion: 2 });
    assert.equal(prepared.read?.status, 'completed');
    assert.equal(prepared.result?.status, 'ready');
    assert.equal(prepared.result?.observationCount, 9);
    assert.equal(prepared.result?.pageCount, 2);
    assertSettledProvider(prepared.state);
    assertCanonicalResolution(prepared.state, 'complete');
    assertNoTerminalProjection(prepared.state);
    assert.deepEqual(providerRows(paths).map((row) => row.page), [0, 1]);

    const terminalPid = await crashAfterTerminalPublication(paths);
    assert.notEqual(terminalPid, prepared.pid);
    const crashed = runFixture(paths, 'inspect');
    assert.notEqual(crashed.pid, terminalPid);
    assert.equal(crashed.state.terminal?.status, 'completed');
    assert.equal(crashed.state.terminal?.terminalOutcome, 'succeeded');
    assert.equal(crashed.state.terminal?.hasClaim, true);
    assert.equal(crashed.state.space.heads, 0);
    assert.equal(crashed.state.space.projections, 0);
    assertCanonicalResolution(crashed.state, 'complete');

    const recovered = runFixture(paths, 'recover');
    assert.notEqual(recovered.pid, terminalPid);
    assert.notEqual(recovered.pid, prepared.pid);
    assert.equal(recovered.result?.status, 'replayed');
    assert.deepEqual(recovered.reconciliation, {
      eligible: 1,
      projected: 1,
      replayed: 0,
      blocked: 0,
      failed: 0,
    });
    assertCanonicalResolution(recovered.state, 'complete');
    assertProjectedSpace(recovered.state, 'complete');

    const replayed = runFixture(paths, 'recover');
    assert.equal(replayed.result?.status, 'replayed');
    assert.deepEqual(replayed.reconciliation, {
      eligible: 1,
      projected: 0,
      replayed: 1,
      blocked: 0,
      failed: 0,
    });
    assert.deepEqual(authoritySnapshot(replayed.state), authoritySnapshot(recovered.state));
    const crossings = providerRows(paths);
    assert.equal(crossings.length, 2);
    assert.deepEqual([...new Set(crossings.map((row) => row.pid))], [prepared.pid]);
  });

  await t.test('generated carrier record order does not change reviewed identity outcomes', () => {
    const paths = pathsFor('complete', 'reverse');
    roots.push(paths.root);
    const prepared = runFixture(paths, 'prepare');
    assert.equal(prepared.result?.status, 'ready');
    assertSettledProvider(prepared.state);
    assertCanonicalResolution(prepared.state, 'complete');
    assertNoTerminalProjection(prepared.state);
  });

  await t.test('an exact failed page rebuilds one failed partition without redispatch or universal coverage', async () => {
    const paths = pathsFor('failed_partition');
    roots.push(paths.root);
    const prepared = runFixture(paths, 'prepare');
    assert.deepEqual(prepared.bridge, { ok: true, projectionVersion: 2 });
    assert.equal(prepared.read?.status, 'failed');
    assert.equal(prepared.read?.reason, 'page_execution_failed');
    assert.equal(prepared.read?.aggregate?.outcome, 'failed');
    assert.equal(prepared.read?.aggregate?.coverageState, 'partial');
    assert.equal(prepared.read?.aggregate?.finalExhaustedTruth, 'false');
    assert.equal(prepared.result?.status, 'ready');
    assert.equal(prepared.result?.observationCount, 4);
    assert.equal(prepared.result?.pageCount, 1);
    assert.equal(prepared.state.provider.physicalCrossings, 1);
    assert.equal(prepared.state.provider.resultHandles, 1);
    assert.deepEqual(prepared.state.provider.pages.map((page) => ({
      ordinal: page.page_ordinal,
      state: page.state,
      continuation: page.continuation_state,
      exhausted: page.provider_exhausted_truth,
      items: page.item_count,
    })), [{
      ordinal: 0,
      state: 'settled',
      continuation: 'continue',
      exhausted: 'false',
      items: 4,
    }, {
      ordinal: 1,
      state: 'failed',
      continuation: null,
      exhausted: null,
      items: null,
    }]);
    assert.deepEqual(prepared.state.provider.aggregate, {
      outcome: 'failed',
      reason: 'page_execution_failed',
      coverage_state: 'partial',
      final_exhausted_truth: 'false',
      page_count: 1,
      total_item_count: 4,
    });
    assertFailedCanonicalResolution(prepared.state);
    assertNoTerminalProjection(prepared.state);
    assert.equal(providerRows(paths).length, 2);

    const terminalPid = await crashAfterTerminalPublication(paths);
    assert.notEqual(terminalPid, prepared.pid);
    const crashed = runFixture(paths, 'inspect');
    assert.equal(crashed.state.terminal?.status, 'failed');
    assert.equal(crashed.state.terminal?.terminalOutcome, 'failed');
    assert.equal(crashed.state.terminal?.hasClaim, true);
    assert.equal(crashed.state.space.heads, 0);
    assert.equal(crashed.state.space.projections, 0);
    assertFailedCanonicalResolution(crashed.state);

    const recovered = runFixture(paths, 'recover');
    assert.equal(recovered.result?.status, 'replayed');
    assert.deepEqual(recovered.reconciliation, {
      eligible: 1,
      projected: 1,
      replayed: 0,
      blocked: 0,
      failed: 0,
    });
    assertFailedCanonicalResolution(recovered.state);
    assertFailedProjectedSpace(recovered.state);
    assert.equal(recovered.state.terminal?.reportBack?.outcome, 'failed');
    assert.match(recovered.state.terminal?.reportBack?.detail ?? '', /provenance-preserving settled prefix/i);
    assert.match(recovered.state.terminal?.reportBack?.detail ?? '', /non-universal/i);

    const replayed = runFixture(paths, 'recover');
    assert.equal(replayed.result?.status, 'replayed');
    assert.deepEqual(replayed.reconciliation, {
      eligible: 1,
      projected: 0,
      replayed: 1,
      blocked: 0,
      failed: 0,
    });
    assert.deepEqual(authoritySnapshot(replayed.state), authoritySnapshot(recovered.state));
    const crossings = providerRows(paths);
    assert.equal(crossings.length, 2);
    assert.deepEqual([...new Set(crossings.map((row) => row.pid))], [prepared.pid]);
  });

  await t.test('unknown denominator remains non-universal through terminal recovery and Space', async () => {
    const paths = pathsFor('unknown_denominator');
    roots.push(paths.root);
    const prepared = runFixture(paths, 'prepare');
    assert.equal(prepared.read?.status, 'completed');
    assert.equal(prepared.result?.status, 'ready');
    assertSettledProvider(prepared.state);
    assertCanonicalResolution(prepared.state, 'unknown');
    assertNoTerminalProjection(prepared.state);

    await crashAfterTerminalPublication(paths);
    const crashed = runFixture(paths, 'inspect');
    assert.equal(crashed.state.space.heads, 0);
    assert.equal(crashed.state.terminal?.hasClaim, true);
    const recovered = runFixture(paths, 'recover');
    assert.equal(recovered.result?.status, 'replayed');
    assert.deepEqual(recovered.reconciliation, {
      eligible: 1,
      projected: 1,
      replayed: 0,
      blocked: 0,
      failed: 0,
    });
    assertProjectedSpace(recovered.state, 'unknown');
    assert.equal(recovered.state.terminal?.reportBack?.outcome, 'done');
    assert.match(recovered.state.terminal?.reportBack?.detail ?? '', /denominator is unknown/i);
    assert.match(recovered.state.terminal?.reportBack?.detail ?? '', /no universal claim/i);
    assert.equal(providerRows(paths).length, 2);
  });

  const partialCases: Array<{
    scenario: Extract<Scenario, 'missing_page' | 'repeated_cursor' | 'bounded_budget'>;
    reason: string;
    crossings: number;
  }> = [
    { scenario: 'missing_page', reason: 'missing_cursor', crossings: 1 },
    { scenario: 'repeated_cursor', reason: 'repeated_cursor', crossings: 2 },
    { scenario: 'bounded_budget', reason: 'maximum_page_budget_reached', crossings: 1 },
  ];
  for (const partialCase of partialCases) {
    await t.test(`${partialCase.scenario} cannot manufacture canonical or universal truth`, () => {
      const paths = pathsFor(partialCase.scenario);
      roots.push(paths.root);
      const prepared = runFixture(paths, 'prepare');
      assert.equal(prepared.read?.status, 'partial');
      assert.equal(prepared.read?.reason, partialCase.reason);
      assert.equal(prepared.read?.aggregate?.outcome, 'partial');
      assert.equal(prepared.read?.aggregate?.reason, partialCase.reason);
      assert.equal(prepared.read?.aggregate?.coverageState, 'partial');
      assert.equal(prepared.read?.aggregate?.finalExhaustedTruth, 'false');
      assert.equal(prepared.state.provider.aggregate?.outcome, 'partial');
      assert.equal(prepared.state.provider.aggregate?.reason, partialCase.reason);
      assert.equal(prepared.state.provider.aggregate?.coverage_state, 'partial');
      assert.equal(prepared.state.provider.aggregate?.final_exhausted_truth, 'false');
      assert.equal(prepared.result?.status, 'blocked');
      assert.equal(prepared.result?.code, 'workflow_result_authority_unavailable');
      assert.deepEqual({
        datasets: prepared.state.canonical.datasets,
        observations: prepared.state.canonical.observations,
        decisions: prepared.state.canonical.decisions,
        records: prepared.state.canonical.records,
        batches: prepared.state.canonical.batches,
        quarantines: prepared.state.canonical.quarantines,
        coveragePages: prepared.state.canonical.coveragePages,
        lineageReceipts: prepared.state.lineageReceipts,
        spaceHeads: prepared.state.space.heads,
        spaceProjections: prepared.state.space.projections,
      }, {
        datasets: 0,
        observations: 0,
        decisions: 0,
        records: 0,
        batches: 0,
        quarantines: 0,
        coveragePages: 0,
        lineageReceipts: 0,
        spaceHeads: 0,
        spaceProjections: 0,
      });
      assertNoTerminalProjection(prepared.state);
      assert.equal(providerRows(paths).length, partialCase.crossings);
    });
  }
});
