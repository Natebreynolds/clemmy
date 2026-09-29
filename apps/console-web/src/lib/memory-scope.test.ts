/**
 * Run: node scripts/run-tests-isolated.mjs apps/console-web/src/lib/memory-scope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canMoveToEverywhere, factInScope, factScopeChoices, factScopeFromKey, factScopeKey, factScopeQuery, scopedFacts,
  type FactScopeFilter,
} from './memory-scope.js';

type Row = { id: number; scope?: typeof inProject | typeof agentInProject | typeof everywhere };
const everywhere = { kind: 'user' as const, projectId: null, projectName: null, agentId: null, agentName: null };
const inProject = { kind: 'project' as const, projectId: 'p1', projectName: 'Weekly Sales', agentId: null, agentName: null };
const byAgent = { kind: 'agent' as const, projectId: null, projectName: null, agentId: 'a1', agentName: 'Sales Assistant' };
const agentInProject = { kind: 'project_agent' as const, projectId: 'p1', projectName: 'Weekly Sales', agentId: 'a1', agentName: 'Sales Assistant' };

test('the filter is asked of the server in the words the contract gives', () => {
  assert.equal(factScopeQuery(undefined), '');
  assert.equal(factScopeQuery({ kind: 'all' }), '');
  assert.equal(factScopeQuery({ kind: 'everywhere' }), '&scopeKind=user');
  assert.equal(factScopeQuery({ kind: 'project', projectId: 'p 1' }), '&scopeProject=p%201');
  assert.equal(factScopeQuery({ kind: 'agent', agentId: 'a1' }), '&scopeAgent=a1');
});

test('a filter survives the trip through a select value', () => {
  const filters: FactScopeFilter[] = [
    { kind: 'all' }, { kind: 'everywhere' }, { kind: 'project', projectId: 'p1' }, { kind: 'agent', agentId: 'sales:west' },
  ];
  for (const filter of filters) assert.deepEqual(factScopeFromKey(factScopeKey(filter)), filter);
  assert.deepEqual(factScopeFromKey('project:'), { kind: 'all' });
  assert.deepEqual(factScopeFromKey('nonsense'), { kind: 'all' });
});

test('a fact that does not say where it applies is for everywhere', () => {
  assert.equal(factInScope({}, { kind: 'everywhere' }), true);
  assert.equal(factInScope({ scope: everywhere }, { kind: 'everywhere' }), true);
  assert.equal(factInScope({ scope: inProject }, { kind: 'everywhere' }), false);
  assert.equal(factInScope({}, { kind: 'project', projectId: 'p1' }), false);
  assert.equal(factInScope({ scope: inProject }, { kind: 'project', projectId: 'p1' }), true);
  assert.equal(factInScope({ scope: agentInProject }, { kind: 'project', projectId: 'p1' }), true, 'what an agent learned in the project is the project\'s too');
  assert.equal(factInScope({ scope: agentInProject }, { kind: 'agent', agentId: 'a1' }), true);
  assert.equal(factInScope({ scope: inProject }, { kind: 'project', projectId: 'p2' }), false);
  assert.equal(factInScope({ scope: byAgent }, { kind: 'agent', agentId: 'a2' }), false);
});

test('an answer that ignores the filter is reported, never drawn as the project\'s facts', () => {
  const ignored = scopedFacts<Row>([{ id: 1 }, { id: 2 }], { kind: 'project', projectId: 'p1' });
  assert.deepEqual(ignored, { supported: false, facts: [] });

  const answered = scopedFacts(
    [{ id: 1, scope: inProject }, { id: 2, scope: agentInProject }, { id: 3, scope: everywhere }],
    { kind: 'project', projectId: 'p1' },
  );
  assert.equal(answered.supported, true);
  assert.deepEqual(answered.facts.map((fact) => fact.id), [1, 2], 'a fact from another scope never rides along');

  assert.deepEqual(scopedFacts([], { kind: 'project', projectId: 'p1' }), { supported: true, facts: [] }, 'nothing learned yet is an honest empty list');
  assert.equal(scopedFacts<Row>([{ id: 1 }], { kind: 'all' }).facts.length, 1, 'the unfiltered list is what it always was');
});

test('only a fact kept somewhere narrower can be moved to everywhere', () => {
  assert.equal(canMoveToEverywhere({ scope: inProject }), true);
  assert.equal(canMoveToEverywhere({ scope: agentInProject }), true);
  assert.equal(canMoveToEverywhere({ scope: everywhere }), false);
  assert.equal(canMoveToEverywhere({}), false);
  assert.equal(canMoveToEverywhere({ scope: inProject, active: false }), false, 'a forgotten fact is not moved');
});

test('the filter offers everything, everywhere, then projects and agents by name', () => {
  const choices = factScopeChoices(
    [{ id: 'p2', name: 'Weekly Sales' }, { id: 'p1', name: 'Spring Launch' }],
    [{ id: 'a1', name: 'Sales Assistant' }],
  );
  assert.deepEqual(choices.map((choice) => [choice.group, choice.key, choice.label]), [
    ['general', 'all', 'All facts'],
    ['general', 'everywhere', 'Everywhere'],
    ['projects', 'project:p1', 'Spring Launch'],
    ['projects', 'project:p2', 'Weekly Sales'],
    ['agents', 'agent:a1', 'Sales Assistant'],
  ]);
});
