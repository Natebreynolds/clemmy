/**
 * Cross-version comparator self-tests. The three gate properties under pin:
 *   1. a source-fingerprint DIFFERENCE is accepted (the whole point);
 *   2. identical fingerprints are annotated as not-a-version-A/B;
 *   3. a workload-key mismatch refuses the cells; a model-signature difference
 *      annotates and voids cost deltas while correctness deltas stand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProofReport } from './types.js';
import { compareVersionLegs } from './version-comparison.js';
import type { LegTokenTotals } from './leg-totals.js';

function report(overrides: Partial<ProofReport>): ProofReport {
  return {
    startedAt: '2026-08-11T00:00:00Z',
    finishedAt: '2026-08-11T00:30:00Z',
    gitHead: 'headhash',
    sourceFingerprint: 'fp-default',
    sourceStable: true,
    sourceClean: true,
    fusionMode: 'off',
    outcomes: [],
    failures: 0,
    ...overrides,
  };
}

function runtimeReport(runtimeFingerprint: string, overrides: Partial<ProofReport>): ProofReport {
  return report({
    sourceFingerprint: 'shared-measurement-stack',
    runtimeFingerprint,
    ...overrides,
  });
}

function totals(totalTokens: number, quiesceTruncated = false): LegTokenTotals {
  return {
    totalTokens,
    inputTokens: totalTokens,
    outputTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    uncachedInputTokens: totalTokens,
    cacheHitRatio: 0,
    preTerminalTokens: totalTokens,
    quiesceTokens: 0,
    quiesceTruncated,
    unattributedTokens: 0,
    unattributedShare: 0,
    unattributedRecords: 0,
    byModel: {},
    recordCount: 1,
    invalidLines: 0,
    firstRecordAt: null,
    lastRecordAt: null,
  };
}

test('different fingerprints compare cleanly; statuses pair by scenario x brain', () => {
  const baseline = report({
    sourceFingerprint: 'measurement-stack',
    runtimeFingerprint: 'runtime-v3.14',
    outcomes: [
      { scenario: 's1', brain: 'codex', status: 'FAIL', checks: [], latency: [] },
      { scenario: 's2', brain: 'codex', status: 'PASS', checks: [], latency: [] },
    ],
  });
  const candidate = report({
    sourceFingerprint: 'measurement-stack',
    runtimeFingerprint: 'runtime-clem4',
    outcomes: [
      { scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] },
      { scenario: 's2', brain: 'codex', status: 'PASS', checks: [], latency: [] },
    ],
  });
  const result = compareVersionLegs(
    { runtimeLabel: 'v3.14.0', report: baseline },
    { runtimeLabel: 'clem4', report: candidate },
  );
  assert.equal(result.sameSourceFingerprint, false);
  assert.equal(result.comparableCells, 2);
  assert.equal(result.improvedCells, 1);
  assert.equal(result.regressedCells, 0);
  assert.equal(result.evidenceGrade, 'release');
  const s1 = result.cells.find((cell) => cell.scenario === 's1');
  assert.equal(s1?.statusDelta, 'improved');
});

test('identical fingerprints are annotated as one-build, not refused', () => {
  const shared = report({
    sourceFingerprint: 'fp-same',
    outcomes: [{ scenario: 's1', brain: 'claude', status: 'PASS', checks: [], latency: [] }],
  });
  const result = compareVersionLegs(
    { runtimeLabel: 'a', report: shared },
    { runtimeLabel: 'b', report: shared },
  );
  assert.equal(result.sameSourceFingerprint, true);
  assert.equal(result.comparableCells, 1, 'cells still compare');
  assert.ok(result.evidenceIssues.some((issue) => issue.startsWith('same_source_fingerprint')));
  assert.equal(result.evidenceGrade, 'development');
});

test('cross-version identity compares the daemon runtime artifact, not the shared measurement stack', () => {
  const baseline = report({ sourceFingerprint: 'measurement-stack' }) as ProofReport;
  const candidate = report({ sourceFingerprint: 'measurement-stack' }) as ProofReport;
  baseline.runtimeFingerprint = 'runtime-v314';
  candidate.runtimeFingerprint = 'runtime-candidate';
  const comparison = compareVersionLegs(
    { runtimeLabel: 'v3.14', report: baseline },
    { runtimeLabel: 'candidate', report: candidate },
  );
  assert.equal(comparison.sameSourceFingerprint, false);
  assert.equal(comparison.baselineFingerprint, 'runtime-v314');
  assert.equal(comparison.candidateFingerprint, 'runtime-candidate');
});

test('different measurement stacks make cells ineligible and downgrade evidence', () => {
  const baseline = report({
    sourceFingerprint: 'measurement-a',
    runtimeFingerprint: 'runtime-a',
    outcomes: [{ scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] }],
  });
  const candidate = report({
    sourceFingerprint: 'measurement-b',
    runtimeFingerprint: 'runtime-b',
    outcomes: [{ scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] }],
  });
  const comparison = compareVersionLegs(
    { runtimeLabel: 'a', report: baseline },
    { runtimeLabel: 'b', report: candidate },
  );
  assert.equal(comparison.evidenceGrade, 'development');
  assert.equal(comparison.comparableCells, 0);
  assert.equal(comparison.cells[0]?.eligibility, 'workload_mismatch');
  assert.ok(comparison.evidenceIssues.includes('measurement_stack_fingerprint_mismatch'));
});

test('workload-key mismatch refuses the cells', () => {
  const baseline = report({
    sourceFingerprint: 'shared-measurement-stack',
    runtimeFingerprint: 'runtime-a',
    benchmark: { protocolVersion: 1, cohortId: 'c', sample: 'prime', workloadKey: 'wk-1' },
    outcomes: [{ scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] }],
  });
  const candidate = report({
    sourceFingerprint: 'shared-measurement-stack',
    runtimeFingerprint: 'runtime-b',
    benchmark: { protocolVersion: 1, cohortId: 'c', sample: 'measured', workloadKey: 'wk-2' },
    outcomes: [{ scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] }],
  });
  const result = compareVersionLegs(
    { runtimeLabel: 'a', report: baseline },
    { runtimeLabel: 'b', report: candidate },
  );
  assert.equal(result.comparableCells, 0);
  assert.equal(result.cells[0]?.eligibility, 'workload_mismatch');
});

test('missing cells surface on both sides', () => {
  const baseline = runtimeReport('runtime-a', {
    outcomes: [
      { scenario: 'only-base', brain: 'codex', status: 'PASS', checks: [], latency: [] },
      { scenario: 'shared', brain: 'codex', status: 'PASS', checks: [], latency: [] },
    ],
  });
  const candidate = runtimeReport('runtime-b', {
    outcomes: [
      { scenario: 'shared', brain: 'codex', status: 'PASS', checks: [], latency: [] },
      { scenario: 'only-cand', brain: 'codex', status: 'PASS', checks: [], latency: [] },
    ],
  });
  const result = compareVersionLegs(
    { runtimeLabel: 'a', report: baseline },
    { runtimeLabel: 'b', report: candidate },
  );
  const eligibilities = result.cells.map((cell) => `${cell.scenario}:${cell.eligibility}`).sort();
  assert.deepEqual(eligibilities, [
    'only-base:missing_in_candidate',
    'only-cand:missing_in_baseline',
    'shared:comparable',
  ]);
});

test('model-signature drift annotates the cell and voids cost deltas, not correctness', () => {
  const baseline = runtimeReport('runtime-a', {
    outcomes: [{ scenario: 's1', brain: 'glm', status: 'FAIL', checks: [], latency: [] }],
  });
  const candidate = runtimeReport('runtime-b', {
    outcomes: [{ scenario: 's1', brain: 'glm', status: 'PASS', checks: [], latency: [] }],
  });
  const result = compareVersionLegs(
    {
      runtimeLabel: 'a',
      report: baseline,
      cells: [{
        scenario: 's1', brain: 'glm', modelSignature: ['brain:kimi-k3'], legTotals: totals(100), wallMs: 1000,
      }],
    },
    {
      runtimeLabel: 'b',
      report: candidate,
      cells: [{
        scenario: 's1', brain: 'glm', modelSignature: ['brain:glm-5.2'], legTotals: totals(50), wallMs: 500,
      }],
    },
  );
  const cell = result.cells[0];
  assert.equal(cell.eligibility, 'comparable');
  assert.equal(cell.statusDelta, 'improved', 'correctness delta stands');
  assert.ok(cell.annotations.some((entry) => entry.startsWith('model_signature_differs')));
  assert.equal(cell.tokenDelta, undefined, 'token delta voided');
  assert.equal(cell.wallDelta, undefined, 'wall delta voided');
});

test('stable signatures produce token/wall/call deltas with ratios', () => {
  const baseline = runtimeReport('runtime-a', {
    outcomes: [{ scenario: 's1', brain: 'claude', status: 'PASS', checks: [], latency: [] }],
  });
  const candidate = runtimeReport('runtime-b', {
    outcomes: [{ scenario: 's1', brain: 'claude', status: 'PASS', checks: [], latency: [] }],
  });
  const result = compareVersionLegs(
    {
      runtimeLabel: 'a',
      report: baseline,
      cells: [{
        scenario: 's1', brain: 'claude', modelSignature: ['brain:claude-sonnet-5'],
        legTotals: totals(1000), wallMs: 2000, canonicalToolCalls: 40,
      }],
    },
    {
      runtimeLabel: 'b',
      report: candidate,
      cells: [{
        scenario: 's1', brain: 'claude', modelSignature: ['brain:claude-sonnet-5'],
        legTotals: totals(600, true), wallMs: 1000, canonicalToolCalls: 10,
      }],
    },
  );
  const cell = result.cells[0];
  assert.ok(cell.tokenDelta && Math.abs(cell.tokenDelta.ratio - 0.6) < 1e-9);
  assert.ok(cell.wallDelta && Math.abs(cell.wallDelta.ratio - 0.5) < 1e-9);
  assert.ok(cell.canonicalCallDelta && Math.abs(cell.canonicalCallDelta.ratio - 0.25) < 1e-9);
  assert.ok(cell.annotations.includes('token_total_is_floor:quiesce_truncated'));
});

test('dirty or unstable trees downgrade evidence to development with named issues', () => {
  const result = compareVersionLegs(
    { runtimeLabel: 'a', report: report({ sourceFingerprint: 'fp-a', sourceClean: false }) },
    { runtimeLabel: 'b', report: report({ sourceFingerprint: 'fp-b', sourceStable: false }) },
  );
  assert.equal(result.evidenceGrade, 'development');
  assert.ok(result.evidenceIssues.includes('a:source_dirty'));
  assert.ok(result.evidenceIssues.includes('b:source_unstable'));
});

test('archived v1 reports without sourceStable are readable but flagged', () => {
  const result = compareVersionLegs(
    { runtimeLabel: 'a', report: report({ sourceFingerprint: 'fp-a', sourceStable: undefined }) },
    { runtimeLabel: 'b', report: report({ sourceFingerprint: 'fp-b' }) },
  );
  assert.ok(result.evidenceIssues.includes('a:source_stability_unrecorded'));
});
