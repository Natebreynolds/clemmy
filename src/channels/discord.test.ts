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
} = await import('./discord-harness.js');
const { getOrCreateDiscordSessionId } = await import('./discord-store.js');
const {
  createSession,
  beginRunAttempt,
  getActiveRunAttempt,
  getKillRequest,
  isKillRequested,
} = await import('../runtime/harness/eventlog.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  markBackgroundTaskRunning,
} = await import('../execution/background-tasks.js');

after(() => {
  if (PREV_HARNESS_WEBHOOK === undefined) delete process.env.CLEMMY_HARNESS_WEBHOOK;
  else process.env.CLEMMY_HARNESS_WEBHOOK = PREV_HARNESS_WEBHOOK;
  if (PREV_LEGACY_RESPOND_FALLBACK === undefined) delete process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  else process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = PREV_LEGACY_RESPOND_FALLBACK;
  if (PREV_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PREV_HOME;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('continue button resumes through the gateway with the original session id', async () => {
  let captured: { message: string; sessionId: string; userId?: string; channel?: string; runId?: string } | undefined;
  const assistant = {
    respond: async (req: typeof captured) => {
      captured = req;
      return { text: 'continued from gateway', sessionId: req!.sessionId };
    },
  };

  const response = await __test__.continueDiscordSessionFromButton({
    assistant: assistant as never,
    sessionId: 'sess-discord-original',
    userId: 'user-123',
    channelId: 'chan-456',
    guildId: 'guild-789',
  });

  assert.equal(response.text, 'continued from gateway');
  assert.equal(captured?.message, 'continue');
  assert.equal(captured?.sessionId, 'sess-discord-original');
  assert.equal(captured?.userId, 'user-123');
  assert.equal(captured?.channel, 'discord:guild-789:chan-456');
  assert.match(captured?.runId ?? '', /^run-/);
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
  const assistantEntered = new Promise<void>((resolve) => { entered = resolve; });
  const assistantReleased = new Promise<void>((resolve) => { release = resolve; });
  const running = __test__.runGatewayPrompt({
    assistant: {
      async respond(request: { sessionId: string }) {
        entered();
        await assistantReleased;
        return { text: 'Stopped.', sessionId: request.sessionId, stoppedReason: 'cancelled' as const };
      },
    } as never,
    prompt: 'do the current foreground work',
    ...context,
  });
  await assistantEntered;
  const attempt = getActiveRunAttempt(sessionId);
  assert.ok(attempt, 'gateway registers the attempt before model work');

  const stopped = __test__.stopDiscordContext(context);

  assert.deepEqual(stopped.stoppedSessionIds, [sessionId]);
  assert.deepEqual(new Set(stopped.stoppedTaskIds), new Set([task.id, queuedTask.id]));
  assert.equal(isKillRequested(sessionId, attempt!), true);
  assert.equal(getBackgroundTask(task.id)?.status, 'cancelling');
  assert.equal(getBackgroundTask(queuedTask.id)?.status, 'aborted');
  assert.equal(getKillRequest(task.runSessionId), null, 'no active task attempt means no session-wide kill latch');
  release();
  await running;
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
  clearDiscordHarnessSession(context.channelId);
  const stopped = __test__.stopDiscordContext(context);

  assert.deepEqual(stopped.stoppedSessionIds, [session.id]);
  assert.equal(isKillRequested(session.id, attempt), true);
  assert.equal(getKillRequest(session.id, attempt)?.attemptId, attempt.attemptId);
});
