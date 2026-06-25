/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-durability npx tsx --test src/memory/durability.test.ts
 *
 * WS6 — durability + hygiene. Covers the restore-from-backup round-trip (the
 * previously-missing reader for nightly snapshots) and the hard-purge of
 * soft-deleted facts (FK CASCADE drops their embeddings + relationship links).
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-durability';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb, backupMemoryDb, restoreMemoryDb, purgeSoftDeletedFacts } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact, forgetFact, getFact, listActiveFacts } = await import('./facts.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('./reflection.js');
// eslint-disable-next-line import/first
const { setFactEntityLinks, getEntityIdsForFact } = await import('./relations.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); openMemoryDb(); });

test('restoreMemoryDb round-trips facts from a snapshot', () => {
  const f = rememberFact({ kind: 'user', content: 'A durable fact worth keeping.' });
  const backup = backupMemoryDb({ retain: 7 });
  assert.ok(backup, 'a snapshot was written');

  // Mutate after the snapshot: forget the fact (soft-delete) + add another.
  forgetFact(f.id);
  rememberFact({ kind: 'project', content: 'Added after the snapshot.' });
  assert.equal(getFact(f.id)?.id, f.id); // still present (soft-deleted)

  // Restore → state reverts to the snapshot (the post-snapshot add is gone,
  // the forgotten fact is active again).
  const res = restoreMemoryDb(backup!.backupPath);
  assert.ok(res.bytes > 0);
  const active = listActiveFacts({ limit: 50 });
  assert.equal(active.length, 1, 'only the snapshot fact is active');
  assert.equal(active[0].content, 'A durable fact worth keeping.');
});

test('restoreMemoryDb rejects a non-Clementine / missing snapshot without clobbering', () => {
  rememberFact({ kind: 'user', content: 'Live fact stays put.' });
  assert.throws(() => restoreMemoryDb('/no/such/backup.db'), /backup not found/);
  assert.equal(listActiveFacts({ limit: 10 }).length, 1, 'live DB untouched after failed restore');
});

test('purgeSoftDeletedFacts hard-deletes old inactive facts and CASCADEs their links', () => {
  const keep = rememberFact({ kind: 'user', content: 'Recent active fact.' });
  const old = rememberFact({ kind: 'project', content: 'Stale fact to be purged.' });
  const ent = upsertEntity({ type: 'company', name: 'Acme' });
  setFactEntityLinks(old.id, [ent]);
  assert.deepEqual(getEntityIdsForFact(old.id), [ent]);

  // Soft-delete `old` and back-date it well beyond the purge window.
  forgetFact(old.id);
  const db = openMemoryDb();
  db.prepare("UPDATE consolidated_facts SET updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 200 * 86_400_000).toISOString(), old.id);

  const purged = purgeSoftDeletedFacts({ minAgeDays: 180 });
  assert.equal(purged, 1, 'one stale inactive fact purged');
  assert.equal(getFact(old.id), null, 'purged fact is gone');
  assert.equal(getEntityIdsForFact(old.id).length, 0, 'fact_entities link CASCADE-dropped');
  assert.equal(getFact(keep.id)?.id, keep.id, 'recent active fact untouched');
});

test('purgeSoftDeletedFacts never purges pinned or recent facts', () => {
  const pinned = rememberFact({ kind: 'feedback', content: 'Pinned standing rule.' });
  forgetFact(pinned.id);
  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET pinned = 1, updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 300 * 86_400_000).toISOString(), pinned.id);
  assert.equal(purgeSoftDeletedFacts({ minAgeDays: 180 }), 0, 'pinned inactive fact is never purged');
});
