/**
 * Run: npx tsx --test src/runtime/harness/restart-auto-resume.test.ts
 *
 * 2026-07-09 — auto-resume of restart-interrupted chat runs. Safety bar:
 * no landed or unresolved external write in the interrupted window, fresh,
 * bounded per boot, kill-switch. Ineligible runs keep the manual banner.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-auto-resume';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const {
  appendEvent,
  beginRunAttempt,
  getLatestRunAttempt,
  isKillRequested,
  listEvents,
  recordRunAttemptUserInput,
  requestKill,
  resetEventLog,
} = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const {
  clearRunInFlightAfterTerminal,
  recoverInterruptedChatRuns,
  markRunInFlight,
  AUTO_RESUME_DIRECTIVE,
} = await import('./restart-recovery.js');
const {
  createWorkflowChatDispatchPreparedReceipt,
  queueWorkflowRun,
  readPendingWorkflowChatDispatchOwnership,
  recordWorkflowChatDispatchPreparation,
} = await import('../../tools/workflow-run-queue.js');
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
const { writeWorkflow } = await import('../../memory/workflow-store.js');
const { finalizePreparedWorkflowDispatchForSource } = await import('./loop.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');

const TEST_ORIGIN_REPLY_TARGET = { type: 'origin_chat' } as const;

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  resetEventLog();
  delete process.env.CLEMMY_CHAT_AUTO_RESUME;
});

function interruptedChatSession(): string {
  const sess = HarnessSession.create({ kind: 'chat', title: 'diag' });
  const attempt = beginRunAttempt(sess.id, { runId: `restart-test:${sess.id}` });
  recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Finish the interrupted task.' },
  });
  markRunInFlight(sess.id, true); // never cleared = killed mid-run
  return sess.id;
}

function interruptedPreparedWorkflowSession(since: string): {
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
  runId: string;
} {
  const sess = HarnessSession.create({ kind: 'chat', title: 'prepared workflow interrupted' });
  const attempt = beginRunAttempt(sess.id, { runId: `restart-prepared:${sess.id}` });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: {
      text: 'Run the admitted background workflow.',
      originReplyTarget: TEST_ORIGIN_REPLY_TARGET,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(TEST_ORIGIN_REPLY_TARGET),
    },
  });
  sess.setRunInFlight(since);
  writeWorkflow('restart-prepared-only', {
    name: 'restart-prepared-only',
    description: 'A bounded restart ownership fixture.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'work', prompt: 'Perform the admitted read-only work.', sideEffect: 'read' }],
  });
  const queued = queueWorkflowRun('restart-prepared-only', {}, {
    originSessionId: sess.id,
    originObserver: {
      sessionId: sess.id,
      sourceUserSeq: source.seq,
      replyTarget: { type: 'origin_chat' },
    },
    prepareChatDispatch: (authority) => {
      const prepared = appendEvent({
        sessionId: sess.id,
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
  assert.equal(queued.status, 'held');
  assert.ok(queued.id);
  return {
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    attemptId: attempt.attemptId,
    runId: queued.id,
  };
}

for (const scenario of [
  {
    label: 'auto-resume disabled',
    skipped: 'disabled' as const,
    ageMs: 60_000,
    configure: (_sessionId: string) => { process.env.CLEMMY_CHAT_AUTO_RESUME = 'off'; },
  },
  {
    label: 'interruption too old',
    skipped: 'too_old' as const,
    ageMs: 3 * 60 * 60_000,
    configure: (_sessionId: string) => {},
  },
  {
    label: 'external write blocks replay',
    skipped: 'external_write' as const,
    ageMs: 60_000,
    configure: (sessionId: string) => {
      appendEvent({
        sessionId,
        turn: 1,
        role: 'system',
        type: 'external_write',
        data: { tool: 'composio_execute_tool', callId: `prepared-write:${sessionId}` },
      });
    },
  },
]) {
  test(`prepared-only workflow ownership survives restart when ${scenario.label}`, async () => {
    const nowMs = Date.now();
    const since = new Date(nowMs - scenario.ageMs).toISOString();
    const fixture = interruptedPreparedWorkflowSession(since);
    scenario.configure(fixture.sessionId);
    const dispatched: string[] = [];

    const summary = recoverInterruptedChatRuns(
      () => nowMs,
      async (sessionId) => { dispatched.push(sessionId); },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(summary.recovered, 1);
    assert.deepEqual(dispatched, []);
    assert.equal(summary.records[0]?.autoResumeSkipped, scenario.skipped);
    assert.equal(summary.records[0]?.preparedDispatchOwnershipPreserved, true);
    assert.deepEqual(summary.records[0]?.preparedDispatchRunIds, [fixture.runId]);
    assert.equal(summary.records[0]?.markerCleared, false);
    assert.ok(HarnessSession.load(fixture.sessionId)?.runInFlightSince(), 'chat ownership remains armed');
    assert.equal(getLatestRunAttempt(fixture.sessionId)?.status, 'active', 'the exact source attempt remains actionable');
    assert.equal(
      clearRunInFlightAfterTerminal(
        fixture.sessionId,
        fixture.attemptId,
        fixture.sourceUserSeq,
      ),
      false,
      'ordinary terminal cleanup cannot cross the pending queue ownership',
    );
    assert.equal(
      JSON.parse(readFileSync(`${WORKFLOW_RUNS_DIR}/${fixture.runId}.json`, 'utf-8')).status,
      'awaiting_chat_dispatch_seal',
    );
    assert.deepEqual(
      readPendingWorkflowChatDispatchOwnership({
        sessionId: fixture.sessionId,
        sourceUserSeq: fixture.sourceUserSeq,
      })?.runIds,
      [fixture.runId],
    );
    assert.equal(
      listEvents(fixture.sessionId, { types: ['conversation_completed'] }).length,
      0,
      'manual recovery guidance is nonterminal while admitted work owns the source',
    );
    const paused = listEvents(fixture.sessionId, { types: ['run_paused'] }).at(-1);
    assert.equal(paused?.data.reason, 'prepared_workflow_dispatch_interrupted');
    assert.deepEqual(paused?.data.runIds, [fixture.runId]);
  });
}

test('a clean interrupted run is auto-resumed with nonterminal progress only', async () => {
  const id = interruptedChatSession();
  const dispatched: Array<{ sessionId: string; directive: string; sourceUserSeq: number }> = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId, directive, sourceUserSeq) => {
    dispatched.push({ sessionId, directive, sourceUserSeq });
  });
  assert.equal(summary.recovered, 1);
  const rec = summary.records[0];
  assert.equal(rec.autoResumed, true);
  assert.equal(rec.autoResumeSkipped, undefined);
  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget dispatch settles
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sessionId, id);
  assert.equal(dispatched[0].directive, AUTO_RESUME_DIRECTIVE);
  assert.equal(dispatched[0].sourceUserSeq, getLatestRunAttempt(id)?.sourceUserSeq);
  assert.equal(
    listEvents(id, { types: ['user_input_received'] }).length,
    1,
    'restart dispatch reuses the accepted source instead of appending its directive as a user turn',
  );
  assert.equal(
    listEvents(id, { types: ['conversation_completed'] }).length,
    0,
    'auto-resume progress is not published as a false terminal before the resumed answer',
  );
  const resumed = listEvents(id, { types: ['run_resumed'] });
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].data.reason, 'restart_auto_resume');
  assert.equal(resumed[0].data.autoResume, true);
  const decisions = listEvents(id, { types: ['restart_recovery_decision'] });
  assert.equal(decisions.length, 1);
  assert.deepEqual(
    {
      eligible: decisions[0].data.eligible,
      autoResume: decisions[0].data.autoResume,
      autoResumeSkipped: decisions[0].data.autoResumeSkipped,
      externalWritesSinceInterrupt: decisions[0].data.externalWritesSinceInterrupt,
      writeCheckFailed: decisions[0].data.writeCheckFailed,
      bootResumeOrdinal: decisions[0].data.bootResumeOrdinal,
    },
    {
      eligible: true,
      autoResume: true,
      autoResumeSkipped: null,
      externalWritesSinceInterrupt: 0,
      writeCheckFailed: false,
      bootResumeOrdinal: 1,
    },
  );
});

test('a persisted user stop is never resurrected by restart auto-resume', async () => {
  const sess = HarnessSession.create({ kind: 'chat', title: 'stopped work' });
  const attempt = beginRunAttempt(sess.id, { runId: 'stopped-before-restart' });
  recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: 'Do the long task' },
  });
  markRunInFlight(sess.id, true);
  requestKill(sess.id, 'user pressed Stop', attempt);

  const dispatched: string[] = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId) => { dispatched.push(sessionId); });
  assert.equal(summary.records[0].autoResumed, false);
  assert.equal(summary.records[0].autoResumeSkipped, 'user_stopped');
  assert.equal(summary.records[0].replayPrepared, false, 'stopped work gets no continue/resume primer');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(dispatched, []);
  const notice = listEvents(sess.id, { types: ['conversation_completed'] }).at(-1)?.data as { reason?: string; reply?: string };
  assert.equal(notice.reason, 'stopped_before_restart');
  assert.match(String(notice.reply ?? ''), /stopped as requested/i);
  assert.doesNotMatch(String(notice.reply ?? ''), /reply `continue`/i);
  assert.equal(
    (notice as { presentation?: { status?: string } }).presentation?.status,
    'cancelled',
  );
  assert.equal(
    (notice as { presentation?: { kind?: string } }).presentation?.kind,
    'stopped',
  );
  assert.equal(isKillRequested(sess.id, attempt), false, 'restart terminal cleanup consumes only the stopped attempt latch');
});

test('answer -> successful space_save -> crash uses the generic durable-result reconciler', async () => {
  const sess = HarnessSession.create({ kind: 'chat', title: 'workspace build' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'Should this refresh daily or only when you click Refresh?', source: 'decision_awaiting' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { awaitingUser: true, summary: 'Should this refresh daily or only when you click Refresh?' },
  });
  sess.setRunInFlight();
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Refresh it daily.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'space_save', callId: 'space-save-1' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'tool',
    type: 'tool_returned',
    data: {
      tool: 'space_save',
      callId: 'space-save-1',
      result: 'Created workspace "Salesforce Daily Report" (salesforce-daily-report) - status active.',
    },
  });

  const dispatched: Array<{ sessionId: string; directive: string }> = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId, directive) => {
    dispatched.push({ sessionId, directive });
  });

  assert.equal(summary.records[0].autoResumed, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dispatched.length, 1, 'restart recovery dispatches exactly one reconciliation turn');
  assert.equal(dispatched[0].sessionId, sess.id);
  assert.equal(dispatched[0].directive, AUTO_RESUME_DIRECTIVE);
  assert.match(dispatched[0].directive, /never repeat a completed mutation, including space_save/i);
  assert.match(dispatched[0].directive, /question as resolved when a later user_input_received event answers it/i);
  assert.match(dispatched[0].directive, /read-only verification and report the result/i);
});

test('an intermediate space_save does not truncate clearly unfinished post-save work', async () => {
  const sess = HarnessSession.create({ kind: 'chat', title: 'workspace build and publish' });
  sess.setRunInFlight();
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Build the workspace, save it, then run its publish verification.' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'space_save', callId: 'space-save-intermediate' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: {
      tool: 'space_save',
      callId: 'space-save-intermediate',
      result: 'Updated workspace "Salesforce Daily Report" (salesforce-daily-report) - status active.',
    },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'run_shell_command', callId: 'publish-verify-unfinished' },
  });

  const dispatched: Array<{ sessionId: string; directive: string }> = [];
  recoverInterruptedChatRuns(Date.now, async (sessionId, directive) => {
    dispatched.push({ sessionId, directive });
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].directive, AUTO_RESUME_DIRECTIVE);
  assert.match(dispatched[0].directive, /successful space_save can be the final action or an intermediate checkpoint/i);
  assert.match(dispatched[0].directive, /continue only work .* clearly unfinished/i);
  assert.match(dispatched[0].directive, /last durable boundary/i);
});

test('an interrupted run WITH an external write keeps the manual banner (double-act guard)', async () => {
  const id = interruptedChatSession();
  appendEvent({ sessionId: id, turn: 1, role: 'Clem', type: 'external_write', data: { tool: 'composio_execute_tool', slug: 'OUTLOOK_SEND_EMAIL' } });
  const dispatched: string[] = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId) => { dispatched.push(sessionId); });
  assert.equal(summary.records[0].autoResumed, false);
  assert.equal(summary.records[0].autoResumeSkipped, 'external_write');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dispatched.length, 0, 'a write-touched run is never auto-resumed');
  const notices = listEvents(id, { types: ['conversation_completed'] });
  assert.match(String((notices.at(-1)?.data as { reply?: string }).reply ?? ''), /Reply `continue`/);
  const decisions = listEvents(id, { types: ['restart_recovery_decision'] });
  assert.equal(decisions.length, 1);
  assert.deepEqual(
    {
      eligible: decisions[0].data.eligible,
      autoResume: decisions[0].data.autoResume,
      autoResumeSkipped: decisions[0].data.autoResumeSkipped,
      externalWritesSinceInterrupt: decisions[0].data.externalWritesSinceInterrupt,
      writeCheckFailed: decisions[0].data.writeCheckFailed,
      bootResumeOrdinal: decisions[0].data.bootResumeOrdinal,
    },
    {
      eligible: false,
      autoResume: false,
      autoResumeSkipped: 'external_write',
      externalWritesSinceInterrupt: 1,
      writeCheckFailed: false,
      bootResumeOrdinal: null,
    },
  );
});

test('an exactly matched proven-no-effect write failure remains safe to auto-resume', async () => {
  const id = interruptedChatSession();
  appendEvent({
    sessionId: id,
    turn: 1,
    role: 'Clem',
    type: 'external_write',
    data: { tool: 'composio_execute_tool', callId: 'failed-write-1' },
  });
  appendEvent({
    sessionId: id,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: { tool: 'composio_execute_tool', callId: 'failed-write-1', effect: 'none' },
  });

  const dispatched: string[] = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId) => {
    dispatched.push(sessionId);
  });

  assert.equal(summary.records[0].autoResumed, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(dispatched, [id]);
  const decision = listEvents(id, { types: ['restart_recovery_decision'] }).at(-1);
  assert.equal(decision?.data.externalWritesSinceInterrupt, 0);
});

test('a failure compensates only its exact write; a sibling reservation still blocks replay', async () => {
  const id = interruptedChatSession();
  appendEvent({
    sessionId: id,
    turn: 1,
    role: 'Clem',
    type: 'external_write',
    data: { tool: 'composio_execute_tool', callId: 'failed-write-a' },
  });
  appendEvent({
    sessionId: id,
    turn: 1,
    role: 'Clem',
    type: 'external_write',
    data: { tool: 'composio_execute_tool', callId: 'unresolved-write-b' },
  });
  appendEvent({
    sessionId: id,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: { tool: 'composio_execute_tool', callId: 'failed-write-a', effect: 'none' },
  });

  const dispatched: string[] = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId) => {
    dispatched.push(sessionId);
  });

  assert.equal(summary.records[0].autoResumeSkipped, 'external_write');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(dispatched, []);
  const decision = listEvents(id, { types: ['restart_recovery_decision'] }).at(-1);
  assert.equal(decision?.data.externalWritesSinceInterrupt, 1);
});

test('an orphan outcome without a reservation still blocks automatic replay', async () => {
  const id = interruptedChatSession();
  appendEvent({
    sessionId: id,
    turn: 1,
    role: 'system',
    type: 'external_write_orphaned',
    data: { tool: 'composio_execute_tool', callId: 'orphan-write-1' },
  });

  const dispatched: string[] = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId) => {
    dispatched.push(sessionId);
  });

  assert.equal(summary.records[0].autoResumeSkipped, 'external_write');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(dispatched, []);
  const decision = listEvents(id, { types: ['restart_recovery_decision'] }).at(-1);
  assert.equal(decision?.data.externalWritesSinceInterrupt, 1);
});

test('kill-switch CLEMMY_CHAT_AUTO_RESUME=off restores banner-only for everyone', async () => {
  process.env.CLEMMY_CHAT_AUTO_RESUME = 'off';
  interruptedChatSession();
  const dispatched: string[] = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId) => { dispatched.push(sessionId); });
  assert.equal(summary.records[0].autoResumeSkipped, 'disabled');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dispatched.length, 0);
});

test('no dispatcher (legacy caller) behaves exactly as before — banner only', () => {
  const id = interruptedChatSession();
  const summary = recoverInterruptedChatRuns(Date.now);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.records[0].autoResumed, false);
  assert.equal(summary.records[0].autoResumeSkipped, 'no_dispatcher');
  const attempt = getLatestRunAttempt(id);
  const terminal = listEvents(id, { types: ['conversation_completed'] }).at(-1)?.data as {
    terminalKey?: string;
    attemptId?: string;
    sourceUserSeq?: number;
    presentation?: { status?: string; kind?: string; needs?: { kind?: string } };
  };
  assert.equal(terminal.terminalKey, `turn:${attempt?.sourceUserSeq}`);
  assert.equal(terminal.attemptId, attempt?.attemptId);
  assert.equal(terminal.sourceUserSeq, attempt?.sourceUserSeq);
  assert.equal(terminal.presentation?.status, 'needs_input');
  assert.equal(terminal.presentation?.kind, 'continue');
  assert.equal(terminal.presentation?.needs?.kind, 'continue');
});

test('boot cap: only the first 3 eligible runs auto-resume; the rest keep the banner', async () => {
  for (let i = 0; i < 5; i++) interruptedChatSession();
  const dispatched: string[] = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId) => { dispatched.push(sessionId); });
  assert.equal(summary.recovered, 5);
  assert.equal(summary.records.filter((r) => r.autoResumed).length, 3);
  assert.equal(summary.records.filter((r) => r.autoResumeSkipped === 'boot_cap').length, 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dispatched.length, 3);
});

test('a FAILED dispatch falls back to the manual banner + a notification', async () => {
  const id = interruptedChatSession();
  const summary = recoverInterruptedChatRuns(Date.now, async () => { throw new Error('brain unavailable'); });
  assert.equal(summary.records[0].autoResumed, true, 'dispatch was attempted');
  await new Promise((r) => setTimeout(r, 30));
  const notices = listEvents(id, { types: ['conversation_completed'] });
  const last = notices.at(-1)?.data as {
    reply?: string;
    presentation?: { status?: string; kind?: string; needs?: { kind?: string } };
  };
  assert.match(String(last.reply ?? ''), /Reply `continue`/, 'the user still gets the manual path');
  assert.equal(last.presentation?.status, 'needs_input');
  assert.equal(last.presentation?.kind, 'continue');
  assert.equal(last.presentation?.needs?.kind, 'continue');
  const privateFailure = listEvents(id, { types: ['restart_recovery_decision'] })
    .find((event) => event.data.phase === 'dispatch_failed');
  assert.equal(privateFailure?.data.error, 'brain unavailable');
  assert.doesNotMatch(JSON.stringify(last), /brain unavailable/);
});

test('a dispatch rejection after exact workflow activation preserves transferred ownership', async () => {
  const nowMs = Date.now();
  const fixture = interruptedPreparedWorkflowSession(
    new Date(nowMs - 60_000).toISOString(),
  );
  let finalizedRunIds: string[] = [];

  const summary = recoverInterruptedChatRuns(
    () => nowMs,
    async (sessionId, _directive, sourceUserSeq) => {
      assert.equal(sessionId, fixture.sessionId);
      assert.equal(sourceUserSeq, fixture.sourceUserSeq);
      const finalized = finalizePreparedWorkflowDispatchForSource(sessionId, sourceUserSeq);
      assert.ok(finalized, 'the resumed source activates its exact prepared workflow group');
      finalizedRunIds = [...finalized.receipt.runIds];
      throw new Error('provider failed after durable workflow dispatch transfer');
    },
  );
  assert.equal(summary.records[0]?.autoResumed, true);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const transferred = listEvents(fixture.sessionId, { types: ['run_resumed'] })
      .some((event) => event.data.reason === 'workflow_dispatch_transferred_after_resume_error');
    if (transferred) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(finalizedRunIds, [fixture.runId]);
  assert.equal(
    readPendingWorkflowChatDispatchOwnership({
      sessionId: fixture.sessionId,
      sourceUserSeq: fixture.sourceUserSeq,
    }),
    null,
    'activation transferred ownership out of the pending preparation state',
  );
  assert.equal(
    listEvents(fixture.sessionId, { types: ['conversation_completed'] }).length,
    0,
    'the rejected foreground Promise cannot publish a competing terminal',
  );
  assert.ok(
    HarnessSession.load(fixture.sessionId)?.runInFlightSince(),
    'restart ownership remains armed until the background workflow settles',
  );
  assert.equal(
    getLatestRunAttempt(fixture.sessionId)?.status,
    'active',
    'the exact accepted source attempt remains active',
  );
  assert.equal(
    JSON.parse(readFileSync(`${WORKFLOW_RUNS_DIR}/${fixture.runId}.json`, 'utf-8')).status,
    'queued',
    'the activated workflow member is executable',
  );
  const transferred = listEvents(fixture.sessionId, { types: ['run_resumed'] })
    .find((event) => event.data.reason === 'workflow_dispatch_transferred_after_resume_error');
  assert.ok(transferred);
  assert.equal(transferred.data.sourceUserSeq, fixture.sourceUserSeq);
  assert.deepEqual(transferred.data.runIds, [fixture.runId]);
  const privateFailure = listEvents(fixture.sessionId, { types: ['restart_recovery_decision'] })
    .find((event) => event.data.phase === 'dispatch_failed');
  assert.equal(privateFailure?.data.error, 'provider failed after durable workflow dispatch transfer');
});
