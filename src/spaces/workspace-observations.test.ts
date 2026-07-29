import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  WORKSPACE_SCHEMA_VERSION,
  ensureWorkspaceSchema,
} from './workspace-db-schema.js';
import {
  bootstrapWorkspaceObservationHistory,
  commitWorkspaceObservationBatch,
  getCurrentWorkspaceDatasetObservation,
  getWorkspaceDatasetObservation,
  getWorkspaceDatasetObservationByRefreshId,
  getWorkspaceObservationDocument,
  healWorkspaceDataProjection,
  indexWorkspaceRecord,
  listWorkspaceDatasetObservations,
  pruneWorkspaceDatasetHistory,
} from './workspace-db.js';
import type { SpaceRecord } from './store.js';

const NOW = '2026-07-28T12:00:00.000Z';

function openTestDb(rootDir: string): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkspaceSchema(db);
  insertWorkspace(db, rootDir);
  return db;
}

function insertWorkspace(db: Database.Database, rootDir: string): void {
  db.prepare(`
    INSERT INTO workspaces (
      id, slug, title, status, root_dir, created_at, updated_at
    ) VALUES (
      'temporal-room', 'temporal-room', 'Temporal Room', 'active', ?, ?, ?
    )
  `).run(rootDir, NOW, NOW);
}

function readProjectedData(rootDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(rootDir, 'data.json'), 'utf-8')) as Record<string, unknown>;
}

test('retiring a declared source preserves history but removes current truth across healing and re-adds', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clem-workspace-retirement-'));
  const db = openTestDb(rootDir);
  const baseRecord: SpaceRecord = {
    id: 'temporal-room',
    title: 'Temporal Room',
    status: 'active',
    viewEntry: 'view/index.html',
    dataSources: [{ id: 'ads', composioSlug: 'GOOGLEADS_SEARCH' }],
    actions: [],
    originSessionId: null,
    focusId: null,
    version: 1,
    revisions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  try {
    writeFileSync(
      path.join(rootDir, 'data.json'),
      JSON.stringify({ manual: { keep: true } }),
      'utf-8',
    );
    indexWorkspaceRecord(baseRecord, {
      db,
      rootDir,
      emitOperational: false,
      appendStateEvent: false,
    });
    const first = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: baseRecord.id,
      observations: [{
        sourceKey: 'ads',
        refreshId: 'ads-before-retirement',
        cause: 'scheduled',
        status: 'ok',
        data: { customers: 42 },
      }],
    }).observations[0]!;
    assert.equal(getCurrentWorkspaceDatasetObservation(baseRecord.id, 'ads', db)?.id, first.id);
    assert.deepEqual(readProjectedData(rootDir).manual, { keep: true });
    assert.deepEqual(readProjectedData(rootDir).ads, { customers: 42 });

    indexWorkspaceRecord({
      ...baseRecord,
      dataSources: [],
      updatedAt: '2026-07-28T12:05:00.000Z',
    }, {
      db,
      rootDir,
      emitOperational: false,
      appendStateEvent: false,
      now: new Date('2020-01-01T00:00:00.000Z'),
    });
    assert.equal(getCurrentWorkspaceDatasetObservation(baseRecord.id, 'ads', db), null);
    assert.equal(
      listWorkspaceDatasetObservations(baseRecord.id, {
        db,
        sourceKey: 'ads',
      }).some((entry) => entry.id === first.id),
      true,
      'retirement keeps the append-only observation queryable',
    );
    let projection = readProjectedData(rootDir);
    assert.deepEqual(projection.manual, { keep: true });
    assert.equal(Object.hasOwn(projection, 'ads'), false);
    assert.equal(
      Object.hasOwn((projection._meta ?? {}) as object, 'ads'),
      false,
    );

    // Reproduce the DB-commit/file-write crash seam. Healing must consult the
    // durable tombstone instead of accepting the stale compatibility file.
    writeFileSync(path.join(rootDir, 'data.json'), JSON.stringify({
      manual: { keep: true },
      ads: { customers: 42 },
      _meta: { ads: { ok: true } },
    }), 'utf-8');
    healWorkspaceDataProjection(baseRecord.id, { db, rootDir });
    projection = readProjectedData(rootDir);
    assert.deepEqual(projection.manual, { keep: true });
    assert.equal(Object.hasOwn(projection, 'ads'), false);

    // Declaring the same id again is not proof of a successful refresh.
    indexWorkspaceRecord({
      ...baseRecord,
      updatedAt: '2026-07-28T12:10:00.000Z',
    }, {
      db,
      rootDir,
      emitOperational: false,
      appendStateEvent: false,
    });
    healWorkspaceDataProjection(baseRecord.id, { db, rootDir });
    assert.equal(Object.hasOwn(readProjectedData(rootDir), 'ads'), false);

    commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: baseRecord.id,
      observations: [{
        sourceKey: 'ads',
        refreshId: 'ads-readded-failed',
        cause: 'manual',
        status: 'error',
        error: 'provider unavailable',
      }],
    });
    projection = readProjectedData(rootDir);
    assert.equal(Object.hasOwn(projection, 'ads'), false);
    assert.deepEqual(
      (projection._meta as Record<string, unknown>).ads,
      {
        refreshedAt: (projection._meta as {
          ads: { refreshedAt: string };
        }).ads.refreshedAt,
        ok: false,
        status: 'error',
        error: 'provider unavailable',
      },
    );

    const restored = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: baseRecord.id,
      observations: [{
        sourceKey: 'ads',
        refreshId: 'ads-readded-success',
        cause: 'manual',
        status: 'ok',
        data: { customers: 43 },
      }],
    }).observations[0]!;
    assert.equal(getCurrentWorkspaceDatasetObservation(baseRecord.id, 'ads', db)?.id, restored.id);
    assert.deepEqual(readProjectedData(rootDir).ads, { customers: 43 });
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count
        FROM workspace_dataset_source_retirements
        WHERE workspace_id = ? AND source_key = ?
      `).get(baseRecord.id, 'ads') as { count: number }).count,
      0,
    );

    // A refresh that was already in flight when the source is removed may
    // remain historical, but cannot make the retired source current again.
    indexWorkspaceRecord({
      ...baseRecord,
      dataSources: [],
      updatedAt: '2026-07-28T12:15:00.000Z',
    }, {
      db,
      rootDir,
      emitOperational: false,
      appendStateEvent: false,
    });
    commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: baseRecord.id,
      observations: [{
        sourceKey: 'ads',
        refreshId: 'ads-inflight-after-retirement',
        cause: 'scheduled',
        status: 'ok',
        data: { customers: 99 },
      }],
    });
    assert.equal(getCurrentWorkspaceDatasetObservation(baseRecord.id, 'ads', db), null);
    assert.equal(Object.hasOwn(readProjectedData(rootDir), 'ads'), false);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('migrates an unstamped 2.7.5 workspace DB in place without losing dataset rows', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        root_dir TEXT NOT NULL,
        view_entry TEXT NOT NULL DEFAULT 'view/index.html',
        origin_session_id TEXT,
        focus_id INTEGER,
        recipe_json TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT,
        last_refreshed_at TEXT
      );
      CREATE TABLE workspace_data_sources (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        runner TEXT,
        composio_slug TEXT,
        args_json TEXT NOT NULL DEFAULT '{}',
        schedule TEXT,
        timezone TEXT,
        last_status TEXT,
        last_error TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE workspace_datasets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_id TEXT REFERENCES workspace_data_sources(id) ON DELETE SET NULL,
        doc_json TEXT NOT NULL DEFAULT '{}',
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok',
        error TEXT,
        refreshed_at TEXT NOT NULL
      );
      PRAGMA user_version = 0;
    `);
    db.prepare(`
      INSERT INTO workspaces (
        id, slug, title, status, root_dir, created_at, updated_at
      ) VALUES (
        'legacy', 'legacy', 'Legacy', 'active', '/tmp/legacy', ?, ?
      )
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO workspace_data_sources (
        id, workspace_id, composio_slug, created_at, updated_at
      ) VALUES (
        'legacy:source:google-ads', 'legacy', 'GOOGLEADS_SEARCH', ?, ?
      )
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO workspace_datasets (
        id, workspace_id, source_id, doc_json, content_hash, refreshed_at
      ) VALUES (
        'legacy-dataset', 'legacy', 'legacy:source:google-ads',
        '{"clicks":12}', 'old-hash', ?
      )
    `).run(NOW);

    ensureWorkspaceSchema(db);
    ensureWorkspaceSchema(db);

    assert.equal(db.pragma('user_version', { simple: true }), WORKSPACE_SCHEMA_VERSION);
    const row = db.prepare(`
      SELECT id, source_key, bytes, first_seen_at, last_seen_at
      FROM workspace_datasets
      WHERE id = 'legacy-dataset'
    `).get() as {
      id: string;
      source_key: string;
      bytes: number;
      first_seen_at: string;
      last_seen_at: string;
    };
    assert.deepEqual(row, {
      id: 'legacy-dataset',
      source_key: 'google-ads',
      bytes: Buffer.byteLength('{"clicks":12}'),
      first_seen_at: NOW,
      last_seen_at: NOW,
    });
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n
        FROM sqlite_master
        WHERE type = 'table' AND name = 'workspace_dataset_observations'
      `).get() as { n: number }).n,
      1,
    );
  } finally {
    db.close();
  }
});

test('batch commit atomically records per-source observations and content-addresses distinct data', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-batch-'));
  const db = openTestDb(rootDir);
  try {
    const first = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      batchId: 'batch-1',
      observations: [
        {
          sourceKey: 'google-ads',
          refreshId: 'ads-refresh-1',
          cause: 'scheduled',
          status: 'ok',
          data: { spend: 100, conversions: 4 },
          observedAt: '2026-07-28T12:01:00.000Z',
          provenance: {
            provider: 'composio',
            toolSlug: 'GOOGLEADS_SEARCH',
            requestId: 'request-1',
          },
        },
        {
          sourceKey: 'bookkeeping',
          refreshId: 'books-refresh-1',
          cause: 'manual',
          status: 'ok',
          data: [{ id: 'txn-1', amount: 12 }],
          observedAt: '2026-07-28T12:01:01.000Z',
        },
      ],
    });

    assert.equal(first.observations.length, 2);
    assert.ok(first.observations.every((item) => item.batchId === 'batch-1'));
    assert.ok(first.observations.every((item) => item.deduped === false));
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_datasets').get() as { n: number }).n,
      2,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_dataset_observations').get() as { n: number }).n,
      2,
    );
    assert.deepEqual(readProjectedData(rootDir).google_ads, undefined);
    assert.deepEqual(readProjectedData(rootDir)['google-ads'], { spend: 100, conversions: 4 });
    assert.deepEqual(readProjectedData(rootDir).bookkeeping, [{ id: 'txn-1', amount: 12 }]);

    const sameContent = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      batchId: 'batch-2',
      observations: [{
        sourceKey: 'google-ads',
        refreshId: 'ads-refresh-2',
        cause: 'scheduled',
        status: 'ok',
        data: { conversions: 4, spend: 100 },
        observedAt: '2026-07-28T13:01:00.000Z',
        provenance: {
          provider: 'composio',
          toolSlug: 'GOOGLEADS_SEARCH',
          requestId: 'request-2',
        },
      }],
    });

    assert.equal(sameContent.observations[0]?.changed, false);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_datasets').get() as { n: number }).n,
      2,
      'same canonical data should reuse its content-addressed dataset',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_dataset_observations').get() as { n: number }).n,
      3,
      'a distinct refresh still appends an observation',
    );
    const current = getCurrentWorkspaceDatasetObservation(
      'temporal-room',
      'google-ads',
      db,
    );
    assert.equal(current?.refreshId, 'ads-refresh-2');
    assert.equal(current?.previousObservationId, first.observations[0]?.id);
    assert.equal(current?.datasetId, first.observations[0]?.datasetId);

    const retry = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'google-ads',
        refreshId: 'ads-refresh-2',
        cause: 'scheduled',
        status: 'ok',
        data: { spend: 100, conversions: 4 },
        provenance: {
          provider: 'composio',
          toolSlug: 'GOOGLEADS_SEARCH',
          requestId: 'request-2',
        },
      }],
    });
    assert.equal(retry.observations[0]?.deduped, true);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_dataset_observations').get() as { n: number }).n,
      3,
    );

    assert.throws(
      () => commitWorkspaceObservationBatch({
        db,
        rootDir,
        workspaceId: 'temporal-room',
        observations: [{
          sourceKey: 'google-ads',
          refreshId: 'ads-refresh-2',
          cause: 'scheduled',
          status: 'ok',
          data: { spend: 999, conversions: 4 },
        }],
      }),
      /refreshId conflict/i,
    );
    assert.equal(getCurrentWorkspaceDatasetObservation(
      'temporal-room',
      'google-ads',
      db,
    )?.datasetId, first.observations[0]?.datasetId);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('observation cursor paginates every row across identical timestamp boundaries', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-cursor-'));
  const db = openTestDb(rootDir);
  try {
    const committed = ['one', 'two', 'three'].map((refreshId) =>
      commitWorkspaceObservationBatch({
        db,
        rootDir,
        workspaceId: 'temporal-room',
        observations: [{
          sourceKey: `source-${refreshId}`,
          refreshId,
          cause: 'manual',
          status: 'ok',
          data: { refreshId },
          observedAt: NOW,
        }],
      }).observations[0]!,
    );
    // Force the complete public sort tuple to tie except for rowid. This is
    // realistic for a legacy bootstrap and makes timestamp-only pagination
    // provably lossy.
    db.prepare(`
      UPDATE workspace_dataset_observations
      SET created_at = ?
      WHERE workspace_id = 'temporal-room'
    `).run(NOW);

    const firstPage = listWorkspaceDatasetObservations('temporal-room', {
      db,
      limit: 2,
    });
    assert.deepEqual(
      firstPage.map((observation) => observation.id),
      [committed[2]!.id, committed[1]!.id],
    );
    assert.deepEqual(
      listWorkspaceDatasetObservations('temporal-room', {
        db,
        before: firstPage[1]!.observedAt,
        limit: 2,
      }),
      [],
      'legacy timestamp-only boundaries cannot include a tied remainder',
    );

    const secondPage = listWorkspaceDatasetObservations('temporal-room', {
      db,
      cursor: firstPage[1]!.id,
      limit: 2,
    });
    assert.deepEqual(
      secondPage.map((observation) => observation.id),
      [committed[0]!.id],
    );
    assert.throws(
      () => listWorkspaceDatasetObservations('temporal-room', {
        db,
        cursor: 'missing-observation',
      }),
      /observation cursor.*not found/i,
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('refresh-id lookup is exact, normalized, and workspace/source scoped', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-refresh-id-'));
  const db = openTestDb(rootDir);
  try {
    const committed = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'metrics',
        refreshId: 'refresh-one',
        cause: 'manual',
        status: 'ok',
        data: { value: 1 },
      }],
    }).observations[0]!;

    assert.equal(
      getWorkspaceDatasetObservationByRefreshId(
        'temporal-room',
        ' metrics ',
        ' refresh-one ',
        db,
      )?.id,
      committed.id,
    );
    assert.equal(
      getWorkspaceDatasetObservationByRefreshId(
        'temporal-room',
        'other-source',
        'refresh-one',
        db,
      ),
      null,
    );
    assert.equal(
      getWorkspaceDatasetObservationByRefreshId(
        'other-room',
        'metrics',
        'refresh-one',
        db,
      ),
      null,
    );
    assert.throws(
      () => getWorkspaceDatasetObservationByRefreshId(
        'temporal-room',
        'metrics',
        'bad\u0001refresh',
        db,
      ),
      /control character/i,
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a conflicting item rolls back every new observation in its batch', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-atomic-'));
  const db = openTestDb(rootDir);
  try {
    commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'existing',
        refreshId: 'existing-1',
        cause: 'manual',
        status: 'ok',
        data: { value: 1 },
      }],
    });

    assert.throws(
      () => commitWorkspaceObservationBatch({
        db,
        rootDir,
        workspaceId: 'temporal-room',
        observations: [
          {
            sourceKey: 'new-source',
            refreshId: 'new-1',
            cause: 'scheduled',
            status: 'ok',
            data: { value: 2 },
          },
          {
            sourceKey: 'existing',
            refreshId: 'existing-1',
            cause: 'manual',
            status: 'ok',
            data: { value: 999 },
          },
        ],
      }),
      /refreshId conflict/i,
    );

    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n
        FROM workspace_dataset_observations
        WHERE source_key = 'new-source'
      `).get() as { n: number }).n,
      0,
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n
        FROM workspace_datasets
        WHERE source_key = 'new-source'
      `).get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('errors and approvals append without advancing current data and scrub persisted secrets', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-errors-'));
  const db = openTestDb(rootDir);
  try {
    const success = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'ads',
        refreshId: 'ads-ok',
        cause: 'scheduled',
        status: 'ok',
        data: { spend: 100 },
      }],
    }).observations[0]!;

    commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [
        {
          sourceKey: 'ads',
          refreshId: 'ads-error',
          cause: 'scheduled',
          status: 'error',
          observedAt: '2020-01-01T00:00:00.000Z',
          error: [
            'Authorization: Bearer live-secret-token',
            'url=https://user:super-secret@example.com/path?api_key=query-secret',
            'x-api-key=header-secret',
            'payload={"access_token":"json-secret","password":"json-pass"}',
            'provider said API key sk-abcd is invalid',
            'authToken=camel-auth idToken:camel-id credentialValue=camel-credential',
            'Z'.repeat(5_000),
          ].join(' '),
          provenance: {
            provider: 'composio',
            requestId: 'Bearer request-secret',
            authorization: 'Bearer provenance-secret',
            arbitraryPayload: { password: 'nested-secret' },
          },
        },
        {
          sourceKey: 'books',
          refreshId: 'books-approval',
          cause: 'manual',
          status: 'awaiting_approval',
          error: 'Approval apr-123 is required',
          provenance: {
            approvalId: 'apr-123',
            authorization: 'Bearer do-not-project',
            arbitraryPayload: 'do-not-project',
          },
        },
      ],
    });

    assert.equal(
      getCurrentWorkspaceDatasetObservation('temporal-room', 'ads', db)?.id,
      success.id,
    );
    assert.equal(
      getCurrentWorkspaceDatasetObservation('temporal-room', 'books', db),
      null,
    );
    const stored = db.prepare(`
      SELECT error, provenance_json
      FROM workspace_dataset_observations
      WHERE refresh_id = 'ads-error'
    `).get() as { error: string; provenance_json: string };
    assert.ok(stored.error.length <= 2_000);
    assert.doesNotMatch(
      stored.error,
      /live-secret|super-secret|query-secret|header-secret|json-secret|json-pass|sk-abcd|camel-auth|camel-id|camel-credential/i,
    );
    assert.match(stored.error, /REDACTED/);
    assert.doesNotMatch(stored.provenance_json, /request-secret|provenance-secret|nested-secret/);
    assert.deepEqual(JSON.parse(stored.provenance_json), {
      provider: 'composio',
      requestId: '[REDACTED]',
    });
    assert.deepEqual(readProjectedData(rootDir).ads, { spend: 100 });
    assert.equal(
      ((readProjectedData(rootDir)._meta as Record<string, unknown>).ads as Record<string, unknown>).ok,
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(
        (readProjectedData(rootDir)._meta as Record<string, unknown>).ads,
      ),
      /camel-auth|camel-id|camel-credential/,
    );
    const booksMeta = (
      (readProjectedData(rootDir)._meta as Record<string, unknown>).books
    ) as Record<string, unknown>;
    assert.equal(booksMeta.ok, null);
    assert.equal(booksMeta.status, 'awaiting_approval');
    assert.equal(booksMeta.error, 'Approval apr-123 is required');
    assert.equal(booksMeta.approvalId, 'apr-123');
    assert.doesNotMatch(JSON.stringify(booksMeta), /do-not-project/);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DB commit survives a projection crash and heals data.json after restart', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-heal-'));
  const rootDir = path.join(temp, 'workspace');
  const dbFile = path.join(temp, 'workspaces.db');
  writeFileSync(
    path.join(temp, 'placeholder'),
    '',
    'utf-8',
  );
  const db1 = new Database(dbFile);
  try {
    db1.pragma('foreign_keys = ON');
    ensureWorkspaceSchema(db1);
    insertWorkspace(db1, rootDir);
    writeFileSync(
      path.join(temp, 'legacy-data.json'),
      '{}',
      'utf-8',
    );
    // The Workspace directory may already contain data written before temporal
    // history was enabled. Healing must preserve keys it cannot account for.
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(
      path.join(rootDir, 'data.json'),
      JSON.stringify({ legacy: { keep: true } }),
      'utf-8',
    );

    assert.throws(
      () => commitWorkspaceObservationBatch({
        db: db1,
        rootDir,
        workspaceId: 'temporal-room',
        observations: [{
          sourceKey: 'ads',
          refreshId: 'ads-crash',
          cause: 'scheduled',
          status: 'ok',
          data: { spend: 321 },
        }],
        afterCommit: () => {
          throw new Error('simulated file crash');
        },
      }),
      /simulated file crash/,
    );
    assert.deepEqual(readProjectedData(rootDir), { legacy: { keep: true } });
    assert.equal(
      (db1.prepare(`
        SELECT COUNT(*) AS n
        FROM workspace_dataset_observations
        WHERE refresh_id = 'ads-crash'
      `).get() as { n: number }).n,
      1,
    );
  } finally {
    db1.close();
  }

  const db2 = new Database(dbFile);
  try {
    db2.pragma('foreign_keys = ON');
    ensureWorkspaceSchema(db2);
    const healed = healWorkspaceDataProjection('temporal-room', { db: db2, rootDir });
    assert.equal(healed.sources, 1);
    assert.deepEqual(readProjectedData(rootDir).legacy, { keep: true });
    assert.deepEqual(readProjectedData(rootDir).ads, { spend: 321 });

    const retry = commitWorkspaceObservationBatch({
      db: db2,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'ads',
        refreshId: 'ads-crash',
        cause: 'scheduled',
        status: 'ok',
        data: { spend: 321 },
      }],
    });
    assert.equal(retry.observations[0]?.deduped, true);
    assert.deepEqual(readProjectedData(rootDir).ads, { spend: 321 });
  } finally {
    db2.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('document-mode observations support full data.json replacement and restart healing', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-document-'));
  const db = openTestDb(rootDir);
  try {
    commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'document',
        refreshId: 'put-1',
        cause: 'direct_put',
        projectionMode: 'document',
        status: 'ok',
        data: { entire: { document: true }, rows: [1, 2, 3] },
      }],
    });
    assert.deepEqual(readProjectedData(rootDir), {
      entire: { document: true },
      rows: [1, 2, 3],
    });
    commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'late-source',
        refreshId: 'late-source-1',
        cause: 'recovery',
        status: 'ok',
        data: { arrived: 'after-document' },
        observedAt: '2020-01-01T00:00:00.000Z',
      }],
    });
    assert.deepEqual(readProjectedData(rootDir)['late-source'], {
      arrived: 'after-document',
    }, 'projection follows commit order even when an event timestamp is backfilled');

    writeFileSync(path.join(rootDir, 'data.json'), '{}', 'utf-8');
    healWorkspaceDataProjection('temporal-room', { db, rootDir });
    assert.deepEqual(readProjectedData(rootDir), {
      entire: { document: true },
      rows: [1, 2, 3],
      'late-source': { arrived: 'after-document' },
      _meta: {
        'late-source': {
          refreshedAt: '2020-01-01T00:00:00.000Z',
          ok: true,
          provenance: 'recovery',
        },
      },
    });
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('document-mode literal null survives commit, exact read, and restart healing', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-document-null-'));
  const db = openTestDb(rootDir);
  try {
    const observation = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: '$document',
        refreshId: 'put-null',
        cause: 'direct_put',
        projectionMode: 'document',
        status: 'ok',
        data: null,
      }],
    }).observations[0]!;

    assert.equal(
      getWorkspaceObservationDocument('temporal-room', observation.id, db),
      null,
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(rootDir, 'data.json'), 'utf-8')),
      null,
      'the compatibility projection must distinguish literal null from missing',
    );

    writeFileSync(path.join(rootDir, 'data.json'), '{}', 'utf-8');
    healWorkspaceDataProjection('temporal-room', { db, rootDir });
    assert.equal(
      JSON.parse(readFileSync(path.join(rootDir, 'data.json'), 'utf-8')),
      null,
      'restart healing must preserve the exact retained document',
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('prototype-shaped source keys survive commit and restart healing without prototype pollution', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-prototype-'));
  const db = openTestDb(rootDir);
  const sourceKeys = ['__proto__', 'constructor', 'prototype'];
  try {
    commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: sourceKeys.map((sourceKey, index) => ({
        sourceKey,
        refreshId: `prototype-${index}`,
        cause: 'manual',
        status: 'ok' as const,
        data: { sourceKey, polluted: false },
      })),
    });

    const assertSafeProjection = (): void => {
      const projected = readProjectedData(rootDir);
      const meta = projected._meta as Record<string, unknown>;
      for (const sourceKey of sourceKeys) {
        assert.equal(Object.hasOwn(projected, sourceKey), true);
        assert.deepEqual(projected[sourceKey], { sourceKey, polluted: false });
        assert.equal(Object.hasOwn(meta, sourceKey), true);
        assert.equal(
          getCurrentWorkspaceDatasetObservation(
            'temporal-room',
            sourceKey,
            db,
          )?.sourceKey,
          sourceKey,
        );
      }
      assert.equal(
        ({} as Record<string, unknown>).polluted,
        undefined,
        'Object.prototype must remain untouched',
      );
    };
    assertSafeProjection();

    writeFileSync(path.join(rootDir, 'data.json'), '{}', 'utf-8');
    healWorkspaceDataProjection('temporal-room', { db, rootDir });
    assertSafeProjection();
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('legacy prototype-shaped source keys bootstrap without mutation and heal as own properties', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-prototype-legacy-'));
  const db = openTestDb(rootDir);
  const legacy = [
    '{',
    '"__proto__":{"legacy":"proto"},',
    '"constructor":{"legacy":"constructor"},',
    '"prototype":{"legacy":"prototype"},',
    '"_meta":{"__proto__":{"ok":true}}',
    '}',
  ].join('');
  try {
    writeFileSync(path.join(rootDir, 'data.json'), legacy, 'utf-8');
    assert.deepEqual(
      bootstrapWorkspaceObservationHistory('temporal-room', { db, rootDir }),
      { ok: true, imported: 3, skipped: 0 },
    );
    assert.equal(readFileSync(path.join(rootDir, 'data.json'), 'utf-8'), legacy);

    writeFileSync(path.join(rootDir, 'data.json'), '{}', 'utf-8');
    healWorkspaceDataProjection('temporal-room', { db, rootDir });
    const healed = readProjectedData(rootDir);
    const meta = healed._meta as Record<string, unknown>;
    for (const sourceKey of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(Object.hasOwn(healed, sourceKey), true);
      assert.equal(Object.hasOwn(meta, sourceKey), true);
    }
    assert.deepEqual(healed.__proto__, { legacy: 'proto' });
    assert.equal(({} as Record<string, unknown>).legacy, undefined);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounded listing and retention preserve current data while pruning old observations and blobs', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-retention-'));
  const db = openTestDb(rootDir);
  try {
    db.prepare(`
      INSERT INTO workspace_datasets (
        id, workspace_id, source_key, doc_json, content_hash, bytes, status,
        refreshed_at, first_seen_at, last_seen_at
      ) VALUES (
        'wdsXlegacy', 'temporal-room', 'legacy', '{"preserve":true}',
        'legacy-hash', 17, 'ok', ?, ?, ?
      )
    `).run(NOW, NOW, NOW);
    for (let i = 1; i <= 5; i += 1) {
      commitWorkspaceObservationBatch({
        db,
        rootDir,
        workspaceId: 'temporal-room',
        observations: [{
          sourceKey: 'metrics',
          refreshId: `metrics-${i}`,
          cause: 'scheduled',
          status: 'ok',
          data: { value: i },
          observedAt: `2026-07-2${i}T12:00:00.000Z`,
        }],
      });
    }

    assert.equal(
      listWorkspaceDatasetObservations('temporal-room', { db, limit: 2 }).length,
      2,
    );
    const before = getCurrentWorkspaceDatasetObservation(
      'temporal-room',
      'metrics',
      db,
    );
    const pruned = pruneWorkspaceDatasetHistory('temporal-room', {
      db,
      maxObservationsPerSource: 1,
      maxAgeDays: 1,
      maxDatasetBytes: 1,
      now: new Date('2026-07-28T12:00:00.000Z'),
    });

    assert.equal(pruned.observationsDeleted, 3);
    assert.equal(
      listWorkspaceDatasetObservations('temporal-room', { db, limit: 100 }).length,
      2,
      'current and immediately prior successful observations are always protected',
    );
    assert.equal(
      getCurrentWorkspaceDatasetObservation('temporal-room', 'metrics', db)?.id,
      before?.id,
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n
        FROM workspace_datasets
        WHERE source_key = 'metrics'
      `).get() as { n: number }).n,
      2,
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n
        FROM workspace_datasets
        WHERE id = 'wdsXlegacy'
      `).get() as { n: number }).n,
      1,
      'retention only owns the exact wds_ namespace and preserves legacy rows',
    );
    assert.deepEqual(readProjectedData(rootDir).metrics, { value: 5 });
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('observation metadata and documents are workspace-scoped and failed observations have no document', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-scope-'));
  const db = openTestDb(rootDir);
  try {
    db.prepare(`
      INSERT INTO workspaces (
        id, slug, title, status, root_dir, created_at, updated_at
      ) VALUES (
        'other-room', 'other-room', 'Other Room', 'active', ?, ?, ?
      )
    `).run(rootDir, NOW, NOW);
    const success = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'metrics',
        refreshId: 'metrics-ok',
        cause: 'manual',
        status: 'ok',
        data: { privateToWorkspace: true },
      }],
    }).observations[0]!;
    const failure = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'failed',
        refreshId: 'failed-1',
        cause: 'scheduled',
        status: 'error',
        error: 'provider unavailable',
      }],
    }).observations[0]!;
    const literalNull = commitWorkspaceObservationBatch({
      db,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'nullable',
        refreshId: 'nullable-1',
        cause: 'manual',
        status: 'ok',
        data: null,
      }],
    }).observations[0]!;

    assert.equal(
      getWorkspaceDatasetObservation('temporal-room', success.id, db)?.contentHash,
      success.contentHash,
    );
    assert.deepEqual(
      getWorkspaceObservationDocument('temporal-room', success.id, db),
      { privateToWorkspace: true },
    );
    assert.equal(getWorkspaceDatasetObservation('other-room', success.id, db), null);
    assert.equal(getWorkspaceObservationDocument('other-room', success.id, db), undefined);
    assert.equal(getWorkspaceObservationDocument('temporal-room', failure.id, db), undefined);
    assert.equal(
      getWorkspaceObservationDocument('temporal-room', literalNull.id, db),
      null,
      'literal JSON null remains distinct from an inaccessible document',
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('legacy data.json bootstrap is deterministic, excludes _meta, and becomes the prior observation', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-bootstrap-'));
  const rootDir = path.join(temp, 'workspace');
  const dbFile = path.join(temp, 'workspaces.db');
  mkdirSync(rootDir, { recursive: true });
  const original = JSON.stringify({
    ads: { spend: 50 },
    books: [{ id: 'txn-1' }],
    _meta: { ads: { ok: true, refreshedAt: NOW } },
  });
  writeFileSync(path.join(rootDir, 'data.json'), original, 'utf-8');

  const db1 = new Database(dbFile);
  let baselineId = '';
  try {
    db1.pragma('foreign_keys = ON');
    ensureWorkspaceSchema(db1);
    insertWorkspace(db1, rootDir);

    const first = bootstrapWorkspaceObservationHistory(
      'temporal-room',
      { db: db1, rootDir },
    );
    assert.deepEqual(first, { ok: true, imported: 2, skipped: 0 });
    assert.equal(readFileSync(path.join(rootDir, 'data.json'), 'utf-8'), original);
    assert.equal(
      listWorkspaceDatasetObservations('temporal-room', { db: db1, limit: 100 }).length,
      2,
    );
    assert.equal(
      listWorkspaceDatasetObservations('temporal-room', {
        db: db1,
        sourceKey: '_meta',
      }).length,
      0,
    );
    const baseline = getCurrentWorkspaceDatasetObservation(
      'temporal-room',
      'ads',
      db1,
    )!;
    baselineId = baseline.id;
    assert.equal(baseline.cause, 'legacy_import');
    assert.match(baseline.refreshId, /^legacy:/);

    const record: SpaceRecord = {
      id: 'temporal-room',
      title: 'Temporal Room',
      status: 'active',
      viewEntry: 'view/index.html',
      dataSources: [
        { id: 'ads', composioSlug: 'GOOGLEADS_SEARCH' },
        { id: 'books', composioSlug: 'GOOGLESHEETS_GET_VALUES' },
      ],
      actions: [],
      originSessionId: null,
      focusId: null,
      version: 1,
      revisions: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    indexWorkspaceRecord(record, { db: db1, rootDir, emitOperational: false });
    assert.deepEqual(
      bootstrapWorkspaceObservationHistory('temporal-room', { db: db1, rootDir }),
      { ok: true, imported: 0, skipped: 2 },
    );

    const refreshed = commitWorkspaceObservationBatch({
      db: db1,
      rootDir,
      workspaceId: 'temporal-room',
      observations: [{
        sourceKey: 'ads',
        refreshId: 'first-v3-refresh',
        cause: 'scheduled',
        status: 'ok',
        data: { spend: 75 },
      }],
    }).observations[0]!;
    assert.equal(refreshed.previousObservationId, baselineId);
    assert.equal(refreshed.changed, true);
    indexWorkspaceRecord(record, {
      db: db1,
      rootDir,
      emitOperational: false,
      now: new Date('2026-07-28T13:00:00.000Z'),
    });
    assert.deepEqual(
      db1.prepare(`
        SELECT source_id, source_key
        FROM workspace_datasets
        WHERE id = ?
      `).get(refreshed.datasetId) as { source_id: string; source_key: string },
      {
        source_id: 'temporal-room:source:ads',
        source_key: 'ads',
      },
      'manifest reindex keeps the stable source row while history uses durable source_key',
    );
    assert.equal(
      getCurrentWorkspaceDatasetObservation('temporal-room', 'ads', db1)?.id,
      refreshed.id,
    );
  } finally {
    db1.close();
  }

  const db2 = new Database(dbFile);
  try {
    db2.pragma('foreign_keys = ON');
    ensureWorkspaceSchema(db2);
    assert.deepEqual(
      bootstrapWorkspaceObservationHistory('temporal-room', { db: db2, rootDir }),
      { ok: true, imported: 0, skipped: 2 },
    );
    assert.equal(
      getWorkspaceDatasetObservation('temporal-room', baselineId, db2)?.cause,
      'legacy_import',
    );
  } finally {
    db2.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('legacy bootstrap keeps document semantics and malformed/oversize files cannot mutate storage', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-observations-bootstrap-safe-'));
  const db = openTestDb(rootDir);
  try {
    writeFileSync(path.join(rootDir, 'data.json'), '[1,2,3]', 'utf-8');
    assert.deepEqual(
      bootstrapWorkspaceObservationHistory('temporal-room', { db, rootDir }),
      { ok: true, imported: 1, skipped: 0 },
    );
    const document = getCurrentWorkspaceDatasetObservation(
      'temporal-room',
      '$document',
      db,
    )!;
    assert.equal(document.projectionMode, 'document');
    assert.deepEqual(
      getWorkspaceObservationDocument('temporal-room', document.id, db),
      [1, 2, 3],
    );
    assert.equal(readFileSync(path.join(rootDir, 'data.json'), 'utf-8'), '[1,2,3]');

    db.prepare(`
      DELETE FROM workspace_dataset_observations
      WHERE workspace_id = 'temporal-room'
    `).run();
    db.prepare(`
      DELETE FROM workspace_datasets
      WHERE workspace_id = 'temporal-room'
    `).run();

    const malformed = '{"broken":';
    writeFileSync(path.join(rootDir, 'data.json'), malformed, 'utf-8');
    const malformedResult = bootstrapWorkspaceObservationHistory(
      'temporal-room',
      { db, rootDir },
    );
    assert.equal(malformedResult.ok, false);
    assert.match(malformedResult.ok ? '' : malformedResult.error, /valid JSON/i);
    assert.equal(readFileSync(path.join(rootDir, 'data.json'), 'utf-8'), malformed);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_dataset_observations').get() as { n: number }).n,
      0,
    );

    const oversized = JSON.stringify({ huge: 'x'.repeat(5 * 1024 * 1024) });
    writeFileSync(path.join(rootDir, 'data.json'), oversized, 'utf-8');
    const oversizedResult = bootstrapWorkspaceObservationHistory(
      'temporal-room',
      { db, rootDir },
    );
    assert.equal(oversizedResult.ok, false);
    assert.match(oversizedResult.ok ? '' : oversizedResult.error, /byte cap/i);
    assert.equal(readFileSync(path.join(rootDir, 'data.json'), 'utf-8'), oversized);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_dataset_observations').get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
