/**
 * Run: npx tsx --test src/runtime/harness/approval-system-cancellation-schema-v55.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-v55-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const eventlog = await import('./eventlog.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

interface ApprovalDecisionBytes {
  approval_id: string;
  status: string;
  resolution: string | null;
  resolver: string | null;
  resolved_at: string | null;
}

function seedHistoricalDecision(db: Database.Database, suffix: string): ApprovalDecisionBytes[] {
  const now = '2026-01-15T12:00:00.000Z';
  const sessionId = `schema-v55-${suffix}`;
  db.prepare(`
    INSERT INTO sessions
      (id, kind, created_at, updated_at, status, metadata_json)
    VALUES (?, 'chat', ?, ?, 'cancelled', '{}')
  `).run(sessionId, now, now);
  db.prepare(`
    INSERT INTO pending_approvals
      (approval_id, session_id, requested_at, expires_at, subject,
       status, resolution, resolver, resolved_at)
    VALUES (?, ?, ?, ?, ?, 'resolved', 'cancelled_by_user', ?, ?)
  `).run(
    `apr-user-${suffix}`,
    sessionId,
    now,
    '2026-01-15T12:10:00.000Z',
    'Historical user cancellation',
    'discord-user',
    now,
  );
  return db.prepare(`
    SELECT approval_id, status, resolution, resolver, resolved_at
      FROM pending_approvals
     ORDER BY approval_id
  `).all() as ApprovalDecisionBytes[];
}

function rehearseUpgrade(sourceVersion: number, suffix: string): void {
  const db = new Database(path.join(TMP_HOME, `harness-${suffix}.db`));
  try {
    db.pragma('foreign_keys = ON');
    eventlog.applyHarnessMigrationsThroughVersionForTests(db, sourceVersion);
    const before = seedHistoricalDecision(db, suffix);
    // For the published v3.14 source, first exercise every historical step up
    // to the immediate predecessor. The final call below still targets the
    // current exported schema dynamically.
    if (sourceVersion < 54) {
      eventlog.applyHarnessMigrationsThroughVersionForTests(db, 54);
    }
    const beforeIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'pending_approvals' AND sql IS NOT NULL
       ORDER BY name
    `).all();

    eventlog.applyHarnessMigrations(db);

    const after = db.prepare(`
      SELECT approval_id, status, resolution, resolver, resolved_at
        FROM pending_approvals
       ORDER BY approval_id
    `).all() as ApprovalDecisionBytes[];
    assert.deepEqual(after, before, 'old cancelled_by_user decision bytes are not reclassified');
    assert.deepEqual(db.prepare(`
      SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'pending_approvals' AND sql IS NOT NULL
       ORDER BY name
    `).all(), beforeIndexes, 'approval indexes survive the constrained-table rebuild');
    const tableSql = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_approvals'
    `).get() as { sql: string };
    assert.match(tableSql.sql, /cancelled_by_system/);

    const now = '2026-01-15T12:01:00.000Z';
    db.prepare(`
      INSERT INTO pending_approvals
        (approval_id, session_id, requested_at, expires_at, subject,
         status, resolution, resolver, resolved_at)
      VALUES (?, ?, ?, ?, ?, 'cancelled', 'cancelled_by_system', ?, ?)
    `).run(
      `apr-system-${suffix}`,
      `schema-v55-${suffix}`,
      now,
      '2026-01-15T12:10:00.000Z',
      'Truthful system cleanup',
      'reaper-dead-session',
      now,
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
    assert.equal(versions.at(-1)?.version, HARNESS_SCHEMA_VERSION);
    assert.deepEqual(
      versions.map((row) => row.version),
      Array.from({ length: HARNESS_SCHEMA_VERSION }, (_, index) => index + 1),
      'the migration target follows the current schema and remains contiguous',
    );
  } finally {
    db.close();
  }
}

test('v54 to v55 widens only the canonical approval resolution enum', () => {
  rehearseUpgrade(54, 'v54');
});

test('published v3.14 schema 20 reaches the dynamic current target without rewriting user cancellations', () => {
  rehearseUpgrade(20, 'v314');
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
