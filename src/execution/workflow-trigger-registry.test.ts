import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  WORKFLOW_TRIGGER_SCHEMA_SQL,
  WORKFLOW_TRIGGER_SCHEMA_VERSION,
  WORKFLOW_TRIGGER_TABLES,
  renderDedupeTemplate,
  validateWorkflowTriggerDescriptor,
  workflowTriggerDedupeKey,
  workflowTriggerPayloadHash,
} from './workflow-trigger-registry.js';

test('workflow trigger schema metadata is explicit', () => {
  assert.equal(WORKFLOW_TRIGGER_SCHEMA_VERSION, 1);
  assert.deepEqual(WORKFLOW_TRIGGER_TABLES, ['workflow_triggers', 'workflow_trigger_events']);
});

test('workflow trigger schema applies and enforces trigger kind requirements', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKFLOW_TRIGGER_SCHEMA_SQL);
    const rows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    for (const table of WORKFLOW_TRIGGER_TABLES) assert.ok(names.has(table), `missing ${table}`);

    assert.throws(() => {
      db.prepare(`
        INSERT INTO workflow_triggers (id, workflow_name, kind, created_at, updated_at)
        VALUES ('bad-schedule', 'daily', 'schedule', '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z')
      `).run();
    }, /CHECK constraint failed/);

    db.prepare(`
      INSERT INTO workflow_triggers (id, workflow_name, kind, schedule, timezone, created_at, updated_at)
      VALUES ('schedule-1', 'daily', 'schedule', '0 8 * * *', 'America/Los_Angeles', '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z')
    `).run();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_triggers').get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});

test('workflow trigger events are deduped per trigger and cascade with trigger deletion', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(WORKFLOW_TRIGGER_SCHEMA_SQL);
    db.prepare(`
      INSERT INTO workflow_triggers (id, workflow_name, kind, created_at, updated_at)
      VALUES ('manual-1', 'daily', 'manual', '2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z')
    `).run();
    const insert = db.prepare(`
      INSERT INTO workflow_trigger_events (id, trigger_id, fired_at, dedupe_key, payload_hash, payload_json)
      VALUES (?, 'manual-1', '2026-06-30T00:01:00.000Z', 'same', 'hash', '{}')
    `);
    insert.run('evt-1');
    assert.throws(() => insert.run('evt-2'), /UNIQUE constraint failed/);

    db.prepare('DELETE FROM workflow_triggers WHERE id = ?').run('manual-1');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_trigger_events').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('workflowTriggerPayloadHash is stable for object key order', () => {
  assert.equal(
    workflowTriggerPayloadHash({ b: 2, a: { y: 2, x: 1 } }),
    workflowTriggerPayloadHash({ a: { x: 1, y: 2 }, b: 2 }),
  );
});

test('workflowTriggerDedupeKey uses template paths when provided', () => {
  const key = workflowTriggerDedupeKey(
    { workflowName: 'daily', kind: 'webhook', dedupeKeyTemplate: 'sf:{{ payload.account.id }}:{{payload.event}}' },
    { event: 'updated', account: { id: '001' } },
  );
  assert.equal(key, 'sf:001:updated');
});

test('workflowTriggerDedupeKey falls back to kind, workflow, and payload hash', () => {
  const payload = { event: 'updated', account: { id: '001' } };
  const key = workflowTriggerDedupeKey({ workflowName: 'daily', kind: 'system_event' }, payload);
  assert.equal(key, `system_event:daily:${workflowTriggerPayloadHash(payload)}`);
});

test('renderDedupeTemplate replaces missing paths with empty strings', () => {
  assert.equal(renderDedupeTemplate('x:{{ payload.missing.value }}:y', { ok: true }), 'x::y');
});

test('validateWorkflowTriggerDescriptor catches missing required fields', () => {
  assert.deepEqual(validateWorkflowTriggerDescriptor({ workflowName: '', kind: 'manual' }), ['workflowName is required.']);
  assert.ok(validateWorkflowTriggerDescriptor({ workflowName: 'daily', kind: 'schedule' }).includes('schedule trigger requires schedule.'));
  assert.ok(validateWorkflowTriggerDescriptor({ workflowName: 'daily', kind: 'webhook' }).includes('webhook trigger requires webhookPath.'));
  assert.ok(validateWorkflowTriggerDescriptor({ workflowName: 'daily', kind: 'system_event' }).includes('system_event trigger requires eventType.'));
  assert.deepEqual(validateWorkflowTriggerDescriptor({ workflowName: 'daily', kind: 'manual' }), []);
});
