/**
 * Run: npx tsx --test apps/console-web/src/lib/activity-lanes.test.ts
 *
 * Pure reducer that folds the operational-telemetry stream into per-work lanes
 * for the dashboard NowStrip. These pin the folding rules: keying, worker
 * counts, open-tool tracking, badges, needs-you, terminal transitions, model
 * capture, and the running-first sort.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldOperationalEvent, lanesToSortedArray, workerRowsForDisplay, type ActivityLane } from './activity-lanes';
import type { OperationalEvent } from './telemetry';

let seq = 0;
function ev(partial: Partial<OperationalEvent> & { type: string }): OperationalEvent {
  seq += 1;
  return {
    eventId: `e${seq}`,
    ts: partial.ts ?? new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    source: partial.source ?? 'harness',
    type: partial.type as OperationalEvent['type'],
    severity: partial.severity ?? 'info',
    sessionId: partial.sessionId,
    workflowRunId: partial.workflowRunId,
    toolCallId: partial.toolCallId,
    payload: partial.payload ?? {},
  } as OperationalEvent;
}

function fold(events: OperationalEvent[]): Map<string, ActivityLane> {
  const lanes = new Map<string, ActivityLane>();
  for (const e of events) foldOperationalEvent(lanes, e);
  return lanes;
}

test('events with no session or workflow correlation are ignored', () => {
  const lanes = fold([ev({ type: 'model_call_started', source: 'model' })]);
  assert.equal(lanes.size, 0);
});

test('a harness lane picks up kind/title and folds worker counts', () => {
  const lanes = fold([
    ev({ type: 'harness_turn_started', sessionId: 's1', payload: { sessionKind: 'chat', sessionTitle: 'Five firm SEO' } }),
    ev({ type: 'worker_spawned', sessionId: 's1' }),
    ev({ type: 'worker_spawned', sessionId: 's1' }),
    ev({ type: 'worker_spawned', sessionId: 's1' }),
    ev({ type: 'worker_queued', sessionId: 's1' }),
    ev({ type: 'worker_completed', sessionId: 's1' }),
    ev({ type: 'worker_failed', sessionId: 's1' }),
  ]);
  const lane = lanes.get('s1')!;
  assert.equal(lane.kind, 'chat');
  assert.equal(lane.title, 'Five firm SEO');
  assert.equal(lane.workers.active, 1); // 3 spawned − 1 completed − 1 failed
  assert.equal(lane.workers.done, 1);
  assert.equal(lane.workers.failed, 1);
});

test('worker_capped is a badge only — its worker_result (worker_failed) owns the slot decrement', () => {
  // A capped worker emits BOTH worker_capped (turn-cap signal) and a failed
  // worker_result; counting both double-decremented active (review finding).
  const lanes = fold([
    ev({ type: 'worker_spawned', sessionId: 's1' }),
    ev({ type: 'worker_capped', sessionId: 's1' }),
    ev({ type: 'worker_failed', sessionId: 's1' }),
  ]);
  const lane = lanes.get('s1')!;
  assert.equal(lane.workers.active, 0);
  assert.equal(lane.workers.failed, 1);
  assert.equal(lane.badges.capped, 1);
});

test('completions never erase genuine waiters: queued decrements on SPAWN, not on completion', () => {
  const lanes = fold([
    ev({ type: 'worker_spawned', sessionId: 's1' }),
    ev({ type: 'worker_spawned', sessionId: 's1' }),
    ev({ type: 'worker_queued', sessionId: 's1' }),
    ev({ type: 'worker_queued', sessionId: 's1' }),
    // The two non-queued workers finish while both waiters still wait.
    ev({ type: 'worker_completed', sessionId: 's1' }),
    ev({ type: 'worker_completed', sessionId: 's1' }),
  ]);
  const lane = lanes.get('s1')!;
  assert.equal(lane.workers.queued, 2, 'waiters still visible');
  assert.equal(lane.workers.active, 0);
  // A waiter gets its slot → spawned dequeues it.
  foldOperationalEvent(lanes, ev({ type: 'worker_spawned', sessionId: 's1' }));
  assert.equal(lanes.get('s1')!.workers.queued, 1);
  assert.equal(lanes.get('s1')!.workers.active, 1);
});

test('per-worker rows track item status through queued → running, and drop on completion', () => {
  const lanes = fold([
    ev({ type: 'worker_queued', sessionId: 's1', payload: { item: 'acme.example' } }),
    ev({ type: 'worker_spawned', sessionId: 's1', payload: { item: 'acme.example', model: 'claude-sonnet-5' } }),
    ev({ type: 'worker_queued', sessionId: 's1', payload: { item: 'globex.example' } }),
  ]);
  const rows = workerRowsForDisplay(lanes.get('s1')!);
  // running first, then queued.
  assert.deepEqual(rows.map((r) => `${r.item}:${r.status}`), ['acme.example:running', 'globex.example:queued']);
  assert.equal(rows[0].model, 'claude-sonnet-5');
  // Completion prunes the row (its count lives in the counter, not the live list).
  foldOperationalEvent(lanes, ev({ type: 'worker_completed', sessionId: 's1', payload: { item: 'acme.example' } }));
  assert.deepEqual(workerRowsForDisplay(lanes.get('s1')!).map((r) => r.item), ['globex.example']);
  assert.equal(lanes.get('s1')!.workers.done, 1);
});

test('failed and capped workers stay as rows, ordered after running/queued', () => {
  const lanes = fold([
    ev({ type: 'worker_spawned', sessionId: 's1', payload: { item: 'a' } }),
    ev({ type: 'worker_queued', sessionId: 's1', payload: { item: 'b' } }),
    ev({ type: 'worker_spawned', sessionId: 's1', payload: { item: 'c' } }),
    ev({ type: 'worker_failed', sessionId: 's1', payload: { item: 'c' } }),
    ev({ type: 'worker_spawned', sessionId: 's1', payload: { item: 'd' } }),
    ev({ type: 'worker_capped', sessionId: 's1', payload: { item: 'd' } }),
  ]);
  const rows = workerRowsForDisplay(lanes.get('s1')!);
  assert.deepEqual(rows.map((r) => `${r.item}:${r.status}`), ['a:running', 'b:queued', 'c:failed', 'd:capped']);
});

test('worker events without an item still fold counters but add no row', () => {
  const lanes = fold([ev({ type: 'worker_spawned', sessionId: 's1' })]);
  assert.equal(lanes.get('s1')!.workers.active, 1);
  assert.equal(workerRowsForDisplay(lanes.get('s1')!).length, 0);
});

test('openTool tracks a started tool call until it completes', () => {
  const lanes = fold([
    ev({ type: 'tool_call_started', source: 'tool', sessionId: 's1', toolCallId: 't1', payload: { tool: 'composio_execute_tool' } }),
  ]);
  assert.equal(lanes.get('s1')!.openTool?.name, 'composio_execute_tool');

  foldOperationalEvent(lanes, ev({ type: 'tool_call_completed', source: 'tool', sessionId: 's1', toolCallId: 't1' }));
  assert.equal(lanes.get('s1')!.openTool, undefined);
});

test('badges accumulate fallover / retries / gate verdicts / auto-continues', () => {
  const lanes = fold([
    ev({ type: 'model_fallover', source: 'model', sessionId: 's1' }),
    ev({ type: 'workflow_node_retried', source: 'workflow', sessionId: 's1' }),
    ev({ type: 'gate_verdict', source: 'safety', sessionId: 's1' }),
    ev({ type: 'auto_continue', sessionId: 's1' }),
    ev({ type: 'auto_continue', sessionId: 's1' }),
  ]);
  const b = lanes.get('s1')!.badges;
  assert.equal(b.fallover, 1);
  assert.equal(b.retries, 1);
  assert.equal(b.gateVerdicts, 1);
  assert.equal(b.autoContinues, 2);
});

test('needsApproval is set by approval_required and cleared by approval_resolved', () => {
  const lanes = fold([ev({ type: 'approval_required', source: 'safety', sessionId: 's1' })]);
  assert.equal(lanes.get('s1')!.needsApproval, true);
  foldOperationalEvent(lanes, ev({ type: 'approval_resolved', source: 'safety', sessionId: 's1' }));
  assert.equal(lanes.get('s1')!.needsApproval, false);
});

test('terminal is set on run completion and cleared when the lane resumes a turn', () => {
  const lanes = fold([
    ev({ type: 'harness_turn_started', sessionId: 's1' }),
    ev({ type: 'harness_run_completed', sessionId: 's1' }),
  ]);
  assert.equal(lanes.get('s1')!.terminal, 'completed');
  foldOperationalEvent(lanes, ev({ type: 'harness_turn_started', sessionId: 's1' }));
  assert.equal(lanes.get('s1')!.terminal, undefined);
});

test('model is captured from model_route_decided', () => {
  const lanes = fold([ev({ type: 'model_route_decided', source: 'model', sessionId: 's1', payload: { model: 'claude-opus-4-8' } })]);
  assert.equal(lanes.get('s1')!.model, 'claude-opus-4-8');
});

test('a workflow lane keys off workflowRunId and labels itself workflow', () => {
  const lanes = fold([ev({ type: 'workflow_node_retried', source: 'workflow', workflowRunId: 'wr1' })]);
  const lane = lanes.get('wr1')!;
  assert.equal(lane.workflowRunId, 'wr1');
  assert.equal(lane.kind, 'workflow');
});

test('lanesToSortedArray orders running-first, needs-you first, then most recent', () => {
  const lanes = new Map<string, ActivityLane>();
  // Terminal lane (should sink to the bottom).
  foldOperationalEvent(lanes, ev({ type: 'harness_turn_started', sessionId: 'done', ts: '2026-07-01T10:00:00.000Z' }));
  foldOperationalEvent(lanes, ev({ type: 'harness_run_completed', sessionId: 'done', ts: '2026-07-01T10:00:01.000Z' }));
  // Running lane, most recent.
  foldOperationalEvent(lanes, ev({ type: 'harness_turn_started', sessionId: 'runNew', ts: '2026-07-01T12:00:00.000Z' }));
  // Running lane needing approval (older, but must sort above runNew).
  foldOperationalEvent(lanes, ev({ type: 'harness_turn_started', sessionId: 'needsYou', ts: '2026-07-01T11:00:00.000Z' }));
  foldOperationalEvent(lanes, ev({ type: 'approval_required', source: 'safety', sessionId: 'needsYou', ts: '2026-07-01T11:00:01.000Z' }));

  const order = lanesToSortedArray(lanes).map((l) => l.key);
  assert.deepEqual(order, ['needsYou', 'runNew', 'done']);
});
