import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-vault-embedding-index-'));
process.env.CLEMENTINE_HOME = home;
const {
  closeMemoryDb,
  openMemoryDb,
  migrateMemoryDatabaseHandle,
  MEMORY_DB_PATH,
  MEMORY_PRE_MIGRATION_BACKUP_DIR,
} = await import('./db.js');

after(() => {
  closeMemoryDb();
  rmSync(home, { recursive: true, force: true });
});

const indexName = 'idx_embeddings_model_dim_chunk';
const now = '2026-10-29T00:00:00.000Z';
const storedChunks = (db: Database.Database) => db.prepare('SELECT * FROM vault_chunks ORDER BY id').all();
const storedEmbeddings = (db: Database.Database) => db.prepare('SELECT * FROM embeddings ORDER BY chunk_id').all();

test('v38 indexes eligible vector keysets while preserving v37 notes, embeddings, and its rollback image', () => {
  mkdirSync(path.dirname(MEMORY_DB_PATH), { recursive: true });
  const historical = new Database(MEMORY_DB_PATH);
  let olderId: number;
  let newerId: number;
  let chunksBefore: unknown[];
  let embeddingsBefore: unknown[];
  try {
    historical.pragma('foreign_keys = ON');
    migrateMemoryDatabaseHandle(historical, { targetVersion: 37 });
    const insertChunk = historical.prepare(`
      INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
      VALUES (?, 0, ?, ?, 1000, ?, ?)
    `);
    const insertEmbedding = historical.prepare(`
      INSERT INTO embeddings (chunk_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)
    `);
    const insert = (filePath: string, content: string, model: string, values: number[]): number => {
      const id = Number(insertChunk.run(filePath, content, path.basename(filePath), content.length, content).lastInsertRowid);
      insertEmbedding.run(id, model, values.length, Buffer.from(new Float32Array(values).buffer), now);
      return id;
    };
    olderId = insert('/fixture/allowed/older.md', 'migrationprobe original note', 'fixture-space-a', [1, 0]);
    insert('/fixture/foreign/model.md', 'Foreign producing model', 'fixture-space-b', [1, 0]);
    insert('/fixture/foreign/dimension.md', 'Foreign vector dimension', 'fixture-space-a', [1, 0, 0]);
    insert('/fixture/other/outside.md', 'Outside requested subtree', 'fixture-space-a', [1, 0]);
    newerId = insert('/fixture/allowed/newer.md', 'Another eligible note', 'fixture-space-a', [0, 1]);
    chunksBefore = storedChunks(historical);
    embeddingsBefore = storedEmbeddings(historical);
    assert.equal(historical.prepare('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND name = ?').get(indexName), undefined);
  } finally {
    historical.close();
  }

  // Exercise the production upgrade entry point: existing canonical databases
  // must receive an immutable pre-migration snapshot before their schema moves.
  const db = openMemoryDb();
  const columns = (db.pragma(`index_info(${indexName})`) as Array<{ name: string }>).map(row => row.name);
  assert.deepEqual(columns, ['model', 'dim', 'chunk_id'], 'the upgrade must provide a space-filtered keyset index');
  assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, 38);
  assert.deepEqual(storedChunks(db), chunksBefore);
  assert.deepEqual(storedEmbeddings(db), embeddingsBefore);
  assert.deepEqual(db.prepare('SELECT rowid FROM vault_chunks_fts WHERE vault_chunks_fts MATCH ?').all('migrationprobe'), [{ rowid: olderId }]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);

  const query = `
    SELECT vc.id, e.vector, (vc.path LIKE ?) AS in_scope
    FROM embeddings e JOIN vault_chunks vc ON vc.id = e.chunk_id
    WHERE e.model = ? AND e.dim = ? AND e.chunk_id > ? AND e.chunk_id <= ?
    ORDER BY e.chunk_id ASC LIMIT ?
  `;
  const parameters = ['/fixture/allowed/%', 'fixture-space-a', 2, olderId, newerId, 4];
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters) as Array<{ detail: string }>;
  const indexSearch = plan.find(row => row.detail.includes(indexName))?.detail;
  assert.ok(indexSearch, `the planner should choose the eligibility index: ${JSON.stringify(plan)}`);
  assert.match(indexSearch, /model=\? AND dim=\? AND chunk_id>\? AND chunk_id<\?/);
  assert.equal(plan.some(row => /TEMP B-TREE/i.test(row.detail)), false, 'keyset traversal does not sort the full vector corpus');
  const batch = db.prepare(query).all(...parameters) as Array<{ id: number; in_scope: number }>;
  assert.equal(batch.length, 2, 'each model/dimension page advances across paths outside the requested subtree');
  assert.deepEqual(batch.filter(row => row.in_scope).map(row => row.id), [newerId]);

  const snapshots = readdirSync(MEMORY_PRE_MIGRATION_BACKUP_DIR).filter(name => /^memory-v37-to-v38-.+\.db$/.test(name));
  assert.equal(snapshots.length, 1);
  const snapshot = new Database(path.join(MEMORY_PRE_MIGRATION_BACKUP_DIR, snapshots[0]), { readonly: true });
  try {
    assert.equal((snapshot.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, 37);
    assert.deepEqual(snapshot.pragma(`index_info(${indexName})`), []);
    assert.deepEqual(storedChunks(snapshot), chunksBefore);
    assert.deepEqual(storedEmbeddings(snapshot), embeddingsBefore);
  } finally {
    snapshot.close();
  }

  db.prepare('DELETE FROM vault_chunks WHERE id = ?').run(olderId);
  assert.equal(db.prepare('SELECT 1 FROM embeddings WHERE chunk_id = ?').get(olderId), undefined, 'chunk deletion still cascades to its embedding');
  assert.deepEqual(db.prepare('SELECT rowid FROM vault_chunks_fts WHERE vault_chunks_fts MATCH ?').all('migrationprobe'), [], 'the FTS delete trigger still follows the source note');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
