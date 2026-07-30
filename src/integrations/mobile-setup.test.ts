/**
 * Run: npx tsx --test src/integrations/mobile-setup.test.ts
 *
 * mobileSetupView is the one object the desktop panel, the CLI, and any future
 * surface all render. Surfaces previously recomputed "what state are we in?"
 * from raw status and disagreed with each other, so the point of these tests
 * is that the derivation is total: every reachable combination maps to exactly
 * one phase, and no phase is ever a dead end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-setup-test-'));
mkdirSync(path.join(TMP_ROOT, 'state'), { recursive: true });
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { mobileSetupView } = await import('./mobile-setup.js');

type Payload = Parameters<typeof mobileSetupView>[0];

function payload(over: Partial<Payload> = {}): Payload {
  return {
    pin: { configured: false },
    sessions: [],
    webhookBound: { host: '127.0.0.1', port: 8420 },
    target: {
      url: 'http://127.0.0.1:8420/m/',
      mode: 'local-preview',
      qrReady: false,
      qrBlockedReason: 'The direct-app door is closed, so a phone cannot reach this Mac. Restart the daemon to open it.',
    },
    ...over,
  } as Payload;
}

test('a closed direct-app door is an error with exactly one next action', () => {
  // No dead ends: every failure the UI can render must be recoverable from the
  // UI itself.
  const view = mobileSetupView(payload());
  assert.equal(view.phase, 'error');
  assert.equal(view.qrReady, false);
  assert.equal(view.failure?.code, 'DOOR_CLOSED');
  assert.ok(view.failure!.remedy.label.length > 0);
  // The screen should not mention tunnels, Cloudflare accounts, or DNS.
  assert.doesNotMatch(view.headline, /tunnel|cloudflared|DNS|domain/i);
});

test('a ready direct-app QR is live and names the Clem app', () => {
  const view = mobileSetupView(payload({
    target: { url: 'https://192.168.1.50:8421/m/', mode: 'direct-app', qrReady: true } as never,
  }));
  assert.equal(view.phase, 'live');
  assert.equal(view.qrReady, true);
  assert.equal(view.url, 'https://192.168.1.50:8421/m/');
  assert.match(view.headline, /Clem app/i, 'direct-app QRs are scanned in the app, not the camera');
  assert.doesNotMatch(view.detail ?? '', /cloudflare|tunnel/i);
});

test('an open door without a LAN address is not-set-up, not an error', () => {
  const view = mobileSetupView(payload({
    target: {
      url: 'https://127.0.0.1:8421/m/',
      mode: 'direct-app',
      qrReady: false,
      qrBlockedReason: 'This Mac has no network address a phone could reach. Join a Wi-Fi network and try again.',
    } as never,
  }));
  assert.equal(view.phase, 'not-set-up');
  assert.equal(view.qrReady, false);
  assert.match(view.detail ?? '', /Wi-Fi/i, 'the blocked reason is surfaced as the next step');
});

test('a blocking auth-posture gap overrides everything, even a ready QR', () => {
  const prior = process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY;
  process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY = 'false';
  try {
    const view = mobileSetupView(payload({
      target: { url: 'https://192.168.1.50:8421/m/', mode: 'direct-app', qrReady: true } as never,
    }));
    assert.equal(view.phase, 'error');
    assert.equal(view.qrReady, false, 'an unsound daemon must never present a scannable QR');
    assert.equal(view.failure?.code, 'AUTH_POSTURE');
  } finally {
    if (prior === undefined) delete process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY;
    else process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY = prior;
  }
});

test('paired devices are surfaced for review', () => {
  const view = mobileSetupView(payload({
    sessions: [
      { deviceId: 'dev-1', deviceLabel: 'iPhone', createdAt: '', lastSeenAt: '2026-07-18T10:00:00Z', expiresAt: '', pushSubscribed: true },
      { deviceId: 'dev-2', createdAt: '', lastSeenAt: '2026-07-17T10:00:00Z', expiresAt: '', pushSubscribed: false },
    ] as never,
  }));
  assert.equal(view.devices.length, 2);
  assert.equal(view.devices[0]?.deviceLabel, 'iPhone');
  assert.equal(view.devices[0]?.pushSubscribed, true);
  assert.equal(view.devices[1]?.pushSubscribed, false);
});
