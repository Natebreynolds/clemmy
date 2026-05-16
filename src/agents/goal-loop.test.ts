/**
 * Run: npx tsx --test src/agents/goal-loop.test.ts
 *
 * Locks the Ralph-loop contract:
 *   - parse / persist / clear state
 *   - judge fail-OPEN (errors don't wedge progress)
 *   - judge parse-failure pause after N in a row
 *   - budget exhaustion → 'paused'
 *   - cancellation respected mid-loop
 *   - judge says done → loop stops with 'done'
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-goal-test-'));
process.env.CLEMENTINE_HOME = path.join(tmpHome, 'clementine-home');
process.env.HOME = tmpHome;

let goalMod: typeof import('./goal-loop.js');

before(async () => {
  goalMod = await import('./goal-loop.js');
});

after(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Minimal fake AgentRuntime that returns a predetermined sequence of
// responses for the judge. Each call pops one. We never use it for the
// main assistant (we pass driveAssistant explicitly).
function makeJudgeRuntime(judgeResponses: string[]): import('../runtime/provider.js').AgentRuntime {
  return {
    async run() {
      const text = judgeResponses.shift() ?? '{"done":false,"reason":"fallback"}';
      return { text };
    },
  } as unknown as import('../runtime/provider.js').AgentRuntime;
}

// ─── parseGoalCommand ─────────────────────────────────────────────

test('parseGoalCommand: bare /goal → status', () => {
  assert.deepEqual(goalMod.parseGoalCommand('/goal'), { kind: 'status' });
  assert.deepEqual(goalMod.parseGoalCommand('  /goal  '), { kind: 'status' });
});

test('parseGoalCommand: with objective → start', () => {
  assert.deepEqual(
    goalMod.parseGoalCommand('/goal audit revilllawfirm.com'),
    { kind: 'start', objective: 'audit revilllawfirm.com' },
  );
});

test('parseGoalCommand: aliases', () => {
  assert.equal(goalMod.parseGoalCommand('/goal resume')?.kind, 'resume');
  assert.equal(goalMod.parseGoalCommand('/goal clear')?.kind, 'clear');
  assert.equal(goalMod.parseGoalCommand('/goal stop')?.kind, 'clear');
  assert.equal(goalMod.parseGoalCommand('/goal status')?.kind, 'status');
});

test('parseGoalCommand: not a goal command', () => {
  assert.equal(goalMod.parseGoalCommand('hello there'), null);
  assert.equal(goalMod.parseGoalCommand('/help'), null);
});

// ─── State persistence ────────────────────────────────────────────

test('save / load / clear round-trips state per sessionId', () => {
  const sessionId = 'sess:test-roundtrip';
  goalMod.clearGoalState(sessionId);
  assert.equal(goalMod.loadGoalState(sessionId), null);
  goalMod.saveGoalState({
    sessionId,
    objective: 'something',
    status: 'pursuing',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turnsUsed: 3,
    turnsLimit: 20,
    judgeParseFailures: 0,
  });
  const loaded = goalMod.loadGoalState(sessionId);
  assert.equal(loaded?.objective, 'something');
  assert.equal(loaded?.turnsUsed, 3);
  goalMod.clearGoalState(sessionId);
  assert.equal(goalMod.loadGoalState(sessionId), null);
});

// ─── runGoalLoop ──────────────────────────────────────────────────

test('runGoalLoop: judge says done on turn 1 → status=achieved', async () => {
  const sessionId = 'sess:done-on-turn-1';
  goalMod.clearGoalState(sessionId);
  let driveCalls = 0;
  const state = await goalMod.runGoalLoop({
    sessionId,
    objective: 'small task',
    runtime: makeJudgeRuntime(['{"done":true,"reason":"already done"}']),
    driveAssistant: async () => {
      driveCalls++;
      return { text: 'I did the thing.' };
    },
  });
  assert.equal(state.status, 'achieved');
  assert.equal(state.turnsUsed, 1);
  assert.equal(driveCalls, 1);
  assert.equal(state.doneReason, 'already done');
});

test('runGoalLoop: judge fail-OPEN — broken JSON does NOT stop the loop', async () => {
  const sessionId = 'sess:judge-fail-open';
  goalMod.clearGoalState(sessionId);
  let drives = 0;
  const state = await goalMod.runGoalLoop({
    sessionId,
    objective: 'multi turn',
    turnsLimit: 3,
    runtime: makeJudgeRuntime([
      'not json at all',
      '{this is also not json',
      '{"done":true,"reason":"finally"}',
    ]),
    driveAssistant: async () => {
      drives++;
      return { text: 'turn ' + drives };
    },
  });
  assert.equal(state.status, 'achieved');
  assert.equal(drives, 3);
});

test('runGoalLoop: 3 consecutive judge parse failures → status=paused', async () => {
  const sessionId = 'sess:judge-pause';
  goalMod.clearGoalState(sessionId);
  let drives = 0;
  const state = await goalMod.runGoalLoop({
    sessionId,
    objective: 'long task',
    turnsLimit: 20,
    runtime: makeJudgeRuntime(['nope', 'still nope', 'never json']),
    driveAssistant: async () => {
      drives++;
      return { text: 'turn ' + drives };
    },
  });
  assert.equal(state.status, 'paused');
  assert.equal(state.judgeParseFailures, 3);
  assert.equal(drives, 3);
  assert.match(state.doneReason ?? '', /parse JSON/i);
});

test('runGoalLoop: budget exhausted without done → status=budget-limited', async () => {
  const sessionId = 'sess:budget-exhausted';
  goalMod.clearGoalState(sessionId);
  // Judge always says not-done.
  const state = await goalMod.runGoalLoop({
    sessionId,
    objective: 'endless',
    turnsLimit: 4,
    runtime: makeJudgeRuntime(
      Array.from({ length: 10 }, () => '{"done":false,"reason":"not yet"}'),
    ),
    driveAssistant: async () => ({ text: 'still going' }),
  });
  assert.equal(state.status, 'budget-limited');
  assert.equal(state.turnsUsed, 4);
  assert.match(state.doneReason ?? '', /budget/i);
});

test('runGoalLoop: cancellation mid-loop → status=unmet', async () => {
  const sessionId = 'sess:cancelled';
  goalMod.clearGoalState(sessionId);
  let drives = 0;
  let shouldCancel = false;
  const state = await goalMod.runGoalLoop({
    sessionId,
    objective: 'gets cut short',
    turnsLimit: 10,
    runtime: makeJudgeRuntime(
      Array.from({ length: 10 }, () => '{"done":false,"reason":"keep going"}'),
    ),
    driveAssistant: async () => {
      drives++;
      if (drives === 2) shouldCancel = true;
      return { text: 'turn ' + drives };
    },
    shouldCancel: () => shouldCancel,
  });
  assert.equal(state.status, 'unmet');
  assert.equal(drives, 2);
});

test('runGoalLoop: state persists to disk after each turn', async () => {
  const sessionId = 'sess:persistence';
  goalMod.clearGoalState(sessionId);
  await goalMod.runGoalLoop({
    sessionId,
    objective: 'persist me',
    turnsLimit: 2,
    runtime: makeJudgeRuntime([
      '{"done":false,"reason":"keep going"}',
      '{"done":true,"reason":"finished"}',
    ]),
    driveAssistant: async () => ({ text: 'work done' }),
  });
  const reloaded = goalMod.loadGoalState(sessionId);
  assert.equal(reloaded?.status, 'achieved');
  assert.equal(reloaded?.objective, 'persist me');
  assert.equal(reloaded?.turnsUsed, 2);
});

test('describeGoalState: returns sensible strings for each status', () => {
  assert.match(goalMod.describeGoalState(null), /No goal active/i);
  const base = {
    sessionId: 's',
    objective: 'x',
    startedAt: '',
    updatedAt: '',
    turnsUsed: 5,
    turnsLimit: 20,
    judgeParseFailures: 0,
  };
  assert.match(goalMod.describeGoalState({ ...base, status: 'pursuing' }), /pursuing.*5\/20/);
  assert.match(goalMod.describeGoalState({ ...base, status: 'paused' }), /paused at 5\/20/);
  assert.match(goalMod.describeGoalState({ ...base, status: 'achieved' }), /achieved/);
  assert.match(goalMod.describeGoalState({ ...base, status: 'unmet' }), /unmet/);
  assert.match(goalMod.describeGoalState({ ...base, status: 'budget-limited' }), /budget-limited/);
});

test('listActiveGoals: returns pursuing + paused goals, excludes terminal ones', () => {
  // Add four goals across distinct sessionIds; vary their status to
  // exercise both retained kinds and both terminal kinds.
  const ids = ['sess:list-1', 'sess:list-2', 'sess:list-3', 'sess:list-4'];
  for (const id of ids) goalMod.clearGoalState(id);
  goalMod.saveGoalState({
    sessionId: 'sess:list-1', objective: 'a', status: 'pursuing',
    startedAt: '', updatedAt: '', turnsUsed: 1, turnsLimit: 20, judgeParseFailures: 0,
  });
  goalMod.saveGoalState({
    sessionId: 'sess:list-2', objective: 'b', status: 'achieved',
    startedAt: '', updatedAt: '', turnsUsed: 2, turnsLimit: 20, judgeParseFailures: 0,
  });
  goalMod.saveGoalState({
    sessionId: 'sess:list-3', objective: 'c', status: 'paused',
    startedAt: '', updatedAt: '', turnsUsed: 3, turnsLimit: 20, judgeParseFailures: 0,
  });
  goalMod.saveGoalState({
    sessionId: 'sess:list-4', objective: 'd', status: 'unmet',
    startedAt: '', updatedAt: '', turnsUsed: 4, turnsLimit: 20, judgeParseFailures: 0,
  });
  const active = goalMod.listActiveGoals().filter((g) => ids.includes(g.sessionId));
  assert.equal(active.length, 2);
  assert.ok(active.some((g) => g.objective === 'a'));
  assert.ok(active.some((g) => g.objective === 'c'));
  for (const id of ids) goalMod.clearGoalState(id);
});

test('loadGoalState: forward-maps legacy status names from older on-disk files', async () => {
  // Simulate a goal state file written by an older Clementine version
  // where the status vocabulary was active/done/aborted. The loader
  // should rewrite those to pursuing/achieved/unmet so consumers see
  // a single vocabulary.
  const sessionId = 'sess:legacy-status';
  goalMod.clearGoalState(sessionId);
  // saveGoalState is typed against the new vocabulary; bypass via
  // direct file write to inject a legacy value.
  const pathMod = await import('node:path');
  const fs = await import('node:fs');
  const home = process.env.CLEMENTINE_HOME || (process.env.HOME + '/.clementine-next');
  const file = pathMod.default.join(home, 'state', 'goals', `${sessionId.replace(/[^A-Za-z0-9_.:-]+/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify({
    sessionId, objective: 'legacy', status: 'active',
    startedAt: '', updatedAt: '', turnsUsed: 1, turnsLimit: 20, judgeParseFailures: 0,
  }), 'utf-8');
  const loaded = goalMod.loadGoalState(sessionId);
  assert.equal(loaded?.status, 'pursuing', 'legacy "active" maps to "pursuing"');

  fs.writeFileSync(file, JSON.stringify({
    sessionId, objective: 'legacy', status: 'done',
    startedAt: '', updatedAt: '', turnsUsed: 1, turnsLimit: 20, judgeParseFailures: 0,
  }), 'utf-8');
  assert.equal(goalMod.loadGoalState(sessionId)?.status, 'achieved');

  fs.writeFileSync(file, JSON.stringify({
    sessionId, objective: 'legacy', status: 'aborted',
    startedAt: '', updatedAt: '', turnsUsed: 1, turnsLimit: 20, judgeParseFailures: 0,
  }), 'utf-8');
  assert.equal(goalMod.loadGoalState(sessionId)?.status, 'unmet');

  goalMod.clearGoalState(sessionId);
});
