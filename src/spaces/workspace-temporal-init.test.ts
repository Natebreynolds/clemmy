import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initializeWorkspaceTemporalStorage,
  type WorkspaceTemporalInitDependencies,
} from './workspace-temporal-init.js';
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
    heal: (id) => healed.push(id),
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
  assert.deepEqual(indexed, ['legacy', 'modern']);
  assert.deepEqual(healed, ['modern']);
  assert.deepEqual(lifecycle, [
    'recover:legacy',
    'prune:legacy',
    'recover:modern',
    'prune:modern',
  ]);
  assert.equal(result.baselinesImported, 2);
  assert.equal(result.memoryCandidates, 2);
  assert.equal(result.memoryRecorded, 1);
  assert.equal(result.memoryDeduped, 1);
  assert.equal(result.observationsPruned, 2);
  assert.equal(result.datasetsPruned, 2);
  assert.deepEqual(result.errors, []);
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
    heal: () => undefined,
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
    heal: () => undefined,
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
