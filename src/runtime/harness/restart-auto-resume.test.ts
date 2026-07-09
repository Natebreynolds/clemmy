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

const { resetEventLog, appendEvent, listEvents } = await import('./eventlog.js');
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
