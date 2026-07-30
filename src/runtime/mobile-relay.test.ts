/**
 * Run: npx tsx --test src/runtime/mobile-relay.test.ts
 *
 * Pins the relay's core security property END TO END: a TLS client that
 * connects through the relay (SNI-routed, spliced into the daemon's outbound
 * tunnel) completes its handshake against the DAEMON's certificate — proving
 * the relay never terminates the phone leg. Plus: framing codec, SNI parsing
 * against a real ClientHello, TOFU claim enforcement, relay-door route
 * restrictions, and client-IP restoration for rate limiting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-relay-test-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { encodeFrame, frameReader, FRAME, startMobileRelayClient, ensureRelayAuthToken, relayPairId, relayConfigFromEnv } =
  await import('./mobile-relay.js');
const { startRelay, parseSni } = await import('../../apps/relay/server.mjs') as {
  startRelay: (opts: Record<string, unknown>) => Promise<{ port: number; tunnelCount(): number; close(): Promise<void> }>;
  parseSni: (b: Buffer) => { sni?: string | null; need?: boolean; bad?: boolean };
};
const { ensureMobileTlsIdentity, certFingerprint } = await import('./mobile-tls.js');
const { classifyIngress, restrictDirectAppIngressToMobile, startRelayInternalListener } =
  await import('./mobile-ingress.js');
const { relayClientIp } = await import('./mobile-ingress.js');

test('mux frame codec roundtrips, including split and coalesced chunks', () => {
  const read = frameReader();
  const a = encodeFrame(FRAME.OPEN, 7, JSON.stringify({ ip: '203.0.113.9' }));
  const b = encodeFrame(FRAME.DATA, 7, Buffer.from('hello world'));
  const c = encodeFrame(FRAME.CLOSE, 7);
  const wire = Buffer.concat([a, b, c]);
  // Feed byte-by-byte to prove incremental parsing never loses framing.
  const frames = [] as Array<{ type: number; streamId: number; payload: Buffer }>;
  for (let i = 0; i < wire.length; i += 3) {
    frames.push(...read(wire.subarray(i, Math.min(i + 3, wire.length))));
  }
  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, FRAME.OPEN);
  assert.equal(JSON.parse(frames[0].payload.toString()).ip, '203.0.113.9');
  assert.equal(frames[1].payload.toString(), 'hello world');
  assert.equal(frames[2].type, FRAME.CLOSE);
  assert.equal(frames[2].streamId, 7);
});

test('parseSni extracts the servername from a real Node-generated ClientHello', async () => {
  // Capture the exact bytes tls.connect writes — no synthetic fixtures.
  const captured: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => captured.push(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const client = tls.connect({ host: '127.0.0.1', port, servername: 'abc123def4567890.r.example.com', rejectUnauthorized: false });
  client.on('error', () => { /* handshake never completes; expected */ });
  await new Promise((resolve) => setTimeout(resolve, 300));
  client.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const parsed = parseSni(Buffer.concat(captured));
  assert.equal(parsed.sni, 'abc123def4567890.r.example.com');
});

test('relay E2E: pinned TLS passes through untouched; routes and IP survive; pairing stays LAN-only', async () => {
  const daemonTlsDir = path.join(TMP_ROOT, 'daemon-a');
  const relayTlsDir = path.join(TMP_ROOT, 'relay-identity');
  const daemonIdentity = ensureMobileTlsIdentity({ stateDir: daemonTlsDir });
  const relayIdentity = ensureMobileTlsIdentity({ stateDir: relayTlsDir });

  // A minimal daemon app with the real ingress middlewares.
  const app = express();
  app.use(classifyIngress);
  app.use(restrictDirectAppIngressToMobile);
  app.get('/m/ping', (req, res) => {
    res.json({ ok: true, ingress: req.clemIngress, clientIp: relayClientIp(req) ?? null });
  });
  app.post('/m/auth/pair', (_req, res) => res.json({ paired: true }));
  app.get('/admin', (_req, res) => res.json({ admin: true }));

  const relayListener = await startRelayInternalListener(app, {
    keyPem: daemonIdentity.keyPem,
    certPem: daemonIdentity.certPem,
  });

  const relay = await startRelay({
    port: 0,
    baseDomain: 'r.test.local',
    tlsKeyPem: relayIdentity.keyPem,
    tlsCertPem: relayIdentity.certPem,
    dataDir: path.join(TMP_ROOT, 'relay-data'),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const pairId = relayPairId(daemonIdentity.certPem);
  const authToken = ensureRelayAuthToken(path.join(TMP_ROOT, 'daemon-a-state'));
  const client = startMobileRelayClient({
    config: { url: `127.0.0.1:${relay.port}`, baseDomain: 'r.test.local', relayCertFp: relayIdentity.fingerprint },
    pairId,
    authToken,
    localPort: relayListener.port,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  try {
    // Wait for the tunnel to register.
    for (let i = 0; i < 100 && !client.connected(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(client.connected(), 'tunnel must register with the relay');
    assert.equal(relay.tunnelCount(), 1);

    // Phone leg: TLS through the relay, SNI = <pairId>.r.test.local.
    const request = (reqPath: string, method = 'GET'): Promise<{ status: number; body: string; peerFp: string }> =>
      new Promise((resolve, reject) => {
        const phone = tls.connect({
          host: '127.0.0.1',
          port: relay.port,
          servername: `${pairId}.r.test.local`,
          rejectUnauthorized: false,
        });
        const chunks: Buffer[] = [];
        phone.on('secureConnect', () => {
          const peerDer = phone.getPeerCertificate().raw;
          const peerFp = createHash('sha256').update(peerDer).digest('base64url');
          phone.write(`${method} ${reqPath} HTTP/1.1\r\nHost: ${pairId}.r.test.local\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
          phone.on('data', (c) => chunks.push(c));
          phone.on('close', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = Number(raw.split(' ')[1] ?? 0);
            const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
            resolve({ status, body, peerFp });
          });
        });
        phone.on('error', reject);
      });

    // THE pin: the certificate the phone sees through the relay is the
    // DAEMON's, not the relay's — the relay never terminated our TLS.
    const ping = await request('/m/ping');
    assert.equal(ping.peerFp, daemonIdentity.fingerprint, 'peer cert through relay must be the daemon cert');
    assert.notEqual(ping.peerFp, relayIdentity.fingerprint);
    assert.equal(ping.status, 200);
    const pingBody = JSON.parse(ping.body) as { ingress: string; clientIp: string | null };
    assert.equal(pingBody.ingress, 'relay', 'relay-fed requests classify as relay ingress');
    assert.equal(pingBody.clientIp, '127.0.0.1', 'the relay-observed client IP is restored for rate limiting');

    // Route restrictions on the relay door.
    const admin = await request('/admin');
    assert.equal(admin.status, 404, 'non-/m/* is refused on the relay door');
    const pair = await request('/m/auth/pair', 'POST');
    assert.equal(pair.status, 404, 'pairing is refused over the relay — it is a LAN ceremony');

    // TOFU: a second daemon claiming the same pairId with a different token
    // is refused.
    const impostor: { refused: boolean } = await new Promise((resolve, reject) => {
      const sock = tls.connect({ host: '127.0.0.1', port: relay.port, servername: 'tunnel.r.test.local', rejectUnauthorized: false });
      const feed = frameReader();
      sock.on('secureConnect', () => {
        sock.write(encodeFrame(FRAME.HELLO, 0, JSON.stringify({ pairId, authToken: 'wrong-token-wrong-token', proto: 1 })));
      });
      sock.on('data', (chunk) => {
        for (const frame of feed(chunk)) {
          if (frame.type === FRAME.HELLO_ERR) { sock.destroy(); resolve({ refused: true }); return; }
          if (frame.type === FRAME.HELLO_OK) { sock.destroy(); resolve({ refused: false }); return; }
        }
      });
      sock.on('error', reject);
    });
    assert.equal(impostor.refused, true, 'a wrong auth token must not steal a claimed pairId');
  } finally {
    client.stop();
    await relay.close();
    await relayListener.close();
  }
});

test('relayConfigFromEnv: kill switch and completeness', () => {
  assert.equal(relayConfigFromEnv({}), null, 'unconfigured = LAN-only');
  assert.equal(relayConfigFromEnv({ CLEMENTINE_RELAY_URL: 'x:1' }), null, 'partial config = LAN-only');
  assert.equal(
    relayConfigFromEnv({
      CLEMENTINE_MOBILE_RELAY: 'off',
      CLEMENTINE_RELAY_URL: 'relay.example:30123',
      CLEMENTINE_RELAY_BASE: 'r.example.com',
      CLEMENTINE_RELAY_CERT_FP: 'fp',
    }),
    null,
    'kill switch wins over full config',
  );
  const full = relayConfigFromEnv({
    CLEMENTINE_RELAY_URL: 'relay.example:30123',
    CLEMENTINE_RELAY_BASE: 'r.example.com',
    CLEMENTINE_RELAY_CERT_FP: 'fp',
  });
  assert.deepEqual(full, { url: 'relay.example:30123', baseDomain: 'r.example.com', relayCertFp: 'fp' });
});

test('relayPairId is DNS-safe lowercase hex derived from the cert', () => {
  const identity = ensureMobileTlsIdentity({ stateDir: path.join(TMP_ROOT, 'daemon-b') });
  const pairId = relayPairId(identity.certPem);
  assert.match(pairId, /^[a-f0-9]{16}$/);
  assert.notEqual(pairId, relayPairId(ensureMobileTlsIdentity({ stateDir: path.join(TMP_ROOT, 'daemon-c') }).certPem));
  assert.equal(certFingerprint(identity.certPem).length > 0, true);
});
