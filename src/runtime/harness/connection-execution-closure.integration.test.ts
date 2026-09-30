/** Real reviewed plan_task → local space_get → connection pause/control →
 * terminal closure. Only the model wire and missing connection are fixtures;
 * graph, plan activation, selected read, manifest and settlement use production. */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Model } from '@openai/agents';
import type { TurnOutcome } from './turn-outcome.js';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-connection-closure-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: fixtureHome,
  CLEMMY_TEST_ISOLATED_HOME: '1',
  OPENAI_AGENTS_DISABLE_TRACING: '1',
  HARNESS_TOOL_BRACKETS: 'on',
  CLEMMY_TURN_ENGINE: 'host_v1',
  MCP_AUTO_IMPORT_ENABLED: 'false',
  EMBEDDINGS_DISABLED: 'true',
  CLEMMY_UNIFIED_RECALL: 'off',
  CLEMMY_UNIFIED_TURN_PRIMER: 'off',
  CLEMMY_DEBATE_MODE: 'off',
  CLEMMY_WATCHER_JUDGE: 'off',
  COMPOSIO_BACKEND: 'sdk',
});
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'machine-id'), 'connection-closure-fixture\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Connection closure fixtures must never access the network.'); };

const log = await import('./eventlog.js');
const { applyHarnessMigrations } = await import('./eventlog-schema.js');
const plans = await import('./plan-artifacts.js');
const publisher = await import('../../tools/publish-plan.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const reviewed = await import('./reviewed-plan-runtime.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifestStores = await import('./capability-manifest-store.js');
const { RouterModelProvider } = await import('./router-model.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const brackets = await import('./brackets.js');
const host = await import('./host-turn-runner.js');
const hostAuthority = await import('./accepted-turn-call-authority.js');
const hostProgress = await import('./host-connection-progress.js');
const batchCheckpoints = await import('./accepted-model-batch-checkpoint.js');
const sourceContext = await import('./source-session-context.js');
const { withSourceSessionContext } = await import('./source-session-context-scope.js');
const preparation = await import('./accepted-task-terminal-preparation.js');
const { loadManifestState } = await import('./obligation-store.js');
const { verifyAcceptedTaskTerminalProofInTransaction } = await import('./terminal-publication-proof.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const connectionCheckpoints = await import('./source-connection-checkpoints.js');
const connectionPause = await import('./connection-execution-pause.js');
const connectionSetup = await import('./connection-setup.js');
const activation = await import('./connection-execution-activation.js');
const { readConnectionPreparationHold } = await import('./connection-preparation-hold.js');
const { runConversation } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
const { respondViaHarness, respondPreferHarness, _setBridgeImplsForTests } = await import('./respond-bridge.js');
const { ClementineGateway } = await import('../../gateway/router.js');
const { readConnectionExecutionActivation } = await import('./connection-execution-activation-proof.js');
const { recoverInterruptedChatRuns } = await import('./restart-recovery.js');
const closure = await import('./connection-execution-closure-proof.js');
const { completionDataForTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { spaceStore } = await import('../../spaces/store.js');
const { closeWorkspaceDb } = await import('../../spaces/workspace-db.js');
const { closeMemoryDb } = await import('../../memory/db.js');
const writeCapabilities = await import('../../memory/verified-write-capability-store.js');
const { installConnectionProviderFixture } = await import('./connection-provider.fixture.js');

after(() => {
  globalThis.fetch = originalFetch;
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  writeCapabilities.closeVerifiedWriteCapabilityStoreForTests();
  closeWorkspaceDb();
  closeMemoryDb();
  log.closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});

const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call', callId, name, arguments: JSON.stringify(args),
});
const message = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text }] });

/** Controlled discovery evidence only; it grants no graph or tool authority. */
function recordMissingConnection(identity: { sessionId: string; sourceUserSeq: number; turn: number }): void {
  const callId = 'fixture-missing-connection';
  const output = JSON.stringify({ query: 'controlled CRM read', role_key: 'source', results: [],
    brokerCoverage: 'authorized_external_v1', unavailable: [{ source: 'authorized_composio', code: 'no_connections',
      reason: 'The controlled fixture account is disconnected.', dependencySubject: {
        version: 1, kind: 'exact_capability_connection', source: 'authorized_composio',
        query: 'controlled CRM read', roleKey: 'source', toolkit: 'fixturecrm',
        capability: 'FIXTURECRM_READ', capabilityRef: 'cap:resolved:fixturecrm_read',
      } }] });
  log.writeToolOutput({ sessionId: identity.sessionId, callId, tool: 'tool_search', output });
  log.appendEvent({ sessionId: identity.sessionId, turn: identity.turn, role: 'Clem', type: 'tool_returned',
    data: { sourceUserSeq: identity.sourceUserSeq, tool: 'tool_search', callId,
      accounting: 'top_level', topologyRole: 'control', result: output } });
}

for (const scenario of ['publication', 'executor', 'bridge-home', 'bridge-mobile', 'prefer-home', 'prefer-mobile',
  'gateway-mobile', 'account-changed-before-model', 'stopped-before-model', 'account-inactive', 'schema-changed',
  'account-changed-during-check', 'stopped-during-check', 'callable-revoked-during-check', 'unreviewed-capability',
  'different-reviewed-account', 'definition-relabeled', 'retry-home', 'retry-mobile', 'retry-stopped'] as const) test(`connection execution: ${scenario}`, async t => {
  const useExecutor = scenario !== 'publication';
  let configured = 0;
  _setBridgeImplsForTests({ configure: async () => { configured += 1; return { ok: true }; } });
  t.after(() => _setBridgeImplsForTests({}));
  log.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const provider = useExecutor && scenario !== 'unreviewed-capability' ? await installConnectionProviderFixture() : null;
  if (provider) t.after(() => provider.dispose());
  const slug = `connection-board-${scenario}`;
  spaceStore.save({ id: slug, title: 'Controlled closure board',
    initialData: { rows: [{ account: 'Southgate', status: 'Ready', note: 'Parts arrived' }] },
    viewContent: '<!doctype html><html><body>Southgate: Ready — Parts arrived</body></html>' });
  const beforeSpace = spaceStore.snapshot(slug);
  const session = log.createSession({ id: `connection-closure-${scenario}`, kind: 'chat', userId: 'fixture-owner' });
  const objective = 'Track one read-only verification of the saved controlled board and report its current status without changing it.';
  const planSource = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `Plan this task: ${objective}`, taskMode: { version: 1, kind: 'plan' } } });
  const planIdentity = { sessionId: session.id, sourceUserSeq: planSource.seq };
  const planning = await semantic.primePrimaryModelPlanningCatalog(planIdentity);
  assert.ok(planning.ok, JSON.stringify(planning));
  if (!planning.ok) throw new Error(planning.reason);
  if (provider) await semantic.disclosePrimaryModelPlanningCapabilities({ authority: planning.planning.authority,
    candidates: [{ name: provider.operation, carrier: 'work_call', sourceKind: 'authorized_composio', schema: provider.schema }] });
  const capabilityRef = 'cap:local:space_get:read';
  const preparedOutline = await publisher.preparePlanOutline({ ...planIdentity, planning: planning.planning, ready: true,
    raw: { steps: [{ id: 'verify_board', action: 'Read the saved controlled board.', effect: 'read', capabilityRef,
      staticArguments: { slug }, dynamicBindings: [], dependsOn: [], subagentRole: null,
      verification: 'Report the returned board status without changing its content.' },
      ...(provider ? [{ id: 'verify_crm', action: 'Read the connected CRM board status.', effect: 'read',
        capabilityRef: provider.capability, staticArguments: { recordId: 'fixture-board' }, dynamicBindings: [],
        dependsOn: ['verify_board'], subagentRole: null, verification: 'Confirm the returned CRM board status.' }] : [])],
    successCriteria: ['Report Southgate’s current status from the saved board.'], subagents: [] } });
  assert.deepEqual(preparedOutline.preparationIssues, []);
  // A reviewed tracked point read is supported by plan_task. The ordinary
  // publisher omits tracking for simple reads, so this fixture explicitly
  // reviews that same one-operation draft before the immutable Execute claim.
  const executionDraft = {
    criteria: ['Read and report the saved board without changing any content.'], cardinality: null, destination: null,
    topology: { version: 1, operations: [{ id: 'verify_board', effect: 'read', coverage: 'single',
      dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
      ...(provider ? [{ id: 'verify_crm', effect: 'read', coverage: 'single', dependsOn: ['verify_board'],
        dataFrom: [], cardinality: { kind: 'once' } }] : [])], universes: [] },
    bindings: [{ operationId: 'verify_board', role: 'source', capabilityRef, evidence: ['tool_result'] },
      ...(provider ? [{ operationId: 'verify_crm', role: 'source', capabilityRef: provider.capability, evidence: ['tool_result'] }] : [])],
    deliverables: [{ id: 'board_evidence', kind: 'evidence' }], evidenceRequirements: ['tool_result'],
  };
  const artifact = plans.publishPlanRevision({ ...planIdentity, principalId: 'fixture-owner', fullText: objective,
    structuredPlan: { ...preparedOutline, executionDraft }, readiness: 'ready' });
  const executeRef = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const executeInput = 'Execute the reviewed controlled board verification.';
  const originalAttempt = log.beginRunAttempt(session.id, { runId: 'fixture-original-execute' });
  const source = log.recordRunAttemptUserInput(originalAttempt, { turn: 2, role: 'user', data: {
    text: executeInput, taskMode: { version: 1, kind: 'execute', executeRef },
  } }, { armRunInFlight: true });
  plans.claimPlanExecution({ sessionId: session.id, sourceUserSeq: source.seq, principalId: 'fixture-owner', executeRef });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const retainedContext = sourceContext.captureFreshSourceSessionContext(identity);
  assert.ok(retainedContext);
  const modelId = 'fixture-connection-closure-model';
  const readCallId = 'controlled-selected-board-read';
  const frames = [
    [toolCall('controlled-reviewed-plan', 'plan_task', {})],
    [toolCall(readCallId, 'work_call', { requirement_id: 'verify_board', universe_item_id: null,
      universe_selector: null, seal_amendment: null,
      name: 'space_get', args_json: JSON.stringify({ slug }) })],
    [message('ASK: Connect the controlled fixture CRM to continue.')],
    ...(provider ? [[toolCall('controlled-selected-crm-read', 'work_call', { requirement_id: 'verify_crm',
      universe_item_id: null, universe_selector: null, seal_amendment: null,
      name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: provider.operation,
        arguments: { recordId: 'fixture-board' } }) })]] : []),
    [message('Southgate is Ready; its note is Parts arrived. The saved board was not changed.')],
  ];
  let modelCalls = 0;
  let beforeFinalResponse: (() => Promise<void>) | undefined;
  const model: Model = {
    async getResponse() {
      if (modelCalls === 3) await beforeFinalResponse?.();
      const output = frames[modelCalls++];
      assert.ok(output, 'the recording model must not run beyond its scripted frames');
      return { responseId: `controlled-closure-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output } as never;
    },
    async *getStreamedResponse(request) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId,
        usage: response.usage, output: response.output } } as never;
    },
  };
  // A string id remains recoverable. Replace only its provider resolution;
  // never relabel an opaque recording model after the accepted batch ran.
  let beforeResumeModel: (() => void) | undefined;
  t.mock.method(RouterModelProvider.prototype, 'getModel', (requested?: string) => {
    assert.equal(requested, modelId, 'no auxiliary or paid model may run');
    beforeResumeModel?.();
    return model;
  });
  const agent = await withSourceSessionContext(retainedContext, async () => {
    const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
    assert.ok(primed.ok, JSON.stringify(primed));
    if (!primed.ok) throw new Error(primed.reason);
    await reviewed.revalidateReviewedPlanPreparation(primed.planning);
    return buildOrchestratorAgent({ userInput: executeInput, ...identity, hostFreshPlanning: primed.planning,
      allowedToolNames: ['space_get', ...(provider ? ['composio_execute_tool'] : [])], allowToolJit: true, model: modelId,
      mcpToolScope: { authority: 'none', reason: 'Controlled native read has no external tool authority',
        allowedServerSlugs: [], toolPatterns: [], maxTools: 0 } });
  });
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('The legacy runner must not execute this fixture.'); } });
  const outcome = await withSourceSessionContext(retainedContext, () => brackets.withHarnessRunContext({ ...identity,
    counter: new brackets.ToolCallsCounter(8), behaviorScopeId: `${session.id}::source:${source.seq}` },
  () => host.hostRunRunner(runner as never, agent as never,
    [{ type: 'message', role: 'user', content: executeInput }] as never,
    { maxTurns: 6, hostTurnEngine: 'host_v1', hostJudgeCompletion: false, context: identity } as never)));
  assert.equal(modelCalls, 3, JSON.stringify({ outcome,
    planResult: log.getToolOutput(session.id, 'controlled-reviewed-plan') }));
  assert.match(String(outcome.finalOutput), /Connect the controlled fixture CRM/);
  const planned = JSON.parse(log.getToolOutput(session.id, 'controlled-reviewed-plan')!.output);
  assert.equal(planned.ok, true);
  assert.equal(planned.writeDeferred, undefined, 'host policy text must not turn the reviewed read into deferred write work');
  const rootBefore = hostAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.ok(rootBefore.status === 'ok' && rootBefore.authority.authorityKind === 'host_v1'
    && rootBefore.authority.state === 'open', 'the real host must retain its original open root');
  const readRows = () => log.openEventLog().prepare(`SELECT s.logical_tool_call_id, l.tool_name,
    s.outcome_kind, s.mutating, s.physical_crossing_count, s.host_crossing_count, s.result_handle_id
    FROM logical_call_settlements s JOIN logical_tool_calls l USING(session_id, source_user_seq, logical_tool_call_id)
    WHERE s.session_id = ? AND s.source_user_seq = ? AND s.logical_tool_call_id = ?`)
    .all(session.id, source.seq, readCallId) as Array<Record<string, unknown>>;
  const readBefore = readRows();
  assert.equal(readBefore.length, 1);
  assert.equal(readBefore[0]!.outcome_kind, 'succeeded');
  assert.equal(readBefore[0]!.mutating, 0);
  assert.equal(readBefore[0]!.host_crossing_count, 1, 'the actual local reader crossed the host exactly once');
  const operation = log.openEventLog().prepare(`SELECT operation_id, resolved_tool, logical_tool_call_id FROM accepted_task_operations
    WHERE session_id = ? AND source_user_seq = ?`).all(session.id, source.seq);
  assert.deepEqual(operation, [{ operation_id: 'verify_board', resolved_tool: 'space_get', logical_tool_call_id: readCallId }]);
  const reply = 'Southgate is Ready; its note is Parts arrived. The saved board was not changed.';
  const prepared = preparation.prepareAcceptedTaskTerminal({ ...identity, proposedReply: reply });
  assert.equal(prepared.status === 'ready', !provider, JSON.stringify(prepared));
  const taskBefore = log.openEventLog().prepare(`SELECT state, manifest_id, work_contract_id, terminal_event_id
    FROM accepted_task_authority WHERE session_id = ? AND source_user_seq = ?`).get(session.id, source.seq) as Record<string, unknown>;
  assert.equal(taskBefore.state, provider ? 'armed' : 'manifested_verifying', JSON.stringify(taskBefore));
  assert.ok(taskBefore.work_contract_id);
  assert.equal(Boolean(taskBefore.manifest_id), !provider);
  assert.equal(taskBefore.terminal_event_id, null);
  const proveOriginal = () => {
    const manifestState = loadManifestState(session.id, source.seq);
    if (manifestState.status !== 'ok') return { ok: false, reason: manifestState.status };
    return log.openEventLog().transaction(() => verifyAcceptedTaskTerminalProofInTransaction({
      db: log.openEventLog(), ...identity, acceptedTaskId: acceptedTaskIdFor(session.id, source.seq),
      manifest: manifestState.manifest,
    }))();
  };
  assert.equal(proveOriginal().ok, !provider, 'the pending provider read cannot count as complete');
  const canonical = batchCheckpoints.prepareAcceptedModelBatchRestart(identity);
  assert.equal(canonical.status, 'ready');
  const progress = hostProgress.boundHostConnectionProgress(agent, identity);
  assert.ok(progress, 'the real host must retain consumed progress at its input pause');
  recordMissingConnection(identity);
  const dependency = connectionCheckpoints.parkObservedConnectionWithCheckpoint({ ...identity, agent });
  assert.ok(dependency);
  // Rehearse the actual old checkpoint table with a host-produced payload.
  // The migration must retain the exact checkpoint, not reconstruct authority.
  const db = log.openEventLog();
  const checkpointRows = () => db.prepare('SELECT * FROM source_connection_checkpoints_v1 ORDER BY request_id').all();
  const checkpointBefore = checkpointRows();
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE fixture_legacy_checkpoints (
        request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL,
        checkpoint_json TEXT NOT NULL, checkpoint_digest TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES dependency_requests(request_id)
      );
      INSERT INTO fixture_legacy_checkpoints SELECT * FROM source_connection_checkpoints_v1;
      DROP TABLE source_connection_checkpoints_v1;
      ALTER TABLE fixture_legacy_checkpoints RENAME TO source_connection_checkpoints_v1;
      CREATE TRIGGER source_connection_checkpoints_v1_no_delete BEFORE DELETE ON source_connection_checkpoints_v1
        BEGIN SELECT RAISE(ABORT, 'connection checkpoints are immutable'); END;
      CREATE TRIGGER source_connection_checkpoints_v1_no_update BEFORE UPDATE ON source_connection_checkpoints_v1
        BEGIN SELECT RAISE(ABORT, 'connection checkpoints are immutable'); END;`);
      db.prepare('DELETE FROM schema_version WHERE version = 83').run();
    })();
  } finally { db.pragma('foreign_keys = ON'); }
  applyHarnessMigrations(db);
  assert.deepEqual(checkpointRows(), checkpointBefore);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const pauseBinding = connectionPause.prepareConnectionExecutionPause({ ...identity, requestId: dependency.requestId });
  assert.ok(pauseBinding, 'the real planned root and completed batch must support a proven pause');
  const pauseOutcome: TurnOutcome = { version: 2, id: turnOutcomeId(identity), identity,
    status: 'needs_input', resumable: true, needs: { kind: 'input' },
    presentation: { kind: 'question', text: dependency.text } };
  const pauseData = completionDataForTurnOutcome(pauseOutcome, { metadata: { connectionExecutionPause: pauseBinding } });
  const publishPause = () => log.appendTerminalEventOnce({ sessionId: session.id, turn: source.turn,
    role: 'system', data: pauseData }, pauseOutcome.id);
  const paused = publishPause();
  assert.equal(paused.inserted, true);
  assert.deepEqual(hostAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq), rootBefore);
  const ageSession = () => {
    log.updateSession(session.id, { status: 'completed' });
    log.openEventLog().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', session.id);
  };
  ageSession();
  assert.equal(log.reapStaleSessions(14), 0, 'an open connection execution survives stale physical-session status');
  assert.deepEqual(hostAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq), rootBefore);
  log.updateSession(session.id, { status: 'active' });
  const context = { sessionId: session.id, connectionRequestId: dependency.requestId };
  const connectedAccount = scenario === 'different-reviewed-account' ? 'fixture-another-account' : 'fixture-server-returned-account';
  connectionSetup.recordConnectionSetupResult(context, { connectionId: connectedAccount });
  let checks = 0;
  const verified = await connectionSetup.verifyConnectionSetup(context, async selected => {
    checks += 1;
    assert.deepEqual(selected, [{ identifier: 'FIXTURECRM_READ', connectionId: connectedAccount }]);
    return { ok: true };
  });
  assert.ok(verified.connectionVerified && verified.verificationBinding);
  const setup = connectionSetup.readConnectionSetup(session.id, dependency.requestId);
  assert.ok(setup);
  const sharedReceipt = connectionSetup.connectionContinuationIdentity(context, setup.continueLabel, setup.clientRequestId);
  const runId = 'fixture-connection-control';
  // Create the receipt at a historical clock so the final retention assertion
  // exercises real expiry without mutating an immutable acceptance timestamp.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2020-01-01T00:00:00.000Z') });
  try {
    log.claimHarnessChatRequest({ ...sharedReceipt, sessionId: session.id, runId,
      sinceSeq: log.listEvents(session.id).at(-1)!.seq });
  } finally { t.mock.timers.reset(); }
  const gateway = new ClementineGateway({ respond: async () => { throw new Error('The legacy gateway responder must not run.'); } } as never);
  let gatewayAccepted: import('./eventlog.js').EventRow | undefined;
  const gatewayRequest = { sessionId: session.id, runId, userId: 'fixture-owner', channel: 'mobile', source: 'mobile' as const,
    message: setup.continueLabel, connectionContinuation: context,
    connectionContinuationVerification: { sourceUserSeq: source.seq, binding: verified.verificationBinding },
    failClosedOnUnsettledReplay: true,
    onAcceptedTurn: ({ source: accepted }: { source: import('./eventlog.js').EventRow }) => { gatewayAccepted = accepted; } };
  if (scenario === 'gateway-mobile') {
    beforeFinalResponse = async () => {
      beforeFinalResponse = undefined;
      const originalControl = gatewayAccepted;
      const originalAttemptId = log.getLatestRunAttemptByRunId(session.id, runId)!.attemptId;
      const retry = await gateway.handleMessage(gatewayRequest);
      assert.equal(retry.stoppedReason, 'in-progress', 'a lost-response retry rejoins the current task');
      assert.equal(retry.terminal, undefined, 'a concurrent retry cannot publish a terminal');
      assert.equal(gatewayAccepted?.seq, originalControl?.seq, 'the retry acknowledges the same accepted control');
      assert.equal(log.getLatestRunAttemptByRunId(session.id, runId)!.attemptId, originalAttemptId,
        'a retry cannot replace the executing attempt');
      assert.equal(modelCalls, 3, 'the retry does not dispatch a second model');
    };
    const response = await gateway.handleMessage(gatewayRequest);
    assert.equal(response.text, reply, JSON.stringify(response));
    assert.equal(response.terminal?.status, 'done');
    assert.ok(gatewayAccepted);
    assert.equal(modelCalls, 5);
  }
  const leaseOwner = scenario === 'gateway-mobile' ? `connection-gateway:${process.pid}` : 'fixture-closure-desktop';
  const lease = scenario === 'gateway-mobile'
    ? { claimed: true, attempt: log.getLatestRunAttemptByRunId(session.id, runId)! }
    : log.claimRunAttemptLease({ sessionId: session.id, runId, ownerId: leaseOwner, leaseMs: 90_000 });
  assert.equal(lease.claimed, true);
  const active = scenario === 'gateway-mobile'
    ? { kind: 'activated', source: gatewayAccepted!, activation: readConnectionExecutionActivation(log.openEventLog(),
        { sessionId: session.id, deliverySourceUserSeq: gatewayAccepted!.seq })!.activation }
    : activation.activateConnectionExecution({ context, text: setup.continueLabel,
    clientRequestId: setup.clientRequestId, runId, attemptId: lease.attempt.attemptId, leaseOwner,
    verified: { sourceUserSeq: source.seq, binding: verified.verificationBinding } });
  assert.equal(active.kind, 'activated');
  assert.equal(active.activation.executionSourceUserSeq, source.seq);
  assert.notEqual(active.source.seq, source.seq);
  if (scenario !== 'gateway-mobile') assert.equal(proveOriginal().ok, !provider, 'control acceptance cannot replace the original completion evidence');
  const deliveryIdentity = { sessionId: session.id, sourceUserSeq: active.source.seq, turn: active.source.turn };
  const finalOutcome: TurnOutcome = { version: 2, id: turnOutcomeId(deliveryIdentity), identity: deliveryIdentity,
    status: 'done', resumable: false, presentation: { kind: 'answer', text: reply } };
  const publishFinal = () => log.appendTerminalEventOnce({ sessionId: session.id, turn: active.source.turn,
    role: 'system', data: completionDataForTurnOutcome(finalOutcome) }, finalOutcome.id);
  const resumeOptions = { sessionId: session.id, sourceUserSeq: active.source.seq,
    input: setup.continueLabel, runAttemptId: lease.attempt.attemptId,
    connectionExecutionLeaseOwner: leaseOwner, turnEngine: 'host_v1' as const,
    // Later caller defaults cannot overwrite the reviewed source's budget,
    // model or completion policy. The recording provider rejects auxiliaries.
    maxTurns: 100, toolCallsPerTurn: 100, judgeCompletion: true,
    buildAgent: async () => { throw new Error('A connection control cannot construct a fresh caller-selected agent.'); } };
  const bridgeRequest = {
    sessionId: session.id, sourceUserSeq: active.source.seq, runId,
    message: setup.continueLabel, taskMode: { version: 1 as const, kind: 'execute' as const, executeRef },
    model: 'fixture-wrong-current-selection',
  };
  const runBridge = () => scenario.startsWith('prefer-')
    ? respondPreferHarness(scenario === 'prefer-mobile' ? 'webhook' : 'home', bridgeRequest,
        async () => { throw new Error('The legacy bridge responder must not run.'); }, { connectionExecutionLeaseOwner: leaseOwner })
    : respondViaHarness(scenario.endsWith('mobile') ? 'webhook' : 'home', bridgeRequest,
        { connectionExecutionLeaseOwner: leaseOwner, turnEngine: 'host_v1', modelOverride: 'fixture-wrong-caller-override' });
  if (scenario.startsWith('retry-')) {
    provider!.setSchemaAvailable(false);
    const beforeChecks = { ...provider!.counts };
    const pauseBlob = HarnessSession.load(session.id)!.loadRecoveryState();
    const response = await runBridge();
    assert.equal(response.stoppedReason, 'in-progress', 'temporary metadata failure must not close the reviewed task');
    assert.match(response.text, /paused|saved/i);
    assert.match(response.text, /retry/i);
    assert.doesNotMatch(response.text, /will continue/i, 'a connection wait cannot promise automatic recovery');
    assert.equal((response.raw as any)?.typedExecution?.wake, 'connection');
    assert.equal((response.raw as any)?.typedExecution?.nextAction, 'retry');
    assert.equal(modelCalls, 3);
    assert.equal(provider!.counts.businessCalls, 0);
    assert.ok(provider!.counts.schemaChecks > beforeChecks.schemaChecks);
    assert.equal(log.getLatestRunAttemptByRunId(session.id, runId)!.status, 'active');
    const root = hostAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
    assert.ok(root.status === 'ok' && root.authority.state === 'open');
    assert.equal(log.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
    assert.equal(closure.readConnectionExecutionClosure(log.openEventLog(), {
      sessionId: session.id, executionSourceUserSeq: source.seq }), null);
    assert.deepEqual(readRows(), readBefore);
    log.closeEventLog();
    const hold = readConnectionPreparationHold({ sessionId: session.id, deliverySourceUserSeq: active.source.seq });
    assert.equal(hold?.nextAction, 'retry', 'reopening preserves the truthful next action');
    assert.equal(readConnectionPreparationHold({ sessionId: session.id, deliverySourceUserSeq: source.seq }), null);
    const countsBeforeBoot = { ...provider!.counts };
    let bootDispatches = 0;
    const boot = recoverInterruptedChatRuns(Date.now, async () => { bootDispatches += 1; });
    await Promise.resolve();
    assert.equal(boot.records.find(row => row.sessionId === session.id)?.autoResumeSkipped, 'connection_wait');
    assert.equal(bootDispatches, 0, 'recovery must not poll a task explicitly waiting on its connection');
    assert.deepEqual(provider!.counts, countsBeforeBoot);
    assert.equal(log.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
    const repeated = await runBridge();
    assert.equal(repeated.stoppedReason, 'in-progress');
    assert.equal(log.getLatestRunAttemptByRunId(session.id, runId)!.attemptId, lease.attempt.attemptId);
    assert.equal(HarnessSession.load(session.id)!.loadRecoveryState(), pauseBlob,
      'a retry must preserve the actual retained cursor');
    assert.equal(log.listEvents(session.id, { types: ['restart_recovery_decision'] })
      .filter(event => event.data.decision === 'connection_preparation_held').length, 1,
      'the same verification failure must not create repeated pause cards or receipts');
    provider!.setSchemaAvailable(true);
    if (scenario === 'retry-stopped') {
      log.requestKill(session.id, 'Owner stopped the retained task while connection was unavailable', originalAttempt);
      await assert.rejects(runConversation(resumeOptions), /stopped/);
      const stopped = recoverInterruptedChatRuns(Date.now, async () => { bootDispatches += 1; });
      await Promise.resolve();
      assert.equal(stopped.records.find(row => row.sessionId === session.id)?.autoResumeSkipped, 'user_stopped',
        'Stop on the original task takes priority over its connection wait during recovery');
      assert.equal(bootDispatches, 0);
      assert.equal(modelCalls, 3);
      assert.equal(provider!.counts.businessCalls, 0);
      assert.deepEqual(readRows(), readBefore);
      return;
    }
  }
  if (['account-inactive', 'schema-changed', 'account-changed-during-check', 'stopped-during-check',
    'callable-revoked-during-check', 'unreviewed-capability', 'different-reviewed-account', 'definition-relabeled'].includes(scenario)) {
    const beforeChecks = provider ? { ...provider.counts } : null;
    if (scenario === 'account-inactive') provider!.setActive(false);
    if (scenario === 'schema-changed') provider!.setSchema({ ...provider!.schema,
      properties: { ...provider!.schema.properties, extra: { type: 'string' } } });
    if (scenario === 'definition-relabeled') provider!.setVersion('2');
    if (scenario === 'account-changed-during-check') provider!.beforeSchema(() => {
      connectionSetup.recordConnectionSetupResult(context, { connectionId: 'fixture-different-account' });
    });
    if (scenario === 'stopped-during-check') provider!.beforeSchema(() => {
      log.requestKill(session.id, 'Owner stopped the task during verification', originalAttempt);
    });
    if (scenario === 'callable-revoked-during-check') provider!.beforeSchema(() => {
      catalogs.peekHostCapabilityCatalogFactory()!.forget(provider!.capability);
    });
    if (scenario === 'account-changed-during-check' || scenario === 'stopped-during-check') {
      await assert.rejects(runConversation(resumeOptions), /account changed|was stopped/);
    } else {
      const held = await runConversation(resumeOptions);
      assert.equal(held.status, 'held');
      assert.equal(held.hold?.wake, 'connection');
      assert.equal(held.hold?.wake === 'connection' && held.hold.nextAction,
        scenario === 'account-inactive' ? 'reconnect' : 'review_plan');
      assert.equal(log.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
      const root = hostAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
      assert.ok(root.status === 'ok' && root.authority.state === 'open');
    }
    assert.equal(modelCalls, 3, 'a metadata refusal cannot spend another model frame');
    assert.equal(provider?.counts.businessCalls ?? 0, 0, 'verification cannot execute a business operation');
    assert.deepEqual(readRows(), readBefore);
    assert.equal(log.openEventLog().prepare('SELECT status FROM dependency_requests WHERE request_id = ?')
      .get(dependency.requestId)?.status, 'open');
    assert.equal(log.listEvents(session.id, { types: ['connection_request_satisfied'] }).length, 0);
    if (provider && beforeChecks && scenario !== 'different-reviewed-account') {
      assert.ok(provider.counts.accountChecks > beforeChecks.accountChecks, 'a cached account must not satisfy the check');
      if (scenario !== 'account-inactive') assert.ok(provider.counts.schemaChecks > beforeChecks.schemaChecks,
        'the exact definition must be refreshed without model discovery');
    }
    if (scenario === 'different-reviewed-account') assert.deepEqual(provider!.counts, beforeChecks,
      'a different account must be refused before provider metadata or business work');
    return;
  }
  if (scenario === 'account-changed-before-model' || scenario === 'stopped-before-model') {
    let invalidated = false;
    beforeResumeModel = () => {
      beforeResumeModel = undefined;
      invalidated = true;
      if (scenario === 'account-changed-before-model') {
        // The request is now satisfied, so a late provider setup callback is
        // correctly ignored. Inject persistent account drift directly to
        // exercise the final ownership guard independently of that filter.
        log.openEventLog().prepare('UPDATE connection_setup_attempts SET connection_id = ? WHERE request_id = ?')
          .run('fixture-different-account', dependency.requestId);
      } else {
        log.requestKill(session.id, 'Owner stopped the original task before dispatch', originalAttempt);
      }
    };
    await assert.rejects(runConversation(resumeOptions));
    assert.equal(invalidated, true, 'the ownership change must happen after rebuild at model resolution');
    assert.equal(modelCalls, 3, 'losing account or Stop authority must prevent the next model frame');
    assert.deepEqual(readRows(), readBefore, 'an invalid continuation cannot repeat the completed read');
    assert.equal(log.listEvents(session.id, { types: ['plan_execution_claimed'] }).length, 1);
    return;
  }
  if (useExecutor && scenario !== 'gateway-mobile') {
    log.closeEventLog();
    if (!scenario.startsWith('retry-')) {
      // Boot must recognize the retained execution under its new delivery
      // control, even when generic chat auto-resume is disabled. This dispatcher
      // records selection only; acquiring a fresh boot lease is a separate gate.
      const dispatched: Array<{ sessionId: string; sourceUserSeq: number }> = [];
      const previousAutoResume = process.env.CLEMMY_CHAT_AUTO_RESUME;
      process.env.CLEMMY_CHAT_AUTO_RESUME = 'off';
      try {
        const scan = recoverInterruptedChatRuns(Date.now, async control => { dispatched.push(control); });
        await Promise.resolve();
        assert.equal(scan.records.find(row => row.sessionId === session.id)?.autoResumed, true, JSON.stringify(scan));
        assert.deepEqual(dispatched.map(({ sessionId, sourceUserSeq }) => ({ sessionId, sourceUserSeq })),
          [{ sessionId: session.id, sourceUserSeq: active.source.seq }]);
        assert.equal(log.listEvents(session.id, { types: ['conversation_completed'] }).length, 1,
          'the original setup pause cannot be treated as completion of the resumed task');
      } finally {
        if (previousAutoResume === undefined) delete process.env.CLEMMY_CHAT_AUTO_RESUME;
        else process.env.CLEMMY_CHAT_AUTO_RESUME = previousAutoResume;
      }
    }
    await assert.rejects(runConversation({ ...resumeOptions, connectionExecutionLeaseOwner: 'wrong-owner' }), /live execution lease/);
    assert.equal(modelCalls, 3, 'a wrong executor cannot spend a model frame');
    if (scenario.startsWith('bridge-') || scenario.startsWith('prefer-') || scenario.startsWith('retry-')) {
      const response = await runBridge();
      assert.equal(response.stoppedReason, 'success', JSON.stringify(response));
      assert.equal(response.text, reply);
      const routed = log.listEvents(session.id, { types: ['turn_model_routed'] }).at(-1);
      assert.equal(routed?.data.model, modelId, 'the bridge reports the retained brain, not current settings');
      assert.equal(routed?.data.sourceUserSeq, active.source.seq);
    } else {
      const [resumed, concurrent] = await Promise.all([runConversation(resumeOptions), runConversation(resumeOptions)]);
      assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
      assert.deepEqual(concurrent, resumed, 'concurrent controls share one executor and terminal');
    }
  }
  const completed = useExecutor ? { inserted: true, event: log.listEvents(session.id, { types: ['conversation_completed'] })
    .find(event => event.data.sourceUserSeq === active.source.seq)! } : publishFinal();
  assert.equal(completed.inserted, true);
  assert.ok(completed.event);
  assert.equal(completed.event.data.sourceUserSeq, active.source.seq);
  const closedRoot = hostAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.ok(closedRoot.status === 'ok' && closedRoot.authority.state === 'closed');
  const readPublication = () => log.readAcceptedTaskTerminalPublication(session.id, source.seq);
  const publication = readPublication();
  assert.equal(publication.status, 'published', JSON.stringify(publication));
  if (publication.status !== 'published') throw new Error('The original manifested task did not close.');
  assert.equal(publication.terminalEventId, completed.event.id);
  assert.equal(publication.event.data.sourceUserSeq, active.source.seq);
  assert.equal(closure.readConnectionExecutionClosure(log.openEventLog(), {
    sessionId: session.id, executionSourceUserSeq: source.seq })?.terminalEventId, completed.event.id);
  log.closeEventLog();
  assert.deepEqual(readPublication(), publication, 'the original task must reopen with the final control event as its winner');
  assert.equal(log.readValidatedTerminalEvent(paused.event.id, session.id, source.seq).id, paused.event.id);
  assert.equal(log.readValidatedTerminalEvent(completed.event.id, session.id, active.source.seq).id, completed.event.id);
  assert.equal(connectionPause.readConnectionExecutionPause(session.id, dependency.requestId)?.eventId, paused.event.id);
  assert.equal(publishPause().inserted, false);
  if (scenario === 'gateway-mobile') assert.equal((await gateway.handleMessage(gatewayRequest)).text, reply);
  else if (scenario.startsWith('bridge-') || scenario.startsWith('prefer-')) assert.equal((await runBridge()).stoppedReason, 'success');
  else if (useExecutor) assert.equal((await runConversation(resumeOptions)).status, 'completed');
  else assert.equal(publishFinal().inserted, false);
  assert.deepEqual(readRows(), readBefore, 'closure and both exact replays must never repeat the completed local read');
  assert.deepEqual(spaceStore.snapshot(slug), beforeSpace);
  assert.equal(modelCalls, useExecutor ? 5 : 3);
  if (provider) {
    assert.equal(provider.counts.businessCalls, 1, 'only the pending provider read executes after connection');
    assert.equal(log.listEvents(session.id, { types: ['connection_request_satisfied'] })
      .filter(event => event.data.kind === 'reviewed_execution_callable').length, 1);
  }
  if (scenario.startsWith('retry-')) {
    assert.equal(readConnectionPreparationHold({ sessionId: session.id, deliverySourceUserSeq: active.source.seq }), null,
      'successful explicit retry clears the diagnostic pause');
    assert.equal(log.listEvents(session.id, { types: ['restart_recovery_decision'] })
      .filter(event => event.data.decision === 'connection_preparation_ready').length, 1);
  }
  assert.equal(configured, scenario.startsWith('prefer-') || scenario === 'gateway-mobile' ? 1 : 0,
    'a completed replay must not configure or re-enter the runtime');
  assert.equal(checks, 1);
  assert.equal(log.listEvents(session.id, { types: ['conversation_completed'] }).length, 2);
  assert.equal(log.listEvents(session.id, { types: ['plan_execution_claimed'] }).length, 1);
  ageSession();
  assert.equal(log.reapStaleSessions(14), 1, 'closed execution proof expires atomically with its eligible session');
  assert.equal(log.getSession(session.id), null);
  for (const table of ['reviewed_plan_revisions_v1', 'reviewed_plan_execution_claims_v1',
    'reviewed_plan_execution_observers_v1', 'source_session_contexts_v1', 'source_connection_checkpoints_v1']) {
    assert.equal((log.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
      .get(session.id) as { n: number }).n, 0, table);
  }
  assert.equal(closure.readConnectionExecutionClosure(log.openEventLog(), {
    sessionId: session.id, executionSourceUserSeq: source.seq }), null);
  assert.equal(modelCalls, useExecutor ? 5 : 3);
});
