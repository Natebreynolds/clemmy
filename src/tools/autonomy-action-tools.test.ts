/**
 * Run: npx tsx --test src/tools/autonomy-action-tools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-autonomy-action-tools-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  registerAutonomyActionTools,
  workflowRunNotificationAuthorityState,
} = await import('./autonomy-action-tools.js');
const {
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  queueWorkflowRun,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupClosedBatch,
} = await import('./workflow-run-queue.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const {
  appendAsyncWorkDispatchBatchClosedOnce,
  appendEvent,
  createSession,
} = await import('../runtime/harness/eventlog.js');

type ToolResult = { content?: Array<{ text?: string }> };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registeredHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  registerAutonomyActionTools({
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as never);
  return handlers;
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('notify_user is dashboard-only for exact authority while scheduled and legacy v1 remain compatible', async () => {
  const scheduled = queueWorkflowRun('Scheduled compatibility control', {}, { dedupe: false });
  const legacy = queueWorkflowRun('Legacy chat compatibility control', {}, {
    dedupe: false,
    originSessionId: 'sess-legacy-origin',
  });
  createSession({
    id: 'sess-exact-origin',
    kind: 'chat',
    channel: 'desktop',
  });
  const exactSource = appendEvent({
    sessionId: 'sess-exact-origin',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run the exact notification control.' },
  });
  const exact = queueWorkflowRun('Exact chat authority control', {}, {
    originSessionId: 'sess-exact-origin',
    originObserver: {
      sessionId: 'sess-exact-origin',
      sourceUserSeq: exactSource.seq,
      replyTarget: { type: 'origin_chat' },
    },
    prepareChatDispatch: (authority) => {
      const prepared = appendEvent({
        sessionId: exactSource.sessionId,
        turn: exactSource.turn,
        role: 'system',
        type: 'async_work_dispatch_prepared',
        parentEventId: exactSource.id,
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
  assert.ok(scheduled.id && legacy.id && exact.id);
  assert.equal(exact.status, 'held');
  assert.ok(exact.chatDispatchPreparation);
  const closeAuthority = createWorkflowOriginGroupCloseAuthority([exact.chatDispatchPreparation]);
  const closeEvent = appendAsyncWorkDispatchBatchClosedOnce({
    sessionId: exactSource.sessionId,
    turn: exactSource.turn,
    sourceUserSeq: exactSource.seq,
    data: { ...closeAuthority },
  }).event;
  const closeReceipt = createWorkflowOriginGroupClosedBatchReceipt(closeAuthority, {
    eventId: closeEvent.id,
    eventSeq: closeEvent.seq,
    closedAt: closeEvent.createdAt,
  });
  recordWorkflowOriginGroupClosedBatch({
    receipt: closeReceipt,
    preparedReceipts: [exact.chatDispatchPreparation],
  });
  finalizeWorkflowOriginGroupClosedBatch(closeAuthority.sourceGroupId, {
    beforeMemberRelease: () => {},
  });
  assert.equal(workflowRunNotificationAuthorityState(scheduled.id), 'none');
  assert.equal(workflowRunNotificationAuthorityState(legacy.id), 'none');
  assert.equal(workflowRunNotificationAuthorityState(exact.id), 'exact');

  const exactStepSessionId = `workflow:${exact.id}:notify_step`;
  createSession({
    id: exactStepSessionId,
    kind: 'workflow',
    channel: 'workflow',
    metadata: { workflowRunId: exact.id, stepId: 'notify_step' },
  });

  const notify = registeredHandlers().get('notify_user');
  assert.ok(notify);
  const realDateNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now++;
  try {
    await withToolOutputContext(
      { workflowRunId: scheduled.id, sessionId: `workflow:${scheduled.id}:report` },
      () => notify!({ title: 'Scheduled', body: 'Scheduled external compatibility', kind: 'workflow' }),
    );
    await withToolOutputContext(
      { workflowRunId: legacy.id, sessionId: `workflow:${legacy.id}:report` },
      () => notify!({ title: 'Legacy', body: 'Legacy external compatibility', kind: 'workflow' }),
    );
    // The direct Codex workflow lane carries sessionId but may not carry
    // explicit workflow attribution. Durable step-session metadata owns it.
    await withToolOutputContext(
      { sessionId: exactStepSessionId },
      () => notify!({ title: 'Exact', body: 'Exact dashboard evidence', kind: 'workflow' }),
    );
  } finally {
    Date.now = realDateNow;
  }

  const byBody = new Map(loadNotifications().map((item) => [item.body, item]));
  assert.notEqual(byBody.get('Scheduled external compatibility')?.silent, true);
  assert.notEqual(byBody.get('Legacy external compatibility')?.silent, true);
  const exactNotice = byBody.get('Exact dashboard evidence');
  assert.equal(exactNotice?.silent, true, 'interim exact-observer notice cannot fan out beside the terminal outbox');
  assert.equal(exactNotice?.metadata?.workflowRunId, exact.id, 'durable workflow-step metadata supplies run authority');
  assert.equal(exactNotice?.metadata?.workflowStepId, 'notify_step');
  assert.equal(exactNotice?.metadata?.exactOriginTerminalAuthority, true);
});

test('corrupt observer sidecars fail closed instead of leaking through global notification delivery', async () => {
  const runId = 'corrupt-observer-notification-control';
  const runKey = createHash('sha256').update(runId).digest('hex');
  const sidecarDir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', runKey);
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(path.join(sidecarDir, 'broken.json'), '{not-json', 'utf-8');

  assert.equal(
    workflowRunNotificationAuthorityState(runId),
    'corrupt',
    'present-but-unreadable authority is distinct from an absent observer',
  );

  const notify = registeredHandlers().get('notify_user');
  assert.ok(notify);
  await withToolOutputContext(
    { workflowRunId: runId, sessionId: `workflow:${runId}:report` },
    () => notify!({ title: 'Corrupt authority', body: 'Must not leak globally', kind: 'workflow' }),
  );
  const notice = loadNotifications().find((item) => item.body === 'Must not leak globally');
  assert.equal(notice?.silent, true);
  assert.equal(notice?.metadata?.originObserverAuthorityUnreadable, true);
});
