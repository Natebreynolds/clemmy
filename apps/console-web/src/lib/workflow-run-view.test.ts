import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, latestRun, runHeadline, runStepLabel, runStepTone, runStillGoing, runWhen } from './workflow-run-view.js';
import type { WorkflowRunOverlay, WorkflowRunRecord } from './automate.js';

test('a waiting step is named as a wait and coloured as one, never as work or failure', () => {
  assert.equal(runStepLabel('awaiting_approval'), 'Waiting on you');
  assert.equal(runStepLabel('awaiting_input'), 'Waiting for your answer');
  assert.equal(runStepLabel('awaiting_capability'), 'Waiting for a connection');
  assert.equal(runStepLabel('blocked'), 'Blocked');
  assert.equal(runStepLabel('redoing'), 'Redoing');
  assert.equal(runStepTone('awaiting_approval'), 'warning');
  assert.equal(runStepTone('redoing'), 'live');
  assert.equal(runStepTone('done'), 'success');
  assert.equal(runStepTone('failed'), 'danger');
});

test('the tab opens on the newest run and keeps refreshing only while it can still change', () => {
  const runs: WorkflowRunRecord[] = [
    { id: 'a', workflow: 'w', status: 'completed', createdAt: '2026-09-26T07:00:00Z' },
    { id: 'b', workflow: 'w', status: 'running', createdAt: '2026-09-26T08:00:00Z' },
    { id: 'c', workflow: 'w', status: 'failed', createdAt: '2026-09-26T06:00:00Z' },
  ];
  assert.equal(latestRun(runs)?.id, 'b');
  assert.equal(latestRun([]), null);
  assert.equal(runStillGoing(runs[1]), true);
  assert.equal(runStillGoing(runs[0]), false);
  assert.equal(runStillGoing({ status: 'blocked_capability' }), true);
});

test('the run headline counts states in plain words', () => {
  const overlay = {
    runStatus: 'running', terminal: false, goal: null, steps: [],
    summary: { totalSteps: 4, pendingSteps: 1, runningSteps: 1, doneSteps: 1, failedSteps: 0, skippedSteps: 0, waitingSteps: 1, blockedSteps: 0, attentionSteps: 1, bottleneckStepId: 'send', bottleneck: 'approval wait' },
  } as unknown as WorkflowRunOverlay;
  assert.equal(runHeadline(overlay, null), 'Running · 1 done · 1 working · 1 waiting on you · 1 not started');
  assert.equal(runHeadline({ ...overlay, runStatus: 'completed', summary: { ...overlay.summary, runningSteps: 0, waitingSteps: 0, pendingSteps: 0, doneSteps: 4 } }, null), 'Finished · 4 done');
});

test('when and how long read the way a person says them', () => {
  const now = new Date('2026-09-26T09:00:00');
  assert.match(runWhen({ startedAt: '2026-09-26T07:05:00', source: 'console' }, now), /^Today .*· you$/);
  assert.match(runWhen({ createdAt: '2026-09-25T07:05:00', source: 'scheduler' }, now), /^Yesterday .*· scheduled$/);
  assert.equal(runWhen({}), 'a run');
  assert.equal(formatDuration(850), '850 ms');
  assert.equal(formatDuration(4200), '4.2 s');
  assert.equal(formatDuration(125000), '2 min 5 s');
});
