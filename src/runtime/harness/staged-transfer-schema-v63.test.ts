import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-staged-transfer-v63-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = '6'.repeat(64);
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-staged-transfer-v63\n', 'utf8');

const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

function seedUntrustedV62Secret(db: Database.Database, suffix: string): void {
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TRIGGER IF EXISTS trg_staged_transfer_secret_exact_attempt');
  db.prepare(`
    INSERT INTO staged_transfer_secret_payloads
      (payload_id, stage_authority_id, payload_kind, binding_digest,
       plaintext_sha256, plaintext_bytes, chunk_count, sealed_sha256,
       sealed_bytes, expires_at, created_at)
    VALUES (?, ?, 'staged_signed_url', ?, ?, 12, 1, ?, 64, ?, ?)
  `).run(
    `authority-payload:untrusted-v62-${suffix}`,
    `staged-attempt:untrusted-v62-${suffix}`,
    '1'.repeat(64),
    '2'.repeat(64),
    '3'.repeat(64),
    '2030-01-01T00:00:00.000Z',
    '2026-08-24T00:00:00.000Z',
  );
  db.pragma('foreign_keys = ON');
}

function secretTriggerSql(db: Database.Database): string {
  return String((db.prepare(`
    SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'trg_staged_transfer_secret_exact_attempt'
  `).get() as { sql: string } | undefined)?.sql ?? '');
}

test('v63 retires every unproven v62 secret and requires the opaque return kernel', () => {
  const upgraded = new Database(path.join(TMP_HOME, 'v62-to-v63.db'));
  const fresh = new Database(path.join(TMP_HOME, 'fresh-v63.db'));
  try {
    schema.applyHarnessMigrationsThroughVersionForTests(upgraded, 62);
    seedUntrustedV62Secret(upgraded, 'upgrade');
    assert.equal((upgraded.prepare(`SELECT COUNT(*) AS count FROM staged_transfer_secret_payloads`)
      .get() as { count: number }).count, 1);

    schema.applyHarnessMigrations(upgraded);
    assert.equal((upgraded.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number;
    }).version, HARNESS_SCHEMA_VERSION);
    assert.equal((upgraded.prepare(`SELECT COUNT(*) AS count FROM staged_transfer_secret_payloads`)
      .get() as { count: number }).count, 0);
    assert.match(secretTriggerSql(upgraded), /clementine_staged_secret_admitted_v1/);

    upgraded.pragma('foreign_keys = OFF');
    assert.throws(() => upgraded.prepare(`
      INSERT INTO staged_transfer_secret_payloads
        (payload_id, stage_authority_id, payload_kind, binding_digest,
         plaintext_sha256, plaintext_bytes, chunk_count, sealed_sha256,
         sealed_bytes, expires_at, created_at)
      VALUES ('authority-payload:forged', 'staged-attempt:forged',
              'staged_signed_url', ?, ?, 12, 1, ?, 64, ?, ?)
    `).run(
      '4'.repeat(64),
      '5'.repeat(64),
      '6'.repeat(64),
      '2030-01-01T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
    ), /clementine_staged_secret_admitted_v1|opaque return authority/);
    upgraded.pragma('foreign_keys = ON');

    schema.applyHarnessMigrations(fresh);
    assert.equal(secretTriggerSql(upgraded), secretTriggerSql(fresh));
  } finally {
    upgraded.close();
    fresh.close();
  }
});

test('v63 secret retirement and version stamp roll back together', () => {
  const db = new Database(path.join(TMP_HOME, 'v63-rollback.db'));
  try {
    schema.applyHarnessMigrationsThroughVersionForTests(db, 62);
    seedUntrustedV62Secret(db, 'rollback');
    db.exec(`
      CREATE TRIGGER test_abort_v63_secret_retirement
      BEFORE DELETE ON staged_transfer_secret_payloads
      BEGIN SELECT RAISE(ABORT, 'test injected v63 failure'); END;
    `);
    assert.throws(() => schema.applyHarnessMigrations(db), /test injected v63 failure/);
    assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number;
    }).version, 62);
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM staged_transfer_secret_payloads`)
      .get() as { count: number }).count, 1);

    db.exec('DROP TRIGGER test_abort_v63_secret_retirement');
    schema.applyHarnessMigrations(db);
    assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number;
    }).version, HARNESS_SCHEMA_VERSION);
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM staged_transfer_secret_payloads`)
      .get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});
