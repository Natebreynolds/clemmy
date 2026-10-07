import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceBoundChatControl, stopObservedChatTurn, stopQualificationOwnsChat } from './chat-control.js';

test('reopened and adopted phone sources cancel only the exact matched existing attempt', async () => {
  for (const sourceUserSeq of [20, 40]) {
    const calls: string[] = [];
    assert.equal(await stopObservedChatTurn({ sessionId: 'fixture', sourceUserSeq, stillCurrent: () => true,
      readControl: async (sessionId, source) => ({ activeRun: { sessionId, sourceUserSeq: source, attemptId: `attempt-${source}` } }),
      cancelExact: async (session, attempt) => { calls.push(`${session}:${attempt}`); return { ok: true }; },
    }), true);
    assert.deepEqual(calls, [`fixture:attempt-${sourceUserSeq}`]);
  }
});

test('a newer active source and a missing/foreign control cannot substitute for the observed run', async () => {
  const row = { sessionId: 'fixture', sourceUserSeq: 20, attemptId: 'attempt-20' };
  let calls = 0;
  for (const activeRun of [null, { ...row, sourceUserSeq: 21 }, { ...row, sessionId: 'other' }, { ...row, attemptId: '' }]) {
    assert.equal(sourceBoundChatControl(activeRun, 'fixture', 20), null);
    await assert.rejects(stopObservedChatTurn({ sessionId: 'fixture', sourceUserSeq: 20, stillCurrent: () => true,
      readControl: async () => ({ activeRun }), cancelExact: async () => { calls += 1; return { ok: true }; },
    }), /Stop was not confirmed/);
  }
  assert.equal(calls, 0);
});

test('late control reads after a chat switch or source replacement never post cancellation', async () => {
  let current = true;
  let finish!: (value: { activeRun: unknown }) => void;
  let calls = 0;
  const pending = stopObservedChatTurn({ sessionId: 'fixture', sourceUserSeq: 20, stillCurrent: () => current,
    readControl: () => new Promise(resolve => { finish = resolve; }),
    cancelExact: async () => { calls += 1; return { ok: true }; },
  });
  current = false;
  finish({ activeRun: { sessionId: 'fixture', sourceUserSeq: 20, attemptId: 'attempt-20' } });
  assert.equal(await pending, false);
  assert.equal(calls, 0);
});

test('missing source authority and refused exact cancellation remain explicit uncertainty', async () => {
  let reads = 0;
  const readControl = async () => { reads += 1; return { activeRun: { sessionId: 'fixture', sourceUserSeq: 20, attemptId: 'attempt-20' } }; };
  await assert.rejects(stopObservedChatTurn({ sessionId: 'fixture', sourceUserSeq: null, stillCurrent: () => true,
    readControl, cancelExact: async () => ({ ok: true }),
  }), /Could not confirm/);
  assert.equal(reads, 0);
  for (const cancelExact of [async () => ({ ok: false }), async () => { throw new Error('STALE_RUN_ATTEMPT'); }]) {
    await assert.rejects(stopObservedChatTurn({ sessionId: 'fixture', sourceUserSeq: 20, stillCurrent: () => true,
      readControl, cancelExact,
    }), /Stop was not confirmed/);
  }
});

test('deferred phone Stop qualification cannot attach to a newer settled source or switched session', async () => {
  const owner = { sessionId: 'fixture', key: 'request-20', sourceUserSeq: 20, acceptedSeqAtStop: 20 };
  const accepted = (sourceUserSeq: number) => ({ acceptedSource: { sessionId: 'fixture', sourceUserSeq, turn: sourceUserSeq },
    idempotencyKey: `request-${sourceUserSeq}` });
  let current = { sessionId: 'fixture', busy: false, cancelKey: null, activeSourceUserSeq: null, messages: [accepted(20)] };
  assert.equal(stopQualificationOwnsChat(owner, current), true, 'same source may settle while the receipt crosses the response boundary');
  let release!: () => void;
  const receipt = new Promise<void>(resolve => { release = resolve; }).then(() => stopQualificationOwnsChat(owner, current));
  current = { ...current, messages: [accepted(20), accepted(21)] };
  release();
  assert.equal(await receipt, false, 'busy=false alone does not establish ownership of the latest completed turn');
  assert.equal(stopQualificationOwnsChat(owner, { ...current, sessionId: 'other' }), false);
  const preAccepted = { ...owner, sourceUserSeq: null, acceptedSeqAtStop: 19 };
  assert.equal(stopQualificationOwnsChat(preAccepted, { ...current, messages: [accepted(20)] }), true,
    'the original request key may bind its own late accepted source');
});
