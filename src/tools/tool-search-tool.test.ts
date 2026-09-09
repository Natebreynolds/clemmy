import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

// NOTHING that reaches config.js may be imported statically above this line:
// a hoisted import captures BASE_DIR from the REAL home before the assignment
// runs, and the suite then reads and writes the user's live store while
// believing it is isolated. openEventLog now refuses that outright.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-toolsearch-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { DEFAULT_TOOL_RESULT_MAX_CHARS } = await import('../runtime/harness/tool-output-format.js');

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

test('JSON-null cursor sentinels are omitted, not treated as continuations', async () => {
  const { normalizeToolSearchCursor } = await import('./tool-search-tool.js');
  for (const cursor of ['null', 'NULL', ' undefined ', 'none', 'nil', 'n/a', '', '  ']) {
    assert.equal(normalizeToolSearchCursor(cursor), null, cursor);
  }
  assert.equal(normalizeToolSearchCursor(null), null);
  assert.equal(normalizeToolSearchCursor(undefined), null);
  assert.match(
    normalizeToolSearchCursor(`tool_search_page:v1:${'a'.repeat(64)}`) ?? '',
    /^tool_search_page:v1:/,
  );

  const t = captureToolSearch();
  const cursorField = t.schema.cursor as { parse?: (value: unknown) => unknown; safeParse?: (value: unknown) => { success: boolean } };
  assert.equal(typeof cursorField?.parse, 'function', 'cursor is a zod field the host validates');
  assert.equal(cursorField.safeParse?.('')?.success, true, 'empty cursor is omitted, not minLength-invalid');
  assert.equal(cursorField.safeParse?.(null)?.success, true);
  for (const cursor of ['null', 'undefined', 'none', '']) {
    const raw = await t.handler({ query: 'calendar', cursor });
    const body = JSON.parse(raw.content[0]!.text) as { error?: string; results?: unknown[] };
    assert.notEqual(body.error, 'invalid_or_expired_tool_search_cursor', cursor);
    assert.ok(Array.isArray(body.results), `${cursor} must run discovery, not a continuation read`);
  }
});

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

test('an explicit workflow_run tool selection keeps its exact discovery shortcut', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const { WORKFLOWS_DIR } = await import('../memory/vault.js');
  const { rmSync } = await import('node:fs');
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Business-hours channel review',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  let providerSearches = 0;
  try {
    const t = captureToolSearch(
      new Set(['workflow_run', 'workflow_get', 'workflow_schedule']),
      false,
      [{
        kind: 'authorized_composio',
        async search() {
          providerSearches += 1;
          return [{
            name: 'APIFY_RUN_ACTOR',
            summary: 'Run an Apify actor',
            carrier: 'work_call',
            score: 1,
          }];
        },
      }],
    );
    const raw = await t.handler({
      query: 'workflow_run',
      limit: 8,
    });
    const out = JSON.parse(raw.content[0]!.text) as {
      results: Array<{ name: string }>;
      schemas: Record<string, unknown>;
    };
    assert.deepEqual(out.results.map((result) => result.name), ['workflow_run']);
    assert.ok(out.schemas.workflow_run, 'workflow_run must include its callable schema');
    assert.equal(providerSearches, 0, 'unique workflow identity must not consult provider discovery');
  } finally {
    rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
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

test('account review unavailability has consistent global and row recovery without reasking the account', async () => {
  for (const reason of ['review_unavailable', undefined] as const) {
    let handler!: Handler;
    registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: Handler) { handler = callback; } } as never, {
      allowedNames: new Set(), dispatchCarrier: 'work_call',
      candidateSources: [{ kind: 'authorized_composio', async search() { return [{
        name: 'OUTLOOK_CREATE_DRAFT', summary: 'Create an unsent draft', score: 1,
        carrier: 'work_call', schema: { type: 'object', properties: {} },
      }]; } }],
      async discloseForPlanning() {
        return { version: 1, refs: {}, blockers: { OUTLOOK_CREATE_DRAFT: {
          code: 'account_selection_required', choices: ['work@fixture.invalid', 'personal@fixture.invalid'],
          ...(reason ? { reason } : {}),
        } } };
      },
    });
    const response = await handler({ query: 'Outlook create draft' });
    const body = JSON.parse(response.content[0]!.text);
    if (reason) {
      assert.match(body.hint, /Retry the identical account_selection once/);
      assert.match(body.hint, /report that exact host blocker/);
      assert.doesNotMatch(body.hint, /Ask the user which exact connected account/);
      assert.ok(body.hint.includes(body.results[0].accountSelectionNextStep),
        'the global instruction and exact row share the same typed recovery');
      assert.equal(body.results[0].accountSelectionReason, reason);
    } else {
      assert.match(body.hint, /Ask the user which exact connected account/);
      assert.match(body.hint, /work@fixture.invalid/);
      assert.doesNotMatch(body.hint, /review unavailable/);
    }
  }
});

test('page guidance follows eight published choices and preserves an off-page account blocker on its own page', async () => {
  let handler!: Handler;
  let sourceCalls = 0;
  const readyNames = Array.from({ length: 8 }, (_, index) => `OUTLOOK_READY_OPERATION_${index + 1}`);
  const blockedName = 'GOOGLECALENDAR_CREATE_EVENT';
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: Handler) { handler = callback; } } as never, {
    allowedNames: new Set(), dispatchCarrier: 'work_call',
    candidateSources: [{ kind: 'authorized_composio', async search() {
      sourceCalls += 1;
      return [...readyNames, blockedName].map((name, index) => ({
        name, summary: 'Create a provider item', score: 100 - index,
        carrier: 'work_call' as const, schema: { type: 'object', properties: {} },
      }));
    } }],
    async discloseForPlanning() {
      return { version: 1, refs: Object.fromEntries(readyNames.map((name) => [name, `cap:resolved:${name.toLowerCase()}`])),
        blockers: { [blockedName]: { code: 'account_selection_required', choices: ['calendar@fixture.invalid'] } } };
    },
  });
  const first = JSON.parse((await handler({ query: 'create provider item', limit: 8 })).content[0]!.text);
  assert.deepEqual(first.results.map((row: { name: string }) => row.name), readyNames);
  assert.ok(first.results.every((row: { capabilityRef?: string }) => row.capabilityRef));
  assert.match(first.hint, /work_call/);
  assert.doesNotMatch(first.hint, /account selection|Ask the user|calendar@fixture.invalid/i);
  assert.ok(first.next_cursor);
  const second = JSON.parse((await handler({ query: 'create provider item', limit: 8, cursor: first.next_cursor })).content[0]!.text);
  assert.equal(sourceCalls, 1, 'the next page uses its retained disclosure');
  assert.equal(second.results[0].name, blockedName);
  assert.equal(second.results[0].planningRefStatus, 'account_selection_required');
  assert.deepEqual(second.results[0].accountChoices, ['calendar@fixture.invalid']);
  assert.match(second.hint, /Ask the user which exact connected account/);
  assert.match(second.hint, /calendar@fixture.invalid/);
});

test('mixed ready and blocked choices keep dispatch available and account recovery specific to the selected row', async () => {
  let handler!: Handler;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: Handler) { handler = callback; } } as never, {
    allowedNames: new Set(), dispatchCarrier: 'work_call',
    candidateSources: [{ kind: 'authorized_composio', async search() { return [
      { name: 'OUTLOOK_CREATE_DRAFT', summary: 'Create an unsent draft', score: 2 },
      { name: 'GOOGLECALENDAR_CREATE_EVENT', summary: 'Create a calendar event', score: 1 },
    ].map((candidate) => ({ ...candidate, carrier: 'work_call' as const, schema: { type: 'object', properties: {} } })); } }],
    async discloseForPlanning() { return { version: 1, refs: { OUTLOOK_CREATE_DRAFT: 'cap:resolved:outlook_create_draft' },
      blockers: { GOOGLECALENDAR_CREATE_EVENT: { code: 'account_selection_required', choices: ['calendar@fixture.invalid'], reason: 'review_unavailable' } } }; },
  });
  const body = JSON.parse((await handler({ query: 'create provider item', limit: 8 })).content[0]!.text);
  assert.equal(body.results[0].capabilityRef, 'cap:resolved:outlook_create_draft');
  assert.match(body.hint, /work_call/);
  assert.match(body.hint, /Only if you select an unresolved result/);
  assert.doesNotMatch(body.hint, /Ask the user|Retry the identical account_selection/);
  const blocked = body.results.find((row: { name: string }) => row.name === 'GOOGLECALENDAR_CREATE_EVENT');
  assert.equal(blocked.planningRefStatus, 'account_selection_required');
  assert.equal(blocked.accountSelectionReason, 'review_unavailable');
  assert.match(blocked.accountSelectionNextStep, /Retry the identical account_selection once/);
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

test('compact oversized schema keeps real properties whose names match annotation keywords', async () => {
  const name = 'ANNOTATION_NAMED_FIELDS';
  const schema = {
    type: 'object',
    description: 'root annotation '.repeat(4_000),
    required: ['description', 'title', 'default', 'payload'],
    additionalProperties: false,
    properties: {
      description: { type: 'string', description: 'field annotation '.repeat(500) },
      title: { type: 'string', title: 'field title annotation'.repeat(500) },
      default: { type: 'string', default: 'field default annotation'.repeat(500) },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: ['description'],
        const: {
          description: 'instance description',
          title: 'instance title',
          default: 'instance default',
        },
        enum: [{
          description: 'enum description',
          title: 'enum title',
          default: 'enum default',
        }],
        properties: {
          description: { type: 'string', description: 'nested annotation '.repeat(500) },
        },
      },
    },
  };
  const t = captureToolSearch(new Set(['tool_search']), false, [{
    kind: 'authorized_composio',
    async search() {
      return [{ name, summary: 'Annotation-name preservation proof', schema, carrier: 'work_call', score: 1 }];
    },
  }]);

  const raw = await t.handler({ query: name, limit: 1 });
  const body = JSON.parse(raw.content[0].text) as {
    schemas: Record<string, any>;
    schema_handles?: Record<string, unknown>;
  };
  const compact = body.schemas[name];
  assert.ok(body.schema_handles?.[name], 'the lossless original remains content-addressable');
  assert.ok(compact, 'annotation stripping should leave a bounded structural preview inline');
  assert.deepEqual(Object.keys(compact.properties).sort(), ['default', 'description', 'payload', 'title']);
  assert.ok(compact.properties.payload.properties.description);
  assert.equal(compact.description, undefined, 'the schema-node annotation is removed');
  assert.equal(compact.properties.description.description, undefined, 'nested schema-node annotations are removed');
  assert.equal(compact.properties.title.title, undefined, 'title annotations are removed without deleting the title field');
  assert.equal(compact.properties.default.default, undefined, 'default annotations are removed without deleting the default field');
  assert.deepEqual(compact.properties.payload.const, {
    description: 'instance description',
    title: 'instance title',
    default: 'instance default',
  }, 'const instance JSON is never traversed as a schema');
  assert.deepEqual(compact.properties.payload.enum, [{
    description: 'enum description',
    title: 'enum title',
    default: 'enum default',
  }], 'enum instance JSON is never traversed as a schema');
});

test('TIERED RANKING: an acquired live-read outranks fuzzy Composio membership on the same planning query', async () => {
  const { registerToolSearchTool } = await import('./tool-search-tool.js');
  const { AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE } = await import(
    '../runtime/harness/live-read-planning-authority.js'
  );
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'live-read-rank-pin', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [
      {
        kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
        search: async () => [{
          name: 'acquired_live_read',
          summary: 'Current attested read capability acquired_live_read',
          schema: { type: 'object', properties: { query: { type: 'string' } } },
          carrier: 'work_call',
          score: 1,
        }],
      },
      {
        kind: 'authorized_composio',
        search: async () => [{
          name: 'UNRELATED_BROKER_QUERY_TABLE',
          summary: 'Fuzzy connected-app membership that does not answer this query.',
          schema: { type: 'object', properties: { spreadsheet_id: { type: 'string' } } },
          carrier: 'work_call',
          score: 1.05,
        }],
      },
    ],
    discloseForPlanning: async (candidates) => Object.fromEntries(
      candidates
        .filter((candidate) => candidate.sourceKind === AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE)
        .map((candidate) => [candidate.name, `cap:live:v1:test:${candidate.name}`]),
    ),
  });
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const result = await handler({
    query: 'query Salesforce open opportunities via sf CLI data query',
    role_key: 'clause-0:write',
    limit: 8,
  });
  const body = JSON.parse(result.content[0].text) as { results: Array<{ name: string }> };
  const names = body.results.map((hit) => hit.name);
  assert.equal(
    names[0],
    'acquired_live_read',
    `exact live-read acquisition must lead the card, got: ${names.join(', ')}`,
  );
  const broker = names.indexOf('UNRELATED_BROKER_QUERY_TABLE');
  assert.ok(broker > 0, 'fuzzy broker membership may still appear, but not as rank one');
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

test('first discovery preserves a proven ref when Composio fuzzy search and staging both wedge', async () => {
  const {
    registerToolSearchTool,
    CANDIDATE_SOURCE_SEARCH_DEADLINE_MS,
    PLANNING_DISCLOSURE_DEADLINE_MS,
  } = await import('./tool-search-tool.js');
  const { timeoutForTool } = await import('../runtime/harness/brackets.js');
  const outerHostBudgetMs = timeoutForTool('tool_search');
  const firstDiscoveryWallCeilingMs = 30_000;
  assert.ok(
    CANDIDATE_SOURCE_SEARCH_DEADLINE_MS + PLANNING_DISCLOSURE_DEADLINE_MS < outerHostBudgetMs,
    'internal discovery deadlines must leave room inside the outer host budget',
  );
  assert.ok(firstDiscoveryWallCeilingMs < outerHostBudgetMs,
    'the broker reserves at least half the host window for wrapper/model recovery overhead');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'first-discovery-combined-stall-pin', version: '1.0.0' });
  const independentlyProvenRefs = Object.freeze({
    LIVE_MCP_SEARCH: 'cap:resolved:live_mcp_search',
  });
  registerToolSearchTool(server as never, {
    candidateSources: [
      {
        kind: 'authorized_composio',
        search: () => new Promise(() => { /* provider fuzzy search never resolves */ }),
      },
      {
        kind: 'authorized_external_mcp',
        search: async () => [{
          name: 'LIVE_MCP_SEARCH',
          summary: 'A separately proven provider capability.',
          schema: { type: 'object', properties: { query: { type: 'string' } } },
          carrier: 'work_call',
          score: 1000,
        }],
      },
    ],
    // Production can disclose the native-MCP row independently; only the
    // Composio group needs the fresh account/staging read. A broker that hands
    // every adapter to one monolithic callback still wedges here and erases
    // the healthy ref, while per-source disclosure retains it.
    discloseForPlanning: async (candidates) => {
      if (candidates.some((candidate) => candidate.sourceKind === 'authorized_composio')) {
        await new Promise(() => { /* provider staging never resolves */ });
      }
      return Object.fromEntries(candidates
        .filter((candidate) => candidate.name === 'LIVE_MCP_SEARCH')
        .map((candidate) => [candidate.name, independentlyProvenRefs.LIVE_MCP_SEARCH]));
    },
  });
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;

  const startedAt = Date.now();
  const result = await handler({ query: 'read the live provider records', limit: 20 });
  const elapsedMs = Date.now() - startedAt;
  const body = JSON.parse(result.content[0].text) as {
    results: Array<{ name: string; capabilityRef?: string }>;
    unavailable?: Array<{ source: string; code: string; reason: string }>;
    next_cursor?: string;
  };
  assert.deepEqual({
    returnedWithinFirstDiscoveryBudget: elapsedMs < firstDiscoveryWallCeilingMs,
    capabilityRef: body.results.find((row) => row.name === 'LIVE_MCP_SEARCH')?.capabilityRef,
    composioTimeoutReported: body.unavailable?.some((entry) => (
      entry.source === 'authorized_composio' && /did not answer within/i.test(entry.reason)
    )) ?? false,
    nextCursor: body.next_cursor,
  }, {
    returnedWithinFirstDiscoveryBudget: true,
    capabilityRef: independentlyProvenRefs.LIVE_MCP_SEARCH,
    composioTimeoutReported: true,
    nextCursor: undefined,
  }, `first discovery took ${elapsedMs}ms; a wedged provider must neither consume the host window nor erase another candidate's usable exact ref`);
});

test('multi-account planning disclosure asks for the exact account instead of inviting a guessed ref', async () => {
  const { registerToolSearchTool } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'account-choice-pin', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [{
      kind: 'authorized_composio',
      search: async () => [{
        name: 'OUTLOOK_SEARCH_MESSAGES',
        summary: 'Read Outlook messages.',
        schema: { type: 'object', properties: { query: { type: 'string' } } },
        carrier: 'work_call',
        score: 1,
      }],
    }],
    discloseForPlanning: async () => ({
      version: 1,
      refs: {},
      blockers: {
        OUTLOOK_SEARCH_MESSAGES: {
          code: 'account_selection_required',
          choices: ['work@corp.example', 'personal@example.net'],
        },
      },
    }),
  });
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const result = await handler({ query: 'read my latest Outlook message', role_key: 'clause-0:read', limit: 8 });
  const body = JSON.parse(result.content[0].text) as {
    results: Array<{
      name: string;
      capabilityRef?: string;
      planningRefStatus?: string;
      accountChoices?: string[];
    }>;
    hint: string;
  };
  const outlook = body.results.find((entry) => entry.name === 'OUTLOOK_SEARCH_MESSAGES');
  assert.ok(outlook);
  assert.equal(outlook?.capabilityRef, undefined);
  assert.equal(outlook?.planningRefStatus, 'account_selection_required');
  assert.deepEqual(outlook?.accountChoices, ['work@corp.example', 'personal@example.net']);
  assert.match(body.hint, /Ask the user which exact connected account/i);
  assert.match(body.hint, /Do not call plan_task or invent a capabilityRef/i);
});

test('catalog-only account question shows the exact selected account on the resolved row and no unrelated identity', async () => {
  const {
    registerToolSearchTool,
    attachToolSearchSelectedAccountEvidence,
  } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'selected-account-evidence', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [{
      kind: 'authorized_composio',
      search: async () => [{
        name: 'OUTLOOK_SEARCH_MESSAGES',
        summary: 'Read Outlook messages.',
        schema: { type: 'object', properties: { query: { type: 'string' } } },
        carrier: 'work_call',
        score: 1,
      }],
    }],
    discloseForPlanning: async (candidates) => {
      const selected = candidates.find((candidate) => candidate.name === 'OUTLOOK_SEARCH_MESSAGES');
      assert.ok(selected);
      attachToolSearchSelectedAccountEvidence(selected!, {
        toolkit: 'outlook',
        label: 'Scorpion',
        email: 'Calendar@Scorpion.Example',
        connectionId: 'ca_scorpion_private_transport_id',
      });
      return { OUTLOOK_SEARCH_MESSAGES: 'cap:resolved:outlook_search_messages:fixture-scorpion' };
    },
  });
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const result = await handler({
    query: 'Identify which connected Outlook account you would use when I say my Scorpion Outlook account.',
    role_key: 'clause-0:read',
    limit: 8,
  });
  const raw = result.content[0].text;
  const body = JSON.parse(raw) as {
    results: Array<{
      name: string;
      capabilityRef?: string;
      selectedAccount?: {
        toolkit: string;
        accountIdentity: string;
        accountIdentityKind: string;
        email?: string;
        label?: string;
      };
    }>;
  };
  const outlook = body.results.find((row) => row.name === 'OUTLOOK_SEARCH_MESSAGES');
  assert.deepEqual(outlook?.selectedAccount, {
    toolkit: 'outlook',
    accountIdentity: 'calendar@scorpion.example',
    accountIdentityKind: 'email',
    email: 'calendar@scorpion.example',
    label: 'Scorpion',
  });
  assert.equal(typeof outlook?.capabilityRef, 'string');
  assert.doesNotMatch(raw, /breakthrough/i, 'an unrelated connected account must not leak');
  assert.doesNotMatch(raw, /ca_scorpion_private_transport_id/i,
    'a raw connection id is omitted when a stable email identity is known');
});

test('selected-account evidence is non-authoritative and stays hidden when no capabilityRef was disclosed', async () => {
  const {
    registerToolSearchTool,
    attachToolSearchSelectedAccountEvidence,
  } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'selected-account-no-ref', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [{
      kind: 'authorized_composio',
      search: async () => [{
        name: 'OUTLOOK_SEARCH_MESSAGES',
        summary: 'Read Outlook messages.',
        schema: { type: 'object', properties: {} },
        carrier: 'work_call',
        score: 1,
      }],
    }],
    discloseForPlanning: async (candidates) => {
      attachToolSearchSelectedAccountEvidence(candidates[0]!, {
        toolkit: 'outlook',
        label: 'Breakthrough',
        email: 'personal.calendar@example.invalid',
      });
      return {};
    },
  });
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const result = await handler({ query: 'inspect Outlook capability readiness', role_key: 'clause-0:read', limit: 8 });
  const body = JSON.parse(result.content[0].text) as {
    results: Array<{ name: string; capabilityRef?: string; selectedAccount?: unknown }>;
  };
  const outlook = body.results.find((row) => row.name === 'OUTLOOK_SEARCH_MESSAGES');
  assert.equal(outlook?.capabilityRef, undefined);
  assert.equal(outlook?.selectedAccount, undefined,
    'identity evidence cannot make an undisclosed row look resolved');
});

test('a named candidate-source unavailability reaches the model, never as silent emptiness', async () => {
  // Regression pin (2026-08-26): "the provider did not answer" and "no such
  // capability exists" were the same empty array to every caller. A live
  // Google Sheets connection went unfound this way — five searches Composio
  // could not reach, reported exactly like five searches that proved nothing
  // existed — and the model guessed a reference that was never disclosed.
  const { registerToolSearchTool, CandidateSourceUnavailableError } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'unavailable-pin', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [
      {
        kind: 'authorized_composio',
        search: async () => {
          throw new CandidateSourceUnavailableError('no_connections', 'No Composio toolkits are connected.');
        },
      },
    ],
  } as never);
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const result = await handler({ query: 'zzz-no-such-builtin-matches-zzz', limit: 8 });
  const body = JSON.parse(result.content[0].text) as {
    unavailable?: Array<{ source: string; reason: string }>;
    hint: string;
  };
  assert.deepEqual(body.unavailable, [
    {
      source: 'authorized_composio',
      code: 'no_connections',
      reason: 'No Composio toolkits are connected.',
      dependencySubject: {
        version: 1,
        kind: 'provider_reconnect_and_rerun',
        source: 'authorized_composio',
        query: 'zzz-no-such-builtin-matches-zzz',
      },
    },
  ]);
  assert.match(body.hint, /Could not reach/);
  assert.doesNotMatch(body.hint, /not disclosed/i);
});

test('an unexpected candidate-source throw is still a named unavailability, not silence', async () => {
  const { registerToolSearchTool } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'unavailable-generic-pin', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [
      { kind: 'authorized_external_mcp', search: async () => { throw new Error('ECONNRESET'); } },
    ],
  } as never);
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const result = await handler({ query: 'zzz-no-such-builtin-matches-zzz', limit: 8 });
  const body = JSON.parse(result.content[0].text) as {
    unavailable?: Array<{ source: string; reason: string }>;
    hint: string;
  };
  assert.equal(body.unavailable?.length, 1);
  assert.equal(body.unavailable?.[0]?.source, 'authorized_external_mcp');
  assert.match(body.hint, /Could not reach/);
});

test('an unavailable source does not shadow a healthy one, and an exact hit outranks a co-occurring outage', async () => {
  const { registerToolSearchTool, CandidateSourceUnavailableError } = await import('./tool-search-tool.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'unavailable-mixed-pin', version: '1.0.0' });
  registerToolSearchTool(server as never, {
    candidateSources: [
      {
        kind: 'authorized_composio',
        search: async () => { throw new CandidateSourceUnavailableError('search_failed', 'Composio search failed.'); },
      },
      {
        kind: 'authorized_external_mcp',
        // A dominant score, so this candidate's rank against an arbitrary
        // built-in catalog is never what this test is actually about.
        search: async () => [{ name: 'LIVE_MCP_OP', summary: 'A healthy MCP source answers.', score: 1000 }],
      },
    ],
  } as never);
  const handler = (server as never as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.tool_search.handler;
  const result = await handler({ query: 'zzz-no-such-builtin-matches-zzz', limit: 8 });
  const body = JSON.parse(result.content[0].text) as {
    results: Array<{ name: string }>;
    unavailable?: Array<{ source: string; reason: string }>;
  };
  assert.equal(body.unavailable?.length, 1);
  assert.equal(body.unavailable?.[0]?.source, 'authorized_composio');
  assert.ok(body.results.some((row) => row.name === 'LIVE_MCP_OP'), 'a source that answered is unaffected by a sibling outage');
});
