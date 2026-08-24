/**
 * Run: npx tsx --test src/channels/discord.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalResolutionResult, PendingApproval } from '../types.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-discord-test-'));
const PREV_HOME = process.env.CLEMENTINE_HOME;
const PREV_HARNESS_WEBHOOK = process.env.CLEMMY_HARNESS_WEBHOOK;
const PREV_LEGACY_RESPOND_FALLBACK = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';

const { __test__ } = await import('./discord.js');
const {
  __test__: harnessTest,
  bindDiscordHarnessSession,
  clearDiscordHarnessSession,
  getBoundDiscordHarnessSessionId,
  tryHandleHarnessApprovalReply,
} = await import('./discord-harness.js');
const { getOrCreateDiscordSessionId } = await import('./discord-store.js');
const {
  appendEvent,
  createSession,
  beginRunAttempt,
  claimHarnessChatRequest,
  getActiveRunAttempt,
  getSession,
  getKillRequest,
  isKillRequested,
  listEvents,
  listSessions,
  openEventLog,
} = await import('../runtime/harness/eventlog.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const harnessApprovals = await import('../runtime/harness/approval-registry.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
const {
  classifyTurnPreflight,
  recordTurnPreflightDecision,
} = await import('../runtime/harness/turn-control.js');
const { publishPreflightConversation } = await import('../runtime/harness/preflight-conversation.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  markBackgroundTaskRunning,
} = await import('../execution/background-tasks.js');
const { createCheckIn, getCheckIn } = await import('../agents/check-ins.js');

after(() => {
  _setBridgeImplsForTests({});
  if (PREV_HARNESS_WEBHOOK === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
  else process.env.CLEMMY_HARNESS_WEBHOOK = PREV_HARNESS_WEBHOOK;
  if (PREV_LEGACY_RESPOND_FALLBACK === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = PREV_LEGACY_RESPOND_FALLBACK;
  if (PREV_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PREV_HOME;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

interface HostGatewayRunOptionsForTest {
  sessionId: string;
  input: string;
  sourceUserSeq?: number;
  turnEngine?: string;
}

function installHostGatewayRunForTest(
  run: (options: HostGatewayRunOptionsForTest) => Promise<Record<string, unknown>>,
): () => void {
  const previousWebhook = process.env.CLEMMY_HARNESS_WEBHOOK;
  const previousTurnEngine = process.env.CLEMMY_TURN_ENGINE;
  process.env.CLEMMY_HARNESS_WEBHOOK = 'on';
  process.env.CLEMMY_TURN_ENGINE = 'host_v1';
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: run as never,
  });
  return () => {
    _setBridgeImplsForTests({});
    if (previousWebhook === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
    else process.env.CLEMMY_HARNESS_WEBHOOK = previousWebhook;
    if (previousTurnEngine === undefined) delete process.env.CLEMMY_TURN_ENGINE;
    else process.env.CLEMMY_TURN_ENGINE = previousTurnEngine;
  };
}

test('every model-entering Discord slash command, including non-ask routes, derives one stable interaction run id', () => {
  const expected = __test__.discordSlashRunId({
    commandName: 'ask',
    channelId: 'chan-slash-stable',
    interactionId: 'interaction-stable',
  });
  assert.ok(expected);
  for (const commandName of ['ask', 'status', 'tasks', 'runs']) {
    assert.equal(__test__.discordSlashRunId({
      commandName,
      channelId: 'chan-slash-stable',
      interactionId: 'interaction-stable',
    }), expected, `/${commandName} must use the provider interaction identity`);
  }
  assert.equal(__test__.discordSlashRunId({
    commandName: 'ping',
    channelId: 'chan-slash-stable',
    interactionId: 'interaction-stable',
  }), null, 'a local slash read does not manufacture a model turn');
});

test('Discord receipt replay wins before audience hydration and creates no blank restart session', async () => {
  const context = {
    channelId: 'chan-receipt-first-restart',
    userId: 'user-receipt-first-restart',
    guildId: 'guild-receipt-first-restart',
  };
  const session = createSession({
    id: 'sess-discord-receipt-first-restart',
    kind: 'chat',
    channel: 'discord',
    userId: context.userId,
    metadata: {
      source: 'discord',
      channelId: context.channelId,
      userId: context.userId,
      guildId: context.guildId,
    },
  });
  const receipt = {
    requestId: 'discord-receipt-first-request',
    runId: 'run-discord-receipt-first',
    inputHash: 'discord-receipt-first-input',
  };
  claimHarnessChatRequest({ ...receipt, sessionId: session.id, sinceSeq: 0 });
  harnessApprovals.register({
    sessionId: session.id,
    channel: 'discord',
    channelId: context.channelId,
    subject: 'Older request remains parked',
  });
  clearDiscordHarnessSession(context.channelId, {
    channel: 'discord',
    userId: context.userId,
    guildId: context.guildId,
  });
  openEventLog().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', session.id);
  const sessionsBefore = listSessions({ limit: 500 }).map((row) => row.id).sort();
  const eventsBefore = listEvents(session.id).map((event) => event.id);

  const selected = await harnessTest.resolveOrCreateSessionForTest({
    ...context,
    prompt: 'exact provider retry',
    channel: 'discord',
    durableSourceId: receipt.runId,
    receipt,
  });

  assert.equal(selected.id, session.id);
  assert.deepEqual(listSessions({ limit: 500 }).map((row) => row.id).sort(), sessionsBefore);
  assert.deepEqual(listEvents(session.id).map((event) => event.id), eventsBefore);
});

test('Discord gateway/slash ingress branches a held session before acceptance and replays on the same child', async () => {
  const context = {
    channelId: 'chan-held-gateway',
    userId: 'user-held-gateway',
    guildId: 'guild-held-gateway',
  };
  const entrySessionId = getOrCreateDiscordSessionId(context);
  HarnessSession.create({
    id: entrySessionId,
    kind: 'chat',
    channel: 'discord',
    userId: context.userId,
    metadata: {
      source: 'discord',
      channelId: context.channelId,
      userId: context.userId,
      guildId: context.guildId,
    },
  });
  const approval = harnessApprovals.register({
    sessionId: entrySessionId,
    channel: 'discord',
    channelId: context.channelId,
    subject: 'Older held request',
  });
  const runId = __test__.discordSlashRunId({
    commandName: 'ask',
    channelId: context.channelId,
    interactionId: 'interaction-held-gateway',
  });
  assert.ok(runId);
  let hostCalls = 0;
  let acceptedSessionId: string | undefined;
  const restore = installHostGatewayRunForTest(async (options) => {
    hostCalls += 1;
    const source = listEvents(options.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === options.sourceUserSeq);
    assert.ok(source);
    const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
    const committed = commitTurnOutcome({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: 'fresh Discord work completed' },
    }, { legacyReason: 'discord_fresh_source_gateway_test' });
    return {
      sessionId: options.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: source.turn,
      publicPresentation: committed.presentation,
    };
  });
  try {
    const first = await __test__.runGatewayPrompt({
      assistant: { async respond() { throw new Error('legacy assistant must not run'); } } as never,
      prompt: 'Start a completely unrelated request.',
      ...context,
      runId: runId!,
      onAcceptedSource: (source) => { acceptedSessionId = source.sessionId; },
    });
    assert.notEqual(first.sessionId, entrySessionId);
    assert.equal(acceptedSessionId, first.sessionId);
    assert.equal(harnessApprovals.get(approval.approvalId)?.status, 'pending');
    assert.equal(harnessApprovals.get(approval.approvalId)?.sessionId, entrySessionId);
    assert.equal(listEvents(entrySessionId, { types: ['user_input_received'] }).length, 0);

    const replay = await __test__.runGatewayPrompt({
      assistant: { async respond() { throw new Error('retry must replay'); } } as never,
      prompt: 'Start a completely unrelated request.',
      ...context,
      runId: runId!,
    });
    assert.equal(replay.sessionId, first.sessionId);
    assert.equal(replay.text, 'fresh Discord work completed');
    assert.equal(hostCalls, 1);
    assert.equal(
      listEvents(first.sessionId, { types: ['user_input_received'] })
        .filter((event) => event.data.runId === runId).length,
      1,
    );
  } finally {
    restore();
  }
});

test('Discord session-resume rejects forged provider, guild, channel, and user targets before pointer or metadata mutation', () => {
  const target = createSession({
    id: 'sess-discord-resume-authority',
    kind: 'chat',
    channel: 'discord',
    userId: 'user-resume-owner',
    metadata: {
      source: 'discord',
      channelId: 'chan-resume-owner',
      guildId: 'guild-resume-owner',
      userId: 'user-resume-owner',
    },
  });
  const db = openEventLog();
  const beforeMetadata = (db.prepare('SELECT metadata_json FROM sessions WHERE id = ?')
    .get(target.id) as { metadata_json: string }).metadata_json;
  const bindingCount = (): number => (db.prepare(
    'SELECT COUNT(*) AS count FROM accepted_source_session_bindings WHERE session_id = ?',
  ).get(target.id) as { count: number }).count;
  const beforeBindings = bindingCount();

  for (const mismatch of [
    { userId: 'user-resume-attacker', guildId: 'guild-resume-owner', channelId: 'chan-resume-owner' },
    { userId: 'user-resume-owner', guildId: 'guild-resume-attacker', channelId: 'chan-resume-owner' },
    { userId: 'user-resume-owner', guildId: 'guild-resume-owner', channelId: 'chan-resume-attacker' },
  ]) {
    assert.throws(() => __test__.bindDiscordSessionResumeForInteraction({
      targetSessionId: target.id,
      interactionId: `interaction-forged-${mismatch.userId}-${mismatch.guildId}-${mismatch.channelId}`,
      ...mismatch,
    }), /audience|scope|conversation|principal/);
  }
  const slackTarget = createSession({
    id: 'sess-slack-forged-discord-resume',
    kind: 'chat',
    channel: 'slack',
    userId: 'user-resume-owner',
    metadata: {
      source: 'slack',
      channelId: 'chan-resume-owner',
      guildId: 'guild-resume-owner',
      userId: 'user-resume-owner',
    },
  });
  assert.throws(() => __test__.bindDiscordSessionResumeForInteraction({
    targetSessionId: slackTarget.id,
    interactionId: 'interaction-forged-provider',
    userId: 'user-resume-owner',
    guildId: 'guild-resume-owner',
    channelId: 'chan-resume-owner',
  }), /provider|principal/);
  assert.equal(
    (db.prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(target.id) as { metadata_json: string }).metadata_json,
    beforeMetadata,
  );
  assert.equal(bindingCount(), beforeBindings);
  assert.equal(getBoundDiscordHarnessSessionId(
    'chan-resume-owner', 'discord', 'user-resume-attacker', 'guild-resume-owner',
  ), null);

  assert.equal(__test__.bindDiscordSessionResumeForInteraction({
    targetSessionId: target.id,
    interactionId: 'interaction-valid-resume',
    userId: 'user-resume-owner',
    guildId: 'guild-resume-owner',
    channelId: 'chan-resume-owner',
  }), true);
  assert.equal(getBoundDiscordHarnessSessionId(
    'chan-resume-owner', 'discord', 'user-resume-owner', 'guild-resume-owner',
  ), target.id);
});

test('continue button resumes through the host gateway with the original session id', async () => {
  let captured: HostGatewayRunOptionsForTest | undefined;
  let legacyCalls = 0;
  const restore = installHostGatewayRunForTest(async (options) => {
    captured = options;
    const source = listEvents(options.sessionId, { types: ['user_input_received'] })
      .find((event) => event.seq === options.sourceUserSeq);
    assert.ok(source, 'host activation owns the exact gateway-accepted source');
    const identity = {
      sessionId: source.sessionId,
      turn: source.turn,
      sourceUserSeq: source.seq,
    };
    const committed = commitTurnOutcome({
      version: 2,
      id: turnOutcomeId(identity),
      identity,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: 'continued from host gateway' },
    }, { legacyReason: 'discord_continue_host_test' });
    return {
      sessionId: options.sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: source.turn,
      publicPresentation: committed.presentation,
    };
  });

  try {
    const response = await __test__.continueDiscordSessionFromButton({
      assistant: {
        async respond() {
          legacyCalls += 1;
          throw new Error('fresh Discord chat must not dispatch the legacy assistant');
        },
      } as never,
      sessionId: 'sess-discord-original',
      userId: 'user-123',
      channelId: 'chan-456',
      guildId: 'guild-789',
    });

    assert.equal(response.text, 'continued from host gateway');
    assert.equal(captured?.input, 'continue');
    assert.equal(captured?.sessionId, 'sess-discord-original');
    assert.equal(captured?.turnEngine, 'host_v1');
    assert.ok(Number.isSafeInteger(captured?.sourceUserSeq));
    assert.equal(legacyCalls, 0);
    assert.equal(getSession('sess-discord-original')?.userId, 'user-123');
    assert.equal(getSession('sess-discord-original')?.channel, 'discord:guild-789:chan-456');
    const accepted = listEvents('sess-discord-original', { types: ['user_input_received'] });
    assert.equal(accepted.length, 1);
    assert.match(String(accepted[0]?.data.runId ?? ''), /^run-/);
  } finally {
    restore();
  }
});

// ── Approval-card copy: no raw session ids / uuids in user-facing text (#7) ──
function pendingApproval(patch: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: patch.id ?? 'a1b2c3d4-1111-2222-3333-444455556666',
    sessionId: patch.sessionId ?? 'sess-secret-xyz',
    agentName: patch.agentName ?? 'Executor',
    toolName: patch.toolName ?? 'run_shell_command',
    createdAt: patch.createdAt ?? new Date().toISOString(),
    status: patch.status ?? 'pending',
    state: patch.state ?? '',
    userId: patch.userId,
    channel: patch.channel,
  };
}

function harnessRow(patch: Partial<PendingApprovalRow> = {}): PendingApprovalRow {
  return {
    approvalId: patch.approvalId ?? 'apr-9999',
    sessionId: patch.sessionId ?? 'sess-secret-xyz',
    channel: patch.channel ?? 'discord',
    channelId: patch.channelId ?? 'chan-a',
    requestedAt: patch.requestedAt ?? new Date().toISOString(),
    expiresAt: patch.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    subject: patch.subject ?? 'send the weekly report',
    tool: patch.tool ?? 'request_approval',
    args: patch.args ?? null,
    status: patch.status ?? 'pending',
    resolution: patch.resolution ?? null,
    resolver: patch.resolver ?? null,
    resolvedAt: patch.resolvedAt ?? null,
  };
}

test('renderApprovalCardContent: no session id or raw uuid in the card text', () => {
  const text = __test__.renderApprovalCardContent(pendingApproval());
  assert.ok(!text.includes('sess-secret-xyz'), 'session id must not appear');
  assert.ok(!text.includes('a1b2c3d4'), 'raw uuid must not appear');
  assert.ok(!/_session /.test(text), 'no session line');
  assert.match(text, /Approval needed/);
});

test('renderHarnessApprovalCardContent: no session id or raw approval id in the card text', () => {
  const text = __test__.renderHarnessApprovalCardContent(harnessRow());
  assert.ok(!text.includes('sess-secret-xyz'), 'session id must not appear');
  assert.ok(!text.includes('apr-9999'), 'raw approval id must not appear');
  assert.ok(!/_session /.test(text), 'no session line');
  assert.match(text, /send the weekly report/);
});

test('approvalResultText: human copy, not "Approval approved: <uuid>"', () => {
  const approved: ApprovalResolutionResult = {
    approvalId: 'apr-9999', status: 'approved', text: 'Draft created.', sessionId: 'sess-secret-xyz',
  };
  const out = __test__.approvalResultText(approved);
  assert.ok(!out.includes('apr-9999'), 'no raw approval id in user-facing text');
  assert.ok(!out.includes('sess-secret-xyz'), 'no session id');
  assert.match(out, /Approved — continuing the run\./);
  assert.match(out, /Draft created\./, 'the resolution detail still shows');

  const rejected: ApprovalResolutionResult = { ...approved, status: 'rejected' };
  assert.match(__test__.approvalResultText(rejected), /Rejected — stopping that action\./);
});

// ── REST DM transport carries sendFollowup so long replies keep their tail (#8) ──
test('buildDiscordRestTransport: exposes sendFollowup (finalFlush needs it for overflow chunks)', () => {
  const transport = __test__.buildDiscordRestTransport('chan-rest');
  assert.equal(typeof transport.sendFollowup, 'function');
  assert.equal(typeof transport.sendInitial, 'function');
});

test('bare approval vocabulary only sees approvals linked to this Discord conversation', () => {
  const context = { channelId: 'chan-current', userId: 'user-same', guildId: 'guild-current' };
  const currentChannel = 'discord:guild-current:chan-current';
  const approvals = [
    pendingApproval({ id: 'current', userId: 'user-same', channel: currentChannel }),
    pendingApproval({ id: 'foreign-channel', userId: 'user-same', channel: 'discord:guild-other:chan-other' }),
    pendingApproval({ id: 'legacy-user-only', userId: 'user-same' }),
    pendingApproval({ id: 'different-user', userId: 'user-other' }),
  ];

  assert.deepEqual(
    __test__.relevantApprovalsForContext(context, approvals).map((approval) => approval.id),
    ['current', 'legacy-user-only'],
  );
});

function noApprovalAssistant() {
  return {
    getRuntime() {
      return { listPendingApprovals: () => [] };
    },
  } as never;
}

function refusingHarnessTransport() {
  return {
    async sendInitial() {
      throw new Error('a bare conversational answer must not receive approval-control copy');
    },
    async sendError() {
      throw new Error('a bare conversational answer must not fail in approval routing');
    },
    async update() {},
    async final() {},
  } as never;
}

test('gateway ingress leaves literal Go ahead/Yes for the next harness turn when no approval exists', async () => {
  const channelId = 'chan-preflight-go-ahead-gateway';
  const message = {
    channelId,
    guildId: 'guild-preflight-go-ahead',
    author: { id: 'user-preflight-go-ahead' },
    channel: {
      isTextBased: () => true,
      async send() {
        throw new Error('the legacy command layer must not answer this message');
      },
    },
  } as never;

  for (const prompt of ['Go ahead', 'Yes']) {
    const harnessHandled = await tryHandleHarnessApprovalReply({
      channelId,
      prompt,
      transport: refusingHarnessTransport(),
    });
    assert.equal(harnessHandled, false, `${prompt} is not approval control without a card`);

    const legacyHandled = await __test__.handleDiscordCommand(
      message,
      noApprovalAssistant(),
      prompt,
    );
    assert.equal(legacyHandled, false, `${prompt} reaches handleDiscordHarnessMessage as a normal turn`);
  }
});

test('DM-poll ingress leaves literal Go ahead/Yes for the next harness turn when no approval exists', async () => {
  const channelId = 'chan-preflight-go-ahead-dm-poll';
  for (const prompt of ['Go ahead', 'Yes']) {
    const harnessHandled = await tryHandleHarnessApprovalReply({
      channelId,
      prompt,
      transport: refusingHarnessTransport(),
      allowGlobalApprovalFallback: true,
    });
    assert.equal(harnessHandled, false, `${prompt} is not global approval control without a card`);

    const legacyHandled = await __test__.handleDiscordRestCommand({
      assistant: noApprovalAssistant(),
      prompt,
      channelId,
      userId: 'user-preflight-go-ahead-dm',
      guildId: null,
    });
    assert.equal(legacyHandled, false, `${prompt} reaches runDiscordHarnessConversation as a normal DM turn`);
  }
});

test('settled Discord preflight does not manufacture pending go-ahead authority', async () => {
  const priorConfirmBeat = process.env.CLEMMY_CONFIRM_BEAT;
  process.env.CLEMMY_CONFIRM_BEAT = 'on';
  try {
    const channelId = 'chan-preflight-continuation';
    const sessionId = 'discord-preflight-continuation';
    const objective = 'Create a Google Sheet with the top five Ventura restaurants, then email me the link.';
    createSession({
      id: sessionId,
      kind: 'chat',
      channel: `discord:guild-preflight:${channelId}`,
      metadata: { source: 'discord', channelId },
    });
    const source = appendEvent({
      sessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: objective },
    });
    const align = classifyTurnPreflight({
      message: objective,
      sessionId,
      sessionKind: 'chat',
      sourceUserSeq: source.seq,
    });
    assert.equal(align.phase, 'align');
    recordTurnPreflightDecision(sessionId, align, source.seq);
    const disposition = await publishPreflightConversation({
      identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
      decision: align,
      openness: null,
      port: { async render() { return 'I have the Ventura sheet and email handoff in mind, and I’m starting now.'; } },
      transport: 'host_harness',
    });
    assert.equal(disposition.kind, 'proceed');

    const prompt = 'Go ahead.';
    assert.equal(await tryHandleHarnessApprovalReply({
      channelId,
      prompt,
      transport: refusingHarnessTransport(),
    }), false, 'no approval card owns the preflight answer');

    const accepted = appendEvent({
      sessionId,
      turn: 2,
      role: 'user',
      type: 'user_input_received',
      data: { text: prompt },
    });
    const continuation = classifyTurnPreflight({
      message: prompt,
      sessionId,
      sessionKind: 'chat',
      sourceUserSeq: accepted.seq,
    });
    assert.equal(continuation.phase, 'execute');
    assert.equal(continuation.reason, 'ordinary_execution');
    assert.equal(continuation.objective, undefined);
    assert.equal(continuation.confirmedIntentKey, undefined);
  } finally {
    if (priorConfirmBeat === undefined) delete process.env.CLEMMY_CONFIRM_BEAT;
    else process.env.CLEMMY_CONFIRM_BEAT = priorConfirmBeat;
  }
});

test('bare Yes still answers a real open check-in instead of falling through as conversation', async () => {
  const checkIn = createCheckIn({
    agentSlug: 'discord-ingress-test',
    question: 'Should the customer-facing release note name the migration explicitly for this rollout?',
  });
  const sent: string[] = [];
  const handled = await __test__.handleDiscordCommand({
    channelId: 'chan-open-check-in',
    guildId: 'guild-open-check-in',
    author: { id: 'user-open-check-in' },
    channel: {
      isTextBased: () => true,
      async send(text: string) { sent.push(text); },
    },
  } as never, noApprovalAssistant(), 'Yes');

  assert.equal(handled, true);
  assert.equal(getCheckIn(checkIn.id)?.status, 'answered');
  assert.match(sent.join('\n'), /Recorded approval for check-in/);
});

test('Discord stop targets the actual in-memory gateway attempt and linked background work', async () => {
  const context = { channelId: 'chan-stop-test', userId: 'user-stop-test', guildId: 'guild-stop-test' };
  const sessionId = getOrCreateDiscordSessionId(context);
  createSession({
    id: sessionId,
    kind: 'chat',
    channel: 'discord:guild-stop-test:chan-stop-test',
    userId: context.userId,
  });
  const task = createBackgroundTask({
    title: 'linked long research',
    prompt: 'research',
    originSessionId: sessionId,
    userId: context.userId,
    channel: 'discord:guild-stop-test:chan-stop-test',
    source: 'discord',
  });
  markBackgroundTaskRunning(task.id);
  // A running task can temporarily have no registered model attempt (startup /
  // between turns). Task-state cancellation must not widen to a session latch.
  const queuedTask = createBackgroundTask({
    title: 'linked queued export',
    prompt: 'export later',
    originSessionId: sessionId,
    userId: context.userId,
    channel: 'discord:guild-stop-test:chan-stop-test',
    source: 'discord',
  });

  let entered!: () => void;
  let release!: () => void;
  const hostEntered = new Promise<void>((resolve) => { entered = resolve; });
  const hostReleased = new Promise<void>((resolve) => { release = resolve; });
  let legacyCalls = 0;
  const restore = installHostGatewayRunForTest(async (options) => {
    entered();
    await hostReleased;
    return {
      sessionId: options.sessionId,
      status: 'killed',
      steps: 1,
      lastTurn: 1,
    };
  });
  const running = __test__.runGatewayPrompt({
    assistant: {
      async respond() {
        legacyCalls += 1;
        throw new Error('fresh Discord chat must not dispatch the legacy assistant');
      },
    } as never,
    prompt: 'do the current foreground work',
    ...context,
  });

  try {
    await hostEntered;
    const attempt = getActiveRunAttempt(sessionId);
    assert.ok(attempt, 'gateway registers the attempt before host model work');

    const stopped = __test__.stopDiscordContext(context);

    assert.deepEqual(stopped.stoppedSessionIds, [sessionId]);
    assert.deepEqual(new Set(stopped.stoppedTaskIds), new Set([task.id, queuedTask.id]));
    assert.equal(isKillRequested(sessionId, attempt!), true);
    assert.equal(getBackgroundTask(task.id)?.status, 'cancelling');
    assert.equal(getBackgroundTask(queuedTask.id)?.status, 'aborted');
    assert.equal(getKillRequest(task.runSessionId), null, 'no active task attempt means no session-wide kill latch');
    assert.equal(legacyCalls, 0);
  } finally {
    release();
    await running.catch(() => undefined);
    restore();
  }
});

test('Discord REST/gateway stop resolution sees the exact active harness attempt', () => {
  const context = { channelId: 'chan-harness-stop', userId: 'user-harness-stop', guildId: 'guild-harness-stop' };
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    userId: context.userId,
    metadata: { channelId: context.channelId, guildId: context.guildId },
  });
  const active = harnessTest.registerActiveChannelRunForTest({
    channel: 'discord',
    ...context,
    sessionId: session.id,
  });

  try {
    const stopped = __test__.stopDiscordContext(context);
    assert.deepEqual(stopped.stoppedSessionIds, [session.id]);
    assert.equal(isKillRequested(session.id, active), true);
  } finally {
    harnessTest.unregisterActiveChannelRunForTest(active, 'cancelled');
  }
});

test('Discord stop is principal-scoped inside one shared channel', () => {
  const common = { channelId: 'chan-shared-stop', guildId: 'guild-shared-stop' };
  const sessionA = createSession({
    kind: 'chat', channel: 'discord', userId: 'user-stop-a',
    metadata: { source: 'discord', ...common, userId: 'user-stop-a' },
  });
  const sessionB = createSession({
    kind: 'chat', channel: 'discord', userId: 'user-stop-b',
    metadata: { source: 'discord', ...common, userId: 'user-stop-b' },
  });
  bindDiscordHarnessSession({ ...common, userId: 'user-stop-a', sessionId: sessionA.id });
  bindDiscordHarnessSession({ ...common, userId: 'user-stop-b', sessionId: sessionB.id });
  const activeA = harnessTest.registerActiveChannelRunForTest({
    channel: 'discord', ...common, userId: 'user-stop-a', sessionId: sessionA.id,
  });
  const activeB = harnessTest.registerActiveChannelRunForTest({
    channel: 'discord', ...common, userId: 'user-stop-b', sessionId: sessionB.id,
  });
  const taskB = createBackgroundTask({
    title: 'other user shared-channel task',
    prompt: 'keep running',
    originSessionId: sessionB.id,
    userId: 'user-stop-b',
    channel: 'discord:guild-shared-stop:chan-shared-stop',
    source: 'discord',
  });
  markBackgroundTaskRunning(taskB.id);
  try {
    const stopped = __test__.stopDiscordContext({ ...common, userId: 'user-stop-a' });
    assert.deepEqual(stopped.stoppedSessionIds, [sessionA.id]);
    assert.equal(isKillRequested(sessionA.id, activeA), true);
    assert.equal(isKillRequested(sessionB.id, activeB), false);
    assert.equal(getBackgroundTask(taskB.id)?.status, 'running');
  } finally {
    harnessTest.unregisterActiveChannelRunForTest(activeA, 'cancelled');
    harnessTest.unregisterActiveChannelRunForTest(activeB, 'cancelled');
  }
});

test('Discord stop rehydrates and exact-kills the durable active attempt after restart', () => {
  const context = { channelId: 'chan-restart-stop', userId: 'user-restart-stop', guildId: 'guild-restart-stop' };
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    userId: context.userId,
    metadata: {
      source: 'discord',
      channelId: context.channelId,
      userId: context.userId,
      guildId: context.guildId,
    },
  });
  assert.equal(bindDiscordHarnessSession({ ...context, sessionId: session.id }), true);
  const attempt = beginRunAttempt(session.id);

  // Simulate a daemon restart: process-local continuity and active-run maps no
  // longer know this turn, while the channel binding + attempt remain in SQLite.
  clearDiscordHarnessSession(context.channelId, {
    channel: 'discord',
    userId: context.userId,
    guildId: context.guildId,
  });
  const stopped = __test__.stopDiscordContext(context);

  assert.deepEqual(stopped.stoppedSessionIds, [session.id]);
  assert.equal(isKillRequested(session.id, attempt), true);
  assert.equal(getKillRequest(session.id, attempt)?.attemptId, attempt.attemptId);
});
