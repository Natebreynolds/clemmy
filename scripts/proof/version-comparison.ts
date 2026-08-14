/**
 * Cross-version comparator — the spine that joins two runtimes.
 *
 * Deliberately a SEPARATE tool from compareProofBenchmarkReports: that
 * comparator's byte-identical-fingerprint gate is correct for isolating a
 * cache effect within one build, and relaxing it would trade a working
 * guarantee for a different one. This comparator does the opposite job —
 * baseline and candidate are EXPECTED to differ in source — so its gates are
 * inverted:
 *
 *   - refuse only on workload-shape mismatch (different scenario, brain, or
 *     declared benchmark workload — then the legs did different work);
 *   - record both fingerprints; IDENTICAL fingerprints are an annotation
 *     (same build — this is not a version A/B) rather than a requirement;
 *   - a model-signature difference ANNOTATES the cell (token/wall deltas
 *     void, correctness deltas stand) instead of refusing it.
 *
 * Evidence grade: release-grade only when BOTH legs are sourceClean and
 * sourceStable; anything else is development-grade, carried on the result so
 * downstream reports cannot launder dirty-tree evidence into a tag claim.
 */

import type { ProofReport, ScenarioOutcome, ScenarioStatus } from './types.js';
import type { FirstRunVerdict } from './first-run.js';
import type { LegTokenTotals } from './leg-totals.js';

export interface VersionLeg {
  /** Human label, e.g. 'v3.14.0' or 'clem4-candidate'. */
  runtimeLabel: string;
  report: ProofReport;
  /** Optional per-(scenario,brain) enrichments captured at run time. */
  cells?: readonly VersionLegCellExtras[];
}

export interface VersionLegCellExtras {
  scenario: string;
  brain: string;
  firstRun?: FirstRunVerdict;
  legTotals?: LegTokenTotals;
  /** e.g. ['brain:claude-sonnet-5', 'worker:claude-sonnet-5']. */
  modelSignature?: readonly string[];
  wallMs?: number;
  canonicalToolCalls?: number;
  discoveryOperations?: number;
}

export type CellEligibility =
  | 'comparable'
  | 'missing_in_baseline'
  | 'missing_in_candidate'
  | 'workload_mismatch';

export interface VersionCellComparison {
  scenario: string;
  brain: string;
  eligibility: CellEligibility;
  baselineStatus?: ScenarioStatus;
  candidateStatus?: ScenarioStatus;
  statusDelta: 'improved' | 'regressed' | 'same' | 'not_comparable';
  /** Non-fatal facts a reader must see next to any number from this cell. */
  annotations: string[];
  baselineFirstRun?: FirstRunVerdict;
  candidateFirstRun?: FirstRunVerdict;
  /** Present only when both sides supplied the metric AND no annotation voids it. */
  tokenDelta?: { baseline: number; candidate: number; ratio: number };
  wallDelta?: { baselineMs: number; candidateMs: number; ratio: number };
  canonicalCallDelta?: { baseline: number; candidate: number; ratio: number };
}

export interface VersionComparison {
  baselineLabel: string;
  candidateLabel: string;
  baselineFingerprint: string;
  candidateFingerprint: string;
  sameSourceFingerprint: boolean;
  evidenceGrade: 'release' | 'development';
  evidenceIssues: string[];
  cells: VersionCellComparison[];
  comparableCells: number;
  improvedCells: number;
  regressedCells: number;
}

const STATUS_RANK: Record<ScenarioStatus, number> = { FAIL: 0, SKIP: 1, PASS: 2 };

function cellKey(scenario: string, brain: string): string {
  return `${scenario}\u0000${brain}`;
}

function workloadKeyOf(report: ProofReport): string | null {
  return report.benchmark?.workloadKey ?? null;
}

function ratioOf(baseline: number, candidate: number): number {
  if (baseline <= 0) return candidate <= 0 ? 1 : Number.POSITIVE_INFINITY;
  return candidate / baseline;
}

function signatureDiffers(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (!a || !b) return false;
  const left = [...a].sort().join('|');
  const right = [...b].sort().join('|');
  return left !== right;
}

export function compareVersionLegs(baseline: VersionLeg, candidate: VersionLeg): VersionComparison {
  const evidenceIssues: string[] = [];
  const grade = (report: ProofReport, label: string): void => {
    if (!report.sourceClean) evidenceIssues.push(`${label}:source_dirty`);
    if (report.sourceStable === false) evidenceIssues.push(`${label}:source_unstable`);
    if (report.sourceStable === undefined) evidenceIssues.push(`${label}:source_stability_unrecorded`);
    if (report.failures > 0) evidenceIssues.push(`${label}:report_has_failures:${report.failures}`);
    const failingChecks = (report.reportChecks ?? []).filter((check) => !check.pass);
    if (failingChecks.length > 0) {
      evidenceIssues.push(`${label}:failing_report_checks:${failingChecks.length}`);
    }
  };
  grade(baseline.report, baseline.runtimeLabel);
  grade(candidate.report, candidate.runtimeLabel);

  const baselineRuntimeFingerprint = baseline.report.runtimeFingerprint ?? baseline.report.sourceFingerprint;
  const candidateRuntimeFingerprint = candidate.report.runtimeFingerprint ?? candidate.report.sourceFingerprint;
  const sameSourceFingerprint = baselineRuntimeFingerprint === candidateRuntimeFingerprint;
  const sameMeasurementStack = baseline.report.sourceFingerprint === candidate.report.sourceFingerprint;
  if (!sameMeasurementStack) {
    evidenceIssues.push('measurement_stack_fingerprint_mismatch');
  }
  if (sameSourceFingerprint) {
    evidenceIssues.push('same_source_fingerprint:legs_are_one_build_not_a_version_ab');
  }

  const baselineWorkload = workloadKeyOf(baseline.report);
  const candidateWorkload = workloadKeyOf(candidate.report);
  const workloadMismatch = !sameMeasurementStack || (
    baselineWorkload !== null
    && candidateWorkload !== null
    && baselineWorkload !== candidateWorkload
  );

  const baselineOutcomes = new Map<string, ScenarioOutcome>();
  for (const outcome of baseline.report.outcomes) {
    baselineOutcomes.set(cellKey(outcome.scenario, outcome.brain), outcome);
  }
  const baselineExtras = new Map<string, VersionLegCellExtras>();
  for (const extras of baseline.cells ?? []) {
    baselineExtras.set(cellKey(extras.scenario, extras.brain), extras);
  }
  const candidateExtras = new Map<string, VersionLegCellExtras>();
  for (const extras of candidate.cells ?? []) {
    candidateExtras.set(cellKey(extras.scenario, extras.brain), extras);
  }

  const cells: VersionCellComparison[] = [];
  const seen = new Set<string>();

  for (const candOutcome of candidate.report.outcomes) {
    const key = cellKey(candOutcome.scenario, candOutcome.brain);
    seen.add(key);
    const baseOutcome = baselineOutcomes.get(key);
    if (!baseOutcome) {
      cells.push({
        scenario: candOutcome.scenario,
        brain: candOutcome.brain,
        eligibility: 'missing_in_baseline',
        candidateStatus: candOutcome.status,
        statusDelta: 'not_comparable',
        annotations: [],
      });
      continue;
    }
    if (workloadMismatch) {
      cells.push({
        scenario: candOutcome.scenario,
        brain: candOutcome.brain,
        eligibility: 'workload_mismatch',
        baselineStatus: baseOutcome.status,
        candidateStatus: candOutcome.status,
        statusDelta: 'not_comparable',
        annotations: !sameMeasurementStack
          ? ['measurement_stack_fingerprint_mismatch']
          : [`workload:${baselineWorkload}!=${candidateWorkload}`],
      });
      continue;
    }

    const annotations: string[] = [];
    const baseExtra = baselineExtras.get(key);
    const candExtra = candidateExtras.get(key);
    const modelDrift = signatureDiffers(baseExtra?.modelSignature, candExtra?.modelSignature);
    if (modelDrift) {
      annotations.push(
        `model_signature_differs:${(baseExtra?.modelSignature ?? []).join(',')}->${(candExtra?.modelSignature ?? []).join(',')}`,
      );
    }

    const failToSkip = baseOutcome.status === 'FAIL' && candOutcome.status === 'SKIP';
    if (failToSkip) annotations.push('fail_to_skip:evidence_disappeared');
    const rankDelta = STATUS_RANK[candOutcome.status] - STATUS_RANK[baseOutcome.status];
    const cell: VersionCellComparison = {
      scenario: candOutcome.scenario,
      brain: candOutcome.brain,
      eligibility: 'comparable',
      baselineStatus: baseOutcome.status,
      candidateStatus: candOutcome.status,
      statusDelta: failToSkip
        ? 'not_comparable'
        : rankDelta > 0 ? 'improved' : rankDelta < 0 ? 'regressed' : 'same',
      annotations,
      baselineFirstRun: baseExtra?.firstRun,
      candidateFirstRun: candExtra?.firstRun,
    };

    // Cost/latency deltas are voided by model drift; correctness stands.
    if (!modelDrift) {
      if (baseExtra?.legTotals && candExtra?.legTotals) {
        cell.tokenDelta = {
          baseline: baseExtra.legTotals.totalTokens,
          candidate: candExtra.legTotals.totalTokens,
          ratio: ratioOf(baseExtra.legTotals.totalTokens, candExtra.legTotals.totalTokens),
        };
        if (baseExtra.legTotals.quiesceTruncated || candExtra.legTotals.quiesceTruncated) {
          cell.annotations.push('token_total_is_floor:quiesce_truncated');
        }
      }
      if (typeof baseExtra?.wallMs === 'number' && typeof candExtra?.wallMs === 'number') {
        cell.wallDelta = {
          baselineMs: baseExtra.wallMs,
          candidateMs: candExtra.wallMs,
          ratio: ratioOf(baseExtra.wallMs, candExtra.wallMs),
        };
      }
      if (
        typeof baseExtra?.canonicalToolCalls === 'number'
        && typeof candExtra?.canonicalToolCalls === 'number'
      ) {
        cell.canonicalCallDelta = {
          baseline: baseExtra.canonicalToolCalls,
          candidate: candExtra.canonicalToolCalls,
          ratio: ratioOf(baseExtra.canonicalToolCalls, candExtra.canonicalToolCalls),
        };
      }
      if (!cell.tokenDelta && !cell.wallDelta && !cell.canonicalCallDelta) {
        cell.annotations.push('cost_evidence_missing');
      }
    }

    cells.push(cell);
  }

  for (const baseOutcome of baseline.report.outcomes) {
    const key = cellKey(baseOutcome.scenario, baseOutcome.brain);
    if (seen.has(key)) continue;
    cells.push({
      scenario: baseOutcome.scenario,
      brain: baseOutcome.brain,
      eligibility: 'missing_in_candidate',
      baselineStatus: baseOutcome.status,
      statusDelta: 'not_comparable',
      annotations: [],
    });
  }

  const comparable = cells.filter((cell) => cell.eligibility === 'comparable');
  return {
    baselineLabel: baseline.runtimeLabel,
    candidateLabel: candidate.runtimeLabel,
    baselineFingerprint: baselineRuntimeFingerprint,
    candidateFingerprint: candidateRuntimeFingerprint,
    sameSourceFingerprint,
    evidenceGrade: evidenceIssues.length === 0 ? 'release' : 'development',
    evidenceIssues,
    cells,
    comparableCells: comparable.length,
    improvedCells: comparable.filter((cell) => cell.statusDelta === 'improved').length,
    regressedCells: comparable.filter((cell) => cell.statusDelta === 'regressed').length,
  };
}
