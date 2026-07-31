/**
 * Run: npx tsx --test src/dashboard/console-license-routes.test.ts
 *
 * Functional smoke for the console license routes. Boots a tiny Express app
 * with the REAL registerConsoleRoutes (stub assistant — these routes never
 * touch it) and drives every license state through the wire.
 *
 * The state that matters most here is `stale`. A license server outage must
 * report as "still fine, we couldn't reach the server", never as unlicensed
 * and never as locked — so that case is asserted on `ok` explicitly rather
 * than on rendering. Offline, deterministic, per-test temp home: leases are
 * signed with a throwaway key injected through CLEMENTINE_LICENSE_PUBKEYS,
 * so nothing here touches the production key ring or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-license-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

// A throwaway signing key, published to the client through the documented dev
// override. Replaces the baked ring, so a bug that ignored the override would
// fail these tests rather than silently pass against production keys.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
process.env.CLEMENTINE_LICENSE_PUBKEYS = `k1:${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`;
// Nothing in this file should ever reach a real server; point the client at a
// port nothing is listening on so an accidental call fails instead of leaking.
process.env.CLEMENTINE_LICENSE_URL = 'http://127.0.0.1:9';

const { registerConsoleRoutes } = await import('./console-routes.js');
const { __resetSecretStoreForTests } = await import('../runtime/secrets/index.js');
const LEASE_FILE = path.join(TMP_HOME, 'state', 'license-lease.json');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const NOW = () => Math.floor(Date.now() / 1000);

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** Builds a compact lease the client will actually verify. */
function signLease(overrides: Partial<Record<string, unknown>> = {}): string {
  const payload = {
    v: 1,
    jti: 'test-jti',
    tenant: 'clementine',
    product: 'desktop',
    licenseId: '1',
    activationId: '11',
    mid: 'test-machine',
    pair: null,
    plan: 'pro',
    features: ['relay'],
    seat: { used: 1, limit: 3 },
    enforce: false,
    iat: NOW() - 60,
    nbf: NOW() - 60,
    exp: NOW() + 3600,
    grace: 1_209_600,
    srv: NOW() - 60,
    ...overrides,
  };
  const header = b64url(JSON.stringify({ alg: 'Ed25519', kid: 'k1' }));
  const body = b64url(JSON.stringify(payload));
  const signature = cryptoSign(null, Buffer.from(`${header}.${body}`, 'ascii'), privateKey);
  return `${header}.${body}.${signature.toString('base64url')}`;
}

function seedLease(record: Record<string, unknown> | null): void {
  if (record === null) {
    try { rmSync(LEASE_FILE, { force: true }); } catch { /* fine */ }
    return;
  }
  writeFileSync(LEASE_FILE, JSON.stringify(record), 'utf-8');
}

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  const assistant = { getRuntime: () => ({ listPendingApprovals: () => [] }) };
  registerConsoleRoutes(app, () => authorized.v, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

interface LicenseBody {
  state: string;
  ok: boolean;
  enforcing: boolean;
  plan: string | null;
  features: string[];
  seat: { used: number; limit: number } | null;
  expiresAt: string | null;
  lastCheckAt: string | null;
  lastCheckOutcome: string | null;
  gaps: Array<{ code: string; message: string; blocking: boolean }>;
  hasKey: boolean;
  generatedAt: string;
  tick?: { ran: boolean; outcome?: string; reason?: string };
}

async function getLicense(url: string): Promise<{ status: number; body: LicenseBody; raw: string }> {
  const res = await fetch(`${url}/api/console/license`);
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : ({} as LicenseBody), raw };
}

test('a fresh install with no key reads as unlicensed, not as expired', async () => {
  seedLease(null);
  const app = await boot();
  try {
    const { status, body } = await getLicense(app.url);
    assert.equal(status, 200);
    assert.equal(body.state, 'unlicensed');
    assert.equal(body.hasKey, false);
    assert.equal(body.ok, false);
    // Never enforcing on a fresh install — that is what keeps a licensing
    // rollout from locking out people who simply have no key yet.
    assert.equal(body.enforcing, false);
    assert.ok(body.gaps.some((g) => g.code === 'NO_KEY' && g.blocking));
  } finally {
    await app.close();
  }
});

test('a current lease reads as active and carries plan, seats, and expiry', async () => {
  seedLease({ leaseCompact: signLease(), lastCheckAt: new Date().toISOString(), lastCheckOutcome: 'ok' });
  const app = await boot();
  try {
    const { body } = await getLicense(app.url);
    assert.equal(body.state, 'active');
    assert.equal(body.ok, true);
    assert.equal(body.plan, 'pro');
    assert.deepEqual(body.seat, { used: 1, limit: 3 });
    assert.deepEqual(body.features, ['relay']);
    assert.ok(body.expiresAt);
    assert.equal(body.lastCheckOutcome, 'ok');
  } finally {
    await app.close();
  }
});

test('the server being unreachable reads as stale and STILL ok', async () => {
  // Past exp, well inside grace: the license server has been unreachable.
  seedLease({
    leaseCompact: signLease({ exp: NOW() - 86_400, iat: NOW() - 172_800, nbf: NOW() - 172_800 }),
    lastCheckAt: new Date().toISOString(),
    lastCheckOutcome: 'unreachable',
  });
  const app = await boot();
  try {
    const { body } = await getLicense(app.url);
    assert.equal(body.state, 'stale');
    // The whole point: an outage on our side is not a lapse on theirs.
    assert.equal(body.ok, true);
    assert.equal(body.plan, 'pro');
    const stale = body.gaps.find((g) => g.code === 'LEASE_STALE');
    assert.ok(stale, 'expected a LEASE_STALE gap');
    assert.equal(stale!.blocking, false, 'a stale lease must never be blocking');
  } finally {
    await app.close();
  }
});

test('a lease past its grace window reads as expired', async () => {
  seedLease({
    leaseCompact: signLease({ exp: NOW() - 5_000_000, iat: NOW() - 6_000_000, nbf: NOW() - 6_000_000, grace: 60 }),
    lastCheckAt: new Date().toISOString(),
    lastCheckOutcome: 'unreachable',
  });
  const app = await boot();
  try {
    const { body } = await getLicense(app.url);
    assert.equal(body.state, 'expired');
    assert.equal(body.ok, false);
    assert.ok(body.gaps.some((g) => g.code === 'LEASE_EXPIRED' && g.blocking));
  } finally {
    await app.close();
  }
});

test('a revoked license surfaces the server message verbatim', async () => {
  const serverSaid = 'Refunded on 2026-07-12 — contact support@clementine.app.';
  seedLease({
    leaseCompact: signLease(),
    lastCheckAt: new Date().toISOString(),
    lastCheckOutcome: 'rejected',
    lastCheckMessage: serverSaid,
  });
  const app = await boot();
  try {
    const { body } = await getLicense(app.url);
    assert.equal(body.state, 'revoked');
    assert.equal(body.ok, false);
    const blocking = body.gaps.find((g) => g.blocking);
    assert.ok(blocking);
    // Verbatim: the server knows why, and a generic paraphrase helps nobody.
    assert.equal(blocking!.message, serverSaid);
  } finally {
    await app.close();
  }
});

test('the stored key is never in a response', async () => {
  const SECRET_KEY = 'clem_live_NEVER_SEND_THIS_VALUE_9Z4Q';
  process.env.CLEMENTINE_LICENSE_KEY = SECRET_KEY;
  __resetSecretStoreForTests();
  seedLease({ leaseCompact: signLease(), lastCheckAt: new Date().toISOString(), lastCheckOutcome: 'ok' });
  const app = await boot();
  try {
    const { body, raw } = await getLicense(app.url);
    assert.equal(body.hasKey, true, 'a stored key should be reported as present');
    assert.ok(!raw.includes(SECRET_KEY), 'the license key must never cross the wire');
    assert.ok(!raw.includes('licenseKey'), 'no key field should appear at all');
  } finally {
    delete process.env.CLEMENTINE_LICENSE_KEY;
    __resetSecretStoreForTests();
    await app.close();
  }
});

test('refresh with no key reports the failed CHECK without changing the license', async () => {
  seedLease(null);
  const app = await boot();
  try {
    const res = await fetch(`${app.url}/api/console/license/refresh`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as LicenseBody;
    // The attempt is reported as not having run; the posture is still the
    // honest one rather than an error state.
    assert.equal(body.tick?.ran, false);
    assert.equal(body.tick?.reason, 'no_key');
    assert.equal(body.state, 'unlicensed');
  } finally {
    await app.close();
  }
});

test('both routes refuse an unauthorized caller', async () => {
  const app = await boot({ v: false });
  try {
    const get = await fetch(`${app.url}/api/console/license`);
    assert.equal(get.status, 401);
    const post = await fetch(`${app.url}/api/console/license/refresh`, { method: 'POST' });
    assert.equal(post.status, 401);
  } finally {
    await app.close();
  }
});
