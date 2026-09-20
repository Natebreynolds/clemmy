/**
 * The live work-checklist fold.
 *
 * NOTE: inert in production today. `work_manifest_declared` and
 * `work_item_checkpoint` are not cased in `projectData`
 * (src/runtime/harness/public-presentation.ts), a fail-closed allowlist, so
 * they never reach a client. These tests pin the behavior so the fold is
 * correct the day the server admits them; AWAITING_PROJECTION in
 * reduce-lifecycle.ts tracks that, and event-coverage.test.ts enforces it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity } from './reduce-activity.js';
import type { ActivityItem, HarnessEvent } from './types.js';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>): HarnessEvent => ({ seq: ++seq, type, data });

const declare = (items: number, extra: Record<string, unknown> = {}) => ev('work_manifest_declared', {
  manifestId: 'm1',
  contractVersion: '1',
  items: Array.from({ length: items }, (_, i) => ({ id: `i${i + 1}` })),
  phases: [{ id: 'research' }],
  ...extra,
});

const checkpoint = (itemId: string, status: string, phase = 'research') =>
  ev('work_item_checkpoint', { manifestId: 'm1', contractVersion: '1', phase, itemId, status });

function fold(events: HarnessEvent[]): ActivityItem[] {
  return events.reduce<ActivityItem[]>((acc, e) => reduceActivity(acc, e), []);
}

test('a declared manifest becomes one metered row with the objective as its label', () => {
  const [row] = fold([declare(100, { objective: 'Find 100 market-leader accounts' })]);
  assert.equal(row.kind, 'batch');
  assert.equal(row.label, 'Find 100 market-leader accounts');
  assert.deepEqual(row.batch, { done: 0, total: 100, failed: 0 });
  assert.equal(row.status, 'running');
});

test('checkpoints advance the meter and name the current phase', () => {
  const [row] = fold([
    declare(3),
    checkpoint('i1', 'succeeded'),
    checkpoint('i2', 'running', 'verify'),
  ]);
  assert.deepEqual(row.batch, { done: 1, total: 3, failed: 0 });
  assert.equal(row.detail, 'verify');
  assert.equal(row.status, 'running');
});

test('a retried item is counted once, not twice', () => {
  // running → failed → running → succeeded is one item, however many
  // checkpoints it takes. A naive increment reported 4/3 here.
  const [row] = fold([
    declare(3),
    checkpoint('i1', 'running'),
    checkpoint('i1', 'failed'),
    checkpoint('i1', 'running'),
    checkpoint('i1', 'succeeded'),
  ]);
  assert.deepEqual(row.batch, { done: 1, total: 3, failed: 0 });
});

test('the row settles only when every declared item is accounted for', () => {
  const partial = fold([declare(2), checkpoint('i1', 'succeeded')]);
  assert.equal(partial[0].status, 'running');
  const all = fold([declare(2), checkpoint('i1', 'succeeded'), checkpoint('i2', 'succeeded')]);
  assert.equal(all[0].status, 'done');
});

test('any failed item settles the row as failed', () => {
  const [row] = fold([declare(2), checkpoint('i1', 'succeeded'), checkpoint('i2', 'failed')]);
  assert.equal(row.status, 'failed');
  assert.deepEqual(row.batch, { done: 1, total: 2, failed: 1 });
});

test('extending a live manifest keeps the work already proved', () => {
  const [row] = fold([
    declare(2),
    checkpoint('i1', 'succeeded'),
    declare(5, { mode: 'extend' }),
  ]);
  assert.deepEqual(row.batch, { done: 1, total: 5, failed: 0 });
});

test('a checkpoint with no declaration invents no meter', () => {
  // Without the declaration there is no denominator; drawing "1/1" would be a
  // completeness claim the harness never made.
  assert.deepEqual(fold([checkpoint('i1', 'succeeded')]), []);
});

test('a malformed declaration is ignored rather than drawn empty', () => {
  assert.deepEqual(fold([ev('work_manifest_declared', { manifestId: 'm1', items: [] })]), []);
  assert.deepEqual(fold([ev('work_manifest_declared', { items: [{ id: 'i1' }] })]), []);
});
