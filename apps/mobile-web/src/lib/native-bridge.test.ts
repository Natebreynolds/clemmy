import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from './api.js';
import {
  parkOriginHandoff,
  installNativeBridge,
  ORIGIN_HANDOFF_STORED_EVENT,
  reportConnectionLost,
  reportOriginHandoffResult,
} from './native-bridge.js';

test('a failed PWA transport can wake the native LAN-to-relay reconnect ladder', () => {
  const messages: unknown[] = [];
  const priorWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      webkit: {
        messageHandlers: {
          clemConnectionLost: {
            postMessage: (body: unknown) => messages.push(body),
          },
        },
      },
    },
  });

  try {
    assert.equal(reportConnectionLost(), true);
    assert.deepEqual(messages, ['offline']);
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
  }
});

test('plain browsers keep the existing offline behavior without a native shell', () => {
  const priorWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });

  try {
    assert.equal(reportConnectionLost(), false);
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
  }
});

test('only a transport failure wakes native reconnect; an HTTP refusal does not', async () => {
  const messages: unknown[] = [];
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      webkit: {
        messageHandlers: {
          clemConnectionLost: {
            postMessage: (body: unknown) => messages.push(body),
          },
        },
      },
    },
  });

  try {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => new Response(JSON.stringify({ error: 'refused' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(() => api('/m/api/test'), (err: unknown) => (
      (err as { status?: number }).status === 503
    ));
    assert.deepEqual(messages, []);

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => { throw new TypeError('network down'); },
    });
    await assert.rejects(() => api('/m/api/test'), (err: unknown) => (
      (err as { status?: number; offline?: boolean }).status === 0
      && (err as { offline?: boolean }).offline === true
    ));
    assert.deepEqual(messages, ['offline']);
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: priorFetch });
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
  }
});

test('origin handoff parking sends the complete v2 lease to the native shell', () => {
  const messages: unknown[] = [];
  const priorWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      webkit: {
        messageHandlers: {
          clemHandoff: {
            postMessage: (body: unknown) => messages.push(body),
          },
        },
      },
    },
  });
  const lease = {
    version: 2 as const,
    token: 'handoff-token',
    expiresAt: 1_900_000_000_000,
    handoffId: 'handoff-id',
    generation: 17,
    deviceId: 'device-id',
  };

  try {
    assert.equal(parkOriginHandoff(lease), true);
    assert.deepEqual(messages, [lease]);
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
  }
});

test('origin handoff result acknowledges the exact handoff id and generation', () => {
  const messages: unknown[] = [];
  const priorWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      webkit: {
        messageHandlers: {
          clemHandoffResult: {
            postMessage: (body: unknown) => messages.push(body),
          },
        },
      },
    },
  });

  try {
    assert.equal(reportOriginHandoffResult('handoff-id', 17, 'consumed'), true);
    assert.deepEqual(messages, [{
      handoffId: 'handoff-id',
      generation: 17,
      outcome: 'consumed',
    }]);
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
  }
});

test('handoff bridge methods are no-ops when native handlers are absent', () => {
  const priorWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });

  try {
    assert.equal(parkOriginHandoff({
      version: 2,
      token: 'unused-token',
      expiresAt: 1_900_000_000_000,
      handoffId: 'unused-handoff',
      generation: 1,
      deviceId: 'unused-device',
    }), false);
    assert.equal(reportOriginHandoffResult('unused-handoff', 1, 'invalid'), false);
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
  }
});

test('native Keychain storage acknowledgement becomes one exact browser event', () => {
  const priorWindow = globalThis.window;
  const priorStorage = globalThis.localStorage;
  const events: Event[] = [];
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const fakeWindow = {
    addEventListener(name: string, listener: (event: Event) => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    dispatchEvent(event: Event) {
      events.push(event);
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, removeItem: () => undefined, setItem: () => undefined },
  });
  try {
    installNativeBridge();
    (fakeWindow as typeof fakeWindow & {
      clemNative: { originHandoffStored(value: { handoffId: string; generation: number }): void };
    }).clemNative.originHandoffStored({ handoffId: 'stored-id', generation: 23 });
    const stored = events.find((event) => event.type === ORIGIN_HANDOFF_STORED_EVENT) as CustomEvent;
    assert.deepEqual(stored.detail, { handoffId: 'stored-id', generation: 23 });
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    if (priorStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: priorStorage });
  }
});
