import { createHash } from 'node:crypto';

import type {
  BrainKind,
  FusionProofMode,
  ProofBenchmarkMetadata,
  ProofBenchmarkSample,
  ProofReport,
  ScenarioOutcome,
} from './types.js';

export interface ProofBenchmarkCliRequest {
  cohortId: string;
  sample: ProofBenchmarkSample;
}

export interface ProofBenchmarkWorkload {
  fusionMode: FusionProofMode;
  scenarios: ReadonlyArray<{
    name: string;
    inputs?: Readonly<Record<string, string | number | boolean | null>>;
  }>;
}

export type ObservedWorkerCacheState = 'all_miss' | 'mixed' | 'all_hit' | 'unknown';
export type ProofBenchmarkEvidence = 'release' | 'development' | 'ineligible';

export interface ProofBenchmarkSelector {
  brain: BrainKind;
  scenario: string;
}

export interface ProofBenchmarkSampleSummary {
  brain: BrainKind;
  scenario: string;
  sourceFingerprint: string;
  sourceClean: boolean;
  workloadKey: string;
  modelSignature: string[];
  itemCount: number;
  phaseCount: number;
  expectedWorkerCalls: number;
  workerCallCount: number;
  workerGrossPromptTokens: number;
  workerCacheReadInputTokens: number;
  workerZeroCacheCalls: number;
  workerCacheState: ObservedWorkerCacheState;
  wallMs: number;
  totals: {
    grossPromptTokens: number;
    cacheReadInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    accruedTokens: number;
    cacheHitRatio: number;
  };
}

export interface ProofBenchmarkTokenDelta {
  grossPromptTokens: number;
  cacheReadInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  accruedTokens: number;
  cacheHitRatio: number;
  wallMs: number;
  zeroCacheWorkerCalls: number;
}

export interface ProofBenchmarkComparison {
  eligible: boolean;
  evidence: ProofBenchmarkEvidence;
  releaseEligible: boolean;
  reasons: string[];
  prime: ProofBenchmarkSampleSummary | null;
  measured: ProofBenchmarkSampleSummary | null;
  /** Absolute token deltas exist only for a certified same-provider/model pair. */
  tokenDelta: ProofBenchmarkTokenDelta | null;
  /** True only when worker call count and aggregate gross-prompt volume match,
   * making the uncached delta an exact cache-accounting effect. This does not
   * claim that independently generated prompt bytes were identical. */
  cacheEffectIsolated: boolean;
}

function requiredFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

/** Parse only benchmark identity; the main proof parser still owns all other flags. */
export function parseProofBenchmarkFlags(argv: readonly string[]): ProofBenchmarkCliRequest | null {
  let cohortId: string | undefined;
  let sample: ProofBenchmarkSample | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--benchmark-cohort') {
      if (cohortId !== undefined) throw new Error('--benchmark-cohort may be supplied only once');
      cohortId = requiredFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--benchmark-sample') {
      if (sample !== undefined) throw new Error('--benchmark-sample may be supplied only once');
      const raw = requiredFlagValue(argv, i, arg);
      if (raw !== 'prime' && raw !== 'measured') {
        throw new Error('--benchmark-sample requires prime or measured');
      }
      sample = raw;
      i += 1;
    }
  }
  if (cohortId === undefined && sample === undefined) return null;
  if (cohortId === undefined || sample === undefined) {
    throw new Error('--benchmark-cohort and --benchmark-sample must be supplied together');
  }
  if (cohortId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(cohortId)) {
    throw new Error('--benchmark-cohort must be a 1-128 character identifier');
  }
  return { cohortId, sample };
}

function stableRecord(
  value: Readonly<Record<string, string | number | boolean | null>> | undefined,
): Record<string, string | number | boolean | null> {
  const source = value ?? {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(source).sort()) out[key] = source[key]!;
  return out;
}

/** Hash declared inputs only. Runtime output/timestamps can never split a cohort. */
export function fingerprintProofBenchmarkWorkload(input: ProofBenchmarkWorkload): string {
  const canonical = {
    protocolVersion: 1,
    fusionMode: input.fusionMode,
    scenarios: input.scenarios
      .map((scenario) => ({ name: scenario.name, inputs: stableRecord(scenario.inputs) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  return createHash('sha256')
    .update('clementine-proof-benchmark-workload-v1\0')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

export function proofBenchmarkMetadata(
  request: ProofBenchmarkCliRequest,
  workload: ProofBenchmarkWorkload,
): ProofBenchmarkMetadata {
  return {
    protocolVersion: 1,
    cohortId: request.cohortId,
    sample: request.sample,
    workloadKey: fingerprintProofBenchmarkWorkload(workload),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function finiteRatio(value: unknown): number | null {
  const ratio = finiteNonNegative(value);
  return ratio !== null && ratio <= 1 ? ratio : null;
}

function exactOutcome(report: ProofReport, selector: ProofBenchmarkSelector): ScenarioOutcome | null {
  const matches = report.outcomes.filter((outcome) => (
    outcome.brain === selector.brain && outcome.scenario === selector.scenario
  ));
  return matches.length === 1 ? matches[0]! : null;
}

function sampleSummary(
  report: ProofReport,
  selector: ProofBenchmarkSelector,
  expectedSample: ProofBenchmarkSample,
): { summary: ProofBenchmarkSampleSummary | null; issues: string[] } {
  const issues: string[] = [];
  const benchmark = report.benchmark;
  if (!benchmark) issues.push('benchmark_metadata_missing');
  else {
    if (benchmark.protocolVersion !== 1) issues.push('benchmark_protocol_unsupported');
    if (benchmark.sample !== expectedSample) issues.push(`sample_must_be_${expectedSample}`);
    if (
      typeof benchmark.cohortId !== 'string'
      || benchmark.cohortId.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(benchmark.cohortId)
    ) issues.push('cohort_id_invalid');
    if (!/^[a-f0-9]{64}$/.test(benchmark.workloadKey)) issues.push('workload_key_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(report.sourceFingerprint)) issues.push('source_fingerprint_invalid');
  if (
    report.sourceStable !== true
    || report.sourceFingerprintEnd !== report.sourceFingerprint
  ) issues.push('source_stability_unproven');
  if (report.failures !== 0) issues.push('report_has_failures');
  if (report.reportChecks?.some((check) => !check.pass)) issues.push('report_check_failed');

  const outcome = exactOutcome(report, selector);
  if (!outcome) {
    issues.push('selected_outcome_missing_or_ambiguous');
    return { summary: null, issues };
  }
  if (outcome.status !== 'PASS') issues.push('selected_outcome_not_pass');
  const metrics = object(outcome.metrics);
  if (!metrics) {
    issues.push('scenario_metrics_missing');
    return { summary: null, issues };
  }
  const itemCount = positiveInteger(metrics.itemCount);
  const phaseCount = positiveInteger(metrics.phaseCount);
  if (itemCount === null || phaseCount === null) issues.push('workload_shape_missing');
  const usage = object(metrics.usageBreakdown);
  if (!usage) {
    issues.push('usage_breakdown_missing');
    return { summary: null, issues };
  }
  const usageRecordCount = nonNegativeInteger(usage.usageRecordCount);
  const malformedUsageRecordCount = nonNegativeInteger(usage.malformedUsageRecordCount);
  const explicitRoleUsageRecords = nonNegativeInteger(usage.explicitRoleUsageRecords);
  const unattributedUsageRecords = nonNegativeInteger(usage.unattributedUsageRecords);
  if (malformedUsageRecordCount !== 0) issues.push('malformed_usage_rows');
  if (
    usageRecordCount === null
    || explicitRoleUsageRecords === null
    || unattributedUsageRecords === null
  ) issues.push('usage_record_counts_invalid');
  if (unattributedUsageRecords !== 0) issues.push('usage_attribution_incomplete');
  const totals = object(usage.totals);
  const rows = Array.isArray(usage.rows) ? usage.rows.map(object) : null;
  if (!totals || !rows || rows.some((row) => row === null)) {
    issues.push('usage_breakdown_invalid');
    return { summary: null, issues };
  }
  const callCount = nonNegativeInteger(totals.callCount);
  const grossPromptTokens = nonNegativeInteger(totals.grossPromptTokens);
  const cacheReadInputTokens = nonNegativeInteger(totals.cacheReadInputTokens);
  const cacheReadRecordedCalls = nonNegativeInteger(totals.cacheReadRecordedCalls);
  const uncachedInputTokens = nonNegativeInteger(totals.uncachedInputTokens);
  const outputTokens = nonNegativeInteger(totals.outputTokens);
  const accruedTokens = nonNegativeInteger(totals.accruedTokens);
  const cacheHitRatio = finiteRatio(totals.cacheHitRatio);
  if (
    callCount === null
    || callCount <= 0
    || grossPromptTokens === null
    || cacheReadInputTokens === null
    || cacheReadRecordedCalls === null
    || uncachedInputTokens === null
    || outputTokens === null
    || accruedTokens === null
    || cacheHitRatio === null
  ) issues.push('usage_totals_incomplete');
  if (callCount !== null && cacheReadRecordedCalls !== callCount) issues.push('cache_read_coverage_incomplete');
  if (totals.accrualDeltaFromSession !== 0) issues.push('session_accrual_mismatch');
  if (
    grossPromptTokens !== null
    && cacheReadInputTokens !== null
    && uncachedInputTokens !== null
    && (
      cacheReadInputTokens > grossPromptTokens
      || uncachedInputTokens !== grossPromptTokens - cacheReadInputTokens
    )
  ) issues.push('usage_token_identity_mismatch');
  if (
    uncachedInputTokens !== null
    && outputTokens !== null
    && accruedTokens !== null
    && accruedTokens !== uncachedInputTokens + outputTokens
  ) issues.push('usage_accrual_identity_mismatch');

  const validRows = rows.filter((row): row is Record<string, unknown> => row !== null);
  if (validRows.some((row) => row.uncertifiedCallCount !== 0 || row.invalidCallCount !== 0)) {
    issues.push('cache_accounting_uncertified');
  }
  if (validRows.some((row) => (
    row.attribution !== 'explicit_trace_lane'
    || row.role === 'unattributed'
  ))) issues.push('usage_attribution_incomplete');
  if (validRows.some((row) => (
    typeof row.model !== 'string'
    || !row.model.trim()
    || row.model.trim() === '(unknown)'
  ))) issues.push('model_identity_missing');

  const rowTotals = {
    callCount: 0,
    grossPromptTokens: 0,
    cacheReadInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    accruedTokens: 0,
  };
  let completeRows = true;
  for (const row of validRows) {
    const rowCallCount = nonNegativeInteger(row.callCount);
    const rowGross = nonNegativeInteger(row.grossPromptTokens);
    const rowReads = nonNegativeInteger(row.cacheReadInputTokens);
    const rowReadCalls = nonNegativeInteger(row.cacheReadRecordedCalls);
    const rowUncached = nonNegativeInteger(row.uncachedInputTokens);
    const rowOutput = nonNegativeInteger(row.outputTokens);
    const rowAccrued = nonNegativeInteger(row.accruedTokens);
    const rowRatio = finiteRatio(row.cacheHitRatio);
    if (
      rowCallCount === null
      || rowGross === null
      || rowReads === null
      || rowReadCalls === null
      || rowUncached === null
      || rowOutput === null
      || rowAccrued === null
      || rowRatio === null
    ) {
      completeRows = false;
      continue;
    }
    if (rowReadCalls !== rowCallCount) issues.push('cache_read_coverage_incomplete');
    if (rowReads > rowGross || rowUncached !== rowGross - rowReads) {
      issues.push('usage_token_identity_mismatch');
    }
    if (rowAccrued !== rowUncached + rowOutput) issues.push('usage_accrual_identity_mismatch');
    rowTotals.callCount += rowCallCount;
    rowTotals.grossPromptTokens += rowGross;
    rowTotals.cacheReadInputTokens += rowReads;
    rowTotals.uncachedInputTokens += rowUncached;
    rowTotals.outputTokens += rowOutput;
    rowTotals.accruedTokens += rowAccrued;
  }
  if (!completeRows) issues.push('usage_rows_incomplete');
  if (
    usageRecordCount !== null
    && explicitRoleUsageRecords !== null
    && unattributedUsageRecords !== null
    && (
      callCount !== usageRecordCount
      || explicitRoleUsageRecords + unattributedUsageRecords !== usageRecordCount
      || (completeRows && rowTotals.callCount !== usageRecordCount)
    )
  ) issues.push('usage_call_count_mismatch');
  if (
    completeRows
    && grossPromptTokens !== null
    && cacheReadInputTokens !== null
    && uncachedInputTokens !== null
    && outputTokens !== null
    && accruedTokens !== null
    && (
      rowTotals.grossPromptTokens !== grossPromptTokens
      || rowTotals.cacheReadInputTokens !== cacheReadInputTokens
      || rowTotals.uncachedInputTokens !== uncachedInputTokens
      || rowTotals.outputTokens !== outputTokens
      || rowTotals.accruedTokens !== accruedTokens
    )
  ) issues.push('usage_row_total_mismatch');

  const workerRows = validRows.filter((row) => row.role === 'worker');
  if (workerRows.length === 0) issues.push('explicit_worker_usage_missing');
  if (workerRows.some((row) => row.attribution !== 'explicit_trace_lane')) {
    issues.push('worker_usage_not_explicit');
  }
  let workerCallCount = 0;
  let workerGrossPromptTokens = 0;
  let workerCacheReadInputTokens = 0;
  let workerZeroCacheCalls = 0;
  for (const row of workerRows) {
    const calls = nonNegativeInteger(row.callCount);
    const gross = nonNegativeInteger(row.grossPromptTokens);
    const reads = nonNegativeInteger(row.cacheReadInputTokens);
    const readCalls = nonNegativeInteger(row.cacheReadRecordedCalls);
    const zeroCalls = nonNegativeInteger(row.zeroCacheCalls);
    if (
      calls === null
      || gross === null
      || reads === null
      || readCalls !== calls
      || zeroCalls === null
      || zeroCalls > calls
      || reads > gross
      || (reads === 0) !== (zeroCalls === calls)
    ) {
      issues.push('worker_cache_evidence_incomplete');
      continue;
    }
    workerCallCount += calls;
    workerGrossPromptTokens += gross;
    workerCacheReadInputTokens += reads;
    workerZeroCacheCalls += zeroCalls;
  }
  const reportedZeroCacheWorkerCalls = nonNegativeInteger(usage.zeroCacheWorkerCalls);
  if (
    reportedZeroCacheWorkerCalls === null
    || reportedZeroCacheWorkerCalls !== workerZeroCacheCalls
  ) issues.push('worker_cache_evidence_incomplete');
  const expectedWorkerCalls = itemCount !== null && phaseCount !== null
    ? itemCount * phaseCount
    : 0;
  if (expectedWorkerCalls <= 0 || workerCallCount !== expectedWorkerCalls) {
    issues.push('worker_call_shape_mismatch');
  }
  const models = [...new Set(validRows.flatMap((row) => (
    typeof row.model === 'string' && row.model.trim()
      ? [`${String(row.role ?? 'unattributed')}:${row.model.trim()}`]
      : []
  )))].sort();
  if (models.length === 0) issues.push('model_identity_missing');
  const wallMs = finiteNonNegative(metrics.observedSettlementWallMs);
  if (wallMs === null) issues.push('settlement_wall_time_missing');

  if (
    !benchmark
    || itemCount === null
    || phaseCount === null
    || callCount === null
    || grossPromptTokens === null
    || cacheReadInputTokens === null
    || uncachedInputTokens === null
    || outputTokens === null
    || accruedTokens === null
    || cacheHitRatio === null
    || wallMs === null
  ) return { summary: null, issues: [...new Set(issues)] };

  const workerCacheState: ObservedWorkerCacheState = workerCallCount <= 0
    ? 'unknown'
    : workerZeroCacheCalls === workerCallCount
      ? 'all_miss'
      : workerZeroCacheCalls === 0 && workerCacheReadInputTokens > 0
        ? 'all_hit'
        : workerZeroCacheCalls > 0 && workerZeroCacheCalls < workerCallCount
          ? 'mixed'
          : 'unknown';
  return {
    summary: {
      brain: selector.brain,
      scenario: selector.scenario,
      sourceFingerprint: report.sourceFingerprint,
      sourceClean: report.sourceClean,
      workloadKey: benchmark.workloadKey,
      modelSignature: models,
      itemCount,
      phaseCount,
      expectedWorkerCalls,
      workerCallCount,
      workerGrossPromptTokens,
      workerCacheReadInputTokens,
      workerZeroCacheCalls,
      workerCacheState,
      wallMs,
      totals: {
        grossPromptTokens,
        cacheReadInputTokens,
        uncachedInputTokens,
        outputTokens,
        accruedTokens,
        cacheHitRatio,
      },
    },
    issues: [...new Set(issues)],
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Compare an explicit prime/measured report pair. This function never infers a
 * cohort from timestamps and never emits absolute token deltas across provider
 * or model boundaries. Invalid/legacy reports remain readable as reasons.
 */
export function compareProofBenchmarkReports(input: {
  primeReport: ProofReport;
  measuredReport: ProofReport;
  prime: ProofBenchmarkSelector;
  measured?: ProofBenchmarkSelector;
}): ProofBenchmarkComparison {
  const measuredSelector = input.measured ?? input.prime;
  const primeRead = sampleSummary(input.primeReport, input.prime, 'prime');
  const measuredRead = sampleSummary(input.measuredReport, measuredSelector, 'measured');
  const reasons = [
    ...primeRead.issues.map((issue) => `prime:${issue}`),
    ...measuredRead.issues.map((issue) => `measured:${issue}`),
  ];
  const primeMeta = input.primeReport.benchmark;
  const measuredMeta = input.measuredReport.benchmark;
  if (primeMeta && measuredMeta) {
    if (primeMeta.cohortId !== measuredMeta.cohortId) reasons.push('cohort_mismatch');
    if (primeMeta.workloadKey !== measuredMeta.workloadKey) reasons.push('workload_key_mismatch');
  }
  if (input.primeReport.sourceFingerprint !== input.measuredReport.sourceFingerprint) {
    reasons.push('source_fingerprint_mismatch');
  }
  if (input.primeReport.fusionMode !== input.measuredReport.fusionMode) reasons.push('fusion_mode_mismatch');
  if (input.prime.scenario !== measuredSelector.scenario) reasons.push('scenario_mismatch');

  const prime = primeRead.summary;
  const measured = measuredRead.summary;
  if (prime && measured) {
    if (prime.itemCount !== measured.itemCount || prime.phaseCount !== measured.phaseCount) {
      reasons.push('workload_shape_mismatch');
    }
    if (prime.brain !== measured.brain) reasons.push('provider_mismatch');
    if (!sameStrings(prime.modelSignature, measured.modelSignature)) reasons.push('model_signature_mismatch');
  }
  const uniqueReasons = [...new Set(reasons)];
  const eligible = prime !== null && measured !== null && uniqueReasons.length === 0;
  const releaseEligible = eligible && prime.sourceClean && measured.sourceClean;
  const evidence: ProofBenchmarkEvidence = !eligible
    ? 'ineligible'
    : releaseEligible
      ? 'release'
      : 'development';
  const cacheEffectIsolated = eligible
    && prime.workerCallCount === measured.workerCallCount
    && prime.workerGrossPromptTokens === measured.workerGrossPromptTokens;
  const tokenDelta: ProofBenchmarkTokenDelta | null = eligible ? {
    grossPromptTokens: measured.totals.grossPromptTokens - prime.totals.grossPromptTokens,
    cacheReadInputTokens: measured.totals.cacheReadInputTokens - prime.totals.cacheReadInputTokens,
    uncachedInputTokens: measured.totals.uncachedInputTokens - prime.totals.uncachedInputTokens,
    outputTokens: measured.totals.outputTokens - prime.totals.outputTokens,
    accruedTokens: measured.totals.accruedTokens - prime.totals.accruedTokens,
    cacheHitRatio: measured.totals.cacheHitRatio - prime.totals.cacheHitRatio,
    wallMs: measured.wallMs - prime.wallMs,
    zeroCacheWorkerCalls: measured.workerZeroCacheCalls - prime.workerZeroCacheCalls,
  } : null;
  return {
    eligible,
    evidence,
    releaseEligible,
    reasons: uniqueReasons,
    prime,
    measured,
    tokenDelta,
    cacheEffectIsolated,
  };
}
