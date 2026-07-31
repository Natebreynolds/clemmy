/**
 * What installs talk to.
 *
 * The status codes here are a contract, not decoration. Because the product is
 * unusable without a license, the client must be able to tell "you are not
 * licensed" apart from "I could not reach the server", and only this server can
 * make that distinction unambiguous:
 *
 *   200         → licensed, here is a fresh lease
 *   401 / 403   → NOT licensed. The only answer that may ever lock a user out.
 *   402         → licensed, but out of seats (actionable, distinct message)
 *   429 / 5xx   → our problem. The client keeps its cached lease and retries.
 *
 * Anything unexpected must fall into the last bucket. A bug that returns 500
 * costs a retry; a bug that returns 403 locks out a paying customer.
 */
import express from 'express';
import { buildLeasePayload, signLease } from './lease.mjs';
import { hashLicenseKey, hashMachineId, parseLicenseKey } from './keys.mjs';
import { audit } from './db.mjs';

const MAX_SEAT_IDLE_DAYS = 60;

export function publicRoutes({ pool, signingKeyPem, kid, pepper, serviceToken, log }) {
  const router = express.Router();

  /** Loads license + product + tenant by key, or null. */
  async function loadByKey(licenseKey) {
    const parsed = parseLicenseKey(licenseKey);
    if (!parsed) return null;
    const { rows } = await pool.query(
      `SELECT l.*, p.slug AS product_slug, p.lease_ttl_seconds, p.grace_seconds, p.enforce,
              t.slug AS tenant_slug
         FROM licenses l
         JOIN products p ON p.id = l.product_id
         JOIN tenants  t ON t.id = l.tenant_id
        WHERE l.key_hash = $1`,
      [hashLicenseKey(licenseKey)],
    );
    return rows[0] ?? null;
  }

  /** The single place that decides "is this license usable right now". */
  function licenseRefusal(lic) {
    if (!lic) return { status: 401, code: 'invalid_key', message: 'That license key is not recognized.' };
    if (lic.status === 'revoked') {
      return { status: 403, code: 'license_revoked', message: lic.revoked_reason || 'This license has been revoked.' };
    }
    if (lic.status === 'suspended') {
      return { status: 403, code: 'license_suspended', message: 'This license is suspended — check your billing.' };
    }
    if (lic.expires_at && new Date(lic.expires_at).getTime() < Date.now()) {
      return { status: 403, code: 'license_expired', message: 'This license has expired.' };
    }
    return null;
  }

  async function issueLease(lic, activation) {
    const payload = buildLeasePayload({
      tenant: lic.tenant_slug,
      product: lic.product_slug,
      licenseId: String(lic.id),
      activationId: String(activation.id),
      machineIdHashHex: activation.machine_id_hash.toString('hex'),
      pairId: activation.pair_id,
      plan: lic.plan,
      features: lic.features,
      seatUsed: activation.seat_used,
      seatLimit: lic.seat_limit,
      enforce: lic.enforce,
      leaseTtlSeconds: lic.lease_ttl_seconds,
      graceSeconds: lic.grace_seconds,
    });
    const lease = signLease(payload, { privateKeyPem: signingKeyPem, kid });
    await pool.query(
      'INSERT INTO lease_issuances (activation_id, jti, kid, expires_at) VALUES ($1,$2,$3,to_timestamp($4))',
      [activation.id, payload.jti, kid, payload.exp],
    );
    return { lease, payload };
  }

  async function countActiveSeats(licenseId) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM activations
        WHERE license_id = $1 AND status = 'active'
          AND last_seen_at > now() - ($2 || ' days')::interval`,
      [licenseId, MAX_SEAT_IDLE_DAYS],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * First contact: bind this install to a seat and hand back a lease.
   *
   * `dryRun` validates the key WITHOUT consuming a seat — the desktop app's
   * "check this key before saving it" path uses it. A dry run that quietly
   * burned a seat would strand users whose save then failed.
   */
  router.post('/v1/activate', async (req, res) => {
    const { licenseKey, machineId, appVersion, os, arch, hostnameHint, pairId, product, dryRun } = req.body ?? {};
    if (!licenseKey || (!dryRun && !machineId)) {
      return res.status(400).json({ error: 'bad_request', message: 'licenseKey and machineId are required.' });
    }
    const lic = await loadByKey(licenseKey);
    const refusal = licenseRefusal(lic);
    if (refusal) {
      return res.status(refusal.status).json({ error: refusal.code, message: refusal.message });
    }
    if (product && product !== lic.product_slug) {
      return res.status(403).json({ error: 'wrong_product', message: 'That key belongs to a different product.' });
    }

    if (dryRun) {
      const used = await countActiveSeats(lic.id);
      return res.json({ ok: true, plan: lic.plan, seat: { used, limit: lic.seat_limit } });
    }

    const midHash = hashMachineId(machineId, pepper);
    const existing = await pool.query(
      'SELECT * FROM activations WHERE license_id = $1 AND machine_id_hash = $2',
      [lic.id, midHash],
    );

    if (existing.rows[0]?.status === 'blocked') {
      return res.status(403).json({
        error: 'activation_blocked',
        message: existing.rows[0].blocked_reason || 'This device has been blocked.',
      });
    }

    // Seats are counted, not reserved: an install that already holds one is
    // renewing, not taking another.
    if (!existing.rows[0]) {
      const used = await countActiveSeats(lic.id);
      if (used >= lic.seat_limit) {
        return res.status(402).json({
          error: 'seat_limit_reached',
          message: `This license covers ${lic.seat_limit} device${lic.seat_limit === 1 ? '' : 's'} and they are all in use. Release one, or ask for more seats.`,
          seat: { used, limit: lic.seat_limit },
        });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO activations (license_id, machine_id_hash, pair_id, app_version, os, arch, hostname_hint, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
       ON CONFLICT (license_id, machine_id_hash) DO UPDATE
            SET status = 'active', released_at = NULL, last_seen_at = now(),
                pair_id = COALESCE(EXCLUDED.pair_id, activations.pair_id),
                app_version = EXCLUDED.app_version, os = EXCLUDED.os, arch = EXCLUDED.arch
         RETURNING *`,
      [lic.id, midHash, pairId ?? null, appVersion ?? null, os ?? null, arch ?? null, hostnameHint ?? null],
    );
    const activation = rows[0];
    activation.seat_used = await countActiveSeats(lic.id);

    const { lease, payload } = await issueLease(lic, activation);
    await audit(pool, {
      actor: 'install', action: 'activate', subjectType: 'license', subjectId: lic.id,
      meta: { activationId: activation.id, appVersion, os, arch },
    });
    log.info?.(`license: activated license=${lic.id} activation=${activation.id}`);
    res.json({
      lease,
      activationId: String(activation.id),
      leaseExpiresAt: new Date(payload.exp * 1000).toISOString(),
      plan: lic.plan,
      seat: { used: activation.seat_used, limit: lic.seat_limit },
    });
  });

  /** Renewal. Same checks, no seat accounting — this install already has one. */
  router.post('/v1/lease', async (req, res) => {
    const { licenseKey, machineId, activationId, appVersion, pairId } = req.body ?? {};
    if (!licenseKey || !machineId) {
      return res.status(400).json({ error: 'bad_request', message: 'licenseKey and machineId are required.' });
    }
    const lic = await loadByKey(licenseKey);
    const refusal = licenseRefusal(lic);
    if (refusal) return res.status(refusal.status).json({ error: refusal.code, message: refusal.message });

    const midHash = hashMachineId(machineId, pepper);
    const { rows } = await pool.query(
      `UPDATE activations
          SET last_seen_at = now(),
              pair_id = COALESCE($3, pair_id),
              app_version = COALESCE($4, app_version)
        WHERE license_id = $1 AND machine_id_hash = $2 AND status = 'active'
        RETURNING *`,
      [lic.id, midHash, pairId ?? null, appVersion ?? null],
    );
    const activation = rows[0];
    if (!activation) {
      // Seat was released or blocked elsewhere; the client should re-activate,
      // which re-runs seat accounting.
      return res.status(403).json({ error: 'activation_not_found', message: 'This device is no longer activated. Re-enter your key.' });
    }
    if (activationId && String(activation.id) !== String(activationId)) {
      log.warn?.(`license: activationId mismatch for license=${lic.id}`);
    }
    activation.seat_used = await countActiveSeats(lic.id);
    const { lease, payload } = await issueLease(lic, activation);
    res.json({
      lease,
      activationId: String(activation.id),
      leaseExpiresAt: new Date(payload.exp * 1000).toISOString(),
      plan: lic.plan,
      seat: { used: activation.seat_used, limit: lic.seat_limit },
    });
  });

  /** Frees a seat so the user can move to a new machine without support. */
  router.post('/v1/deactivate', async (req, res) => {
    const { licenseKey, machineId } = req.body ?? {};
    const lic = await loadByKey(licenseKey);
    if (!lic) return res.status(401).json({ error: 'invalid_key' });
    await pool.query(
      `UPDATE activations SET status = 'released', released_at = now()
        WHERE license_id = $1 AND machine_id_hash = $2`,
      [lic.id, hashMachineId(machineId, pepper)],
    );
    await audit(pool, { actor: 'install', action: 'deactivate', subjectType: 'license', subjectId: lic.id, meta: {} });
    res.json({ ok: true });
  });

  /**
   * The relay's revocation feed. Small by construction: only things that were
   * revoked or blocked, so the relay keeps an in-memory set and never needs a
   * database of its own.
   */
  router.get('/v1/revocations', async (req, res) => {
    const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!serviceToken || presented !== serviceToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
    const revoked = await pool.query(
      `SELECT id FROM licenses
        WHERE status IN ('revoked','suspended')
          AND COALESCE(revoked_at, created_at) > $1`,
      [Number.isFinite(since.getTime()) ? since : new Date(0)],
    );
    const blocked = await pool.query(
      `SELECT id FROM activations WHERE status = 'blocked'`,
    );
    res.json({
      revokedLicenseIds: revoked.rows.map((r) => String(r.id)),
      blockedActivationIds: blocked.rows.map((r) => String(r.id)),
      now: new Date().toISOString(),
    });
  });

  router.get('/v1/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  return router;
}
