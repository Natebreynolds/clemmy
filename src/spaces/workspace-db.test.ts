import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { WORKSPACE_SCHEMA_SQL } from './workspace-db-schema.js';
import { deleteWorkspaceIndex, indexWorkspaceRecord, listIndexedWorkspaces } from './workspace-db.js';
import type { SpaceRecord } from './store.js';

test('indexWorkspaceRecord indexes manifest-backed workspace rows', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workspace-index-'));
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKSPACE_SCHEMA_SQL);
    mkdirSync(path.join(tmp, 'view'), { recursive: true });
    mkdirSync(path.join(tmp, 'data'), { recursive: true });
    mkdirSync(path.join(tmp, 'view-history'), { recursive: true });
    writeFileSync(path.join(tmp, 'space.json'), '{"id":"release-room"}', 'utf-8');
    writeFileSync(path.join(tmp, 'view', 'index.html'), '<main>Release Room</main>', 'utf-8');
    writeFileSync(path.join(tmp, 'data', 'refresh.mjs'), 'console.log("refresh")', 'utf-8');
    writeFileSync(path.join(tmp, 'view-history', 'snap.html'), '<main>Old</main>', 'utf-8');

    const record: SpaceRecord = {
      id: 'release-room',
      title: 'Release Room',
      status: 'active',
      viewEntry: 'view/index.html',
      dataSources: [{ id: 'daily', runner: 'refresh.mjs', schedule: '0 9 * * *', timezone: 'America/Los_Angeles' }],
      actions: [{ id: 'send', composioSlug: 'OUTLOOK_SEND_EMAIL', confirm: true }],
      originSessionId: 'sess-1',
      focusId: null,
      version: 2,
      revisions: [{ version: 1, ts: '2026-06-30T00:00:00.000Z', bytes: 16, file: 'view-history/snap.html' }],
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T01:00:00.000Z',
      recipe: 'Keep launches visible.',
    };

    indexWorkspaceRecord(record, {
      db,
      rootDir: tmp,
      eventType: 'workspace_created',
      actor: 'test',
      now: new Date('2026-06-30T02:00:00.000Z'),
    });

    assert.deepEqual(listIndexedWorkspaces(db).map((row) => row.slug), ['release-room']);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_files WHERE workspace_id = ?').get('release-room') as { n: number }).n, 4);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_revisions WHERE workspace_id = ?').get('release-room') as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspace_data_sources WHERE workspace_id = ?').get('release-room') as { n: number }).n, 1);
    const action = db.prepare('SELECT side_effect, approval_policy FROM workspace_actions WHERE workspace_id = ?').get('release-room') as { side_effect: string; approval_policy: string };
    assert.equal(action.side_effect, 'send');
    assert.equal(action.approval_policy, 'required');
    const event = db.prepare('SELECT seq, event_type FROM workspace_state_events WHERE workspace_id = ?').get('release-room') as { seq: number; event_type: string };
    assert.deepEqual(event, { seq: 1, event_type: 'workspace_created' });

    deleteWorkspaceIndex('release-room', { db });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n, 0);
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
