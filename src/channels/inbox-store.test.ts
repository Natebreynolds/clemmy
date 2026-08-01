/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-inbox npx tsx --test src/channels/inbox-store.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';

const TEST_HOME = '/tmp/clemmy-test-inbox';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const {
  MEMORY_SCHEMA_VERSION,
  migrateMemoryDatabaseHandle,
  resetMemoryDb,
  openMemoryDb,
} = await import('../memory/db.js');
// eslint-disable-next-line import/first
const {
  bindInboundSource,
  claimInbound: claimInboundRaw,
  completeInbound,
  getInbound,
  LEGACY_INBOUND_QUARANTINE_REASON,
  listInbound,
} = await import('./inbox-store.js');

type DurableClaimInput = Parameters<typeof claimInboundRaw>[0];
function claimInbound(
  input: Omit<DurableClaimInput, 'runId' | 'payloadHash'>
    & Partial<Pick<DurableClaimInput, 'runId' | 'payloadHash'>>,
) {
  return claimInboundRaw({
    ...input,
    runId: input.runId ?? `run:${input.channel}:${input.sourceMessageId}`,
    payloadHash: input.payloadHash ?? `payload:${input.channel}:${input.sourceMessageId}:${input.userId ?? ''}`,
  });
}

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
});

test('real v30 fixture quarantines unresolved legacy inbox rows while preserving terminal history', () => {
  const fixturePath = `${TEST_HOME}/inbox-v30.db`;
  rmSync(fixturePath, { force: true });
  const fixture = new Database(fixturePath);
  try {
    migrateMemoryDatabaseHandle(fixture, { targetVersion: 30 });
    const columnsBefore = (fixture.pragma('table_info(inbound_messages)') as Array<{ name: string }>)
      .map((column) => column.name);
    assert.equal(columnsBefore.includes('payload_hash'), false, 'fixture physically predates v31');
    const insert = fixture.prepare(`
      INSERT INTO inbound_messages
        (channel, source_message_id, session_id, user_id, run_id, status,
         attempts, error, received_at, claimed_at, completed_at)
      VALUES (?, ?, NULL, 'legacy-user', NULL, ?, 1, ?, ?, ?, ?)
    `);
    const now = '2026-07-30T12:00:00.000Z';
    insert.run('discord:legacy', 'claimed-old', 'claimed', null, now, now, null);
    insert.run('slack:legacy', 'failed-old', 'failed', 'old transport error', now, now, now);
    insert.run('discord:legacy', 'replied-old', 'replied', null, now, now, now);
    insert.run('slack:legacy', 'dropped-old', 'dropped', 'owner dropped it', now, now, now);

    migrateMemoryDatabaseHandle(fixture);
    assert.equal(
      (fixture.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
      MEMORY_SCHEMA_VERSION,
    );
    const rows = fixture.prepare(`
      SELECT source_message_id AS id, status, payload_hash AS payloadHash,
             source_user_seq AS sourceUserSeq, error
        FROM inbound_messages ORDER BY source_message_id
    `).all() as Array<{
      id: string;
      status: string;
      payloadHash: string | null;
      sourceUserSeq: number | null;
      error: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.deepEqual(byId.get('claimed-old'), {
      id: 'claimed-old', status: 'dropped', payloadHash: null, sourceUserSeq: null,
      error: LEGACY_INBOUND_QUARANTINE_REASON,
    });
    assert.deepEqual(byId.get('failed-old'), {
      id: 'failed-old', status: 'dropped', payloadHash: null, sourceUserSeq: null,
      error: `old transport error | ${LEGACY_INBOUND_QUARANTINE_REASON}`,
    });
    assert.equal(byId.get('replied-old')?.status, 'replied');
    assert.equal(byId.get('replied-old')?.error, null);
    assert.equal(byId.get('dropped-old')?.status, 'dropped');
    assert.equal(byId.get('dropped-old')?.error, 'owner dropped it');
    assert.deepEqual(fixture.prepare(`
      SELECT affected_rows AS affectedRows
        FROM memory_migration_audit
       WHERE migration_version = 32
         AND action = 'quarantine_legacy_unresolved_inbound'
    `).get(), { affectedRows: 2 });
  } finally {
    fixture.close();
  }
});

test('an already-opened v31 candidate database receives the v32 quarantine', () => {
  const fixturePath = `${TEST_HOME}/inbox-v31-candidate.db`;
  rmSync(fixturePath, { force: true });
  const fixture = new Database(fixturePath);
  try {
    migrateMemoryDatabaseHandle(fixture, { targetVersion: 31 });
    fixture.prepare(`
      INSERT INTO inbound_messages
        (channel, source_message_id, status, attempts, received_at, claimed_at,
         payload_hash, source_user_seq)
      VALUES ('discord:candidate', 'legacy-unsettled', 'claimed', 1, ?, ?, NULL, NULL)
    `).run('2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z');

    migrateMemoryDatabaseHandle(fixture);
    assert.deepEqual(fixture.prepare(`
      SELECT status, payload_hash AS payloadHash, source_user_seq AS sourceUserSeq, error
        FROM inbound_messages
       WHERE channel = 'discord:candidate' AND source_message_id = 'legacy-unsettled'
    `).get(), {
      status: 'dropped',
      payloadHash: null,
      sourceUserSeq: null,
      error: LEGACY_INBOUND_QUARANTINE_REASON,
    });
  } finally {
    fixture.close();
  }
});

test('first claim creates the row and tells caller to process', () => {
  const result = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm1', userId: 'u1' });
  assert.equal(result.isNew, true);
  assert.equal(result.shouldProcess, true);
  assert.equal(result.record.status, 'claimed');
  assert.equal(result.record.attempts, 1);
  assert.equal(result.record.userId, 'u1');
});

test('claim quarantines an unresolved pre-v31 row before identity backfill', () => {
  const db = openMemoryDb();
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  db.prepare(`
    INSERT INTO inbound_messages
      (channel, source_message_id, session_id, user_id, run_id, payload_hash,
       source_user_seq, status, attempts, error, received_at, claimed_at)
    VALUES ('discord:legacy-runtime', 'legacy-retry', NULL, 'legacy-user', NULL,
            NULL, NULL, 'failed', 1, 'old failure', ?, ?)
  `).run(old, old);

  const retry = claimInbound({
    channel: 'discord:legacy-runtime',
    sourceMessageId: 'legacy-retry',
    userId: 'legacy-user',
    runId: 'run-modern-redelivery',
    payloadHash: 'payload-modern-redelivery',
  });
  assert.equal(retry.isNew, false);
  assert.equal(retry.shouldProcess, false, 'legacy uncertainty never becomes dispatch authority');
  assert.equal(retry.record.status, 'dropped');
  assert.equal(retry.record.attempts, 1);
  assert.equal(retry.record.runId, undefined, 'modern run id was not backfilled');
  assert.equal(retry.record.payloadHash, undefined, 'modern payload hash was not backfilled');
  assert.equal(retry.record.sourceUserSeq, undefined);
  assert.match(retry.record.error ?? '', new RegExp(LEGACY_INBOUND_QUARANTINE_REASON));

  const again = claimInbound({
    channel: 'discord:legacy-runtime',
    sourceMessageId: 'legacy-retry',
    userId: 'legacy-user',
    runId: 'run-modern-redelivery',
    payloadHash: 'payload-modern-redelivery',
  });
  assert.equal(again.shouldProcess, false);
  assert.equal(again.record.runId, undefined);
  assert.equal(again.record.payloadHash, undefined);
});

test('claim after replied returns shouldProcess=false (idempotent)', () => {
  claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm2', runId: 'run-1' });
  completeInbound({ channel: 'discord:chan1', sourceMessageId: 'm2', status: 'replied', runId: 'run-1' });
  const second = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm2', runId: 'run-1' });
  assert.equal(second.isNew, false);
  assert.equal(second.shouldProcess, false, 'must not reprocess an already-replied message');
  assert.equal(second.record.runId, 'run-1');
});

test('claim after dropped also short-circuits', () => {
  claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm3' });
  completeInbound({ channel: 'discord:chan1', sourceMessageId: 'm3', status: 'dropped' });
  const second = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm3' });
  assert.equal(second.shouldProcess, false);
});

test('fresh v31 claimed rows with payload authority still suppress concurrency and reclaim normally', () => {
  // First claim — simulates a crash before completion.
  const first = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm4' });
  assert.equal(first.record.attempts, 1);

  // Immediate duplicate delivery in the same daemon window is treated
  // as concurrent processing and suppressed.
  const duplicate = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm4' });
  assert.equal(duplicate.shouldProcess, false, 'fresh duplicate claim should not double-run the model');
  assert.equal(duplicate.record.attempts, 1);

  // Daemon restart replay after the freshness window. The row is still
  // 'claimed' but never marked 'replied', so the retry path bumps
  // attempts and lets us recover.
  const staleClaimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  openMemoryDb()
    .prepare(
      `UPDATE inbound_messages
          SET claimed_at = ?
        WHERE channel = ? AND source_message_id = ?`,
    )
    .run(staleClaimedAt, 'discord:chan1', 'm4');

  const second = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm4' });
  assert.equal(second.shouldProcess, true, 'stale stuck claim should be retryable');
  assert.equal(second.record.attempts, 2);

  // Failed runs are also retryable.
  completeInbound({ channel: 'discord:chan1', sourceMessageId: 'm4', status: 'failed', error: 'network blip' });
  const third = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm4' });
  assert.equal(third.shouldProcess, true);
  assert.equal(third.record.attempts, 3);
});

test('different channels with same source id are distinct', () => {
  const a = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'shared' });
  const b = claimInbound({ channel: 'discord:chan2', sourceMessageId: 'shared' });
  assert.equal(a.isNew, true);
  assert.equal(b.isNew, true, 'same id on a different channel must NOT collide');
});

test('listInbound filters by status', () => {
  claimInbound({ channel: 'discord:c', sourceMessageId: 'a' });
  claimInbound({ channel: 'discord:c', sourceMessageId: 'b' });
  completeInbound({ channel: 'discord:c', sourceMessageId: 'b', status: 'replied' });
  const claimed = listInbound({ status: 'claimed' });
  const replied = listInbound({ status: 'replied' });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].sourceMessageId, 'a');
  assert.equal(replied.length, 1);
  assert.equal(replied[0].sourceMessageId, 'b');
});

test('getInbound returns undefined for unknown row', () => {
  assert.equal(getInbound('discord:c', 'never-seen'), undefined);
});

test('provider identity binds run, payload, and exact source before work', () => {
  const claimed = claimInbound({
    channel: 'discord:durable',
    sourceMessageId: 'provider-1',
    userId: 'user-1',
    runId: 'run-discord-stable',
    payloadHash: 'payload-a',
  });
  assert.equal(claimed.record.runId, 'run-discord-stable');
  assert.equal(claimed.record.payloadHash, 'payload-a');

  const bound = bindInboundSource({
    channel: 'discord:durable',
    sourceMessageId: 'provider-1',
    sessionId: 'session-stable',
    runId: 'run-discord-stable',
    sourceUserSeq: 42,
  });
  assert.equal(bound.sessionId, 'session-stable');
  assert.equal(bound.sourceUserSeq, 42);

  assert.throws(() => claimInbound({
    channel: 'discord:durable',
    sourceMessageId: 'provider-1',
    userId: 'user-1',
    runId: 'run-discord-stable',
    payloadHash: 'payload-b',
  }), /different inbound request/i);
  assert.throws(() => bindInboundSource({
    channel: 'discord:durable',
    sourceMessageId: 'provider-1',
    sessionId: 'session-stable',
    runId: 'run-discord-stable',
    sourceUserSeq: 43,
  }), /different source user event/i);
});

test('Slack channel label dedups a redelivered message ts (Events-API retry)', () => {
  // Slack retries event delivery on timeout; claimInbound is what stops the
  // duplicate from being processed twice. Same (channel, ts) → no reprocess
  // once replied.
  const first = claimInbound({ channel: 'slack:C123', sourceMessageId: '1700000000.000100', userId: 'U1' });
  assert.equal(first.isNew, true);
  assert.equal(first.shouldProcess, true);
  completeInbound({ channel: 'slack:C123', sourceMessageId: '1700000000.000100', status: 'replied' });
  const retry = claimInbound({ channel: 'slack:C123', sourceMessageId: '1700000000.000100', userId: 'U1' });
  assert.equal(retry.isNew, false);
  assert.equal(retry.shouldProcess, false, 'a redelivered Slack ts must not be reprocessed');
});
