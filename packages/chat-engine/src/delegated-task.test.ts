/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/delegated-task.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  delegatedTaskCard, delegatedTaskChosenBy, delegatedTaskCorrection, delegatedTaskCorrections, delegatedTaskFollowUps,
  delegatedTaskFollowsLine, delegatedTaskOpen, delegatedTaskOwner, orderDelegatedTasks, type DelegatedTask,
} from './delegated-task.js';

function task(patch: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    taskId: 'bg-1',
    title: 'Draft the weekly briefing',
    status: 'running',
    phase: 'working',
    owner: { agentId: 'sales-assistant', agentName: 'Sales Assistant', chosenBy: 'owner' },
    project: { id: 'prj_1', name: 'Weekly Sales' },
    requestVersion: 1,
    revisions: [],
    correctionPending: false,
    artifactDestination: null,
    question: null,
    approvalId: null,
    resultPreview: null,
    resultPath: null,
    error: null,
    originSessionId: 'chat-1',
    runSessionId: 'background:bg-1',
    followsTaskId: null,
    createdAt: '2026-09-29T09:00:00.000Z',
    startedAt: '2026-09-29T09:00:05.000Z',
    completedAt: null,
    updatedAt: '2026-09-29T09:01:00.000Z',
    controls: { canSteer: true, canStop: true, canResume: false, canAnswer: false },
    ...patch,
  };
}

test('the card names the owner and the project, never always Clem', () => {
  const card = delegatedTaskCard(task());
  assert.deepEqual([card.owner, card.project, card.title], ['Sales Assistant', 'Weekly Sales', 'Draft the weekly briefing']);
  assert.deepEqual(card.phase, { label: 'Working', tone: 'live', settled: false });

  const kept = delegatedTaskCard(task({ owner: { agentId: null, agentName: null, chosenBy: null }, project: null }));
  assert.deepEqual([kept.owner, kept.project], ['Clem', null]);
  assert.equal(delegatedTaskOwner(task({ owner: { agentId: 'x', agentName: '  ', chosenBy: null } })), 'Clem');
});

test('every phase has plain words, and an unknown one is never called finished', () => {
  const words = (phase: DelegatedTask['phase']) => delegatedTaskCard(task({ phase })).phase.label;
  assert.deepEqual(
    (['waiting_to_start', 'working', 'stopping', 'needs_you', 'paused', 'finished', 'stopped', 'failed'] as const).map(words),
    ['Waiting to start', 'Working', 'Stopping', 'Waiting on you', 'Paused', 'Finished', 'Stopped', 'Did not finish'],
  );
  const unknown = delegatedTaskCard(task({ phase: 'teleported' as DelegatedTask['phase'] }));
  assert.deepEqual(unknown.phase, { label: 'Paused', tone: 'warning', settled: false });
  assert.equal(delegatedTaskOpen(task({ phase: 'paused' })), true);
  assert.equal(delegatedTaskOpen(task({ phase: 'finished' })), false);
  assert.equal(delegatedTaskOpen(task({ phase: 'stopped' })), false);
  assert.equal(delegatedTaskOpen(task({ phase: 'failed' })), false);
});

test('the request version shows only above 1, and a pending correction says when it lands', () => {
  assert.equal(delegatedTaskCard(task()).request, null);
  assert.equal(delegatedTaskCard(task({ requestVersion: 3 })).request, 'Request v3');
  assert.equal(delegatedTaskCard(task()).correction, null);
  assert.equal(delegatedTaskCard(task({ correctionPending: true })).correction, 'Your correction will be applied at its next step.');
  assert.equal(delegatedTaskCard(task({ correctionPending: true, phase: 'finished' })).correction, null, 'nothing is pending on work that ended');
});

test('a question shows only while the task waits on it, and Answer only when it may be answered', () => {
  const waiting = delegatedTaskCard(task({
    phase: 'needs_you',
    question: { id: 'q1', text: ' Which region? ', options: ['West', '', 'East'] },
    controls: { canSteer: true, canStop: true, canResume: false, canAnswer: true },
  }));
  assert.deepEqual(waiting.question, { text: 'Which region?', options: ['West', 'East'] });
  assert.equal(waiting.controls.answer, true);

  const stale = delegatedTaskCard(task({ phase: 'working', question: { id: 'q1', text: 'Which region?', options: [] } }));
  assert.equal(stale.question, null);

  const approval = delegatedTaskCard(task({ phase: 'needs_you', approvalId: 'apr-1', controls: { canSteer: true, canStop: true, canResume: false, canAnswer: true } }));
  assert.equal(approval.approvalId, 'apr-1');
  assert.equal(approval.controls.answer, false, 'there is no question to answer');
});

test('the result opens only on finished work; the reason only on work that did not finish', () => {
  const long = `${'The briefing covers the week. '.repeat(30)}end`;
  const done = delegatedTaskCard(task({ phase: 'finished', resultPreview: long, controls: { canSteer: false, canStop: false, canResume: false, canAnswer: false } }));
  assert.ok(done.result && done.result.length <= 361 && done.result.endsWith('…'));
  assert.equal(done.problem, null);
  assert.deepEqual(done.controls, { steer: false, stop: false, resume: false, answer: false });

  assert.equal(delegatedTaskCard(task({ phase: 'working', resultPreview: 'partial' })).result, null, 'running work has no result');
  const failed = delegatedTaskCard(task({ phase: 'failed', error: 'The reporting account is not connected.', controls: { canSteer: false, canStop: false, canResume: true, canAnswer: false } }));
  assert.equal(failed.problem, 'The reporting account is not connected.');
  assert.equal(failed.controls.resume, true);
});

test('controls follow the task view and nothing else', () => {
  const none = delegatedTaskCard(task({ controls: { canSteer: false, canStop: false, canResume: false, canAnswer: false } }));
  assert.deepEqual(none.controls, { steer: false, stop: false, resume: false, answer: false });
  const missing = delegatedTaskCard({ ...task(), controls: undefined as unknown as DelegatedTask['controls'] });
  assert.deepEqual(missing.controls, { steer: false, stop: false, resume: false, answer: false });
});

test('corrections read newest first, and who chose the owner is said in words', () => {
  const corrected = task({
    revisions: [
      { version: 2, instruction: 'Focus on this week.', evidencePolicy: 'revalidate', queuedAt: '2026-09-29T09:02:00.000Z', applied: true },
      { version: 3, instruction: 'Exclude unqualified leads.', evidencePolicy: 'revalidate', queuedAt: '2026-09-29T09:03:00.000Z', applied: false },
    ],
  });
  assert.deepEqual(delegatedTaskCorrections(corrected), [
    { label: 'Request v3', instruction: 'Exclude unqualified leads.', applied: false },
    { label: 'Request v2', instruction: 'Focus on this week.', applied: true },
  ]);
  assert.equal(delegatedTaskChosenBy(task()), 'You chose who does this');
  assert.equal(delegatedTaskChosenBy(task({ owner: { agentId: 'a', agentName: 'A', chosenBy: 'router' } })), 'Matched to the agent responsible in this project');
  assert.equal(delegatedTaskChosenBy(task({ owner: { agentId: null, agentName: null, chosenBy: null } })), null);
});

test('what waits on the owner leads, then what is moving, then what ended', () => {
  const ordered = orderDelegatedTasks([
    task({ taskId: 'done', phase: 'finished', updatedAt: '2026-09-29T12:00:00.000Z' }),
    task({ taskId: 'old-run', phase: 'working', updatedAt: '2026-09-29T08:00:00.000Z' }),
    task({ taskId: 'ask', phase: 'needs_you', updatedAt: '2026-09-29T07:00:00.000Z' }),
    task({ taskId: 'new-run', phase: 'paused', updatedAt: '2026-09-29T10:00:00.000Z' }),
  ]);
  assert.deepEqual(ordered.map((row) => row.taskId), ['ask', 'new-run', 'old-run', 'done']);
});

test('open work is steered; ended work is corrected by a new task, and stays ended', () => {
  const open = delegatedTaskCard(task());
  assert.deepEqual([open.steer.control, open.steer.startsNewTask], ['Steer', false]);
  assert.match(open.steer.note, /same task continues/);

  const ended = delegatedTaskCard(task({ phase: 'finished', controls: { canSteer: true, canStop: false, canResume: false, canAnswer: false } }));
  assert.deepEqual([ended.steer.control, ended.steer.startsNewTask, ended.controls.steer], ['Correct this', true, true]);
  assert.equal(ended.steer.note, 'This task has finished, so your correction starts a new task for Sales Assistant that follows it.');
  assert.deepEqual(ended.phase, { label: 'Finished', tone: 'success', settled: true }, 'a correction never makes ended work look running');

  // Stopped or failed before finishing: the same task takes the correction and resumes.
  for (const phase of ['stopped', 'failed'] as const) {
    const cut = delegatedTaskCard(task({ phase, controls: { canSteer: true, canStop: false, canResume: true, canAnswer: false } }));
    assert.deepEqual([cut.steer.control, cut.steer.startsNewTask], ['Correct and resume', false]);
    assert.match(cut.steer.note, /resumes where it was with your correction/);
  }
});

test('a steer answer says whether the task was revised or followed', () => {
  const revised = delegatedTaskCorrection({ task: task({ requestVersion: 2 }), applied: 'revised' });
  assert.equal(revised.applied, 'revised');
  const older = delegatedTaskCorrection({ task: task() });
  assert.equal(older.applied, 'revised', 'an answer with the task alone is a revision');

  const finished = task({ taskId: 'bg-1', phase: 'finished' });
  const next = task({ taskId: 'bg-2', followsTaskId: 'bg-1', phase: 'waiting_to_start' });
  const followed = delegatedTaskCorrection({ task: next, applied: 'followed', follows: finished });
  assert.deepEqual([followed.applied, followed.task.taskId, followed.applied === 'followed' && followed.follows?.taskId], ['followed', 'bg-2', 'bg-1']);
});

test('a task that follows another says which, and the ended one names what followed it', () => {
  const finished = task({ taskId: 'bg-1', title: 'Draft the weekly briefing', phase: 'finished' });
  const next = task({ taskId: 'bg-2', followsTaskId: 'bg-1', updatedAt: '2026-09-29T11:00:00.000Z' });
  const later = task({ taskId: 'bg-3', followsTaskId: 'bg-1', updatedAt: '2026-09-29T12:00:00.000Z' });
  assert.equal(delegatedTaskFollowsLine(next, [finished, next]), 'Follows “Draft the weekly briefing” with your correction');
  assert.equal(delegatedTaskFollowsLine(next, []), 'Follows a finished task with your correction');
  assert.equal(delegatedTaskFollowsLine(finished, [finished, next]), null);
  assert.equal(delegatedTaskCard(next).followsTaskId, 'bg-1');
  assert.equal(delegatedTaskCard(finished).followsTaskId, null);
  assert.deepEqual(delegatedTaskFollowUps(finished, [finished, next, later]).map((row) => row.taskId), ['bg-3', 'bg-2']);
  assert.deepEqual(delegatedTaskFollowUps(next, [finished, next, later]), []);
});

test('a paused task says why it stopped', () => {
  const paused = delegatedTaskCard(task({ phase: 'paused', error: 'This step reached its time budget. Completed work is saved.' }));
  assert.equal(paused.problem, 'This step reached its time budget. Completed work is saved.');
  assert.equal(delegatedTaskCard(task({ phase: 'working', error: 'stale' })).problem, null, 'a working task shows no problem');
});

const briefs = {
  done: 3,
  total: 4,
  items: [
    { id: 'harbor', label: 'harbor-bakery', state: 'done' as const },
    { id: 'lantern', label: 'lantern-books', state: 'done' as const },
    { id: 'copper', label: 'copper-kettle', state: 'done' as const },
    { id: 'willow', label: 'willow-florist', state: 'failed' as const, note: 'no source file' },
  ],
};

test('a job that is not working never ends without a clear direction', () => {
  const paused = delegatedTaskCard(task({ phase: 'paused', status: 'blocked', work: briefs,
    controls: { canSteer: true, canStop: false, canResume: true, canAnswer: false } }));
  assert.equal(paused.progress?.label, '3 of 4 done');
  assert.match(paused.next?.text ?? '', /1 of 4 not done: willow-florist\. It stopped before finishing/);
  assert.equal(paused.next?.action, 'resume');

  const finishedWithGap = delegatedTaskCard(task({ phase: 'finished', status: 'done', work: briefs }));
  assert.match(finishedWithGap.next?.text ?? '', /willow-florist\. Correct this to finish them\./);
  assert.equal(finishedWithGap.next?.action, 'correct');

  const failed = delegatedTaskCard(task({ phase: 'failed', status: 'failed',
    controls: { canSteer: true, canStop: false, canResume: false, canAnswer: false } }));
  assert.equal(failed.next?.action, 'correct', 'nothing to resume: correcting it is the way on');

  const stopped = delegatedTaskCard(task({ phase: 'stopped', status: 'aborted' }));
  assert.equal(stopped.next?.action, 'correct');

  const approval = delegatedTaskCard(task({ phase: 'needs_you', status: 'awaiting_approval', approvalId: 'apr-1' }));
  assert.equal(approval.next?.action, 'approve');
  const asked = delegatedTaskCard(task({ phase: 'needs_you', status: 'awaiting_input', question: { id: 'q', text: 'Skip it?', options: [] } }));
  assert.equal(asked.next, null, 'the question is its own direction');

  const complete = delegatedTaskCard(task({ phase: 'finished', status: 'done', work: { ...briefs, done: 4, items: briefs.items.map((item) => ({ ...item, state: 'done' as const })) } }));
  assert.equal(complete.next, null, 'a job that finished everything needs no direction');
  assert.equal(delegatedTaskCard(task()).next, null, 'a working job is its own progress');
});

test('a working job says what it is on now, and only its newest update shows', () => {
  const card = delegatedTaskCard(task({
    work: { done: 1, total: 3, items: [
      { id: 'a', label: 'alpha', state: 'done' }, { id: 'b', label: 'beta', state: 'working' }, { id: 'c', label: 'gamma', state: 'waiting' },
    ] },
    checkIns: [{ at: '2026-09-29T09:00:30.000Z', note: 'Read the sources.' }, { at: '2026-09-29T09:00:50.000Z', note: 'Writing now.' }],
    files: [{ name: 'alpha.md', dir: 'notes' }],
  }));
  assert.equal(card.now, 'Working on beta.');
  assert.deepEqual(card.latest, { at: '2026-09-29T09:00:50.000Z', note: 'Writing now.', earlier: 1 });
  assert.deepEqual(card.files, [{ name: 'alpha.md', dir: 'notes' }]);
});

test('a job that stopped short reports what it found, from its own report', () => {
  const card = delegatedTaskCard(task({ phase: 'paused', status: 'blocked', resultPreview: null,
    error: 'I wrote **3 of 4** briefs; willow-florist has no source file.' }));
  assert.match(card.report ?? '', /\*\*3 of 4\*\*/, 'kept as markdown for the card to render');
});


test('large work lists keep full missing and running counts after display truncation', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}`, label: `Row ${i}`, state: 'done' as const }));
  const gap = delegatedTaskCard(task({ phase: 'finished', status: 'done', work: {
    done: 40, total: 41, items: rows, remaining: { count: 1, labels: ['Last transformation'] }, running: { count: 0, labels: [] },
  } }));
  assert.equal(gap.progress?.label, '40 of 41 done');
  assert.match(gap.next?.text ?? '', /1 of 41 not done: Last transformation/);
  assert.equal(gap.next?.action, 'correct');
  const legacy = delegatedTaskCard(task({ phase: 'finished', status: 'done', work: { done: 40, total: 41, items: rows } }));
  assert.match(legacy.next?.text ?? '', /1 of 41 not done/);
  const working = delegatedTaskCard(task({ work: { done: 0, total: 100, items: [],
    remaining: { count: 100, labels: ['A', 'B', 'C'] }, running: { count: 60, labels: ['A', 'B', 'C'] } } }));
  assert.equal(working.now, 'Working on A, B, C and 57 more.');
});
