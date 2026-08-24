/** Run: node scripts/run-tests-isolated.mjs src/memory/capability-index-shape.test.ts
 *
 * THE SILENT-NO-OP HAZARD.
 *
 * This store's schema is `CREATE TABLE IF NOT EXISTS`, which does nothing at
 * all against a table that already exists. So a column added to the DDL is
 * present on a fresh install and ABSENT on every install that already had the
 * file — and because SQLite returns `undefined` for a column that isn't there,
 * nothing raises. The capability simply never binds, on exactly the machines
 * that have been running longest.
 *
 * These pins build a database in the PREVIOUS shape by hand, then open it
 * through the module, and require both halves of the contract:
 *   1. the new columns exist afterwards, and
 *   2. the rows that were already there are still there.
 *
 * (2) is why this is an ALTER and not a rebuild. A rebuild looks safe — the
 * store is per-machine, authority-free and provisioning-derived — but it is
 * not uniformly reconstructible: connected apps re-enumerate on the next
 * connection publication and CLIs on the next scan, while MCP servers
 * re-enumerate ONLY when their config is written. Dropping the table would
 * strand every MCP row until a user happened to edit their config.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cap-shape-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
const MACHINE = 'machine-cap-shape';
writeFileSync(path.join(HOME, 'state', 'machine-id'), `${MACHINE}\n`, 'utf8');

/** The exact v1 shape, before second-level addressing existed. */
const V1_DDL = `
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
`;

const indexDir = path.join(HOME, 'memory', 'capability-index', MACHINE);
mkdirSync(indexDir, { recursive: true });
const indexFile = path.join(indexDir, 'capabilities.db');

// Build the OLD database before the module ever opens it, and seed a row that
// stands in for a carrier nothing will re-enumerate on its own.
{
  const legacy = new Database(indexFile);
  legacy.pragma('journal_mode = WAL');
  legacy.exec(V1_DDL);
  legacy.prepare(`
    INSERT INTO capability_operations
      (identifier, account_identity, carrier_kind, carrier, display_name,
       description, effect_class, effect_provenance, first_seen_at, last_seen_at, active)
    VALUES (?, '', 'mcp', 'a-server', 'Existing tool', 'Indexed before the shape changed.',
            'read', 'declared', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)
  `).run('a-server__existing');
  assert.equal(Number(legacy.pragma('user_version', { simple: true }) ?? 0), 0, 'v1 files carry no version');
  legacy.close();
}

const {
  capabilityIndexDatabase,
  searchCapabilityOperations,
  capabilityIndexStats,
  _resetCapabilityIndexForTest,
} = await import('./capability-index.js');

test('an existing v1 database gains the new columns on open', () => {
  const db = capabilityIndexDatabase();
  const columns = new Set(
    (db.pragma('table_info(capability_operations)') as Array<{ name: string }>).map((c) => c.name),
  );
  for (const column of ['parent_identifier', 'selector', 'inventory_state']) {
    assert.ok(columns.has(column), `v1 file must gain ${column}`);
  }
});

test('the rows that were already indexed survive the shape change', () => {
  // The whole reason this is an ALTER: nothing re-enumerates an MCP server
  // except a config write, so a dropped row is stranded indefinitely.
  assert.equal(capabilityIndexStats().operations, 1, 'the pre-existing row is still indexed');
});

test('a search index that drifted from the table is repaired on open', () => {
  // The seeded database above has no FTS content for its row — the shape this
  // simulates is any file whose triggers did not cover a write. Surviving is
  // not enough: a row that exists but cannot be FOUND is indistinguishable
  // from a capability the install never had, and that is the exact shape of a
  // confident false refusal.
  const hits = searchCapabilityOperations('existing tool', { limit: 5 });
  assert.equal(hits[0]?.identifier, 'a-server__existing', 'the row must be retrievable, not merely present');
});

test('the shape is recorded so the work happens once', () => {
  const db = capabilityIndexDatabase();
  const version = Number(db.pragma('user_version', { simple: true }) ?? 0);
  assert.ok(version >= 2, `expected the shape marker to advance, got ${version}`);
});

test('reopening a migrated database is a no-op, not a repeated ALTER', () => {
  // A second ALTER for the same column raises in SQLite, so this pins that the
  // version gate actually gates.
  _resetCapabilityIndexForTest();
  assert.doesNotThrow(() => capabilityIndexDatabase(), 'reopen must not re-apply the ALTER');
  assert.equal(capabilityIndexStats().operations, 1, 'and must not disturb the rows');
});
