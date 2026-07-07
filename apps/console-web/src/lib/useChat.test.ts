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
