import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-delivery-committer-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { actionBus } = await import('../action-bus.js');
const { appendEvent, appendTerminalEventOnce, createSession, listEvents } = await import('./eventlog.js');
const { commitTurnOutcome, completionDataForTurnOutcome } = await import('./delivery-committer.js');
const {
  InvalidTurnOutcomeError,
  UnsafePresentationError,
  presentationEventForOutcome,
  presentationEventFromCompletionData,
  turnOutcomeId,
} = await import('./turn-outcome.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function answer(sessionId: string, text: string): TurnOutcome {
  const identity = { sessionId, turn: 1, attemptId: `attempt-${sessionId}`, sourceUserSeq: 1 } as const;
  return {
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
    evidenceRefs: [{ kind: 'tool_result', id: 'tool-result-1' }],
  };
}

function acceptedAnswer(
  sessionId: string,
  text: string,
  options: { turn?: number; attemptId?: string; runId?: string } = {},
): TurnOutcome {
  const source = appendEvent({
    sessionId,
    turn: options.turn ?? 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Accepted request.' },
  });
  const identity = {
    sessionId,
    turn: source.turn,
    sourceUserSeq: source.seq,
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  };
  return {
    ...answer(sessionId, text),
    id: turnOutcomeId(identity),
    identity,
  };
}

test('typed outcome projection ignores runtime-cast internal fields', () => {
  const outcome = {
    ...answer('projection', 'The account is healthy.'),
    internalSummary: 'judge chain and private prompt',
    rawModelOutput: 'summary: leaked',
  } as TurnOutcome;
  const presentation = presentationEventForOutcome(outcome);
  assert.equal(presentation.text, 'The account is healthy.');
  assert.equal('internalSummary' in presentation, false);
  assert.equal('rawModelOutput' in presentation, false);

  const data = completionDataForTurnOutcome(outcome, {
    metadata: {
      steps: 3,
      internalSummary: 'must not cross',
      reply: 'must not override the presentation',
    },
  });
  assert.equal(data.reply, 'The account is healthy.');
  assert.equal(data.steps, 3);
  assert.equal('internalSummary' in data, false);
});

test('outcome id must be the canonical id derived from its exact turn identity', () => {
  const outcome = answer('noncanonical-id', 'This must not be published.');
  const forged = { ...outcome, id: 'brain:a-different-attempt' } as TurnOutcome;
  assert.throws(() => presentationEventForOutcome(forged), InvalidTurnOutcomeError);
  assert.throws(() => completionDataForTurnOutcome(forged), InvalidTurnOutcomeError);
});

test('the committer persists and publishes exactly one winning public answer', () => {
  const sessionId = 'commit-once';
  createSession({ id: sessionId, kind: 'chat' });
  const firstProposal = acceptedAnswer(sessionId, 'First committed answer.', {
    attemptId: 'attempt-first',
    runId: 'run-first',
  });
  const racedProposal = {
    ...firstProposal,
    identity: {
      sessionId,
      turn: firstProposal.identity.turn,
      sourceUserSeq: firstProposal.identity.sourceUserSeq,
      attemptId: 'attempt-fallover',
      runId: 'run-fallover',
    },
    presentation: { kind: 'answer', text: 'Losing retry answer.' },
  } as TurnOutcome;
  const publicEvents: unknown[] = [];
  const detach = actionBus.subscribe((event) => {
    if (event.kind === 'harness.public_event' && event.sessionId === sessionId) publicEvents.push(event);
  });
  try {
    const first = commitTurnOutcome(firstProposal);
    const raced = commitTurnOutcome(racedProposal);
    assert.equal(first.inserted, true);
    assert.equal(raced.inserted, false);
    assert.equal(raced.presentation.text, 'First committed answer.');

    const completions = listEvents(sessionId, { types: ['conversation_completed'] });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].data.reply, 'First committed answer.');
    assert.equal(
      (completions[0].data.presentation as { audience?: string }).audience,
      'user',
    );
    assert.equal(publicEvents.length, 1, 'only the inserted terminal is published');
  } finally {
    detach();
  }
});

test('invalid status/presentation combinations and narrated control text fail closed', () => {
  assert.throws(
    () => presentationEventForOutcome({
      ...answer('bad-shape', 'Question?'),
      status: 'needs_input',
      resumable: true,
      needs: { kind: 'input' },
      presentation: { kind: 'answer', text: 'Question?' },
    } as unknown as TurnOutcome),
    InvalidTurnOutcomeError,
  );

  assert.throws(
    () => presentationEventForOutcome(answer('unsafe', [
      'summary: internal',
      'reply: public',
      'done: true',
      'nextAction: completed',
      'reason: internal',
    ].join('\n'))),
    UnsafePresentationError,
  );
});

test('approval outcome requires and preserves an exact approval id', () => {
  const identity = { sessionId: 'approval-shape', turn: 2, sourceUserSeq: 12 } as const;
  const presentation = presentationEventForOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'approval' },
    presentation: { kind: 'approval', text: 'Approve sending the message?', approvalId: 'apr-123' },
  });
  assert.equal(presentation.kind, 'approval');
  assert.equal(presentation.approvalId, 'apr-123');
});

test('typed completion decoder validates duplicated id, identity, and status authority fields', () => {
  const outcome = answer('strict-decode', 'Strictly decoded answer.');
  const canonical = completionDataForTurnOutcome(outcome);
  canonical.terminalKey = outcome.id;
  assert.equal(presentationEventFromCompletionData(canonical)?.text, 'Strictly decoded answer.');

  const contradictions: Array<[string, (data: Record<string, unknown>) => void]> = [
    ['presentation id', (data) => {
      (data.presentation as Record<string, unknown>).id = 'brain:foreign:presentation';
    }],
    ['outcome id', (data) => {
      (data.presentation as Record<string, unknown>).outcomeId = 'brain:foreign';
    }],
    ['top-level attempt identity', (data) => { data.attemptId = 'attempt-foreign'; }],
    ['durable status', (data) => {
      (data.turnOutcome as Record<string, unknown>).status = 'failed';
    }],
    ['terminal key', (data) => { data.terminalKey = 'brain:foreign'; }],
  ];
  for (const [label, mutate] of contradictions) {
    const data = structuredClone(canonical) as Record<string, unknown>;
    mutate(data);
    assert.throws(
      () => presentationEventFromCompletionData(data),
      InvalidTurnOutcomeError,
      `${label} contradiction must fail closed`,
    );
  }
});

test('a contradictory typed winner is never reinterpreted through the losing proposal', () => {
  const sessionId = 'contradictory-winner';
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Losing retry.');
  const corrupt = completionDataForTurnOutcome({
    ...outcome,
    presentation: { kind: 'answer', text: 'First writer text.' },
  } as TurnOutcome);
  (corrupt.turnOutcome as Record<string, unknown>).status = 'failed';
  appendTerminalEventOnce({
    sessionId,
    turn: outcome.identity.turn,
    role: 'system',
    data: corrupt,
  }, outcome.id);

  assert.throws(() => commitTurnOutcome(outcome), InvalidTurnOutcomeError);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('an explicit pre-typed terminal winner remains compatible', () => {
  const sessionId = 'legacy-winner';
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Losing modern retry.');
  appendTerminalEventOnce({
    sessionId,
    turn: outcome.identity.turn,
    role: 'system',
    data: {
      reply: 'First legacy answer.',
      summary: 'First legacy answer.',
      reason: 'success',
      delivered: true,
    },
  }, outcome.id);

  const result = commitTurnOutcome(outcome);
  assert.equal(result.inserted, false);
  assert.equal(result.presentation.text, 'First legacy answer.');
  assert.equal(result.presentation.outcomeId, outcome.id);
  assert.deepEqual(result.presentation.identity, outcome.identity);
});

test('a pre-upgrade typed brain terminal wins by exact source over a new turn-key retry', () => {
  const sessionId = 'upgrade-attempt-winner';
  createSession({ id: sessionId, kind: 'chat' });
  const proposed = acceptedAnswer(sessionId, 'Losing upgraded retry.');
  const legacyIdentity = {
    sessionId,
    turn: proposed.identity.turn,
    sourceUserSeq: proposed.identity.sourceUserSeq,
    attemptId: 'attempt-pre-upgrade',
    runId: 'run-pre-upgrade',
  };
  const legacyOutcome = {
    ...proposed,
    id: turnOutcomeId(legacyIdentity),
    identity: legacyIdentity,
    presentation: { kind: 'answer', text: 'The pre-upgrade answer already committed.' },
  } as TurnOutcome;
  const legacyData = completionDataForTurnOutcome(legacyOutcome);
  const legacyKey = `brain:${legacyIdentity.attemptId}`;
  (legacyData.presentation as Record<string, unknown>).id = `${legacyKey}:presentation`;
  (legacyData.presentation as Record<string, unknown>).outcomeId = legacyKey;
  (legacyData.turnOutcome as Record<string, unknown>).id = legacyKey;
  legacyData.terminalKey = legacyKey;
  appendEvent({
    sessionId,
    turn: legacyIdentity.turn,
    role: 'system',
    type: 'conversation_completed',
    data: legacyData,
  });

  const result = commitTurnOutcome(proposed);
  assert.equal(result.inserted, false);
  assert.equal(result.presentation.text, 'The pre-upgrade answer already committed.');
  assert.equal(result.presentation.outcomeId, proposed.id);
  assert.deepEqual(result.presentation.identity, proposed.identity);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('committer rejects a source sequence whose accepted event has another turn', () => {
  const sessionId = 'wrong-accepted-turn';
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Must not publish.', { turn: 4 });
  const contradictory = {
    ...outcome,
    identity: { ...outcome.identity, turn: 5 },
  } as TurnOutcome;
  assert.throws(() => commitTurnOutcome(contradictory), InvalidTurnOutcomeError);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('a typed winner whose event envelope names another turn fails closed', () => {
  const sessionId = 'wrong-turn-winner';
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Losing retry.');
  appendTerminalEventOnce({
    sessionId,
    turn: outcome.identity.turn + 1,
    role: 'system',
    data: completionDataForTurnOutcome({
      ...outcome,
      presentation: { kind: 'answer', text: 'First writer text.' },
    } as TurnOutcome),
  }, outcome.id);

  assert.throws(() => commitTurnOutcome(outcome), InvalidTurnOutcomeError);
});

test('physical attempts racing on one accepted source converge on the first terminal', () => {
  const sessionId = 'same-source-fallover';
  createSession({ id: sessionId, kind: 'chat' });
  const winner = acceptedAnswer(sessionId, 'First writer text.', {
    attemptId: 'attempt-original',
    runId: 'run-original',
  });
  appendTerminalEventOnce({
    sessionId,
    turn: winner.identity.turn,
    role: 'system',
    data: completionDataForTurnOutcome(winner),
  }, winner.id);
  const falloverRetry = {
    ...winner,
    identity: {
      sessionId,
      turn: winner.identity.turn,
      sourceUserSeq: winner.identity.sourceUserSeq,
      attemptId: 'attempt-fallover',
      runId: 'run-fallover',
    },
    presentation: { kind: 'answer', text: 'Losing retry.' },
  } as TurnOutcome;

  assert.equal(turnOutcomeId(falloverRetry.identity), winner.id);
  const result = commitTurnOutcome(falloverRetry);
  assert.equal(result.inserted, false);
  assert.equal(result.presentation.text, 'First writer text.');
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
});
