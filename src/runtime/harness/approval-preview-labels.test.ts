/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-preview-labels.test.ts
 *
 * Live 2026-09-25: an approval read "users UC0806VCJ"; the record Clem had
 * looked up named the person. Candidates come from the records that carry the
 * exact value; Jev picks (see host-turn-runner.test.ts for the wired pin).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { labelAskedOnce, labelCandidatesFor, type ApprovalLabelMemo } from './approval-preview-labels.js';

test('candidates are the strings of the records that carry the exact id, most repeated first, without URLs', () => {
  const directory = { data: { members: [{
    id: 'U0FIXTURE1', name: 'sam', real_name: 'Sam Rivera', tz: 'America/Los_Angeles',
    profile: { title: 'Recruiter', image: 'https://example.test/sam.png' },
  }, { id: 'U0OTHER', real_name: 'Someone Else' }] } };
  const messages = { messages: { matches: [
    { user: 'U0FIXTURE1', username: 'sam', text: 'see you at 4:15', permalink: 'https://example.test/p/1' },
    { user: 'U0FIXTURE1', username: 'sam', text: 'running late' },
  ] } };
  const candidates = labelCandidatesFor([directory, messages], 'U0FIXTURE1');
  assert.equal(candidates[0], 'sam', 'the name every record agrees on comes first');
  for (const expected of ['Sam Rivera', 'Recruiter', 'see you at 4:15']) assert.ok(candidates.includes(expected), expected);
  assert.ok(!candidates.includes('U0FIXTURE1'), 'the id is not its own name');
  assert.ok(!candidates.includes('Someone Else'), 'another record is not a candidate');
  assert.ok(!candidates.some((text) => text.includes('://')), 'a URL is never a name');
  assert.deepEqual(labelCandidatesFor([directory], 'U0NOWHERE'), []);
});

test('the members of one approval batch ask an identical label question once', async () => {
  // Live 2026-09-28 (source 325147): nine prepared events carried the same
  // identifier beside the same results, and the same question was asked nine
  // times for nine identical answers.
  const memo: ApprovalLabelMemo = new Map();
  const question = { operation: 'Create calendar event', field: 'owner', value: 'U0FIXTURE1', candidates: ['sam', 'Sam Rivera'] };
  let asks = 0;
  const ask = async (): Promise<string | null> => { asks += 1; return 'Sam Rivera'; };
  const answers = await Promise.all(Array.from({ length: 9 }, () => labelAskedOnce(memo, { ...question, candidates: [...question.candidates] }, ask)));
  assert.deepEqual(answers, Array(9).fill('Sam Rivera'));
  assert.equal(asks, 1, 'members asked together share one ask');
  await labelAskedOnce(memo, { ...question, value: 'U0OTHER' }, ask);
  await labelAskedOnce(memo, { ...question, candidates: ['Sam Rivera', 'sam'] }, ask);
  await labelAskedOnce(memo, { ...question, field: 'recipient' }, ask);
  assert.equal(asks, 4, 'a different value, candidate order or field is a different question');
  await labelAskedOnce(undefined, question, ask);
  await labelAskedOnce(new Map(), question, ask);
  assert.equal(asks, 6, 'no memo, or another batch, asks again');
});

test('a label ask that fails answers no name for every member that shared it', async () => {
  const memo: ApprovalLabelMemo = new Map();
  const question = { operation: 'Send message', field: 'recipient', value: 'U0FIXTURE1', candidates: ['sam'] };
  let asks = 0;
  const failing = async (): Promise<string | null> => { asks += 1; throw new Error('router unavailable'); };
  assert.deepEqual(await Promise.all([labelAskedOnce(memo, question, failing), labelAskedOnce(memo, question, failing)]), [null, null]);
  assert.equal(asks, 1);
});
