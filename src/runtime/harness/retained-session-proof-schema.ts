/** Storage lifetime for retained task identity. No eventlog, tool or model imports.
 * Immutable during a session's life; deleted only with that owning session.
 * Cross-session proof references remain restrictive and are pruned from the
 * reaper's candidate set before any row is deleted. */
import type Database from 'better-sqlite3';

type Definition = { name: string; columns: string[]; body: string; indexes?: string };
const plans: Definition[] = [
  { name: 'reviewed_plan_revisions_v1',
    columns: ['plan_id', 'revision', 'digest', 'session_id', 'source_user_seq', 'principal_id', 'artifact_json', 'event_id'],
    body: `plan_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), digest TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_user_seq INTEGER NOT NULL REFERENCES events(seq), principal_id TEXT NOT NULL,
      artifact_json TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id),
      base_plan_id TEXT GENERATED ALWAYS AS (json_extract(artifact_json, '$.base.planId')) VIRTUAL,
      base_revision INTEGER GENERATED ALWAYS AS (json_extract(artifact_json, '$.base.revision')) VIRTUAL,
      PRIMARY KEY(plan_id, revision), UNIQUE(session_id, source_user_seq),
      FOREIGN KEY(base_plan_id, base_revision) REFERENCES reviewed_plan_revisions_v1(plan_id, revision)`,
    indexes: `CREATE INDEX IF NOT EXISTS reviewed_plan_revision_base ON reviewed_plan_revisions_v1(base_plan_id, base_revision);` },
  { name: 'reviewed_plan_execution_claims_v1',
    columns: ['claim_id', 'plan_id', 'revision', 'session_id', 'source_user_seq', 'claim_json', 'event_id'],
    body: `claim_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_user_seq INTEGER NOT NULL REFERENCES events(seq), claim_json TEXT NOT NULL,
      event_id TEXT NOT NULL REFERENCES events(id), UNIQUE(plan_id, revision), UNIQUE(session_id, source_user_seq),
      FOREIGN KEY(plan_id, revision) REFERENCES reviewed_plan_revisions_v1(plan_id, revision)` },
  { name: 'reviewed_plan_execution_observers_v1', columns: ['session_id', 'source_user_seq', 'claim_id', 'source_digest'],
    body: `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_user_seq INTEGER NOT NULL REFERENCES events(seq),
      claim_id TEXT NOT NULL REFERENCES reviewed_plan_execution_claims_v1(claim_id),
      source_digest TEXT NOT NULL, PRIMARY KEY(session_id, source_user_seq)` },
];
const context: Definition = { name: 'source_session_contexts_v1',
  columns: ['session_id', 'source_user_seq', 'identity_json', 'identity_digest'],
  body: `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_user_seq INTEGER NOT NULL REFERENCES events(seq), identity_json TEXT NOT NULL, identity_digest TEXT NOT NULL,
    parent_session_id TEXT GENERATED ALWAYS AS (json_extract(identity_json, '$.parent.sessionId')) VIRTUAL,
    parent_source_user_seq INTEGER GENERATED ALWAYS AS (json_extract(identity_json, '$.parent.sourceUserSeq')) VIRTUAL,
    PRIMARY KEY(session_id, source_user_seq),
    FOREIGN KEY(parent_session_id, parent_source_user_seq) REFERENCES source_session_contexts_v1(session_id, source_user_seq)`,
  indexes: `CREATE INDEX IF NOT EXISTS source_session_context_parent ON source_session_contexts_v1(parent_session_id, parent_source_user_seq);` };
const checkpoint: Definition = { name: 'source_connection_checkpoints_v1',
  columns: ['request_id', 'session_id', 'source_user_seq', 'checkpoint_json', 'checkpoint_digest'],
  body: `request_id TEXT PRIMARY KEY REFERENCES dependency_requests(request_id),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_user_seq INTEGER NOT NULL, checkpoint_json TEXT NOT NULL, checkpoint_digest TEXT NOT NULL` };

function create(db: Database.Database, definition: Definition): void {
  const { name, body } = definition;
  db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${body});
    CREATE TRIGGER IF NOT EXISTS ${name}_no_update BEFORE UPDATE ON ${name}
      BEGIN SELECT RAISE(ABORT, 'retained task proof is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${name}_no_delete BEFORE DELETE ON ${name}
      WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
      BEGIN SELECT RAISE(ABORT, 'retained task proof is immutable'); END;
    ${definition.indexes ?? ''}`);
}
export function ensureReviewedPlanStore(db: Database.Database): void { for (const definition of plans) create(db, definition); }
export function ensureSourceSessionContextStore(db: Database.Database): void { create(db, context); }
export function ensureSourceConnectionCheckpointStore(db: Database.Database): void { create(db, checkpoint); }

function exists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** Migration 83 runs in the migration transaction with foreign keys disabled.
 * Copy the original columns byte-for-byte; generated references add no claims.
 * A missing parent/corrupt store aborts and restores the entire old schema. */
export function migrateRetainedSessionProofs(db: Database.Database): void {
  if (!db.inTransaction || Number(db.pragma('foreign_keys', { simple: true })) !== 0) {
    throw new Error('Retained proof migration requires its schema transaction and foreign-key cutover.');
  }
  const definitions = [...plans, context, checkpoint].filter(definition => exists(db, definition.name));
  if (!definitions.length) return;
  for (const definition of definitions) {
    const replacement = `${definition.name}_retention_v83`;
    const columns = definition.columns.join(', ');
    if (exists(db, replacement)) throw new Error('Retained proof migration found an unexpected replacement table.');
    db.exec(`CREATE TABLE ${replacement} (${definition.body});
      INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM ${definition.name};
      DROP TABLE ${definition.name};
      ALTER TABLE ${replacement} RENAME TO ${definition.name};`);
    create(db, definition);
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length !== 0
    || (db.pragma('quick_check', { simple: true }) !== 'ok')) {
    throw new Error('Retained proof migration failed storage integrity checks; no migration was committed.');
  }
}

/** Each edge names the session whose proof is needed by another session.
 * References within one session disappear with it and need no extra hold. */
function dependencyEdges(db: Database.Database): string[] {
  const edges: string[] = [];
  if (exists(db, context.name)) edges.push(`SELECT parent_session_id AS owner, session_id AS consumer
    FROM source_session_contexts_v1 WHERE parent_session_id IS NOT NULL`);
  if (exists(db, plans[0]!.name)) edges.push(`SELECT parent.session_id AS owner, child.session_id AS consumer
    FROM reviewed_plan_revisions_v1 child JOIN reviewed_plan_revisions_v1 parent
      ON parent.plan_id = child.base_plan_id AND parent.revision = child.base_revision`);
  if (exists(db, plans[1]!.name)) edges.push(`SELECT parent.session_id AS owner, child.session_id AS consumer
    FROM reviewed_plan_execution_claims_v1 child JOIN reviewed_plan_revisions_v1 parent
      ON parent.plan_id = child.plan_id AND parent.revision = child.revision`);
  if (exists(db, plans[2]!.name)) edges.push(`SELECT parent.session_id AS owner, child.session_id AS consumer
    FROM reviewed_plan_execution_observers_v1 child JOIN reviewed_plan_execution_claims_v1 parent
      ON parent.claim_id = child.claim_id`);
  return edges;
}

/** Called inside the existing fixed-point reaper. Only narrows eligibility. */
export function pruneRetainedProofSessionOwners(db: Database.Database): number {
  let pruned = 0;
  const edges = dependencyEdges(db);
  if (edges.length) pruned += db.prepare(`WITH edges AS (${edges.join(' UNION ALL ')})
    DELETE FROM reap_doomed_session_ids WHERE id IN (
      SELECT owner FROM edges WHERE consumer != owner
        AND consumer NOT IN (SELECT id FROM reap_doomed_session_ids)
    )`).run().changes;
  // A connection question can end its physical attempt while retaining open
  // execution. Session display status alone must not expire that paused work.
  if (exists(db, checkpoint.name)) pruned += db.prepare(`DELETE FROM reap_doomed_session_ids WHERE id IN (
    SELECT checkpoint.session_id FROM source_connection_checkpoints_v1 checkpoint
    JOIN accepted_turn_call_authorities root ON root.session_id = checkpoint.session_id
      AND root.source_user_seq = checkpoint.source_user_seq WHERE root.state = 'open'
  )`).run().changes;
  return pruned;
}

/** Hard-delete surfaces archive rather than breaking a remaining consumer. */
export function sessionHasRetainedProofConsumer(db: Database.Database, sessionId: string): boolean {
  const edges = dependencyEdges(db);
  return edges.length > 0 && Boolean(db.prepare(`WITH edges AS (${edges.join(' UNION ALL ')})
    SELECT 1 FROM edges WHERE owner = ? AND consumer != owner LIMIT 1`).get(sessionId));
}

/** Session-owned evidence has mutually dependent RESTRICT references. Defer
 * only inside this synchronous deletion transaction, then check the resulting
 * whole proof graph before restoring the caller's constraint mode. Foreign
 * keys and immutable triggers stay enabled. A surviving reference aborts the
 * surrounding transaction/savepoint, including any preparatory cleanup. */
export function withSessionProofCascade<T>(db: Database.Database, remove: () => T): T {
  if (!db.inTransaction || Number(db.pragma('foreign_keys', { simple: true })) !== 1) {
    throw new Error('Session proof deletion requires a transaction with foreign keys enabled.');
  }
  const deferred = Number(db.pragma('defer_foreign_keys', { simple: true })) === 1;
  db.pragma('defer_foreign_keys = ON');
  try {
    const result = remove();
    if ((db.pragma('foreign_key_check') as unknown[]).length) {
      throw new Error('FOREIGN KEY constraint failed: session deletion would strand retained proof.');
    }
    return result;
  } finally {
    db.pragma(`defer_foreign_keys = ${deferred ? 'ON' : 'OFF'}`);
  }
}
