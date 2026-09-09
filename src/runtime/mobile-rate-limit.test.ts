/**
 * Run: npx tsx --test src/runtime/mobile-rate-limit.test.ts
 *
 * Covers the scope dimension added so that `POST /m/auth/pair` — which mints a
 * full session exactly like PIN login — is budgeted at all, and budgeted
 * SEPARATELY from PIN so the two can never starve each other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-ratelimit-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const {
  checkAttempt,
  reserveAttempt,
  resetInFlightAttempts,
  recordFailure,
  recordSuccess,
  readGlobalBucket,
  SCOPE_POLICIES,
} = await import('./mobile-rate-limit.js');

let caseCounter = 0;
function freshDir(): string {
  const dir = path.join(TMP_ROOT, `case-${++caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('pin lockout trips after the configured failures', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pin' as const };
  for (let i = 0; i < SCOPE_POLICIES.pin.maxFailures - 1; i += 1) {
    const d = await recordFailure('1.2.3.4', opts);
    assert.equal(d.allowed, true, `attempt ${i + 1} should still be allowed`);
  }
  const last = await recordFailure('1.2.3.4', opts);
  assert.equal(last.allowed, false);
  assert.ok(last.retryAfterMs > 0);
  assert.equal(checkAttempt('1.2.3.4', opts).allowed, false);
});

test('pair has its own budget: PIN failures never lock out pairing', async () => {
  // This is the reason for separate scopes. Pairing is the recovery path — if
  // PIN brute-forcing could lock it, an attacker could deny the legitimate user
  // their own way back in.
  const stateDir = freshDir();
  for (let i = 0; i < SCOPE_POLICIES.pin.maxFailures + 2; i += 1) {
    await recordFailure('1.2.3.4', { stateDir, scope: 'pin' });
  }
  assert.equal(checkAttempt('1.2.3.4', { stateDir, scope: 'pin' }).allowed, false, 'pin is locked');
  assert.equal(
    checkAttempt('1.2.3.4', { stateDir, scope: 'pair' }).allowed,
    true,
    'pairing must remain available while pin is locked',
  );
});

test('pair lockout trips independently and does not lock pin', async () => {
  const stateDir = freshDir();
  for (let i = 0; i < SCOPE_POLICIES.pair.maxFailures; i += 1) {
    await recordFailure('9.9.9.9', { stateDir, scope: 'pair' });
  }
  assert.equal(checkAttempt('9.9.9.9', { stateDir, scope: 'pair' }).allowed, false);
  assert.equal(checkAttempt('9.9.9.9', { stateDir, scope: 'pin' }).allowed, true);
});

test('per-IP buckets are independent within a scope', async () => {
  const stateDir = freshDir();
  for (let i = 0; i < SCOPE_POLICIES.pin.maxFailures; i += 1) {
    await recordFailure('10.0.0.1', { stateDir, scope: 'pin' });
  }
  assert.equal(checkAttempt('10.0.0.1', { stateDir, scope: 'pin' }).allowed, false);
  assert.equal(checkAttempt('10.0.0.2', { stateDir, scope: 'pin' }).allowed, true);
});

test('success clears the per-IP bucket but not the global one', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pin' as const };
  await recordFailure('7.7.7.7', opts);
  await recordFailure('7.7.7.7', opts);
  assert.equal(checkAttempt('7.7.7.7', opts).failures, 2);
  await recordSuccess('7.7.7.7', opts);
  assert.equal(checkAttempt('7.7.7.7', opts).failures, 0);
  // An active brute-force is still active even if the real user got in.
  assert.equal(readGlobalBucket(opts).failures.length, 2);
});

test('the global tier trips across rotating IPs and reports globalTrippedNow once', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pair' as const };
  const trips: boolean[] = [];
  for (let i = 0; i < SCOPE_POLICIES.pair.globalMaxFailures + 1; i += 1) {
    const d = await recordFailure(`203.0.113.${i}`, opts);
    trips.push(d.globalTrippedNow);
  }
  assert.equal(trips.filter(Boolean).length, 1, 'the lockdown alarm must fire exactly once');
  assert.equal(checkAttempt('198.51.100.1', opts).globalLocked, true, 'global lock applies to every IP');
});

test('a v2 file migrates to v3 and an in-progress lockout SURVIVES the upgrade', async () => {
  // Shipping a release must not hand an active brute-force a free reset.
  const stateDir = freshDir();
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'mobile-pin-attempts.json');
  const now = Date.now();
  writeFileSync(file, JSON.stringify({
    version: 2,
    buckets: {
      '5.5.5.5': { failures: [now - 1000, now - 900, now - 800, now - 700, now - 600], lockedUntil: now + 20 * 60 * 1000 },
    },
    global: { failures: [now - 500] },
  }));

  const opts = { stateDir, scope: 'pin' as const };
  const decision = checkAttempt('5.5.5.5', opts);
  assert.equal(decision.allowed, false, 'the legacy lockout must still be in force');
  assert.ok(decision.retryAfterMs > 0);
  assert.equal(readGlobalBucket(opts).failures.length, 1, 'the legacy global bucket carries over');

  // And the first write rewrites the file in the new shape without losing it.
  await recordFailure('6.6.6.6', opts);
  const persisted = JSON.parse(readFileSync(file, 'utf-8')) as {
    version: number;
    buckets: Record<string, unknown>;
    globals: Record<string, unknown>;
  };
  assert.equal(persisted.version, 3);
  assert.ok(persisted.buckets['pin:5.5.5.5'], 'legacy bare-IP key must be re-keyed under the pin scope');
  assert.ok(persisted.buckets['pin:6.6.6.6']);
  assert.ok(persisted.globals.pin);
});

test('state survives a restart within a scope', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pin' as const };
  for (let i = 0; i < SCOPE_POLICIES.pin.maxFailures; i += 1) {
    await recordFailure('4.4.4.4', opts);
  }
  // A fresh read is exactly what a restarted daemon does.
  assert.equal(checkAttempt('4.4.4.4', opts).allowed, false);
});


/**
 * ── The burst, which the durable buckets alone never bounded ────────────────
 *
 * checkAttempt records nothing, so every request that arrived while the caller
 * was hashing was judged against the same pre-burst counter. These pin the
 * reservation that closes that window.
 */

test('a concurrent burst is admitted only up to the budget, not all at once', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pin' as const };
  resetInFlightAttempts();

  // Nothing recorded yet: checkAttempt says yes to every one of these, which is
  // exactly the defect. reserveAttempt must not.
  const budget = SCOPE_POLICIES.pin.maxFailures;
  const held = [];
  let admitted = 0;
  for (let i = 0; i < budget + 20; i += 1) {
    const r = reserveAttempt('9.9.9.9', opts);
    if (r.allowed) { admitted += 1; held.push(r); }
    assert.equal(checkAttempt('9.9.9.9', opts).allowed, true,
      'the durable counter is still untouched — that is the window being closed');
  }
  assert.equal(admitted, budget,
    `a ${budget}-attempt budget must admit ${budget} concurrent attempts, not ${admitted}`);

  // The slot frees as each attempt settles.
  held[0].release();
  assert.equal(reserveAttempt('9.9.9.9', opts).allowed, true, 'a released slot is reusable');
});

test('release is idempotent and cannot inflate the budget', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pin' as const };
  resetInFlightAttempts();

  const first = reserveAttempt('8.8.8.8', opts);
  assert.equal(first.allowed, true);
  first.release();
  first.release();
  first.release();

  // Three releases of one slot must not leave room for budget + 2.
  let admitted = 0;
  for (let i = 0; i < SCOPE_POLICIES.pin.maxFailures + 5; i += 1) {
    if (reserveAttempt('8.8.8.8', opts).allowed) admitted += 1;
  }
  assert.equal(admitted, SCOPE_POLICIES.pin.maxFailures);
});

test('a refused reservation holds no slot', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pin' as const };
  resetInFlightAttempts();

  const budget = SCOPE_POLICIES.pin.maxFailures;
  const held = [];
  for (let i = 0; i < budget; i += 1) held.push(reserveAttempt('7.7.7.7', opts));

  const refused = reserveAttempt('7.7.7.7', opts);
  assert.equal(refused.allowed, false);
  refused.release();  // the handler's `finally` / res close runs on this path too

  // Releasing a refusal must not have decremented someone else's slot.
  assert.equal(reserveAttempt('7.7.7.7', opts).allowed, false,
    'the budget is still fully held by the live attempts');
  held[0].release();
  assert.equal(reserveAttempt('7.7.7.7', opts).allowed, true);
});

test('reservations do not leak across IPs, and a durable lockout still wins', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pin' as const };
  resetInFlightAttempts();

  const mine = reserveAttempt('1.1.1.1', opts);
  assert.equal(mine.allowed, true);
  assert.equal(reserveAttempt('2.2.2.2', opts).allowed, true,
    'one caller in flight must not close the door on a different IP');

  // A durably locked-out IP is refused regardless of how quiet the in-flight
  // map is — the reservation narrows the gate, it never widens it.
  for (let i = 0; i < SCOPE_POLICIES.pin.maxFailures; i += 1) {
    await recordFailure('3.3.3.3', opts);
  }
  resetInFlightAttempts();
  assert.equal(reserveAttempt('3.3.3.3', opts).allowed, false);
});

test('the global budget is held in flight too, so a distributed burst is bounded', async () => {
  const stateDir = freshDir();
  const opts = { stateDir, scope: 'pin' as const };
  resetInFlightAttempts();

  // One attempt per IP never trips the per-IP budget, which is the whole point
  // of the global bucket — and in flight it must behave the same way.
  const globalBudget = SCOPE_POLICIES.pin.globalMaxFailures;
  let admitted = 0;
  for (let i = 0; i < globalBudget + 10; i += 1) {
    if (reserveAttempt(`10.0.0.${i}`, opts).allowed) admitted += 1;
  }
  assert.equal(admitted, globalBudget,
    `a distributed burst must stop at the global budget (${globalBudget}), got ${admitted}`);
});
