/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-backup.test.ts
 *
 * The memory backup off the main thread. Every pin is structural: macrotask
 * turns counted while the backup is awaited, the statements the main
 * connection received, files on disk, restart counts. No wall-clock bounds.
 */
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-backup-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_MEMORY_SELF_HEAL_JUDGE = 'off';
delete process.env.CLEMMY_MEMORY_SELF_HEAL;
delete process.env.CLEMMY_MEMORY_SELF_HEAL_REAL;
delete process.env.CLEMMY_MEMORY_SELF_HEAL_MAX;

// eslint-disable-next-line import/first
const {
  resetMemoryDb,
  openMemoryDb,
  backupMemoryDb,
  MEMORY_BACKUP_DIR,
  MEMORY_DB_PATH,
  MEMORY_SCHEMA_VERSION,
} = await import('./db.js');
// eslint-disable-next-line import/first
const {
  backupMemoryDbAsync,
  memoryBackupInFlight,
  _setMemoryBackupWorkerEntryForTest,
  _pagedBackupStatsForTest,
  _expireMemoryBackupWorkerForTest,
} = await import('./memory-backup.js');

before(() => {
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  rmSync(MEMORY_BACKUP_DIR, { recursive: true, force: true });
  seedFacts(600);
});

afterEach(() => {
  _setMemoryBackupWorkerEntryForTest(null);
});

/** Enough rows that a copy takes many 16-page steps. */
function seedFacts(count: number, tag = 'seed'): void {
  const db = openMemoryDb();
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at,
       derivation_depth, pinned, access_count, impression_count, utility_count)
    VALUES ('project', ?, ?, 1, 1, datetime('now'), datetime('now'), 0, 0, 0, 0, 0)
  `);
  const filler = 'x'.repeat(1_500);
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) insert.run(`${tag} fact ${i} ${filler}`, `${tag}-${i}-${Math.random()}`);
  })();
}

function factCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM consolidated_facts').get() as { c: number }).c;
}

/** Bytes 18-19 of a SQLite header: 1,1 = rollback journal, 2,2 = WAL. */
function headerVersions(file: string): [number, number] {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(2);
    readSync(fd, buf, 0, 2, 18);
    return [buf[0]!, buf[1]!];
  } finally {
    closeSync(fd);
  }
}

function snapshots(): string[] {
  return existsSync(MEMORY_BACKUP_DIR)
    ? readdirSync(MEMORY_BACKUP_DIR).filter((name) => name.startsWith('memory-') && name.endsWith('.db')).sort()
    : [];
}

function partials(): string[] {
  return existsSync(MEMORY_BACKUP_DIR)
    ? readdirSync(MEMORY_BACKUP_DIR).filter((name) => name.includes('.partial-'))
    : [];
}

/** A setImmediate turn counter: counts macrotask turns while it is on. */
function turnCounter(): { stop: () => number } {
  let turns = 0;
  let on = true;
  (function turn() { turns += 1; if (on) setImmediate(turn); })();
  return { stop: () => { on = false; return turns; } };
}

/** Record every statement the cached main connection is asked to run. */
function recordMainConnection(): { statements: string[]; restore: () => void } {
  const db = openMemoryDb();
  const statements: string[] = [];
  const exec = db.exec.bind(db);
  const pragma = db.pragma.bind(db);
  db.exec = ((sql: string) => { statements.push(sql); return exec(sql); }) as typeof db.exec;
  db.pragma = ((source: string, options?: Database.PragmaOptions) => {
    statements.push(`PRAGMA ${source}`);
    return pragma(source, options);
  }) as typeof db.pragma;
  return {
    statements,
    restore: () => { db.exec = exec as typeof db.exec; db.pragma = pragma as typeof db.pragma; },
  };
}

function assertParity(file: string, expectedFacts: number): void {
  assert.deepEqual(headerVersions(file), [1, 1], 'a rollback-journal header, like a VACUUM INTO copy');
  const snap = new Database(file, { readonly: true });
  try {
    assert.deepEqual(snap.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    assert.equal(
      (snap.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v,
      MEMORY_SCHEMA_VERSION,
    );
    assert.equal(factCount(snap), expectedFacts);
  } finally {
    snap.close();
  }
  assert.equal(existsSync(`${file}-wal`), false, 'a read-only open leaves no WAL sidecar');
  assert.equal(existsSync(`${file}-shm`), false, 'a read-only open leaves no shared-memory sidecar');
}

// ── C1: the backup yields ────────────────────────────────────────────────────

test('C1: the loop keeps turning while the backup is written, and the main connection never runs the VACUUM', async () => {
  const main = recordMainConnection();
  try {
    const counter = turnCounter();
    const runsBefore = _pagedBackupStatsForTest().runs;
    const result = await backupMemoryDbAsync({ retain: 7, localDayKey: '2026-09-27' });
    const turns = counter.stop();
    assert.ok(result, 'the worker published a snapshot');
    assert.equal(_pagedBackupStatsForTest().runs, runsBefore, 'the worker ran; no fallback');
    assert.equal(result!.reused, false);
    assert.ok(turns > 0, `the main loop must get turns while the copy is written (saw ${turns})`);
    assert.deepEqual(
      main.statements.filter((sql) => /VACUUM|wal_checkpoint/i.test(sql)),
      [],
      'the copy and its checkpoint run on the worker connection, never the main one',
    );
  } finally {
    main.restore();
  }
});

// ── C2: output parity ────────────────────────────────────────────────────────

test('C2: the worker copy is the same kind of file as the main-thread copy', async () => {
  const expected = factCount(openMemoryDb());
  const viaWorker = await backupMemoryDbAsync({ retain: 7 });
  const onThread = backupMemoryDb({ retain: 7 });
  assert.ok(viaWorker && onThread);
  assertParity(viaWorker!.backupPath, expected);
  assertParity(onThread!.backupPath, expected);
  assert.deepEqual(partials(), []);
});

// ── C3: single flight ────────────────────────────────────────────────────────

test('C3: one publication per nightly day in flight; a synchronous backup meanwhile withholds instead of waiting', async () => {
  const first = backupMemoryDbAsync({ retain: 7, localDayKey: '2026-09-26' });
  const second = backupMemoryDbAsync({ retain: 7, localDayKey: '2026-09-26' });
  assert.equal(second, first, 'callers asking for the same day share one publication');
  assert.equal(memoryBackupInFlight(), true);

  // The async backup holds (or is about to hold) the cross-process lease.
  // Without the in-flight check this call would sleep in SQLite's busy handler
  // on this thread until the worker finished, and then succeed.
  const main = recordMainConnection();
  let during: ReturnType<typeof backupMemoryDb> | undefined;
  try {
    during = backupMemoryDb({ retain: 14 });
  } finally {
    main.restore();
  }
  assert.equal(during, null, 'a synchronous backup withholds while an async one is in flight');
  assert.deepEqual(main.statements, [], 'and never touched the main connection');

  // A different request waits for the one in flight, then runs.
  const repair = backupMemoryDbAsync({ retain: 14 });
  const [a, b, c] = await Promise.all([first, second, repair]);
  assert.ok(a && b && c);
  assert.equal(a, b);
  assert.equal(a!.reused, false);
  assert.notEqual(c!.backupPath, a!.backupPath);
  assert.equal(snapshots().filter((name) => name.endsWith('-nightly.db')).length, 1, 'one nightly file');
  assert.equal(memoryBackupInFlight(), false);
  assert.ok(backupMemoryDb({ retain: 14 }), 'once settled, the synchronous path works again');

  // The same day again: the keyed snapshot is re-adopted, not copied twice.
  const again = await backupMemoryDbAsync({ retain: 7, localDayKey: '2026-09-26' });
  assert.equal(again?.reused, true);
  assert.equal(again?.backupPath, a!.backupPath);
});

test('an invalid day key is a null, never a throw', async () => {
  assert.equal(await backupMemoryDbAsync({ localDayKey: '2026-02-30' }), null);
  assert.equal(memoryBackupInFlight(), false);
});

test('a refused free-space check is a null from the worker too', async () => {
  const result = await backupMemoryDbAsync({ retain: 7, _availableBytesForTest: 1 });
  assert.equal(result, null);
  assert.deepEqual(snapshots(), []);
  assert.deepEqual(partials(), []);
});

// ── C4: retention by class ───────────────────────────────────────────────────

test('C4: repair snapshots never push the week of nightly copies out, and a nightly never prunes a repair', async () => {
  const { writeFileSync } = await import('node:fs');
  mkdirSync(MEMORY_BACKUP_DIR, { recursive: true });
  const nightlies = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']
    .map((day) => `memory-${day}-nightly.db`);
  // Repair snapshots from the night before, which sort AFTER every older nightly.
  const repairs = Array.from({ length: 8 }, (_, i) => `memory-2026-09-25T04-35-0${i}-000Z-0000000${i}.db`);
  for (const name of [...nightlies, ...repairs]) writeFileSync(path.join(MEMORY_BACKUP_DIR, name), 'seeded');

  const nightly = await backupMemoryDbAsync({ retain: 7, localDayKey: '2026-09-26' });
  assert.ok(nightly);
  const afterNightly = snapshots();
  assert.deepEqual(
    afterNightly.filter((name) => name.endsWith('-nightly.db')),
    [...nightlies.slice(1), 'memory-2026-09-26-nightly.db'],
    'the newest seven nightlies remain: the week is intact',
  );
  assert.deepEqual(afterNightly.filter((name) => !name.endsWith('-nightly.db')), repairs, 'a nightly prunes nightlies only');

  // A repair snapshot prunes repairs only, however small its bound.
  const repair = await backupMemoryDbAsync({ retain: 2 });
  assert.ok(repair);
  const afterRepair = snapshots();
  assert.deepEqual(afterRepair.filter((name) => name.endsWith('-nightly.db')).length, 7, 'every nightly survives a repair burst');
  const repairsLeft = afterRepair.filter((name) => !name.endsWith('-nightly.db'));
  assert.equal(repairsLeft.length, 2);
  assert.ok(repairsLeft.includes(path.basename(repair!.backupPath)));
});

// ── C5: self-heal takes one snapshot per run ─────────────────────────────────

test('C5: a self-heal run that applies three fixes takes exactly one snapshot', async () => {
  const { rememberFact, getFact } = await import('./facts.js');
  const { _setEmbeddingProviderForTest } = await import('./embeddings.js');
  const { runMemorySelfHeal } = await import('./self-heal.js');
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test',
    dim: 4,
    async embed(texts: string[]) { return texts.map(() => new Float32Array(4)); },
  });
  rmSync(path.join(TEST_HOME, 'state', 'memory-self-heal'), { recursive: true, force: true });
  const noise = [
    rememberFact({ kind: 'project', content: 'Internal task list result from memory_read', derivedFrom: { tool: 'memory_read', sessionId: 's1' } }),
    rememberFact({ kind: 'project', content: 'Internal search result from memory_search', derivedFrom: { tool: 'memory_search', sessionId: 's2' } }),
    rememberFact({ kind: 'project', content: 'Internal recall result from memory_recall', derivedFrom: { tool: 'memory_recall', sessionId: 's3' } }),
  ];
  const before = snapshots();
  const outcome = await runMemorySelfHeal({ maxApply: 10, nowIso: '2026-07-04T12:00:00.000Z' });
  assert.equal(outcome.applied, 3, `expected three applied fixes, got ${JSON.stringify(outcome)}`);
  for (const fact of noise) assert.equal(getFact(fact.id)?.active, false);
  const added = snapshots().filter((name) => !before.includes(name));
  assert.equal(added.length, 1, `one rollback point for the whole run, not one per fix (added ${added.join(', ')})`);
});

// ── C6: the paged fallback when no worker can start ──────────────────────────

test('C6: without a worker, the paged backup mirrors writes made through its own connection', async () => {
  _setMemoryBackupWorkerEntryForTest(new URL('./no-such-memory-backup.worker.mjs', import.meta.url));
  const db = openMemoryDb();
  const before = factCount(db);
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at,
       derivation_depth, pinned, access_count, impression_count, utility_count)
    VALUES ('project', ?, ?, 1, 1, datetime('now'), datetime('now'), 0, 0, 0, 0, 0)
  `);
  let writing = true;
  let writes = 0;
  (function write() {
    if (!writing) return;
    insert.run(`same-connection write ${writes}`, `same-${writes}-${Math.random()}`);
    writes += 1;
    setImmediate(write);
  })();
  const counter = turnCounter();
  const runsBefore = _pagedBackupStatsForTest().runs;
  const result = await backupMemoryDbAsync({ retain: 7 });
  writing = false;
  const turns = counter.stop();
  assert.ok(result, 'the paged fallback published a snapshot');
  assert.equal(_pagedBackupStatsForTest().runs, runsBefore + 1, 'the worker could not start, so the paged fallback ran');
  assert.equal(_pagedBackupStatsForTest().lastRestarts, 0, 'writes through the backup connection never restart it');
  assert.ok(writes > 0 && turns > 0, 'the loop turned (and wrote) while the copy ran');
  assert.deepEqual(headerVersions(result!.backupPath), [1, 1], 'converted to a rollback journal before publication');
  const snap = new Database(result!.backupPath, { readonly: true });
  try {
    assert.ok(factCount(snap) >= before, 'the copy holds every row committed before it began');
    assert.deepEqual(snap.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    snap.close();
  }
  assert.deepEqual(partials(), []);
});

test('C6: a second connection writing on every step makes the paged backup give up, not livelock', async () => {
  _setMemoryBackupWorkerEntryForTest(new URL('./no-such-memory-backup.worker.mjs', import.meta.url));
  openMemoryDb();
  const other = new Database(MEMORY_DB_PATH);
  other.pragma('busy_timeout = 5000');
  const insert = other.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at,
       derivation_depth, pinned, access_count, impression_count, utility_count)
    VALUES ('project', ?, ?, 1, 1, datetime('now'), datetime('now'), 0, 0, 0, 0, 0)
  `);
  let writing = true;
  let writes = 0;
  (function write() {
    if (!writing) return;
    insert.run(`other-connection write ${writes}`, `other-${writes}-${Math.random()}`);
    writes += 1;
    setImmediate(write);
  })();
  try {
    const runsBefore = _pagedBackupStatsForTest().runs;
    const result = await backupMemoryDbAsync({ retain: 7 });
    assert.equal(result, null, 'at the restart cap the backup returns null');
    assert.equal(_pagedBackupStatsForTest().runs, runsBefore + 1);
    assert.equal(_pagedBackupStatsForTest().lastRestarts, 3);
    assert.deepEqual(snapshots(), [], 'nothing half-copied is published');
    assert.deepEqual(partials(), [], 'and no partial is left behind');
  } finally {
    writing = false;
    other.close();
  }
});

test('the nightly caller awaits the worker-backed backup', () => {
  const source = readFileSync(new URL('./maintenance.ts', import.meta.url), 'utf8');
  assert.match(source, /await runMemoryJob\('backup',[\s\S]*?\(\) => backupMemoryDbAsync\(\{\s*retain: MEMORY_BACKUP_RETAIN,\s*localDayKey: today\s*\}\)/,
    'the nightly copy must not run VACUUM INTO on the main connection');
  const selfHeal = readFileSync(new URL('./self-heal.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(selfHeal, /\bbackupMemoryDb\(/, 'self-heal never takes a main-thread copy');
});

// A timed-out worker can still own a native SQLite operation until exit.
test('a timed-out backup keeps synchronous backup excluded until its thread exits', async () => {
  _setMemoryBackupWorkerEntryForTest(new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.postMessage({kind:"started"}); setInterval(() => {}, 1000);'));
  const pending = backupMemoryDbAsync({ retain: 7 });
  for (let i = 0; i < 100 && !_expireMemoryBackupWorkerForTest(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(await pending, null);
  assert.equal(memoryBackupInFlight(), true, 'the timeout result does not mean the native lease is gone');
  assert.equal(backupMemoryDb({ retain: 7 }), null);
  for (let i = 0; i < 1000 && memoryBackupInFlight(); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(memoryBackupInFlight(), false, 'exit releases the exclusion');
});
