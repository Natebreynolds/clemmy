import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

/**
 * SQLite-backed memory index for the markdown vault.
 *
 * Design choices:
 * - The vault on disk stays the source of truth. This DB is a rebuildable
 *   index — safe to delete; the indexer will repopulate it from the vault.
 * - FTS5 over chunked markdown gives strong lexical recall with zero deps
 *   beyond `better-sqlite3` (already in package.json).
 * - The `embeddings` table is provisioned but unused on day one. When we
 *   turn on semantic recall later, no migration is needed — only an
 *   indexer pass + a recall rerank step.
 * - The `consolidated_facts` table holds durable, agent-curated facts that
 *   get injected into every conversation. The autonomy loop writes here.
 */

export const STATE_DIR = path.join(BASE_DIR, 'state');
export const MEMORY_DB_PATH = path.join(STATE_DIR, 'memory.db');

export type ConsolidatedFactKind = 'user' | 'project' | 'feedback' | 'reference';

export interface VaultChunkRow {
  id: number;
  path: string;
  chunk_index: number;
  content: string;
  title: string | null;
  mtime: number;
  byte_size: number;
  content_hash: string;
}

export interface EmbeddingRow {
  chunk_id: number;
  model: string;
  dim: number;
  vector: Buffer;
  created_at: string;
}

export interface ConsolidatedFactRow {
  id: number;
  kind: ConsolidatedFactKind;
  content: string;
  content_hash: string;
  source_session_id: string | null;
  source_path: string | null;
  score: number;
  active: number; // 0 or 1
  created_at: string;
  updated_at: string;
  // v3 (Phase 1 brain architecture) — derived-fact provenance fields.
  // NULL when the fact was directly stated by the user / agent via
  // memory_remember; populated when the reflection loop synthesized
  // the fact from a tool return.
  derived_from_session_id: string | null;
  derived_from_call_id: string | null;
  derived_from_tool: string | null;
  trust_level: number | null; // 0.0–1.0; user-stated = 1.0; derived inferred ~0.6
  extracted_at: string | null;
  // v4 (brain architecture Phase 1 expansion — Stanford-faithful):
  //   importance      — 1.0..10.0 poignancy score (Park et al §4.1). Used
  //                     to gate reflection trigger (sum-importance ≥ 150)
  //                     and as a retrieval weight in memory_search.
  //   last_accessed_at — ISO timestamp; touched on every recall. Stanford
  //                     §4.1 uses exp decay 0.995/hr from THIS column
  //                     (not creation) for the recency component of the
  //                     retrieval score.
  importance: number | null;
  last_accessed_at: string | null;
}

export type EntityType = 'person' | 'company' | 'project' | 'place' | 'thing';

export interface EntityRow {
  id: number;
  entity_type: EntityType;
  canonical_name: string;
  canonical_name_lc: string;
  aliases_json: string; // JSON array of alternate names
  first_seen_at: string;
  last_seen_at: string;
  mention_count: number;
}

export interface EpisodicPointerRow {
  id: number;
  session_id: string;
  call_id: string;
  label: string;
  tool: string | null;
  source_uri: string | null; // e.g. "outlook:thread:abc123"
  created_at: string;
}

let cached: Database.Database | null = null;

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS vault_chunks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        path          TEXT NOT NULL,
        chunk_index   INTEGER NOT NULL,
        content       TEXT NOT NULL,
        title         TEXT,
        mtime         INTEGER NOT NULL,
        byte_size     INTEGER NOT NULL,
        content_hash  TEXT NOT NULL,
        UNIQUE(path, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_vault_chunks_path  ON vault_chunks(path);
      CREATE INDEX IF NOT EXISTS idx_vault_chunks_mtime ON vault_chunks(mtime DESC);

      -- FTS5 mirror, kept in sync via triggers. content='vault_chunks' is
      -- a contentless-style binding that lets us MATCH while joining back
      -- to the row by rowid = vault_chunks.id.
      CREATE VIRTUAL TABLE IF NOT EXISTS vault_chunks_fts USING fts5(
        content,
        title,
        path UNINDEXED,
        content='vault_chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS vault_chunks_ai AFTER INSERT ON vault_chunks BEGIN
        INSERT INTO vault_chunks_fts(rowid, content, title, path)
        VALUES (new.id, new.content, COALESCE(new.title, ''), new.path);
      END;

      CREATE TRIGGER IF NOT EXISTS vault_chunks_ad AFTER DELETE ON vault_chunks BEGIN
        INSERT INTO vault_chunks_fts(vault_chunks_fts, rowid, content, title, path)
        VALUES ('delete', old.id, old.content, COALESCE(old.title, ''), old.path);
      END;

      CREATE TRIGGER IF NOT EXISTS vault_chunks_au AFTER UPDATE ON vault_chunks BEGIN
        INSERT INTO vault_chunks_fts(vault_chunks_fts, rowid, content, title, path)
        VALUES ('delete', old.id, old.content, COALESCE(old.title, ''), old.path);
        INSERT INTO vault_chunks_fts(rowid, content, title, path)
        VALUES (new.id, new.content, COALESCE(new.title, ''), new.path);
      END;

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id    INTEGER PRIMARY KEY REFERENCES vault_chunks(id) ON DELETE CASCADE,
        model       TEXT NOT NULL,
        dim         INTEGER NOT NULL,
        vector      BLOB NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consolidated_facts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        kind              TEXT NOT NULL CHECK (kind IN ('user','project','feedback','reference')),
        content           TEXT NOT NULL,
        content_hash      TEXT NOT NULL UNIQUE,
        source_session_id TEXT,
        source_path       TEXT,
        score             REAL NOT NULL DEFAULT 1.0,
        active            INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_facts_active ON consolidated_facts(active, kind, score DESC);
    `,
  },
  {
    version: 2,
    sql: `
      -- Inbound message inbox. Channels (Discord, dashboard, webhook)
      -- write 'received' before handing off to the gateway and mark
      -- 'replied' once delivery confirms. PRIMARY KEY enforces
      -- idempotency: redelivery of the same provider message id is a
      -- no-op. On daemon restart, anything not in ('replied','dropped')
      -- can be replayed without double-billing the model.
      CREATE TABLE IF NOT EXISTS inbound_messages (
        channel            TEXT NOT NULL,
        source_message_id  TEXT NOT NULL,
        session_id         TEXT,
        user_id            TEXT,
        run_id             TEXT,
        status             TEXT NOT NULL CHECK (status IN ('received','claimed','replied','failed','dropped')),
        attempts           INTEGER NOT NULL DEFAULT 0,
        error              TEXT,
        received_at        TEXT NOT NULL,
        claimed_at         TEXT,
        completed_at       TEXT,
        PRIMARY KEY (channel, source_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_inbound_status ON inbound_messages(status, received_at);
    `,
  },
  {
    // v3 — Phase 1 brain architecture (Stanford Generative Agents
    // reflection loop + Tulving's memory taxonomy).
    //
    // Three additions:
    //  (a) Extend consolidated_facts with derivation provenance so a
    //      fact synthesized from a tool return links back to its
    //      source call_id. Enables the "go look at the original"
    //      pointer-first model — see [[project_brain_architecture]].
    //  (b) New `entities` table — first-class registry of people,
    //      companies, projects the brain knows about. Aliases enable
    //      cross-source matching ("Marlow" in Outlook = marlow@acme.com).
    //  (c) New `episodic_pointers` table — short labels that point at a
    //      specific tool_outputs row (session_id + call_id), so the
    //      agent can refer to "the pricing convo" and recall fetches
    //      the actual content via recall_tool_result.
    version: 3,
    sql: `
      ALTER TABLE consolidated_facts ADD COLUMN derived_from_session_id TEXT;
      ALTER TABLE consolidated_facts ADD COLUMN derived_from_call_id   TEXT;
      ALTER TABLE consolidated_facts ADD COLUMN derived_from_tool      TEXT;
      ALTER TABLE consolidated_facts ADD COLUMN trust_level             REAL;
      ALTER TABLE consolidated_facts ADD COLUMN extracted_at            TEXT;

      CREATE INDEX IF NOT EXISTS idx_facts_extracted_at
        ON consolidated_facts(extracted_at DESC) WHERE extracted_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS entities (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type       TEXT NOT NULL CHECK (entity_type IN ('person','company','project','place','thing')),
        canonical_name    TEXT NOT NULL,
        canonical_name_lc TEXT NOT NULL,
        aliases_json      TEXT NOT NULL DEFAULT '[]',
        first_seen_at     TEXT NOT NULL,
        last_seen_at      TEXT NOT NULL,
        mention_count     INTEGER NOT NULL DEFAULT 1,
        UNIQUE(entity_type, canonical_name_lc)
      );

      CREATE INDEX IF NOT EXISTS idx_entities_last_seen
        ON entities(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_entities_type_name
        ON entities(entity_type, canonical_name_lc);

      CREATE TABLE IF NOT EXISTS episodic_pointers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        call_id     TEXT NOT NULL,
        label       TEXT NOT NULL,
        tool        TEXT,
        source_uri  TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_episodic_session
        ON episodic_pointers(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodic_call
        ON episodic_pointers(call_id);
    `,
  },
  {
    // v4 — Brain architecture Phase 1 expansion, closing the Stanford
    // Generative Agents research gaps documented in
    // [[project_brain_phase1_gaps]]:
    //   - `importance` (1.0–10.0): Park et al §4.1's poignancy score.
    //     Used by reflection.ts to gate the trigger via sum-threshold
    //     (Stanford uses 150) AND as a retrieval weight in memory_search.
    //   - `last_accessed_at`: Stanford §4.1's "since last retrieval"
    //     anchor for the recency component (exp decay 0.995/hr). Touched
    //     on every memory_search/recall hit.
    version: 4,
    sql: `
      ALTER TABLE consolidated_facts ADD COLUMN importance REAL;
      ALTER TABLE consolidated_facts ADD COLUMN last_accessed_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_facts_importance
        ON consolidated_facts(importance DESC) WHERE importance IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_facts_last_accessed
        ON consolidated_facts(last_accessed_at DESC) WHERE last_accessed_at IS NOT NULL;
    `,
  },
];

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const current = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
  const apply = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      apply.run(migration.version, new Date().toISOString());
    });
    tx();
  }
}

export function openMemoryDb(): Database.Database {
  if (cached) return cached;
  ensureStateDir();

  const db = new Database(MEMORY_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  cached = db;
  return db;
}

export function closeMemoryDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/**
 * Drop and re-open the memory DB. Used by tests and the `clementine doctor
 * --rebuild-index` path. Safe because the vault is the source of truth.
 */
export function resetMemoryDb(): void {
  closeMemoryDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = MEMORY_DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}
