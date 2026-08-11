/**
 * First-run verdict self-tests — table-driven, one case per reason string,
 * plus the clustered-analysis invariants (cells are the inference unit; a
 * pooled-trial McNemar would treat within-cell repeats as independent, which
 * is exactly what this module exists to prevent).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clusteredPairedAnalysis,
  firstRunVerdict,
  rollupFirstRunCell,
  type FirstRunTurnFacts,
} from './first-run.js';

const cleanTurn: FirstRunTurnFacts = {
  sourceUserSeq: 10,
  attemptCount: 1,
  unfinishedAttempts: 0,
  terminalStatus: 'completed',
  awaitingUserInputEvents: 0,
  supersededEvents: 0,
  restartRecoveryEvents: 0,
};

const passChecks = [{ name: 'a', pass: true }, { name: 'b', pass: true }];

test('clean single-attempt turn with green checks is first-run-correct', () => {
  const verdict = firstRunVerdict({ status: 'PASS', checks: passChecks, turns: [cleanTurn] });
  assert.equal(verdict.correct, true);
  assert.deepEqual(verdict.reasons, []);
  assert.deepEqual(verdict.unknowns, []);
});

test('each violation produces its named reason', () => {
  const cases: Array<{ turn: Partial<FirstRunTurnFacts>; reason: RegExp }> = [
    { turn: { attemptCount: 2 }, reason: /^attempts:turn:10=2$/ },
    { turn: { unfinishedAttempts: 1 }, reason: /^unfinished-attempts:turn:10=1$/ },
    { turn: { terminalStatus: 'blocked' }, reason: /^terminal:turn:10=blocked$/ },
    { turn: { terminalStatus: null }, reason: /^terminal:turn:10=none$/ },
    { turn: { supersededEvents: 1 }, reason: /^superseded:turn:10=1$/ },
    { turn: { awaitingUserInputEvents: 1 }, reason: /^asks:total=1>scripted=0$/ },
    { turn: { restartRecoveryEvents: 1 }, reason: /^restarts:total=1>scripted=0$/ },
  ];
  for (const { turn, reason } of cases) {
    const verdict = firstRunVerdict({
      status: 'PASS',
      checks: passChecks,
      turns: [{ ...cleanTurn, ...turn }],
    });
    assert.equal(verdict.correct, false, `expected incorrect for ${reason}`);
    assert.ok(
      verdict.reasons.some((entry) => reason.test(entry)),
      `expected a reason matching ${reason}, got ${JSON.stringify(verdict.reasons)}`,
    );
  }
});

test('failed check names the check', () => {
  const verdict = firstRunVerdict({
    status: 'FAIL',
    checks: [{ name: 'sheet-rows-exact', pass: false }],
    turns: [cleanTurn],
  });
  assert.equal(verdict.correct, false);
  assert.deepEqual(verdict.reasons, ['check:sheet-rows-exact']);
});

test('scripted asks and restarts are not violations', () => {
  const verdict = firstRunVerdict({
    status: 'PASS',
    checks: passChecks,
    turns: [{ ...cleanTurn, awaitingUserInputEvents: 1, restartRecoveryEvents: 1 }],
    contract: { scriptedAskCount: 1, scriptedRestarts: 1 },
  });
  assert.equal(verdict.correct, true);
});

test('non-default accepted terminal statuses are honored', () => {
  const verdict = firstRunVerdict({
    status: 'PASS',
    checks: passChecks,
    turns: [{ ...cleanTurn, terminalStatus: 'transferred' }],
    contract: { acceptedTerminalStatuses: ['completed', 'transferred'] },
  });
  assert.equal(verdict.correct, true);
});

test('missing facts land in unknowns, never silently satisfied', () => {
  const verdict = firstRunVerdict({
    status: 'PASS',
    checks: passChecks,
    turns: [{ sourceUserSeq: 7 }],
  });
  assert.equal(verdict.correct, true, 'missing facts alone must not fail the verdict');
  for (const expected of [
    'attempts:turn:7',
    'unfinished-attempts:turn:7',
    'terminal:turn:7',
    'asks:turn:7',
    'superseded:turn:7',
    'restarts:turn:7',
  ]) {
    assert.ok(verdict.unknowns.includes(expected), `expected unknown ${expected}`);
  }
});

test('SKIP is never first-run-correct and carries only the skip reason', () => {
  const verdict = firstRunVerdict({ status: 'SKIP', checks: [], turns: [] });
  assert.equal(verdict.correct, false);
  assert.deepEqual(verdict.reasons, ['status:SKIP']);
});

test('cell rollup: pass^k requires every repeat correct', () => {
  const good = { correct: true, reasons: [], unknowns: [] };
  const bad = { correct: false, reasons: ['check:x'], unknowns: [] };
  const all = rollupFirstRunCell({ scenario: 's', brain: 'codex', verdicts: [good, good, good] });
  assert.equal(all.passAllRepeats, true);
  assert.equal(all.rate, 1);
  const one = rollupFirstRunCell({ scenario: 's', brain: 'codex', verdicts: [good, bad, good] });
  assert.equal(one.passAllRepeats, false);
  assert.ok(Math.abs(one.rate - 2 / 3) < 1e-9);
});

test('clustered analysis pairs by cell and counts wins over cells, not trials', () => {
  const cellsOf = (rates: number[], label: string) => rates.map((rate, index) => ({
    scenario: `scn-${index}`,
    brain: label,
    trials: 5,
    correct: Math.round(rate * 5),
    rate,
    passAllRepeats: rate === 1,
    evidenceLimitedTrials: 0,
  }));
  const baseline = cellsOf([0.2, 0.4, 0.4, 0.6], 'codex');
  const candidate = cellsOf([0.8, 0.8, 0.4, 1.0], 'codex');
  const result = clusteredPairedAnalysis({ baseline, candidate, seed: 7 });
  assert.equal(result.cells.length, 4);
  assert.equal(result.wins, 3);
  assert.equal(result.losses, 0);
  assert.equal(result.ties, 1);
  // Sign test over 3 non-tied cells at p=0.5: two-sided P = 2 * 0.125 = 0.25.
  assert.ok(result.signTestP !== null && Math.abs(result.signTestP - 0.25) < 1e-9);
  assert.ok(result.meanDifference > 0);
  assert.ok(result.bootstrapCi95 !== null);
});

test('clustered analysis is deterministic for a fixed seed', () => {
  const cell = (scenario: string, rate: number) => ({
    scenario,
    brain: 'claude',
    trials: 5,
    correct: Math.round(rate * 5),
    rate,
    passAllRepeats: rate === 1,
    evidenceLimitedTrials: 0,
  });
  const baseline = [cell('a', 0.2), cell('b', 0.6), cell('c', 0.4)];
  const candidate = [cell('a', 0.6), cell('b', 0.8), cell('c', 0.6)];
  const one = clusteredPairedAnalysis({ baseline, candidate, seed: 42 });
  const two = clusteredPairedAnalysis({ baseline, candidate, seed: 42 });
  assert.deepEqual(one.bootstrapCi95, two.bootstrapCi95);
});
