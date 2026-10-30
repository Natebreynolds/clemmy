import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueWords, missedRunInMotion, missedRunState, type MissedRun } from './missed-runs';

const base: MissedRun = { workflow: 'w', name: 'W', dueAt: '2026-10-29T23:00:00.000Z', times: 1 };
const run = (status: string, stepsCompleted = 0, stepsTotal = 3): MissedRun => ({ ...base,
  decision: { action: 'run', runId: 'r1', at: '2026-10-29T23:40:00.000Z' }, run: { status, stepsCompleted, stepsTotal, currentStepId: null } });

test('each missed run says where it stands, and only a moving one is watched closely', () => {
  assert.equal(missedRunState(base), null, 'undecided: the checkbox speaks');
  assert.deepEqual(missedRunState({ ...base, decision: { action: 'skip', at: 'x' } }), { tone: 'muted', text: 'Skipped' });
  assert.equal(missedRunState(run('queued'))?.text, 'Starting…');
  assert.equal(missedRunState(run('running', 1, 3))?.text, 'Running · step 2 of 3');
  assert.deepEqual(missedRunState(run('completed')), { tone: 'done', text: 'Done' });
  assert.equal(missedRunState(run('awaiting_input'))?.text, 'Needs you');
  assert.equal(missedRunState(run('error'))?.tone, 'fail');
  assert.equal(missedRunInMotion(run('running')), true);
  assert.equal(missedRunInMotion(run('completed')), false);
  assert.equal(missedRunInMotion(base), false);
  assert.match(dueWords('2026-10-29T23:00:00.000Z', new Date('2026-10-29T23:30:00.000Z')), /^\d{1,2}:00 [AP]M$/);
  assert.match(dueWords('2026-10-27T23:00:00.000Z', new Date('2026-10-29T23:30:00.000Z')), /^[A-Z][a-z]+day \d{1,2}:00 [AP]M$/);
});
