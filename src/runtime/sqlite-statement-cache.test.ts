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
