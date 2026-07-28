import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityTerminalOutcomeForMessageStatus,
  activityTerminalOutcomeFromHarnessEvents,
  settleTerminalActivity,
} from './activity-presentation.js';
import type { ActivityItem } from './useChat.js';

const runningTool: ActivityItem = {
  id: 'tool-1',
  kind: 'tool',
  label: 'Write the report',
  status: 'running',
};

test('terminal activity never turns an unresolved row green after failure or interruption', () => {
  assert.equal(settleTerminalActivity([runningTool], 'failed')[0]?.status, 'failed');
  assert.equal(settleTerminalActivity([runningTool], 'interrupted')[0]?.status, 'interrupted');
  assert.equal(settleTerminalActivity([runningTool], 'completed')[0]?.status, 'done');
});

test('live activity remains untouched and preserves its array identity', () => {
  const items = [runningTool];
  assert.equal(settleTerminalActivity(items), items);
  assert.equal(items[0]?.status, 'running');
});

test('chat terminal status distinguishes success, failure, and parked or stopped work', () => {
  assert.equal(activityTerminalOutcomeForMessageStatus('thinking'), undefined);
  assert.equal(activityTerminalOutcomeForMessageStatus('complete'), 'completed');
  assert.equal(activityTerminalOutcomeForMessageStatus('failed'), 'failed');
  assert.equal(activityTerminalOutcomeForMessageStatus('stopped'), 'interrupted');
  assert.equal(activityTerminalOutcomeForMessageStatus('awaiting-approval'), 'interrupted');
  assert.equal(activityTerminalOutcomeForMessageStatus('awaiting-reply'), 'interrupted');
  assert.equal(activityTerminalOutcomeForMessageStatus('awaiting-plan'), 'interrupted');
  assert.equal(activityTerminalOutcomeForMessageStatus(undefined), 'interrupted');
});

test('board feed uses durable terminal events and fails closed without one', () => {
  assert.equal(activityTerminalOutcomeFromHarnessEvents([], true), undefined);
  assert.equal(activityTerminalOutcomeFromHarnessEvents([
    { type: 'tool_called' },
    { type: 'run_failed' },
  ], false), 'failed');
  assert.equal(activityTerminalOutcomeFromHarnessEvents([
    { type: 'tool_called' },
    { type: 'conversation_completed' },
  ], false), 'completed');
  assert.equal(activityTerminalOutcomeFromHarnessEvents([
    { type: 'tool_called' },
  ], false), 'interrupted');
});
