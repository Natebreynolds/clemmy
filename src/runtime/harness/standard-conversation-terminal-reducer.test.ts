import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-standard-terminal-reducer-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const {
  _testOnly_reduceStandardConversationTerminal: reduceStandardConversationTerminal,
} = await import('./loop.js');
const { MISSING_REPLY_USER_FALLBACK } = await import('./turn-decision.js');

beforeEach(() => {
  eventlog.resetEventLog();
});

after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedSource(sessionId: string): { sourceUserSeq: number; turn: number } {
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Please answer this request.' },
  });
  return { sourceUserSeq: source.seq, turn: source.turn };
}

test('production reducer publishes a completed result with no reply as needs_input, never done', () => {
  const sessionId = 'missing-model-reply';
  const source = acceptedSource(sessionId);

  const reduced = reduceStandardConversationTerminal({
    sourceUserSeq: source.sourceUserSeq,
    result: {
      sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: source.turn,
    },
  });

  assert.equal(reduced.status, 'awaiting_user_input');
  assert.equal(reduced.publicPresentation?.kind, 'question');
  assert.equal(reduced.publicPresentation?.text, MISSING_REPLY_USER_FALLBACK);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.ok(terminal);
  assert.equal((terminal.data.turnOutcome as { status?: string }).status, 'needs_input');
  assert.equal(terminal.data.reason, 'awaiting_user_input');
});

test('production reducer preserves an authored completed reply as done', () => {
  const sessionId = 'authored-model-reply';
  const source = acceptedSource(sessionId);
  const authored = 'Here is the answer I wrote for you.';

  const reduced = reduceStandardConversationTerminal({
    sourceUserSeq: source.sourceUserSeq,
    result: {
      sessionId,
      status: 'completed',
      steps: 1,
      lastTurn: source.turn,
      lastDecision: {
        summary: 'Internal completion summary.',
        reply: authored,
        done: true,
        nextAction: 'completed',
        reason: null,
      },
    },
  });

  assert.equal(reduced.status, 'completed');
  assert.equal(reduced.publicPresentation?.kind, 'answer');
  assert.equal(reduced.publicPresentation?.text, authored);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.ok(terminal);
  assert.equal((terminal.data.turnOutcome as { status?: string }).status, 'done');
  assert.equal(terminal.data.reason, 'success');
});

test('an internal no-progress stop cannot become a resumable user continuation', () => {
  const sessionId = 'internal-no-progress-stop';
  const source = acceptedSource(sessionId);
  const text = 'I hit an internal host error before any external action. Nothing was executed or changed.';

  const reduced = reduceStandardConversationTerminal({
    sourceUserSeq: source.sourceUserSeq,
    result: {
      sessionId,
      status: 'blocked',
      steps: 1,
      lastTurn: source.turn,
      error: text,
      blockedResumable: false,
    },
  });

  assert.equal(reduced.status, 'blocked');
  assert.equal(reduced.publicPresentation?.kind, 'blocked');
  assert.equal(reduced.publicPresentation?.text, text);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.ok(terminal);
  const outcome = terminal.data.turnOutcome as { status?: string; resumable?: boolean };
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.resumable, false);
});

test('a host blocked terminal persists its machine reason and bounded detail, not the literal "blocked" (say why)', () => {
  const sessionId = 'host-blocked-says-why';
  const source = acceptedSource(sessionId);
  const text = 'I hit a bounded internal host error. Any completed work and retained results remain preserved, and no uncertain external change is pending.';
  const detail = 'catalog_entry_or_manifest_missing:candidates=0:proven=none';

  const reduced = reduceStandardConversationTerminal({
    sourceUserSeq: source.sourceUserSeq,
    result: {
      sessionId,
      status: 'blocked',
      steps: 1,
      lastTurn: source.turn,
      error: text,
      blockedResumable: false,
      blockedReason: 'control_no_progress_exhausted',
      blockedDetail: detail,
    },
  });

  assert.equal(reduced.status, 'blocked');
  assert.equal(reduced.publicPresentation?.text, text, 'machine metadata never rewrites the user-facing text');
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.ok(terminal);
  assert.equal(terminal.data.blockedReason, 'control_no_progress_exhausted');
  assert.equal(terminal.data.blockedDetail, detail);
  assert.equal(terminal.data.reason, 'blocked', 'the legacy classifier is unchanged');

  // A blocked result that carries no host reason keeps the compatibility default.
  const plainSessionId = 'host-blocked-without-reason';
  const plain = acceptedSource(plainSessionId);
  reduceStandardConversationTerminal({
    sourceUserSeq: plain.sourceUserSeq,
    result: { sessionId: plainSessionId, status: 'blocked', steps: 1, lastTurn: plain.turn, error: text },
  });
  const plainTerminal = eventlog.listEvents(plainSessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(plainTerminal?.data.blockedReason, 'blocked');
  assert.equal(plainTerminal && 'blockedDetail' in plainTerminal.data, false);
});


test('a failed terminal retains its returned diagnostic even when the advisory failure event is absent', () => {
  const sessionId = 'failure-without-advisory-event';
  const source = acceptedSource(sessionId);
  const diagnostic = 'model transport\nclosed before an accepted response';
  const result = { sessionId, status: 'failed' as const, steps: 1, lastTurn: source.turn, error: diagnostic };
  const reduced = reduceStandardConversationTerminal({ sourceUserSeq: source.sourceUserSeq, result });
  assert.equal(eventlog.listEvents(sessionId, { types: ['run_failed'] }).length, 0);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.failureDetail, 'model transport closed before an accepted response');
  assert.doesNotMatch(reduced.publicPresentation?.text ?? '', /transport|accepted response/);
  // A replay cannot replace the persisted diagnostic or create a second final.
  reduceStandardConversationTerminal({ sourceUserSeq: source.sourceUserSeq, result: { ...reduced, error: 'later diagnostic' } });
  const terminals = eventlog.listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].data.failureDetail, terminal?.data.failureDetail);
});

test('failure metadata belongs to the exact source and the returned error wins over advisory history', () => {
  const sessionId = 'failure-detail-source-ownership';
  const first = acceptedSource(sessionId);
  eventlog.appendEvent({ sessionId, turn: first.turn, role: 'system', type: 'run_failed', data: {
    sourceUserSeq: first.sourceUserSeq, error: 'previous request failure',
  } });
  const second = eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Another request.' } });
  const reduce = (sourceUserSeq: number, turn: number, error?: string) => reduceStandardConversationTerminal({
    sourceUserSeq, result: { sessionId, status: 'failed', steps: 1, lastTurn: turn, ...(error ? { error } : {}) },
  });
  reduce(second.seq, second.turn);
  assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)?.data.failureDetail, undefined,
    'an unrelated previous request must not explain a new failure');
  const third = eventlog.appendEvent({ sessionId, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'Third request.' } });
  eventlog.appendEvent({ sessionId, turn: third.turn, role: 'system', type: 'run_failed', data: {
    sourceUserSeq: third.seq, error: 'intermediate failure',
  } });
  reduce(third.seq, third.turn, 'actual terminal failure');
  assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)?.data.failureDetail, 'actual terminal failure');
});


test('an exact-source advisory can supply a missing diagnostic without entering public prose', () => {
  const sessionId = 'exact-advisory-fallback';
  const source = acceptedSource(sessionId);
  eventlog.appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'run_failed', data: {
    sourceUserSeq: source.sourceUserSeq, error: ' first detail ',
  } });
  eventlog.appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'run_failed', data: {
    sourceUserSeq: source.sourceUserSeq, error: ' latest   detail ' + 'x'.repeat(350),
  } });
  const reduced = reduceStandardConversationTerminal({ sourceUserSeq: source.sourceUserSeq,
    result: { sessionId, status: 'failed', steps: 1, lastTurn: source.turn } });
  const detail = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)?.data.failureDetail;
  assert.equal(typeof detail, 'string');
  assert.equal((detail as string).length, 300);
  assert.match(detail as string, /^latest detail /);
  assert.doesNotMatch(reduced.publicPresentation?.text ?? '', /latest detail/);
});
