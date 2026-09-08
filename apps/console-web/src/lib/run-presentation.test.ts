import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WriteLedgerRow } from '@clem/chat-engine';
import { foldWriteLedger } from '@clem/chat-engine';
import {
  backgroundTaskIdForRun,
  conversationEmptyStateText,
  conversationHref,
  deleteConfirmText,
  endsTheRun,
  latestRunBoundary,
  observedRunStatus,
  filterSessionsByKind,
  foldRunDeliverables,
  isRunKind,
  matchesKindFilter,
  parseConversationKindFilter,
  presentRunWrite,
  runActivityItems,
  runCoverageNotice,
  runElapsedLabel,
  runEmptyStateText,
  runFinalReply,
  runIsLive,
  runIsOver,
  runLedgerIsComplete,
  runLivenessFromSteps,
  runRowTiming,
  runStatusMeta,
  runStepsFor,
  runStepsLabel,
  runTerminalOutcome,
  runWriteRows,
  runWriteSummary,
  stoppableRunCard,
  toEngineEvent,
  type RunEventInput,
  type RunLiveness,
  type RunStep,
} from './run-presentation.js';

function row(patch: Partial<WriteLedgerRow> = {}): WriteLedgerRow {
  return {
    callId: 'call-1',
    shapeKey: 'GMAIL_SEND_EMAIL',
    toolName: 'gmail_send_email',
    targets: ['ana@example.com'],
    disposition: 'confirmed',
    irreversible: null,
    ...patch,
  };
}

let seq = 0;
function ev(type: string, data: Record<string, unknown> = {}): RunEventInput {
  seq += 1;
  return { seq, type, data };
}

// ─── which kinds render as a run ────────────────────────────────────────────

test('workflow, execution and agent sessions are runs; chat is not', () => {
  assert.equal(isRunKind('workflow'), true);
  assert.equal(isRunKind('execution'), true);
  assert.equal(isRunKind('agent'), true);
  assert.equal(isRunKind('chat'), false);
});

test('an unknown kind stays visible under All and Chats rather than disappearing', () => {
  assert.equal(matchesKindFilter('rehearsal', 'all'), true);
  assert.equal(matchesKindFilter('rehearsal', 'chats'), true);
  assert.equal(matchesKindFilter('rehearsal', 'runs'), false);
});

test('the kind filter keeps the server ordering it was given', () => {
  const sessions = [
    { id: 'a', kind: 'chat' },
    { id: 'b', kind: 'workflow' },
    { id: 'c', kind: 'chat' },
    { id: 'd', kind: 'execution' },
  ];
  assert.deepEqual(filterSessionsByKind(sessions, 'all').map((s) => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterSessionsByKind(sessions, 'chats').map((s) => s.id), ['a', 'c']);
  assert.deepEqual(filterSessionsByKind(sessions, 'runs').map((s) => s.id), ['b', 'd']);
});

test('a stored filter preference that no longer exists falls back to All', () => {
  assert.equal(parseConversationKindFilter('runs'), 'runs');
  assert.equal(parseConversationKindFilter('workflows'), 'all');
  assert.equal(parseConversationKindFilter(null), 'all');
});

// ─── status and elapsed ─────────────────────────────────────────────────────

test('only the harness status "active" reads as live', () => {
  assert.equal(runIsLive('active'), true);
  for (const settled of ['completed', 'failed', 'cancelled', 'superseded', 'interrupted']) {
    assert.equal(runIsLive(settled), false, settled);
  }
});

test('a settled status never borrows the live tone', () => {
  assert.equal(runStatusMeta('active').tone, 'live');
  assert.equal(runStatusMeta('completed').tone, 'success');
  assert.equal(runStatusMeta('failed').tone, 'danger');
  assert.equal(runStatusMeta('cancelled').label, 'Stopped');
  // A status this build has never heard of is shown, not guessed at.
  assert.deepEqual(runStatusMeta('quarantined'), { label: 'quarantined', tone: 'neutral' });
});

test('elapsed runs to now while live and freezes at the last event once settled', () => {
  const started = Date.parse('2026-09-06T12:00:00.000Z');
  const lastEvent = started + 90_000;
  const now = started + 600_000;
  assert.equal(runElapsedLabel(started, lastEvent, true, now), '10m 00s');
  assert.equal(runElapsedLabel(started, lastEvent, false, now), '1m 30s');
  // ISO strings are the wire spelling of the same instants.
  assert.equal(
    runElapsedLabel(new Date(started).toISOString(), new Date(lastEvent).toISOString(), false, now),
    '1m 30s',
  );
});

test('elapsed is empty rather than wrong when the run never recorded a start', () => {
  assert.equal(runElapsedLabel(null, 123, false, 456), '');
  assert.equal(runElapsedLabel('not a date', null, true, 456), '');
});

test('a run row reports working time while live and settle time once finished', () => {
  const created = '2026-09-06T12:00:00.000Z';
  const now = Date.parse(created) + 5 * 60_000;
  assert.deepEqual(
    runRowTiming({ status: 'active', createdAt: created, updatedAt: created }, now),
    { text: 'running 5m 00s', live: true },
  );
  assert.deepEqual(
    runRowTiming({ status: 'completed', createdAt: created, updatedAt: created }, now),
    { text: 'settled 5m ago', live: false },
  );
});

// ─── THE regression: a reservation is not a receipt ─────────────────────────

test('a reserved write never renders as a completed receipt', () => {
  const presented = presentRunWrite(row({ disposition: 'reserved' }));
  assert.equal(presented.settled, false);
  assert.equal(presented.state, 'running');
  assert.equal(presented.tone, 'live');
  assert.equal(presented.note, 'not confirmed yet');
  // Past tense is a claim about the world. Only a terminal earns it.
  assert.match(presented.what, /^Sending /);
  assert.doesNotMatch(presented.what, /^(Sent|Created|Updated|Saved|Deleted|Published) /);
});

test('a null irreversibility never renders as "can\'t be undone"', () => {
  for (const disposition of ['reserved', 'confirmed', 'failed', 'orphaned', 'unknown'] as const) {
    const presented = presentRunWrite(row({ disposition, irreversible: null }));
    assert.equal(presented.reversibility, null, disposition);
    const rendered = `${presented.what} ${presented.note ?? ''}`;
    assert.doesNotMatch(rendered, /undone|irreversible/i, disposition);
  }
});

test('reversibility is spoken only when the ledger actually carried it', () => {
  assert.equal(presentRunWrite(row({ irreversible: true })).reversibility, "can't be undone");
  assert.equal(presentRunWrite(row({ irreversible: false })).reversibility, 'reversible');
});

test('an unsettled terminal keeps its ambiguity in the row and in the count', () => {
  const orphaned = presentRunWrite(row({ disposition: 'orphaned' }));
  assert.equal(orphaned.tone, 'warning');
  assert.match(orphaned.what, /may have landed/);
  const failed = presentRunWrite(row({ disposition: 'failed' }));
  assert.equal(failed.tone, 'danger');
  assert.match(failed.what, /failed/);
});

test('the section count calls out reservations instead of folding them into the total', () => {
  const rows = [
    presentRunWrite(row({ callId: 'a', disposition: 'confirmed' })),
    presentRunWrite(row({ callId: 'b', disposition: 'reserved' })),
  ];
  assert.equal(runWriteSummary(rows), '2 changes · 1 still unconfirmed');
  assert.equal(runWriteSummary(rows.slice(0, 1)), '1 change');
  assert.equal(runWriteSummary([]), '');
});

test('a reservation and its terminal are one row, and it is the terminal that speaks', () => {
  // The pre-dispatch append and its terminal share callId by construction.
  const events: RunEventInput[] = [
    ev('external_write', { callId: 'c1', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['ana@example.com'] }),
    ev('external_write_succeeded', { callId: 'c1', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['ana@example.com'] }),
  ];
  const folded = [...foldWriteLedger(events).values()].map(presentRunWrite);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].settled, true);
  assert.match(folded[0].what, /^Sent a message to ana@example\.com$/);
});

// ─── deliverables and the final reply ───────────────────────────────────────

test('deliverables dedupe by path so a rewritten file is one row', () => {
  const events = [
    ev('deliverable_saved', { name: 'pipeline.csv', dir: '/vault/reports', excerpt: 'v1' }),
    ev('deliverable_saved', { name: 'pipeline.csv', dir: '/vault/reports', excerpt: 'v2' }),
    ev('deliverable_saved', { name: 'notes.md' }),
    ev('deliverable_saved', { dir: '/vault' }),
  ];
  const rows = foldRunDeliverables(events);
  assert.deepEqual(rows.map((r) => r.name), ['pipeline.csv', 'notes.md']);
  assert.equal(rows[0].excerpt, 'v2');
  assert.equal(rows[1].dir, null);
});

test('the final reply is the last thing the run actually said', () => {
  assert.equal(runFinalReply([
    ev('conversation_completed', { reply: 'First pass done.' }),
    ev('tool_returned', {}),
    ev('conversation_completed', { reply: '  Sent the summary.  ' }),
  ]), 'Sent the summary.');
  // An empty reply is not a reply; the caller omits the section rather than
  // quoting nothing.
  assert.equal(runFinalReply([ev('conversation_completed', { reply: '   ' })]), '');
  assert.equal(runFinalReply([]), '');
});

// ─── where a run leads ──────────────────────────────────────────────────────

test('a background run recovers its task id; a workflow run does not guess one', () => {
  assert.equal(backgroundTaskIdForRun('harness:background:bg-123'), 'bg-123');
  assert.equal(backgroundTaskIdForRun('background:bg-123'), 'bg-123');
  assert.equal(backgroundTaskIdForRun('harness:wf-run-9'), null);
  assert.equal(backgroundTaskIdForRun('harness:background:'), null);
});

test('an origin conversation link is addressed the way the rail addresses one', () => {
  assert.equal(conversationHref('sess-1'), '/chat/harness%3Asess-1');
  assert.equal(conversationHref('harness:sess-1'), '/chat/harness%3Asess-1');
});

test('Stop is offered only on an exactly identified card', () => {
  const cards = [
    { id: 'bg-7', sourceKind: 'background', sessionId: 'chat-1', actions: ['cancel'] },
    { id: 'bg-8', sourceKind: 'background', sessionId: 'chat-1', actions: [] },
    { id: 'attempt-a', sourceKind: 'run', sessionId: 'wf-run-9', actions: ['cancel'] },
    { id: 'wf-card', sourceKind: 'workflow', sessionId: 'wf-run-9', actions: ['cancel'] },
  ];
  // A background run is matched on the task id its session id carries.
  assert.equal(stoppableRunCard('harness:background:bg-7', cards)?.id, 'bg-7');
  // …and never on a card that did not offer cancel.
  assert.equal(stoppableRunCard('harness:background:bg-8', cards), undefined);
  // A foreground `run` card may not be claimed by session — one session serves
  // many attempts. The durable workflow card that owns the session may.
  assert.equal(stoppableRunCard('harness:wf-run-9', cards)?.id, 'wf-card');
  assert.equal(stoppableRunCard('harness:wf-run-unknown', cards), undefined);
});

test('an ISO createdAt is normalised before the shared reducer sees it', () => {
  // The console transport allows a string here; the engine's event does not.
  const at = '2026-09-06T12:00:00.000Z';
  assert.equal(toEngineEvent({ seq: 1, type: 'tool_called', createdAt: at }).createdAt, Date.parse(at));
  assert.equal(toEngineEvent({ seq: 1, type: 'tool_called', createdAt: 1757160000000 }).createdAt, 1757160000000);
  // Unparseable or absent is absent, never 0 — a zero start would render as a
  // fifty-six-year elapsed.
  assert.equal(toEngineEvent({ seq: 1, type: 'tool_called', createdAt: 'soon' }).createdAt, undefined);
  assert.equal(toEngineEvent({ seq: 1, type: 'tool_called' }).createdAt, undefined);
});

// ─── F3 · a settled run has no work in flight ───────────────────────────────

const LIVE: RunLiveness = { live: true, over: false, status: 'active' };
const OVER: RunLiveness = { live: false, over: true, status: 'completed' };
const PARKED: RunLiveness = { live: false, over: false, status: 'paused' };

test('a reservation left open when the run ended is sealed, not shown as sending', () => {
  // A run that appended its pre-dispatch reservation and died before the
  // terminal. An hour later the page must not render an in-flight send.
  const events: RunEventInput[] = [
    ev('external_write', { callId: 'c9', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['ana@example.com'] }),
  ];
  const whileRunning = runWriteRows(events, LIVE);
  assert.equal(whileRunning[0].state, 'running', 'while it is running, it IS running');
  assert.equal(whileRunning[0].tone, 'live');

  const onceOver = runWriteRows(events, OVER);
  assert.equal(onceOver.length, 1);
  assert.equal(onceOver[0].state, 'interrupted', 'sealed to unknown, never to done');
  assert.equal(onceOver[0].tone, 'warning');
  assert.equal(onceOver[0].settled, true);
  assert.equal(onceOver[0].note, null, 'no "not confirmed yet" on a run that is over');
  assert.match(onceOver[0].what, /couldn’t confirm|couldn't confirm/);
  assert.doesNotMatch(onceOver[0].what, /^Sending /, 'a finished run has nothing in flight');
});

test('a run parked on an approval does not seal a write that may still be in flight', () => {
  const events: RunEventInput[] = [
    ev('external_write', { callId: 'c10', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['ana@example.com'] }),
  ];
  const parked = runWriteRows(events, PARKED);
  assert.equal(parked[0].state, 'running', 'parked is not finished');
  assert.equal(parked[0].note, 'not confirmed yet');
});

test('a confirmed write is untouched by sealing', () => {
  const events: RunEventInput[] = [
    ev('external_write', { callId: 'c11', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['ana@example.com'] }),
    ev('external_write_succeeded', { callId: 'c11', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['ana@example.com'] }),
  ];
  assert.equal(runWriteRows(events, OVER)[0].state, 'done');
});

test('the timeline of a run that is over carries no still-running step', () => {
  // A tool call whose return never arrived: the reducer leaves it `running`,
  // and RunTimeline paints a pulse on exactly that.
  const events: RunEventInput[] = [
    { seq: 1, turn: 1, role: 'assistant', type: 'tool_called', data: { tool: 'gmail_send_email', callId: 'c12' } },
  ];
  assert.equal(
    runActivityItems(events, LIVE).some((item) => item.status === 'running'),
    true,
    'while live, an open step really is running',
  );
  assert.equal(
    runActivityItems(events, OVER).some((item) => item.status === 'running'),
    false,
    'a finished run may not claim work is happening right now',
  );
});

test('how an unfinished step is closed follows the run’s own outcome', () => {
  assert.equal(runTerminalOutcome(LIVE), undefined);
  assert.equal(runTerminalOutcome(PARKED), undefined, 'parked is not a terminal');
  assert.equal(runTerminalOutcome({ live: false, over: true, status: 'completed' }), 'completed');
  assert.equal(runTerminalOutcome({ live: false, over: true, status: 'failed' }), 'failed');
  // Stopped, superseded, or a status this build has not heard of never settle
  // an open step as a success.
  assert.equal(runTerminalOutcome({ live: false, over: true, status: 'cancelled' }), 'interrupted');
  assert.equal(runTerminalOutcome({ live: false, over: true, status: 'quarantined' }), 'interrupted');
});

// ─── F4 · working now, and having finished, are different questions ─────────

test('a run parked on an approval is neither live nor over', () => {
  assert.equal(runIsLive('paused'), false, 'nothing is happening this instant');
  assert.equal(runIsOver('paused'), false, 'and it has emphatically not finished');
  assert.deepEqual(runStatusMeta('paused'), { label: 'Paused', tone: 'warning' });
});

test('only a real terminal ends the watch; an unknown status keeps it open', () => {
  for (const over of ['completed', 'failed', 'cancelled', 'superseded', 'interrupted']) {
    assert.equal(runIsOver(over), true, over);
  }
  for (const notOver of ['active', 'paused', 'queued', '']) {
    assert.equal(runIsOver(notOver), false, notOver);
  }
});

test('the composer’s terminals are not the run’s', () => {
  // isTerminalEvent (lib/chat.ts) resolves on all five of these, because it
  // answers "re-enable the input". Only two of them end a run.
  assert.equal(endsTheRun('conversation_completed'), true);
  assert.equal(endsTheRun('run_failed'), true);
  for (const notTheEnd of ['approval_requested', 'awaiting_user_input', 'async_work_dispatched']) {
    assert.equal(endsTheRun(notTheEnd), false, notTheEnd);
  }
});

// ─── F1/F2 · a run is N sessions, and its status is the run's ───────────────

function step(id: string, status: string, at = '2026-09-06T12:00:00.000Z'): RunStep {
  return { id, label: id, status, createdAt: at, updatedAt: at };
}

test('a collapsed run is read as all of its steps; anything else is one step', () => {
  const collapsed = runStepsFor({
    id: 'harness:workflow:run-1:d',
    status: 'completed',
    createdAt: 'c',
    updatedAt: 'u',
    title: 'Nightly brief',
    runSteps: [step('harness:workflow:run-1:a', 'completed'), step('harness:workflow:run-1:d', 'completed')],
  });
  assert.deepEqual(collapsed.map((s) => s.id), ['harness:workflow:run-1:a', 'harness:workflow:run-1:d']);

  const single = runStepsFor({ id: 'harness:bg-1', status: 'active', createdAt: 'c', updatedAt: 'u', title: 'Task' });
  assert.deepEqual(single.map((s) => s.id), ['harness:bg-1'], 'a run with no steps is its own step');
  assert.equal(single[0].status, 'active');
});

test('one step still running keeps the whole run live, whatever the row said', () => {
  const steps = [step('s1', 'completed'), step('s2', 'active')];
  const liveness = runLivenessFromSteps(steps, {}, 'completed');
  assert.equal(liveness.live, true);
  assert.equal(liveness.over, false, 'a run with a running step has not finished');
  assert.equal(liveness.status, 'active', 'and it is never shown as Completed');
  assert.equal(runStatusMeta(liveness.status).label, 'Running');
});

test('what the page observed outranks the row it was handed', () => {
  // The row said the step was active; the poll has since seen it complete.
  const steps = [step('s1', 'active')];
  const liveness = runLivenessFromSteps(steps, { s1: 'completed' }, 'completed');
  assert.equal(liveness.live, false);
  assert.equal(liveness.over, true);
});

test('a run between two steps is not sealed just because no session is active', () => {
  // Every step session has finished, but the run row still says active — the
  // workflow's own run log knows step 4 has not started yet.
  const liveness = runLivenessFromSteps([step('s1', 'completed')], {}, 'active');
  assert.equal(liveness.over, false, 'both witnesses must agree before anything is sealed');
  assert.equal(runWriteRows(
    [ev('external_write', { callId: 'c13', shapeKey: 'GMAIL_SEND_EMAIL', targets: ['ana@example.com'] })],
    liveness,
  )[0].state, 'running');
});

test('a multi-step run says how many steps it is showing', () => {
  assert.equal(runStepsLabel([step('a', 'completed')]), null, 'one session needs no disclosure');
  assert.equal(runStepsLabel([step('a', 'completed'), step('b', 'completed')]), '2 steps');
  assert.equal(
    runStepsLabel([step('a', 'completed'), step('b', 'active'), step('c', 'completed')]),
    '3 steps · 1 still running',
  );
});

// ─── F5/F6 · an unknown count is not zero ──────────────────────────────────

test('"nothing was changed" is said only after a whole, successful read', () => {
  const whole = { steps: 2, read: 2, truncated: false };
  assert.match(
    runEmptyStateText({ loading: false, failed: false, eventCount: 0, coverage: whole }) ?? '',
    /Nothing was changed/,
  );
  // A transport failure asserting nothing was written is the alarming lie this
  // page exists to prevent.
  assert.match(
    runEmptyStateText({ loading: false, failed: true, eventCount: 0, coverage: { steps: 2, read: 0, truncated: false } }) ?? '',
    /could not be read/,
  );
  assert.doesNotMatch(
    runEmptyStateText({ loading: false, failed: true, eventCount: 0, coverage: { steps: 2, read: 0, truncated: false } }) ?? '',
    /Nothing was changed/,
  );
  // A partial read cannot support it either.
  assert.match(
    runEmptyStateText({ loading: false, failed: false, eventCount: 0, coverage: { steps: 3, read: 1, truncated: false } }) ?? '',
    /could not be read/,
  );
  // And it is never shown while the page is still reading, or once it has
  // something to show.
  assert.equal(runEmptyStateText({ loading: true, failed: false, eventCount: 0, coverage: whole }), null);
  assert.equal(runEmptyStateText({ loading: false, failed: false, eventCount: 4, coverage: whole }), null);
});

test('a partial or truncated read says so above the ledger', () => {
  assert.equal(runCoverageNotice({ steps: 3, read: 3, truncated: false }), null, 'a whole read says nothing');
  assert.match(runCoverageNotice({ steps: 4, read: 2, truncated: false }) ?? '', /Showing 2 of 4 steps/);
  assert.match(runCoverageNotice({ steps: 1, read: 1, truncated: true }) ?? '', /only part of it/);
  // Nothing read at all is the error banner's story, not a coverage note.
  assert.equal(runCoverageNotice({ steps: 2, read: 0, truncated: false }), null);
});

test('an empty ledger may only speak for itself on a whole read of a finished run', () => {
  assert.equal(runLedgerIsComplete(OVER, { steps: 2, read: 2, truncated: false }), true);
  assert.equal(runLedgerIsComplete(OVER, { steps: 2, read: 1, truncated: false }), false);
  assert.equal(runLedgerIsComplete(OVER, { steps: 1, read: 1, truncated: true }), false);
  assert.equal(runLedgerIsComplete(LIVE, { steps: 1, read: 1, truncated: false }), false);
  assert.equal(runLedgerIsComplete(PARKED, { steps: 1, read: 1, truncated: false }), false);
  assert.equal(runLedgerIsComplete(OVER, { steps: 0, read: 0, truncated: false }), false);
});

// ─── the rail must not claim more than one page of rows ────────────────────

test('the rail claims emptiness only when it actually saw everything', () => {
  const full = { fetched: 200, pageSize: 200 };
  const short = { fetched: 12, pageSize: 200 };
  assert.equal(
    conversationEmptyStateText({ filter: 'chats', query: '', ...short }),
    'No conversations yet.',
  );
  // 200 workflow runs newer than the last chat fill the one page the server
  // returns across both kinds — "no conversations" would be a claim the rail
  // cannot support.
  assert.match(
    conversationEmptyStateText({ filter: 'chats', query: '', ...full }),
    /No chats among the 200 most recent conversations/,
  );
  assert.match(
    conversationEmptyStateText({ filter: 'runs', query: '', ...full }),
    /No runs among the 200 most recent conversations/,
  );
  assert.match(conversationEmptyStateText({ filter: 'runs', query: '', ...short }), /^No runs yet\./);
  assert.equal(
    conversationEmptyStateText({ filter: 'chats', query: 'invoice', ...full }),
    'Nothing matches “invoice”.',
  );
});

test('the delete confirm describes what delete actually does', () => {
  // The console sends no `hard` flag, so a harness row is archived.
  assert.match(deleteConfirmText({ store: 'harness', kind: 'workflow' }), /run\? It is archived rather than erased/);
  assert.match(deleteConfirmText({ store: 'harness', kind: 'chat' }), /conversation\? It is archived/);
  assert.doesNotMatch(deleteConfirmText({ store: 'harness', kind: 'workflow' }), /cannot be undone/);
  // A legacy desktop chat really is deleted.
  assert.match(deleteConfirmText({ store: 'desktop', kind: 'chat' }), /cannot be undone/);
});

test('typed resumable completion keeps the observed run open until a later real final', () => {
  const held = { type: 'conversation_completed', data: { presentation: { version: 2, status: 'needs_input', resumable: true }, turnOutcome: { version: 2, status: 'needs_input', resumable: true } } };
  assert.equal(endsTheRun(held), false);
  assert.equal(observedRunStatus([held], 'completed'), 'paused');
  assert.equal(latestRunBoundary([held, { type: 'user_input_received' }]), null);
  const final = { type: 'conversation_completed', data: { presentation: { version: 2, status: 'done', resumable: false }, turnOutcome: { version: 2, status: 'done', resumable: false } } };
  assert.equal(endsTheRun(final), true);
  assert.equal(observedRunStatus([held, final], 'completed'), 'completed');
});


test('known workflow conversations cannot certify complete effects or absence of writes', () => {
  const partial = { steps: 2, read: 2, truncated: false, knownStepsOnly: true };
  assert.equal(runLedgerIsComplete(OVER, partial), false);
  assert.match(runCoverageNotice(partial) ?? '', /Other workflow activity/);
  assert.match(runEmptyStateText({ loading: false, failed: false, eventCount: 0, coverage: partial }) ?? '', /does not establish/);
  assert.match(runCoverageNotice({ ...partial, recordUnavailable: true }) ?? '', /record could not be read/);
  assert.match(runEmptyStateText({ loading: false, failed: false, eventCount: 0, coverage: { steps: 1, read: 1, truncated: true } }) ?? '', /does not establish/);
});
