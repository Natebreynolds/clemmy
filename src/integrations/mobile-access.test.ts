/**
 * Run: npx tsx --test src/integrations/mobile-access.test.ts
 *
 * Tests the orchestration module that the dashboard endpoints call.
 * The pinned-TLS direct-app door is the only pairing transport — these pin
 * that the QR always targets it, that the cert fingerprint rides in the QR,
 * and that posture gaps still block exposure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-access-test-'));
const tmpHome = path.join(TMP_ROOT, 'home');
mkdirSync(path.join(tmpHome, '.clementine-next', 'state'), { recursive: true });
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');

test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const integration = await import('./mobile-access.js');
const { setDirectAppRuntime } = await import('../runtime/mobile-ingress.js');

test('getMobileAccessStatusPayload returns a coherent door-closed payload', async () => {
  setDirectAppRuntime(null);
  const payload = await integration.getMobileAccessStatusPayload();
  assert.ok(payload);
  assert.equal(payload.pin.configured, false);
  assert.equal(payload.sessions.length, 0);
  assert.match(payload.targetUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+\/m\/$/);
  assert.equal(payload.target.mode, 'local-preview');
  assert.equal(payload.target.qrReady, false);
  assert.match(payload.target.qrBlockedReason ?? '', /door is closed/i);
  assert.equal(payload.targetMode, 'local-preview');
  assert.ok(payload.setup, 'the derived setup view rides along');
});

test('rotatePin updates state and PIN meta is reflected in next status payload', async () => {
  const result = await integration.rotatePin('TestPin1!');
  assert.equal(typeof result.updatedAt, 'string');
  const payload = await integration.getMobileAccessStatusPayload();
  assert.equal(payload.pin.configured, true);
  assert.ok(payload.pin.updatedAt);
});

test('rotatePin rejects invalid PINs via the underlying setPin guard', async () => {
  await assert.rejects(() => integration.rotatePin('abc'));
  await assert.rejects(() => integration.rotatePin('12'));
});

test('generateQrSvg blocks the QR while the direct-app door is closed', async () => {
  setDirectAppRuntime(null);
  await assert.rejects(
    () => integration.generateQrSvg(),
    (err: unknown) => {
      assert.ok(err instanceof integration.MobileQrNotReadyError);
      assert.equal(err.target.mode, 'local-preview');
      assert.equal(err.target.qrReady, false);
      return true;
    },
  );
});

test('a blocking auth-posture gap still blocks the QR', async () => {
  // The gate did not disappear with the tunnel, it moved to something we can
  // actually verify. Without this the change would just be "ship an open door".
  setDirectAppRuntime({ port: 8421, fingerprint: 'test-fp-b64url' });
  const prior = process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY;
  process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY = 'false';
  try {
    await assert.rejects(
      () => integration.generateQrSvg({ lanIp: '192.168.1.50' }),
      (err: unknown) => {
        assert.ok(err instanceof integration.MobileQrNotReadyError);
        assert.match(err.target.qrBlockedReason ?? '', /device binding/i);
        return true;
      },
    );
  } finally {
    if (prior === undefined) delete process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY;
    else process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY = prior;
    setDirectAppRuntime(null);
  }
});

test('lanIPv4Address prefers en0 and skips internal/virtual interfaces', () => {
  const pick = integration.lanIPv4Address({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' } as never],
    utun3: [{ family: 'IPv4', internal: false, address: '100.64.0.9' } as never],
    en5: [{ family: 'IPv4', internal: false, address: '10.0.0.8' } as never],
    en0: [
      { family: 'IPv6', internal: false, address: 'fe80::1' } as never,
      { family: 'IPv4', internal: false, address: '192.168.1.50' } as never,
    ],
  });
  assert.equal(pick, '192.168.1.50');
  assert.equal(integration.lanIPv4Address({ lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' } as never] }), null);
});

test('with the door open, the QR is the pinned-TLS LAN url with fp and pairing token', async () => {
  setDirectAppRuntime({ port: 8421, fingerprint: 'test-fp-b64url' });
  try {
    const result = await integration.generateQrSvg({ lanIp: '192.168.1.50' });
    assert.match(result.svg, /^<svg/);
    assert.equal(result.target.mode, 'direct-app');
    assert.equal(result.target.qrReady, true);
    assert.equal(result.targetMode, 'public');
    assert.match(result.targetUrl, /^https:\/\/192\.168\.1\.50:8421\/m\/\?pair=/);
    const url = new URL(result.targetUrl);
    assert.equal(url.searchParams.get('fp'), 'test-fp-b64url', 'the cert pin rides in the QR');
    assert.ok(url.searchParams.get('pair'), 'one-time pairing token present');
    assert.ok(result.expiresAt);
  } finally {
    setDirectAppRuntime(null);
  }
});

test('direct-app QR is blocked when the Mac has no LAN address', async () => {
  setDirectAppRuntime({ port: 8421, fingerprint: 'test-fp-b64url' });
  try {
    await assert.rejects(
      () => integration.generateQrSvg({ lanIp: null }),
      (err: unknown) => {
        assert.ok(err instanceof integration.MobileQrNotReadyError);
        assert.equal(err.target.mode, 'direct-app');
        assert.match(err.target.qrBlockedReason ?? '', /no network address/i);
        return true;
      },
    );
  } finally {
    setDirectAppRuntime(null);
  }
});
