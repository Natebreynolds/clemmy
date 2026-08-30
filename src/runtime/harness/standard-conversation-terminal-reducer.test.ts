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
