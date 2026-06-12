import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync, readdirSync, statSync, statfsSync } from 'node:fs';
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
export const MEMORY_BACKUP_DIR = path.join(STATE_DIR, 'backups');

export type ConsolidatedFactKind = 'user' | 'project' | 'feedback' | 'reference' | 'constraint';

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
  // v5 (brain Phase 2 — recursive reflection / Stanford trees, §4.2):
  //   derivation_depth      — 0 for atomic facts derived from tool returns
  //                           (or direct user statements); 1 for first-level
  //                           recursive patterns; 2 cap.
  //   derived_from_fact_ids — JSON array of source fact ids when depth>0.
  //                           NULL for depth=0 facts.
  derivation_depth: number;
  derived_from_fact_ids: string | null;
  // v8 — pinned standing instruction. 1 = always injected into the
  // prompt, exempt from the top-N cap and recency decay.
  pinned: number;
  // v9 — friendly app name when the fact was derived from a system of
  // record (Salesforce/Outlook/Airtable/…). NULL otherwise. Provenance
  // only; the trust prior lives in trust_level.
  source_app: string | null;
  // v11 — number of times this fact has been surfaced into a prompt.
  // Folded as log(1+access_count) into the recall score (reinforcement)
  // and used as a decay-resistance signal. Defaults to 0.
  access_count: number;
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

export interface ResourcePointerRow {
  id: number;
  app: string;
  kind: string;
  ref: string;
  name: string;
  whats_here: string | null;
  when_to_use: string | null;
  parent_ref: string | null;
  trust: number | null;
  source: string;
  first_seen_at: string;
  last_seen_at: string;
  mention_count: number;
}

export type FocusStatus = 'active' | 'paused' | 'completed' | 'abandoned';

export interface FocusRow {
  id: number;
  resource_ref: string;
  title: string;
  summary: string;
  status: FocusStatus;
  resource_kind: string | null;
  related_session_id: string | null;
  related_goal_id: string | null;
  created_at: string;
  last_touched_at: string;
  confirm_after: string;
  parked_at: string | null;
  parked_reason: string | null;
  metadata_json: string;
}

let cached: Database.Database | null = null;

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

const MIGRATIONS: ({ version: number; sql: string } | { version: number; run: (db: Database.Database) => void })[] = [
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
        kind              TEXT NOT NULL CHECK (kind IN ('user','project','feedback','reference','constraint')),
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
  {
    // v5 — Brain architecture Phase 2 (recursive reflection / Stanford
    // trees, Park et al §4.2). Lets a nightly job synthesize higher-order
    // patterns from accumulated atomic facts and record them in the same
    // table with a depth marker + provenance back to the source facts.
    //   derivation_depth      — 0 for atomic facts, 1 for first-level
    //                           recursive reflections, capped at 2.
    //   derived_from_fact_ids — JSON array of contributing fact ids; null
    //                           when depth=0.
    version: 5,
    sql: `
      ALTER TABLE consolidated_facts ADD COLUMN derivation_depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE consolidated_facts ADD COLUMN derived_from_fact_ids TEXT;

      CREATE INDEX IF NOT EXISTS idx_facts_derivation_depth
        ON consolidated_facts(derivation_depth, created_at DESC);
    `,
  },
  {
    // v6 — Current Focus: an attention pointer separate from long-term
    // goals (vault/goals/*.json) and from atomic facts. Solves the
    // "every Discord message starts a new session and loses the thread"
    // problem (2026-05-23). Single-active invariant enforced by a
    // partial unique index so two parallel writes can't both be active.
    // Per-user scoping deferred until multi-owner deployments exist;
    // this Clementine install is single-owner.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS current_focus (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_ref        TEXT NOT NULL,
        title               TEXT NOT NULL,
        summary             TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('active','paused','completed','abandoned')),
        resource_kind       TEXT,
        related_session_id  TEXT,
        related_goal_id     TEXT,
        created_at          TEXT NOT NULL,
        last_touched_at     TEXT NOT NULL,
        confirm_after       TEXT NOT NULL,
        parked_at           TEXT,
        parked_reason       TEXT,
        metadata_json       TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_focus_status
        ON current_focus(status, last_touched_at DESC);

      -- DB-level enforcement: at most one row may be status='active'.
      -- Switching focus must park the current active first.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_one_active
        ON current_focus(status) WHERE status = 'active';
    `,
  },
  {
    // v7 — Fact embeddings. The `embeddings` table (v1) is keyed to
    // vault_chunks only, so consolidated_facts had no semantic search:
    // the reflection conflict-resolver's candidate retrieval
    // (findSimilarFacts) fell back to LIKE-token matching and missed
    // paraphrased contradictions ("prefers Tuesday" vs "Wednesdays work
    // best"). This table gives facts the same Float32-BLOB treatment as
    // chunks. `content_hash` lets the backfill detect a fact whose
    // content changed (updateFact rewrites the hash) and re-embed it.
    // FK-cascaded so a hard fact delete drops its embedding for free.
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS fact_embeddings (
        fact_id      INTEGER PRIMARY KEY REFERENCES consolidated_facts(id) ON DELETE CASCADE,
        model        TEXT NOT NULL,
        dim          INTEGER NOT NULL,
        vector       BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `,
  },
  {
    // v8 — Pinned standing instructions. A pinned fact is ALWAYS injected
    // into the prompt, exempt from the top-N recency/relevance cap, so a
    // durable rule ("never email clients on Fridays") can't silently age
    // out of context as the fact pool grows. Additive column, default 0.
    version: 8,
    sql: `
      ALTER TABLE consolidated_facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_facts_pinned
        ON consolidated_facts(pinned, active);
    `,
  },
  {
    // v9 — Source app provenance (connectors-as-authoritative-writers).
    // Friendly name of the app a derived fact came from (e.g. "Salesforce",
    // "Outlook / Microsoft 365") when the fact was derived from a system of
    // record, so the UI/audit can show WHERE a fact originated and the
    // resolver can prefer ground truth. NULL for user-stated + generic
    // derived facts. The trust prior lives in the existing trust_level
    // column; this column is provenance only.
    version: 9,
    sql: `
      ALTER TABLE consolidated_facts ADD COLUMN source_app TEXT;
    `,
  },
  {
    // v10 — Source-map / landscape memory. A POINTER-FIRST navigational
    // index of WHERE the user's data lives (Drive folders, Airtable bases,
    // CRM objects, …) and WHEN to use it — never the content itself. One row
    // per distinct resource (UNIQUE(app, ref)); touches bump mention_count +
    // last_seen so the map stays bounded. See docs/source-map-landscape-memory.md.
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS resource_pointers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        app           TEXT NOT NULL,
        kind          TEXT NOT NULL,
        ref           TEXT NOT NULL,
        name          TEXT NOT NULL,
        whats_here    TEXT,
        when_to_use   TEXT,
        parent_ref    TEXT,
        trust         REAL,
        source        TEXT NOT NULL DEFAULT 'reactive',
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        mention_count INTEGER NOT NULL DEFAULT 1,
        UNIQUE(app, ref)
      );

      CREATE INDEX IF NOT EXISTS idx_resource_last_seen
        ON resource_pointers(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_resource_app
        ON resource_pointers(app, last_seen_at DESC);
    `,
  },
  {
    // v11 — access-frequency reinforcement (Stanford "Generative Agents" §4:
    // retrieval frequency feeds the importance/recency loop). access_count
    // increments every time a fact is surfaced (touchFactAccess); the recall
    // score folds in log(1+access_count) so a repeatedly-useful fact ranks
    // higher AND resists decay — memory compounds and sharpens with use instead
    // of treating a fact recalled 50x the same as one never recalled.
    version: 11,
    sql: `
      ALTER TABLE consolidated_facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // v12 — widen the kind CHECK to admit 'constraint'. The 'constraint' kind
    // was added to the TS types (2026-06-10) but the CHECK was never migrated,
    // so every INSERT of a constraint fact threw and listConstraints() stayed
    // empty — which is why the dispatch-time constraint gate never enforced
    // anything (2026-06-11 wrong-mailbox incident). SQLite can't ALTER a
    // CHECK, so this is the documented full-rebuild procedure. It must run
    // with foreign_keys OFF: fact_embeddings references this table with
    // ON DELETE CASCADE, and a plain DROP would cascade-wipe every embedding.
    version: 12,
    run: (db: Database.Database) => {
      const ddl = (db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='consolidated_facts'`,
      ).get() as { sql: string } | undefined)?.sql ?? '';
      if (ddl.includes("'constraint'")) return; // fresh install — v1 already created the widened CHECK

      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE consolidated_facts_new (
              id                INTEGER PRIMARY KEY AUTOINCREMENT,
              kind              TEXT NOT NULL CHECK (kind IN ('user','project','feedback','reference','constraint')),
              content           TEXT NOT NULL,
              content_hash      TEXT NOT NULL UNIQUE,
              source_session_id TEXT,
              source_path       TEXT,
              score             REAL NOT NULL DEFAULT 1.0,
              active            INTEGER NOT NULL DEFAULT 1,
              created_at        TEXT NOT NULL,
              updated_at        TEXT NOT NULL,
              derived_from_session_id TEXT,
              derived_from_call_id    TEXT,
              derived_from_tool       TEXT,
              trust_level             REAL,
              extracted_at            TEXT,
              importance              REAL,
              last_accessed_at        TEXT,
              derivation_depth        INTEGER NOT NULL DEFAULT 0,
              derived_from_fact_ids   TEXT,
              pinned                  INTEGER NOT NULL DEFAULT 0,
              source_app              TEXT,
              access_count            INTEGER NOT NULL DEFAULT 0
            );

            INSERT INTO consolidated_facts_new (
              id, kind, content, content_hash, source_session_id, source_path,
              score, active, created_at, updated_at, derived_from_session_id,
              derived_from_call_id, derived_from_tool, trust_level, extracted_at,
              importance, last_accessed_at, derivation_depth, derived_from_fact_ids,
              pinned, source_app, access_count
            )
            SELECT
              id, kind, content, content_hash, source_session_id, source_path,
              score, active, created_at, updated_at, derived_from_session_id,
              derived_from_call_id, derived_from_tool, trust_level, extracted_at,
              importance, last_accessed_at, derivation_depth, derived_from_fact_ids,
              pinned, source_app, access_count
            FROM consolidated_facts;

            DROP TABLE consolidated_facts;
            ALTER TABLE consolidated_facts_new RENAME TO consolidated_facts;

            CREATE INDEX idx_facts_active ON consolidated_facts(active, kind, score DESC);
            CREATE INDEX idx_facts_extracted_at
              ON consolidated_facts(extracted_at DESC) WHERE extracted_at IS NOT NULL;
            CREATE INDEX idx_facts_importance
              ON consolidated_facts(importance DESC) WHERE importance IS NOT NULL;
            CREATE INDEX idx_facts_last_accessed
              ON consolidated_facts(last_accessed_at DESC) WHERE last_accessed_at IS NOT NULL;
            CREATE INDEX idx_facts_derivation_depth
              ON consolidated_facts(derivation_depth, created_at DESC);
            CREATE INDEX idx_facts_pinned
              ON consolidated_facts(pinned, active);
          `);
          // Inside the transaction so an orphan (id drift between copy and the
          // FK in fact_embeddings) rolls the whole rebuild back.
          const orphans = db.pragma('foreign_key_check(fact_embeddings)') as unknown[];
          if (orphans.length > 0) {
            throw new Error(`consolidated_facts rebuild would orphan ${orphans.length} fact_embeddings rows`);
          }
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    },
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
    if ('run' in migration) {
      // Callback migrations manage their own transaction (e.g. the v12 table
      // rebuild needs PRAGMA foreign_keys toggled, which is a silent no-op
      // inside an open transaction). Version is recorded only on success, so
      // a failed run retries on the next open.
      migration.run(db);
      apply.run(migration.version, new Date().toISOString());
      continue;
    }
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      apply.run(migration.version, new Date().toISOString());
    });
    tx();
  }
}

export function openMemoryDb(): Database.Database {
  // Self-heal a dead cache: if some caller closed the handle directly
  // (instead of closeMemoryDb, which resets the cache), every subsequent
  // caller would get "The database connection is not open" until daemon
  // restart. Drop the stale handle and reopen instead.
  if (cached && !cached.open) cached = null;
  if (cached) return cached;
  ensureStateDir();

  const db = new Database(MEMORY_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Checkpoint the WAL ~4x more often than the 4MB default (256 pages ≈ 1MB) so
  // the WAL stays small between the nightly TRUNCATE backup-checkpoint, even for
  // a transient process that holds the connection a while. PASSIVE under the
  // hood — never blocks writers, no-op when it can't proceed.
  db.pragma('wal_autocheckpoint = 256');

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

export interface BackupResult {
  backupPath: string;
  bytes: number;
}

/**
 * Tier C2 — disaster-recovery backup of the memory DB. Unlike the vault
 * (rebuildable from markdown), `consolidated_facts`/`entities`/`embeddings`
 * are NOT derivable from anything on disk — a corrupt memory.db loses the
 * agent's whole long-term memory. This writes a consistent, defragmented
 * snapshot and prunes to the newest `retain` copies.
 *
 * `VACUUM INTO` (vs a raw file copy) is atomic and consistent under WAL —
 * it serializes a clean page image, so the backup is never a torn mid-write
 * file. We checkpoint the WAL first so the live file is also compacted.
 */
export function backupMemoryDb(opts: { retain?: number } = {}): BackupResult | null {
  const retain = Math.max(1, opts.retain ?? 7);
  try {
    // Disk-full guard (v0.5.64): a VACUUM INTO snapshot needs room for a full
    // copy of the live DB. On a near-full disk the write fails with ENOSPC
    // every maintenance cycle (and a backup you can't write is moot anyway), so
    // skip cleanly when free space is below a safety floor instead of
    // attempting + erroring nightly. Best-effort: if statfs is unavailable,
    // proceed (the outer try/catch still soft-fails any write error to null).
    try {
      const fsStat = statfsSync(STATE_DIR);
      const freeBytes = fsStat.bavail * fsStat.bsize;
      if (freeBytes < 50 * 1024 * 1024) return null; // < ~50MB free — skip this cycle
    } catch { /* statfs unsupported — fall through and let the write try */ }

    const db = openMemoryDb();
    // Fold the WAL back into the main file (TRUNCATE resets it) so both the
    // live DB and the snapshot stay compact. Best-effort — a busy checkpoint
    // is not fatal to the backup itself.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }

    if (!existsSync(MEMORY_BACKUP_DIR)) mkdirSync(MEMORY_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(MEMORY_BACKUP_DIR, `memory-${stamp}.db`);
    // Escape single quotes for the SQL string literal (path is ours, but be safe).
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

    // Retention: ISO stamps sort lexicographically = chronologically, so the
    // oldest are at the front. Keep the newest `retain`, drop the rest.
    const backups = readdirSync(MEMORY_BACKUP_DIR)
      .filter((f) => f.startsWith('memory-') && f.endsWith('.db'))
      .sort();
    for (let i = 0; i < backups.length - retain; i++) {
      try { unlinkSync(path.join(MEMORY_BACKUP_DIR, backups[i])); } catch { /* ignore */ }
    }

    let bytes = 0;
    try { bytes = existsSync(backupPath) ? statSync(backupPath).size : 0; } catch { /* ignore */ }
    return { backupPath, bytes };
  } catch {
    return null;
  }
}

/**
 * Tier C3 — TTL reaper for `episodic_pointers`. These are breadcrumbs
 * (session_id, call_id, label) pointing at tool outputs in harness.db, which
 * the eventlog reaper drops after ~14 days. A pointer older than the tool
 * output it references is dead weight (the raw output is already gone), so we
 * retire pointers past `maxAgeDays` (default 30, comfortably beyond the
 * tool-output TTL). Same class as the always-on tool_outputs reaper: bounded,
 * indexed DELETE, no curated data lost. Returns the row count removed.
 */
export function reapStaleEpisodicPointers(opts: { maxAgeDays?: number } = {}): number {
  const maxAgeDays = Math.max(1, opts.maxAgeDays ?? 30);
  try {
    const db = openMemoryDb();
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare('DELETE FROM episodic_pointers WHERE created_at < ?').run(cutoff);
    return Number(info.changes ?? 0);
  } catch {
    return 0;
  }
}
