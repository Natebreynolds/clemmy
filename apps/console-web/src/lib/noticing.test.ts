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
  assert.equal(goalOutcomeTaskWords({goalBinding:'current',state:'outcome_retained'}), 'Result recorded');
  assert.equal(goalOutcomeTaskWords({goalBinding:'historical',state:'outcome_retained'}), 'For an earlier version of this goal');
  assert.equal(goalOutcomeTaskWords({goalBinding:'unavailable',state:'outcome_retained'}), 'Link to this goal unconfirmed');
  assert.equal(goalOutcomeTaskWords({goalBinding:'current',state:'needs_attention'}), 'Needs attention');
  assert.equal(goalWorkflowOutcomeWords('satisfied'), 'Workflow criteria met');
  assert.equal(goalWorkflowOutcomeWords('unavailable'), 'Workflow evidence unavailable');
});

test('current artifact check stays separate from the retained workflow outcome', () => {
  assert.equal(goalArtifactReadbackWords('verified'), 'Saved artifact matches the recorded result.');
  assert.equal(goalArtifactReadbackWords('changed_or_unavailable'), 'Saved artifact has changed or could not be checked.');
  assert.equal(goalArtifactReadbackWords('not_checked'), 'Current artifact has not been checked.');
});

test('a goal result opens only its named workflow and run', () => {
  assert.equal(goalWorkflowHref({workflowName:'review & draft',runId:'run?foreign=1'}), '/automate?workflow=review%20%26%20draft&run=run%3Fforeign%3D1');
  assert.equal(goalWorkflowHref({workflowName:'',runId:'run-a'}), null);
  assert.equal(goalWorkflowHref({workflowName:'workflow-a',runId:''}), null);
});
