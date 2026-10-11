import assert from 'node:assert/strict';
import test from 'node:test';
import { installNativeVoiceBridge, type NativeVoiceProvisioningRequest } from './native-voice-bridge.js';
import { setSessionFingerprint } from './api.js';
const request: NativeVoiceProvisioningRequest = { requestId: 'a'.repeat(43), publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'b'.repeat(43), y: 'c'.repeat(43) } };
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(t: test.TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const messages: unknown[] = []; const ready: unknown[] = [];
  const bridge: { registerApnsToken(): void; prepareVoice?: (input: NativeVoiceProvisioningRequest) => void } = { registerApnsToken() {} };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { clemNative: bridge, webkit: { messageHandlers: {
    clemNativeVoiceSession: { postMessage: (body: unknown) => messages.push(body) }, clemNativeVoiceReady: { postMessage: (body: unknown) => ready.push(body) },
  } } } });
  setSessionFingerprint(null);
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'window', descriptor); else Reflect.deleteProperty(globalThis, 'window'); });
  return { messages, ready, bridge };
}
test('provisioning is explicit, correlated, same-origin, and leaves browser credentials alone', async t => {
  const f = fixture(t); const calls: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/m/auth/native-voice-session'); calls.push(init);
    return Response.json({ requestId: request.requestId, keyThumbprint: 'native-key', token: 'synthetic', sessionFingerprint: 'native-session', deviceId: 'fixture', expiresAt: 'future' });
  });
  const cleanup = installNativeVoiceBridge(); t.after(cleanup);
  assert.deepEqual(f.ready, [true]); assert.equal(calls.length, 0);
  f.bridge.prepareVoice!(request); await settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].body as string), request);
  assert.equal((f.messages[0] as { ok: boolean }).ok, true);
});
test('cleanup aborts and ignores a late response without clearing native credentials', async t => {
  const f = fixture(t); let release: (response: Response) => void = () => {}; let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_: string, init: RequestInit) => { signal = init.signal!; return await new Promise<Response>(resolve => { release = resolve; }); });
  const cleanup = installNativeVoiceBridge(); f.bridge.prepareVoice!(request); await settle(); cleanup();
  assert.equal(signal?.aborted, true); assert.equal(f.bridge.prepareVoice, undefined);
  release(Response.json({ requestId: request.requestId })); await settle(); assert.deepEqual(f.messages, []);
});
test('duplicate pending requests are collapsed and mismatched receipts fail closed', async t => {
  const f = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; await settle(); return Response.json({ requestId: 'wrong' }); });
  const cleanup = installNativeVoiceBridge(); t.after(cleanup);
  f.bridge.prepareVoice!(request); f.bridge.prepareVoice!(request); await settle(); await settle();
  assert.equal(calls, 1); assert.deepEqual(f.messages, [{ requestId: request.requestId, ok: false, error: 'Native voice could not connect. Open Clem and try again.' }]);
});
test('malformed provisioning calls never reach the network', async t => {
  const f = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}); });
  const cleanup = installNativeVoiceBridge(); t.after(cleanup);
  f.bridge.prepareVoice!({ ...request, requestId: 'short' });
  f.bridge.prepareVoice!({ ...request, publicKeyJwk: { ...request.publicKeyJwk, x: '' } });
  await settle(); assert.equal(calls, 0); assert.deepEqual(f.messages, []);
});
