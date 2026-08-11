import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyBackgroundInputReply } from './background-input-reply.js';

test('background reply classifier resumes only a bounded answer to the exact question', () => {
  const pause = {
    question: 'Choose the deployment target.',
    options: ['Staging', 'Production'],
  };
  assert.deepEqual(classifyBackgroundInputReply({ message: 'Production', ...pause }), {
    kind: 'resume',
    classification: { disposition: 'selected', selectedOption: 'Production' },
  });
  assert.deepEqual(classifyBackgroundInputReply({ message: '2', ...pause }), {
    kind: 'resume',
    classification: { disposition: 'selected', selectedOption: 'Production' },
  });
});

test('background reply classifier leaves declines, compounds, questions, and unrelated asks in chat', () => {
  const pause = {
    question: 'Should I send the client update?',
    options: ['Yes', 'No'],
  };
  assert.equal(classifyBackgroundInputReply({ message: 'No.', ...pause }).kind, 'declined');
  for (const message of [
    'No, but send it to Alice instead',
    'No—leave that task alone. Instead, what is 15 × 9?',
    'Why would we send that?',
    'What should we improve in Clem next?',
  ]) {
    assert.deepEqual(classifyBackgroundInputReply({ message, ...pause }), { kind: 'fresh_turn' });
  }
});

test('background reply classifier accepts confirmation only when the question invites it', () => {
  assert.equal(classifyBackgroundInputReply({
    message: 'Yes.',
    question: 'Should I send the client update?',
    options: ['Yes', 'No'],
  }).kind, 'resume');
  assert.deepEqual(classifyBackgroundInputReply({
    message: 'Yes.',
    question: 'Which deployment target should I use?',
    options: ['Staging', 'Production'],
  }), { kind: 'fresh_turn' });
});
