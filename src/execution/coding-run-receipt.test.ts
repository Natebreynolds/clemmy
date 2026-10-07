import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewCodingRunReceipt, setCodingRunJudgeForTests, type CodingRunReceipt } from './coding-run-receipt.js';

const run = { objective: 'Controlled test task', acceptance: [], branch: 'fixture', testCommand: 'controlled test',
  expectChanges: false, round: 0, maxRounds: 3 };

function timedOutReceipt(cleanup: 'complete' | 'incomplete'): CodingRunReceipt {
  return { autoCommitted: false, finalMessage: 'Controlled fixture', agentTurnOk: true,
    evidence: { commits: [], dirtyFiles: [], diffStat: { filesChanged: 0, insertions: 0, deletions: 0, files: [] } },
    test: { exitCode: null, timedOut: true, timeoutCleanup: cleanup, tail: 'Controlled timeout', durationMs: 3000 } };
}

test('unconfirmed timeout cleanup stops automatic retries and tells the user what remains', async () => {
  let judgeCalls = 0;
  setCodingRunJudgeForTests(async () => { judgeCalls++; throw new Error('No judge call is allowed for failed cleanup'); });
  try {
    const review = await reviewCodingRunReceipt(run, timedOutReceipt('incomplete'));
    assert.equal(review.next, 'done');
    assert.equal(review.verdict, 'fail');
    assert.equal(review.followUp, null);
    assert.match(review.reason, /Check and stop the remaining test processes before retrying/);
    assert.equal(judgeCalls, 0);
  } finally { setCodingRunJudgeForTests(null); }
});

test('a stopped timeout tree keeps the existing finite correction-round behavior', async () => {
  const review = await reviewCodingRunReceipt(run, timedOutReceipt('complete'));
  assert.equal(review.next, 'continue');
  assert.equal(review.verdict, 'fail');
  assert.match(review.followUp!, /Fix the cause/);
  assert.equal((await reviewCodingRunReceipt({ ...run, round: 2 }, timedOutReceipt('complete'))).next, 'done');
});
