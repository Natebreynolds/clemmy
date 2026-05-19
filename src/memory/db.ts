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
