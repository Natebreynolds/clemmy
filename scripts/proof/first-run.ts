/**
 * First-run correctness — the tag standard's headline metric, as a pure module.
 *
 * A scenario leg is first-run-correct only when the work landed on the first
 * attempt with no hidden help: every check green, one run attempt, an accepted
 * terminal, and no unscripted asks, supersessions, or restart re-drives.
 *
 * The verdict consumes structural TURN FACTS rather than a concrete
 * measurement type so it can score both live measurements (once
 * AcceptedTurnMeasurement carries the counters) and archived reports (where
 * some facts are unavailable). A missing fact is never silently treated as
 * satisfied — it lands in `unknowns` so a verdict built on partial evidence
 * says so.
 */

import type { Check, ScenarioStatus } from './types.js';

export interface ScenarioFirstRunContract {
  /** Asks the scenario itself scripts (clarify-then-answer flows). Default 0. */
  scriptedAskCount?: number;
  /** Restarts the scenario deliberately performs (restart-resume). Default 0. */
  scriptedRestarts?: number;
  /** Terminal statuses that count as a clean landing. Default ['completed']. */
  acceptedTerminalStatuses?: readonly string[];
}

/**
 * Per-measured-turn facts. Every field optional: an absent fact is reported in
 * `unknowns`, never assumed. Field names match the planned
 * AcceptedTurnMeasurement extensions so wiring later is a pass-through.
 */
export interface FirstRunTurnFacts {
  sourceUserSeq?: number;
  attemptCount?: number;
  unfinishedAttempts?: number;
  terminalStatus?: string | null;
  awaitingUserInputEvents?: number;
  supersededEvents?: number;
  restartRecoveryEvents?: number;
}

export interface FirstRunVerdict {
  correct: boolean;
  /** Concrete violations, machine-greppable prefixes (e.g. `attempts:`). */
  reasons: string[];
  /** Facts that were unavailable, so this verdict is evidence-limited. */
  unknowns: string[];
}

const DEFAULT_ACCEPTED_TERMINALS: readonly string[] = ['completed'];

function turnLabel(turn: FirstRunTurnFacts, index: number): string {
  return typeof turn.sourceUserSeq === 'number' ? `turn:${turn.sourceUserSeq}` : `turn[${index}]`;
}

export function firstRunVerdict(input: {
  status?: ScenarioStatus;
  checks: readonly Check[];
  turns: readonly FirstRunTurnFacts[];
  contract?: ScenarioFirstRunContract;
}): FirstRunVerdict {
  const contract = input.contract ?? {};
  const scriptedAsks = contract.scriptedAskCount ?? 0;
  const scriptedRestarts = contract.scriptedRestarts ?? 0;
  const acceptedTerminals = contract.acceptedTerminalStatuses ?? DEFAULT_ACCEPTED_TERMINALS;

  const reasons: string[] = [];
  const unknowns: string[] = [];

  if (input.status === 'SKIP') {
    // A skipped leg has no run to grade; it is not first-run-correct and the
    // reason is the skip itself, not a behavior defect.
    return { correct: false, reasons: ['status:SKIP'], unknowns: [] };
  }

  const failedChecks = input.checks.filter((check) => !check.pass);
  for (const check of failedChecks) {
    reasons.push(`check:${check.name}`);
  }
  if (input.checks.length === 0) {
    unknowns.push('checks:none-recorded');
  }

  let totalAsks: number | null = 0;
  let totalRestarts: number | null = 0;

  if (input.turns.length === 0) {
    unknowns.push('turns:none-recorded');
  }

  input.turns.forEach((turn, index) => {
    const label = turnLabel(turn, index);

    if (typeof turn.attemptCount === 'number') {
      if (turn.attemptCount > 1) reasons.push(`attempts:${label}=${turn.attemptCount}`);
      if (turn.attemptCount === 0) unknowns.push(`attempts:${label}=0`);
    } else {
      unknowns.push(`attempts:${label}`);
    }

    if (typeof turn.unfinishedAttempts === 'number') {
      if (turn.unfinishedAttempts > 0) reasons.push(`unfinished-attempts:${label}=${turn.unfinishedAttempts}`);
    } else {
      unknowns.push(`unfinished-attempts:${label}`);
    }

    if (turn.terminalStatus === undefined) {
      unknowns.push(`terminal:${label}`);
    } else if (turn.terminalStatus === null || !acceptedTerminals.includes(turn.terminalStatus)) {
      reasons.push(`terminal:${label}=${turn.terminalStatus ?? 'none'}`);
    }

    if (typeof turn.awaitingUserInputEvents === 'number') {
      if (totalAsks !== null) totalAsks += turn.awaitingUserInputEvents;
    } else {
      totalAsks = totalAsks === null ? null : totalAsks;
      unknowns.push(`asks:${label}`);
    }

    if (typeof turn.supersededEvents === 'number') {
      if (turn.supersededEvents > 0) reasons.push(`superseded:${label}=${turn.supersededEvents}`);
    } else {
      unknowns.push(`superseded:${label}`);
    }

    if (typeof turn.restartRecoveryEvents === 'number') {
      if (totalRestarts !== null) totalRestarts += turn.restartRecoveryEvents;
    } else {
      unknowns.push(`restarts:${label}`);
    }
  });

  if (totalAsks !== null && totalAsks > scriptedAsks) {
    reasons.push(`asks:total=${totalAsks}>scripted=${scriptedAsks}`);
  }
  if (totalRestarts !== null && totalRestarts > scriptedRestarts) {
    reasons.push(`restarts:total=${totalRestarts}>scripted=${scriptedRestarts}`);
  }

  return { correct: reasons.length === 0, reasons, unknowns };
}

/**
 * Roll a set of per-leg verdicts up to the aggregates the benchmark reports:
 * pass^k per cell (all repeats correct) and the per-cell paired differences the
 * clustered analysis consumes. Pure arithmetic — no I/O.
 */
export interface FirstRunCell {
  scenario: string;
  brain: string;
  verdicts: readonly FirstRunVerdict[];
}

export interface FirstRunCellRollup {
  scenario: string;
  brain: string;
  trials: number;
  correct: number;
  /** Fraction of trials correct (pass@1 mean for the cell). */
  rate: number;
  /** True only when every trial in the cell is correct (the pass^k event). */
  passAllRepeats: boolean;
  /** Trials whose verdicts carried unknowns — evidence-limited, flag in reports. */
  evidenceLimitedTrials: number;
}

export function rollupFirstRunCell(cell: FirstRunCell): FirstRunCellRollup {
  const trials = cell.verdicts.length;
  const correct = cell.verdicts.filter((verdict) => verdict.correct).length;
  return {
    scenario: cell.scenario,
    brain: cell.brain,
    trials,
    correct,
    rate: trials === 0 ? 0 : correct / trials,
    passAllRepeats: trials > 0 && correct === trials,
    evidenceLimitedTrials: cell.verdicts.filter((verdict) => verdict.unknowns.length > 0).length,
  };
}

/**
 * Cell-clustered paired analysis (Anthropic error-bars methodology): the unit
 * of inference is the CELL (scenario x brain), never the pooled trial. Returns
 * per-cell paired rate differences, the exact sign-test p-value over cells with
 * a nonzero difference, and a cluster bootstrap CI over the mean difference.
 * Deliberately NOT McNemar over pooled trials — within-cell repeats share a
 * cell and are not independent.
 */
export interface PairedCellDifference {
  scenario: string;
  brain: string;
  baselineRate: number;
  candidateRate: number;
  difference: number;
}

export interface ClusteredPairedResult {
  cells: PairedCellDifference[];
  meanDifference: number;
  /** Cells where candidate > baseline / candidate < baseline. */
  wins: number;
  losses: number;
  ties: number;
  /** Two-sided exact binomial sign test over non-tied cells. */
  signTestP: number | null;
  /** Percentile cluster-bootstrap CI over the mean per-cell difference. */
  bootstrapCi95: { low: number; high: number } | null;
}

function exactBinomialTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  // P(X <= min(k, n-k)) + P(X >= max(k, n-k)) under p = 0.5.
  const logChoose = (nn: number, kk: number): number => {
    let sum = 0;
    for (let i = 1; i <= kk; i += 1) sum += Math.log(nn - kk + i) - Math.log(i);
    return sum;
  };
  const pmf = (kk: number): number => Math.exp(logChoose(n, kk) + n * Math.log(0.5));
  const lo = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= lo; i += 1) p += pmf(i);
  for (let i = Math.max(n - lo, lo + 1); i <= n; i += 1) p += pmf(i);
  return Math.min(1, p);
}

/** Deterministic LCG so bootstrap results are reproducible in tests/reports. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function clusteredPairedAnalysis(input: {
  baseline: readonly FirstRunCellRollup[];
  candidate: readonly FirstRunCellRollup[];
  bootstrapIterations?: number;
  seed?: number;
}): ClusteredPairedResult {
  const byKey = new Map<string, FirstRunCellRollup>();
  for (const cell of input.baseline) byKey.set(`${cell.scenario} ${cell.brain}`, cell);

  const cells: PairedCellDifference[] = [];
  for (const cand of input.candidate) {
    const base = byKey.get(`${cand.scenario} ${cand.brain}`);
    if (!base) continue;
    cells.push({
      scenario: cand.scenario,
      brain: cand.brain,
      baselineRate: base.rate,
      candidateRate: cand.rate,
      difference: cand.rate - base.rate,
    });
  }

  const wins = cells.filter((cell) => cell.difference > 0).length;
  const losses = cells.filter((cell) => cell.difference < 0).length;
  const ties = cells.length - wins - losses;
  const meanDifference = cells.length === 0
    ? 0
    : cells.reduce((sum, cell) => sum + cell.difference, 0) / cells.length;

  const nonTied = wins + losses;
  const signTestP = nonTied === 0 ? null : exactBinomialTwoSided(wins, nonTied);

  let bootstrapCi95: { low: number; high: number } | null = null;
  const iterations = input.bootstrapIterations ?? 2000;
  if (cells.length >= 2 && iterations > 0) {
    const rand = lcg(input.seed ?? 0x5eed);
    const means: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      let sum = 0;
      for (let j = 0; j < cells.length; j += 1) {
        sum += cells[Math.floor(rand() * cells.length)].difference;
      }
      means.push(sum / cells.length);
    }
    means.sort((a, b) => a - b);
    bootstrapCi95 = {
      low: means[Math.floor(0.025 * (means.length - 1))],
      high: means[Math.ceil(0.975 * (means.length - 1))],
    };
  }

  return { cells, meanDifference, wins, losses, ties, signTestP, bootstrapCi95 };
}
