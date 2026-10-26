/**
 * Run: npx tsx --test src/runtime/web-push.test.ts
 *
 * Covers the daemon-side bookkeeping for Web Push:
 *   - VAPID keypair generation + persistence
 *   - upsertWebPushDestination idempotency keyed by endpoint URL
 *   - removeWebPushDestinationByEndpoint / ByDeviceId
 *
 * Wire-level delivery (HTTPS POST with VAPID headers, 410 reaper) is
 * covered in scripts/smoke-mobile-push.mjs — `web-push` requires HTTPS
 * with a real-looking cert chain, which adds enough setup that the
 * smoke is the cleaner home for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-web-push-test-'));
process.env.CLEMENTINE_HOME = path.join(TMP_ROOT, '.clementine-next');

test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { getVapidKeys, getVapidPublicKey, _regenerateVapidKeysForTests } = await import('./web-push-keys.js');
const {
  upsertWebPushDestination,
  removeWebPushDestinationByEndpoint,
  removeWebPushDestinationsByDeviceId,
  listNotificationDestinations,
} = await import('./notifications.js');

// ─── VAPID ──────────────────────────────────────────────────────────

test('getVapidKeys generates and persists a keypair', () => {
  const first = getVapidKeys();
  assert.ok(first.publicKey.length > 60, 'public key should be reasonably long');
  assert.ok(first.privateKey.length > 0);
  const second = getVapidKeys();
  assert.equal(first.publicKey, second.publicKey, 'subsequent calls return the same persisted keypair');
});

test('getVapidPublicKey matches getVapidKeys().publicKey', () => {
  const a = getVapidPublicKey();
  const b = getVapidKeys().publicKey;
  assert.equal(a, b);
});

test('regenerate produces a different keypair and persists it', () => {
  const before = getVapidPublicKey();
  const regenerated = _regenerateVapidKeysForTests();
  assert.notEqual(before, regenerated.publicKey);
  assert.equal(getVapidPublicKey(), regenerated.publicKey);
});

test('VAPID keys persist to <state>/vapid.json', () => {
  const file = path.join(process.env.CLEMENTINE_HOME!, 'state', 'vapid.json');
  const text = readFileSync(file, 'utf-8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  assert.ok(parsed.publicKey && parsed.privateKey);
});

// ─── destination upsert ─────────────────────────────────────────────

test('upsertWebPushDestination is idempotent by endpoint URL', () => {
  const endpoint = 'https://push.example.com/abc123';
  const first = upsertWebPushDestination({
    endpoint,
    p256dh: 'p256-1',
    auth: 'auth-1',
    deviceId: 'dev-1',
    deviceLabel: 'iPhone',
  });
  const second = upsertWebPushDestination({
    endpoint,
    p256dh: 'p256-2',
    auth: 'auth-2',
    deviceId: 'dev-1',
    deviceLabel: 'iPhone Renamed',
  });
  assert.equal(first.id, second.id, 'same endpoint → same destination row');
  const matching = listNotificationDestinations().filter(
    (d) => d.type === 'web_push' && d.pushEndpoint === endpoint,
  );
  assert.equal(matching.length, 1);
  assert.equal(matching[0].pushP256dh, 'p256-2', 'keys are updated to the latest values');
  assert.equal(matching[0].name, 'iPhone Renamed');
});

test('distinct endpoints for one device keep distinct IDs within the same millisecond', () => {
  // A duplicate ID is correctly quarantined on the next read. Keep the
  // regression in its own real catalog so a pre-fix failure cannot poison
  // the independent endpoint/device removal tests below.
  const script = `
    import assert from 'node:assert/strict';
    const { upsertWebPushDestination, listNotificationDestinations } =
      await import(${JSON.stringify(new URL('./notifications.ts', import.meta.url).href)});
    const originalNow = Date.now;
    Date.now = () => 1793000000000;
    try {
      const first = upsertWebPushDestination({
        endpoint: 'https://push.example.com/fixed-clock-a',
        p256dh: 'first-key', auth: 'first-auth', deviceId: 'fixed-clock-device',
      });
      const refreshed = upsertWebPushDestination({
        endpoint: 'https://push.example.com/fixed-clock-a',
        p256dh: 'refreshed-key', auth: 'refreshed-auth', deviceId: 'fixed-clock-device',
      });
      assert.equal(refreshed.id, first.id, 'resubscribing preserves the existing endpoint ID');
      const second = upsertWebPushDestination({
        endpoint: 'https://push.example.com/fixed-clock-b',
        p256dh: 'second-key', auth: 'second-auth', deviceId: 'fixed-clock-device',
      });
      assert.notEqual(first.id, second.id, 'different endpoints must not collide on one device');
      const destinations = listNotificationDestinations().filter(
        (destination) => destination.type === 'web_push' && destination.deviceId === 'fixed-clock-device',
      );
      assert.equal(destinations.length, 2, 'both subscriptions remain in a valid catalog');
      assert.equal(new Set(destinations.map(destination => destination.id)).size, 2);
      assert.equal(destinations.find(destination => destination.id === first.id)?.pushP256dh, 'refreshed-key');
    } finally {
      Date.now = originalNow;
    }
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      CLEMENTINE_HOME: path.join(TMP_ROOT, 'fixed-clock-catalog'),
      CLEMMY_TEST_DISABLE_LIVE_MODELS: '1',
      CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off',
      CLEMMY_LOCAL_EMBEDDINGS: 'off',
    },
  });
  assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stdout}\n${child.stderr}`);
});

test('different endpoints create distinct destinations', () => {
  upsertWebPushDestination({ endpoint: 'https://a.example/1', p256dh: 'p', auth: 'a', deviceId: 'dev-2' });
  upsertWebPushDestination({ endpoint: 'https://a.example/2', p256dh: 'p', auth: 'a', deviceId: 'dev-2' });
  const all = listNotificationDestinations().filter(
    (d) => d.type === 'web_push' && d.deviceId === 'dev-2',
  );
  assert.equal(all.length, 2);
});

test('removeWebPushDestinationByEndpoint deletes only the matching row', () => {
  const endpoint = 'https://push.example.com/to-be-removed';
  upsertWebPushDestination({ endpoint, p256dh: 'p', auth: 'a', deviceId: 'dev-3' });
  const removed = removeWebPushDestinationByEndpoint(endpoint);
  assert.equal(removed, true);
  const remaining = listNotificationDestinations().filter(
    (d) => d.type === 'web_push' && d.pushEndpoint === endpoint,
  );
  assert.equal(remaining.length, 0);
  assert.equal(removeWebPushDestinationByEndpoint(endpoint), false, 'second remove is a no-op');
});

test('removeWebPushDestinationsByDeviceId drops every subscription for that device', () => {
  upsertWebPushDestination({ endpoint: 'https://x/a', p256dh: 'p', auth: 'a', deviceId: 'dev-4' });
  upsertWebPushDestination({ endpoint: 'https://x/b', p256dh: 'p', auth: 'a', deviceId: 'dev-4' });
  const count = removeWebPushDestinationsByDeviceId('dev-4');
  assert.equal(count, 2);
  assert.equal(
    listNotificationDestinations().filter((d) => d.deviceId === 'dev-4').length,
    0,
  );
});
