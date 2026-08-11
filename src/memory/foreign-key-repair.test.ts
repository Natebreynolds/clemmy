import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clementine-memory-fk-repair-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const {
  closeMemoryDb,
  MEMORY_DB_PATH,
  openMemoryDb,
  resetMemoryDb,
} = await import('./db.js');
const { rememberFact } = await import('./facts.js');
const {
  inspectMemoryForeignKeyRepair,
  repairMemoryForeignKeyOrphans,
} = await import('./foreign-key-repair.js');

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
});

after(() => {
  closeMemoryDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function seedSmokeFactOrphans(): number {
  const fact = rememberFact({ kind: 'user', content: 'My smoke marker is MEMTOK-153832.' });
  const db = openMemoryDb();
  const now = '2026-08-05T22:39:27.653Z';
  db.prepare(`
    INSERT INTO memory_episodes
      (id, kind, source_app, session_id, call_id, source_uri, occurred_at,
       ingested_at, content_hash, evidence_excerpt, status)
    VALUES ('call:fk-repair-smoke', 'user_turn', 'console',
      'console:devsmoke-memw-153832', 'auto-capture:fk-repair-smoke',
      'conversation://console/devsmoke-memw-153832', ?, ?,
      'episode-hash-fk-repair-smoke', ?, 'available')
  `).run(now, now, 'Remember exactly: my smoke marker is MEMTOK-153832. Confirm.');
  db.prepare('DELETE FROM fact_evidence WHERE fact_id = ?').run(fact.id);
  db.prepare(`
    INSERT INTO fact_evidence
      (fact_id, episode_id, excerpt, source_uri, ordinal, created_at)
    VALUES (?, 'call:fk-repair-smoke', ?,
      'conversation://console/devsmoke-memw-153832', 0, ?)
  `).run(fact.id, 'Remember exactly: my smoke marker is MEMTOK-153832. Confirm.', now);
  db.prepare(`
    INSERT INTO memory_reflection_candidates
      (episode_id, session_id, call_id, candidate_hash, kind, text,
       importance, status, reason, resulting_fact_id, created_at, resolved_at,
       source_type)
    VALUES ('call:fk-repair-smoke', 'console:devsmoke-memw-153832',
      'auto-capture:fk-repair-smoke', 'candidate-hash-fk-repair-smoke',
      'user', ?, 5, 'promoted', 'consolidation:add', ?, ?, ?, 'auto_capture')
  `).run(fact.content, fact.id, now, now);

  // The historical smoke row predated/omitted a compiled prompt policy, so
  // remove the automatically-created user policy while FK enforcement is
  // still active to reproduce its exact three-row violation footprint.
  db.prepare('DELETE FROM memory_policies WHERE fact_id = ?').run(fact.id);

  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM consolidated_facts WHERE id = ?').run(fact.id);
  const violations = db.pragma('foreign_key_check') as unknown[];
  assert.equal(violations.length, 3, `fixture reproduces the three live orphans: ${JSON.stringify(violations)}`);
  closeMemoryDb();
  return fact.id;
}

test('repair is readiness-driven, backup-first, and idempotent for the smoke hard-delete shape', () => {
  const factId = seedSmokeFactOrphans();
  const plan = inspectMemoryForeignKeyRepair(MEMORY_DB_PATH);
  assert.equal(plan.safeToApply, true);
  assert.deepEqual(
    plan.findings.map((finding) => `${finding.table}:${finding.repair}`).sort(),
    [
      'fact_evidence:delete_orphan',
      'fact_validity_intervals:delete_orphan',
      'memory_reflection_candidates:clear_reference',
    ],
  );

  const result = repairMemoryForeignKeyOrphans(MEMORY_DB_PATH, {
    now: '2026-08-08T12:00:00.000Z',
  });
  assert.equal(result.applied, true);
  assert.equal(result.repairedRows, 3);
  assert.ok(result.backupPath && existsSync(result.backupPath));
  assert.ok(result.backupBytes > 0);
  assert.equal(
    result.readinessAfter.checks.find((item) => item.id === 'foreign_key_integrity')?.status,
    'pass',
  );

  const repaired = new Database(MEMORY_DB_PATH, { readonly: true });
  try {
    assert.deepEqual(repaired.pragma('foreign_key_check'), []);
    assert.equal(
      (repaired.prepare(`
        SELECT resulting_fact_id FROM memory_reflection_candidates
        WHERE candidate_hash = 'candidate-hash-fk-repair-smoke'
      `).get() as { resulting_fact_id: number | null }).resulting_fact_id,
      null,
    );
    assert.equal(
      (repaired.prepare('SELECT COUNT(*) AS count FROM fact_evidence WHERE fact_id = ?').get(factId) as { count: number }).count,
      0,
    );
    assert.equal(
      (repaired.prepare('SELECT COUNT(*) AS count FROM fact_validity_intervals WHERE fact_id = ?').get(factId) as { count: number }).count,
      0,
    );
  } finally {
    repaired.close();
  }

  const backup = new Database(result.backupPath!, { readonly: true });
  try {
    assert.equal((backup.pragma('foreign_key_check') as unknown[]).length, 3, 'backup preserves the exact pre-repair state');
  } finally {
    backup.close();
  }

  const second = repairMemoryForeignKeyOrphans(MEMORY_DB_PATH);
  assert.equal(second.applied, false);
  assert.equal(second.repairedRows, 0);
  assert.equal(second.backupPath, null, 'an idempotent no-op does not create another backup');
});

test('repair refuses an unknown violation shape before creating a backup or changing data', () => {
  const db = openMemoryDb();
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE unsafe_fact_reference (
      id INTEGER PRIMARY KEY,
      fact_id INTEGER NOT NULL REFERENCES consolidated_facts(id)
    );
    INSERT INTO unsafe_fact_reference (id, fact_id) VALUES (1, 999999);
  `);
  closeMemoryDb();

  const backupDir = path.join(path.dirname(MEMORY_DB_PATH), 'backups', 'foreign-key-repair');
  const before = existsSync(backupDir) ? readdirSync(backupDir).length : 0;
  const plan = inspectMemoryForeignKeyRepair(MEMORY_DB_PATH);
  assert.equal(plan.safeToApply, false);
  assert.equal(plan.findings[0]?.repair, null);
  assert.throws(
    () => repairMemoryForeignKeyOrphans(MEMORY_DB_PATH),
    /do not match a declared safe fact-delete action/,
  );
  const afterCount = existsSync(backupDir) ? readdirSync(backupDir).length : 0;
  assert.equal(afterCount, before, 'unsafe dry-run/refusal writes no backup artifact');

  const verify = new Database(MEMORY_DB_PATH, { readonly: true });
  try {
    assert.equal(
      (verify.prepare('SELECT fact_id FROM unsafe_fact_reference WHERE id = 1').get() as { fact_id: number }).fact_id,
      999999,
      'unsafe row is untouched',
    );
  } finally {
    verify.close();
  }
});
