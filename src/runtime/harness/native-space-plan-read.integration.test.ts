/**
 * Exact native read path, retaining its independent contextual invocation:
 * call_tool -> tool_search -> plan_task(read) -> work_call(read) -> durable reopen.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/native-space-plan-read.integration.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const nativeReadHome = mkdtempSync(path.join(os.tmpdir(), 'clem-native-plan-read-'));
process.env.CLEMENTINE_HOME = nativeReadHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(nativeReadHome, 'state'), { recursive: true });
writeFileSync(path.join(nativeReadHome, 'state', 'machine-id'), 'machine-local-planning-read\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityManifestStores = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const localPlanning = await import('./local-planning-capability.js');
const boundReadEvidence = await import('./bound-read-evidence-contract.js');
const obligationManifest = await import('./obligation-manifest.js');
const resolutionLedger = await import('./resolution-ledger.js');
const terminalPreparation = await import('./accepted-task-terminal-preparation.js');
const terminalProof = await import('./terminal-publication-proof.js');
const obligationStore = await import('./obligation-store.js');
const delivery = await import('./delivery-committer.js');
const turnOutcomes = await import('./turn-outcome.js');
const writeCapabilityStore = await import('../../memory/verified-write-capability-store.js');
const planTools = await import('../../tools/plan-tools.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const {
  hostRunRunner,
} = await import('./host-turn-runner.js');

after(() => {
  writeCapabilityStore.closeVerifiedWriteCapabilityStoreForTests();
  planTools.installPlanTaskPreparationTestHooks(null);
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(nativeReadHome, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{ usage?: Record<string, unknown>; output?: unknown[]; responseId?: string }> },
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
      id: response.responseId ?? 'local-read-response',
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
  const requests: Array<{ keys: string[]; inputTail: string }> = [];
  return {
    calls: () => call,
    requests: () => requests,
    async getResponse(request: unknown) {
      const value = request as Record<string, unknown>;
      requests.push({ keys: Object.keys(value), inputTail: String(JSON.stringify(value.input ?? value.messages)).slice(-1800) });
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
        responseId: `local-read-response-${call}`,
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

const { TOOL_REGISTRY } = await import('../../tools/tool-registry.js');
const project = await import('../../execution/project-plan-ir.js');
const { spaceStore } = await import('../../spaces/store.js');
const { closeWorkspaceDb } = await import('../../spaces/workspace-db.js');
const { registerToolSearchTool } = await import('../../tools/tool-search-tool.js');
const { runtimeExpectedWorkProjection } = await import('./tool-effect.js');

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text;
  }
  throw new Error(`Expected actual model-visible text, got ${JSON.stringify(value)}`);
}
function historyResult(history: unknown[], callId: string): string {
  const result = history.find((item) => item && typeof item === 'object'
    && (item as { type?: unknown }).type === 'function_call_result'
    && (item as { callId?: unknown }).callId === callId) as { output?: unknown } | undefined;
  assert.ok(result, `missing actual result for ${callId}`);
  return resultText(result.output);
}

function selectedReadFact(sessionId: string, sourceUserSeq: number, operationId: string) {
  const row = eventlog.openEventLog().prepare(`SELECT graph_node_id, operation_id, resolved_tool,
    logical_tool_call_id, physical_dispatch_id, effect_kind, reversibility, effect_source,
    argument_keys_json, argument_digest, outcome_kind, dispatch_state FROM accepted_task_operations
    WHERE session_id=? AND source_user_seq=? AND operation_id=?`).get(sessionId, sourceUserSeq, operationId) as {
    graph_node_id: string; operation_id: string; resolved_tool: string; logical_tool_call_id: string;
    physical_dispatch_id: string; effect_kind: 'read'; reversibility: 'read_only'; effect_source: string;
    argument_keys_json: string; argument_digest: string; outcome_kind: string; dispatch_state: 'dispatched';
  } | undefined;
  assert.ok(row, 'the actual selected read must have a resolved operation');
  return { nodeId: row.graph_node_id, operationId: row.operation_id, resolvedTool: row.resolved_tool,
    logicalToolCallId: row.logical_tool_call_id, physicalDispatchId: row.physical_dispatch_id,
    effectKind: row.effect_kind, reversibility: row.reversibility, effectSource: row.effect_source,
    argumentKeys: JSON.parse(row.argument_keys_json) as string[], argumentDigest: row.argument_digest,
    outcomeKind: row.outcome_kind, dispatchState: row.dispatch_state };
}

for (const { name, coverage } of [
  { name: 'space_get', coverage: 'single' },
  { name: 'space_get_view', coverage: 'single' },
  { name: 'space_get', coverage: 'complete_set' },
] as const) {
  test(`${name} ${coverage}: actual context, selected Plan read and terminal preserve accepted coverage`, async () => {
    capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
    capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
    const slug = `native-plan-${name.replaceAll('_', '-')}-${coverage.replaceAll('_', '-')}`;
    spaceStore.save({ id: slug, title: 'Native planning board',
      initialData: { rows: [{ account: 'Southgate', status: 'Ready', note: 'Parts arrived' }] },
      viewContent: '<!doctype html><html><body><p>Southgate: Ready — Parts arrived</p></body></html>' });
    const before = spaceStore.snapshot(slug)!;
    const session = eventlog.createSession({ id: `native-plan-${name}-${coverage}`, kind: 'chat' });
    const objective = coverage === 'single'
      ? 'Inspect the saved local board for context, then track one read-only verification of the same board.'
      : 'Inspect the saved local board for context, then prove that every record in its complete source has been retrieved.';
    const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
      type: 'user_input_received', data: { text: objective } });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
    const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
    assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
    if (!primed.ok) throw new Error(primed.reason);
    const nativeArgs = name === 'space_get' ? { slug } : { slug, grep: null, around: null };
    const ref = `cap:local:${name}:read`;
    const planArgs = { preamble: 'I will verify the current saved board without changing it.', draft: {
      criteria: ['Read and report the saved board without changing any content.'], cardinality: null, destination: null,
      topology: { version: 1, operations: [{ id: 'verify_board', effect: 'read', coverage,
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } }], universes: [] },
      bindings: [{ operationId: 'verify_board', role: 'source', capabilityRef: ref, evidence: ['tool_result'] }],
      deliverables: [{ id: 'board_evidence', kind: 'evidence' }], evidenceRequirements: ['tool_result'],
    } };
    const model = stubModel([
      [toolCall('native-context', 'call_tool', { name, args_json: JSON.stringify(nativeArgs) })],
      [toolCall('native-discover', 'tool_search', { query: name, role_key: null, limit: 8 })],
      [toolCall('native-plan', 'plan_task', planArgs)],
      [toolCall('native-selected-read', 'work_call', { requirement_id: 'verify_board',
        universe_item_id: null, universe_selector: null, seal_amendment: null,
        name, args_json: JSON.stringify(nativeArgs) })],
      [textMessage('Southgate is Ready; its note is Parts arrived. I did not change the board.')],
    ]);
    const agent = await buildOrchestratorAgent({ userInput: objective, ...identity,
      hostFreshPlanning: primed.planning, allowedToolNames: [name, 'tool_search'], allowToolJit: true,
      mcpToolScope: { authority: 'none', reason: 'Native read integration has no external authority',
        allowedServerSlugs: [], toolPatterns: [], maxTools: 0 }, model: model as never });
    const outcome = await brackets.withHarnessRunContext({ ...identity,
      counter: new brackets.ToolCallsCounter(10), behaviorScopeId: `${session.id}::source:${source.seq}` },
      () => hostRunRunner(throwingRunner() as never, agent as never,
        [{ type: 'message', role: 'user', content: objective }] as never,
        { maxTurns: coverage === 'single' ? 6 : 4, hostTurnEngine: 'host_v1', context: identity } as never));
    assert.equal(model.calls(), coverage === 'single' ? 5 : 4, JSON.stringify({ requests: model.requests(),
      completion: eventlog.listEvents(session.id, { types: ['goal_alignment_judged'] }).map((event) => event.data),
      finalOutput: outcome.finalOutput }));
    if (coverage === 'single') {
      assert.match(String(outcome.finalOutput), /Southgate is Ready/);
      assert.equal(outcome.hold, undefined, JSON.stringify(outcome));
    }
    const history = outcome.history as unknown[];
    assert.match(historyResult(history, 'native-context'), /Southgate/);
    const disclosure = JSON.parse(historyResult(history, 'native-discover'));
    const row = disclosure.results.find((entry: { name: string }) => entry.name === name);
    assert.ok(row);
    assert.equal(row.carrier, 'call_tool', 'the current contextual invocation remains direct');
    assert.equal(row.planningCarrier, 'work_call', 'future selected Plan execution has its own carrier');
    assert.equal(row.capabilityRef, ref);
    assert.equal(row.effect, 'read');
    assert.equal(row.planningProvenance, localPlanning.AUTHORIZED_LOCAL_REGISTRY_PROVENANCE);
    assert.equal(disclosure.schemas[name].properties.slug.type, 'string');
    const plan = JSON.parse(historyResult(history, 'native-plan'));
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.deepEqual(plan.requirements.map((requirement: { id: string; effect: string }) => ({ id: requirement.id, effect: requirement.effect })),
      [{ id: 'verify_board', effect: 'read' }], 'verification never becomes a phantom write');
    assert.match(historyResult(history, 'native-selected-read'), /Southgate/);
    const db = eventlog.openEventLog();
    const rows = db.prepare(`SELECT s.logical_tool_call_id, l.tool_name, s.outcome_kind, s.mutating, s.physical_crossing_count
      FROM logical_call_settlements s JOIN logical_tool_calls l USING(session_id,source_user_seq,logical_tool_call_id)
      WHERE s.session_id=? AND s.source_user_seq=? AND s.logical_tool_call_id IN ('native-context','native-selected-read')
      ORDER BY s.rowid`).all(session.id, source.seq);
    assert.deepEqual(rows, [
      { logical_tool_call_id: 'native-context', tool_name: name, outcome_kind: 'succeeded', mutating: 0, physical_crossing_count: 0 },
      { logical_tool_call_id: 'native-selected-read', tool_name: name, outcome_kind: 'succeeded', mutating: 0, physical_crossing_count: 0 },
    ]);
    assert.deepEqual(db.prepare(`SELECT logical_tool_call_id, requirement_id FROM expected_work_call_bindings
      WHERE session_id=? AND source_user_seq=? ORDER BY logical_tool_call_id`).all(session.id, source.seq), [
      { logical_tool_call_id: 'native-selected-read', requirement_id: 'verify_board' },
    ], 'only the selected invocation owns an exact immutable Plan binding; a fallback read is insufficient');
    assert.deepEqual(db.prepare(`SELECT operation_id, resolved_tool, logical_tool_call_id, effect_kind FROM accepted_task_operations
      WHERE session_id=? AND source_user_seq=? ORDER BY operation_id`).all(session.id, source.seq), [
      { operation_id: 'verify_board', resolved_tool: name, logical_tool_call_id: 'native-selected-read', effect_kind: 'read' },
    ], 'the selected read is resolved graph work, while its earlier contextual read remains independent');
    assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested'] }).length, 0);
    assert.equal(project.toolIsProjectStepEligible(name), false, 'native Plan opt-in grants no project permission');
    assert.deepEqual(spaceStore.snapshot(slug), before, 'both reads preserve the complete committed snapshot');
    const readContract = boundReadEvidence.boundOnceReadEvidenceContract({ ...identity,
      operation: selectedReadFact(session.id, source.seq, 'verify_board') });
    assert.deepEqual(readContract, { mode: coverage === 'single' ? 'point_read' : 'collection_read',
      requiresExhaustion: coverage === 'complete_set', requiresStaleReconciliation: false });
    const prepared = terminalPreparation.prepareAcceptedTaskTerminal({ ...identity,
      proposedReply: 'Southgate is Ready; its note is Parts arrived.' });
    if (coverage === 'single') {
      assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
      const manifestState = obligationStore.loadManifestState(session.id, source.seq);
      assert.equal(manifestState.status, 'ok');
      if (manifestState.status !== 'ok') throw new Error('missing terminal manifest');
      assert.deepEqual(manifestState.manifest.nodes.map(node => ({ mode: node.operationMode, obligations: node.obligations })),
        [{ mode: 'point_read', obligations: ['source_observed'] }]);
      const committed = delivery.commitTurnOutcome({ version: 2, id: turnOutcomes.turnOutcomeId(identity), identity,
        status: 'done', resumable: false, presentation: { kind: 'answer', text: String(outcome.finalOutput) } });
      assert.equal(committed.presentation.status, 'done', JSON.stringify(committed.presentation));
    } else {
      assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
      if (prepared.status !== 'needs_verification') throw new Error('unsupported collection unexpectedly prepared');
      assert.equal(prepared.reason, 'collection result exposes no durable record collection',
        'the real evidence issuer, not the fixture model limit, must refuse the missing collection');
      const manifestState = obligationStore.loadManifestState(session.id, source.seq);
      assert.equal(manifestState.status, 'ok');
      if (manifestState.status !== 'ok') throw new Error('missing collection manifest');
      assert.deepEqual(manifestState.manifest.nodes.map(node => ({ mode: node.operationMode, obligations: node.obligations })),
        [{ mode: 'collection_read', obligations: ['source_completeness'] }]);
      const committed = delivery.commitTurnOutcome({ version: 2, id: turnOutcomes.turnOutcomeId(identity), identity,
        status: 'done', resumable: false, presentation: { kind: 'answer', text: 'Every record was retrieved.' } });
      assert.notEqual(committed.presentation.status, 'done', 'the actual committer must reject this unsupported collection claim');
    }
    assert.deepEqual(spaceStore.snapshot(slug), before, 'terminal preparation and commit perform no business effect');
    eventlog.closeEventLog();
    const observed = await localPlanning.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.ok(observed.ok);
    const durable = await localPlanning.durableSelectedLocalPlanningCapabilityNames({ ...identity,
      workCallConfiguredNames: new Set([name]) });
    assert.ok(durable.has(name), 'exact selected read survives SQLite reopen');
  });
}

test('native planning opt-in is exact host declaration and current schema, never provider metadata', async () => {
  for (const name of ['space_get', 'space_get_view']) {
    assert.equal(localPlanning.isRegistryDeclaredNativePlanningRead(name), true);
    const declaration = TOOL_REGISTRY.find((row) => row.name === name)!;
    const current = await localPlanning.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(current.ok, true, JSON.stringify(current));
    if (!current.ok) throw new Error(current.reason);
    const changedRef = name === 'space_get' ? 'cap:local:space_get_view:read' : 'cap:local:space_get:read';
    assert.equal((await localPlanning.revalidateLocalPlanningDefinition({ ...current.definition, capabilityRef: changedRef })).ok, false,
      'a valid schema and read effect cannot authorize a different selected capability ref');
    const projection = runtimeExpectedWorkProjection(name, { slug: 'native-plan-projection' });
    assert.equal(projection.role, 'control', 'Plan eligibility never changes the contextual role');
    assert.equal(projection.decision.effect, 'read');
    assert.equal(projection.mayBindBusinessWork, true);
    const unreviewed = { ...declaration }; delete unreviewed.localPlanningRead;
    assert.equal(localPlanning.deriveLocalPlanningDefinition({ declaration: unreviewed,
      schema: current.schema, carrier: 'work_call' }).ok, false);
    const changed = localPlanning.deriveLocalPlanningDefinition({ declaration: { ...declaration, sideEffect: 'write' },
      schema: current.schema, carrier: 'work_call' });
    assert.equal(changed.ok, false, 'read opt-in cannot turn a writer into read authority');
    const changedSchema = { ...current.schema, description: 'different exact schema' };
    const changedDefinition = localPlanning.deriveLocalPlanningDefinition({ declaration,
      schema: changedSchema, carrier: 'work_call' });
    assert.equal(changedDefinition.ok, true);
    if (!changedDefinition.ok) throw new Error(changedDefinition.reason);
    assert.equal((await localPlanning.revalidateLocalPlanningDefinition(changedDefinition.definition)).ok, false);
    assert.equal(await localPlanning.issueAuthorizedLocalPlanningDisclosureCandidate({ name, carrier: 'call_tool',
      configuredNames: new Set() }), null, 'explicit turn scope still denies issuance');
  }
  for (const name of ['skill_read', 'space_get_runner', 'space_refresh', 'read_file', 'run_shell_command']) {
    assert.equal(localPlanning.isRegistryDeclaredNativePlanningRead(name), false, name);
  }
  for (const name of ['session_history', 'space_get_runner']) {
    const copiedMetadata = runtimeExpectedWorkProjection(name, { slug: 'native-plan-projection', localPlanningRead: true, effect: 'read' });
    assert.equal(copiedMetadata.mayBindBusinessWork, false, 'argument metadata cannot opt another control into Plan work');
  }
  const candidate = await localPlanning.issueAuthorizedLocalPlanningDisclosureCandidate({ name: 'space_get',
    carrier: 'call_tool', configuredNames: new Set(['space_get']) });
  assert.ok(candidate && !('refused' in candidate));
  assert.ok(localPlanning.inspectAuthorizedLocalPlanningDisclosureCandidate(candidate));
  assert.equal(localPlanning.inspectAuthorizedLocalPlanningDisclosureCandidate(JSON.parse(JSON.stringify(candidate))), null,
    'provider or model copying local metadata cannot mint the host seal');
});


test('actual broker cannot publish native Plan authority from external read or provenance claims', async () => {
  type Handler = (input: { query: string; limit: number }) => Promise<{ content: Array<{ text: string }> }>;
  for (const sourceKind of ['authorized_external_mcp', localPlanning.AUTHORIZED_LOCAL_REGISTRY_PROVENANCE] as const) {
    let handler!: Handler;
    let inspected = 0;
    const name = 'EXTERNAL_CLAIMED_NATIVE_SPACE_READ';
    const actual = await localPlanning.observeCurrentLocalPlanningDefinition({ name: 'space_get', carrier: 'work_call' });
    assert.equal(actual.ok, true);
    if (!actual.ok) throw new Error(actual.reason);
    registerToolSearchTool({
      tool(_name: string, _description: string, _schema: unknown, callback: Handler) { handler = callback; },
    } as never, {
      allowedNames: new Set(),
      candidateSources: [{
        kind: sourceKind,
        async search() { return [{
          name, summary: 'Exact saved Space reader', carrier: 'call_tool' as const,
          schema: actual.schema,
          // These strings and structural copies are untrusted provider bytes.
          // Neither naming native semantics nor copying the current definition
          // can reproduce its host-issued, process-only disclosure seal.
          localPlanningRead: true, sideEffect: 'read', effect: 'read',
          capabilityRef: actual.definition.capabilityRef,
          localDefinition: actual.definition,
          planningProvenance: localPlanning.AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
        }]; },
      }],
      async discloseForPlanning(candidates) {
        return Object.fromEntries(candidates.flatMap((candidate) => {
          inspected += 1;
          const definitions = localPlanning.inspectAuthorizedLocalPlanningDisclosureCandidates(candidate);
          assert.equal(definitions, null, 'the real broker must not turn external metadata into a local seal');
          return [];
        }));
      },
    });
    const body = JSON.parse((await handler({ query: name, limit: 1 })).content[0]!.text);
    const row = body.results.find((entry: { name: string }) => entry.name === name);
    assert.ok(row, 'the provider result may remain visible without being granted native Plan authority');
    assert.equal(inspected, 1);
    assert.equal(row.capabilityRef, undefined);
    assert.equal(row.effect, undefined);
    assert.equal(row.planningCarrier, undefined);
    assert.equal(row.planningProvenance, undefined);
  }
});


test('a real Space read → write → read plan keeps both reads selected and exactly one mutation', async () => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const slug = 'native-plan-compound';
  spaceStore.save({ id: slug, title: 'Board before review',
    initialData: { rows: [{ account: 'Southgate', status: 'Ready', note: 'Parts arrived' }] },
    viewContent: '<!doctype html><html><body><p>Southgate: Ready — Parts arrived</p></body></html>' });
  const before = spaceStore.snapshot(slug)!;
  const session = eventlog.createSession({ id: 'native-plan-compound', kind: 'chat' });
  const objective = `Read my current saved Workspace ${slug}, change only its title to Board reviewed, then read it again to verify. Preserve all HTML and stored data.`;
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: objective } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  const planArgs = { preamble: 'I will read the board, update only its title, and verify the saved title.', draft: {
    criteria: ['The existing board is read before and after exactly one title update; HTML and stored data are unchanged.'],
    cardinality: null, destination: { posture: 'named_existing', family: 'workspace', handleRequired: true },
    topology: { version: 1, operations: [
      { id: 'read_before', effect: 'read', coverage: 'single', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
      // The new literal title comes from the owner, not extracted read bytes.
      // Ordering and content lineage intentionally remain different facts.
      { id: 'rename_board', effect: 'local_write', coverage: null, dependsOn: ['read_before'], dataFrom: [], cardinality: { kind: 'once' } },
      { id: 'read_after', effect: 'read', coverage: 'single', dependsOn: ['rename_board'], dataFrom: [], cardinality: { kind: 'once' } },
    ], universes: [] },
    bindings: [
      { operationId: 'read_before', role: 'source', capabilityRef: 'cap:local:space_get:read', evidence: ['tool_result'] },
      { operationId: 'rename_board', role: 'destination', capabilityRef: 'cap:local:space_save:reversible', evidence: ['local_commit_receipt'] },
      { operationId: 'read_after', role: 'readback', capabilityRef: 'cap:local:space_get:read', evidence: ['tool_result'] },
    ],
    deliverables: [{ id: 'updated_board', kind: 'workspace' }], evidenceRequirements: ['tool_result', 'local_commit_receipt'],
  } };
  const selectedCall = (callId: string, requirement_id: string, name: string, args: Record<string, unknown>) =>
    toolCall(callId, 'work_call', { requirement_id, name, args_json: JSON.stringify(args) });
  const model = stubModel([
    [toolCall('compound-context', 'call_tool', { name: 'space_get', args_json: JSON.stringify({ slug }) })],
    [toolCall('compound-discover-read', 'tool_search', { query: 'space_get', limit: 8 })],
    [toolCall('compound-discover-write', 'tool_search', { query: 'space_save', limit: 8 })],
    [toolCall('compound-plan', 'plan_task', planArgs)],
    [selectedCall('compound-before', 'read_before', 'space_get', { slug })],
    [selectedCall('compound-write', 'rename_board', 'space_save', { slug, title: 'Board reviewed' })],
    [selectedCall('compound-after', 'read_after', 'space_get', { slug })],
    [textMessage('The saved title is Board reviewed. The HTML and stored data are unchanged.')],
  ]);
  const agent = await buildOrchestratorAgent({ userInput: objective, ...identity,
    hostFreshPlanning: primed.planning, allowedToolNames: ['space_get', 'space_save', 'tool_search'], allowToolJit: true,
    mcpToolScope: { authority: 'none', reason: 'Native compound integration has no external authority',
      allowedServerSlugs: [], toolPatterns: [], maxTools: 0 }, model: model as never });
  const outcome = await brackets.withHarnessRunContext({ ...identity,
    counter: new brackets.ToolCallsCounter(12), behaviorScopeId: `${session.id}::source:${source.seq}` },
    () => hostRunRunner(throwingRunner() as never, agent as never,
      [{ type: 'message', role: 'user', content: objective }] as never,
      { maxTurns: 9, hostTurnEngine: 'host_v1', context: identity } as never));
  assert.equal(model.calls(), 8, JSON.stringify(outcome));
  assert.equal(outcome.hold, undefined, JSON.stringify(outcome));
  assert.match(String(outcome.finalOutput), /saved title is Board reviewed/);
  const history = outcome.history as unknown[];
  const plan = JSON.parse(historyResult(history, 'compound-plan'));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.requirements.map((requirement: { id: string; effect: string; dependsOn: string[] }) =>
    ({ id: requirement.id, effect: requirement.effect, dependsOn: requirement.dependsOn }))
    .sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)), [
    { id: 'read_after', effect: 'read', dependsOn: ['rename_board'] },
    { id: 'read_before', effect: 'read', dependsOn: [] },
    { id: 'rename_board', effect: 'local_write', dependsOn: ['read_before'] },
  ]);
  const { proveNativeRevisionCommit } = await import('./native-revision-commit-proof.js');
  const { loadExpectedWorkContract } = await import('./expected-work-contract.js');
  const { expectedWorkPlanLines } = await import('./expected-work-admission.js');
  const contract = loadExpectedWorkContract(session.id, source.seq);
  assert.equal(contract.status, 'ok');
  if (contract.status !== 'ok') throw new Error('exact contract missing');
  const proofInput = {sessionId:session.id,sourceUserSeq:source.seq,
    acceptedTaskId:contract.contract.acceptedTaskId,contractId:contract.contract.contractId,
    requirementId:'rename_board',logicalToolCallId:'compound-write'};
  const proof = proveNativeRevisionCommit(proofInput);
  assert.match(historyResult(history, 'compound-context'), /Board before review/);
  assert.match(historyResult(history, 'compound-before'), /Board before review/);
  assert.match(historyResult(history, 'compound-after'), /Board reviewed/,
    `selected read must return current title; native predecessor proof: ${JSON.stringify(proof)}`);
  const after = spaceStore.snapshot(slug)!;
  assert.equal(after.record.title, 'Board reviewed');
  assert.equal(after.record.version, before.record.version, 'metadata-only edits preserve the HTML revision number');
  assert.equal(after.view, before.view);
  assert.equal(after.data, before.data);
  const rows = eventlog.openEventLog().prepare(`SELECT logical_tool_call_id, outcome_kind, mutating, physical_crossing_count
    FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?
    AND logical_tool_call_id IN ('compound-context','compound-before','compound-write','compound-after') ORDER BY rowid`).all(session.id, source.seq);
  assert.deepEqual(rows, [
    { logical_tool_call_id: 'compound-context', outcome_kind: 'succeeded', mutating: 0, physical_crossing_count: 0 },
    { logical_tool_call_id: 'compound-before', outcome_kind: 'succeeded', mutating: 0, physical_crossing_count: 0 },
    { logical_tool_call_id: 'compound-write', outcome_kind: 'succeeded', mutating: 1, physical_crossing_count: 0 },
    { logical_tool_call_id: 'compound-after', outcome_kind: 'succeeded', mutating: 0, physical_crossing_count: 0 },
  ], 'one real native mutation; contextual and selected readers settle without mutation or provider crossing');
  assert.deepEqual(eventlog.openEventLog().prepare(`SELECT logical_tool_call_id, requirement_id FROM expected_work_call_bindings
    WHERE session_id=? AND source_user_seq=? ORDER BY requirement_id`).all(session.id, source.seq), [
    { logical_tool_call_id: 'compound-after', requirement_id: 'read_after' },
    { logical_tool_call_id: 'compound-before', requirement_id: 'read_before' },
    { logical_tool_call_id: 'compound-write', requirement_id: 'rename_board' },
  ]);
  assert.deepEqual(eventlog.openEventLog().prepare(`SELECT operation_id, logical_tool_call_id, effect_kind FROM accepted_task_operations
    WHERE session_id=? AND source_user_seq=? ORDER BY operation_id`).all(session.id, source.seq), [
    { operation_id: 'read_after', logical_tool_call_id: 'compound-after', effect_kind: 'read' },
    { operation_id: 'read_before', logical_tool_call_id: 'compound-before', effect_kind: 'read' },
    { operation_id: 'rename_board', logical_tool_call_id: 'compound-write', effect_kind: 'local_write' },
  ], 'all three graph operations resolve through selected bindings, never read fallback credit');
  assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested'] }).length, 0);
  assert.equal(proof.status, 'verified', JSON.stringify(proof));
  assert.equal(proveNativeRevisionCommit({...proofInput,sourceUserSeq:source.seq+1}).status,'unverified');
  assert.equal(proveNativeRevisionCommit({...proofInput,requirementId:'read_before'}).status,'unverified');
  assert.equal(proveNativeRevisionCommit({...proofInput,logicalToolCallId:'compound-before'}).status,'unverified');
  assert.equal(proveNativeRevisionCommit({...proofInput,contractId:'another-contract'}).status,'unverified');
  const settledCount = () => expectedWorkPlanLines(identity).find(row=>row.requirementId==='rename_board')?.settledInstances;
  assert.equal(settledCount(),1);
  if (proof.status !== 'verified') throw new Error('missing exact native proof');
  const receiptPath = path.join(nativeReadHome,proof.handle);
  const committedBytes = readFileSync(receiptPath);
  try {
    writeFileSync(receiptPath, Buffer.concat([committedBytes,Buffer.from('<!-- later unrelated drift -->')]));
    assert.equal(proveNativeRevisionCommit(proofInput).status,'unverified','current changed receipt bytes cannot discharge');
    assert.equal(settledCount(),0,'dependency oracle consumes current receipt proof, not outcome=succeeded');
    rmSync(receiptPath);
    assert.equal(proveNativeRevisionCommit(proofInput).status,'unverified','missing current artifact cannot discharge');
  } finally { writeFileSync(receiptPath,committedBytes); }
  assert.equal(settledCount(),1,'exact restored bytes recover without executing the write again');
  const retained = eventlog.openEventLog().prepare(`SELECT handle_id,raw_payload_json FROM durable_result_handles
    WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id='compound-write'`).get(session.id,source.seq) as {handle_id:string;raw_payload_json:string};
  const immutableTrigger = eventlog.openEventLog().prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_durable_result_identity_immutable'").get() as {sql:string};
  assert.ok(immutableTrigger?.sql);
  eventlog.openEventLog().exec('DROP TRIGGER trg_durable_result_identity_immutable');
  try {
    eventlog.openEventLog().prepare('UPDATE durable_result_handles SET raw_payload_json=? WHERE handle_id=?')
      .run(JSON.stringify('Saved, but no retained receipt'),retained.handle_id);
    assert.equal(proveNativeRevisionCommit(proofInput).status,'unverified','missing/tampered retained receipt fails canonical redemption');
    assert.equal(settledCount(),0);
  } finally {
    eventlog.openEventLog().prepare('UPDATE durable_result_handles SET raw_payload_json=? WHERE handle_id=?')
      .run(retained.raw_payload_json,retained.handle_id);
    eventlog.openEventLog().exec(immutableTrigger.sql);
  }
  eventlog.closeEventLog();
  assert.equal(proveNativeRevisionCommit(proofInput).status,'verified','source, selection, settlement and exact receipt survive reopen');

  // The previous fixture stopped at hostRunRunner. Actual terminal preparation
  // is a separate authority boundary: its readback role formerly reclassified
  // this exact point observation as an exhaustive collection and blocked it.
  const readInput = { ...identity, operation: selectedReadFact(session.id, source.seq, 'read_after') };
  const exactRead = { mode: 'point_read', requiresExhaustion: false, requiresStaleReconciliation: false };
  assert.deepEqual(boundReadEvidence.boundOnceReadEvidenceContract(readInput), exactRead);
  assert.equal(boundReadEvidence.boundOnceReadEvidenceContract({ ...readInput, sourceUserSeq: source.seq + 1 }), null);
  assert.equal(boundReadEvidence.boundOnceReadEvidenceContract({ ...readInput,
    operation: { ...readInput.operation, logicalToolCallId: 'compound-context' } }), null,
    'the same-context tool result cannot replace the exact selected call');
  const db = eventlog.openEventLog();
  const corruptions = [
    { name: 'missing binding', sql: `DELETE FROM expected_work_call_bindings WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id='compound-after'` },
    { name: 'wrong evidence basis', sql: `UPDATE expected_work_call_bindings SET evidence_basis='expected_complete_set' WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id='compound-after'` },
    { name: 'wrong effective arguments', sql: `UPDATE expected_work_call_bindings SET argument_digest='${'0'.repeat(64)}' WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id='compound-after'` },
  ];
  const expected = resolutionLedger.expectedTaskFor(session.id, source.seq);
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  for (const corruption of corruptions) {
    db.exec('SAVEPOINT native_read_terminal_counterexample');
    try {
      db.exec('DROP TRIGGER trg_expected_work_call_bindings_update_immutable');
      db.exec('DROP TRIGGER trg_expected_work_call_bindings_delete_immutable');
      db.prepare(corruption.sql).run(session.id, source.seq);
      assert.equal(boundReadEvidence.boundOnceReadEvidenceContract(readInput), null, corruption.name);
      const invalid = terminalPreparation.prepareAcceptedTaskTerminal({ ...identity,
        proposedReply: String(outcome.finalOutput) });
      assert.notEqual(invalid.status, 'ready', `${corruption.name}: ${JSON.stringify(invalid)}`);
      const compiled = obligationManifest.compileObligationManifest({ graph: expected.graph });
      const readback = compiled.manifest.nodes.find(node => node.operationId === 'read_after');
      assert.ok(!compiled.validation.ok || (readback?.operationMode === 'collection_read'
        && readback.obligations.includes('source_completeness')),
      `${corruption.name} must retain strict fallback or reject the damaged resolution: ${JSON.stringify(compiled)}`);
    } finally {
      db.exec('ROLLBACK TO native_read_terminal_counterexample');
      db.exec('RELEASE native_read_terminal_counterexample');
    }
  }
  assert.deepEqual(boundReadEvidence.boundOnceReadEvidenceContract(readInput), exactRead);
  const prepared = terminalPreparation.prepareAcceptedTaskTerminal({ ...identity,
    proposedReply: String(outcome.finalOutput) });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const manifestState = obligationStore.loadManifestState(session.id, source.seq);
  assert.equal(manifestState.status, 'ok');
  if (manifestState.status !== 'ok') throw new Error('missing compound terminal manifest');
  assert.deepEqual(manifestState.manifest.nodes.filter(node => node.effectKind === 'read').map(node => ({
    operationId: node.operationId, mode: node.operationMode, obligations: node.obligations,
  })).sort((a, b) => a.operationId.localeCompare(b.operationId)), [
    { operationId: 'read_after', mode: 'point_read', obligations: ['source_observed'] },
    { operationId: 'read_before', mode: 'point_read', obligations: ['source_observed'] },
  ]);
  assert.deepEqual(terminalProof.verifyAcceptedTaskTerminalProofInTransaction({ db, ...identity,
    acceptedTaskId: contract.contract.acceptedTaskId, manifest: manifestState.manifest }), { ok: true });
  const committed = delivery.commitTurnOutcome({ version: 2, id: turnOutcomes.turnOutcomeId(identity), identity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: String(outcome.finalOutput) } });
  assert.equal(committed.presentation.status, 'done', JSON.stringify(committed.presentation));
  assert.equal(model.calls(), 8, 'terminal proof must not request another model turn');
  assert.equal((db.prepare(`SELECT count(*) AS n FROM logical_call_settlements WHERE session_id=? AND source_user_seq=? AND mutating=1`)
    .get(session.id, source.seq) as { n: number }).n, 1, 'verification must not execute the effect again');
  assert.deepEqual(spaceStore.snapshot(slug), after, 'publication preserves the exact title/data/view generation');
  await new Promise<void>(resolve => setImmediate(resolve));
});
