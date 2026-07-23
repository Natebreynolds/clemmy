/**
 * Adaptive route policy — job + bounded hot-path read.
 *
 * Pins the safety contract: with no evidence (empty table) or the kill-switch
 * off, resolution is byte-identical to static behavior; the policy only ever
 * overrides a MEASURED default it beats by a real margin, never routes below
 * the floor or on thin samples, and never picks a model the live validator
 * rejects.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-route-policy-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const {
  runRoutePolicyJob,
  pickRoutePolicyModel,
  clearRoutePolicyCache,
  routePolicyMinSamples,
  routePolicyEnabled,
  routePolicyThompsonEnabled,
  setRoutePolicySamplerForTest,
  sampleBeta,
} = await import('./route-policy.js');
const {
  recordModelRouteDecision,
  recordModelRouteOutcome,
  resetModelRouteMetricsForTest,
  openModelRouteMetricsDb,
} = await import('../model-route-metrics.js');

const NOW = new Date('2026-07-01T12:00:00.000Z');
const acceptAll = () => true;

/** Seed N outcomes for a (role, intent, model) with the given success rate. */
function seed(opts: {
  role: 'brain' | 'worker' | 'judge';
  intent?: string;
  model: string;
  n: number;
  successRate: number;
  latencyMs?: number;
}): void {
  for (let i = 0; i < opts.n; i++) {
    const id = recordModelRouteDecision({
      role: opts.role,
      intent: opts.intent,
      resolvedModel: opts.model,
      provider: 'claude',
      source: 'default',
      now: NOW,
    });
    recordModelRouteOutcome({
      decisionId: id,
      status: i < Math.round(opts.n * opts.successRate) ? 'success' : 'failed',
      latencyMs: opts.latencyMs ?? 2_000,
      toolSuccess: i < Math.round(opts.n * opts.successRate),
      objectiveMet: i < Math.round(opts.n * opts.successRate),
      now: NOW,
    });
  }
}

beforeEach(() => {
  resetModelRouteMetricsForTest();
  clearRoutePolicyCache();
  process.env.CLEMMY_ROUTE_POLICY = 'on';
  // The greedy-branch characterization below is pinned with Thompson off;
  // the Thompson block re-enables it per test with a deterministic sampler.
  process.env.CLEMMY_ROUTE_POLICY_THOMPSON = 'off';
});

after(() => {
  resetModelRouteMetricsForTest();
  delete process.env.CLEMMY_ROUTE_POLICY;
  delete process.env.CLEMMY_ROUTE_POLICY_THOMPSON;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('adaptive routing is opt-in: default off, explicit on', () => {
  delete process.env.CLEMMY_ROUTE_POLICY;
  assert.equal(routePolicyEnabled(), false);
  process.env.CLEMMY_ROUTE_POLICY = 'on';
  assert.equal(routePolicyEnabled(), true);
});

test('job: groups outcomes, scores them, marks thin/weak candidates disabled', () => {
  seed({ role: 'worker', model: 'model-strong', n: 12, successRate: 1 });
  seed({ role: 'worker', model: 'model-weak', n: 12, successRate: 0.25 });
  seed({ role: 'worker', model: 'model-thin', n: 3, successRate: 1 });

  const result = runRoutePolicyJob({ now: NOW });
  assert.ok(result, 'job ran');
  assert.equal(result!.rowsWritten, 3);
  assert.equal(result!.policyVersion, 1);

  const rows = openModelRouteMetricsDb()
    .prepare(`SELECT model, score, sample_count, disabled_reason FROM model_route_policy ORDER BY score DESC`)
    .all() as Array<{ model: string; score: number; sample_count: number; disabled_reason: string | null }>;
  const byModel = new Map(rows.map((r) => [r.model, r]));
  assert.equal(byModel.get('model-strong')!.disabled_reason, null);
  assert.equal(byModel.get('model-weak')!.disabled_reason, 'below_floor');
  assert.equal(byModel.get('model-thin')!.disabled_reason, 'insufficient_samples');
  assert.ok(byModel.get('model-strong')!.score > byModel.get('model-weak')!.score);
});

test('job: reruns bump the policy version and fully rebuild', () => {
  seed({ role: 'worker', model: 'm1', n: 10, successRate: 1 });
  assert.equal(runRoutePolicyJob({ now: NOW })!.policyVersion, 1);
  assert.equal(runRoutePolicyJob({ now: NOW })!.policyVersion, 2);
  const count = (openModelRouteMetricsDb().prepare(`SELECT COUNT(*) AS c FROM model_route_policy`).get() as { c: number }).c;
  assert.equal(count, 1, 'rebuild, not append');
});

test('pick: empty table ⇒ null (byte-identical static behavior)', () => {
  runRoutePolicyJob({ now: NOW });
  assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null);
});

test('pick: kill-switch off ⇒ null even with a winning candidate', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.6 });
  seed({ role: 'worker', model: 'better-model', n: 12, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  process.env.CLEMMY_ROUTE_POLICY = 'off';
  assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null);
});

test('pick: an UNMEASURED default is never switched away from', () => {
  seed({ role: 'worker', model: 'better-model', n: 20, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  // default-model has no rows at all → no anchor → no switch.
  assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null);
});

test('pick: candidate must beat the measured default by the hysteresis margin', () => {
  // Both healthy; the gap is real (0.6 vs 1.0 success) → switch fires.
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.6 });
  seed({ role: 'worker', model: 'better-model', n: 12, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  const pick = pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll);
  assert.ok(pick, 'clear winner picked');
  assert.equal(pick!.modelId, 'better-model');
  assert.ok(pick!.score > pick!.defaultScore);

  // Near-tie (0.95 vs 1.0) → inside the margin → no flip-flop.
  resetModelRouteMetricsForTest();
  clearRoutePolicyCache();
  seed({ role: 'worker', model: 'default-model', n: 20, successRate: 0.95 });
  seed({ role: 'worker', model: 'better-model', n: 20, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null);
});

test('pick: disabled and thin candidates never win; validator rejection skips', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'worker', model: 'weak-model', n: 12, successRate: 0.3 });   // below floor
  seed({ role: 'worker', model: 'thin-model', n: 3, successRate: 1 });      // insufficient samples
  seed({ role: 'worker', model: 'gone-model', n: 12, successRate: 1 });     // validator rejects
  runRoutePolicyJob({ now: NOW });
  const pick = pickRoutePolicyModel('worker', undefined, 'default-model', (m) => m !== 'gone-model');
  assert.equal(pick, null, 'no guard-passing candidate ⇒ static default');
});

test('pick: intent scope wins over role-wide scope; scopes never mix anchors', () => {
  // Role-wide: default is fine. Design intent: default measured weak, alt strong.
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 1 });
  seed({ role: 'worker', intent: 'design', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'worker', intent: 'design', model: 'design-model', n: 12, successRate: 1 });
  runRoutePolicyJob({ now: NOW });

  const designPick = pickRoutePolicyModel('worker', 'design', 'default-model', acceptAll);
  assert.ok(designPick, 'intent-scoped winner found');
  assert.equal(designPick!.modelId, 'design-model');

  const plainPick = pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll);
  assert.equal(plainPick, null, 'role-wide default is healthy — no switch');
});

test('pick: sampleCount from the winning row rides out for the routing trace', () => {
  seed({ role: 'judge', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'judge', model: 'sharp-judge', n: 15, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  const pick = pickRoutePolicyModel('judge', undefined, 'default-model', acceptAll);
  assert.ok(pick);
  assert.equal(pick!.sampleCount, 15);
  assert.ok(pick!.sampleCount >= routePolicyMinSamples());
  assert.equal(pick!.policyVersion, 1);
});

test('weightsForSamples: absent signals redistribute onto success; present signals score unchanged', async () => {
  const { weightsForSamples } = await import('./route-policy.js');
  const { DEFAULT_ROUTE_SCORE_WEIGHTS } = await import('../model-route-metrics.js');
  const rich = weightsForSamples([{ status: 'success', objectiveMet: true, toolSuccess: true }]);
  assert.deepEqual(rich, DEFAULT_ROUTE_SCORE_WEIGHTS, 'signal-rich groups keep canonical weights');
  const poor = weightsForSamples([{ status: 'success' }, { status: 'failed' }]);
  assert.equal(poor.objective, 0);
  assert.equal(poor.toolSuccess, 0);
  assert.ok(Math.abs(poor.success - (DEFAULT_ROUTE_SCORE_WEIGHTS.success + DEFAULT_ROUTE_SCORE_WEIGHTS.objective + DEFAULT_ROUTE_SCORE_WEIGHTS.toolSuccess)) < 1e-9,
    'missing positive weight lands on success — success-only evidence can clear the floor');
  // Mixed: any sample carrying the signal keeps its weight.
  const mixed = weightsForSamples([{ status: 'success', toolSuccess: true }, { status: 'success' }]);
  assert.equal(mixed.toolSuccess, DEFAULT_ROUTE_SCORE_WEIGHTS.toolSuccess);
});

// ─── Thompson pick (CLEMMY_ROUTE_POLICY_THOMPSON, default on) ──────────────

/** Deterministic posterior: the Beta mean α/(α+β). */
const meanSampler = (a: number, b: number): number => a / (a + b);

function withThompson(sampler: (a: number, b: number) => number, fn: () => void): void {
  process.env.CLEMMY_ROUTE_POLICY_THOMPSON = 'on';
  setRoutePolicySamplerForTest(sampler);
  try {
    fn();
  } finally {
    setRoutePolicySamplerForTest(null);
    process.env.CLEMMY_ROUTE_POLICY_THOMPSON = 'off';
  }
}

test('thompson: kill-switch defaults ON; off restores the greedy branch', () => {
  delete process.env.CLEMMY_ROUTE_POLICY_THOMPSON;
  assert.equal(routePolicyThompsonEnabled(), true, 'validated behavior is the default');
  process.env.CLEMMY_ROUTE_POLICY_THOMPSON = 'off';
  assert.equal(routePolicyThompsonEnabled(), false);
});

test('thompson: clear winner picked deterministically under the mean sampler', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'worker', model: 'better-model', n: 12, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  withThompson(meanSampler, () => {
    const pick = pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll);
    assert.ok(pick);
    assert.equal(pick!.modelId, 'better-model');
    assert.equal(pick!.sampleCount, 12);
    assert.ok(pick!.score > pick!.defaultScore);
  });
});

test('thompson: a near-tie the greedy margin refused is now explorable', () => {
  // Same seeding as the greedy near-tie test above, which pins null.
  seed({ role: 'worker', model: 'default-model', n: 20, successRate: 0.95 });
  seed({ role: 'worker', model: 'better-model', n: 20, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  withThompson(meanSampler, () => {
    const pick = pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll);
    assert.ok(pick, 'posterior mean 21/22 beats 20/22 — no hysteresis wall');
    assert.equal(pick!.modelId, 'better-model');
  });
});

test('thompson: an under-sampled candidate stays eligible (wide posterior IS the exploration)', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'worker', model: 'thin-model', n: 3, successRate: 1 }); // disabled: insufficient_samples
  runRoutePolicyJob({ now: NOW });
  withThompson(meanSampler, () => {
    const pick = pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll);
    assert.ok(pick, 'Beta(4,1) mean 0.8 beats the default posterior 0.5');
    assert.equal(pick!.modelId, 'thin-model');
  });
});

test('thompson: a MEASURED below-floor candidate is excluded before any draw', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'worker', model: 'weak-model', n: 12, successRate: 0.25 }); // measured, below floor
  runRoutePolicyJob({ now: NOW });
  // First draw is the default's: give it 0 so ANY sampled candidate would win.
  let calls = 0;
  withThompson(() => (calls++ === 0 ? 0 : 1), () => {
    assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null,
      'weak-model never entered the draw — the floor is a hard exclusion');
  });
});

test('thompson: validator rejection excludes a candidate before any draw', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'worker', model: 'gone-model', n: 12, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  let calls = 0;
  withThompson(() => (calls++ === 0 ? 0 : 1), () => {
    assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', (m) => m !== 'gone-model'), null);
  });
});

test('thompson: the draw is memoized for the cache window (no mid-turn flips)', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'worker', model: 'better-model', n: 12, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  let draws = 0;
  withThompson((a, b) => { draws++; return a / (a + b); }, () => {
    const first = pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll);
    const drawsAfterFirst = draws;
    const second = pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll);
    assert.deepEqual(second, first, 'same pick within the window');
    assert.equal(draws, drawsAfterFirst, 'no fresh draws — the memo answered');
  });
});

test('thompson: fallback outcomes count against the posterior', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.5 }); // posterior mean 7/14 = 0.5
  seed({ role: 'worker', model: 'flaky-model', n: 12, successRate: 1 });
  for (let i = 0; i < 12; i++) {
    const id = recordModelRouteDecision({ role: 'worker', resolvedModel: 'flaky-model', provider: 'claude', source: 'default', now: NOW });
    recordModelRouteOutcome({ decisionId: id, status: 'fallback', latencyMs: 2_000, now: NOW });
  }
  runRoutePolicyJob({ now: NOW });
  withThompson(meanSampler, () => {
    // 12 successes / 24 samples ⇒ posterior mean 13/26 = 0.5 — ties the
    // default, and ties go to the default.
    assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null);
  });
});

test('thompson: a denied model never enters the draw (id and prefix)', () => {
  seed({ role: 'worker', model: 'default-model', n: 12, successRate: 0.5 });
  seed({ role: 'worker', model: 'pricey-model', n: 12, successRate: 1 });
  runRoutePolicyJob({ now: NOW });
  for (const deny of ['pricey-model', 'pricey']) {
    process.env.CLEMMY_ROUTE_POLICY_DENY = deny;
    clearRoutePolicyCache();
    withThompson(meanSampler, () => {
      assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null, `deny=${deny}`);
    });
  }
  delete process.env.CLEMMY_ROUTE_POLICY_DENY;
});

test('thompson: cost guard — the bandit never routes UP in measured cost', () => {
  const seedWithCost = (model: string, n: number, successRate: number, costUsd: number): void => {
    for (let i = 0; i < n; i++) {
      const id = recordModelRouteDecision({ role: 'worker', resolvedModel: model, provider: 'claude', source: 'default', now: NOW });
      recordModelRouteOutcome({ decisionId: id, status: i < Math.round(n * successRate) ? 'success' : 'failed', latencyMs: 2_000, costUsd, now: NOW });
    }
  };
  // Pricier winner: excluded despite a perfect record.
  seedWithCost('default-model', 12, 0.5, 0.02);
  seedWithCost('premium-model', 12, 1, 0.1);
  runRoutePolicyJob({ now: NOW });
  withThompson(meanSampler, () => {
    assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null, '5× the cost is not the bandit\'s call');
  });

  // Unmeasured candidate cost is NOT a free pass when the default's is measured.
  resetModelRouteMetricsForTest();
  clearRoutePolicyCache();
  seedWithCost('default-model', 12, 0.5, 0.02);
  seed({ role: 'worker', model: 'mystery-model', n: 12, successRate: 1 }); // no cost evidence
  runRoutePolicyJob({ now: NOW });
  withThompson(meanSampler, () => {
    assert.equal(pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll), null);
  });

  // Same-or-cheaper cost within tolerance: the switch is allowed.
  resetModelRouteMetricsForTest();
  clearRoutePolicyCache();
  seedWithCost('default-model', 12, 0.5, 0.02);
  seedWithCost('frugal-model', 12, 1, 0.02);
  runRoutePolicyJob({ now: NOW });
  withThompson(meanSampler, () => {
    const pick = pickRoutePolicyModel('worker', undefined, 'default-model', acceptAll);
    assert.ok(pick);
    assert.equal(pick!.modelId, 'frugal-model');
  });
});

test('sampleBeta: deterministic under a seeded rng and statistically sane', () => {
  // mulberry32 — tiny seeded PRNG, good enough for a distribution sanity check.
  const mulberry32 = (s: number) => () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = sampleBeta(13, 2, mulberry32(42));
  const b = sampleBeta(13, 2, mulberry32(42));
  assert.equal(a, b, 'same seed ⇒ same draw');
  assert.ok(a > 0 && a < 1);

  const rng = mulberry32(7);
  let sum = 0;
  const N = 2_000;
  for (let i = 0; i < N; i++) sum += sampleBeta(13, 2, rng);
  const mean = sum / N;
  assert.ok(Math.abs(mean - 13 / 15) < 0.03, `empirical mean ${mean} ≈ 13/15`);
});
