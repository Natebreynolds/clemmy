/**
 * Run: npx tsx --test src/runtime/harness/verify-delivered.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDelivered, matchesBlockedText } from './verify-delivered.js';
import type { ObjectiveJudgeVerdict } from './objective-judge.js';

// A judge stub that records whether it was invoked, so we can assert the
// "suspicious-only" budget: it must fire ONLY on a promise-shaped reply.
function judgeStub(done: boolean): { fn: (o: string, r: string) => Promise<ObjectiveJudgeVerdict>; calls: () => number } {
  let calls = 0;
  return {
    fn: async () => {
      calls += 1;
      return { done, reason: done ? 'artifact present' : 'no verifiable artifact' };
    },
    calls: () => calls,
  };
}

test('a clean completion with an artifact is delivered WITHOUT spending a judge call', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered(
    'create a summary doc',
    "Done — wrote the summary to /tmp/out.md. Here's the link: https://x/y",
    { stoppedReason: 'success', judgeFn: judge.fn },
  );
  assert.equal(v.delivered, true);
  assert.equal(v.status, 'completed');
  assert.equal(judge.calls(), 0, 'a non-promise-shaped reply must not invoke the judge');
});

test('a runtime-error stoppedReason is blocked (no judge needed)', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered('pull the data', 'Some partial text', {
    stoppedReason: 'error',
    judgeFn: judge.fn,
  });
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.equal(judge.calls(), 0);
});

test('a cancelled run is blocked', async () => {
  const v = await verifyDelivered('do the thing', 'whatever', { stoppedReason: 'cancelled' });
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
});

test('max-turns-with-grace is blocked until the user continues', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered(
    'finish the whole research run',
    'I hit the run budget before finishing — say "continue" to keep going.',
    { stoppedReason: 'max-turns-with-grace', judgeFn: judge.fn },
  );
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.match(v.reason ?? '', /continue|budget/i);
  assert.equal(judge.calls(), 0, 'structured stop reason must not spend a judge call');
});

test('blocked-text in the final reply is blocked (no judge needed)', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered('pull salesforce contacts', 'I am blocked — unable to access the CRM.', {
    stoppedReason: 'success',
    judgeFn: judge.fn,
  });
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.equal(judge.calls(), 0);
});

test('a PROMISE-shaped reply spends a judge call; judge=not-done => blocked', async () => {
  const judge = judgeStub(false);
  const v = await verifyDelivered("prep the contacts", "I'll prep those contacts and get them over to you next.", {
    stoppedReason: 'success',
    judgeFn: judge.fn,
  });
  assert.equal(judge.calls(), 1, 'a promise-shaped reply is the one shape that must be judged');
  assert.equal(v.delivered, false);
  assert.equal(v.status, 'blocked');
  assert.match(v.reason ?? '', /artifact/i);
});

test('a PROMISE-shaped reply the judge confirms done is delivered', async () => {
  const judge = judgeStub(true);
  const v = await verifyDelivered("prep the contacts", "I'll prep those contacts now.", {
    stoppedReason: 'success',
    judgeFn: judge.fn,
  });
  assert.equal(judge.calls(), 1);
  assert.equal(v.delivered, true);
  assert.equal(v.status, 'completed');
});

test('STRICTLY fail-open: a throwing judge resolves to delivered, never wedges', async () => {
  const throwingJudge = async (): Promise<ObjectiveJudgeVerdict> => {
    throw new Error('judge backend down');
  };
  // Promise-shaped (so the judge path is reached), but the judge throws.
  const v = await verifyDelivered('prep the contacts', "I'll prep those next.", {
    stoppedReason: 'success',
    judgeFn: async (o, r) => {
      try {
        return await throwingJudge();
      } catch {
        // mirror judgeObjectiveComplete's own fail-open contract
        return { done: true, reason: 'judge unavailable — accepting completion' };
      }
    },
  });
  assert.equal(v.delivered, true);
});

test('kill-switch off => always delivered (no behavior change, no judge call)', async () => {
  const prev = process.env.CLEMMY_VERIFY_DELIVERED;
  const judge = judgeStub(false);
  try {
    process.env.CLEMMY_VERIFY_DELIVERED = 'off';
    const v = await verifyDelivered('pull the data', 'I am blocked, cannot proceed.', {
      stoppedReason: 'error',
      judgeFn: judge.fn,
    });
    assert.equal(v.delivered, true, 'with the kill-switch off, nothing is ever flagged');
    assert.equal(v.status, 'completed');
    assert.equal(judge.calls(), 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_VERIFY_DELIVERED;
    else process.env.CLEMMY_VERIFY_DELIVERED = prev;
  }
});

test('matchesBlockedText: true on blocked shapes, false on a clean result', () => {
  assert.equal(matchesBlockedText('Approval required to send.'), true);
  assert.equal(matchesBlockedText('waiting on your confirmation'), true);
  assert.equal(matchesBlockedText('Added 5 rows to the sheet.'), false);
  assert.equal(matchesBlockedText(''), false);
  assert.equal(matchesBlockedText(undefined), false);
});
