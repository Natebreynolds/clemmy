/**
 * Run: npx tsx --test src/dashboard/activity-parity-restart.test.ts
 *
 * One durable state, three surfaces, and a restart in the middle.
 *
 * Desktop reads the projection through the console endpoint, Slack App Home and
 * Discord status read it through the shared snapshot, and the channel message
 * lane projects its own entry from the same stores. If any of them kept private
 * state — a folded event stream, a client-side staleness rule, a process
 * counter — a daemon restart would leave them disagreeing about the same run.
 * These tests close every store and rebuild from disk to prove none of them do.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-activity-parity-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(testHome, 'state'), { recursive: true });

const { projectActivitySnapshot, shouldSurfaceInWorkingNow } = await import('./activity-projection.js');
const { buildActivitySnapshot } = await import('../shared/activity-snapshot.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { __test__ } = await import('../channels/discord-harness.js');
const {
  claimRunAttemptLease,
  closeEventLog,
  createSession,
  finishRunAttempt,
} = await import('../runtime/harness/eventlog.js');
const bg = await import('../execution/background-tasks.js');

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A long-running chat turn under a held lease, plus detached work. */
function seedDurableWork(): { sessionId: string; attemptId: string; taskId: string } {
  const session = createSession({ kind: 'chat', channel: 'discord', title: 'Pipeline review' });
  const claim = claimRunAttemptLease({
    sessionId: session.id,
    runId: 'parity-run',
    ownerId: 'daemon-under-test',
    leaseMs: 30 * 60_000,
    nowMs: Date.now() - 5 * 60_000,
  });
  const task = bg.createBackgroundTask({ title: 'Segment the list', prompt: 'segment', source: 'discord' });
  bg.markBackgroundTaskRunning(task.id);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'parity-wf.json'), JSON.stringify({
    id: 'parity-wf', workflow: 'Morning Digest', status: 'running', source: 'cron',
    createdAt: '2026-08-04T10:00:00.000Z', startedAt: '2026-08-04T10:00:01.000Z',
  }), 'utf-8');
  return { sessionId: session.id, attemptId: claim.attempt!.attemptId, taskId: task.id };
}

const seeded = seedDurableWork();

test('desktop and the channel surfaces describe the same run identically', () => {
  const observedAt = new Date().toISOString();
  const desktop = projectActivitySnapshot({ observedAt }).entries;
  const chat = desktop.find((entry) => entry.sessionId === seeded.sessionId)!;
  assert.ok(chat, 'the desktop projection lost the live chat run');

  // Slack App Home / Discord status read the shared snapshot, which is the same
  // projection behind a different shape.
  const shared = buildActivitySnapshot(new Date(observedAt));
  const sharedRow = shared.runningNow.find((row) => row.sessionId === seeded.sessionId);
  assert.ok(sharedRow, 'the channel surfaces lost a run the desktop shows');
  assert.equal(sharedRow?.title, chat.headline, 'the two surfaces name the same run differently');
  assert.equal(sharedRow?.kind, 'discord', 'the row lost the channel it belongs to');

  const sharedTask = shared.runningNow.find((row) => row.id === seeded.taskId);
  assert.ok(sharedTask, 'detached work must be visible to the channel surfaces immediately');
});

test('an ordinary foreground turn stays in the conversation, on every surface', () => {
  // A turn that just started belongs in the chat, not in a panel that implies
  // work the user has walked away from. The gate is the server's, so the notch
  // and App Home inherit it rather than each re-deciding.
  const fresh = createSession({ kind: 'chat', channel: 'desktop', title: 'Quick question' });
  claimRunAttemptLease({
    sessionId: fresh.id,
    runId: 'parity-fresh',
    ownerId: 'daemon-under-test',
    leaseMs: 10 * 60_000,
  });

  const entry = projectActivitySnapshot().entries.find((row) => row.sessionId === fresh.id)!;
  assert.ok(entry, 'the projection lost a live foreground turn');
  assert.equal(entry.liveness, 'live', 'a leased turn is still live — it is just not panel work');
  assert.equal(shouldSurfaceInWorkingNow(entry, Date.now()), false,
    'an ordinary foreground turn opened a Working Now row');

  const shared = buildActivitySnapshot().runningNow.find((row) => row.sessionId === fresh.id);
  assert.equal(shared, undefined,
    'the notch and Slack App Home surfaced an ordinary chat turn as detached work');
});

test('a held lease reads live on every surface; quiet time is not death', () => {
  const entries = projectActivitySnapshot().entries;
  const chat = entries.find((entry) => entry.sessionId === seeded.sessionId)!;
  assert.equal(chat.liveness, 'live', 'a five-minute-quiet leased run read as dead');
  assert.equal(chat.owner, 'daemon-under-test', 'the durable owner is not carried');
  assert.equal(chat.needsAttention, false);
  assert.equal(shouldSurfaceInWorkingNow(chat, Date.now()), true,
    'a long-running turn belongs in Working Now');
});

test('every surface reconstructs identically after a daemon restart', () => {
  const observedAt = '2026-08-04T12:00:00.000Z';
  const before = projectActivitySnapshot({ observedAt });
  const sharedBefore = buildActivitySnapshot(new Date(observedAt)).runningNow;

  // The restart: drop every open handle and rebuild from disk alone.
  closeEventLog();

  const after = projectActivitySnapshot({ observedAt });
  const sharedAfter = buildActivitySnapshot(new Date(observedAt)).runningNow;

  assert.deepEqual(after.entries, before.entries,
    'the desktop projection depends on process state, not durable truth');
  assert.deepEqual(sharedAfter, sharedBefore,
    'the channel surfaces depend on process state, not durable truth');
});

test('the channel message lane reconstructs one kickoff and one final across a restart', () => {
  const state = {
    summary: '', status: 'starting', done: false, toolsCalled: [] as string[], toolCount: 0,
  };
  const laneBefore = __test__.createChannelProgressLane({
    sessionId: seeded.sessionId,
    attemptId: seeded.attemptId,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const t0 = Date.parse('2026-08-04T12:00:00.000Z');
  assert.equal(laneBefore.milestone(state, t0).action, 'kickoff');

  // A restart mid-turn: the process state is gone, the stores are not.
  closeEventLog();
  const laneAfter = __test__.createChannelProgressLane({
    sessionId: seeded.sessionId,
    attemptId: seeded.attemptId,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const resumed = laneAfter.milestone(state, t0 + 1_000);
  assert.equal(resumed.action, 'kickoff',
    'a resumed lane must re-establish the message it owns, from the same projection');
  assert.equal(resumed.action === 'kickoff' && resumed.text, 'Thinking it through');

  // And the settled run is settled for the lane too, whichever process asks.
  finishRunAttempt({ sessionId: seeded.sessionId, attemptId: seeded.attemptId }, 'completed');
  closeEventLog();
  const laneSettled = __test__.createChannelProgressLane({
    sessionId: seeded.sessionId,
    attemptId: seeded.attemptId,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  assert.equal(laneSettled.milestone(state, t0 + 2_000).action, 'none',
    'a settled run still accepted progress edits after a restart');

  // Desktop agrees: the same durable settle removes it from Working Now.
  const chat = projectActivitySnapshot().entries.find((entry) => entry.sessionId === seeded.sessionId)!;
  assert.equal(chat.terminal?.status, 'completed');
  assert.equal(shouldSurfaceInWorkingNow(chat, Date.now()), false,
    'a settled run stayed in Working Now');
  const shared = buildActivitySnapshot().runningNow.find((row) => row.sessionId === seeded.sessionId);
  assert.equal(shared, undefined, 'the channel surfaces still show a settled run as running');
});
