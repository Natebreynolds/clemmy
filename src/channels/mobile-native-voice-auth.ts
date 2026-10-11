import express from 'express';
import { createHash, createPublicKey } from 'node:crypto';
import { sessionFingerprint } from '../runtime/mobile-device-proof.js';
import { createOrReuseSessionForExistingDevice, type MobileSessionRecord, type MobileSessionStoreOptions } from '../runtime/mobile-sessions.js';

const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** This ID is 256 bits of native-generated randomness, not a loggable UUID.
 * Its deterministic token makes a lost response retryable without persisting
 * raw credentials. The public-key thumbprint and existing device fence reuse. */
export async function provisionNativeVoiceSession(
  record: MobileSessionRecord,
  input: unknown,
  options?: MobileSessionStoreOptions,
) {
  if (record.binding !== 'key' || record.scope !== 'full') throw new NativeVoiceAuthError(403, 'KEY_BOUND_SESSION_REQUIRED');
  const body = input as { requestId?: unknown; publicKeyJwk?: unknown } | null;
  if (!body || typeof body.requestId !== 'string' || !SECRET.test(body.requestId)
    || Buffer.from(body.requestId, 'base64url').toString('base64url') !== body.requestId) {
    throw new NativeVoiceAuthError(400, 'INVALID_NATIVE_REQUEST');
  }
  const supplied = body.publicKeyJwk as JsonWebKey | null;
  if (!supplied || supplied.kty !== 'EC' || supplied.crv !== 'P-256' || supplied.d !== undefined
    || typeof supplied.x !== 'string' || typeof supplied.y !== 'string'
    || !SECRET.test(supplied.x) || !SECRET.test(supplied.y)) throw new NativeVoiceAuthError(400, 'INVALID_NATIVE_KEY');
  const publicKeyJwk = { crv: 'P-256', kty: 'EC', x: supplied.x, y: supplied.y };
  try { createPublicKey({ key: publicKeyJwk, format: 'jwk' }); }
  catch { throw new NativeVoiceAuthError(400, 'INVALID_NATIVE_KEY'); }
  const keyThumbprint = digest(JSON.stringify(publicKeyJwk));
  const enrollmentDigest = createHash('sha256').update(`clem.native-voice.enrollment.v1\0${record.deviceId}\0${body.requestId}`).digest('hex');
  const token = digest(`clem.native-voice.session.v1\0${record.deviceId}\0${body.requestId}\0${keyThumbprint}`);
  const created = await createOrReuseSessionForExistingDevice({
    deviceId: record.deviceId,
    deviceLabel: record.deviceLabel,
    devicePublicKeyJwk: publicKeyJwk,
    scope: 'full',
    maxSessionsPerKey: 4,
    // Namespaced digest preserves the store's atomic same-device revocation
    // and prevents this enrollment reminting a row after token rotation.
    originHandoffDigest: enrollmentDigest,
  }, token, options);
  if (!created) throw new NativeVoiceAuthError(409, 'NATIVE_ENROLLMENT_RETIRED');
  const actual = created.record.devicePublicKeyJwk;
  if (actual?.x !== publicKeyJwk.x || actual?.y !== publicKeyJwk.y || actual?.crv !== 'P-256') {
    throw new NativeVoiceAuthError(409, 'NATIVE_KEY_MISMATCH');
  }
  return { requestId: body.requestId, keyThumbprint, token: created.token,
    sessionFingerprint: sessionFingerprint(created.token), deviceId: created.record.deviceId,
    expiresAt: created.record.expiresAt };
}

export class NativeVoiceAuthError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function registerMobileNativeVoiceAuth(
  router: express.Router,
  requireMobileSession: express.RequestHandler,
  options?: MobileSessionStoreOptions,
): void {
  router.post('/auth/native-voice-session', requireMobileSession, express.json({ limit: '4kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // The router's existing proof middleware supplies this context. Never
      // accept a client-selected device ID or replace the browser's cookie.
      const record = (req as express.Request & { mobileSession?: { record: MobileSessionRecord } }).mobileSession?.record;
      if (!record) { res.status(401).json({ error: 'NO_SESSION' }); return; }
      res.json(await provisionNativeVoiceSession(record, req.body, options));
    } catch (error) {
      res.status(error instanceof NativeVoiceAuthError ? error.status : 503)
        .json({ error: error instanceof NativeVoiceAuthError ? error.code : 'NATIVE_SESSION_UNAVAILABLE' });
    }
  });
}
