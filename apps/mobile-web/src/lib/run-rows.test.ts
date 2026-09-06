import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunSummary } from './api';
import { runRowLabel, runStateLabel, workflowRunStateLabel } from './run-rows';

function run(patch: Partial<RunSummary>): RunSummary {
  return {
    id: 'run-1',
    sessionId: 'sess-1',
    title: 'A run',
    status: 'completed',
    createdAt: '2026-09-06T09:00:00.000Z',
    updatedAt: '2026-09-06T09:05:00.000Z',
    ...patch,
  };
}

test('a row says what the run did, not what the engine calls it', () => {
  const row = runRowLabel(run({
    status: 'completed',
    statusLabel: 'Done',
    preview: 'Filed 12 prospects into the Family Law tab.',
  }));
  assert.deepEqual(row, { state: 'Done', detail: 'Filed 12 prospects into the Family Law tab.' });
});

test('a raw status token never reaches the screen', () => {
  assert.equal(runStateLabel({ status: 'awaiting_input' }), 'Waiting for your input');
  assert.equal(runStateLabel({ status: 'completed' }), 'Done');
  // A status this build has never seen still arrives as words, not `a_b_c`.
  assert.equal(runStateLabel({ status: 'completed_with_errors' as RunSummary['status'] }), 'Completed with errors');
  assert.equal(runStateLabel({ status: '' as RunSummary['status'] }), 'Status unavailable');
});

test('the server label wins over the local fallback', () => {
  assert.equal(
    runStateLabel({ status: 'completed', statusLabel: 'Needs attention' }),
    'Needs attention',
    'the daemon already decided this row needs a person; the raw status must not overrule it',
  );
});

test('a run with nothing to report says its state once, never twice', () => {
  assert.deepEqual(runRowLabel(run({ statusLabel: 'Done', preview: 'Done' })), { state: 'Done', detail: '' });
  assert.deepEqual(runRowLabel(run({ statusLabel: 'Done' })), { state: 'Done', detail: '' });
  assert.deepEqual(
    runRowLabel(run({ status: 'failed', preview: '  Network timeout \n ' })),
    { state: 'Failed', detail: 'Network timeout' },
  );
});

test('a workflow run row reads as an outcome', () => {
  assert.equal(workflowRunStateLabel({ status: 'completed', terminalOutcome: 'partial' }), 'Done, with some items failed');
  assert.equal(workflowRunStateLabel({ status: 'completed', terminalOutcome: 'blocked' }), 'Needs a look');
  assert.equal(workflowRunStateLabel({ status: 'running' }), 'Working');
});
