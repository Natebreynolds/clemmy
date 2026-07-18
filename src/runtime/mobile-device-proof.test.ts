/**
 * Run: npx tsx --test src/runtime/mobile-device-proof.test.ts
 *
 * Proofs are generated here with WebCrypto exactly as the PWA generates them,
 * so this also pins the raw-r||s vs DER signature-encoding contract that a
 * hand-rolled verifier gets wrong silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const {
  verifyDeviceProof,
  sessionFingerprint,
  isSupportedDeviceKey,
  resetProofReplayCacheForTests,
  PROOF_SKEW_MS,
} = await import('./mobile-device-proof.js');

const subtle = webcrypto.subtle;

async function makeKey(): Promise<{ pair: CryptoKeyPair; publicJwk: JsonWebKey }> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  return { pair, publicJwk };
}

function b64url(input: string | Uint8Array): string {
  return Buffer.from(input as never).toString('base64url');
}

async function signProof(
  pair: CryptoKeyPair,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'ES256', typ: 'clem-dpop+jws' },
): Promise<string> {
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(claims));
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    Buffer.from(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const SFP = sessionFingerprint('a-session-token');

function baseClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    htm: 'POST',
    htu: '/m/api/chat/send',
    iat: Math.floor(Date.now() / 1000),
    jti: `nonce-${Math.random().toString(36).slice(2)}`,
    sfp: SFP,
    ...over,
  };
}

async function verify(proof: string, over: Record<string, unknown> = {}): Promise<unknown> {
  const { publicKeyJwk, method, path } = {
    method: 'POST',
    path: '/m/api/chat/send',
    ...over,
  } as { publicKeyJwk: JsonWebKey; method: string; path: string };
  return verifyDeviceProof({
    proof,
    publicKeyJwk,
    method,
    path,
    sessionFingerprint: SFP,
    ...over,
  } as never);
}

test('a genuine WebCrypto-generated proof verifies', async () => {
  resetProofReplayCacheForTests();
  const { pair, publicJwk } = await makeKey();
  const proof = await signProof(pair, baseClaims());
  const result = await verify(proof, { publicKeyJwk: publicJwk });
  assert.deepEqual((result as { ok: boolean }).ok, true);
});

test('alg confusion is refused before the key is used', async () => {
  resetProofReplayCacheForTests();
  const { pair, publicJwk } = await makeKey();
  for (const alg of ['none', 'HS256', 'RS256', 'ES384']) {
    const proof = await signProof(pair, baseClaims(), { alg, typ: 'clem-dpop+jws' });
    const result = await verify(proof, { publicKeyJwk: publicJwk }) as { ok: boolean; reason?: string };
    assert.equal(result.ok, false, `${alg} must be refused`);
    assert.equal(result.reason, 'BAD_ALG');
  }
});

test('a proof is bound to its method and path', async () => {
  resetProofReplayCacheForTests();
  const { pair, publicJwk } = await makeKey();

  const wrongMethod = await signProof(pair, baseClaims({ htm: 'GET' }));
  assert.equal(
    ((await verify(wrongMethod, { publicKeyJwk: publicJwk })) as { reason?: string }).reason,
    'METHOD_MISMATCH',
  );

  const wrongPath = await signProof(pair, baseClaims({ htu: '/m/api/memory/facts' }));
  assert.equal(
    ((await verify(wrongPath, { publicKeyJwk: publicJwk })) as { reason?: string }).reason,
    'PATH_MISMATCH',
  );
});

test('a proof minted for one session cannot be used on another', async () => {
  resetProofReplayCacheForTests();
  const { pair, publicJwk } = await makeKey();
  const proof = await signProof(pair, baseClaims({ sfp: sessionFingerprint('a-different-token') }));
  const result = await verify(proof, { publicKeyJwk: publicJwk }) as { ok: boolean; reason?: string };
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SESSION_MISMATCH');
});

test('proofs outside the clock-skew window are stale in both directions', async () => {
  resetProofReplayCacheForTests();
  const { pair, publicJwk } = await makeKey();
  const skewSec = Math.ceil(PROOF_SKEW_MS / 1000) + 30;

  const tooOld = await signProof(pair, baseClaims({ iat: Math.floor(Date.now() / 1000) - skewSec }));
  assert.equal(((await verify(tooOld, { publicKeyJwk: publicJwk })) as { reason?: string }).reason, 'STALE');

  const tooNew = await signProof(pair, baseClaims({ iat: Math.floor(Date.now() / 1000) + skewSec }));
  assert.equal(((await verify(tooNew, { publicKeyJwk: publicJwk })) as { reason?: string }).reason, 'STALE');
});

test('a replayed nonce is refused the second time', async () => {
  resetProofReplayCacheForTests();
  const { pair, publicJwk } = await makeKey();
  const proof = await signProof(pair, baseClaims({ jti: 'fixed-nonce-1' }));
  assert.equal(((await verify(proof, { publicKeyJwk: publicJwk })) as { ok: boolean }).ok, true);
  const second = await verify(proof, { publicKeyJwk: publicJwk }) as { ok: boolean; reason?: string };
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'REPLAYED');
});

test('a foreign key cannot sign for this device', async () => {
  resetProofReplayCacheForTests();
  const attacker = await makeKey();
  const victim = await makeKey();
  const proof = await signProof(attacker.pair, baseClaims());
  const result = await verify(proof, { publicKeyJwk: victim.publicJwk }) as { ok: boolean; reason?: string };
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BAD_SIGNATURE');
});

test('a tampered payload invalidates the signature', async () => {
  resetProofReplayCacheForTests();
  const { pair, publicJwk } = await makeKey();
  const proof = await signProof(pair, baseClaims());
  const [head, , sig] = proof.split('.');
  const forged = Buffer.from(JSON.stringify(baseClaims({ htu: '/m/api/chat/send' }))).toString('base64url');
  const tampered = `${head}.${forged}.${sig}`;
  const result = await verify(tampered, { publicKeyJwk: publicJwk }) as { ok: boolean; reason?: string };
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BAD_SIGNATURE');
});

test('malformed proofs are rejected without throwing', async () => {
  resetProofReplayCacheForTests();
  const { publicJwk } = await makeKey();
  for (const bad of ['', 'a.b', 'not-base64!.x.y', 'a.b.c.d', '..']) {
    const result = await verify(bad, { publicKeyJwk: publicJwk }) as { ok: boolean; reason?: string };
    assert.equal(result.ok, false, `${bad || '(empty)'} must be refused`);
    assert.ok(result.reason === 'MALFORMED' || result.reason === 'BAD_ALG');
  }
});

test('a failed proof does not burn its nonce', async () => {
  // Otherwise an attacker could pre-emptively invalidate a legitimate client's
  // nonce by replaying it with a broken signature.
  resetProofReplayCacheForTests();
  const { pair, publicJwk } = await makeKey();
  const attacker = await makeKey();
  const claims = baseClaims({ jti: 'contested-nonce' });

  const forged = await signProof(attacker.pair, claims);
  assert.equal(((await verify(forged, { publicKeyJwk: publicJwk })) as { ok: boolean }).ok, false);

  const genuine = await signProof(pair, claims);
  assert.equal(
    ((await verify(genuine, { publicKeyJwk: publicJwk })) as { ok: boolean }).ok,
    true,
    'the legitimate client must still be able to use its nonce',
  );
});

test('isSupportedDeviceKey accepts a P-256 public key and rejects private material', async () => {
  const { pair, publicJwk } = await makeKey();
  assert.equal(isSupportedDeviceKey(publicJwk), true);

  const privateJwk = await subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  assert.equal(isSupportedDeviceKey(privateJwk), false, 'private material must never be accepted');

  assert.equal(isSupportedDeviceKey({ kty: 'RSA', n: 'x', e: 'AQAB' }), false);
  assert.equal(isSupportedDeviceKey({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' }), false);
  assert.equal(isSupportedDeviceKey(null), false);
  assert.equal(isSupportedDeviceKey('nope'), false);
});
