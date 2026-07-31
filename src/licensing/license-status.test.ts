/**
 * Run: npx tsx --test src/licensing/license-status.test.ts
 *
 * These pin the states that must NOT lock anyone out. Because the product is
 * unusable without a license, a false positive here is a total outage for a
 * paying customer — so most of what follows is asserting that the gate stays
 * OPEN: while enforcement is off, on a fresh install, and on a laptop that has
 * been offline for a week.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-license-status-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { privateKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const { buildLeasePayload, signLease, publicKeyBase64 } = await import('../../apps/license/lease.mjs');
process.env.CLEMENTINE_LICENSE_PUBKEYS = `k1:${publicKeyBase64(privateKeyPem)}`;

const { licensePosture, licenseLocksFeatures } = await import('./license-status.js');
const { writeLeaseRecord } = await import('./lease-store.js');

const DAY = 86_400_000;

function seed(over: Record<string, unknown> = {}, now = Date.now(), record: Record<string, unknown> = {}): void {
  const payload = buildLeasePayload({
    tenant: 'breakthrough', product: 'clementine', licenseId: '1', activationId: '1',
    machineIdHashHex: 'ab'.repeat(32), pairId: null, plan: 'pro', features: ['relay'],
    seatUsed: 1, seatLimit: 3, enforce: true,
    leaseTtlSeconds: 259_200, graceSeconds: 1_209_600, now,
  });
  writeLeaseRecord({
    leaseCompact: signLease({ ...payload, ...over }, { privateKeyPem, kid: 'k1' }),
    lastCheckOutcome: 'ok',
    lastCheckAt: new Date(now).toISOString(),
    ...record,
  });
}

test('a current lease is active and locks nothing', () => {
  seed();
  const posture = licensePosture();
  assert.equal(posture.state, 'active');
  assert.equal(posture.ok, true);
  assert.equal(posture.plan, 'pro');
  assert.deepEqual(posture.seat, { used: 1, limit: 3 });
  assert.equal(licenseLocksFeatures(posture), false);
});

test('a week offline keeps working — grace is not a lockout', () => {
  // The scenario that matters most: the license server has been unreachable
  // for days. The user must notice nothing beyond a quiet note.
  seed({}, Date.now() - 7 * DAY, { lastCheckOutcome: 'unreachable' });
  const posture = licensePosture();
  assert.equal(posture.state, 'stale');
  assert.equal(posture.ok, true, 'stale must still be usable');
  assert.equal(licenseLocksFeatures(posture), false, 'an outage must never lock a paying customer out');
  const gap = posture.gaps.find((g) => g.code === 'LEASE_STALE');
  assert.ok(gap && gap.blocking === false, 'the stale note is advisory, never blocking');
});

test('enforcement off means nothing locks, whatever the state', () => {
  // The kill switch. If enforcement misfires in the field, flipping this one
  // server-side flag has to be enough — with no client release.
  seed({ enforce: false }, Date.now() - 40 * DAY, { lastKnownEnforce: false });
  const posture = licensePosture();
  assert.equal(posture.state, 'expired');
  assert.equal(posture.enforcing, false);
  assert.equal(licenseLocksFeatures(posture), false, 'enforce=false must override everything');
});

test('a fresh install is unlicensed, never "expired"', () => {
  // Conflating these is exactly how a rollout locks out everyone who was
  // simply never issued a key.
  writeLeaseRecord({});
  const posture = licensePosture();
  assert.equal(posture.state, 'unlicensed');
  assert.equal(posture.enforcing, false, 'we cannot be enforcing on behalf of a server we have never reached');
  assert.equal(licenseLocksFeatures(posture), false);
  assert.ok(posture.gaps.some((g) => g.code === 'NO_KEY'));
});

test('past grace, with enforcement on, is the one state that locks', () => {
  seed({}, Date.now() - 40 * DAY, { lastKnownEnforce: true });
  const posture = licensePosture();
  assert.equal(posture.state, 'expired');
  assert.equal(licenseLocksFeatures(posture), true);
});

test('an explicit rejection skips grace and shows the server\'s own words', () => {
  // Safe to act on immediately precisely BECAUSE it required a successful
  // conversation with the server — it cannot be produced by an outage.
  seed({}, Date.now(), { lastCheckOutcome: 'rejected', lastCheckMessage: 'Subscription cancelled on 12 Aug.', lastKnownEnforce: true });
  const posture = licensePosture();
  assert.equal(posture.state, 'revoked');
  assert.equal(licenseLocksFeatures(posture), true);
  assert.equal(posture.gaps.find((g) => g.blocking)?.message, 'Subscription cancelled on 12 Aug.');
});

test('the lock message never threatens the user\'s data', async () => {
  const { licenseLockResponse } = await import('./entitlements.js');
  seed({}, Date.now() - 40 * DAY, { lastKnownEnforce: true });
  const blocked = licenseLockResponse('sess-1');
  assert.ok(blocked, 'expired + enforcing must produce a refusal');
  assert.match(blocked!.text, /still yours/i);
  assert.equal(blocked!.sessionId, 'sess-1');

  seed();
  assert.equal(licenseLockResponse('sess-1'), null, 'an active license must not be blocked');
});
