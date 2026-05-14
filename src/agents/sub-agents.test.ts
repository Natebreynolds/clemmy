/**
 * Run: npx tsx --test src/agents/sub-agents.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUB_AGENT_TOOL_ALLOWLISTS,
  buildDeployerAgent,
  buildExecutorAgent,
  buildResearcherAgent,
  buildReviewerAgent,
  buildWriterAgent,
  defaultOrchestratorHandoffs,
  isOrchestratorSlug,
} from './sub-agents.js';

function handoffDisplayName(entry: unknown): string | undefined {
  const ref = entry as { name?: string; agentName?: string };
  return ref.name ?? ref.agentName;
}

test('isOrchestratorSlug: clementine is the default orchestrator', () => {
  assert.equal(isOrchestratorSlug('clementine'), true);
});

test('isOrchestratorSlug: other slugs are not orchestrators by default', () => {
  assert.equal(isOrchestratorSlug('researcher'), false);
  assert.equal(isOrchestratorSlug('writer'), false);
  assert.equal(isOrchestratorSlug(''), false);
});

test('isOrchestratorSlug: env var opts other slugs in', () => {
  const original = process.env.AUTONOMY_ORCHESTRATOR_SLUGS;
  process.env.AUTONOMY_ORCHESTRATOR_SLUGS = 'project-lead, ops-pilot ';
  try {
    assert.equal(isOrchestratorSlug('project-lead'), true);
    assert.equal(isOrchestratorSlug('ops-pilot'), true);
    assert.equal(isOrchestratorSlug('random-agent'), false);
  } finally {
    if (original === undefined) delete process.env.AUTONOMY_ORCHESTRATOR_SLUGS;
    else process.env.AUTONOMY_ORCHESTRATOR_SLUGS = original;
  }
});

test('researcher allowlist is read-only (no writes to user state)', () => {
  const writeShaped = ['write_file', 'run_shell_command', 'task_add', 'task_update', 'goal_update', 'execution_update_step', 'execution_complete', 'memory_remember', 'memory_forget', 'composio_execute_tool'];
  for (const name of writeShaped) {
    assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.researcher.has(name), false, `researcher should NOT have ${name}`);
  }
});

test('researcher allowlist includes the core read tools', () => {
  const required = ['memory_recall', 'memory_read', 'read_file', 'list_files', 'workspace_info', 'git_status'];
  for (const name of required) {
    assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.researcher.has(name), true, `researcher should have ${name}`);
  }
});

test('executor allowlist includes the core write tools', () => {
  const required = ['task_add', 'execution_update_step', 'execution_complete', 'write_file', 'goal_update', 'notify_user', 'memory_remember'];
  for (const name of required) {
    assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.executor.has(name), true, `executor should have ${name}`);
  }
});

test('executor can ask the user when stuck (ask_user_question)', () => {
  assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.executor.has('ask_user_question'), true);
});

test('writer can draft files but cannot execute external delivery', () => {
  assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.writer.has('write_file'), true);
  assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.writer.has('composio_execute_tool'), false);
  assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.writer.has('run_shell_command'), false);
});

test('reviewer is read-only', () => {
  for (const name of ['write_file', 'run_shell_command', 'task_add', 'goal_update', 'execution_update_step', 'composio_execute_tool']) {
    assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.reviewer.has(name), false, `reviewer should NOT have ${name}`);
  }
  assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.reviewer.has('read_file'), true);
  assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.reviewer.has('agent_runs_recent'), true);
});

test('deployer has release tools and can ask for missing info', () => {
  for (const name of ['run_shell_command', 'git_status', 'execution_update_step', 'execution_complete', 'ask_user_question']) {
    assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.deployer.has(name), true, `deployer should have ${name}`);
  }
});

test('researcher CANNOT ask user questions (it gathers, the orchestrator decides)', () => {
  assert.equal(SUB_AGENT_TOOL_ALLOWLISTS.researcher.has('ask_user_question'), false);
});

test('buildResearcherAgent returns a configured Agent with handoffDescription', () => {
  const agent = buildResearcherAgent();
  assert.equal(agent.name, 'Researcher');
  assert.ok(agent.handoffDescription, 'handoffDescription required so orchestrator knows when to delegate');
  assert.match(agent.handoffDescription, /information|gather|read/i);
});

test('buildExecutorAgent returns a configured Agent with handoffDescription', () => {
  const agent = buildExecutorAgent();
  assert.equal(agent.name, 'Executor');
  assert.ok(agent.handoffDescription);
  assert.match(agent.handoffDescription, /work|decision|perform/i);
});

test('build specialized agents return configured Agents with handoffDescription', () => {
  for (const agent of [buildWriterAgent(), buildReviewerAgent(), buildDeployerAgent()]) {
    assert.ok(agent.name);
    assert.ok(agent.handoffDescription);
  }
});

test('defaultOrchestratorHandoffs returns the specialized sub-agent set', () => {
  const handoffs = defaultOrchestratorHandoffs();
  assert.equal(handoffs.length, 5);
  const names = handoffs.map(handoffDisplayName);
  assert.ok(names.includes('Researcher'));
  assert.ok(names.includes('Writer'));
  assert.ok(names.includes('Reviewer'));
  assert.ok(names.includes('Executor'));
  assert.ok(names.includes('Deployer'));
});

test('execution handoffs are gated by default and ungated by option', () => {
  const gated = defaultOrchestratorHandoffs();
  const executor = gated.find((entry) => handoffDisplayName(entry) === 'Executor') as { isEnabled?: unknown } | undefined;
  const deployer = gated.find((entry) => handoffDisplayName(entry) === 'Deployer') as { isEnabled?: unknown } | undefined;
  assert.equal(typeof executor?.isEnabled, 'function');
  assert.equal(typeof deployer?.isEnabled, 'function');

  const ungated = defaultOrchestratorHandoffs({ requireWorkflowApprovalForExecution: false });
  const ungatedExecutor = ungated.find((entry) => handoffDisplayName(entry) === 'Executor') as { isEnabled?: unknown } | undefined;
  assert.equal(ungatedExecutor?.isEnabled, undefined);
});

test('sub-agents do NOT have their own handoffs (they are leaves)', () => {
  const agents = [
    buildResearcherAgent(),
    buildWriterAgent(),
    buildReviewerAgent(),
    buildExecutorAgent(),
    buildDeployerAgent(),
  ];
  // SDK exposes handoffs on Agent; sub-agents leave it undefined / empty.
  // We tolerate either undefined or empty array depending on SDK defaults.
  for (const agent of agents) {
    const handoffs = (agent as unknown as { handoffs?: unknown[] }).handoffs;
    assert.ok(!handoffs || (Array.isArray(handoffs) && handoffs.length === 0), `${agent.name} should be a leaf`);
  }
});
