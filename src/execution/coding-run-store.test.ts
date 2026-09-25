/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/coding-run-store.test.ts
 *
 * Pins the coding-run store as the durable owner: idempotent admission, a
 * lease only one generation holds, resumption after an owner dies, a stop
 * switch any process can throw, an immutable settlement written with its
 * report-back row, and usage snapshots that only the lease holder moves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'coding-run-store-'));

const store = await import('./coding-run-store.js');

function admit(overrides: Partial<Parameters<typeof store.admitCodingRun>[0]> = {}) {
  return store.admitCodingRun({
    agent: 'claude',
    projectName: 'fixture',
    projectPath: '/tmp/fixture',
    worktreePath: '/tmp/worktrees/fixture/run',
    branch: 'clem/add-greeting-abcd1234',
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    objective: 'Add a greeting function',
    brief: 'Add greet(name) to src/greet.ts and a test.',
    acceptance: ['greet("Ada") returns "Hello, Ada!"'],
    testCommand: 'npm test',
    originSessionId: 'sess-origin-1',
    originSourceUserSeq: 7,
    ...overrides,
  });
}

test('admission is idempotent on its key and opens a coding session id', () => {
  const first = admit({ admissionKey: 'sess-origin-1:7:call-1' });
  const replay = admit({ admissionKey: 'sess-origin-1:7:call-1' });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.run.runId, first.run.runId);
  assert.equal(first.run.sessionId, `coding:${first.run.runId}`);
  assert.equal(store.runIdFromCodingSession(first.run.sessionId), first.run.runId);
  assert.equal(first.run.state, 'admitted');
  assert.equal(first.run.finishLine, 'local_branch');
  assert.deepEqual(first.run.acceptance, ['greet("Ada") returns "Hello, Ada!"']);
  assert.ok(Date.parse(first.run.deadlineAt) - Date.parse(first.run.createdAt) >= store.CODING_RUN_DEADLINE_MS - 1_000);
});

test('one generation holds the lease; a dead owner\'s run is claimed again as a resume', () => {
  const { run } = admit({ admissionKey: 'lease-test' });
  const now = Date.now();
  let claimed = store.claimNextCodingRun('owner-a', 60_000, now);
  while (claimed && claimed.runId !== run.runId) claimed = store.claimNextCodingRun('owner-a', 60_000, now);
  assert.ok(claimed);
  assert.equal(claimed.state, 'running');
  assert.equal(claimed.resumeCount, 0);

  // Another owner cannot take a live lease or write progress under it.
  assert.equal(store.renewCodingRunLease(run.runId, 'owner-b', 60_000, now), false);
  assert.equal(store.updateCodingRunProgress(run.runId, 'owner-b', { round: 2 }), false);
  assert.equal(store.renewCodingRunLease(run.runId, 'owner-a', 60_000, now), true);

  // Owner A dies: after its lease lapses, B claims the run as a resume.
  const later = now + 120_000;
  let reclaimed = store.claimNextCodingRun('owner-b', 60_000, later);
  while (reclaimed && reclaimed.runId !== run.runId) reclaimed = store.claimNextCodingRun('owner-b', 60_000, later);
  assert.ok(reclaimed);
  assert.equal(reclaimed.leaseOwner, 'owner-b');
  assert.equal(reclaimed.resumeCount, 1);
  assert.equal(store.renewCodingRunLease(run.runId, 'owner-a', 60_000, later), false);
});

test('a released run is resumed by the next claim', () => {
  const { run } = admit({ admissionKey: 'release-test' });
  let claimed = store.claimNextCodingRun('owner-c', 60_000);
  while (claimed && claimed.runId !== run.runId) claimed = store.claimNextCodingRun('owner-c', 60_000);
  assert.ok(claimed);
  assert.equal(store.releaseCodingRunForResume(run.runId, 'owner-c'), true);
  assert.equal(store.getCodingRun(run.runId)?.state, 'resuming');
  let next = store.claimNextCodingRun('owner-d', 60_000);
  while (next && next.runId !== run.runId) next = store.claimNextCodingRun('owner-d', 60_000);
  assert.equal(next?.resumeCount, 1);
});

test('the stop switch is a request any process can write, and origin cascades find every open run', () => {
  const a = admit({ originSessionId: 'sess-stop-origin', admissionKey: 'stop-a' }).run;
  const b = admit({ originSessionId: 'sess-stop-origin', admissionKey: 'stop-b' }).run;
  admit({ originSessionId: 'sess-someone-else', admissionKey: 'stop-c' });
  assert.equal(store.isCodingRunStopRequested(a.runId), false);
  const stopped = store.requestCodingRunStopsForOrigin('sess-stop-origin', 'Stopped from chat');
  assert.deepEqual(stopped.map((run) => run.runId).sort(), [a.runId, b.runId].sort());
  assert.equal(store.isCodingRunStopRequested(a.runId), true);
  assert.equal(store.getCodingRun(a.runId)?.stopReason, 'Stopped from chat');
  // The first reason stands.
  store.requestCodingRunStop(a.runId, 'second reason');
  assert.equal(store.getCodingRun(a.runId)?.stopReason, 'Stopped from chat');
});

test('only the lease holder settles; the settlement is immutable and queues its report-back', () => {
  const { run } = admit({ admissionKey: 'settle-test', originSessionId: 'sess-settle-origin' });
  let claimed = store.claimNextCodingRun('owner-e', 60_000);
  while (claimed && claimed.runId !== run.runId) claimed = store.claimNextCodingRun('owner-e', 60_000);
  assert.ok(claimed);
  assert.equal(store.settleCodingRun(run.runId, 'owner-f', { outcome: 'failed', reason: 'not mine' }), null);

  const settlement = store.settleCodingRun(run.runId, 'owner-e', {
    outcome: 'completed_verified',
    reason: 'Tests pass and the greeting works.',
    headCommit: 'b'.repeat(40),
    commits: [{ sha: 'b'.repeat(40), subject: 'Add greet()' }],
    diffStat: { filesChanged: 2, insertions: 20, deletions: 0, files: ['src/greet.ts', 'src/greet.test.ts'] },
    testCommand: 'npm test',
    testExitCode: 0,
    verdict: 'pass',
  });
  assert.ok(settlement);
  assert.equal(settlement.outcome, 'completed_verified');
  assert.deepEqual(settlement.commits, [{ sha: 'b'.repeat(40), subject: 'Add greet()' }]);
  assert.equal(store.getCodingRun(run.runId)?.state, 'settled');
  assert.equal(store.settleCodingRun(run.runId, 'owner-e', { outcome: 'failed', reason: 'again' }), null);

  const pending = store.listPendingCodingRunReportBacks().filter((row) => row.runId === run.runId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.originSessionId, 'sess-settle-origin');
  assert.equal(store.markCodingRunReportBackDelivered(run.runId), true);
  assert.equal(store.markCodingRunReportBackDelivered(run.runId), false);
  assert.equal(store.listPendingCodingRunReportBacks().some((row) => row.runId === run.runId), false);
  // A settled run is never claimed again.
  assert.equal(store.requestCodingRunStop(run.runId, 'late')?.stopRequestedAt, null);
});

test('usage snapshots move only under the lease and survive a reload', () => {
  const { run } = admit({ admissionKey: 'usage-test' });
  let claimed = store.claimNextCodingRun('owner-g', 60_000);
  while (claimed && claimed.runId !== run.runId) claimed = store.claimNextCodingRun('owner-g', 60_000);
  const snapshot = { 'claude-sonnet': { inputTokens: 10, cachedInputTokens: 200, cacheCreationInputTokens: 30, outputTokens: 40 } };
  assert.equal(store.recordCodingRunUsageSnapshot(run.runId, 'owner-other', snapshot), false);
  assert.equal(store.recordCodingRunUsageSnapshot(run.runId, 'owner-g', snapshot), true);
  store._closeCodingRunStoreForTests();
  assert.deepEqual(store.getCodingRun(run.runId)?.usageRecorded, snapshot);
});
