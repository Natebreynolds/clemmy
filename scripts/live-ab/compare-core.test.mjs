/**
 * Run: node --test scripts/live-ab/compare-core.test.mjs
 *
 * The comparison judges whole observations: no composite "best" pass, every
 * failing pass counted, a failing baseline never excuses a failing candidate,
 * and timing judged only between quiet passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns, compareTest, observationFrom, summarize } from './compare-core.mjs';

const obs = (over) => ({
  id: 't', pass: 1, terminal: 'done', assertionsPassed: true, failures: [], rounds: 3, repairs: 0,
  promptTokens: 30_000, uncachedInputTokens: 10_000, outputTokens: 500, wallMs: 10_000, modelWorkMs: 8_000,
  usage: { certified: true, uncertifiedCalls: 0, invalidCalls: 0 }, contended: false, reply: 'ok', ...over,
});

test('no synthetic best: a pass that is fast but fails does not lend its speed to one that passes', () => {
  const a = [obs({ pass: 1 }), obs({ pass: 2 })];
  const b = [
    obs({ pass: 1, wallMs: 4_000, promptTokens: 10_000, assertionsPassed: false, failures: ['reply missing "24"'] }),
    obs({ pass: 2, wallMs: 40_000, promptTokens: 90_000 }),
  ];
  const r = compareTest(a, b);
  assert.equal(r.verdict, 'regression');
  assert.ok(r.reasons.some((x) => x.startsWith('B failed 1/2')));
  assert.equal(r.b.promptTokens.median, 50_000, 'the median of the real passes, not the minimum');
});

test('an intermittent failure is counted, and both sides failing is unresolved, not a match', () => {
  const failing = obs({ assertionsPassed: false, failures: ['argument repairs: 1 exceeds 0'], repairs: 1 });
  assert.equal(compareTest([failing], [failing]).verdict, 'unresolved');
  const r = compareTest([obs({ pass: 1 }), obs({ pass: 2 })], [obs({ pass: 1 }), obs({ pass: 2, terminal: 'blocked' })]);
  assert.equal(r.verdict, 'regression');
  assert.ok(r.reasons.some((x) => x.includes('terminal blocked')));
});

test('timing is judged only between quiet passes; contention is reported, not scored', () => {
  const slowButBusy = obs({ wallMs: 60_000, contended: true });
  const r = compareTest([obs({})], [slowButBusy]);
  assert.equal(r.verdict, 'ok');
  assert.ok(r.notes.includes('timing not judged: no quiet pass on one side'));
  assert.equal(compareTest([obs({})], [obs({ wallMs: 60_000 })]).verdict, 'regression');
});

test('unknown usage stays unknown, never zero', () => {
  const s = summarize([obs({ usage: { certified: null, uncertifiedCalls: null, invalidCalls: null } })]);
  assert.equal(s.usageComplete, false);
  assert.equal(s.usageUnknown, true);
});

test('observations read the receipt: its reply, its own assertions, certified usage; missing liveness is contended', () => {
  const receipt = { turns: [{
    modelRequests: 5,
    assertions: { passed: false, failures: ['argument repairs: 1 exceeds 0'] },
    terminal: { reply: 'Done — fixture note B5', turnOutcome: { status: 'done' } },
    measurement: { turnWallMs: 13_629, sdkDurationMs: 12_001, promptTokens: 40_000, usageAttributionCertified: true, uncertifiedUsageCalls: 0, invalidUsageCalls: 0 },
  }] };
  const o = observationFrom({ id: 'file-write-read', pass: 1, repairs: 0, otherFailures: [], busyAtStart: [] }, receipt);
  assert.equal(o.reply, 'Done — fixture note B5');
  assert.equal(o.assertionsPassed, false);
  assert.equal(o.repairs, 1);
  assert.equal(o.modelWorkMs, 12_001);
  assert.equal(o.contended, true, 'a row with no liveness reading is not assumed quiet, even with an empty busy list');
  assert.equal(observationFrom({ id: 'x', pass: 1, liveness: 'fresh', busyAtStart: [], busyAtEnd: [] }, receipt).contended, false);
});

test('a run qualifies only with no regression and nothing unresolved or missing', () => {
  const base = [obs({ id: 'x' }), obs({ id: 'y' })];
  assert.equal(compareRuns(base, base).verdict, 'NO REGRESSION');
  assert.equal(compareRuns(base, [obs({ id: 'x' })]).verdict, 'NOT QUALIFIED');
});
