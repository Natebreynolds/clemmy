import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const priorHome = process.env.CLEMENTINE_HOME;
const tempHome = mkdtempSync(path.join(os.tmpdir(), 'clem-continuity-v42-'));
process.env.CLEMENTINE_HOME = tempHome;
mkdirSync(path.join(tempHome, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(tempHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = priorHome;
});

test('v42 additively upgrades an existing lazy continuity table without blessing old rows', () => {
  eventlog.closeEventLog();
  const raw = new Database(eventlog.HARNESS_DB_PATH);
  eventlog.applyHarnessMigrationsThroughVersionForTests(raw, 41);
  raw.exec(`
    CREATE TABLE task_continuity_packets (
      packet_id TEXT PRIMARY KEY,
      consumed_at TEXT
    );
    INSERT INTO task_continuity_packets (packet_id, consumed_at)
      VALUES ('legacy-unsealed-packet', NULL);
  `);
  raw.close();

  const migrated = eventlog.openEventLog();
  assert.equal(
    (migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    HARNESS_SCHEMA_VERSION,
  );
  const columns = new Set(
    (migrated.prepare('PRAGMA table_info(task_continuity_packets)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const name of [
    'origin_audience_hash',
    'consumer_audience_hash',
    'resolver_version',
    'resolution_disposition',
    'resolution_selected_option',
    'resolution_active_task_input',
    'resolution_semantic_input_hash',
  ]) assert.ok(columns.has(name), name);
  assert.deepEqual(
    migrated.prepare(`
      SELECT origin_audience_hash AS originAudienceHash,
             resolver_version AS resolverVersion,
             resolution_semantic_input_hash AS semanticInputHash
        FROM task_continuity_packets
       WHERE packet_id = 'legacy-unsealed-packet'
    `).get(),
    { originAudienceHash: null, resolverVersion: null, semanticInputHash: null },
    'legacy packets stay unsealed and must fail closed in the continuity reader',
  );
});
