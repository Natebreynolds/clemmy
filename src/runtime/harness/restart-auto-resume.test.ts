/**
 * Run: npx tsx --test src/runtime/harness/restart-auto-resume.test.ts
 *
 * 2026-07-09 — auto-resume of restart-interrupted chat runs. Safety bar:
 * no external_write in the interrupted window, fresh, bounded per boot,
 * kill-switch. Ineligible runs keep the manual banner exactly as before.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-auto-resume';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  appendEvent,
  beginRunAttempt,
  isKillRequested,
  listEvents,
  recordRunAttemptUserInput,
  requestKill,
  resetEventLog,
} = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { recoverInterruptedChatRuns, markRunInFlight, AUTO_RESUME_DIRECTIVE } = await import('./restart-recovery.js');

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  resetEventLog();
  delete process.env.CLEMMY_CHAT_AUTO_RESUME;
});

function interruptedChatSession(): string {
  const sess = HarnessSession.create({ kind: 'chat', title: 'diag' });
  markRunInFlight(sess.id, true); // never cleared = killed mid-run
  return sess.id;
}

test('a clean interrupted run (no external writes) is AUTO-RESUMED with the truthful notice', async () => {
  const id = interruptedChatSession();
  const dispatched: Array<{ sessionId: string; directive: string }> = [];
  const summary = recoverInterruptedChatRuns(Date.now, async (sessionId, directive) => { dispatched.push({ sessionId, directive }); });
  assert.equal(summary.recovered, 1);
  const rec = summary.records[0];
  assert.equal(rec.autoResumed, true);
  assert.equal(rec.autoResumeSkipped, undefined);
  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget dispatch settles
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sessionId, id);
  assert.equal(dispatched[0].directive, AUTO_RESUME_DIRECTIVE);
  const notices = listEvents(id, { types: ['conversation_completed'] });
  assert.match(String((notices.at(-1)?.data as { reply?: string }).reply ?? ''), /resuming it automatically/);
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
  interruptedChatSession();
  const summary = recoverInterruptedChatRuns(Date.now);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.records[0].autoResumed, false);
  assert.equal(summary.records[0].autoResumeSkipped, 'no_dispatcher');
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
  const last = notices.at(-1)?.data as { autoResumeFailed?: boolean; reply?: string };
  assert.equal(last.autoResumeFailed, true);
  assert.match(String(last.reply ?? ''), /Reply `continue`/, 'the user still gets the manual path');
});
