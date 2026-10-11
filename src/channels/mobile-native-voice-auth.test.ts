import assert from 'node:assert/strict';
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { provisionNativeVoiceSession, NativeVoiceAuthError } from './mobile-native-voice-auth.js';
import { createSession, listSessions, revokeSessionByDeviceId, rotateSessionToken, validateSession } from '../runtime/mobile-sessions.js';
import { verifyDeviceProof } from '../runtime/mobile-device-proof.js';

async function fixture(t: test.TestContext) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'clem-native-voice-auth-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const web = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const native = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const nativeJwk = await webcrypto.subtle.exportKey('jwk', native.publicKey);
  const opts = { stateDir };
  const paired = await createSession({ deviceLabel: 'Controlled native voice fixture', devicePublicKeyJwk: await webcrypto.subtle.exportKey('jwk', web.publicKey) }, opts);
  const request = { requestId: randomBytes(32).toString('base64url'), publicKeyJwk: nativeJwk };
  return { opts, paired, request, native, web };
}
const refusal = (code: string) => (error: unknown) => error instanceof NativeVoiceAuthError && error.code === code;

test('native enrollment is separate, same-device, idempotent, and persists no raw secret', async t => {
  const f = await fixture(t);
  const first = await provisionNativeVoiceSession(f.paired.record, f.request, f.opts);
  const [second, third] = await Promise.all([provisionNativeVoiceSession(f.paired.record, f.request, f.opts), provisionNativeVoiceSession(f.paired.record, f.request, f.opts)]);
  assert.deepEqual(second, first); assert.deepEqual(third, first);
  assert.equal(first.deviceId, f.paired.record.deviceId);
  assert.notEqual(first.token, f.paired.token);
  assert.equal(first.requestId, f.request.requestId);
  assert.equal(listSessions(f.opts).length, 2);
  assert.ok(await validateSession(f.paired.token, f.opts));
  const stored = readFileSync(path.join(f.opts.stateDir, 'mobile-sessions.json'), 'utf8');
  assert.ok(!stored.includes(first.token)); assert.ok(!stored.includes(f.request.requestId));
});

test('provisioned credential requires the native private key, not the browser key', async t => {
  const f = await fixture(t);
  const result = await provisionNativeVoiceSession(f.paired.record, f.request, f.opts);
  const session = await validateSession(result.token, f.opts);
  assert.ok(session?.devicePublicKeyJwk);
  const signature = async (key: CryptoKey) => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ htm: 'POST', htu: '/m/api/chat/send', iat: Date.now() / 1000, jti: webcrypto.randomUUID(), sfp: result.sessionFingerprint })).toString('base64url');
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(`${header}.${claims}`));
    return `${header}.${claims}.${Buffer.from(sig).toString('base64url')}`;
  };
  const verify = async (key: CryptoKey) => verifyDeviceProof({ proof: await signature(key), publicKeyJwk: session.devicePublicKeyJwk!, method: 'POST', path: '/m/api/chat/send', sessionFingerprint: result.sessionFingerprint });
  assert.equal((await verify(f.native.privateKey)).ok, true);
  assert.equal((await verify(f.web.privateKey)).ok, false);
});

test('rejects private, malformed, unsupported, and invalid curve points', async t => {
  const f = await fixture(t);
  for (const publicKeyJwk of [null, { ...f.request.publicKeyJwk, d: 'private' }, { ...f.request.publicKeyJwk, crv: 'P-384' }, { ...f.request.publicKeyJwk, x: 'A'.repeat(43), y: 'A'.repeat(43) }]) {
    await assert.rejects(provisionNativeVoiceSession(f.paired.record, { ...f.request, publicKeyJwk }, f.opts), refusal('INVALID_NATIVE_KEY'));
  }
  await assert.rejects(provisionNativeVoiceSession(f.paired.record, { ...f.request, requestId: 'not-secret' }, f.opts), refusal('INVALID_NATIVE_REQUEST'));
  assert.equal(listSessions(f.opts).length, 1);
});

test('cookie-only and PIN-rotation sessions cannot enroll native authority', async t => {
  const f = await fixture(t);
  await assert.rejects(provisionNativeVoiceSession({ ...f.paired.record, binding: 'cookie' }, f.request, f.opts), refusal('KEY_BOUND_SESSION_REQUIRED'));
  await assert.rejects(provisionNativeVoiceSession({ ...f.paired.record, scope: 'pin-rotation' }, f.request, f.opts), refusal('KEY_BOUND_SESSION_REQUIRED'));
});

test('an enrollment cannot change keys or recreate its rotated native credential', async t => {
  const f = await fixture(t);
  const result = await provisionNativeVoiceSession(f.paired.record, f.request, f.opts);
  await assert.rejects(provisionNativeVoiceSession(f.paired.record, { ...f.request, publicKeyJwk: await webcrypto.subtle.exportKey('jwk', f.web.publicKey) }, f.opts), refusal('NATIVE_ENROLLMENT_RETIRED'));
  await rotateSessionToken(result.token, f.opts);
  await assert.rejects(provisionNativeVoiceSession(f.paired.record, f.request, f.opts), refusal('NATIVE_ENROLLMENT_RETIRED'));
  assert.equal(listSessions(f.opts).length, 2);
});

test('device revocation removes both sessions and a stale enrollment cannot revive them', async t => {
  const f = await fixture(t);
  const result = await provisionNativeVoiceSession(f.paired.record, f.request, f.opts);
  await revokeSessionByDeviceId(f.paired.record.deviceId, f.opts);
  assert.equal(await validateSession(f.paired.token, f.opts), undefined);
  assert.equal(await validateSession(result.token, f.opts), undefined);
  await assert.rejects(provisionNativeVoiceSession(f.paired.record, f.request, f.opts), refusal('NATIVE_ENROLLMENT_RETIRED'));
});

test('same-key enrollment cap is atomic and exact retries still work at the cap', async t => {
  const f = await fixture(t);
  const inputs = Array.from({ length: 9 }, () => ({ ...f.request, requestId: randomBytes(32).toString('base64url') }));
  const outcomes = await Promise.allSettled(inputs.map(input => provisionNativeVoiceSession(f.paired.record, input, f.opts)));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 4);
  assert.equal(listSessions(f.opts).length, 5);
  const successful = outcomes.findIndex(outcome => outcome.status === 'fulfilled');
  const repeated = await provisionNativeVoiceSession(f.paired.record, inputs[successful], f.opts);
  assert.equal(repeated.token, (outcomes[successful] as PromiseFulfilledResult<typeof repeated>).value.token);
});

test('concurrent device revocation and enrollment cannot leave a usable native session', async t => {
  const f = await fixture(t);
  await Promise.allSettled([provisionNativeVoiceSession(f.paired.record, f.request, f.opts), revokeSessionByDeviceId(f.paired.record.deviceId, f.opts)]);
  assert.equal(listSessions(f.opts).length, 0);
});
