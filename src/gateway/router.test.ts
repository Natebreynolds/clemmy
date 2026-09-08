/**
 * Run: npx tsx --test src/gateway/router.test.ts
 *
 * Focused tests for the cross-channel gateway wrapper. Fresh interactive turns
 * enter an injected host_v1 activation; a throwing assistant stub proves the
 * legacy responder cannot reacquire chat ownership.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { BoundaryJudgeRouting } from '../runtime/harness/debate-model.js';
import type {
  TerminalDeliveryJudgePort,
  TerminalDeliveryJudgeRequest,
} from '../runtime/harness/terminal-delivery-judge.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-gateway-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
process.env.CLEMMY_VERIFY_DELIVERED = 'on';

const { ClementineGateway } = await import('./router.js');
const {
  appendEvent,
  beginRunAttempt,
  createSession,
  getActiveRunAttempt,
  getRunAttemptBySourceUserSeq,
  closeEventLog,
  interruptForeignRunAttemptLeases,
  interruptOrphanedRunAttemptsAtBoot,
  openEventLog,
  getSession,
  listEvents,
  recordRunAttemptUserInput,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const { workflowOwnedUnfinishedAttemptIds } = await import('../runtime/harness/accepted-source-outcome.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const {
  presentationEventFromCompletionData,
  turnOutcomeId,
} = await import('../runtime/harness/turn-outcome.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { exactOriginDeliveryTargetDigest } = await import('../runtime/exact-origin-delivery.js');
const {
  PUBLIC_RUN_FAILURE_TEXT,
  publicAsyncWorkDispatchedData,
  publicUserInputText,
} = await import('../runtime/harness/public-presentation.js');
const { getRun } = await import('../runtime/run-events.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  createWorkflowChatDispatchPreparationAuthority,
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupClosedBatch,
} = await import('../execution/workflow-origin-group.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  markBackgroundTaskAwaitingContinue,
  markBackgroundTaskAwaitingInput,
} = await import('../execution/background-tasks.js');

afterEach(() => {
  resetEventLog();
  _setBridgeImplsForTests({});
  process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  process.env.CLEMMY_VERIFY_DELIVERED = 'on';
  delete process.env.CLEMMY_TURN_ENGINE;
});

test.after(() => {
  resetEventLog();
  _setBridgeImplsForTests({});
  delete process.env.CLEMMY_HARNESS_WEBHOOK;
  delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  delete process.env.CLEMMY_VERIFY_DELIVERED;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function appendActiveWorkflowDispatch(
  source: import('../runtime/harness/eventlog.js').EventRow,
  runId: string,
) {
  const replyTarget = source.data.originReplyTarget as import('../runtime/exact-origin-delivery.js').ExactOriginDeliveryTarget;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'gateway-dispatch-test',
    status: 'awaiting_chat_dispatch_seal',
  }), 'utf-8');
  const authority = createWorkflowChatDispatchPreparationAuthority({
    runId,
    observer: { sessionId: source.sessionId, sourceUserSeq: source.seq, replyTarget },
    queueRequestDigest: createHash('sha256').update(`gateway-dispatch:${runId}`).digest('hex'),
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
  return appendEvent({
    sessionId: source.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatched',
    parentEventId: source.id,
    data: { ...active.publicDispatch, replyTarget: active.sealed.replyTarget },
  });
}

function commitAnswerForSource(
  source: import('../runtime/harness/eventlog.js').EventRow,
  text: string,
) {
  const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
  return commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
  }, { legacyReason: 'gateway_dispatch_test_terminal' });
}

interface HostGatewayRunOptionsForTest {
  sessionId: string;
  input: string;
  sourceUserSeq?: number;
  turnEngine?: string;
}

function acceptedHostSource(options: HostGatewayRunOptionsForTest) {
  const source = listEvents(options.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === options.sourceUserSeq);
  assert.ok(source, 'host activation owns the exact gateway-accepted source');
  return source;
}

function installHostGatewayRunForTest(
  run: (options: HostGatewayRunOptionsForTest) => Promise<Record<string, unknown>>,
): void {
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: run as never,
  });
}

function hostGatewayForTest(
  run: (options: HostGatewayRunOptionsForTest) => Promise<Record<string, unknown>>,
  options: ConstructorParameters<typeof ClementineGateway>[1] = {},
) {
  let legacyCalls = 0;
  installHostGatewayRunForTest(run);
  return {
    gateway: new ClementineGateway({
      async respond() {
        legacyCalls += 1;
        throw new Error('fresh gateway chat must not dispatch the legacy assistant');
      },
    } as never, options),
    legacyCalls: () => legacyCalls,
  };
}

async function completedHostAnswer(
  options: HostGatewayRunOptionsForTest,
  text: string,
  input: { commitTerminal?: boolean } = {},
): Promise<Record<string, unknown>> {
  const source = acceptedHostSource(options);
  const committed = input.commitTerminal === false ? null : commitAnswerForSource(source, text);
  return {
    sessionId: options.sessionId,
    status: 'completed',
    steps: 1,
    lastTurn: source.turn,
    lastDecision: { reply: text },
    ...(committed ? { publicPresentation: committed.presentation } : {}),
  };
}

function gatewayTerminalJudge(output: unknown, failure?: Error): {
  port: TerminalDeliveryJudgePort;
  runCalls(): number;
  request(): TerminalDeliveryJudgeRequest | null;
} {
  const route: BoundaryJudgeRouting = {
    model: {} as BoundaryJudgeRouting['model'],
    modelId: 'claude-haiku-4-5',
    judgeFamily: 'claude',
    brainFamily: 'codex',
    transport: 'claude_subscription',
    selfJudge: false,
  };
  let runs = 0;
  let seen: TerminalDeliveryJudgeRequest | null = null;
  return {
    port: {
      async resolveRoute() { return route; },
      async run(request) {
        runs += 1;
        seen = request;
        if (failure) throw failure;
        return output;
      },
    },
    runCalls: () => runs,
    request: () => seen,
  };
}

test('bare continue after an awaiting_continue completion is rewritten with prior summary context', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Mobile loop' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'awaiting_continue',
      lastDecisionSummary: 'Finished discovery; keep working until the final outreach list is drafted.',
      reply: 'Reply `continue` to keep going.',
    },
  });

  let capturedMessage = '';
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    capturedMessage = options.input;
    return completedHostAnswer(options, 'continued');
  });

  const response = await gateway.handleMessage({
    message: 'continue',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-literal-continue',
  });

  assert.equal(response.text, 'continued');
  assert.equal(response.queuedTaskId, undefined, 'synthetic continuation prompt must not be promoted to background');
  assert.match(capturedMessage, /previous turn/);
  assert.match(capturedMessage, /do not restart/i);
  assert.match(capturedMessage, /Finished discovery; keep working until/);
  assert.equal(legacyCalls(), 0);
  const accepted = listEvents(session.id, { types: ['user_input_received'] });
  assert.equal(accepted.length, 1);
  assert.equal(publicUserInputText(accepted[0].data), 'continue');
  assert.equal(accepted[0].data.text, 'continue', 'expanded continuation directive stays private model input');
  const terminal = listEvents(session.id, { types: ['conversation_completed'], desc: true })
    .find((event) => event.data.sourceUserSeq === accepted[0].seq)!;
  assert.equal(terminal.data.terminalKey, `turn:${accepted[0].seq}`);
  assert.equal(presentationEventFromCompletionData(terminal.data)?.identity.sourceUserSeq, accepted[0].seq);
});

test('gateway command is one accepted turn with one replay-safe typed terminal', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Gateway command' });
  let respondCalls = 0;
  const gateway = new ClementineGateway({
    respond: async (req: { sessionId: string }) => {
      respondCalls += 1;
      return { text: 'model should not run', sessionId: req.sessionId };
    },
  } as never);
  const request = {
    message: 'tasks',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile' as const,
    runId: 'run-gateway-command-replay',
  };

  const first = await gateway.handleMessage(request);
  const replay = await gateway.handleMessage(request);

  assert.equal(respondCalls, 0);
  assert.equal(replay.text, first.text);
  const users = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = listEvents(session.id, { types: ['conversation_completed'] });
  assert.equal(users.length, 1);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.terminalKey, `turn:${users[0].seq}`);
  assert.equal(presentationEventFromCompletionData(terminals[0].data)?.status, 'done');
});

test('accepted host gateway exception reduces to one stable failed terminal', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Gateway failure' });
  const privateDetail = 'provider leaked bearer-secret-123';
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    acceptedHostSource(options);
    throw new Error(privateDetail);
  });

  const response = await gateway.handleMessage({
    message: 'trigger the provider failure',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-stable-failure',
  });

  assert.equal(response.text, PUBLIC_RUN_FAILURE_TEXT);
  assert.equal(response.stoppedReason, 'error');
  assert.equal(response.sessionId, session.id);
  assert.equal(response.terminal?.status, 'failed');
  assert.equal(legacyCalls(), 0);
  const [accepted] = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = listEvents(session.id, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  const presentation = presentationEventFromCompletionData(terminals[0].data);
  assert.equal(terminals[0].data.terminalKey, `turn:${accepted.seq}`);
  assert.equal(presentation?.status, 'failed');
  assert.equal(presentation?.text, PUBLIC_RUN_FAILURE_TEXT);
  assert.doesNotMatch(JSON.stringify(terminals[0].data), /bearer-secret-123/);
});

test('late gateway terminal A does not clear newer attempt B restart coverage', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Gateway overlap' });
  let releaseA!: () => void;
  let enteredA!: () => void;
  const aEntered = new Promise<void>((resolve) => { enteredA = resolve; });
  const aReleased = new Promise<void>((resolve) => { releaseA = resolve; });
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    enteredA();
    await aReleased;
    return completedHostAnswer(options, 'A finished late.');
  });

  const lateA = gateway.handleMessage({
    message: 'run A',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-overlap-a',
  });
  await aEntered;
  const attemptB = beginRunAttempt(session.id, { runId: 'run-gateway-overlap-b' });
  recordRunAttemptUserInput(attemptB, {
    turn: 2,
    role: 'user',
    data: { text: 'run B', displayText: 'run B' },
  }, { armRunInFlight: true });

  releaseA();
  await lateA;
  assert.equal(legacyCalls(), 0);
  assert.equal(getActiveRunAttempt(session.id)?.attemptId, attemptB.attemptId);
  assert.ok(HarnessSession.load(session.id)?.runInFlightSince(), 'B retains restart coverage');
});

test('bare continue without a limit completion remains a normal user message', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Mobile loop' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'success', reply: 'All done.' },
  });

  let capturedMessage = '';
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    capturedMessage = options.input;
    return completedHostAnswer(options, 'normal');
  });

  await gateway.handleMessage({
    message: 'continue',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });

  assert.equal(capturedMessage, 'continue');
  assert.equal(legacyCalls(), 0);
});

test('gateway routes parked background question replies before any model run', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Mobile background question' });
  const task = createBackgroundTask({
    title: 'Segment prospects',
    prompt: 'finish segmenting prospects',
    originSessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });
  markBackgroundTaskAwaitingInput(task.id, 'q-gateway-bg', 'Which segment?');

  let respondCalled = false;
  const gateway = new ClementineGateway({
    respond: async (req: { sessionId: string }) => {
      respondCalled = true;
      return { text: 'foreground', sessionId: req.sessionId };
    },
  } as never);

  // Step 1: the gateway does NOT silently apply the message — it CONFIRMS first, surfacing
  // the parked task + its question, without running the model.
  const ask = await gateway.handleMessage({
    message: 'healthcare only',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });
  assert.equal(respondCalled, false, 'no model run — the parked task is surfaced first');
  assert.equal(ask.handledControl, true);
  assert.match(ask.text, /background task "Segment prospects" is paused/);
  assert.match(ask.text, /Which segment\?/, 'the parked question is shown');
  assert.match(ask.text, /Reply \*\*yes\*\* to apply/);
  // NOT applied yet — still awaiting the user's confirmation.
  assert.equal(getBackgroundTask(task.id)?.status, 'awaiting_input');
  assert.equal(getBackgroundTask(task.id)?.inputResolution, undefined);

  // Step 2: the user confirms → the ORIGINAL message is applied as the answer.
  const applied = await gateway.handleMessage({
    message: 'yes',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });
  assert.equal(respondCalled, false);
  assert.equal(applied.handledControl, true);
  assert.equal(applied.queuedTaskId, task.id);
  assert.match(applied.text, /sent "healthcare only" to your background task/);
  const stored = getBackgroundTask(task.id);
  assert.equal(stored?.status, 'pending');
  assert.equal(stored?.inputResolution?.answer, 'healthcare only');
});

test('gateway parked reply: declining leaves the task paused and does NOT re-nag on the next message', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Decline path' });
  const task = createBackgroundTask({
    title: 'Segment prospects', prompt: 'finish segmenting', originSessionId: session.id, channel: 'mobile', source: 'mobile',
  });
  markBackgroundTaskAwaitingInput(task.id, 'q-decline', 'Which segment?');

  let hostCalls = 0;
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    hostCalls += 1;
    return completedHostAnswer(options, 'foreground');
  });
  const opts = { sessionId: session.id, channel: 'mobile' as const, source: 'mobile' as const };

  // First unrelated message → asks to confirm.
  const ask = await gateway.handleMessage({ message: 'what is the weather', ...opts });
  assert.match(ask.text, /paused waiting on you/);
  // Decline (a non-yes reply) → the task stays paused, the message is handled normally.
  const declined = await gateway.handleMessage({ message: 'no, something else', ...opts });
  assert.equal(declined.handledControl ?? false, false, 'decline falls through to the model');
  assert.equal(hostCalls, 1, 'the declined message reached the foreground host turn');
  assert.equal(getBackgroundTask(task.id)?.status, 'awaiting_input', 'task still parked');
  // A FURTHER message must NOT re-nag about the same parked question.
  const next = await gateway.handleMessage({ message: 'tell me a joke', ...opts });
  assert.equal(next.handledControl ?? false, false, 'no re-ask for the already-declined question');
  assert.equal(hostCalls, 2);
  assert.equal(legacyCalls(), 0);
});

test('gateway bare continue prioritizes a parked background continuation', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Mobile background continue' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'awaiting_continue',
      lastDecisionSummary: 'Harness foreground continuation should not win.',
      reply: 'Reply `continue` to keep going.',
    },
  });
  const task = createBackgroundTask({
    title: 'Long report',
    prompt: 'continue the report',
    originSessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });
  markBackgroundTaskAwaitingContinue(task.id, 'turn budget', 'partial work');

  let respondCalled = false;
  const gateway = new ClementineGateway({
    respond: async (req: { sessionId: string }) => {
      respondCalled = true;
      return { text: 'foreground', sessionId: req.sessionId };
    },
  } as never);

  const response = await gateway.handleMessage({
    message: 'continue',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });

  assert.equal(respondCalled, false);
  assert.equal(response.handledControl, true);
  assert.equal(response.queuedTaskId, task.id);
  assert.match(response.text, /Continuing background task "Long report"/);
  const stored = getBackgroundTask(task.id);
  assert.equal(stored?.status, 'pending');
  assert.ok(stored?.continueResolution, 'continue request should be queued on the background task');
});

for (const message of ['Continue.', 'keep going!']) {
  test(`gateway ${JSON.stringify(message)} prioritizes a parked background continuation`, async () => {
    const session = createSession({
      kind: 'chat',
      channel: 'mobile',
      title: `Mobile punctuated background continue: ${message}`,
    });
    const task = createBackgroundTask({
      title: 'Punctuated long report',
      prompt: 'continue the report',
      originSessionId: session.id,
      channel: 'mobile',
      source: 'mobile',
    });
    markBackgroundTaskAwaitingContinue(task.id, 'turn budget', 'partial work');

    let respondCalled = false;
    const gateway = new ClementineGateway({
      respond: async (req: { sessionId: string }) => {
        respondCalled = true;
        return { text: 'foreground', sessionId: req.sessionId };
      },
    } as never);

    const response = await gateway.handleMessage({
      message,
      sessionId: session.id,
      channel: 'mobile',
      source: 'mobile',
    });

    assert.equal(respondCalled, false, 'the foreground model must not win continuation precedence');
    assert.equal(response.handledControl, true);
    assert.equal(response.queuedTaskId, task.id);
    assert.equal(getBackgroundTask(task.id)?.status, 'pending');
    assert.ok(getBackgroundTask(task.id)?.continueResolution);
  });
}

test('gateway keeps an INFERRED pipeline in the conversation, and backgrounds a named one', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'CRM enrichment' });
  let hostCalled = false;
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    hostCalled = true;
    return completedHostAnswer(options, 'foreground');
  });

  const response = await gateway.handleMessage({
    message: 'Pull full data from Salesforce via the CLI, then scrape all of it with Apify MCP, run subagents for 5 different actors including Google reviews, SEO data, and lead info, then add the results to my Airtable CRM via MCP.',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });

  // Shape alone is Clementine's inference, not the user's instruction. Live
  // 2026-08-03: a request of exactly this shape was dispatched unattended
  // without ever asking what it needed, then spent twelve minutes acting on
  // guesses. It stays in the conversation now, where the turn can align first.
  assert.equal(hostCalled, true, 'an inferred pipeline should stay in the host conversation');
  assert.equal(response.queuedTaskId, undefined, 'an inferred pipeline must not auto-dispatch');

  // Naming the lane is an instruction, and it is still honoured immediately.
  hostCalled = false;
  const named = await gateway.handleMessage({
    message: 'Run this in the background: Pull full data from Salesforce via the CLI, then scrape all of it with Apify MCP, then add the results to my Airtable CRM via MCP.',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
  });
  assert.equal(hostCalled, false, 'a named background lane should skip the foreground run');
  assert.equal(legacyCalls(), 0);
  assert.ok(named.queuedTaskId, 'a durable background task should be queued');
  assert.match(named.text, /background task/i);

  const task = getBackgroundTask(named.queuedTaskId!);
  assert.ok(task, 'queued task should be persisted');
  assert.equal(task!.originSessionId, session.id);
  assert.equal(task!.source, 'mobile');
  assert.match(task!.prompt, /Salesforce/);
  assert.match(task!.prompt, /Airtable CRM/);
});

test('gateway keeps simple replies with negated background instructions in foreground', async () => {
  const session = createSession({ kind: 'chat', channel: 'webhook', title: 'Smoke test' });
  let hostCalled = false;
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    hostCalled = true;
    return completedHostAnswer(options, 'HOTPATCH_SMOKE_OK');
  });

  const response = await gateway.handleMessage({
    message: 'Reply exactly HOTPATCH_SMOKE_OK. Do not call tools, send messages, modify files, or start background tasks.',
    sessionId: session.id,
    channel: 'webhook',
    source: 'webhook',
  });

  assert.equal(hostCalled, true, 'foreground host chat run should handle the simple reply');
  assert.equal(legacyCalls(), 0);
  assert.equal(response.queuedTaskId, undefined, 'negated background wording must not queue a durable task');
  assert.equal(response.text, 'HOTPATCH_SMOKE_OK');
});

test('gateway explicit "move this to the background" with task skips foreground execution', async () => {
  const sessionId = 'gateway-explicit-background-origin';
  assert.equal(getSession(sessionId), null, 'precondition: origin session is not already registered');
  let respondCalled = false;
  const gateway = new ClementineGateway({
    respond: async (req: { sessionId: string }) => {
      respondCalled = true;
      return { text: 'foreground', sessionId: req.sessionId };
    },
  } as never);

  const response = await gateway.handleMessage({
    message: 'Live validation only: move this to the background. Read the top-level files and summarize them.',
    sessionId,
    channel: 'webhook',
    source: 'webhook',
  });

  assert.equal(respondCalled, false, 'foreground chat run should be skipped for explicit background handoff');
  assert.ok(response.queuedTaskId, 'a durable background task should be queued');

  const task = getBackgroundTask(response.queuedTaskId!);
  assert.ok(task, 'queued task should be persisted');
  assert.equal(task!.originSessionId, sessionId);
  assert.equal(task!.source, 'webhook');
  assert.match(task!.prompt, /^Read the top-level files and summarize them\./);
  assert.doesNotMatch(task!.prompt, /move this to the background/i);

  const origin = getSession(sessionId);
  assert.equal(origin?.kind, 'chat', 'queued-only background origin is registered as a harness chat session');
  const [originTurn] = listEvents(sessionId, { types: ['user_input_received'], limit: 5, desc: true });
  assert.ok(originTurn);
  assert.match(String((originTurn?.data as { text?: string } | undefined)?.text ?? ''), /move this to the background/i);
  const terminal = listEvents(sessionId, { types: ['conversation_completed'] })
    .find((event) => event.data.sourceUserSeq === originTurn.seq);
  assert.equal(terminal?.data.reason, 'queued_background');
  assert.equal(terminal?.data.terminalKey, `turn:${originTurn.seq}`);
});

test('gateway records max-turns-with-grace as a non-completed run', async () => {
  const limitText = 'I hit the run budget before finishing — say "continue" to keep going.';
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    const source = acceptedHostSource(options);
    return {
      sessionId: options.sessionId,
      status: 'limit_exceeded',
      limitKind: 'max_steps',
      steps: 1,
      lastTurn: source.turn,
      lastDecision: { reply: limitText },
    };
  });

  const response = await gateway.handleMessage({
    message: 'research every account and finish the report',
    sessionId: 'sess-gateway-limit',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-limit',
  });

  assert.equal(response.stoppedReason, 'max-turns-with-grace');
  assert.equal(legacyCalls(), 0);
  const run = getRun('run-gateway-limit');
  assert.equal(run?.status, 'failed');
  assert.match(run?.error ?? '', /continue|budget/i);
});

test('gateway preserves an exact-source in-progress response without publishing or settling it', async () => {
  const sessionId = 'sess-gateway-exact-source-in-progress';
  const runId = 'run-gateway-exact-source-in-progress';
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    acceptedHostSource(options);
    return {
      sessionId: options.sessionId,
      status: 'held',
      steps: 0,
      lastTurn: 1,
      hold: { owner: 'host', wake: 'recovery', reason: 'recovery_pending' },
    };
  });

  const response = await gateway.handleMessage({
    message: 'Continue the exact task.',
    sessionId,
    channel: 'mobile',
    source: 'mobile',
    runId,
  });

  assert.equal(response.stoppedReason, 'in-progress');
  assert.equal(legacyCalls(), 0);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(getRun(runId)?.status, 'running');
});

test('gateway preserves a host awaiting-input stop as a typed question without terminal judging', async () => {
  const question = 'Which connected account should I use for the requested lookup?';
  let judgeCalls = 0;
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    const source = acceptedHostSource(options);
    const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
    const committed = commitTurnOutcome({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'needs_input',
      resumable: true,
      needs: { kind: 'input' },
      presentation: { kind: 'question', text: question },
    }, { legacyReason: 'awaiting_user_input' });
    return {
      sessionId: options.sessionId,
      status: 'awaiting_user_input',
      steps: 1,
      lastTurn: source.turn,
      publicPresentation: committed.presentation,
    };
  }, {
    terminalDeliveryJudgePort: {
      async resolveRoute() { judgeCalls += 1; return null; },
      async run() { throw new Error('a native question must not reach terminal delivery judging'); },
    },
  });

  const response = await gateway.handleMessage({
    message: 'Look up the account record.',
    sessionId: 'sess-gateway-legacy-awaiting-input',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-legacy-awaiting-input',
  });

  assert.equal(judgeCalls, 0);
  assert.equal(legacyCalls(), 0);
  assert.equal(response.text, question);
  assert.equal(response.stoppedReason, 'awaiting-input');
  const [terminal] = listEvents(response.sessionId, { types: ['conversation_completed'] });
  const presentation = presentationEventFromCompletionData(terminal.data);
  assert.equal(presentation?.status, 'needs_input');
  assert.equal(presentation?.needs?.kind, 'input');
  assert.equal(presentation?.text, question);
  assert.equal(getRun('run-gateway-legacy-awaiting-input')?.status, 'awaiting_input');
});

test('gateway stop keeps a conversational send row hidden while formal approval stop stays addressable', async () => {
  const hiddenSessionId = 'sess-gateway-hidden-send-stop';
  const channelId = 'gateway-hidden-send-channel';
  const userId = 'gateway-hidden-send-user';
  const originReplyTarget = { type: 'discord_channel' as const, channelId };
  createSession({
    id: hiddenSessionId,
    kind: 'chat',
    channel: 'discord',
    userId,
    metadata: { channelId, userId },
  });
  const hidden = approvalRegistry.register({
    sessionId: hiddenSessionId,
    channel: 'discord',
    channelId,
    subject: 'Send the reviewed email',
    tool: 'request_approval',
    presentation: {
      version: 1,
      kind: 'autonomous_send_consent',
      question: 'The exact email is ready. Do you want me to send it?',
      actionLabel: 'email',
      target: 'proof@example.com',
      subject: 'Reviewed sheet',
      bodyPreview: 'The reviewed sheet is attached.',
      resultUrl: null,
      sourceUserSeq: 1,
      originReplyTarget,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
      conversationKey: `discord:${channelId}`,
      audienceUserId: userId,
    },
  });
  const gateway = new ClementineGateway({
    respond: async () => { throw new Error('stop must not invoke the model'); },
  } as never);

  const hiddenResponse = await gateway.handleMessage({
    message: 'stop',
    sessionId: hiddenSessionId,
    channel: 'discord',
    source: 'discord',
    userId,
  });
  assert.match(hiddenResponse.text, /prepared email.*unsent/i);
  assert.doesNotMatch(hiddenResponse.text, /approval|card|apr-/i);
  assert.doesNotMatch(hiddenResponse.text, new RegExp(hidden.approvalId));
  assert.equal(approvalRegistry.get(hidden.approvalId)?.resolution, 'rejected');

  const formalSessionId = 'sess-gateway-formal-approval-stop';
  createSession({ id: formalSessionId, kind: 'chat', channel: 'webhook' });
  const formal = approvalRegistry.register({
    sessionId: formalSessionId,
    subject: 'Delete the reviewed record',
    tool: 'request_approval',
  });
  const formalResponse = await gateway.handleMessage({
    message: 'stop',
    sessionId: formalSessionId,
    channel: 'webhook',
    source: 'webhook',
  });
  assert.match(formalResponse.text, /Rejected approval/i);
  assert.match(formalResponse.text, new RegExp(formal.approvalId));
});

test('gateway does not manufacture an unverified concern for a safe terminal-less host completion', async () => {
  const authored = 'The report run returned, but its completion record is unverified.';
  const judged = 'must not replace a safe host answer';
  const judge = gatewayTerminalJudge({
    verb: 'deliver',
    reason: 'the confirmed status is useful with the missing completion record stated plainly',
    publicText: judged,
  });
  const { gateway, legacyCalls } = hostGatewayForTest(
    (options) => completedHostAnswer(options, authored, { commitTerminal: false }),
    { terminalDeliveryJudgePort: judge.port },
  );

  const response = await gateway.handleMessage({
    message: 'Run the report and tell me what happened.',
    sessionId: 'sess-gateway-legacy-unverified',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-legacy-unverified',
  });

  assert.equal(judge.runCalls(), 0);
  assert.equal(legacyCalls(), 0);
  assert.equal(response.text, authored);
  const [terminal] = listEvents(response.sessionId, { types: ['conversation_completed'] });
  const presentation = presentationEventFromCompletionData(terminal.data);
  assert.equal(presentation?.status, 'done');
  assert.equal(presentation?.text, authored);
  assert.equal(terminal.data.terminalJudgeDisposition, undefined);
  assert.equal(terminal.data.deliveryDisclosure, undefined);
});

test('gateway records an intentionally stopped run as cancelled exactly once', async () => {
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    const source = acceptedHostSource(options);
    return {
      sessionId: options.sessionId,
      status: 'killed',
      steps: 1,
      lastTurn: source.turn,
      lastDecision: { reply: 'Stopped.' },
    };
  });

  const response = await gateway.handleMessage({
    message: 'Answer this short prompt.',
    sessionId: 'sess-gateway-cancelled',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-cancelled',
  });

  assert.equal(response.stoppedReason, 'cancelled');
  assert.equal(response.terminal?.status, 'cancelled');
  assert.equal(legacyCalls(), 0);
  const run = getRun('run-gateway-cancelled');
  assert.equal(run?.status, 'cancelled');
  assert.equal(run?.events.filter((event) => event.type === 'cancelled').length, 1);
  assert.equal(run?.events.filter((event) => event.type === 'failed').length, 0);
});

test('gateway preserves blocked, uncertain, input, and cancelled terminals as typed client outcomes', async () => {
  const cases = [
    { status: 'blocked' as const, stoppedReason: 'blocked' as const, runStatus: 'blocked' as const },
    { status: 'uncertain' as const, stoppedReason: 'unverified' as const, runStatus: 'blocked' as const },
    { status: 'needs_input' as const, stoppedReason: 'awaiting-input' as const, runStatus: 'awaiting_input' as const },
    { status: 'cancelled' as const, stoppedReason: 'cancelled' as const, runStatus: 'cancelled' as const },
  ];

  for (const item of cases) {
    const sessionId = `sess-gateway-typed-${item.status}`;
    const runId = `run-gateway-typed-${item.status}`;
    const text = item.status === 'needs_input'
      ? 'Which exact input should I use?'
      : item.status === 'cancelled'
        ? 'The exact turn was cancelled.'
        : item.status === 'uncertain'
          ? 'The exact crossing requires reconciliation.'
          : 'The exact turn is blocked before execution.';
    const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
      const source = acceptedHostSource(options);
      const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
      if (item.status === 'needs_input') {
        appendEvent({
          sessionId: source.sessionId,
          turn: source.turn,
          role: 'system',
          type: 'awaiting_user_input',
          data: { question: text, sourceUserSeq: source.seq },
        });
      }
      const outcome = item.status === 'needs_input'
        ? {
            version: 2 as const,
            id: turnOutcomeId(identity),
            identity,
            status: 'needs_input' as const,
            resumable: true as const,
            needs: { kind: 'input' as const },
            presentation: { kind: 'question' as const, text },
          }
        : item.status === 'cancelled'
          ? {
              version: 2 as const,
              id: turnOutcomeId(identity),
              identity,
              status: 'cancelled' as const,
              resumable: false as const,
              presentation: { kind: 'stopped' as const, text },
            }
          : {
              version: 2 as const,
              id: turnOutcomeId(identity),
              identity,
              status: item.status,
              resumable: true as const,
              presentation: { kind: 'blocked' as const, text },
            };
      const committed = commitTurnOutcome(outcome, {
        legacyReason: item.status === 'uncertain'
          ? 'reconciliation_required'
          : item.status === 'needs_input'
            ? 'awaiting_user_input'
            : item.status,
      });
      return {
        sessionId: options.sessionId,
        status: item.status === 'needs_input'
          ? 'awaiting_user_input'
          : item.status === 'cancelled'
            ? 'killed'
            : 'blocked',
        steps: 1,
        lastTurn: source.turn,
        lastDecision: { reply: text },
        publicPresentation: committed.presentation,
      };
    });

    const response = await gateway.handleMessage({
      message: `exercise typed ${item.status}`,
      sessionId,
      channel: 'mobile',
      source: 'mobile',
      runId,
    });
    assert.equal(response.sessionId, sessionId);
    assert.equal(response.text, text);
    assert.equal(response.stoppedReason, item.stoppedReason);
    assert.equal(response.terminal?.status, item.status);
    assert.equal(response.terminal?.identity.sessionId, sessionId);
    assert.equal(getRun(runId)?.status, item.runStatus);
    assert.equal(legacyCalls(), 0);
  }
});

test('gateway returns and records model route diagnostics', async () => {
  let selectedEngine: string | undefined;
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    selectedEngine = options.turnEngine;
    return completedHostAnswer(options, 'Done. Route diagnostic recorded.');
  });

  const response = await gateway.handleMessage({
    message: 'record the route diagnostic',
    sessionId: 'sess-gateway-route',
    channel: 'mobile',
    source: 'mobile',
    model: 'claude-sonnet-5',
    runId: 'run-gateway-route',
  });

  assert.equal(response.route?.routeKind, 'harness');
  assert.equal(response.route?.surface, 'webhook');
  assert.equal(response.route?.requestedModel, 'claude-sonnet-5');
  assert.equal(response.route?.transport, 'host_harness');
  assert.equal(selectedEngine, 'host_v1');
  assert.equal(legacyCalls(), 0);

  const run = getRun('run-gateway-route');
  const routeEvent = run?.events.find((event) => event.message.startsWith('Model route:'));
  assert.equal(routeEvent?.data?.routeKind, 'harness');
  assert.equal(routeEvent?.data?.requestedModel, 'claude-sonnet-5');
});

test('gateway terminal-less host completion rejects an unhonorable RESUME and conservatively holds before first write', async () => {
  const authoredText = 'I am blocked on missing credentials, so I cannot complete this task.';
  const judge = gatewayTerminalJudge({
    verb: 'resume',
    reason: 'one account-scoped credential check could repair the result',
    recoveryInstruction: 'Inspect the configured account credential and retry the exact read-only lookup once.',
    askIfRepeated: 'Which account should I use to finish the requested lookup?',
  });
  let hostCalls = 0;
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    hostCalls += 1;
    return completedHostAnswer(options, authoredText, { commitTerminal: false });
  }, { terminalDeliveryJudgePort: judge.port });
  const request = {
    message: 'Pull the account data and finish the report.',
    sessionId: 'sess-gateway-legacy-resume-hold',
    channel: 'mobile',
    source: 'mobile' as const,
    runId: 'run-gateway-legacy-resume-hold',
  };

  const first = await gateway.handleMessage(request);
  const replay = await gateway.handleMessage(request);

  assert.equal(first.text, authoredText, 'the shared hold keeps an already-authored blocker account');
  assert.equal(first.stoppedReason, 'blocked');
  assert.equal(first.terminal?.status, 'blocked');
  assert.equal(replay.text, authoredText);
  assert.equal(hostCalls, 1, 'durable replay must not run the host activation again');
  assert.equal(legacyCalls(), 0);
  assert.equal(judge.runCalls(), 1, 'durable replay must not judge the same source again');
  assert.deepEqual(judge.request()?.tools, []);
  assert.equal(judge.request()?.maxTurns, 1);
  assert.match(judge.request()?.prompt ?? '', /Live continuation: UNAVAILABLE/);
  assert.match(judge.request()?.prompt ?? '', /Tools during continuation: UNAVAILABLE/);
  assert.match(judge.request()?.prompt ?? '', /Read-only external-state inspection: UNAVAILABLE/);
  const terminals = listEvents(request.sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  const presentation = presentationEventFromCompletionData(terminals[0].data);
  assert.equal(presentation?.status, 'blocked');
  assert.equal(presentation?.kind, 'blocked');
  assert.equal(presentation?.text, authoredText);
  assert.equal(terminals[0].data.terminalJudgeDisposition, undefined,
    'resume_unavailable is not a decided control edge');
  assert.equal(terminals[0].data.terminalJudgeFamily, undefined);
  assert.equal(terminals[0].data.terminalJudgeResumeCount, undefined,
    'a RESUME the legacy carrier cannot honor must not consume a strike');
  assert.equal(getRun(request.runId)?.status, 'blocked');
});

test('gateway terminal-less host completion publishes a different-family ASK as the only terminal', async () => {
  const authoredText = 'I am blocked on missing credentials, so I cannot complete this task.';
  const publicQuestion = 'Which account should I use to access the requested records?';
  const judge = gatewayTerminalJudge({
    verb: 'ask',
    reason: 'the account choice belongs to the user',
    publicText: publicQuestion,
  });
  const { gateway, legacyCalls } = hostGatewayForTest(
    (options) => completedHostAnswer(options, authoredText, { commitTerminal: false }),
    { terminalDeliveryJudgePort: judge.port },
  );

  const response = await gateway.handleMessage({
    message: 'Pull the account data and finish the report.',
    sessionId: 'sess-gateway-legacy-judge-ask',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-legacy-judge-ask',
  });

  assert.equal(response.text, publicQuestion);
  assert.equal(legacyCalls(), 0);
  const [terminal] = listEvents(response.sessionId, { types: ['conversation_completed'] });
  const presentation = presentationEventFromCompletionData(terminal.data);
  assert.equal(presentation?.status, 'needs_input');
  assert.equal(presentation?.kind, 'question');
  assert.equal(presentation?.needs?.kind, 'input');
  assert.equal(presentation?.text, publicQuestion);
  assert.equal(terminal.data.reason, 'awaiting_user_input');
  assert.equal(terminal.data.terminalJudgeDisposition, 'ask');
  assert.equal(getRun('run-gateway-legacy-judge-ask')?.status, 'awaiting_input');
});

test('gateway terminal-less host completion sends a different-family DELIVER through the shared concern rule', async () => {
  const authoredText = 'I am blocked on missing credentials, so I cannot complete this task.';
  const publicAnswer = 'I could not access the account records, so no report was created.';
  const judge = gatewayTerminalJudge({
    verb: 'deliver',
    reason: 'the truthful access failure is the complete result available to report',
    publicText: publicAnswer,
  });
  const { gateway, legacyCalls } = hostGatewayForTest(
    (options) => completedHostAnswer(options, authoredText, { commitTerminal: false }),
    { terminalDeliveryJudgePort: judge.port },
  );

  const response = await gateway.handleMessage({
    message: 'Pull the account data and finish the report.',
    sessionId: 'sess-gateway-legacy-judge-deliver',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-legacy-judge-deliver',
  });

  assert.equal(response.text, publicAnswer);
  assert.equal(legacyCalls(), 0);
  const [terminal] = listEvents(response.sessionId, { types: ['conversation_completed'] });
  const presentation = presentationEventFromCompletionData(terminal.data);
  assert.equal(presentation?.status, 'done');
  assert.equal(presentation?.kind, 'answer');
  assert.equal(presentation?.text, publicAnswer, 'no committer-authored caveat is added to judge-authored disclosure');
  assert.equal(terminal.data.terminalJudgeDisposition, 'deliver');
  assert.equal(terminal.data.deliveryDisclosure, 'unverified_completion');
  assert.equal(getRun('run-gateway-legacy-judge-deliver')?.status, 'completed');
});

test('gateway terminal-less host completion keeps the shared conservative hold when the judge is unavailable', async () => {
  const authoredText = 'I am blocked on missing credentials, so I cannot complete this task.';
  const judge = gatewayTerminalJudge(null, new Error('judge provider unavailable'));
  const { gateway, legacyCalls } = hostGatewayForTest(
    (options) => completedHostAnswer(options, authoredText, { commitTerminal: false }),
    { terminalDeliveryJudgePort: judge.port },
  );

  const response = await gateway.handleMessage({
    message: 'Pull the account data and finish the report.',
    sessionId: 'sess-gateway-legacy-judge-outage',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-legacy-judge-outage',
  });

  assert.equal(judge.runCalls(), 1);
  assert.equal(legacyCalls(), 0);
  assert.equal(response.text, authoredText, 'judge outage must not manufacture replacement user text');
  const [terminal] = listEvents(response.sessionId, { types: ['conversation_completed'] });
  const presentation = presentationEventFromCompletionData(terminal.data);
  assert.equal(presentation?.status, 'blocked');
  assert.equal(presentation?.text, authoredText);
  assert.equal(terminal.data.terminalJudgeDisposition, undefined);
});

test('gateway preserves an already-committed host terminal without gateway re-judging', async () => {
  const judge = gatewayTerminalJudge({
    verb: 'ask',
    reason: 'must not run for an existing bridge winner',
    publicText: 'must not surface',
  });
  const durableText = 'The harness already committed this verified answer.';
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    const source = acceptedHostSource(options);
    const committed = commitAnswerForSource(source, durableText);
    return {
      sessionId: options.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: source.turn,
      lastDecision: { reply: 'I am blocked on a replaceable raw response.' },
      publicPresentation: committed.presentation,
    };
  }, { terminalDeliveryJudgePort: judge.port });

  const response = await gateway.handleMessage({
    message: 'Return the verified answer.',
    sessionId: 'sess-gateway-existing-bridge-terminal',
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-existing-bridge-terminal',
  });

  assert.equal(response.text, durableText);
  assert.equal(judge.runCalls(), 0, 'an existing typed terminal bypasses gateway terminal review');
  assert.equal(legacyCalls(), 0);
  assert.equal(getRun('run-gateway-existing-bridge-terminal')?.status, 'completed');
  const terminals = listEvents(response.sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal(presentationEventFromCompletionData(terminals[0].data)?.text, durableText);
});

test('gateway keeps verified workflow dispatch nonterminal across replay until the real result wins', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Gateway async dispatch' });
  const runId = 'run-gateway-verified-async-dispatch';
  let hostCalls = 0;
  let dispatchText = '';
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    hostCalls += 1;
    const source = acceptedHostSource(options);
    const dispatch = appendActiveWorkflowDispatch(source, 'workflow-gateway-verified-async');
    dispatchText = publicAsyncWorkDispatchedData(dispatch.data)?.text ?? '';
    return {
      sessionId: options.sessionId,
      status: 'dispatched',
      steps: 1,
      lastTurn: source.turn,
      lastDecision: { reply: 'model-authored acknowledgement must not become the terminal' },
    };
  });
  const request = {
    message: 'analyze these results and post the answer here',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile' as const,
    runId,
    failClosedOnUnsettledReplay: true,
  };

  const first = await gateway.handleMessage(request);
  const replay = await gateway.handleMessage(request);

  assert.ok(dispatchText);
  assert.equal(first.text, dispatchText);
  assert.equal(replay.text, dispatchText);
  assert.equal(first.stoppedReason, 'success');
  assert.equal(replay.stoppedReason, 'success');
  assert.equal(hostCalls, 1, 'provider replay must not dispatch the host or workflow twice');
  assert.equal(legacyCalls(), 0);
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['async_work_dispatched'] }).length, 1);
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 0,
    'dispatch acknowledgement closes the physical request but not the logical turn');
  assert.equal(getRun(runId)?.status, 'queued');

  const [source] = listEvents(session.id, { types: ['user_input_received'] });
  const attempt = getRunAttemptBySourceUserSeq(session.id, source.seq);
  assert.equal(attempt?.status, 'active', 'dispatch replay must retain the exact parent owner');
  assert.equal(attempt?.finishedAt, null);
  assert.equal(HarnessSession.load(session.id)?.runInFlightSince(), null, 'durable transfer releases only the foreground marker');
  closeEventLog();
  assert.equal(interruptForeignRunAttemptLeases('new-process', { preserveAttemptIds: workflowOwnedUnfinishedAttemptIds() }), 0);
  assert.equal(interruptOrphanedRunAttemptsAtBoot(Date.now(), { preserveAttemptIds: workflowOwnedUnfinishedAttemptIds() }), 0);
  assert.equal(getRunAttemptBySourceUserSeq(session.id, source.seq)?.attemptId, attempt?.attemptId);
  assert.equal(getRunAttemptBySourceUserSeq(session.id, source.seq)?.finishedAt, null);
  commitAnswerForSource(source, 'The background report is ready.');
  const finishedAt = getRunAttemptBySourceUserSeq(session.id, source.seq)?.finishedAt;
  assert.ok(finishedAt, 'only the exact final terminal closes the parent');
  const completedReplay = await gateway.handleMessage(request);
  assert.equal(completedReplay.text, 'The background report is ready.');
  assert.equal(getRunAttemptBySourceUserSeq(session.id, source.seq)?.finishedAt, finishedAt);
  assert.equal(hostCalls, 1);
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
  assert.equal(getRun(runId)?.status, 'completed');
});

test('gateway preserves a verified host dispatch over a replaceable foreground proposal', async () => {
  const session = createSession({ kind: 'chat', channel: 'mobile', title: 'Gateway dispatch race' });
  const runId = 'run-gateway-dispatch-then-throw';
  let dispatchText = '';
  const { gateway, legacyCalls } = hostGatewayForTest(async (options) => {
    const source = acceptedHostSource(options);
    const dispatch = appendActiveWorkflowDispatch(source, 'workflow-gateway-dispatch-then-throw');
    dispatchText = publicAsyncWorkDispatchedData(dispatch.data)?.text ?? '';
    return {
      sessionId: options.sessionId,
      status: 'dispatched',
      steps: 1,
      lastTurn: source.turn,
      lastDecision: { reply: 'replaceable foreground acknowledgement' },
    };
  });

  const response = await gateway.handleMessage({
    message: 'check this dataset for anomalies',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
    runId,
  });

  assert.equal(response.text, dispatchText);
  assert.equal(legacyCalls(), 0);
  assert.equal(response.stoppedReason, 'success');
  assert.equal(getRun(runId)?.status, 'queued');
  assert.equal(listEvents(session.id, { types: ['conversation_completed'] }).length, 0);
});

test('a verbal approval settles a sole approval-parked task deterministically (no brain turn)', async () => {
  resetEventLog();
  const session = createSession({ kind: 'chat' });
  const { createBackgroundTask, getBackgroundTask, markBackgroundTaskRunning, markBackgroundTaskAwaitingApproval } =
    await import('../execution/background-tasks.js');
  const task = createBackgroundTask({
    title: 'Outreach draft sweep',
    prompt: 'draft outreach',
    originSessionId: session.id,
    source: 'gateway',
    channel: 'mobile',
  });
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskAwaitingApproval(task.id, 'apr-gwok', 'Awaiting approval for the crawl.');

  let brainTurns = 0;
  const gateway = new ClementineGateway({
    respond: async (req: { message: string; sessionId: string }) => {
      brainTurns += 1;
      return { text: 'brain must not run', sessionId: req.sessionId };
    },
  } as never);

  const response = await gateway.handleMessage({
    message: 'Approved',
    sessionId: session.id,
    channel: 'mobile',
    source: 'mobile',
    runId: 'run-gateway-approval-settle',
  });

  assert.match(response.text ?? '', /Approved — "Outreach draft sweep"/, 'the reply must lead with the task the user recognizes, not the card id');
  assert.equal(brainTurns, 0, 'a deterministic settlement woke the brain');
  const settled = getBackgroundTask(task.id);
  assert.equal(settled?.status, 'pending', 'the parked task was not queued for continuation');
  assert.equal(settled?.approvalResolution?.approved, true);
});

for (const damage of ['ordinary', 'wrong-source', 'missing-group', 'corrupt-group'] as const) {
  test(`workflow boot preservation refuses ${damage} ownership`, () => {
    const session = createSession({ kind: 'chat', channel: 'mobile' });
    const attempt = beginRunAttempt(session.id, { runId: `desktop:bad-owner-${damage}` });
    const source = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Run my saved workflow.' } });
    if (damage !== 'ordinary') {
      const dispatchedSource = damage === 'wrong-source'
        ? appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: source.data })
        : source;
      const event = appendActiveWorkflowDispatch(dispatchedSource, `child-bad-owner-${damage}`);
      const group = path.join(WORKFLOW_RUNS_DIR, '.origin-groups', createHash('sha256').update(String(event.data.sourceGroupId)).digest('hex'));
      if (damage === 'missing-group') rmSync(group, { recursive: true, force: true });
      if (damage === 'corrupt-group') writeFileSync(path.join(group, 'sealed.json'), '{}');
    }
    const preserved = workflowOwnedUnfinishedAttemptIds();
    assert.equal(preserved.includes(attempt.attemptId), false);
    assert.equal(interruptOrphanedRunAttemptsAtBoot(Date.now(), { preserveAttemptIds: preserved }), 1);
    assert.equal(getRunAttemptBySourceUserSeq(session.id, source.seq)?.status, 'interrupted');
  });
}
