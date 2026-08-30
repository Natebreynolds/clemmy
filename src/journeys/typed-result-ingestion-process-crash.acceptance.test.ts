/**
 * Governing real-process crash matrix for typed workflow-result ingestion.
 * Every case begins with a generated two-page production read. Crashed and
 * recovering PIDs share only the isolated durable home; provider bodies are
 * counted in a synchronous append-only file.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/journeys/typed-result-ingestion-process-crash.acceptance.test.ts
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'clem-typed-ingestion-crash-'));
const FIXTURE = path.join(import.meta.dirname, 'typed-result-ingestion-process-crash.fixture.ts');
const REPO = path.resolve(import.meta.dirname, '../..');

after(() => rmSync(ROOT, { recursive: true, force: true }));

type ProducerCrashPoint =
  | 'after_provider_settlement_before_batch'
  | 'after_batch_before_coverage'
  | 'after_coverage_before_lineage'
  | 'after_lineage_before_terminal';

type FixtureMode =
  | 'prepare'
  | 'inspect'
  | 'crash_ingest'
  | 'ingest_only'
  | 'publish_terminal'
  | 'recover';

interface ProviderState {
  physicalCrossings: number;
  resultHandles: number;
  pageCount: number;
  pageRows: Array<{
    page_ordinal: number;
    state: string;
    result_handle_id: string | null;
    page_receipt_digest: string | null;
    provider_exhausted_truth: string | null;
    item_count: number | null;
  }>;
  distinctPageHandles: number;
  aggregateReceipts: number;
}

interface CanonicalState {
  datasets: number;
  observations: number;
  decisions: number;
  records: number;
  batches: number;
  coveragePages: number;
  coverageItems: number;
  dataset: null | {
    datasetId: string;
    resolutionRevision: number;
    resolutionDigest: string;
    coverageRevision: number;
    coverageDigest: string;
  };
  coverage: null | {
    status: string;
    observed: number;
    denominator: { kind: string; total?: number };
    exhaustion: string;
    cursorCycleDetected: boolean;
    reasons: string[];
  };
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
}

interface FixtureState {
  pid: number;
  provider: ProviderState;
  canonical: CanonicalState;
  lineageReceipts: number;
  terminal: null | {
    status: string | null;
    terminalOutcome: string | null;
    finishedAt: string | null;
    hasClaim: boolean;
    reportBack: unknown;
  };
  terminalFiles: number;
  space: {
    heads: number;
    runProjections: number;
    head: null | {
      headDigest: string;
      runId: string;
      datasetId: string;
      observationsCommitted: number;
      canonicalRecordsCreated: number;
      resolutionBatchCount: number;
      coverageStatus: string;
      observed: number;
      exhaustion: string;
    };
    surface: null | {
      digest: string;
      runId: string | null;
      runStatus: string | null;
      coverageStatus: string;
      observationsCommitted: number;
      canonicalRecords: number;
    };
  };
}

interface FixtureOutput {
  pid: number;
  contextFile?: string;
  readStatus?: string;
  aggregateDigest?: string;
  result?: {
    status: string;
    datasetId?: string;
    observationCount?: number;
    pageCount?: number;
    claim?: unknown;
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
  home: string;
  label: string;
  counter: string;
  context: string;
}

function fixtureEnv(
  paths: CasePaths,
  mode: FixtureMode,
  options: {
    crashPoint?: ProducerCrashPoint;
    crashMarker?: string;
    terminalReady?: string;
    terminalRelease?: string;
  } = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLEMENTINE_HOME: paths.home,
    CLEMMY_TEST_ISOLATED_HOME: '1',
    MCP_AUTO_IMPORT_ENABLED: 'false',
    CLEM_TYPED_INGEST_MODE: mode,
    CLEM_TYPED_INGEST_LABEL: paths.label,
    CLEM_TYPED_INGEST_COUNTER: paths.counter,
    CLEM_TYPED_INGEST_CONTEXT: paths.context,
    ...(options.crashPoint ? { CLEM_TYPED_INGEST_CRASH_POINT: options.crashPoint } : {}),
    ...(options.crashMarker ? { CLEM_TYPED_INGEST_CRASH_MARKER: options.crashMarker } : {}),
    ...(options.terminalReady
      ? { CLEMENTINE_TEST_TERMINAL_PUBLISH_READY: options.terminalReady }
      : {}),
    ...(options.terminalRelease
      ? { CLEMENTINE_TEST_TERMINAL_PUBLISH_RELEASE: options.terminalRelease }
      : {}),
  };
}

function outputFrom(stdout: string): FixtureOutput {
  const line = stdout.trim().split('\n')
    .findLast((candidate) => candidate.startsWith('TYPED_INGEST_FIXTURE:'));
  assert.ok(line, stdout);
  return JSON.parse(line.slice('TYPED_INGEST_FIXTURE:'.length)) as FixtureOutput;
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

function crashIngestion(paths: CasePaths, point: ProducerCrashPoint): number {
  const marker = path.join(paths.home, `${point}.marker.json`);
  const child = spawnSync(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: REPO,
    env: fixtureEnv(paths, 'crash_ingest', { crashPoint: point, crashMarker: marker }),
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, null, child.stderr);
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(existsSync(marker), true, 'the producer hook did not publish its crash marker');
  const marked = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number; point: string };
  assert.equal(marked.point, point);
  return marked.pid;
}

async function crashAfterTerminalPublication(paths: CasePaths): Promise<number> {
  const ready = path.join(paths.home, 'terminal-published.ready');
  const release = path.join(paths.home, 'terminal-published.release');
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: REPO,
    env: fixtureEnv(paths, 'publish_terminal', {
      terminalReady: ready,
      terminalRelease: release,
    }),
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

function providerBodyRows(counter: string): Array<{ pid: number; page: number }> {
  if (!existsSync(counter)) return [];
  return readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; page: number });
}

function assertSettledProvider(state: FixtureState): void {
  assert.equal(state.provider.physicalCrossings, 2);
  assert.equal(state.provider.resultHandles, 2);
  assert.equal(state.provider.pageCount, 2);
  assert.equal(state.provider.distinctPageHandles, 2);
  assert.equal(state.provider.aggregateReceipts, 1);
  assert.deepEqual(
    state.provider.pageRows.map((row) => ({
      page: row.page_ordinal,
      state: row.state,
      hasHandle: typeof row.result_handle_id === 'string',
      hasReceipt: typeof row.page_receipt_digest === 'string',
      exhausted: row.provider_exhausted_truth,
      items: row.item_count,
    })),
    [{ page: 0, state: 'settled', hasHandle: true, hasReceipt: true, exhausted: 'false', items: 2 },
      { page: 1, state: 'settled', hasHandle: true, hasReceipt: true, exhausted: 'true', items: 2 }],
  );
}

function assertNoTerminalOrSpace(state: FixtureState): void {
  assert.equal(state.terminal?.status, 'running');
  assert.equal(state.terminal?.terminalOutcome, null);
  assert.equal(state.terminal?.hasClaim, false);
  assert.equal(state.terminalFiles, 1);
  assert.equal(state.space.heads, 0);
  assert.equal(state.space.runProjections, 0);
  assert.equal(state.space.head, null);
  assert.equal(state.space.surface, null);
}

function assertCompleteCanonicalState(state: FixtureState): void {
  assertSettledProvider(state);
  assert.deepEqual({
    datasets: state.canonical.datasets,
    observations: state.canonical.observations,
    decisions: state.canonical.decisions,
    records: state.canonical.records,
    batches: state.canonical.batches,
    coveragePages: state.canonical.coveragePages,
    coverageItems: state.canonical.coverageItems,
    lineageReceipts: state.lineageReceipts,
  }, {
    datasets: 1,
    observations: 4,
    decisions: 4,
    records: 4,
    batches: 2,
    coveragePages: 2,
    coverageItems: 4,
    lineageReceipts: 1,
  });
  assert.equal(state.canonical.dataset?.resolutionRevision, 2);
  assert.equal(state.canonical.dataset?.coverageRevision, 2);
  assert.deepEqual(state.canonical.coverage, {
    version: 1,
    datasetId: state.canonical.dataset?.datasetId,
    coverageRevision: 2,
    coverageDigest: state.canonical.dataset?.coverageDigest,
    observedPartitions: 1,
    cursorCycleDetected: false,
    status: 'complete',
    observed: 4,
    denominator: { kind: 'exact', total: 4 },
    exhaustion: 'exhausted',
    reasons: [],
  });
  assert.deepEqual(state.canonical.audit, {
    version: 1,
    datasetId: state.canonical.dataset?.datasetId,
    observations: 4,
    decisions: 4,
    records: 4,
    quarantines: 0,
    resolutionBatches: 2,
    coveragePartitions: 1,
    coveragePages: 2,
    coverageItems: 4,
  });
}

function assertFinalState(state: FixtureState): void {
  assertCompleteCanonicalState(state);
  assert.equal(state.terminal?.status, 'completed');
  assert.equal(state.terminal?.terminalOutcome, 'succeeded');
  assert.equal(state.terminal?.hasClaim, true);
  assert.deepEqual(state.terminal?.reportBack, {
    version: 1,
    workflowName: state.space.head ? `workflow.ingestion.${state.space.head.runId.split('.').at(-1)}` : '',
    outcome: 'done',
    detail: 'Exact generated typed-result ingestion completed.',
    acknowledgedOriginSessionIds: [],
  });
  assert.equal(state.terminalFiles, 1);
  assert.equal(state.space.heads, 1);
  assert.equal(state.space.runProjections, 1);
  assert.equal(state.space.head?.datasetId, state.canonical.dataset?.datasetId);
  assert.equal(state.space.head?.observationsCommitted, 4);
  assert.equal(state.space.head?.canonicalRecordsCreated, 4);
  assert.equal(state.space.head?.resolutionBatchCount, 2);
  assert.equal(state.space.head?.coverageStatus, 'complete');
  assert.equal(state.space.head?.observed, 4);
  assert.equal(state.space.head?.exhaustion, 'exhausted');
  assert.equal(state.space.surface?.runId, state.space.head?.runId);
  assert.equal(state.space.surface?.runStatus, 'completed');
  assert.equal(state.space.surface?.coverageStatus, 'complete');
  assert.equal(state.space.surface?.observationsCommitted, 4);
  assert.equal(state.space.surface?.canonicalRecords, 4);
}

function authoritySnapshot(state: FixtureState): unknown {
  return {
    provider: state.provider,
    canonical: state.canonical,
    lineageReceipts: state.lineageReceipts,
    terminal: state.terminal,
    terminalFiles: state.terminalFiles,
    space: state.space,
  };
}

function pathsFor(name: string): CasePaths {
  const home = path.join(ROOT, name);
  mkdirSync(home, { recursive: true });
  return {
    home,
    label: `${name}-${randomUUID()}`,
    counter: path.join(home, 'provider-bodies.jsonl'),
    context: path.join(home, 'typed-ingestion-context.json'),
  };
}

const producerCases: Array<{
  point: ProducerCrashPoint;
  expected: Pick<CanonicalState,
    'datasets' | 'observations' | 'decisions' | 'records' | 'batches' | 'coveragePages' | 'coverageItems'> & {
      lineageReceipts: number;
    };
  recoveryStatus: 'ready' | 'replayed';
}> = [{
  point: 'after_provider_settlement_before_batch',
  expected: {
    datasets: 1,
    observations: 0,
    decisions: 0,
    records: 0,
    batches: 0,
    coveragePages: 0,
    coverageItems: 0,
    lineageReceipts: 0,
  },
  recoveryStatus: 'ready',
}, {
  point: 'after_batch_before_coverage',
  expected: {
    datasets: 1,
    observations: 4,
    decisions: 4,
    records: 4,
    batches: 2,
    coveragePages: 0,
    coverageItems: 0,
    lineageReceipts: 0,
  },
  recoveryStatus: 'ready',
}, {
  point: 'after_coverage_before_lineage',
  expected: {
    datasets: 1,
    observations: 4,
    decisions: 4,
    records: 4,
    batches: 2,
    coveragePages: 2,
    coverageItems: 4,
    lineageReceipts: 0,
  },
  recoveryStatus: 'ready',
}, {
  point: 'after_lineage_before_terminal',
  expected: {
    datasets: 1,
    observations: 4,
    decisions: 4,
    records: 4,
    batches: 2,
    coveragePages: 2,
    coverageItems: 4,
    lineageReceipts: 1,
  },
  recoveryStatus: 'replayed',
}];

test('typed result ingestion converges across five actual process-death cuts without redispatch or duplication', async (t) => {
  for (const candidate of producerCases) {
    await t.test(candidate.point, () => {
      const paths = pathsFor(candidate.point);
      const prepared = runFixture(paths, 'prepare');
      assert.equal(prepared.readStatus, 'completed');
      assert.ok(prepared.aggregateDigest);
      assert.equal(prepared.contextFile, paths.context);
      assertSettledProvider(prepared.state);
      assert.deepEqual({
        datasets: prepared.state.canonical.datasets,
        observations: prepared.state.canonical.observations,
        batches: prepared.state.canonical.batches,
        coveragePages: prepared.state.canonical.coveragePages,
        lineageReceipts: prepared.state.lineageReceipts,
      }, { datasets: 0, observations: 0, batches: 0, coveragePages: 0, lineageReceipts: 0 });
      assertNoTerminalOrSpace(prepared.state);
      assert.deepEqual(providerBodyRows(paths.counter).map((row) => row.page), [0, 1]);

      const crashedPid = crashIngestion(paths, candidate.point);
      assert.notEqual(crashedPid, prepared.pid);
      const crashed = runFixture(paths, 'inspect');
      assert.notEqual(crashed.pid, crashedPid);
      assertSettledProvider(crashed.state);
      assert.deepEqual({
        datasets: crashed.state.canonical.datasets,
        observations: crashed.state.canonical.observations,
        decisions: crashed.state.canonical.decisions,
        records: crashed.state.canonical.records,
        batches: crashed.state.canonical.batches,
        coveragePages: crashed.state.canonical.coveragePages,
        coverageItems: crashed.state.canonical.coverageItems,
        lineageReceipts: crashed.state.lineageReceipts,
      }, candidate.expected);
      assertNoTerminalOrSpace(crashed.state);
      assert.equal(providerBodyRows(paths.counter).length, 2);

      const recovered = runFixture(paths, 'recover');
      assert.notEqual(recovered.pid, crashed.pid);
      assert.equal(recovered.result?.status, candidate.recoveryStatus, JSON.stringify(recovered.result));
      assert.equal(recovered.result?.observationCount, 4);
      assert.equal(recovered.result?.pageCount, 2);
      assert.equal(recovered.reconciliation?.blocked, 0);
      assert.equal(recovered.reconciliation?.failed, 0);
      assert.equal(
        (recovered.reconciliation?.projected ?? 0) + (recovered.reconciliation?.replayed ?? 0),
        1,
      );
      assertFinalState(recovered.state);
      assert.equal(providerBodyRows(paths.counter).length, 2);

      const replayed = runFixture(paths, 'recover');
      assert.notEqual(replayed.pid, recovered.pid);
      assert.equal(replayed.result?.status, 'replayed');
      assert.deepEqual(replayed.reconciliation, {
        eligible: 1,
        projected: 0,
        replayed: 1,
        blocked: 0,
        failed: 0,
      });
      assert.deepEqual(authoritySnapshot(replayed.state), authoritySnapshot(recovered.state));
      assert.equal(providerBodyRows(paths.counter).length, 2);
      assert.equal(new Set(providerBodyRows(paths.counter).map((row) => row.pid)).size, 1);
    });
  }

  await t.test('after_terminal_publication_before_space_projection', async () => {
    const paths = pathsFor('after-terminal-before-space');
    const prepared = runFixture(paths, 'prepare');
    assertSettledProvider(prepared.state);
    assert.equal(providerBodyRows(paths.counter).length, 2);

    const ingested = runFixture(paths, 'ingest_only');
    assert.equal(ingested.result?.status, 'ready');
    assertCompleteCanonicalState(ingested.state);
    assertNoTerminalOrSpace(ingested.state);

    const terminalPid = await crashAfterTerminalPublication(paths);
    assert.notEqual(terminalPid, ingested.pid);
    const crashed = runFixture(paths, 'inspect');
    assert.notEqual(crashed.pid, terminalPid);
    assertCompleteCanonicalState(crashed.state);
    assert.equal(crashed.state.terminal?.status, 'completed');
    assert.equal(crashed.state.terminal?.terminalOutcome, 'succeeded');
    assert.equal(crashed.state.terminal?.hasClaim, true);
    assert.equal(crashed.state.space.heads, 0);
    assert.equal(crashed.state.space.runProjections, 0);
    assert.equal(providerBodyRows(paths.counter).length, 2);

    const recovered = runFixture(paths, 'recover');
    assert.equal(recovered.result?.status, 'replayed');
    assert.deepEqual(recovered.reconciliation, {
      eligible: 1,
      projected: 1,
      replayed: 0,
      blocked: 0,
      failed: 0,
    });
    assertFinalState(recovered.state);
    assert.equal(providerBodyRows(paths.counter).length, 2);

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
    assert.equal(providerBodyRows(paths.counter).length, 2);
    assert.equal(new Set(providerBodyRows(paths.counter).map((row) => row.pid)).size, 1);
  });
});
