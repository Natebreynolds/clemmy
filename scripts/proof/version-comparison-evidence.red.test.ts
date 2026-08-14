/**
 * RED PIN — the cross-version comparator must not launder weak evidence.
 *
 * Invariant: an honest performance proof names what it could NOT see. Three
 * grader-weakening seams are pinned here:
 *
 *   1. A leg whose own ProofReport recorded failures (or a failing
 *      report-wide check) cannot ground a clean comparison — the comparator
 *      must carry that as an evidence issue instead of comparing silently.
 *   2. A comparable cell with NO cost evidence (no token/wall/call extras on
 *      either side) must be flagged 'cost_evidence_missing' — omitting the
 *      extras must never silently produce an unmetered "clean" comparison.
 *   3. baseline FAIL -> candidate SKIP is vanished evidence, not improvement:
 *      the cell must read 'not_comparable' (or carry a named fail_to_skip
 *      annotation), never 'improved'. Today STATUS_RANK orders FAIL < SKIP,
 *      so a scenario that stopped running counts as an improved cell.
 *
 * Run: npx tsx --test scripts/proof/version-comparison-evidence.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProofReport } from './types.js';
import { compareVersionLegs } from './version-comparison.js';

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

test('a candidate report carrying failures is flagged as an evidence issue, never compared clean', () => {
  const baseline = report({
    sourceFingerprint: 'fp-v3.14',
    outcomes: [{ scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] }],
  });
  const candidate = report({
    sourceFingerprint: 'fp-clem4',
    failures: 1,
    outcomes: [{ scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] }],
  });
  const result = compareVersionLegs(
    { runtimeLabel: 'baseline', report: baseline },
    { runtimeLabel: 'candidate', report: candidate },
  );
  assert.ok(
    result.evidenceIssues.some((issue) => issue.startsWith('candidate:') && /failur/.test(issue)),
    'a leg whose own report recorded failures>0 must surface a named evidence issue '
    + `(e.g. candidate:report_has_failures); evidenceIssues=${JSON.stringify(result.evidenceIssues)}`,
  );
  assert.equal(result.evidenceGrade, 'development', 'failure-carrying evidence is never release grade');
});

test('a failing report-wide check on a leg is an evidence issue, never compared clean', () => {
  const baseline = report({
    sourceFingerprint: 'fp-v3.14',
    outcomes: [{ scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] }],
  });
  const candidate = report({
    sourceFingerprint: 'fp-clem4',
    reportChecks: [{ name: 'source fingerprint stable across proof', pass: false }],
    outcomes: [{ scenario: 's1', brain: 'codex', status: 'PASS', checks: [], latency: [] }],
  });
  const result = compareVersionLegs(
    { runtimeLabel: 'baseline', report: baseline },
    { runtimeLabel: 'candidate', report: candidate },
  );
  assert.ok(
    result.evidenceIssues.some((issue) => issue.startsWith('candidate:') && /(check|failur)/.test(issue)),
    'a failing report-wide check must surface a named evidence issue '
    + `(e.g. candidate:failing_report_check); evidenceIssues=${JSON.stringify(result.evidenceIssues)}`,
  );
});

test('comparable cells with no cost evidence are flagged, never silently unmetered', () => {
  const baseline = report({
    sourceFingerprint: 'shared-measurement-stack',
    runtimeFingerprint: 'runtime-a',
    outcomes: [{ scenario: 's1', brain: 'claude', status: 'PASS', checks: [], latency: [] }],
  });
  const candidate = report({
    sourceFingerprint: 'shared-measurement-stack',
    runtimeFingerprint: 'runtime-b',
    outcomes: [{ scenario: 's1', brain: 'claude', status: 'PASS', checks: [], latency: [] }],
  });
  // Neither leg supplies cells extras: no legTotals, no wallMs, no
  // canonicalToolCalls. The comparison is then correctness-only.
  const result = compareVersionLegs(
    { runtimeLabel: 'baseline', report: baseline },
    { runtimeLabel: 'candidate', report: candidate },
  );
  const cell = result.cells[0];
  assert.equal(cell?.eligibility, 'comparable', 'fixture: the cell pairs by (scenario, brain)');
  assert.equal(cell.tokenDelta, undefined, 'fixture: no cost metric was computable');
  assert.ok(
    cell.annotations.includes('cost_evidence_missing'),
    'a comparable cell whose cost extras are absent must say so on the cell '
    + `('cost_evidence_missing'), so omitting the extras cannot fabricate a fully-metered comparison; annotations=${JSON.stringify(cell.annotations)}`,
  );
});

test('a baseline FAIL that becomes a candidate SKIP never reads as improvement', () => {
  const baseline = report({
    sourceFingerprint: 'fp-a',
    outcomes: [{ scenario: 's1', brain: 'glm', status: 'FAIL', checks: [], latency: [] }],
  });
  const candidate = report({
    sourceFingerprint: 'fp-b',
    outcomes: [{ scenario: 's1', brain: 'glm', status: 'SKIP', checks: [], latency: [] }],
  });
  const result = compareVersionLegs(
    { runtimeLabel: 'baseline', report: baseline },
    { runtimeLabel: 'candidate', report: candidate },
  );
  const cell = result.cells[0];
  assert.ok(cell, 'fixture: the cell exists');
  const honest = cell.statusDelta === 'not_comparable'
    || cell.annotations.some((entry) => entry.includes('fail_to_skip'));
  assert.ok(
    honest,
    'FAIL -> SKIP means the scenario stopped producing evidence, not that it improved; '
    + `the cell must be not_comparable or carry a named fail_to_skip annotation, got statusDelta=${cell.statusDelta} annotations=${JSON.stringify(cell.annotations)}`,
  );
  assert.equal(result.improvedCells, 0, 'a cell that stopped running cannot count toward improvedCells');
});
