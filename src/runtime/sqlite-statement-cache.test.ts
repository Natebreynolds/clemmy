import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { prepareCached } from './sqlite-statement-cache.js';

test('prepareCached prepares once per SQL shape without suppressing executions', () => {
  let prepareCalls = 0;
  let getCalls = 0;
  let allCalls = 0;
  const statementFor = (source: string) => ({
    source,
    get: (..._params: unknown[]) => {
      getCalls += 1;
      return { source };
    },
    all: (..._params: unknown[]) => {
      allCalls += 1;
      return [{ source }];
    },
  });
  const db = {
    open: true,
    prepare: (source: string) => {
      prepareCalls += 1;
      return statementFor(source);
    },
  } as unknown as Database.Database;

  for (let i = 0; i < 3; i += 1) {
    prepareCached(db, 'SELECT one WHERE id = ?').get(i);
  }
  for (let i = 0; i < 4; i += 1) {
    prepareCached(db, 'SELECT many WHERE id > ?').all(i);
  }

  assert.equal(prepareCalls, 2, 'each distinct SQL text is prepared once');
  assert.equal(getCalls, 3, 'every point read still executes');
  assert.equal(allCalls, 4, 'every list read still executes');
});

test('prepareCached isolates handles and a reopened path gets fresh statements', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-statement-cache-'));
  const file = path.join(dir, 'cache.db');
  try {
    const first = new Database(file);
    const firstStatement = prepareCached(first, 'SELECT 1 AS value');
    assert.strictEqual(
      prepareCached(first, 'SELECT 1 AS value'),
      firstStatement,
      'one live handle reuses its statement',
    );
    first.close();
    assert.throws(
      () => prepareCached(first, 'SELECT 1 AS value'),
      /database connection is not open/i,
      'a closed handle keeps the native prepare-time failure',
    );

    const reopened = new Database(file);
    try {
      const reopenedStatement = prepareCached(reopened, 'SELECT 1 AS value');
      assert.notStrictEqual(
        reopenedStatement,
        firstStatement,
        'a new handle for the same path cannot inherit a closed statement',
      );
      assert.deepEqual(reopenedStatement.get(), { value: 1 });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an active iterator gets an independent statement without losing its scope or continuation', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE records(id INTEGER PRIMARY KEY, scope TEXT, value TEXT);
      INSERT INTO records VALUES (1,'a','first'),(2,'b','other'),(3,'a','last');`);
    const sql = 'SELECT * FROM records WHERE scope = ? ORDER BY id';
    const original = prepareCached(db, sql);
    const iterator = original.iterate('a');
    try {
      assert.deepEqual(iterator.next().value, { id:1, scope:'a', value:'first' });
      assert.equal(original.busy, true);
      const nested = prepareCached(db, sql);
      assert.notStrictEqual(nested, original);
      assert.deepEqual(nested.get('b'), { id:2, scope:'b', value:'other' });
      assert.deepEqual(iterator.next().value, { id:3, scope:'a', value:'last' });
    } finally { iterator.return?.(); }
    assert.strictEqual(prepareCached(db, sql), original);
  } finally { db.close(); }
});

test('cached SQL still reads current corrections and schema changes, rather than caching results', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE records(id INTEGER PRIMARY KEY, scope TEXT, value TEXT);
      INSERT INTO records VALUES (1,'a','old'),(2,'b','other');`);
    const sql = 'SELECT * FROM records WHERE id = ? AND scope = ?';
    assert.deepEqual(prepareCached(db,sql).get(1,'a'), {id:1,scope:'a',value:'old'});
    db.prepare('UPDATE records SET value = ? WHERE id = ?').run('corrected',1);
    assert.deepEqual(prepareCached(db,sql).get(1,'a'), {id:1,scope:'a',value:'corrected'});
    assert.equal(prepareCached(db,sql).get(1,'b'),undefined);
    db.exec("ALTER TABLE records ADD COLUMN revision INTEGER NOT NULL DEFAULT 2");
    assert.deepEqual(prepareCached(db,sql).get(1,'a'), {id:1,scope:'a',value:'corrected',revision:2});
  } finally { db.close(); }
});
