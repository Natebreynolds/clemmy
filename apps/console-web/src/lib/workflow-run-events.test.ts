import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunEvents } from './workflow-run-events.js';

test('fresh rows append, the cursor follows the newest, and the buffer stays bounded', () => {
  const a = mergeRunEvents([], [{ t: '2026-09-08T01:00:00Z', kind: 'run_started' }]);
  assert.equal(a.events.length, 1);
  assert.equal(a.since, '2026-09-08T01:00:00Z');
  const b = mergeRunEvents(a.events, []);
  assert.equal(b.events, a.events, 'no fresh rows leaves the array untouched');
  assert.equal(b.since, a.since);
  const many = Array.from({ length: 700 }, (_, i) => ({ t: `t${i}`, kind: 'tool_called' }));
  const c = mergeRunEvents(a.events, many);
  assert.equal(c.events.length, 600);
  assert.equal(c.events[c.events.length - 1].t, 't699');
});
