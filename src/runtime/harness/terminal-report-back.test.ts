/**
 * Run: npx tsx --test src/runtime/harness/terminal-report-back.test.ts
 *
 * Pins the foreground-run report-back. The load-bearing assertion is the PARITY
 * one at the bottom: a foreground chat run's terminal notification must resolve
 * to exactly the same delivery destinations as a background task's, because the
 * whole point is that "she tells me when she's done" cannot depend on which
 * button the user pressed before the work started.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-terminal-report-back-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { appendEvent, createSession } = await import('./eventlog.js');
const {
  decideTerminalReportBack,
  readTerminalRunFacts,
  startTerminalReportBackWatcher,
} = await import('./terminal-report-back.js');
type TerminalRunFacts = import('./terminal-report-back.js').TerminalRunFacts;
const { attachSessionViewer, sessionViewerSeenSince, resetSessionViewersForTest } =
  await import('./session-viewers.js');
const { listNotifications, getNotificationDestinationsForRecord } = await import('../notifications.js');

const BASE: TerminalRunFacts = {
  sessionId: 'sess-x',
  sessionKind: 'chat',
  channel: null,
  elapsedMs: 6 * 60_000,
  toolCalls: 40,
  externalWrites: 0,
  seenByViewer: false,
  outcome: 'completed',
  startSeq: 1,
};

let stopWatcher: (() => void) | null = null;
beforeEach(() => { resetSessionViewersForTest(); });
afterEach(() => { stopWatcher?.(); stopWatcher = null; });

// ── The decision ────────────────────────────────────────────────────────────

test('a long foreground run that nobody watched still owes the user a report', () => {
  const decision = decideTerminalReportBack(BASE);
  assert.equal(decision.deliver, true);
  assert.equal(decision.reason, 'report_back');
});

test('a run the user watched land is already reported — no second signal', () => {
  const decision = decideTerminalReportBack({ ...BASE, seenByViewer: true });
  assert.equal(decision.deliver, false);
  assert.equal(decision.reason, 'seen_by_viewer');
});

test('chatter does not page anyone', () => {
  const decision = decideTerminalReportBack({
    ...BASE, elapsedMs: 3_000, toolCalls: 0, externalWrites: 0,
  });
  assert.equal(decision.deliver, false);
  assert.equal(decision.reason, 'not_substantive');
});

test('an external write is substantive at any duration', () => {
  // Four seconds, one tool call — but she sent something on the user's behalf.
  const decision = decideTerminalReportBack({
    ...BASE, elapsedMs: 4_000, toolCalls: 1, externalWrites: 1,
  });
  assert.equal(decision.deliver, true);
});

test('Discord and Slack already delivered the reply — pinging again is a duplicate', () => {
  for (const channel of ['discord', 'slack', 'cli']) {
    const decision = decideTerminalReportBack({ ...BASE, channel });
    assert.equal(decision.deliver, false, `${channel} should not double-report`);
    assert.equal(decision.reason, 'out_of_band_channel');
  }
});

test('workflow and worker sessions keep their own report-back', () => {
  const decision = decideTerminalReportBack({ ...BASE, sessionKind: 'workflow' });
  assert.equal(decision.deliver, false);
  assert.equal(decision.reason, 'not_a_chat_run');
});

// ── Viewer ledger ───────────────────────────────────────────────────────────

test('a viewer who watched and then left still counts as having seen it', () => {
  const detach = attachSessionViewer('sess-v', 1_000);
  detach(2_000);
  assert.equal(sessionViewerSeenSince('sess-v', 1_500), true, 'left AFTER the run ended → saw it');
  assert.equal(sessionViewerSeenSince('sess-v', 5_000), false, 'left BEFORE the run ended → missed it');
});

test('a still-open view counts as seen regardless of window', () => {
  attachSessionViewer('sess-w', 1_000);
  assert.equal(sessionViewerSeenSince('sess-w', 9_999_999), true);
});

// ── Reading the run out of the log ──────────────────────────────────────────

function seedRun(sessionId: string, toolCalls: number, startedAt: string, endedAt: string): {
  startSeq: number;
  terminalSeq: number;
} {
  createSession({ id: sessionId, kind: 'chat', title: 'ten firms' });
  const start = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'find me 10 firms and put them in a spreadsheet' },
  });
  for (let i = 0; i < toolCalls; i += 1) {
    appendEvent({ sessionId, turn: 1, role: 'assistant', type: 'tool_called', data: { tool: 'firecrawl_search', callId: `c${i}` } });
  }
  const terminal = appendEvent({
    sessionId, turn: 1, role: 'assistant', type: 'conversation_completed',
    data: { reply: 'Done — 10 firms, keywords and gaps, in the sheet.', steps: 12 },
  });
  // The event log stamps its own createdAt; overwrite the pair we time against
  // so the elapsed calculation is deterministic rather than sub-millisecond.
  void startedAt; void endedAt;
  return { startSeq: start.seq, terminalSeq: terminal.seq };
}

test('the run window is scoped to the last user input, not the whole session', () => {
  const sessionId = 'sess-window';
  createSession({ id: sessionId, kind: 'chat', title: 'two turns' });
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'first' } });
  for (let i = 0; i < 30; i += 1) {
    appendEvent({ sessionId, turn: 1, role: 'assistant', type: 'tool_called', data: { tool: 't', callId: `a${i}` } });
  }
  appendEvent({ sessionId, turn: 1, role: 'assistant', type: 'conversation_completed', data: { reply: 'first done' } });
  const second = appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'thanks' } });
  const terminal = appendEvent({ sessionId, turn: 2, role: 'assistant', type: 'conversation_completed', data: { reply: 'anytime' } });

  const facts = readTerminalRunFacts({
    sessionId, sessionKind: 'chat', channel: null,
    terminalSeq: terminal.seq, terminalType: 'conversation_completed',
    terminalAt: terminal.createdAt, seenByViewer: false,
  });
  assert.ok(facts);
  assert.equal(facts.startSeq, second.seq, 'window opens at the SECOND user input');
  assert.equal(facts.toolCalls, 0, 'the first turn\'s 30 calls must not make "thanks" substantive');
  assert.equal(decideTerminalReportBack(facts).deliver, false);
});

// ── End to end, and the parity that matters ─────────────────────────────────

test('an unwatched foreground run emits the same terminal signal a background task does', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-foreground-e2e';
  const { startSeq } = seedRun(sessionId, 12, '', '');
  // graceMs 0 still defers by one macrotask.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const notification = listNotifications(50).find((item) => item.id.includes(sessionId));
  assert.ok(notification, 'the finished run must produce a terminal notification');
  assert.equal(notification.id, `foreground-report-back-${sessionId}-${startSeq}`);
  assert.equal(notification.kind, 'execution');
  assert.match(notification.body, /Done — 10 firms/);
  assert.equal(notification.silent, undefined, 'a completion report is LOUD, not a dashboard-only ping');

  // Parity: the same metadata pair the background lane sets is what the
  // delivery layer reads. If this drifts, foreground runs silently stop
  // reaching the user's devices while the notification still looks fine.
  assert.equal(notification.metadata?.terminalReportBack, true);
  assert.equal(notification.metadata?.reportBackTargetType, 'origin_chat');

  const { createBackgroundTask, backgroundTaskNotificationMetadata } =
    await import('../../execution/background-tasks.js');
  const task = createBackgroundTask({ title: 'same work, handed off', prompt: 'do it', originSessionId: sessionId });
  const backgroundEquivalent = {
    id: 'bg-parity-probe',
    kind: 'execution' as const,
    title: 'Background task completed: same work, handed off',
    body: 'done',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: backgroundTaskNotificationMetadata(task, { terminalReportBack: true }),
  };
  assert.deepEqual(
    getNotificationDestinationsForRecord(notification).map((d) => `${d.type}:${d.id}`).sort(),
    getNotificationDestinationsForRecord(backgroundEquivalent).map((d) => `${d.type}:${d.id}`).sort(),
    'foreground and background terminal report-backs must resolve identical destinations',
  );
});

test('a watched run stays quiet', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-foreground-watched';
  attachSessionViewer(sessionId);
  seedRun(sessionId, 12, '', '');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    listNotifications(50).some((item) => item.id.includes(sessionId)),
    false,
    'the user was sitting right there',
  );
});

test('one user request pages the user once, however many terminal events it writes', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-foreground-dedup';
  const { startSeq } = seedRun(sessionId, 12, '', '');
  // A single request can terminate more than once: an approval resolution, a
  // budget "reply continue" prompt, then the real completion all append their
  // own conversation_completed. Keyed per terminal event, that was three pages
  // for one piece of work.
  appendEvent({
    sessionId, turn: 1, role: 'assistant', type: 'conversation_completed',
    data: { reply: 'Actually, one more thing landed.', steps: 13 },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const matches = listNotifications(100)
    .filter((item) => item.id.startsWith(`foreground-report-back-${sessionId}-`));
  assert.equal(matches.length, 1, `expected one report, got ${matches.map((m) => m.id).join(', ')}`);
  assert.equal(matches[0]!.id, `foreground-report-back-${sessionId}-${startSeq}`);
});

process.on('exit', () => { rmSync(TMP_HOME, { recursive: true, force: true }); });
