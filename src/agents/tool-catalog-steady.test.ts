/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/tool-catalog-steady.test.ts
 *
 * Live 10-02: one conversation's first-class tool list went 10→15→15→13→14→13→14
 * and every change re-billed the cached prompt prefix (~714k tokens in a day).
 * A tool promoted earlier in a conversation stays promoted while the turn's
 * policy allows it; discovery doors and the always-loaded kernel are not kept.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const { steadySessionPromotions, _resetSteadySessionPromotionsForTests, TOOL_SEARCH_ALWAYS_LOADED, DISCOVERY_SIBLING_DOORS } = await import('./tool-catalog.js');

beforeEach(() => _resetSteadySessionPromotionsForTests());
const all = () => true;

test('a tool promoted on an earlier turn stays promoted on the next, in its first order', () => {
  const kernel = [...TOOL_SEARCH_ALWAYS_LOADED][0]!;
  const first = steadySessionPromotions('sess-a', new Set([kernel, 'http_read', 'workflow_list']), all);
  assert.deepEqual([...first], [kernel, 'http_read', 'workflow_list']);
  const second = steadySessionPromotions('sess-a', new Set([kernel, 'write_file']), all);
  assert.deepEqual([...second], [kernel, 'write_file', 'http_read', 'workflow_list']);
  const third = steadySessionPromotions('sess-a', new Set([kernel]), all);
  assert.deepEqual([...third].sort(), [kernel, 'http_read', 'workflow_list', 'write_file'].sort(), 'nothing drops out between turns');
  assert.deepEqual([...steadySessionPromotions('sess-b', new Set([kernel]), all)], [kernel], 'another conversation starts lean');
});

test('the turn\'s policy still decides, discovery doors are not kept, and the kept set is bounded', () => {
  steadySessionPromotions('sess-c', new Set(['http_read', 'workflow_list']), all);
  const planTurn = steadySessionPromotions('sess-c', new Set(), (name) => name !== 'workflow_list');
  assert.deepEqual([...planTurn], ['http_read'], 'a tool this turn does not allow is not shown');
  const door = [...DISCOVERY_SIBLING_DOORS][0]!;
  steadySessionPromotions('sess-d', new Set([door]), all);
  assert.equal(steadySessionPromotions('sess-d', new Set(), all).has(door), false);
  const many = new Set(Array.from({ length: 12 }, (_, i) => `tool_${i}`));
  steadySessionPromotions('sess-e', many, all);
  assert.equal(steadySessionPromotions('sess-e', new Set(), all).size, 8);
});
