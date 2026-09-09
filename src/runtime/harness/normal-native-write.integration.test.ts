/** Real Normal-mode native create/edit proof, without a graph or provider/model calls. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-normal-native-write-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-space-save-work-call\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityEnvelopes = await import('../../agents/capability-envelope.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityManifestStores = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const localPreparation = await import('./host-local-call-preparation.js');
const localDefinitions = await import('./local-planning-capability.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');
const workCallTools = await import('../../tools/work-call.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const store = await import('../../spaces/store.js');
const workspaceDb = await import('../../spaces/workspace-db.js');
const workflowStore = await import('../../memory/workflow-store.js');

after(() => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{
    usage?: Record<string, unknown>;
    output?: unknown[];
    responseId?: string;
  }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'space-save-response',
      usage: {
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        totalTokens: Number(response.usage?.totalTokens ?? 0),
      },
      output,
    },
  } as never;
}

function stubModel(responses: unknown[][]) {
  let call = 0;
  return {
    calls: () => call,
    async getResponse() {
      const output = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          requests: 1,
          inputTokensDetails: [],
          outputTokensDetails: [],
        },
        output,
        responseId: `space-save-response-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

const textMessage = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}

test('Normal mode creates and edits actual native Space and workflow definitions without a plan', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'normal-native-authoring', kind: 'chat' });
  const prompt = 'Create a native Space and a manual workflow from my inline content, then edit their description and display text. Also schedule a separate brief once and disable it before it runs. Do not run either workflow.';
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true);
  if (!primed.ok) return;
  const names = ['space_save', 'space_edit_view', 'workflow_create', 'workflow_update', 'workflow_schedule', 'workflow_unschedule'];
  const refs = new Map<string, string>();
  for (const name of names) {
    const search = buildScopedLocalToolSearch(new Set([name]), 'work_call', undefined, undefined,
      candidates => semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates }));
    const result = JSON.parse(String(await search.invoke(new RunContext({ sessionId: session.id }),
      JSON.stringify({ query: name, role_key: null, limit: 1, account_selection: null }))));
    assert.equal(result.results[0].effect, 'local_write');
    assert.equal(result.results[0].example.args.name, name);
    refs.set(name, result.results[0].capabilityRef);
  }
  const transform = (value: string) => JSON.stringify({ version: 1, expression: { op: 'literal', value } });
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({ requireHostPlan: true,
    reachableBuiltinNames: new Set(names), firstClassNames: new Set(), catalogIdentifiers: names,
    settlementLane: 'byo', hostPlanningReady: () => true }) as never);
  const inputs = [
    { name: 'space_save', args: { slug: 'normal-native-proof', title: 'Normal Native Proof',
      view_html: '<html><body><p>Original native body</p></body></html>',
      initial_data_json: JSON.stringify({ _mobile: { records: { items: [{ primary: 'Original native body' }] } } }),
      objective: null, success_criteria: null, invariants: null, view_path: null, data_sources: null,
      actions: null, reengage_triggers: null, reengage_guidance: null, origin_session_id: null } },
    { name: 'space_edit_view', args: { slug: 'normal-native-proof', edits: [{ find: 'Original native body', replace: 'Edited native body' }] } },
    { name: 'workflow_create', args: { name: 'Normal Native Workflow', description: 'Original native workflow',
      steps: [{ id: 'literal', sideEffect: 'read', transform: transform('original') }] } },
    { name: 'workflow_update', args: { name: 'Normal Native Workflow', description: 'Edited native workflow',
      steps: [{ id: 'literal', sideEffect: 'read', transform: transform('edited') }] } },
    { name: 'workflow_schedule', args: { name: 'normal-scheduled-brief', description: 'Prepare a local brief once.', run_at: '2026-09-11T22:30:00Z', instructions: 'Read the local performance CSV and summarize it.', toolCall: null } },
    { name: 'workflow_unschedule', args: { name: 'normal-scheduled-brief' } },
  ];
  const model = stubModel([...inputs.map((input, index) => [toolCall(`normal-native-${index}`, 'work_call', {
    requirement_id: refs.get(input.name), source_call_ids: null, source_record_ids: null,
    universe_item_id: null, universe_selector: null, seal_amendment: null,
    name: input.name, args_json: JSON.stringify(input.args),
  })]), [textMessage('The native Space and workflow are created and edited.')]]);
  const agent = { model, tools: [workCall] };
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id,
    universeTools: [workCall], activeToolNames: ['work_call'], policyHash: 'normal-native-proof',
    budget: { maxUncachedTokens: 20_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 } });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const result = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(16),
    behaviorScopeId: `${session.id}::turn:1` }, () => hostRunRunner(throwingRunner() as never, agent as never,
    [{ type: 'message', role: 'user', content: prompt }] as never,
    { maxTurns: 8, hostTurnEngine: 'host_v1', context: identity } as never));
  const results = result.history.filter((item: any) => item.type === 'function_call_result');
  assert.equal(result.terminal, undefined, JSON.stringify({ results,
    settlements: eventlog.openEventLog().prepare('SELECT * FROM logical_call_settlements WHERE session_id = ?').all(session.id),
    physical: eventlog.openEventLog().prepare('SELECT * FROM physical_dispatches WHERE session_id = ?').all(session.id),
    events: eventlog.listEvents(session.id, { types: ['tool_returned', 'tool_called', 'guardrail_tripped'] }),
  }));
  assert.equal(Boolean(result.hasInterruptions), false, JSON.stringify(results));
  assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null, 'ordinary native work must not manufacture a graph');
  assert.equal(eventlog.listEvents(session.id, { types: ['tool_called'] }).some(event => event.data.tool === 'plan_task'), false);
  const space = store.spaceStore.get('normal-native-proof');
  assert.ok(space, JSON.stringify(results));
  assert.equal(space.version, 2);
  const html = readFileSync(path.join(TEST_HOME, 'spaces', 'normal-native-proof', space.viewEntry), 'utf8');
  assert.match(html, /Edited native body/);
  const workflow = workflowStore.readWorkflow('normal-native-workflow');
  assert.ok(workflow, JSON.stringify(results));
  assert.equal(workflow.data.description, 'Edited native workflow');
  assert.equal(workflow.data.enabled, true);
  const scheduled = workflowStore.readWorkflow('normal-scheduled-brief')!;
  assert.equal(scheduled.data.enabled, false);
  assert.equal(scheduled.data.trigger.onceAt, '2026-09-11T22:30:00.000Z');
  assert.equal(workflow.data.trigger.manual, true);
  assert.equal(workflow.data.steps[0]!.transform?.expression.op, 'literal');
  assert.equal((workflow.data.steps[0]!.transform?.expression as any).value, 'edited');
  const physical = eventlog.openEventLog().prepare('SELECT tool_name, state FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ? ORDER BY rowid').all(session.id, source.seq);
  assert.equal(physical.length, names.length, JSON.stringify({ results, physical }));
  assert.deepEqual(physical, names.map(tool_name => ({ tool_name, state: 'returned' })));
  const settlements = eventlog.openEventLog().prepare(`SELECT mutating, outcome_kind, host_crossing_count
    FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ? ORDER BY logical_tool_call_id`).all(session.id, source.seq);
  assert.deepEqual(settlements, names.map(() => ({ mutating: 1, outcome_kind: 'succeeded', host_crossing_count: 1 })),
    'every actual native mutation retains its effect and one crossing in the durable outcome');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?').get(session.id) as { n: number }).n, 0);
});

test('separate accepted Normal workflow create and edit use their own exact native coverage without planning', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'normal-native-live-regression', kind: 'chat', userId: 'native-fixture-owner' });
  const name = 'Clem qualification isolated';
  const steps = [{ id: 'draft_status_summary',
    prompt: 'Draft a short status summary from the text supplied at runtime. Use the supplied source text as the only material and produce a concise status summary. Do not send, publish, or take any other action.',
    sideEffect: 'read', inputs: { source_text: { type: 'string', required: true,
      description: 'Source text supplied at runtime to summarize into a short status update' } } }];
  const requests = [
    { prompt: `Create a workflow named ${name} with a manual trigger and one step that drafts a short status summary from text I supply at runtime. Set its description to QUALIFICATION INITIAL. Save it without running it.`,
      toolName: 'workflow_create', args: { name, description: 'QUALIFICATION INITIAL', steps } },
    { prompt: `Update the description of ${name} to QUALIFICATION EDITED. Preserve its existing step and do not run it.`,
      toolName: 'workflow_update', args: { name, description: 'QUALIFICATION EDITED' } },
  ];
  let savedSteps: unknown;
  for (const [index, request] of requests.entries()) {
    const source = eventlog.appendEvent({ sessionId: session.id, turn: index + 1, role: 'user',
      type: 'user_input_received', data: { text: request.prompt, taskMode: { version: 1, kind: 'normal' } } });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
    const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
    assert.ok(primed.ok);
    if (!primed.ok) throw new Error('source catalog unavailable');
    const search = buildScopedLocalToolSearch(new Set([request.toolName]), 'work_call', undefined, undefined,
      candidates => semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates }));
    const discovery = JSON.parse(String(await search.invoke(new RunContext({ sessionId: session.id }),
      JSON.stringify({ query: request.toolName, role_key: null, limit: 1, account_selection: null }))));
    assert.equal(discovery.results[0].effect, 'local_write');
    const capabilityRef = discovery.results[0].capabilityRef;
    const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({ requireHostPlan: true,
      reachableBuiltinNames: new Set([request.toolName]), firstClassNames: new Set(),
      catalogIdentifiers: [request.toolName], settlementLane: 'byo', hostPlanningReady: () => true }) as never);
    const callId = `live-native-${index}`;
    const model = stubModel([[toolCall(callId, 'work_call', {
      requirement_id: capabilityRef, source_call_ids: null, source_record_ids: null,
      universe_item_id: null, universe_selector: null, seal_amendment: null,
      name: request.toolName, args_json: JSON.stringify(request.args),
    })], [textMessage(index === 0 ? 'The workflow was saved without running it.' : 'The description was updated.')]]);
    const agent = { model, tools: [workCall] };
    const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id,
      universeTools: [workCall], activeToolNames: ['work_call'], policyHash: `normal-native-live-${index}`,
      budget: { maxUncachedTokens: 20_000, maxModelCalls: 4, maxToolCalls: 4, maxElapsedMs: 60_000 } });
    assert.ok(sealed.ok);
    if (!sealed.ok) throw new Error('native envelope unavailable');
    capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const result = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(4),
      behaviorScopeId: `${session.id}::turn:${source.turn}` }, () => hostRunRunner(throwingRunner() as never,
      agent as never, [{ type: 'message', role: 'user', content: request.prompt }] as never,
      { maxTurns: 3, hostTurnEngine: 'host_v1', context: identity } as never));
    assert.equal(result.terminal, undefined, JSON.stringify(result.history));
    assert.equal(Boolean(result.hasInterruptions), false);
    assert.equal(model.calls(), 2, 'the first native call succeeds and the next model response completes');
    assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
    assert.deepEqual(eventlog.openEventLog().prepare(`SELECT logical_tool_call_id, outcome_kind, host_crossing_count
      FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ?`)
      .all(session.id, source.seq), [{ logical_tool_call_id: callId, outcome_kind: 'succeeded', host_crossing_count: 1 }]);
    assert.deepEqual(eventlog.openEventLog().prepare(`SELECT tool_name, binding_kind, capability_id
      FROM host_call_capability_bindings WHERE session_id = ? AND source_user_seq = ?`)
      .all(session.id, source.seq), [{ tool_name: request.toolName, binding_kind: 'local_envelope', capability_id: capabilityRef }]);
    const stored = workflowStore.readWorkflow('clem-qualification-isolated');
    assert.ok(stored);
    assert.equal(stored.data.description, request.args.description);
    assert.equal(stored.data.trigger.manual, true);
    if (index === 0) savedSteps = structuredClone(stored.data.steps);
    else assert.deepEqual(stored.data.steps, savedSteps, 'description-only edit preserves the saved runtime-input step');
    eventlog.closeEventLog();
    assert.equal((eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements
      WHERE session_id = ? AND source_user_seq = ? AND outcome_kind = 'succeeded'`)
      .get(session.id, source.seq) as { n: number }).n, 1, 'the exact success survives storage reopen');
  }
  assert.equal(eventlog.listEvents(session.id, { types: ['tool_called'] }).some(event => event.data.tool === 'plan_task'), false);
  assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested'] }).length, 0);
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
    .get(session.id) as { n: number }).n, 2, 'only create and edit cross; the saved workflow never executes');
});


for (const malformedFirst of [false, true]) {
test(`an exact file overwrite commits once without rediscovery or a redundant approval (malformed first: ${malformedFirst})`, async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: `known-native-overwrite-${malformedFirst}`, kind: 'chat', userId: 'native-fixture-owner' });
  const file = path.join(TEST_HOME, `known-draft-${malformedFirst}.html`);
  writeFileSync(file, 'Original draft\n');
  const prompt = `Update ${file} to Revised draft.`;
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: prompt, taskMode: { version: 1, kind: 'normal' } } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error(primed.reason);
  const args = { path: file, content: 'Revised draft', mode: 'overwrite', append: null };
  const capabilityRef = 'cap:local:write_file:overwrite';
  assert.equal(localDefinitions.nominateDisclosedLocalPlanningDefinition({ ...identity, capabilityRef,
    operationId: 'write_file', effect: 'local_write', args }), null);
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({ requireHostPlan: true,
    reachableBuiltinNames: new Set(['write_file']), firstClassNames: new Set(), catalogIdentifiers: ['write_file'],
    settlementLane: 'byo', hostPlanningReady: () => true }) as never);
  const carriedArgs = {
    requirement_id: capabilityRef, source_call_ids: null, source_record_ids: null,
    universe_item_id: null, universe_selector: null, seal_amendment: null,
    name: 'write_file', args_json: JSON.stringify(args),
  };
  const responses = [[toolCall('known-file-edit', 'work_call', carriedArgs)],
    [textMessage('The requested file revision is saved.')]];
  if (malformedFirst) {
    // Real live failure: the outer carrier is valid, but its nested JSON ends
    // inside a string. Nothing may dispatch until the model repairs the bytes.
    const malformedArgs = JSON.stringify({ path: file, mode: 'overwrite', content: 'Revised draft' }).slice(0, -2);
    responses.unshift([toolCall('malformed-file-edit', 'work_call', { ...carriedArgs, args_json: malformedArgs })]);
  }
  const model = stubModel(responses);
  const agent = { model, tools: [workCall] };
  localPreparation.bindHostLocalCallPreparation(agent, { planning: primed.planning, configuredNames: new Set(['write_file']) });
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id,
    universeTools: [workCall], activeToolNames: ['work_call'], policyHash: 'known-file-overwrite',
    budget: { maxUncachedTokens: 20_000, maxModelCalls: 4, maxToolCalls: 4, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) throw new Error('native envelope unavailable');
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const result = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(4),
    behaviorScopeId: `${session.id}::turn:1` }, () => hostRunRunner(throwingRunner() as never, agent as never,
    [{ type: 'message', role: 'user', content: prompt }] as never,
    { maxTurns: 3, hostTurnEngine: 'host_v1', context: identity } as never));
  assert.equal(model.calls(), malformedFirst ? 3 : 2, JSON.stringify(result.history));
  assert.doesNotMatch(JSON.stringify(result.history), /work_contract_required|not yet published|tool_search/);
  if (malformedFirst) {
    assert.match(JSON.stringify(result.history), /argument payload is not valid JSON/);
    assert.match(JSON.stringify(result.history), /Correct the arguments and retry the same operation/);
    assert.doesNotMatch(JSON.stringify(result.history), /binding is absent or changed|not proven for this step|What IS proven/);
  }
  assert.ok(localDefinitions.nominateDisclosedLocalPlanningDefinition({ ...identity, capabilityRef,
    operationId: 'write_file', effect: 'local_write', args }));
  assert.equal(Boolean(result.hasInterruptions), false);
  assert.equal(result.terminal, undefined);
  assert.equal(readFileSync(file, 'utf8'), 'Revised draft\n');
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
    .get(session.id) as { n: number }).n, 1);
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?')
    .get(session.id) as { n: number }).n, 0);
  const { settledSourceArtifacts } = await import('./host-turn-runner.js');
  const evidence = settledSourceArtifacts(identity);
  assert.equal(evidence.artifacts.length, 1, JSON.stringify(evidence));
  assert.equal(evidence.artifacts[0]?.evidenceContract, 'file');
  assert.equal(evidence.artifacts[0]?.digestMatches, true);
});
}
