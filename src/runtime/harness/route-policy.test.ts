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
});

after(() => {
  resetModelRouteMetricsForTest();
  delete process.env.CLEMMY_ROUTE_POLICY;
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
