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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      execution_draft: null, readiness: 'ready', missing_prerequisites: [], base_ref_json: null })],
    [textMessage('The full plan is ready for review.')],
  ]);
  // Discovery can retire an unrelated previously connected tool while this
  // Plan turn is preparing its own operations. That catalog change must not
  // poison Plan's host root or grant any authority to execute the new plan.
  const { attachSemanticContract, capabilityManifestDigest } = await import('./capability-manifest.js');
  const unrelated = attachSemanticContract({
    version: 1, manifestId: 'cap:unrelated-prior-read', providerKind: 'native_mcp',
    operationId: 'unrelated__read', providerIdentity: 'unrelated', providerVersion: '1', operationVersion: '1',
    definitionFingerprint: createHash('sha256').update('unrelated read').digest('hex'), effect: 'read', accountId: 'unrelated-account',
    idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'result' }, evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: new Date().toISOString(), trusted: true }, lifecycle: { state: 'current' },
  });
  const manifestStore = capabilityManifestStores.resolveCapabilityManifestStore();
  assert.ok(manifestStore.install(unrelated).ok);
  const factory = capabilityCatalogs.peekHostCapabilityCatalogFactory()!;
  factory.register({ capabilityId: unrelated.manifestId, toolName: unrelated.operationId,
    schemaVersion: unrelated.operationVersion, schemaDigest: unrelated.definitionFingerprint,
    effect: unrelated.effect, account: unrelated.accountId, manifest: unrelated,
    manifestDigest: capabilityManifestDigest(unrelated), providerKind: unrelated.providerKind, invoke: async () => ({}) });
  const originalPlanResponse = planModel.getResponse.bind(planModel);
  planModel.getResponse = async () => {
    factory.forget(unrelated.manifestId);
    manifestStore.revoke(unrelated.manifestId);
    return originalPlanResponse();
  };
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
  // A Plan turn ends when its plan is published; the reply is the plan text
  // the model wrote, not a further model round.
  assert.equal(planOutcome.finalOutput, planArtifactText);
  const artifact = plans.getPlanRevisionForSource({ ...identity, principalId: session.id });
  assert.ok(artifact, JSON.stringify(planOutcome.history));
  if (!artifact) return;
  assert.equal(artifact.fullText, planArtifactText);
  const planTerminal = delivery.commitTurnOutcome({ version: 2, id: turnOutcomes.turnOutcomeId(identity), identity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: planArtifactText } });
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
  const artifact = plans.publishPlanRevision({ sessionId: session.id, sourceUserSeq: source.seq, principalId: session.id, fullText: 'Read the exact local profile and report its contents. Do not use external tools.', structuredPlan: outline, readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: `Execute the reviewed plan, revision ${ref.revision}.`, taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  plans.claimPlanExecution({ sessionId: session.id, sourceUserSeq: source.seq, principalId: session.id, executeRef: ref });
  primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(primed.ok); if (!primed.ok) return;
  await reviewed.revalidateReviewedPlanPreparation(primed.planning);
  const built = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: source.seq, userInput: execution.acceptedPlanExecutionText(session.id, source.seq)!, allowToolJit: true, hostFreshPlanning: primed.planning });
  assert.doesNotMatch(String(eventlog.listEvents(session.id, { types: ['mcp_tool_scope'] }).at(-1)?.data.reason), /user excluded|user refused|user prohibited|explicit local-only|user restricted/i, 'model-authored plan text cannot become an owner access prohibition');
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

for (const [wholeText, repair, review] of [[false, false, false], [true, false, false], [true, true, false], [true, true, true]]) test(`approved research → synthesis → write uses ${wholeText ? 'whole text' : 'object fields'} and survives reopen${repair ? ' with an owned-file correction' : ''}${review ? ' requested by the completion judge' : ''}`, async () => {
  const local = await import('./local-planning-capability.js');
  const runtime = await import('../../tools/local-runtime-tools.js');
  const { getCoreTools } = await import('../../tools/registry.js');
  const publisher = await import('../../tools/publish-plan.js');
  const plans = await import('./plan-artifacts.js');
  const reviewed = await import('./reviewed-plan-runtime.js');
  const results = await import('./reviewed-plan-results.js');
  const execution = await import('./accepted-plan-execution.js');
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'runtime-synthesis', kind: 'chat' });
  let source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Plan to read the latest profile and synthesize a local briefing. Do not write during Plan.', taskMode: { version: 1, kind: 'plan' } } });
  let identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  let primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok); if (!primed.ok) throw new Error(primed.reason);
  const names = new Set(getCoreTools().map(t => t.name));
  const candidates = await Promise.all(['read_file', 'write_file'].map(name => local.issueAuthorizedLocalPlanningDisclosureCandidate({ name, carrier: 'work_call', configuredNames: names })));
  assert.ok(candidates.every(c => c && !('refused' in c)));
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates: candidates as any });
  const outputPath = path.join(HOME, `runtime-synthesized-${wholeText ? 'text' : 'object'}-${repair ? 'repair' : 'clean'}-${review ? 'review' : 'self'}.md`);
  const base = { subagentRole: null, dynamicBindings: [], dependsOn: [] };
  const outline = await publisher.preparePlanOutline({ ...identity, planning: primed.planning, ready: true, raw: {
    steps: [
      { ...base, id: 'research', action: 'Read the latest profile.', effect: 'read', capabilityRef: refs.read_file, staticArguments: { path: path.join(HOME, 'state/user-profile.json') }, verification: 'Current profile returned.' },
      { ...base, id: 'synthesize', action: 'Write a short Markdown briefing containing the current profile notes.', effect: 'compute', capabilityRef: null, staticArguments: {}, dependsOn: ['research'], verification: 'The briefing includes the exact current note.' },
      { ...base, id: 'save', action: 'Save the synthesized briefing.', effect: 'local_write', capabilityRef: refs.write_file, staticArguments: { path: outputPath },
        dynamicBindings: [{ producerStepId: 'synthesize', outputPath: wholeText ? '' : '/markdown', targetPath: '/content', expectedType: 'string' }], verification: 'Committed bytes equal the recorded synthesis.' },
      ...(repair ? [{ ...base, id: 'verify', action: 'Read the saved briefing back.', effect: 'read', capabilityRef: refs.read_file,
        staticArguments: { path: outputPath }, dependsOn: ['save'], verification: 'Read the current saved text.' }] : []),
    ], successCriteria: ['One file with the current profile note, no duplicate effects.'], subagents: [],
  } });
  const artifact = plans.publishPlanRevision({ ...identity, principalId: session.id, fullText: 'Read the current profile, synthesize a briefing, and save it.', structuredPlan: outline, readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const nonce = 'AFTER-PLAN-RESEARCH-97231';
  writeFileSync(path.join(HOME, 'state/user-profile.json'), JSON.stringify({ displayName: 'Research fixture', notes: nonce }));
  assert.doesNotMatch(JSON.stringify(artifact), new RegExp(nonce), 'the plan did not pretend to know future findings');
  source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Execute this reviewed plan.', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  plans.claimPlanExecution({ ...identity, principalId: session.id, executeRef: ref });
  primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok); if (!primed.ok) throw new Error(primed.reason);
  await reviewed.revalidateReviewedPlanPreparation(primed.planning);
  assert.throws(() => results.recordReviewedPlanStepResult(identity, 'synthesize', { markdown: 'premature' }), /Activate|settled result/);
  const input = execution.acceptedPlanExecutionText(session.id, source.seq)!;
  const built = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: source.seq, userInput: input, allowToolJit: true, hostFreshPlanning: primed.planning });
  assert.ok(built.tools.some(t => t.name === 'plan_step_result'), 'the actual Execute surface contains the result channel');
  const workTool = built.tools.find(t => t.name === 'work_call')!;
  assert.match(workTool.description, /plan_step_result/);
  assert.match(workTool.description, /omit the bound argument fields/);
  assert.doesNotMatch(workTool.description, /compute ONLY for work a tool will perform/,
    'the Execute carrier must not contradict its reviewed model-authored synthesis step');
  const resultTool = built.tools.find(t => t.name === 'plan_step_result')!;
  if (wholeText) {
    assert.equal((resultTool.parameters as any).properties.data.type, 'string', 'whole-text synthesis advertises its actual argument type');
    assert.doesNotMatch(resultTool.description, /\{"markdown"/);
  } else {
    assert.notEqual((resultTool.parameters as any).properties.data.type, 'string', 'object bindings keep structured data available');
  }
  const supplementalPath = path.join(HOME, 'supplemental-profile-note.txt');
  const supplementalNote = 'Supplemental observation: the delivery window is Thursday.';
  writeFileSync(supplementalPath, supplementalNote);
  const content = `# Briefing\n\n${nonce}\n${wholeText ? supplementalNote : ''}\n`;
  const initialContent = repair ? '# Briefing\n\nAn unsupported first draft.\n' : content;
  const resultValue = (text: string) => wholeText ? text : { markdown: text };
  const work = (id: string, name: string, args: unknown) => ({ requirement_id: id, name, args_json: JSON.stringify(args), source_call_ids: null, source_record_ids: null });
  const frames = [
    [toolCall('activate-runtime-synthesis', 'plan_task', {})],
    [toolCall('read-runtime-synthesis', 'work_call', work('research', 'read_file', { path: path.join(HOME, 'state/user-profile.json') }))],
    ...(wholeText ? [[toolCall('missing-supplement-runtime-synthesis', 'work_call', work(refs.read_file!, 'read_file', { path: path.join(HOME, 'missing-note.txt') }))]] : []),
    ...(wholeText ? [[toolCall('supplement-runtime-synthesis', 'work_call', work(refs.read_file!, 'read_file', { path: supplementalPath }))]] : []),
    [toolCall('record-runtime-synthesis', 'plan_step_result', { step_id: 'synthesize', data: resultValue(initialContent) })],
    [toolCall('write-runtime-synthesis', 'work_call', work('save', 'write_file', { path: outputPath, ...(wholeText ? { content: 'A retyped paraphrase must never replace the recorded briefing.' } : {}) }))],
    ...(repair ? [[toolCall('initial-readback-runtime-synthesis', 'work_call', work('verify', 'read_file', { path: outputPath }))]] : []),
    ...(review ? [[textMessage('The first briefing is saved.')]] : []),
    ...(repair ? [
      [toolCall('correct-runtime-synthesis', 'plan_step_result', { step_id: 'synthesize', data: resultValue(content) })],
      [toolCall('revise-runtime-synthesis', 'work_call', work('save', 'write_file', { path: outputPath }))],
    ] : []),
    [repair ? toolCall('readback-runtime-synthesis', 'work_call', work('verify', 'read_file', { path: outputPath })) : wholeText
      ? toolCall('readback-runtime-synthesis', 'work_call', work(refs.read_file!, 'read_file', { path: outputPath }))
      : toolCall('readback-runtime-synthesis', 'call_tool', { name: 'read_file', args_json: JSON.stringify({ path: outputPath }) })],
    [textMessage('The briefing is saved.')],
  ];
  let calls = 0;
  const model = { async getResponse(request: any) {
    if (calls === 2) assert.match(JSON.stringify(request.input), new RegExp(nonce), 'the model sees the actual settled research');
    if (calls === (wholeText ? 4 : 2)) assert.ok(JSON.stringify(request.input).includes(wholeText ? supplementalNote : nonce));
    if (calls === (wholeText ? 5 : 3)) {
      eventlog.closeEventLog();
      assert.deepEqual(results.resolveReviewedPlanStepResult(identity, 'synthesize'), resultValue(initialContent));
      const stored = eventlog.openEventLog().prepare('SELECT inputs_json FROM reviewed_plan_step_results_v1 WHERE session_id=? AND source_user_seq=? ORDER BY id DESC LIMIT 1').get(session.id, source.seq) as { inputs_json: string };
      const inputs = JSON.parse(stored.inputs_json);
      assert.equal(inputs.version, 2);
      if (wholeText) {
        assert.ok(inputs.supplementalReads.some((row: any) => row.callId === 'supplement-runtime-synthesis' && row.digest.length === 64), 'the optional read survives reopen with the synthesis');
        assert.ok(!inputs.supplementalReads.some((row: any) => row.callId === 'missing-supplement-runtime-synthesis'), 'a failed read is not represented as evidence of its missing content');
        const corrupted = structuredClone(inputs);
        corrupted.supplementalReads[0].digest = '0'.repeat(64);
        const updateInputs = eventlog.openEventLog().prepare('UPDATE reviewed_plan_step_results_v1 SET inputs_json=? WHERE session_id=? AND source_user_seq=?');
        updateInputs.run(JSON.stringify(corrupted), session.id, source.seq);
        assert.throws(() => results.resolveReviewedPlanStepResult(identity, 'synthesize'), /changed or lost its source evidence/);
        updateInputs.run(stored.inputs_json, session.id, source.seq);
      }
      // Existing saved results use the flat dependency-digest shape.
      eventlog.openEventLog().prepare('UPDATE reviewed_plan_step_results_v1 SET inputs_json=? WHERE session_id=? AND source_user_seq=?')
        .run(JSON.stringify(inputs.dependencies), session.id, source.seq);
      assert.deepEqual(results.resolveReviewedPlanStepResult(identity, 'synthesize'), resultValue(initialContent));
      eventlog.openEventLog().prepare('UPDATE reviewed_plan_step_results_v1 SET inputs_json=? WHERE session_id=? AND source_user_seq=?')
        .run(stored.inputs_json, session.id, source.seq);
      assert.match(reviewed.reviewedPlanCallRefusal({ ...identity, toolName: 'work_call', effect: 'read',
        args: work('research', 'read_file', { path: supplementalPath }) })!, /REVIEWED_PLAN_CALL_REFUSED/, 'an extra read cannot claim changed arguments for a planned step');
      assert.match(reviewed.reviewedPlanCallRefusal({ ...identity, toolName: 'work_call', effect: 'local_write',
        args: work(refs.write_file!, 'write_file', { path: outputPath + '.extra', content }) })!, /REVIEWED_PLAN_CALL_REFUSED/, 'supplemental reads never widen write authority');
      const materialize = (id: string, args: unknown, name = 'write_file') => reviewed.materializeReviewedPlanCallArguments({ ...identity,
        toolName: 'work_call', argumentsJson: JSON.stringify(work(id, name, args)) });
      const bound = materialize('save', { path: outputPath + '.unapproved', content: 'retyped' });
      assert.ok(bound, 'declared result fields are materialized from the reopened synthesis');
      const boundCall = JSON.parse(bound.argumentsJson);
      assert.deepEqual(JSON.parse(boundCall.args_json), { path: outputPath + '.unapproved', content: initialContent }, 'only result-bound fields change');
      assert.match(reviewed.reviewedPlanCallRefusal({ ...identity, toolName: 'work_call', args: boundCall, effect: 'local_write' })!, /arguments differ at \/path/, 'an unapproved static destination remains refused');
      assert.equal(materialize('not-a-reviewed-step', { path: outputPath }), undefined);
      assert.equal(materialize('save', { path: outputPath }, 'delete_file'), undefined, 'binding a result cannot select a different operation');
      assert.equal(reviewed.materializeReviewedPlanCallArguments({ ...identity, sourceUserSeq: artifact.sourceUserSeq,
        toolName: 'work_call', argumentsJson: JSON.stringify(work('save', 'write_file', { path: outputPath })) }), undefined, 'another accepted source cannot borrow this binding');
      assert.throws(() => results.recordReviewedPlanStepResult(identity, 'synthesize', { wrongField: content }), /must be string/);
      assert.throws(() => results.recordReviewedPlanStepResult(identity, 'synthesize', undefined), /closed JSON domain/);
      assert.throws(() => results.recordReviewedPlanStepResult(identity, 'synthesize', { invalid: Number.NaN }), /finite/);
      results.recordReviewedPlanStepResult(identity, 'synthesize', resultValue('A draft to revise before writing.'));
      results.recordReviewedPlanStepResult(identity, 'synthesize', resultValue(initialContent));
      eventlog.closeEventLog();
      assert.deepEqual(results.resolveReviewedPlanStepResult(identity, 'synthesize'), resultValue(initialContent), 'A → B → A records A as current without erasing the earlier revision');
    }
    const output = frames[Math.min(calls++, frames.length - 1)];
    return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output, responseId: `runtime-synthesis-${calls}` };
  }, getStreamedResponse: testModelStream };
  const tools = built.tools.filter(t => ['plan_task', 'work_call', 'plan_step_result', 'call_tool'].includes(t.name));
  const agent = { model, tools };
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: tools, activeToolNames: tools.map(t => t.name), policyHash: 'runtime-synthesis', budget: { maxUncachedTokens: 100_000, maxModelCalls: 12, maxToolCalls: frames.length * 2, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok); if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope); capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const { _setHostObjectiveJudgeForTests } = await import('./host-turn-runner.js');
  let reviewCalls = 0;
  _setHostObjectiveJudgeForTests(async () => {
    reviewCalls++;
    return { done: readFileSync(outputPath, 'utf8') === content,
      reason: 'Compare the saved briefing with the current notes. Correct unsupported content in the same owned file.' };
  });
  const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(frames.length * 2) }, () => hostRunRunner(throwingRunner() as never, agent as never,
    [{ type: 'message', role: 'user', content: input }] as never, { maxTurns: 12, hostTurnEngine: 'host_v1', hostJudgeCompletion: review, context: identity } as never));
  _setHostObjectiveJudgeForTests(null);
  assert.equal(reviewCalls, review ? 2 : 0);
  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(calls, frames.length, 'the read failure and alternate source complete without an extra model frame');
  assert.ok(existsSync(outputPath), JSON.stringify(outcome.history.filter((item: any) => item.type === 'function_call_result')));
  assert.equal(readFileSync(outputPath, 'utf8'), content, JSON.stringify(outcome.history.filter((item: any) => item.type === 'function_call_result')));
  const readback = outcome.history.find((item: any) => item.type === 'function_call_result' && item.callId === 'readback-runtime-synthesis');
  assert.match(JSON.stringify(readback), new RegExp(nonce), 'selecting a reader for the plan must not prevent a later contextual readback');
  const settled = eventlog.openEventLog().prepare('SELECT outcome_kind,mutating FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?').all(session.id, source.seq) as any[];
  assert.equal(settled.filter(x => x.mutating && x.outcome_kind === 'succeeded').length, repair ? 2 : 1);
  if (repair) {
    const firstReadback = outcome.history.find((item: any) => item.type === 'function_call_result' && item.callId === 'initial-readback-runtime-synthesis');
    assert.match(JSON.stringify(firstReadback), /unsupported first draft/);
    assert.doesNotMatch(JSON.stringify(readback), /unsupported first draft/);
    assert.match(String(results.resolveReviewedPlanStepResult(identity, 'verify')), new RegExp(nonce), 'a reviewed readback refreshes after the upstream file changes');
    const journal = eventlog.openEventLog().prepare('SELECT correction_json FROM reviewed_file_corrections_v1 WHERE session_id=? AND source_user_seq=?').all(session.id, source.seq) as any[];
    assert.equal(journal.length, 1);
    const correction = JSON.parse(journal[0].correction_json);
    assert.equal(correction.priorCallId, 'write-runtime-synthesis');
    const correctionProof = await import('./reviewed-file-correction.js');
    assert.deepEqual([...correctionProof.supersededReviewedFileCalls(identity, 'save')], ['write-runtime-synthesis']);
    assert.equal(correctionProof.supersededReviewedFileCalls(identity, 'save', new Set(['write-runtime-synthesis'])).size, 0,
      'a replacement missing from observed authority cannot remove the original obligation');
    assert.deepEqual([...correctionProof.supersededReviewedFileCalls({ ...identity, sourceUserSeq: artifact.sourceUserSeq }, 'save')], []);
    const graphState = (await import('./resolution-ledger.js')).expectedTaskFor(session.id, source.seq);
    assert.equal(graphState.status, 'ok'); if (graphState.status !== 'ok') throw new Error(graphState.reason);
    const finalized = (await import('./resolution-ledger.js')).finalizeResolutionAgainstExpectedWork(identity);
    assert.ok(finalized.status === 'finalized' || finalized.status === 'replayed', JSON.stringify(finalized));
    const { compileObligationManifest } = await import('./obligation-manifest.js');
    const manifestWrites = () => compileObligationManifest({ graph: graphState.graph }).manifest.nodes.filter(node => node.effectKind === 'local_write');
    assert.equal(manifestWrites().length, 1, JSON.stringify(compileObligationManifest({ graph: graphState.graph })));
    for (const tamper of [{ priorCallId: 'supplement-runtime-synthesis' }, { priorReceiptDigest: '0'.repeat(64) }, { resultId: -1 }, { content: 'unproven replacement' }]) {
      eventlog.openEventLog().prepare('UPDATE reviewed_file_corrections_v1 SET correction_json=? WHERE session_id=? AND source_user_seq=?')
        .run(JSON.stringify({ ...correction, ...tamper }), session.id, source.seq);
      assert.equal(correctionProof.supersededReviewedFileCalls(identity, 'save').size, 0, 'a mismatched lineage cannot hide a settled write');
      assert.equal(compileObligationManifest({ graph: graphState.graph }).manifest.readiness, 'unresolved',
        'invalid lineage prevents the frozen work contract from certifying completion');
    }
    eventlog.openEventLog().prepare('UPDATE reviewed_file_corrections_v1 SET correction_json=? WHERE session_id=? AND source_user_seq=?')
      .run(journal[0].correction_json, session.id, source.seq);
    const receipts = (await import('./host-turn-runner.js')).settledSourceArtifacts(identity);
    assert.equal(receipts.artifacts.filter(row => row.superseded).length, 1, 'the first receipt remains explicitly historical');
    assert.equal(receipts.artifacts.filter(row => !row.superseded && row.digestMatches).length, 1, 'only the corrected current bytes certify completion');
    assert.match(String(results.resolveReviewedPlanStepResult(identity, 'save')), /Overwrote/, 'downstream consumers use the exact revised result');

    assert.equal(correction.expectedContentDigest, createHash('sha256').update(initialContent).digest('hex'));
    const receiptRows = eventlog.openEventLog().prepare('SELECT result_json FROM reviewed_plan_step_results_v1 WHERE session_id=? AND source_user_seq=? ORDER BY id').all(session.id, source.seq) as any[];
    assert.ok(receiptRows.some(row => JSON.parse(row.result_json) === initialContent), 'first synthesis remains immutable history');
    eventlog.closeEventLog();
    assert.equal(readFileSync(outputPath, 'utf8'), content, JSON.stringify(outcome.history.filter((item: any) => item.type === 'function_call_result')));
  }
  assert.equal(results.recordReviewedPlanStepResult(identity, 'synthesize', resultValue(content)).replayed, true);
  eventlog.closeEventLog();
  const terminal = terminalPreparation.prepareAcceptedTaskTerminal({ ...identity, proposedReply: 'The briefing is saved.' });
  assert.equal(terminal.status, 'ready', JSON.stringify(terminal));
  const { commitTurnOutcome } = await import('./delivery-committer.js');
  const { turnOutcomeId } = await import('./turn-outcome.js');
  const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: 'The briefing is saved.' } });
  assert.equal(committed.presentation.status, 'done', JSON.stringify(committed.presentation));
  writeFileSync(outputPath, 'An intervening owner edit.');
  assert.throws(() => results.recordReviewedPlanStepResult(identity, 'synthesize', resultValue('changed after effect')), /successful write/, 'an intervening edit prevents automatic replacement');
  assert.equal(readFileSync(outputPath, 'utf8'), 'An intervening owner edit.');
  assert.throws(() => results.recordReviewedPlanStepResult(identity, 'save', resultValue(content)), /Only a reviewed compute/);
  assert.throws(() => results.resolveReviewedPlanStepResult({ ...identity, sourceUserSeq: artifact.sourceUserSeq }, 'synthesize'), /selected ready plan/);
});

test('a reviewed runtime collection uses the complete current read and keeps member progress across reopen', async () => {
  const local = await import('./local-planning-capability.js');
  const { getCoreTools } = await import('../../tools/registry.js');
  const publisher = await import('../../tools/publish-plan.js');
  const plans = await import('./plan-artifacts.js');
  const reviewed = await import('./reviewed-plan-runtime.js');
  const results = await import('./reviewed-plan-results.js');
  const execution = await import('./accepted-plan-execution.js');
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'runtime-collection', kind: 'chat' });
  let source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Plan to read the current batch and save each exact record to its stated local path.', taskMode: { version: 1, kind: 'plan' } } });
  let identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  let primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok); if (!primed.ok) throw new Error(primed.reason);
  const names = new Set(getCoreTools().map(t => t.name));
  const candidates = await Promise.all(['read_file', 'write_file'].map(name => local.issueAuthorizedLocalPlanningDisclosureCandidate({ name, carrier: 'work_call', configuredNames: names })));
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates: candidates as any });
  const sourcePath = path.join(HOME, 'current-collection.json');
  writeFileSync(sourcePath, JSON.stringify([{ id: 'before-plan', path: path.join(HOME, 'old.md'), content: 'old' }]));
  const outline = await publisher.preparePlanOutline({ ...identity, planning: primed.planning, ready: true, raw: {
    steps: [
      { id: 'read', action: 'Read the entire current collection.', capabilityRef: refs.read_file, staticArguments: { path: sourcePath }, verification: 'Complete current records returned.' },
      { id: 'save', action: 'Save each current record.', capabilityRef: refs.write_file, verification: 'Each record saved once with exact content.',
        forEach: { producerStepId: 'read', memberIdPath: '/id', bindings: [{ itemPath: '/path', targetPath: '/path' }, { itemPath: '/content', targetPath: '/content' }] } },
    ], successCriteria: ['All records in the current complete collection saved once.'],
  } });
  const artifact = plans.publishPlanRevision({ ...identity, principalId: session.id, fullText: 'Read the whole current batch and save each exact record. The collection is determined by the execution-time read.', structuredPlan: outline, readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const records = Array.from({ length: 3 }, (_, i) => ({ id: `current-${i}`, path: path.join(HOME, `current-member-${i}.md`), content: `Execution-only value ${i}\nLiteral \\n retained.\n` }));
  writeFileSync(sourcePath, JSON.stringify(records));
  assert.doesNotMatch(JSON.stringify(artifact), /Execution-only/);
  source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Execute.', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  plans.claimPlanExecution({ ...identity, principalId: session.id, executeRef: ref });
  primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok); if (!primed.ok) throw new Error(primed.reason);
  await reviewed.revalidateReviewedPlanPreparation(primed.planning);
  const input = execution.acceptedPlanExecutionText(session.id, source.seq)!;
  const built = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: source.seq, userInput: input, allowToolJit: true, hostFreshPlanning: primed.planning });
  const write = (index: number, callId = `save-member-${index}`) => toolCall(callId, 'work_call', { requirement_id: 'save', universe_item_id: records[index]!.id, name: 'write_file', args_json: JSON.stringify(index === 1 ? {} : { path: records[index]!.path, content: 'The host must use the exact member content.' }) });
  const frames = [
    [toolCall('activate-collection', 'plan_task', {})],
    [toolCall('read-collection', 'work_call', { requirement_id: 'read', name: 'read_file', args_json: JSON.stringify({ path: sourcePath }) })],
    [write(0)], [write(1), write(2)], [write(0, 'replay-member-0')], [textMessage('All current records saved exactly once.')],
  ];
  let frame = 0;
  const model = { async getResponse() {
    if (frame === 3) {
      eventlog.closeEventLog();
      assert.equal(readFileSync(records[0]!.path, 'utf8'), records[0]!.content);
      assert.throws(() => results.resolveReviewedPlanStepResult(identity, 'save'), /not complete/);
    }
    const output = frames[Math.min(frame++, frames.length - 1)];
    return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output, responseId: `collection-${frame}` };
  }, getStreamedResponse: testModelStream };
  const tools = built.tools.filter(t => ['plan_task', 'work_call'].includes(t.name));
  const agent = { model, tools };
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: tools, activeToolNames: tools.map(t => t.name), policyHash: 'runtime-collection', budget: { maxUncachedTokens: 100_000, maxModelCalls: 8, maxToolCalls: 10, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok); if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope); capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(10) }, () => hostRunRunner(throwingRunner() as never, agent as never,
    [{ type: 'message', role: 'user', content: input }] as never, { maxTurns: 8, hostTurnEngine: 'host_v1', context: identity } as never));
  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  for (const record of records) assert.equal(readFileSync(record.path, 'utf8'), record.content);
  assert.equal(existsSync(path.join(HOME, 'old.md')), false);
  const settlements = eventlog.openEventLog().prepare('SELECT outcome_kind,mutating FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?').all(session.id, source.seq) as any[];
  assert.equal(settlements.filter(x => x.mutating && x.outcome_kind === 'succeeded').length, 3, JSON.stringify(settlements));
  assert.equal(settlements.filter(x => x.outcome_kind === 'policy_denial').length, 1, 'completed member replay stays refused');
  eventlog.closeEventLog();
  assert.equal((results.resolveReviewedPlanStepResult(identity, 'save') as any).items.length, 3);
  const terminal = terminalPreparation.prepareAcceptedTaskTerminal({ ...identity, proposedReply: 'All three current records saved.' });
  assert.equal(terminal.status, 'ready', JSON.stringify(terminal));
  const { commitTurnOutcome } = await import('./delivery-committer.js');
  const { turnOutcomeId } = await import('./turn-outcome.js');
  const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: 'All three current records saved.' } });
  assert.equal(committed.presentation.status, 'done', JSON.stringify(committed.presentation));
});

test('repeated reads feed repeated writes with exact member results across reopen and terminal commit', async () => {
  const local = await import('./local-planning-capability.js');
  const { getCoreTools } = await import('../../tools/registry.js');
  const publisher = await import('../../tools/publish-plan.js');
  const plans = await import('./plan-artifacts.js');
  const reviewed = await import('./reviewed-plan-runtime.js');
  const results = await import('./reviewed-plan-results.js');
  const execution = await import('./accepted-plan-execution.js');
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(capabilityManifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'chained-collection', kind: 'chat' });
  let source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Plan to read the current batch and save each exact record to its stated local path.', taskMode: { version: 1, kind: 'plan' } } });
  let identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  let primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok); if (!primed.ok) throw new Error(primed.reason);
  const names = new Set(getCoreTools().map(t => t.name));
  const candidates = await Promise.all(['read_file', 'write_file'].map(name => local.issueAuthorizedLocalPlanningDisclosureCandidate({ name, carrier: 'work_call', configuredNames: names })));
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates: candidates as any });
  const records = Array.from({ length: 3 }, (_, i) => ({ id: path.join(HOME, `chain-output-${i}.md`), sourcePath: path.join(HOME, `chain-input-${i}.txt`), content: `Current result ${i}\n` }));
  for (const record of records) writeFileSync(record.sourcePath, 'old content');
  const outline = await publisher.preparePlanOutline({ ...identity, planning: primed.planning, ready: true, raw: {
    steps: [
      { id: 'read', action: 'Read each current source.', capabilityRef: refs.read_file, verification: 'Each input read once.',
        forEach: { items: records.map(({ id, sourcePath }) => ({ id, path: sourcePath })), memberIdPath: '/id', bindings: [{ itemPath: '/path', targetPath: '/path' }] } },
      { id: 'save', action: 'Save each corresponding result.', capabilityRef: refs.write_file, verification: 'Each current result saved once under its own member ID.',
        forEach: { producerStepId: 'read', bindings: [{ itemPath: '/memberId', targetPath: '/path' }, { itemPath: '/result', targetPath: '/content' }] } },
    ], successCriteria: ['All current results saved once.'],
  } });
  const graph = outline.executionDraft as any;
  assert.equal(graph.topology.universes.length, 1, 'repeated stages share member identity');
  assert.deepEqual(graph.topology.operations[1].cardinality, graph.topology.operations[0].cardinality);
  assert.deepEqual(graph.topology.operations[1].dataFrom, ['read']);
  const artifact = plans.publishPlanRevision({ ...identity, principalId: session.id, fullText: 'Read the whole current batch and save each exact record. The collection is determined by the execution-time read.', structuredPlan: outline, readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  for (const record of records) writeFileSync(record.sourcePath, record.content);
  assert.doesNotMatch(JSON.stringify(artifact), /Current result/);
  source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Execute.', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  plans.claimPlanExecution({ ...identity, principalId: session.id, executeRef: ref });
  primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok); if (!primed.ok) throw new Error(primed.reason);
  await reviewed.revalidateReviewedPlanPreparation(primed.planning);
  const input = execution.acceptedPlanExecutionText(session.id, source.seq)!;
  const built = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: source.seq, userInput: input, allowToolJit: true, hostFreshPlanning: primed.planning });
  const write = (index: number, callId = `save-member-${index}`) => toolCall(callId, 'work_call', { requirement_id: 'save', universe_item_id: records[index]!.id, name: 'write_file', args_json: JSON.stringify({ path: records[index]!.id, content: records[index]!.content }) });
  const frames = [
    [toolCall('activate-collection', 'plan_task', {})],
    records.map((record, i) => toolCall(`read-chain-${i}`, 'work_call', { requirement_id: 'read', universe_item_id: record.id, name: 'read_file', args_json: JSON.stringify({ path: record.sourcePath }) })),
    [write(0)], [write(1), write(2)], [write(0, 'replay-member-0')], [textMessage('All current records saved exactly once.')],
  ];
  let frame = 0;
  const model = { async getResponse(request: unknown) {
    if (frame === 2) {
      const exact = { ...identity, stepId: 'read', memberId: records[0]!.id, toolName: 'read_file', args: { path: records[0]!.sourcePath } };
      assert.equal(reviewed.reviewedPlanMemberReadArgumentsMatch(exact), true);
      assert.equal(reviewed.reviewedPlanMemberReadArgumentsMatch({ ...exact, memberId: records[1]!.id }), false);
      assert.equal(reviewed.reviewedPlanMemberReadArgumentsMatch({ ...exact, sourceUserSeq: source.seq + 1 }), false);
      assert.equal(reviewed.reviewedPlanMemberReadArgumentsMatch({ ...exact, args: { path: records[0]!.sourcePath, max_chars: 1 } }), false);
    }
    if (frame === 3) {
      eventlog.closeEventLog();
      assert.ok(existsSync(records[0]!.id), JSON.stringify((request as any).input?.filter((item: any) => item.type === 'function_call_result')));
      assert.equal(readFileSync(records[0]!.id, 'utf8'), records[0]!.content);
      assert.throws(() => results.resolveReviewedPlanStepResult(identity, 'save'), /not complete/);
    }
    const output = frames[Math.min(frame++, frames.length - 1)];
    return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 }, output, responseId: `collection-${frame}` };
  }, getStreamedResponse: testModelStream };
  const tools = built.tools.filter(t => ['plan_task', 'work_call'].includes(t.name));
  const agent = { model, tools };
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: tools, activeToolNames: tools.map(t => t.name), policyHash: 'chained-collection', budget: { maxUncachedTokens: 100_000, maxModelCalls: 8, maxToolCalls: 10, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok); if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope); capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const outcome = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(10) }, () => hostRunRunner(throwingRunner() as never, agent as never,
    [{ type: 'message', role: 'user', content: input }] as never, { maxTurns: 8, hostTurnEngine: 'host_v1', context: identity } as never));
  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  for (const record of records) assert.equal(readFileSync(record.id, 'utf8'), record.content);
  const settlements = eventlog.openEventLog().prepare('SELECT outcome_kind,mutating FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?').all(session.id, source.seq) as any[];
  assert.equal(settlements.filter(x => x.mutating && x.outcome_kind === 'succeeded').length, 3, JSON.stringify(settlements));
  assert.equal(settlements.filter(x => x.outcome_kind === 'policy_denial').length, 1, 'completed member replay stays refused');
  eventlog.closeEventLog();
  assert.equal((results.resolveReviewedPlanStepResult(identity, 'save') as any).items.length, 3);
  const terminal = terminalPreparation.prepareAcceptedTaskTerminal({ ...identity, proposedReply: 'All three current records saved.' });
  assert.equal(terminal.status, 'ready', JSON.stringify(terminal));
  const { commitTurnOutcome } = await import('./delivery-committer.js');
  const { turnOutcomeId } = await import('./turn-outcome.js');
  const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: 'All three current records saved.' } });
  assert.equal(committed.presentation.status, 'done', JSON.stringify(committed.presentation));
});
