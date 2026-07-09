import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity, type ActivityItem } from './useChat';
import type { HarnessEvent } from './types';

let seq = 0;
function ev(type: string, data: Record<string, unknown>): HarnessEvent {
  seq += 1;
  return { seq, turn: 0, role: 'Clem', type, data };
}

test('reduceActivity pairs overlapping same-name tool calls by callId when present', () => {
  let activity: ActivityItem[] = [];
  activity = reduceActivity(activity, ev('tool_called', { tool: 'read_file', callId: 'toolu_a' }));
  activity = reduceActivity(activity, ev('tool_called', { tool: 'read_file', callId: 'toolu_b' }));
  activity = reduceActivity(activity, ev('tool_returned', { tool: 'read_file', callId: 'toolu_a', ok: true }));

  assert.deepEqual(
    activity.map((a) => ({ id: a.id, label: a.label, status: a.status })),
    [
      { id: 't-toolu_a', label: 'read file', status: 'done' },
      { id: 't-toolu_b', label: 'read file', status: 'running' },
    ],
  );
});

test('reduceActivity falls back to label matching for legacy tool return events without callId', () => {
  let activity: ActivityItem[] = [];
  activity = reduceActivity(activity, ev('tool_called', { tool: 'read_file' }));
  activity = reduceActivity(activity, ev('tool_returned', { tool: 'read_file', ok: false }));

  assert.equal(activity[0].status, 'failed');
});

test('reduceActivity: run_batch renders as ONE live meter row; per-item batchMode tool events are suppressed', () => {
  let a: ActivityItem[] = [];
  a = reduceActivity(a, ev('batch_started', { batchId: 'b1', items: 18, slug: 'OUTLOOK_SEND_EMAIL', sideEffect: 'send' }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'batch');
  assert.match(a[0].label, /Sending 18 × outlook send email/);
  assert.deepEqual(a[0].batch, { done: 0, total: 18, failed: 0 });

  // Per-item plumbing events must NOT add rows.
  a = reduceActivity(a, ev('tool_called', { tool: 'composio_execute_tool', callId: 'c1', batchMode: true, args: '{}' }));
  a = reduceActivity(a, ev('tool_returned', { tool: 'composio_execute_tool', callId: 'c1', batchMode: true, ok: true }));
  assert.equal(a.length, 1, 'batch item events must not create tool rows');

  a = reduceActivity(a, ev('batch_progress', { batchId: 'b1', done: 12, total: 18, failed: 1, itemId: 'lowryinc.com', ok: true }));
  assert.deepEqual(a[0].batch, { done: 12, total: 18, failed: 1 });
  assert.equal(a[0].detail, 'lowryinc.com');

  a = reduceActivity(a, ev('batch_completed', { batchId: 'b1', total: 18, succeeded: 17, failed: 1, halted: false }));
  assert.equal(a[0].status, 'failed', 'any failed item surfaces as a failed batch row');
  assert.equal(a[0].batch?.failed, 1);
});

test('reduceActivity: a throttled batch_progress flips the meter into backing-off; a normal update clears it', () => {
  let a: ActivityItem[] = [];
  a = reduceActivity(a, ev('batch_started', { batchId: 'b2', items: 10, slug: 'GMAIL_SEND_EMAIL', sideEffect: 'send' }));
  a = reduceActivity(a, ev('batch_progress', { batchId: 'b2', done: 4, total: 10, failed: 0, itemId: 'a@x.com', ok: true }));
  assert.equal(a[0].batch?.throttled, undefined, 'a normal update has no throttled flag');

  // Rate-limit back-off pause: counts unchanged, throttled flips on.
  a = reduceActivity(a, ev('batch_progress', { batchId: 'b2', done: 4, total: 10, failed: 0, throttled: true, backoffMs: 2000, backoffCount: 1, ok: true }));
  assert.deepEqual(a[0].batch, { done: 4, total: 10, failed: 0, throttled: true });

  // The next real item update clears the throttled flag.
  a = reduceActivity(a, ev('batch_progress', { batchId: 'b2', done: 5, total: 10, failed: 0, itemId: 'b@x.com', ok: true }));
  assert.deepEqual(a[0].batch, { done: 5, total: 10, failed: 0 });
});

test('reduceActivity: tool rows carry the salient target and a composio call reads as its slug', () => {
  let a: ActivityItem[] = [];
  a = reduceActivity(a, ev('tool_called', {
    tool: 'composio_execute_tool',
    callId: 'c9',
    args: JSON.stringify({ tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to: 'paul@lowryinc.com', subject: 'Hi' }) }),
  }));
  assert.equal(a[0].label, 'outlook send email', 'composio calls read as their inner slug');
  assert.equal(a[0].detail, 'paul@lowryinc.com', 'the salient target is narrated');
  assert.ok(typeof a[0].startedAt === 'number');

  a = reduceActivity(a, ev('tool_called', { tool: 'dataforseo__serp_organic_live_advanced', callId: 'c10', args: JSON.stringify({ keyword: 'executive coaching' }) }));
  assert.equal(a[1].label, 'dataforseo · serp organic live advanced', 'server__tool renders as server · tool');
  assert.equal(a[1].detail, 'executive coaching');
});

// ─── Trust cockpit: verdict + watcher rows in the activity strip ─────────────

test('reduceActivity: verdict_recorded appends a check row with door, scorecard, and pass tone', () => {
  let a = reduceActivity([], ev('verdict_recorded', { door: 'goal_validation', pass: false, reason: 'criterion 2 unmet', criteriaMet: 1, criteriaTotal: 2 }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'check');
  assert.match(a[0].label, /goal validation 1\/2: not passed/);
  assert.equal(a[0].detail, 'criterion 2 unmet');
  assert.equal(a[0].status, 'failed');

  a = reduceActivity(a, ev('verdict_recorded', { door: 'completion', pass: true, failedOpen: true }));
  assert.match(a[1].label, /accepted \(judge unavailable\)/);
  assert.equal(a[1].status, 'failed', 'failed-open acceptance renders as attention, not a clean tick');

  a = reduceActivity(a, ev('verdict_recorded', { door: 'delivery', pass: true, reason: 'artifact delivered' }));
  assert.equal(a[2].status, 'done');
});

test('reduceActivity: watcher_steer heartbeat appends a check row; other heartbeats stay invisible', () => {
  let a = reduceActivity([], ev('heartbeat', { kind: 'progress_check_in', message: 'still going' }));
  assert.equal(a.length, 0, 'generic heartbeats never clutter the strip');
  a = reduceActivity(a, ev('heartbeat', { kind: 'watcher_steer', miss: 'criterion untouched', steer: 'address it before drafting' }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'check');
  assert.equal(a[0].label, 'Watcher steered');
  assert.equal(a[0].detail, 'criterion untouched → address it before drafting');
});
