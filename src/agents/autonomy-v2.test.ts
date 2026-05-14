/**
 * Run: npx tsx --test src/agents/autonomy-v2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDecisionSchema, buildPolicyText, categorizeToolForPolicy, filterToolsByPolicy } from './autonomy-v2.js';
import { DEFAULT_PROACTIVITY_POLICY } from './proactivity-policy.js';

test('AgentDecisionSchema accepts the minimal valid shape', () => {
  const r = AgentDecisionSchema.safeParse({
    summary: 'Did X.',
    commitments: [],
  });
  assert.equal(r.success, true);
});

test('AgentDecisionSchema rejects missing summary', () => {
  const r = AgentDecisionSchema.safeParse({ commitments: [] });
  assert.equal(r.success, false);
});

test('AgentDecisionSchema rejects out-of-bounds followUpMinutes', () => {
  const lo = AgentDecisionSchema.safeParse({ summary: 's', commitments: [], followUpMinutes: 1 });
  const hi = AgentDecisionSchema.safeParse({ summary: 's', commitments: [], followUpMinutes: 9999 });
  assert.equal(lo.success, false);
  assert.equal(hi.success, false);
});

test('AgentDecisionSchema strips unknown keys (e.g. legacy actions array)', () => {
  // Strip behavior means old payloads don't crash rollout.
  const r = AgentDecisionSchema.safeParse({
    summary: 's',
    commitments: [],
    actions: [{ type: 'noop' }],
  });
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal('actions' in r.data, false, 'unknown actions key should be stripped');
  }
});

test('buildPolicyText reflects watch mode guidance', () => {
  const text = buildPolicyText({ ...DEFAULT_PROACTIVITY_POLICY, mode: 'watch' });
  assert.match(text, /Watch mode/);
  assert.match(text, /noop and notify_user/);
});

test('buildPolicyText reflects hands_on mode guidance', () => {
  const text = buildPolicyText({ ...DEFAULT_PROACTIVITY_POLICY, mode: 'hands_on' });
  assert.match(text, /Hands-on mode/);
  assert.match(text, /drive things forward/i);
});

test('buildPolicyText reflects balanced mode by default', () => {
  const text = buildPolicyText(DEFAULT_PROACTIVITY_POLICY);
  assert.match(text, /Balanced mode/);
});

test('buildPolicyText surfaces check-in cadence', () => {
  const text = buildPolicyText({ ...DEFAULT_PROACTIVITY_POLICY, checkInMinutes: 7 });
  assert.match(text, /7 minute\(s\)/);
});

test('buildPolicyText lists allowed action categories', () => {
  const text = buildPolicyText({
    ...DEFAULT_PROACTIVITY_POLICY,
    allowComputerActions: true,
    allowComposioActions: true,
    allowDiscordCheckIns: true,
  });
  assert.match(text, /local computer tools/);
  assert.match(text, /Composio/);
  assert.match(text, /Discord/);
});

test('buildPolicyText warns about blocked categories', () => {
  const text = buildPolicyText({
    ...DEFAULT_PROACTIVITY_POLICY,
    allowComputerActions: false,
    allowComposioActions: false,
    allowDiscordCheckIns: true,
  });
  assert.match(text, /Blocked: computer actions, Composio actions/);
  assert.match(text, /will fail/);
});

test('buildPolicyText handles all-allowed without blocked section', () => {
  const text = buildPolicyText({
    ...DEFAULT_PROACTIVITY_POLICY,
    allowComputerActions: true,
    allowComposioActions: true,
    allowDiscordCheckIns: true,
  });
  assert.doesNotMatch(text, /Blocked:/);
});

test('categorizeToolForPolicy: composio_* → composio', () => {
  assert.equal(categorizeToolForPolicy('composio_status'), 'composio');
  assert.equal(categorizeToolForPolicy('composio_execute_tool'), 'composio');
});

test('categorizeToolForPolicy: known shell/fs tools → computer', () => {
  for (const name of ['run_shell_command', 'write_file', 'read_file', 'list_files', 'git_status', 'workspace_info']) {
    assert.equal(categorizeToolForPolicy(name), 'computer', `${name} should be computer`);
  }
});

test('categorizeToolForPolicy: safe tools → other', () => {
  for (const name of ['memory_recall', 'memory_remember', 'task_add', 'notify_user', 'goal_update', 'note_take', 'agent_runs_recent']) {
    assert.equal(categorizeToolForPolicy(name), 'other', `${name} should be other`);
  }
});

test('filterToolsByPolicy: default policy keeps all tools', () => {
  const tools = [
    { name: 'composio_execute_tool' },
    { name: 'run_shell_command' },
    { name: 'memory_recall' },
  ];
  const filtered = filterToolsByPolicy(tools, DEFAULT_PROACTIVITY_POLICY);
  assert.equal(filtered.length, 3);
});

test('filterToolsByPolicy: allowComposioActions=false drops composio_* tools', () => {
  const tools = [
    { name: 'composio_status' },
    { name: 'composio_execute_tool' },
    { name: 'memory_recall' },
    { name: 'run_shell_command' },
  ];
  const filtered = filterToolsByPolicy(tools, { ...DEFAULT_PROACTIVITY_POLICY, allowComposioActions: false });
  const names = filtered.map((t) => t.name);
  assert.deepEqual(names, ['memory_recall', 'run_shell_command']);
});

test('filterToolsByPolicy: allowComputerActions=false drops shell/fs tools', () => {
  const tools = [
    { name: 'run_shell_command' },
    { name: 'write_file' },
    { name: 'read_file' },
    { name: 'memory_recall' },
    { name: 'composio_status' },
  ];
  const filtered = filterToolsByPolicy(tools, { ...DEFAULT_PROACTIVITY_POLICY, allowComputerActions: false });
  const names = filtered.map((t) => t.name);
  assert.deepEqual(names, ['memory_recall', 'composio_status']);
});

test('filterToolsByPolicy: both gates off keeps only safe tools', () => {
  const tools = [
    { name: 'run_shell_command' },
    { name: 'composio_execute_tool' },
    { name: 'memory_recall' },
    { name: 'notify_user' },
  ];
  const filtered = filterToolsByPolicy(tools, {
    ...DEFAULT_PROACTIVITY_POLICY,
    allowComputerActions: false,
    allowComposioActions: false,
  });
  const names = filtered.map((t) => t.name);
  assert.deepEqual(names, ['memory_recall', 'notify_user']);
});

test('filterToolsByPolicy: does not mutate input array', () => {
  const tools = [{ name: 'composio_status' }, { name: 'memory_recall' }];
  const before = tools.length;
  filterToolsByPolicy(tools, { ...DEFAULT_PROACTIVITY_POLICY, allowComposioActions: false });
  assert.equal(tools.length, before, 'input array length unchanged');
});
