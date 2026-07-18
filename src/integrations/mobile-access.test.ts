/**
 * Run: npx tsx --test src/integrations/mobile-access.test.ts
 *
 * Tests the orchestration module that the dashboard endpoints call.
 * Each test sets CLEMENTINE_HOME to a tmp dir before importing the
 * module so persistent state lands in the fixture.
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
const { setMobileAccessAccessAck, setMobileAccessBinary, setMobileAccessTunnel } = await import('../runtime/mobile-access-state.js');
const { setPin } = await import('../runtime/mobile-pin.js');

test('getMobileAccessStatusPayload returns a coherent empty-state payload', async () => {
  integration._resetMobileAccessForTests();
  const payload = await integration.getMobileAccessStatusPayload();
  assert.ok(payload);
  assert.equal(typeof payload.detect, 'object');
  assert.equal(payload.pin.configured, false);
  assert.equal(payload.sessions.length, 0);
  assert.equal(payload.login.active, false);
  assert.equal(payload.tunnel.running, false);
  assert.match(payload.targetUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+\/m\/$/);
  assert.equal(payload.target.mode, 'local-preview');
  assert.equal(payload.target.qrReady, false);
  assert.match(payload.target.qrBlockedReason ?? '', /phone cannot reach/i);
  assert.equal(payload.targetMode, 'local-preview');
});

test('rotatePin updates state and PIN meta is reflected in next status payload', async () => {
  integration._resetMobileAccessForTests();
  const result = await integration.rotatePin('TestPin1!');
  assert.equal(typeof result.updatedAt, 'string');
  const payload = await integration.getMobileAccessStatusPayload();
  assert.equal(payload.pin.configured, true);
  assert.ok(payload.pin.updatedAt);
});

test('rotatePin rejects invalid PINs via the underlying setPin guard', async () => {
  integration._resetMobileAccessForTests();
  await assert.rejects(() => integration.rotatePin('abc'));
  await assert.rejects(() => integration.rotatePin('12'));
});

test('configureTunnel rejects bad input shapes', async () => {
  integration._resetMobileAccessForTests();
  await assert.rejects(
    () => integration.configureTunnel({ tunnelName: 'bad name with spaces', hostname: 'a.b' }),
    /Tunnel name must be/,
  );
  await assert.rejects(
    () => integration.configureTunnel({ tunnelName: 'ok', hostname: 'no-dot' }),
    /Hostname must be/,
  );
});

test('startTunnel refuses when prerequisites are missing', async () => {
  integration._resetMobileAccessForTests();
  // On machines where cloudflared is already installed the state-store
  // has a binary recorded; on clean CI it won't. Either error is fine
  // here — what matters is that startTunnel rejects without a tunnel
  // configured and without spawning anything.
  const { updateMobileAccess } = await import('../runtime/mobile-access-state.js');
  await updateMobileAccess((current) => ({ ...current, tunnel: null }));
  const result = await integration.startTunnel();
  assert.equal(result.ok, false);
  assert.match(result.error || '', /(cloudflared binary|no .*tunnel configured)/);
});

test('startTunnel refuses when binary present but no tunnel configured', async () => {
  integration._resetMobileAccessForTests();
  await setMobileAccessBinary({ path: '/opt/homebrew/bin/cloudflared', version: '2024.1.0' });
  const { updateMobileAccess } = await import('../runtime/mobile-access-state.js');
  await updateMobileAccess((current) => ({ ...current, tunnel: null }));
  const result = await integration.startTunnel();
  assert.equal(result.ok, false);
  assert.match(result.error || '', /no .*tunnel configured/);
});

test('generateQrSvg blocks local-preview QR when no hostname is configured', async () => {
  integration._resetMobileAccessForTests();
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

test('custom-domain QR no longer requires a Cloudflare Access acknowledgement', async () => {
  // INVERTED DELIBERATELY. This used to assert that the QR was blocked until
  // the user ticked "I've enabled Access" — an acknowledgement nothing ever
  // verified, which meant the security model rested on a self-report and the
  // hard setup steps (own a domain, configure a Cloudflare app) were
  // load-bearing. The daemon's own auth now stands on its own: device-bound
  // sessions, unspoofable rate limits, default-deny routing. Access is
  // defense-in-depth, reported from a real probe rather than trusted.
  integration._resetMobileAccessForTests();
  await setMobileAccessTunnel({ id: 'tid', name: 'clem', hostname: 'clem.example.com', mode: 'named' });
  integration._setTunnelRuntimeForTests({ running: true, connected: true, events: [] });

  const result = await integration.generateQrSvg();
  assert.equal(result.target.qrReady, true, 'a connected tunnel with sound posture is enough');
  assert.equal(result.target.hardening?.cloudflareAccess, 'unknown', 'unprobed means unknown, not off');
});

test('a blocking auth-posture gap still blocks the QR', async () => {
  // The gate did not disappear, it moved to something we can actually verify.
  // Without this the change would just be "ship an open door".
  integration._resetMobileAccessForTests();
  await setMobileAccessTunnel({ id: 'tid', name: 'clem', hostname: 'clem.example.com', mode: 'named' });
  integration._setTunnelRuntimeForTests({ running: true, connected: true, events: [] });

  const prior = process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY;
  process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY = 'false';
  try {
    await assert.rejects(
      () => integration.generateQrSvg(),
      (err: unknown) => {
        assert.ok(err instanceof integration.MobileQrNotReadyError);
        assert.match(err.target.qrBlockedReason ?? '', /device binding/i);
        return true;
      },
    );
  } finally {
    if (prior === undefined) delete process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY;
    else process.env.CLEMENTINE_MOBILE_REQUIRE_DEVICE_KEY = prior;
  }
});

test('a spoofed Access acknowledgement is corrected by the probe, not trusted', async () => {
  integration._resetMobileAccessForTests();
  await setMobileAccessTunnel({ id: 'tid', name: 'clem', hostname: 'clem.example.com', mode: 'named' });
  await setMobileAccessAccessAck({ enabled: true }); // the user claims Access is on

  const { refreshCloudflareAccessVerification } = await import('./cloudflare-access-probe.js');
  // Reality: our own origin answers, so Access is not enforcing.
  const result = await refreshCloudflareAccessVerification('clem.example.com', {
    fetchImpl: (async () => new Response(JSON.stringify({ pinConfigured: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
  });
  assert.equal(result.enforcing, false);
  assert.equal(result.evidence, 'origin-served');

  const { readMobileAccess } = await import('../runtime/mobile-access-state.js');
  const stored = readMobileAccess().cloudflareAccess;
  assert.equal(stored?.enabled, false, 'the unverified claim must be corrected');
  assert.equal(stored?.verified?.enforcing, false);
});

test('generateQrSvg returns one-time pairing SVG when custom-domain target is ready', async () => {
  integration._resetMobileAccessForTests();
  await setMobileAccessTunnel({ id: 'tid', name: 'clem', hostname: 'clem.example.com', mode: 'named' });
  await setMobileAccessAccessAck({ enabled: true });
  integration._setTunnelRuntimeForTests({ running: true, connected: true, events: [] });
  const result = await integration.generateQrSvg();
  assert.ok(result);
  assert.match(result.svg, /^<svg/);
  assert.equal(result.targetMode, 'public');
  assert.equal(result.target.mode, 'custom-domain');
  assert.equal(result.target.qrReady, true);
  assert.match(result.targetUrl, /^https:\/\/clem\.example\.com\/m\/\?pair=/);
  assert.ok(result.expiresAt);
});

test('quick tunnel QR is allowed only for a running connected quick target', async () => {
  integration._resetMobileAccessForTests();
  await setMobileAccessTunnel({ id: 'quick', name: 'Quick mobile link', hostname: 'alpha.trycloudflare.com', mode: 'quick' });
  integration._setTunnelRuntimeForTests({ running: true, connected: true, events: [] });
  const result = await integration.generateQrSvg();
  assert.equal(result.target.mode, 'quick');
  assert.match(result.targetUrl, /^https:\/\/alpha\.trycloudflare\.com\/m\/\?pair=/);
});

test('install jobs are tracked in the module-scoped map and capped to 5 in recent list', async () => {
  integration._resetMobileAccessForTests();
  // We can't actually run brew here, but the job record is created
  // synchronously. The async install will fail on non-macOS or no
  // brew — the test only cares that the registry tracks the job.
  const job1 = await integration.startInstallJob();
  assert.ok(job1.id.startsWith('install-'));
  assert.ok(['running', 'succeeded', 'failed'].includes(job1.status), `unexpected status ${job1.status}`);
  const fetched = integration.getInstallJob(job1.id);
  assert.ok(fetched);
  assert.equal(fetched!.id, job1.id);
  // Drain the fire-and-forget install so its background state writes settle
  // WITHIN this test rather than racing a later test's reset / temp-home
  // teardown on a clean CI runner (that was failing the whole file).
  for (let i = 0; i < 100 && integration.getInstallJob(job1.id)?.status === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test('getLoginStatus reports certPresent based on cert.pem existence', () => {
  integration._resetMobileAccessForTests();
  // Without a cert this would be false on this machine if cert.pem
  // is missing. We don't write one (CLEMENTINE_HOME ≠ ~/.cloudflared)
  // so this just asserts the shape rather than the value.
  const status = integration.getLoginStatus();
  assert.equal(typeof status.certPresent, 'boolean');
  assert.equal(typeof status.certPath, 'string');
  assert.equal(status.active, false);
});

test('status labels cover every MobileAccessStatus value', () => {
  const labels = integration.MOBILE_ACCESS_STATUS_LABELS;
  for (const k of ['inactive', 'installing', 'awaiting-login', 'configuring', 'running', 'error'] as const) {
    assert.ok(labels[k], `missing label for ${k}`);
  }
});

// ─── tunnel adoption ───────────────────────────────────────────────────

test('probeTunnelOwnership accepts only a matching nonce echo', async () => {
  // Cloudflare recycles trycloudflare hostnames, so "the hostname answers" is
  // NOT evidence that it still points at us. Without the nonce, adoption could
  // silently attach us to a stranger's tunnel.
  const ok = await integration.probeTunnelOwnership('x.trycloudflare.com', 'nonce-abc', {
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true, nonce: 'nonce-abc' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
  });
  assert.equal(ok, true);

  const recycled = await integration.probeTunnelOwnership('x.trycloudflare.com', 'nonce-abc', {
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true, nonce: 'someone-elses' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch,
  });
  assert.equal(recycled, false, 'a different daemon answering must not be adopted');

  const missing = await integration.probeTunnelOwnership('x.trycloudflare.com', 'nonce-abc', {
    fetchImpl: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
  });
  assert.equal(missing, false);

  const offline = await integration.probeTunnelOwnership('x.trycloudflare.com', 'nonce-abc', {
    fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
  });
  assert.equal(offline, false);
});

test('probeTunnelOwnership refuses when there is no nonce to check', async () => {
  assert.equal(await integration.probeTunnelOwnership('x.trycloudflare.com', ''), false);
  assert.equal(await integration.probeTunnelOwnership('', 'nonce'), false);
});

test('a quick tunnel with a dead pid is not adopted', async () => {
  integration._resetMobileAccessForTests();
  await setMobileAccessTunnel({
    id: 'quick', name: 'Quick mobile link', hostname: 'dead.trycloudflare.com', mode: 'quick',
    pid: 4194303, probeNonce: 'n1',
  } as never);
  // No binary configured, so the fallback start fails — what matters is that it
  // did NOT report an adoption of a process that is gone.
  const result = await integration.adoptOrStartQuickTunnel();
  assert.equal(result.adopted, false);
});
