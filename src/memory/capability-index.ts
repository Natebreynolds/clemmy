/**
 * The connect-time capability index — what this install can DO right now.
 *
 * Every other capability store here is USE-derived: the alias index is
 * materialized from verified read receipts, tool-choice pins are learned from
 * successful dispatches, procedure artifacts are recorded after the fact. That
 * is the right shape for "what worked before," and it is exactly the wrong
 * shape for a blank install: on day one those stores are empty by
 * construction, so a freshly connected toolkit is invisible until the model
 * spends a live provider search — per turn, per role — to rediscover what the
 * user already told us they connected.
 *
 * This index is PROVISIONING-derived. When a capability becomes available —
 * a Composio toolkit connects, an MCP server is added, a CLI is discovered —
 * its operations are enumerated once and recorded here, so the very first turn
 * can retrieve them locally. It carries no authority: a row proves that an
 * operation EXISTS and what it appears to do, never that it may run. Dispatch
 * still resolves schema through the contract store, still binds an account,
 * still revalidates live, and still passes every effect gate. Deliberately
 * NOT stored here: input schemas (owned by tool-contract-store) and manifests
 * (dispatch authority, owned by capability-manifest-store) — one writer per
 * fact.
 *
 * Storage follows the alias-index precedent: a per-machine SQLite database, so
 * machine-scoped facts (a CLI's path, a server's local availability) never
 * leak across machines that share a home directory.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';

/** Where an operation came from. Adding a carrier adds a value, not a branch. */
export type CapabilityCarrierKind = 'composio' | 'mcp' | 'cli' | 'host';

/** What the operation does, and how much we trust that answer. */
export type CapabilityEffectClass = 'read' | 'write' | 'unknown';

/**
 * How the effect class was established. `declared` is the owning provider's
 * own annotation; `curated` is host-authored provider knowledge; `inferred` is
 * verb evidence. Provenance travels with the value so a consumer can decide
 * how much weight it deserves — an inferred read is not a proven one.
 */
export type CapabilityEffectProvenance = 'curated' | 'declared' | 'inferred' | 'none';

export interface CapabilityOperationRow {
  /** Exact callable identifier: a Composio slug, `server__tool`, or CLI command. */
  identifier: string;
  carrierKind: CapabilityCarrierKind;
  /** Toolkit slug, MCP server slug, or binary name — the thing the user connected. */
  carrier: string;
  displayName: string;
  description: string;
  effectClass: CapabilityEffectClass;
  effectProvenance: CapabilityEffectProvenance;
  /** Account/tenant this operation is bound to, when the carrier is account-scoped. */
  accountIdentity?: string;
}

export interface CapabilityOperationHit extends CapabilityOperationRow {
  /** Lexical relevance for the query that produced this hit (higher is better). */
  score: number;
}

const MAX_TEXT = 600;

let handle: Database.Database | null = null;
let handlePath = '';

function harden(dir: string, file: string): void {
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  try { if (existsSync(file)) chmodSync(file, 0o600); } catch { /* best effort */ }
}

function db(): Database.Database {
  const dir = path.join(BASE_DIR, 'memory', 'capability-index', getMachineId());
  const file = path.join(dir, 'capabilities.db');
  if (handle && handlePath === file) return handle;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  harden(dir, file);
  const database = new Database(file);
  harden(dir, file);
  database.pragma('journal_mode = WAL');
  database.pragma('secure_delete = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS capability_operations (
      identifier        TEXT NOT NULL,
      account_identity  TEXT NOT NULL DEFAULT '',
      carrier_kind      TEXT NOT NULL,
      carrier           TEXT NOT NULL,
      display_name      TEXT NOT NULL,
      description       TEXT NOT NULL,
      effect_class      TEXT NOT NULL,
      effect_provenance TEXT NOT NULL,
      first_seen_at     TEXT NOT NULL,
      last_seen_at      TEXT NOT NULL,
      active            INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (identifier, account_identity)
    );
    CREATE INDEX IF NOT EXISTS idx_capability_operations_carrier
      ON capability_operations (active, carrier_kind, carrier);
    CREATE INDEX IF NOT EXISTS idx_capability_operations_effect
      ON capability_operations (active, effect_class);
    CREATE VIRTUAL TABLE IF NOT EXISTS capability_operations_fts USING fts5(
      identifier,
      display_name,
      description,
      carrier,
      content='capability_operations',
      content_rowid='rowid',
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS capability_operations_ai
      AFTER INSERT ON capability_operations BEGIN
        INSERT INTO capability_operations_fts (rowid, identifier, display_name, description, carrier)
        VALUES (new.rowid, new.identifier, new.display_name, new.description, new.carrier);
      END;
    CREATE TRIGGER IF NOT EXISTS capability_operations_ad
      AFTER DELETE ON capability_operations BEGIN
        INSERT INTO capability_operations_fts (capability_operations_fts, rowid, identifier, display_name, description, carrier)
        VALUES ('delete', old.rowid, old.identifier, old.display_name, old.description, old.carrier);
      END;
    CREATE TRIGGER IF NOT EXISTS capability_operations_au
      AFTER UPDATE ON capability_operations BEGIN
        INSERT INTO capability_operations_fts (capability_operations_fts, rowid, identifier, display_name, description, carrier)
        VALUES ('delete', old.rowid, old.identifier, old.display_name, old.description, old.carrier);
        INSERT INTO capability_operations_fts (rowid, identifier, display_name, description, carrier)
        VALUES (new.rowid, new.identifier, new.display_name, new.description, new.carrier);
      END;
    CREATE TABLE IF NOT EXISTS capability_embeddings (
      identifier        TEXT NOT NULL,
      account_identity  TEXT NOT NULL DEFAULT '',
      model             TEXT NOT NULL,
      dim               INTEGER NOT NULL,
      vector            BLOB NOT NULL,
      content_hash      TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (identifier, account_identity)
    );
  `);
  handle = database;
  handlePath = file;
  return database;
}

function clip(value: string | undefined, max = MAX_TEXT): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The index's own database handle, for the semantic sibling that stores vectors
 * for these same rows. Deliberately narrow: the operations table has ONE writer
 * (this module) and the embeddings table has ONE writer (capability-semantic-index).
 * Sharing the file keeps a capability and its vector in the same per-machine
 * store, so deleting the index deletes both and neither can outlive the other.
 */
export function capabilityIndexDatabase(): Database.Database {
  return db();
}

/**
 * Record what a carrier exposes. Idempotent per (identifier, account): a
 * re-enumeration refreshes the descriptive columns and `last_seen_at` while
 * preserving `first_seen_at`, so "when did this install gain this capability"
 * survives every refresh.
 */
export function recordCapabilityOperations(rows: readonly CapabilityOperationRow[]): number {
  const usable = rows.filter((row) => row.identifier.trim() && row.carrier.trim());
  if (usable.length === 0) return 0;
  const now = new Date().toISOString();
  const database = db();
  const upsert = database.prepare(`
    INSERT INTO capability_operations (
      identifier, account_identity, carrier_kind, carrier, display_name, description,
      effect_class, effect_provenance, first_seen_at, last_seen_at, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (identifier, account_identity) DO UPDATE SET
      carrier_kind = excluded.carrier_kind,
      carrier = excluded.carrier,
      display_name = excluded.display_name,
      description = excluded.description,
      effect_class = excluded.effect_class,
      effect_provenance = excluded.effect_provenance,
      last_seen_at = excluded.last_seen_at,
      active = 1
  `);
  const write = database.transaction((batch: readonly CapabilityOperationRow[]) => {
    for (const row of batch) {
      upsert.run(
        row.identifier.trim(),
        clip(row.accountIdentity, 200),
        row.carrierKind,
        row.carrier.trim().toLowerCase(),
        clip(row.displayName, 200) || row.identifier.trim(),
        clip(row.description),
        row.effectClass,
        row.effectProvenance,
        now,
        now,
      );
    }
  });
  write(usable);
  return usable.length;
}

/**
 * A carrier the user disconnected, or whose operations vanished, is no longer
 * a capability. Rows are deactivated rather than deleted so `first_seen_at`
 * and any downstream references survive a reconnect.
 */
export function deactivateCapabilityCarrier(
  carrierKind: CapabilityCarrierKind,
  carrier: string,
): number {
  const slug = carrier.trim().toLowerCase();
  if (!slug) return 0;
  const result = db().prepare(`
    UPDATE capability_operations SET active = 0
     WHERE carrier_kind = ? AND carrier = ? AND active = 1
  `).run(carrierKind, slug);
  return result.changes;
}

function rowToOperation(row: Record<string, unknown>): CapabilityOperationRow {
  const account = String(row.account_identity ?? '');
  return {
    identifier: String(row.identifier ?? ''),
    carrierKind: String(row.carrier_kind ?? 'composio') as CapabilityCarrierKind,
    carrier: String(row.carrier ?? ''),
    displayName: String(row.display_name ?? ''),
    description: String(row.description ?? ''),
    effectClass: String(row.effect_class ?? 'unknown') as CapabilityEffectClass,
    effectProvenance: String(row.effect_provenance ?? 'none') as CapabilityEffectProvenance,
    ...(account ? { accountIdentity: account } : {}),
  };
}

/** FTS5 MATCH is a query language; user text must be quoted, never injected. */
function ftsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 12);
  if (terms.length === 0) return '';
  return terms.map((term) => `"${term}"*`).join(' OR ');
}

export interface CapabilitySearchOptions {
  limit?: number;
  carrierKind?: CapabilityCarrierKind;
  /** Restrict to one effect class — e.g. a read role never wants writes. */
  effectClass?: CapabilityEffectClass;
}

/**
 * Local lexical retrieval over everything this install can reach. Returns []
 * when the index is cold, so callers fall back to live provider discovery
 * rather than mistaking an unbuilt index for an empty world.
 */
export function searchCapabilityOperations(
  query: string,
  options: CapabilitySearchOptions = {},
): CapabilityOperationHit[] {
  const match = ftsQuery(query);
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  if (!match) return [];
  try {
    const filters: string[] = ['ops.active = 1'];
    const params: unknown[] = [match];
    if (options.carrierKind) filters.push('ops.carrier_kind = ?');
    if (options.effectClass) filters.push('ops.effect_class = ?');
    if (options.carrierKind) params.push(options.carrierKind);
    if (options.effectClass) params.push(options.effectClass);
    params.push(limit);
    const rows = db().prepare(`
      SELECT ops.*, bm25(capability_operations_fts) AS rank
        FROM capability_operations_fts
        JOIN capability_operations AS ops ON ops.rowid = capability_operations_fts.rowid
       WHERE capability_operations_fts MATCH ?
         AND ${filters.join(' AND ')}
       ORDER BY rank
       LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row, index) => ({
      ...rowToOperation(row),
      // bm25 returns lower-is-better; expose a bounded higher-is-better score.
      score: Math.max(0, 1 - index / Math.max(1, rows.length)),
    }));
  } catch {
    // A cold or damaged index must degrade to live discovery, never throw
    // into a turn.
    return [];
  }
}

/** Everything one carrier exposes — the "what can I do with X" answer. */
export function listCapabilityOperationsForCarrier(
  carrierKind: CapabilityCarrierKind,
  carrier: string,
  limit = 200,
): CapabilityOperationRow[] {
  try {
    const rows = db().prepare(`
      SELECT * FROM capability_operations
       WHERE active = 1 AND carrier_kind = ? AND carrier = ?
       ORDER BY identifier
       LIMIT ?
    `).all(carrierKind, carrier.trim().toLowerCase(), Math.max(1, limit)) as Array<Record<string, unknown>>;
    return rows.map(rowToOperation);
  } catch {
    return [];
  }
}

export interface CapabilityIndexStats {
  operations: number;
  carriers: number;
  byCarrierKind: Record<string, number>;
}

/** Coverage, for the boot reconcile and for telling a user what is indexed. */
export function capabilityIndexStats(): CapabilityIndexStats {
  try {
    const database = db();
    const total = database.prepare(
      'SELECT COUNT(*) AS n FROM capability_operations WHERE active = 1',
    ).get() as { n: number };
    const carriers = database.prepare(
      'SELECT COUNT(DISTINCT carrier_kind || \':\' || carrier) AS n FROM capability_operations WHERE active = 1',
    ).get() as { n: number };
    const kinds = database.prepare(
      'SELECT carrier_kind, COUNT(*) AS n FROM capability_operations WHERE active = 1 GROUP BY carrier_kind',
    ).all() as Array<{ carrier_kind: string; n: number }>;
    return {
      operations: total.n,
      carriers: carriers.n,
      byCarrierKind: Object.fromEntries(kinds.map((row) => [row.carrier_kind, row.n])),
    };
  } catch {
    return { operations: 0, carriers: 0, byCarrierKind: {} };
  }
}

export interface CapabilityCarrierSummary {
  carrierKind: CapabilityCarrierKind;
  carrier: string;
  operations: number;
}

/**
 * Carriers with their operation counts, ordered deterministically (kind, then
 * size, then name). Deterministic order matters: this feeds the model's stable
 * system prompt, and unstable bytes there cost a prompt-cache hit every turn.
 */
export function listCapabilityCarrierSummaries(limitPerKind = 50): CapabilityCarrierSummary[] {
  try {
    const rows = db().prepare(`
      SELECT carrier_kind, carrier, COUNT(*) AS operations
        FROM capability_operations
       WHERE active = 1
       GROUP BY carrier_kind, carrier
       ORDER BY carrier_kind ASC, operations DESC, carrier ASC
    `).all() as Array<{ carrier_kind: string; carrier: string; operations: number }>;
    const perKind = new Map<string, number>();
    const summaries: CapabilityCarrierSummary[] = [];
    for (const row of rows) {
      const used = perKind.get(row.carrier_kind) ?? 0;
      if (used >= limitPerKind) continue;
      perKind.set(row.carrier_kind, used + 1);
      summaries.push({
        carrierKind: row.carrier_kind as CapabilityCarrierKind,
        carrier: row.carrier,
        operations: row.operations,
      });
    }
    return summaries;
  } catch {
    return [];
  }
}

/** Which carriers this install has already indexed (for connect-time diffing). */
export function indexedCapabilityCarriers(carrierKind: CapabilityCarrierKind): string[] {
  try {
    const rows = db().prepare(`
      SELECT DISTINCT carrier FROM capability_operations
       WHERE active = 1 AND carrier_kind = ?
    `).all(carrierKind) as Array<{ carrier: string }>;
    return rows.map((row) => row.carrier);
  } catch {
    return [];
  }
}

/** Test seam: drop the cached handle so a fresh home opens a fresh database. */
export function _resetCapabilityIndexForTest(): void {
  try { handle?.close(); } catch { /* best effort */ }
  handle = null;
  handlePath = '';
}
