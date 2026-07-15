import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  MEMORY_SCHEMA_VERSION,
  migrateMemoryDatabaseHandle,
} from './db.js';
import { rehearseMemoryMigration } from './migration-rehearsal.js';

function fileHash(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function createPhysicalV21Database(databasePath: string): Database.Database {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  migrateMemoryDatabaseHandle(db, { targetVersion: 21 });
  assert.equal(
    (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    21,
  );
  assert.equal(tableExists(db, 'memory_migration_audit'), false, 'fixture physically predates v22');
  assert.equal(tableExists(db, 'memory_reflection_candidates'), false, 'fixture physically predates v26');
  return db;
}

test('migration rehearsal upgrades a consistent copy and leaves a physical v21 source byte-for-byte unchanged', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-rehearsal-success-'));
  const sourcePath = path.join(root, 'memory-v21.db');
  let retainedCopyDirectory: string | null = null;
  try {
    const db = createPhysicalV21Database(sourcePath);
    const now = '2026-07-15T18:00:00.000Z';
    const episodeId = 'episode-live-meeting';
    db.prepare(`
      INSERT INTO memory_episodes
        (id, kind, source_app, session_id, call_id, source_uri, occurred_at,
         ingested_at, content_hash, evidence_excerpt, status, subtype, title, metadata_json)
      VALUES (?, 'tool_result', 'Recorder', 'session-live', 'call-live', ?, ?, ?, ?, ?,
              'available', 'in_person_recording', 'Northstar planning meeting', '{}')
    `).run(
      episodeId,
      'recording://local/northstar-planning',
      now,
      now,
      'episode-hash',
      'Dana said the Northstar launch review is Friday in the Q3 Planning folder.',
    );
    const meetingFact = db.prepare(`
      INSERT INTO consolidated_facts
        (kind, content, content_hash, source_session_id, score, active, created_at, updated_at,
         derived_from_session_id, derived_from_call_id, derived_from_tool, trust_level,
         extracted_at, importance, pinned, source_app, valid_from, confidence)
      VALUES ('project', ?, 'meeting-fact-hash', 'session-live', 1, 1, ?, ?,
              'session-live', 'call-live', 'Recorder', 0.9, ?, 8, 0, 'Recorder', ?, 0.9)
    `).run('The Northstar launch review is Friday in the Q3 Planning folder.', now, now, now, now);
    const meetingFactId = Number(meetingFact.lastInsertRowid);
    db.prepare(`
      INSERT INTO fact_evidence (fact_id, episode_id, excerpt, source_uri, ordinal, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(
      meetingFactId,
      episodeId,
      'Dana said the Northstar launch review is Friday in the Q3 Planning folder.',
      'recording://local/northstar-planning',
      now,
    );
    db.prepare(`
      INSERT INTO reflection_pending_extractions
        (session_id, call_id, tool, extraction_json, importance,
         created_at, expires_at, status)
      VALUES ('session-live', 'call-live', 'Recorder', ?, 8, ?, ?, 'pending')
    `).run(
      JSON.stringify({
        facts: [{
          kind: 'project',
          text: 'The Northstar launch review is Friday in the Q3 Planning folder.',
          importance: 8,
        }],
      }),
      now,
      '2026-07-16T18:00:00.000Z',
    );
    const profileFact = db.prepare(`
      INSERT INTO consolidated_facts
        (kind, content, content_hash, score, active, created_at, updated_at,
         importance, pinned, valid_from, confidence)
      VALUES ('user', 'Nathan prefers concise answers.', 'profile-fact-hash', 1, 1, ?, ?, 7, 1, ?, 1)
    `).run(now, now, now);
    assert.ok(Number(profileFact.lastInsertRowid) > 0);
    const entity = db.prepare(`
      INSERT INTO entities
        (entity_type, canonical_name, canonical_name_lc, aliases_json,
         first_seen_at, last_seen_at, mention_count)
      VALUES ('person', 'Dana Lee', 'dana lee', '[]', ?, ?, 1)
    `).run(now, now);
    const entityId = Number(entity.lastInsertRowid);
    db.prepare(`
      INSERT INTO fact_entities
        (fact_id, entity_id, created_at, link_type, confidence,
         evidence_episode_id, evidence_excerpt)
      VALUES (?, ?, ?, 'extracted', 0.98, ?, ?)
    `).run(
      meetingFactId,
      entityId,
      now,
      episodeId,
      'Dana said the Northstar launch review is Friday.',
    );
    const projectEntity = db.prepare(`
      INSERT INTO entities
        (entity_type, canonical_name, canonical_name_lc, aliases_json,
         first_seen_at, last_seen_at, mention_count)
      VALUES ('project', 'Northstar', 'northstar', '[]', ?, ?, 1)
    `).run(now, now);
    const projectEntityId = Number(projectEntity.lastInsertRowid);
    db.prepare(`
      INSERT INTO fact_entities
        (fact_id, entity_id, created_at, link_type, confidence,
         evidence_episode_id, evidence_excerpt)
      VALUES (?, ?, ?, 'inferred_text', 0.55, NULL, NULL)
    `).run(meetingFactId, projectEntityId, now);
    const resource = db.prepare(`
      INSERT INTO resource_pointers
        (app, kind, ref, name, whats_here, source, first_seen_at, last_seen_at, mention_count)
      VALUES ('Google Drive', 'folder', 'google-drive:folder:q3-planning', 'Q3 Planning',
              'Launch plans and review notes', 'reactive', ?, ?, 1)
    `).run(now, now);
    const resourceId = Number(resource.lastInsertRowid);
    db.prepare(`
      INSERT INTO fact_resources
        (fact_id, resource_id, created_at, link_type, confidence,
         evidence_episode_id, evidence_excerpt)
      VALUES (?, ?, ?, 'inferred_text', 0.55, NULL, NULL)
    `).run(meetingFactId, resourceId, now);
    const duplicateEntity = db.prepare(`
      INSERT INTO entities
        (entity_type, canonical_name, canonical_name_lc, aliases_json,
         first_seen_at, last_seen_at, mention_count)
      VALUES ('person', 'D. Lee', 'd. lee', '[]', ?, ?, 1)
    `).run(now, now);
    const duplicateEntityId = Number(duplicateEntity.lastInsertRowid);
    const insertIdentifier = db.prepare(`
      INSERT INTO entity_identifiers
        (entity_id, scheme, value, value_norm, confidence,
         evidence_episode_id, source_uri, first_seen_at, last_seen_at)
      VALUES (?, 'email', 'dana@example.com', 'dana@example.com', 0.99,
              NULL, NULL, ?, ?)
    `);
    insertIdentifier.run(entityId, now, now);
    insertIdentifier.run(duplicateEntityId, now, now);
    db.close();

    const beforeHash = fileHash(sourcePath);
    const report = await rehearseMemoryMigration(sourcePath, {
      keepCopy: true,
      now: '2026-07-15T19:00:00.000Z',
    });

    assert.equal(report.ready, true);
    assert.equal(report.migration.success, true);
    assert.equal(report.migration.error, null);
    assert.equal(report.migration.identityReconciliation?.groupsMerged, 1);
    assert.equal(report.migration.identityReconciliation?.entitiesRedirected, 1);
    assert.equal(report.migration.groundedFactEntityBackfill?.promoted, 1);
    assert.equal(report.migration.groundedFactResourceBackfill?.promoted, 1);
    assert.equal(report.migration.legacyReflectionBackfill?.batchesBackfilled, 1);
    assert.equal(report.migration.legacyReflectionBackfill?.candidatesInserted, 1);
    assert.equal(report.migration.expiredLegacyReflectionBatches, 0);
    assert.equal(report.source.schemaVersionBefore, 21);
    assert.equal(report.source.schemaVersionAfter, 21);
    assert.equal(report.source.observedUnchanged, true);
    assert.equal(fileHash(sourcePath), beforeHash, 'source database bytes never change');
    assert.equal(report.copy.schemaVersionBefore, 21);
    assert.equal(report.copy.schemaVersionAfter, MEMORY_SCHEMA_VERSION);
    assert.deepEqual(report.copy.migrationsApplied, [22, 23, 24, 25, 26, 27, 28, 29]);
    assert.deepEqual(report.copy.integrityMessages, ['ok']);
    assert.equal(report.copy.foreignKeyViolations, 0);
    assert.deepEqual(report.copy.inventoryAfter, report.copy.inventoryBefore);
    assert.equal(report.copy.preservation.canonicalRowsPreserved, true);
    assert.equal(report.readiness.ready, true);
    assert.equal(report.copy.deleted, false);
    assert.ok(report.copy.path && existsSync(report.copy.path));
    retainedCopyDirectory = path.dirname(report.copy.path!);

    const migrated = new Database(report.copy.path!, { readonly: true });
    try {
      assert.equal(tableExists(migrated, 'memory_migration_audit'), true);
      assert.equal(tableExists(migrated, 'memory_reflection_candidates'), true);
      assert.deepEqual(
        migrated.prepare(`
          SELECT status, source_type, resulting_fact_id
          FROM memory_reflection_candidates
          WHERE session_id = 'session-live' AND call_id = 'call-live'
        `).get(),
        { status: 'pending', source_type: 'tool_reflection', resulting_fact_id: null },
        'exact pre-ledger extractor history is projected before the upgraded boot can expire it',
      );
      assert.deepEqual(
        migrated.prepare(`
          SELECT source_entity_id, canonical_entity_id FROM entity_redirects
          WHERE source_entity_id = ?
        `).get(duplicateEntityId),
        { source_entity_id: duplicateEntityId, canonical_entity_id: entityId },
        'stable personal-email duplicates converge on the disposable copy',
      );
      assert.equal(
        (migrated.prepare(`
          SELECT COUNT(*) AS count FROM fact_evidence
          WHERE fact_id = ? AND source_uri = 'recording://local/northstar-planning'
        `).get(meetingFactId) as { count: number }).count,
        1,
        'durable recording evidence survives the rehearsed migration',
      );
      assert.deepEqual(
        migrated.prepare(`
          SELECT link_type, evidence_episode_id FROM fact_entities
          WHERE fact_id = ? AND entity_id = ?
        `).get(meetingFactId, projectEntityId),
        { link_type: 'extracted', evidence_episode_id: episodeId },
        'exact entity names in surviving excerpts become stored graph truth on the disposable copy',
      );
      assert.equal(
        (migrated.prepare(`
          SELECT COUNT(*) AS count FROM entity_observations
          WHERE entity_id = ? AND episode_id = ?
        `).get(projectEntityId, episodeId) as { count: number }).count,
        1,
        'grounded backfill creates an exact entity source observation',
      );
      assert.deepEqual(
        migrated.prepare(`
          SELECT link_type, evidence_episode_id FROM fact_resources
          WHERE fact_id = ? AND resource_id = ?
        `).get(meetingFactId, resourceId),
        { link_type: 'extracted', evidence_episode_id: episodeId },
        'exact resource names in surviving excerpts become stored graph truth on the disposable copy',
      );
    } finally {
      migrated.close();
    }
  } finally {
    if (retainedCopyDirectory) rmSync(retainedCopyDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration rehearsal withholds an unsafe grounded orphan without changing the source', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-rehearsal-refusal-'));
  const sourcePath = path.join(root, 'memory-v21-broken.db');
  let retainedCopyDirectory: string | null = null;
  try {
    const db = createPhysicalV21Database(sourcePath);
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT INTO fact_entities
        (fact_id, entity_id, created_at, link_type, confidence, evidence_excerpt)
      VALUES (880001, 880002, '2026-07-15T18:00:00.000Z', 'extracted', 0.99,
              'Grounded evidence must never be silently discarded')
    `).run();
    db.close();

    const beforeHash = fileHash(sourcePath);
    const report = await rehearseMemoryMigration(sourcePath, { keepCopy: true });
    if (report.copy.path) retainedCopyDirectory = path.dirname(report.copy.path);

    assert.equal(report.ready, false);
    assert.equal(report.migration.success, false);
    assert.match(report.migration.error ?? '', /non-rebuildable foreign-key violation/);
    assert.equal(report.source.schemaVersionBefore, 21);
    assert.equal(report.source.schemaVersionAfter, 21);
    assert.equal(report.source.observedUnchanged, true);
    assert.equal(fileHash(sourcePath), beforeHash, 'refusal path never mutates source');
    assert.equal(report.copy.schemaVersionAfter, 21, 'failed migration is not recorded on the copy');
    assert.ok(report.copy.foreignKeyViolations > 0);
    assert.equal(report.readiness.ready, false);

    const source = new Database(sourcePath, { readonly: true });
    try {
      assert.equal(
        (source.prepare(`
          SELECT COUNT(*) AS count FROM fact_entities
          WHERE fact_id = 880001 AND link_type = 'extracted'
        `).get() as { count: number }).count,
        1,
        'the grounded orphan remains available for an explicit repair decision',
      );
    } finally {
      source.close();
    }
  } finally {
    if (retainedCopyDirectory) rmSync(retainedCopyDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
