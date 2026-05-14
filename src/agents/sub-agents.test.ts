/**
 * Run: npx tsx --test src/agents/sub-agents.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUB_AGENT_TOOL_ALLOWLISTS,
  buildExecutorAgent,
  buildResearcherAgent,
  defaultOrchestratorHandoffs,
  isOrchestratorSlug,
} from './sub-agents.js';

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

test('defaultOrchestratorHandoffs returns researcher + executor', () => {
  const handoffs = defaultOrchestratorHandoffs();
  assert.equal(handoffs.length, 2);
  const names = handoffs.map((h) => h.name);
  assert.ok(names.includes('Researcher'));
  assert.ok(names.includes('Executor'));
});

test('sub-agents do NOT have their own handoffs (they are leaves)', () => {
  const researcher = buildResearcherAgent();
  const executor = buildExecutorAgent();
  // SDK exposes handoffs on Agent; sub-agents leave it undefined / empty.
  // We tolerate either undefined or empty array depending on SDK defaults.
  const rH = (researcher as unknown as { handoffs?: unknown[] }).handoffs;
  const eH = (executor as unknown as { handoffs?: unknown[] }).handoffs;
  assert.ok(!rH || (Array.isArray(rH) && rH.length === 0));
  assert.ok(!eH || (Array.isArray(eH) && eH.length === 0));
});
