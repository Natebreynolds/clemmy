/**
 * Run: npx tsx --test src/integrations/mobile-setup.test.ts
 *
 * mobileSetupView is the one object the desktop panel, the CLI, and any future
 * surface all render. Three surfaces previously recomputed "what state are we
 * in?" from raw status and disagreed with each other, so the point of these
 * tests is that the derivation is total: every reachable combination maps to
 * exactly one phase, and no phase is ever a dead end.
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
    detect: { binary: '/opt/homebrew/bin/cloudflared', version: '2026.1.0' },
    state: {
      version: 1,
      tunnel: null,
      binary: { path: '/opt/homebrew/bin/cloudflared', version: '2026.1.0' },
      autoStart: false,
      status: 'inactive',
      updatedAt: new Date().toISOString(),
    },
    pin: { configured: false },
    sessions: [],
    login: { active: false, certPath: '/x/cert.pem', certPresent: false },
    tunnel: { running: false, connected: false, events: [] },
    install: { recent: [] },
    webhookBound: { host: '127.0.0.1', port: 8420 },
    target: { url: 'http://127.0.0.1:8420/m/', mode: 'local-preview', qrReady: false },
    ...over,
  } as Payload;
}

test('a machine without cloudflared is not-set-up, with no jargon', () => {
  const view = mobileSetupView(payload({ detect: { binary: null, version: null } as never }));
  assert.equal(view.phase, 'not-set-up');
  assert.equal(view.qrReady, false);
  assert.match(view.headline, /phone/i);
  // The first screen should not mention tunnels, Cloudflare accounts, or DNS.
  assert.doesNotMatch(view.headline, /tunnel|cloudflared|DNS|domain/i);
});

test('a running install job reports honest progress rather than a spinner', () => {
  const view = mobileSetupView(payload({
    install: {
      recent: [{
        id: 'j1',
        status: 'running',
        startedAt: new Date().toISOString(),
        lines: [
          { stream: 'stdout', text: '==> Fetching cloudflared', at: '' },
          { stream: 'stdout', text: '==> Pouring cloudflared', at: '' },
        ],
      }],
    } as never,
  }));
  assert.equal(view.phase, 'installing');
  assert.deepEqual(view.progressLines, ['==> Fetching cloudflared', '==> Pouring cloudflared']);
  assert.match(view.detail ?? '', /30 seconds/);
});

test('a connected tunnel with a ready QR is live and carries the URL', () => {
  const view = mobileSetupView(payload({
    state: { ...payload().state, status: 'running', tunnel: { id: 'quick', name: 'Quick mobile link', hostname: 'x.trycloudflare.com', mode: 'quick' } } as never,
    tunnel: { running: true, connected: true, events: [] },
    target: { url: 'https://x.trycloudflare.com/m/', mode: 'quick', qrReady: true },
  }));
  assert.equal(view.phase, 'live');
  assert.equal(view.qrReady, true);
  assert.equal(view.url, 'https://x.trycloudflare.com/m/');
  assert.match(view.detail ?? '', /home screen/i);
  assert.equal(view.advanced.mode, 'quick');
});

test('a tunnel that is up but not yet connected is "connecting", not an error', () => {
  const view = mobileSetupView(payload({
    state: { ...payload().state, status: 'configuring' } as never,
    tunnel: { running: true, connected: false, events: [] },
  }));
  assert.equal(view.phase, 'connecting');
  assert.equal(view.qrReady, false);
});

test('an error phase ALWAYS offers exactly one next action', () => {
  // No dead ends: every failure the UI can render must be recoverable from the
  // UI itself.
  const view = mobileSetupView(payload({
    state: { ...payload().state, status: 'error', lastError: 'Cloudflare refused the connection' } as never,
  }));
  assert.equal(view.phase, 'error');
  assert.ok(view.failure);
  assert.ok(view.failure!.remedy.label.length > 0);
  assert.equal(view.failure!.message, 'Cloudflare refused the connection');
});

test('a blocking auth-posture gap overrides everything, even a ready QR', () => {
  const prior = process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY;
  process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY = 'false';
  try {
    const view = mobileSetupView(payload({
      tunnel: { running: true, connected: true, events: [] },
      target: { url: 'https://x.trycloudflare.com/m/', mode: 'quick', qrReady: true },
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

test('a named tunnel keeps its mode, and Cloudflare Access is reported not assumed', () => {
  const view = mobileSetupView(payload({
    state: { ...payload().state, tunnel: { id: 't', name: 'clem', hostname: 'clem.example.com', mode: 'named' } } as never,
    login: { active: false, certPath: '/x/cert.pem', certPresent: true },
    tunnel: { running: true, connected: true, events: [] },
    target: {
      url: 'https://clem.example.com/m/',
      mode: 'custom-domain',
      qrReady: true,
      hardening: { cloudflareAccess: 'enforcing' },
    },
  }));
  assert.equal(view.advanced.mode, 'named');
  assert.equal(view.advanced.permanentAvailable, true);
  assert.equal(view.advanced.cloudflareAccess, 'enforcing');
});

test('an unprobed hostname reports Access as unknown, never as off', () => {
  const view = mobileSetupView(payload({
    tunnel: { running: true, connected: true, events: [] },
    target: { url: 'https://x.trycloudflare.com/m/', mode: 'quick', qrReady: true },
  }));
  assert.equal(view.advanced.cloudflareAccess, 'unknown');
});
