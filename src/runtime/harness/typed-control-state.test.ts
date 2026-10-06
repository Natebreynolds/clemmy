/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/typed-control-state.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultHoldForControlState,
  isTypedControlStatus,
  renderTypedControlState,
} from './typed-control-state.js';
import {
  presentationEventForOutcome,
  turnOutcomeId,
  UnsafePresentationError,
  type TurnOutcome,
} from './turn-outcome.js';

test('every non-final control state has an owner and a wake condition', () => {
  const blocked = defaultHoldForControlState({ status: 'blocked' });
  assert.equal(blocked.owner, 'host');
  assert.ok(blocked.wake.kind === 'host_retry' || blocked.wake.kind === 'host_reconcile' || blocked.wake.kind === 'host_peer');

  const question = defaultHoldForControlState({ status: 'needs_input', needs: { kind: 'input' } });
  assert.equal(question.owner, 'user');
  assert.equal(question.wake.kind, 'user_answer');

  const connect = defaultHoldForControlState({
    status: 'needs_input',
    gate: 'credential_connection_required',
  });
  assert.equal(connect.owner, 'user');
  assert.equal(connect.wake.kind, 'user_connection');

  const uncertain = defaultHoldForControlState({ status: 'uncertain' });
  assert.equal(uncertain.owner, 'host');
  assert.equal(uncertain.wake.kind, 'host_reconcile');
});

test('deterministic copy never depends on a model sentence', () => {
  const blocked = renderTypedControlState({ status: 'blocked' });
  assert.match(blocked, /unfinished.*cause is not confirmed.*check the blocker/i);
  assert.doesNotMatch(blocked, /provider|connection/i, 'Default hold is not observation of a failed provider.');
  const question = renderTypedControlState({ status: 'needs_input', needs: { kind: 'input' } });
  assert.match(question, /unfinished.*information.*check what information is still missing/i);
  const uncertain = renderTypedControlState({ status: 'uncertain' });
  assert.match(uncertain, /may already have happened.*unfinished.*check the outcome/i);
  for (const text of [blocked, question, uncertain]) {
    assert.doesNotMatch(text, /I will (?:continue|resume|reconcile)|nothing (?:new )?was started|have not retried/i,
      'A declared control state cannot certify an armed wake or historical effect receipt.');
  }
});

function identity(sessionId: string) {
  return { sessionId, turn: 1, sourceUserSeq: 1 };
}

test('an empty or unsafe author on a control state still publishes the host sentence', () => {
  const blockedId = identity('sess-author-outage-blocked');
  const blocked: TurnOutcome = {
    version: 2,
    id: turnOutcomeId(blockedId),
    identity: blockedId,
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text: '   ' },
  };
  const published = presentationEventForOutcome(blocked);
  assert.equal(published.status, 'blocked');
  assert.ok(published.text.trim().length > 0);
  assert.match(published.text, /unfinished.*cause is not confirmed.*check the blocker/i);
  assert.doesNotMatch(published.text, /provider|connection|I will continue/i);

  const questionId = identity('sess-author-outage-question');
  const question: TurnOutcome = {
    version: 2,
    id: turnOutcomeId(questionId),
    identity: questionId,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: 'summary: internal\nreply: public\ndone: false\nnextAction: ask\nreason: author' },
  };
  const asked = presentationEventForOutcome(question);
  assert.equal(asked.status, 'needs_input');
  assert.match(asked.text, /unfinished.*check what information is still missing/i);
});

test('an unsafe Continue author preserves the real control instead of asking for new information', () => {
  const id = identity('sess-author-outage-continue');
  const outcome: TurnOutcome = {
    version: 2,
    id: turnOutcomeId(id),
    identity: id,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'continue' },
    presentation: { kind: 'continue', text: '' },
  };
  const event = presentationEventForOutcome(outcome);
  assert.equal(event.status, 'needs_input');
  assert.equal(event.kind, 'continue');
  assert.equal(event.resumable, true);
  assert.deepEqual(event.identity, id);
  assert.deepEqual(event.needs, { kind: 'continue' });
  assert.match(event.text, /unfinished.*Use Continue here/i);
  assert.doesNotMatch(event.text, /information|send.*again|I will continue/i);
});

test('blocked fallback reports only declared facts and leaves its wake and owner unchanged', () => {
  const cases = [
    ['budget_exhausted', /budget/],
    ['lease_unavailable', /activation holds/],
    ['reconciliation_pending', /effect may already/],
    ['admission_refused', /could not admit/],
    ['capability_identity_mismatch', /could not admit/],
    ['observation_unavailable', /observation is unavailable/],
    ['provider_unavailable', /provider is unavailable/],
  ] as const;
  for (const [reason, expectedFact] of cases) {
    const hold = defaultHoldForControlState({ status: 'blocked', hold: reason });
    const original = structuredClone(hold);
    const text = renderTypedControlState({ status: 'blocked', hold });
    assert.match(text, expectedFact);
    assert.match(text, /unfinished.*Ask me to check/);
    assert.doesNotMatch(text, /I will (?:continue|resume|reconcile)|nothing .*started|have not retried|host defect/);
    assert.deepEqual(hold, original, 'Rendering cannot change the typed wake or owner.');
  }
});

test('a completed answer with empty or unsafe author still fails closed', () => {
  const id = identity('sess-author-outage-done');
  assert.throws(
    () => presentationEventForOutcome({
      version: 2,
      id: turnOutcomeId(id),
      identity: id,
      status: 'done',
      resumable: false,
      presentation: { kind: 'answer', text: '' },
    }),
    UnsafePresentationError,
  );
  assert.equal(isTypedControlStatus('done'), false);
  assert.equal(isTypedControlStatus('failed'), false);
  assert.equal(isTypedControlStatus('blocked'), true);
});
