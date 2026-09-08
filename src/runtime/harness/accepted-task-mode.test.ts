import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planModeCallRefusal } from './accepted-task-mode.js';
const plan = { version: 1, kind: 'plan' } as const;
test('Plan allows proven reads, investigation workers and its exact host artifact publication', () => {
  for (const [toolName, args] of [['read_file', { path: '/tmp/prepared' }], ['tool_search', { query: 'workflow_create' }], ['run_worker', {}], ['publish_plan', {}]] as const) {
    assert.equal(planModeCallRefusal({ mode: plan, toolName, args }), undefined, toolName);
  }
});
test('Plan closes native/business writes, workflow escapes, approvals, shell and foreign host-control names', () => {
  for (const [toolName, args] of [
    ['space_save', {}], ['workflow_create', {}], ['workflow_update', {}], ['workflow_run', {}], ['write_file', { path: '/tmp/not-scratch-authorized', content: 'x' }], ['request_approval', {}],
    ['run_shell_command', { command: 'echo investigation' }], ['mcp__foreign__publish_plan', {}],
    ['work_call', { name: 'space_save', args_json: '{}' }],
    ['composio_execute_tool', { tool_slug: 'OUTLOOK_CREATE_DRAFT', arguments: '{}' }],
  ] as const) assert.match(planModeCallRefusal({ mode: plan, toolName, args }) ?? '', /PLAN_MODE_READ_ONLY/, toolName);
});
test('Normal and Execute retain native capabilities at this mode ceiling; Execute has a separate exact reviewed-call gate', () => {
  const execute = { version: 1, kind: 'execute', executeRef: { planId: 'plan1', revision: 1, digest: 'a'.repeat(64) } } as const;
  for (const mode of [undefined, { version: 1, kind: 'normal' } as const, execute]) for (const toolName of ['workflow_create', 'workflow_update', 'space_save', 'write_file']) {
    assert.equal(planModeCallRefusal({ mode, toolName, args: {} }), undefined, toolName);
  }
});
