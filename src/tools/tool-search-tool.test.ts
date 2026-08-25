import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '../runtime/harness/tool-output-format.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-toolsearch-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolSearchCandidateSource } from './tool-search-tool.js';
const { registerToolSearchTool } = await import('./tool-search-tool.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { getHotSet, _resetHotSetForTest } = await import('../agents/tool-hotset.js');
const { deriveOrchestratorDiscoveryNames } = await import('./tool-registry.js');

type Handler = (input: { query: string; role_key?: string; limit?: number }) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

interface Captured {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: Handler;
}

function captureToolSearch(
  allowedNames?: ReadonlySet<string>,
  dispatchViaCallTool = false,
  candidateSources?: readonly ToolSearchCandidateSource[],
): Captured {
  let captured: Captured | undefined;
  const fakeServer = {
    tool(name: string, description: string, schema: Record<string, unknown>, handler: Handler): void {
      captured = { name, description, schema, handler };
    },
  };
  registerToolSearchTool(fakeServer as unknown as McpServer, {
    allowedNames,
    dispatchViaCallTool,
    ...(candidateSources ? { candidateSources } : {}),
  });
  assert.ok(captured, 'tool_search should register');
  return captured!;
}

async function runSearch(handler: Handler, query: string, sessionId?: string, roleKey?: string) {
  const result = await (sessionId
    ? (withToolOutputContext({ sessionId }, () => handler({ query, ...(roleKey ? { role_key: roleKey } : {}) })) as Promise<{ content: Array<{ type: 'text'; text: string }> }>)
    : handler({ query, ...(roleKey ? { role_key: roleKey } : {}) }));
  return JSON.parse(result.content[0].text) as {
    query: string;
    role_key?: string;
    results: Array<{ name: string; summary: string; carrier?: string; invocation?: unknown }>;
    schemas: Record<string, unknown>;
    guidance?: Record<string, string>;
    hint: string;
    brokerCoverage: string;
  };
}

test('registers as read-only tool_search with a query param', () => {
  const t = captureToolSearch();
  assert.equal(t.name, 'tool_search');
  assert.ok('query' in t.schema, 'schema exposes a query field');
  assert.ok('role_key' in t.schema, 'schema exposes the opaque requirement role');
});

test('echoes role_key without changing an exact-name result', async () => {
  const t = captureToolSearch(new Set(['workspace_roots']));
  const out = await runSearch(t.handler, 'workspace_roots', undefined, 'requirement-7');
  assert.equal(out.role_key, 'requirement-7');
  assert.deepEqual(out.results.map((result) => result.name), ['workspace_roots']);
});

test('returns ranked names + summaries and full schemas for the top hits', async () => {
  const t = captureToolSearch();
  const out = await runSearch(t.handler, 'schedule a recurring workflow');
  assert.ok(out.results.length > 0 && out.results.length <= 8, 'returns up to 8 results');
  assert.ok(out.results.every((r) => typeof r.name === 'string'), 'each result has a name');
  // Top hit should be schema-bearing and on-topic.
  const schemaNames = Object.keys(out.schemas);
  assert.ok(schemaNames.length >= 1 && schemaNames.length <= 3, 'schemas for up to 3 top hits');
  assert.ok(out.results.slice(0, 3).some((r) => r.name === 'workflow_schedule'), 'on-topic tool ranks in top 3');
  // A returned schema is a real JSON Schema object.
  const first = out.schemas[schemaNames[0]] as { type?: string; properties?: unknown };
  assert.ok(first && typeof first === 'object' && ('properties' in first || 'type' in first), 'schema looks like JSON Schema');
});

test('incident replay: scoped reminder discovery ranks the firing timer above a non-notifying TODO', async () => {
  const previousDisabled = process.env.EMBEDDINGS_DISABLED;
  process.env.EMBEDDINGS_DISABLED = 'true';
  try {
    const t = captureToolSearch(deriveOrchestratorDiscoveryNames(), true);
    const raw = await t.handler({
      query: 'schedule a one-time reminder notification for the user at a specified date and time',
      limit: 5,
    });
    const out = JSON.parse(raw.content[0].text) as {
      results: Array<{ name: string }>;
      schemas: Record<string, unknown>;
    };
    const timerIndex = out.results.findIndex((result) => result.name === 'set_timer');
    const todoIndex = out.results.findIndex((result) => result.name === 'task_add');
    assert.ok(timerIndex >= 0, 'set_timer must be discoverable on the live orchestrator scope');
    assert.ok(
      todoIndex < 0 || timerIndex < todoIndex,
      'a firing reminder must rank above task_add, whose due date does not notify',
    );
    assert.ok(out.schemas.set_timer, 'the winning reminder tool must include its callable schema');
  } finally {
    if (previousDisabled === undefined) delete process.env.EMBEDDINGS_DISABLED;
    else process.env.EMBEDDINGS_DISABLED = previousDisabled;
  }
});

test('an explicitly named tool survives a one-result limit ahead of stronger lexical neighbors', async () => {
  const previousDisabled = process.env.EMBEDDINGS_DISABLED;
  process.env.EMBEDDINGS_DISABLED = 'true';
  try {
    const t = captureToolSearch();
    const raw = await t.handler({
      query: 'space_save exact input schema create Workspace with title slug HTML view and runner data source code',
      limit: 1,
    });
    const out = JSON.parse(raw.content[0].text) as {
      results: Array<{ name: string }>;
      schemas: Record<string, unknown>;
    };
    assert.deepEqual(out.results.map((result) => result.name), ['space_save']);
    assert.deepEqual(Object.keys(out.schemas), ['space_save']);
  } finally {
    if (previousDisabled === undefined) delete process.env.EMBEDDINGS_DISABLED;
    else process.env.EMBEDDINGS_DISABLED = previousDisabled;
  }
});

test('an explicitly searched large schema survives the output budget instead of forcing an invalid probe call', async () => {
  const t = captureToolSearch();
  const raw = await t.handler({
    query: 'space_save exact input schema create Workspace with title slug HTML view and runner data source code',
    limit: 3,
  });
  const text = raw.content[0].text;
  const out = JSON.parse(text) as {
    results: Array<{ name: string }>;
    schemas: Record<string, unknown>;
    guidance?: Record<string, string>;
  };
  assert.equal(out.results[0]?.name, 'space_save');
  assert.ok(out.schemas.space_save, 'the requested large schema must remain available');
  assert.deepEqual(Object.keys(out.schemas), ['space_save'], 'an exact-name query spends tokens on only the selected schema');
  assert.match(out.guidance?.space_save ?? '', /clem\.data\(\)/, 'exact selection includes its critical usage contract');
  assert.ok(text.length <= DEFAULT_TOOL_RESULT_MAX_CHARS, 'tool_search stays within its own intact-JSON budget');
});

test('call_tool discovery removes nested nullable placeholders from required lists', async () => {
  const t = captureToolSearch(new Set(['workflow_update']), true);
  const out = await runSearch(t.handler, 'workflow_update exact schema');
  const schema = out.schemas.workflow_update as {
    required?: string[];
    properties?: {
      steps?: {
        anyOf?: Array<{
          type?: string;
          items?: { required?: string[] };
        }>;
      };
    };
  };
  assert.ok(schema);
  assert.deepEqual(schema.required, ['name'], 'only the real root requirement remains');
  const arrayBranch = schema.properties?.steps?.anyOf?.find((branch) => branch.type === 'array');
  assert.deepEqual(
    arrayBranch?.items?.required,
    ['id'],
    'nested workflow steps no longer advertise every optional field as mandatory null-filled boilerplate',
  );
  assert.match(
    out.guidance?.workflow_update ?? '',
    /steps.*REPLACES THE ENTIRE STEP GRAPH/i,
    'exact discovery warns that steps are replacement semantics even when schema annotations are stripped',
  );
  assert.match(out.hint, /Omit optional\/nullable fields/);
});

test('does not promote speculative schema-bearing hits to the session hot-set', async () => {
  _resetHotSetForTest();
  const t = captureToolSearch();
  const sid = 'search-sess-1';
  const out = await runSearch(t.handler, 'read a clipped tool result', sid);
  const schemaNames = Object.keys(out.schemas);
  const hot = getHotSet(sid);
  assert.ok(schemaNames.length > 0);
  for (const n of schemaNames) assert.equal(hot.includes(n), false, `${n} was suggested, not dispatched`);
});

test('no session context still returns results (recording is a no-op)', async () => {
  const t = captureToolSearch();
  const out = await runSearch(t.handler, 'send an email');
  assert.ok(out.results.length > 0);
});

test('a scoped MCP search never promises tools outside the active advertised surface', async () => {
  const allowed = new Set(['task_hygiene', 'tool_search']);
  const t = captureToolSearch(allowed);
  const out = await runSearch(t.handler, 'repair and compact the task ledger');
  assert.ok(out.results.length > 0);
  assert.ok(out.results.every((result) => allowed.has(result.name)));
  assert.ok(out.results.some((result) => result.name === 'task_hygiene'));
});

test('schema-on-demand search tells Claude to dispatch a deferred result through call_tool', async () => {
  const allowed = new Set(['workspace_roots', 'tool_search', 'call_tool']);
  const t = captureToolSearch(allowed, true);
  const out = await runSearch(t.handler, 'list workspace roots');
  assert.match(out.hint, /call_tool\(name, args_json\)/);
  assert.ok(out.results.some((result) => result.name === 'workspace_roots'));
});

test('one federated broker returns an authorized provider candidate with exact schema and carrier', async () => {
  const sources: ToolSearchCandidateSource[] = [
    {
      kind: 'authorized_external_mcp',
      async search() {
        return [{
          name: 'crm__mass_read',
          summary: 'Read a large CRM dataset with bounded pagination.',
          schema: {
            type: 'object',
            properties: { query: { type: 'string' }, cursor: { type: 'string' } },
            required: ['query'],
          },
          carrier: 'work_call',
        }];
      },
    },
    { kind: 'authorized_composio', async search() { return []; } },
  ];
  const t = captureToolSearch(new Set(['tool_search']), false, sources);
  const out = await runSearch(t.handler, 'crm__mass_read exact schema');
  assert.equal(out.brokerCoverage, 'authorized_external_v1');
  assert.deepEqual(out.results.map((result) => result.name), ['crm__mass_read']);
  assert.equal(out.results[0]?.carrier, 'work_call');
  assert.deepEqual((out.schemas.crm__mass_read as { required?: string[] }).required, ['query']);
  assert.match(out.hint, /work_call/);
});

test('TIERED RANKING: her own workflow_schedule outranks a third-party scheduler for the live query', async () => {
  const { registerToolSearchTool } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'rank-pin', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [{
      search: async () => [
        { name: 'APIFY_SCHEDULE_PUT', summary: 'Tool to update an existing schedule with new settings.', score: 0.95 },
        { name: 'dataforseo__docs_index', summary: 'Fetch the DataForSEO API documentation index.', score: 0.9 },
      ],
    }],
  } as never);
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const result = await handler({ query: 'update workflow schedule cron interval', limit: 8 });
  const body = JSON.parse(result.content[0].text) as { results: Array<{ name: string }> };
  const names = body.results.map((hit) => hit.name);
  const own = names.indexOf('workflow_schedule');
  const foreign = names.indexOf('APIFY_SCHEDULE_PUT');
  assert.ok(own >= 0, `workflow_schedule missing from: ${names.join(', ')}`);
  assert.ok(foreign === -1 || own < foreign,
    'her own tool outranks the third-party scheduler (live 2026-08-19 session-fixture-tool-search)');
});

// ─── A wedged candidate source cannot hold a discovery read (live 2026-08-25) ─
//
// platform-49 run 1787649706964-0a8b20: a provider-side candidate search hung
// and tool_search sat for the carrier's entire ten-minute call window — the
// only bound was the transport timeout. A source that cannot answer inside
// the per-source deadline contributes nothing, exactly like one that throws,
// and the local catalog still answers.
test('a never-resolving candidate source is dropped at the deadline and the search still answers', async () => {
  const { registerToolSearchTool, CANDIDATE_SOURCE_SEARCH_DEADLINE_MS } = await import('./tool-search-tool.js');
  assert.ok(CANDIDATE_SOURCE_SEARCH_DEADLINE_MS <= 15_000, 'the bound stays a discovery-read bound, not a work budget');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'deadline-pin', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [
      { search: () => new Promise(() => { /* never resolves */ }) },
      { search: async () => [{ name: 'LIVE_PROVIDER_SEARCH', summary: 'A healthy source answers.', score: 0.9 }] },
    ],
  } as never);
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const startedAt = Date.now();
  const result = await handler({ query: 'review the channel and read the log sheet', limit: 8 });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs < CANDIDATE_SOURCE_SEARCH_DEADLINE_MS + 5_000,
    `the read returns at the deadline, not the transport window (took ${elapsedMs}ms)`,
  );
  const body = JSON.parse(result.content[0].text) as { results: Array<{ name: string }> };
  assert.ok(body.results.length > 0, 'the local catalog and healthy sources still answer');
});
