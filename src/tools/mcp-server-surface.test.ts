import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-surface-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  boundClementineMcpCapabilityEnvelope,
  boundClementineMcpCapabilityRevision,
  createClementineMcpServer,
  initializeClementineMcpCapabilityAuthority,
} = await import('./mcp-server.js');
const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
const { getToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { appendEvent, createSession } = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const {
  activateDispatchLease,
  revokeDispatchLease,
  StaleDispatchLeaseError,
} = await import('../runtime/harness/dispatch-lease.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * A dispatch that reaches the settlement spine needs the whole accepted-source
 * anchor: a real session, the accepted user input, and the persisted turn graph
 * for it. Half of it settles as `uncorrelated`, which the MCP surface renders
 * as tool-error TEXT — so a test that only inspects returned text can look
 * green while nothing dispatched.
 */
function anchoredSession(ask: string): { sessionId: string; sourceUserSeq: number } {
  const session = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ask },
  });
  const shadow = recordTurnGraphShadow({
    identity: { sessionId: session.id, turn: source.turn, sourceUserSeq: source.seq },
  });
  assert.ok(shadow, 'fixture persisted the turn graph for the accepted task');
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

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
  const anchor = anchoredSession('list the workspace roots for this install');
  const server = createClementineMcpServer({
    sessionId: anchor.sessionId,
    sourceUserSeq: anchor.sourceUserSeq,
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

  assert.equal(await initializeClementineMcpCapabilityAuthority(server), true);
  const envelope = await boundClementineMcpCapabilityEnvelope(server);
  const initialRevision = await boundClementineMcpCapabilityRevision(server);
  assert.ok(envelope?.capabilities.some((capability) => capability.name === 'workspace_roots'),
    'the deferred capability is absent from the sealed universe');
  assert.equal(initialRevision?.revision, 1);
  assert.equal(initialRevision?.bound.includes('workspace_roots'), false,
    'a deferred capability started active before acquisition');

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
  const acquiredRevision = await boundClementineMcpCapabilityRevision(server);
  assert.equal(acquiredRevision?.revision, 2);
  assert.equal(acquiredRevision?.bound.includes('workspace_roots'), true);

  await registered.call_tool.handler({ name: 'workspace_roots', args_json: '{}' });
  assert.equal((await boundClementineMcpCapabilityRevision(server))?.revision, 2,
    'duplicate acquisition churned the MCP revision');
});

test('MCP schema-on-demand fails closed when its exact universe cannot seal', async () => {
  const session = createSession({ kind: 'chat' });
  const server = createClementineMcpServer({
    sessionId: session.id,
    allowedTools: ['tool_search', 'call_tool'],
    deferredTools: ['test_only_missing_capability_descriptor'],
  });
  const registered = (server as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }>;
  assert.equal(await initializeClementineMcpCapabilityAuthority(server), false,
    'a universe with no exact descriptor sealed');
  const result = await registered.call_tool.handler({
    name: 'test_only_missing_capability_descriptor',
    args_json: '{}',
  });
  assert.match(result.content[0].text, /requires_readmission/i);
  assert.equal(await boundClementineMcpCapabilityRevision(server), null,
    'a refused seal still created dispatch authority');
});

test('two physical MCP servers keep capability revisions isolated', async () => {
  const make = () => {
    const anchor = anchoredSession('list the workspace roots for this install');
    return createClementineMcpServer({
      sessionId: anchor.sessionId,
      sourceUserSeq: anchor.sourceUserSeq,
      allowedTools: ['tool_search', 'call_tool'],
      deferredTools: ['workspace_roots'],
    });
  };
  const first = make();
  const second = make();
  await Promise.all([
    initializeClementineMcpCapabilityAuthority(first),
    initializeClementineMcpCapabilityAuthority(second),
  ]);
  const firstTools = (first as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<unknown>;
  }>;
  await firstTools.call_tool.handler({ name: 'workspace_roots', args_json: '{}' });
  assert.equal((await boundClementineMcpCapabilityRevision(first))?.revision, 2);
  assert.equal((await boundClementineMcpCapabilityRevision(second))?.revision, 1,
    'one physical query mutated another query\'s revision chain');
  assert.equal((await boundClementineMcpCapabilityRevision(second))?.bound.includes('workspace_roots'), false);
});

test('the real default Claude full universe seals and admits a deferred built-in', async () => {
  const { defaultClaudeAgentSdkAllowedLocalTools } = await import('../runtime/harness/claude-agent-sdk.js');
  const { claudeAgentSdkAdvertisedToolUniverse } = await import('../runtime/harness/claude-agent-brain.js');
  const fastAllow = defaultClaudeAgentSdkAllowedLocalTools('full');
  const universe = claudeAgentSdkAdvertisedToolUniverse('full', fastAllow, [], false);
  const firstClass = ['tool_search', 'call_tool'];
  const deferred = universe.filter((name) => !firstClass.includes(name));
  assert.ok(deferred.includes('run_worker'), 'fixture stopped matching the production full universe');
  assert.ok(deferred.includes('view_image'), 'fixture stopped matching the production MCP surface');
  assert.ok(deferred.includes('workspace_roots'), 'fixture needs a safe deferred dispatch probe');

  const anchor = anchoredSession('list the workspace roots for this install');
  const server = createClementineMcpServer({
    sessionId: anchor.sessionId,
    sourceUserSeq: anchor.sourceUserSeq,
    gatedMutations: true,
    allowedTools: firstClass,
    deferredTools: deferred,
  });
  assert.equal(await initializeClementineMcpCapabilityAuthority(server), true,
    'the production Claude full universe refused capability sealing');
  const envelope = await boundClementineMcpCapabilityEnvelope(server);
  const before = await boundClementineMcpCapabilityRevision(server);
  assert.ok(envelope?.capabilities.some((capability) => capability.name === 'run_worker'));
  assert.ok(envelope?.capabilities.some((capability) => capability.name === 'view_image'));
  assert.equal(before?.bound.includes('workspace_roots'), false);

  const registered = (server as any)._registeredTools as Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }>;
  const called = await registered.call_tool.handler({ name: 'workspace_roots', args_json: '{}' });
  assert.doesNotMatch(called.content[0].text, /requires_readmission|not_reachable/i);
  // The acquired capability must have actually RUN, not merely been admitted:
  // a settlement refusal comes back as ordinary tool text and would otherwise
  // satisfy every assertion above.
  assert.match(called.content[0].text, /clementine-next|clemmy-mcp-surface/i);
  const acquired = await boundClementineMcpCapabilityRevision(server);
  assert.equal(acquired?.revision, (before?.revision ?? 0) + 1);
  assert.equal(acquired?.bound.includes('workspace_roots'), true);
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
