import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-surface-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { createClementineMcpServer } = await import('./mcp-server.js');
const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
const { getToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const {
  activateDispatchLease,
  revokeDispatchLease,
  StaleDispatchLeaseError,
} = await import('../runtime/harness/dispatch-lease.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('MCP tool_search is scoped to tools the active server actually registered', async () => {
  const server = createClementineMcpServer({
    sessionId: 'mcp-surface-test',
    allowedTools: ['memory_recall_all', 'tool_search'],
  });
  const registered = (server as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }>;

  assert.ok(registered.memory_recall_all);
  assert.ok(registered.tool_search);
  assert.ok(registered.ping, 'the health floor remains available');
  assert.equal(registered.workflow_update, undefined);

  const result = await registered.tool_search.handler({ query: 'update a workflow', limit: 20 });
  const body = JSON.parse(result.content[0].text) as { results: Array<{ name: string }> };
  const actualRegisteredCatalogNames = new Set(['memory_recall_all', 'ping', 'tool_search']);
  assert.ok(
    body.results.every((hit) => actualRegisteredCatalogNames.has(hit.name)),
    `unexpected search results: ${JSON.stringify(body.results)}`,
  );
  assert.equal(body.results.some((hit) => hit.name === 'workflow_update'), false);
});

test('MCP always-load metadata is additive and leaves unselected tools deferred', () => {
  const server = createClementineMcpServer({
    sessionId: 'mcp-deferral-test',
    alwaysLoadTools: ['memory_recall_all', 'tool_search'],
  });
  const registered = (server as any)._registeredTools as Record<string, { _meta?: Record<string, unknown> }>;

  assert.equal(registered.memory_recall_all?._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(registered.tool_search?._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(registered.workflow_update?._meta?.['anthropic/alwaysLoad'], undefined);
});

test('MCP schema-on-demand omits deferred schemas but search → call_tool still dispatches them', async () => {
  const session = createSession({ kind: 'chat' });
  const server = createClementineMcpServer({
    sessionId: session.id,
    allowedTools: ['memory_recall_all', 'tool_search', 'call_tool'],
    deferredTools: ['workspace_roots'],
  });
  const registered = (server as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }>;

  assert.ok(registered.memory_recall_all);
  assert.ok(registered.tool_search);
  assert.ok(registered.call_tool);
  assert.equal(registered.workspace_roots, undefined, 'deferred schema must not enter the MCP surface');

  const searched = await registered.tool_search.handler({ query: 'list workspace roots', limit: 20 });
  const searchBody = JSON.parse(searched.content[0].text) as {
    results: Array<{ name: string }>;
    schemas: Record<string, unknown>;
    hint: string;
  };
  assert.equal(searchBody.results.some((hit) => hit.name === 'workspace_roots'), true);
  assert.ok(searchBody.schemas.workspace_roots, 'search returns the exact deferred schema');
  assert.match(searchBody.hint, /call_tool\(name, args_json\)/);

  const called = await registered.call_tool.handler({
    name: 'workspace_roots',
    args_json: '{}',
  });
  assert.doesNotMatch(called.content[0].text, /not_reachable|arg_validation|missing_session_context/i);
  assert.match(called.content[0].text, /clementine-next|clemmy-mcp-surface/i);
});

test('in-process MCP handlers inherit the exact SDK source turn', async () => {
  const server = createClementineMcpServer({
    sessionId: 'mcp-source-authority-test',
    sourceUserSeq: 91,
    allowedTools: ['source_authority_probe'],
  });
  server.tool(
    'source_authority_probe',
    'test-only source authority probe',
    {},
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          harnessSourceUserSeq: harnessRunContextStorage.getStore()?.sourceUserSeq ?? null,
          toolSourceUserSeq: getToolOutputContext()?.sourceUserSeq ?? null,
        }),
      }],
    }),
  );
  const registered = (server as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }>;
  const result = await registered.source_authority_probe.handler({});
  assert.deepEqual(JSON.parse(result.content[0].text), {
    harnessSourceUserSeq: 91,
    toolSourceUserSeq: 91,
  });
});

test('in-process MCP refuses a superseded SDK attempt before entering its handler', async () => {
  const session = createSession({ kind: 'chat' });
  const dispatchLease = activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::sdk`,
  });
  const server = createClementineMcpServer({
    sessionId: session.id,
    dispatchLease,
    allowedTools: ['lease_probe'],
  });
  let handlerCalls = 0;
  server.tool(
    'lease_probe',
    'test-only dispatch lease probe',
    {},
    async () => {
      handlerCalls += 1;
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );
  const registered = (server as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<unknown>;
  }>;

  await registered.lease_probe.handler({});
  assert.equal(handlerCalls, 1);
  revokeDispatchLease(dispatchLease);
  await assert.rejects(
    registered.lease_probe.handler({}),
    (err: unknown) => err instanceof StaleDispatchLeaseError,
  );
  assert.equal(handlerCalls, 1, 'stale call was rejected before handler bookkeeping/work');
});
