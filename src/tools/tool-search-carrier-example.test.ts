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

test('an exact business capability keeps its direct tool-edge binding inside the literal example', () => {
  const capabilityRef = 'cap:resolved:googlesheets_update_values_batch:definition-fixture';
  const example = renderCarrierInvocationExample('work_call', {
    name: 'composio_execute_tool',
    fixedArgs: { tool_slug: 'GOOGLESHEETS_UPDATE_VALUES_BATCH' },
    payloadField: 'arguments',
  }, capabilityRef);
  assert.deepEqual(example, {
    tool: 'work_call',
    args: {
      requirement_id: capabilityRef,
      source_call_ids: null,
      source_record_ids: null,
      name: 'composio_execute_tool',
      args_json: JSON.stringify({
        tool_slug: 'GOOGLESHEETS_UPDATE_VALUES_BATCH',
        arguments: { '<argument>': '<value>' },
      }),
    },
  });
});

test('the public tool_search row keeps its singleton capabilityRef and literal work_call example aligned', async () => {
  const { registerToolSearchTool } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const capabilityRef = 'cap:resolved:crm_update_record:definition-fixture';
  const server = new McpServer({ name: 'carrier-example-public-row', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [{
      kind: 'authorized_composio',
      search: async () => [{
        name: 'CRM_UPDATE_RECORD',
        summary: 'Update one existing record.',
        schema: {
          type: 'object',
          properties: { record_id: { type: 'string' } },
          required: ['record_id'],
        },
        carrier: 'work_call',
        invocation: {
          name: 'composio_execute_tool',
          fixedArgs: { tool_slug: 'CRM_UPDATE_RECORD' },
          payloadField: 'arguments',
        },
      }],
    }],
    discloseForPlanning: async () => ({ CRM_UPDATE_RECORD: capabilityRef }),
  });
  const handler = (server as never as {
    _registeredTools: Record<string, {
      handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>;
    }>;
  })._registeredTools.tool_search.handler;
  const result = await handler({
    query: 'CRM_UPDATE_RECORD',
    role_key: 'clause-1:write',
    limit: 3,
    cursor: null,
  });
  const body = JSON.parse(result.content[0]!.text) as {
    results: Array<{
      capabilityRef?: string;
      example?: { tool: string; args: Record<string, unknown> };
    }>;
  };
  const row = body.results[0];
  assert.equal(row?.capabilityRef, capabilityRef);
  assert.equal(row?.example?.tool, 'work_call');
  assert.equal(row?.example?.args.requirement_id, capabilityRef);
  assert.equal(row?.example?.args.source_call_ids, null);
});

test('call_tool and undisclosed work_call examples never invent a requirement binding', () => {
  const callTool = renderCarrierInvocationExample('call_tool', { name: 'read_only_tool' }, 'cap:resolved:read');
  const undisclosed = renderCarrierInvocationExample('work_call', { name: 'business_tool' });
  assert.equal(callTool.args.requirement_id, undefined);
  assert.equal(undisclosed.args.requirement_id, undefined);
});

test('a write whose account review is still running is callable by its operation, with no ref to copy', async () => {
  const { registerToolSearchTool } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'carrier-example-pending-row', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [{
      kind: 'authorized_composio',
      search: async () => [{
        name: 'CRM_UPDATE_RECORD',
        summary: 'Update one existing record.',
        schema: {
          type: 'object',
          properties: { record_id: { type: 'string' } },
          required: ['record_id'],
        },
        carrier: 'work_call',
        invocation: {
          name: 'composio_execute_tool',
          fixedArgs: { tool_slug: 'CRM_UPDATE_RECORD' },
          payloadField: 'arguments',
        },
      }],
    }],
    // An earlier definition on the card must not stand in for this request's
    // account review.
    discloseForPlanning: async () => ({
      version: 1 as const,
      refs: { CRM_UPDATE_RECORD: 'cap:resolved:crm_update_record:definition-earlier' },
      blockers: {},
      pending: { CRM_UPDATE_RECORD: true as const },
    }),
  });
  const handler = (server as never as {
    _registeredTools: Record<string, {
      handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>;
    }>;
  })._registeredTools.tool_search.handler;
  const result = await handler({ query: 'CRM_UPDATE_RECORD', role_key: null, limit: 3, cursor: null });
  const text = result.content[0]!.text;
  const body = JSON.parse(text) as {
    results: Array<{
      capabilityRef?: string;
      planningRefStatus?: string;
      accountCheck?: string;
      example?: { tool: string; args: Record<string, unknown> };
    }>;
  };
  const row = body.results[0];
  assert.equal(row?.capabilityRef, undefined, 'no ref until its own review publishes one');
  assert.equal(row?.planningRefStatus, 'account_check_pending');
  assert.match(row?.accountCheck ?? '', /can be called now/);
  assert.equal(row?.example?.tool, 'work_call');
  assert.equal(row?.example?.args.requirement_id, 'cap:resolved:crm_update_record');
  assert.deepEqual(JSON.parse(String(row?.example?.args.args_json)), {
    tool_slug: 'CRM_UPDATE_RECORD',
    arguments: { '<argument>': '<value>' },
  });
  assert.match(text, /CRM_UPDATE_RECORD can be called now/, 'the page says to call it rather than search again');
});
