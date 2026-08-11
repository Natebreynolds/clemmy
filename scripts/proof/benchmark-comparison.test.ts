import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareProofBenchmarkReports,
  fingerprintProofBenchmarkWorkload,
  parseProofBenchmarkFlags,
  proofBenchmarkMetadata,
} from './benchmark-comparison.js';
import type {
  BrainKind,
  ProofBenchmarkSample,
  ProofReport,
} from './types.js';

const SOURCE = 'a'.repeat(64);
const WORKLOAD = {
  fusionMode: 'off' as const,
  scenarios: [{
    name: 'long-horizon-manifest',
    inputs: {
      itemCount: 12,
      phaseCount: 2,
      manifestContractVersion: '1',
      manifestId: 'proof-long-horizon',
    },
  }],
};
const WORKLOAD_KEY = fingerprintProofBenchmarkWorkload(WORKLOAD);

interface ReportOptions {
  sample: ProofBenchmarkSample;
  brain?: BrainKind;
  sourceClean?: boolean;
  sourceFingerprint?: string;
  sourceFingerprintEnd?: string;
  sourceStable?: boolean;
  cohortId?: string;
  workloadKey?: string;
  workerCacheReads: number;
  workerZeroCacheCalls: number | null;
  workerGrossPromptTokens?: number;
  workerModel?: string;
  wallMs: number;
}

function report(options: ReportOptions): ProofReport {
  const brain = options.brain ?? 'claude';
  const sourceFingerprint = options.sourceFingerprint ?? SOURCE;
  const workerGrossPromptTokens = options.workerGrossPromptTokens ?? 365_184;
  const workerUncached = workerGrossPromptTokens - options.workerCacheReads;
  const workerOutput = options.sample === 'prime' ? 483 : 482;
  const workerAccrued = workerUncached + workerOutput;
  const brainGross = options.sample === 'prime' ? 76_813 : 76_814;
  const brainReads = options.sample === 'prime' ? 47_628 : 60_974;
  const brainOutput = options.sample === 'prime' ? 1_367 : 1_249;
  const brainUncached = brainGross - brainReads;
  const brainAccrued = brainUncached + brainOutput;
  const totalGross = workerGrossPromptTokens + brainGross;
  const totalReads = options.workerCacheReads + brainReads;
  const totalUncached = workerUncached + brainUncached;
  const totalOutput = workerOutput + brainOutput;
  const totalAccrued = workerAccrued + brainAccrued;
  const workerModel = options.workerModel ?? 'claude-sonnet-5';
  return {
    startedAt: options.sample === 'prime'
      ? '2026-08-08T21:52:45.701Z'
      : '2026-08-08T21:53:47.786Z',
    finishedAt: options.sample === 'prime'
      ? '2026-08-08T21:53:34.930Z'
      : '2026-08-08T21:54:38.286Z',
    gitHead: 'f'.repeat(40),
    gitHeadEnd: 'f'.repeat(40),
    sourceFingerprint,
    sourceFingerprintEnd: options.sourceFingerprintEnd ?? sourceFingerprint,
    sourceStable: options.sourceStable ?? true,
    sourceClean: options.sourceClean ?? false,
    fusionMode: 'off',
    benchmark: {
      protocolVersion: 1,
      cohortId: options.cohortId ?? 'cohort-0808',
      sample: options.sample,
      workloadKey: options.workloadKey ?? WORKLOAD_KEY,
    },
    reportChecks: [{ name: 'source stable', pass: options.sourceStable ?? true }],
    outcomes: [{
      scenario: 'long-horizon-manifest',
      brain,
      status: 'PASS',
      checks: [],
      latency: [{ wallMs: options.wallMs, ttftMs: 3_000 }],
      metrics: {
        itemCount: 12,
        phaseCount: 2,
        observedSettlementWallMs: options.wallMs,
        usageBreakdown: {
          usageRecordCount: 25,
          malformedUsageRecordCount: 0,
          explicitRoleUsageRecords: 25,
          unattributedUsageRecords: 0,
          zeroCacheWorkerCalls: options.workerZeroCacheCalls,
          rows: [
            {
              role: 'brain',
              model: workerModel,
              attribution: 'explicit_trace_lane',
              callCount: 1,
              grossPromptTokens: brainGross,
              cacheReadInputTokens: brainReads,
              cacheReadRecordedCalls: 1,
              uncachedInputTokens: brainUncached,
              outputTokens: brainOutput,
              accruedTokens: brainAccrued,
              cacheHitRatio: brainReads / brainGross,
              zeroCacheCalls: null,
              uncertifiedCallCount: 0,
              invalidCallCount: 0,
            },
            {
              role: 'worker',
              model: workerModel,
              attribution: 'explicit_trace_lane',
              callCount: 24,
              grossPromptTokens: workerGrossPromptTokens,
              cacheReadInputTokens: options.workerCacheReads,
              cacheReadRecordedCalls: 24,
              uncachedInputTokens: workerUncached,
              outputTokens: workerOutput,
              accruedTokens: workerAccrued,
              cacheHitRatio: options.workerCacheReads / workerGrossPromptTokens,
              zeroCacheCalls: options.workerZeroCacheCalls,
              uncertifiedCallCount: 0,
              invalidCallCount: 0,
            },
          ],
          totals: {
            callCount: 25,
            grossPromptTokens: totalGross,
            cacheReadInputTokens: totalReads,
            cacheReadRecordedCalls: 25,
            uncachedInputTokens: totalUncached,
            outputTokens: totalOutput,
            accruedTokens: totalAccrued,
            cacheHitRatio: totalReads / totalGross,
            sessionTokensUsed: totalAccrued,
            accrualDeltaFromSession: 0,
          },
          limitations: [],
        },
      },
    }],
    failures: 0,
  };
}

function paired(
  primeOverrides: Partial<ReportOptions> = {},
  measuredOverrides: Partial<ReportOptions> = {},
) {
  return compareProofBenchmarkReports({
    primeReport: report({
      sample: 'prime',
      workerCacheReads: 235_394,
      workerZeroCacheCalls: 5,
      wallMs: 35_889.291292,
      ...primeOverrides,
    }),
    measuredReport: report({
      sample: 'measured',
      workerCacheReads: 309_312,
      workerZeroCacheCalls: 0,
      wallMs: 38_149.863166,
      ...measuredOverrides,
    }),
    prime: { brain: primeOverrides.brain ?? 'claude', scenario: 'long-horizon-manifest' },
    measured: { brain: measuredOverrides.brain ?? 'claude', scenario: 'long-horizon-manifest' },
  });
}

test('benchmark flags require an explicit valid cohort and prime/measured role', () => {
  assert.deepEqual(parseProofBenchmarkFlags([]), null);
  assert.deepEqual(parseProofBenchmarkFlags([
    '--brain', 'claude',
    '--benchmark-cohort', 'clem4:long-horizon.1',
    '--benchmark-sample', 'prime',
  ]), { cohortId: 'clem4:long-horizon.1', sample: 'prime' });
  assert.throws(() => parseProofBenchmarkFlags(['--benchmark-cohort', 'only']), /supplied together/);
  assert.throws(() => parseProofBenchmarkFlags([
    '--benchmark-cohort', 'pair', '--benchmark-sample', 'cold',
  ]), /prime or measured/);
  assert.throws(() => parseProofBenchmarkFlags([
    '--benchmark-cohort', 'not a stable id', '--benchmark-sample', 'measured',
  ]), /identifier/);
});

test('workload fingerprint is order-stable and changes with a material scenario input', () => {
  const same = fingerprintProofBenchmarkWorkload({
    fusionMode: 'off',
    scenarios: [{
      name: 'long-horizon-manifest',
      inputs: {
        manifestId: 'proof-long-horizon',
        phaseCount: 2,
        itemCount: 12,
        manifestContractVersion: '1',
      },
    }],
  });
  const changed = fingerprintProofBenchmarkWorkload({
    ...WORKLOAD,
    scenarios: [{ ...WORKLOAD.scenarios[0]!, inputs: { ...WORKLOAD.scenarios[0]!.inputs, itemCount: 120 } }],
  });
  assert.equal(same, WORKLOAD_KEY);
  assert.notEqual(changed, WORKLOAD_KEY);
  assert.deepEqual(
    proofBenchmarkMetadata({ cohortId: 'pair-1', sample: 'measured' }, WORKLOAD),
    { protocolVersion: 1, cohortId: 'pair-1', sample: 'measured', workloadKey: WORKLOAD_KEY },
  );
});

test('same-provider pair reports observed mixed-to-all-hit cache change without claiming cold', () => {
  const comparison = paired();
  assert.equal(comparison.eligible, true);
  assert.equal(comparison.evidence, 'development');
  assert.equal(comparison.releaseEligible, false);
  assert.equal(comparison.prime?.workerCacheState, 'mixed');
  assert.equal(comparison.measured?.workerCacheState, 'all_hit');
  assert.equal(comparison.cacheEffectIsolated, true);
  assert.ok(comparison.tokenDelta);
  assert.equal(comparison.tokenDelta.cacheReadInputTokens, 87_264);
  assert.equal(comparison.tokenDelta.uncachedInputTokens, -87_263);
  assert.equal(comparison.tokenDelta.zeroCacheWorkerCalls, -5);
  assert.ok((comparison.tokenDelta.wallMs ?? 0) > 0, 'warmer cache did not manufacture a latency win');
});

test('only two clean, stable, green reports can make paired release evidence', () => {
  assert.equal(paired({ sourceClean: true }, { sourceClean: true }).evidence, 'release');
  assert.equal(paired({ sourceClean: true }, { sourceClean: false }).evidence, 'development');
  const drifted = paired({}, { sourceStable: false, sourceFingerprintEnd: 'b'.repeat(64) });
  assert.equal(drifted.eligible, false);
  assert.ok(drifted.reasons.includes('measured:source_stability_unproven'));
});

test('cross-provider or model comparisons never emit absolute token deltas', () => {
  const crossProvider = paired({}, {
    brain: 'codex',
    workerModel: 'gpt-5.4',
  });
  assert.equal(crossProvider.eligible, false);
  assert.equal(crossProvider.tokenDelta, null);
  assert.ok(crossProvider.reasons.includes('provider_mismatch'));
  assert.ok(crossProvider.reasons.includes('model_signature_mismatch'));

  const modelDrift = paired({}, { workerModel: 'claude-sonnet-5.1' });
  assert.equal(modelDrift.eligible, false);
  assert.equal(modelDrift.tokenDelta, null);
  assert.ok(modelDrift.reasons.includes('model_signature_mismatch'));
});

test('cohort, source, workload, and explicit cache evidence all fail closed', () => {
  assert.ok(paired({}, { cohortId: 'different' }).reasons.includes('cohort_mismatch'));
  assert.ok(paired({}, { sourceFingerprint: 'b'.repeat(64) }).reasons.includes('source_fingerprint_mismatch'));
  assert.ok(paired({}, { workloadKey: 'b'.repeat(64) }).reasons.includes('workload_key_mismatch'));
  const missingCache = paired({}, { workerZeroCacheCalls: null });
  assert.equal(missingCache.eligible, false);
  assert.ok(missingCache.reasons.includes('measured:worker_cache_evidence_incomplete'));
});

test('internally inconsistent usage accounting is never comparison evidence', () => {
  const measured = report({
    sample: 'measured', workerCacheReads: 309_312, workerZeroCacheCalls: 0, wallMs: 30_000,
  });
  const outcome = measured.outcomes[0]!;
  const usage = outcome.metrics!.usageBreakdown as {
    usageRecordCount: number;
    rows: Array<Record<string, unknown>>;
    totals: Record<string, unknown>;
  };
  usage.usageRecordCount += 1;
  usage.rows[1]!.uncachedInputTokens = 1;
  const comparison = compareProofBenchmarkReports({
    primeReport: report({
      sample: 'prime', workerCacheReads: 235_394, workerZeroCacheCalls: 5, wallMs: 30_000,
    }),
    measuredReport: measured,
    prime: { brain: 'claude', scenario: 'long-horizon-manifest' },
  });
  assert.equal(comparison.eligible, false);
  assert.equal(comparison.tokenDelta, null);
  assert.ok(comparison.reasons.includes('measured:usage_call_count_mismatch'));
  assert.ok(comparison.reasons.includes('measured:usage_token_identity_mismatch'));
  assert.ok(comparison.reasons.includes('measured:usage_row_total_mismatch'));
});

test('sample labels are protocol identity, not timestamp-based cold/warm inference', () => {
  const wrongLabels = compareProofBenchmarkReports({
    primeReport: report({
      sample: 'measured', workerCacheReads: 309_312, workerZeroCacheCalls: 0, wallMs: 30_000,
    }),
    measuredReport: report({
      sample: 'prime', workerCacheReads: 235_394, workerZeroCacheCalls: 5, wallMs: 40_000,
    }),
    prime: { brain: 'claude', scenario: 'long-horizon-manifest' },
  });
  assert.equal(wrongLabels.eligible, false);
  assert.ok(wrongLabels.reasons.includes('prime:sample_must_be_prime'));
  assert.ok(wrongLabels.reasons.includes('measured:sample_must_be_measured'));
});

test('legacy reports remain readable but are comparison-ineligible', () => {
  const legacy = report({
    sample: 'prime', workerCacheReads: 235_394, workerZeroCacheCalls: 5, wallMs: 30_000,
  });
  delete legacy.benchmark;
  delete legacy.sourceFingerprintEnd;
  delete legacy.sourceStable;
  const comparison = compareProofBenchmarkReports({
    primeReport: legacy,
    measuredReport: report({
      sample: 'measured', workerCacheReads: 309_312, workerZeroCacheCalls: 0, wallMs: 30_000,
    }),
    prime: { brain: 'claude', scenario: 'long-horizon-manifest' },
  });
  assert.equal(comparison.eligible, false);
  assert.equal(comparison.tokenDelta, null);
  assert.ok(comparison.reasons.includes('prime:benchmark_metadata_missing'));
  assert.ok(comparison.reasons.includes('prime:source_stability_unproven'));
});
