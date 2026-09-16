import assert from 'node:assert/strict';
import test from 'node:test';
process.env.NODE_ENV = 'test';
const { reviewedRepairCompanion } = await import('./reviewed-plan-runtime.js');

test('a workflow_create step is completed by the tools that fix what its creation test found', () => {
  for (const tool of ['workflow_update', 'workflow_edit_step', 'workflow_apply_contract_fixes', 'workflow_capability_resolve', 'workflow_set_enabled', 'workflow_get', 'workflow_state']) {
    assert.equal(reviewedRepairCompanion('workflow_create', tool), true, tool);
  }
});

test('the companion set is closed: no provider call, no delete, no run rides a create step', () => {
  for (const tool of ['workflow_run', 'workflow_delete', 'composio_execute_tool', 'run_shell_command', 'OUTLOOK_LIST_EVENTS']) {
    assert.equal(reviewedRepairCompanion('workflow_create', tool), false, tool);
  }
  assert.equal(reviewedRepairCompanion('composio_execute_tool', 'workflow_update'), false, 'only local authoring steps have companions');
  assert.equal(reviewedRepairCompanion(undefined, 'workflow_update'), false);
});

test('a space_save step is completed by the Workspace reads, refreshes and view edits it needs', () => {
  for (const tool of ['space_refresh', 'space_set_data', 'space_edit_view', 'space_get', 'space_history', 'pending_action_get']) {
    assert.equal(reviewedRepairCompanion('space_save', tool), true, tool);
  }
  for (const tool of ['pending_action_execute', 'composio_execute_tool', 'workflow_run', 'run_shell_command']) {
    assert.equal(reviewedRepairCompanion('space_save', tool), false, tool);
  }
});
