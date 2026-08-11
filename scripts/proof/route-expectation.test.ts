import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedModelTurnsForRouteCheck,
  routeSessionsForRouteCheck,
  servedModelSessionIdsForOutcomes,
} from './route-expectation.js';

test('model-route expectation defaults to the scenario latency sample count', () => {
  assert.equal(expectedModelTurnsForRouteCheck({}, 4), 4);
});

test('model-route expectation honors a scenario override for deterministic fast paths', () => {
  assert.equal(expectedModelTurnsForRouteCheck({ expectedModelTurns: 2 }, 5), 2);
  assert.equal(expectedModelTurnsForRouteCheck({ expectedModelTurns: 0 }, 1), 0);
});

test('model-route expectation rejects invalid overrides instead of weakening proof', () => {
  assert.throws(
    () => expectedModelTurnsForRouteCheck({ expectedModelTurns: -1 }, 5),
    /non-negative safe integer/,
  );
  assert.throws(
    () => expectedModelTurnsForRouteCheck({ expectedModelTurns: 1.5 }, 5),
    /non-negative safe integer/,
  );
});

test('multi-session route expectations preserve every horizon leg', () => {
  assert.deepEqual(routeSessionsForRouteCheck(
    { expectedModelTurns: 3 },
    {
      sessionId: 'summary-session',
      latencySampleCount: 4,
      routeSessions: [
        { sessionId: 'cold-session', expectedModelTurns: 1 },
        { sessionId: 'learned-session', expectedModelTurns: 2 },
      ],
    },
  ), [
    { sessionId: 'cold-session', expectedModelTurns: 1 },
    { sessionId: 'learned-session', expectedModelTurns: 2 },
  ]);
});

test('multi-session route expectations reject omissions, duplicates, and total drift', () => {
  assert.throws(() => routeSessionsForRouteCheck(
    { expectedModelTurns: 3 },
    { latencySampleCount: 4, routeSessions: [{ sessionId: 'cold', expectedModelTurns: 1 }] },
  ), /does not match/);
  assert.throws(() => routeSessionsForRouteCheck(
    { expectedModelTurns: 2 },
    { latencySampleCount: 2, routeSessions: [
      { sessionId: 'same', expectedModelTurns: 1 },
      { sessionId: 'same', expectedModelTurns: 1 },
    ] },
  ), /repeats session/);
  assert.throws(() => routeSessionsForRouteCheck(
    {},
    { latencySampleCount: 0, routeSessions: [] },
  ), /cannot be empty/);
});

test('served-model evidence includes summary and every unique routed session', () => {
  assert.deepEqual(servedModelSessionIdsForOutcomes([
    {
      sessionId: 'learned-session',
      routeSessions: [
        { sessionId: 'cold-session', expectedModelTurns: 1 },
        { sessionId: 'learned-session', expectedModelTurns: 2 },
      ],
    },
    {
      sessionId: ' later-scenario ',
      routeSessions: [
        { sessionId: ' cold-session ', expectedModelTurns: 1 },
      ],
    },
    { sessionId: '   ' },
  ]), [
    'learned-session',
    'cold-session',
    'later-scenario',
  ]);
});
