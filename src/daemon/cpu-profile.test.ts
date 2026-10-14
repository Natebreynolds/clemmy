import assert from 'node:assert/strict';
import test from 'node:test';
import { heaviestFunctions } from './cpu-profile.js';

test('self time is charged per sample interval to the function sampled, heaviest first, idle excluded', () => {
  const profile = {
    startTime: 0, endTime: 10_000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
      { id: 2, callFrame: { functionName: 'buildList', url: 'file:///app/sessions-api.js', lineNumber: 9 } },
      { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
      { id: 4, callFrame: { functionName: 'parse', url: 'file:///app/eventlog.js', lineNumber: 41 } },
    ],
    samples: [2, 2, 4, 3, 2],
    timeDeltas: [0, 1_000, 1_000, 2_000, 5_000],
  };
  assert.deepEqual(heaviestFunctions(profile), [
    { functionName: 'buildList', url: '/app/sessions-api.js', line: 10, selfMs: 2 },
    { functionName: 'parse', url: '/app/eventlog.js', line: 42, selfMs: 2 },
  ]);
});
