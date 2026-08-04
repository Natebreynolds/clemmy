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
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TEST_HOME = '/tmp/clemmy-test-respond-bridge';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const {
  respondPreferHarness,
  respondViaHarness,
  harnessSurfaceEnabled,
  isChatBrainFalloverEligible,
  synthesizeCompletedWorkReport,
  _setBridgeImplsForTests,
} = await import('./respond-bridge.js');
// eslint-disable-next-line import/first
const {
  appendEvent,
  beginRunAttempt,
  createSession,
  finishRunAttempt,
  getLatestRunAttempt,
  getSession,
  listEvents,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('./eventlog.js');
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
const { turnOutcomeId } = await import('./turn-outcome.js');
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
const {
  clearRunInFlightAfterTerminal,
  recoverInterruptedChatRuns,
} = await import('./restart-recovery.js');
// eslint-disable-next-line import/first
const { finalizePreparedWorkflowDispatchForSource } = await import('./loop.js');
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

function fakeRun(result: Record<string, unknown>): never {
  return (async (opts: { sessionId: string; buildAgent?: () => Promise<unknown> }) => {
    // Capability interior contract: the real runConversation resolves the
    // agent AT the capability_resolve node. The stub mirrors that, so tests
    // asserting builder arguments keep asserting the true call, at its true
    // time — during the turn, not before it.
    await opts.buildAgent?.();
    return {
      sessionId: opts.sessionId,
      steps: 1,
      lastTurn: 1,
      ...result,
    };
  }) as never;
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
  process.env.AUTH_MODE = 'api_key';
});

after(() => {
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

test('home + dashboard ride the gated loop by default; the kill-switch blocks unless legacy fallback is explicit', async () => {
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
    assert.equal(res.stoppedReason, 'error');
    assert.match(res.text, /runtime lane is temporarily unavailable/i);
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

test('respondPreferHarness: kill-switch blocks by default, legacy fallback requires explicit break-glass', async () => {
  process.env.CLEMMY_HARNESS_CRON = 'off';
  let legacyCalled = 0;
  const res = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-t1' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 0);
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /runtime lane is temporarily unavailable/i);

  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  const legacy = await respondPreferHarness('cron', { message: 'hi', sessionId: 'bridge-t1-legacy' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 1);
  assert.equal(legacy.text, 'legacy');
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

  assert.equal(res.stoppedReason, 'error');
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
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /requested tool boundary is not supported/i);
});

test('respondPreferHarness: harness auth unavailable blocks by default instead of falling back to legacy', async () => {
  _setBridgeImplsForTests({ configure: (async () => ({ ok: false, reason: 'no auth' })) as never });
  let legacyCalled = 0;
  const res = await respondPreferHarness('webhook', { message: 'hi', sessionId: 'bridge-t3' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });
  assert.equal(legacyCalled, 0);
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /no model runtime is connected/i);
  assert.doesNotMatch(res.text, /no auth/i, 'provider diagnostics stay out of public copy');
});

test('respondPreferHarness: Claude auth + SDK brain opt-in routes chat through Claude Agent SDK brain', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  let legacyCalled = 0;
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => { runConversationCalled += 1; return { status: 'completed' }; }) as never,
    claudeAgentBrain: (async (_surface, req) => ({
      text: 'claude sdk brain',
      sessionId: req.sessionId,
      stoppedReason: 'success',
    })) as never,
  });

  const res = await respondPreferHarness('home', { message: 'hi', sessionId: 'claude-brain-route' }, async (req) => {
    legacyCalled += 1;
    return { text: 'legacy', sessionId: req.sessionId };
  });

  assert.equal(res.text, 'claude sdk brain');
  assert.equal(legacyCalled, 0);
  assert.equal(runConversationCalled, 0, 'Claude SDK brain is a distinct route from the OpenAI SDK runner');
});

test('active-Claude cron dispatches through the tool-capable SDK lane', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let sdkCalls = 0;
  let harnessCalls = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async () => { harnessCalls += 1; return { status: 'completed' }; }) as never,
    claudeAgentBrain: (async () => {
      sdkCalls += 1;
      return { text: 'cron complete', raw: { transport: 'claude_agent_sdk_brain', model: 'claude-sonnet-4-6', mode: 'full' } };
    }) as never,
  });

  const res = await respondPreferHarness('cron', { message: 'run scheduled sync', sessionId: 'cron-sdk-route' }, async () => ({ text: 'legacy' }));
  assert.equal(res.text, 'cron complete');
  assert.equal(res.route?.routeKind, 'claude_agent_sdk_brain');
  assert.equal(sdkCalls, 1);
  assert.equal(harnessCalls, 0, 'cron never falls into the tool-bearing headless harness');
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

test('respondPreferHarness: Discord and Slack are first-class chat bridge surfaces', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const seenSurfaces: string[] = [];
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'completed' }),
    claudeAgentBrain: (async (surface, req) => {
      seenSurfaces.push(surface);
      return { text: `claude:${surface}`, sessionId: req.sessionId, stoppedReason: 'success' };
    }) as never,
  });

  const discord = await respondPreferHarness('discord', { message: 'hi', sessionId: 'discord-bridge' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));
  const slack = await respondPreferHarness('slack', { message: 'hi', sessionId: 'slack-bridge' }, async (req) => ({ text: 'legacy', sessionId: req.sessionId }));

  assert.equal(discord.text, 'claude:discord');
  assert.equal(slack.text, 'claude:slack');
  assert.deepEqual(seenSurfaces, ['discord', 'slack']);
});

test('respondPreferHarness: Claude SDK brain relays harness tool/progress events to legacy callbacks', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const seenTools: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const seenReasoning: string[] = [];
  _setBridgeImplsForTests({
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

test('respondPreferHarness: Claude SDK brain opt-in routes background, while workflow stays on its dedicated path', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const claudeBrainSurfaces: string[] = [];
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: (async (opts: { sessionId: string }) => {
      runConversationCalled += 1;
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

  assert.equal(background.text, 'claude');
  assert.equal(workflow.text, 'harness');
  assert.equal(runConversationCalled, 1);
  assert.deepEqual(claudeBrainSurfaces, ['background']);
});

test('Claude SDK brain overload (uncommitted) falls the turn over to the harness brain (Codex→GLM)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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

test('Claude SDK brain fallover forces a non-Claude harness model when one is configured', async () => {
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
      configure: okConfigure,
      buildAgent: (async (opts: { model?: string }) => {
        capturedModel = opts.model;
        return FAKE_AGENT;
      }) as never,
      runConversation: (async (opts: { sessionId: string; buildAgent?: () => Promise<unknown> }) => (await opts.buildAgent?.(), {
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

test('Claude SDK brain UNPARSEABLE-TOOL-CALL (parse failure) also falls the turn over to the harness brain', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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

test('Claude SDK uncommitted fallover reuses the pre-recorded user input row', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const runId = 'run:fallover-reuse';
  let claudeAttemptId = '';
  let claudeSourceUserSeq = 0;
  let harnessAttemptId = '';
  let harnessSourceUserSeq = 0;
  _setBridgeImplsForTests({
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

test('a Claude exception after logical terminal commit returns that winner and never dispatches fallback', async () => {
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

test('Claude SDK brain overload AFTER committing reduces to one safe failed terminal without a double-act', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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

test('generic Claude terminal error after an Airtable write is salvaged without whole-turn fallover', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-generic-write-gate';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /Created a record/);
  assert.match(res.text, /did not rerun/i);
  assert.doesNotMatch(res.text, /blind rerun/);
});

test('blocked Claude recovery clears the in-flight marker only after its typed terminal commits', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-marker-after-blocked-terminal';
  const runId = 'run:marker-after-blocked-terminal';
  const { markRunInFlight } = await import('./restart-recovery.js');
  const { HarnessSession } = await import('./session.js');
  let markerWasArmedAtPublication = false;
  _setBridgeImplsForTests({
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
      });
      markRunInFlight(req.sessionId, true);
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
    assert.equal(response.stoppedReason, 'error');
  } finally {
    detach();
  }
  assert.equal(markerWasArmedAtPublication, true, 'terminal durability happens before marker cleanup');
  assert.equal(HarnessSession.load(sessionId)?.runInFlightSince(), null);
});

test('whole-turn recovery allows fallover after the exact call records a proven-no-dispatch failure', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-exact-failed-write';
  createSession({ id: sessionId, kind: 'chat', title: 'failed before dispatch' });
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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

test('whole-turn recovery blocks fallover when a sibling failure does not settle the reservation', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-sibling-failed-write';
  createSession({ id: sessionId, kind: 'chat', title: 'mismatched failure' });
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /did not rerun/i);
});

test('whole-turn recovery blocks fallover after an exact orphaned write', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-exact-orphaned-write';
  createSession({ id: sessionId, kind: 'chat', title: 'orphaned write' });
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /could not confirm|uncertain/i);
  assert.match(res.text, /did not rerun/i);
});

test('whole-turn recovery salvage carries orphan evidence and never fabricates write success', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-orphaned-write-truth';
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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

test('whole-turn recovery uses a per-attempt write baseline, so an old write does not block a clean generic-error fallover', async () => {
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

test('whole-turn recovery fails closed when the attempt write ledger cannot be checked', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const sessionId = 'fallover-ledger-unreadable';
  createSession({ id: sessionId, kind: 'chat', title: 'ledger unavailable' });
  let ledgerReads = 0;
  let runConversationCalled = 0;
  _setBridgeImplsForTests({
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
  assert.equal(res.stoppedReason, 'error');
  assert.match(res.text, /could not verify the external-write ledger/i);
  assert.match(res.text, /did not rerun/i);
  assert.equal((res.raw as { recoverySkipped?: string }).recoverySkipped, 'ledger_unreadable');
});

test('CLEMMY_BRAIN_FALLOVER=off disables the chat-brain fallover (overload surfaces)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'off';
  _setBridgeImplsForTests({
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

test('a corrupt typed terminal winner suppresses duplicate recovery publication and exposes no raw detail', async () => {
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

  await assert.rejects(
    respondViaHarness('webhook', { message: 'run once', sessionId }),
    (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : String(error), PUBLIC_RUN_FAILURE_TEXT);
      return true;
    },
  );
  assert.equal(
    listEvents(sessionId, { types: ['conversation_completed'] }).length,
    1,
    'the corrupt typed winner is never reinterpreted or followed by a duplicate terminal',
  );
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
  assert.equal(res.route?.transport, 'openai_agents_harness');
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
    async (recoveredSessionId, _directive, sourceUserSeq) => {
      assert.equal(recoveredSessionId, sessionId);
      assert.equal(sourceUserSeq, source.seq);
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

test('respondPreferHarness: Claude wrapper preserves a record-before-preparation admission for exact restart', async () => {
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
      async (recoveredSessionId, _directive, sourceUserSeq) => {
        assert.equal(recoveredSessionId, sessionId);
        assert.equal(sourceUserSeq, source.seq);
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
  assert.equal(res.route?.transport, 'openai_agents_harness');
  assert.equal(res.route?.mode, 'all_in');

  const routed = listEvents('route-gpt-shaped-byo', { types: ['turn_model_routed'] });
  assert.equal(routed.length, 1);
  assert.deepEqual(routed[0].data, {
    model: 'gpt-4o',
    provider: 'byo',
    transport: 'openai_agents_harness',
    mode: 'all_in',
    routeKind: 'harness',
    surface: 'home',
  });
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
  _setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    runConversation: fakeRun({ status: 'awaiting_approval', lastDecision: null }),
  });
  const res = await respondViaHarness('background', { message: 'do it', sessionId: 'bridge-t6' });
  assert.equal(res.stoppedReason, 'pending-approval');
  assert.match(res.text, /approval/i);
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
  const run = (async (opts: { sessionId: string; runAttemptId?: string; sourceUserSeq?: number; buildAgent?: () => Promise<unknown> }) => {
    // Contract mirror: capability resolves during the turn.
    await opts.buildAgent?.();
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
  await respondViaHarness('webhook', { message: 'do the thing', sessionId: 'parse-exhaustion-no-recurse' });
  assert.equal(calls, 2, 'exactly one recovery hop — never a loop');
  const deadEndCompletions = listEvents('parse-exhaustion-no-recurse', { types: ['conversation_completed'] });
  assert.equal(deadEndCompletions.length, 1, 'the exhausted recovery commits one terminal');
  assert.equal(
    (deadEndCompletions[0].data.presentation as { status?: string }).status,
    'blocked',
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
  assert.equal(response.stoppedReason, 'error');
  assert.match(response.text, /could not verify the external-write ledger/i);
  assert.equal((response.raw as { recoverySkipped?: string }).recoverySkipped, 'ledger_unreadable');
  const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal((terminals[0].data.presentation as { status?: string }).status, 'blocked');
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
