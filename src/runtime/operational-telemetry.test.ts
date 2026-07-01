import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  createOperationalEvent,
  isOperationalEventType,
  listOperationalEvents,
  MODEL_OPERATIONAL_EVENT_TYPES,
  OPERATIONAL_EVENT_TYPES,
  OPERATIONAL_TELEMETRY_SCHEMA_SQL,
  SAFETY_OPERATIONAL_EVENT_TYPES,
  recordOperationalEvent,
  TOOL_OPERATIONAL_EVENT_TYPES,
  WORKFLOW_OPERATIONAL_EVENT_TYPES,
  WORKSPACE_OPERATIONAL_EVENT_TYPES,
} from './operational-telemetry.js';

test('operational event taxonomy includes release-critical graph and routing events', () => {
  for (const type of [
    'workflow_branch_evaluated',
    'workflow_graph_patch_applied',
    'workflow_checkpoint_created',
    'workflow_trigger_fired',
  ]) {
    assert.ok(WORKFLOW_OPERATIONAL_EVENT_TYPES.includes(type as never), `missing ${type}`);
    assert.ok(isOperationalEventType(type));
  }

  for (const type of ['model_route_decided', 'model_call_completed', 'route_policy_updated']) {
    assert.ok(MODEL_OPERATIONAL_EVENT_TYPES.includes(type as never), `missing ${type}`);
    assert.ok(isOperationalEventType(type));
  }
});

test('operational event taxonomy includes workspace and transaction visibility', () => {
  for (const type of [
    'workspace_data_refresh_failed',
    'workspace_action_executed',
    'workspace_memory_consolidated',
  ]) {
    assert.ok(WORKSPACE_OPERATIONAL_EVENT_TYPES.includes(type as never), `missing ${type}`);
    assert.ok(isOperationalEventType(type));
  }

  for (const type of [
    'transaction_guard_opened',
    'transaction_guard_committed',
    'transaction_guard_rolled_back',
    'specular_simulation_completed',
  ]) {
    assert.ok(SAFETY_OPERATIONAL_EVENT_TYPES.includes(type as never), `missing ${type}`);
    assert.ok(isOperationalEventType(type));
  }
});

test('operational event taxonomy includes tool lifecycle visibility', () => {
  for (const type of [
    'tool_call_started',
    'tool_call_completed',
    'tool_call_failed',
    'tool_approval_pending',
  ]) {
    assert.ok(TOOL_OPERATIONAL_EVENT_TYPES.includes(type as never), `missing ${type}`);
    assert.ok(isOperationalEventType(type));
  }
});

test('createOperationalEvent emits a stable correlation envelope', () => {
  const event = createOperationalEvent({
    eventId: 'evt-test',
    now: new Date('2026-06-30T12:00:00.000Z'),
    source: 'workflow',
    type: 'workflow_node_completed',
    workspaceId: 'ws-1',
    workflowRunId: 'run-1',
    workflowNodeRunId: 'node-run-1',
    sessionId: 'sess-1',
    modelCallId: 'model-1',
    toolCallId: 'tool-1',
    actor: 'runner',
    payload: { nodeId: 'draft' },
  });

  assert.deepEqual(event, {
    eventId: 'evt-test',
    ts: '2026-06-30T12:00:00.000Z',
    source: 'workflow',
    type: 'workflow_node_completed',
    severity: 'info',
    workspaceId: 'ws-1',
    workflowRunId: 'run-1',
    workflowNodeRunId: 'node-run-1',
    sessionId: 'sess-1',
    modelCallId: 'model-1',
    toolCallId: 'tool-1',
    actor: 'runner',
    payload: { nodeId: 'draft' },
  });
});

test('operational event type list has no duplicates', () => {
  assert.equal(new Set(OPERATIONAL_EVENT_TYPES).size, OPERATIONAL_EVENT_TYPES.length);
});

test('WS2 visibility taxonomy: harness / scheduler / verdict / retry types are registered', () => {
  for (const type of [
    // harness run lifecycle + swarm + background task
    'harness_turn_started',
    'harness_turn_completed',
    'harness_run_completed',
    'harness_run_failed',
    'worker_spawned',
    'worker_queued',
    'worker_completed',
    'worker_failed',
    'worker_capped',
    'auto_continue',
    'background_task_created',
    'background_task_started',
    'background_task_finished',
    'background_task_parked',
    // scheduler (cron)
    'cron_job_started',
    'cron_job_completed',
    'cron_job_failed',
    // safety verdicts
    'gate_verdict',
    'judge_verdict',
    // workflow retry
    'workflow_node_retried',
  ]) {
    assert.ok(isOperationalEventType(type), `missing operational type ${type}`);
  }
});

test('recordOperationalEvent persists redacted envelopes and list filters them', () => {
  const db = new Database(':memory:');
  try {
    db.exec(OPERATIONAL_TELEMETRY_SCHEMA_SQL);
    recordOperationalEvent({
      eventId: 'evt-db-1',
      now: new Date('2026-06-30T12:01:00.000Z'),
      source: 'tool',
      type: 'tool_call_failed',
      severity: 'error',
      sessionId: 'sess-1',
      toolCallId: 'tool-1',
      payload: { toolName: 'send_email', apiKey: 'secret-value' },
    }, db);
    recordOperationalEvent({
      eventId: 'evt-db-2',
      now: new Date('2026-06-30T12:02:00.000Z'),
      source: 'model',
      type: 'model_route_decided',
      sessionId: 'sess-2',
      payload: { model: 'gpt-5.4' },
    }, db);

    const events = listOperationalEvents({ source: 'tool', limit: 10 }, db);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'evt-db-1');
    assert.equal(events[0].severity, 'error');
    assert.equal(events[0].payload.toolName, 'send_email');
    assert.notEqual(events[0].payload.apiKey, 'secret-value');
  } finally {
    db.close();
  }
});
