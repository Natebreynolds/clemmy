# License server — runbook

Issues the license keys and signed leases that activate Clementine installs.

**Read this first if something is on fire:** installs verify a **signed lease
offline**. This server being down does **not** lock anyone out. A desktop install
keeps working for roughly **17 days** without reaching this server (72h lease +
14d grace). Before you touch anything, confirm customers are actually affected —
usually they are not.

One real exception, below in [Blast radius](#blast-radius): phone access through
the relay does **not** get the 14-day grace.

---

## Contents

- [Is anything actually broken?](#is-anything-actually-broken)
- [Blast radius](#blast-radius)
- [The kill switch](#the-kill-switch)
- [Getting a database shell](#getting-a-database-shell)
- [Break-glass SQL](#break-glass-sql)
- [Symptoms → cause → fix](#symptoms--cause--fix)
- [Key rotation](#key-rotation)
- [Disaster recovery](#disaster-recovery)
- [Reference](#reference)

---

## Is anything actually broken?

```bash
curl -s https://license-production-f998.up.railway.app/v1/health
# {"ok":true}          → server and database are fine
# {"ok":false} + 503   → server is up, Postgres is not
# connection refused   → service is down
```

`/v1/health` is the only public route exempt from rate limiting, so it is always
safe to poll.

Then read the status codes clients are getting. They are a contract, not
decoration (`routes-public.mjs`):

| Code | Meaning | Locks the user out? |
| --- | --- | --- |
| 200 | Licensed, fresh lease issued | no |
| 401 / 403 | **Not licensed.** The only answers that may ever lock someone out | yes |
| 402 | Licensed but out of seats | no — actionable |
| 429 / 5xx | Our problem. Client keeps its cached lease and retries | no |

A bug that returns 500 costs a retry. A bug that returns 403 locks out a paying
customer. If you are unsure which bucket something belongs in, it belongs in the
last one.

## Blast radius

| Surface | Tolerance for this server being down | Why |
| --- | --- | --- |
| Desktop app | **~17 days** (72h lease TTL + 14d grace) | The daemon honours the lease's `grace` field |
| Relay / phone access | **~72h**, and only when `RELAY_REQUIRE_LICENSE=true` | The relay uses its own clock and **ignores client grace** — 5 min skew only |

The daemon wakes every ~6h (jittered) but only calls the network once the lease
is into its **final third** — the last 24h of a 72h lease. So a healthy install
actually contacts this server about **every two days**, not every six hours.
Console → Settings → License → **Check now** forces it immediately.

While `RELAY_REQUIRE_LICENSE` is unset or `false`, the relay allows connections
with no lease at all, so a licensing outage cannot affect phone access.

## The kill switch

Turns enforcement off for every install **without a client release**. `enforce`
rides inside the signed lease, so clients relax as they renew.

```sql
-- 1. Look before you leap: product slugs are unique per TENANT, not globally.
SELECT p.id, t.slug AS tenant, p.slug AS product, p.enforce,
       p.lease_ttl_seconds, p.grace_seconds
  FROM products p
  JOIN tenants t ON t.id = p.tenant_id
 ORDER BY t.slug, p.slug;

-- 2a. The blunt, safe form — stop enforcing everywhere.
UPDATE products SET enforce = false;

-- 2b. Or one product (replace the slugs with what step 1 printed).
UPDATE products SET enforce = false
 WHERE slug = 'desktop'
   AND tenant_id = (SELECT id FROM tenants WHERE slug = 'clementine');
```

**How fast it propagates — slower than you would guess.** An install picks up
the new value at its next *renewal*, and it does not renew until its lease is
into its final third. An install that renewed a minute ago will not call home
for roughly another 48 hours.

- Installs already in their renewal window: within ~6h.
- Typical: **up to ~2 days**.
- Outer bound: **72h**, the lease TTL.

There is no way to make it faster than the lease TTL. That is the same property
that makes outages survivable — you cannot have one without the other. If a
specific customer needs it now, have them hit **Check now** in the console.

**The matching switch for phone access** is on the `relay` service, not here:

```
RELAY_REQUIRE_LICENSE=false
```

Takes effect on relay restart. Set both if you are backing enforcement out
entirely.

## Getting a database shell

Everything below is break-glass. The hosted admin at `/admin` on the web app is
the normal path and does all of it with an audit trail; use psql when the admin
is down or the fix is not in the UI.

```bash
railway link                      # select project: clementine-relay
railway connect Postgres          # opens psql
```

If `railway connect` is unavailable (no CLI, no TTY):

```bash
railway variables --service Postgres     # copy DATABASE_PUBLIC_URL
psql "$DATABASE_PUBLIC_URL"
```

**At 2am, in this order:** run the `SELECT` first, confirm the row is the one
you mean, then run the `UPDATE`. Every `UPDATE` below is written with a `WHERE`.
An `UPDATE` without one hits every row. When in doubt:

```sql
BEGIN;
-- ... your UPDATE ...
-- check the row count, then:
COMMIT;   -- or ROLLBACK;
```

## Break-glass SQL

Verified against `migrations/001_init.sql`. Note there is **no `seats_used`
column** — seats are always counted from `activations`.

### Find a license

```sql
SELECT l.id, l.key_prefix, l.key_last4, l.plan, l.status, l.seat_limit,
       l.customer_email, l.note, l.expires_at, l.revoked_at, l.revoked_reason,
       t.slug AS tenant, p.slug AS product, p.enforce
  FROM licenses l
  JOIN tenants  t ON t.id = l.tenant_id
  JOIN products p ON p.id = l.product_id
 WHERE l.customer_email ILIKE '%alice@example.com%'
    OR l.key_last4 = 'Z4Q9'
 ORDER BY l.created_at DESC;
```

`key_last4` is the last 4 characters of the key's secret half — the part a
customer can read off their own screen. You cannot search by full key: only a
SHA-256 hash is stored.

### See its activations

```sql
SELECT id, status, app_version, os, arch, hostname_hint, pair_id,
       first_seen_at, last_seen_at, released_at, blocked_reason
  FROM activations
 WHERE license_id = 123
 ORDER BY last_seen_at DESC;
```

### Count active seats the way the server does

```sql
SELECT count(*)::int AS seats_used
  FROM activations
 WHERE license_id = 123
   AND status = 'active'
   AND last_seen_at > now() - interval '60 days';
```

The 60 days is `MAX_SEAT_IDLE_DAYS` in `routes-public.mjs`. An activation that
has not checked in for longer stops counting against the limit on its own, so a
customer who retired a laptop two months ago is not stuck.

### Free a seat a customer is stuck on

```sql
-- The specific one, once you have identified it above:
UPDATE activations
   SET status = 'released', released_at = now()
 WHERE id = 456
RETURNING id, hostname_hint, last_seen_at;

-- Or the least recently used active seat on the license:
UPDATE activations
   SET status = 'released', released_at = now()
 WHERE id = (SELECT id FROM activations
              WHERE license_id = 123 AND status = 'active'
              ORDER BY last_seen_at ASC
              LIMIT 1)
RETURNING id, hostname_hint, last_seen_at;
```

The machine reactivates and takes the seat back if it is still running — this
frees a seat, it does not evict anyone permanently. Use `status = 'blocked'`
with a `blocked_reason` for that.

### Revoke and un-revoke

```sql
-- Revoke. The message is shown to the customer verbatim, so write it for them.
UPDATE licenses
   SET status = 'revoked', revoked_at = now(),
       revoked_reason = 'Refunded on 12 Jul 2026 — email support to reinstate.'
 WHERE id = 123;

-- Un-revoke.
UPDATE licenses
   SET status = 'active', revoked_at = NULL, revoked_reason = NULL
 WHERE id = 123;
```

Revocation takes effect at the install's next renewal (≤72h), or immediately for
relay connections once the relay polls `/v1/revocations`. `status` accepts only
`active`, `suspended`, `revoked` — anything else fails the CHECK constraint.

### Extend or clear an expiry

```sql
UPDATE licenses SET expires_at = now() + interval '30 days' WHERE id = 123;
UPDATE licenses SET expires_at = NULL WHERE id = 123;   -- NULL = perpetual
```

### Who did what

```sql
SELECT at, actor, action, subject_type, subject_id, meta
  FROM audit_log
 ORDER BY at DESC
 LIMIT 50;
```

## Symptoms → cause → fix

### "It stopped working" — one customer

1. Is anything even enforced? `SELECT slug, enforce FROM products;` — if
   `enforce` is false, licensing is not their problem. Look elsewhere.
2. `SELECT status, expires_at, revoked_reason FROM licenses WHERE id = ...` —
   revoked, suspended, or past `expires_at`?
3. `SELECT status, last_seen_at, blocked_reason FROM activations WHERE license_id = ...`
   — was their seat released or blocked?
4. If all of that is clean, they are probably just offline. Ask them to open
   Console → Settings → License. "Using saved license" in amber means their Mac
   cannot reach this server; that is not a licensing fault and nothing is gated.

### "Seat limit reached" (402)

They are at `seat_limit` active activations within the 60-day window. Release
the idle one ([above](#free-a-seat-a-customer-is-stuck-on)), or raise the limit:

```sql
UPDATE licenses SET seat_limit = 5 WHERE id = 123;
```

### "I lost my key"

Keys are stored as a SHA-256 hash and are **unrecoverable by design** — there is
no query that returns one. Issue a new key (admin UI → Generate key) and revoke
the old one. Never promise a customer you can look theirs up.

### "Everyone is failing at once"

Do not start revoking or editing rows. In order:

1. `curl .../v1/health` — is it the server or the database?
2. Railway → `license` service → Deployments → logs. A boot failure prints
   `license: <VAR> is required` for a missing env var, or `migration ... failed`.
3. `curl .../v1/jwks` — confirms the server still holds a signing key and shows
   which `kid` it is signing with. If that `kid` is not in the clients' baked
   key ring, every install rejects every lease. See [Key rotation](#key-rotation).
4. Only then consider the [kill switch](#the-kill-switch).

### "Key is rejected as invalid" (401 `invalid_key`)

The key failed to parse or does not exist. Format is
`clem_live_<tenant>_<32 chars>`, alphabet `0-9 A-Z` minus `I L O U`. A customer
who typed `O` for `0` or `l` for `1` gets this. A key for a different product
returns 403 `wrong_product` instead.

## Key rotation

**Order matters, and getting it wrong bricks every install that has not
updated.** The public key must agree in three places:

| Where | What |
| --- | --- |
| `src/licensing/license-keys.ts` | `BAKED_KEYS` — the daemon's ring |
| relay service env | `RELAY_LICENSE_PUBKEYS` (`k1:BASE64,k2:BASE64`) |
| license service env | `LICENSE_SIGNING_KEY_PEM` + `LICENSE_SIGNING_KID` |

Clients must **never** fetch a verification key at runtime — that would turn a
compromise of this server into a compromise of every client, which is precisely
what offline verification exists to prevent. `/v1/jwks` is for humans.

1. **Mint** the new pair:
   ```bash
   cd apps/license && node scripts/genkey.mjs
   ```
2. **Publish the new public key first, still signing with the old one.** Add
   `k2` to `BAKED_KEYS` *alongside* `k1`, and append it to the relay's
   `RELAY_LICENSE_PUBKEYS`. Do not touch the server's signing key yet.
3. **Ship a client release and wait for adoption.** Every install must be able
   to verify `k2` before anything is signed with it.
4. **Only then flip the server:** set `LICENSE_SIGNING_KEY_PEM` to the new
   private key and `LICENSE_SIGNING_KID=k2`. Verify with
   `curl .../v1/jwks`.
5. **Retire `k1` later** — after every lease signed with it has aged past its
   TTL plus grace (~17 days) — by dropping it from `BAKED_KEYS` and the relay in
   a subsequent release.

Doing step 4 before step 3 means every install still on the old build rejects
every lease it is issued, and no server-side change can fix them.

## Disaster recovery

### Losing `LICENSE_SIGNING_KEY_PEM`

You can no longer issue or renew **any** license. Existing installs coast on
their cached leases (~17 days desktop, ~72h relay) and then every customer
degrades. Recovery requires minting a new key *and shipping a client release*
carrying its public half — so the real outage length is however long a release
takes, not however long the fix takes.

- Back it up **offline**, in a password manager. Not in the repo, not in a
  client bundle, not in a chat message.
- It is the only thing standing between an attacker and minting their own
  licenses.

### Losing the database

Keys are stored as SHA-256 hashes, so **nothing can reconstruct a customer's
key** — not from a backup of anything else, not from the client, not from us.
Losing the database means reissuing keys to every customer by hand.

Take Railway's Postgres backups seriously, and verify a restore before you need
one.

### Changing `LICENSE_MACHINE_PEPPER`

Quieter than the other two and easy to do by accident. `machine_id_hash` is
`sha256(pepper:machineId)`, so a new pepper orphans **every existing
activation**: each install fails to match its row, re-activates as a new device,
and burns a second seat. Customers on 1-seat plans hit 402 immediately.

Treat the pepper as permanent. If it must change, expect to release every
activation first:

```sql
UPDATE activations SET status = 'released', released_at = now()
 WHERE status = 'active';
```

## Reference

### Deployment

Railway project **clementine-relay**, services `license` and `Postgres`.
Public URL: `https://license-production-f998.up.railway.app`.
Migrations in `migrations/*.sql` run automatically on every boot and are
recorded in `schema_migrations`; a failed migration exits the process rather
than serving a half-migrated schema.

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | `${{Postgres.DATABASE_URL}}` |
| `LICENSE_SIGNING_KEY_PEM` | yes | Ed25519 PKCS#8 PEM, `\n`-escaped |
| `LICENSE_MACHINE_PEPPER` | yes | Never change — see above |
| `LICENSE_SIGNING_KID` | no | Defaults to `k1` |
| `LICENSE_ADMIN_BOOTSTRAP_TOKEN` | no | First admin bearer token. **Accepted for as long as it is set** — creating a row in `admin_tokens` does not retire it. Unset it once a real token exists |
| `RELAY_SERVICE_TOKEN` | no | Lets the relay read `/v1/revocations`; without it that route 401s |
| `PORT` | no | Railway provides it; defaults to 8080 |

Missing a required variable fails the boot loudly with
`license: <NAME> is required`.

### Endpoints

Everything under `/v1` is rate-limited to 120 requests/min per IP — admin routes
included — with `/v1/health` the only exemption. Public routes
(`routes-public.mjs`):

| Route | Purpose |
| --- | --- |
| `POST /v1/activate` | First contact; binds a seat. `dryRun: true` validates a key **without** consuming a seat |
| `POST /v1/lease` | Renewal. No seat accounting — the install already holds one |
| `POST /v1/deactivate` | Frees a seat so a customer can move machines unaided |
| `GET /v1/revocations` | The relay's feed. Bearer `RELAY_SERVICE_TOKEN` |
| `GET /v1/health` | Liveness + database check |
| `GET /v1/jwks` | Current `kid` and public key. Humans only |

Admin (`routes-admin.mjs`), mounted at `/v1/admin`, Bearer token required —
tenants, products, licenses, activations, audit. The hosted admin UI in
`apps/web` calls these server-side; the token never reaches a browser.

### Defaults

| Setting | Default | Column |
| --- | --- | --- |
| Lease TTL | 72h (259200s) | `products.lease_ttl_seconds` |
| Grace | 14d (1209600s) | `products.grace_seconds` |
| Enforcement | off | `products.enforce` |
| Seat limit | 1 | `licenses.seat_limit` |
| Seat idle window | 60 days | `MAX_SEAT_IDLE_DAYS`, `routes-public.mjs` |

Lease TTL is also the **revocation window**: it is the longest a revoked install
can keep working. Shortening it makes revocation faster and outages less
survivable, in equal measure.
