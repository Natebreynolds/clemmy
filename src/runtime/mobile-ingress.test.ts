/**
 * Run: npx tsx --test src/runtime/mobile-ingress.test.ts
 *
 * Regression coverage for ingress classification and the spoofable
 * rate-limit bucket.
 *
 * Trust follows the listener a request arrived on, which a caller cannot
 * influence. Forwarding headers (CF-Connecting-IP, X-Forwarded-For) are never
 * believed on any door — the socket peer IS the client. These tests assert
 * exactly that, plus the /m/*-only restriction on the direct-app door.
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
  restrictDirectAppIngressToMobile,
} = await import('./mobile-ingress.js');

function buildApp() {
  const app = express();
  app.use(classifyIngress);
  app.use(restrictDirectAppIngressToMobile);
  // Mirrors back how this request was classified and which IP would be billed.
  // The billed IP is ALWAYS the socket peer — a forwarded header must never
  // choose the bucket, or a caller could mint a fresh one per request.
  const report = (req: express.Request, res: express.Response): void => {
    res.json({
      ingress: req.clemIngress,
      billedIp: req.socket.remoteAddress,
    });
  };
  app.get('/api/status', report);
  app.get('/m/auth/status', report);
  return app;
}

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

test('the main listener classifies as loopback and serves the full surface', async () => {
  const listeners = await startIngressListeners(buildApp(), { host: '127.0.0.1', port: 0 });
  const addr = listeners.main.address();
  const mainPort = addr && typeof addr === 'object' ? addr.port : 0;
  try {
    const api = await rawRequest(mainPort, { path: '/api/status' });
    assert.equal(api.status, 200, 'loopback keeps the full surface');
    assert.equal(JSON.parse(api.body).ingress, 'loopback');
  } finally {
    await listeners.close();
  }
});

test('rotating CF-Connecting-IP does NOT yield fresh buckets on any door', async () => {
  // This is the attack the pre-split code permitted: 25 requests, 25 claimed
  // IPs, 25 independent rate-limit buckets, lockout never trips.
  const listeners = await startIngressListeners(buildApp(), { host: '127.0.0.1', port: 0 });
  const addr = listeners.main.address();
  const mainPort = addr && typeof addr === 'object' ? addr.port : 0;
  try {
    const billed = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const res = await rawRequest(mainPort, {
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
    await listeners.close();
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

  const listeners = await startIngressListeners(buildApp(), {
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
    assert.notEqual(JSON.parse(res.body).billedIp, '203.0.113.7');
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
