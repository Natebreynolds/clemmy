import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalEvent, runHarnessStream, subscribeDelegatedActivity } from './chat';

test('chat stream keeps budget-limit telemetry non-terminal', () => {
  assert.equal(isTerminalEvent('conversation_limit_exceeded'), false);
  assert.equal(isTerminalEvent('conversation_completed'), true);
  assert.equal(isTerminalEvent('run_failed'), true);
});

test('chat stream delivers every approval in one replay burst before settling', async () => {
  type Listener = (event: { data: string }) => void;
  class FakeEventSource {
    static active: FakeEventSource | null = null;
    listeners = new Map<string, Listener>();
    onerror: (() => void) | null = null;
    constructor(_url: string) { FakeEventSource.active = this; }
    addEventListener(type: string, listener: Listener) { this.listeners.set(type, listener); }
    close() {}
    emit(type: string, data: unknown) {
      this.listeners.get(type)?.({ data: JSON.stringify(data) });
    }
  }
  const previousEventSource = globalThis.EventSource;
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  Object.assign(globalThis, {
    EventSource: FakeEventSource,
    window: { __CLEM_BOOTSTRAP__: { token: 'stream-test', version: '', flags: {} } },
  });
  globalThis.fetch = (async () => ({
    json: async () => ({ events: [] }),
  })) as unknown as typeof fetch;
  try {
    const seen: string[] = [];
    const stream = runHarnessStream('approval-burst', {
      onEvent: (event) => {
        if (event.type === 'approval_requested') {
          seen.push(String((event.data as { approvalId?: string }).approvalId ?? ''));
        }
      },
    });
    FakeEventSource.active?.emit('replay', {
      events: [
        { seq: 1, turn: 1, role: 'Clem', type: 'approval_requested', data: { approvalId: 'apr-a111' } },
        { seq: 2, turn: 1, role: 'Clem', type: 'approval_requested', data: { approvalId: 'apr-b222' } },
      ],
    });
    assert.deepEqual(seen, ['apr-a111', 'apr-b222']);
    assert.deepEqual(await stream.promise, { ok: true, error: null });
  } finally {
    Object.assign(globalThis, {
      EventSource: previousEventSource,
      fetch: previousFetch,
      window: previousWindow,
    });
  }
});

test('delegated-activity subscription forwards only bridged frames from the promoted run', () => {
  type Listener = (event: { data: string }) => void;
  class FakeEventSource {
    static active: FakeEventSource | null = null;
    listeners = new Map<string, Listener>();
    onerror: (() => void) | null = null;
    constructor(_url: string) { FakeEventSource.active = this; }
    addEventListener(type: string, listener: Listener) { this.listeners.set(type, listener); }
    close() { if (FakeEventSource.active === this) FakeEventSource.active = null; }
    emit(type: string, data: unknown) {
      this.listeners.get(type)?.({ data: JSON.stringify(data) });
    }
  }
  const previousEventSource = globalThis.EventSource;
  const previousWindow = globalThis.window;
  Object.assign(globalThis, {
    EventSource: FakeEventSource,
    window: { __CLEM_BOOTSTRAP__: { token: 'strip-test', version: '', flags: {} } },
  });
  try {
    const seen: Array<{ type: string; sessionId?: string }> = [];
    const unsubscribe = subscribeDelegatedActivity('console:origin', (ev) => {
      seen.push({ type: ev.type, sessionId: ev.sessionId });
    });
    const es = FakeEventSource.active!;
    // Replay frames are the turn stream's business — never the strip's.
    es.emit('replay', { events: [{ seq: 1, turn: 1, role: 'Clem', type: 'tool_called', data: {} }] });
    // Own-session frames belong to the per-turn stream.
    es.emit('event', { seq: 2, turn: 1, role: 'Clem', type: 'tool_called', sessionId: 'console:origin', data: { tool: 'memory_search' } });
    // Un-tagged frames (no sessionId) are own-session by definition.
    es.emit('event', { seq: 3, turn: 1, role: 'Clem', type: 'tool_called', data: { tool: 'memory_search' } });
    // Bridged frames from the promoted task's run session ARE the strip.
    es.emit('event', { seq: 4, turn: 1, role: 'agent', type: 'batch_progress', sessionId: 'background:task-1', data: { batchId: 'accounts', done: 12, total: 29, failed: 0 } });
    es.emit('event', { seq: 5, turn: 1, role: 'agent', type: 'tool_called', sessionId: 'background:task-1', data: { tool: 'web_search' } });
    unsubscribe();

    assert.deepEqual(seen, [
      { type: 'batch_progress', sessionId: 'background:task-1' },
      { type: 'tool_called', sessionId: 'background:task-1' },
    ], 'only frames bridged from another session reach the delegated-work strip');
  } finally {
    Object.assign(globalThis, {
      EventSource: previousEventSource,
      window: previousWindow,
    });
  }
});
