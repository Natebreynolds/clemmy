/**
 * Scope: who a piece of memory is for.
 *
 * Memory is one store. What differs is who it is for:
 *  - everywhere: no scope. Everything that existed before scopes did, facts
 *    about the owner, and standing rules.
 *  - a project: what is true of one body of work.
 *  - an agent: what one specialist knows wherever it works.
 *  - an agent in a project: what it learned or was corrected on there.
 *
 * A scope is two optional ids kept beside the record in a table of its own.
 * A record with no row is for everywhere, so nothing that already exists is
 * rewritten, and a build that does not know about scopes reads the store as
 * it always did.
 *
 * Reading: a turn sees what is for everywhere, plus what is for its own
 * project and its own agent. It never sees what is for another project or
 * another agent. Clem, answering without an agent inside a project, also
 * sees what that project's agents learned in it. Work with no turn behind it
 * (maintenance, the owner's own Memory screen) sees everything.
 *
 * The table is created where it is first used and is not part of the
 * numbered schema chain: several agents ship builds to the same installed
 * app, and a rolled-back build must still open this database.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { openMemoryDb } from './db.js';

export interface MemoryScope {
  projectId: string | null;
  /** The agent's scope key: its id and when it was created, so a different
   * agent saved later under the same name does not inherit this. */
  agentKey: string | null;
}

/**
 * What a read may see. `unrestricted` is work with no turn behind it.
 * `exact` narrows a read to what is kept for precisely this scope and
 * nothing wider: settling a new memory against the ones it might replace
 * must never reach a memory kept for anyone else, everywhere included.
 */
export type MemoryReadScope = (MemoryScope & { exact?: true }) | 'unrestricted';

export type ScopedKind = 'fact' | 'episode';

export const EVERYWHERE: MemoryScope = Object.freeze({ projectId: null, agentKey: null });

export function agentScopeKey(agent: { id: string; createdAt?: string | null }): string {
  return agent.createdAt ? `${agent.id}@${agent.createdAt}` : agent.id;
}

export function agentIdOfScopeKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const at = key.indexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

export function isEverywhere(scope: MemoryScope | null | undefined): boolean {
  return !scope || (!scope.projectId && !scope.agentKey);
}

export function sameScope(a: MemoryScope | null | undefined, b: MemoryScope | null | undefined): boolean {
  return (a?.projectId ?? null) === (b?.projectId ?? null) && (a?.agentKey ?? null) === (b?.agentKey ?? null);
}

/** Whether a record kept for `recordScope` may be seen by a read in `readScope`. */
export function scopeVisible(recordScope: MemoryScope | null | undefined, readScope: MemoryReadScope): boolean {
  if (readScope === 'unrestricted') return true;
  if (readScope.exact) return sameScope(recordScope, readScope);
  if (isEverywhere(recordScope)) return true;
  const record = recordScope!;
  if (record.projectId && record.projectId !== readScope.projectId) return false;
  if (record.agentKey) {
    // An agent sees what is kept for itself. Clem, who coordinates the
    // agents of a project, sees what they learned in the project she is in,
    // and nothing an agent keeps for its work elsewhere.
    if (readScope.agentKey) return record.agentKey === readScope.agentKey;
    return Boolean(record.projectId);
  }
  return true;
}

/** Part of a record's content address, so the same sentence learned in two
 * scopes is two records. Empty for everywhere: those hash as they always did. */
export function scopeHashSuffix(scope: MemoryScope | null | undefined): string {
  return isEverywhere(scope) ? '' : `::scope:${scope!.projectId ?? ''}|${scope!.agentKey ?? ''}`;
}

// ── Who is reading ────────────────────────────────────────────────────────

const readOverride = new AsyncLocalStorage<MemoryReadScope>();

export interface MemoryScopeBinding {
  /** The session behind the work that is running now, if any. */
  ambientSessionId(): string | null;
  /** The scope a session works in. Null when the session is unknown. */
  scopeOfSession(sessionId: string): MemoryScope | null;
}

let binding: MemoryScopeBinding | null = null;

/** Installed once by the runtime. Without it every read is unrestricted and
 * every write is for everywhere, which is how memory behaved before scopes. */
export function installMemoryScopeBinding(next: MemoryScopeBinding | null): void {
  binding = next;
}

/** Run with an explicit reading scope, whatever the ambient turn is. */
export function withMemoryReadScope<T>(scope: MemoryReadScope, run: () => T): T {
  return readOverride.run(scope, run);
}

const writeOverride = new AsyncLocalStorage<MemoryScope>();

/**
 * Settle one memory for one scope: everything written inside is kept for
 * that scope, and everything read is what is kept for exactly that scope.
 */
export function withMemorySettledFor<T>(scope: MemoryScope, run: () => T): T {
  const exact: MemoryReadScope = { projectId: scope.projectId ?? null, agentKey: scope.agentKey ?? null, exact: true };
  return writeOverride.run({ projectId: exact.projectId, agentKey: exact.agentKey }, () => readOverride.run(exact, run));
}

/** The scope a write is being settled for, when one is. */
export function currentMemoryWriteScope(): MemoryScope | undefined {
  return writeOverride.getStore();
}

/**
 * Run as the turn of one session: everything read inside sees what that
 * session may see. Without a session, or before the runtime is bound, the
 * work runs as it would have.
 */
export function withSessionMemoryScope<T>(sessionId: string | null | undefined, run: () => T): T {
  if (!binding || !sessionId || readOverride.getStore() !== undefined) return run();
  return readOverride.run(scopeOfSession(sessionId) ?? EVERYWHERE, run);
}

export function scopeOfSession(sessionId: string | null | undefined): MemoryScope | null {
  if (!sessionId || !binding) return null;
  try {
    return binding.scopeOfSession(sessionId);
  } catch {
    return null;
  }
}

export function currentMemoryReadScope(): MemoryReadScope {
  const explicit = readOverride.getStore();
  if (explicit !== undefined) return explicit;
  if (!binding) return 'unrestricted';
  let sessionId: string | null = null;
  try { sessionId = binding.ambientSessionId(); } catch { sessionId = null; }
  if (!sessionId) return 'unrestricted';
  // A turn whose session cannot be read sees only what is for everywhere:
  // failing open here would show it another project's memory.
  return scopeOfSession(sessionId) ?? EVERYWHERE;
}

// ── The table ─────────────────────────────────────────────────────────────

const prepared = new WeakSet<Database.Database>();

function tableExists(conn: Database.Database): boolean {
  return Boolean(conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_scopes'").get());
}

function db(): Database.Database {
  const conn = openMemoryDb();
  if (!prepared.has(conn)) {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS memory_scopes (
        target_kind       TEXT NOT NULL CHECK (target_kind IN ('fact','episode')),
        target_id         TEXT NOT NULL,
        scope_project_id  TEXT,
        scope_agent_key   TEXT,
        source_session_id TEXT,
        stamped_by        TEXT NOT NULL DEFAULT 'learned',
        stamped_at        TEXT NOT NULL,
        PRIMARY KEY (target_kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scopes_project ON memory_scopes (scope_project_id, target_kind);
      CREATE INDEX IF NOT EXISTS idx_memory_scopes_agent ON memory_scopes (scope_agent_key, target_kind);
    `);
    prepared.add(conn);
  }
  return conn;
}

interface ScopeRow { target_id: string; scope_project_id: string | null; scope_agent_key: string | null }

function toScope(row: ScopeRow): MemoryScope {
  return { projectId: row.scope_project_id, agentKey: row.scope_agent_key };
}

/**
 * Keep a record for a scope, or for everywhere. `stampedBy` says whether it
 * was learned there or the owner moved it.
 */
export function stampMemoryScope(
  kind: ScopedKind,
  id: string | number,
  scope: MemoryScope | null | undefined,
  provenance: { sessionId?: string | null; stampedBy?: 'learned' | 'owner' } = {},
): void {
  const conn = db();
  if (isEverywhere(scope)) {
    localWrites += 1;
    conn.prepare('DELETE FROM memory_scopes WHERE target_kind = ? AND target_id = ?').run(kind, String(id));
    return;
  }
  localWrites += 1;
  conn.prepare(`
    INSERT INTO memory_scopes (target_kind, target_id, scope_project_id, scope_agent_key, source_session_id, stamped_by, stamped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_kind, target_id) DO UPDATE SET
      scope_project_id = excluded.scope_project_id,
      scope_agent_key = excluded.scope_agent_key,
      source_session_id = COALESCE(excluded.source_session_id, memory_scopes.source_session_id),
      stamped_by = excluded.stamped_by,
      stamped_at = excluded.stamped_at
  `).run(kind, String(id), scope!.projectId ?? null, scope!.agentKey ?? null,
    provenance.sessionId ?? null, provenance.stampedBy ?? 'learned', new Date().toISOString());
}

export function memoryScopeOf(kind: ScopedKind, id: string | number): MemoryScope | null {
  return scopedRecords(kind).get(String(id)) ?? null;
}

/** Writes this process made through its own connection. */
let localWrites = 0;

interface ScopeSnapshot { dataVersion: unknown; localWrites: number; byKind: Map<ScopedKind, Map<string, MemoryScope>> }
const snapshots = new WeakMap<Database.Database, ScopeSnapshot>();

/**
 * Every record of one kind that is kept for a scope. The table holds only
 * those, so it stays small however large memory grows. Read once and kept
 * until the table changes: a turn asks this many times, and the answer
 * changes only when something is learned or moved. The database's own
 * change counter covers writes by another process; this process counts its
 * own.
 */
export function scopedRecords(kind: ScopedKind): ReadonlyMap<string, MemoryScope> {
  let conn: Database.Database;
  try {
    conn = db();
  } catch (error) {
    // The table could not be created (a database opened for reading). If it
    // is not there, nothing was ever kept for a scope.
    if (!tableExists(openMemoryDb())) return new Map();
    throw error;
  }
  const dataVersion = conn.pragma('data_version', { simple: true });
  let snapshot = snapshots.get(conn);
  if (!snapshot || snapshot.dataVersion !== dataVersion || snapshot.localWrites !== localWrites) {
    snapshot = { dataVersion, localWrites, byKind: new Map() };
    snapshots.set(conn, snapshot);
  }
  let records = snapshot.byKind.get(kind);
  if (!records) {
    const rows = conn.prepare(
      'SELECT target_id, scope_project_id, scope_agent_key FROM memory_scopes WHERE target_kind = ?',
    ).all(kind) as ScopeRow[];
    records = new Map(rows.map((row) => [row.target_id, toScope(row)]));
    snapshot.byKind.set(kind, records);
  }
  return records;
}

/**
 * How many more rows a reader must ask the store for so that, once what it
 * may not see is taken out, it still has as many as it wanted. The store
 * cuts a list before this module sees it; without the allowance, records
 * kept for another project could push out every record the reader may see.
 */
export function hiddenFromScope(kind: ScopedKind, readScope: MemoryReadScope = currentMemoryReadScope()): number {
  if (readScope === 'unrestricted') return 0;
  try {
    let hidden = 0;
    for (const scope of scopedRecords(kind).values()) if (!scopeVisible(scope, readScope)) hidden += 1;
    return hidden;
  } catch {
    return 0;
  }
}

/** The ids kept for exactly this scope. */
export function recordsInScope(kind: ScopedKind, scope: MemoryScope): string[] {
  const rows = db().prepare(`
    SELECT target_id FROM memory_scopes
     WHERE target_kind = ? AND scope_project_id IS ? AND scope_agent_key IS ?
  `).all(kind, scope.projectId ?? null, scope.agentKey ?? null) as Array<{ target_id: string }>;
  return rows.map((row) => row.target_id);
}

/**
 * What a read may see out of a list. Unrestricted reads and lists that hold
 * nothing scoped come back as they were, in the same order.
 */
export function visibleInScope<T>(
  kind: ScopedKind,
  rows: readonly T[],
  idOf: (row: T) => string | number,
  readScope: MemoryReadScope = currentMemoryReadScope(),
  /** What to return when scopes cannot be read. Knowledge fails to nothing:
   * a turn is shown only what it can be proved to be allowed to see. Rules
   * that restrain a turn fail to all of them: one rule too many is safe,
   * one too few is not. */
  onUnreadable: 'nothing' | 'everything' = 'nothing',
): T[] {
  if (readScope === 'unrestricted' || rows.length === 0) return [...rows];
  let scoped: ReadonlyMap<string, MemoryScope>;
  try {
    scoped = scopedRecords(kind);
  } catch {
    return onUnreadable === 'everything' ? [...rows] : [];
  }
  if (scoped.size === 0 && !readScope.exact) return [...rows];
  return rows.filter((row) => scopeVisible(scoped.get(String(idOf(row))), readScope));
}

export function recordVisible(
  kind: ScopedKind,
  id: string | number,
  readScope: MemoryReadScope = currentMemoryReadScope(),
  onUnreadable: 'nothing' | 'everything' = 'nothing',
): boolean {
  if (readScope === 'unrestricted') return true;
  try {
    return scopeVisible(memoryScopeOf(kind, id), readScope);
  } catch {
    return onUnreadable === 'everything';
  }
}
