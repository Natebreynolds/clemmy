/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-carrier-example.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { renderCarrierInvocationExample } = await import('./tool-search-tool.js');

test('every disclosed business result carries a literal example call with only the action arguments left to fill', () => {
  const example = renderCarrierInvocationExample('work_call', {
    name: 'composio_execute_tool',
    fixedArgs: { tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY' },
    payloadField: 'arguments',
  });
  assert.equal(example.tool, 'work_call');
  assert.equal(example.args.name, 'composio_execute_tool');
  assert.deepEqual(JSON.parse(example.args.args_json), {
    tool_slug: 'SLACK_FETCH_CONVERSATION_HISTORY',
    arguments: { '<argument>': '<value>' },
  });
  assert.equal(typeof example.args.args_json, 'string', 'exactly one level of string encoding');
});
