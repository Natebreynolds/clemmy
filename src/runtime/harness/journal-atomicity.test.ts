/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/journal-atomicity.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-journal-atomic-'));
process.env.CLEMENTINE_HOME = HOME;

const { openEventLog, resetEventLog } = await import('./eventlog.js');
const { createLeaseManager } = await import('../graph/graph-lease.js');

test('sync lease transact refuses async work and rolls back on append failure', () => {
  resetEventLog();
  const db = openEventLog();
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_node_leases (
      lease_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      fence INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS graph_journal_entries (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      entry_json TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, seq)
    );
  `);
  db.prepare(`INSERT INTO graph_node_leases VALUES ('k', 'owner-a', 1, 1, ?, 0)`).run(Date.now() + 60_000);
  const store = {
    async read() { return undefined; },
    async cas() { return false; },
    transactSync(key, expected, now, work) {
      try {
        db.transaction(() => {
          const row = db.prepare(`SELECT owner, fence, released, expires_at FROM graph_node_leases WHERE lease_key = ?`).get(key) as {
            owner: string; fence: number; released: number; expires_at: number;
          };
          if ('acquireOwner' in expected) throw new Error('not used');
          if (row.owner !== expected.owner || row.fence !== expected.fence || row.released === 1 || row.expires_at <= now) {
            throw new Error('lease-mismatch');
          }
          db.prepare(`UPDATE graph_node_leases SET revision = revision + 1 WHERE lease_key = ?`).run(key);
          work();
        }).immediate();
        return { ok: true, fence: 1 };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  const manager = createLeaseManager({ store, owner: 'owner-a', clock: () => Date.now(), ttlMs: 30_000 });
  const before = db.prepare(`SELECT revision FROM graph_node_leases WHERE lease_key = 'k'`).get() as { revision: number };
  const failed = manager.commitSync('k', 1, () => {
    throw new Error('forced journal append failure');
  });
  assert.equal(failed.ok, false);
  const after = db.prepare(`SELECT revision FROM graph_node_leases WHERE lease_key = 'k'`).get() as { revision: number };
  assert.equal(after.revision, before.revision);
  const journalCount = (db.prepare(`SELECT COUNT(*) AS n FROM graph_journal_entries`).get() as { n: number }).n;
  assert.equal(journalCount, 0);
});
