import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  _resetApnsTokenCacheForTests,
  apnsHost,
  buildApnsPayload,
  isApnsConfigured,
  isApnsTokenGone,
  loadApnsConfig,
  mintApnsJwt,
} from './apns.js';

function p256KeyPem(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

test('config loads from state/apns.json, env wins per key, missing pieces mean unconfigured', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'apns-test-'));
  try {
    const emptyEnv = {} as NodeJS.ProcessEnv;
    assert.equal(loadApnsConfig({ stateDir, env: emptyEnv }), null);
    assert.equal(isApnsConfigured({ stateDir, env: emptyEnv }), false);

    const { privatePem } = p256KeyPem();
    writeFileSync(path.join(stateDir, 'apns.json'), JSON.stringify({
      keyId: 'FILEKEY123',
      teamId: 'FILETEAM12',
      key: privatePem,
    }));
    const fromFile = loadApnsConfig({ stateDir, env: emptyEnv });
    assert.equal(fromFile?.keyId, 'FILEKEY123');
    assert.equal(fromFile?.environment, 'sandbox', 'sandbox is the default: dev builds get sandbox tokens');
    assert.ok(fromFile?.topic.length, 'topic falls back to the app bundle id');

    const fromEnv = loadApnsConfig({
      stateDir,
      env: { APNS_KEY_ID: 'ENVKEY9999', APNS_ENV: 'production' } as NodeJS.ProcessEnv,
    });
    assert.equal(fromEnv?.keyId, 'ENVKEY9999', 'env overrides the file per key');
    assert.equal(fromEnv?.teamId, 'FILETEAM12', 'unset env keys still come from the file');
    assert.equal(fromEnv?.environment, 'production');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('mintApnsJwt produces a verifiable ES256 token with raw r||s signature', () => {
  _resetApnsTokenCacheForTests();
  const { privatePem, publicPem } = p256KeyPem();
  const token = mintApnsJwt({ keyId: 'KEYID12345', teamId: 'TEAM123456', key: privatePem }, 1_700_000_000_000);

  const [headerB64, claimsB64, sigB64] = token.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString());
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEYID12345' });
  assert.equal(claims.iss, 'TEAM123456');
  assert.equal(claims.iat, 1_700_000_000);

  const signature = Buffer.from(sigB64, 'base64url');
  assert.equal(signature.length, 64, 'ES256 JWT signatures are raw r||s (64 bytes), not DER');
  const verified = createVerify('SHA256')
    .update(`${headerB64}.${claimsB64}`)
    .verify({ key: publicPem, dsaEncoding: 'ieee-p1363' }, signature);
  assert.equal(verified, true);
});

test('the provider token is cached and re-minted only after it ages out', () => {
  _resetApnsTokenCacheForTests();
  const { privatePem } = p256KeyPem();
  const config = { keyId: 'CACHEKEY12', teamId: 'TEAM123456', key: privatePem };
  const first = mintApnsJwt(config, 1_700_000_000_000);
  const cached = mintApnsJwt(config, 1_700_000_000_000 + 10 * 60 * 1000);
  const reminted = mintApnsJwt(config, 1_700_000_000_000 + 50 * 60 * 1000);
  assert.equal(cached, first, 'within 45 minutes the same token is reused');
  assert.notEqual(reminted, first, 'after 45 minutes a fresh token is minted');
  _resetApnsTokenCacheForTests();
});

test('payload shape and host selection', () => {
  const payload = buildApnsPayload({ title: 'Approval pending', body: 'Tap to review', url: '/m/?tab=inbox' });
  assert.deepEqual(payload, {
    aps: { alert: { title: 'Approval pending', body: 'Tap to review' }, sound: 'default' },
    url: '/m/?tab=inbox',
  });
  assert.equal(apnsHost('sandbox'), 'https://api.sandbox.push.apple.com');
  assert.equal(apnsHost('production'), 'https://api.push.apple.com');
});

test('dead-token classification reaps exactly the right failures', () => {
  assert.equal(isApnsTokenGone({ ok: false, status: 410 }), true);
  assert.equal(isApnsTokenGone({ ok: false, status: 400, reason: 'BadDeviceToken' }), true);
  assert.equal(isApnsTokenGone({ ok: false, status: 400, reason: 'Unregistered' }), true);
  assert.equal(isApnsTokenGone({ ok: false, status: 400, reason: 'DeviceTokenNotForTopic' }), true);
  assert.equal(isApnsTokenGone({ ok: false, status: 429, reason: 'TooManyRequests' }), false, 'throttling must retry, not reap');
  assert.equal(isApnsTokenGone({ ok: false, status: 500, reason: 'InternalServerError' }), false);
});
