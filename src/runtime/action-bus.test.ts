/**
 * Run: npx tsx --test src/runtime/action-bus.test.ts
 *
 * Contract: subscribers receive every emit, exceptions in a
 * subscriber don't break sibling subscribers, and unsubscribe stops
 * delivery to that listener. This is a signal layer, not a queue —
 * no replay, no persistence on the bus itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionBus, type ActionEvent } from './action-bus.js';

function makeRunEvent(message: string): ActionEvent {
  return {
    kind: 'run.event',
    runId: 'run-test',
    sessionId: 'sess-test',
    runTitle: 'test',
    runStatus: 'running',
    event: {
      id: 'evt-1',
      type: 'tool_started',
      message,
      createdAt: new Date().toISOString(),
    },
  };
}

test('actionBus: subscriber receives emitted events', () => {
  const received: ActionEvent[] = [];
  const unsubscribe = actionBus.subscribe((event) => { received.push(event); });
  try {
    actionBus.emit(makeRunEvent('one'));
    actionBus.emit(makeRunEvent('two'));
  } finally {
    unsubscribe();
  }
  assert.equal(received.length, 2);
  assert.equal(received[0].kind, 'run.event');
  if (received[0].kind === 'run.event') {
    assert.equal(received[0].event.message, 'one');
  }
});

test('actionBus: unsubscribe stops further delivery to that listener', () => {
  const received: ActionEvent[] = [];
  const unsubscribe = actionBus.subscribe((event) => { received.push(event); });
  actionBus.emit(makeRunEvent('before'));
  unsubscribe();
  actionBus.emit(makeRunEvent('after'));
  assert.equal(received.length, 1);
});

test('actionBus: a throwing subscriber does not poison sibling subscribers', () => {
  const goodReceived: ActionEvent[] = [];
  const unsubscribeGood = actionBus.subscribe((event) => { goodReceived.push(event); });
  const unsubscribeBad = actionBus.subscribe(() => { throw new Error('intentional'); });
  try {
    actionBus.emit(makeRunEvent('payload'));
  } finally {
    unsubscribeBad();
    unsubscribeGood();
  }
  assert.equal(goodReceived.length, 1);
});

test('actionBus: emits all four event kinds with their distinct shapes', () => {
  const received: ActionEvent[] = [];
  const unsubscribe = actionBus.subscribe((event) => { received.push(event); });
  try {
    actionBus.emit({
      kind: 'approval.created',
      approval: {
        id: 'a-1',
        sessionId: 's',
        agentName: 'agent',
        toolName: 'tool',
        createdAt: new Date().toISOString(),
        status: 'pending',
        state: '{}',
      },
    });
    actionBus.emit({
      kind: 'approval.resolved',
      approval: {
        id: 'a-1',
        sessionId: 's',
        agentName: 'agent',
        toolName: 'tool',
        createdAt: new Date().toISOString(),
        status: 'approved',
        state: '{}',
      },
      resolution: 'approved',
    });
    actionBus.emit({
      kind: 'notification.created',
      notification: {
        id: 'n-1',
        kind: 'system',
        title: 't',
        body: 'b',
        createdAt: new Date().toISOString(),
        read: false,
      },
    });
    actionBus.emit({
      kind: 'execution.transitioned',
      executionId: 'e-1',
      title: 'x',
      previousState: 'running',
      nextState: 'blocked',
    });
  } finally {
    unsubscribe();
  }
  assert.deepEqual(received.map((e) => e.kind), [
    'approval.created',
    'approval.resolved',
    'notification.created',
    'execution.transitioned',
  ]);
});
