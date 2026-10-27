import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createMemoryReportCache } from './report-cache.js';

test('an unchanged store serves the retained report; a commit recomputes it after the floor', () => {
  // Live 2026-10-27: the Memory screen's 30-s readiness poll recomputed ~60
  // queries on the daemon thread every time, 1.6–2.7 s held per poll, with
  // nothing changed in memory between polls.
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-report-cache-'));
  try {
    const databasePath = path.join(root, 'memory.db');
    const writer = new Database(databasePath);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, content TEXT NOT NULL)');
    writer.exec("INSERT INTO facts (content) VALUES ('first')");
    let computed = 0;
    const cache = createMemoryReportCache({
      databasePath,
      floorMs: 1_000,
      compute: () => ({ n: ++computed, rows: writer.prepare('SELECT COUNT(*) AS c FROM facts').get() as { c: number } }),
    });
    const t0 = 1_000_000;
    assert.deepEqual(cache.read(t0), { n: 1, rows: { c: 1 } });
    assert.deepEqual(cache.read(t0 + 100), { n: 1, rows: { c: 1 } }, 'nothing changed: the retained report');
    assert.deepEqual(cache.read(t0 + 60_000), { n: 1, rows: { c: 1 } }, 'age alone never recomputes an unchanged store');
    writer.exec("INSERT INTO facts (content) VALUES ('second')");
    assert.deepEqual(cache.read(t0 + 60_100), { n: 2, rows: { c: 2 } }, 'changed and past the floor: recomputed');
    writer.exec("INSERT INTO facts (content) VALUES ('third')");
    assert.deepEqual(cache.read(t0 + 60_200), { n: 2, rows: { c: 2 } }, 'changed again within the floor of the last compute: still retained');
    assert.deepEqual(cache.read(t0 + 61_200), { n: 3, rows: { c: 3 } }, 'past the floor: recomputed once');
    assert.deepEqual(cache.read(t0 + 61_300), { n: 3, rows: { c: 3 } });
    cache.reset();
    assert.deepEqual(cache.read(t0 + 61_400), { n: 4, rows: { c: 3 } }, 'reset forces one recompute');
    assert.equal(computed, 4);
    writer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a store that cannot be probed is computed on every read and never retained', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-report-cache-missing-'));
  try {
    let computed = 0;
    const cache = createMemoryReportCache({ databasePath: path.join(root, 'absent.db'), compute: () => ++computed });
    assert.equal(cache.read(1), 1);
    assert.equal(cache.read(2), 2);
    assert.equal(computed, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
