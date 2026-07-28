import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalEvent, runHarnessStream } from './chat';

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
