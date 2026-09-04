/** Run: npx tsx --test src/runtime/harness/current-task-authority.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCurrentTaskInput,
  currentInputExplicitlyResumesPriorTask,
  currentInputSuppressesPriorTask,
} from './current-task-authority.js';
import { snapshotFromAcceptedSource } from '../semantic-boundary/prepare-accepted-source.js';

test('fresh and pivot language deterministically outranks stale continuation', () => {
  for (const input of [
    'Brand-new prospects from scratch. Run the full workflow.',
    'Use a fresh batch please.',
    'This is a different workflow.',
    'Start over with another task.',
    'Continue, but make this a brand-new run.',
  ]) {
    assert.equal(classifyCurrentTaskInput(input), 'fresh', input);
    assert.equal(currentInputSuppressesPriorTask(input), true, input);
  }
});

test('only explicit continuation language opts into prior work', () => {
  for (const input of [
    'continue',
    'Resume the workflow.',
    'Pick this back up.',
    'Keep going with the task.',
    'Start where we left off.',
  ]) {
    assert.equal(classifyCurrentTaskInput(input), 'resume', input);
    assert.equal(currentInputExplicitlyResumesPriorTask(input), true, input);
  }
  assert.equal(classifyCurrentTaskInput('Find five prospects and draft the emails.'), 'unspecified');
});

test('checked accepted-source relation outranks wording when available', () => {
  assert.equal(classifyCurrentTaskInput('Please handle these records.', 'new_goal'), 'fresh');
  assert.equal(classifyCurrentTaskInput('Use the value Acme.', 'answer_open_slot'), 'resume');
  assert.equal(classifyCurrentTaskInput('Continue, but this is brand-new from scratch.', 'answer_open_slot'), 'fresh');
});

test('semantic host snapshot withholds an old open workflow slot on an explicit fresh request', () => {
  const oldPacket = {
    kind: 'clarification' as const,
    question: 'Continue the Tyler batch or use the disabled workflow?',
    options: ['Continue Tyler', 'Use workflow'],
    originatingSourceUserSeq: 41,
    goalId: 'goal:old-tyler',
    revision: 3,
    questionId: 'question:old-tyler',
    slotKey: 'prospect-source',
  };
  const base = {
    sessionId: 'current-task-authority-session',
    sourceUserSeq: 42,
    audienceKey: 'audience',
    userId: 'user',
    conversationKey: 'conversation',
    policyRevision: 'policy-v1',
    packet: oldPacket,
  };

  const fresh = snapshotFromAcceptedSource({
    ...base,
    acceptedText: 'Brand-new prospects from scratch. Run the whole thing.',
  });
  assert.deepEqual(fresh.resumableGoals, []);
  assert.deepEqual(fresh.openQuestions, []);

  const resumed = snapshotFromAcceptedSource({
    ...base,
    acceptedText: 'Resume the workflow.',
  });
  assert.equal(resumed.resumableGoals?.[0]?.goalId, 'goal:old-tyler');
  assert.equal(resumed.openQuestions?.[0]?.questionId, 'question:old-tyler');
});
