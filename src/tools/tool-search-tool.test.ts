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
const {
  closeEventLog,
  createSession,
  openEventLog,
  readToolSearchContinuation,
  TOOL_SEARCH_CONTINUATION_MAX_ENTRIES,
  TOOL_SEARCH_CONTINUATION_MAX_ENTRY_BYTES,
  writeToolSearchContinuation,
} = await import('../runtime/harness/eventlog.js');
const { getHotSet, _resetHotSetForTest } = await import('../agents/tool-hotset.js');
const { deriveOrchestratorDiscoveryNames } = await import('./tool-registry.js');

type Handler = (input: { query: string; role_key?: string; limit?: number; cursor?: string }) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

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

test('the default eight-result page keeps provider rank nine reachable without a second source search', async () => {
  let sourceCalls = 0;
  const candidates = Array.from({ length: 9 }, (_, index) => ({
    name: `BOUNDARY_PROVIDER_OPERATION_${String(index + 1).padStart(2, '0')}`,
    summary: `Provider boundary operation ${index + 1}`,
    schema: {
      type: 'object',
      properties: { ordinal: { type: 'integer', enum: [index + 1] } },
      required: ['ordinal'],
    },
    carrier: 'work_call' as const,
    score: 10 - index / 100,
  }));
  const t = captureToolSearch(new Set(['tool_search']), false, [{
    kind: 'authorized_composio',
    async search({ limit }) {
      sourceCalls += 1;
      assert.equal(limit, 8, 'the visible page limit remains source-compatible');
      // Mirrors the production Composio adapter: its one bounded provider
      // response oversamples beyond the visible page and returns that snapshot.
      return candidates;
    },
  }]);

  const firstRaw = await t.handler({ query: 'provider boundary operation', limit: 8, role_key: 'clause-0:read' });
  const first = JSON.parse(firstRaw.content[0].text) as {
    results: Array<{ name: string }>;
    next_cursor?: string;
  };
  assert.equal(first.results.length, 8);
  assert.equal(first.results.some((row) => row.name === candidates[8]!.name), false);
  assert.ok(first.next_cursor, 'rank nine is represented by a local continuation');

  const secondRaw = await t.handler({
    query: 'provider boundary operation',
    role_key: 'clause-0:read',
    cursor: first.next_cursor!,
  });
  const second = JSON.parse(secondRaw.content[0].text) as { results: Array<{ name: string }> };
  assert.equal(second.results[0]?.name, candidates[8]!.name, 'rank nine leads the continuation page');
  assert.equal(sourceCalls, 1, 'redeeming a page never re-enters the physical candidate source');
});

test('content-addressed tool_search cursors are local reads, not new discovery claims', async () => {
  const { classifyDiscoveryCall } = await import('../runtime/harness/discovery-boundary.js');
  assert.equal(
    classifyDiscoveryCall('tool_search', {
      query: 'provider boundary operation',
      role_key: 'clause-0:read',
      cursor: `tool_search_page:v1:${'a'.repeat(64)}`,
    }),
    null,
  );
  assert.equal(
    classifyDiscoveryCall('tool_search', {
      query: 'BOUNDARY_EXACT_SCHEMA_100000',
      cursor: `tool_search_schema:v1:${'b'.repeat(64)}:8000`,
    }),
    null,
  );
  assert.equal(
    classifyDiscoveryCall('tool_search', {
      query: 'provider boundary operation',
      role_key: 'clause-0:read',
    })?.category,
    'broad_discovery',
    'only a host-issued cursor-shaped local read is subtracted from physical discovery',
  );
});

function exactSizedNestedEnumSchema(targetChars: number): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'request'],
    properties: {
      mode: { type: 'string', enum: ['append', 'replace'] },
      request: {
        type: 'object',
        additionalProperties: false,
        required: ['destination', 'rows'],
        properties: {
          destination: { type: 'string', enum: ['primary', 'archive'] },
          rows: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'state'],
              properties: {
                id: { type: 'string' },
                state: { type: 'string', enum: ['ready', 'held'] },
              },
            },
          },
        },
      },
      padding: { type: 'string', enum: [''] },
    },
  };
  const padding = ((schema.properties as Record<string, unknown>).padding as { enum: string[] }).enum;
  const base = JSON.stringify(schema).length;
  assert.ok(base <= targetChars);
  padding[0] = 'x'.repeat(targetChars - base);
  assert.equal(JSON.stringify(schema).length, targetChars);
  return schema;
}

async function redeemSchema(
  handler: Handler,
  query: string,
  first: {
    schemas: Record<string, unknown>;
    schema_handles?: Record<string, { cursor: string; sha256: string; chars: number }>;
  },
  name: string,
): Promise<unknown> {
  if (first.schemas[name] !== undefined) return first.schemas[name];
  const handle = first.schema_handles?.[name];
  assert.ok(handle, `missing lossless schema handle for ${name}`);
  let cursor: string | undefined = handle!.cursor;
  let serialized = '';
  let chunks = 0;
  while (cursor) {
    const raw = await handler({ query, cursor });
    assert.ok(raw.content[0].text.length <= DEFAULT_TOOL_RESULT_MAX_CHARS);
    const page = JSON.parse(raw.content[0].text) as {
      kind: string;
      sha256: string;
      chunk: string;
      next_cursor?: string;
    };
    assert.equal(page.kind, 'tool_search_schema_chunk');
    assert.equal(page.sha256, handle!.sha256);
    serialized += page.chunk;
    cursor = page.next_cursor;
    chunks += 1;
    assert.ok(chunks <= 32, 'the 100K fixture stays within the bounded chunk window');
  }
  assert.equal(serialized.length, handle!.chars);
  return JSON.parse(serialized);
}

test('page and schema cursors survive a broker/database restart only in their issuing durable session', async () => {
  const sessionId = 'tool-search-durable-owner';
  const otherSessionId = 'tool-search-durable-other';
  createSession({ id: sessionId, kind: 'chat' });
  createSession({ id: otherSessionId, kind: 'chat' });

  let sourceCalls = 0;
  const largeSchema = exactSizedNestedEnumSchema(100_000);
  const candidates = Array.from({ length: 9 }, (_, index) => ({
    name: `DURABLE_PROVIDER_OPERATION_${String(index + 1).padStart(2, '0')}`,
    summary: `Durable provider operation ${index + 1}`,
    schema: index === 0
      ? largeSchema
      : {
          type: 'object',
          properties: { ordinal: { type: 'integer', enum: [index + 1] } },
          required: ['ordinal'],
        },
    carrier: 'work_call' as const,
    score: 100 - index,
  }));
  const firstBroker = captureToolSearch(new Set(['tool_search']), false, [{
    kind: 'authorized_composio',
    async search() {
      sourceCalls += 1;
      return candidates;
    },
  }]);
  const firstRaw = await withToolOutputContext({ sessionId }, () => firstBroker.handler({
    query: 'durable provider operation',
    role_key: 'clause-0:read',
    limit: 8,
  })) as Awaited<ReturnType<Handler>>;
  const first = JSON.parse(firstRaw.content[0].text) as {
    next_cursor?: string;
    schema_handles?: Record<string, { cursor: string; sha256: string; chars: number }>;
  };
  assert.ok(first.next_cursor, 'the issuing search returns a retained second page');
  const schemaCursor = first.schema_handles?.[candidates[0]!.name]?.cursor;
  assert.ok(schemaCursor, 'the issuing search returns a retained large-schema cursor');
  assert.equal(sourceCalls, 1);

  // A process restart loses every tool-instance Map and reopens SQLite. The
  // new broker has a source that must never be entered by cursor redemption.
  closeEventLog();
  const restartedBroker = captureToolSearch(new Set(['tool_search']), false, [{
    kind: 'authorized_composio',
    async search() {
      sourceCalls += 1;
      throw new Error('cursor redemption must not repeat provider discovery');
    },
  }]);
  const pageRaw = await withToolOutputContext({ sessionId }, () => restartedBroker.handler({
    query: 'durable provider operation',
    role_key: 'clause-0:read',
    cursor: first.next_cursor!,
  })) as Awaited<ReturnType<Handler>>;
  const page = JSON.parse(pageRaw.content[0].text) as { results?: Array<{ name: string }>; error?: string };
  assert.equal(page.error, undefined);
  assert.equal(page.results?.some((row) => row.name === candidates[8]!.name), true);

  const schemaRaw = await withToolOutputContext({ sessionId }, () => restartedBroker.handler({
    query: 'durable provider operation',
    cursor: schemaCursor!,
  })) as Awaited<ReturnType<Handler>>;
  const schemaPage = JSON.parse(schemaRaw.content[0].text) as { kind?: string; sha256?: string; error?: string };
  assert.equal(schemaPage.error, undefined);
  assert.equal(schemaPage.kind, 'tool_search_schema_chunk');
  assert.equal(schemaPage.sha256, first.schema_handles?.[candidates[0]!.name]?.sha256);

  for (const [label, contextSessionId, cursor] of [
    ['wrong session', otherSessionId, first.next_cursor!],
    ['forged digest', sessionId, `tool_search_page:v1:${'f'.repeat(64)}`],
  ] as const) {
    const refusedRaw = await withToolOutputContext({ sessionId: contextSessionId }, () => restartedBroker.handler({
      query: 'durable provider operation',
      role_key: 'clause-0:read',
      cursor,
    })) as Awaited<ReturnType<Handler>>;
    const refused = JSON.parse(refusedRaw.content[0].text) as { error?: string };
    assert.equal(refused.error, 'invalid_or_expired_tool_search_cursor', label);
  }
  assert.equal(sourceCalls, 1, 'restart, cross-session, and forged cursor reads all stay provider-free');
});

test('durable tool_search continuations enforce entry/size ceilings and reject corrupt bytes', () => {
  const sessionId = 'tool-search-durable-bounds';
  createSession({ id: sessionId, kind: 'chat' });
  const addresses: string[] = [];
  for (let index = 0; index <= TOOL_SEARCH_CONTINUATION_MAX_ENTRIES; index += 1) {
    const digest = writeToolSearchContinuation({
      sessionId,
      kind: 'page',
      text: JSON.stringify({ page: index, marker: `durable-${index}` }),
    });
    assert.ok(digest);
    addresses.push(digest!);
  }

  const db = openEventLog();
  const retained = db.prepare(
    `SELECT COUNT(*) AS entries, COALESCE(SUM(content_bytes), 0) AS bytes
       FROM tool_search_continuations WHERE session_id = ?`,
  ).get(sessionId) as { entries: number; bytes: number };
  assert.equal(retained.entries, TOOL_SEARCH_CONTINUATION_MAX_ENTRIES);
  assert.ok(retained.bytes <= 32 * 1_048_576);
  assert.equal(readToolSearchContinuation({
    sessionId,
    kind: 'page',
    digest: addresses[0]!,
  }), null, 'the exact least-recently-used entry is evicted');
  assert.match(readToolSearchContinuation({
    sessionId,
    kind: 'page',
    digest: addresses.at(-1)!,
  }) ?? '', /durable-128/, 'the newest address remains readable');

  assert.equal(writeToolSearchContinuation({
    sessionId,
    kind: 'schema',
    text: 'x'.repeat(TOOL_SEARCH_CONTINUATION_MAX_ENTRY_BYTES + 1),
  }), null, 'an oversized continuation is refused before SQLite');

  const corruptDigest = addresses.at(-1)!;
  db.prepare(
    `UPDATE tool_search_continuations SET content_text = 'tampered'
      WHERE session_id = ? AND kind = 'page' AND content_sha256 = ?`,
  ).run(sessionId, corruptDigest);
  assert.equal(readToolSearchContinuation({
    sessionId,
    kind: 'page',
    digest: corruptDigest,
  }), null, 'manifest/body disagreement is never returned');
  assert.equal((db.prepare(
    `SELECT COUNT(*) AS count FROM tool_search_continuations
      WHERE session_id = ? AND kind = 'page' AND content_sha256 = ?`,
  ).get(sessionId, corruptDigest) as { count: number }).count, 0, 'the corrupt address is reaped atomically');
});

for (const renderChars of [20_000, 20_001, 100_000]) {
  test(`an exact ${renderChars.toLocaleString()}-character schema render is losslessly readable and constructs nested enum arguments`, async () => {
    const name = 'BOUNDARY_EXACT_RENDER_SCHEMA';
    const summary = 'Exact schema render boundary';
    const baselineSchema = exactSizedNestedEnumSchema(1_000);
    const baseline = captureToolSearch(new Set(['tool_search']), false, [{
      kind: 'authorized_composio',
      async search() {
        return [{ name, summary, schema: baselineSchema, carrier: 'work_call', score: 1 }];
      },
    }]);
    const baselineRaw = await baseline.handler({ query: name, limit: 1 });
    const renderOverhead = baselineRaw.content[0].text.length - JSON.stringify(baselineSchema).length;
    const schema = exactSizedNestedEnumSchema(renderChars - renderOverhead);
    assert.equal(
      renderOverhead + JSON.stringify(schema).length,
      renderChars,
      'fixture pins the pre-ceiling compact JSON render exactly',
    );
    let sourceCalls = 0;
    const t = captureToolSearch(new Set(['tool_search']), false, [{
      kind: 'authorized_composio',
      async search() {
        sourceCalls += 1;
        return [{
          name,
          summary,
          schema,
          carrier: 'work_call',
          score: 1,
        }];
      },
    }]);

    const raw = await t.handler({ query: name, limit: 1 });
    assert.ok(raw.content[0].text.length <= DEFAULT_TOOL_RESULT_MAX_CHARS);
    if (renderChars === DEFAULT_TOOL_RESULT_MAX_CHARS) {
      assert.equal(raw.content[0].text.length, DEFAULT_TOOL_RESULT_MAX_CHARS,
        'the exact ceiling stays inline and intact');
    }
    const first = JSON.parse(raw.content[0].text) as {
      schemas: Record<string, unknown>;
      schema_handles?: Record<string, { cursor: string; sha256: string; chars: number }>;
    };
    const recovered = await redeemSchema(t.handler, name, first, name);
    assert.deepEqual(recovered, schema, 'every schema byte survives the result ceiling');

    const { validateArgsAgainstSchema } = await import('./composio-batch-validator.js');
    const constructed = {
      mode: 'append',
      request: {
        destination: 'primary',
        rows: [{ id: 'row-1', state: 'ready' }],
      },
    };
    assert.equal(
      validateArgsAgainstSchema(name, constructed, recovered as Record<string, unknown>),
      null,
      'the reconstructed nested/enum contract supports a valid execution payload',
    );
    assert.equal(sourceCalls, 1, 'schema chunks are local reads, not provider rescans');
  });
}

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

test('a wedged planning-disclosure stage is dropped at its deadline and the search still answers', async () => {
  const { registerToolSearchTool, PLANNING_DISCLOSURE_DEADLINE_MS } = await import('./tool-search-tool.js');
  assert.ok(PLANNING_DISCLOSURE_DEADLINE_MS <= 20_000, 'discovery stays a read budget, not a work budget');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'disclosure-deadline-pin', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [
      { search: async () => [{ name: 'LIVE_PROVIDER_OP', summary: 'A live provider operation.', score: 0.9 }] },
    ],
    discloseForPlanning: () => new Promise(() => { /* the live 60s-per-call walk, never resolving */ }),
  } as never);
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const startedAt = Date.now();
  const result = await handler({ query: 'send my team update', limit: 8 });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs < PLANNING_DISCLOSURE_DEADLINE_MS + 5_000,
    `the read returns at the stage deadline (took ${elapsedMs}ms)`,
  );
  const body = JSON.parse(result.content[0].text) as { results: Array<{ name: string }> };
  assert.ok(body.results.length > 0, 'candidates still answer without materialized refs');
});
