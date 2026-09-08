import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultClaudeAgentSdkAllowedLocalTools } from './claude-agent-sdk.js';
import {
  claudeAgentSdkAdvertisedToolUniverse,
  projectClaudeAcceptedActionSurface,
} from './claude-agent-brain.js';
import { actionControlContextFor } from '../../tools/tool-registry.js';

function fullUniverse(): string[] {
  const allowed = defaultClaudeAgentSdkAllowedLocalTools('full');
  return claudeAgentSdkAdvertisedToolUniverse('full', allowed);
}

test('Claude fresh accepted action excludes archaeology and alternate action owners', () => {
  const fresh = new Set(projectClaudeAcceptedActionSurface(fullUniverse(), true, 'fresh'));
  for (const name of [
    'resume_held_task',
    'background_task_status',
    'background_tasks_recent',
    'focus_get',
    'focus_activate',
    'execution_create',
    'execution_update_step',
  ]) {
    assert.equal(fresh.has(name), false, `${name} leaked into Claude's fresh catalog/call_tool universe`);
  }
  for (const name of [
    'workflow_create', 'workflow_edit_step', 'workflow_set_enabled',
    'space_save', 'space_get', 'space_edit_view',
    'memory_recall', 'skill_read', 'session_history', 'session_search',
    'focus_set', 'focus_update', 'focus_clear', 'focus_park',
    'tool_search',
  ]) {
    assert.equal(fresh.has(name), true, `${name} became unreachable on Claude fresh action`);
  }
});
test('Claude typed/anaphoric continuation has one deferred recovery route', () => {
  const continuation = projectClaudeAcceptedActionSurface(fullUniverse(), true, 'continuation');
  const names = new Set(continuation);
  for (const name of [
    'session_history', 'resume_held_task', 'background_task_status', 'focus_get',
  ]) {
    assert.equal(names.has(name), true, `${name} missing from the continuation universe`);
    assert.equal(actionControlContextFor(name), name === 'session_history' ? 'fresh' : 'task_recovery');
  }
  assert.equal(names.has('execution_create'), false, 'continuation acquired a second action owner');
  assert.equal(names.has('tool_search'), true);

  // Production schema-on-demand applies this same structural predicate to the
  // direct hot set, leaving recovery entries only in localMcpToolUniverse. The
  // SDK mounts call_tool as the acquisition bridge outside this advertised
  // registry universe, so broker+dispatcher is one bounded acquisition route,
  // not direct schemas plus a second recovery door.
  const direct = continuation.filter((name) => actionControlContextFor(name) !== 'task_recovery');
  for (const name of ['resume_held_task', 'background_task_status', 'focus_get']) {
    assert.equal(direct.includes(name), false, `${name} also became first-class`);
  }
});
