import assert from 'node:assert/strict';
import test from 'node:test';
import { appendWorkflowSetupRequest, workflowSetupRequest } from './workflow-setup';
import type { WorkflowDetailInfo } from './api';

const info: WorkflowDetailInfo = { name: 'Weekly business brief', slug: 'business-brief-exact', description: 'Prepare a brief for the owner.', enabled: false,
  schedule: '0 9 * * 1', stepCount: 1, summary: '', steps: [], certification: null,
  inputs: [{ key: 'report_recipient', description: 'Who should receive the report?', required: true, example: null },
    { key: 'ready_value', description: 'Already entered', required: true, example: null }] };

test('setup context keeps the exact workflow, each missing input and resource, without asking to run', () => {
  const request = workflowSetupRequest(info, ['report_recipient'], ['owner-account:primary', 'report-destination']);
  assert.match(request, /workflow "business-brief-exact"/);
  assert.match(request, /report_recipient: Who should receive the report\?/);
  assert.match(request, /owner-account:primary\n- report-destination/);
  assert.match(request, /saved automation is disabled/);
  assert.match(request, /Do not guess account bindings or secrets, enable it, run it, or change its schedule without my confirmation/);
  assert.doesNotMatch(request, /ready_value/);
});

test('setup context preserves an existing draft exactly and repeated taps do not append it again', () => {
  const request = workflowSetupRequest(info, ['report_recipient'], []);
  const previous = 'Keep my existing question and whitespace.  ';
  const combined = appendWorkflowSetupRequest(previous, request);
  assert.equal(combined, `${previous}\n\n${request}`);
  assert.equal(appendWorkflowSetupRequest(combined, request), combined);
  assert.equal(appendWorkflowSetupRequest('', request), request);
});
