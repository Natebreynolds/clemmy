/**
 * Production-connected hermetic pin for Autonomous conversational send consent.
 *
 * The provider is fake, but every host boundary is real:
 * direct SDK permission -> ordinary question -> exact Discord Yes -> hidden
 * approval row -> PendingAction claim -> batch dispatcher -> MCP namespace shim
 * -> one provider crossing. No model or network is used.
 *
 * Run:
 *   npx tsx --test src/channels/autonomous-send-consent-vertical.integration.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-autonomous-send-vertical-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_AUTONOMOUS_CONVERSATIONAL_CONSENT = 'on';
process.env.CLEMMY_GROUNDING_GATE = 'off';
process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
process.env.CLEMMY_OUTPUT_GROUNDING_GATE = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  appendEvent,
  beginRunAttempt,
  createSession,
  getRunAttemptBySourceUserSeq,
  listEvents,
  openEventLog,
  recordRunAttemptUserInput,
} = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const {
  getPendingAction,
  listPendingActions,
  verifyPendingActionExecutionCapability,
} = await import('../runtime/harness/pending-actions.js');
type PendingActionExecutionCapability = import('../runtime/harness/pending-actions.js').PendingActionExecutionCapability;
const {
  buildGatedToolPermission,
  surfaceDeferredConversationalApproval,
} = await import('../runtime/harness/claude-agent-approval.js');
type ClaudeAgentApprovalBoundary = import('../runtime/harness/claude-agent-approval.js').ClaudeAgentApprovalBoundary;
const { exactOriginDeliveryTargetDigest } = await import('../runtime/exact-origin-delivery.js');
const { listNotifications } = await import('../runtime/notifications.js');
const { saveProactivityPolicy } = await import('../agents/proactivity-policy.js');
const { createMcpNamespaceShim } = await import('../runtime/mcp-namespace-shim.js');
const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
const { approvedMandateAdmitsCall } = await import('../runtime/harness/expected-work-admission.js');
const {
  _resetChatApprovalResumeForTest,
  startChatApprovalResume,
} = await import('../runtime/harness/chat-approval-resume.js');
const {
  _setCodeModeMcpResolverForTests,
} = await import('../tools/code-mode-tool.js');
const {
  bindDiscordHarnessSession,
  tryHandleHarnessApprovalReply,
} = await import('./discord-harness.js');

type Permission = (
  name: string,
  input: Record<string, unknown>,
  options: unknown,
) => Promise<{
  behavior: string;
  message?: string;
  updatedInput?: Record<string, unknown>;
  interrupt?: boolean;
}>;

function permissionOptions(toolUseID: string): unknown {
  return { signal: new AbortController().signal, toolUseID };
}

function recordingTransport() {
  const initial: string[] = [];
  return {
    initial,
    transport: {
      async sendInitial(content: string) {
        initial.push(content);
        return { async edit() {} };
      },
      async sendError(content: string) {
        initial.push(content);
      },
    },
  };
}

test.after(() => {
  _resetChatApprovalResumeForTest();
  _setCodeModeMcpResolverForTests(null);
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('Autonomous ordinary Yes executes one frozen Outlook send through the real MCP shim', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo', batchConfirmThreshold: 5 });
  let legacyResumeDispatches = 0;
  _resetChatApprovalResumeForTest();
  startChatApprovalResume(async () => { legacyResumeDispatches += 1; });

  const channelId = 'autonomous-send-channel';
  const userId = 'autonomous-send-user';
  const conversationKey = `discord:${channelId}`;
  const originReplyTarget = { type: 'discord_channel' as const, channelId };
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId, userId },
  });
  assert.equal(bindDiscordHarnessSession({ channelId, sessionId: session.id, userId }), true);

  const firstAttempt = beginRunAttempt(session.id, { runId: 'autonomous-send-request-A' });
  const request = recordRunAttemptUserInput(firstAttempt, {
    turn: 1,
    role: 'user',
    data: {
      text: 'Create the Ventura sheet, then email it to nate@example.com.',
      displayText: 'Create the Ventura sheet, then email it to nate@example.com.',
      source: 'channel:discord',
      userId,
      conversationKey,
      originReplyTarget,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
    },
  }, { armRunInFlight: true });

  const payload = {
    to: 'nate@example.com',
    subject: 'Ventura restaurant shortlist',
    body: 'The sheet is ready: https://docs.google.com/spreadsheets/d/ventura-proof/edit',
  };

  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  let providerSourceUserSeq: number | undefined;
  let providerRunAttemptId: string | undefined;
  let providerAuthorityAtCrossing: {
    acceptedTaskId: string;
    expectedWorkRequired: number;
  } | undefined;
  let providerCapability: PendingActionExecutionCapability | undefined;
  let capabilityChecks: Record<string, boolean> | null = null;
  const provider: MCPServer = {
    name: 'outlook',
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools() {
      return [{
        name: 'OUTLOOK_SEND_EMAIL',
        description: 'Send one email.',
        inputSchema: { type: 'object' },
      }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool(tool, args) {
      const context = harnessRunContextStorage.getStore();
      providerSourceUserSeq = context?.sourceUserSeq;
      providerRunAttemptId = context?.runAttemptId;
      providerAuthorityAtCrossing = openEventLog().prepare(`
        SELECT accepted_task_id AS acceptedTaskId, expected_work_required AS expectedWorkRequired
          FROM accepted_task_authority
         WHERE session_id = ? AND source_user_seq = ?
      `).get(session.id, context?.sourceUserSeq ?? 0) as typeof providerAuthorityAtCrossing;
      const capability = context?.pendingActionExecution as PendingActionExecutionCapability | undefined;
      assert.ok(capability, 'the provider boundary receives the opaque PendingAction claim');
      providerCapability = capability;
      capabilityChecks = {
        exact: verifyPendingActionExecutionCapability({
          capability,
          sessionId: session.id,
          toolName: 'outlook__OUTLOOK_SEND_EMAIL',
          payload,
        }),
        wrongToken: verifyPendingActionExecutionCapability({
          capability: { ...capability, claimToken: `${capability.claimToken}-wrong` },
          sessionId: session.id,
          toolName: 'outlook__OUTLOOK_SEND_EMAIL',
          payload,
        }),
        wrongPayload: verifyPendingActionExecutionCapability({
          capability,
          sessionId: session.id,
          toolName: 'outlook__OUTLOOK_SEND_EMAIL',
          payload: { ...payload, subject: 'Changed after consent' },
        }),
        wrongSession: verifyPendingActionExecutionCapability({
          capability,
          sessionId: `${session.id}-wrong`,
          toolName: 'outlook__OUTLOOK_SEND_EMAIL',
          payload,
        }),
        wrongSource: verifyPendingActionExecutionCapability({
          capability: { ...capability, sourceUserSeq: capability.sourceUserSeq + 1 },
          sessionId: session.id,
          toolName: 'outlook__OUTLOOK_SEND_EMAIL',
          payload,
        }),
      };
      providerCalls.push({ tool, args });
      return [{
        type: 'text',
        text: JSON.stringify({ successful: true, data: { message_id: 'fake-outlook-message-1', status: 'sent' } }),
      }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
  } as MCPServer;
  const shim = createMcpNamespaceShim({ servers: [provider], cacheToolsList: false });
  await shim.listTools();
  _setCodeModeMcpResolverForTests(() => shim);

  let deferredBoundary: ClaudeAgentApprovalBoundary | null = null;
  const permission = buildGatedToolPermission(
    session.id,
    ['memory_read'],
    {
      approvalMode: 'park',
      sourceUserSeq: request.seq,
      onApprovalBoundary: (boundary) => { deferredBoundary = boundary; },
    },
  ) as unknown as Permission;
  const parked = await permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    payload,
    permissionOptions('sdk-send-A'),
  );
  assert.equal(parked.behavior, 'deny', 'the raw SDK send is parked before provider I/O');
  assert.equal(providerCalls.length, 0);

  const [row] = approvalRegistry.listPending({ sessionId: session.id, status: 'pending' });
  assert.ok(row?.presentation, 'the hidden approval row carries an ordinary question');
  assert.equal(row.presentation.kind, 'autonomous_send_consent');
  assert.equal(approvalRegistry.isFormalApprovalSurface(row), false);
  assert.match(row.presentation.question, /nate@example\.com/);
  assert.match(row.presentation.question, /Ventura restaurant shortlist/);
  assert.match(row.presentation.question, /docs\.google\.com/);
  assert.equal(
    listNotifications(100).some((notification) => notification.metadata?.approvalId === row.approvalId),
    false,
    'the ordinary question never enters an approval-card notification surface',
  );

  const pendingActionId = String(row.args?.pendingActionId ?? '');
  assert.ok(pendingActionId);
  const parkedPendingAction = getPendingAction(pendingActionId);
  assert.equal(parkedPendingAction?.status, 'approval_requested');
  const resumeKey = `pending-action-approval-v1:${session.id}:${pendingActionId}:${parkedPendingAction!.payloadHash}`;
  assert.equal(
    approvalRegistry.claimResumableApproval(resumeKey, row.approvalId).state,
    'pending_action_owned',
    'a presentation row is never a consumable raw-native grant',
  );
  assert.equal(listEvents(session.id, { types: ['approval_requested'] }).length, 0,
    'the permission hook does not expose an answer slot while native SDK A still owns execution');
  assert.ok(deferredBoundary?.conversational);
  assert.equal(
    surfaceDeferredConversationalApproval(deferredBoundary!),
    row.presentation.question,
    'the SDK-shutdown seam publishes the ordinary question only after A is parked',
  );
  const refreshedRow = approvalRegistry.get(row.approvalId)!;
  assert.ok(
    refreshedRow.presentation?.promptEventId && refreshedRow.presentation.promptEventSeq,
    JSON.stringify({
      permission: parked,
      approvalEvents: listEvents(session.id, { types: ['approval_requested'] })
        .map((event) => ({ id: event.id, seq: event.seq, data: event.data })),
      presentation: refreshedRow.presentation,
      pendingAction: getPendingAction(pendingActionId),
    }),
  );
  const presented = approvalRegistry.markConversationalApprovalPresented({
    approvalId: row.approvalId,
    promptEventId: refreshedRow.presentation!.promptEventId!,
    promptEventSeq: refreshedRow.presentation!.promptEventSeq!,
  });
  assert.ok(presented?.presentation?.presentedAt);

  // A native SDK replay while the question is pending cannot consume its row or
  // reach the provider. Only the host PendingAction machine owns dispatch.
  const rawReplay = await permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    payload,
    permissionOptions('sdk-send-A-replay'),
  );
  assert.equal(rawReplay.behavior, 'deny');
  assert.equal(providerCalls.length, 0);
  assert.equal(approvalRegistry.get(row.approvalId)?.consumedAt, null);

  const consentReply = "Yes that's all correct";
  const wrongUser = await tryHandleHarnessApprovalReply({
    channelId,
    prompt: consentReply,
    userId: `${userId}-wrong`,
    conversationKey,
    channel: 'discord',
    transport: recordingTransport().transport,
    durableRequest: {
      runId: 'autonomous-send-wrong-user',
      sessionId: session.id,
    },
  });
  const wrongConversation = await tryHandleHarnessApprovalReply({
    channelId,
    prompt: consentReply,
    userId,
    conversationKey: `${conversationKey}:wrong`,
    channel: 'discord',
    transport: recordingTransport().transport,
    durableRequest: {
      runId: 'autonomous-send-wrong-conversation',
      sessionId: session.id,
    },
  });
  assert.equal(wrongUser, false);
  assert.equal(wrongConversation, false);
  assert.equal(providerCalls.length, 0, 'only the addressed person and conversation can answer the question');

  const delivery = recordingTransport();
  const handled = await tryHandleHarnessApprovalReply({
    channelId,
    prompt: consentReply,
    userId,
    conversationKey,
    channel: 'discord',
    transport: delivery.transport,
    durableRequest: {
      runId: 'autonomous-send-answer-B',
      sessionId: session.id,
    },
  });
  assert.equal(handled, true);

  const answer = listEvents(session.id, { types: ['user_input_received'] })
    .find((event) => event.data.source === 'channel_send_consent');
  assert.ok(answer, 'the ordinary Yes is a durable accepted source B');
  assert.equal(approvalRegistry.get(row.approvalId)?.resolution, 'approved');
  assert.equal(approvalRegistry.get(row.approvalId)?.consumedAt, null,
    'the legacy raw-call grant is never consumed by conversational consent');
  assert.equal(getPendingAction(pendingActionId)?.status, 'executed');
  assert.equal(getPendingAction(pendingActionId)?.approvedBy, 'human');
  assert.equal(getPendingAction(pendingActionId)?.approvalEvidence?.kind, 'conversation');

  assert.equal(providerCalls.length, 1, 'exactly one Outlook provider crossing occurs');
  assert.equal(legacyResumeDispatches, 0,
    'the registry listener joins the conversational host flight instead of starting a model replay');
  assert.equal(providerCalls[0]?.tool, 'OUTLOOK_SEND_EMAIL');
  assert.deepEqual(providerCalls[0]?.args, payload);
  assert.equal(providerSourceUserSeq, answer.seq, 'the provider crossing belongs to accepted Yes source B');
  const answerAttempt = getRunAttemptBySourceUserSeq(session.id, answer.seq);
  assert.ok(answerAttempt, 'accepted Yes source B has one durable physical attempt');
  assert.equal(answerAttempt.runId, 'autonomous-send-answer-B');
  assert.equal(providerRunAttemptId, answerAttempt.attemptId,
    'the provider crossing carries B\'s exact physical run-attempt owner');
  assert.deepEqual(providerAuthorityAtCrossing, {
    acceptedTaskId: `task:${session.id}#${answer.seq}`,
    expectedWorkRequired: 1,
  }, 'action authority is armed and expected-work active before the provider crossing');
  assert.deepEqual(capabilityChecks, {
    exact: true,
    wrongToken: false,
    wrongPayload: false,
    wrongSession: false,
    wrongSource: false,
  });
  assert.ok(providerCapability);
  assert.equal(verifyPendingActionExecutionCapability({
    capability: providerCapability!,
    sessionId: session.id,
    toolName: 'outlook__OUTLOOK_SEND_EMAIL',
    payload,
  }), false, 'the exact opaque claim expires as soon as its PendingAction leaves EXECUTING');
  assert.equal(
    approvalRegistry.claimResumableApproval(resumeKey, row.approvalId).state,
    'pending_action_owned',
    'even the approved presentation row cannot grant a raw native replay',
  );

  const starts = listEvents(session.id, { types: ['provider_dispatch_started'] });
  assert.equal(starts.length, 1, 'the durable crossing ledger records one physical dispatch');
  assert.equal(starts[0]?.data.sourceUserSeq, answer.seq);
  assert.equal(starts[0]?.data.acceptedTaskId, `task:${session.id}#${answer.seq}`);
  assert.ok(starts[0]?.data.logicalToolCallId, 'the paid crossing has an admitted logical parent');
  const physicalSettlements = listEvents(session.id, { types: ['provider_dispatch_settled'] });
  assert.deepEqual(physicalSettlements.map((event) => ({
    sourceUserSeq: event.data.sourceUserSeq,
    acceptedTaskId: event.data.acceptedTaskId,
    logicalToolCallId: event.data.logicalToolCallId,
    physicalDispatchId: event.data.physicalDispatchId,
    outcome: event.data.outcome,
  })), [{
    sourceUserSeq: answer.seq,
    acceptedTaskId: `task:${session.id}#${answer.seq}`,
    logicalToolCallId: starts[0]!.data.logicalToolCallId,
    physicalDispatchId: starts[0]!.data.physicalDispatchId,
    outcome: 'returned',
  }], 'the one paid crossing has one B-owned physical settlement');

  const graphEvents = listEvents(session.id, { types: ['turn_graph_compiled'] })
    .filter((event) => event.data.sourceUserSeq === answer.seq);
  const graph = graphEvents[0]?.data.graph as {
    classification?: { route?: unknown; externalEffectRequested?: unknown };
    effectCeiling?: unknown;
  } | undefined;
  assert.equal(graphEvents.length, 1, 'accepted Yes source B owns one persisted graph');
  assert.equal(graph?.classification?.route, 'act');
  assert.equal(graph?.classification?.externalEffectRequested, true);
  assert.equal(graph?.effectCeiling, 'external_write');

  const db = openEventLog();
  const authority = db.prepare(`
    SELECT accepted_task_id AS acceptedTaskId, expected_work_required AS expectedWorkRequired
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, answer.seq) as {
    acceptedTaskId: string;
    expectedWorkRequired: number;
  } | undefined;
  assert.deepEqual(authority, {
    acceptedTaskId: `task:${session.id}#${answer.seq}`,
    expectedWorkRequired: 1,
  }, 'accepted Yes source B is armed as action authority before dispatch');

  assert.equal(
    approvedMandateAdmitsCall(
      db,
      session.id,
      answer.seq + 1,
      'outlook__OUTLOOK_SEND_EMAIL',
      payload,
    ),
    false,
    'the exact conversation mandate cannot be borrowed by another accepted source',
  );

  const physicalRows = db.prepare(`
    SELECT source_user_seq AS sourceUserSeq, accepted_task_id AS acceptedTaskId,
           logical_tool_call_id AS logicalToolCallId, state
      FROM physical_dispatches
     WHERE session_id = ?
     ORDER BY source_user_seq, ordinal
  `).all(session.id) as Array<{
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
    state: string;
  }>;
  assert.deepEqual(physicalRows, [{
    sourceUserSeq: answer.seq,
    acceptedTaskId: `task:${session.id}#${answer.seq}`,
    logicalToolCallId: starts[0]!.data.logicalToolCallId,
    state: 'returned',
  }], 'the one physical crossing is settled under B, never source A or source 0');

  const logicalRows = db.prepare(`
    SELECT l.source_user_seq AS sourceUserSeq, l.accepted_task_id AS acceptedTaskId,
           l.logical_tool_call_id AS logicalToolCallId, l.state,
           s.execution_kind AS executionKind, s.outcome_kind AS outcomeKind
      FROM logical_tool_calls l
      LEFT JOIN logical_call_settlements s
        ON s.session_id = l.session_id
       AND s.source_user_seq = l.source_user_seq
       AND s.logical_tool_call_id = l.logical_tool_call_id
     WHERE l.session_id = ?
     ORDER BY l.source_user_seq, l.opened_at
  `).all(session.id) as Array<{
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
    state: string;
    executionKind: string | null;
    outcomeKind: string | null;
  }>;
  assert.deepEqual(logicalRows, [{
    sourceUserSeq: answer.seq,
    acceptedTaskId: `task:${session.id}#${answer.seq}`,
    logicalToolCallId: starts[0]!.data.logicalToolCallId,
    state: 'settled',
    executionKind: 'provider_execution',
    outcomeKind: 'succeeded',
  }], 'the provider result settles its one logical parent under B');

  assert.match(delivery.initial.at(-1) ?? '', /Executed .*OUTLOOK_SEND_EMAIL/i);

  // Redelivering the same provider inbox answer cannot produce a second send.
  await tryHandleHarnessApprovalReply({
    channelId,
    prompt: consentReply,
    userId,
    conversationKey,
    channel: 'discord',
    transport: delivery.transport,
    durableRequest: {
      runId: 'autonomous-send-answer-B',
      sessionId: session.id,
    },
  });
  assert.equal(providerCalls.length, 1);

  // Even after approval, the original raw SDK call never receives an allow.
  const postApprovalRawReplay = await permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    payload,
    permissionOptions('sdk-send-A-post-approval-replay'),
  );
  assert.equal(postApprovalRawReplay.behavior, 'deny');
  assert.equal(providerCalls.length, 1);
  assert.equal(
    approvalRegistry.listPending({ sessionId: session.id, status: 'any' }).length,
    1,
    'a stale raw SDK replay cannot mint a second approval surface',
  );
  assert.equal(
    listPendingActions({ sessionId: session.id, status: 'all', limit: 100 }).length,
    1,
    'a stale raw SDK replay cannot mint a second frozen send',
  );

  // Dedupe is source-scoped, not a lifetime ban on the same bytes. A new real
  // user request may intentionally prepare that email again, but it receives a
  // fresh question and still cannot dispatch without its own Yes.
  const freshAttempt = beginRunAttempt(session.id, { runId: 'autonomous-send-request-C' });
  const freshRequest = recordRunAttemptUserInput(freshAttempt, {
    turn: 3,
    role: 'user',
    data: {
      text: 'Send that exact Ventura email again.',
      displayText: 'Send that exact Ventura email again.',
      source: 'channel:discord',
      userId,
      conversationKey,
      originReplyTarget,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
    },
  }, { armRunInFlight: true });
  const freshPermission = buildGatedToolPermission(session.id, ['memory_read'], {
    approvalMode: 'park',
    sourceUserSeq: freshRequest.seq,
  }) as unknown as Permission;
  const freshPark = await freshPermission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    payload,
    permissionOptions('sdk-send-C'),
  );
  assert.equal(freshPark.behavior, 'deny');
  assert.equal(freshPark.interrupt, true);
  assert.equal(providerCalls.length, 1);
  assert.equal(
    approvalRegistry.listPending({ sessionId: session.id, status: 'any' }).length,
    2,
    'a genuinely new accepted source receives its own frozen decision',
  );
  assert.equal(
    listPendingActions({ sessionId: session.id, status: 'all', limit: 100 }).length,
    2,
    'a genuinely new accepted source may intentionally prepare the same bytes',
  );

  // The mandate lookup is exact and unbounded. Nine newer approved rows with
  // drifted payloads cannot hide the one conversational decision that owns B.
  for (let index = 0; index < 9; index += 1) {
    const noise = approvalRegistry.register({
      sessionId: session.id,
      subject: `Newer unrelated approval ${index}`,
      tool: 'outlook__OUTLOOK_SEND_EMAIL',
      args: { ...payload, subject: `Unapproved drift ${index}` },
    });
    approvalRegistry.resolve(noise.approvalId, 'approved', 'formal-test-user');
    db.prepare('UPDATE pending_approvals SET resolved_at = ? WHERE approval_id = ?')
      .run(`2099-01-01T00:00:${String(index).padStart(2, '0')}.000Z`, noise.approvalId);
  }
  assert.equal(
    approvedMandateAdmitsCall(
      db,
      session.id,
      answer.seq,
      'outlook__OUTLOOK_SEND_EMAIL',
      payload,
    ),
    true,
    'the exact B mandate remains discoverable beyond eight newer approvals',
  );
});
