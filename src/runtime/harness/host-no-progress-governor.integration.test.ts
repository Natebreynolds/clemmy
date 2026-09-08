/**
 * Causal production-host pin for the live discovery loop:
 *
 *   citable discovery -> repeated discovery with no new authority -> one
 *   control-only recovery request -> hallucinated third discovery is paired
 *   locally and terminalized without entering its body.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-no-progress-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-host-no-progress\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const localPlanning = await import('./local-planning-capability.js');
const semanticPlanning = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const attemptSettlement = await import('./attempt-settlement.js');
const dispatchLedger = await import('./dispatch-ledger.js');
const attemptIdentity = await import('./attempt-identity.js');
const turnGraphShadow = await import('../graph/turn-graph-shadow.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const {
  HOST_NO_PROGRESS_BLOCKED_TEXT,
  HOST_NO_PROGRESS_KNOWN_RESULT_BLOCKED_TEXT,
  HostInterruptState,
  HostRecoveryState,
  hostNoProgressRecoveryDirective,
  hostNoProgressRecoveryToolNames,
  hostNoProgressBlockedText,
  hostRunRunner,
} = await import('./host-turn-runner.js');
const {
  createNoProgressConsequence,
  initializeNoProgressGovernor,
  observeNoProgress,
  NO_PROGRESS_RETRY_BUDGET,
} = await import('./no-progress-governor.js');
const { projectHostNoProgressAuthority } = await import('./host-no-progress-projection.js');
const { ModelStreamStalledError } = await import('./model-stall-policy.js');

const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();

after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return {
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify(args),
  };
}

async function* modelStream(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (
        (item as { type?: unknown }).type === 'function_call'
      )) ? 'tool_calls' : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must remain unreachable');
  };
  return runner;
}

// A read op plus a write op bound to a capability the host has NOT attested.
// A wholly-read plan is now admitted as a gather stage (plan-tools change
// 2026-09-02); the missing-write refusal fires only on a broken write binding,
// which is what these governor-recovery regressions exercise.
function readThenUnattestedWriteDraft(readRef: string) {
  return {
    criteria: ['Read the source before creating the requested output file.'],
    cardinality: null,
    destination: null,
    topology: {
      version: 1,
      operations: [
        {
          id: 'read_source',
          effect: 'read',
          coverage: 'single',
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        },
        {
          id: 'create_output',
          effect: 'local_write',
          dependsOn: ['read_source'],
          dataFrom: ['read_source'],
          cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    },
    bindings: [
      { operationId: 'read_source', role: 'source', capabilityRef: readRef, evidence: ['tool_result'] },
      { operationId: 'create_output', role: 'sink', capabilityRef: 'cap:local:deferred_write:create', evidence: ['tool_result'] },
    ],
    deliverables: [{ id: 'source_evidence', kind: 'evidence' }],
    evidenceRequirements: ['tool_result'],
  };
}

test('approval-resume state preserves a spent no-progress retry and exact history cursor', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted-task:resume-pin',
    authority: { operation: [], account: [], target: [], evidence: [], effect: [] },
  });
  const spent = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'dependency_lookup',
    authority: initial.authority,
  }).state;
  const paused = new HostInterruptState(
    [{ role: 'user', content: 'accepted source' }] as never,
    [],
    'accepted-response',
    'host_v1',
    {
      state: spent,
      historyCursor: 1,
      recoveryOnly: true,
      recoveryDirectiveWritten: true,
    },
  );
  const resumed = HostInterruptState.fromString(paused.toString());
  assert.equal(resumed.noProgressCheckpoint?.state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET - 1);
  assert.equal(resumed.noProgressCheckpoint?.state.noProgressAttempts, 1);
  assert.equal(resumed.noProgressCheckpoint?.historyCursor, 1);
  assert.equal(resumed.noProgressCheckpoint?.recoveryOnly, true);

  const forged = JSON.parse(paused.toString()) as Record<string, unknown>;
  const checkpoint = forged.noProgressCheckpoint as {
    state: { retriesRemaining: number };
  };
  checkpoint.state.retriesRemaining = NO_PROGRESS_RETRY_BUDGET;
  assert.throws(
    () => HostInterruptState.fromString(JSON.stringify(forged)),
    /invalid no-progress checkpoint/i,
  );
});

test('structural repair directives retain their next call without forbidding the proven read surface', () => {
  const authority = { operation: [], account: [], target: [], evidence: [], effect: [] } as const;
  const directive = (stage: string, tool: string) => {
    const initial = initializeNoProgressGovernor({ taskKey: `directive:${stage}`, authority });
    const decision = observeNoProgress(initial, {
      taskKey: initial.taskKey,
      attemptClass: 'plan_admission',
      authority,
      consequence: createNoProgressConsequence({
        stage,
        recovery: 'repair_model',
        effectState: 'not_started',
        recoveryToolNames: [tool],
      }),
    });
    return hostNoProgressRecoveryDirective(decision.state);
  };
  const graphNeutral = directive('plan_not_required:graph_neutral', 'call_tool');
  assert.match(graphNeutral, /Call call_tool exactly once/);
  assert.match(graphNeutral, /Available discovery and read controls/);
  const workflow = directive('plan_not_required:unique_workflow', 'workflow_run');
  assert.match(workflow, /Call workflow_run exactly once/);
  assert.match(workflow, /Available discovery and read controls/);
  const search = directive('semantic_admission:capability_not_disclosed', 'tool_search');
  assert.match(search, /Call tool_search exactly once/);
  assert.match(search, /Available discovery and read controls/);
  const plan = directive('semantic_admission:write_not_aligned', 'plan_task');
  assert.match(plan, /Call plan_task exactly once/);
  assert.match(plan, /Available discovery and read controls/);
});

test('provider-crossed invalid arguments expose one honest repair-or-alternative choice and remain bounded', () => {
  const authority = { operation: [], account: [], target: [], evidence: [], effect: [] } as const;
  const consequence = createNoProgressConsequence({
    stage: 'execution:invalid_arguments',
    recovery: 'repair_model',
    effectState: 'known_terminal',
    recoveryToolNames: ['work_call', 'tool_search'],
  });
  const initial = initializeNoProgressGovernor({
    taskKey: 'provider-repair:directive-surface',
    authority,
  });
  const first = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'provider_repair',
    authority,
    consequence,
  });
  assert.equal(first.action, 'continue');
  assert.deepEqual(
    [...hostNoProgressRecoveryToolNames(consequence, ['plan_task', 'tool_search', 'work_call', 'ask_user_question'])],
    ['tool_search', 'work_call'],
    'the advertised recovery schemas are exactly the failed carrier plus one alternative search',
  );
  const directive = hostNoProgressRecoveryDirective(first.state);
  assert.match(directive, /Choose exactly one next call/);
  assert.match(directive, /call work_call once with corrected arguments/);
  assert.match(directive, /OR call tool_search once for an alternative capability/);
  assert.doesNotMatch(directive, /Do not repeat discovery/);

  const repeated = observeNoProgress(first.state, {
    taskKey: initial.taskKey,
    attemptClass: 'provider_repair',
    authority,
    consequence,
  });
  assert.equal(repeated.action, 'terminalize', 'an unchanged provider rejection still cannot loop');
});

for (const stalled of [false, true]) test(`discovery recovery keeps the proven surface and stops resumably without a last-word call (stall=${stalled})`, async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());

  const prompt = 'Create one new local fixture file with the supplied content.';
  const session = eventlog.createSession({ id: 'host-no-progress-discovery', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  const observed = await localPlanning.observeCurrentLocalPlanningDefinition({
    name: 'write_file',
    carrier: 'work_call',
  });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  if (!observed.ok) return;
  const primed = await semanticPlanning.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  assert.deepEqual(primed.planning.capabilities, []);

  let modelCalls = 0;
  let providerAttempts = 0;
  let stallInjected = false;
  let budgetAtStall: unknown;
  const surfaces: string[][] = [];
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }> }) {
      providerAttempts += 1;
      const lastBudget = () => eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
        .filter((event) => event.data.kind === 'no_progress_decision').at(-1)?.data.retriesRemaining;
      if (stalled && modelCalls === 2 && !stallInjected) {
        stallInjected = true;
        budgetAtStall = lastBudget();
        throw new ModelStreamStalledError(600, true, false);
      }
      if (stallInjected && modelCalls === 2) assert.equal(lastBudget(), budgetAtStall,
        'a stalled provider attempt has no tool result and consumes no governor retry');
      modelCalls += 1;
      const surface = (request.tools ?? [])
        .map((entry) => entry.name ?? '')
        .filter(Boolean);
      surfaces.push(surface);
      if (modelCalls === 1) {
        assert.ok(surface.includes('tool_search'));
      } else if (modelCalls === 2) {
        assert.ok(surface.includes('tool_search'));
        assert.ok(surface.includes('plan_task'), 'the citable path enables exact plan admission');
      } else {
        assert.ok(surface.includes('tool_search'),
          'a no-gain lookup cannot hide discovery needed to pivot to another requirement');
      }
      return {
        responseId: `host-no-progress-response-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        // Repeated no-gain discovery must stop at the bounded governor; the
        // recovery model must still have executable schemas until that stop.
        output: [functionCall(`discover-${modelCalls}`, 'tool_search', {
          query: modelCalls === 1 ? 'write_file' : `write_file alternate ${modelCalls}`,
          role_key: null,
          limit: 1,
        })],
      };
    },
    getStreamedResponse: modelStream,
  };

  const agent = await buildOrchestratorAgent({
    userInput: prompt,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['write_file', 'tool_search'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none',
      reason: 'local no-progress regression has no external authority',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(20),
    behaviorScopeId: `${session.id}::turn:1`,
  };

  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ role: 'user', content: prompt }] as never,
    {
      maxTurns: 10,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    } as never,
  ));

  assert.ok(modelCalls <= NO_PROGRESS_RETRY_BUDGET + 2, `model calls: ${modelCalls}`);
  assert.equal(providerAttempts, modelCalls + (stalled ? 1 : 0));
  assert.deepEqual(outcome.terminal, {
    status: 'blocked',
    reason: 'control_no_progress_exhausted',
  });
  assert.match(String(outcome.finalOutput), /Next: .*resume/i);
  assert.equal(surfaces[2]?.includes('tool_search'), true);
  assert.equal(eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'last_word_turn').length, 0);
  const called = eventlog.listEvents(session.id, { types: ['discovery_governor_decision'] })
    .map((event) => event.data.callId)
    .filter((callId) => typeof callId === 'string');
  assert.ok(called.includes('discover-3'), 'the recovery lookup reaches its own discovery governor');
  assert.equal(eventlog.listEvents(session.id, { types: ['external_write'] }).length, 0);
});

// A write already on the card is NOT a repair for a draft missing ITS write:
// nothing can tell the matching write from an unrelated one, and offering the
// card's writes as candidates is the "offered greenhouse/airtable" incident
// (plan-task-account-selection pin ii). The recovery is the same ask-only
// shape as the empty card: one tool_search for the exact missing write.
test('a current-card write still gets the ask-only missing-write recovery (one tool_search, no substitutes)', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());

  const prompt = 'Read a source file, then create one new output file from it.';
  const session = eventlog.createSession({ id: 'host-missing-write-card-repair', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  const primed = await semanticPlanning.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const surfaces: string[][] = [];
  let modelCalls = 0;
  const expectedStop = new Error('expected stop after observing plan-only recovery surface');
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }> }) {
      modelCalls += 1;
      const surface = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      surfaces.push(surface);
      if (modelCalls === 1) {
        return {
          responseId: 'card-repair-search',
          output: [
            functionCall('card-repair-search', 'tool_search', {
              query: 'write_file', role_key: null, limit: 1,
            }),
            functionCall('card-repair-read-search', 'tool_search', {
              query: 'read_file', role_key: null, limit: 1,
            }),
          ],
        };
      }
      if (modelCalls === 2) {
        assert.ok(surface.includes('plan_task'));
        return {
          responseId: 'card-repair-incomplete-plan',
          output: [functionCall('card-repair-incomplete-plan', 'plan_task', {
            preamble: 'I’ll read the source and create the output now.',
            draft: readThenUnattestedWriteDraft('cap:local:read_file'),
          })],
        };
      }
      const requestText = JSON.stringify(request);
      assert.ok(requestText.includes('plan_incomplete_missing_write'));
      assert.ok(!requestText.includes('admissibleCapabilities'),
        'the refusal must not advertise card writes as substitutes');
      assert.ok(requestText.includes('Use tool_search for the exact missing write capability'));
      assert.ok(surface.includes('tool_search'), 'the repair keeps its discovery control');
      throw expectedStop;
    },
    getStreamedResponse: modelStream,
  };
  const agent = await buildOrchestratorAgent({
    userInput: prompt,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['read_file', 'write_file', 'tool_search'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none', reason: 'isolated local recovery regression',
      allowedServerSlugs: [], toolPatterns: [], maxTools: 0,
    },
    model: model as never,
  });
  let thrown: unknown;
  try {
    await brackets.withHarnessRunContext({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      counter: new brackets.ToolCallsCounter(6),
      behaviorScopeId: `${session.id}::turn:1`,
    }, () => hostRunRunner(
      throwingRunner() as never,
      agent as never,
      [{ role: 'user', content: prompt }] as never,
      {
        maxTurns: 5,
        hostTurnEngine: 'host_v1',
        context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
      } as never,
    ));
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, expectedStop);
  assert.equal(modelCalls, 3);
  assert.ok(surfaces[2]?.includes('tool_search'));
  assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
});

test('an empty-card missing-write recovery exposes one search, then newly disclosed write reaches plan_task', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());

  const prompt = 'Read a source file, then create one new output file from it.';
  const session = eventlog.createSession({ id: 'host-missing-write-search-repair', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  const primed = await semanticPlanning.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const surfaces: string[][] = [];
  let modelCalls = 0;
  const expectedStop = new Error('expected stop after newly disclosed write reached plan_task');
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }> }) {
      modelCalls += 1;
      const surface = (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean);
      surfaces.push(surface);
      if (modelCalls === 1) {
        return {
          responseId: 'search-repair-read-search',
          output: [functionCall('search-repair-read-search', 'tool_search', {
            query: 'user_profile_read', role_key: null, limit: 1,
          })],
        };
      }
      if (modelCalls === 2) {
        assert.ok(surface.includes('plan_task'));
        return {
          responseId: 'search-repair-incomplete-plan',
          output: [functionCall('search-repair-incomplete-plan', 'plan_task', {
            preamble: 'I’ll read the source and create the output now.',
            draft: readThenUnattestedWriteDraft('cap:local:user_profile_read:read'),
          })],
        };
      }
      if (modelCalls === 3) {
        const requestText = JSON.stringify(request);
        assert.ok(requestText.includes('plan_incomplete_missing_write'));
        assert.ok(!requestText.includes('admissibleCapabilities'),
          'the ask-only refusal carries no capability list to pick from');
        assert.ok(requestText.includes('Use tool_search for the exact missing write capability'));
        assert.ok(surface.includes('tool_search'));
        return {
          responseId: 'search-repair-write-search',
          output: [functionCall('search-repair-write-search', 'tool_search', {
            query: 'write_file', role_key: null, limit: 1,
          })],
        };
      }
      if (modelCalls === 4) {
        assert.ok(surface.includes('plan_task'), 'new authority restores the ordinary planning surface');
        throw expectedStop;
      }
      throw new Error(`unexpected extra model call ${modelCalls}`);
    },
    getStreamedResponse: modelStream,
  };
  const agent = await buildOrchestratorAgent({
    userInput: prompt,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['user_profile_read', 'write_file', 'tool_search'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none', reason: 'isolated local recovery regression',
      allowedServerSlugs: [], toolPatterns: [], maxTools: 0,
    },
    model: model as never,
  });
  let thrown: unknown;
  try {
    await brackets.withHarnessRunContext({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      counter: new brackets.ToolCallsCounter(8),
      behaviorScopeId: `${session.id}::turn:1`,
    }, () => hostRunRunner(
      throwingRunner() as never,
      agent as never,
      [{ role: 'user', content: prompt }] as never,
      {
        maxTurns: 7,
        hostTurnEngine: 'host_v1',
        context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
      } as never,
    ));
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, expectedStop);
  assert.equal(modelCalls, 4);
  assert.ok(surfaces[2]?.includes('tool_search'));
  assert.ok(surfaces[3]?.includes('plan_task'));
  assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
});

test('a host-only materialization gap transfers privately to HostRecoveryState without another model call', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const prompt = 'Use the already connected account to complete the requested host-only plan.';
  const session = eventlog.createSession({ id: 'host-no-progress-private-recovery', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  assert.ok(turnGraphShadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const acceptedTaskId = attemptIdentity.acceptedTaskIdFor(session.id, source.seq);
  const callId = 'plan-host-materialization-gap';
  const args = { preamble: 'I’ll bind the exact destination.', draft: { criteria: ['one exact result'] } };
  const refusal = JSON.stringify({
    ok: false,
    code: 'plan_not_admitted',
    detail: 'host_destination_identity_unavailable:cap:fixture:connected-account',
    repair: 'Refresh the host-owned destination binding and retry the exact plan.',
  });
  const physical = dispatchLedger.beginPhysicalDispatch({
    identity: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedTaskId,
      logicalToolCallId: callId,
      physicalDispatchId: `dispatch:host:${callId}`,
      ordinal: 1,
    },
    tool: 'plan_task',
    args,
    relation: 'primary',
    executionSite: 'host',
  });
  assert.equal(physical.status, 'inserted');
  if (physical.status !== 'inserted') return;
  assert.equal(dispatchLedger.settlePhysicalDispatch({
    identity: physical.identity,
    tool: 'plan_task',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = attemptSettlement.settleToolAttempt({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    lane: 'byo',
    toolName: 'plan_task',
    callId,
    args,
    mutating: false,
    businessCall: false,
    result: refusal,
  });
  assert.notEqual(settled.outcome.kind, 'succeeded');

  const authority = projectHostNoProgressAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(authority.status, 'ok');
  if (authority.status !== 'ok') return;
  const governor = initializeNoProgressGovernor({
    taskKey: acceptedTaskId,
    authority: authority.authority,
  });
  const history = [
    { type: 'message', role: 'user', content: prompt },
    functionCall(callId, 'plan_task', args),
    {
      type: 'function_call_result',
      callId,
      name: 'plan_task',
      output: { type: 'text', text: refusal },
    },
  ];
  const acceptedRef = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    batchOrdinal: 1,
    batchId: 'a'.repeat(64),
    authorityDigest: 'b'.repeat(64),
  };
  const resumed = new HostInterruptState(
    history as never,
    [],
    'host-materialization-response',
    'host_v1',
    {
      state: governor,
      historyCursor: 1,
      recoveryOnly: false,
      recoveryDirectiveWritten: false,
    },
    acceptedRef,
  );
  const primed = await semanticPlanning.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  let modelCalls = 0;
  const model = {
    async getResponse() {
      modelCalls += 1;
      throw new Error('host-owned recovery must transfer before another model request');
    },
    getStreamedResponse: modelStream,
  };
  const agent = await buildOrchestratorAgent({
    userInput: prompt,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['tool_search'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none',
      reason: 'host-only no-progress recovery regression',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });
  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(6),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    resumed as never,
    {
      maxTurns: 5,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    } as never,
  ));
  assert.equal(modelCalls, 0);
  assert.deepEqual(outcome.hold, {
    owner: 'host', wake: 'recovery', reason: 'recovery_pending',
  });
  assert.equal(outcome.terminal, undefined);
  assert.ok(outcome.serializedRecoveryState);
  const privateState = HostRecoveryState.fromString(outcome.serializedRecoveryState!);
  assert.equal(privateState.phase, 'continue');
  assert.equal(privateState.noProgressCheckpoint?.state.lastConsequence?.stage,
    'semantic_admission:host_destination_identity_unavailable');
});

test('ask-user recovery publishes only the exact durable question/options/purpose', async () => {
  const question = 'Which connected account should I use?';
  const choices = ['Scorpion', 'Breakthrough'];
  const cases = [
    {
      label: 'completed-prose',
      output: [{
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Tell me whatever account details you have and ask me to continue.' }],
      }],
      exact: false,
    },
    {
      label: 'wrong-question',
      output: [functionCall('wrong-question', 'ask_user_question', {
        question: 'Which account, or should I just choose for you?',
        options: choices,
        purpose: 'clarification',
      })],
      exact: false,
    },
    {
      label: 'reordered-options',
      output: [functionCall('reordered-options', 'ask_user_question', {
        question,
        options: [...choices].reverse(),
        purpose: 'clarification',
      })],
      exact: false,
    },
    {
      label: 'wrong-purpose',
      output: [functionCall('wrong-ask', 'ask_user_question', {
        question,
        options: choices,
        purpose: 'approval',
      })],
      exact: false,
    },
    {
      label: 'exact',
      output: [functionCall('exact-ask', 'ask_user_question', {
        question,
        options: choices,
        purpose: 'clarification',
      })],
      exact: true,
    },
    {
      // The governor has no choices and the tool declares `options` as a
      // required strict-nullable field. A brain that omits it emits the bytes
      // the host will materialize to options: null — the canonical ask — so
      // the authority compare must read the materialized call, not raw bytes.
      label: 'omitted-nullable-options',
      choices: [] as readonly string[],
      output: [functionCall('omitted-options-ask', 'ask_user_question', {
        question,
        purpose: 'clarification',
      })],
      exact: true,
    },
  ] as const;

  for (const fixtureCase of cases) {
    const caseChoices = 'choices' in fixtureCase ? fixtureCase.choices : choices;
    eventlog.resetEventLog();
    catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
    const session = eventlog.createSession({
      id: `host-no-progress-exact-ask-${fixtureCase.label}`,
      kind: 'chat',
    });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Use the connected account I choose.' },
    });
    const initial = initializeNoProgressGovernor({
      taskKey: attemptIdentity.acceptedTaskIdFor(session.id, source.seq),
      authority: { operation: [], account: [], target: [], evidence: [], effect: [] },
    });
    const asked = observeNoProgress(initial, {
      taskKey: initial.taskKey,
      attemptClass: 'plan_admission',
      authority: initial.authority,
      consequence: createNoProgressConsequence({
        stage: 'input_required:account_selection',
        recovery: 'ask_user',
        effectState: 'not_started',
        userInput: { question, choices: caseChoices, purpose: 'clarification' },
      }),
    });
    assert.equal(asked.action, 'continue');
    const resumed = new HostInterruptState(
      [{ type: 'message', role: 'user', content: String(source.data.text) }] as never,
      [],
      undefined,
      'host_v1',
      {
        state: asked.state,
        historyCursor: 1,
        recoveryOnly: true,
        recoveryDirectiveWritten: false,
      },
    );
    let modelCalls = 0;
    const model = {
      async getResponse() {
        modelCalls += 1;
        return {
          responseId: `exact-ask-${fixtureCase.label}`,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: fixtureCase.output,
        };
      },
      getStreamedResponse: modelStream,
    };
    const agent = await buildOrchestratorAgent({
      userInput: String(source.data.text),
      sessionId: session.id,
      sourceUserSeq: source.seq,
      // This recovery fixture intentionally mounts only the host-control ask.
      // The durable consequence, not an ambient business/catalog surface,
      // owns its exact question authority.
      allowedToolNames: ['ask_user_question'],
      allowToolJit: true,
      mcpToolScope: {
        authority: 'none',
        reason: 'exact no-progress ask regression',
        allowedServerSlugs: [],
        toolPatterns: [],
        maxTools: 0,
      },
      model: model as never,
    });
    const parent = {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      counter: new brackets.ToolCallsCounter(3),
      behaviorScopeId: `${session.id}::turn:1`,
    };
    const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
      throwingRunner() as never,
      agent as never,
      resumed as never,
      {
        maxTurns: 3,
        hostTurnEngine: 'host_v1',
        context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
      } as never,
    ));
    assert.equal(modelCalls, 1, 'an invalid ask never buys a last-word model call');
    const asks = eventlog.listEvents(session.id, { types: ['awaiting_user_input'] });
    if (fixtureCase.exact) {
      assert.equal(outcome.terminal, undefined, JSON.stringify({
        terminal: outcome.terminal,
        finalOutput: outcome.finalOutput,
        history: outcome.history,
      }));
      assert.equal(asks.length, 1);
      assert.equal(asks[0]?.data.question, question);
      assert.deepEqual(asks[0]?.data.options ?? null, caseChoices.length > 0 ? caseChoices : null);
      assert.equal(asks[0]?.data.purpose, 'clarification');
    } else {
      assert.equal(outcome.terminal?.reason, 'control_no_progress_exhausted');
      assert.notEqual(outcome.terminal?.resumable, false);
      assert.match(String(outcome.finalOutput), /Next: Answer:/);
      assert.equal(asks.length, 0);
      assert.notEqual(outcome.finalOutput,
        'Tell me whatever account details you have and ask me to continue.');
    }
  }
});

test('a known result stops from retained state without a model call or invented approval', async () => {
  for (const [label, text] of [
    ['ask-marker', 'ASK: Please reconnect the account and tell me to continue.'],
    ['approval-envelope', JSON.stringify({
      summary: 'I need your approval to retry.',
      reply: 'Approve another attempt?',
      done: false,
      nextAction: 'awaiting_approval',
      reason: 'internal retry',
    })],
  ] as const) {
    eventlog.resetEventLog();
    catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
    const session = eventlog.createSession({
      id: `host-no-progress-stop-factual-${label}`,
      kind: 'chat',
    });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Use the result that is already known.' },
    });
    const initial = initializeNoProgressGovernor({
      taskKey: attemptIdentity.acceptedTaskIdFor(session.id, source.seq),
      authority: { operation: [], account: [], target: [], evidence: [], effect: [] },
    });
    const recovery = observeNoProgress(initial, {
      taskKey: initial.taskKey,
      attemptClass: 'plan_admission',
      authority: initial.authority,
      consequence: createNoProgressConsequence({
        stage: 'execution:known_terminal',
        recovery: 'stop_factual',
        effectState: 'known_terminal',
      }),
    });
    assert.equal(recovery.action, 'continue');
    const resumed = new HostInterruptState(
      [{ type: 'message', role: 'user', content: String(source.data.text) }] as never,
      [],
      undefined,
      'host_v1',
      {
        state: recovery.state,
        historyCursor: 1,
        recoveryOnly: true,
        recoveryDirectiveWritten: false,
      },
    );
    let modelCalls = 0;
    const model = {
      async getResponse() {
        modelCalls += 1;
        return {
          responseId: `stop-factual-${label}`,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [{
            type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text }],
          }],
        };
      },
      getStreamedResponse: modelStream,
    };
    const agent = await buildOrchestratorAgent({
      userInput: String(source.data.text),
      sessionId: session.id,
      sourceUserSeq: source.seq,
      allowedToolNames: [],
      allowToolJit: true,
      mcpToolScope: {
        authority: 'none',
        reason: 'stop-factual no-progress regression',
        allowedServerSlugs: [],
        toolPatterns: [],
        maxTools: 0,
      },
      model: model as never,
    });
    const parent = {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: 1,
      counter: new brackets.ToolCallsCounter(1),
      behaviorScopeId: `${session.id}::turn:1`,
    };
    const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
      throwingRunner() as never,
      agent as never,
      resumed as never,
      {
        maxTurns: 2,
        hostTurnEngine: 'host_v1',
        context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
      } as never,
    ));
    assert.equal(modelCalls, 0);
    assert.equal(outcome.terminal?.reason, 'control_no_progress_exhausted');
    assert.notEqual(outcome.terminal?.resumable, false);
    assert.equal(outcome.finalOutput, hostNoProgressBlockedText(recovery.state));
    assert.equal(eventlog.listEvents(session.id, { types: ['awaiting_user_input'] }).length, 0);
    assert.notEqual(outcome.finalOutput, text);
  }
});

// ---------------------------------------------------------------------------
// Nested-schema repair (gate 2). The refusal diagnostic, the recovery surface,
// and the recovery directive all derive from ONE consequence: the surface is
// exactly the refused carrier, the directive never names a control that
// surface does not contain, the diagnostic never recommends discovery, a NEW
// failing-path set continues as bounded progress, and an identical one
// terminalizes. (Appended pins; the earlier tests in this file are unchanged.)
// ---------------------------------------------------------------------------
const proofArgs = await import('./proof-provider-args.js');
const noProgressProjection = await import('./host-no-progress-projection.js');
const hostResults = await import('./host-model-result-receipt.js');

const OPAQUE_TABLE_INSERT_V7 = {
  type: 'object',
  required: ['destination_id', 'insertion'],
  properties: {
    destination_id: { type: 'string', description: 'SENTINEL_DESCRIPTION' },
    insertion: {
      type: 'object',
      required: ['range'],
      properties: {
        range: {
          type: 'object',
          required: ['axis', 'start_index', 'end_index'],
          properties: {
            sheet_id: { type: 'integer' },
            axis: { type: 'string', enum: ['ROWS', 'COLUMNS'] },
            start_index: { type: 'integer' },
            end_index: { type: 'integer' },
          },
        },
        inherit_from_before: { type: 'boolean' },
      },
    },
  },
};
const SCHEMA_REPAIR_CARRIER = 'opaque_provider_carrier';
const NO_PROGRESS_AUTHORITY = { operation: [], account: [], target: [], evidence: [], effect: [] } as const;

function schemaRefusalValidator() {
  const validator = proofArgs.createProofProviderForegroundPayloadValidator({
    operationId: 'OPAQUE_TABLE_INSERT_V7',
    schema: OPAQUE_TABLE_INSERT_V7,
  });
  assert.ok(validator);
  return validator!;
}

function refusedSchemaPayload(validator: ReturnType<typeof schemaRefusalValidator>, payload: unknown) {
  const refused = validator(payload);
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error('fixture payload unexpectedly matched the schema');
  return refused;
}

function schemaRefusalSource(label: string) {
  const session = eventlog.createSession({ id: `host-no-progress-schema-repair-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Insert two rows into the opaque table.' },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function projectSchemaRefusal(input: {
  identity: { sessionId: string; sourceUserSeq: number };
  callId: string;
  refused: { repair: string; repairKey: string };
  args: Record<string, unknown>;
}) {
  const marker = hostResults.buildHostToolDispositionResult({
    callId: input.callId,
    toolName: SCHEMA_REPAIR_CARRIER,
    disposition: 'refused_pre_dispatch',
    frameDigest: 'd'.repeat(64),
    frameIndex: 0,
    frameSize: 1,
    countsRefusal: false,
    diagnostic: input.refused.repair,
    repairKey: input.refused.repairKey,
  });
  const projected = noProgressProjection.projectHostNoProgressAttempt({
    ...input.identity,
    historyDelta: [functionCall(input.callId, SCHEMA_REPAIR_CARRIER, input.args), marker],
  });
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok' || !projected.consequence) throw new Error('expected a projected consequence');
  assert.equal(projected.attemptClass, 'zero_crossing_repair');
  return { marker, consequence: projected.consequence };
}

/** The runner's recovery-surface rule for a consequence with recovery tool
 * names: the model sees exactly those tool names and nothing else. */
test('a schema refusal preserves its carrier and the turn\'s available discovery/read controls', () => {
  eventlog.resetEventLog();
  const validator = schemaRefusalValidator();
  const camelArgs = {
    destination_id: 'dest-1',
    insertion: { range: { sheetId: 7, axis: 'ROWS', startIndex: 1, endIndex: 2 } },
  };
  const refused = refusedSchemaPayload(validator, camelArgs);
  assert.match(refused.repair, /^\[provider-dispatch:not-started:invalid-args\] OPAQUE_TABLE_INSERT_V7 arguments did not match its exact current schema\./);
  assert.match(refused.repair, /"\/insertion\/range\/start_index" \(missing required, expected integer\)/);
  assert.match(refused.repair, /Required shape at "\/insertion\/range": object; required: \[axis, start_index, end_index\]/);
  // The diagnostic never recommends discovery; its one mention of tool_search
  // is the negative instruction, matching the directive below.
  assert.doesNotMatch(refused.repair, /call the first-class local tool_search/i);
  assert.equal(refused.repair.replace(/do not call tool_search/g, '').includes('tool_search'), false);
  assert.doesNotMatch(refused.repair, /SENTINEL_/);

  const identity = schemaRefusalSource('surface');
  const { marker, consequence } = projectSchemaRefusal({
    identity, callId: 'call:schema:1', refused, args: camelArgs,
  });
  assert.equal(consequence.stage, `schema_invalid:${refused.repairKey.slice(0, 16)}`);
  assert.equal(consequence.recovery, 'repair_model');
  assert.equal(consequence.effectState, 'not_started');
  assert.deepEqual(consequence.recoveryToolNames, [SCHEMA_REPAIR_CARRIER]);
  assert.deepEqual(
    [...hostNoProgressRecoveryToolNames(consequence, ['tool_search', 'read_file', 'plan_task', 'call_tool', SCHEMA_REPAIR_CARRIER, 'write_file', 'unknown_mutation'])],
    ['tool_search', 'read_file', SCHEMA_REPAIR_CARRIER],
    'reads/discovery stay available; unrelated writes and unproven carriers do not',
  );
  assert.deepEqual([...hostNoProgressRecoveryToolNames(consequence,
    ['call_tool', 'work_call', 'proven_read', 'unknown_mutation'], ['proven_read'])],
  ['call_tool', 'work_call', 'proven_read'], 'proven reads retain their existing carrier');

  const initial = initializeNoProgressGovernor({
    taskKey: attemptIdentity.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq),
    authority: NO_PROGRESS_AUTHORITY,
  });
  const decision = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: initial.authority,
    consequence,
  });
  assert.equal(decision.action, 'continue');
  const directive = hostNoProgressRecoveryDirective(decision.state);
  assert.match(directive, /^BOUNDED AUTO RECOVERY — the last call was refused before dispatch because its arguments did not match the exact schema/);
  assert.match(directive, new RegExp(`Call ${SCHEMA_REPAIR_CARRIER} exactly once with one corrected JSON object for the same operation`));
  assert.match(directive, /available discovery and read controls/);

  // The keyed marker is an exact host projection: the receipt lane accepts it.
  assert.equal(hostResults.describeCanonicalHostModelResult(marker)?.disposition, 'refused_pre_dispatch');
  assert.equal(hostResults.canonicalHostModelResultClass(marker), 'refused_pre_dispatch');
  const markerText = (marker as unknown as { output: { text: string } }).output.text;
  assert.equal((JSON.parse(markerText) as Record<string, unknown>).repairKey, refused.repairKey);
});

test('a second schema refusal with a new failing-path set continues; an identical one terminalizes', () => {
  eventlog.resetEventLog();
  const validator = schemaRefusalValidator();
  const camelArgs = {
    destination_id: 'dest-1',
    insertion: { range: { sheetId: 7, axis: 'ROWS', startIndex: 1, endIndex: 2 } },
  };
  const camelAgainArgs = {
    destination_id: 'a different destination',
    insertion: { range: { sheetId: 99, axis: 'COLUMNS', startIndex: 40, endIndex: 41 } },
  };
  const flatArgs = {
    destination_id: 'dest-1',
    insertion: { axis: 'ROWS', start_index: 1, end_index: 2 },
  };
  const camel = refusedSchemaPayload(validator, camelArgs);
  const camelAgain = refusedSchemaPayload(validator, camelAgainArgs);
  const flat = refusedSchemaPayload(validator, flatArgs);
  assert.equal(camel.repairKey, camelAgain.repairKey, 'different wrong values at the same paths are the same mistake');
  assert.notEqual(camel.repairKey, flat.repairKey, 'a different failing-path set is a different mistake');
  assert.deepEqual(validator({
    destination_id: 'dest-1',
    insertion: { range: { sheet_id: 7, axis: 'ROWS', start_index: 1, end_index: 2 } },
  }), { ok: true });

  const identity = schemaRefusalSource('progress');
  const first = projectSchemaRefusal({ identity, callId: 'call:schema:a1', refused: camel, args: camelArgs });
  const identical = projectSchemaRefusal({ identity, callId: 'call:schema:a2', refused: camelAgain, args: camelAgainArgs });
  const progressed = projectSchemaRefusal({ identity, callId: 'call:schema:b1', refused: flat, args: flatArgs });
  assert.equal(first.consequence.key, identical.consequence.key);
  assert.notEqual(first.consequence.key, progressed.consequence.key);
  assert.deepEqual(progressed.consequence.recoveryToolNames, [SCHEMA_REPAIR_CARRIER]);

  const initial = initializeNoProgressGovernor({
    taskKey: attemptIdentity.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq),
    authority: NO_PROGRESS_AUTHORITY,
  });
  const observe = (
    state: typeof initial,
    consequence: typeof first.consequence,
  ) => observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: NO_PROGRESS_AUTHORITY,
    consequence,
  });

  const afterFirst = observe(initial, first.consequence);
  assert.equal(afterFirst.action, 'continue');
  // The same mistake spends the bounded retry budget (no effect started), then terminalizes.
  let afterIdentical = observe(afterFirst.state, identical.consequence);
  assert.equal(afterIdentical.action, 'continue', 'the same mistake spends a retry first');
  for (let spent = 1; afterIdentical.action === 'continue'; spent += 1) {
    assert.ok(spent <= NO_PROGRESS_RETRY_BUDGET, 'the same mistake must stay bounded');
    afterIdentical = observe(afterIdentical.state, identical.consequence);
  }
  assert.equal(afterIdentical.action, 'terminalize', 'the same mistake terminalizes once its retries are spent');

  const afterProgress = observe(afterFirst.state, progressed.consequence);
  assert.equal(afterProgress.action, 'continue', 'a new failing-path set is bounded structural progress');
  if (afterProgress.action === 'continue') assert.equal(afterProgress.reason, 'consequence_progress');
  assert.match(
    hostNoProgressRecoveryDirective(afterProgress.state),
    new RegExp(`Call ${SCHEMA_REPAIR_CARRIER} exactly once with one corrected JSON object for the same operation`),
  );
  let afterRepeatedProgress = observe(afterProgress.state, progressed.consequence);
  for (let spent = 0; afterRepeatedProgress.action === 'continue'; spent += 1) {
    assert.ok(spent < NO_PROGRESS_RETRY_BUDGET, 'the repeated progress consequence must stay bounded');
    afterRepeatedProgress = observe(afterRepeatedProgress.state, progressed.consequence);
  }
  assert.equal(afterRepeatedProgress.action, 'terminalize');
});
