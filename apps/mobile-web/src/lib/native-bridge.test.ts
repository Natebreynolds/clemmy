import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from './api.js';
import { reportConnectionLost } from './native-bridge.js';

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
