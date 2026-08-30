/**
 * Test support for migration rehearsals that rewind the schema_version ledger.
 *
 * A rehearsal starts from TODAY's schema and deletes version rows to replay an
 * older migration boundary. The runner resumes from MAX(version), so deleting
 * one marker replays every later migration too — each of them against a store
 * that already carries its own artifacts. A replayed migration must therefore
 * see an honest pre-state, or it fails on structures its own earlier run made.
 *
 * Additive parent columns are restart-safe and may legitimately remain; the
 * structures below are not, so a fixture sheds them before reopening.
 */
import type Database from 'better-sqlite3';
import { STRICT_TAIL_TABLES } from './eventlog-schema.js';

/**
 * v65 and v66 deliberately REFUSE their authority table names when their
 * version rows are absent: they had no sanctioned predecessor, so a
 * preexisting lookalike must never be blessed as durable authority. The helper
 * retains its original name because every caller rewinds to before v65; it now
 * sheds the complete strict tail that those rehearsals must replay.
 */
export function removeV65StructuresFromHistoricalMigrationFixture(db: Database.Database): void {
  // Derived from STRICT_TAIL_TABLES rather than restated here. The previous
  // hand-maintained copy rotted: v66's table was added to it, v67's was not,
  // and every rehearsal then failed on a structure its own replay had created.
  // Dropping a table drops its indexes and triggers with it.
  db.exec('DROP INDEX IF EXISTS idx_tool_outputs_session_created_call;');
  for (const table of STRICT_TAIL_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table};`);
  }
}

/**
 * SQLite refuses to drop a column any trigger still reads. A rehearsal that
 * sheds a column to reach an older shape must therefore shed those triggers
 * first — the replayed migrations recreate them. Discovered from sqlite_master
 * rather than named, so a later migration that adds another reader of the same
 * column does not silently strand the rehearsal.
 */
export function dropTriggersReadingColumnForHistoricalMigrationFixture(
  db: Database.Database,
  column: string,
): void {
  const triggers = db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND sql LIKE '%' || ? || '%'`,
  ).all(column) as Array<{ name: string }>;
  for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
}
