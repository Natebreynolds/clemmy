/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-db npx tsx --test src/memory/db.test.ts
 *
 * Tier C durability surface: memory.db backup (VACUUM INTO + retention) and
 * the episodic_pointers TTL reaper.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TEST_HOME = '/tmp/clemmy-test-db';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const {
  resetMemoryDb,
  closeMemoryDb,
  openMemoryDb,
  backupMemoryDb,
  reapStaleEpisodicPointers,
  MEMORY_BACKUP_DIR,
  MEMORY_DB_PATH,
  MEMORY_SCHEMA_VERSION,
  migrateMemoryDatabaseHandle,
} = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact } = await import('./facts.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
  rmSync(MEMORY_BACKUP_DIR, { recursive: true, force: true });
});

test('backupMemoryDb writes a consistent snapshot containing the facts', () => {
  rememberFact({ kind: 'user', content: 'Nathan prefers concise replies.' });
  const result = backupMemoryDb({ retain: 7 });
  assert.ok(result, 'backup returns a result');
  assert.ok(existsSync(result!.backupPath), 'backup file exists on disk');
  assert.ok(result!.bytes > 0, 'backup has non-zero size');

  // The snapshot is a real SQLite db with the fact in it.
  const snap = new Database(result!.backupPath, { readonly: true });
  const row = snap.prepare('SELECT COUNT(*) AS c FROM consolidated_facts').get() as { c: number };
  snap.close();
  assert.equal(row.c, 1, 'backed-up db contains the fact');
});

test('backupMemoryDb retains only the newest N snapshots', () => {
  // Seed three OLD fake snapshots (lexicographically earlier ISO stamps).
  if (!existsSync(MEMORY_BACKUP_DIR)) mkdirSync(MEMORY_BACKUP_DIR, { recursive: true });
  for (const stamp of ['2020-01-01T00-00-00-000Z', '2020-02-01T00-00-00-000Z', '2020-03-01T00-00-00-000Z']) {
    writeFileSync(path.join(MEMORY_BACKUP_DIR, `memory-${stamp}.db`), 'stale');
  }
  rememberFact({ kind: 'project', content: 'Backup retention check.' });

  const result = backupMemoryDb({ retain: 2 });
  assert.ok(result, 'backup succeeded');

  const remaining = readdirSync(MEMORY_BACKUP_DIR).filter((f) => f.startsWith('memory-') && f.endsWith('.db')).sort();
  assert.equal(remaining.length, 2, 'pruned to the newest 2 snapshots');
  // The fresh (real) backup is the newest, so it must survive.
  assert.ok(remaining.includes(path.basename(result!.backupPath)), 'the just-written backup survives pruning');
  // The oldest fakes are gone.
  assert.ok(!remaining.includes('memory-2020-01-01T00-00-00-000Z.db'), 'oldest snapshot pruned');
});

test('reapStaleEpisodicPointers drops pointers past the TTL but keeps fresh ones', () => {
  const db = openMemoryDb();
  const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60d ago
  const freshIso = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO episodic_pointers (session_id, call_id, label, tool, source_uri, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('s1', 'c-old', 'the old convo', 'outlook', 'outlook:thread:old', oldIso);
  insert.run('s2', 'c-new', 'the recent convo', 'outlook', 'outlook:thread:new', freshIso);

  const deleted = reapStaleEpisodicPointers({ maxAgeDays: 30 });
  assert.equal(deleted, 1, 'exactly the stale pointer is reaped');

  const remaining = db.prepare('SELECT call_id FROM episodic_pointers').all() as { call_id: string }[];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].call_id, 'c-new', 'the fresh pointer survives');
});

test('v22 removes only rebuildable orphan indexes, audits cleanup, and preserves grounded memory', () => {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const fact = rememberFact({ kind: 'user', content: 'Dana Lee works at Northstar Labs.' });
  const entity = db.prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES ('person', 'Dana Lee', 'dana lee', '[]', ?, ?, 1)
  `).run(now, now);
  const entityId = Number(entity.lastInsertRowid);
  db.prepare(`
    INSERT INTO fact_entities
      (fact_id, entity_id, created_at, link_type, confidence, evidence_excerpt)
    VALUES (?, ?, ?, 'extracted', 0.98, ?)
  `).run(fact.id, entityId, now, fact.content);

  // Simulate index debris produced by a historical writer that had foreign-key
  // enforcement disabled. These rows are all derivable again from source data.
  db.pragma('foreign_keys = OFF');
  db.prepare(`
    INSERT INTO fact_entities
      (fact_id, entity_id, created_at, link_type, confidence)
    VALUES (9999991, 9999992, ?, 'inferred_text', 0.55)
  `).run(now);
  db.prepare(`
    INSERT INTO fact_resources
      (fact_id, resource_id, created_at, link_type, confidence)
    VALUES (9999991, 9999993, ?, 'inferred_text', 0.55)
  `).run(now);
  db.prepare(`
    INSERT INTO embeddings (chunk_id, model, dim, vector, created_at)
    VALUES (9999994, 'test-model', 1, ?, ?)
  `).run(Buffer.alloc(4), now);
  db.prepare(`
    INSERT INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
    VALUES (9999995, 'test-model', 1, ?, 'orphan', ?)
  `).run(Buffer.alloc(4), now);
  db.prepare('DELETE FROM schema_version WHERE version IN (22, 23, 24, 25, 26, 27, 28, 29)').run();
  closeMemoryDb();

  const migrated = openMemoryDb();
  assert.equal(
    (migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    MEMORY_SCHEMA_VERSION,
  );
  assert.deepEqual(migrated.pragma('foreign_key_check'), []);
  assert.deepEqual(migrated.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  assert.equal(
    (migrated.prepare(`
      SELECT COUNT(*) AS count FROM fact_entities
      WHERE fact_id = ? AND entity_id = ? AND link_type = 'extracted'
    `).get(fact.id, entityId) as { count: number }).count,
    1,
    'grounded relationship survives the entity table rebuild',
  );
  const audit = migrated.prepare(`
    SELECT action, affected_rows FROM memory_migration_audit
    WHERE migration_version = 22 ORDER BY action
  `).all() as Array<{ action: string; affected_rows: number }>;
  assert.deepEqual(audit, [
    { action: 'materialize_legacy_fact_entity_truth_defaults', affected_rows: 2 },
    { action: 'materialize_legacy_fact_resource_truth_defaults', affected_rows: 1 },
    { action: 'remove_orphaned_fact_embeddings', affected_rows: 1 },
    { action: 'remove_orphaned_inferred_fact_entity_links', affected_rows: 1 },
    { action: 'remove_orphaned_inferred_fact_resource_links', affected_rows: 1 },
    { action: 'remove_orphaned_vault_embeddings', affected_rows: 1 },
  ]);

  const insertSameName = migrated.prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES ('person', 'Dana Lee', 'dana lee', '[]', ?, ?, 1)
  `);
  assert.doesNotThrow(() => insertSameName.run(now, now), 'same display names no longer collide');
});

test('v22 refuses to discard an orphaned grounded relationship', () => {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  db.pragma('foreign_keys = OFF');
  db.prepare(`
    INSERT INTO fact_entities
      (fact_id, entity_id, created_at, link_type, confidence, evidence_excerpt)
    VALUES (8888881, 8888882, ?, 'extracted', 0.99, 'Durable relationship evidence')
  `).run(now);
  db.prepare('DELETE FROM schema_version WHERE version IN (22, 23, 24, 25, 26, 27, 28, 29)').run();
  closeMemoryDb();

  assert.throws(
    () => openMemoryDb(),
    /non-rebuildable foreign-key violation/,
    'grounded links are never silently treated as an index cache',
  );

  const probe = new Database(MEMORY_DB_PATH);
  try {
    assert.equal(
      (probe.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
      21,
      'failed migration is not recorded',
    );
    assert.equal(
      (probe.prepare(`
        SELECT COUNT(*) AS count FROM fact_entities
        WHERE fact_id = 8888881 AND link_type = 'extracted'
      `).get() as { count: number }).count,
      1,
      'the durable orphan remains available for an explicit repair decision',
    );
  } finally {
    probe.close();
  }
});

test('v29 widens candidate provenance without losing any v28 lifecycle state', () => {
  const fixturePath = path.join(TEST_HOME, 'candidate-v28.db');
  rmSync(fixturePath, { force: true });
  const fixture = new Database(fixturePath);
  try {
    migrateMemoryDatabaseHandle(fixture, { targetVersion: 28 });
    fixture.prepare(`
      INSERT INTO memory_reflection_candidates
        (episode_id, session_id, call_id, candidate_hash, kind, text,
         importance, status, reason, resulting_fact_id, created_at, resolved_at,
         source_type, intake_reason, trust_level, authority, source_uri, pin,
         attempt_count, next_attempt_at, last_error, processing_started_at)
      VALUES (NULL, 'legacy-session', 'legacy-call', 'legacy-hash', 'project',
        'Preserve this exact pending claim.', 7, 'pending', NULL, NULL,
        '2026-07-15T00:00:00.000Z', NULL, 'manual', 'owner entered', 0.95,
        'manual', 'manual://memory/1', 1, 2, '2026-07-16T00:00:00.000Z',
        'temporary error', '2026-07-15T01:00:00.000Z')
    `).run();

    migrateMemoryDatabaseHandle(fixture);
    assert.equal((fixture.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, MEMORY_SCHEMA_VERSION);
    assert.deepEqual(fixture.prepare(`
      SELECT session_id, call_id, text, status, source_type, intake_reason,
             trust_level, authority, source_uri, pin, attempt_count,
             next_attempt_at, last_error, processing_started_at
      FROM memory_reflection_candidates WHERE candidate_hash = 'legacy-hash'
    `).get(), {
      session_id: 'legacy-session', call_id: 'legacy-call', text: 'Preserve this exact pending claim.',
      status: 'pending', source_type: 'manual', intake_reason: 'owner entered',
      trust_level: 0.95, authority: 'manual', source_uri: 'manual://memory/1', pin: 1,
      attempt_count: 2, next_attempt_at: '2026-07-16T00:00:00.000Z',
      last_error: 'temporary error', processing_started_at: '2026-07-15T01:00:00.000Z',
    });
    assert.doesNotThrow(() => fixture.prepare(`
      INSERT INTO memory_reflection_candidates
        (session_id, call_id, candidate_hash, kind, text, importance, status, created_at, source_type)
      VALUES ('meeting:local', 'meeting-1', 'meeting-hash', 'project', 'Meeting decision', 7, 'pending', ?, 'meeting_analysis')
    `).run(new Date().toISOString()));
    assert.deepEqual(fixture.pragma('foreign_key_check'), []);
    assert.deepEqual(fixture.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    fixture.close();
    rmSync(fixturePath, { force: true });
  }
});
