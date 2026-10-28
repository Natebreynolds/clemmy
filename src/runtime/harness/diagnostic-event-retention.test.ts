/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/diagnostic-event-retention.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-diagnostic-events-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const log = await import('./eventlog.js');
const retention = await import('./diagnostic-event-retention.js');

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

after(() => { log.closeEventLog(); rmSync(TMP_HOME, { recursive: true, force: true }); });

test('diagnostic rows older than the window go, the transcript and referenced rows stay, and the bound holds', () => {
  const db = log.openEventLog();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO sessions (id, kind, created_at, updated_at, status, metadata_json) VALUES ('chat-a', 'chat', ?, ?, 'active', '{}')`)
    .run(daysAgo(60), daysAgo(1));
  const insert = db.prepare(`INSERT INTO events (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, 'chat-a', 1, 'system', ?, NULL, '{}', ?)`);
  // Old diagnostics of several types, one of them pinned by a pending report.
  for (let n = 0; n < 12; n++) insert.run(`transport-${n}`, 'model_transport_observed', daysAgo(45 - n));
  for (let n = 0; n < 6; n++) insert.run(`guard-${n}`, 'guardrail_tripped', daysAgo(40 - n));
  insert.run('pinned-source', 'prompt_composition', daysAgo(50));
  db.prepare(`INSERT INTO outcome_reports_pending_v1 (source_event_id, session_id, created_at, attempts) VALUES ('pinned-source', 'chat-a', ?, 0)`).run(daysAgo(50));
  // The transcript, old and new, and fresh diagnostics.
  insert.run('user-old', 'user_input_received', daysAgo(50));
  insert.run('reply-old', 'conversation_completed', daysAgo(50));
  insert.run('tool-old', 'tool_returned', daysAgo(50));
  insert.run('transport-fresh', 'model_transport_observed', daysAgo(3));
  insert.run('guard-fresh', 'guardrail_tripped', daysAgo(0.5));
  const count = (type: string) => (db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n;

  // A bound smaller than the backlog removes oldest rows first and reports that it is not caught up.
  const bounded = retention.reapStaleDiagnosticEvents(db, { nowMs: NOW, maxRows: 5 });
  assert.deepEqual(bounded, { removed: 5, pinned: 0, caughtUp: false });
  assert.equal(count('model_transport_observed'), 8);
  assert.equal(db.prepare("SELECT 1 FROM events WHERE id = 'transport-0'").get(), undefined, 'the oldest row went first');

  const rest = retention.reapStaleDiagnosticEvents(db, { nowMs: NOW });
  assert.deepEqual(rest, { removed: 13, pinned: 1, caughtUp: true });
  assert.equal(count('model_transport_observed'), 1, 'only the fresh transport row stays');
  assert.equal(count('guardrail_tripped'), 1, 'only the fresh guardrail row stays');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE id = 'pinned-source'").get(), 'a referenced row stays');
  for (const kept of ['user-old', 'reply-old', 'tool-old', 'transport-fresh', 'guard-fresh']) {
    assert.ok(db.prepare('SELECT 1 FROM events WHERE id = ?').get(kept), `${kept} stays`);
  }
  // Nothing left to do: the pinned row is reported, not retried forever.
  assert.deepEqual(retention.reapStaleDiagnosticEvents(db, { nowMs: NOW }), { removed: 0, pinned: 1, caughtUp: true });
});
