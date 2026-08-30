/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/strict-tail-coverage.test.ts
 *
 * A refuse-on-existence migration and the rehearsal that replays it must agree
 * on which tables are strict. When they drift, NOTHING warns you: production is
 * fine, and the rehearsal fails on a structure its own replay created.
 *
 * That drift has happened twice. v66 added `model_request_provenance` and the
 * shed list was updated; v67 added `host_model_result_receipts` and it was not.
 * The result was 46 failing tests reporting "schema v67 refuses preexisting
 * unsanctioned table host_model_result_receipts" — a fixture gap that reads
 * exactly like a schema defect and cost hours to tell apart.
 *
 * This pin closes the loop by reading the migration source itself, so a new
 * guarded migration cannot be added without listing its table.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const { STRICT_TAIL_TABLES } = await import('./eventlog-schema.js');

const source = readFileSync(
  fileURLToPath(new URL('./eventlog-schema.ts', import.meta.url)),
  'utf8',
);

/** Every table a migration refuses when it already exists. */
function guardedTables(): string[] {
  const names = new Set<string>();
  // Literal form: throw new Error('schema vNN refuses preexisting unsanctioned table X')
  for (const m of source.matchAll(/refuses preexisting unsanctioned table ([a-z_]+)'/g)) {
    names.add(m[1]!);
  }
  // Templated form: `schema v65 refuses preexisting unsanctioned table ${table}`
  // — the names come from the array literal the loop iterates.
  if (/refuses preexisting unsanctioned table \$\{table\}/.test(source)) {
    const loop = source.match(/for \(const table of \[([^\]]+)\]/);
    if (loop) {
      for (const m of loop[1]!.matchAll(/'([a-z_]+)'/g)) names.add(m[1]!);
    }
  }
  return [...names].sort();
}

test('the fixture knows about every table a migration will refuse', () => {
  const guarded = guardedTables();
  assert.ok(guarded.length >= 5,
    `expected to find the known guards; parsed ${guarded.length} — the guard wording may have changed, `
    + 'which would make this pin silently vacuous');

  const listed = new Set(STRICT_TAIL_TABLES);
  const missing = guarded.filter((table) => !listed.has(table));
  assert.deepEqual(missing, [],
    'a migration refuses these tables but STRICT_TAIL_TABLES does not list them, so every migration '
    + 'rehearsal will fail on a structure its own replay created. Add them to STRICT_TAIL_TABLES '
    + '(src/runtime/harness/eventlog-schema.ts).');
});

test('the list contains no table that nothing actually guards', () => {
  // The NEGATIVE. A stale entry means a rehearsal drops a table no migration
  // recreates, which corrupts the replay in the opposite direction.
  const guarded = new Set(guardedTables());
  const orphans = STRICT_TAIL_TABLES.filter((table) => !guarded.has(table));
  assert.deepEqual(orphans, [],
    'STRICT_TAIL_TABLES lists tables that no migration guards; a rehearsal would drop structures '
    + 'nothing recreates');
});

test('the named strict-tail regressions through schema v70 are covered', () => {
  // Named explicitly so the exact regression that cost 46 tests is pinned by
  // name, not only by the generic rule above. Schema 69 is included because
  // projection receipts also refuse a preexisting lookalike and must be shed
  // before an intentionally rewound migration rehearsal replays that tail.
  // V70 repairs an existing sanctioned table, so it correctly adds no strict
  // table name; this title still pins that the checked tail reaches v70.
  for (const table of [
    'model_request_provenance',
    'host_model_result_receipts',
    'logical_model_result_projection_receipts',
  ]) {
    assert.ok(STRICT_TAIL_TABLES.includes(table), `${table} must be shed before a rehearsal replays it`);
  }
});
