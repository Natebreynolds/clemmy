import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { ensureWorkspaceSchema } from './workspace-db-schema.js';
import {
  commitWorkspaceObservationBatch,
  type WorkspaceObservationCommitItem,
} from './workspace-db.js';
import {
  diffWorkspaceObservations,
  getWorkspaceHistoryAvailability,
  listWorkspaceObservationHistory,
} from './workspace-observation-query.js';

interface QueryHarness {
  db: Database.Database;
  temp: string;
  roots: Record<'alpha' | 'beta', string>;
}

function openHarness(): QueryHarness {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clem-workspace-query-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkspaceSchema(db);
  const roots = {
    alpha: path.join(temp, 'alpha'),
    beta: path.join(temp, 'beta'),
  };
  const insert = db.prepare(`
    INSERT INTO workspaces (
      id, slug, title, status, root_dir, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, '2026-07-28T10:00:00.000Z', '2026-07-28T10:00:00.000Z')
  `);
  insert.run('alpha', 'alpha', 'Alpha', roots.alpha);
  insert.run('beta', 'beta', 'Beta', roots.beta);
  return { db, temp, roots };
}

function closeHarness(harness: QueryHarness): void {
  harness.db.close();
  rmSync(harness.temp, { recursive: true, force: true });
}

function commit(
  harness: QueryHarness,
  workspaceId: 'alpha' | 'beta',
  observation: WorkspaceObservationCommitItem,
) {
  return commitWorkspaceObservationBatch({
    db: harness.db,
    rootDir: harness.roots[workspaceId],
    workspaceId,
    observations: [observation],
  }).observations[0]!;
}

test('history is metadata-only, provenance-bounded, and clamps its row limit', () => {
  const harness = openHarness();
  try {
    for (let index = 0; index < 6; index += 1) {
      commit(harness, 'alpha', {
        sourceKey: 'ads',
        refreshId: `ads-${index}`,
        cause: 'scheduled',
        status: 'ok',
        data: { spend: index, raw: 'RAW-DATA-MUST-NOT-LEAK' },
        observedAt: `2026-07-28T10:0${index}:00.000Z`,
        provenance: {
          provider: 'composio',
          toolSlug: 'GOOGLEADS_SEARCH',
          requestId: 'OPENAI_API_KEY=sk-historycanary1234567890abcdef',
          arbitraryPayload: 'PROVENANCE-PAYLOAD-MUST-NOT-LEAK',
        },
      });
    }
    const history = listWorkspaceObservationHistory('alpha', {
      db: harness.db,
      sourceKey: 'ads',
      limit: 999,
    });
    assert.equal(history.limit, 25);
    assert.equal(history.returned, 6);
    assert.deepEqual(history.observations[0]?.provenance, [
      'provider=composio',
      'tool=GOOGLEADS_SEARCH',
      'request=[REDACTED]',
    ]);
    const serialized = JSON.stringify(history);
    assert.doesNotMatch(serialized, /RAW-DATA-MUST-NOT-LEAK/);
    assert.doesNotMatch(serialized, /PROVENANCE-PAYLOAD-MUST-NOT-LEAK/);
    assert.doesNotMatch(serialized, /historycanary/);
  } finally {
    closeHarness(harness);
  }
});

test('first success and failed-only sources report explicit insufficient history', () => {
  const harness = openHarness();
  try {
    commit(harness, 'alpha', {
      sourceKey: 'first',
      refreshId: 'first-ok',
      cause: 'manual',
      status: 'ok',
      data: { value: 1 },
    });
    commit(harness, 'alpha', {
      sourceKey: 'failed',
      refreshId: 'failed-1',
      cause: 'scheduled',
      status: 'error',
      error: 'upstream unavailable',
    });
    assert.deepEqual(diffWorkspaceObservations('alpha', 'first', { db: harness.db }), {
      status: 'insufficient_history',
      workspace: 'alpha',
      source: 'first',
      successfulObservations: 1,
      reason: 'only_one_successful_observation',
    });
    assert.equal(
      listWorkspaceObservationHistory('alpha', {
        db: harness.db,
        sourceKey: 'first',
      }).observations[0]?.changed,
      null,
      'a baseline is not presented as a change without a prior observation',
    );
    assert.deepEqual(diffWorkspaceObservations('alpha', 'failed', { db: harness.db }), {
      status: 'insufficient_history',
      workspace: 'alpha',
      source: 'failed',
      successfulObservations: 0,
      reason: 'no_successful_observations',
    });
    const failedHistory = listWorkspaceObservationHistory('alpha', {
      db: harness.db,
      sourceKey: 'failed',
    });
    assert.equal(failedHistory.observations[0]?.status, 'error');
    assert.equal(failedHistory.observations[0]?.changed, null);
  } finally {
    closeHarness(harness);
  }
});

test('distinct successful observations with identical data report unchanged', () => {
  const harness = openHarness();
  try {
    const first = commit(harness, 'alpha', {
      sourceKey: 'ads',
      refreshId: 'same-1',
      cause: 'scheduled',
      status: 'ok',
      data: { conversions: 4, spend: 100 },
      observedAt: '2026-07-28T10:00:00.000Z',
    });
    const second = commit(harness, 'alpha', {
      sourceKey: 'ads',
      refreshId: 'same-2',
      cause: 'scheduled',
      status: 'ok',
      data: { spend: 100, conversions: 4 },
      observedAt: '2026-07-28T11:00:00.000Z',
    });
    const result = diffWorkspaceObservations('alpha', 'ads', { db: harness.db });
    assert.equal(result.status, 'unchanged');
    if (result.status !== 'unchanged') return;
    assert.equal(result.from.id, first.id);
    assert.equal(result.to.id, second.id);
    assert.deepEqual(result.changes, []);
    assert.match(result.summary, /No data changes/);
  } finally {
    closeHarness(harness);
  }
});

test('default diff compares current versus prior success and ignores failed attempts', () => {
  const harness = openHarness();
  try {
    const first = commit(harness, 'alpha', {
      sourceKey: 'books',
      refreshId: 'books-1',
      cause: 'scheduled',
      status: 'ok',
      data: [{ id: 'txn-1', category: 'uncategorized' }],
      observedAt: '2026-07-28T10:00:00.000Z',
    });
    commit(harness, 'alpha', {
      sourceKey: 'books',
      refreshId: 'books-failed',
      cause: 'retry',
      status: 'error',
      error: 'temporary failure',
      observedAt: '2026-07-28T10:30:00.000Z',
    });
    const second = commit(harness, 'alpha', {
      sourceKey: 'books',
      refreshId: 'books-2',
      cause: 'scheduled',
      status: 'ok',
      data: [{ id: 'txn-1', category: 'software' }],
      observedAt: '2026-07-28T11:00:00.000Z',
    });
    const result = diffWorkspaceObservations('alpha', 'books', { db: harness.db });
    assert.equal(result.status, 'changed');
    if (result.status !== 'changed') return;
    assert.equal(result.from.id, first.id);
    assert.equal(result.to.id, second.id);
    assert.ok(result.changes.some((change) => change.path.endsWith('/category')));
  } finally {
    closeHarness(harness);
  }
});

test('default diff follows the durable observation chain when source clocks are out of order', () => {
  const harness = openHarness();
  try {
    const first = commit(harness, 'alpha', {
      sourceKey: 'clock-skew',
      refreshId: 'clock-1',
      cause: 'scheduled',
      status: 'ok',
      data: { value: 1 },
      observedAt: '2026-07-28T12:00:00.000Z',
    });
    const second = commit(harness, 'alpha', {
      sourceKey: 'clock-skew',
      refreshId: 'clock-2',
      cause: 'retry',
      status: 'ok',
      data: { value: 2 },
      observedAt: '2026-07-28T11:00:00.000Z',
    });
    const result = diffWorkspaceObservations('alpha', 'clock-skew', { db: harness.db });
    assert.equal(result.status, 'changed');
    if (result.status !== 'changed') return;
    assert.equal(result.from.id, first.id);
    assert.equal(result.to.id, second.id);
  } finally {
    closeHarness(harness);
  }
});

test('observation ids cannot cross a workspace or source boundary', () => {
  const harness = openHarness();
  try {
    commit(harness, 'alpha', {
      sourceKey: 'ads',
      refreshId: 'ads-1',
      cause: 'manual',
      status: 'ok',
      data: { value: 1 },
    });
    commit(harness, 'alpha', {
      sourceKey: 'ads',
      refreshId: 'ads-2',
      cause: 'manual',
      status: 'ok',
      data: { value: 2 },
    });
    const otherSource = commit(harness, 'alpha', {
      sourceKey: 'books',
      refreshId: 'books-1',
      cause: 'manual',
      status: 'ok',
      data: { value: 3 },
    });
    const otherWorkspace = commit(harness, 'beta', {
      sourceKey: 'ads',
      refreshId: 'beta-ads-1',
      cause: 'manual',
      status: 'ok',
      data: { value: 4 },
    });
    for (const forbiddenId of [otherSource.id, otherWorkspace.id]) {
      assert.deepEqual(
        diffWorkspaceObservations('alpha', 'ads', {
          db: harness.db,
          fromObservationId: forbiddenId,
        }),
        {
          status: 'observation_not_found',
          workspace: 'alpha',
          source: 'ads',
          reason: 'requested observation is not a retained successful observation for this workspace and source',
        },
      );
    }
  } finally {
    closeHarness(harness);
  }
});

test('diff entry count, paths, identities, and value previews stay bounded', () => {
  const harness = openHarness();
  try {
    const hugeKey = `field-${'k'.repeat(500)}`;
    const before = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        index === 0 ? hugeKey : `field-${index}`,
        `before-${'x'.repeat(500)}`,
      ]),
    );
    const after = Object.fromEntries(
      Object.keys(before).map((key) => [key, `after-${'y'.repeat(500)}`]),
    );
    commit(harness, 'alpha', {
      sourceKey: 'large',
      refreshId: 'large-1',
      cause: 'manual',
      status: 'ok',
      data: before,
    });
    commit(harness, 'alpha', {
      sourceKey: 'large',
      refreshId: 'large-2',
      cause: 'manual',
      status: 'ok',
      data: after,
    });
    const result = diffWorkspaceObservations('alpha', 'large', {
      db: harness.db,
      maxChanges: 999,
    });
    assert.equal(result.status, 'changed');
    if (result.status !== 'changed') return;
    assert.equal(result.changes.length, 25);
    assert.equal(result.truncated, true);
    assert.ok(result.changes.every((change) => change.path.length <= 240));
    assert.ok(result.changes.every((change) => (change.entityKey?.length ?? 0) <= 120));
    assert.ok(result.changes.every((change) => (change.before?.length ?? 0) <= 160));
    assert.ok(result.changes.every((change) => (change.after?.length ?? 0) <= 160));
  } finally {
    closeHarness(harness);
  }
});

test('literal JSON null is a valid retained document, not a missing blob', () => {
  const harness = openHarness();
  try {
    commit(harness, 'alpha', {
      sourceKey: 'nullable',
      refreshId: 'null-1',
      cause: 'manual',
      status: 'ok',
      data: null,
    });
    commit(harness, 'alpha', {
      sourceKey: 'nullable',
      refreshId: 'null-2',
      cause: 'manual',
      status: 'ok',
      data: { restored: true },
    });
    const result = diffWorkspaceObservations('alpha', 'nullable', { db: harness.db });
    assert.equal(result.status, 'changed');
  } finally {
    closeHarness(harness);
  }
});

test('diff previews redact credential-shaped values even under a generic field name', () => {
  const harness = openHarness();
  try {
    commit(harness, 'alpha', {
      sourceKey: 'secret-preview',
      refreshId: 'secret-1',
      cause: 'manual',
      status: 'ok',
      data: {
        note: 'Bearer old-live-secret-token',
        url: 'https://user:old-password@example.test/path?api_key=old-query-secret',
        env: 'OPENAI_API_KEY=sk-oldcanary1234567890abcdef',
        credentials: 'PASSWORD=old-password-canary',
        // The `...` marks this as a placeholder body for the public-hygiene
        // check, which otherwise flags any PEM block as key material. The
        // canary substring the assertion below greps for is unchanged.
        pem: '-----BEGIN PRIVATE KEY-----\nOLD-PRIVATE-CANARY...\n-----END PRIVATE KEY-----',
        'OPENAI_API_KEY=sk-pathcanary1234567890abcdef': 'old',
        rows: [{ id: 'OPENAI_API_KEY=sk-entitycanary1234567890abcdef', state: 'old' }],
      },
    });
    commit(harness, 'alpha', {
      sourceKey: 'secret-preview',
      refreshId: 'secret-2',
      cause: 'manual',
      status: 'ok',
      data: {
        note: 'Bearer new-live-secret-token',
        url: 'https://user:new-password@example.test/path?api_key=new-query-secret',
        env: 'OPENAI_API_KEY=sk-newcanary1234567890abcdef',
        credentials: 'PASSWORD=new-password-canary',
        pem: '-----BEGIN PRIVATE KEY-----\nNEW-PRIVATE-CANARY...\n-----END PRIVATE KEY-----',
        'OPENAI_API_KEY=sk-pathcanary1234567890abcdef': 'new',
        rows: [{ id: 'OPENAI_API_KEY=sk-entitycanary1234567890abcdef', state: 'new' }],
      },
    });
    const result = diffWorkspaceObservations('alpha', 'secret-preview', { db: harness.db });
    assert.equal(result.status, 'changed');
    const serialized = JSON.stringify(result);
    assert.match(serialized, /REDACTED/);
    assert.doesNotMatch(
      serialized,
      /old-live-secret|new-live-secret|old-password|new-password|password-canary|old-query-secret|new-query-secret|oldcanary|newcanary|pathcanary|entitycanary|OLD-PRIVATE-CANARY|NEW-PRIVATE-CANARY/,
    );
  } finally {
    closeHarness(harness);
  }
});

test('availability distinguishes a baseline from a comparable source', () => {
  const harness = openHarness();
  try {
    commit(harness, 'alpha', {
      sourceKey: 'baseline',
      refreshId: 'baseline-1',
      cause: 'legacy_import',
      status: 'ok',
      data: { value: 1 },
    });
    commit(harness, 'alpha', {
      sourceKey: 'comparable',
      refreshId: 'comparable-1',
      cause: 'manual',
      status: 'ok',
      data: { value: 1 },
    });
    commit(harness, 'alpha', {
      sourceKey: 'comparable',
      refreshId: 'comparable-2',
      cause: 'manual',
      status: 'ok',
      data: { value: 2 },
    });
    assert.deepEqual(getWorkspaceHistoryAvailability('alpha', harness.db), {
      observations: 3,
      observationsAreLowerBound: false,
      successfulObservations: 3,
      sourcesObserved: 2,
      comparableSources: ['comparable'],
    });
  } finally {
    closeHarness(harness);
  }
});
