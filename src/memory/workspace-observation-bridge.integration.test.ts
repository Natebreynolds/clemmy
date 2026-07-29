import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(tmpdir(), 'clem-workspace-memory-purge-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const {
  createWorkspaceObservationMemoryBridge,
  listWorkspaceObservationMemoryProjectionIds,
  purgeWorkspaceObservationMemory,
  pruneWorkspaceObservationMemoryProjections,
  recordWorkspaceObservationMemoryProjection,
} = await import('./workspace-observation-bridge.js');
const { recordMemoryEpisode } = await import('./temporal-memory.js');
const { recallEverything } = await import('./unified-recall.js');
const { resolveSpaceDir, spaceStore } = await import('../spaces/store.js');
const {
  commitWorkspaceObservationBatch,
  resetWorkspaceDbForTest,
} = await import('../spaces/workspace-db.js');
const { initializeWorkspaceTemporalStorage } = await import(
  '../spaces/workspace-temporal-init.js'
);

beforeEach(() => {
  resetMemoryDb();
  resetWorkspaceDbForTest();
  rmSync(path.join(TEST_HOME, 'spaces'), { recursive: true, force: true });
});

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('hard delete purges Workspace episodes, receipts, and FK attachments from unified recall', async () => {
  const bridge = createWorkspaceObservationMemoryBridge();
  const captured = await bridge.capture({
    kind: 'observation',
    workspaceId: 'ads-room',
    sourceId: 'campaigns',
    observationId: 'obs-current',
    contentHash: 'b'.repeat(64),
    previousContentHash: 'a'.repeat(64),
    occurredAt: '2026-07-28T20:00:00.000Z',
    provenanceSummary: 'Scheduled Workspace observation committed.',
    outcome: 'succeeded',
    changeCounts: { add: 1, remove: 0, replace: 2 },
    truncated: false,
  });
  assert.equal(captured.status, 'recorded');
  assert.ok(captured.episodeId);
  recordWorkspaceObservationMemoryProjection({
    workspaceId: 'ads-room',
    observationId: 'obs-current',
    disposition: 'captured',
    reason: 'recorded',
  });
  recordWorkspaceObservationMemoryProjection({
    workspaceId: 'ads-room',
    observationId: 'obs-already-pruned',
    disposition: 'suppressed',
    reason: 'volatile_only',
  });
  assert.equal(
    pruneWorkspaceObservationMemoryProjections('ads-room', ['obs-current']),
    1,
  );

  const db = openMemoryDb();
  const now = new Date().toISOString();
  const subject = Number(db.prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json,
       first_seen_at, last_seen_at, mention_count)
    VALUES ('project', 'Old Ads Room', 'old ads room', '[]', ?, ?, 1)
  `).run(now, now).lastInsertRowid);
  const object = Number(db.prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json,
       first_seen_at, last_seen_at, mention_count)
    VALUES ('company', 'Old Campaign', 'old campaign', '[]', ?, ?, 1)
  `).run(now, now).lastInsertRowid);
  db.prepare(`
    INSERT INTO entity_edges
      (subject_id, predicate, object_id, recurrence_count, first_seen_at,
       last_seen_at, confidence, evidence_episode_id, valid_from)
    VALUES (?, 'tracked', ?, 1, ?, ?, 0.9, ?, ?)
  `).run(subject, object, now, now, captured.episodeId, now);
  db.prepare(`
    INSERT INTO entity_edge_evidence
      (subject_id, predicate, object_id, episode_id, excerpt_hash, excerpt,
       confidence, observed_at, extraction_method, created_at)
    VALUES (?, 'tracked', ?, ?, 'workspace-evidence', 'bounded evidence',
            0.9, ?, 'manual', ?)
  `).run(subject, object, captured.episodeId, now, now);

  const unrelated = recordMemoryEpisode({
    kind: 'manual',
    sourceApp: 'manual',
    sessionId: 'manual:keep',
    callId: 'manual-keep',
    occurredAt: '2026-07-28T20:00:00.000Z',
    content: 'Workspace data elsewhere changed: 9 additions.',
    status: 'available',
  });
  const before = await recallEverything(
    'Workspace data changed additions replacements',
    { stores: ['episode'], limit: 20, perStore: 20 },
  );
  assert.ok(before.hits.some((hit) => hit.ref === captured.episodeId));

  const purged = purgeWorkspaceObservationMemory('ads-room', db);
  assert.equal(purged.episodesDeleted, 1);
  assert.equal(purged.projectionReceiptsDeleted, 1);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM entity_edge_evidence
      WHERE episode_id = ?
    `).get(captured.episodeId) as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare(`
      SELECT evidence_episode_id
      FROM entity_edges
      WHERE subject_id = ? AND predicate = 'tracked' AND object_id = ?
    `).get(subject, object) as { evidence_episode_id: string | null }).evidence_episode_id,
    null,
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual([...listWorkspaceObservationMemoryProjectionIds('ads-room', db)], []);

  const afterPurge = await recallEverything(
    'Workspace data changed additions replacements',
    { stores: ['episode'], limit: 20, perStore: 20 },
  );
  assert.ok(!afterPurge.hits.some((hit) => hit.ref === captured.episodeId));
  assert.ok(afterPurge.hits.some((hit) => hit.ref === unrelated.id));

  const recreated = await createWorkspaceObservationMemoryBridge().capture({
    kind: 'observation',
    workspaceId: 'ads-room',
    sourceId: 'campaigns',
    observationId: 'obs-recreated',
    contentHash: 'd'.repeat(64),
    previousContentHash: 'c'.repeat(64),
    occurredAt: '2026-07-28T22:00:00.000Z',
    provenanceSummary: 'New Workspace generation.',
    outcome: 'succeeded',
    changeCounts: { add: 2, remove: 0, replace: 0 },
    truncated: false,
  });
  assert.equal(recreated.status, 'recorded');
  assert.equal(recreated.episodeId, captured.episodeId, 'identity may be reused only after old state is gone');
});

test('real boot recovery closes a post-commit crash once and performs no second-boot projection', async () => {
  spaceStore.save({
    id: 'crash-recovery',
    title: 'Crash Recovery',
    dataSources: [{ id: 'metrics' }],
  });
  const rootDir = resolveSpaceDir('crash-recovery');
  commitWorkspaceObservationBatch({
    workspaceId: 'crash-recovery',
    rootDir,
    observations: [{
      sourceKey: 'metrics',
      refreshId: 'baseline',
      cause: 'manual',
      status: 'ok',
      data: { total: 1, fetchedAt: '2026-07-28T10:00:00.000Z' },
      observedAt: '2026-07-28T10:00:00.000Z',
    }],
  });
  assert.throws(() => commitWorkspaceObservationBatch({
    workspaceId: 'crash-recovery',
    rootDir,
    observations: [{
      sourceKey: 'metrics',
      refreshId: 'durable-before-crash',
      cause: 'scheduled',
      status: 'ok',
      data: { total: 2, fetchedAt: '2026-07-28T11:00:00.000Z' },
      observedAt: '2026-07-28T11:00:00.000Z',
    }],
    afterCommit: () => {
      throw new Error('injected crash after SQLite commit');
    },
  }), /injected crash/);

  const firstBoot = await initializeWorkspaceTemporalStorage();
  assert.equal(firstBoot.errors.length, 0);
  assert.equal(firstBoot.memoryCandidates, 1);
  assert.equal(firstBoot.memoryRecorded, 1);
  assert.equal(firstBoot.projectionsHealed, 1);
  assert.equal(
    (openMemoryDb().prepare(`
      SELECT COUNT(*) AS count
      FROM memory_episodes
      WHERE source_app = 'workspace'
        AND session_id = 'workspace:crash-recovery'
    `).get() as { count: number }).count,
    1,
  );
  assert.equal(
    [...listWorkspaceObservationMemoryProjectionIds('crash-recovery')].length,
    1,
  );

  const secondBoot = await initializeWorkspaceTemporalStorage();
  assert.equal(secondBoot.errors.length, 0);
  assert.equal(secondBoot.memoryCandidates, 0);
  assert.equal(secondBoot.memoryRecorded, 0);
  assert.equal(secondBoot.memoryDeduped, 0);
});
