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
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const {
  buildTerminalReportBody,
  decideTerminalReportBack,
  readTerminalRunFacts,
  resetTerminalReportBackOutboxForTest,
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
  outcome: 'done',
  startSeq: 1,
};

let stopWatcher: (() => void) | null = null;
beforeEach(() => {
  resetSessionViewersForTest();
  resetTerminalReportBackOutboxForTest();
});
afterEach(() => {
  stopWatcher?.();
  stopWatcher = null;
  resetTerminalReportBackOutboxForTest();
});

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

test('report-back body uses the same safe public projection as live chat', () => {
  const body = buildTerminalReportBody({
    sessionId: 'sess-x',
    terminalSeq: 2,
    startSeq: 1,
    terminalData: {
      reply: [
        'Which tenant should I use?',
        'summary: inspected all connections',
        'reply: I found two valid tenants.',
        'done: false',
        'nextAction: awaiting_user_input',
        'reason: tenant choice is user-owned',
      ].join('\n'),
      internalSummary: 'private execution notes',
    },
  });
  assert.equal(body, 'I found two valid tenants.\n\nWhich tenant should I use?');
  assert.doesNotMatch(body, /summary:|done:|nextAction:|reason:|private execution/i);
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
  const identity = { sessionId, turn: 1, sourceUserSeq: start.seq };
  const terminal = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Done — 10 firms, keywords and gaps, in the sheet.' },
  }, { metadata: { steps: 12 } }).event;
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
  const identity = { sessionId, turn: 2, sourceUserSeq: second.seq };
  const terminal = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'anytime' },
  }).event;

  const facts = readTerminalRunFacts({
    sessionId, sessionKind: 'chat', channel: null,
    terminalSeq: terminal.seq, terminalAt: terminal.createdAt,
    sourceUserSeq: second.seq, outcome: 'done', seenByViewer: false,
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

test('a late terminal for A keeps A source ownership after B was accepted', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-late-terminal-a';
  createSession({ id: sessionId, kind: 'chat', title: 'overlapping turns' });
  const sourceA = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'do A' },
  });
  for (let i = 0; i < 12; i += 1) {
    appendEvent({
      sessionId, turn: 1, role: 'assistant', type: 'tool_called',
      data: { tool: 'research', callId: `late-a-${i}` },
    });
  }
  const sourceB = appendEvent({
    sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'do B' },
  });
  const identityA = { sessionId, turn: 1, sourceUserSeq: sourceA.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identityA),
    identity: identityA,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'A finished after B was accepted.' },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const notification = listNotifications(100).find(
    (item) => item.id === `foreground-report-back-${sessionId}-${sourceA.seq}`,
  );
  assert.ok(notification, 'late A still emits A-owned report-back');
  assert.match(notification.body, /^A finished/);
  assert.equal(
    listNotifications(100).some(
      (item) => item.id === `foreground-report-back-${sessionId}-${sourceB.seq}`,
    ),
    false,
    'the latest accepted input B must never steal A terminal ownership',
  );
});

test('typed failed terminal is labeled failed, never completed', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-typed-failure-label';
  createSession({ id: sessionId, kind: 'chat', title: 'client export' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'export it' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendEvent({
      sessionId, turn: 1, role: 'assistant', type: 'tool_called',
      data: { tool: 'export', callId: `failed-${i}` },
    });
  }
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'failed',
    resumable: false,
    presentation: { kind: 'error', text: 'The export failed before a file was produced.' },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const notification = listNotifications(100).find(
    (item) => item.id === `foreground-report-back-${sessionId}-${source.seq}`,
  );
  assert.ok(notification);
  assert.match(notification.title, /^Chat run failed:/);
  assert.doesNotMatch(notification.title, /completed/i);
  assert.equal(notification.metadata?.status, 'failed');
  assert.equal(notification.metadata?.needsAttention, true);
});

test('pending report survives a process restart during the grace window', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 45_000, now: () => 1_000 });
  const sessionId = 'sess-pending-restart';
  const { startSeq } = seedRun(sessionId, 12, '', '');

  // Stop tears down every in-memory timer/listener, as a process exit would.
  // The replacement watcher sees the durable row after its original deadline.
  stopWatcher();
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 45_000, now: () => 100_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const matches = listNotifications(100).filter(
    (item) => item.id === `foreground-report-back-${sessionId}-${startSeq}`,
  );
  assert.equal(matches.length, 1, 'restart reconciliation delivers the stable source exactly once');
});

test('watched decision survives a process restart during the grace window', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 45_000, now: () => 1_000 });
  const sessionId = 'sess-watched-restart';
  const { startSeq } = seedRun(sessionId, 12, '', '');
  // Arriving after the terminal exercises the outbox's durable viewer mark,
  // rather than only the viewer-presence snapshot taken while it is armed.
  attachSessionViewer(sessionId, 1_100);

  stopWatcher();
  resetSessionViewersForTest(); // a live socket ledger does not survive restart
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 45_000, now: () => 100_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    listNotifications(100).some(
      (item) => item.id === `foreground-report-back-${sessionId}-${startSeq}`,
    ),
    false,
    'durable seen marker prevents a duplicate page after restart',
  );
});

test('a run long enough to outgrow a read window still reports back', () => {
  // Found by probing the new code adversarially before it shipped (2026-07-31).
  // The first cut read the newest 2000 events and looked for the user's input
  // inside them. A scrape making thousands of tool calls pushes its own opening
  // message out of that window, so the run read as "not user-facing" and went
  // silent — meaning the LONGEST runs, the ones nobody is still watching, were
  // the exact ones that never reported. The feature would have failed on the
  // very run that motivated it.
  const sessionId = 'sess-very-long-run';
  createSession({ id: sessionId, kind: 'chat', title: 'ten firms, the hard way' });
  const start = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'find me 10 firms and put them in a spreadsheet' },
  });
  for (let i = 0; i < 2200; i += 1) {
    appendEvent({ sessionId, turn: 1, role: 'assistant', type: 'tool_called', data: { tool: 'firecrawl_search', callId: 'x' + i } });
  }
  const identity = { sessionId, turn: 1, sourceUserSeq: start.seq };
  const terminal = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Done - 10 firms, keywords and gaps, in the sheet.' },
  }).event;

  const facts = readTerminalRunFacts({
    sessionId, sessionKind: 'chat', channel: null,
    terminalSeq: terminal.seq, terminalAt: terminal.createdAt,
    sourceUserSeq: start.seq, outcome: 'done', seenByViewer: false,
  });
  assert.ok(facts, 'a 2200-event run is still a run');
  assert.equal(facts.startSeq, start.seq, 'the opening message is found however far back it is');
  assert.equal(facts.toolCalls, 2200);
  assert.equal(decideTerminalReportBack(facts).deliver, true);
});

process.on('exit', () => { rmSync(TMP_HOME, { recursive: true, force: true }); });
