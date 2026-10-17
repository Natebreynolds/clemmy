import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const { appendEvent, beginRunAttempt, createSession, listEvents, openEventLog, recordRunAttemptUserInput } = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { z } = await import('zod');
const { toolSchemaFingerprint } = await import('../agents/capability-envelope.js');
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

test('MCP tool_search finds the whole brain-lane catalog; the registered subset only bounds direct registration', async () => {
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
  assert.ok(registered.file_query, 'the landed-result query floor remains available (2026-08-18)');
  assert.equal(registered.workflow_update, undefined);

  const result = await registered.tool_search.handler({ query: 'update a workflow', limit: 20 });
  const body = JSON.parse(result.content[0].text) as { results: Array<{ name: string }> };
  // THE CLEAN LOOP (live 2026-08-19 session-fixture-tool-search): search sees the whole
  // brain-lane catalog — finding is free, the gates gate the CALL. The old
  // scoping made her own workflow tools unfindable for 40 straight searches.
  assert.equal(body.results.some((hit) => hit.name === 'workflow_update'), true,
    'her own catalog is findable even when this surface registered a narrow subset');
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

test('modern MCP registration preserves original arguments and exact lease/session/source/run context', async () => {
  const anchor = anchoredSession('inspect a controlled modern tool context');
  const lease = activateDispatchLease({ sessionId: anchor.sessionId, scopeId: `${anchor.sessionId}::modern-query` });
  const runScopeId = `${anchor.sessionId}::run`;
  const observed: string[] = [];
  const server = createClementineMcpServer({
    ...anchor, dispatchLease: lease, runScopeId, workerScope: true, directOrchestrator: false,
    workflowRunId: 'fixture-workflow-run', workflowName: 'fixture-workflow', stepId: 'fixture-step',
    mcpToolScope: null, allowedTools: ['modern_context_probe'], onToolRegistered: name => observed.push(name),
  });
  const payload = { args_json: JSON.parse('{"__proto__":{"retained":true},"literal":"unchanged"}') };
  const extra = { requestId: 'fixture-request' };
  let calls = 0;
  let bodyCounter: { calls: number } | undefined;
  server.registerTool('modern_context_probe', {
    description: 'Read the controlled context.', inputSchema: z.strictObject({ args_json: z.unknown() }),
  }, async (input, receivedExtra) => {
    calls += 1;
    assert.equal(input, payload, 'registration wrapper never copies/parses the invocation input');
    assert.equal(input.args_json, payload.args_json);
    assert.ok(Object.hasOwn(input.args_json as object, '__proto__'));
    assert.equal(receivedExtra, extra, 'SDK callback extras remain untouched');
    const ctx = harnessRunContextStorage.getStore();
    assert.ok(ctx);
    assert.equal(ctx.sessionId, anchor.sessionId);
    assert.equal(ctx.sourceUserSeq, anchor.sourceUserSeq);
    assert.equal(ctx.behaviorScopeId, runScopeId);
    assert.equal(ctx.dispatchLease, lease);
    assert.equal(ctx.runAttemptId, lease.runAttemptId);
    assert.equal(ctx.workerScope, true);
    assert.equal(ctx.directOrchestrator, false);
    assert.equal(ctx.mcpToolScope, null);
    assert.equal(ctx.counter.calls, 0);
    ctx.counter.increment();
    bodyCounter = ctx.counter;
    assert.deepEqual(getToolOutputContext(), { sessionId: anchor.sessionId, sourceUserSeq: anchor.sourceUserSeq,
      runScopeId, toolName: 'modern_context_probe', workflowRunId: 'fixture-workflow-run',
      workflowName: 'fixture-workflow', stepId: 'fixture-step' });
    return { content: [{ type: 'text' as const, text: 'controlled context received' }] };
  });
  const registered = (server as any)._registeredTools;
  await registered.modern_context_probe.handler(payload, extra);
  assert.equal(calls, 1);
  assert.equal(bodyCounter?.calls, 1);
  assert.equal(observed.filter(name => name === 'modern_context_probe').length, 1);
  revokeDispatchLease(lease);
  await assert.rejects(registered.modern_context_probe.handler(payload, extra), StaleDispatchLeaseError);
  assert.equal(calls, 1, 'stale modern callback must fail before body observations/counter work');
  assert.equal(bodyCounter?.calls, 1);
});

test('modern and legacy registrations share filtering, exact schema observation and additive always-load metadata', async () => {
  const observed: string[] = [];
  const server = createClementineMcpServer({
    sessionId: 'fixture-modern-registration',
    allowedTools: ['modern_allowed', 'legacy_allowed', 'tool_search', 'call_tool'],
    alwaysLoadTools: ['modern_allowed'], deferredTools: ['workspace_roots'],
    onToolRegistered: name => observed.push(name),
  });
  const schema = z.strictObject({ literal: z.string() });
  const description = 'Return a controlled literal.';
  server.registerTool('modern_allowed', { description, inputSchema: schema, _meta: { fixture: 'retained' } },
    async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  server.tool('legacy_allowed', 'A legacy control.', {}, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  const refused = server.registerTool('modern_denied', { inputSchema: schema },
    async () => { throw new Error('filtered handler must never register'); });
  const registered = (server as any)._registeredTools;
  assert.equal(refused, undefined);
  assert.equal(registered.modern_denied, undefined);
  assert.equal(observed.filter(name => name === 'modern_denied').length, 0);
  assert.equal(observed.filter(name => name === 'modern_allowed').length, 1);
  assert.equal(observed.filter(name => name === 'legacy_allowed').length, 1);
  assert.equal(registered.modern_allowed.inputSchema, schema, 'full strict schema is preserved for the SDK');
  assert.deepEqual(registered.modern_allowed._meta, { fixture: 'retained', 'anthropic/alwaysLoad': true });
  assert.equal(registered.legacy_allowed._meta?.['anthropic/alwaysLoad'], undefined);
  assert.equal(await initializeClementineMcpCapabilityAuthority(server), true);
  const envelope = await boundClementineMcpCapabilityEnvelope(server);
  assert.equal(envelope?.capabilities.find(capability => capability.name === 'modern_allowed')?.schemaFingerprint,
    toolSchemaFingerprint({ name: 'modern_allowed', description, parameters: z.toJSONSchema(schema) }),
    'sealed callable schema must come from config.inputSchema, not the registration config wrapper');
  assert.equal(envelope?.capabilities.some(capability => capability.name === 'modern_denied'), false);
});

test('modern deferred carrier admits during its exact lease and cannot acquire after that lease is revoked', async () => {
  const anchor = anchoredSession('list the workspace roots using a controlled deferred carrier');
  const lease = activateDispatchLease({ sessionId: anchor.sessionId, scopeId: `${anchor.sessionId}::deferred-query` });
  const server = createClementineMcpServer({ ...anchor, dispatchLease: lease,
    allowedTools: ['tool_search', 'call_tool'], deferredTools: ['workspace_roots'] });
  assert.equal(await initializeClementineMcpCapabilityAuthority(server), true);
  assert.equal((await boundClementineMcpCapabilityRevision(server))?.revision, 1);
  const registered = (server as any)._registeredTools;
  const output = await registered.call_tool.handler({ name: 'workspace_roots', args_json: {} });
  assert.doesNotMatch(output.content[0].text, /requires_readmission|not_reachable|missing_session_context|arg_validation/i);
  assert.match(output.content[0].text, /clementine-next|clemmy-mcp-surface/i);
  assert.equal((await boundClementineMcpCapabilityRevision(server))?.revision, 2);
  assert.equal((await boundClementineMcpCapabilityRevision(server))?.bound.includes('workspace_roots'), true);
  revokeDispatchLease(lease);
  await assert.rejects(registered.call_tool.handler({ name: 'workspace_roots', args_json: {} }), StaleDispatchLeaseError);
  assert.equal((await boundClementineMcpCapabilityRevision(server))?.revision, 2,
    'a stale physical server cannot mutate the sealed revision chain');
});

const claudeCorrelation = await import('../runtime/harness/claude-local-tool-correlation.js');
const spaceStore = await import('../spaces/store.js');
const spaceCommit = await import('../runtime/harness/host-local-write-commit.js');
const { _setWorkspaceDeliverablesReaderForTests } = await import('../spaces/workspace-deliverables-check.js');
const wireExtra = (id: string) => ({ requestId: `rpc-${id}`, _meta: { 'claudecode/toolUseId': id } });
const mcpText = (value: any): string => value.content[0].text;
let spaceFixtureFetch: typeof fetch | undefined;
let unmockedSpaceFetches = 0;
test.beforeEach(context => {
  if (!context.name.startsWith('Claude Space') && !context.name.startsWith('Claude metadata id')) return;
  spaceFixtureFetch = globalThis.fetch;
  unmockedSpaceFetches = 0;
  globalThis.fetch = (async () => { unmockedSpaceFetches++; throw new Error('Unexpected provider/network transport in controlled Space identity fixture.'); }) as typeof fetch;
  _setWorkspaceDeliverablesReaderForTests(async (_system, user) => {
    const packet = JSON.parse(user);
    return { bindingDigest: packet.bindingDigest, assessmentComplete: false,
      assessedCriteriaIds: packet.workspace.successCriteria.map((item: { id: string }) => item.id),
      deliverables: [{ deliverable: 'Semantic and visual review are outside this call identity control.',
        status: 'unverified', requiredEvidence: 'render_readback', evidenceIds: [], gap: 'This fixture proves call identity and saved bytes only.' }] };
  });
});
test.afterEach(context => {
  if (!context.name.startsWith('Claude Space') && !context.name.startsWith('Claude metadata id')) return;
  _setWorkspaceDeliverablesReaderForTests(null);
  if (spaceFixtureFetch) globalThis.fetch = spaceFixtureFetch;
  spaceFixtureFetch = undefined;
  assert.equal(unmockedSpaceFetches, 0, 'no unmocked provider/network attempt');
});

function spaceIdentityFixture(route: 'direct' | 'carrier', suffix: string) {
  const session = createSession({ kind: 'chat' });
  const attempt = beginRunAttempt(session.id, { runId: `space-proof-${suffix}` });
  const source = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: 'Create and edit only the controlled call identity Workspace.' } });
  assert.ok(recordTurnGraphShadow({ identity: { sessionId: session.id, turn: 1, sourceUserSeq: source.seq } }));
  const anchor = { sessionId: session.id, sourceUserSeq: source.seq };
  const runScopeId = `${anchor.sessionId}::space-identity`;
  const lease = activateDispatchLease({ sessionId: anchor.sessionId, scopeId: `${runScopeId}::query`, runAttemptId: attempt.attemptId });
  const server = createClementineMcpServer({ ...anchor, runScopeId, dispatchLease: lease,
    claudeSpaceCallIdentity: true, workerScope: true, directOrchestrator: false,
    allowedTools: route === 'direct' ? ['space_save', 'space_get'] : ['tool_search', 'call_tool'],
    ...(route === 'carrier' ? { deferredTools: ['space_save', 'space_get'] } : {}),
  });
  const registered = (server as any)._registeredTools;
  const toolName = route === 'direct' ? 'space_save' : 'call_tool';
  const args = { slug: `identity-${suffix}`, title: 'Controlled identity', objective: null,
    view_html: '<html><body><p>Literal null, {"one":null} and &lt;tag&gt;.</p></body></html>',
    initial_data_json: JSON.parse('{"__proto__":{"literal":true},"nullable":null,"_mobile":{"records":{"items":[{"primary":"Controlled","body":"Complete"}]}}}'),
  };
  const wire = (value: unknown) => route === 'direct' ? value : { name: 'space_save', args_json: value };
  const admit = (id: string, value: unknown = wire(args), overrides: Record<string, unknown> = {}) => {
    const admission = claudeCorrelation.recordClaudeLocalPermissionAdmission({ ...anchor, runScopeId,
      dispatchLease: lease, directOrchestrator: false, providerCallId: id,
      sdkToolName: `mcp__clementine-local__${toolName}`, input: value, ...overrides,
    });
    assert.ok(admission, 'controlled final permission was durably admitted');
    return admission;
  };
  return { ...anchor, runScopeId, lease, registered, toolName, args, wire, admit,
    invoke: (value: unknown, extra?: unknown) => registered[toolName].handler(value, extra) };
}

for (const route of ['direct', 'carrier'] as const) {
  test(`Claude Space ${route} binds real saved bytes and settlement to the exact metadata id; A replay cannot steal pending B`, async () => {
    const f = spaceIdentityFixture(route, `positive-${route}`);
    const idA = `space-${route}-A`;
    f.admit(idA);
    const originalWire = JSON.stringify(f.wire(f.args));
    const first = await f.invoke(f.wire(f.args), wireExtra(idA));
    const proof = spaceCommit.parseHostLocalWriteCommitFacts(mcpText(first));
    assert.ok(proof, mcpText(first));
    assert.equal(spaceCommit.readCommittedArtifactContent(proof).verified, true);
    assert.equal(readFileSync(spaceStore.resolveInSpace(f.args.slug, 'view/index.html'), 'utf8'), f.args.view_html);
    const data = JSON.parse(readFileSync(spaceStore.resolveInSpace(f.args.slug, 'data.json'), 'utf8'));
    assert.equal(Object.hasOwn(data, '__proto__'), true);
    assert.equal(data.nullable, null);
    assert.equal(JSON.stringify(f.wire(f.args)), originalWire, 'no argument rewriting at the metadata bridge');
    const ledger = () => openEventLog().prepare(`SELECT logical_tool_call_id, state, tool_name
      FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?`).all(f.sessionId, f.sourceUserSeq) as any[];
    assert.deepEqual(ledger().map(row => [row.logical_tool_call_id, row.state, row.tool_name]), [[idA, 'settled', 'space_save']]);
    assert.equal((openEventLog().prepare(`SELECT outcome_kind FROM logical_call_settlements
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`).get(f.sessionId, f.sourceUserSeq, idA) as any)?.outcome_kind, 'succeeded');
    const canonical = listEvents(f.sessionId, { types: ['tool_called'] }).filter(event => event.data.accounting === 'top_level');
    assert.deepEqual(canonical.map(event => event.data.callId), [idA]);

    // Same-payload B is a distinct pending permission. Replayed A must not be
    // guessed to be B just because B is the sole remaining unclaimed marker.
    const idB = `space-${route}-B`;
    const markerB = f.admit(idB);
    const saved = spaceStore.spaceStore.snapshot(f.args.slug);
    assert.ok(saved);
    const replay = await f.invoke(f.wire(f.args), wireExtra(idA));
    assert.equal(replay.isError, true);
    assert.match(mcpText(replay), /already claimed|uncertain/);
    assert.equal(spaceStore.spaceStore.snapshot(f.args.slug)?.revision, saved.revision);
    assert.equal(ledger().length, 1, 'replayed A opens no second inner call');
    assert.equal(listEvents(f.sessionId, { types: ['tool_called'] }).some(event =>
      event.data.claudePermissionAdmissionEventId === markerB.id), false, 'B permission was not consumed by A replay');
    const second = await f.invoke(f.wire(f.args), wireExtra(idB));
    assert.ok(spaceCommit.parseHostLocalWriteCommitFacts(mcpText(second)), mcpText(second));
    assert.deepEqual(ledger().map(row => row.logical_tool_call_id).sort(), [idA, idB].sort());

    const updated = { slug: f.args.slug, title: 'Independent change' };
    const idC = `space-${route}-C`;
    f.admit(idC, f.wire(updated));
    assert.ok(spaceCommit.parseHostLocalWriteCommitFacts(mcpText(await f.invoke(f.wire(updated), wireExtra(idC)))));
    assert.equal(spaceStore.spaceStore.get(f.args.slug)?.title, 'Independent change');
    assert.equal(ledger().length, 3, 'independent exact metadata identity owns its own settled operation');
    revokeDispatchLease(f.lease);
  });

  test(`Claude Space ${route} refuses missing, foreign, changed, duplicate, source/scope/lease metadata before the producer`, async () => {
    for (const mode of ['missing', 'foreign-id', 'null-removed', 'literal-changed', 'proto-removed', 'duplicate', 'source', 'scope', 'lease'] as const) {
      const f = spaceIdentityFixture(route, `${route}-${mode}`);
      const id = `space-${route}-${mode}`;
      let invoke = f.invoke;
      if (mode === 'source') {
        // A valid final ALLOW for A cannot be donated to another source row.
        f.admit(id);
        const other = appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Separate controlled request.' } });
        assert.equal(claudeCorrelation.claimClaudeLocalPermissionAdmission({ sessionId: f.sessionId,
          sourceUserSeq: other.seq, runScopeId: f.runScopeId, toolName: f.toolName, rawInput: f.wire(f.args),
          directOrchestrator: false, dispatchLease: f.lease, providerCallId: id }), null);
        const otherServer = createClementineMcpServer({ sessionId: f.sessionId, sourceUserSeq: other.seq,
          runScopeId: f.runScopeId, dispatchLease: f.lease, claudeSpaceCallIdentity: true,
          allowedTools: route === 'direct' ? ['space_save'] : ['tool_search', 'call_tool'],
          ...(route === 'carrier' ? { deferredTools: ['space_save'] } : {}),
        });
        invoke = (value, extra) => (otherServer as any)._registeredTools[f.toolName].handler(value, extra);
      } else if (mode === 'scope') f.admit(id, f.wire(f.args), { runScopeId: `${f.runScopeId}:other` });
      else if (mode === 'lease') {
        const other = activateDispatchLease({ sessionId: f.sessionId, scopeId: `${f.runScopeId}:other-query`, runAttemptId: f.lease.runAttemptId });
        f.admit(id, f.wire(f.args), { dispatchLease: other });
        revokeDispatchLease(other);
      } else f.admit(id);
      if (mode === 'duplicate') f.admit(id);
      const changed = JSON.parse(JSON.stringify(f.args));
      if (mode === 'null-removed') delete changed.initial_data_json.nullable;
      if (mode === 'literal-changed') changed.view_html = changed.view_html.replace('null', 'changed');
      if (mode === 'proto-removed') delete changed.initial_data_json.__proto__;
      const out = await invoke(f.wire(changed), mode === 'missing' ? { requestId: id }
        : wireExtra(mode === 'foreign-id' ? `${id}:foreign` : id));
      assert.equal(out.isError, true, mode);
      assert.equal(spaceStore.spaceStore.get(f.args.slug), undefined, `no saved artifact for ${mode}`);
      assert.equal((openEventLog().prepare('SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ?').get(f.sessionId) as any)?.n, 0,
        `no bracket/producer crossing for ${mode}`);
      revokeDispatchLease(f.lease);
    }
  });
}

test('Claude metadata id is transport-only own data, and reads retain their ordinary no-marker path', async () => {
  for (const extra of [undefined, {}, { _meta: {} }, { _meta: { 'claudecode/toolUseId': ['forged'] } },
    { _meta: { 'claudecode/toolUseId': ' leading' } }, Object.create({ _meta: { 'claudecode/toolUseId': 'inherited' } }),
    { _meta: Object.create({ 'claudecode/toolUseId': 'inherited' }) }]) {
    assert.equal(claudeCorrelation.claudeLocalMcpProviderCallId(extra), undefined);
  }
  assert.equal(claudeCorrelation.claudeLocalMcpProviderCallId(wireExtra('exact-id')), 'exact-id');
  const f = spaceIdentityFixture('direct', 'read-compatible');
  const result = await f.registered.space_get.handler({ slug: 'does-not-exist', metadata_only: true });
  assert.doesNotMatch(mcpText(result), /space_call_identity_unavailable/);
  revokeDispatchLease(f.lease);
});

test('Claude Space revoked query refuses before the producer while non-Claude MCP retains its existing route', async () => {
  const f = spaceIdentityFixture('direct', 'revoked-query');
  f.admit('revoked-space');
  revokeDispatchLease(f.lease);
  await assert.rejects(f.invoke(f.wire(f.args), wireExtra('revoked-space')), StaleDispatchLeaseError);
  assert.equal(spaceStore.spaceStore.get(f.args.slug), undefined);
  const server = createClementineMcpServer({ allowedTools: ['space_save'], claudeSpaceCallIdentity: false });
  const output = await (server as any)._registeredTools.space_save.handler({ slug: 'non-claude-compatible',
    title: 'Existing transport', view_html: '<html><body><p>Controlled compatibility.</p></body></html>' });
  assert.ok(spaceCommit.parseHostLocalWriteCommitFacts(mcpText(output)), mcpText(output));
});
