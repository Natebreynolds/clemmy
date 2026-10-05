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
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applyHarnessMigrationsThroughVersionForTests, STRICT_TAIL_TABLES } from './eventlog-schema.js';

let historicalReceiptSql: string | undefined;
const receiptTable = 'durable_memory_intake_receipts';
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const normalizedTableSql = (sql: string): string => sql
  .replace(/^CREATE TABLE(?: IF NOT EXISTS)?\s+"?durable_memory_intake_receipts"?/i, 'CREATE TABLE durable_memory_intake_receipts')
  .replace(/\s+/g, ' ').trim();

/** Restore only an EMPTY synthetic receipt table to its real historical V1
 * shape before a version-ledger rewind. This is not a database downgrade: a
 * populated receipt or bound host authority is deliberately refused. */
export function restoreEmptyV1MemoryReceiptForHistoricalMigrationFixture(db: Database.Database): void {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') {
    throw new Error('historical receipt fixture requires the isolated test contract');
  }
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(receiptTable) as { sql: string } | undefined;
  if (!current) return;
  if ((db.prepare(`SELECT COUNT(*) n FROM ${receiptTable}`).get() as { n: number }).n !== 0) {
    throw new Error('historical receipt fixture refuses populated receipt authority');
  }
  const authorityColumns = new Set((db.prepare('PRAGMA table_info(accepted_task_authority)').all() as Array<{ name: string }>)
    .map(column => column.name));
  const bindingColumns = ['host_completion_receipt_id', 'host_completion_event_id']
    .filter(column => authorityColumns.has(column));
  if (bindingColumns.length && db.prepare(`SELECT 1 FROM accepted_task_authority
    WHERE ${bindingColumns.map(column => `${quote(column)} IS NOT NULL`).join(' OR ')} LIMIT 1`).get()) {
    throw new Error('historical receipt fixture refuses bound host completion authority');
  }
  if (!historicalReceiptSql) {
    const historical = new Database(':memory:');
    try {
      applyHarnessMigrationsThroughVersionForTests(historical, 92);
      historicalReceiptSql = (historical.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(receiptTable) as { sql: string }).sql;
    } finally { historical.close(); }
  }
  const v1 = historicalReceiptSql;
  if (normalizedTableSql(current.sql) === normalizedTableSql(v1)) return;
  const v2 = v1
    .replace("CHECK (length(receipt_id) = 81 AND receipt_id LIKE 'memory-intake:v1:%')",
      "CHECK (length(receipt_id) = 81 AND ( (protocol_version = 1 AND receipt_id LIKE 'memory-intake:v1:%') OR (protocol_version = 2 AND receipt_id LIKE 'memory-intake:v2:%')))")
    .replace('CHECK (protocol_version = 1)', 'CHECK (protocol_version IN (1, 2))');
  if (normalizedTableSql(current.sql) !== normalizedTableSql(v2)) {
    throw new Error('historical receipt fixture refuses an unknown receipt schema');
  }
  const objects = (): Array<{ type: string; name: string; sql: string }> => db.prepare(`
    SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND
      ((type='index' AND tbl_name=?) OR
       (type='trigger' AND (tbl_name=? OR sql LIKE '%durable_memory_intake_receipts%')))
    ORDER BY type,name`).all(receiptTable, receiptTable) as Array<{ type: string; name: string; sql: string }>;
  const retained = objects();
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  const violations = db.pragma('foreign_key_check');
  db.transaction(() => {
    for (const object of retained) if (object.type === 'trigger') db.exec(`DROP TRIGGER ${quote(object.name)}`);
    db.exec(`DROP TABLE ${receiptTable}`);
    db.exec(v1);
    for (const object of retained) db.exec(object.sql);
    assert.deepEqual(objects(), retained, 'receipt fixture preserves exact dependent trigger and index SQL');
    assert.deepEqual(db.pragma('foreign_key_check'), violations, 'receipt fixture preserves existing FK validity');
    assert.equal(db.pragma('foreign_keys', { simple: true }), foreignKeys);
  }).immediate();
}

/**
 * v65 and v66 deliberately REFUSE their authority table names when their
 * version rows are absent: they had no sanctioned predecessor, so a
 * preexisting lookalike must never be blessed as durable authority. The helper
 * retains its original name because every caller rewinds to before v65; it now
 * sheds the complete strict tail that those rehearsals must replay.
 */
export function removeV65StructuresFromHistoricalMigrationFixture(db: Database.Database): void {
  // These callers also replay v93. Its real predecessor has V1 checks, not
  // today's V2 checks with only its version marker removed.
  restoreEmptyV1MemoryReceiptForHistoricalMigrationFixture(db);
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
