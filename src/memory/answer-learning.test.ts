/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/answer-learning.test.ts
 *
 * An answer to Clem's question reaches memory with the question it answered:
 * the memory model keeps one standalone sentence when the answer settles
 * something lasting, nothing when it only fills in this request, once per
 * question, and never for a turn the owner kept out of memory.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-answer-learning-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.EMBEDDINGS_DISABLED = 'true';
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const { resetMemoryDb } = await import('./db.js');
const { searchFactsByText } = await import('./facts.js');
const { appendEvent, createSession, getSession } = await import('../runtime/harness/eventlog.js');
const { answerMemoryRequest, learnFromAnswer, parseAnswerMemory, _resetAnswerLearningForTests, _setAnswerMemoryModelForTests } =
  await import('./answer-learning.js');

beforeEach(() => { resetMemoryDb(); _resetAnswerLearningForTests(); _setAnswerMemoryModelForTests(null); });

function ownerAnswer(sessionId: string, text: string, data: Record<string, unknown> = {}): number {
  if (!getSession(sessionId)) createSession({ id: sessionId, kind: 'chat' });
  return appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text, ...data } }).seq;
}

const question = {
  question: 'There are two TEST FIXTURE pantry lists. Which one should I add oranges to?',
  options: ['The Kitchen folder list: milk, eggs', 'The Home folder list: apples, bread', 'Both lists'],
};

test('a pick that settles which of several things is the owner\'s is kept as a sentence that stands without the question', async () => {
  const asked: string[] = [];
  _setAnswerMemoryModelForTests(async (request) => {
    asked.push(request);
    return '{"memory": "The owner\'s TEST FIXTURE pantry list is the one in the Home folder."}';
  });
  const sessionId = 'answer-pick';
  const seq = ownerAnswer(sessionId, 'The Home folder list: apples, bread');
  const answered = { sessionId, sourceUserSeq: seq, questionId: 'q-1', ...question,
    answer: 'The Home folder list: apples, bread', chosen: 'The Home folder list: apples, bread' };
  await learnFromAnswer(answered);
  assert.equal(asked.length, 1);
  const request = JSON.parse(asked[0]!) as Record<string, unknown>;
  assert.equal(request.question, question.question, 'the model reads the question the answer belongs to');
  assert.deepEqual(request.choices, question.options);
  assert.equal(request.chosen, 'The Home folder list: apples, bread');
  const kept = searchFactsByText('pantry list Home folder', 5);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.kind, 'user');
  // Once per question: a retried answer asks nothing new.
  await learnFromAnswer(answered);
  assert.equal(asked.length, 1);
});

test('an answer that only fills in this request keeps nothing', async () => {
  let asked = 0;
  _setAnswerMemoryModelForTests(async () => { asked += 1; return '{"memory": null}'; });
  const sessionId = 'answer-one-off';
  const seq = ownerAnswer(sessionId, 'Last 7 days');
  await learnFromAnswer({ sessionId, sourceUserSeq: seq, questionId: 'q-2', question: 'Which time window should the TEST FIXTURE report cover?',
    options: ['Last 7 days', 'Last 30 days'], answer: 'Last 7 days', chosen: 'Last 7 days' });
  assert.equal(asked, 1);
  assert.equal(searchFactsByText('TEST FIXTURE report window', 5).length, 0);
});

test('a turn kept out of memory, or one whose source cannot be read, asks the memory model nothing', async () => {
  let asked = 0;
  _setAnswerMemoryModelForTests(async () => { asked += 1; return '{"memory": "The owner\'s TEST FIXTURE list is the Home one."}'; });
  const sessionId = 'answer-excluded';
  const seq = ownerAnswer(sessionId, 'The Home folder list', { learningPolicy: { version: 1, mode: 'exclude', reason: 'owner_opt_out' } });
  await learnFromAnswer({ sessionId, sourceUserSeq: seq, questionId: 'q-3', ...question, answer: 'The Home folder list' });
  await learnFromAnswer({ sessionId: 'answer-missing-source', sourceUserSeq: 99, questionId: 'q-4', ...question, answer: 'The Home folder list' });
  assert.equal(asked, 0);
});

test('the reply contract: one bounded sentence or null; anything else is refused', () => {
  assert.equal(parseAnswerMemory('{"memory": "  The owner\'s list is   the Home one. "}'), 'The owner\'s list is the Home one.');
  assert.equal(parseAnswerMemory('{"memory": null}'), null);
  assert.equal(parseAnswerMemory(`{"memory": "${'x'.repeat(241)}"}`), null);
  assert.throws(() => parseAnswerMemory('{"memory": 3}'));
  assert.throws(() => parseAnswerMemory('[]'));
  const request = JSON.parse(answerMemoryRequest({ sessionId: 's', sourceUserSeq: 1, questionId: 'q', ...question, answer: 'x' }));
  assert.equal('chosen' in request, false, 'an answer in the owner\'s own words names no choice');
});
