-- Licensing schema.
--
-- Shaped so that self-serve billing later adds tables and one webhook, never a
-- migration of what is here: licenses already carry plan/features/seat_limit
-- and an optional customer_email, so a Stripe flow just fills them in.

CREATE TABLE IF NOT EXISTS tenants (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  lease_ttl_seconds  INT NOT NULL DEFAULT 259200,    -- 72h: also the revocation window
  grace_seconds      INT NOT NULL DEFAULT 1209600,   -- 14d offline tolerance
  -- The kill switch. Ships false; one UPDATE turns enforcement on or off for
  -- every install without a client release.
  enforce            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS licenses (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id      BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  key_hash        BYTEA NOT NULL UNIQUE,
  key_prefix      TEXT NOT NULL,
  key_last4       TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'pro',
  features        JSONB NOT NULL DEFAULT '[]'::jsonb,
  seat_limit      INT NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'revoked')),
  expires_at      TIMESTAMPTZ NULL,                  -- NULL = perpetual (founders, testers)
  customer_email  TEXT NULL,
  note            TEXT NULL,
  created_by      TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ NULL,
  revoked_reason  TEXT NULL
);
CREATE INDEX IF NOT EXISTS licenses_status_idx ON licenses (status);
CREATE INDEX IF NOT EXISTS licenses_email_idx ON licenses (customer_email);

CREATE TABLE IF NOT EXISTS activations (
  id               BIGSERIAL PRIMARY KEY,
  license_id       BIGINT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  machine_id_hash  BYTEA NOT NULL,
  pair_id          TEXT NULL,                        -- relay tunnel address, binds the lease
  app_version      TEXT NULL,
  os               TEXT NULL,
  arch             TEXT NULL,
  hostname_hint    TEXT NULL,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'released', 'blocked')),
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at      TIMESTAMPTZ NULL,
  blocked_reason   TEXT NULL,
  UNIQUE (license_id, machine_id_hash)
);
CREATE INDEX IF NOT EXISTS activations_license_idx ON activations (license_id);

-- What we handed out. Enables per-lease revocation and answers "what does that
-- install actually hold" during support.
CREATE TABLE IF NOT EXISTS lease_issuances (
  id             BIGSERIAL PRIMARY KEY,
  activation_id  BIGINT NOT NULL REFERENCES activations(id) ON DELETE CASCADE,
  jti            TEXT NOT NULL UNIQUE,
  kid            TEXT NOT NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked        BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS lease_issuances_activation_idx ON lease_issuances (activation_id);

CREATE TABLE IF NOT EXISTS admin_users (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,                      -- scrypt: salt:hash, both hex
  totp_secret    TEXT NULL,                          -- base32; NULL until enrolled
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash  BYTEA NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          TEXT NULL
);

CREATE TABLE IF NOT EXISTS admin_tokens (
  id          BIGSERIAL PRIMARY KEY,
  token_hash  BYTEA NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NULL,
  revoked_at  TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  subject_type  TEXT NULL,
  subject_id    TEXT NULL,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
