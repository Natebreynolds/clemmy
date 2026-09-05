/**
 * Run: npx tsx --test src/runtime/harness/respond-bridge.test.ts
 *
 * Isolated CLEMENTINE_HOME so harness sessions/events don't touch the real
 * vault. The bridge's model/agent layers are injected via
 * _setBridgeImplsForTests — these tests cover ROUTING and CONTRACT mapping,
 * not the model.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const TEST_HOME = mkdtempSync(path.join(tmpdir(), 'clemmy-test-respond-bridge-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const {
  respondPreferHarness,
  respondViaHarness,
  harnessSurfaceEnabled,
  isChatBrainFalloverEligible,
  synthesizeCompletedWorkReport,
  _setBridgeImplsForTests,
  composeDispatchedReplyText,
} = await import('./respond-bridge.js');
// eslint-disable-next-line import/first
const {
  appendConversationPreambleOnce,
  appendEvent,
  beginRunAttempt,
  createSession,
  finishRunAttempt,
  getLatestRunAttempt,
  getSession,
  getTurnGraphEventForSource,
  listEvents,
  openEventLog,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('./eventlog.js');
// eslint-disable-next-line import/first
const {
  classifyTurnPreflight,
  recordTurnPreflightDecision,
  sourceStrategyTopologyDigestFor,
} = await import('./turn-control.js');
// eslint-disable-next-line import/first
const { publishPreflightConversation } = await import('./preflight-conversation.js');
// eslint-disable-next-line import/first
const { turnGraphFromShadowEvent } = await import('../graph/turn-graph-shadow.js');
// eslint-disable-next-line import/first
const { recordAcceptedSourceGraph } = await import('./record-accepted-source-graph.js');
// eslint-disable-next-line import/first
const { AgentRuntimeCancelledError } = await import('../provider.js');
// eslint-disable-next-line import/first
const {
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
} = await import('./claude-agent-brain.js');
// eslint-disable-next-line import/first
const { ClaudeSdkCapacityExhaustedError, ClaudeSdkProviderOverloadError } = await import('./claude-agent-sdk.js');
// eslint-disable-next-line import/first
const capabilityHealth = await import('./capability-health.js');
// eslint-disable-next-line import/first
const { actionBus } = await import('../action-bus.js');
// eslint-disable-next-line import/first
const { PUBLIC_RUN_FAILURE_TEXT } = await import('./public-presentation.js');
// eslint-disable-next-line import/first
const { HarnessSession } = await import('./session.js');
// eslint-disable-next-line import/first
const { commitTurnOutcome } = await import('./delivery-committer.js');
// eslint-disable-next-line import/first
const { presentationEventForOutcome, turnOutcomeId } = await import('./turn-outcome.js');
// eslint-disable-next-line import/first
const { inspectDurableMaterialSourceContinuation } = await import('./task-continuity-runtime.js');
// eslint-disable-next-line import/first
const schemaCache = await import('../../tools/composio-schema-cache.js');
// eslint-disable-next-line import/first
const semanticDisposition = await import('../semantic-boundary/semantic-disposition.js');
// eslint-disable-next-line import/first
const approvalRegistry = await import('./approval-registry.js');
// eslint-disable-next-line import/first
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
// eslint-disable-next-line import/first
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
// eslint-disable-next-line import/first
const {
  queueWorkflowRun,
  workflowChatDispatchQueueRequestDigest,
} = await import('../../tools/workflow-run-queue.js');
// eslint-disable-next-line import/first
const { writeWorkflow } = await import('../../memory/workflow-store.js');
// eslint-disable-next-line import/first
const { peekTaskContinuityPacket } = await import('../../memory/task-continuity.js');
// eslint-disable-next-line import/first
const {
  clearRunInFlightAfterTerminal,
  recoverInterruptedChatRuns,
} = await import('./restart-recovery.js');
// eslint-disable-next-line import/first
const { finalizePreparedWorkflowDispatchForSource } = await import('./loop.js');
// eslint-disable-next-line import/first
const runtimeConfig = await import('../../config.js');
// eslint-disable-next-line import/first
const acceptedCallAuthority = await import('./accepted-turn-call-authority.js');
// eslint-disable-next-line import/first
// eslint-disable-next-line import/first
const {
  createWorkflowChatDispatchPreparationAuthority,
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupClosedBatch,
  workflowOriginSourceGroupId,
} = await import('../../execution/workflow-origin-group.js');

const FAKE_AGENT = {} as never;
const okConfigure = (async () => ({ ok: true })) as never;
const fakeAgentBuilder = (async () => FAKE_AGENT) as never;

/**
 * Mirror of loop.ts's capability_resolve identity: the exact accepted source
 * plus the persisted shadow-graph route (chat surfaces fall back to
 * direct_reply exactly like the loop when no graph exists; non-chat sessions
 * are always direct_reply because TurnGraph v1 contracts chat sources only).
 * Every runConversation stub that invokes buildAgent must pass this — the real
 * builder closure reads identity.sourceUserSeq and identity.route.
 */
function stubBuildIdentity(opts: { sessionId: string; sourceUserSeq?: number }): {
  sessionId: string;
  sourceUserSeq: number;
  route: 'direct_reply' | 'retrieve' | 'act';
} {
  const sourceUserSeq = opts.sourceUserSeq ?? 0;
  let route: 'direct_reply' | 'retrieve' | 'act' = 'direct_reply';
  if (getSession(opts.sessionId)?.kind === 'chat' && sourceUserSeq > 0) {
    try {
      const graphEvent = getTurnGraphEventForSource(opts.sessionId, sourceUserSeq);
      const graph = graphEvent ? turnGraphFromShadowEvent(graphEvent) : null;
      route = graph?.classification.route ?? 'direct_reply';
    } catch { /* keep the loop's direct_reply fallback */ }
  }
  return { sessionId: opts.sessionId, sourceUserSeq, route };
}

function stubAnswerPresentation(
  opts: { sessionId: string; sourceUserSeq?: number },
  text: string,
) {
  const source = listEvents(opts.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === opts.sourceUserSeq);
  assert.ok(source, 'the bridge must establish the accepted source before runConversation');
  const identity = { sessionId: opts.sessionId, turn: source.turn, sourceUserSeq: source.seq };
  return presentationEventForOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
  });
}

/** Install the smallest claim-linked semantic record whose checked projection
 * says this exact accepted source answered an open slot with a value. The
 * production bridge reads this durable claim; an unlinked event is ignored. */
function recordTypedProvidedAnswer(source: import('./eventlog.js').EventRow): void {
  const inputHash = createHash('sha256').update(`input:${source.id}`).digest('hex');
  const audienceHash = createHash('sha256').update(`audience:${source.sessionId}`).digest('hex');
  const policyRevision = createHash('sha256').update('typed-answer-policy').digest('hex');
  const interpreted = appendEvent({
    sessionId: source.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'turn_semantics_interpreted',
    data: {
      purpose: 'turn_semantics',
      sourceUserSeq: source.seq,
      inputHash,
      audienceHash,
      policyRevision,
      payloadHash: 'a'.repeat(64),
      contextHash: 'b'.repeat(64),
      modelIdentity: 'typed-slot-fixture',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      validationOutcome: 'admitted',
      repairAttempted: false,
      raw: {
        relation: 'answer_open_slot',
        work: null,
        goal: null,
        slotAnswers: [{ kind: 'value', value: source.data.text }],
      },
    },
  });
  openEventLog().prepare(`
    INSERT INTO turn_semantics_claims
      (session_id, source_user_seq, owner, created_at, event_id,
       input_hash, audience_hash, policy_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.sessionId,
    source.seq,
    `typed-owner:${source.id}`,
    new Date().toISOString(),
    interpreted.id,
    inputHash,
    audienceHash,
    policyRevision,
  );
  semanticDisposition.recordSemanticParticipation(source.sessionId, source.seq, 'participated');
  semanticDisposition.recordSemanticDispositionOutcome(source.sessionId, source.seq, 'admitted');
}

function fakeRun(result: Record<string, unknown>): never {
  return (async (opts: {
    sessionId: string;
    sourceUserSeq?: number;
    buildAgent?: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
  }) => {
    // Capability interior contract: the real runConversation resolves the
    // agent AT the capability_resolve node. The stub mirrors that, so tests
    // asserting builder arguments keep asserting the true call, at its true
    // time — during the turn, not before it.
    await opts.buildAgent?.(stubBuildIdentity(opts));
    return {
      sessionId: opts.sessionId,
      steps: 1,
      lastTurn: 1,
      ...result,
    };
  }) as never;
}

function seedCompletedAnswerReplay(input: {
  sessionId: string;
  answerRequest?: string;
  priorText?: string;
  priorStatus?: 'done' | 'continue';
}): {
  prior: import('./eventlog.js').EventRow;
  current: import('./eventlog.js').EventRow;
  currentAttempt: ReturnType<typeof beginRunAttempt>;
} {
  const priorText = input.priorText ?? 'The workspace inspection is complete.';
  const answerRequest = input.answerRequest ?? 'Repeat the last answer.';
  createSession({ id: input.sessionId, kind: 'chat' });
  const priorAttempt = beginRunAttempt(input.sessionId, { runId: `${input.sessionId}:prior` });
  const prior = recordRunAttemptUserInput(priorAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Inspect the workspace and report the roots.' },
  }, { armRunInFlight: true });
  const priorIdentity = {
    sessionId: input.sessionId,
    turn: prior.turn,
    sourceUserSeq: prior.seq,
  } as const;
  commitTurnOutcome(input.priorStatus === 'continue'
    ? {
        version: 2,
        id: turnOutcomeId(priorIdentity),
        identity: priorIdentity,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'continue' },
        presentation: { kind: 'continue', text: 'The task has more work. Reply continue.' },
      }
    : {
        version: 2,
        id: turnOutcomeId(priorIdentity),
        identity: priorIdentity,
        status: 'done',
        resumable: false,
        presentation: { kind: 'answer', text: priorText },
      });
  finishRunAttempt(priorAttempt, 'completed');
  const currentAttempt = beginRunAttempt(input.sessionId, { runId: `${input.sessionId}:current` });
  const current = recordRunAttemptUserInput(currentAttempt, {
    turn: 2,
    role: 'user',
    data: { text: answerRequest },
  }, { armRunInFlight: true });
  return { prior, current, currentAttempt };
}

function appendActiveWorkflowDispatch(source: import('./eventlog.js').EventRow, runId: string): void {
  const replyTarget = source.data.originReplyTarget as { type: 'origin_chat' };
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'test-workflow',
    status: 'awaiting_chat_dispatch_seal',
  }), 'utf-8');
  const authority = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer: { sessionId: source.sessionId, sourceUserSeq: source.seq, replyTarget },
    queueRequestDigest: createHash('sha256').update(`bridge-test:${runId}`).digest('hex'),
  });
  const prepared = appendEvent({
    sessionId: source.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatch_prepared',
    parentEventId: source.id,
    data: { ...authority },
  });
  const receipt = recordWorkflowChatDispatchPreparation(createWorkflowChatDispatchPreparedReceipt(authority, {
    eventId: prepared.id,
    eventSeq: prepared.seq,
    preparedAt: prepared.createdAt,
  }));
  const closeAuthority = createWorkflowOriginGroupCloseAuthority([receipt]);
  const closed = appendEvent({
    sessionId: source.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatch_batch_closed',
    parentEventId: source.id,
    data: { ...closeAuthority },
  });
  recordWorkflowOriginGroupClosedBatch({
    receipt: createWorkflowOriginGroupClosedBatchReceipt(closeAuthority, {
      eventId: closed.id,
      eventSeq: closed.seq,
      closedAt: closed.createdAt,
    }),
    preparedReceipts: [receipt],
  });
  const active = finalizeWorkflowOriginGroupClosedBatch(receipt.sourceGroupId, {
    beforeMemberRelease: () => {},
  });
  appendEvent({
    sessionId: source.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatched',
    parentEventId: source.id,
    data: { ...active.publicDispatch, replyTarget: active.sealed.replyTarget },
  });
}

beforeEach(() => {
  resetEventLog();
  runtimeConfig._setRuntimeConfigCaptureObserverForTest(null);
  setClaudeAgentSdkBrainRunForTest(null);
  capabilityHealth._resetHarnessCapabilityHealthForTest();
  _setBridgeImplsForTests({});
  delete process.env.CLEMMY_HARNESS_WEBHOOK;
  delete process.env.CLEMMY_HARNESS_CRON;
  delete process.env.CLEMMY_HARNESS_DASHBOARD;
  delete process.env.CLEMMY_HARNESS_HOME;
  delete process.env.CLEMMY_HARNESS_WORKFLOW;
  delete process.env.CLEMMY_HARNESS_DISCORD;
  delete process.env.CLEMMY_HARNESS_SLACK;
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_BRAIN_FALLOVER;
  delete process.env.CLEMMY_CHAT_AUTO_RESUME;
  delete process.env.MODEL_ROUTING_MODE;
  delete process.env.BYO_MODEL_BASE_URL;
  delete process.env.BYO_MODEL_API_KEY;
  delete process.env.BYO_MODEL_ID;
  delete process.env.BYO_MODEL_JUDGE_ID;
  delete process.env.BYO_MODEL_PROVIDER;
  delete process.env.BYO_PROVIDERS;
  delete process.env.CLAUDE_MODEL;
  delete process.env.OPENAI_MODEL_PRIMARY;
  delete process.env.CLEMMY_TURN_ENGINE;
  delete process.env.CLEMMY_CONFIRM_BEAT;
  process.env.AUTH_MODE = 'api_key';
});

after(() => {
  runtimeConfig._setRuntimeConfigCaptureObserverForTest(null);
  setClaudeAgentSdkBrainRunForTest(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('harnessSurfaceEnabled: default on, kill-switch values off', () => {
  assert.equal(harnessSurfaceEnabled('webhook'), true, 'default is ON');
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  assert.equal(harnessSurfaceEnabled('webhook'), false);
  process.env.CLEMMY_HARNESS_WEBHOOK = '0';
  assert.equal(harnessSurfaceEnabled('webhook'), false);
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  assert.equal(harnessSurfaceEnabled('webhook'), true);
});

test('harnessSurfaceEnabled: ALL surfaces default ON (FORK-collapse complete); kill-switch disables the lane', () => {
  // 2026-06-13 audit #7: dashboard/home/workflow validated live → default ON
  // like every other surface (the gated loop is the ONE path). The per-surface
  // kill-switch disables the harness lane; legacy requires explicit break-glass.
  assert.equal(harnessSurfaceEnabled('dashboard'), true, 'dashboard default ON');
  assert.equal(harnessSurfaceEnabled('home'), true, 'home default ON');
  assert.equal(harnessSurfaceEnabled('workflow'), true, 'workflow default ON');
  assert.equal(harnessSurfaceEnabled('cli'), true, 'validated surface ON by default');
  assert.equal(harnessSurfaceEnabled('discord'), true, 'discord default ON');
  assert.equal(harnessSurfaceEnabled('slack'), true, 'slack default ON');
  process.env.CLEMMY_HARNESS_DASHBOARD = 'off';
  assert.equal(harnessSurfaceEnabled('dashboard'), false, 'kill-switch disables the lane');
  delete process.env.CLEMMY_HARNESS_DASHBOARD;
});

test('respondPreferHarness owns one runtime config capture across route, build, and turn work', async () => {
  const captures: Array<'environment' | 'secret_vault'> = [];
  runtimeConfig._setRuntimeConfigCaptureObserverForTest((kind) => captures.push(kind));
  _setBridgeImplsForTests({
    configure: (async () => {
      runtimeConfig.getRuntimeEnv('CLEMMY_HARNESS_HOME', 'on');
      runtimeConfig.getRuntimeEnv('CLEMMY_HARNESS_HOME', 'on');
      runtimeConfig.getOpenAiApiKey();
      runtimeConfig.getOpenAiApiKey();
      return { ok: true };
    }) as never,
    resolveTurnCandidates: (async () => ({
      candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
    })) as never,
    buildAgent: (async () => {
      runtimeConfig.getRuntimeEnv('OPENAI_MODEL_PRIMARY', 'gpt-5.4');
      runtimeConfig.getOpenAiApiKey();
      return FAKE_AGENT;
    }) as never,
    runConversation: (async (options: {
      sessionId: string;
      sourceUserSeq?: number;
      buildAgent: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
    }) => {
      runtimeConfig.getRuntimeEnv('OPENAI_MODEL_PRIMARY', 'gpt-5.4');
      await options.buildAgent(stubBuildIdentity(options));
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        publicPresentation: stubAnswerPresentation(options, 'snapshot-owned'),
      };
    }) as never,
  });

  try {
    const response = await respondPreferHarness('home', {
      sessionId: 'bridge-runtime-config-snapshot-owner',
      message: 'Please answer this ordinary request.',
    }, async () => { throw new Error('legacy path must not run'); });
    assert.equal(response.text, 'snapshot-owned');
    assert.deepEqual(captures, ['environment', 'secret_vault']);
  } finally {
    runtimeConfig._setRuntimeConfigCaptureObserverForTest(null);
  }
});

test('accepted plain build skips live candidate recall while an unproven direct reply retains it', async () => {
  const variants = [
    { label: 'proven-plain', hostPlainConversation: true, expectedResolverCalls: 0 },
    { label: 'near-action', hostPlainConversation: false, expectedResolverCalls: 1 },
  ] as const;

  for (const variant of variants) {
    let resolverCalls = 0;
    let builtCandidates: unknown;
    _setBridgeImplsForTests({
      configure: okConfigure,
      resolveTurnCandidates: (async () => {
        resolverCalls += 1;
        return {
          candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
        };
      }) as never,
      buildAgent: (async (options: { turnCandidates?: unknown }) => {
        builtCandidates = options.turnCandidates;
        return FAKE_AGENT;
      }) as never,
      runConversation: (async (options: {
        sessionId: string;
        sourceUserSeq?: number;
        buildAgent: (identity: ReturnType<typeof stubBuildIdentity> & {
          hostPlainConversation?: true;
        }) => Promise<unknown>;
      }) => {
        await options.buildAgent({
          ...stubBuildIdentity(options),
          ...(variant.hostPlainConversation ? { hostPlainConversation: true as const } : {}),
        });
        return {
          sessionId: options.sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          publicPresentation: stubAnswerPresentation(options, variant.label),
        };
      }) as never,
    });

    const response = await respondViaHarness('home', {
      sessionId: `bridge-candidate-read-${variant.label}`,
      message: variant.hostPlainConversation ? 'Hello there.' : 'Could you check my inbox?',
      channel: 'desktop',
    }, { turnEngine: 'host_v1' });
    assert.equal(response.text, variant.label);
    assert.equal(resolverCalls, variant.expectedResolverCalls, variant.label);
    assert.equal(builtCandidates === undefined, variant.hostPlainConversation, variant.label);
  }
});

test('host chat freezes engine ownership before semantic graph work', async () => {
  process.env.CLEMMY_TURN_ENGINE = 'host_v1_read_only';
  const sessionId = 'bridge-host-engine-entry';
  let runCalls = 0;
  let selectedEngine: string | undefined;
  let selectedMaxTurns: number | undefined;
  let selectedMaxSteps: number | undefined;
  let buildIdentity: { sessionId: string; sourceUserSeq: number; route?: string } | undefined;
  let acceptedRoute: string | undefined;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: (async (input: { acceptedRoute?: string }) => {
      acceptedRoute = input.acceptedRoute;
      return FAKE_AGENT;
    }) as never,
    runConversation: (async (options: {
      sessionId: string;
      sourceUserSeq?: number;
      turnEngine?: string;
      maxTurns?: number;
      maxSteps?: number;
      buildAgent?: (identity: { sessionId: string; sourceUserSeq: number; route?: string }) => Promise<unknown>;
    }) => {
      runCalls += 1;
      selectedEngine = options.turnEngine;
      selectedMaxTurns = options.maxTurns;
      selectedMaxSteps = options.maxSteps;
      buildIdentity = {
        sessionId: options.sessionId,
        sourceUserSeq: Number(options.sourceUserSeq),
      };
      await options.buildAgent?.(buildIdentity);
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        publicPresentation: stubAnswerPresentation(options, 'HOST ENGINE READY'),
      };
    }) as never,
  });

  const response = await respondPreferHarness('home', {
    sessionId,
    message: 'Reply with exactly: HOST ENGINE READY',
  }, async () => {
    throw new Error('legacy response path must be unreachable');
  }, { maxTurns: 7, maxSteps: 9 });

  assert.equal(response.text, 'HOST ENGINE READY');
  assert.equal(runCalls, 1);
  assert.equal(selectedEngine, 'host_v1_read_only');
  assert.equal(selectedMaxTurns, 7);
  assert.equal(selectedMaxSteps, 9);
  assert.equal(buildIdentity?.sessionId, sessionId);
  assert.ok(Number.isSafeInteger(buildIdentity?.sourceUserSeq));
  assert.equal(buildIdentity?.route, undefined);
  assert.equal(acceptedRoute, undefined, 'the bridge does not reintroduce a semantic route');
  assert.equal(listEvents(sessionId, { types: ['capability_resolution'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['turn_semantics_interpreted'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['turn_graph_shadow'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['accepted_task_authority_armed'] }).length, 0);
});

test('fresh host candidate recall stays advisory and cannot carry source authority into the model', async () => {
  const sessionId = 'bridge-fresh-host-material-source-marker';
  const displayMessage = 'Find the top 5 Pismo Beach restaurants and create one new Google Sheet.';
  const message = `${displayMessage} Pull them from the Apify API.`;
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_FRESH_LIVE_READ',
      schemaFingerprint: 'd'.repeat(64),
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'e'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  let runCalls = 0;
  let advisoryCandidatesObserved = false;
  let builtBinding: unknown;
  const forgedCallerBinding = {
    ...sourceStrategyBinding,
    primary: {
      capabilityId: 'capability:composio:CALLER_FORGED_SOURCE',
      schemaFingerprint: 'f'.repeat(64),
    },
  } as const;
  _setBridgeImplsForTests({
    configure: okConfigure,
    resolveTurnCandidates: (async (input: { userInput: string }) => {
      assert.equal(input.userInput, displayMessage,
        'resolver authority is the durable displayed user text, not a hidden model directive');
      return ({
      candidates: [],
      requirements: [],
      matches: [],
      pinnedTools: ['composio_execute_tool'],
      semanticApplied: true,
      sourceStrategyBinding,
      });
    }) as never,
    buildAgent: (async (input: { turnCandidates?: { sourceStrategyBinding?: unknown } }) => {
      builtBinding = input.turnCandidates?.sourceStrategyBinding;
      return FAKE_AGENT;
    }) as never,
    runConversation: (async (options: {
      sessionId: string;
      sourceUserSeq?: number;
      buildAgent: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
    }) => {
      runCalls += 1;
      await options.buildAgent(stubBuildIdentity(options));
      const sourceUserSeq = Number(options.sourceUserSeq);
      const decisions = listEvents(sessionId, { types: ['turn_preflight_decision'] })
        .filter((event) => event.data.sourceUserSeq === sourceUserSeq);
      assert.equal(decisions.length, 0, 'advisory recall cannot mint a durable A/Q/B marker');
      const inspection = inspectDurableMaterialSourceContinuation({ sessionId, sourceUserSeq });
      assert.equal(inspection.status, 'not_applicable');
      advisoryCandidatesObserved = true;
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        publicPresentation: stubAnswerPresentation(options, 'candidate context ready'),
      };
    }) as never,
  });
  const response = await respondViaHarness('home', {
    sessionId,
    message,
    displayMessage,
    channel: 'desktop',
    turnCandidates: {
      candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
      sourceStrategyBinding: forgedCallerBinding,
    },
  }, { turnEngine: 'host_v1' });
  assert.equal(response.text, 'candidate context ready');
  assert.equal(runCalls, 1);
  assert.equal(advisoryCandidatesObserved, true);
  assert.equal(builtBinding, undefined,
    'both caller and historical resolver bindings are stripped from the fresh model surface');
  const source = listEvents(sessionId, { types: ['user_input_received'] })[0]!;
  const db = openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, source.seq) as { n: number }).n, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, source.seq) as { n: number }).n, 0);
});

test('fresh structural work reaches the model without a historical source binding or retry checkpoint', async () => {
  const callerBinding = {
    version: 1,
    primary: { capabilityId: 'capability:composio:CALLER_ONLY_SOURCE' },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'a'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const variants = [
    {
      label: 'resolver-throw',
      message: 'Find the top 5 firms by rating and create one new spreadsheet.',
      confirmBeat: 'on',
      resolver: async () => { throw new Error('selector storage unavailable'); },
    },
    {
      label: 'caller-only-confirm-off',
      message: 'Find the top 5 firms by rating and create one new spreadsheet.',
      confirmBeat: 'off',
      resolver: async () => ({
        candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
      }),
    },
    {
      label: 'preauthorized-no-binding',
      message: 'Go ahead and find the top 5 firms by rating and create one new spreadsheet.',
      confirmBeat: 'on',
      resolver: async () => ({
        candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
      }),
    },
  ] as const;
  for (const variant of variants) {
    process.env.CLEMMY_CONFIRM_BEAT = variant.confirmBeat;
    let runEntries = 0;
    let agentBuilds = 0;
    let builtBinding: unknown;
    _setBridgeImplsForTests({
      configure: okConfigure,
      resolveTurnCandidates: variant.resolver as never,
      buildAgent: (async (input: { turnCandidates?: { sourceStrategyBinding?: unknown } }) => {
        agentBuilds += 1;
        builtBinding = input.turnCandidates?.sourceStrategyBinding;
        return FAKE_AGENT;
      }) as never,
      runConversation: (async (options: {
        sessionId: string;
        sourceUserSeq?: number;
        buildAgent: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
      }) => {
        runEntries += 1;
        await options.buildAgent(stubBuildIdentity(options));
        return {
          sessionId: options.sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          publicPresentation: stubAnswerPresentation(options, `started ${variant.label}`),
        };
      }) as never,
    });
    const sessionId = `bridge-fresh-no-binding-${variant.label}`;
    const response = await respondViaHarness('home', {
      sessionId,
      message: variant.message,
      channel: 'desktop',
      turnCandidates: {
        candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
        sourceStrategyBinding: callerBinding,
      },
    }, { turnEngine: 'host_v1' });
    assert.equal(response.text, `started ${variant.label}`, variant.label);
    assert.equal(response.stoppedReason, 'success', variant.label);
    assert.equal(runEntries, 1, `${variant.label}: runner owns the accepted task`);
    assert.equal(agentBuilds, 1, `${variant.label}: agent/model surface is built`);
    assert.equal(builtBinding, undefined, `${variant.label}: no historical source authority reaches build`);
    const source = listEvents(sessionId, { types: ['user_input_received'] })[0]!;
    assert.equal(listEvents(sessionId, { types: ['turn_preflight_decision'] })
      .filter((row) => row.data.sourceUserSeq === source.seq).length, 0);
    assert.equal(listEvents(sessionId, { types: ['awaiting_user_input'] }).length, 0,
      `${variant.label}: no unrecoverable unbound A/Q edge`);
    assert.equal(peekTaskContinuityPacket({ sessionId }).status, 'none',
      `${variant.label}: no unbound continuity packet`);
    const db = openEventLog();
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
    `).get(sessionId, source.seq) as { n: number }).n, 0, `${variant.label}: no logical tool call`);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(sessionId, source.seq) as { n: number }).n, 0, `${variant.label}: no provider dispatch`);
    assert.ok(getLatestRunAttempt(sessionId)?.finishedAt);
  }
});

test('a resolver-returned fresh source binding is ignored without creating a checkpoint', async () => {
  const sessionId = 'bridge-fresh-source-marker-readback-corrupt';
  const binding = {
    version: 1,
    primary: { capabilityId: 'capability:composio:APIFY_EXACT_FRESH' },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'b'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  let runEntries = 0;
  let agentBuilds = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    resolveTurnCandidates: (async () => ({
        candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: true,
        sourceStrategyBinding: binding,
      })) as never,
    buildAgent: (async () => { agentBuilds += 1; return FAKE_AGENT; }) as never,
    runConversation: (async (options: {
      sessionId: string;
      sourceUserSeq?: number;
      buildAgent: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
    }) => {
      runEntries += 1;
      await options.buildAgent(stubBuildIdentity(options));
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        publicPresentation: stubAnswerPresentation(options, 'fresh task accepted'),
      };
    }) as never,
  });
  const response = await respondViaHarness('home', {
    sessionId,
    message: 'Find the top 5 firms and create one new spreadsheet.',
    channel: 'desktop',
  }, { turnEngine: 'host_v1' });
  assert.equal(response.text, 'fresh task accepted');
  assert.equal(runEntries, 1);
  assert.equal(agentBuilds, 1);
  const source = listEvents(sessionId, { types: ['user_input_received'] })[0]!;
  assert.equal(listEvents(sessionId, { types: ['turn_preflight_decision'] })
    .filter((row) => row.data.sourceUserSeq === source.seq).length, 0);
  assert.equal(getLatestRunAttempt(sessionId)?.status, 'completed');
  assert.ok(getLatestRunAttempt(sessionId)?.finishedAt);
});

test('production host_v1 owns fresh chat at the bridge before legacy semantics or SDK execution', async () => {
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  const sessionId = 'bridge-production-host-engine-entry';
  let selectedEngine: string | undefined;
  let legacyCalls = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: (async () => FAKE_AGENT) as never,
    runConversation: (async (options: {
      sessionId: string;
      sourceUserSeq?: number;
      turnEngine?: string;
      buildAgent?: (identity: { sessionId: string; sourceUserSeq: number; route?: string }) => Promise<unknown>;
    }) => {
      selectedEngine = options.turnEngine;
      await options.buildAgent?.({
        sessionId: options.sessionId,
        sourceUserSeq: Number(options.sourceUserSeq),
      });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        publicPresentation: stubAnswerPresentation(options, 'PRODUCTION HOST READY'),
      };
    }) as never,
  });

  const response = await respondPreferHarness('home', {
    sessionId,
    message: 'Reply with exactly: PRODUCTION HOST READY',
  }, async () => {
    legacyCalls += 1;
    throw new Error('legacy response path must be unreachable');
  });

  assert.equal(response.text, 'PRODUCTION HOST READY');
  assert.equal(selectedEngine, 'host_v1');
  assert.equal(legacyCalls, 0);
  assert.equal(listEvents(sessionId, { types: ['turn_graph_shadow'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['accepted_task_authority_armed'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['turn_semantics_interpreted'] }).length, 0);
});

test('explicit completed-answer replay is provider-neutral, zero-model, typed, and idempotent', async () => {
  const providers = [
    { label: 'claude', authMode: 'claude_oauth', claudeSdk: 'on', routingMode: 'balanced' },
    { label: 'codex', authMode: 'codex_oauth', claudeSdk: 'off', routingMode: 'balanced' },
    { label: 'byo', authMode: 'api_key', claudeSdk: 'off', routingMode: 'all_in' },
  ] as const;

  for (const provider of providers) {
    process.env.AUTH_MODE = provider.authMode;
    process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = provider.claudeSdk;
    process.env.MODEL_ROUTING_MODE = provider.routingMode;
    const sessionId = `completed-answer-replay-${provider.label}`;
    const seeded = seedCompletedAnswerReplay({
      sessionId,
      priorText: `${provider.label}: the exact task is complete.`,
    });
    let configureCalls = 0;
    let buildCalls = 0;
    let runCalls = 0;
    let claudeCalls = 0;
    let legacyCalls = 0;
    _setBridgeImplsForTests({
      configure: (async () => { configureCalls += 1; return { ok: true }; }) as never,
      buildAgent: (async () => { buildCalls += 1; return FAKE_AGENT; }) as never,
      runConversation: (async () => { runCalls += 1; throw new Error('model lane must not run'); }) as never,
      claudeAgentBrain: (async () => { claudeCalls += 1; throw new Error('Claude must not run'); }) as never,
      completedAnswerReplayProtection: () => [],
    });
    const request = {
      message: 'Repeat the last answer.',
      sessionId,
      sourceUserSeq: seeded.current.seq,
      runId: seeded.currentAttempt.runId ?? undefined,
    };
    const first = await respondPreferHarness('home', request, async (req) => {
      legacyCalls += 1;
      return { text: 'legacy', sessionId: req.sessionId };
    });
    const second = await respondPreferHarness('home', request, async (req) => {
      legacyCalls += 1;
      return { text: 'legacy', sessionId: req.sessionId };
    });

    assert.equal(first.text, `${provider.label}: the exact task is complete.`);
    assert.equal(second.text, first.text, `${provider.label}: transport retry replays the same winner`);
    assert.equal(first.stoppedReason, 'success');
    assert.equal(first.turnsUsed, 0);
    assert.equal(first.route?.transport, 'completed_answer_replay');
    assert.equal(first.route?.provider, undefined);
    assert.equal(first.route?.effectiveModel, undefined);
    assert.equal(second.route?.transport, 'completed_answer_replay');
    assert.deepEqual(
      { configureCalls, buildCalls, runCalls, claudeCalls, legacyCalls },
      { configureCalls: 0, buildCalls: 0, runCalls: 0, claudeCalls: 0, legacyCalls: 0 },
      `${provider.label}: no runtime, brain, or legacy work ran`,
    );

    const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 2, `${provider.label}: prior + current typed terminals only`);
    const currentTerminal = terminals.find((event) => event.data.sourceUserSeq === seeded.current.seq);
    assert.ok(currentTerminal);
    const presentation = currentTerminal.data.presentation as {
      identity?: { sourceUserSeq?: number };
      status?: string;
      kind?: string;
      resumable?: boolean;
    };
    assert.equal(presentation.identity?.sourceUserSeq, seeded.current.seq);
    assert.equal(presentation.status, 'done');
    assert.equal(presentation.kind, 'answer');
    assert.equal(presentation.resumable, false);
    assert.equal(currentTerminal.data.transport, 'completed_answer_replay');
    assert.equal(currentTerminal.data.steps, 0);
    assert.equal(currentTerminal.data.replayedFromSourceUserSeq, seeded.prior.seq);
    assert.equal(typeof currentTerminal.data.replayedFromTerminalId, 'string');
    assert.equal(typeof currentTerminal.data.replayedFromPresentationId, 'string');
    assert.equal(listEvents(sessionId, { types: ['turn_model_routed'] }).length, 0);
    assert.equal(listEvents(sessionId, { types: ['tool_called', 'tool_returned'] }).length, 0);
    assert.equal(getLatestRunAttempt(sessionId)?.status, 'completed');
    assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
  }
});

test('exact bridge replay treats legacy and corrupt terminal claims as blocked authority with zero runtime work', async (t) => {
  for (const terminalKind of ['legacy', 'corrupt'] as const) {
    await t.test(terminalKind, async () => {
      const sessionId = `bridge-unverifiable-terminal-${terminalKind}`;
      createSession({ id: sessionId, kind: 'chat' });
      const attempt = beginRunAttempt(sessionId, { runId: `${sessionId}:run` });
      const source = recordRunAttemptUserInput(attempt, {
        turn: 1,
        role: 'user',
        data: { text: 'Run this accepted request exactly once.' },
      }, { armRunInFlight: true });
      const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
      const data = terminalKind === 'legacy'
        ? {
            terminalKey: `turn:${source.seq}`,
            sourceUserSeq: source.seq,
            reply: 'A pre-upgrade terminal already exists.',
            summary: 'A pre-upgrade terminal already exists.',
            reason: 'success',
            delivered: true,
          }
        : {
            terminalKey: `turn:${source.seq}`,
            sourceUserSeq: source.seq,
            presentation: { identity },
          };
      openEventLog().prepare(`
        INSERT INTO events
          (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
        VALUES (?, ?, ?, 'system', 'conversation_completed', ?, ?, ?)
      `).run(
        `${sessionId}:terminal`,
        sessionId,
        source.turn,
        source.id,
        JSON.stringify(data),
        new Date().toISOString(),
      );

      let configureCalls = 0;
      let buildCalls = 0;
      let runCalls = 0;
      let claudeCalls = 0;
      let legacyCalls = 0;
      _setBridgeImplsForTests({
        configure: (async () => { configureCalls += 1; return { ok: true }; }) as never,
        buildAgent: (async () => { buildCalls += 1; return FAKE_AGENT; }) as never,
        runConversation: (async () => { runCalls += 1; throw new Error('model lane must not run'); }) as never,
        claudeAgentBrain: (async () => { claudeCalls += 1; throw new Error('Claude lane must not run'); }) as never,
      });

      const response = await respondPreferHarness('home', {
        message: 'Run this accepted request exactly once.',
        sessionId,
        sourceUserSeq: source.seq,
        runId: attempt.runId ?? undefined,
      }, async (request) => {
        legacyCalls += 1;
        return { text: 'legacy runtime', sessionId: request.sessionId };
      });

      assert.equal(response.stoppedReason, 'blocked', JSON.stringify(response));
      assert.match(response.text, /cannot verify safely/i);
      assert.deepEqual(
        { configureCalls, buildCalls, runCalls, claudeCalls, legacyCalls },
        { configureCalls: 0, buildCalls: 0, runCalls: 0, claudeCalls: 0, legacyCalls: 0 },
      );
      assert.ok(getLatestRunAttempt(sessionId)?.finishedAt, 'the exact replay settles its physical request attempt');
      assert.equal(
        HarnessSession.load(sessionId)?.runInFlightSince(),
        null,
        'the exact terminal replay clears only its own restart marker',
      );
      assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
      assert.equal(listEvents(sessionId, { types: ['tool_called', 'tool_returned'] }).length, 0);
    });
  }
});

test('completed-answer replay declines unfinished, substantive, blocked, and unreadable cases', async () => {
  const cases = [
    { label: 'prior-needs-continue', priorStatus: 'continue' as const, answerRequest: 'Repeat the last answer.', protection: () => [] },
    { label: 'substantive-repeat', priorStatus: 'done' as const, answerRequest: 'Repeat the last answer and refresh it.', protection: () => [] },
    { label: 'durable-blocker', priorStatus: 'done' as const, answerRequest: 'Repeat the last answer.', protection: () => ['approval'] },
    { label: 'unreadable', priorStatus: 'done' as const, answerRequest: 'Repeat the last answer.', protection: () => { throw new Error('ledger unreadable'); } },
  ];

  for (const item of cases) {
    const sessionId = `completed-answer-replay-decline-${item.label}`;
    const seeded = seedCompletedAnswerReplay({
      sessionId,
      answerRequest: item.answerRequest,
      priorStatus: item.priorStatus,
    });
    let configureCalls = 0;
    _setBridgeImplsForTests({
      configure: (async () => { configureCalls += 1; return { ok: false, reason: 'test normal route' }; }) as never,
      completedAnswerReplayProtection: item.protection,
    });
    const response = await respondPreferHarness('home', {
      message: item.answerRequest,
      sessionId,
      sourceUserSeq: seeded.current.seq,
      runId: seeded.currentAttempt.runId ?? undefined,
    }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

    assert.equal(configureCalls, 1, `${item.label}: ordinary preflight ran`);
    assert.notEqual(response.route?.transport, 'completed_answer_replay');
    assert.notEqual(response.text, 'The workspace inspection is complete.');
    const currentTerminal = listEvents(sessionId, { types: ['conversation_completed'] })
      .find((event) => event.data.sourceUserSeq === seeded.current.seq);
    assert.equal((currentTerminal?.data.presentation as { status?: string } | undefined)?.status, 'blocked');
  }
});

test('Continue, Resume, and Keep going after a completed answer reach ordinary brain reasoning', async () => {
  for (const [index, message] of ['Continue.', 'Resume!', 'Keep going!'].entries()) {
    const sessionId = `conversational-continuation-${index}`;
    const seeded = seedCompletedAnswerReplay({ sessionId, answerRequest: message });
    const brainReply = `The brain handled ${message} as a new conversational turn.`;
    let runCalls = 0;
    let replayProtectionCalls = 0;
    _setBridgeImplsForTests({
      configure: okConfigure,
      buildAgent: fakeAgentBuilder,
      runConversation: (async (opts: {
        sessionId: string;
        sourceUserSeq?: number;
        buildAgent?: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
      }) => {
        runCalls += 1;
        await opts.buildAgent?.(stubBuildIdentity(opts));
        return {
          sessionId: opts.sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 2,
          lastDecision: {
            summary: 'ordinary brain continuation',
            reply: brainReply,
            done: true,
            nextAction: 'completed',
          },
        };
      }) as never,
      completedAnswerReplayProtection: () => {
        replayProtectionCalls += 1;
        return [];
      },
    });

    const response = await respondPreferHarness('home', {
      message,
      sessionId,
      sourceUserSeq: seeded.current.seq,
      runId: seeded.currentAttempt.runId ?? undefined,
    }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

    assert.equal(runCalls, 1, `${message}: ordinary brain ran once`);
    assert.equal(replayProtectionCalls, 0, `${message}: answer-replay audit stayed off the hot path`);
    assert.equal(response.text, brainReply, `${message}: the new brain reply was preserved`);
    assert.equal(response.route?.transport, 'host_harness');
  }
});

test('respondPreferHarness: dashboard rides the gated harness loop by DEFAULT (architect conversion baked in)', async () => {
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  await respondPreferHarness(
    'dashboard',
    { message: 'draft a workflow', sessionId: 'arch-baked', excludeToolNames: ['workflow_create', 'workflow_run'] },
    async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalled, 0, 'default-ON → gated harness loop, not legacy');
});

test('home + dashboard ride the gated loop by default; the chat kill-switch blocks without legacy re-entry', async () => {
  assert.equal(harnessSurfaceEnabled('dashboard'), true, 'architect drafting surface ON');
  assert.equal(harnessSurfaceEnabled('home'), true, 'home chat surface ON');
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  await respondPreferHarness('home', { message: 'hi', sessionId: 'home-baked' }, async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; });
  assert.equal(legacyCalled, 0, 'home default-ON → gated harness loop');
  // The old automatic revert is gone: disabled harness lanes block by default
  // instead of silently bypassing the gates through assistant.respond().
  process.env.CLEMMY_HARNESS_HOME = 'off';
  try {
    const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'home-killed' }, async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; });
    assert.equal(legacyCalled, 0, 'kill-switch blocks by default');
    assert.equal(res.stoppedReason, 'blocked');
    assert.match(res.text, /runtime lane is temporarily unavailable/i);
    const terminals = listEvents('home-killed', { types: ['conversation_completed'] });
    assert.equal(terminals.length, 1, 'exactly one durable terminal');
    assert.equal((terminals[0]?.data.presentation as { status?: string })?.status, 'blocked');
    assert.equal((res.raw as { terminalCommitted?: boolean })?.terminalCommitted, true);
    assert.equal(HarnessSession.load('home-killed')?.runInFlightSince(), null, 'in-flight marker cleared after commit');
  } finally {
    delete process.env.CLEMMY_HARNESS_HOME;
  }
});

test('workflow surface: default ON + honorModel forwards step.model on the gated loop', async () => {
  assert.equal(harnessSurfaceEnabled('workflow'), true, 'workflow surface default ON');
  // The worker model is forwarded to the agent builder (so a converted forEach
  // step keeps its cheaper model). Other surfaces ignore model.
  let capturedModel: string | undefined;
  const recordingBuilder = (async (opts: { model?: string }) => { capturedModel = opts.model; return FAKE_AGENT; }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: fakeRun({ status: 'completed' }) });
  await respondPreferHarness('workflow', { message: 'step', sessionId: 'wf-1', model: 'gpt-5.4-mini' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  assert.equal(capturedModel, 'gpt-5.4-mini', 'honorModel surface forwards step.model');
});

test('execution lanes are admitted to schema-on-demand, with both kill-switches honored', async () => {
  let capturedJit: boolean | undefined;
  const recordingBuilder = (async (opts: { allowToolJit?: boolean }) => { capturedJit = opts.allowToolJit; return FAKE_AGENT; }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: fakeRun({ status: 'completed' }) });
  const priorExec = process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
  const priorGlobal = process.env.CLEMMY_CODEX_TOOL_SEARCH;
  try {
    // Default: cron (execution kind) rides the deferred tool-search surface.
    delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    await respondPreferHarness('cron', { message: 'job', sessionId: 'cron-jit-1' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
    assert.equal(capturedJit, true, 'execution lane admitted by default');

    // Execution kill-switch: cron falls back to the full first-class surface.
    process.env.CLEMMY_EXECUTION_TOOL_SEARCH = 'off';
    await respondPreferHarness('cron', { message: 'job', sessionId: 'cron-jit-2' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
    assert.equal(capturedJit, false, 'execution kill-switch restores the full surface');

    // Global tool-search off: execution must NOT be admitted (no catalog
    // recovery ⇒ the legacy JIT pruner must never run unattended).
    delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    process.env.CLEMMY_CODEX_TOOL_SEARCH = 'off';
    await respondPreferHarness('cron', { message: 'job', sessionId: 'cron-jit-3' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
    assert.equal(capturedJit, false, 'no global catalog ⇒ full surface on execution lanes');

    // Chat lanes are admitted regardless of the execution flag.
    process.env.CLEMMY_EXECUTION_TOOL_SEARCH = 'off';
    delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    await respondPreferHarness('dashboard', { message: 'hi', sessionId: 'chat-jit-1' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
    assert.equal(capturedJit, true, 'chat admission is independent of the execution flag');
  } finally {
    if (priorExec === undefined) delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    else process.env.CLEMMY_EXECUTION_TOOL_SEARCH = priorExec;
    if (priorGlobal === undefined) delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    else process.env.CLEMMY_CODEX_TOOL_SEARCH = priorGlobal;
  }
});

test('non-honorModel surface ignores request.model (cron/gateway byte-identical)', async () => {
  let capturedModel: string | undefined = 'unset';
  const recordingBuilder = (async (opts: { model?: string }) => { capturedModel = opts.model; return FAKE_AGENT; }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: fakeRun({ status: 'completed' }) });
  await respondPreferHarness('cron', { message: 'job', sessionId: 'cron-1', model: 'gpt-5.4-deep' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  assert.equal(capturedModel, undefined, 'cron does NOT forward model — harness keeps its configured model');
});

test('structured no-tool completion opt-in requires explicit empty tool authority', async () => {
  const forwarded: boolean[] = [];
  const recordingRun = (async (opts: {
    sessionId: string;
    acceptStructuredNoToolResult?: boolean;
  }) => {
    forwarded.push(opts.acceptStructuredNoToolResult === true);
    return {
      sessionId: opts.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: 1,
      lastDecision: {
        summary: 'ok',
        reply: 'ok',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    };
  }) as never;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: recordingRun,
  });

  await respondViaHarness('cron', {
    message: 'closed decision',
    sessionId: 'structured-empty-authority',
    allowedToolNames: [],
    acceptStructuredNoToolResult: true,
  });
  await respondViaHarness('cron', {
    message: 'undefined authority',
    sessionId: 'structured-undefined-authority',
    acceptStructuredNoToolResult: true,
  });
  await respondViaHarness('cron', {
    message: 'nonempty authority',
    sessionId: 'structured-nonempty-authority',
    allowedToolNames: ['memory_status'],
    acceptStructuredNoToolResult: true,
  });
  await respondViaHarness('cron', {
    message: 'flag absent',
    sessionId: 'structured-flag-absent',
    allowedToolNames: [],
  });

  assert.deepEqual(
    forwarded,
    [true, false, false, false],
    'only flag=true plus an explicitly empty allowlist can suppress zero-tool stall recovery',
  );
});

test('a typed blocked terminal remains blocked when the executor returned normally', async () => {
  const sessionId = 'typed-blocked-terminal-through-bridge';
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string; sourceUserSeq?: number }) => ({
      sessionId: opts.sessionId,
      status: 'completed',
      steps: 2,
      lastTurn: 1,
      lastDecision: {
        summary: 'executor returned after a bounded host stop',
        reply: 'I hit the same internal wall twice.',
        done: true,
        nextAction: 'completed',
        reason: null,
      },
      publicPresentation: {
        version: 1,
        id: `turn:${opts.sourceUserSeq}:presentation`,
        outcomeId: `turn:${opts.sourceUserSeq}`,
        audience: 'user',
        phase: 'final',
        identity: {
          sessionId: opts.sessionId,
          turn: 1,
          sourceUserSeq: opts.sourceUserSeq!,
        },
        status: 'blocked',
        kind: 'blocked',
        text: 'The host stopped after bounded recovery made no progress.',
        resumable: false,
      },
    })) as never,
  });

  const response = await respondViaHarness('background', {
    message: 'Run the exact workflow.',
    sessionId,
  });

  assert.equal(response.stoppedReason, 'blocked');
  assert.equal(response.text, 'The host stopped after bounded recovery made no progress.');
});

test('only the machine-typed terminal readback failure maps to unverified', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string; sourceUserSeq?: number }) => {
      const source = listEvents(opts.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === opts.sourceUserSeq)!;
      const identity = { sessionId: opts.sessionId, turn: source.turn, sourceUserSeq: source.seq };
      const committed = commitTurnOutcome({
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'blocked',
        resumable: false,
        presentation: {
          kind: 'blocked',
          text: 'The effect settled, but its authoritative readback is unavailable.',
        },
      }, {
        legacyReason: 'verification_required',
        metadata: { blockedReason: 'authoritative_terminal_verification_incomplete' },
      });
      return {
        sessionId: opts.sessionId,
        status: 'blocked',
        steps: 1,
        lastTurn: source.turn,
        blockedReason: 'authoritative_terminal_verification_incomplete',
        publicPresentation: committed.presentation,
      };
    }) as never,
  });
  const readbackOnly = await respondViaHarness('background', {
    message: 'Create the requested draft.',
    sessionId: 'typed-readback-only-through-bridge',
  });
  assert.equal(readbackOnly.stoppedReason, 'unverified');

  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({
      status: 'blocked',
      error: 'Required work remains blocked.',
      blockedReason: 'control_no_progress_exhausted',
    }),
  });
  const realBlock = await respondViaHarness('background', {
    message: 'Create the requested draft.',
    sessionId: 'typed-real-block-through-bridge',
  });
  assert.equal(realBlock.stoppedReason, 'blocked');
});

test('an exact replay preserves the machine-typed readback-only terminal', async () => {
  const sessionId = 'typed-readback-only-terminal-replay';
  createSession({ id: sessionId, kind: 'chat' });
  const attempt = beginRunAttempt(sessionId, { runId: `${sessionId}:run` });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Create the requested draft.' },
  }, { armRunInFlight: true });
  const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: false,
    presentation: {
      kind: 'blocked',
      text: 'The draft settled, but its authoritative readback is unavailable.',
    },
  }, {
    legacyReason: 'verification_required',
    metadata: { blockedReason: 'authoritative_terminal_verification_incomplete' },
  });
  finishRunAttempt(attempt, 'completed');
  _setBridgeImplsForTests({
    configure: (async () => { throw new Error('a terminal replay must not configure'); }) as never,
    buildAgent: (async () => { throw new Error('a terminal replay must not build'); }) as never,
    runConversation: (async () => { throw new Error('a terminal replay must not run'); }) as never,
  });

  const replay = await respondPreferHarness('home', {
    message: 'Create the requested draft.',
    sessionId,
    sourceUserSeq: source.seq,
    runId: attempt.runId ?? undefined,
  }, async () => { throw new Error('a terminal replay must not enter legacy'); });
  assert.equal(replay.stoppedReason, 'unverified');
  assert.match(replay.text, /authoritative readback is unavailable/i);
});

test('exact-source model directive binds a new attempt without a synthetic user event', async () => {
  const sessionId = 'exact-source-private-directive';
  createSession({ id: sessionId, kind: 'chat' });
  const accepted = appendEvent({
    sessionId,
    turn: 7,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Yes, approve that exact action.', approvalId: 'apr-7', decision: 'approve' },
  });
  let receivedInput = '';
  let receivedSource: number | undefined;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (options: { input: string; sourceUserSeq?: number; sessionId: string }) => {
      receivedInput = options.input;
      receivedSource = options.sourceUserSeq;
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 7,
        lastDecision: {
          summary: 'approved action completed',
          reply: 'The approved action completed.',
          done: true,
          nextAction: 'completed',
          reason: null,
        },
        publicPresentation: {
          version: 1,
          id: `turn:${accepted.seq}:presentation`,
          outcomeId: `turn:${accepted.seq}`,
          audience: 'user',
          phase: 'final',
          identity: { sessionId, turn: accepted.turn, sourceUserSeq: accepted.seq },
          status: 'done',
          kind: 'answer',
          text: 'The approved action completed.',
          resumable: false,
        },
      };
    }) as never,
  });

  await respondViaHarness('home', {
    sessionId,
    message: '[approval-resume] Execute the already-approved exact payload.',
    displayMessage: 'Yes, approve that exact action.',
    sourceUserSeq: accepted.seq,
  });

  assert.match(receivedInput, /^\[approval-resume\]/);
  assert.equal(receivedSource, accepted.seq);
  const inputs = listEvents(sessionId, { types: ['user_input_received'] });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].data.text, 'Yes, approve that exact action.');
  const graphs = listEvents(sessionId, { types: ['turn_graph_compiled'] });
  assert.equal(graphs.length, 1, 'the bridge observes the exact accepted source once');
  assert.equal(graphs[0].parentEventId, accepted.id);
  assert.equal(graphs[0].data.sourceUserSeq, accepted.seq);
  assert.equal((graphs[0].data.graph as { source?: { surface?: unknown } }).source?.surface, 'home');
  assert.equal(
    JSON.stringify(graphs[0].data).includes('[approval-resume]'),
    false,
    'the private model directive cannot replace the accepted display turn in graph telemetry',
  );
});

test('respondPreferHarness: a disabled lane stays under one owner even when the retired legacy flag is set', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  let legacyCalled = 0;
  const res = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-t1' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 0);
  assert.equal(res.stoppedReason, 'blocked');
  assert.match(res.text, /runtime lane is temporarily unavailable/i);
  assert.equal(listEvents('bridge-t1', { types: ['conversation_completed'] }).length, 1);
  assert.equal((res.raw as { terminalCommitted?: boolean })?.terminalCommitted, true);
  assert.equal(HarnessSession.load('bridge-t1')?.runInFlightSince(), null);

  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  const stillBlocked = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-t1-legacy' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 0, 'the retired environment flag cannot transfer execution ownership');
  assert.equal(stillBlocked.stoppedReason, 'blocked');
  assert.match(stillBlocked.text, /runtime lane is temporarily unavailable/i);
  assert.equal(listEvents('bridge-t1-legacy', { types: ['conversation_completed'] }).length, 1);
});

test('respondPreferHarness: preflight blocks are recorded in harness capability health', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  const publicEvents: Array<{ event: { type: string; data: Record<string, unknown> } }> = [];
  const detach = actionBus.subscribe((event) => {
    if (event.kind === 'harness.public_event'
      && event.sessionId === 'bridge-health-block'
      && event.event.type === 'conversation_completed') {
      publicEvents.push(event);
    }
  });
  let res;
  try {
    res = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-health-block' }, async (req) => ({
      text: 'legacy',
      sessionId: req.sessionId,
    }));
  } finally {
    detach();
  }

  assert.equal(res.stoppedReason, 'blocked');
  const rec = capabilityHealth.readHarnessCapabilityHealth('respond_bridge_surface_disabled');
  assert.ok(rec, 'preflight block is persisted for harness_status/model context');
  assert.equal(rec.state, 'unavailable');
  assert.equal(rec.sessionId, 'bridge-health-block');
  assert.equal(rec.reason, 'cron: surface_disabled');
  assert.equal(rec.details?.surface, 'cron');
  assert.equal(rec.details?.reason, 'surface_disabled');

  const completions = listEvents('bridge-health-block', { types: ['conversation_completed'] });
  assert.equal(completions.length, 1, 'a blocked preflight has one durable terminal');
  assert.equal((completions[0].data.presentation as { audience?: string }).audience, 'user');
  assert.equal((completions[0].data.presentation as { status?: string }).status, 'blocked');
  assert.equal((completions[0].data.presentation as { kind?: string }).kind, 'blocked');
  assert.equal(publicEvents.length, 1, 'the durable terminal publishes one public event');
  assert.equal(publicEvents[0].event.type, 'conversation_completed');
  assert.equal(
    (publicEvents[0].event.data.presentation as { status?: string }).status,
    'blocked',
  );
  assert.equal((res.raw as { terminalCommitted?: boolean })?.terminalCommitted, true);
  assert.equal(HarnessSession.load('bridge-health-block')?.runInFlightSince(), null);
});

test('preflight terminal write failure returns only stable failure and preserves restart ownership', async () => {
  process.env.CLEMMY_HARNESS_HOME = 'off';
  _setBridgeImplsForTests({
    commitTurnOutcome: (() => { throw new Error('forced sqlite terminal failure'); }) as never,
  });

  const result = await respondPreferHarness(
    'home',
    { message: 'Please finish this.', sessionId: 'preflight-terminal-write-failure' },
    async (request) => ({ text: 'legacy', sessionId: request.sessionId }),
  );

  assert.equal(result.stoppedReason, 'error');
  assert.equal(result.text, PUBLIC_RUN_FAILURE_TEXT);
  assert.doesNotMatch(result.text, /temporarily unavailable|sqlite/i);
  assert.equal(
    listEvents(result.sessionId, { types: ['conversation_completed'] }).length,
    0,
    'the proposed preflight block never escapes as a live-only terminal',
  );
  assert.equal(listEvents(result.sessionId, { types: ['user_input_received'] }).length, 1);
  assert.notEqual(
    HarnessSession.load(result.sessionId)?.runInFlightSince(),
    null,
    'the exact accepted source remains restart-recoverable after commit failure',
  );
  assert.equal((result.raw as { terminalCommitted?: boolean }).terminalCommitted, false);
});

test('respondPreferHarness: harness-FILTERABLE excludeToolNames ride the gated loop (exclusion passed to the builder)', async () => {
  // The FORK-collapse capability: callers excluding only harness tools (architect
  // workflow_*, autonomy composio_execute_tool+workflow_*) now run on the gated
  // harness loop instead of the legacy ungated core, with the exclusion enforced.
  let captured: string[] | undefined;
  const recordingBuilder = (async (opts: { excludeToolNames?: string[] }) => { captured = opts.excludeToolNames; return FAKE_AGENT; }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  await respondPreferHarness(
    'cron',
    { message: 'hi', sessionId: 'bridge-excl-ok', excludeToolNames: ['composio_execute_tool', 'workflow_run'] },
    async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalled, 0, 'harness-filterable excludes ride the loop, not legacy');
  assert.deepEqual(captured, ['composio_execute_tool', 'workflow_run'], 'exclusion forwarded to the agent builder');
});

test('respondPreferHarness: a NON-filterable exclude blocks by default — no silent surface widening or legacy bypass', async () => {
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: fakeRun({ status: 'completed' }) });
  let legacyCalled = 0;
  const res = await respondPreferHarness(
    'cron',
    { message: 'hi', sessionId: 'bridge-excl-ext', excludeToolNames: ['dataforseo__serp_organic_live_advanced'] },
    async (req) => { legacyCalled += 1; return { text: 'legacy', sessionId: req.sessionId }; },
  );
  assert.equal(legacyCalled, 0, 'the harness cannot enforce an external-MCP exclude → block before run');
  assert.equal(res.stoppedReason, 'blocked');
  assert.match(res.text, /requested tool boundary is not supported/i);
  assert.equal(listEvents('bridge-excl-ext', { types: ['conversation_completed'] }).length, 1);
  assert.equal((res.raw as { terminalCommitted?: boolean })?.terminalCommitted, true);
  assert.equal(HarnessSession.load('bridge-excl-ext')?.runInFlightSince(), null);
});

test('respondPreferHarness: harness auth unavailable blocks by default instead of falling back to legacy', async () => {
  _setBridgeImplsForTests({ configure: (async () => ({ ok: false, reason: 'no auth' })) as never });
  let legacyCalled = 0;
  const res = await respondPreferHarness('webhook', { message: 'hi', sessionId: 'bridge-t3' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 0);
  assert.equal(res.stoppedReason, 'blocked');
  assert.match(res.text, /no model runtime is connected/i);
  assert.doesNotMatch(res.text, /no auth/i, 'provider diagnostics stay out of public copy');
  assert.equal(listEvents('bridge-t3', { types: ['conversation_completed'] }).length, 1);
  assert.equal((res.raw as { terminalCommitted?: boolean })?.terminalCommitted, true);
  assert.equal(HarnessSession.load('bridge-t3')?.runInFlightSince(), null);
});

test('respondPreferHarness: Claude OAuth chat uses the shared host harness with the exact Claude provider/model', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let legacyCalled = 0;
  let runConversationCalled = 0;
  let claudeSdkBrainCalled = 0;
  const builderInputs: Array<{
    userInput?: string;
    sessionId?: string;
    sourceUserSeq?: number;
    acceptedRoute?: string;
    model?: string;
    allowToolJit?: boolean;
  }> = [];
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: (async (input: typeof builderInputs[number]) => {
      builderInputs.push(input);
      return FAKE_AGENT;
    }) as never,
    runConversation: (async (opts: {
      sessionId: string;
      input: string;
      sourceUserSeq?: number;
      buildAgent?: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
    }) => {
      runConversationCalled += 1;
      assert.equal(opts.input, 'hi', 'the unchanged user turn reaches the shared host runner');
      assert.equal(typeof opts.buildAgent, 'function', 'the host runner receives the capability-node builder');
      await opts.buildAgent!(stubBuildIdentity(opts));
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'shared Claude harness', done: true, nextAction: 'completed' },
      };
    }) as never,
    claudeAgentBrain: (async () => {
      claudeSdkBrainCalled += 1;
      throw new Error('standalone Claude brain must not serve interactive chat');
    }) as never,
  });

  const sessionId = 'claude-shared-host-route';
  const res = await respondPreferHarness('home', { message: 'hi', sessionId }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });

  assert.equal(res.text, 'shared Claude harness');
  assert.equal(legacyCalled, 0);
  assert.equal(claudeSdkBrainCalled, 0, 'interactive chat never enters respondViaClaudeAgentSdkBrain');
  assert.equal(runConversationCalled, 1, 'Claude uses the same runConversation/host runner path as Codex');
  assert.equal(builderInputs.length, 1, 'the shared host runner builds exactly one accepted-source agent');
  assert.equal(builderInputs[0]?.userInput, 'hi');
  assert.equal(builderInputs[0]?.sessionId, sessionId);
  assert.ok(Number(builderInputs[0]?.sourceUserSeq) > 0, 'the builder is bound to the accepted source');
  assert.equal(builderInputs[0]?.acceptedRoute, 'direct_reply');
  assert.equal(builderInputs[0]?.allowToolJit, true);
  assert.equal(builderInputs[0]?.model, undefined, 'interactive model selection remains router-owned');
  assert.deepEqual(res.route, {
    routeKind: 'harness',
    surface: 'home',
    effectiveModel: 'claude-sonnet-4-6',
    provider: 'claude',
    transport: 'host_harness',
    mode: 'off',
  });
  const routed = listEvents(sessionId, { types: ['turn_model_routed'] });
  assert.equal(routed.length, 1);
  assert.equal(routed[0]?.data.sourceUserSeq, builderInputs[0]?.sourceUserSeq);
  assert.deepEqual(
    {
      model: routed[0]?.data.model,
      provider: routed[0]?.data.provider,
      transport: routed[0]?.data.transport,
      routeKind: routed[0]?.data.routeKind,
    },
    {
      model: 'claude-sonnet-4-6',
      provider: 'claude',
      transport: 'host_harness',
      routeKind: 'harness',
    },
  );
});

test('respondPreferHarness: Codex OAuth chat keeps the same shared host route', async () => {
  process.env.AUTH_MODE = 'codex_oauth';
  process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.5';
  let legacyCalled = 0;
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      runConversationCalled += 1;
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'shared Codex harness', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'codex-shared-host-route' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });

  assert.equal(res.text, 'shared Codex harness');
  assert.equal(legacyCalled, 0);
  assert.equal(runConversationCalled, 1);
  assert.equal(res.route?.routeKind, 'harness');
  assert.equal(res.route?.effectiveModel, 'gpt-5.5');
  assert.equal(res.route?.provider, 'codex');
  assert.equal(res.route?.transport, 'host_harness');
});

test('respondPreferHarness: shared Claude host binds an exact compound decline without legacy graph entry', async (t) => {
  // Fresh production chat enters host_v1 before semantic graph compilation;
  // task-continuation authority still narrows private retrieval semantics to
  // the independent clause without reopening the legacy owner.
  const sessionId = 'claude-bridge-compound-decline';
  const fullMessage = 'No—leave that note alone. Instead, what is 15 × 9? Answer that naturally without tools.';
  const activeTaskInput = 'what is 15 × 9? Answer that naturally without tools.';
  // Keep a connected capability in the fixture to prove that a closed-world
  // fresh clause does not inherit the declined task's hosted-world authority.
  const composioClient = await import('../../integrations/composio/client.js');
  composioClient.__test__.setConnectedAccountsLoader(async () => [
    { id: 'ca_bridge_outlook', toolkit: { slug: 'outlook' }, status: 'ACTIVE' },
  ]);
  await composioClient.listUsableConnectedToolkits({ requireFresh: true });
  t.after(() => composioClient.__test__.setConnectedAccountsLoader(null));
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  const parent = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Update the local note.' },
  });
  appendEvent({
    sessionId,
    turn: 7,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: 'Should I update it?',
      options: ['Yes', 'No'],
      purpose: 'clarification',
      sourceUserSeq: parent.seq,
    },
  });
  const parentIdentity = { sessionId, turn: parent.turn, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: 'Should I update it?' },
  });

  const runId = 'run-claude-bridge-compound-decline';
  const attempt = beginRunAttempt(sessionId, { runId });
  const accepted = recordRunAttemptUserInput(attempt, {
    turn: 2,
    role: 'user',
    data: { text: fullMessage, runId },
  }, { armRunInFlight: true });

  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let builtAgentInput: {
    userInput?: string;
    sourceUserSeq?: number;
    taskContinuation?: {
      answer: string;
      disposition: string;
      activeTaskInput?: string;
      consumingSourceUserSeq: number;
    };
  } | undefined;
  let runInput = '';
  let semanticTaskInput = '';
  let sdkCalls = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: (async (options) => {
      builtAgentInput = options as typeof builtAgentInput;
      return FAKE_AGENT;
    }) as never,
    runConversation: (async (options: {
      sessionId: string;
      input: string;
      semanticTaskInput?: string;
      sourceUserSeq?: number;
      buildAgent: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
    }) => {
      runInput = options.input;
      semanticTaskInput = options.semanticTaskInput ?? '';
      await options.buildAgent(stubBuildIdentity(options));
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: '135', done: true, nextAction: 'completed' },
      };
    }) as never,
    claudeAgentBrain: (async () => { sdkCalls += 1; throw new Error('standalone chat lane must stay closed'); }) as never,
    allowStandaloneClaudeInteractiveBrainForTests: false,
  });

  const response = await respondPreferHarness('home', {
    message: fullMessage,
    sessionId,
    sourceUserSeq: accepted.seq,
    runId,
    channel: 'desktop',
  }, async () => {
    assert.fail('the exact Claude turn cannot fall through to legacy');
  });

  // The shared host sends the complete conversational correction while
  // binding task authority to only the fresh clause.
  assert.match(response.text, /135/);
  assert.equal(sdkCalls, 0);
  assert.equal(response.route?.transport, 'host_harness');
  assert.equal(response.route?.provider, 'claude');
  assert.equal(runInput, fullMessage, 'the provider input remains the user\'s full message');
  assert.equal(semanticTaskInput, activeTaskInput, 'Claude semantics use only the independent fresh task');
  assert.equal(builtAgentInput?.userInput, fullMessage);
  assert.equal(builtAgentInput?.sourceUserSeq, accepted.seq);
  assert.equal(builtAgentInput?.taskContinuation?.answer, fullMessage);
  assert.equal(builtAgentInput?.taskContinuation?.disposition, 'declined_with_new_task');
  assert.equal(builtAgentInput?.taskContinuation?.activeTaskInput, activeTaskInput);
  assert.equal(builtAgentInput?.taskContinuation?.consumingSourceUserSeq, accepted.seq);

  const acceptedAfter = listEvents(sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === accepted.seq);
  assert.equal(acceptedAfter?.id, accepted.id);
  assert.equal(acceptedAfter?.data.text, fullMessage);
  assert.equal(
    listEvents(sessionId, { types: ['turn_graph_compiled'] }).length,
    0,
    'fresh host chat cannot re-enter the legacy semantic graph owner',
  );
});

test('typed materially different source runs one fresh selector and returns a second unconfirmed checkpoint', async () => {
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  const sessionId = 'bridge-material-source-variant-recovery';
  const objective = 'Find the top 5 restaurants in Pismo Beach and create one new workbook.';
  const question = 'I will use the exact bound Apify source and create one new workbook. Use that source?';
  const answerText = 'Use the DataForSEO source instead.';
  const parentBinding = {
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_VARIANT_PARENT',
      schemaFingerprint: 'a'.repeat(64),
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'b'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;

  createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  const parent = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: parent.turn, sourceUserSeq: parent.seq },
    surface: 'home',
    acceptedText: objective,
  });
  const parentDecision = classifyTurnPreflight({
    message: objective,
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: parent.seq,
    sourceStrategyBinding: parentBinding,
  });
  assert.equal(parentDecision.sourceStrategyPosture, 'materially_variant');
  recordTurnPreflightDecision(sessionId, parentDecision, parent.seq);
  appendEvent({
    sessionId,
    turn: parent.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: parent.seq,
      intentKey: parentDecision.intentKey,
      confirmationDisposition: parentDecision.confirmationDisposition,
      sourceStrategyBinding: parentBinding,
    },
  });
  const parentIdentity = { sessionId, turn: parent.turn, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });

  const answerAttempt = beginRunAttempt(sessionId, { runId: 'variant-answer-run' });
  const answer = recordRunAttemptUserInput(answerAttempt, {
    turn: 2,
    role: 'user',
    data: { text: answerText },
  });
  recordTypedProvidedAnswer(answer);

  const replacementSlug = 'DATAFORSEO_VARIANT_REPLACEMENT';
  schemaCache.rememberToolSchema(replacementSlug, {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  }, Date.now());
  const replacementFingerprint = schemaCache.liveComposioSchemaFingerprint(replacementSlug);
  assert.ok(replacementFingerprint);
  const replacementDraft = {
    version: 1,
    primary: {
      capabilityId: `capability:composio:${replacementSlug}`,
      schemaFingerprint: replacementFingerprint!,
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: '0'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const replacementBinding = {
    ...replacementDraft,
    topologyDigest: sourceStrategyTopologyDigestFor(replacementDraft)!,
  };
  const replacementCandidate = {
    identifier: replacementSlug,
    kind: 'composio',
    intent: 'collect the requested records from the freshly selected source',
    klass: 'capability_only',
    via: 'exact' as const,
    score: 1,
    effectClass: 'read' as const,
    schemaFingerprint: replacementFingerprint!,
    schemaAuthority: 'live' as const,
    roleKey: 'clause-0:read',
    resolutionRoleKeys: ['clause-0:read'],
    verifiedReadOrigin: {
      version: 1 as const,
      sessionId: 'replacement-origin',
      sourceUserSeq: 1,
      receiptId: `rr_${'c'.repeat(32)}`,
      evidenceDigest: 'd'.repeat(24),
    },
    verifiedReadAliasSpecific: true as const,
    verifiedReadSchemaFingerprint: replacementFingerprint!,
    sourceStructurallyEligible: true as const,
  };

  let selectorCalls = 0;
  let buildCalls = 0;
  let runEntries = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    resolveTurnCandidates: (async ({ userInput }: { userInput: string }) => {
      selectorCalls += 1;
      assert.match(userInput, /Find the top 5 restaurants/);
      assert.match(userInput, /Use the DataForSEO source instead/);
      return {
        candidates: [replacementCandidate],
        requirements: [{
          roleKey: 'clause-0:read',
          clauseIndex: 0,
          text: 'collect the requested records',
          effect: 'read',
          resolved: true,
          resolvedCapabilities: [replacementCandidate],
        }],
        matches: [],
        pinnedTools: ['composio_execute_tool'],
        semanticApplied: true,
        sourceStrategyBinding: replacementBinding,
      };
    }) as never,
    buildAgent: (async () => {
      buildCalls += 1;
      throw new Error('Q2 must publish before the business model is built');
    }) as never,
    runConversation: (async (options: { sessionId: string; sourceUserSeq?: number }) => {
      runEntries += 1;
      const sourceUserSeq = Number(options.sourceUserSeq);
      const decisionRow = listEvents(sessionId, { types: ['turn_preflight_decision'] })
        .filter((row) => row.data.sourceUserSeq === sourceUserSeq);
      assert.equal(decisionRow.length, 1);
      const decision = decisionRow[0]!.data as never;
      const published = await publishPreflightConversation({
        identity: { sessionId, turn: answer.turn, sourceUserSeq },
        decision,
        conversationContext: '',
        memoryContext: '',
        capabilityContext: '',
        openness: null,
        port: {
          render: async () => 'Should I use the current replacement source for the same workbook task?',
        },
        transport: 'host_harness',
      });
      assert.equal(published.kind, 'ask');
      return {
        sessionId,
        status: 'awaiting_user_input',
        steps: 0,
        lastTurn: answer.turn,
        lastDecision: {
          summary: 'replacement source awaits confirmation',
          reply: published.presentation.text,
          done: false,
          nextAction: 'awaiting_user_input',
          reason: null,
        },
      };
    }) as never,
  });

  const response = await respondViaHarness('home', {
    sessionId,
    sourceUserSeq: answer.seq,
    runId: answerAttempt.runId ?? undefined,
    message: answerText,
    channel: 'desktop',
    turnCandidates: {
      candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
      sourceStrategyBinding: parentBinding,
    },
  }, {
    sourceUserSeq: answer.seq,
    turnEngine: 'host_v1',
  });

  assert.equal(selectorCalls, 1, 'the existing fresh selector runs exactly once after lineage proof');
  assert.equal(runEntries, 1);
  assert.equal(buildCalls, 0);
  assert.equal(response.stoppedReason, 'awaiting-input');
  assert.match(response.text, /replacement source/i);
  const childDecisions = listEvents(sessionId, { types: ['turn_preflight_decision'] })
    .filter((row) => row.data.sourceUserSeq === answer.seq);
  assert.equal(childDecisions.length, 1);
  assert.equal(childDecisions[0]!.data.phase, 'align');
  assert.equal(childDecisions[0]!.data.sourceStrategyPosture, 'materially_variant');
  assert.equal(childDecisions[0]!.data.confirmedIntentKey, undefined);
  assert.equal(
    (childDecisions[0]!.data.sourceStrategyBinding as { primary?: { capabilityId?: string } })
      .primary?.capabilityId,
    `capability:composio:${replacementSlug}`,
  );
  const childAwaiting = listEvents(sessionId, { types: ['awaiting_user_input'] })
    .filter((row) => row.data.sourceUserSeq === answer.seq);
  assert.equal(childAwaiting.length, 1);
  assert.match(String(childAwaiting[0]!.data.question), /replacement source/i);
  assert.equal(peekTaskContinuityPacket({ sessionId }).status, 'available',
    'Q2 creates a fresh B-owned packet rather than opening the business gate');
  const db = openEventLog();
  for (const table of ['logical_tool_calls', 'physical_dispatches']) {
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM ${table}
       WHERE session_id = ? AND source_user_seq = ?
    `).get(sessionId, answer.seq) as { n: number }).n, 0, table);
  }

  const confirmationAttempt = beginRunAttempt(sessionId, { runId: 'variant-confirmation-run' });
  const confirmation = recordRunAttemptUserInput(confirmationAttempt, {
    turn: 3,
    role: 'user',
    data: { text: 'Yes' },
  });
  let confirmedRunEntries = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    resolveTurnCandidates: (async () => {
      selectorCalls += 1;
      throw new Error('Q2 confirmation must not run the material-variant selector again');
    }) as never,
    buildAgent: (async () => FAKE_AGENT) as never,
    runConversation: (async () => {
      confirmedRunEntries += 1;
      return {
        sessionId,
        status: 'completed',
        steps: 0,
        lastTurn: confirmation.turn,
        lastDecision: {
          summary: 'confirmed source is ready for the continuing task',
          reply: 'The replacement source is confirmed.',
          done: true,
          nextAction: null,
          reason: null,
        },
      };
    }) as never,
  });
  const confirmedResponse = await respondViaHarness('home', {
    sessionId,
    sourceUserSeq: confirmation.seq,
    runId: confirmationAttempt.runId ?? undefined,
    message: 'Yes',
    channel: 'desktop',
  }, {
    sourceUserSeq: confirmation.seq,
    turnEngine: 'host_v1',
  });
  assert.equal(confirmedResponse.text, 'The replacement source is confirmed.');
  assert.equal(confirmedRunEntries, 1);
  assert.equal(selectorCalls, 1, 'only B performs fresh material-variant selection');
  const confirmedDecisions = listEvents(sessionId, { types: ['turn_preflight_decision'] })
    .filter((row) => row.data.sourceUserSeq === confirmation.seq);
  assert.equal(confirmedDecisions.length, 1);
  assert.equal(confirmedDecisions[0]!.data.phase, 'execute');
  assert.equal(confirmedDecisions[0]!.data.sourceStrategyPosture, 'confirmed_exact');
  assert.equal(
    (confirmedDecisions[0]!.data.sourceStrategyBinding as { primary?: { capabilityId?: string } })
      .primary?.capabilityId,
    `capability:composio:${replacementSlug}`,
  );
  for (const table of ['logical_tool_calls', 'physical_dispatches']) {
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM ${table}
       WHERE session_id = ? AND source_user_seq = ?
    `).get(sessionId, confirmation.seq) as { n: number }).n, 0, table);
  }
});

test('stale exact source lineage blocks before selector, model, logical call, or crossing', async () => {
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  const sessionId = 'bridge-material-source-stale-before-selector';
  const objective = 'Find the top 5 restaurants and create one new workbook.';
  const question = 'Should I use the exact bound source for the collection?';
  const slug = 'SOURCE_SCHEMA_DRIFT_BEFORE_SELECTOR';
  schemaCache.rememberToolSchema(slug, {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  }, Date.now() - 1_000);
  const originalFingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
  assert.ok(originalFingerprint);
  const binding = {
    version: 1,
    primary: {
      capabilityId: `capability:composio:${slug}`,
      schemaFingerprint: originalFingerprint!,
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'e'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  const parent = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: parent.turn, sourceUserSeq: parent.seq },
    surface: 'home',
    acceptedText: objective,
  });
  const decision = classifyTurnPreflight({
    message: objective,
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: parent.seq,
    sourceStrategyBinding: binding,
  });
  assert.equal(decision.sourceStrategyPosture, 'materially_variant');
  recordTurnPreflightDecision(sessionId, decision, parent.seq);
  appendEvent({
    sessionId,
    turn: parent.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: parent.seq,
      intentKey: decision.intentKey,
      confirmationDisposition: decision.confirmationDisposition,
      sourceStrategyBinding: binding,
    },
  });
  const parentIdentity = { sessionId, turn: parent.turn, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
  assert.equal(peekTaskContinuityPacket({ sessionId }).status, 'available',
    'the stale-binding case begins from an exact durable A/Q packet');
  schemaCache.rememberToolSchema(slug, {
    type: 'object',
    properties: {
      query: { type: 'string' },
      locale: { type: 'string' },
    },
    required: ['query', 'locale'],
  }, Date.now());
  assert.notEqual(schemaCache.liveComposioSchemaFingerprint(slug), originalFingerprint);
  const answerAttempt = beginRunAttempt(sessionId, { runId: 'stale-source-answer-run' });
  const answer = recordRunAttemptUserInput(answerAttempt, {
    turn: 2,
    role: 'user',
    data: { text: 'Yes' },
  });
  let selectorCalls = 0;
  let buildCalls = 0;
  let runCalls = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    resolveTurnCandidates: (async () => {
      selectorCalls += 1;
      throw new Error('stale binding must stop before selector');
    }) as never,
    buildAgent: (async () => { buildCalls += 1; return FAKE_AGENT; }) as never,
    runConversation: (async () => { runCalls += 1; throw new Error('must not run'); }) as never,
  });
  const response = await respondViaHarness('home', {
    sessionId,
    sourceUserSeq: answer.seq,
    runId: answerAttempt.runId ?? undefined,
    message: 'Yes',
    channel: 'desktop',
    turnCandidates: {
      candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
      sourceStrategyBinding: binding,
    },
  }, { sourceUserSeq: answer.seq, turnEngine: 'host_v1' });
  assert.equal(response.stoppedReason, 'blocked');
  assert.equal(inspectDurableMaterialSourceContinuation({
    sessionId,
    sourceUserSeq: answer.seq,
  }).status, 'refused');
  assert.equal(selectorCalls, 0);
  assert.equal(buildCalls, 0);
  assert.equal(runCalls, 0);
  const child = listEvents(sessionId, { types: ['user_input_received'] })
    .find((row) => row.seq === answer.seq)!;
  const terminal = listEvents(sessionId, { types: ['conversation_completed'] }).find((row) =>
    (row.data.presentation as { identity?: { sourceUserSeq?: unknown } } | undefined)
      ?.identity?.sourceUserSeq === answer.seq);
  assert.equal((terminal?.data.presentation as { status?: unknown } | undefined)?.status, 'blocked');
  const db = openEventLog();
  for (const table of ['logical_tool_calls', 'physical_dispatches']) {
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS n FROM ${table}
       WHERE session_id = ? AND source_user_seq = ?
    `).get(sessionId, child.seq) as { n: number }).n, 0, table);
  }
});

test('source confirmation persists one lineage graph before shared execution and preserves the exact Apify binding', async () => {
  const sessionId = 'bridge-apify-source-confirmation-lineage';
  const objective = 'Find the top 5 restaurants in Pismo Beach by Google review count. Include each restaurant name, review count, and phone number, then create one new Google Sheet containing those 5 rows. Do not email or share it.';
  const answer = 'Use Apify as the restaurant source.';
  const question = 'I will run one Apify actor for the restaurant collection, then create one Google Sheet. Should I go ahead with that approach?';
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
      schemaFingerprint: createHash('sha256').update('apify-live-schema').digest('hex'),
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: createHash('sha256').update('pismo-apify-to-new-sheet').digest('hex'),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const bindingBytes = JSON.stringify(sourceStrategyBinding);

  createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  const parent = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: parent.turn, sourceUserSeq: parent.seq },
    surface: 'home',
    acceptedText: objective,
  });
  const align = classifyTurnPreflight({
    message: objective,
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: parent.seq,
    sourceStrategyBinding,
  });
  assert.equal(align.confirmationDisposition, 'material_source_strategy');
  recordTurnPreflightDecision(sessionId, align, parent.seq);
  appendEvent({
    sessionId,
    turn: parent.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: parent.seq,
      intentKey: align.intentKey,
      confirmationDisposition: align.confirmationDisposition,
      sourceStrategyBinding,
    },
  });
  const parentIdentity = { sessionId, turn: parent.turn, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });

  let continuationSourceUserSeq = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (options: {
      sessionId: string;
      sourceUserSeq?: number;
      taskContinuation?: import('../../types.js').TaskContinuationContext;
    }) => {
      continuationSourceUserSeq = options.sourceUserSeq ?? 0;
      assert.ok(options.taskContinuation, 'the exact accepted answer consumes the durable source question');
      const durableDecisions = listEvents(sessionId, { types: ['turn_preflight_decision'] })
        .filter((event) => event.data.sourceUserSeq === continuationSourceUserSeq);
      assert.equal(durableDecisions.length, 1,
        'the bridge records and reads back exactly one consuming decision before execution');
      assert.equal(JSON.stringify(durableDecisions[0]?.data.sourceStrategyBinding), bindingBytes,
        'only the durable A/Q/B inspector authors the consuming binding bytes');
      const source = listEvents(sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === continuationSourceUserSeq);
      assert.ok(source);
      const replay = await recordAcceptedSourceGraph({
        identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
        surface: 'direct',
        acceptedText: answer,
        verifiedTaskContinuation: options.taskContinuation,
      });
      assert.ok(replay, 'runConversation must reuse the bridge\'s lineage-bearing graph');
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: source.turn,
        lastDecision: { reply: 'The confirmed source is admitted.', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  const response = await respondViaHarness('home', {
    message: answer,
    sessionId,
    channel: 'desktop',
    turnCandidates: {
      candidates: [], requirements: [], matches: [], pinnedTools: ['composio_execute_tool'],
      semanticApplied: false,
      sourceStrategyBinding,
    },
  }, { turnEngine: 'host_v1' });
  assert.equal(response.text, 'The confirmed source is admitted.');
  assert.equal(response.stoppedReason, 'success');
  assert.notEqual(response.text, PUBLIC_RUN_FAILURE_TEXT, 'the continuation must not collapse into the bridge 500');

  const graphs = listEvents(sessionId, { types: ['turn_graph_compiled'] })
    .filter((event) => event.data.sourceUserSeq === continuationSourceUserSeq);
  assert.equal(graphs.length, 1, 'the accepted confirmation owns exactly one graph');
  const lineage = graphs[0]?.data.taskContinuationLineage as Record<string, unknown> | undefined;
  assert.ok(lineage, 'the first persisted graph carries durable A/Q/B lineage');
  assert.equal(lineage.parentSourceUserSeq, parent.seq);
  assert.equal(lineage.consumingSourceUserSeq, continuationSourceUserSeq);
  assert.equal(graphs[0]?.data.effectCeiling, 'external_write');
  const decisions = listEvents(sessionId, { types: ['turn_preflight_decision'] })
    .filter((event) => event.data.sourceUserSeq === continuationSourceUserSeq);
  assert.equal(decisions.length, 1);
  assert.equal(JSON.stringify(decisions[0]?.data.sourceStrategyBinding), bindingBytes);
});

test('reforged caller source binding blocks before the model and replays one cleared terminal', async () => {
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  const sessionId = 'bridge-reforged-material-source-binding';
  const objective = 'Find the top 5 restaurants in Pismo Beach and create one new Google Sheet.';
  const answer = 'Use Apify as the restaurant source.';
  const question = 'Use the exact bound Apify source before creating the sheet?';
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_EXACT_SOURCE',
      schemaFingerprint: 'a'.repeat(64),
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'b'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const forgedBinding = {
    ...sourceStrategyBinding,
    primary: {
      capabilityId: 'capability:composio:FOREIGN_SOURCE',
      schemaFingerprint: 'c'.repeat(64),
    },
  } as const;
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  const parent = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: objective },
  });
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: parent.turn, sourceUserSeq: parent.seq },
    surface: 'home',
    acceptedText: objective,
  });
  const align = classifyTurnPreflight({
    message: objective,
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: parent.seq,
    sourceStrategyBinding,
  });
  assert.equal(align.confirmationDisposition, 'material_source_strategy');
  recordTurnPreflightDecision(sessionId, align, parent.seq);
  appendEvent({
    sessionId,
    turn: parent.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: parent.seq,
      intentKey: align.intentKey,
      confirmationDisposition: align.confirmationDisposition,
      sourceStrategyBinding,
    },
  });
  const parentIdentity = { sessionId, turn: parent.turn, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      throw new Error('a reforged caller binding must block before model execution');
    }) as never,
  });
  const request = {
    message: answer,
    sessionId,
    channel: 'desktop',
    turnCandidates: {
      candidates: [], requirements: [], matches: [], pinnedTools: ['composio_execute_tool'],
      semanticApplied: false,
      sourceStrategyBinding: forgedBinding,
    },
  } as const;
  const response = await respondViaHarness('home', request, { turnEngine: 'host_v1' });
  assert.equal(response.stoppedReason, 'blocked');
  assert.match(response.text, /stopped before contacting a source/i);
  assert.equal(runConversationCalled, 0);
  const child = listEvents(sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq > parent.seq);
  assert.ok(child);
  assert.equal(listEvents(sessionId, { types: ['turn_preflight_decision'] })
    .filter((event) => event.data.sourceUserSeq === child!.seq).length, 0,
  'caller disagreement never authors a consuming decision');
  const terminals = listEvents(sessionId, { types: ['conversation_completed'] })
    .filter((event) => event.data.sourceUserSeq === child!.seq);
  assert.equal(terminals.length, 1);
  assert.equal((terminals[0]!.data.presentation as { status?: unknown }).status, 'blocked');
  const db = openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, child!.seq) as { n: number }).n, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, child!.seq) as { n: number }).n, 0);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
  const attempt = getLatestRunAttempt(sessionId);
  assert.ok(attempt?.finishedAt);
  assert.equal(attempt?.status, 'failed');

  const replay = await respondPreferHarness('home', {
    ...request,
    sourceUserSeq: child!.seq,
  }, async () => {
    assert.fail('the exact blocked terminal cannot fall through to legacy');
  });
  assert.equal(replay.text, response.text);
  assert.equal(replay.stoppedReason, 'blocked');
  assert.equal(runConversationCalled, 0);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] })
    .filter((event) => event.data.sourceUserSeq === child!.seq).length, 1);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
});

test('wrong-turn or mixed parent source decisions block before agent/model work or any crossing', async (t) => {
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_PARENT_TURN_AUTHORITY',
      accountIdentity: 'account:apify:parent-turn',
      schemaFingerprint: 'a'.repeat(64),
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'b'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;

  for (const variant of ['wrong_turn', 'mixed_turn'] as const) {
    await t.test(variant, async () => {
      const sessionId = `bridge-material-parent-${variant}`;
      const objective = 'Find the top 5 restaurants in Pismo Beach and create one new Google Sheet.';
      const answer = 'Use Apify as the restaurant source.';
      const question = 'Use the exact bound Apify source before creating the sheet?';
      createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
      const parent = appendEvent({
        sessionId,
        turn: 1,
        role: 'user',
        type: 'user_input_received',
        data: { text: objective },
      });
      await recordAcceptedSourceGraph({
        identity: { sessionId, turn: parent.turn, sourceUserSeq: parent.seq },
        surface: 'home',
        acceptedText: objective,
      });
      const align = classifyTurnPreflight({
        message: objective,
        sessionId,
        sessionKind: 'chat',
        sourceUserSeq: parent.seq,
        sourceStrategyBinding,
      });
      assert.equal(align.confirmationDisposition, 'material_source_strategy');
      if (variant === 'mixed_turn') recordTurnPreflightDecision(sessionId, align, parent.seq);
      appendEvent({
        sessionId,
        turn: parent.turn,
        role: 'system',
        type: 'turn_preflight_decision',
        data: { ...align, sourceUserSeq: parent.seq },
      });
      appendEvent({
        sessionId,
        turn: parent.turn,
        role: 'Clem',
        type: 'awaiting_user_input',
        data: {
          question,
          purpose: 'clarification',
          source: 'preflight_alignment',
          sourceUserSeq: parent.seq,
          intentKey: align.intentKey,
          confirmationDisposition: align.confirmationDisposition,
          sourceStrategyBinding,
        },
      });
      const parentIdentity = { sessionId, turn: parent.turn, sourceUserSeq: parent.seq };
      commitTurnOutcome({
        version: 2,
        id: turnOutcomeId(parentIdentity),
        identity: parentIdentity,
        status: 'needs_input',
        resumable: true,
        needs: { kind: 'input' },
        presentation: { kind: 'question', text: question },
      });

      let buildCalls = 0;
      let runCalls = 0;
      let selectorCalls = 0;
      _setBridgeImplsForTests({
        configure: okConfigure,
        resolveTurnCandidates: (async () => {
          selectorCalls += 1;
          throw new Error('invalid lineage must stop before selector/schema work');
        }) as never,
        buildAgent: (async () => {
          buildCalls += 1;
          return FAKE_AGENT;
        }) as never,
        runConversation: (async () => {
          runCalls += 1;
          throw new Error('invalid parent authority must stop before model work');
        }) as never,
      });
      const response = await respondViaHarness('home', {
        message: answer,
        sessionId,
        channel: 'desktop',
        turnCandidates: {
          candidates: [], requirements: [], matches: [], pinnedTools: ['composio_execute_tool'],
          semanticApplied: false,
          sourceStrategyBinding,
        },
      }, { turnEngine: 'host_v1' });
      assert.equal(response.stoppedReason, 'blocked', JSON.stringify(response));
      assert.equal(selectorCalls, 0, `${variant}: corrupt/ambiguous A/Q/B never enters the selector`);
      assert.equal(buildCalls, 0);
      assert.equal(runCalls, 0);
      const child = listEvents(sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq > parent.seq);
      assert.ok(child);
      const db = openEventLog();
      for (const table of ['logical_tool_calls', 'physical_dispatches']) {
        assert.equal((db.prepare(`
          SELECT COUNT(*) AS n FROM ${table}
           WHERE session_id = ? AND source_user_seq = ?
        `).get(sessionId, child!.seq) as { n: number }).n, 0, `${variant}:${table}`);
      }
      assert.equal(listEvents(sessionId, { types: ['conversation_completed'] })
        .filter((event) => event.data.sourceUserSeq === child!.seq).length, 1);
      assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
    });
  }
});

test('active-Claude cron stays on the shared host-owned lane', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let sdkCalls = 0;
  let harnessCalls = 0;
  let selectedEngine: string | undefined;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string; turnEngine?: string }) => {
      harnessCalls += 1;
      selectedEngine = opts.turnEngine;
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        publicPresentation: stubAnswerPresentation(opts, 'cron complete'),
      };
    }) as never,
    claudeAgentBrain: (async () => {
      sdkCalls += 1;
      return { text: 'cron complete', raw: { transport: 'claude_agent_sdk_brain', model: 'claude-sonnet-4-6', mode: 'full' } };
    }) as never,
  });

  const res = await respondPreferHarness('cron', { message: 'run scheduled sync', sessionId: 'cron-sdk-route' }, async () => ({ text: 'legacy' }));
  assert.equal(res.text, 'cron complete');
  assert.equal(res.route?.routeKind, 'harness');
  assert.equal(res.route?.transport, 'host_harness');
  assert.equal(selectedEngine, 'host_v1');
  assert.equal(sdkCalls, 0, 'the retired standalone owner is unreachable in production');
  assert.equal(harnessCalls, 1);
});

test('stale claude_oauth plus all_in Claude-shaped BYO stays on the harness/BYO lane', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://byo.example.test/v1';
  process.env.BYO_MODEL_API_KEY = 'byo-key';
  process.env.BYO_MODEL_ID = 'claude-custom';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let sdkCalls = 0;
  let harnessCalls = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      harnessCalls += 1;
      return { sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1, lastDecision: { reply: 'BYO complete', done: true, nextAction: 'completed' } };
    }) as never,
    claudeAgentBrain: (async () => { sdkCalls += 1; return { text: 'wrong lane' }; }) as never,
  });

  const res = await respondPreferHarness('home', { message: 'do the task', sessionId: 'allin-claude-shaped-byo' }, async () => ({ text: 'legacy' }));
  assert.equal(res.text, 'BYO complete');
  assert.equal(res.route?.routeKind, 'harness');
  assert.equal(res.route?.provider, 'byo');
  assert.equal(sdkCalls, 0, 'all_in provider isolation wins over stale Claude auth');
  assert.equal(harnessCalls, 1);
});

test('respondPreferHarness: Claude Discord and Slack turns share the host harness', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLAUDE_MODEL = 'claude-opus-4-8';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const harnessSessions: string[] = [];
  let sdkCalls = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      harnessSessions.push(opts.sessionId);
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: `shared:${opts.sessionId}`, done: true, nextAction: 'completed' },
      };
    }) as never,
    claudeAgentBrain: (async () => { sdkCalls += 1; throw new Error('standalone chat lane must stay closed'); }) as never,
    allowStandaloneClaudeInteractiveBrainForTests: false,
  });

  const discord = await respondPreferHarness('discord', { message: 'hi', sessionId: 'discord-bridge' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  const slack = await respondPreferHarness('slack', { message: 'hi', sessionId: 'slack-bridge' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

  assert.equal(discord.text, 'shared:discord-bridge');
  assert.equal(slack.text, 'shared:slack-bridge');
  assert.deepEqual(harnessSessions, ['discord-bridge', 'slack-bridge']);
  assert.equal(sdkCalls, 0);
  for (const response of [discord, slack]) {
    assert.equal(response.route?.routeKind, 'harness');
    assert.equal(response.route?.effectiveModel, 'claude-opus-4-8');
    assert.equal(response.route?.provider, 'claude');
    assert.equal(response.route?.transport, 'host_harness');
  }
});

// The cases below exercise the retired standalone reducer. They opt into that
// production-dead route explicitly so rolling-upgrade failure handling remains
// testable without transferring fresh-turn ownership.
test('legacy standalone Claude reducer: relays tool/progress events to legacy callbacks', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const seenTools: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const seenReasoning: string[] = [];
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed' }),
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) {
        createSession({ id: req.sessionId, kind: 'chat', title: 'claude progress' });
      }
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'agent',
        type: 'turn_started',
        data: {},
      });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'run_shell_command', callId: 'toolu-shell', accounting: 'top_level', arguments: JSON.stringify({ command: 'npm test' }) },
      });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'run_shell_command', callId: 'mcp-shell', accounting: 'transport_mirror', args: { command: 'npm test' } },
      });
      return { text: 'claude sdk brain', sessionId: req.sessionId, stoppedReason: 'success' };
    }) as never,
  });

  await respondPreferHarness('home', {
    message: 'run the local check',
    sessionId: 'claude-brain-progress',
    onToolActivity: (activity) => { seenTools.push(activity); },
    onReasoning: (text) => { seenReasoning.push(text); },
  }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

  assert.deepEqual(seenTools, [
    { toolName: 'run_shell_command', input: {} },
  ]);
  assert.ok(seenReasoning.some((text) => /planning the next step/i.test(text)));
});

test('respondPreferHarness: Claude background and workflow share the host-owned path', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const claudeBrainSurfaces: string[] = [];
  let runConversationCalled = 0;
  const selectedEngines: string[] = [];
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string; turnEngine?: string }) => {
      runConversationCalled += 1;
      selectedEngines.push(opts.turnEngine ?? '');
      return { sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1, lastDecision: { reply: 'harness', summary: 's', done: true, nextAction: 'completed' } };
    }) as never,
    claudeAgentBrain: (async (surface, req) => {
      claudeBrainSurfaces.push(surface);
      return { text: 'claude', sessionId: req.sessionId };
    }) as never,
  });

  const background = await respondPreferHarness('background', { message: 'count files', sessionId: 'claude-brain-background' }, async (req) => ({
    text: 'legacy',
    sessionId: req.sessionId,
  }));
  const workflow = await respondPreferHarness('workflow', { message: 'step', sessionId: 'claude-brain-workflow' }, async (req) => ({
    text: 'legacy',
    sessionId: req.sessionId,
  }));

  assert.equal(background.text, 'harness');
  assert.equal(workflow.text, 'harness');
  assert.equal(runConversationCalled, 2);
  assert.deepEqual(selectedEngines, ['host_v1', 'host_v1']);
  assert.deepEqual(claudeBrainSurfaces, []);
});

test('legacy standalone Claude reducer: uncommitted overload falls the turn over to the host harness', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      runConversationCalled += 1;
      return { sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1, lastDecision: { reply: 'harness-fallover', summary: 's', done: true, nextAction: 'completed' } };
    }) as never,
    // Overloaded with NOTHING committed (no tool, no stream) → safe to re-run elsewhere.
    claudeAgentBrain: (async () => { throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', false); }) as never,
  });

  const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'fallover-ok' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  assert.equal(res.text, 'harness-fallover', 'turn ran on the harness brain after Claude overloaded');
  assert.equal(runConversationCalled, 1);
  assert.equal(res.route?.routeKind, 'harness');
  assert.equal(res.route?.falloverFrom, 'claude_agent_sdk_brain');
  assert.equal(res.route?.surface, 'home');
});

test('legacy standalone Claude reducer: request-scoped preamble survives host fallover and is awaited before work', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const order: string[] = [];
  const onConversationPreamble = async (text: string) => {
    order.push(`deliver:${text}`);
    return { status: 'delivered' as const };
  };
  let claudeSawCallback = false;
  let harnessSawSameCallback = false;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    claudeAgentBrain: (async (_surface, request) => {
      claudeSawCallback = request.onConversationPreamble === onConversationPreamble;
      throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', false);
    }) as never,
    runConversation: (async (options: {
      sessionId: string;
      onConversationPreamble?: typeof onConversationPreamble;
    }) => {
      harnessSawSameCallback = options.onConversationPreamble === onConversationPreamble;
      const delivery = await options.onConversationPreamble?.('I remember the earlier attempt and I’m beginning now.');
      assert.deepEqual(delivery, { status: 'delivered' });
      order.push('tool:start');
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          reply: 'completed after fallover',
          summary: 'completed after fallover',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });

  const response = await respondPreferHarness('home', {
    message: 'run the task',
    sessionId: 'preamble-callback-fallover',
    onConversationPreamble,
  }, async (request) => ({ text: 'legacy', sessionId: request.sessionId }));

  assert.equal(response.text, 'completed after fallover');
  assert.equal(claudeSawCallback, true);
  assert.equal(harnessSawSameCallback, true);
  assert.deepEqual(order, [
    'deliver:I remember the earlier attempt and I’m beginning now.',
    'tool:start',
  ]);
});

test('legacy standalone Claude reducer: same-source host fallover reuses one durable preamble before work', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'preamble-durable-cross-lane-replay';
  const runId = 'preamble-durable-cross-lane-run';
  const objective = 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.';
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
      accountIdentity: 'connection:apify-primary',
      schemaFingerprint: createHash('sha256').update('apify-source-schema').digest('hex'),
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: createHash('sha256').update('ventura-apify-to-new-google-sheet').digest('hex'),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const bindingBytes = JSON.stringify(sourceStrategyBinding);
  createSession({ id: sessionId, kind: 'chat', channel: 'discord' });
  const acceptedAttempt = beginRunAttempt(sessionId, { runId });
  const source = recordRunAttemptUserInput(acceptedAttempt, {
    turn: 1,
    role: 'user',
    data: { text: objective },
  }, { armRunInFlight: true });
  const decision = classifyTurnPreflight({
    message: objective,
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: source.seq,
    sourceStrategyBinding,
  });
  assert.equal(decision.phase, 'align');
  assert.equal(decision.sourceStrategyPosture, 'confirmed_exact',
    '"from the Apify API" is fresh explicit source authority, not an unanswered source choice');
  assert.equal(decision.confirmationDisposition, undefined);
  assert.equal(JSON.stringify(decision.sourceStrategyBinding), bindingBytes);
  recordTurnPreflightDecision(sessionId, decision, source.seq);
  const durableDecision = listEvents(sessionId, { types: ['turn_preflight_decision'] })[0];
  assert.equal(JSON.stringify(durableDecision?.data.sourceStrategyBinding), bindingBytes,
    'the selector-authored source binding is persisted byte-identically before either brain runs');

  const durableText = 'I remember the earlier Ventura attempt and I’m continuing with the specified sheet and email handoff.';
  const order: string[] = [];
  let claudeAuthorCalls = 0;
  let codexAuthorCalls = 0;
  const onConversationPreamble = async (text: string) => {
    order.push(`deliver:${text}`);
    return { status: 'delivered' as const };
  };
  const preflightIdentity = {
    sessionId,
    turn: source.turn,
    sourceUserSeq: source.seq,
  };

  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    claudeAgentBrain: (async (_surface, request) => {
      assert.equal(request.sourceUserSeq, source.seq);
      const authored = await publishPreflightConversation({
        identity: preflightIdentity,
        decision,
        openness: null,
        port: {
          async render(packet) {
            claudeAuthorCalls += 1;
            assert.equal(JSON.stringify(packet.decision.sourceStrategyBinding), bindingBytes);
            return durableText;
          },
        },
        transport: 'claude_agent_sdk_brain',
      });
      assert.equal(authored.kind, 'proceed');
      if (authored.kind !== 'proceed') assert.fail('settled Claude preflight must proceed');
      const persisted = appendConversationPreambleOnce({
        source,
        text: authored.preamble,
        intentKey: decision.intentKey,
      });
      assert.equal(persisted.inserted, true);
      await request.onConversationPreamble?.(String(persisted.event.data.text));
      throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', false);
    }) as never,
    runConversation: (async (options: {
      sessionId: string;
      sourceUserSeq?: number;
      onConversationPreamble?: typeof onConversationPreamble;
    }) => {
      assert.equal(options.sourceUserSeq, source.seq, 'fallover retains the exact accepted source');
      const replay = await publishPreflightConversation({
        identity: preflightIdentity,
        decision,
        openness: null,
        port: {
          async render() {
            codexAuthorCalls += 1;
            return 'Codex should never author competing replay prose.';
          },
        },
        transport: 'host_harness',
      });
      assert.equal(replay.kind, 'proceed');
      if (replay.kind !== 'proceed') assert.fail('settled Codex replay must proceed');
      const reused = appendConversationPreambleOnce({
        source,
        text: replay.preamble,
        intentKey: decision.intentKey,
      });
      assert.equal(reused.inserted, false);
      await options.onConversationPreamble?.(String(reused.event.data.text));
      order.push('tool:start');
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          reply: 'completed after same-source fallover',
          summary: 'completed after same-source fallover',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });

  const response = await respondPreferHarness('home', {
    message: objective,
    sessionId,
    sourceUserSeq: source.seq,
    runId,
    onConversationPreamble,
  }, async (request) => ({ text: 'legacy', sessionId: request.sessionId }));

  assert.equal(response.text, 'completed after same-source fallover');
  assert.equal(claudeAuthorCalls, 1);
  assert.equal(codexAuthorCalls, 0, 'fallover reuses the durable opening instead of re-authoring');
  assert.deepEqual(order, [
    `deliver:${durableText}`,
    `deliver:${durableText}`,
    'tool:start',
  ]);
  assert.equal(listEvents(sessionId, { types: ['conversation_preamble'] }).length, 1);
});

test('legacy standalone Claude reducer: fallover forces a non-Claude host model when one is configured', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const oldByoUrl = process.env.BYO_MODEL_BASE_URL;
  const oldByoKey = process.env.BYO_MODEL_API_KEY;
  const oldByoId = process.env.BYO_MODEL_ID;
  const oldRouting = process.env.MODEL_ROUTING_MODE;
  process.env.BYO_MODEL_BASE_URL = 'https://example.invalid/v1';
  process.env.BYO_MODEL_API_KEY = 'test-key';
  process.env.BYO_MODEL_ID = 'glm-bridge-fallback';
  process.env.MODEL_ROUTING_MODE = 'off';
  let capturedModel: string | undefined;
  try {
    _setBridgeImplsForTests({
      allowStandaloneClaudeInteractiveBrainForTests: true,
      configure: okConfigure,
      buildAgent: (async (opts: { model?: string }) => {
        capturedModel = opts.model;
        return FAKE_AGENT;
      }) as never,
      runConversation: (async (opts: {
        sessionId: string;
        sourceUserSeq?: number;
        buildAgent?: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
      }) => (await opts.buildAgent?.(stubBuildIdentity(opts)), {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'recovered with tools', summary: 's', done: true, nextAction: 'completed' },
      })) as never,
      claudeAgentBrain: (async () => {
        throw new Error('Claude Agent SDK local MCP surface is missing required tool: memory_recall');
      }) as never,
    });

    const res = await respondPreferHarness('discord', { message: 'check my calendar', sessionId: 'fallover-model-override' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

    assert.equal(res.text, 'recovered with tools');
    assert.equal(capturedModel, 'glm-bridge-fallback', 'recovery must not re-enter the Claude headless text-only harness');
    assert.equal(res.route?.effectiveModel, 'glm-bridge-fallback');
    assert.equal(res.route?.provider, 'byo');
    assert.equal(res.route?.falloverFrom, 'claude_agent_sdk_brain');
  } finally {
    if (oldByoUrl === undefined) delete process.env.BYO_MODEL_BASE_URL; else process.env.BYO_MODEL_BASE_URL = oldByoUrl;
    if (oldByoKey === undefined) delete process.env.BYO_MODEL_API_KEY; else process.env.BYO_MODEL_API_KEY = oldByoKey;
    if (oldByoId === undefined) delete process.env.BYO_MODEL_ID; else process.env.BYO_MODEL_ID = oldByoId;
    if (oldRouting === undefined) delete process.env.MODEL_ROUTING_MODE; else process.env.MODEL_ROUTING_MODE = oldRouting;
  }
});

test('legacy standalone Claude reducer: an unparseable tool call falls the turn over to the host harness', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      runConversationCalled += 1;
      return { sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1, lastDecision: { reply: 'harness-fallover', summary: 's', done: true, nextAction: 'completed' } };
    }) as never,
    // The exact error that killed the 2026-06-29 turn — now fallover-eligible.
    claudeAgentBrain: (async () => { throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed)."); }) as never,
  });

  const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'fallover-parse' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  assert.equal(res.text, 'harness-fallover', 'a parse failure now recovers on the harness brain instead of "Didn\'t finish"');
  assert.equal(runConversationCalled, 1);
});

test('legacy standalone Claude reducer: uncommitted fallover reuses the pre-recorded user input row', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const runId = 'run:fallover-reuse';
  let claudeAttemptId = '';
  let claudeSourceUserSeq = 0;
  let harnessAttemptId = '';
  let harnessSourceUserSeq = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: {
      sessionId: string;
      reuseRecordedUserInput?: boolean;
      sourceUserSeq?: number;
      runAttemptId?: string;
    }) => {
      assert.equal(opts.reuseRecordedUserInput, true);
      harnessAttemptId = opts.runAttemptId ?? '';
      harnessSourceUserSeq = opts.sourceUserSeq ?? 0;
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 2,
        lastDecision: { reply: 'fallback done', summary: 's', done: true, nextAction: 'completed' },
      };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) {
        createSession({ id: req.sessionId, kind: 'chat', title: 'fallover test' });
      }
      const attempt = beginRunAttempt(req.sessionId, { runId: req.runId });
      const source = recordRunAttemptUserInput(attempt, {
        turn: 1,
        role: 'user',
        data: { text: req.message },
      });
      claudeAttemptId = attempt.attemptId;
      claudeSourceUserSeq = source.seq;
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'system',
        type: 'turn_started',
        data: {},
      });
      throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', false);
    }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'same turn', sessionId: 'fallover-reuse', runId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(res.text, 'fallback done');
  assert.ok(claudeAttemptId && harnessAttemptId);
  assert.notEqual(harnessAttemptId, claudeAttemptId, 'fallover owns a fresh physical attempt');
  assert.equal(harnessSourceUserSeq, claudeSourceUserSeq, 'both physical attempts bind the exact accepted event');
  assert.equal(
    listEvents('fallover-reuse', { types: ['user_input_received'] }).length,
    1,
    'the logical user turn is recorded once',
  );
});

test('legacy standalone Claude reducer: an exception after terminal commit returns that winner without fallback', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-post-terminal-short-circuit';
  const runId = 'run:post-terminal-short-circuit';
  let runConversationCalled = 0;
  const { commitTurnOutcome } = await import('./delivery-committer.js');
  const { turnOutcomeId } = await import('./turn-outcome.js');
  const { markRunInFlight } = await import('./restart-recovery.js');
  const { HarnessSession } = await import('./session.js');
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      return { sessionId, status: 'completed' };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) createSession({ id: req.sessionId, kind: 'chat' });
      const attempt = beginRunAttempt(req.sessionId, { runId: req.runId });
      const source = recordRunAttemptUserInput(attempt, {
        turn: 1,
        role: 'user',
        data: { text: req.message },
      });
      markRunInFlight(req.sessionId, true);
      const identity = {
        sessionId: req.sessionId,
        turn: source.turn,
        sourceUserSeq: source.seq,
      } as const;
      commitTurnOutcome({
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'done',
        resumable: false,
        presentation: { kind: 'answer', text: 'Committed before bookkeeping failed.' },
      });
      throw new Error('post-terminal learning database failure');
    }) as never,
  });

  const response = await respondPreferHarness(
    'home',
    { message: 'do it once', sessionId, runId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(response.text, 'Committed before bookkeeping failed.');
  assert.equal(response.stoppedReason, 'success');
  assert.equal(runConversationCalled, 0, 'the exact durable terminal forbids a second brain dispatch');
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
});

test('legacy standalone Claude reducer: late attempt A replay cannot clear newer attempt B ownership', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-late-A-newer-B-marker';
  const runIdA = 'run:late-A';
  let attemptB: ReturnType<typeof beginRunAttempt> | undefined;
  let sourceB: ReturnType<typeof recordRunAttemptUserInput> | undefined;
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      return { sessionId, status: 'completed' };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) createSession({ id: req.sessionId, kind: 'chat' });
      const attemptA = beginRunAttempt(req.sessionId, { runId: req.runId });
      const sourceA = recordRunAttemptUserInput(attemptA, {
        turn: 1,
        role: 'user',
        data: { text: req.message },
      }, { armRunInFlight: true });
      const identity = {
        sessionId: req.sessionId,
        turn: sourceA.turn,
        sourceUserSeq: sourceA.seq,
        attemptId: attemptA.attemptId,
        runId: attemptA.runId ?? undefined,
      } as const;
      commitTurnOutcome({
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'done',
        resumable: false,
        presentation: { kind: 'answer', text: 'A committed before its late wrapper returned.' },
      });

      // B is accepted after A's terminal but before A's wrapper reports its
      // post-commit exception. The bridge may replay A; it must retain B's exact
      // restart owner and must not dispatch another brain for A.
      attemptB = beginRunAttempt(req.sessionId, { runId: 'run:newer-B' });
      sourceB = recordRunAttemptUserInput(attemptB, {
        turn: 2,
        role: 'user',
        data: { text: 'newer request B' },
      }, { armRunInFlight: true });
      throw new Error('late A bookkeeping failure');
    }) as never,
  });

  const response = await respondPreferHarness(
    'home',
    { message: 'request A', sessionId, runId: runIdA },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(response.text, 'A committed before its late wrapper returned.');
  assert.equal(runConversationCalled, 0);
  assert.ok(attemptB && sourceB);
  assert.deepEqual(getSession(sessionId)?.metadata.__run_in_flight_owner, {
    attemptId: attemptB.attemptId,
    sourceUserSeq: sourceB.seq,
    armedAt: (getSession(sessionId)?.metadata.__run_in_flight_owner as { armedAt?: string }).armedAt,
  });
  assert.ok(getSession(sessionId)?.metadata.__run_in_flight);
});

test('legacy standalone Claude reducer: committed overload reduces to one safe terminal without a double-act', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => { runConversationCalled += 1; return { status: 'completed' }; }) as never,
    // committed=true (a tool ran / text streamed) → must NOT re-run on another brain.
    claudeAgentBrain: (async () => { throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', true); }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'hi', sessionId: 'fallover-unsafe' },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );
  assert.equal(runConversationCalled, 0, 'no fallover once the turn committed work');
  assert.equal(res.stoppedReason, 'error');
  assert.doesNotMatch(res.text, /529|overload/i, 'raw provider detail is private');
  const terminals = listEvents('fallover-unsafe', { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal((terminals[0].data.presentation as { status?: string }).status, 'failed');
});

test('legacy standalone Claude reducer: a terminal error after a write is salvaged without whole-turn fallover', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-generic-write-gate';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'blind rerun', summary: 's', done: true, nextAction: 'completed' },
      };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) {
        createSession({ id: req.sessionId, kind: 'chat', title: 'write-gated fallover' });
      }
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write',
        data: {
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_CREATE_RECORD',
          targets: ['record:rec-42'],
        },
      });
      throw new Error('Claude SDK terminal error after the Airtable call returned');
    }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'Create the approved Airtable record', sessionId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(runConversationCalled, 0, 'a completed non-send write forbids re-driving the whole turn');
  assert.equal(res.stoppedReason, 'blocked');
  assert.match(res.text, /Created a record/);
  assert.match(res.text, /did not rerun/i);
  assert.doesNotMatch(res.text, /blind rerun/);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
});

test('legacy standalone Claude reducer: blocked recovery clears the marker only after its terminal commits', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-marker-after-blocked-terminal';
  const runId = 'run:marker-after-blocked-terminal';
  const { HarnessSession } = await import('./session.js');
  let markerWasArmedAtPublication = false;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      throw new Error('must not dispatch fallback');
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) createSession({ id: req.sessionId, kind: 'chat' });
      const attempt = beginRunAttempt(req.sessionId, { runId: req.runId });
      recordRunAttemptUserInput(attempt, {
        turn: 1,
        role: 'user',
        data: { text: req.message },
      }, { armRunInFlight: true });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write_orphaned',
        data: {
          callId: 'call-uncertain',
          canonicalCallId: 'call-uncertain',
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_UPDATE_RECORD',
          targets: ['record:rec-uncertain'],
        },
      });
      throw new Error('provider stopped after uncertain write');
    }) as never,
  });
  const detach = actionBus.subscribe((event) => {
    if (event.kind === 'harness.public_event'
      && event.sessionId === sessionId
      && event.event.type === 'conversation_completed') {
      markerWasArmedAtPublication = HarnessSession.load(sessionId)?.runInFlightSince() != null;
    }
  });
  try {
    const response = await respondPreferHarness(
      'home',
      { message: 'update once', sessionId, runId },
      async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
    );
    assert.equal(response.stoppedReason, 'blocked');
  } finally {
    detach();
  }
  assert.equal(
    markerWasArmedAtPublication,
    false,
    'the exact run owner is closed atomically before the terminal becomes publicly observable',
  );
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('legacy standalone Claude reducer: exact proven-no-dispatch failure permits whole-turn fallover', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-exact-failed-write';
  createSession({ id: sessionId, kind: 'chat', title: 'failed before dispatch' });
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'safe recovery', summary: 's', done: true, nextAction: 'completed' },
      };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write',
        data: {
          callId: 'call-airtable-no-dispatch',
          canonicalCallId: 'call-airtable-no-dispatch',
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_CREATE_RECORD',
          targets: ['record:rec-no-dispatch'],
          preDispatch: true,
        },
      });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write_failed',
        data: {
          callId: 'call-airtable-no-dispatch',
          canonicalCallId: 'call-airtable-no-dispatch',
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_CREATE_RECORD',
          targets: ['record:rec-no-dispatch'],
          reason: 'validation_failed_before_dispatch',
        },
      });
      throw new Error('Claude SDK terminal error after a rejected call');
    }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'Create the approved Airtable record', sessionId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(runConversationCalled, 1, 'an exact no-dispatch settlement makes whole-turn recovery safe');
  assert.equal(res.text, 'safe recovery');
  assert.equal(res.route?.falloverFrom, 'claude_agent_sdk_brain');
});

test('legacy standalone Claude reducer: sibling failure cannot settle another reservation for fallover', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-sibling-failed-write';
  createSession({ id: sessionId, kind: 'chat', title: 'mismatched failure' });
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      return { sessionId, status: 'completed' };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write',
        data: {
          callId: 'call-airtable-reserved',
          canonicalCallId: 'call-airtable-reserved',
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_CREATE_RECORD',
          targets: ['record:rec-sibling'],
          preDispatch: true,
        },
      });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write_failed',
        data: {
          callId: 'call-airtable-sibling',
          canonicalCallId: 'call-airtable-sibling',
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_CREATE_RECORD',
          targets: ['record:rec-sibling'],
          reason: 'validation_failed_before_dispatch',
        },
      });
      throw new Error('Claude SDK terminal error with an unresolved reservation');
    }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'Create the approved Airtable record', sessionId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(runConversationCalled, 0, 'a sibling failure cannot compensate another call reservation');
  assert.equal(res.stoppedReason, 'blocked');
  assert.match(res.text, /did not rerun/i);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
});

test('legacy standalone Claude reducer: an exact orphaned write blocks whole-turn fallover', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-exact-orphaned-write';
  createSession({ id: sessionId, kind: 'chat', title: 'orphaned write' });
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      return { sessionId, status: 'completed' };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write',
        data: {
          callId: 'call-airtable-orphaned',
          canonicalCallId: 'call-airtable-orphaned',
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_UPDATE_RECORD',
          targets: ['record:rec-orphaned'],
          preDispatch: true,
        },
      });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write_orphaned',
        data: {
          callId: 'call-airtable-orphaned',
          canonicalCallId: 'call-airtable-orphaned',
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_UPDATE_RECORD',
          targets: ['record:rec-orphaned'],
          reason: 'timeout',
        },
      });
      throw new Error('Claude SDK terminal error after an uncertain provider result');
    }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'Update the approved Airtable record', sessionId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(runConversationCalled, 0, 'an orphaned write remains unsafe to replay');
  assert.equal(res.stoppedReason, 'blocked');
  assert.match(res.text, /could not confirm|uncertain/i);
  assert.match(res.text, /did not rerun/i);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
});

test('legacy standalone Claude reducer: salvage carries orphan evidence without fabricating write success', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-orphaned-write-truth';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      return { sessionId, status: 'completed' };
    }) as never,
    claudeAgentBrain: (async (_surface, req) => {
      if (!getSession(req.sessionId)) {
        createSession({ id: req.sessionId, kind: 'chat', title: 'uncertain write' });
      }
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write',
        data: {
          callId: 'call-airtable-timeout',
          toolName: 'composio_execute_tool',
          shapeKey: 'AIRTABLE_UPDATE_RECORD',
          targets: ['record:rec-uncertain'],
        },
      });
      appendEvent({
        sessionId: req.sessionId,
        turn: 1,
        role: 'tool',
        type: 'external_write_orphaned',
        data: {
          callId: 'call-airtable-timeout',
          slug: 'AIRTABLE_UPDATE_RECORD',
          targets: ['record:rec-uncertain'],
          reason: 'timeout',
        },
      });
      throw new Error('Claude SDK terminal error after an uncertain Airtable update');
    }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'Update the Airtable record', sessionId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(runConversationCalled, 0);
  assert.match(res.text, /could not confirm|uncertain/i);
  assert.match(res.text, /did not rerun/i);
  assert.doesNotMatch(res.text, /I finished|Updated a record/);
});

test('legacy standalone Claude reducer: per-attempt baseline excludes old writes from clean fallover', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-attempt-write-baseline';
  createSession({ id: sessionId, kind: 'chat', title: 'prior write' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'external_write',
    data: { toolName: 'composio_execute_tool', shapeKey: 'AIRTABLE_UPDATE_RECORD', targets: ['record:old'] },
  });
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => {
      runConversationCalled += 1;
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'clean recovery', summary: 's', done: true, nextAction: 'completed' },
      };
    }) as never,
    claudeAgentBrain: (async () => {
      throw new Error('clean generic Claude terminal error');
    }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'Read the current Airtable view', sessionId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(runConversationCalled, 1, 'only writes added by this failed attempt block recovery');
  assert.equal(res.text, 'clean recovery');
  assert.equal(res.route?.falloverFrom, 'claude_agent_sdk_brain');
});

test('legacy standalone Claude reducer: whole-turn recovery fails closed when its ledger is unreadable', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-ledger-unreadable';
  createSession({ id: sessionId, kind: 'chat', title: 'ledger unavailable' });
  let ledgerReads = 0;
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    recoveryListEvents: ((id: string, options?: Parameters<typeof listEvents>[1]) => {
      ledgerReads += 1;
      if (ledgerReads === 1) return listEvents(id, options);
      throw new Error('ledger unavailable');
    }) as never,
    runConversation: (async () => {
      runConversationCalled += 1;
      return { sessionId, status: 'completed' };
    }) as never,
    claudeAgentBrain: (async () => {
      throw new Error('generic Claude terminal error');
    }) as never,
  });

  const res = await respondPreferHarness(
    'home',
    { message: 'Update Airtable if needed', sessionId },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );

  assert.equal(ledgerReads, 2, 'baseline and terminal check are both attempt-scoped');
  assert.equal(runConversationCalled, 0, 'unreadable safety evidence can never authorize a whole-turn rerun');
  assert.equal(res.stoppedReason, 'blocked');
  assert.match(res.text, /could not verify the external-write ledger/i);
  assert.match(res.text, /did not rerun/i);
  assert.equal((res.raw as { recoverySkipped?: string }).recoverySkipped, 'ledger_unreadable');
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
});

test('legacy standalone Claude reducer: the fallover kill-switch surfaces overload without rerunning', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'off';
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => ({ status: 'completed' })) as never,
    claudeAgentBrain: (async () => { throw new ClaudeSdkProviderOverloadError('API Error: 529 Overloaded', false); }) as never,
  });
  const res = await respondPreferHarness(
    'home',
    { message: 'hi', sessionId: 'fallover-off' },
    async (req) => ({ text: 'legacy', sessionId: req.sessionId }),
  );
  assert.equal(res.stoppedReason, 'error');
  assert.doesNotMatch(res.text, /529|overload/i);
  delete process.env.CLEMMY_BRAIN_FALLOVER;
});

test('respondPreferHarness: harness run errors commit one failed terminal — no post-start legacy retry', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => { throw new Error('mid-run boom'); }) as never,
  });
  let legacyCalled = 0;
  const res = await respondPreferHarness(
    'webhook',
    { message: 'hi', sessionId: 'bridge-t4' },
    async (req) => {
      legacyCalled += 1;
      return { text: 'legacy', sessionId: req.sessionId };
    },
  );
  assert.equal(legacyCalled, 0, 'a started harness run must never retry on legacy (double-send class)');
  assert.equal(res.stoppedReason, 'error');
  assert.doesNotMatch(res.text, /mid-run boom/);
  assert.equal(listEvents('bridge-t4', { types: ['conversation_completed'] }).length, 1);
});

test('a corrupt typed terminal rolls back atomically and recovery publishes one safe failure', async () => {
  const sessionId = 'bridge-corrupt-terminal-winner';
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string; sourceUserSeq?: number }) => {
      const sourceUserSeq = opts.sourceUserSeq ?? 0;
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'system',
        type: 'conversation_completed',
        data: {
          terminalKey: `turn:${sourceUserSeq}`,
          sourceUserSeq,
          reply: 'PRIVATE INVALID DUPLICATE REPLY',
          summary: 'PRIVATE INVALID DUPLICATE SUMMARY',
          presentation: {
            version: 1,
            id: `turn:${sourceUserSeq}:presentation`,
            outcomeId: `turn:${sourceUserSeq}`,
            audience: 'user',
            phase: 'final',
            identity: { sessionId: opts.sessionId, turn: 1, sourceUserSeq },
            // Contradictory typed rows must fail strict parsing.
            status: 'done',
            kind: 'error',
            text: 'PRIVATE INVALID DUPLICATE REPLY',
            resumable: false,
          },
        },
      });
      throw new Error('private provider failure');
    }) as never,
  });

  const response = await respondViaHarness('webhook', { message: 'run once', sessionId });
  assert.equal(response.stoppedReason, 'error');
  assert.equal(response.text, PUBLIC_RUN_FAILURE_TEXT);
  assert.doesNotMatch(response.text, /PRIVATE INVALID|provider failure/i);
  const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'the invalid proposal rolls back and only the safe reducer wins');
  assert.equal((terminals[0]?.data.presentation as { status?: unknown } | undefined)?.status, 'failed');
  assert.doesNotMatch(JSON.stringify(terminals[0]?.data), /PRIVATE INVALID|provider failure/i);
});

test('respondViaHarness: completed maps to AssistantResponse with reply preferred over summary', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed', lastDecision: { summary: 'meta', reply: 'hello user', done: true, nextAction: 'completed' }, lastTurn: 3 }),
  });
  const res = await respondViaHarness('webhook', { message: 'hi', sessionId: 'bridge-t5', channel: 'webhook' });
  assert.equal(res.text, 'hello user');
  assert.equal(res.stoppedReason, 'success');
  assert.equal(res.turnsUsed, 3);
  assert.equal(res.route?.routeKind, 'harness');
  assert.equal(res.route?.surface, 'webhook');
  assert.equal(res.route?.transport, 'host_harness');
  assert.ok(res.route?.effectiveModel, 'effective model is recorded for diagnostics');
  const session = getSession('bridge-t5');
  assert.ok(session, 'harness session created');
  assert.equal(session?.kind, 'chat', 'webhook surface creates a chat-kind session');
});

test('respondViaHarness: typed async dispatch returns a deterministic ACK without a false terminal', async () => {
  const sessionId = 'bridge-typed-dispatch';
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string; sourceUserSeq?: number }) => {
      const source = listEvents(opts.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === opts.sourceUserSeq);
      assert.ok(source);
      appendActiveWorkflowDispatch(source, 'bridge-run-123');
      return {
        sessionId: opts.sessionId,
        status: 'dispatched',
        steps: 1,
        lastTurn: 1,
      };
    }) as never,
  });

  const response = await respondViaHarness('home', {
    message: 'Run the saved workflow.',
    sessionId,
    channel: 'desktop',
  });
  assert.equal(
    response.text,
    'Started — I’ll post the result here when it’s ready.',
  );
  assert.equal(response.stoppedReason, 'success', 'the synchronous provider request delivered its ACK');
  const publicDispatch = listEvents(sessionId, { types: ['async_work_dispatched'] })[0];
  assert.match(String(publicDispatch.data.sourceGroupId), /^workflow-origin-group-v1:[a-f0-9]{64}$/);
  assert.deepEqual((response.raw as { asyncWork?: unknown }).asyncWork, {
    status: 'dispatched',
    kind: 'workflow_run_group',
    runIds: ['bridge-run-123'],
    sourceGroupId: publicDispatch.data.sourceGroupId,
    sourceGroupDigest: publicDispatch.data.sourceGroupDigest,
    sourceUserSeq: listEvents(sessionId, { types: ['user_input_received'] })[0].seq,
    dispatchKey: publicDispatch.data.dispatchKey,
  });
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('respondViaHarness: typed peer/recovery ownership stays nonterminal and preserves the exact attempt', async () => {
  const sessionId = 'bridge-typed-execution-held';
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({
      status: 'held',
      hold: { owner: 'host', wake: 'peer', reason: 'peer_in_progress' },
    }),
  });

  const response = await respondViaHarness('home', {
    message: 'Continue the exact admitted task.',
    sessionId,
    channel: 'desktop',
  });

  assert.equal(response.stoppedReason, 'in-progress');
  assert.match(response.text, /did not start a duplicate attempt/i);
  assert.deepEqual((response.raw as { typedExecution?: unknown }).typedExecution, {
    owner: 'host',
    wake: 'peer',
    reason: 'peer_in_progress',
  });
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(getLatestRunAttempt(sessionId)?.status, 'active');
  assert.ok(HarnessSession.load(sessionId)?.runInFlightSince());
});

test('respondViaHarness: restart-owned held admission never becomes a failed terminal and resumes the same run', async () => {
  const sessionId = 'bridge-restart-owned-dispatch';
  const workflowName = 'restart-owned-bridge-workflow';
  const runId = 'bridge-restart-owned-run';
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  writeWorkflow(workflowName, {
    name: workflowName,
    description: 'Restart-owned bridge recovery fixture.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'work', prompt: 'Perform the admitted read-only work.', sideEffect: 'read' }],
  });
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string; sourceUserSeq?: number }) => {
      const source = listEvents(opts.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === opts.sourceUserSeq);
      assert.ok(source);
      const sourceGroupId = workflowOriginSourceGroupId({
        sessionId: source.sessionId,
        sourceUserSeq: source.seq,
      });
      mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
      writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
        id: runId,
        workflow: workflowName,
        inputs: {},
        status: 'awaiting_chat_dispatch_seal',
        createdAt: new Date().toISOString(),
        chatDispatchSourceGroupId: sourceGroupId,
        chatDispatchQueueRequestDigest: workflowChatDispatchQueueRequestDigest({
          workflowName,
          normalizedInputs: {},
        }),
      }), 'utf-8');

      // This is the real public terminal boundary, not a synthetic thrown
      // fixture. The committer emits the typed restart-owned control signal
      // because the queue record won before its preparation callback/event.
      const identity = {
        sessionId: source.sessionId,
        turn: source.turn,
        sourceUserSeq: source.seq,
      };
      commitTurnOutcome({
        version: 2,
        id: turnOutcomeId(identity),
        identity,
        status: 'failed',
        resumable: false,
        presentation: { kind: 'error', text: PUBLIC_RUN_FAILURE_TEXT },
      });
      assert.fail('held workflow ownership must reject a failed terminal');
    }) as never,
  });

  const response = await respondViaHarness('home', {
    message: 'Run the restart-owned workflow.',
    sessionId,
    channel: 'desktop',
  });
  const source = listEvents(sessionId, { types: ['user_input_received'] })[0];
  const attempt = getLatestRunAttempt(sessionId);
  assert.ok(attempt);
  assert.equal(response.stoppedReason, 'awaiting-input');
  assert.match(response.text, /preserved the original request/i);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['run_paused'] }).at(-1)?.data.reason,
    'prepared_workflow_dispatch_restart_owned');
  assert.ok(HarnessSession.load(sessionId)?.runInFlightSince(), 'the atomic chat marker remains armed');
  assert.equal(attempt.status, 'active', 'the bridge does not settle the restart-owned attempt as failed');
  assert.equal(
    JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf-8')).status,
    'awaiting_chat_dispatch_seal',
  );

  const reusedRunIds: string[] = [];
  process.env.CLEMMY_CHAT_AUTO_RESUME = 'on';
  const summary = recoverInterruptedChatRuns(
    () => Date.now() + 1_000,
    async (restart) => {
      assert.equal(restart.sessionId, sessionId);
      assert.equal(restart.sourceUserSeq, source.seq);
      const sourceUserSeq = restart.sourceUserSeq;
      const replyTarget = source.data.originReplyTarget as { type: 'origin_chat' };
      const retried = queueWorkflowRun(workflowName, {}, {
        originSessionId: sessionId,
        originObserver: { sessionId, sourceUserSeq, replyTarget },
        prepareChatDispatch: (authority) => {
          const prepared = appendEvent({
            sessionId,
            turn: source.turn,
            role: 'system',
            type: 'async_work_dispatch_prepared',
            parentEventId: source.id,
            data: { ...authority },
          });
          return recordWorkflowChatDispatchPreparation(
            createWorkflowChatDispatchPreparedReceipt(authority, {
              eventId: prepared.id,
              eventSeq: prepared.seq,
              preparedAt: prepared.createdAt,
            }),
          );
        },
      });
      assert.equal(retried.status, 'duplicate');
      assert.equal(retried.id, runId);
      reusedRunIds.push(retried.id!);
      const dispatch = finalizePreparedWorkflowDispatchForSource(sessionId, sourceUserSeq);
      assert.deepEqual(dispatch?.presentation.runIds, [runId]);
      assert.equal(
        clearRunInFlightAfterTerminal(sessionId, attempt.attemptId, sourceUserSeq),
        true,
        'activation transfers ownership before the original marker is released',
      );
      finishRunAttempt(attempt, 'completed');
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete process.env.CLEMMY_CHAT_AUTO_RESUME;

  assert.equal(summary.records[0]?.autoResumed, true);
  assert.deepEqual(reusedRunIds, [runId], 'restart dedupes to the already-admitted canonical run');
  assert.equal(
    readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json')).length,
    1,
    'recovery does not create a replacement run',
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf-8')).status,
    'queued',
  );
  assert.equal(listEvents(sessionId, { types: ['async_work_dispatched'] }).length, 1);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
  assert.equal(getLatestRunAttempt(sessionId)?.status, 'completed');
});

test('legacy standalone Claude reducer: wrapper preserves record-before-preparation admission for exact restart', async () => {
  const sessionId = 'claude-bridge-restart-owned-dispatch';
  const workflowName = 'claude-restart-owned-bridge-workflow';
  const runId = 'claude-bridge-restart-owned-run';
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  writeWorkflow(workflowName, {
    name: workflowName,
    description: 'Claude restart-owned bridge recovery fixture.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'work', prompt: 'Perform the admitted read-only work.', sideEffect: 'read' }],
  });
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  _setBridgeImplsForTests({
    allowStandaloneClaudeInteractiveBrainForTests: true,
    configure: okConfigure,
    claudeAgentBrain: respondViaClaudeAgentSdkBrain,
  });
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.equal(options.sessionId, sessionId);
    assert.ok(options.sourceUserSeq);
    const source = listEvents(sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === options.sourceUserSeq);
    assert.ok(source);
    mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
      id: runId,
      workflow: workflowName,
      inputs: {},
      status: 'awaiting_chat_dispatch_seal',
      createdAt: new Date().toISOString(),
      chatDispatchSourceGroupId: workflowOriginSourceGroupId({
        sessionId,
        sourceUserSeq: source.seq,
      }),
      chatDispatchQueueRequestDigest: workflowChatDispatchQueueRequestDigest({
        workflowName,
        normalizedInputs: {},
      }),
    }), 'utf-8');
    throw new Error('provider disconnected after the run record won but before preparation callback');
  });

  try {
    const response = await respondPreferHarness('home', {
      message: 'Run the Claude restart-owned workflow.',
      sessionId,
      channel: 'desktop',
    }, async () => {
      assert.fail('restart-owned Claude work cannot fall through to legacy');
    });
    const source = listEvents(sessionId, { types: ['user_input_received'] })[0];
    const attempt = getLatestRunAttempt(sessionId);
    assert.ok(source && attempt);
    assert.equal(response.stoppedReason, 'awaiting-input');
    assert.match(response.text, /preserved the original request/i);
    assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
    assert.equal(listEvents(sessionId, { types: ['conversation_failed'] }).length, 0);
    assert.ok(HarnessSession.load(sessionId)?.runInFlightSince());
    assert.equal(attempt.status, 'active', 'the inner Claude wrapper keeps exact attempt ownership active');

    const reusedRunIds: string[] = [];
    process.env.CLEMMY_CHAT_AUTO_RESUME = 'on';
    const summary = recoverInterruptedChatRuns(
      () => Date.now() + 1_000,
      async (restart) => {
        assert.equal(restart.sessionId, sessionId);
        assert.equal(restart.sourceUserSeq, source.seq);
        const sourceUserSeq = restart.sourceUserSeq;
        const replyTarget = source.data.originReplyTarget as { type: 'origin_chat' };
        const retried = queueWorkflowRun(workflowName, {}, {
          originSessionId: sessionId,
          originObserver: { sessionId, sourceUserSeq, replyTarget },
          prepareChatDispatch: (authority) => {
            const prepared = appendEvent({
              sessionId,
              turn: source.turn,
              role: 'system',
              type: 'async_work_dispatch_prepared',
              parentEventId: source.id,
              data: { ...authority },
            });
            return recordWorkflowChatDispatchPreparation(
              createWorkflowChatDispatchPreparedReceipt(authority, {
                eventId: prepared.id,
                eventSeq: prepared.seq,
                preparedAt: prepared.createdAt,
              }),
            );
          },
        });
        assert.equal(retried.status, 'duplicate');
        assert.equal(retried.id, runId);
        reusedRunIds.push(retried.id!);
        const dispatch = finalizePreparedWorkflowDispatchForSource(sessionId, sourceUserSeq);
        assert.deepEqual(dispatch?.presentation.runIds, [runId]);
        assert.equal(clearRunInFlightAfterTerminal(
          sessionId,
          attempt.attemptId,
          sourceUserSeq,
        ), true);
        finishRunAttempt(attempt, 'completed');
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(summary.records[0]?.autoResumed, true);
    assert.deepEqual(reusedRunIds, [runId]);
    assert.equal(listEvents(sessionId, { types: ['async_work_dispatched'] }).length, 1);
    assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
    assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
    assert.equal(getLatestRunAttempt(sessionId)?.status, 'completed');
  } finally {
    delete process.env.CLEMMY_CHAT_AUTO_RESUME;
    setClaudeAgentSdkBrainRunForTest(null);
  }
});

test('respondViaHarness: standard runner never receives the user transport callback', async () => {
  const streamed: string[] = [];
  const transportOnChunk = async (delta: string): Promise<void> => { streamed.push(delta); };
  let runnerOnChunk: ((delta: string) => void | Promise<void>) | undefined;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: {
      sessionId: string;
      onChunk?: (delta: string) => void | Promise<void>;
    }) => {
      runnerOnChunk = opts.onChunk;
      await opts.onChunk?.('{"reply":"Hello');
      await opts.onChunk?.(' from the harness."}');
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'Hello from the harness.', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  await respondViaHarness('home', {
    message: 'hi',
    sessionId: 'bridge-public-stream-envelope',
    onChunk: transportOnChunk,
  });

  assert.equal(runnerOnChunk, undefined, 'raw executor deltas have no public transport authority');
  assert.deepEqual(streamed, [], 'the authoritative answer is returned/replayed from its committed terminal');
});

test('respondViaHarness: standard runner cannot stream plain prose or decision narration', async () => {
  const streamed: string[] = [];
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: {
      sessionId: string;
      onChunk?: (delta: string) => void | Promise<void>;
    }) => {
      await opts.onChunk?.('I am going to inspect the account.');
      await opts.onChunk?.('\nsummary: inspection complete\nreply: The account is healthy.\ndone: true');
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'The account is healthy.', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  const response = await respondViaHarness('home', {
    message: 'check the account',
    sessionId: 'bridge-public-stream-private-narration',
    onChunk: (delta) => { streamed.push(delta); },
  });

  assert.deepEqual(streamed, [], 'uncommitted executor output stays private');
  assert.equal(response.text, 'The account is healthy.', 'the committed response still returns normally');
});

test('respondViaHarness sanitizes legacy pause results before returning them synchronously', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'Clem',
        type: 'awaiting_user_input',
        data: {
          question: 'Which tenant should I use?',
          options: ['Acme', 'Tool call: composio_execute_tool\n{"secret":true}'],
        },
      });
      return {
        sessionId: opts.sessionId,
        status: 'awaiting_user_input',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'summary: inspected connections\nreply: I found two tenants.\ndone: false\nnextAction: awaiting_user_input\nreason: selection required',
          done: false,
          nextAction: 'awaiting_user_input',
        },
      };
    }) as never,
  });

  const response = await respondViaHarness('home', {
    message: 'use the right tenant',
    sessionId: 'bridge-public-legacy-pause',
  });

  assert.equal(response.text, 'Which tenant should I use?\n1. Acme\n(Reply with a number or in your own words.)');
  assert.doesNotMatch(response.text, /summary:|done:|nextAction:|reason:|tool call|secret/i);
});

test('respondViaHarness: omits the runner stream callback when the transport did not request streaming', async () => {
  let runnerOnChunk: ((delta: string) => void | Promise<void>) | undefined | 'unset' = 'unset';
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: {
      sessionId: string;
      onChunk?: (delta: string) => void | Promise<void>;
    }) => {
      runnerOnChunk = opts.onChunk;
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  await respondViaHarness('home', {
    message: 'hi',
    sessionId: 'bridge-public-stream-disabled',
  });

  assert.equal(runnerOnChunk, undefined);
});

test('all_in gpt-shaped BYO route diagnostics and event telemetry report the actual BYO wire', async () => {
  process.env.AUTH_MODE = 'api_key';
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://api.together.test/v1';
  process.env.BYO_MODEL_API_KEY = 'together-key';
  process.env.BYO_MODEL_ID = 'gpt-4o';
  process.env.BYO_MODEL_PROVIDER = 'Together';
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed', lastDecision: { reply: 'served by BYO', done: true, nextAction: 'completed' } }),
  });

  const res = await respondViaHarness('home', { message: 'hi', sessionId: 'route-gpt-shaped-byo' });
  assert.equal(res.route?.effectiveModel, 'gpt-4o');
  assert.equal(res.route?.provider, 'byo');
  assert.equal(res.route?.transport, 'host_harness');
  assert.equal(res.route?.mode, 'all_in');

  const routed = listEvents('route-gpt-shaped-byo', { types: ['turn_model_routed'] });
  assert.equal(routed.length, 1);
  const { sourceUserSeq, attemptId, ...routeData } = routed[0].data;
  assert.deepEqual(routeData, {
    model: 'gpt-4o',
    provider: 'byo',
    transport: 'host_harness',
    mode: 'all_in',
    routeKind: 'harness',
    surface: 'home',
  });
  const accepted = listEvents('route-gpt-shaped-byo', { types: ['user_input_received'] });
  assert.equal(sourceUserSeq, accepted[0]?.seq, 'route evidence owns the exact accepted source');
  assert.equal(attemptId, getLatestRunAttempt('route-gpt-shaped-byo')?.attemptId,
    'route evidence owns the exact physical attempt');
});

test('respondViaHarness: relays harness tool/progress events to legacy callbacks', async () => {
  const seenTools: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const seenReasoning: string[] = [];
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'turn_started',
        data: {},
      });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'memory_search', arguments: JSON.stringify({ query: 'status' }) },
      });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'run_shell_command', args: { command: 'npm test' } },
      });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { toolName: 'browser_open', input: { url: 'http://127.0.0.1:3000' } },
      });
      appendEvent({
        sessionId: opts.sessionId,
        turn: 1,
        role: 'agent',
        type: 'tool_called',
        data: { tool: 'debug_probe', args: 'not-json' },
      });
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 's', reply: 'r', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  await respondViaHarness('background', {
    message: 'work',
    sessionId: 'bridge-progress',
    onToolActivity: (activity) => { seenTools.push(activity); },
    onReasoning: (text) => { seenReasoning.push(text); },
  });

  assert.deepEqual(seenTools, [
    { toolName: 'memory_search', input: {} },
    { toolName: 'run_shell_command', input: {} },
    { toolName: 'browser_open', input: {} },
    { toolName: 'debug_probe', input: {} },
  ]);
  assert.ok(seenReasoning.some((text) => /planning the next step/i.test(text)));
});

test('respondViaHarness: cron surface creates an execution-kind session', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed', lastDecision: { summary: 's', reply: 'r', done: true, nextAction: 'completed' } }),
  });
  await respondViaHarness('cron', { message: 'nightly job', sessionId: 'cron:test-job' });
  assert.equal(getSession('cron:test-job')?.kind, 'execution');
});

test('respondViaHarness: awaiting_approval maps to pending-approval stoppedReason', async () => {
  createSession({ id: 'bridge-t6', kind: 'execution' });
  const formal = approvalRegistry.register({
    sessionId: 'bridge-t6',
    subject: 'Publish the reviewed record',
    tool: 'request_approval',
  });
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'awaiting_approval', lastDecision: null }),
  });
  const res = await respondViaHarness('background', { message: 'do it', sessionId: 'bridge-t6' });
  assert.equal(res.stoppedReason, 'pending-approval');
  assert.equal(res.pendingApprovalId, formal.approvalId);
  assert.match(res.text, /approval/i);
});

test('respondViaHarness: a conversational approval projects only its frozen ordinary question', async () => {
  const sessionId = 'bridge-conversational-approval';
  const channelId = 'discord-channel-bridge-consent';
  const userId = 'discord-user-bridge-consent';
  const originReplyTarget = { type: 'discord_channel' as const, channelId };
  const question = 'The exact email to proof@example.com is ready. Do you want me to send it?';
  createSession({
    id: sessionId,
    kind: 'chat',
    channel: 'discord',
    userId,
    metadata: { channelId, userId },
  });
  const row = approvalRegistry.register({
    sessionId,
    channel: 'discord',
    channelId,
    subject: 'Send the reviewed email',
    tool: 'request_approval',
    presentation: {
      version: 1,
      kind: 'autonomous_send_consent',
      question,
      actionLabel: 'email',
      target: 'proof@example.com',
      subject: 'Reviewed sheet',
      bodyPreview: 'The reviewed sheet is attached.',
      resultUrl: 'https://docs.google.com/spreadsheets/d/proof/edit',
      sourceUserSeq: 1,
      originReplyTarget,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
      conversationKey: `discord:${channelId}`,
      audienceUserId: userId,
    },
  });
  assert.equal(approvalRegistry.isFormalApprovalSurface(row), false);
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({
      status: 'awaiting_approval',
      lastDecision: { summary: 'Approval pending.', reply: 'Use the approval card.', done: false },
    }),
  });

  const res = await respondViaHarness('background', { message: 'prepare it', sessionId });
  assert.equal(res.text, question);
  assert.equal(res.stoppedReason, 'awaiting-input');
  assert.equal(res.pendingApprovalId, undefined);
});

test('respondViaHarness: limit_exceeded maps to max-turns-with-grace', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'limit_exceeded' }),
  });
  const res = await respondViaHarness('webhook', { message: 'big task', sessionId: 'bridge-t7' });
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
});

test('respondViaHarness: failed status reduces to a durable safe error terminal', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'failed', error: 'runtime exploded' }),
  });
  const res = await respondViaHarness('cron', { message: 'job', sessionId: 'bridge-t8' });
  assert.equal(res.stoppedReason, 'error');
  assert.doesNotMatch(res.text, /runtime exploded/);
  const terminals = listEvents('bridge-t8', { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal((terminals[0].data.presentation as { status?: string }).status, 'failed');
});

test('respondViaHarness: caller-driven cancel throws AgentRuntimeCancelledError (background abort contract)', async () => {
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    // Run long enough for the 2s cancel poll to fire, then report killed.
    runConversation: (async (opts: { sessionId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      return { sessionId: opts.sessionId, status: 'killed', steps: 1, lastTurn: 1 };
    }) as never,
  });
  await assert.rejects(
    respondViaHarness('background', {
      message: 'long task',
      sessionId: 'bridge-t9',
      shouldCancel: () => true,
    }),
    (err: unknown) => err instanceof AgentRuntimeCancelledError,
  );
});

test('isChatBrainFalloverEligible: ANY genuine Claude-brain failure switches brains; intentional stops do NOT', () => {
  const prev = process.env.CLEMMY_BRAIN_FALLOVER;
  try {
    process.env.CLEMMY_BRAIN_FALLOVER = 'on';
    // Broadened: a generic terminal error (SDK internal throw, tool-surface, unknown 4xx)
    // is now fallover-eligible — a DIFFERENT brain often succeeds. (Was a dead turn.)
    assert.equal(isChatBrainFalloverEligible(new Error('SDK internal failure: something broke')), true);
    assert.equal(isChatBrainFalloverEligible(new Error('The usage limit has been reached')), true);
    // Uncommitted overload still eligible; committed overload is handled by salvage (not here).
    assert.equal(isChatBrainFalloverEligible(new ClaudeSdkProviderOverloadError('529 Overloaded', false)), true);
    assert.equal(isChatBrainFalloverEligible(new ClaudeSdkProviderOverloadError('529 Overloaded', true)), false);
    assert.equal(isChatBrainFalloverEligible(new ClaudeSdkCapacityExhaustedError('out of extra usage', false)), true);
    assert.equal(isChatBrainFalloverEligible(new ClaudeSdkCapacityExhaustedError('out of extra usage', true)), false);
    // Intentional stops are NOT brain failures — never switch/re-run them.
    assert.equal(isChatBrainFalloverEligible(new AgentRuntimeCancelledError('Run cancelled by caller.')), false);
    const killErr = new Error('stopped'); killErr.name = 'KillRequested';
    assert.equal(isChatBrainFalloverEligible(killErr), false);
    // Kill-switch off ⇒ never fall over (prior behavior preserved).
    process.env.CLEMMY_BRAIN_FALLOVER = 'off';
    assert.equal(isChatBrainFalloverEligible(new Error('SDK internal failure')), false);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_BRAIN_FALLOVER; else process.env.CLEMMY_BRAIN_FALLOVER = prev;
  }
});

test('parse-exhaustion completion re-runs ONCE on the next brain instead of shipping the apology', async () => {
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  // Seed a connected Claude so falloverBrainModelIds('codex') has a target
  // (the harness brain under AUTH_MODE=api_key resolves to the codex class).
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
  writeFileSync(path.join(TEST_HOME, 'state', 'claude-auth.json'), JSON.stringify({
    accessToken: 'sk-ant-oat01-test', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
  }), 'utf-8');

  const models: Array<string | undefined> = [];
  const recordingBuilder = (async (opts: { model?: string }) => { models.push(opts.model); return FAKE_AGENT; }) as never;
  let calls = 0;
  const attemptIds: string[] = [];
  const sourceUserSeqs: number[] = [];
  const run = (async (opts: {
    sessionId: string;
    runAttemptId?: string;
    sourceUserSeq?: number;
    buildAgent?: (identity: ReturnType<typeof stubBuildIdentity>) => Promise<unknown>;
  }) => {
    // Contract mirror: capability resolves during the turn.
    await opts.buildAgent?.(stubBuildIdentity(opts));
    calls += 1;
    attemptIds.push(opts.runAttemptId ?? '');
    sourceUserSeqs.push(opts.sourceUserSeq ?? 0);
    if (calls === 1) {
      // Dead turn: parse retries exhausted, apology summary, completedReason set.
      return { sessionId: opts.sessionId, status: 'completed', steps: 3, lastTurn: 3, completedReason: 'no_structured_output' };
    }
    assert.equal(
      listEvents(opts.sessionId, { types: ['conversation_completed'] }).length,
      0,
      'the failed first brain remains a private recovery candidate until fallover resolves',
    );
    return {
      sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1,
      lastDecision: { summary: 's', reply: 'recovered on the other brain', done: true, nextAction: 'completed', reason: null },
    };
  }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: run });

  const res = await respondViaHarness('webhook', {
    message: 'do the thing',
    sessionId: 'parse-exhaustion-fallover',
    runId: 'run:parse-exhaustion-fallover',
  });
  assert.equal(calls, 2, 'the dead turn must be re-run exactly once');
  assert.match(res.text, /recovered on the other brain/, 'the recovered reply ships, not the apology');
  assert.ok(models[1], 'the re-run pinned a modelOverride (the next brain)');
  assert.notEqual(models[1], models[0], 'the re-run must not use the same model');
  assert.ok(attemptIds.every(Boolean));
  assert.notEqual(attemptIds[0], attemptIds[1], 'parse recovery mints a fresh physical attempt');
  assert.equal(sourceUserSeqs[0], sourceUserSeqs[1], 'both attempts bind the same logical user turn');
  assert.equal(
    listEvents('parse-exhaustion-fallover', { types: ['user_input_received'] }).length,
    1,
    'parse recovery does not duplicate the user transcript row',
  );

  // And the guard: a re-run that ALSO dead-ends must NOT recurse.
  calls = 0;
  const alwaysDead = (async (opts: { sessionId: string }) => {
    calls += 1;
    if (calls === 2) {
      assert.equal(
        listEvents(opts.sessionId, { types: ['conversation_completed'] }).length,
        0,
        'the first exhausted attempt does not publish an early terminal',
      );
    }
    return { sessionId: opts.sessionId, status: 'completed', steps: 3, lastTurn: 3, completedReason: 'no_structured_output', lastDecision: { summary: 'apology', reply: null, done: true, nextAction: 'completed', reason: null } };
  }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: recordingBuilder, runConversation: alwaysDead });
  const deadEnd = await respondViaHarness('webhook', {
    message: 'do the thing',
    sessionId: 'parse-exhaustion-no-recurse',
  });
  assert.equal(calls, 2, 'exactly one recovery hop — never a loop');
  assert.doesNotMatch(deadEnd.text, /ask me|continue|retry|resume/i,
    'an exhausted cross-brain recovery closes factually instead of assigning a continuation to the user');
  const deadEndCompletions = listEvents('parse-exhaustion-no-recurse', { types: ['conversation_completed'] });
  assert.equal(deadEndCompletions.length, 1, 'the exhausted recovery commits one terminal');
  assert.equal(
    (deadEndCompletions[0].data.presentation as { status?: string }).status,
    'blocked',
  );
  assert.equal(
    (deadEndCompletions[0].data.presentation as { resumable?: unknown }).resumable,
    false,
  );
});

test('narration give-up is fallover-eligible; without fallover it ships the graceful copy, never a raw error', async () => {
  const { ClaudeSdkNarrationGiveUpError } = await import('./claude-agent-brain.js');
  const err = new ClaudeSdkNarrationGiveUpError('I started to turn that into an action but it did not go through as a real tool call. Say the word and I will run it properly.');
  // Eligible for the cross-brain re-run (zero tools ran ⇒ side-effect-safe).
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  assert.equal(isChatBrainFalloverEligible(err), true);
  // And the bridge's catch converts it to a graceful reply when fallover is unavailable
  // (kill-switch off ⇒ recoverChatBrainFailure returns null ⇒ text floor).
  process.env.CLEMMY_BRAIN_FALLOVER = 'off';
  try {
    assert.equal(isChatBrainFalloverEligible(err), false, 'fallover disabled');
    assert.equal((err as { narrationGiveUp?: boolean }).narrationGiveUp, true, 'floor marker present for the bridge catch');
    assert.match(err.message, /did not go through as a real tool call/);
  } finally {
    delete process.env.CLEMMY_BRAIN_FALLOVER;
  }
});

test('awaiting_user_input surfaces THE QUESTION (+ numbered options), never the "asked a question" summary', async () => {
  const sessionId = 'ask-question-visible';
  createSession({ id: sessionId, kind: 'chat' });
  appendEvent({
    sessionId, turn: 1, role: 'Clem', type: 'awaiting_user_input',
    data: { question: 'Which pipeline do you mean, and where should the update go?', options: ['Sales pipeline → email', 'Sales pipeline → Slack', 'Just clean it up'] },
  });
  const run = (async (opts: { sessionId: string }) => ({
    sessionId: opts.sessionId, status: 'awaiting_user_input', steps: 1, lastTurn: 1,
    lastDecision: { summary: 'Asked a clarifying question to identify the pipeline.', reply: null, done: false, nextAction: 'awaiting_user_input', reason: null },
  })) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: run });

  const res = await respondViaHarness('webhook', { message: 'clean up my pipeline and tell the team', sessionId });
  assert.match(res.text, /Which pipeline do you mean/, 'the user sees the actual question');
  assert.match(res.text, /1\. Sales pipeline → email/, 'options are numbered so a channel user can reply "1"');
  assert.ok(!/Asked a clarifying question to identify/.test(res.text), 'the internal summary never ships as the reply');
  assert.equal(res.stoppedReason, 'awaiting-input');

  // A decision whose reply ALREADY asks keeps its own wording (no override).
  const runWithReply = (async (opts: { sessionId: string }) => ({
    sessionId: opts.sessionId, status: 'awaiting_user_input', steps: 1, lastTurn: 1,
    lastDecision: { summary: 's', reply: 'Quick check — email or Slack?', done: false, nextAction: 'awaiting_user_input', reason: null },
  })) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: runWithReply });
  const res2 = await respondViaHarness('webhook', { message: 'again', sessionId });
  assert.equal(res2.text, 'Quick check — email or Slack?');
});

test('parse-exhaustion recovery is GATED on external writes — a run that committed a write ships the honest completion, never a blind re-run', async () => {
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  // The invariant (mirror of loop.ts step-boundary canSwitch): only rerun
  // across brains when the external_write count did not increase during the
  // run. If anything was sent/updated/created, re-driving the turn on another
  // brain could double-act — salvage or ask instead.
  const sessionId = 'parse-exhaustion-write-gate';
  createSession({ id: sessionId, kind: 'chat' });
  let calls = 0;
  const runThatWrites = (async (opts: { sessionId: string }) => {
    calls += 1;
    // A lifecycle success without a legacy external_write row must still block
    // replay; counting only the old event type was the fail-open bug.
    appendEvent({
      sessionId: opts.sessionId, turn: 1, role: 'system', type: 'external_write_succeeded',
      data: {
        callId: 'call-salesforce-update',
        canonicalCallId: 'call-salesforce-update',
        tool: 'composio_execute_tool',
        shapeKey: 'salesforce:update',
        targets: ['record:rec-42'],
      },
    });
    return {
      sessionId: opts.sessionId, status: 'completed', steps: 3, lastTurn: 3,
      completedReason: 'no_structured_output',
      lastDecision: { summary: 'apology', reply: null, done: true, nextAction: 'completed', reason: null },
    };
  }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: runThatWrites });
  const publicTerminals: Array<{ event: { type: string; data: Record<string, unknown> } }> = [];
  const detach = actionBus.subscribe((event) => {
    if (event.kind === 'harness.public_event'
      && event.sessionId === sessionId
      && event.event.type === 'conversation_completed') {
      publicTerminals.push(event);
    }
  });
  let res;
  try {
    res = await respondViaHarness('webhook', { message: 'update the account', sessionId });
  } finally {
    detach();
  }
  assert.equal(calls, 1, 'NO recovery hop — the run committed an external write');
  assert.match(res.text, /successful external write/i, 'the lifecycle success is reported instead of a blind re-run');
  assert.doesNotMatch(res.text, /apology/i, 'internal parse-exhaustion copy never becomes the reply');
  const writeGateCompletions = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(writeGateCompletions.length, 1, 'the blocked recovery commits one terminal');
  assert.equal(
    (writeGateCompletions[0].data.presentation as { status?: string }).status,
    'blocked',
  );
  assert.equal(
    (writeGateCompletions[0].data.presentation as { kind?: string }).kind,
    'blocked',
  );
  assert.equal(publicTerminals.length, 1, 'the typed blocked terminal publishes once');

  // Control: the SAME dead turn with no external write still recovers.
  const sessionId2 = 'parse-exhaustion-no-write-recovers';
  createSession({ id: sessionId2, kind: 'chat' });
  let calls2 = 0;
  const cleanDeadThenRecover = (async (opts: { sessionId: string }) => {
    calls2 += 1;
    if (calls2 === 1) {
      return { sessionId: opts.sessionId, status: 'completed', steps: 3, lastTurn: 3, completedReason: 'no_structured_output' };
    }
    assert.equal(
      listEvents(opts.sessionId, { types: ['conversation_completed'] }).length,
      0,
      'a clean fallover also has no terminal before the recovered brain answers',
    );
    return {
      sessionId: opts.sessionId, status: 'completed', steps: 1, lastTurn: 1,
      lastDecision: { summary: 's', reply: 'recovered cleanly', done: true, nextAction: 'completed', reason: null },
    };
  }) as never;
  _setBridgeImplsForTests({ configure: okConfigure, buildAgent: fakeAgentBuilder, runConversation: cleanDeadThenRecover });
  const res2 = await respondViaHarness('webhook', { message: 'update the account', sessionId: sessionId2 });
  assert.equal(calls2, 2, 'clean dead turn still gets the recovery hop');
  assert.match(res2.text, /recovered cleanly/);
});

test('parse-exhaustion recovery fails closed when its lifecycle ledger baseline is unreadable', async () => {
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'parse-exhaustion-ledger-unreadable';
  let calls = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    recoveryListEvents: (() => {
      throw new Error('event ledger unavailable');
    }) as never,
    runConversation: (async () => {
      calls += 1;
      return {
        sessionId,
        status: 'completed',
        steps: 3,
        lastTurn: 3,
        completedReason: 'no_structured_output',
      };
    }) as never,
  });

  const response = await respondViaHarness('webhook', {
    message: 'update the account',
    sessionId,
  });

  assert.equal(calls, 1, 'an unreadable safety ledger cannot authorize a replay');
  assert.equal(response.stoppedReason, 'blocked');
  assert.match(response.text, /could not verify the external-write ledger/i);
  assert.equal((response.raw as { recoverySkipped?: string }).recoverySkipped, 'ledger_unreadable');
  const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal((terminals[0].data.presentation as { status?: string }).status, 'blocked');
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
});

test('always-reports-back: synthesizeCompletedWorkReport describes external writes when the model emitted no reply', () => {
  resetEventLog();
  const sessionId = 'report-back-session';
  createSession({ id: sessionId, kind: 'chat', title: 'report back' });
  // Two real writes committed this turn, then a structure-less completion.
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: ['casey@example.com'] } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'AIRTABLE_CREATE_RECORD', toolName: 'composio_execute_tool', targets: [] } });

  const report = synthesizeCompletedWorkReport(sessionId, 0);
  assert.ok(report, 'a report is produced when writes exist and the reply is empty');
  assert.match(report!, /here's what I did/i);
  assert.match(report!, /Sent a message to casey@example\.com/);
  assert.match(report!, /Created a record/);

  // Effect-anchored + general: a Slack send and a draft-creation read correctly, no tool names leak.
  assert.doesNotMatch(report!, /OUTLOOK|AIRTABLE|composio/i);

  // Nothing durable to report → null (a pure ack is not force-reported).
  assert.equal(synthesizeCompletedWorkReport(sessionId, 2), null);
});

// ─── The dispatched reply is the model's voice, not a template ───────────────
//
// The dispatch ACK used to deliver only the projection's canned line, and the
// model's actual closing message for that turn was discarded. Observed
// 2026-08-25: the discarded message warned "this workflow has been
// blocking/cancelling repeatedly today…" — replaced by boilerplate. Composed
// from durable turn_ended events only, so a restart replay derives identical
// text; the words must never ride on the async_work_dispatched event itself,
// which is deep-strict-equal-checked against its replay winner.
test('a dispatched turn delivers the model\'s own words, with the canned line as floor', () => {
  const sessionId = 'sess-dispatch-voice';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'run my weekly review' },
  });
  appendEvent({
    sessionId, turn: 1, role: 'Clem', type: 'turn_ended',
    data: { output: 'Kicked off weekly-review — heads up, it has been blocking repeatedly today.' },
  });
  // A later turn_ended with no output (the host emits one) must not erase the words.
  appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'turn_ended', data: { items: 3 } });

  const composed = composeDispatchedReplyText(source, 'Started — canned.');
  assert.equal(
    composed,
    'Kicked off weekly-review — heads up, it has been blocking repeatedly today.',
  );

  // No words recorded → the ACK floor holds.
  const bare = appendEvent({
    sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'run it again' },
  });
  assert.equal(composeDispatchedReplyText(bare, 'Started — canned.'), 'Started — canned.');
});
