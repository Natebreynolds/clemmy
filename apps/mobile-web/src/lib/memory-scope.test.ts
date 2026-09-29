/**
 * Run: npx tsx --test src/lib/memory-scope.test.ts   (from apps/mobile-web)
 *
 * Pins for the Memories scope filter: the query each choice asks with, and
 * that a Mac which does not scope memory yet changes nothing on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_MEMORY,
  factsCarryScope,
  memoryScopeChoices,
  memoryScopeFilterKey,
  memoryScopeFilterLabel,
  memoryScopeQuery,
  sameMemoryScopeFilter,
  scopeMove,
} from './memory-scope';

test('each choice asks the facts list with exactly its own parameter', () => {
  assert.deepEqual(memoryScopeQuery(ALL_MEMORY), {}, 'all memories is the list as it always was');
  assert.deepEqual(memoryScopeQuery({ kind: 'everywhere' }), { scopeKind: 'user' });
  assert.deepEqual(memoryScopeQuery({ kind: 'project', projectId: 'prj_1', name: 'Weekly Sales' }), { scopeProject: 'prj_1' });
  assert.deepEqual(memoryScopeQuery({ kind: 'agent', agentId: 'agt_1', name: 'Sales Assistant' }), { scopeAgent: 'agt_1' });
  assert.deepEqual(memoryScopeQuery({ kind: 'project', projectId: '', name: 'x' }), {}, 'a choice with no id narrows nothing');
});

test('the button names the choice in the owner\'s words, never an id', () => {
  assert.equal(memoryScopeFilterLabel(ALL_MEMORY), 'All memories');
  assert.equal(memoryScopeFilterLabel({ kind: 'everywhere' }), 'Everywhere');
  assert.equal(memoryScopeFilterLabel({ kind: 'project', projectId: 'prj_1', name: 'Weekly Sales' }), 'Weekly Sales');
  assert.equal(memoryScopeFilterLabel({ kind: 'agent', agentId: 'agt_1', name: ' ' }), 'One agent');
});

test('two filters are the same list only when they name the same scope', () => {
  const a = { kind: 'project', projectId: 'p1', name: 'A' } as const;
  assert.ok(sameMemoryScopeFilter(a, { kind: 'project', projectId: 'p1', name: 'Renamed' }));
  assert.ok(!sameMemoryScopeFilter(a, { kind: 'project', projectId: 'p2', name: 'A' }));
  assert.ok(!sameMemoryScopeFilter(a, { kind: 'agent', agentId: 'p1', name: 'A' }));
  assert.equal(memoryScopeFilterKey(ALL_MEMORY), 'all');
});

test('facts with no scope mean the Mac does not scope memory yet', () => {
  assert.equal(factsCarryScope([{}, {}]), false);
  assert.equal(factsCarryScope([]), false);
  assert.equal(factsCarryScope([{ scope: null }]), false);
  assert.equal(factsCarryScope([{}, { scope: { kind: 'user', projectId: null, projectName: null, agentId: null, agentName: null } }]), true);
});

test('the sheet lists active projects and agents by name', () => {
  const choices = memoryScopeChoices({
    projects: [
      { id: 'p2', name: 'Weekly Sales', status: 'active' },
      { id: 'p1', name: 'Board Prep', status: 'active' },
      { id: 'p3', name: 'Old', status: 'archived' },
      { id: '', name: 'No id' },
    ],
    agents: [{ id: 'a2', name: 'Writer' }, { id: 'a1', name: 'Analyst' }, { id: 'a3', name: '  ' }],
  });
  assert.deepEqual(choices.top.map((choice) => choice.kind), ['all', 'everywhere']);
  assert.deepEqual(choices.projects.map((choice) => memoryScopeFilterLabel(choice)), ['Board Prep', 'Weekly Sales']);
  assert.deepEqual(choices.agents.map((choice) => memoryScopeFilterLabel(choice)), ['Analyst', 'Writer']);
});

test('moving a fact sends the two ids its scope names, and nulls for everywhere', () => {
  assert.deepEqual(scopeMove(undefined), { projectId: null, agentId: null });
  assert.deepEqual(scopeMove({ kind: 'user', projectId: 'stale', projectName: null, agentId: 'stale', agentName: null }), { projectId: null, agentId: null });
  assert.deepEqual(scopeMove({ kind: 'project', projectId: 'p1', projectName: 'A', agentId: null, agentName: null }), { projectId: 'p1', agentId: null });
  assert.deepEqual(scopeMove({ kind: 'agent', projectId: null, projectName: null, agentId: 'a1', agentName: 'B' }), { projectId: null, agentId: 'a1' });
  assert.deepEqual(scopeMove({ kind: 'project_agent', projectId: 'p1', projectName: 'A', agentId: 'a1', agentName: 'B' }), { projectId: 'p1', agentId: 'a1' });
});
