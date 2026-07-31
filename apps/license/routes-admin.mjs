/**
 * Admin CRUD. Bearer-token only — the hosted admin UI in apps/web holds the
 * token server-side and proxies, so it never reaches a browser.
 *
 * A generated key is returned exactly once, at creation. We store only its
 * hash, so "resend my key" is deliberately impossible; the answer is to issue
 * a new one and revoke the old.
 */
import express from 'express';
import { generateLicenseKey, hashLicenseKey, hashToken, keyDisplay, safeEqual } from './keys.mjs';
import { audit } from './db.mjs';

export function adminRoutes({ pool, bootstrapToken, log }) {
  const router = express.Router();

  router.use(async (req, res, next) => {
    const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!presented) return res.status(401).json({ error: 'unauthorized' });

    // Bootstrap token works until a DB token exists, so the very first key can
    // be issued without a chicken-and-egg problem.
    if (bootstrapToken && safeEqual(presented, bootstrapToken)) {
      req.adminActor = 'bootstrap';
      return next();
    }
    const { rows } = await pool.query(
      'SELECT id, label FROM admin_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(presented)],
    );
    if (!rows[0]) return res.status(401).json({ error: 'unauthorized' });
    await pool.query('UPDATE admin_tokens SET last_used_at = now() WHERE id = $1', [rows[0].id]);
    req.adminActor = rows[0].label;
    next();
  });

  router.get('/tenants', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT t.id, t.slug, t.name,
              (SELECT json_agg(json_build_object('id',p.id,'slug',p.slug,'displayName',p.display_name,'enforce',p.enforce))
                 FROM products p WHERE p.tenant_id = t.id) AS products
         FROM tenants t ORDER BY t.slug`,
    );
    res.json({ tenants: rows });
  });

  router.post('/tenants', async (req, res) => {
    const { slug, name, productSlug, productName } = req.body ?? {};
    if (!slug || !name) return res.status(400).json({ error: 'bad_request' });
    const t = await pool.query(
      'INSERT INTO tenants (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING *',
      [slug, name],
    );
    let product = null;
    if (productSlug) {
      const p = await pool.query(
        `INSERT INTO products (tenant_id, slug, display_name) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, slug) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING *`,
        [t.rows[0].id, productSlug, productName ?? productSlug],
      );
      product = p.rows[0];
    }
    res.json({ tenant: t.rows[0], product });
  });

  /** Flips enforcement for an entire product. The kill switch. */
  router.patch('/products/:id', async (req, res) => {
    const fields = [];
    const values = [];
    for (const [col, val] of [
      ['enforce', req.body?.enforce],
      ['lease_ttl_seconds', req.body?.leaseTtlSeconds],
      ['grace_seconds', req.body?.graceSeconds],
    ]) {
      if (val !== undefined) { values.push(val); fields.push(`${col} = $${values.length}`); }
    }
    if (!fields.length) return res.status(400).json({ error: 'nothing_to_update' });
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values,
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(pool, { actor: req.adminActor, action: 'product.update', subjectType: 'product', subjectId: req.params.id, meta: req.body ?? {} });
    log.warn?.(`license: product ${rows[0].slug} enforce=${rows[0].enforce}`);
    res.json({ product: rows[0] });
  });

  router.get('/licenses', async (req, res) => {
    const q = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    const status = req.query.status ? String(req.query.status) : null;
    const { rows } = await pool.query(
      `SELECT l.id, l.key_prefix, l.key_last4, l.plan, l.seat_limit, l.status,
              l.customer_email, l.note, l.expires_at, l.created_at, l.revoked_at,
              t.slug AS tenant, p.slug AS product,
              (SELECT count(*)::int FROM activations a
                WHERE a.license_id = l.id AND a.status = 'active') AS seats_used,
              (SELECT max(a.last_seen_at) FROM activations a WHERE a.license_id = l.id) AS last_seen_at
         FROM licenses l
         JOIN tenants t ON t.id = l.tenant_id
         JOIN products p ON p.id = l.product_id
        WHERE ($1::text IS NULL OR lower(coalesce(l.customer_email,'') || ' ' || coalesce(l.note,'') || ' ' || l.key_last4) LIKE $1)
          AND ($2::text IS NULL OR l.status = $2)
        ORDER BY l.created_at DESC LIMIT 200`,
      [q, status],
    );
    res.json({ licenses: rows });
  });

  router.get('/licenses/:id', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT l.*, t.slug AS tenant, p.slug AS product FROM licenses l
         JOIN tenants t ON t.id = l.tenant_id JOIN products p ON p.id = l.product_id
        WHERE l.id = $1`, [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const acts = await pool.query(
      `SELECT id, pair_id, app_version, os, arch, status, first_seen_at, last_seen_at, blocked_reason
         FROM activations WHERE license_id = $1 ORDER BY last_seen_at DESC`, [req.params.id],
    );
    const { key_hash, ...license } = rows[0];
    res.json({ license, activations: acts.rows });
  });

  /** The key is in this response and nowhere else, ever again. */
  router.post('/licenses', async (req, res) => {
    const { tenant, product, plan, seatLimit, customerEmail, note, expiresAt, features } = req.body ?? {};
    const ctx = await pool.query(
      `SELECT p.id AS product_id, t.id AS tenant_id, t.slug AS tenant_slug
         FROM products p JOIN tenants t ON t.id = p.tenant_id
        WHERE t.slug = $1 AND p.slug = $2`,
      [tenant, product],
    );
    if (!ctx.rows[0]) return res.status(400).json({ error: 'unknown_product', message: 'No such tenant/product.' });

    const key = generateLicenseKey({ tenantSlug: ctx.rows[0].tenant_slug });
    const display = keyDisplay(key);
    const { rows } = await pool.query(
      `INSERT INTO licenses (tenant_id, product_id, key_hash, key_prefix, key_last4, plan,
                             features, seat_limit, customer_email, note, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        ctx.rows[0].tenant_id, ctx.rows[0].product_id, hashLicenseKey(key),
        display.prefix, display.last4, plan ?? 'pro',
        JSON.stringify(features ?? []), seatLimit ?? 1,
        customerEmail ?? null, note ?? null, expiresAt ?? null, req.adminActor,
      ],
    );
    await audit(pool, {
      actor: req.adminActor, action: 'license.create', subjectType: 'license', subjectId: rows[0].id,
      meta: { plan: rows[0].plan, seatLimit: rows[0].seat_limit, customerEmail: customerEmail ?? null },
    });
    const { key_hash, ...license } = rows[0];
    res.status(201).json({ license, key });
  });

  router.post('/licenses/:id/revoke', async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE licenses SET status = 'revoked', revoked_at = now(), revoked_reason = $2
        WHERE id = $1 RETURNING id, status`,
      [req.params.id, req.body?.reason ?? null],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(pool, { actor: req.adminActor, action: 'license.revoke', subjectType: 'license', subjectId: req.params.id, meta: { reason: req.body?.reason ?? null } });
    res.json({ license: rows[0] });
  });

  router.post('/licenses/:id/restore', async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE licenses SET status = 'active', revoked_at = NULL, revoked_reason = NULL
        WHERE id = $1 RETURNING id, status`, [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(pool, { actor: req.adminActor, action: 'license.restore', subjectType: 'license', subjectId: req.params.id, meta: {} });
    res.json({ license: rows[0] });
  });

  router.patch('/licenses/:id', async (req, res) => {
    const fields = [];
    const values = [];
    for (const [col, val] of [
      ['plan', req.body?.plan], ['seat_limit', req.body?.seatLimit],
      ['customer_email', req.body?.customerEmail], ['note', req.body?.note],
      ['expires_at', req.body?.expiresAt], ['status', req.body?.status],
    ]) {
      if (val !== undefined) { values.push(val); fields.push(`${col} = $${values.length}`); }
    }
    if (!fields.length) return res.status(400).json({ error: 'nothing_to_update' });
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE licenses SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING id`, values,
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(pool, { actor: req.adminActor, action: 'license.update', subjectType: 'license', subjectId: req.params.id, meta: req.body ?? {} });
    res.json({ ok: true });
  });

  router.post('/activations/:id/:action', async (req, res) => {
    const { action } = req.params;
    if (!['release', 'block', 'unblock'].includes(action)) return res.status(400).json({ error: 'bad_action' });
    const next = action === 'release' ? 'released' : action === 'block' ? 'blocked' : 'active';
    const { rows } = await pool.query(
      `UPDATE activations SET status = $2, blocked_reason = $3,
              released_at = CASE WHEN $2 = 'released' THEN now() ELSE released_at END
        WHERE id = $1 RETURNING id, status`,
      [req.params.id, next, action === 'block' ? (req.body?.reason ?? 'Blocked by admin') : null],
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await audit(pool, { actor: req.adminActor, action: `activation.${action}`, subjectType: 'activation', subjectId: req.params.id, meta: {} });
    res.json({ activation: rows[0] });
  });

  router.get('/audit', async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY at DESC LIMIT 200');
    res.json({ entries: rows });
  });

  return router;
}
