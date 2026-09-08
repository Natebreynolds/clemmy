import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity, type ActivityItem } from './useChat';
import { settleTerminalActivity } from './activity-presentation';
import type { HarnessEvent } from './types';

const event = (seq: number, type: string, callId = 'call-a'): HarnessEvent => ({
  seq, turn: 1, role: 'tool', type,
  data: { callId, toolName: 'OUTLOOK_CREATE_DRAFT', targets: ['person@example.test'],
    ...(type === 'external_write' ? { preDispatch: true } : {}) },
});
const replay = (events: HarnessEvent[]) => events.reduce(reduceActivity, [] as ActivityItem[]);

test('desktop reservation-only completion stays unknown, while a no-write turn has no write rows', () => {
  const rows = settleTerminalActivity(replay([event(1, 'external_write')]), 'completed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.write?.disposition, 'unknown');
  assert.equal(rows[0]?.status, 'interrupted');
  assert.notEqual(rows[0]?.tone, 'success');
  assert.deepEqual(settleTerminalActivity([], 'completed'), []);
});

test('desktop success/failure replay pairs exact calls and cannot settle an unrelated reservation', () => {
  const events = [event(1, 'external_write', 'saved'), event(2, 'external_write', 'failed'),
    event(3, 'external_write_failed', 'failed'), event(4, 'external_write_succeeded', 'saved'),
    event(5, 'external_write', 'unresolved')];
  const rows = settleTerminalActivity(replay(events), 'completed');
  assert.deepEqual(rows.map(row => [row.write?.callId, row.write?.disposition, row.status]), [
    ['saved', 'confirmed', 'done'], ['failed', 'failed', 'failed'], ['unresolved', 'unknown', 'interrupted'],
  ]);
  assert.deepEqual(settleTerminalActivity(replay(events), 'completed'), rows, 'reopening the same retained event log preserves the ledger');
});

test('desktop late reservation or orphan observation does not downgrade a decisive terminal', () => {
  const rows = replay([event(1, 'external_write_succeeded'), event(2, 'external_write'), event(3, 'external_write_orphaned')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.write?.disposition, 'confirmed');
  assert.equal(rows[0]?.status, 'done');
  const failed = replay([event(1, 'external_write_failed'), event(2, 'external_write')]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.write?.disposition, 'failed');
});
