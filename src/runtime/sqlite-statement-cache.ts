import type Database from 'better-sqlite3';

type CachedStatement = Database.Statement<unknown[], unknown>;
type PreparedStatementFor<
  BindParameters extends unknown[] | object,
  Result,
> = BindParameters extends unknown[]
  ? Database.Statement<BindParameters, Result>
  : Database.Statement<[BindParameters], Result>;

const statementsByConnection = new WeakMap<
  Database.Database,
  Map<string, CachedStatement>
>();

/**
 * Prepare one stable SQL shape once per live SQLite connection.
 *
 * The connection is part of the cache identity, so closing and reopening the
 * same database path cannot reuse a statement owned by the old handle. Callers
 * must keep cached statements unbound and must not change their row mode with
 * `pluck`, `expand`, `raw`, or `safeIntegers`.
 */
export function prepareCached<
  BindParameters extends unknown[] | object = unknown[],
  Result = unknown,
>(
  db: Database.Database,
  source: string,
): PreparedStatementFor<BindParameters, Result> {
  // Preserve better-sqlite3's native closed-handle failure at prepare time.
  // Returning an old cached Statement here would defer the same fault until
  // get/all/run and would make a dead connection look reusable.
  if (!db.open) {
    return db.prepare<BindParameters, Result>(source) as PreparedStatementFor<
      BindParameters,
      Result
    >;
  }

  let statements = statementsByConnection.get(db);
  if (!statements) {
    statements = new Map<string, CachedStatement>();
    statementsByConnection.set(db, statements);
  }
  const existing = statements.get(source);
  if (existing) {
    return existing as unknown as PreparedStatementFor<BindParameters, Result>;
  }
  const prepared = db.prepare<BindParameters, Result>(source) as PreparedStatementFor<
    BindParameters,
    Result
  >;
  statements.set(source, prepared as unknown as CachedStatement);
  return prepared;
}
