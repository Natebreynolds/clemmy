import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { Agent, Tool } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-action-control-surface-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-action-control-surface\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { requireActionExpectedWorkActivation } = await import('../runtime/harness/action-expected-work-boundary.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
const guardrail = await import('../runtime/harness/tool-guardrail.js');
const { discoveryGovernor } = await import('../runtime/harness/discovery-governor.js');
const { buildOrchestratorAgent } = await import('./orchestrator.js');
const { clearFocus, createFocus, listFocuses } = await import('../memory/focus.js');
const { _setCodeModeToolsForTests } = await import('../tools/code-mode-tool.js');
const { registerToolSearchTool } = await import('../tools/tool-search-tool.js');

type Invokable = Tool<unknown> & {
  invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
};

function invokable(agent: Agent<any, any>, name: string): Invokable {
  const found = (agent.tools ?? []).find((toolRef) => toolRef.name === name) as Invokable | undefined;
  assert.ok(found, `missing ${name} on production action surface`);
  return found;
}

function namesOf(agent: Agent<any, any>): Set<string> {
  return new Set((agent.tools ?? []).map((toolRef) => toolRef.name).filter(Boolean));
}

async function acceptedAction(
  text: string,
  pinnedTools: string[] = [],
  taskContinuation?: import('../types.js').TaskContinuationContext,
  seedTaskState?: (sessionId: string) => void,
): Promise<{ agent: Agent<any, any>; sessionId: string; sourceUserSeq: number; turn: number }> {
  const session = eventlog.createSession({ kind: 'chat', channel: 'test' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const shadow = recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  });
  assert.ok(shadow, 'fixture could not persist its accepted TurnGraph');
  assert.equal(
    requireActionExpectedWorkActivation({ sessionId: session.id, sourceUserSeq: source.seq }).status,
    'action_active',
  );
  discoveryGovernor.initializeTask({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    knownCapability: pinnedTools.length > 0,
  });
  seedTaskState?.(session.id);
  const agent = await buildOrchestratorAgent({
    userInput: text,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedRoute: 'act',
    allowToolJit: true,
    turnCandidates: {
      candidates: [],
      requirements: [],
      matches: [],
      pinnedTools,
      semanticApplied: false,
    },
    ...(taskContinuation ? { taskContinuation, taskContinuationResolved: true as const } : {}),
  });
  return { agent, sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
}

async function searchExact(
  fixture: Awaited<ReturnType<typeof acceptedAction>>,
  name: string,
): Promise<{ results: Array<{ name: string; carrier?: string }>; schemas: Record<string, unknown>; hint: string }> {
  const output = await withHarnessRunContext(
    {
      sessionId: fixture.sessionId,
      sourceUserSeq: fixture.sourceUserSeq,
      turn: fixture.turn,
      counter: new ToolCallsCounter(1_000),
    },
    () => invokable(fixture.agent, 'tool_search').invoke(
      { context: {
        sessionId: fixture.sessionId,
        sourceUserSeq: fixture.sourceUserSeq,
        turn: fixture.turn,
      } },
      // Codex strict tool schemas represent an omitted optional as explicit
      // null. The MCP/Claude spelling may omit role_key; this direct OpenAI
      // invocation must exercise the exact wire shape the model receives.
      JSON.stringify({ query: name, role_key: null, limit: 2 }),
      { toolCall: { callId: `search-${name}` } },
    ),
  );
  const rendered = String(output);
  assert.match(rendered, /^\{/, `tool_search(${name}) returned a non-JSON refusal: ${rendered}`);
  return JSON.parse(rendered);
}

beforeEach(() => {
  eventlog.resetEventLog();
  for (const focus of listFocuses({ limit: 50 })) clearFocus(focus.id, 'abandoned');
  guardrail._resetAllTrackersForTests();
  guardrail._resetGuardrailScopeSignals();
  _setCodeModeToolsForTests(null);
});
after(() => {
  _setCodeModeToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('fresh accepted action subtracts dormant controls without opening archaeology', async () => {
  let controlDispatches = 0;
  _setCodeModeToolsForTests(new Map([['desktop_status', {
    name: 'desktop_status',
    invoke: async () => {
      controlDispatches += 1;
      return 'desktop-ok';
    },
  }]]));
  const fixture = await acceptedAction(
    'Create a recurring workflow that refreshes my dashboard, retain our procedure, and keep its Workspace editable.',
  );
  const names = namesOf(fixture.agent);
  const scope = eventlog.listEvents(fixture.sessionId, { types: ['tool_search_scope'] }).at(-1)?.data as {
    firstClassCount?: number;
    catalogCount?: number;
    estFirstClassTokens?: number;
    estCatalogTokens?: number;
  } | undefined;

  assert.ok(names.has('work_call'), 'business work keeps its one semantic carrier');
  assert.ok(names.has('call_tool'), 'deferred controls retain a same-turn carrier');
  assert.match(String(invokable(fixture.agent, 'call_tool').description ?? ''), /control/i);
  assert.match(String(invokable(fixture.agent, 'call_tool').description ?? ''), /business.*work_call/i);
  assert.ok((scope?.firstClassCount ?? 999) <= 12, `action surface regrew to ${scope?.firstClassCount}`);
  assert.ok((scope?.estFirstClassTokens ?? 99_999) <= 6_000,
    `action schema proxy regrew to ${scope?.estFirstClassTokens} tokens`);
  assert.ok((scope?.catalogCount ?? 0) > 90, 'subtracted controls must remain in the same-turn catalog');

  const controlFamilies = [
    // Workflow create/edit/disable.
    'workflow_create', 'workflow_edit_step', 'workflow_set_enabled',
    // Workspace create/read/edit.
    'space_save', 'space_get', 'space_edit_view',
    // Durable memory + learned procedure recall remain independent of history.
    'memory_recall', 'skill_read',
    // Explicit current-task writes are ordinary fresh controls, not archaeology.
    'focus_set', 'focus_update', 'focus_clear', 'focus_park',
  ];
  for (const name of controlFamilies) {
    assert.equal(names.has(name), false, `${name} should not charge every action prompt a schema`);
    const found = await searchExact(fixture, name);
    assert.equal(found.results[0]?.name, name, `${name} was not exactly discoverable`);
    assert.equal(found.results[0]?.carrier, 'call_tool', `${name} was routed through the business carrier`);
    assert.ok(found.schemas[name], `${name} search omitted its exact input schema`);
    assert.match(found.hint, /call_tool/);
  }

  // Exact-name search is never authority to reopen prior-task archaeology.
  const archaeology = [
    'session_history',
    'resume_held_task',
    'background_task_status',
    'background_tasks_recent',
    'focus_get',
    'focus_activate',
    'execution_create',
  ];
  for (const name of archaeology) {
    assert.equal(names.has(name), false, `${name} should be absent from a fresh schema surface`);
    const found = await searchExact(fixture, name);
    assert.equal(found.results.some((entry) => entry.name === name), false,
      `${name} leaked through exact-name search on a fresh action`);
    const refused = await withHarnessRunContext(
      {
        sessionId: fixture.sessionId,
        sourceUserSeq: fixture.sourceUserSeq,
        turn: fixture.turn,
        counter: new ToolCallsCounter(1_000),
      },
      () => invokable(fixture.agent, 'call_tool').invoke(
        { context: { sessionId: fixture.sessionId, sourceUserSeq: fixture.sourceUserSeq, turn: fixture.turn } },
        JSON.stringify({ name, args_json: '{}' }),
        { toolCall: { callId: `fresh-archaeology-${name}` } },
      ),
    );
    assert.match(String(refused), /not_reachable/, `${name} dispatched without continuation authority`);
  }

  const business = await searchExact(fixture, 'composio_execute_tool');
  assert.equal(business.results[0]?.carrier, 'work_call');
  assert.match(business.hint, /work_call/);

  const refused = await withHarnessRunContext(
    {
      sessionId: fixture.sessionId,
      sourceUserSeq: fixture.sourceUserSeq,
      turn: fixture.turn,
      counter: new ToolCallsCounter(1_000),
    },
    () => invokable(fixture.agent, 'call_tool').invoke(
      { context: { sessionId: fixture.sessionId, sourceUserSeq: fixture.sourceUserSeq, turn: fixture.turn } },
      JSON.stringify({
        name: 'composio_execute_tool',
        args_json: JSON.stringify({ tool_slug: 'EXAMPLE_READ', arguments: '{}' }),
      }),
      { toolCall: { callId: 'business-through-control-carrier' } },
    ),
  );
  assert.match(String(refused), /not_reachable/,
    'the control dispatcher must not become a second unbound business carrier');

  const controlResult = await withHarnessRunContext(
    {
      sessionId: fixture.sessionId,
      sourceUserSeq: fixture.sourceUserSeq,
      turn: fixture.turn,
      counter: new ToolCallsCounter(1_000),
    },
    () => invokable(fixture.agent, 'call_tool').invoke(
      { context: { sessionId: fixture.sessionId, sourceUserSeq: fixture.sourceUserSeq, turn: fixture.turn } },
      JSON.stringify({ name: 'desktop_status', args_json: '{}' }),
      { toolCall: { callId: 'deferred-control-dispatch' } },
    ),
  );
  assert.equal(String(controlResult), 'desktop-ok');
  assert.equal(controlDispatches, 1, 'deferred control must dispatch exactly once');
});

test('typed continuation admits exactly one bounded recovery carrier', async () => {
  const fixture = await acceptedAction(
    'Yes, continue.',
    [],
    {
      packetId: 'packet-1',
      parentSourceUserSeq: 1,
      consumingSourceUserSeq: 2,
      parentInput: 'Continue the dashboard workflow we were editing.',
      question: 'Should I continue the existing task?',
      options: ['Continue', 'Stop'],
      answer: 'Yes, continue.',
      disposition: 'affirmed',
      retrievalQuery: 'Continue the dashboard workflow we were editing. Yes, continue.',
      capabilities: [],
    },
  );
  const names = namesOf(fixture.agent);
  assert.ok(names.has('call_tool'), 'continuation needs one recovery carrier');
  assert.equal([...names].filter((name) => name === 'call_tool').length, 1);
  for (const name of ['session_history', 'resume_held_task', 'background_task_status', 'focus_get']) {
    assert.equal(names.has(name), false, `${name} should remain schema-deferred`);
    const found = await searchExact(fixture, name);
    assert.equal(found.results[0]?.name, name, `${name} was not available on a typed continuation`);
    assert.equal(found.results[0]?.carrier, 'call_tool');
    assert.ok(found.schemas[name]);
  }
  const alternateOwner = await searchExact(fixture, 'execution_create');
  assert.equal(alternateOwner.results.some((entry) => entry.name === 'execution_create'), false,
    'a continuation must not acquire a second action owner');
  for (const name of ['workflow_create', 'space_get', 'memory_recall', 'skill_read']) {
    const found = await searchExact(fixture, name);
    assert.equal(found.results[0]?.name, name, `${name} disappeared when recovery opened`);
  }
  const business = await searchExact(fixture, 'composio_execute_tool');
  assert.equal(business.results[0]?.carrier, 'work_call', 'recovery carrier cannot become business owner');
});

test('anaphoric continuation requires and uses durable task state', async () => {
  const fixture = await acceptedAction(
    'Continue where we left off.',
    [],
    undefined,
    (sessionId) => {
      createFocus({
        resourceRef: 'workspace:dashboard-refresh',
        resourceKind: 'workspace',
        title: 'Dashboard refresh',
        summary: 'Editing the retained dashboard refresh workspace.',
        relatedSessionId: sessionId,
      });
    },
  );
  const recovered = await searchExact(fixture, 'session_history');
  assert.equal(recovered.results[0]?.name, 'session_history');
  assert.equal(recovered.results[0]?.carrier, 'call_tool');

  for (const focus of listFocuses({ limit: 50 })) clearFocus(focus.id, 'abandoned');
  const noDurableTask = await acceptedAction('Continue where we left off.');
  const refused = await searchExact(noDurableTask, 'session_history');
  assert.equal(refused.results.some((entry) => entry.name === 'session_history'), false,
    'anaphoric wording alone must not mint recovery authority');
});

test('resolved control capabilities load directly without an extra discovery decision', async () => {
  const fixture = await acceptedAction(
    'Create the recurring dashboard workflow now using the already-resolved authoring operation.',
    ['workflow_create'],
  );
  const names = namesOf(fixture.agent);
  assert.ok(names.has('workflow_create'), 'a structurally resolved control should be first-class this turn');
  assert.equal(names.has('workflow_update'), false, 'one resolved control must not restore the whole control surface');
  const scope = eventlog.listEvents(fixture.sessionId, { types: ['tool_search_scope'] }).at(-1)?.data as {
    firstClassCount?: number;
    estFirstClassTokens?: number;
  } | undefined;
  assert.ok((scope?.firstClassCount ?? 999) <= 13);
  assert.ok((scope?.estFirstClassTokens ?? 99_999) <= 10_000);
});

test('exact capability selection bypasses semantic discovery ranking', async () => {
  const previousEmbeddingsDisabled = process.env.EMBEDDINGS_DISABLED;
  delete process.env.EMBEDDINGS_DISABLED;
  let captured: ((input: { query: string; limit?: number }) => Promise<{
    content: Array<{ text: string }>;
  }>) | undefined;
  try {
    registerToolSearchTool({
      tool(_name: string, _description: string, _schema: unknown, handler: typeof captured): void {
        captured = handler;
      },
    } as never, {
      allowedNames: new Set(['workflow_create']),
      dispatchViaCallTool: true,
    });
    assert.ok(captured);
    const startedAt = performance.now();
    const result = await captured!({ query: 'workflow_create exact schema', limit: 1 });
    const elapsedMs = performance.now() - startedAt;
    const body = JSON.parse(result.content[0]!.text) as {
      results: Array<{ name: string }>;
      schemas: Record<string, unknown>;
    };
    assert.deepEqual(body.results.map((entry) => entry.name), ['workflow_create']);
    assert.ok(body.schemas.workflow_create);
    assert.ok(elapsedMs < 1_000, `exact selection paid a semantic-ranker detour (${elapsedMs.toFixed(1)}ms)`);
  } finally {
    if (previousEmbeddingsDisabled === undefined) delete process.env.EMBEDDINGS_DISABLED;
    else process.env.EMBEDDINGS_DISABLED = previousEmbeddingsDisabled;
  }
});
