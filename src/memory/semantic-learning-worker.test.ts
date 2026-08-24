import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-terminal-learning-worker-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const memory = await import('./db.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const worker = await import('./semantic-learning-worker.js');
const { closedCanonicalJson } = await import('../shared/closed-canonical-json.js');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

after(() => {
  memory.closeMemoryDb();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

function insertUnrebuildableShard(): void {
  const db = memory.openMemoryDb();
  const now = new Date(0).toISOString();
  const digest = 'a'.repeat(64);
  db.prepare(`
    INSERT INTO memory_learning_batches
      (batch_id, session_id, source_user_seq, accepted_task_id,
       terminal_event_id, terminal_event_rowid, terminal_digest,
       member_manifest_hash, member_count, shard_count, status,
       created_at, updated_at, completed_at, last_error)
    VALUES ('batch-1', 'session-1', 1, 'task-1', 'terminal-1', 1, ?, ?, 1, 1,
            'pending', ?, ?, NULL, NULL)
  `).run(digest, digest, now, now);
  db.prepare(`
    INSERT INTO memory_learning_members
      (member_id, batch_id, ordinal, logical_tool_call_id, result_handle_id,
       result_digest, tool_name, resolved_tool, outcome_kind, effect_kind,
       disposition, source_text_digest, source_text_chars, selection_digest,
       selection_chars, resource_ref, created_at)
    VALUES ('member-1', 'batch-1', 0, 'call-1', 'missing-handle', ?,
            'read_file', NULL, 'succeeded', 'read', 'unstructured', ?, 900, ?,
            900, NULL, ?)
  `).run(digest, digest, digest, now);
  const manifestJson = closedCanonicalJson({
    version: 1,
    sources: [{ memberOrdinal: 0, start: 0, end: 900, sliceDigest: digest }],
  });
  db.prepare(`
    INSERT INTO memory_learning_shards
      (shard_id, batch_id, ordinal, manifest_json, manifest_hash,
       reflection_call_id, status, attempts, lease_token, lease_expires_at,
       next_attempt_at, last_error, created_at, updated_at, completed_at)
    VALUES ('shard-1', 'batch-1', 0, ?, ?, 'terminal-learning:shard-1',
            'pending', 0, NULL, NULL, ?, NULL, ?, ?, NULL)
  `).run(manifestJson, sha256(manifestJson), now, now, now);
}

test('durable shard backpressure retries without model calls and dead-letters without silent loss', async () => {
  memory.resetMemoryDb();
  eventlog.resetEventLog();
  insertUnrebuildableShard();

  const first = await worker.drainTerminalSemanticLearning({ requireIdle: false, shardLimit: 1 });
  assert.deepEqual({
    claimed: first.shardsClaimed,
    retried: first.shardsRetried,
    modelCalls: first.extractorInvocations,
  }, { claimed: 1, retried: 1, modelCalls: 0 });
  let row = memory.openMemoryDb().prepare(`
    SELECT status, attempts, last_error FROM memory_learning_shards WHERE shard_id = 'shard-1'
  `).get() as { status: string; attempts: number; last_error: string };
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /could not be rebuilt/);

  const session = eventlog.createSession({ id: 'busy-chat', kind: 'chat' });
  eventlog.beginRunAttempt(session.id, {});
  memory.openMemoryDb().prepare(`
    UPDATE memory_learning_shards SET next_attempt_at = ?, attempts = 3 WHERE shard_id = 'shard-1'
  `).run(new Date(0).toISOString());
  const busy = await worker.drainTerminalSemanticLearning({ requireIdle: true, shardLimit: 1 });
  assert.equal(busy.foregroundBusy, true);
  assert.equal(busy.shardsClaimed, 0);
  assert.equal(busy.extractorInvocations, 0);

  eventlog.openEventLog().prepare(`
    UPDATE run_attempts SET finished_at = ?, status = 'completed' WHERE session_id = ?
  `).run(new Date().toISOString(), session.id);
  const terminal = await worker.drainTerminalSemanticLearning({ requireIdle: true, shardLimit: 1 });
  assert.equal(terminal.shardsDeadLettered, 1);
  assert.equal(terminal.extractorInvocations, 0);
  row = memory.openMemoryDb().prepare(`
    SELECT status, attempts, last_error FROM memory_learning_shards WHERE shard_id = 'shard-1'
  `).get() as { status: string; attempts: number; last_error: string };
  assert.equal(row.status, 'dead_letter');
  assert.equal(row.attempts, 4);
  assert.match(row.last_error, /could not be rebuilt/);
});

test('restart closes a shard from its completed reflection receipt without rebuilding or extracting again', async () => {
  memory.resetMemoryDb();
  eventlog.resetEventLog();
  insertUnrebuildableShard();
  const db = memory.openMemoryDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_reflection_receipts
      (session_id, call_id, input_hash, status, attempts, first_seen_at,
       last_attempt_at, completed_at, result_json, last_error)
    VALUES ('session-1', 'terminal-learning:shard-1', ?, 'completed', 1,
            ?, ?, ?, '{}', NULL)
  `).run('b'.repeat(64), now, now, now);
  memory.closeMemoryDb();

  const replay = await worker.drainTerminalSemanticLearning({ requireIdle: false, shardLimit: 1 });
  assert.deepEqual({
    completed: replay.shardsCompleted,
    retried: replay.shardsRetried,
    modelCalls: replay.extractorInvocations,
  }, { completed: 1, retried: 0, modelCalls: 0 });
  assert.equal((memory.openMemoryDb().prepare(`
    SELECT status FROM memory_learning_shards WHERE shard_id = 'shard-1'
  `).get() as { status: string }).status, 'completed');
});
