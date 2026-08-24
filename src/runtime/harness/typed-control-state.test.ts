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
  assert.match(blocked, /continue this exact request/i);
  const question = renderTypedControlState({ status: 'needs_input', needs: { kind: 'input' } });
  assert.match(question, /resume this exact request/i);
  const uncertain = renderTypedControlState({ status: 'uncertain' });
  assert.match(uncertain, /have not retried/i);
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
  assert.match(published.text, /continue this exact request/i);

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
  assert.match(asked.text, /resume this exact request/i);
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
