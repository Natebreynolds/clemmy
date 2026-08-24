/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/physical-dispatch-refinement-lease-schema-v58.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-refined-lease-v58-migration-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

const NOW = '2026-08-23T12:00:00.000Z';
const TOOL = 'registry_control_write';
const RAW_DIGEST = '1'.repeat(64);
const EFFECTIVE_DIGEST = '2'.repeat(64);
const UNRELATED_DIGEST = '3'.repeat(64);

function appendEvent(db: Database.Database, input: {
  id: string;
  sessionId: string;
  turn: number;
  role: 'user' | 'system';
  type: string;
}): number {
  const inserted = db.prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, '{}', ?)
  `).run(input.id, input.sessionId, input.turn, input.role, input.type, NOW);
  return Number(inserted.lastInsertRowid);
}

function seedRefinedCallAtV57(db: Database.Database) {
  const sessionId = 'v58-migration-session';
  const sourceEventId = 'v58-source';
  db.prepare(`
    INSERT INTO sessions
      (id, kind, created_at, updated_at, status, metadata_json)
    VALUES (?, 'chat', ?, ?, 'active', '{}')
  `).run(sessionId, NOW, NOW);
  const sourceUserSeq = appendEvent(db, {
    id: sourceEventId,
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
  });
  const acceptedTaskId = `task:${sessionId}#${sourceUserSeq}`;
  const digest = (character: string) => character.repeat(64);
  db.prepare(`
    INSERT INTO accepted_turn_call_authorities
      (session_id, source_user_seq, accepted_task_id, authority_protocol,
       authority_kind, source_event_id, source_event_digest, source_turn,
       engine_version, surface_version, surface_digest, effect_ceiling,
       effect_bounds_json, max_logical_calls, max_parallel_calls,
       catalog_revision_digest, binding_revision_digest,
       authority_digest, state, revision, opened_at)
    VALUES (?, ?, ?, 1, 'host_v1', ?, ?, 1,
            'host_v1', 'configured_harness_capability_surface_v1', ?, 'admin',
            '["admin","compute","external_write","host_only","local_write","read"]',
            8, 4, ?, ?, ?, 'open', 0, ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    sourceEventId,
    digest('a'),
    digest('b'),
    digest('c'),
    digest('d'),
    digest('e'),
    NOW,
  );
  const logicalToolCallId = 'logical:refined-v58';
  db.prepare(`
    INSERT INTO logical_tool_calls
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       tool_name, argument_digest, raw_argument_digest, state, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId,
    TOOL,
    RAW_DIGEST,
    RAW_DIGEST,
    NOW,
  );
  const refinementEventId = 'v58-refinement';
  appendEvent(db, {
    id: refinementEventId,
    sessionId,
    turn: 1,
    role: 'system',
    type: 'logical_call_contract_refined',
  });
  db.prepare(`
    UPDATE logical_tool_calls
       SET argument_digest = ?, effective_argument_digest = ?,
           refined_at = ?, refinement_event_id = ?
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).run(
    EFFECTIVE_DIGEST,
    EFFECTIVE_DIGEST,
    NOW,
    refinementEventId,
    sessionId,
    sourceUserSeq,
    logicalToolCallId,
  );
  const scopeId = `${sessionId}::call`;
  const leaseId = 'lease-v58-migration';
  db.prepare(`
    INSERT INTO run_dispatch_leases
      (scope_id, session_id, lease_id, activated_at,
       source_user_seq, accepted_task_id, logical_tool_call_id,
       recovery_effect, recovery_business_call, recovery_tool_name,
       recovery_argument_digest, recovery_argument_cipher, recovery_turn)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'local_write', 1, ?, ?, 'sealed-v58', 1)
  `).run(
    scopeId,
    sessionId,
    leaseId,
    NOW,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId,
    TOOL,
    RAW_DIGEST,
  );
  return {
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId,
    scopeId,
    leaseId,
  };
}

function insertPhysical(db: Database.Database, input: ReturnType<typeof seedRefinedCallAtV57>, options: {
  id: string;
  eventId: string;
  ordinal: number;
  argumentDigest: string;
}): void {
  appendEvent(db, {
    id: options.eventId,
    sessionId: input.sessionId,
    turn: 1,
    role: 'system',
    type: 'physical_dispatch_started',
  });
  db.prepare(`
    INSERT INTO physical_dispatches
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       physical_dispatch_id, ordinal, relation, retry_of, tool_name,
       argument_digest, state, started_at, start_event_id, execution_site,
       lease_scope_id, lease_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'started', ?, ?, 'host', ?, ?)
  `).run(
    input.sessionId,
    input.sourceUserSeq,
    input.acceptedTaskId,
    input.logicalToolCallId,
    options.id,
    options.ordinal,
    options.ordinal === 1 ? 'primary' : 'child',
    TOOL,
    options.argumentDigest,
    NOW,
    options.eventId,
    input.scopeId,
    input.leaseId,
  );
}

function durableSeedRows(db: Database.Database): unknown {
  return {
    sessions: db.prepare(`SELECT * FROM sessions WHERE id = 'v58-migration-session'`).all(),
    events: db.prepare(`SELECT * FROM events WHERE session_id = 'v58-migration-session' ORDER BY seq`).all(),
    roots: db.prepare(`SELECT * FROM accepted_turn_call_authorities WHERE session_id = 'v58-migration-session'`).all(),
    calls: db.prepare(`SELECT * FROM logical_tool_calls WHERE session_id = 'v58-migration-session'`).all(),
    leases: db.prepare(`SELECT * FROM run_dispatch_leases WHERE session_id = 'v58-migration-session'`).all(),
  };
}

test('v57 to v58 replaces the lease trigger without rewriting durable call bytes', () => {
  const db = new Database(path.join(TMP_HOME, 'v57-to-v58.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 57);
    assert.equal((db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
      version: number;
    }).version, 57);
    const input = seedRefinedCallAtV57(db);
    const oldTrigger = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_physical_dispatch_lease_owner'
    `).get() as { sql: string };
    assert.doesNotMatch(oldTrigger.sql, /call\.raw_argument_digest = lease\.recovery_argument_digest/);
    assert.throws(
      () => insertPhysical(db, input, {
        id: 'physical-old-trigger-refusal',
        eventId: 'event-old-trigger-refusal',
        ordinal: 1,
        argumentDigest: EFFECTIVE_DIGEST,
      }),
      /physical dispatch requires its exact current call lease/,
      'v57 demonstrates the raw-lease/effective-dispatch defect',
    );
    const before = durableSeedRows(db);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatches`).get() as { n: number }).n, 0);

    schema.applyHarnessMigrations(db);

    assert.deepEqual(durableSeedRows(db), before, 'v58 does not reinterpret the logical call or lease');
    assert.equal((db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
      version: number;
    }).version, HARNESS_SCHEMA_VERSION);
    const newTrigger = db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_physical_dispatch_lease_owner'
    `).get() as { sql: string };
    assert.match(newTrigger.sql, /call\.raw_argument_digest = lease\.recovery_argument_digest/);
    assert.match(newTrigger.sql, /NEW\.argument_digest = call\.effective_argument_digest/);

    insertPhysical(db, input, {
      id: 'physical-effective-positive',
      eventId: 'event-effective-positive',
      ordinal: 1,
      argumentDigest: EFFECTIVE_DIGEST,
    });
    assert.deepEqual(db.prepare(`
      SELECT argument_digest, lease_scope_id, lease_id
        FROM physical_dispatches
       WHERE physical_dispatch_id = 'physical-effective-positive'
    `).get(), {
      argument_digest: EFFECTIVE_DIGEST,
      lease_scope_id: input.scopeId,
      lease_id: input.leaseId,
    });
    assert.throws(
      () => insertPhysical(db, input, {
        id: 'physical-unrelated-negative',
        eventId: 'event-unrelated-negative',
        ordinal: 2,
        argumentDigest: UNRELATED_DIGEST,
      }),
      /physical dispatch requires its exact current call lease/,
    );
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatches`).get() as { n: number }).n, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);

    const frozenTrigger = db.prepare(`
      SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_physical_dispatch_lease_owner'
    `).get();
    const frozenVersions = db.prepare(`SELECT * FROM schema_version ORDER BY version`).all();
    schema.applyHarnessMigrations(db);
    assert.deepEqual(db.prepare(`
      SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'trg_physical_dispatch_lease_owner'
    `).get(), frozenTrigger);
    assert.deepEqual(db.prepare(`SELECT * FROM schema_version ORDER BY version`).all(), frozenVersions);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    db.close();
  }
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
