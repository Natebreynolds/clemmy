import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalArtifactReadbackWords, goalOutcomeTaskWords, goalWorkflowHref, goalWorkflowOutcomeWords, progressWords } from './noticing.js';

test('a goal\'s progress line says what the record carries, never a percentage no one measured', () => {
  const today = new Date().toISOString();
  assert.equal(progressWords({ progressNotes: [], nextActions: [], blockers: [], updatedAt: today, status: 'active' }), 'No progress recorded yet · moved today');
  assert.equal(progressWords({ progressNotes: ['a', 'b'], nextActions: ['x'], blockers: [], updatedAt: today, status: 'active' }), '2 notes · 1 next action · moved today');
  assert.equal(progressWords({ progressNotes: ['a'], nextActions: [], blockers: ['y', 'z'], updatedAt: today, status: 'blocked' }), '1 note · 2 blockers · moved today');
  assert.equal(progressWords({ progressNotes: [], nextActions: [], blockers: [], updatedAt: today, status: 'completed' }), 'Done');
});


test('workflow result presentation does not complete a goal or certify changed criteria', () => {
  assert.equal(goalOutcomeTaskWords({goalBinding:'pending',state:'pending'}), 'Waiting to start');
  assert.equal(goalOutcomeTaskWords({goalBinding:'current',state:'partial'}), 'More work in the chat');
  assert.equal(goalOutcomeTaskWords({goalBinding:'current',state:'outcome_retained'}), 'Result recorded');
  assert.equal(goalOutcomeTaskWords({goalBinding:'historical',state:'outcome_retained'}), 'For an earlier version of this goal');
  assert.equal(goalOutcomeTaskWords({goalBinding:'unavailable',state:'outcome_retained'}), 'Couldn’t confirm the goal link');
  assert.equal(goalOutcomeTaskWords({goalBinding:'current',state:'needs_attention'}), 'Needs attention');
  assert.equal(goalOutcomeTaskWords({goalBinding:'historical',state:'needs_attention'}), 'Needs attention');
  assert.equal(goalOutcomeTaskWords({goalBinding:'unavailable',state:'in_progress'}), 'Work in progress');
  assert.equal(goalWorkflowOutcomeWords('satisfied'), 'Requirements met');
  assert.equal(goalWorkflowOutcomeWords('unavailable'), 'Couldn’t check this run');
});

test('current artifact check stays separate from the retained workflow outcome', () => {
  assert.equal(goalArtifactReadbackWords('verified'), 'Saved output matches this run’s result.');
  assert.equal(goalArtifactReadbackWords('superseded'), 'Another saved result has replaced this one. This run’s result is still verified.');
  assert.equal(goalArtifactReadbackWords('changed_or_unavailable'), 'Saved output has changed or couldn’t be checked.');
  assert.equal(goalArtifactReadbackWords('not_checked'), 'The current saved output hasn’t been checked.');
});

test('a goal result opens only its named workflow and run', () => {
  assert.equal(goalWorkflowHref({workflowName:'review & draft',runId:'run?foreign=1'}), '/automate?workflow=review%20%26%20draft&run=run%3Fforeign%3D1');
  assert.equal(goalWorkflowHref({workflowName:'',runId:'run-a'}), null);
  assert.equal(goalWorkflowHref({workflowName:'  ',runId:'run-a'}), null);
  assert.equal(goalWorkflowHref({workflowName:'Workflow',runId:'run-a'}), '/automate?workflow=Workflow&run=run-a', 'a real workflow named Workflow remains navigable');
  assert.equal(goalWorkflowHref({workflowName:'workflow-a',runId:''}), null);
});
