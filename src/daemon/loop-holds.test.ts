import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeLoopHold } from './loop-holds.js';

test('a hold is split among the phases that took the thread inside it, the start owner first', () => {
  const points = [
    { at: 100, name: 'daemon.loop.sleep' },
    { at: 1_000, name: 'daemon.http', detail: 'GET /api/console/sessions' },
    { at: 3_000, name: 'daemon.loop.sleep' },
    { at: 3_100, name: 'daemon.timer.workflow_runs.closed_batches' },
  ];
  assert.deepEqual(attributeLoopHold(points, 1_200, 3_600), [
    { name: 'daemon.http', detail: 'GET /api/console/sessions', ms: 1_800 },
    { name: 'daemon.timer.workflow_runs.closed_batches', ms: 500 },
    { name: 'daemon.loop.sleep', ms: 100 },
  ]);
});

test('a hold with no known point before it is unattributed, and an empty stretch has no segments', () => {
  assert.deepEqual(attributeLoopHold([], 0, 900), [{ name: 'unattributed', ms: 900 }]);
  assert.deepEqual(attributeLoopHold([{ at: 10, name: 'x' }], 500, 500), []);
});
