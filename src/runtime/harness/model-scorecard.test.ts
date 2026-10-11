/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/model-scorecard.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-model-scorecard-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state', 'token-usage'), { recursive: true });
const scorecard = await import('./model-scorecard.js');
const metrics = await import('../model-route-metrics.js');
const usage = await import('../usage-log.js');
test.after(() => { metrics.closeModelRouteMetricsDb(); rmSync(HOME, { recursive: true, force: true }); });

type Event = Parameters<typeof scorecard.tallyUsage>[0][number];
const call = (extra: Partial<Event>): Event => ({
  at: '2026-10-10T12:00:00.000Z', source: 's', kind: 'chat', model: 'model-a', role: 'brain',
  inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50, totalTokens: 1_050, cacheDialect: 'inclusive', durationMs: 2_000,
  ...extra,
} as Event);

test('usage tallies per role and model: failures by reason, certified tokens only, the router and unset roles left out', () => {
  const tallies = scorecard.tallyUsage([
    call({}),
    call({ durationMs: 4_000 }),
    call({ ok: false, failReason: 'timeout', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 60_000 }),
    call({ cacheDialect: undefined, durationMs: 1_000 }),
    call({ role: 'reviewer', model: 'model-c' }),
    call({ role: 'router', model: 'model-r' }),
    call({ role: undefined }),
  ]);
  assert.deepEqual([...tallies.keys()].map((k) => k.replace('\u0000', ' ')).sort(), ['brain model-a', 'judge model-c']);
  const brain = [...tallies.values()].find((t) => t.role === 'brain')!;
  assert.equal(brain.calls, 4);
  assert.equal(brain.failedCalls, 1);
  assert.deepEqual(brain.failureReasons, { timeout: 1 });
  assert.equal(brain.uncertifiedCalls, 2, 'an undeclared cache dialect, and a failure with no reported usage, count as calls, not tokens');
  assert.equal(brain.cachedReadTokens, 1_600);
  assert.deepEqual(brain.durations.sort((a, b) => a - b), [1_000, 2_000, 4_000], 'a failed call\'s wait is not its model\'s speed');
});

test('rows join usage with route evidence, with percentiles, cache rate and billed cost only when reported', () => {
  const usageTallies = scorecard.mergeTallies([
    scorecard.tallyUsage([call({ durationMs: 1_000 }), call({ durationMs: 2_000 })]),
    scorecard.tallyUsage([call({ durationMs: 3_000 }), call({ durationMs: 10_000 })]),
  ]);
  const card = scorecard.scorecardFromTallies({
    usage: usageTallies,
    routes: [
      { role: 'brain', modelId: 'model-a', reviewed: 4, passed: 3, toolTurns: 2, toolTurnsLanded: 2, fellOver: 1, stoodIn: 0, billedUsd: null },
      { role: 'judge', modelId: 'model-j', reviewed: 0, passed: 0, toolTurns: 0, toolTurnsLanded: 0, fellOver: 0, stoodIn: 0, billedUsd: 0.42 },
    ],
    days: 7,
    now: new Date('2026-10-10T12:00:00.000Z'),
  });
  assert.equal(card.window.from, '2026-10-03T12:00:00.000Z');
  const brain = card.rows.find((row) => row.role === 'brain')!;
  assert.equal(brain.calls, 4);
  assert.deepEqual(brain.latencyMs, { p50: 2_000, p95: 10_000 });
  assert.equal(brain.cacheHitRate, 0.8);
  assert.equal(brain.reviewed, 4);
  assert.equal(brain.passed, 3);
  assert.equal(brain.billedUsd, null);
  assert.equal(brain.certified, true);
  const judge = card.rows.find((row) => row.role === 'judge')!;
  assert.equal(judge.calls, 0, 'route evidence without usage still shows, with no invented calls');
  assert.equal(judge.latencyMs, null);
  assert.equal(judge.cacheHitRate, null);
  assert.equal(judge.billedUsd, 0.42);
});

test('an empty home has no rows; a live read joins the ledger files and the route metrics', async () => {
  scorecard._resetModelScorecardForTests();
  const now = new Date();
  const empty = await scorecard.readModelScorecard(7, now);
  assert.deepEqual(empty.rows, []);

  scorecard._resetModelScorecardForTests();
  const lines = [call({ at: now.toISOString() }), call({ at: now.toISOString(), role: 'memory' })].map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(usage.usageFileForDate(now), `${lines}\n`);
  writeFileSync(usage.usageFileForDate(new Date(now.getTime() - 3 * 86_400_000)), `${JSON.stringify(call({}))}\nnot json\n`);
  writeFileSync(usage.usageFileForDate(new Date(now.getTime() - 20 * 86_400_000)), `${JSON.stringify(call({}))}\n`);
  const decision = metrics.recordModelRouteDecision({ role: 'brain', resolvedModel: 'model-a', provider: 'claude', source: 'default', now });
  metrics.recordModelRouteOutcome({ decisionId: decision, status: 'success', objectiveMet: true, toolSuccess: true, now });
  const week = await scorecard.readModelScorecard(7, now);
  const brain = week.rows.find((row) => row.role === 'brain')!;
  assert.equal(brain.calls, 2, 'today and three days ago; a line that is not JSON is skipped');
  assert.equal(brain.reviewed, 1);
  assert.equal(brain.passed, 1);
  assert.ok(week.rows.some((row) => row.role === 'memory'));
  const month = await scorecard.readModelScorecard(30, now);
  assert.equal(month.rows.find((row) => row.role === 'brain')!.calls, 3);
  assert.equal(await scorecard.readModelScorecard(7, now), await scorecard.readModelScorecard(7, now), 'computed once a minute');
});
