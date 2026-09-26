/**
 * Run: npx tsx --test apps/console-web/src/lib/agents.test.ts
 *
 * A roster card says what an agent reaches for in words, never in counts of
 * zero: an agent with nothing pinned gets no chips, and a model is shown by
 * its label when the catalog knows one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentReachSummary, type AgentRecord } from './agents.js';

function agent(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: 'a1',
    name: 'Sales',
    handles: '',
    instructions: '',
    skills: [],
    workflows: [],
    tools: [],
    model: null,
    memoryScope: null,
    createdFrom: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

test('nothing pinned means no chips at all', () => {
  assert.deepEqual(agentReachSummary(agent({})), []);
});

test('counts read as words and pluralize', () => {
  assert.deepEqual(
    agentReachSummary(agent({ skills: ['a'], workflows: ['b', 'c'], tools: ['d', 'e', 'f'] })),
    ['1 skill', '2 workflows', '3 tools'],
  );
});

test('the model shows by its catalog label, falling back to the id', () => {
  assert.deepEqual(agentReachSummary(agent({ model: 'm-1' }), 'Fast model'), ['Fast model']);
  assert.deepEqual(agentReachSummary(agent({ model: 'm-1' }), null), ['m-1']);
});
