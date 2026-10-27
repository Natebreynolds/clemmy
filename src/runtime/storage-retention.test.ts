import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  runStorageRetention,
  selectExpiredRequestCopies,
  storageRetentionPolicy,
  type StorageRetentionDependencies,
  type StorageRetentionPolicy,
} from './storage-retention.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

test('the default policy keeps Clem inside 10 GB with a one-week window, and enforces it', () => {
  const policy = storageRetentionPolicy({});
  assert.equal(policy.mode, 'enforce');
  assert.equal(storageRetentionPolicy({ CLEMMY_STORAGE_RETENTION: 'report' }).mode, 'report');
  assert.equal(storageRetentionPolicy({ CLEMMY_STORAGE_RETENTION: 'off' }).mode, 'off');
  assert.equal(policy.budgetBytes, 10 * 1024 ** 3);
  assert.equal(policy.scratchDays, 7);
  assert.equal(storageRetentionPolicy({ CLEMMY_STORAGE_RETENTION: 'enforce' }).mode, 'enforce');
  assert.equal(storageRetentionPolicy({ CLEMMY_STORAGE_BUDGET_GB: '0' }).budgetBytes, 1024 ** 3, 'the budget has a floor');
});

test('request copies expire after the window, except a running task\'s and the newest few of a recent conversation', () => {
  const row = (sessionId: string, sourceUserSeq: number, requestOrdinal: number, createdAt: string) => ({
    sessionId, sourceUserSeq, requestOrdinal, payloadId: `authority-payload:${sessionId}-${sourceUserSeq}-${requestOrdinal}`, createdAt });
  const rows = [
    row('recent', 1, 1, daysAgo(40)), row('recent', 2, 1, daysAgo(20)), row('recent', 3, 1, daysAgo(10)), row('recent', 4, 1, daysAgo(9)), row('recent', 5, 1, daysAgo(1)),
    row('stale', 1, 1, daysAgo(60)), row('stale', 2, 1, daysAgo(50)),
    row('running', 1, 1, daysAgo(30)),
  ];
  const expired = selectExpiredRequestCopies(rows, {
    nowMs: NOW, scratchDays: 7, recentConversationDays: 30, keepPerConversation: 3,
    conversationUpdatedAt: new Map([['recent', daysAgo(1)], ['stale', daysAgo(45)], ['running', daysAgo(0)]]),
    liveConversations: new Set(['running']),
  });
  assert.deepEqual(expired.sort(), [
    'authority-payload:recent-1-1', 'authority-payload:recent-2-1',
    'authority-payload:stale-1-1', 'authority-payload:stale-2-1',
  ].sort(), 'inside the window: kept; newest three of a recent conversation: kept; a running task: kept; an old conversation: all past the window go');
});

function harness(input: { footprint: number[]; files: Array<{ id: string; createdAt: string; bytes: number }>; distillFails?: boolean }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-storage-retention-'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE model_request_provenance (session_id TEXT, source_user_seq INTEGER, request_ordinal INTEGER, payload_id TEXT, created_at TEXT);
    CREATE TABLE sessions (id TEXT, updated_at TEXT); CREATE TABLE run_attempts (session_id TEXT, finished_at TEXT);
    INSERT INTO sessions VALUES ('old', '${daysAgo(60)}');`);
  input.files.forEach((file, index) => {
    db.prepare('INSERT INTO model_request_provenance VALUES (?, ?, 1, ?, ?)').run('old', index + 1, `authority-payload:${file.id}`, file.createdAt);
    writeFileSync(path.join(dir, `${file.id}.sealed.json`), 'x'.repeat(file.bytes));
  });
  const calls: string[] = [];
  let footprintCall = 0;
  const deps: StorageRetentionDependencies = {
    db: () => db,
    payloadFilePath: (id) => path.join(dir, `${id.slice('authority-payload:'.length)}.sealed.json`),
    reclaimOrphans: () => { calls.push('orphans'); return { deletedPayloadFiles: 2 }; },
    distillToolResults: () => { calls.push('distill'); if (input.distillFails) throw new Error('distiller down'); },
    reapToolResults: (days) => { calls.push(`reap:${days}`); return 5; },
    footprint: async () => ({ totalBytes: input.footprint[Math.min(footprintCall++, input.footprint.length - 1)]!, complete: true }),
    prunePythonToolCache: async () => { calls.push('uv'); return { pruned: true }; },
    yieldTurn: async () => {},
    now: () => NOW,
    reportFile: path.join(dir, 'report.json'),
  };
  return { dir, deps, calls };
}

const policy = (mode: StorageRetentionPolicy['mode'], budgetBytes: number): StorageRetentionPolicy =>
  ({ mode, budgetBytes, scratchDays: 7, recentConversationDays: 30, keepRequestCopiesPerConversation: 3 });

test('report mode counts what would go and deletes nothing', async () => {
  const { dir, deps, calls } = harness({ footprint: [1_000], files: [{ id: 'a', createdAt: daysAgo(20), bytes: 300 }, { id: 'b', createdAt: daysAgo(2), bytes: 100 }] });
  const report = await runStorageRetention(policy('report', 10_000), deps);
  assert.equal(report.requestCopies.eligible, 1);
  assert.equal(report.requestCopies.eligibleBytes, 300);
  assert.equal(report.requestCopies.removed, 0);
  assert.ok(existsSync(path.join(dir, 'a.sealed.json')));
  assert.deepEqual(calls, [], 'no distill, no reap, no orphan or cache work in report mode');
  assert.equal(report.footprintAfter, 700);
});

test('enforce mode distills before deleting tool results, removes expired copies, and tightens the window only while over budget', async () => {
  const { dir, deps, calls } = harness({
    footprint: [1_000, 400],
    files: [{ id: 'old', createdAt: daysAgo(20), bytes: 300 }, { id: 'mid', createdAt: daysAgo(5), bytes: 200 }, { id: 'new', createdAt: daysAgo(0.5), bytes: 100 }],
  });
  const report = await runStorageRetention(policy('enforce', 600), deps);
  assert.equal(existsSync(path.join(dir, 'old.sealed.json')), false);
  assert.equal(existsSync(path.join(dir, 'mid.sealed.json')), false, 'over budget after the week window: the three-day window removes it');
  assert.equal(existsSync(path.join(dir, 'new.sealed.json')), true, 'under budget again: the one-day window never runs');
  assert.deepEqual(calls.filter((call) => call === 'distill' || call.startsWith('reap')), ['distill', 'reap:7', 'distill', 'reap:3']);
  assert.equal(report.requestCopies.removedBytes, 500);
  assert.equal(report.scratchDays, 3);
  assert.ok(calls.includes('orphans') && calls.includes('uv'));
  assert.equal(report.footprintAfter, 400);
  assert.equal(report.overBudgetBytes, 0);
});

test('when distilling fails, tool results are kept', async () => {
  const { deps, calls } = harness({ footprint: [100], files: [], distillFails: true });
  const report = await runStorageRetention(policy('enforce', 10_000), deps);
  assert.equal(calls.some((call) => call.startsWith('reap')), false);
  assert.equal(report.toolResults.distilled, false);
  assert.match(report.notes.join(' '), /were kept/);
});
