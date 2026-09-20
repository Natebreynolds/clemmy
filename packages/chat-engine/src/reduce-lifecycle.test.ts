import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAITING_PROJECTION, lifecycleActivityItem, reduceFeed } from './reduce-lifecycle.js';
import type { ActivityItem, HarnessEvent } from './types.js';

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}): HarnessEvent =>
  ({ seq: ++seq, type, data });

const fold = (events: HarnessEvent[]): ActivityItem[] =>
  events.reduce<ActivityItem[]>((acc, e) => reduceFeed(acc, e), []);

test('projected beats the activity fold ignores now get a row', () => {
  // Each of these is cased in projectData, so it genuinely arrives — and each
  // reached the client before and rendered nothing.
  const rows = fold([
    ev('plan_approved'),
    ev('plan_execution_claimed'),
    ev('user_steer_note'),
    ev('plan_rejected'),
  ]);
  assert.deepEqual(rows.map((r) => r.label), [
    'Plan approved',
    'Executing the plan',
    'You steered',
    'Plan rejected',
  ]);
  assert.deepEqual(rows.map((r) => r.variant), ['lifecycle', 'lifecycle', 'lifecycle', 'lifecycle']);
});

test('an event the activity fold claims never also emits a lifecycle row', () => {
  // The whole composition rests on this: reduceActivity returns `prev`
  // unchanged only when it did not claim the event.
  const rows = fold([ev('tool_called', { tool: 'read_file', callId: 'c1' })]);
  assert.equal(rows.length, 1, 'one row, not a tool row plus a lifecycle row');
  assert.equal(rows[0].kind, 'tool');
});

test('events the server never publishes produce nothing, and are not pretended otherwise', () => {
  // These carry real owner-meaningful truth but are not cased in projectData,
  // so they cannot arrive. Rendering them would be dead code that reads as a
  // feature; AWAITING_PROJECTION records the intent instead.
  for (const type of ['brain_fallover', 'memory_correction', 'condenser_applied', 'work_manifest_declared']) {
    assert.ok(type in AWAITING_PROJECTION, `${type} should be on the backlog`);
    assert.equal(lifecycleActivityItem(ev(type)), null, `${type} must not render today`);
  }
});

test('an unknown event type is ignored rather than guessed at', () => {
  assert.equal(lifecycleActivityItem(ev('some_future_event')), null);
  assert.deepEqual(fold([ev('some_future_event')]), []);
});

test('a lifecycle row carries the event’s own words, not its payload', () => {
  const row = lifecycleActivityItem(ev('plan_rejected', { summary: 'The scope was wider than you asked for.' }));
  assert.equal(row?.label, 'Plan rejected');
  assert.equal(row?.detail, 'The scope was wider than you asked for.');
});

test('a danger-toned beat settles as failed, everything else as done', () => {
  assert.equal(lifecycleActivityItem(ev('run_failed'))?.status, 'failed');
  assert.equal(lifecycleActivityItem(ev('plan_approved'))?.status, 'done');
});
