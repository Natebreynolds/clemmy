import assert from 'node:assert/strict';
import test from 'node:test';
import { timelineBounds, timelineSpan, turnProgress, type ProgressRow } from './turn-progress.js';
import { MODEL_PHASE_ACTIVITY_ID } from './reduce-activity.js';

function row(over: Partial<ProgressRow> & Pick<ProgressRow, 'id' | 'kind' | 'status'>): ProgressRow {
  return { ...over };
}

const modelPhase = row({ id: MODEL_PHASE_ACTIVITY_ID, kind: 'event', variant: 'lifecycle', status: 'running', startedAt: 10 });

function states(p: ReturnType<typeof turnProgress>): string[] {
  return p.phases.map((phase) => `${phase.id}:${phase.state}`);
}

test('a fresh turn is thinking, with everything else ahead of it', () => {
  const p = turnProgress({ activity: [modelPhase], live: true, hasText: false });
  assert.equal(p.current, 'think');
  assert.deepEqual(states(p), ['think:current', 'work:pending', 'write:pending', 'check:pending']);
});

test('a running tool moves the turn into working and counts its steps honestly', () => {
  const p = turnProgress({
    activity: [
      row({ id: 't1', kind: 'tool', status: 'done', startedAt: 10, finishedAt: 20 }),
      row({ id: 't2', kind: 'tool', status: 'running', startedAt: 20 }),
      modelPhase,
    ],
    live: true,
    hasText: false,
  });
  assert.equal(p.current, 'work');
  assert.deepEqual(states(p), ['think:done', 'work:current', 'write:pending', 'check:pending']);
  const work = p.phases[1];
  assert.equal(work.caption, '2 steps · 1 running');
  assert.equal(work.fraction, undefined, 'no declared count means no percent');
});

test('the model thinking between two tools is still the working phase, not a rewind', () => {
  const p = turnProgress({
    activity: [row({ id: 't1', kind: 'tool', status: 'done', startedAt: 10, finishedAt: 20 }), modelPhase],
    live: true,
    hasText: false,
  });
  assert.equal(p.current, 'work');
  assert.equal(p.phases[1].caption, '1 step');
});

test('a declared batch gives the working segment a real fraction', () => {
  const p = turnProgress({
    activity: [row({ id: 'b-1', kind: 'batch', status: 'running', startedAt: 1, batch: { done: 3, total: 10, failed: 1 } })],
    live: true,
    hasText: false,
  });
  assert.equal(p.phases[1].fraction, 0.4);
  assert.equal(p.phases[1].caption, '4 of 10');
});

test('a streaming draft is the writing phase; a turn that never worked shows working as skipped', () => {
  const p = turnProgress({
    activity: [modelPhase],
    live: true,
    hasText: true,
    draft: { id: 's1', base: '', phase: 'writing' },
  });
  assert.equal(p.current, 'write');
  assert.deepEqual(states(p), ['think:done', 'work:skipped', 'write:current', 'check:pending']);
});

test('a draft under review is the checking phase', () => {
  const p = turnProgress({
    activity: [row({ id: 't1', kind: 'tool', status: 'done', startedAt: 1, finishedAt: 2 })],
    live: true,
    hasText: true,
    draft: { id: 's1', base: '', phase: 'checking' },
  });
  assert.equal(p.current, 'check');
  assert.deepEqual(states(p), ['think:done', 'work:done', 'write:done', 'check:current']);
});

test('a draft withdrawn by the reviewer goes back to writing and says so', () => {
  const p = turnProgress({
    activity: [row({ id: 'v1', kind: 'check', status: 'failed', verdict: 'rejected' })],
    live: true,
    hasText: true,
    draft: { id: 's1', base: '', phase: 'withdrawn', withdrawn: 'review' },
  });
  assert.equal(p.current, 'write');
  assert.equal(p.phases[2].caption, 'correcting');
  assert.equal(p.phases[3].state, 'pending', 'the check will run again');
  assert.equal(p.phases[3].caption, 'found issues');
});

test('a draft withdrawn for a tool call returns to working while that tool runs', () => {
  const p = turnProgress({
    activity: [row({ id: 't1', kind: 'tool', status: 'running', startedAt: 1 })],
    live: true,
    hasText: true,
    draft: { id: 's1', base: '', phase: 'withdrawn', withdrawn: 'tool_call' },
  });
  assert.equal(p.current, 'work');
});

test('a settled turn has no current phase; a passed check is named, an unreviewed one is not a pass', () => {
  const passed = turnProgress({
    activity: [
      row({ id: 't1', kind: 'tool', status: 'done', startedAt: 1, finishedAt: 2 }),
      row({ id: 'v1', kind: 'check', status: 'done', verdict: 'passed' }),
    ],
    live: false,
    hasText: true,
  });
  assert.equal(passed.current, null);
  assert.deepEqual(states(passed), ['think:done', 'work:done', 'write:done', 'check:done']);
  assert.equal(passed.phases[3].caption, 'passed');

  const unreviewed = turnProgress({
    activity: [row({ id: 'v1', kind: 'check', status: 'done', verdict: 'unreviewed' })],
    live: false,
    hasText: true,
  });
  assert.equal(unreviewed.phases[3].state, 'skipped');
  assert.equal(unreviewed.phases[3].caption, 'not checked');
});

test('timeline bounds run from the first start to now while live, and to the last settle once done', () => {
  const rows = [
    row({ id: 'a', kind: 'tool', status: 'done', startedAt: 100, finishedAt: 300 }),
    row({ id: 'b', kind: 'tool', status: 'done', startedAt: 300, finishedAt: 500 }),
  ];
  assert.deepEqual(timelineBounds(rows, true, 1000), { start: 100, end: 1000 });
  assert.deepEqual(timelineBounds(rows, false, 1000), { start: 100, end: 500 });
  assert.equal(timelineBounds([row({ id: 'x', kind: 'check', status: 'done' })], true, 5), null);
});

test('a step takes its share of the window; a running step reaches now; an instant step has no width', () => {
  const bounds = { start: 0, end: 1000 };
  assert.deepEqual(timelineSpan({ startedAt: 250, finishedAt: 500, status: 'done' }, bounds, false, 0), { left: 25, width: 25 });
  assert.deepEqual(timelineSpan({ startedAt: 800, status: 'running' }, bounds, true, 1000), { left: 80, width: 20 });
  assert.deepEqual(timelineSpan({ startedAt: 400, finishedAt: 400, status: 'done' }, bounds, false, 0), { left: 40, width: 0 });
  assert.equal(timelineSpan({ status: 'done' }, bounds, false, 0), null);
  // A settled step that never recorded a finish claims at most the window's end.
  assert.deepEqual(timelineSpan({ startedAt: 900, status: 'done' }, bounds, false, 0), { left: 90, width: 10 });
});
