/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-inbox npx tsx --test src/channels/inbox-store.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-inbox';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('../memory/db.js');
// eslint-disable-next-line import/first
const { claimInbound, completeInbound, getInbound, listInbound } = await import('./inbox-store.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  resetMemoryDb();
  openMemoryDb();
});

test('first claim creates the row and tells caller to process', () => {
  const result = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm1', userId: 'u1' });
  assert.equal(result.isNew, true);
  assert.equal(result.shouldProcess, true);
  assert.equal(result.record.status, 'claimed');
  assert.equal(result.record.attempts, 1);
  assert.equal(result.record.userId, 'u1');
});

test('claim after replied returns shouldProcess=false (idempotent)', () => {
  claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm2' });
  completeInbound({ channel: 'discord:chan1', sourceMessageId: 'm2', status: 'replied', runId: 'run-1' });
  const second = claimInbound({ channel: 'discord:chan1', sourceMessageId: 'm2' });
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

test('fresh duplicate claimed message is suppressed, stale claimed/failed rows retry', () => {
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
