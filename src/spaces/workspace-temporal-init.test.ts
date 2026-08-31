import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  initializeWorkspaceTemporalStorage,
  type WorkspaceTemporalInitDependencies,
} from './workspace-temporal-init.js';
import {
  bootstrapWorkspaceObservationHistory,
  commitWorkspaceObservationBatch,
  healWorkspaceDataProjection,
  indexWorkspaceRecord,
} from './workspace-db.js';
import { ensureWorkspaceSchema } from './workspace-db-schema.js';
import type { SpaceRecord } from './store.js';

function workspace(id: string): SpaceRecord {
  return {
    id,
    title: id,
    status: 'active',
    viewEntry: 'view/index.html',
    dataSources: [],
    actions: [],
    version: 1,
    revisions: [],
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

test('boot imports legacy baselines, heals post-commit workspaces, recovers memory, then prunes', async () => {
  const indexed: string[] = [];
  const healed: string[] = [];
  const lifecycle: string[] = [];
  const deps: WorkspaceTemporalInitDependencies = {
    listWorkspaces: () => [workspace('legacy'), workspace('modern')],
    index: (record) => indexed.push(record.id),
    bootstrap: (id) => ({ ok: true, imported: id === 'legacy' ? 2 : 0, skipped: 0 }),
    hasNonLegacyObservation: (id) => id === 'modern',
    heal: (id) => {
      healed.push(id);
      return true;
    },
    recoverMemory: async (id) => {
      lifecycle.push(`recover:${id}`);
      return {
        examined: id === 'modern' ? 2 : 0,
        memory: [],
        memoryCandidates: id === 'modern' ? 2 : 0,
        memoryRecorded: id === 'modern' ? 1 : 0,
        memoryDeduped: id === 'modern' ? 1 : 0,
        memoryFailed: 0,
      };
    },
    prune: (id) => {
      lifecycle.push(`prune:${id}`);
      return {
      observationsDeleted: 1,
      datasetsDeleted: 1,
      datasetBytesRetained: 100,
      };
    },
  };
  const result = await initializeWorkspaceTemporalStorage(deps);
  assert.deepEqual(indexed, ['legacy', 'modern', 'modern']);
  assert.deepEqual(healed, ['modern']);
  assert.deepEqual(lifecycle, [
    'recover:legacy',
    'prune:legacy',
    'recover:modern',
    'prune:modern',
  ]);
  assert.equal(result.baselinesImported, 2);
  assert.equal(result.projectionsHealed, 1);
  assert.equal(result.memoryCandidates, 2);
  assert.equal(result.memoryRecorded, 1);
  assert.equal(result.memoryDeduped, 1);
  assert.equal(result.observationsPruned, 2);
  assert.equal(result.datasetsPruned, 2);
  assert.deepEqual(result.errors, []);
});

test('boot heals and indexes a crashed document projection immediately, then reaches a fixed point', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-temporal-document-heal-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkspaceSchema(db);
  const record = workspace('temporal-room');
  let indexCalls = 0;

  const dependencies: WorkspaceTemporalInitDependencies = {
    listWorkspaces: () => [record],
    index: (item) => {
      indexCalls += 1;
      indexWorkspaceRecord(item, {
        db,
        rootDir,
        emitOperational: false,
        appendStateEvent: false,
        strict: true,
      });
    },
    bootstrap: (workspaceId) => bootstrapWorkspaceObservationHistory(workspaceId, {
      db,
      rootDir,
    }),
    hasNonLegacyObservation: (workspaceId) => Boolean(db.prepare(`
      SELECT 1
      FROM workspace_dataset_observations
      WHERE workspace_id = ? AND cause <> 'legacy_import'
      LIMIT 1
    `).get(workspaceId)),
    heal: (workspaceId) => healWorkspaceDataProjection(workspaceId, {
      db,
      rootDir,
    }).changed,
    recoverMemory: async () => ({
      examined: 0,
      memory: [],
      memoryCandidates: 0,
      memoryRecorded: 0,
      memoryDeduped: 0,
      memoryFailed: 0,
    }),
    prune: () => ({
      observationsDeleted: 0,
      datasetsDeleted: 0,
      datasetBytesRetained: 0,
    }),
  };

  try {
    const projectionPath = path.join(rootDir, 'data.json');
    writeFileSync(projectionPath, '{"preexisting":true}', 'utf-8');
    indexWorkspaceRecord(record, {
      db,
      rootDir,
      emitOperational: false,
      appendStateEvent: false,
      strict: true,
    });
    assert.throws(
      () => commitWorkspaceObservationBatch({
        db,
        rootDir,
        workspaceId: record.id,
        observations: [{
          sourceKey: 'fixture-document',
          refreshId: 'document-crash-1',
          cause: 'direct_put',
          projectionMode: 'document',
          status: 'ok',
          data: { release: 'v3.14.0', rows: [{ id: 1 }, { id: 2 }] },
        }],
        afterCommit: () => {
          throw new Error('simulated projection crash');
        },
      }),
      /simulated projection crash/,
    );
    writeFileSync(projectionPath, '{"torn":', 'utf-8');

    const firstBoot = await initializeWorkspaceTemporalStorage(dependencies);
    assert.equal(firstBoot.projectionsHealed, 1);
    assert.deepEqual(firstBoot.errors, []);
    assert.equal(indexCalls, 2, 'changed bytes require a post-heal index in the same boot');

    const healedBytes = readFileSync(projectionPath);
    assert.deepEqual(
      JSON.parse(healedBytes.toString('utf-8')),
      { release: 'v3.14.0', rows: [{ id: 1 }, { id: 2 }] },
    );
    const healedMtimeNs = statSync(projectionPath, { bigint: true }).mtimeNs;
    const indexedAfterHeal = db.prepare(`
      SELECT id, workspace_id, rel_path, kind, content_hash, bytes, version,
             created_at, updated_at
      FROM workspace_files
      WHERE workspace_id = ? AND rel_path = 'data.json'
    `).get(record.id) as Record<string, unknown>;
    assert.equal(
      indexedAfterHeal.content_hash,
      createHash('sha256').update(healedBytes).digest('hex'),
    );
    assert.equal(indexedAfterHeal.bytes, healedBytes.byteLength);

    const secondBoot = await initializeWorkspaceTemporalStorage(dependencies);
    assert.equal(secondBoot.projectionsHealed, 0);
    assert.deepEqual(secondBoot.errors, []);
    assert.equal(indexCalls, 3, 'converged bytes must not trigger a second post-heal index');
    assert.deepEqual(readFileSync(projectionPath), healedBytes);
    assert.equal(statSync(projectionPath, { bigint: true }).mtimeNs, healedMtimeNs);
    assert.deepEqual(
      db.prepare(`
        SELECT id, workspace_id, rel_path, kind, content_hash, bytes, version,
               created_at, updated_at
        FROM workspace_files
        WHERE workspace_id = ? AND rel_path = 'data.json'
      `).get(record.id),
      indexedAfterHeal,
      'boot two must not need file-index catch-up',
    );
    assert.deepEqual(
      db.prepare(`
        SELECT source_key, projection_mode, cause, is_current
        FROM workspace_dataset_observations
        WHERE workspace_id = ?
        ORDER BY rowid
      `).all(record.id),
      [{
        source_key: 'fixture-document',
        projection_mode: 'document',
        cause: 'direct_put',
        is_current: 1,
      }],
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('one malformed legacy workspace cannot stop other Workspace initialization', async () => {
  const pruned: string[] = [];
  const deps: WorkspaceTemporalInitDependencies = {
    listWorkspaces: () => [workspace('broken'), workspace('healthy')],
    index: () => undefined,
    bootstrap: (id) => id === 'broken'
      ? { ok: false, error: 'legacy data.json is not valid JSON' }
      : { ok: true, imported: 1, skipped: 0 },
    hasNonLegacyObservation: () => false,
    heal: () => false,
    recoverMemory: async () => ({
      examined: 0,
      memory: [],
      memoryCandidates: 0,
      memoryRecorded: 0,
      memoryDeduped: 0,
      memoryFailed: 0,
    }),
    prune: (id) => {
      pruned.push(id);
      return { observationsDeleted: 0, datasetsDeleted: 0, datasetBytesRetained: 0 };
    },
  };
  const result = await initializeWorkspaceTemporalStorage(deps);
  assert.deepEqual(pruned, ['healthy']);
  assert.deepEqual(result.errors, [{
    workspaceId: 'broken',
    error: 'legacy data.json is not valid JSON',
  }]);
});

test('boot reports memory recovery failure without allowing retention to grow forever', async () => {
  const pruned: string[] = [];
  const deps: WorkspaceTemporalInitDependencies = {
    listWorkspaces: () => [workspace('preserve-for-retry'), workspace('healthy')],
    index: () => undefined,
    bootstrap: () => ({ ok: true, imported: 0, skipped: 0 }),
    hasNonLegacyObservation: () => true,
    heal: () => false,
    recoverMemory: async (id) => {
      if (id === 'preserve-for-retry') throw new Error('memory database offline');
      return {
        examined: 1,
        memory: [],
        memoryCandidates: 1,
        memoryRecorded: 1,
        memoryDeduped: 0,
        memoryFailed: 0,
      };
    },
    prune: (id) => {
      pruned.push(id);
      return { observationsDeleted: 0, datasetsDeleted: 0, datasetBytesRetained: 0 };
    },
  };
  const result = await initializeWorkspaceTemporalStorage(deps);
  assert.deepEqual(pruned, ['preserve-for-retry', 'healthy']);
  assert.equal(result.memoryFailures, 1);
  assert.deepEqual(result.errors, [{
    workspaceId: 'preserve-for-retry',
    error: 'memory recovery failed: memory database offline',
  }]);
});
