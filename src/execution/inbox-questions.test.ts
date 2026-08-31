import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-inbox-questions-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask,
  getBackgroundTask,
  updateBackgroundTask,
} = await import('./background-tasks.js');
const { createCheckIn, getCheckIn } = await import('../agents/check-ins.js');
const { answerExactCheckIn, answerInboxQuestion, listInboxQuestions } = await import('./inbox-questions.js');
const eventlog = await import('../runtime/harness/eventlog.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a linked check-in represents only its exact frozen task question', () => {
  const task = createBackgroundTask({
    title: 'Prepare the exact account report',
    prompt: 'Prepare the report and ask when the account is ambiguous.',
  });
  const firstQuestionId = `question:${task.id}:q1`;
  updateBackgroundTask(task.id, {
    status: 'awaiting_input',
    pendingQuestionId: firstQuestionId,
    pendingQuestion: 'Should I use the North or South account?',
    pendingQuestionOptions: ['North', 'South'],
  });
  const checkIn = createCheckIn({
    agentSlug: 'Clem',
    question: 'Should I use the North or South account?',
    linkedTaskId: task.id,
    linkedQuestionId: firstQuestionId,
  });

  const firstProjection = listInboxQuestions();
  assert.deepEqual(
    firstProjection.filter((row) => row.taskId === task.id).map((row) => row.id),
    [`checkin:${checkIn.id}`],
    'the exact linked check-in replaces only the same task/question pair',
  );
  assert.equal(firstProjection.find((row) => row.id === `checkin:${checkIn.id}`)?.answerable, true);

  const secondQuestionId = `question:${task.id}:q2`;
  updateBackgroundTask(task.id, {
    status: 'awaiting_input',
    pendingQuestionId: secondQuestionId,
    pendingQuestion: 'Should I use the current quarter or trailing twelve months?',
    pendingQuestionOptions: ['Current quarter', 'Trailing twelve months'],
  });
  const advancedProjection = listInboxQuestions().filter((row) => row.taskId === task.id);
  assert.deepEqual(advancedProjection.map((row) => row.id), [`task:${secondQuestionId}`]);
  assert.equal(
    getCheckIn(checkIn.id)?.status,
    'closed',
    'a stale Q1 is reconciled instead of remaining an unopenable Needs You row',
  );
  assert.equal(advancedProjection.find((row) => row.id === `task:${secondQuestionId}`)?.answerable, true);
});

test('answering stale Q1 cannot consume Q2; the exact Q2 answer resumes once', () => {
  const task = createBackgroundTask({
    title: 'Resume the exact durable question',
    prompt: 'Wait for one exact user answer.',
  });
  const firstQuestionId = `question:${task.id}:q1`;
  updateBackgroundTask(task.id, {
    status: 'awaiting_input',
    pendingQuestionId: firstQuestionId,
    pendingQuestion: 'Use account A or B?',
  });
  const checkIn = createCheckIn({
    agentSlug: 'Clem',
    question: 'Use account A or B?',
    linkedTaskId: task.id,
    linkedQuestionId: firstQuestionId,
  });
  const secondQuestionId = `question:${task.id}:q2`;
  updateBackgroundTask(task.id, {
    status: 'awaiting_input',
    pendingQuestionId: secondQuestionId,
    pendingQuestion: 'Use region East or West?',
  });

  const compatibilityResult = answerExactCheckIn({
    checkInId: checkIn.id,
    answer: 'Account B',
  });
  assert.equal(compatibilityResult.status, 'stale_link');
  assert.match('reason' in compatibilityResult ? compatibilityResult.reason : '', /newer question|no longer/i);

  const stale = answerInboxQuestion({
    id: `checkin:${checkIn.id}`,
    answer: 'Account B',
    requestId: 'desktop:stale-q1',
  });
  assert.equal(stale.status, 'already_resolved');
  assert.equal(getCheckIn(checkIn.id)?.status, 'closed', 'stale check-in is durably settled for audit');
  assert.equal(getBackgroundTask(task.id)?.pendingQuestionId, secondQuestionId);

  const exact = answerInboxQuestion({
    id: `task:${secondQuestionId}`,
    answer: 'West',
    requestId: 'desktop:exact-q2',
  });
  assert.equal(exact.status, 'resuming');
  assert.equal(getBackgroundTask(task.id)?.status, 'pending');
  const replay = answerInboxQuestion({
    id: `task:${secondQuestionId}`,
    answer: 'East',
    requestId: 'desktop:replay-q2',
  });
  assert.equal(replay.status, 'already_resolved');
  assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'West');
});

test('answering an exact linked check-in commits the task/question CAS before reporting resume', () => {
  const task = createBackgroundTask({
    title: 'Resume through the compatibility check-in',
    prompt: 'Wait for the exact region answer.',
  });
  const questionId = `question:${task.id}:region`;
  updateBackgroundTask(task.id, {
    status: 'awaiting_input',
    pendingQuestionId: questionId,
    pendingQuestion: 'Which exact region should receive the report?',
  });
  const checkIn = createCheckIn({
    agentSlug: 'Clem',
    question: 'Which exact region should receive the report?',
    linkedTaskId: task.id,
    linkedQuestionId: questionId,
  });

  const result = answerInboxQuestion({
    id: `checkin:${checkIn.id}`,
    answer: 'West',
    requestId: 'desktop:exact-linked-checkin',
  });
  assert.deepEqual(result, {
    status: 'resuming',
    questionId: `checkin:${checkIn.id}`,
    taskId: task.id,
  });
  assert.equal(getBackgroundTask(task.id)?.status, 'pending');
  assert.equal(getBackgroundTask(task.id)?.inputResolution?.questionId, questionId);
  assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'West');
  assert.equal(getBackgroundTask(task.id)?.lastInputResolutionRequestId, `checkin:${checkIn.id}`);
  assert.equal(getCheckIn(checkIn.id)?.status, 'answered');
});
