import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateMemoryDatabaseHandle } from './db.js';
import { parseStandingPolicyDescriptor } from './policy-enforcement.js';

test('migration 36 backfills a v1 dispatch row into a sealed authoritative v2 descriptor', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'clemmy-policy-v36-'));
  const db = new Database(path.join(directory, 'memory.db'));
  try {
    migrateMemoryDatabaseHandle(db, { targetVersion: 35 });
    const content = 'Always call Salesforce via the local sf CLI, never via the Composio Salesforce toolkit because it is expired.';
    const now = '2026-08-27T00:00:00.000Z';
    const inserted = db.prepare(`
      INSERT INTO consolidated_facts
        (kind, content, content_hash, score, active, created_at, updated_at, importance, pinned)
      VALUES ('constraint', ?, 'fixture-policy-v1', 1, 1, ?, ?, 9, 1)
    `).run(content, now, now);
    const factId = Number(inserted.lastInsertRowid);
    // Exact legacy v28 projection that existed at the v35 boundary.
    db.prepare(`
      UPDATE memory_policies
      SET policy_type = 'hard_constraint', enforcement = 'dispatch', applies_to_json = ?
      WHERE fact_id = ?
    `).run(JSON.stringify({
      schemaVersion: 1,
      family: 'salesforce_cli_only',
      deterministic: true,
      tools: ['composio_execute_tool'],
      reason: 'legacy v1 admission descriptor',
    }), factId);

    migrateMemoryDatabaseHandle(db, { targetVersion: 36 });
    const row = db.prepare(`
      SELECT policy_type, enforcement, applies_to_json
      FROM memory_policies WHERE fact_id = ?
    `).get(factId) as { policy_type: string; enforcement: string; applies_to_json: string };
    assert.equal(row.policy_type, 'hard_constraint');
    assert.equal(row.enforcement, 'dispatch');
    const descriptor = parseStandingPolicyDescriptor(row.applies_to_json, content);
    assert.ok(descriptor, 'v36 must produce a valid source-bound sealed descriptor');
    assert.equal(descriptor?.schemaVersion, 2);
    assert.equal(descriptor?.policyClass, 'route_denial');
    assert.equal(descriptor?.directives[0]?.kind, 'deny');

    const audit = db.prepare(`
      SELECT affected_rows, detail_json FROM memory_migration_audit
      WHERE migration_version = 36 AND action = 'compile_sealed_standing_policy_v2'
    `).get() as { affected_rows: number; detail_json: string };
    assert.equal(audit.affected_rows >= 1, true);
    assert.equal(JSON.parse(audit.detail_json).dispatchPolicies >= 1, true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
