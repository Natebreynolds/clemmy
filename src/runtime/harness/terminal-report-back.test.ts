/**
 * Run: npx tsx --test src/runtime/harness/terminal-report-back.test.ts
 *
 * Pins the foreground-run report-back. The load-bearing assertion is the PARITY
 * one at the bottom: a foreground chat run's terminal notification must resolve
 * to exactly the same delivery destinations as a background task's, because the
 * whole point is that "she tells me when she's done" cannot depend on which
 * button the user pressed before the work started.
 */
import fs, { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-terminal-report-back-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { appendEvent, createSession, getSession, listEvents, summarizeSessionForSignal } = await import('./eventlog.js');
const { BASE_DIR } = await import('../../config.js');
const { actionBus } = await import('../action-bus.js');
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
const { addNotification, listNotifications, getNotificationDestinationsForRecord } = await import('../notifications.js');

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

test('report-back with neither terminal prose nor durable work stays silent', () => {
  assert.equal(buildTerminalReportBody({
    sessionId: 'missing-report-body',
    terminalSeq: 2,
    startSeq: 1,
    terminalData: {},
  }), '');
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

test('an exact workflow-origin terminal keeps one authoritative report-back carrier', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-exact-workflow-origin';
  createSession({ id: sessionId, kind: 'chat', channel: 'mobile', title: 'workflow origin' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'run the workflow' },
  });
  for (let i = 0; i < 12; i += 1) {
    appendEvent({
      sessionId, turn: 1, role: 'assistant', type: 'tool_called',
      data: { tool: 'workflow_read', callId: `workflow-origin-${i}` },
    });
  }
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq, runId: 'workflow-run-1' };
  const detail = 'The workflow is blocked because its result still needs verification.';
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text: detail },
  }, {
    legacyReason: 'workflow_async_terminal',
    metadata: { transport: 'workflow_report_back' },
  });

  // Production's workflow-origin report-back owns this durable receipt. The
  // generic foreground watcher must not mint a second page for the same source.
  addNotification({
    id: `workflow-origin-carrier-${sessionId}`,
    kind: 'workflow',
    title: 'Workflow blocked',
    body: detail,
    createdAt: new Date().toISOString(),
    read: false,
    silent: true,
    metadata: {
      runId: 'workflow-run-1',
      source: 'workflow_origin_terminal',
      sourceUserSeq: source.seq,
      terminalReportBack: true,
      exactOriginDelivery: { version: 1, target: { type: 'origin_chat' } },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sourceNotifications = listNotifications(100).filter((item) => (
    item.id.includes(sessionId)
  ));
  assert.deepEqual(
    sourceNotifications.map((item) => item.id),
    [`workflow-origin-carrier-${sessionId}`],
    'the exact workflow carrier is the sole notification record for this source',
  );
  assert.equal(
    sourceNotifications.some((item) => item.id.startsWith('foreground-report-back-')),
    false,
    'the foreground fallback does not duplicate exact workflow-origin delivery',
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

test('pending report survives watcher replacement during the grace window', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 45_000, now: () => 1_000 });
  const sessionId = 'sess-pending-restart';
  const { startSeq } = seedRun(sessionId, 12, '', '');

  // Stop tears down timers/listeners. This same-process replacement sees the
  // durable row after its original deadline without resetting process allowance.
  stopWatcher();
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 45_000, now: () => 100_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const matches = listNotifications(100).filter(
    (item) => item.id === `foreground-report-back-${sessionId}-${startSeq}`,
  );
  assert.equal(matches.length, 1, 'restart reconciliation delivers the stable source exactly once');
});

test('watched decision survives watcher replacement during the grace window', async () => {
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

const OUTBOX_PATH = path.join(BASE_DIR, 'state', 'terminal-report-back-outbox.json');
const NOTIFICATIONS_PATH = path.join(BASE_DIR, 'state', 'notifications.json');

function pendingReportIds(): string[] {
  return (JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) as Array<{ id: string }>).map((row) => row.id);
}

/** Fail the real atomic persistence seam without replacing report or delivery logic. */
function interceptRename(fail: (destination: fs.PathLike) => boolean): () => void {
  const original = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (fail(destination)) throw new Error('controlled transient atomic rename failure');
    original(source, destination);
  };
  syncBuiltinESMExports();
  return () => { fs.renameSync = original; syncBuiltinESMExports(); };
}

test('report persistence retries in the same process with the same source and notification id', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-retry-recovered';
  const { startSeq, terminalSeq } = seedRun(sessionId, 12, '', '');
  const notificationId = `foreground-report-back-${sessionId}-${startSeq}`;
  let notificationWrites = 0;
  const restore = interceptRename((destination) => (
    String(destination) === NOTIFICATIONS_PATH && ++notificationWrites === 1
  ));
  try {
    t.mock.timers.tick(0);
    assert.equal(notificationWrites, 1);
    assert.equal(listNotifications(100).some((row) => row.id === notificationId), false);
    assert.deepEqual(pendingReportIds(), [`${sessionId}:${startSeq}`]);
    const terminal = listEvents(sessionId).find((row) => row.seq === terminalSeq)!;
    // Replay the published signal, not a second canonical terminal row (which
    // the event log correctly rejects for this same logical source).
    actionBus.emit({ kind: 'harness.public_event', sessionId, event: terminal,
      session: summarizeSessionForSignal(getSession(sessionId)!) });
    t.mock.timers.tick(999);
    assert.equal(notificationWrites, 1, 'duplicate terminal does not bypass retry backoff');
    t.mock.timers.tick(1);
    const notifications = listNotifications(100).filter((row) => row.id === notificationId);
    assert.equal(notifications.length, 1, 'same watcher delivers once after persistence recovers');
    assert.equal(notificationWrites, 2);
    assert.deepEqual(pendingReportIds(), []);
    assert.equal(listEvents(sessionId, { types: ['tool_called'] }).length, 12, 'delivery retries create no new task work');
    t.mock.timers.tick(60_000);
    assert.equal(notificationWrites, 2, 'successful acknowledgement releases the retry owner');
  } finally { restore(); stopWatcher?.(); stopWatcher = null; t.mock.timers.reset(); }
});

test('report cleanup retry reuses the persisted notification without a second created signal', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-retry-cleanup';
  const { startSeq } = seedRun(sessionId, 12, '', '');
  const notificationId = `foreground-report-back-${sessionId}-${startSeq}`;
  let created = 0;
  const unsubscribe = actionBus.subscribe((event) => {
    if (event.kind === 'notification.created' && event.notification.id === notificationId) created += 1;
  });
  let cleanupWrites = 0;
  const restore = interceptRename((destination) => (
    String(destination) === OUTBOX_PATH && ++cleanupWrites === 1
  ));
  try {
    t.mock.timers.tick(0);
    assert.equal(created, 1);
    assert.deepEqual(pendingReportIds(), [`${sessionId}:${startSeq}`]);
    t.mock.timers.tick(1_000);
    assert.equal(cleanupWrites, 2, 'same process acknowledges the already persisted notification');
    assert.deepEqual(pendingReportIds(), []);
    assert.equal(created, 1, 'cleanup never emits a second notification');
    assert.equal(listNotifications(100).filter((row) => row.id === notificationId).length, 1);
  } finally { restore(); unsubscribe(); stopWatcher?.(); stopWatcher = null; t.mock.timers.reset(); }
});

test('report retry budget survives watcher generations; a fresh process can reconcile the durable row', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-retry-exhausted';
  const { startSeq, terminalSeq } = seedRun(sessionId, 12, '', '');
  let writes = 0;
  const restore = interceptRename((destination) => {
    if (String(destination) !== NOTIFICATIONS_PATH) return false;
    writes += 1;
    return true;
  });
  try {
    for (const elapsed of [0, 1_000, 5_000, 15_000]) t.mock.timers.tick(elapsed);
    assert.equal(writes, 4, 'one initial attempt plus three delayed retries');
    const terminal = listEvents(sessionId).find((row) => row.seq === terminalSeq)!;
    actionBus.emit({ kind: 'harness.public_event', sessionId, event: terminal,
      session: summarizeSessionForSignal(getSession(sessionId)!) });
    t.mock.timers.tick(60 * 60_000);
    assert.equal(writes, 4, 'no hot loop or renewed budget on duplicate source');
    assert.deepEqual(pendingReportIds(), [`${sessionId}:${startSeq}`], 'exhaustion leaves durable restart recovery');
    stopWatcher();
    stopWatcher = null;
    restore();
    stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
    t.mock.timers.tick(60_000);
    assert.deepEqual(pendingReportIds(), [`${sessionId}:${startSeq}`], 'same-process watcher replacement cannot replenish exhausted allowance');
    const notificationId = `foreground-report-back-${sessionId}-${startSeq}`;
    assert.equal(listNotifications(100).some((row) => row.id === notificationId), false);
    stopWatcher();
    stopWatcher = null;

    // A separate Node process has fresh process-local allowance and reads the
    // same disposable fixture's durable row. This is fresh-process outbox
    // recovery, not an installed-app restart or a remote push delivery test.
    const script = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const { startTerminalReportBackWatcher } = await import(${JSON.stringify(new URL('./terminal-report-back.ts', import.meta.url).href)});
      const { actionBus } = await import(${JSON.stringify(new URL('../action-bus.ts', import.meta.url).href)});
      const { listNotifications } = await import(${JSON.stringify(new URL('../notifications.ts', import.meta.url).href)});
      const id = ${JSON.stringify(notificationId)};
      let unsubscribe;
      const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('fresh-process report did not arrive')), 5000);
        unsubscribe = actionBus.subscribe(event => {
          if (event.kind === 'notification.created' && event.notification.id === id) {
            clearTimeout(timeout); resolve();
          }
        });
      });
      const stop = startTerminalReportBackWatcher({ graceMs: 0 });
      try {
        await ready;
        assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(OUTBOX_PATH)}, 'utf8')), []);
        const count = listNotifications(100).filter(row => row.id === id).length;
        assert.equal(count, 1);
        console.log(JSON.stringify({ pid: process.pid, notificationId: id, count }));
      } finally { stop(); unsubscribe(); }
    `;
    const child = spawnSync(process.execPath, [
      '--import', new URL('../../../scripts/test-isolation-preload.mjs', import.meta.url).href,
      '--import', 'tsx', '--input-type=module', '-e', script,
    ], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, CLEMENTINE_HOME: BASE_DIR, CLEMMY_ALLOW_LIVE_HOME_TESTS: '0', CLEMMY_TEST_DISABLE_LIVE_MODELS: '1' },
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    assert.notEqual(result.pid, process.pid);
    assert.equal(result.notificationId, notificationId);
    assert.equal(result.count, 1);
    assert.deepEqual(pendingReportIds(), []);
    assert.equal(listNotifications(100).filter((row) => row.id === notificationId).length, 1);
  } finally { restore(); stopWatcher?.(); stopWatcher = null; t.mock.timers.reset(); }
});

test('watcher replacement preserves remaining report allowance and its pending backoff', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-retry-remaining';
  const { startSeq } = seedRun(sessionId, 12, '', '');
  let writes = 0;
  const restore = interceptRename((destination) => (
    String(destination) === NOTIFICATIONS_PATH && ++writes <= 2
  ));
  try {
    t.mock.timers.tick(0);
    assert.equal(writes, 1);
    stopWatcher();
    stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
    t.mock.timers.tick(999);
    assert.equal(writes, 1, 'watcher replacement does not skip the existing delay');
    t.mock.timers.tick(1);
    assert.equal(writes, 2);
    stopWatcher();
    stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
    t.mock.timers.tick(4_999);
    assert.equal(writes, 2, 'second generation retains the second backoff, not the first');
    t.mock.timers.tick(1);
    assert.equal(writes, 3);
    assert.deepEqual(pendingReportIds(), []);
    assert.equal(listNotifications(100).filter((row) => row.id === `foreground-report-back-${sessionId}-${startSeq}`).length, 1);
  } finally { restore(); stopWatcher?.(); stopWatcher = null; t.mock.timers.reset(); }
});

test('a viewer arriving during report retry still suppresses notification and acknowledges the outbox', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-retry-viewer';
  const { startSeq } = seedRun(sessionId, 12, '', '');
  let writes = 0;
  const restore = interceptRename((destination) => (
    String(destination) === NOTIFICATIONS_PATH && ++writes === 1
  ));
  try {
    t.mock.timers.tick(0);
    const detach = attachSessionViewer(sessionId);
    detach();
    t.mock.timers.tick(1_000);
    assert.equal(writes, 1, 'viewer observation is rechecked before retry delivery');
    assert.deepEqual(pendingReportIds(), []);
    assert.equal(listNotifications(100).some((row) => row.id === `foreground-report-back-${sessionId}-${startSeq}`), false);
  } finally { restore(); stopWatcher?.(); stopWatcher = null; t.mock.timers.reset(); }
});

test('watcher shutdown cancels scheduled report retries while preserving the durable row', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-retry-shutdown';
  const { startSeq } = seedRun(sessionId, 12, '', '');
  let writes = 0;
  const restore = interceptRename((destination) => (
    String(destination) === NOTIFICATIONS_PATH && ++writes === 1
  ));
  try {
    t.mock.timers.tick(0);
    stopWatcher();
    stopWatcher = null;
    t.mock.timers.tick(60_000);
    assert.equal(writes, 1, 'stopped watcher cannot emit or reschedule');
    assert.deepEqual(pendingReportIds(), [`${sessionId}:${startSeq}`]);
    assert.equal(listNotifications(100).some((row) => row.id === `foreground-report-back-${sessionId}-${startSeq}`), false);
  } finally { restore(); stopWatcher?.(); stopWatcher = null; t.mock.timers.reset(); }
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

/**
 * A finished report is titled with its ANSWER, not with the owner's question.
 *
 * Live 2026-09-21 the Inbox read:
 *   Chat run completed: anything urgent in my inbox? btw when in doubt draft…
 *   Chat run completed: pull up the pipeline. also i go by Nate not Nathan…
 * Every row echoed the owner's own words, so a list of Clem's reports was a
 * list of the owner's questions and each answer sat one click away. That same
 * title is most of what a Discord or Slack DM shows, which is where the owner
 * noticed it first.
 */
test('a completed report is titled with what Clem concluded', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-headline-done';
  createSession({ id: sessionId, kind: 'chat', title: 'how many meetings does tim have tomorrow' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'how many meetings does tim have tomorrow' },
  });
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  // A report-back only arms for a SUBSTANTIVE run (external writes, elapsed
  // time, or tool calls). These runs are synthetic and instant, so give them
  // the tool calls a real one would have.
  for (let i = 0; i < 8; i += 1) {
    appendEvent({
      sessionId, turn: 1, role: 'assistant', type: 'tool_called',
      data: { tool: 'lookup', callId: `${sessionId}-${i}` },
    });
  }
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: {
      kind: 'answer',
      text: 'Tim has 0 meetings in Salesforce tomorrow. Nothing on his calendar as owner or invitee.',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const notification = listNotifications(100).find(
    (item) => item.id === `foreground-report-back-${sessionId}-${source.seq}`,
  );
  assert.ok(notification, 'a completed run reports back');
  assert.ok(
    notification.title.startsWith('Tim has 0 meetings'),
    `title must lead with the answer, got: ${notification.title}`,
  );
  assert.doesNotMatch(
    notification.title,
    /how many meetings does tim/i,
    'the title must not echo the question back at the owner',
  );
  assert.ok(notification.title.length <= 95, `title stays scannable, got ${notification.title.length}`);
});

/**
 * A stop the owner must act on keeps its status lead. Prose does not scan when
 * the point is "this needs you", and the owner still has to see which request
 * is waiting on them.
 */
test('a run that needs the owner still leads with its status', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-headline-needs';
  createSession({ id: sessionId, kind: 'chat', title: 'send the client export' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'send it' },
  });
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  // A report-back only arms for a SUBSTANTIVE run (external writes, elapsed
  // time, or tool calls). These runs are synthetic and instant, so give them
  // the tool calls a real one would have.
  for (let i = 0; i < 8; i += 1) {
    appendEvent({
      sessionId, turn: 1, role: 'assistant', type: 'tool_called',
      data: { tool: 'lookup', callId: `${sessionId}-${i}` },
    });
  }
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'approval' },
    presentation: {
      kind: 'approval',
      text: 'Approval required for Send Slack message. Review apr-3lmm to continue.',
      approvalId: 'apr-3lmm',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const notification = listNotifications(100).find(
    (item) => item.id === `foreground-report-back-${sessionId}-${source.seq}`,
  );
  assert.ok(notification, 'a run needing the owner reports back');
  assert.match(notification.title, /^Chat run needs you:/);
  assert.match(notification.title, /send the client export/);
});

/**
 * A report names what it produced.
 *
 * 31 deliverables were written in a fortnight and every one was reachable only
 * from inside the chat thread that made it, so finding last week's report meant
 * remembering which conversation produced it. The run's own event window
 * already holds the names.
 */
test('a report names the files the run produced', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-deliverables';
  createSession({ id: sessionId, kind: 'chat', title: 'weekly report' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'build the weekly report' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendEvent({
      sessionId, turn: 1, role: 'assistant', type: 'tool_called',
      data: { tool: 'compose', callId: `deliv-${i}` },
    });
  }
  appendEvent({
    sessionId, turn: 1, role: 'assistant', type: 'deliverable_saved',
    data: { name: 'orchard-birch-weekly-report.md', dir: 'reports' },
  });
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    // Her prose does NOT mention the filename — the gap this fills.
    presentation: { kind: 'answer', text: 'Pulled the numbers and wrote it up for you.' },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const notification = listNotifications(100).find(
    (item) => item.id === `foreground-report-back-${sessionId}-${source.seq}`,
  );
  assert.ok(notification, 'a run that produced a file reports back');
  assert.match(
    notification.body,
    /Saved: orchard-birch-weekly-report\.md/,
    `the report must name what it produced, got: ${notification.body}`,
  );
  const deliverables = notification.metadata?.deliverables as Array<{ name: string; dir: string | null }>;
  assert.ok(Array.isArray(deliverables), 'structured copy rides the metadata for an open affordance');
  assert.equal(deliverables[0]?.name, 'orchard-birch-weekly-report.md');
  assert.equal(deliverables[0]?.dir, 'reports');
});

/** Repeating a filename she already wrote would read as the assistant talking
 *  to itself. The appended line fills a gap; it does not echo. */
test('a report does not repeat a filename its own words already gave', async () => {
  stopWatcher = startTerminalReportBackWatcher({ graceMs: 0 });
  const sessionId = 'sess-report-deliverables-named';
  createSession({ id: sessionId, kind: 'chat', title: 'discovery summary' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'summarize it' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendEvent({
      sessionId, turn: 1, role: 'assistant', type: 'tool_called',
      data: { tool: 'compose', callId: `named-${i}` },
    });
  }
  appendEvent({
    sessionId, turn: 1, role: 'assistant', type: 'deliverable_saved',
    data: { name: 'discovery-call-summary.txt', dir: null },
  });
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Saved discovery-call-summary.txt for you.' },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const notification = listNotifications(100).find(
    (item) => item.id === `foreground-report-back-${sessionId}-${source.seq}`,
  );
  assert.ok(notification);
  assert.doesNotMatch(notification.body, /Saved: discovery-call-summary/);
  // Still structured, so a surface can offer to open it.
  const deliverables = notification.metadata?.deliverables as Array<{ name: string }>;
  assert.equal(deliverables?.[0]?.name, 'discovery-call-summary.txt');
});
