/**
 * Focused regression coverage for deterministic Discord/Slack early outcomes.
 *
 * Run: npx tsx --test src/channels/discord-harness-terminal.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discord-terminal-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  __test__,
  bindDiscordHarnessSession,
  tryHandleHarnessApprovalReply,
  UnboundDurableApprovalReplyError,
} = await import('./discord-harness.js');
const { createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { bindInboundSource, claimInbound, getInbound } = await import('./inbox-store.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function terminalEvents(sessionId: string) {
  return listEvents(sessionId, { types: ['conversation_completed'] });
}

function recordingTransport() {
  const initial: string[] = [];
  const errors: string[] = [];
  return {
    initial,
    errors,
    transport: {
      async sendInitial(content: string) {
        initial.push(content);
        return { async edit() {} };
      },
      async sendError(content: string) {
        errors.push(content);
      },
    },
  };
}

test('accepted channel requests persist their typed progress presentation for approval resumes', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const active = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-quiet-policy',
    userId: 'user-quiet-policy',
    guildId: null,
    sessionId: session.id,
  });
  try {
    const accepted = __test__.recordActiveChannelUserInputForTest(
      active,
      'Find the verified result.',
      'Do not narrate your plan or tool calls. Return only the verified answer.',
    );
    assert.equal(accepted.data.progressPresentation, 'quiet');
    assert.equal(__test__.progressPresentationForSessionForTest(session.id), 'quiet');
  } finally {
    __test__.unregisterActiveChannelRunForTest(active);
  }
});

let durableOrdinal = 0;
function durableProviderRequest(channelId: string, prompt: string, sessionId?: string) {
  durableOrdinal += 1;
  const sourceMessageId = `provider-approval-${durableOrdinal}`;
  const channel = `discord:${channelId}`;
  const runId = `discord-run-${durableOrdinal}`;
  claimInbound({
    channel,
    sourceMessageId,
    sessionId,
    userId: `user-${durableOrdinal}`,
    runId,
    payloadHash: `payload:${prompt}`,
  });
  return {
    channel,
    sourceMessageId,
    durableRequest: {
      runId,
      sessionId,
      onSourceAccepted(source: { sessionId: string; seq: number }) {
        bindInboundSource({
          channel,
          sourceMessageId,
          sessionId: source.sessionId,
          runId,
          sourceUserSeq: source.seq,
        });
      },
    },
  };
}

function typedTerminalStatus(sessionId: string): string | undefined {
  const terminal = terminalEvents(sessionId)[0];
  return (terminal?.data.turnOutcome as { status?: string } | undefined)?.status;
}

test('fresh Discord /goal outcome owns the newly accepted user turn', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const active = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-goal-fresh',
    userId: 'user-goal-fresh',
    guildId: null,
    sessionId: session.id,
  });

  try {
    const accepted = __test__.recordActiveChannelUserInputForTest(
      active,
      '/goal status',
      '/goal status',
    );
    __test__.commitDiscordAnswerForTest({
      source: accepted,
      text: 'No goal is currently active.',
      reason: 'goal_command',
      metadata: { steps: 0 },
    });
    // A transport retry of the same accepted outcome must reuse the durable
    // terminal instead of publishing a second assistant turn.
    __test__.commitDiscordAnswerForTest({
      source: accepted,
      text: 'No goal is currently active.',
      reason: 'goal_command',
      metadata: { steps: 0 },
    });

    const users = listEvents(session.id, { types: ['user_input_received'] });
    const completed = terminalEvents(session.id);
    assert.equal(users.length, 1);
    assert.equal(users[0].seq, accepted.seq);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].data.reason, 'goal_command');
    assert.equal(completed[0].data.sourceUserSeq, accepted.seq);
    assert.equal(completed[0].data.terminalKey, `turn:${accepted.seq}`);
    assert.equal((completed[0].data.presentation as { text?: string }).text, 'No goal is currently active.');
  } finally {
    __test__.unregisterActiveChannelRunForTest(active);
  }
});

test('continuing Discord durable-background outcome cannot reuse the prior turn identity', () => {
  const session = createSession({ kind: 'chat', channel: 'discord' });
  const first = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-background-continuing',
    userId: 'user-background-continuing',
    guildId: null,
    sessionId: session.id,
  });
  const firstUser = __test__.recordActiveChannelUserInputForTest(first, 'hello', 'hello');
  __test__.commitDiscordAnswerForTest({
    source: firstUser,
    text: 'Hello.',
    reason: 'success',
  });
  __test__.unregisterActiveChannelRunForTest(first);

  const second = __test__.registerActiveChannelRunForTest({
    channel: 'discord',
    channelId: 'chan-background-continuing',
    userId: 'user-background-continuing',
    guildId: null,
    sessionId: session.id,
  });
  try {
    const accepted = __test__.recordActiveChannelUserInputForTest(
      second,
      '/background finish the report',
      '/background finish the report',
    );
    __test__.commitDiscordAnswerForTest({
      source: accepted,
      text: 'Queued the report as a background task.',
      reason: 'queued_background',
      metadata: { steps: 0, queuedTaskId: 'bg-test' },
    });

    const users = listEvents(session.id, { types: ['user_input_received'] });
    const completed = terminalEvents(session.id);
    assert.equal(users.length, 2);
    assert.equal(completed.length, 2);
    assert.notEqual(accepted.seq, firstUser.seq);
    assert.notEqual(completed[1].data.terminalKey, completed[0].data.terminalKey);
    assert.equal(completed[1].data.reason, 'queued_background');
    assert.equal(completed[1].data.sourceUserSeq, accepted.seq);
    assert.equal(completed[1].data.terminalKey, `turn:${accepted.seq}`);
    assert.equal((completed[1].data.presentation as { text?: string }).text, 'Queued the report as a background task.');
  } finally {
    __test__.unregisterActiveChannelRunForTest(second);
  }
});

test('missing approval owns one provider receipt, source, and needs-input terminal; retry only replays', async () => {
  const channelId = 'chan-missing-durable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  assert.equal(bindDiscordHarnessSession({ channelId, sessionId: session.id }), true);

  const prompt = 'approve apr-none';
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();
  const input = {
    channelId,
    prompt,
    transport: delivery.transport,
    allowGlobalApprovalFallback: true,
    durableRequest: provider.durableRequest,
  };

  assert.equal(await tryHandleHarnessApprovalReply(input), true);
  assert.equal(await tryHandleHarnessApprovalReply(input), true);

  const receipt = getInbound(provider.channel, provider.sourceMessageId);
  const users = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = terminalEvents(session.id);
  assert.equal(receipt?.sessionId, session.id);
  assert.equal(receipt?.sourceUserSeq, users[0]?.seq);
  assert.equal(users.length, 1, 'redelivery must not append another accepted source');
  assert.equal(terminals.length, 1, 'redelivery must not append another terminal');
  assert.equal(terminals[0].data.sourceUserSeq, users[0].seq);
  assert.equal(typedTerminalStatus(session.id), 'needs_input');
  assert.equal(delivery.initial.length, 2, 'first delivery plus exact terminal replay');
  assert.equal(delivery.initial[1], delivery.initial[0]);
  assert.equal(delivery.errors.length, 0);
  assert.equal(listEvents(session.id, { types: ['tool_called', 'run_completed'] }).length, 0);
});

test('unprovable approval session fails closed before source, terminal, mutation, or model dispatch', async () => {
  const channelId = 'chan-unbound-durable-approval';
  const prompt = 'approve apr-missing';
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();

  await assert.rejects(
    tryHandleHarnessApprovalReply({
      channelId,
      prompt,
      transport: delivery.transport,
      allowGlobalApprovalFallback: true,
      durableRequest: provider.durableRequest,
    }),
    UnboundDurableApprovalReplyError,
  );

  const receipt = getInbound(provider.channel, provider.sourceMessageId);
  assert.equal(receipt?.status, 'claimed');
  assert.equal(receipt?.sessionId, undefined);
  assert.equal(receipt?.sourceUserSeq, undefined);
  assert.deepEqual(delivery.initial, []);
  assert.deepEqual(delivery.errors, []);
});

test('ambiguous bare approval commits needs-input without resolving either card', async () => {
  const channelId = 'chan-ambiguous-durable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  bindDiscordHarnessSession({ channelId, sessionId: session.id });
  const first = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Send the first message',
  });
  const second = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Send the second message',
  });
  const provider = durableProviderRequest(channelId, 'approve');
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId,
    prompt: 'approve',
    transport: delivery.transport,
    allowGlobalApprovalFallback: true,
    durableRequest: provider.durableRequest,
  }), true);

  assert.equal(approvalRegistry.get(first.approvalId)?.status, 'pending');
  assert.equal(approvalRegistry.get(second.approvalId)?.status, 'pending');
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(terminalEvents(session.id).length, 1);
  assert.equal(typedTerminalStatus(session.id), 'needs_input');
  assert.match(delivery.initial[0], /Pick the one you mean/i);
  assert.equal(listEvents(session.id, { types: ['tool_called', 'run_completed'] }).length, 0);
});

test('cross-channel approval commits in the current conversation and leaves the foreign card pending', async () => {
  const currentChannelId = 'chan-current-approval';
  const foreignChannelId = 'chan-foreign-approval';
  const current = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId: currentChannelId },
  });
  const foreign = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId: foreignChannelId },
  });
  bindDiscordHarnessSession({ channelId: currentChannelId, sessionId: current.id });
  bindDiscordHarnessSession({ channelId: foreignChannelId, sessionId: foreign.id });
  const approval = approvalRegistry.register({
    sessionId: foreign.id,
    channel: 'discord',
    channelId: foreignChannelId,
    subject: 'Foreign write',
  });
  const prompt = `approve ${approval.approvalId}`;
  const provider = durableProviderRequest(currentChannelId, prompt);
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId: currentChannelId,
    prompt,
    transport: delivery.transport,
    durableRequest: provider.durableRequest,
  }), true);

  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'pending');
  assert.equal(listEvents(current.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(terminalEvents(current.id).length, 1);
  assert.equal(typedTerminalStatus(current.id), 'needs_input');
  assert.equal(listEvents(foreign.id, { types: ['user_input_received', 'conversation_completed'] }).length, 0);
  assert.match(delivery.initial[0], /different or stale conversation/i);
});

test('expired approval accepts its source before mutation and commits needs-input', async () => {
  const channelId = 'chan-expired-durable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  bindDiscordHarnessSession({ channelId, sessionId: session.id });
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Expired write',
    ttlMs: -1,
  });
  const prompt = `approve ${approval.approvalId}`;
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId,
    prompt,
    transport: delivery.transport,
    durableRequest: provider.durableRequest,
  }), true);

  const users = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = terminalEvents(session.id);
  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'expired');
  assert.equal(users.length, 1);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.sourceUserSeq, users[0].seq);
  assert.equal(typedTerminalStatus(session.id), 'needs_input');
  assert.match(delivery.initial[0], /has expired/i);
});

test('already-resolved approval gets a deterministic needs-input terminal without re-mutation', async () => {
  const channelId = 'chan-resolved-durable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  bindDiscordHarnessSession({ channelId, sessionId: session.id });
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Already handled write',
  });
  assert.equal(approvalRegistry.resolve(approval.approvalId, 'approved', 'test').ok, true);
  const prompt = `approve ${approval.approvalId}`;
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId,
    prompt,
    transport: delivery.transport,
    durableRequest: provider.durableRequest,
  }), true);

  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'resolved');
  assert.equal(approvalRegistry.get(approval.approvalId)?.resolution, 'approved');
  assert.equal(listEvents(session.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(terminalEvents(session.id).length, 1);
  assert.equal(typedTerminalStatus(session.id), 'needs_input');
  assert.match(delivery.initial[0], /already resolved/i);
});

test('model-runtime-unavailable resume has an accepted source and failed terminal without resolving approval', async () => {
  const channelId = 'chan-runtime-unavailable-approval';
  const session = createSession({
    kind: 'chat',
    channel: 'discord',
    metadata: { source: 'discord', channelId },
  });
  bindDiscordHarnessSession({ channelId, sessionId: session.id });
  HarnessSession.load(session.id)?.saveInterruptState('{"test":"paused"}');
  const approval = approvalRegistry.register({
    sessionId: session.id,
    channel: 'discord',
    channelId,
    subject: 'Runtime-gated write',
  });
  const prompt = `approve ${approval.approvalId}`;
  const provider = durableProviderRequest(channelId, prompt);
  const delivery = recordingTransport();

  assert.equal(await tryHandleHarnessApprovalReply({
    channelId,
    prompt,
    transport: delivery.transport,
    durableRequest: provider.durableRequest,
  }), true);

  const users = listEvents(session.id, { types: ['user_input_received'] });
  const terminals = terminalEvents(session.id);
  assert.equal(users.length, 1);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.sourceUserSeq, users[0].seq);
  assert.equal(typedTerminalStatus(session.id), 'failed');
  assert.equal(approvalRegistry.get(approval.approvalId)?.status, 'pending');
  assert.equal(listEvents(session.id, { types: ['tool_called', 'run_completed'] }).length, 0);
  assert.match(delivery.initial[0], /model|connect|settings/i);
});
