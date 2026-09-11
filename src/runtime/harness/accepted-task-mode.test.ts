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
    ['run_shell_command', { command: 'rm -rf /tmp/plan-mode-write-probe' }], ['mcp__foreign__publish_plan', {}],
    ['work_call', { name: 'space_save', args_json: '{}' }],
    ['composio_execute_tool', { tool_slug: 'OUTLOOK_CREATE_DRAFT', arguments: '{}' }],
  ] as const) assert.match(planModeCallRefusal({ mode: plan, toolName, args }) ?? '', /PLAN_MODE_READ_ONLY/, toolName);
});
test('Plan lets a read-only shell command run: a read is a read, whatever carries it', () => {
  // Live 2026-09-08: a planning turn needed `sf org list --json` to plan its
  // query and was refused as a write, then wandered until a misleading stop.
  for (const command of ['echo investigation', 'sf org list --json', 'gh pr list --json number']) {
    assert.equal(planModeCallRefusal({ mode: plan, toolName: 'run_shell_command', args: { command } }), undefined, command);
  }
});

test('Normal and Execute retain native capabilities at this mode ceiling; Execute has a separate exact reviewed-call gate', () => {
  const execute = { version: 1, kind: 'execute', executeRef: { planId: 'plan1', revision: 1, digest: 'a'.repeat(64) } } as const;
  for (const mode of [undefined, { version: 1, kind: 'normal' } as const, execute]) for (const toolName of ['workflow_create', 'workflow_update', 'space_save', 'write_file']) {
    assert.equal(planModeCallRefusal({ mode, toolName, args: {} }), undefined, toolName);
  }
});


// ─── Plan's ceiling is the CALL, not the wrapper around it ──────────────────
//
// The refusal resolved the tool NAME through arbitrary nesting but read the
// EFFECT off the raw outer carrier, which unwraps one level. At depth two they
// disagreed: `call_tool` wrapping `call_tool` classified `unknown` — neither
// read nor host_only — so a plain status read was refused, and the message then
// named the correctly-unwrapped tool, so it could not be acted on.
//
// Live 2026-09-11: a Plan turn asked, in the user's words, to "let me know what
// tools we can use" reached for a connection status check and two catalogue
// searches, double-wrapped them, and was refused as if reading the tool list
// were a business effect.

const wrapCall = (inner: unknown) => ({ name: 'call_tool', args_json: JSON.stringify(inner) });
const planRefusalFor = (args: unknown) => planModeCallRefusal({
  mode: { kind: 'plan' } as never,
  toolName: 'call_tool',
  args,
});

test('a read stays readable at every nesting depth', () => {
  const status = { name: 'composio_status', args_json: '{}' };
  assert.equal(planRefusalFor(status), undefined, 'one wrapper');
  assert.equal(planRefusalFor(wrapCall(status)), undefined, 'two wrappers');
  assert.equal(planRefusalFor(wrapCall(wrapCall(status))), undefined, 'three wrappers');
  assert.equal(
    planRefusalFor(wrapCall({ name: 'composio_search_tools', args_json: '{"query":"x"}' })),
    undefined,
    'searching the catalogue is how Plan answers "what can we use"',
  );
});

test('a write stays refused at every nesting depth', () => {
  // The fix must be accurate in BOTH directions. Before it, a nested write
  // classified `unknown` and was refused for the wrong reason; it must now be
  // refused for the right one.
  const write = { name: 'focus_set', args_json: '{}' };
  assert.ok(planRefusalFor(write), 'one wrapper');
  assert.ok(planRefusalFor(wrapCall(write)), 'two wrappers');
  assert.ok(planRefusalFor(wrapCall(wrapCall(write))), 'three wrappers');
  assert.ok(
    planRefusalFor(wrapCall({ name: 'memory_remember', args_json: '{}' })),
    'a host_only tool declared write is still a write when nested',
  );
});

test('the refusal names the call it actually classified', () => {
  // The message said "composio_status cannot execute in Plan mode" about a
  // call nothing had classified as composio_status. Name and effect now come
  // from one identity, so a refusal can always be acted on.
  const refusal = planRefusalFor(wrapCall({ name: 'focus_set', args_json: '{}' }));
  assert.ok(refusal);
  assert.match(refusal, /focus_set/);
});
