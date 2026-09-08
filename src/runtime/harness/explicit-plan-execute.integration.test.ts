/**
 * End-to-end local-planning proof for ordinary Workspace creation.
 *
 * The foreground model authors one semantic space_save requirement through
 * plan_task, then invokes it through the production work_call carrier. A
 * second invocation of that frozen once requirement must reuse/refuse durable
 * state without entering the local body again.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/local-space-save-work-call.integration.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-explicit-plan-execute-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-space-save-work-call\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityEnvelopes = await import('../../agents/capability-envelope.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityManifestStores = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');
const planTools = await import('../../tools/plan-tools.js');
const workCallTools = await import('../../tools/work-call.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const terminalPreparation = await import('./accepted-task-terminal-preparation.js');
const delivery = await import('./delivery-committer.js');
const turnOutcomes = await import('./turn-outcome.js');
const writeLearning = await import('./verified-write-capability-learning.js');
const writeCapabilityStore = await import('../../memory/verified-write-capability-store.js');
const obligationStore = await import('./obligation-store.js');
const terminalProof = await import('./terminal-publication-proof.js');
const evidenceReceipts = await import('./evidence-receipts.js');
const localWriteCommit = await import('./host-local-write-commit.js');
const store = await import('../../spaces/store.js');
const workspaceDb = await import('../../spaces/workspace-db.js');
const dataStore = await import('../../spaces/data-store.js');
const workflowStore = await import('../../memory/workflow-store.js');

after(() => {
  writeCapabilityStore.closeVerifiedWriteCapabilityStoreForTests();
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
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

function fileDigest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function indexedFileFacts(workspaceId: string): Array<{
  rel_path: string;
  content_hash: string;
  version: number;
}> {
  return workspaceDb.openWorkspaceDb().prepare(`
    SELECT rel_path, content_hash, version
      FROM workspace_files
     WHERE workspace_id = ?
       AND rel_path IN ('view/index.html', 'notes.jsonl')
     ORDER BY rel_path
  `).all(workspaceId) as Array<{ rel_path: string; content_hash: string; version: number }>;
}


const publisher = await import('../../tools/publish-plan.js');
const plans = await import('./plan-artifacts.js');
const reviewedRuntime = await import('./reviewed-plan-runtime.js');
const executionContext = await import('./accepted-plan-execution.js');
test('explicit Plan prepares native Space schema without effects; Execute activates frozen draft once and replay never re-saves', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );

  const session = eventlog.createSession({ id: 'space-save-work-call', kind: 'chat' });
  let source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create one simple Workspace called Inline Proof.', taskMode: { version: 1, kind: 'plan' } },
  });
  let identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  let primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const search = buildScopedLocalToolSearch(
    new Set(['space_save']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const searchOutput = await search.invoke(
    new RunContext({ sessionId: session.id }),
    JSON.stringify({ query: 'space_save', role_key: null, limit: 8, account_selection: null }),
  );
  assert.match(String(searchOutput), /^\s*\{/, String(searchOutput));
  const searchBody = JSON.parse(String(searchOutput)) as {
    results: Array<{ name: string; capabilityRef?: string }>;
  };
  const capabilityRef = searchBody.results.find((row) => row.name === 'space_save')?.capabilityRef;
  assert.equal(capabilityRef, 'cap:local:space_save:reversible');

  const html = '<html><body><h1>Inline Proof</h1><p>One authoritative save.</p></body></html>';
  const initialData = {
    _mobile: {
      records: {
        items: [{
          primary: 'One complete authored artifact',
          body: 'This full body is committed with the view and manifest.',
        }],
      },
    },
  };
  const planArgs = {
    preamble: 'I’ll create the requested Workspace now.',
    draft: {
      criteria: ['One versioned Workspace renders the requested inline view.'],
      cardinality: null,
      destination: { posture: 'create_new', family: 'workspace', handleRequired: true },
      topology: {
        version: 1,
        operations: [{
          id: 'author_workspace',
          effect: 'local_write',
          coverage: null,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }],
        universes: [],
      },
      bindings: [{
        operationId: 'author_workspace',
        role: 'destination',
        capabilityRef,
        evidence: ['local_commit_receipt'],
      }],
      deliverables: [{ id: 'workspace_deliverable', kind: 'workspace' }],
      evidenceRequirements: ['local_commit_receipt'],
    },
  };
  const saveArgs = {
    slug: 'inline-proof',
    title: 'Inline Proof',
    objective: null,
    success_criteria: null,
    invariants: null,
    view_html: html,
    view_path: null,
    initial_data_json: JSON.stringify(initialData),
    data_sources: null,
    actions: null,
    reengage_triggers: null,
    reengage_guidance: null,
    origin_session_id: null,
  };
  const workArgs = {
    requirement_id: 'author_workspace',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'space_save',
    args_json: JSON.stringify(saveArgs),
  };
  const structuredPlan = await publisher.preparePlanOutline({ planning: primed.planning, ...identity, ready: true, raw: {
    executionDraft: planArgs.draft,
    steps: [{ id: 'author_workspace', action: 'Create the exact Inline Proof Workspace.', effect: 'local_write', capabilityRef,
      staticArguments: saveArgs, dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'One durable local commit receipt.' }],
    successCriteria: planArgs.draft.criteria, subagents: [],
  } });
  const planArtifactText = 'Create one simple Workspace called Inline Proof with the exact reviewed HTML and initial dataset.';
  const publicOutline = { steps: structuredPlan.steps, successCriteria: structuredPlan.successCriteria, subagents: structuredPlan.subagents };
  const publishTool = brackets.wrapToolForHarness(publisher.buildPublishPlanTool(primed.planning) as never);
  const planModel = stubModel([
    [toolCall('publish-reviewed-workspace', 'publish_plan', { full_text: planArtifactText, structured_plan: { ...publicOutline, steps: (publicOutline.steps as any[]).map(({ staticArguments, ...step }) => ({ ...step, staticArgumentsJson: JSON.stringify(staticArguments) })) },
      execution_draft: planArgs.draft, readiness: 'ready', missing_prerequisites: [], base_ref_json: null })],
    [textMessage('The full plan is ready for review.')],
  ]);
  const planAgent = { model: planModel, tools: [publishTool] };
  const planEnvelope = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [publishTool], activeToolNames: ['publish_plan'],
    policyHash: 'explicit-plan-publication', budget: { maxUncachedTokens: 20_000, maxModelCalls: 3, maxToolCalls: 3, maxElapsedMs: 60_000 } });
  assert.ok(planEnvelope.ok, JSON.stringify(planEnvelope)); if (!planEnvelope.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(planAgent, planEnvelope.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(planAgent, planEnvelope.revision);
  const planOutcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(3), behaviorScopeId: `${session.id}::plan` },
    () => hostRunRunner(throwingRunner() as never, planAgent as never,
      [{ type: 'message', role: 'user', content: 'Create one simple Workspace called Inline Proof.' }] as never,
      { maxTurns: 3, hostTurnEngine: 'host_v1', context: identity } as never));
  assert.equal(planOutcome.terminal, undefined, JSON.stringify(planOutcome));
  assert.equal(planOutcome.finalOutput, 'The full plan is ready for review.');
  const artifact = plans.getPlanRevisionForSource({ ...identity, principalId: session.id });
  assert.ok(artifact, JSON.stringify(planOutcome.history));
  if (!artifact) return;
  assert.equal(artifact.fullText, planArtifactText);
  const planTerminal = delivery.commitTurnOutcome({ version: 2, id: turnOutcomes.turnOutcomeId(identity), identity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: 'The full plan is ready for review.' } });
  assert.equal(planTerminal.presentation.status, 'done');
  assert.deepEqual(planTerminal.event.data.planArtifactRef, { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest });
  assert.equal(store.spaceStore.get('inline-proof'), undefined, 'Plan must not create the Workspace');
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Execute this exact reviewed plan.', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const claimed = plans.claimPlanExecution({ ...identity, principalId: session.id, executeRef: ref });
  assert.equal(claimed.replayed, false);
  primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok, JSON.stringify(primed));
  if (!primed.ok) return;
  await reviewedRuntime.revalidateReviewedPlanPreparation(primed.planning);
  const planTask = brackets.wrapToolForHarness(
    planTools.buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({
    requireHostPlan: true,
    reachableBuiltinNames: new Set(['space_save']),
    firstClassNames: new Set<string>(),
    catalogIdentifiers: ['space_save'],
    settlementLane: 'byo',
    hostPlanningReady: () => true,
  }) as never);
  assert.equal(workCallTools.isHostPlanRequiredWorkCall(workCall), true);

  const model = stubModel([
    [toolCall('plan-inline-workspace', 'plan_task', {})],
    [toolCall('save-inline-workspace', 'work_call', workArgs)],
    [toolCall('replay-inline-workspace', 'work_call', workArgs)],
    [textMessage('Created the Inline Proof Workspace.')],
  ]);
  const agent = { model, tools: [planTask, workCall] };
  const tools = [planTask, workCall];
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'space-save-work-call-test-v1',
    budget: {
      maxUncachedTokens: 2_000,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);

  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: executionContext.acceptedPlanExecutionText(session.id, source.seq)! }] as never,
    {
      maxTurns: 5,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    } as never,
  ));

  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, 'Created the Inline Proof Workspace.');
  assert.equal(model.calls(), 4);
  const db = eventlog.openEventLog();
  const physical = db.prepare(`
    SELECT tool_name, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY rowid
  `).all(session.id, source.seq) as Array<{ tool_name: string; state: string }>;
  const callResults = outcome.history
    .filter((item) => (item as { type?: string }).type === 'function_call_result')
    .map((item) => ({
      callId: (item as { callId?: unknown }).callId,
      output: (item as { output?: unknown }).output,
    }));
  const resultText = (callId: string): string => {
    const output = callResults.find((entry) => entry.callId === callId)?.output;
    if (typeof output === 'string') return output;
    if (output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
      return (output as { text: string }).text;
    }
    return '';
  };
  assert.match(resultText('plan-inline-workspace'), /"ok":true/);
  assert.match(resultText('save-inline-workspace'), /Created workspace "Inline Proof"/);
  assert.match(
    resultText('replay-inline-workspace'),
    /"disposition":"refused_pre_dispatch"/,
    'replay must be paired as a pre-dispatch refusal rather than entering space_save again',
  );
  const record = store.spaceStore.get('inline-proof');
  assert.equal(record?.version, 1, JSON.stringify({ callResults, physical }));
  assert.equal(
    readFileSync(store.resolveInSpace('inline-proof', 'view/index.html'), 'utf8'),
    html,
  );
  assert.deepEqual(dataStore.readData('inline-proof'), initialData);

  assert.equal(
    physical.filter((row) => row.tool_name === 'space_save' && row.state === 'returned').length,
    1,
    JSON.stringify(physical),
  );
  const mutationSettlements = db.prepare(`
    SELECT logical_tool_call_id, execution_kind, outcome_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND mutating = 1
     ORDER BY settled_at, logical_tool_call_id
  `).all(session.id, source.seq) as Array<{
    logical_tool_call_id: string;
    execution_kind: string;
    outcome_kind: string;
    physical_crossing_count: number;
  }>;
  assert.equal(
    mutationSettlements.filter((row) => row.outcome_kind === 'succeeded').length,
    1,
    JSON.stringify(mutationSettlements),
  );
  assert.deepEqual(mutationSettlements.map((row) => row.outcome_kind), [
    'succeeded',
    'policy_denial',
  ], 'the replay settles as a zero-crossing once-only refusal');
  assert.deepEqual(mutationSettlements.map((row) => ({
    id: row.logical_tool_call_id,
    execution: row.execution_kind,
    crossings: row.physical_crossing_count,
  })), [
    { id: 'save-inline-workspace', execution: 'local_execution', crossings: 0 },
    { id: 'replay-inline-workspace', execution: 'refused_pre_dispatch', crossings: 0 },
  ]);

  const prepared = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Created the Inline Proof Workspace.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  eventlog.closeEventLog();
  assert.equal(plans.getPlanExecutionClaim({ sessionId: session.id, principalId: session.id, ref })?.claimId, claimed.claim.claimId);
  assert.equal(store.spaceStore.get('inline-proof')?.version, 1);
});

test('a ready read-only revision executes the real prepared read without a plan activation', async () => {
  const local = await import('./local-planning-capability.js');
  const runtime = await import('../../tools/local-runtime-tools.js');
  const publisher = await import('../../tools/publish-plan.js');
  const plans = await import('./plan-artifacts.js');
  const reviewed = await import('./reviewed-plan-runtime.js');
  const execution = await import('./accepted-plan-execution.js');
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'read-only-reviewed-execution', kind: 'chat' });
  let source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Plan how to read the prepared local document.', taskMode: { version: 1, kind: 'plan' } } });
  const sourcePath = path.join(HOME, 'state/user-profile.json');
  const nonce = 'READ-ONLY-REVIEWED-NONCE-63171';
  writeFileSync(sourcePath, JSON.stringify({ displayName: 'Read-only fixture', notes: nonce }));
  let primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(primed.ok); if (!primed.ok) return;
  const candidate = await local.issueAuthorizedLocalPlanningDisclosureCandidate({ name: 'user_profile_read', carrier: 'work_call', configuredNames: new Set(runtime.getLocalToolSchemas().keys()) });
  assert.ok(candidate && !('refused' in candidate)); if (!candidate || 'refused' in candidate) return;
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates: [candidate] });
  const args = {};
  const outline = await publisher.preparePlanOutline({ sessionId: session.id, sourceUserSeq: source.seq, planning: primed.planning, ready: true, raw: {
    executionDraft: null, steps: [{ id: 'read_document', action: 'Read the exact local profile.', effect: 'read', capabilityRef: refs.user_profile_read, staticArguments: args, dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'Read result contains the document.' }], successCriteria: ['Read the requested document.'], subagents: [],
  } });
  const artifact = plans.publishPlanRevision({ sessionId: session.id, sourceUserSeq: source.seq, principalId: session.id, fullText: 'Read the exact local profile and report its contents.', structuredPlan: outline, readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: `Execute the reviewed plan, revision ${ref.revision}.`, taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  plans.claimPlanExecution({ sessionId: session.id, sourceUserSeq: source.seq, principalId: session.id, executeRef: ref });
  primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(primed.ok); if (!primed.ok) return;
  await reviewed.revalidateReviewedPlanPreparation(primed.planning);
  const built = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: source.seq, userInput: execution.acceptedPlanExecutionText(session.id, source.seq)!, allowToolJit: true, hostFreshPlanning: primed.planning });
  assert.equal(built.tools.some(tool => ['plan_task', 'draft_plan', 'publish_plan'].includes(tool.name)), false, 'read-only Execute does not expose a needless activation/replanning control');
  const read = brackets.wrapToolForHarness(runtime.getLocalRuntimeTools().find(tool => tool.name === 'user_profile_read') as never);
  const model = stubModel([[toolCall('read-reviewed-document', 'user_profile_read', args)], [textMessage('Read the requested document.')]]);
  const tools = [read]; const agent = { model, tools };
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: tools, activeToolNames: ['user_profile_read'], policyHash: 'read-only-reviewed', budget: { maxUncachedTokens: 20_000, maxModelCalls: 3, maxToolCalls: 3, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok); if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope); capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const outcome = await brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq, counter: new brackets.ToolCallsCounter(3) }, () => hostRunRunner(throwingRunner() as never, agent as never,
    [{ type: 'message', role: 'user', content: execution.acceptedPlanExecutionText(session.id, source.seq)! }] as never,
    { maxTurns: 3, hostTurnEngine: 'host_v1', context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn } } as never));
  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.match(JSON.stringify(outcome.history), new RegExp(nonce));
  assert.equal(eventlog.listEvents(session.id, { types: ['tool_called'] }).some(event => event.data.tool === 'plan_task'), false);
  assert.equal(model.calls(), 2);
});
