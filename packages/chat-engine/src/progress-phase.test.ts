import assert from 'node:assert/strict';
import test from 'node:test';
import {
  liveActivityHeadline,
  narrateActivity,
} from './activity-presentation.js';
import {
  MODEL_PHASE_ACTIVITY_ID,
  reduceActivity,
} from './reduce-activity.js';
import type { ActivityItem, HarnessEvent } from './types.js';

function event(seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent {
  return { seq, type, data };
}

function headline(items: readonly ActivityItem[]): string {
  return liveActivityHeadline(narrateActivity(items, { live: true }));
}

test('live phase advances from route through recall, discovery, rescue, heartbeat, and real work', () => {
  let tick = 10;
  const now = (): number => ++tick;
  let activity = reduceActivity([], event(1, 'turn_model_routed', {
    model: 'grok-4.6',
    provider: 'byo',
  }), now);
  assert.equal(headline(activity), 'Thinking with Grok 4.6…');

  activity = reduceActivity(activity, event(2, 'tool_called', {
    tool: 'memory_recall_all', callId: 'memory',
  }), now);
  assert.equal(headline(activity), 'memory recall all');

  // Discovery can run alongside recall, but recall remains the current honest
  // beat until it settles.
  activity = reduceActivity(activity, event(3, 'tool_called', {
    tool: 'tool_search', callId: 'search',
  }), now);
  assert.equal(headline(activity), 'memory recall all');

  activity = reduceActivity(activity, event(4, 'tool_returned', {
    tool: 'memory_recall_all', callId: 'memory', ok: true,
  }), now);
  assert.equal(headline(activity), 'Finding the right tool…');
  assert.notEqual(headline(activity), 'memory recall all',
    'a settled recall can never remain the live headline');

  activity = reduceActivity(activity, event(5, 'tool_returned', {
    tool: 'tool_search', callId: 'search', ok: true,
  }), now);
  assert.equal(headline(activity), 'Working on it…',
    'settled discovery stops claiming it is still finding a tool');

  activity = reduceActivity(activity, event(6, 'turn_model_routed', {
    model: 'gpt-5.6-sol', provider: 'codex', fallover: true,
  }), now);
  assert.equal(headline(activity), 'Switching to GPT 5.6 Sol…');

  activity = reduceActivity(activity, event(7, 'turn_model_routed', {
    model: 'claude-sonnet-5', provider: 'claude', fallover: true, preselected: true,
  }), now);
  assert.equal(headline(activity), 'Continuing with Claude Sonnet 5…');

  activity = reduceActivity(activity, event(8, 'heartbeat', {
    kind: 'active_turn_check_in', privateDetail: 'never shown',
  }), now);
  assert.equal(headline(activity), 'Still thinking with Claude Sonnet 5…');

  activity = reduceActivity(activity, event(9, 'tool_called', {
    tool: 'space_get', callId: 'space',
  }), now);
  assert.equal(headline(activity), 'space get');

  activity = reduceActivity(activity, event(10, 'heartbeat', {
    kind: 'active_turn_check_in',
  }), now);
  assert.equal(headline(activity), 'space get',
    'a heartbeat cannot mask concrete work that is still running');

  activity = reduceActivity(activity, event(11, 'tool_returned', {
    tool: 'space_get', callId: 'space', ok: true,
  }), now);
  assert.equal(headline(activity), 'Working on it…');

  const phaseRows = activity.filter((row) => row.id === MODEL_PHASE_ACTIVITY_ID);
  assert.equal(phaseRows.length, 1, 'one rolling model phase cannot grow per round');
  assert.ok((phaseRows[0]?.label.length ?? Infinity) <= 120);

  const settledReceipt = narrateActivity(activity, { live: false });
  assert.equal(settledReceipt.some((row) => row.id === MODEL_PHASE_ACTIVITY_ID), false,
    'model wait is not counted as a completed work step');
});

test('discovery presentation stays phase-honest when completed work is already visible', () => {
  const memory: ActivityItem = {
    id: 'memory', kind: 'tool', label: 'memory recall all', status: 'done', startedAt: 1,
  };
  const searching: ActivityItem = {
    id: 'search', kind: 'tool', label: 'tool_search', status: 'running', startedAt: 2,
  };
  const finding = narrateActivity([memory, searching], { live: true });
  assert.deepEqual(finding.map((row) => row.label), [
    'memory recall all',
    'Finding the right tool…',
  ]);
  assert.equal(liveActivityHeadline(finding), 'Finding the right tool…');

  const waiting = narrateActivity([
    memory,
    { ...searching, status: 'done' },
  ], { live: true });
  assert.deepEqual(waiting.map((row) => row.label), [
    'memory recall all',
    'Working on it…',
  ]);
  assert.equal(liveActivityHeadline(waiting), 'Working on it…');
});

test('live headline never falls back to a settled row', () => {
  const settled: ActivityItem[] = [{
    id: 'memory', kind: 'tool', label: 'memory recall all', status: 'done',
  }];
  assert.equal(liveActivityHeadline(settled), 'Working on it…');
});

test('model identity is bounded and invalid model text falls back to safe provider identity', () => {
  const activity = reduceActivity([], event(1, 'turn_model_routed', {
    model: 'secret@example.com/this-is-not-an-identifier',
    provider: 'codex',
  }), () => 1);
  assert.equal(headline(activity), 'Thinking with Codex…');
  assert.doesNotMatch(JSON.stringify(activity), /secret@example/);
});
