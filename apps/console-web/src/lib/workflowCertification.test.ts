import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowCardStatus } from './workflowCertification';
import type { WorkflowCertification } from './automate';

function cert(overrides: Partial<WorkflowCertification>): WorkflowCertification {
  return {
    workflow: 'wf',
    enabled: true,
    state: 'ready_to_run',
    label: 'Ready to run',
    summary: 'ready',
    canRun: true,
    canEnableDirectly: true,
    canQueueCreationTest: false,
    needsCreationTest: false,
    missingRunInputs: [],
    missingTestInputs: [],
    nextActions: [],
    ...overrides,
  };
}

test('broken health outranks everything', () => {
  const status = workflowCardStatus({
    health: { status: 'broken', issues: [{ stepId: 'send_mail' }] },
    certification: cert({ state: 'needs_info', label: 'Needs info', canRun: false }),
    lastRunStatus: 'failed',
  });
  assert.equal(status?.tone, 'danger');
  assert.equal(status?.label, 'Broken — tool missing');
  assert.match(status?.detail ?? '', /send_mail/);
});

test('certification-not-ready outranks last-run trouble', () => {
  const status = workflowCardStatus({
    certification: cert({ state: 'needs_info', label: 'Needs info', summary: 'answer questions', canRun: false }),
    lastRunStatus: 'failed',
  });
  assert.equal(status?.label, 'Needs info');
  assert.equal(status?.tone, 'info');
  assert.equal(status?.aboutLastRun, undefined);
});

test('a runnable workflow surfaces last-run trouble as a clickable run pill', () => {
  const failed = workflowCardStatus({ certification: cert({}), lastRunStatus: 'failed' });
  assert.deepEqual({ tone: failed?.tone, label: failed?.label, aboutLastRun: failed?.aboutLastRun },
    { tone: 'danger', label: 'Last run failed', aboutLastRun: true });

  const attention = workflowCardStatus({ certification: cert({}), lastRunStatus: 'needs_attention' });
  assert.equal(attention?.label, 'Needs attention');

  const failedItems = workflowCardStatus({ certification: cert({}), lastRunStatus: 'completed', lastRunFailedItemCount: 3 });
  assert.equal(failedItems?.label, '3 failed items');
  assert.equal(failedItems?.tone, 'warning');

  const running = workflowCardStatus({ certification: cert({}), lastRunStatus: 'running' });
  assert.equal(running?.label, 'Running now');
  assert.equal(running?.tone, 'live');
});

test('a healthy, certified workflow with a clean last run shows NO pill', () => {
  assert.equal(workflowCardStatus({ certification: cert({}), lastRunStatus: 'completed' }), null);
  assert.equal(workflowCardStatus({}), null);
});
