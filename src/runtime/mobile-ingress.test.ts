/**
 * Run: npx tsx --test src/runtime/mobile-ingress.test.ts
 *
 * Regression coverage for the spoofable rate-limit bucket.
 *
 * clientIp() has to read CF-Connecting-IP, because behind the tunnel the socket
 * peer is always cloudflared on loopback. Previously it read that header
 * unconditionally, on the assumption — stated in a comment, enforced nowhere —
 * that "the only path to /m/* is via the tunnel". Any local caller could
 * therefore rotate the header per request and get a fresh per-IP bucket every
 * time, making the 5-failure lockout unenforceable.
 *
 * The fix is that trust follows the listener a request arrived on, which a
 * caller cannot influence. These tests assert exactly that asymmetry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-ingress-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const {
  startIngressListeners,
  classifyIngress,
  restrictTunnelIngressToMobile,
  trustsForwardedClientIp,
} = await import('./mobile-ingress.js');

function rawRequest(
  port: number,
  opts: { path: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'GET', path: opts.path, headers: opts.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function startBoth() {
  const app = express();
  app.use(classifyIngress);
  app.use(restrictTunnelIngressToMobile);
  // Mirrors back how this request was classified and which IP would be billed.
  const report = (req: express.Request, res: express.Response): void => {
    res.json({
      ingress: req.clemIngress,
      trusted: trustsForwardedClientIp(req),
      billedIp: trustsForwardedClientIp(req) && typeof req.headers['cf-connecting-ip'] === 'string'
        ? req.headers['cf-connecting-ip']
        : req.socket.remoteAddress,
    });
  };
  app.get('/api/status', report);
  app.get('/m/auth/status', report);

  const listeners = await startIngressListeners(app, { host: '127.0.0.1', port: 0 });
  const mainAddr = listeners.main.address();
  const mainPort = mainAddr && typeof mainAddr === 'object' ? mainAddr.port : 0;
  return { listeners, mainPort, tunnelPort: listeners.tunnelPort! };
}

test('the tunnel listener binds an ephemeral loopback port distinct from the main one', async () => {
  const h = await startBoth();
  try {
    assert.ok(h.tunnelPort > 0, 'a private ingress port should be published');
    assert.notEqual(h.tunnelPort, h.mainPort);
  } finally {
    await h.listeners.close();
  }
});

test('tunnel ingress is restricted to /m/* by socket, main ingress serves the full surface', async () => {
  const h = await startBoth();
  try {
    const tunnelApi = await rawRequest(h.tunnelPort, { path: '/api/status' });
    assert.equal(tunnelApi.status, 404, 'the admin API must not be reachable over the tunnel door');

    const tunnelMobile = await rawRequest(h.tunnelPort, { path: '/m/auth/status' });
    assert.equal(tunnelMobile.status, 200);
    assert.equal(JSON.parse(tunnelMobile.body).ingress, 'tunnel');

    const localApi = await rawRequest(h.mainPort, { path: '/api/status' });
    assert.equal(localApi.status, 200, 'loopback keeps the full surface');
    assert.equal(JSON.parse(localApi.body).ingress, 'loopback');
  } finally {
    await h.listeners.close();
  }
});

test('CF-Connecting-IP is honored on the tunnel door and ignored on the loopback door', async () => {
  const h = await startBoth();
  try {
    const viaTunnel = await rawRequest(h.tunnelPort, {
      path: '/m/auth/status',
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    });
    const tunnelBody = JSON.parse(viaTunnel.body);
    assert.equal(tunnelBody.trusted, true);
    assert.equal(tunnelBody.billedIp, '203.0.113.7', 'real client IP must survive the tunnel');

    const viaLoopback = await rawRequest(h.mainPort, {
      path: '/m/auth/status',
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    });
    const loopbackBody = JSON.parse(viaLoopback.body);
    assert.equal(loopbackBody.trusted, false);
    assert.notEqual(loopbackBody.billedIp, '203.0.113.7', 'a spoofed header must not choose the bucket');
  } finally {
    await h.listeners.close();
  }
});

test('rotating CF-Connecting-IP on the loopback door does NOT yield fresh buckets', async () => {
  // This is the attack the old code permitted: 25 requests, 25 claimed IPs,
  // 25 independent rate-limit buckets, lockout never trips.
  const h = await startBoth();
  try {
    const billed = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const res = await rawRequest(h.mainPort, {
        path: '/m/auth/status',
        headers: { 'CF-Connecting-IP': `198.51.100.${i}` },
      });
      billed.add(JSON.parse(res.body).billedIp);
    }
    assert.equal(
      billed.size,
      1,
      `25 spoofed client IPs must all bill one bucket, got ${[...billed].join(', ')}`,
    );
  } finally {
    await h.listeners.close();
  }
});

test('the kill switch falls back to a single shared listener', async () => {
  const prior = process.env.CLEMENTINE_MOBILE_INGRESS;
  process.env.CLEMENTINE_MOBILE_INGRESS = 'shared';
  try {
    const app = express();
    app.use(classifyIngress);
    app.get('/api/status', (_req, res) => { res.json({ ok: true }); });
    const listeners = await startIngressListeners(app, { host: '127.0.0.1', port: 0 });
    try {
      assert.equal(listeners.tunnel, null);
      assert.equal(listeners.tunnelPort, null);
    } finally {
      await listeners.close();
    }
  } finally {
    if (prior === undefined) delete process.env.CLEMENTINE_MOBILE_INGRESS;
    else process.env.CLEMENTINE_MOBILE_INGRESS = prior;
  }
});

test('a failed main bind rejects and leaves no listeners behind', async () => {
  const app = express();
  await assert.rejects(
    () => startIngressListeners(app, {
      host: '127.0.0.1',
      port: 0,
      guardMainBind: () => { throw new Error('Refusing LAN webhook bind'); },
    }),
    /Refusing LAN webhook bind/,
  );
});

// ─── direct-app door (pinned TLS for the iOS app) ───────────────────

async function startWithDirectApp() {
  const { ensureMobileTlsIdentity } = await import('./mobile-tls.js');
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-direct-tls-'));
  const identity = ensureMobileTlsIdentity({ stateDir });

  const app = express();
  app.use(classifyIngress);
  app.use(restrictTunnelIngressToMobile);
  const report = (req: express.Request, res: express.Response): void => {
    res.json({
      ingress: req.clemIngress,
      trusted: trustsForwardedClientIp(req),
      billedIp: trustsForwardedClientIp(req) && typeof req.headers['cf-connecting-ip'] === 'string'
        ? req.headers['cf-connecting-ip']
        : req.socket.remoteAddress,
    });
  };
  app.get('/api/status', report);
  app.get('/m/auth/status', report);

  const listeners = await startIngressListeners(app, {
    host: '127.0.0.1',
    port: 0,
    // Loopback in tests: the trust property under test is the socket marker
    // and the served certificate, neither of which depends on the interface.
    directApp: { port: 0, keyPem: identity.keyPem, certPem: identity.certPem, host: '127.0.0.1' },
  });
  return { listeners, identity, stateDir, directAppPort: listeners.directAppPort! };
}

function rawTlsRequest(
  port: number,
  opts: { path: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string; peerCertDer: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: opts.path,
        headers: opts.headers,
        // The app trusts by fingerprint, not by chain — mirror that here.
        rejectUnauthorized: false,
      },
      (res) => {
        const socket = res.socket as import('node:tls').TLSSocket;
        const peerCertDer = socket.getPeerCertificate().raw;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, peerCertDer }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('direct-app door serves the pinned certificate and only the mobile surface', async () => {
  const h = await startWithDirectApp();
  try {
    const mobile = await rawTlsRequest(h.directAppPort, { path: '/m/auth/status' });
    assert.equal(mobile.status, 200);
    assert.equal(JSON.parse(mobile.body).ingress, 'direct-app');

    // The certificate the phone sees hashes to exactly the QR fingerprint.
    const seenFp = createHash('sha256').update(mobile.peerCertDer).digest('base64url');
    assert.equal(seenFp, h.identity.fingerprint);

    const admin = await rawTlsRequest(h.directAppPort, { path: '/api/status' });
    assert.equal(admin.status, 404, 'the admin API must not be reachable over the direct-app door');
  } finally {
    await h.listeners.close();
    rmSync(h.stateDir, { recursive: true, force: true });
  }
});

test('direct-app door ignores CF-Connecting-IP — the socket peer is the client', async () => {
  const h = await startWithDirectApp();
  try {
    const res = await rawTlsRequest(h.directAppPort, {
      path: '/m/auth/status',
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    });
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.trusted, false);
    assert.notEqual(parsed.billedIp, '203.0.113.7');
  } finally {
    await h.listeners.close();
    rmSync(h.stateDir, { recursive: true, force: true });
  }
});

test('omitting directApp keeps the door closed', async () => {
  const app = express();
  app.use(classifyIngress);
  const listeners = await startIngressListeners(app, { host: '127.0.0.1', port: 0 });
  try {
    assert.equal(listeners.directApp, null);
    assert.equal(listeners.directAppPort, null);
  } finally {
    await listeners.close();
  }
});
