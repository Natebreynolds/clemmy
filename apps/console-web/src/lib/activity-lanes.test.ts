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
import { foldOperationalEvent, lanesToSortedArray, type ActivityLane } from './activity-lanes';
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

test('worker_capped counts as a failure and clears an active slot', () => {
  const lanes = fold([
    ev({ type: 'worker_spawned', sessionId: 's1' }),
    ev({ type: 'worker_capped', sessionId: 's1' }),
  ]);
  const lane = lanes.get('s1')!;
  assert.equal(lane.workers.active, 0);
  assert.equal(lane.workers.failed, 1);
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
