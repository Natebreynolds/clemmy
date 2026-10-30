import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeWidgetVoiceLaunch, widgetVoiceLaunchConsumed, VoiceLaunchGate } from './voice-launch.js';

test('a consumed live action waits for its exact chat history and starts once', () => {
  const gate = new VoiceLaunchGate(); const id = crypto.randomUUID();
  assert.equal(gate.evaluate(id, 'chat-a', 'preparing', 1000), 'wait');
  assert.equal(gate.evaluate(id, 'chat-a', 'preparing', 1200), 'wait');
  assert.equal(gate.evaluate(id, 'chat-a', 'ready', 1400), 'start');
  assert.equal(gate.evaluate(id, 'chat-a', 'ready', 1500), 'used');
});

test('pending live authority cannot cross chats, backgrounding, drafts or expired loading', () => {
  for (const [scope, state, at] of [['chat-b', 'ready', 2000], ['chat-a', 'hidden', 2000], ['chat-a', 'blocked', 2000], ['chat-a', 'ready', 20_000]] as const) {
    const gate = new VoiceLaunchGate(); const id = crypto.randomUUID();
    assert.equal(gate.evaluate(id, 'chat-a', 'preparing', 1000), 'wait');
    assert.equal(gate.evaluate(id, scope, state, at), 'refuse');
    assert.equal(gate.evaluate(id, 'chat-a', 'ready', 21_000), 'used');
  }
});

test('live launch requires the exact native action receipt and cannot replay', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const sent: Array<{ requestId: string; navigationId: string }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { webkit: { messageHandlers: {
    clemWidgetVoiceLaunch: { postMessage: (value: { requestId: string; navigationId: string }) => sent.push(value) },
  } } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const navigationId = crypto.randomUUID();
  const pending = consumeWidgetVoiceLaunch(navigationId);
  assert.equal(sent.length, 1);
  let settled = false; void pending.then(() => { settled = true; });
  widgetVoiceLaunchConsumed({ ...sent[0], navigationId: crypto.randomUUID(), ok: true });
  await Promise.resolve(); assert.equal(settled, false);
  assert.equal(await consumeWidgetVoiceLaunch(navigationId), false);
  widgetVoiceLaunchConsumed({ ...sent[0], ok: true });
  assert.equal(await pending, true);
  assert.equal(await consumeWidgetVoiceLaunch(navigationId), false);
  assert.equal(await consumeWidgetVoiceLaunch('not-a-native-action'), false);
  assert.equal(sent.length, 1);
});

test('a lost receipt never silently retries or later opens the microphone', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalTimer = globalThis.setTimeout;
  const callbacks: Array<() => void> = [];
  const sent: Array<{ requestId: string; navigationId: string }> = [];
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void) => { callbacks.push(callback); return 1; } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { webkit: { messageHandlers: {
    clemWidgetVoiceLaunch: { postMessage: (value: { requestId: string; navigationId: string }) => sent.push(value) },
  } } } });
  t.after(() => {
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: originalTimer });
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  });
  const navigationId = crypto.randomUUID(); const pending = consumeWidgetVoiceLaunch(navigationId);
  callbacks[0](); assert.equal(await pending, false);
  widgetVoiceLaunchConsumed({ ...sent[0], ok: true });
  assert.equal(await consumeWidgetVoiceLaunch(navigationId), false);
  assert.equal(sent.length, 1);
});
