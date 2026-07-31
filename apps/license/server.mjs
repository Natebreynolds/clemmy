/**
 * Clementine license server.
 *
 * Issues short-lived Ed25519-signed leases that installs verify offline. See
 * lease.mjs for why that shape, and routes-public.mjs for the status-code
 * contract that keeps an outage here from locking out paying customers.
 *
 * Env:
 *   DATABASE_URL                     Postgres (Railway provides it)
 *   LICENSE_SIGNING_KEY_PEM          Ed25519 private key, PKCS#8 PEM (\n escaped ok)
 *   LICENSE_SIGNING_KID              key id baked into clients, e.g. "k1"
 *   LICENSE_MACHINE_PEPPER           pepper for install-id hashing
 *   LICENSE_ADMIN_BOOTSTRAP_TOKEN    first admin bearer token
 *   RELAY_SERVICE_TOKEN              lets the relay read /v1/revocations
 *   PORT                             Railway provides it
 */
import express from 'express';
import { createPool, migrate } from './db.mjs';
import { publicRoutes } from './routes-public.mjs';
import { adminRoutes } from './routes-admin.mjs';
import { publicKeyBase64 } from './lease.mjs';

const log = console;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`license: ${name} is required`);
  return value;
}

const signingKeyPem = required('LICENSE_SIGNING_KEY_PEM').replace(/\\n/g, '\n');
const kid = process.env.LICENSE_SIGNING_KID || 'k1';
const pepper = required('LICENSE_MACHINE_PEPPER');
const bootstrapToken = process.env.LICENSE_ADMIN_BOOTSTRAP_TOKEN || '';
const serviceToken = process.env.RELAY_SERVICE_TOKEN || '';
const port = Number(process.env.PORT || 8080);

const pool = createPool(required('DATABASE_URL'));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

/**
 * Per-IP rate limit on the public surface. The threat is enumeration and
 * noise, not brute force — guessing a 160-bit key is not a thing — so the
 * budget is generous enough that a flaky client retrying never trips it.
 */
const hits = new Map();
app.use('/v1', (req, res, next) => {
  if (req.path === '/health') return next();
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const window = 60_000;
  const entry = hits.get(ip);
  if (!entry || now - entry.start > window) {
    hits.set(ip, { start: now, count: 1 });
    return next();
  }
  entry.count += 1;
  if (entry.count > 120) {
    // 429 is in the "our problem" bucket for clients: they keep their lease
    // and retry, which is exactly right for a rate limit.
    return res.status(429).json({ error: 'rate_limited', message: 'Too many requests — try again shortly.' });
  }
  next();
});
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [ip, entry] of hits) if (entry.start < cutoff) hits.delete(ip);
}, 60_000).unref?.();

app.use(publicRoutes({ pool, signingKeyPem, kid, pepper, serviceToken, log }));
app.use('/v1/admin', adminRoutes({ pool, bootstrapToken, log }));

// Convenience only. Clients trust their BAKED public keys and must never fetch
// one from here — a fetched key would turn a server compromise into a client
// compromise.
app.get('/v1/jwks', (_req, res) => {
  res.json({ keys: [{ kid, alg: 'Ed25519', publicKeyBase64: publicKeyBase64(signingKeyPem) }] });
});

// Any unhandled error must land in the "our problem" bucket, never in the
// bucket that means "you are not licensed".
app.use((err, _req, res, _next) => {
  log.error('license: unhandled error', err);
  res.status(500).json({ error: 'server_error', message: 'Something went wrong here — your license is unaffected.' });
});

migrate(pool, log)
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      log.info(`license: listening on :${port} (kid=${kid})`);
      log.info(`license: public key ${publicKeyBase64(signingKeyPem)}`);
    });
  })
  .catch((err) => {
    log.error('license: migration failed', err);
    process.exit(1);
  });
