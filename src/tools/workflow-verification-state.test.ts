import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingPendingWorkflowVerification } from './workflow-verification-state.js';
test('pending verification must match the exact unfinished saved definition and record identity', () => {
  const expected = { runId: 'run-1', workflowName: 'example', definitionHash: 'current' };
  const run = { id: 'run-1', workflow: 'example', status: 'creation_test', workflowDefinitionSnapshot: { definitionHash: 'current' } };
  assert.equal(matchingPendingWorkflowVerification(run, expected), true);
  for (const changes of [
    { id: 'run-2' }, { workflow: 'other' }, { status: 'running' },
    { finishedAt: '2026-09-19' }, { terminalOutcome: 'succeeded' },
    { workflowDefinitionSnapshot: { definitionHash: 'old' } },
    { workflowDefinitionSnapshot: undefined },
  ]) assert.equal(matchingPendingWorkflowVerification({ ...run, ...changes }, expected), false);
  assert.equal(matchingPendingWorkflowVerification(null, expected), false);
});

import { workflowVerificationDependencyState } from './workflow-verification-state.js';
test('deferred execution requires its exact successful verification and unchanged enabled definition', () => {
  const verification = { id:'v', workflow:'w', status:'creation_test', workflowDefinitionSnapshot:{definitionHash:'h'} };
  const input = { verification, runId:'v', workflowName:'w', definitionHash:'h', currentDefinitionMatches:true, enabled:false };
  assert.equal(workflowVerificationDependencyState(input),'pending');
  const done = {...input, enabled:true, verification:{...verification, finishedAt:'now',terminalOutcome:'succeeded'}};
  assert.equal(workflowVerificationDependencyState(done),'ready');
  for (const changed of [ {...done,enabled:false}, {...done,currentDefinitionMatches:false}, {...done,definitionHash:'other'}, {...done,verification:null}, {...done,verification:{...done.verification,terminalOutcome:'blocked'}}, {...done,verification:{...done.verification,status:'cancelled'}} ]) assert.equal(workflowVerificationDependencyState(changed),'blocked');
});
