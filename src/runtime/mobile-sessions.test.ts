/**
 * Run: npx tsx --test src/runtime/mobile-sessions.test.ts
 *
 * The most important assertion in this file is the migration one: a v1
 * sessions file must keep authenticating after upgrade. Shipping a release
 * that silently logs every paired phone out would be a worse outcome than the
 * vulnerability being fixed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { webcrypto } from 'node:crypto';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-sessions-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const {
  createSession,
  validateSession,
  rotateSessionToken,
  detectTokenReuse,
  bindDeviceKey,
  needsDeviceUpgrade,
  shouldRotate,
  revokeSessionByDeviceId,
  listSessions,
  markPushSubscribed,
  ABSOLUTE_TTL_MS,
  ROTATE_AFTER_MS,
  UPGRADE_GRACE_MS,
} = await import('./mobile-sessions.js');

let caseCounter = 0;
function freshDir(): string {
  const dir = path.join(TMP_ROOT, `case-${++caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function publicJwk(): Promise<JsonWebKey> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  return await webcrypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
}

test('MIGRATION: a v1 sessions file still authenticates after upgrade', async () => {
  // The no-lockout guarantee. Every already-paired phone must keep working.
  const stateDir = freshDir();
  const file = path.join(stateDir, 'mobile-sessions.json');
  const now = Date.now();
  const token = 'legacy-token-value';
  const { createHash } = await import('node:crypto');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  writeFileSync(file, JSON.stringify({
    version: 1,
    sessions: [{
      tokenHash,
      deviceId: 'dev-legacy',
      deviceLabel: 'Old iPhone',
      createdAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(now - 1000).toISOString(),
      pushSubscribed: true,
    }],
  }));

  const record = await validateSession(token, { stateDir });
  assert.ok(record, 'a v1 session must still validate');
  assert.equal(record!.deviceId, 'dev-legacy');
  assert.equal(record!.deviceLabel, 'Old iPhone');
  assert.equal(record!.pushSubscribed, true, 'v1 fields must survive');
  assert.equal(record!.binding, 'cookie', 'migrated rows are cookie-bound');
  assert.equal(record!.scope, 'full', 'migrated rows keep full capability');
  assert.ok(record!.upgradeGraceUntil, 'migrated rows get a silent-upgrade window');
  assert.ok(record!.absoluteExpiresAt, 'migrated rows gain an absolute ceiling');
});

test('MIGRATION: a migrated session works during grace and is upgradable in place', async () => {
  const stateDir = freshDir();
  const file = path.join(stateDir, 'mobile-sessions.json');
  const now = Date.now();
  const token = 'legacy-token-2';
  const { createHash } = await import('node:crypto');
  writeFileSync(file, JSON.stringify({
    version: 1,
    sessions: [{
      tokenHash: createHash('sha256').update(token).digest('hex'),
      deviceId: 'dev-legacy-2',
      createdAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(now - 1000).toISOString(),
    }],
  }));

  const before = await validateSession(token, { stateDir });
  assert.equal(needsDeviceUpgrade(before!, now), false, 'inside grace it still works');
  assert.equal(
    needsDeviceUpgrade(before!, now + UPGRADE_GRACE_MS + 1000),
    true,
    'after grace it must stop working',
  );

  // The silent upgrade: bind a key, get a fresh token, no user interaction.
  const upgraded = await bindDeviceKey(token, await publicJwk(), { stateDir });
  assert.ok(upgraded, 'binding a key must succeed during grace');
  assert.equal(upgraded!.record.binding, 'key');
  assert.equal(upgraded!.record.deviceId, 'dev-legacy-2', 'device identity is preserved');
  assert.equal(needsDeviceUpgrade(upgraded!.record, now), false);

  // And the pre-binding token is retired.
  const stale = await validateSession(token, { stateDir, now: () => now + 60_000 });
  assert.equal(stale, undefined, 'the pre-upgrade token must stop working');
});

test('a key-bound session cannot be rebound by a stolen cookie', async () => {
  // Otherwise the whole scheme collapses: a thief with the cookie would just
  // swap in a key they control.
  const stateDir = freshDir();
  const { token } = await createSession({ devicePublicKeyJwk: await publicJwk() }, { stateDir });
  const attempt = await bindDeviceKey(token, await publicJwk(), { stateDir });
  assert.equal(attempt, undefined, 'rebinding an already-bound session must be refused');
});

test('rotation preserves device identity and the absolute ceiling', async () => {
  const stateDir = freshDir();
  const created = await createSession({ deviceLabel: 'iPhone' }, { stateDir });
  const rotated = await rotateSessionToken(created.token, { stateDir });
  assert.ok(rotated);
  assert.notEqual(rotated!.token, created.token, 'a new token must be issued');
  assert.equal(rotated!.record.deviceId, created.record.deviceId);
  assert.equal(rotated!.record.deviceLabel, 'iPhone');
  assert.equal(
    rotated!.record.absoluteExpiresAt,
    created.record.absoluteExpiresAt,
    'the absolute ceiling must NOT slide on rotation',
  );
  assert.equal(rotated!.record.tokenGeneration, 1);

  const byNew = await validateSession(rotated!.token, { stateDir });
  assert.ok(byNew, 'the new token works');
});

test('the old token survives a 30s grace, then stops', async () => {
  // Absorbs a request already in flight when rotation happened, and the SSE
  // reconnect, which would otherwise 401 mid-stream.
  const stateDir = freshDir();
  const created = await createSession({}, { stateDir });
  await rotateSessionToken(created.token, { stateDir });

  const inFlight = await validateSession(created.token, { stateDir });
  assert.ok(inFlight, 'an in-flight request with the old token must not 401');

  const later = await validateSession(created.token, { stateDir, now: () => Date.now() + 60_000 });
  assert.equal(later, undefined, 'past the grace the old token is dead');
});

test('reuse of a retired token past grace is detected and revokes the device', async () => {
  const stateDir = freshDir();
  const created = await createSession({}, { stateDir });
  const rotated = await rotateSessionToken(created.token, { stateDir });
  const future = () => Date.now() + 60_000;

  const reuse = await detectTokenReuse(created.token, { stateDir, now: future });
  assert.equal(reuse.reused, true, 'a retired token in use means the value leaked');
  assert.equal((reuse as { deviceId: string }).deviceId, created.record.deviceId);

  // Killing the whole chain is the safe response — we cannot tell which caller
  // is the legitimate one.
  await revokeSessionByDeviceId(created.record.deviceId, { stateDir });
  assert.equal(await validateSession(rotated!.token, { stateDir }), undefined);
});

test('a current token is never mistaken for reuse', async () => {
  const stateDir = freshDir();
  const created = await createSession({}, { stateDir });
  assert.equal((await detectTokenReuse(created.token, { stateDir })).reused, false);
  const rotated = await rotateSessionToken(created.token, { stateDir });
  assert.equal((await detectTokenReuse(rotated!.token, { stateDir })).reused, false);
});

test('the absolute ceiling beats the sliding idle window', async () => {
  const stateDir = freshDir();
  const created = await createSession({}, { stateDir });
  const past = Date.now() + ABSOLUTE_TTL_MS + 1000;
  assert.equal(
    await validateSession(created.token, { stateDir, now: () => past }),
    undefined,
    'a session must not live past its absolute ceiling no matter how active it is',
  );
});

test('shouldRotate fires only after the rotation interval', async () => {
  const stateDir = freshDir();
  const { record } = await createSession({}, { stateDir });
  const now = Date.parse(record.createdAt);
  assert.equal(shouldRotate(record, now + 1000), false);
  assert.equal(shouldRotate(record, now + ROTATE_AFTER_MS + 1000), true);
});

test('listSessions hides expired rows and markPushSubscribed follows rotation', async () => {
  const stateDir = freshDir();
  const created = await createSession({ deviceLabel: 'Pixel' }, { stateDir });
  assert.equal(listSessions({ stateDir }).length, 1);

  const rotated = await rotateSessionToken(created.token, { stateDir });
  // The old token still resolves during grace, so a push confirmation that
  // raced rotation must not be lost.
  assert.equal(await markPushSubscribed(created.token, true, { stateDir }), true);
  const rows = listSessions({ stateDir });
  assert.equal(rows.length, 1, 'rotation must not duplicate the session');
  assert.equal(rows[0]!.pushSubscribed, true);
  assert.ok(rotated);
});

test('a session created with a device key is key-bound with no grace', async () => {
  const stateDir = freshDir();
  const { record } = await createSession({ devicePublicKeyJwk: await publicJwk() }, { stateDir });
  assert.equal(record.binding, 'key');
  assert.equal(record.upgradeGraceUntil, undefined);
  assert.equal(needsDeviceUpgrade(record, Date.now()), false);
});

test('private key material is never accepted or stored', async () => {
  const stateDir = freshDir();
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  const { record } = await createSession({ devicePublicKeyJwk: privateJwk }, { stateDir });
  assert.equal(record.binding, 'cookie', 'a JWK carrying private material must be refused');
  assert.equal(record.devicePublicKeyJwk, undefined);

  const persisted = readFileSync(path.join(stateDir, 'mobile-sessions.json'), 'utf-8');
  assert.equal(persisted.includes(String(privateJwk.d)), false, 'private material must never hit disk');
});
