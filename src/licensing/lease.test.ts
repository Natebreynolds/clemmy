/**
 * Run: npx tsx --test src/licensing/lease.test.ts
 *
 * These pin the daemon's verifier against the server's signer by importing
 * BOTH — a format drift between apps/license/lease.mjs and this module would
 * lock out every install at once, so the two must be tested as one unit rather
 * than against a fixture that could rot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { effectiveNowMs, shouldRenew, verifyLease } from './lease.js';
import { buildLeasePayload, signLease, publicKeyBase64 } from '../../apps/license/lease.mjs';

const { privateKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const KEYS = [{ kid: 'k1', spkiBase64: publicKeyBase64(privateKeyPem) }];

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);

function mint(overrides: Record<string, unknown> = {}, now = NOW): string {
  const payload = buildLeasePayload({
    tenant: 'breakthrough',
    product: 'clementine',
    licenseId: '1',
    activationId: '7',
    machineIdHashHex: 'ab'.repeat(32),
    pairId: 'de9334b0f70862c5',
    plan: 'founder',
    features: ['relay'],
    seatUsed: 1,
    seatLimit: 3,
    enforce: true,
    leaseTtlSeconds: 259_200,
    graceSeconds: 1_209_600,
    now,
    ...overrides,
  });
  return signLease({ ...payload, ...overrides }, { privateKeyPem, kid: 'k1' });
}

test('a freshly signed lease verifies, and carries the claims the client needs', () => {
  const verdict = verifyLease(mint(), NOW, KEYS);
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  assert.equal(verdict.state, 'active');
  assert.equal(verdict.payload.plan, 'founder');
  assert.equal(verdict.payload.pair, 'de9334b0f70862c5');
  assert.equal(verdict.payload.enforce, true, 'the kill switch rides inside the signature');
  assert.deepEqual(verdict.payload.seat, { used: 1, limit: 3 });
});

test('a tampered payload is rejected — the signature covers the received bytes', () => {
  // The attack this pins: swap the payload for one claiming a better plan and
  // more seats. Verifying a re-serialization instead of the received bytes is
  // the classic JWT hole; this must fail on signature, not on parsing.
  const compact = mint();
  const [header, , signature] = compact.split('.');
  const forged = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(compact.split('.')[1], 'base64url').toString()),
    plan: 'enterprise',
    seat: { used: 1, limit: 9999 },
    enforce: false,
  })).toString('base64url');
  const verdict = verifyLease(`${header}.${forged}.${signature}`, NOW, KEYS);
  assert.deepEqual(verdict, { ok: false, reason: 'bad_signature' });
});

test('algorithm confusion is refused outright', () => {
  const compact = mint();
  const [, payload, signature] = compact.split('.');
  for (const alg of ['none', 'HS256', 'RS256']) {
    const header = Buffer.from(JSON.stringify({ alg, kid: 'k1' })).toString('base64url');
    const verdict = verifyLease(`${header}.${payload}.${signature}`, NOW, KEYS);
    assert.deepEqual(verdict, { ok: false, reason: 'bad_alg' }, `alg ${alg} must be refused`);
  }
});

test('a lease signed by an unknown key is refused', () => {
  const other = generateKeyPairSync('ed25519');
  const foreign = signLease(
    buildLeasePayload({
      tenant: 't', product: 'clementine', licenseId: '1', activationId: '1',
      machineIdHashHex: 'cd'.repeat(32), pairId: null, plan: 'pro', features: [],
      seatUsed: 1, seatLimit: 1, enforce: true, leaseTtlSeconds: 3600, graceSeconds: 0, now: NOW,
    }),
    { privateKeyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, kid: 'k1' },
  );
  assert.deepEqual(verifyLease(foreign, NOW, KEYS), { ok: false, reason: 'bad_signature' });

  const unknownKid = signLease(
    buildLeasePayload({
      tenant: 't', product: 'clementine', licenseId: '1', activationId: '1',
      machineIdHashHex: 'cd'.repeat(32), pairId: null, plan: 'pro', features: [],
      seatUsed: 1, seatLimit: 1, enforce: true, leaseTtlSeconds: 3600, graceSeconds: 0, now: NOW,
    }),
    { privateKeyPem, kid: 'k9' },
  );
  assert.deepEqual(verifyLease(unknownKid, NOW, KEYS), { ok: false, reason: 'unknown_kid' });
});

test('grace is what keeps a plane ride from looking like piracy', () => {
  const compact = mint();
  const day = 86_400_000;
  // Past exp (72h) but well inside the 14-day grace: still usable, flagged stale.
  const inGrace = verifyLease(compact, NOW + 5 * day, KEYS);
  assert.equal(inGrace.ok, true);
  if (inGrace.ok) assert.equal(inGrace.state, 'stale');

  // 3 days lease + 14 days grace = 17 days of offline tolerance, then expired.
  assert.equal(verifyLease(compact, NOW + 16 * day, KEYS).ok, true);
  assert.deepEqual(verifyLease(compact, NOW + 18 * day, KEYS), { ok: false, reason: 'expired' });
});

test('renewal starts in the final third, long before anything goes stale', () => {
  const payload = buildLeasePayload({
    tenant: 't', product: 'clementine', licenseId: '1', activationId: '1',
    machineIdHashHex: 'ef'.repeat(32), pairId: null, plan: 'pro', features: [],
    seatUsed: 1, seatLimit: 1, enforce: true, leaseTtlSeconds: 259_200, graceSeconds: 0, now: NOW,
  });
  assert.equal(shouldRenew(payload, NOW), false);
  assert.equal(shouldRenew(payload, NOW + 24 * 3_600_000), false, 'one day in: not yet');
  assert.equal(shouldRenew(payload, NOW + 50 * 3_600_000), true, 'final third: renew');
});

test('winding the clock back cannot extend a lease', () => {
  const serverHighWater = Math.floor(NOW / 1000);
  const rolledBack = NOW - 30 * 86_400_000;
  // The effective clock never drops below the newest server time we have seen,
  // so a backdated machine gets no extra life out of an expired lease.
  assert.equal(effectiveNowMs(rolledBack, serverHighWater), NOW);
  assert.equal(effectiveNowMs(NOW + 1000, serverHighWater), NOW + 1000, 'moving forward still works');
  assert.equal(effectiveNowMs(rolledBack, undefined), rolledBack, 'no high-water yet: trust local');
});

test('garbage in never throws', () => {
  for (const junk of ['', 'a', 'a.b', 'a.b.c.d', 'not.base64.here', '..']) {
    const verdict = verifyLease(junk, NOW, KEYS);
    assert.equal(verdict.ok, false, `${junk} must be refused, not accepted`);
  }
});
