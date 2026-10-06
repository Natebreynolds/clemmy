import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, beforeEach, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-standard-terminal-reducer-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const {
  _testOnly_reduceStandardConversationTerminal: reduceStandardConversationTerminal,
  modelCheckInForExhaustedTurn,
  runConversation,
} = await import('./loop.js');
const { MISSING_REPLY_USER_FALLBACK } = await import('./turn-decision.js');
const { BoundaryError } = await import('../boundary-error.js');
const { CodexModelError } = await import('./codex-model.js');
const { projectHarnessEventForPublic, PUBLIC_CODEX_AUTH_EXPIRED_TEXT, PUBLIC_BLOCKED_NEXT_STEP_TEXT } = await import('./public-presentation.js');

const EMPTY_STOP_TEXT = 'I did not receive a usable reply or next step from the model, so this request is still unfinished. Ask me to continue the unfinished work, or choose another model.';

test('typed empty stop survives the production result carrier and replay preserves a settled effect receipt', async () => {
  const sessionId = 'typed-empty-effect-replay';
  const source = acceptedSource(sessionId);
  let calls = 0;
  const options = {
    sessionId, sourceUserSeq: source.sourceUserSeq, reuseRecordedUserInput: true,
    agent: {} as never, input: 'Please answer this request.', judgeCompletion: false,
    makeRunner: () => new EventEmitter() as never,
    runRunner: async () => {
      calls += 1;
      const reserved = eventlog.appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'external_write',
        data: { sourceUserSeq: source.sourceUserSeq, callId: 'effect-once', preDispatch: true, shapeKey: 'LOCAL_SAVE' } });
      eventlog.appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'external_write_succeeded',
        parentEventId: reserved.id, data: { sourceUserSeq: source.sourceUserSeq, callId: 'effect-once', shapeKey: 'LOCAL_SAVE' } });
      throw new BoundaryError({ kind: 'model.empty_completion', retryable: true,
        userMessage: 'PRIVATE PROVIDER MESSAGE', operatorMessage: 'PRIVATE_EMPTY_DIAGNOSTIC' });
    },
  };
  const failed = await runConversation(options);
  assert.equal(failed.publicPresentation?.text, EMPTY_STOP_TEXT);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.publicPresentation?.resumable, false);
  assert.equal(failed.publicPresentation?.identity.sourceUserSeq, source.sourceUserSeq);
  const effects = eventlog.listEvents(sessionId, { types: ['external_write', 'external_write_succeeded'] });
  assert.equal(effects.length, 2);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(failed.failureKind, 'model.empty_completion');
  assert.equal(eventlog.listEvents(sessionId, { types: ['run_failed'] }).at(-1)?.data.failureKind, 'model.empty_completion');
  assert.equal(terminal.data.failureDetail, 'PRIVATE_EMPTY_DIAGNOSTIC');
  assert.doesNotMatch(JSON.stringify(projectHarnessEventForPublic(terminal)), /PRIVATE_EMPTY_DIAGNOSTIC|failureDetail/);
  assert.doesNotMatch(failed.publicPresentation?.text ?? '', /PRIVATE|no tools|nothing changed|usage|sign.in/i);
  const replay = await runConversation(options);
  assert.equal(calls, 1, 'reading the exact failed winner must not re-run the model or effect');
  assert.deepEqual(replay.publicPresentation, failed.publicPresentation);
  assert.deepEqual(eventlog.listEvents(sessionId, { types: ['external_write', 'external_write_succeeded'] }), effects);
  assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('generic blocked stop preserves the exact source and settled receipt without asserting no effects', () => {
  const sessionId = 'blocked-effect-source';
  const source = acceptedSource(sessionId);
  const reserved = eventlog.appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'external_write',
    data: { sourceUserSeq: source.sourceUserSeq, callId: 'prior-write', preDispatch: true, shapeKey: 'LOCAL_SAVE' } });
  const settled = eventlog.appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'external_write_succeeded',
    parentEventId: reserved.id, data: { sourceUserSeq: source.sourceUserSeq, callId: 'prior-write', shapeKey: 'LOCAL_SAVE' } });
  const input = { sourceUserSeq: source.sourceUserSeq,
    result: { sessionId, status: 'blocked' as const, steps: 1, lastTurn: source.turn } };
  const result = reduceStandardConversationTerminal(input);
  assert.equal(result.publicPresentation?.text, PUBLIC_BLOCKED_NEXT_STEP_TEXT);
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.resumable, true);
  assert.equal(result.publicPresentation?.identity.sourceUserSeq, source.sourceUserSeq);
  assert.doesNotMatch(result.publicPresentation?.text ?? '', /no tools|nothing changed|before using any tools/i);
  assert.deepEqual(reduceStandardConversationTerminal(input).publicPresentation, result.publicPresentation);
  assert.deepEqual(eventlog.listEvents(sessionId, { types: ['external_write_succeeded'] }), [settled]);
  assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
  const next = eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Next.' } });
  const named = reduceStandardConversationTerminal({ sourceUserSeq: next.seq,
    result: { sessionId, status: 'blocked', steps: 1, lastTurn: 2, error: 'The saved model is unavailable. Choose another model.' } });
  assert.equal(named.publicPresentation?.text, 'The saved model is unavailable. Choose another model.');
});

test('proven Codex revocation retains reconnect instructions across result, exact-source replay and unrelated failure', async () => {
  const { clearCodexAuthDead, isCodexAuthDead } = await import('../auth-store.js');
  clearCodexAuthDead();
  try {
    const sessionId = 'codex-revoked-result-carrier';
    const source = acceptedSource(sessionId);
    let calls = 0;
    const options = { sessionId, sourceUserSeq: source.sourceUserSeq, reuseRecordedUserInput: true,
      agent: {} as never, input: 'Please answer this request.', judgeCompletion: false,
      makeRunner: () => new EventEmitter() as never,
      runRunner: async () => { calls += 1; throw new CodexModelError('Codex /responses returned 401: token_revoked PRIVATE', 401); } };
    const failed = await runConversation(options);
    assert.equal(failed.publicPresentation?.text, PUBLIC_CODEX_AUTH_EXPIRED_TEXT);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.publicPresentation?.resumable, false);
    assert.equal(failed.publicPresentation?.identity.sourceUserSeq, source.sourceUserSeq);
    assert.equal(isCodexAuthDead(), true, 'the existing revocation branch still latches auth');
    const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)!;
    assert.equal(failed.failureKind, 'codex.auth_expired');
    assert.equal(eventlog.listEvents(sessionId, { types: ['run_failed'] }).at(-1)?.data.failureKind, 'codex.auth_expired');
    assert.doesNotMatch(JSON.stringify(projectHarnessEventForPublic(terminal)), /PRIVATE|token_revoked|login-native|failureDetail/);
    assert.deepEqual((await runConversation(options)).publicPresentation, failed.publicPresentation);
    assert.equal(calls, 1, 'exact failed source replay never retries revoked auth');
    const next = eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Different request.' } });
    const unrelated = await runConversation({ ...options, sourceUserSeq: next.seq, input: 'Different request.',
      runRunner: async () => { throw new Error('PRIVATE unrelated tool failure'); } });
    assert.match(unrelated.publicPresentation?.text ?? '', /cause.*not.*confirmed/i);
    assert.doesNotMatch(unrelated.publicPresentation?.text ?? '', /sign.in|token_revoked|PRIVATE/i);
    assert.equal(unrelated.publicPresentation?.identity.sourceUserSeq, next.seq);
    assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)?.data.failureKind, undefined);
  } finally { clearCodexAuthDead(); }
});

test('foreign auth-shaped failures cannot inherit a confident Codex public reason from its dead latch', async () => {
  const { clearCodexAuthDead, markCodexAuthDead } = await import('../auth-store.js');
  clearCodexAuthDead();
  markCodexAuthDead('fixture-only existing Codex revocation');
  try {
    for (const status of [401, 403]) {
      const sessionId = `foreign-auth-dead-codex-${status}`;
      const source = acceptedSource(sessionId);
      let calls = 0;
      const options = { sessionId, sourceUserSeq: source.sourceUserSeq, reuseRecordedUserInput: true,
        agent: {} as never, input: 'Please answer this request.', judgeCompletion: false,
        makeRunner: () => new EventEmitter() as never,
        runRunner: async () => { calls += 1; throw Object.assign(new Error('BYO provider rejected its own key PRIVATE'), { status }); } };
      const result = await runConversation(options);
      assert.equal(result.status, 'failed');
      assert.equal(result.failureKind, undefined, 'the legacy classifier is not Codex origin proof');
      assert.match(result.publicPresentation?.text ?? '', /cause.*not.*confirmed/i);
      assert.match(result.publicPresentation?.text ?? '', /what completed.*what remains.*before retrying/i);
      assert.doesNotMatch(result.publicPresentation?.text ?? '', /Codex|sign.in|PRIVATE|no tools|nothing changed/i);
      assert.equal(result.publicPresentation?.identity.sourceUserSeq, source.sourceUserSeq);
      assert.deepEqual((await runConversation(options)).publicPresentation, result.publicPresentation);
      assert.equal(calls, 1);
      assert.equal(eventlog.listEvents(sessionId, { types: ['run_failed'] }).at(-1)?.data.failureKind, undefined);
    }
  } finally { clearCodexAuthDead(); }
});

test('typed empty stop is source-bound and raw or previous failure wording has no typed authority', () => {
  const sessionId = 'typed-empty-source-isolation';
  const first = acceptedSource(sessionId);
  const firstResult = reduceStandardConversationTerminal({ sourceUserSeq: first.sourceUserSeq,
    result: { sessionId, status: 'failed', steps: 1, lastTurn: first.turn,
      failureKind: 'model.empty_completion', error: 'private first failure' } });
  assert.equal(firstResult.publicPresentation?.text, EMPTY_STOP_TEXT);
  const next = eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Another request.' } });
  eventlog.appendEvent({ sessionId, turn: 2, role: 'system', type: 'run_failed',
    data: { sourceUserSeq: first.sourceUserSeq, failureKind: 'model.empty_completion', error: 'old empty completion' } });
  const second = reduceStandardConversationTerminal({ sourceUserSeq: next.seq,
    result: { sessionId, status: 'failed', steps: 1, lastTurn: next.turn,
      error: 'model.empty_completion: PRIVATE_EMPTY_DIAGNOSTIC' } });
  assert.match(second.publicPresentation?.text ?? '', /cause.*not.*confirmed/i);
  assert.match(second.publicPresentation?.text ?? '', /what completed.*what remains.*before retrying/i);
  assert.doesNotMatch(second.publicPresentation?.text ?? '', /PRIVATE|model finished|no tools|nothing changed/i);
  assert.equal(second.publicPresentation?.identity.sourceUserSeq, next.seq);
  assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)?.data.failureKind, undefined);
});

test('public budget stop gives an ordinary next action at the exact source without another dispatch', async () => {
  const sessionId = 'budget-stop-next-action';
  const source = acceptedSource(sessionId);
  let calls = 0;
  const result = await runConversation({ sessionId, sourceUserSeq: source.sourceUserSeq,
    reuseRecordedUserInput: true, agent: {} as never, input: 'Please answer this request.',
    judgeCompletion: false, maxSteps: 1, makeRunner: () => new EventEmitter() as never,
    runRunner: async (_runner, _agent, items) => {
      calls += 1;
      return { history: items, finalOutput: 'CONTINUE: There is more work remaining.', toolCalls: 3 } as never;
    } });
  assert.equal(calls, 1, 'publishing guidance does not spend another model turn');
  assert.equal(result.status, 'blocked');
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.kind, 'blocked');
  assert.equal(result.publicPresentation?.resumable, true);
  assert.equal(result.publicPresentation?.identity.sourceUserSeq, source.sourceUserSeq);
  assert.match(result.publicPresentation?.text ?? '', /step budget.*more work remaining/i);
  assert.match(result.publicPresentation?.text ?? '', /Ask me to continue the unfinished work\./);
  const terminal = eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)!;
  assert.equal(terminal.data.reason, 'step_budget_parked');
  assert.equal(terminal.data.sourceUserSeq, source.sourceUserSeq);
  assert.equal((terminal.data.turnOutcome as { needs?: unknown }).needs, undefined, 'no synthetic Continue control');
  assert.equal(eventlog.listEvents(sessionId, { types: ['tool_called', 'external_write', 'external_write_succeeded'] }).length, 0);
});

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

for (const blockedResumable of [false, undefined] as const) {
  test(`a completed explanatory check-in reaches the blocked terminal without changing resumability (${blockedResumable !== false})`, async () => {
    const sessionId = `explained-no-progress-${blockedResumable !== false}`;
    const source = acceptedSource(sessionId);
    const explanation = 'The helper stopped before returning a usable result. The earlier findings are retained, but the requested audit is incomplete.';
    const stopped = {
      sessionId, turn: source.turn, status: 'blocked' as const,
      finalOutput: 'Stopped at: execution:unknown',
      error: 'Stopped at: execution:unknown',
      blockedReason: 'control_no_progress_exhausted', blockedDetail: 'execution:unknown',
      ...(blockedResumable === false ? { blockedResumable } : {}),
      toolCalls: 3,
    };
    let calls = 0;
    const explained = await modelCheckInForExhaustedTurn(stopped, {
      sessionId, sourceUserSeq: source.sourceUserSeq,
      run: async () => {
        calls += 1;
        return { sessionId, turn: source.turn + 1, status: 'completed', finalOutput: explanation, toolCalls: 0 };
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual({ ...explained, finalOutput: stopped.finalOutput, error: stopped.error }, stopped,
      'only public wording changes; the original stop and retained state remain intact');
    const reduced = reduceStandardConversationTerminal({
      sourceUserSeq: source.sourceUserSeq,
      result: {
        sessionId, status: explained.status, steps: 1, lastTurn: explained.turn,
        error: explained.error, blockedReason: explained.blockedReason,
        blockedDetail: explained.blockedDetail, blockedResumable: explained.blockedResumable,
        lastDecision: { summary: explanation, reply: explanation, done: false, nextAction: 'abandoned', reason: explained.error ?? null },
      },
    });
    assert.equal(reduced.publicPresentation?.text, explanation,
      'the reducer must publish the completed explanation rather than the retained machine error');
    assert.equal(reduced.status, 'blocked');
    const terminals = eventlog.listEvents(sessionId, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 1);
    const terminal = terminals[0]!;
    assert.equal(terminal.data.reply, explanation);
    assert.equal(terminal.data.reason, 'blocked');
    assert.equal(terminal.data.blockedReason, stopped.blockedReason);
    assert.equal(terminal.data.blockedDetail, stopped.blockedDetail);
    const outcome = terminal.data.turnOutcome as { status: string; resumable: boolean };
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.resumable, blockedResumable !== false);
    const presentation = terminal.data.presentation as { identity: { sessionId: string; sourceUserSeq: number; turn: number } };
    assert.deepEqual(presentation.identity, { sessionId, sourceUserSeq: source.sourceUserSeq, turn: source.turn });
    assert.equal(eventlog.listEvents(sessionId, { types: ['awaiting_user_input'] }).length, 0);
  });
}

test('an unfinished or empty explanatory check-in leaves the original blocked text intact', async () => {
  for (const [status, finalOutput] of [['blocked', 'An unfinished explanation.'], ['completed', '']] as const) {
    const sessionId = `unusable-explanation-${status}`;
    const source = acceptedSource(sessionId);
    const stopped = { sessionId, turn: source.turn, status: 'blocked' as const, finalOutput: 'Original stop.',
      error: 'Original stop.', blockedReason: 'control_no_progress_exhausted', blockedDetail: 'execution:unknown' };
    const result = await modelCheckInForExhaustedTurn(stopped, { sessionId, sourceUserSeq: source.sourceUserSeq,
      run: async () => ({ sessionId, turn: source.turn, status, finalOutput, toolCalls: 0 }) });
    assert.equal(result, stopped);
  }
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

test('a job handed to an agent explains its stop in words too; a plain background run keeps the typed stop', async () => {
  const run = async (sessionId: string, metadata: Record<string, unknown>) => {
    eventlog.createSession({ id: sessionId, kind: 'execution', metadata } as never);
    const source = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Do the delegated job.' } });
    const stopped = { sessionId, turn: source.turn, status: 'blocked' as const, finalOutput: 'Stopped at: execution:policy_denial',
      error: 'Stopped at: execution:policy_denial', blockedReason: 'control_no_progress_exhausted', blockedDetail: 'execution:policy_denial', toolCalls: 4 };
    let calls = 0;
    const explained = await modelCheckInForExhaustedTurn(stopped, { sessionId, sourceUserSeq: source.seq,
      run: async () => { calls += 1; return { sessionId, turn: source.turn + 1, status: 'completed', finalOutput: 'I could not reach the data source, so the audit is not finished yet.', toolCalls: 0 }; } });
    return { calls, explained };
  };
  const delegated = await run('background:explained-lead-job', { delegatedTaskId: 'task-explained' });
  assert.equal(delegated.calls, 1);
  assert.equal(delegated.explained.error, 'I could not reach the data source, so the audit is not finished yet.');
  assert.equal(delegated.explained.status, 'blocked');
  const plain = await run('background:plain-typed-stop', {});
  assert.equal(plain.calls, 0);
  assert.equal(plain.explained.error, 'Stopped at: execution:policy_denial');
});

test('a model account out of usage or credit is named, with the provider words; other failures stay generic', () => {
  const reduceFailed = (sessionId: string, error: string) => {
    const source = acceptedSource(sessionId);
    return reduceStandardConversationTerminal({ sourceUserSeq: source.sourceUserSeq,
      result: { sessionId, status: 'failed', steps: 1, lastTurn: source.turn, error } }).publicPresentation?.text ?? '';
  };
  const usage = reduceFailed('capacity-usage', "You're out of extra usage. Add more at the provider's usage settings and keep going.");
  assert.match(usage, /used up its usage/);
  assert.match(usage, /Its provider said: “You're out of extra usage\./);
  assert.match(usage, /saved/);
  assert.doesNotMatch(usage, /Something went wrong/);
  const credit = reduceFailed('capacity-credit', 'Your credit balance is too low to access the API.');
  assert.match(credit, /out of credit/);
  const shaped = reduceFailed('capacity-shaped', '400 {"type":"error","error":{"message":"usage_limit_reached"}}');
  assert.match(shaped, /used up its usage/);
  assert.doesNotMatch(shaped, /provider said|usage_limit_reached|\{/, 'a structured payload is not quoted');
  const other = reduceFailed('capacity-other', 'socket hang up');
  assert.match(other, /cause.*not.*confirmed/i);
  assert.match(other, /what completed.*what remains.*before retrying/i);
  assert.doesNotMatch(other, /socket/);
});

test('a stop explained as a question reaches the owner without the decision marker', async () => {
  const sessionId = 'check-in-ask-marker';
  eventlog.createSession({ id: sessionId, kind: 'chat' } as never);
  const source = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Pull the remaining data.' } });
  const stopped = { sessionId, turn: source.turn, status: 'blocked' as const, finalOutput: 'Stopped', error: 'Stopped',
    blockedReason: 'control_no_progress_exhausted', blockedDetail: 'execution:refused', toolCalls: 3 };
  const asked = await modelCheckInForExhaustedTurn(stopped, { sessionId, sourceUserSeq: source.seq,
    run: async () => ({ sessionId, turn: source.turn + 1, status: 'completed', finalOutput: 'ASK: Can I run the remaining pulls myself?', toolCalls: 0 }) });
  assert.equal(asked.status, 'awaiting_user_input');
  assert.equal(asked.finalOutput, 'Can I run the remaining pulls myself?');
  const question = eventlog.listEvents(sessionId, { types: ['awaiting_user_input'] }).at(-1)?.data.question;
  assert.equal(question, 'Can I run the remaining pulls myself?');
});
