import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchToolChoicesForStep, type ToolChoiceRecord } from './tool-choice-store.js';

// Supplied records only: no remembered-choice writes, home overrides, or resets.
const choice: ToolChoiceRecord = {
  intent: 'harnessorchard.harvest',
  description: 'harnessorchard harvest',
  choice: { kind: 'composio', identifier: 'WEATHER_GET' },
  fallbacks: [], body: '', filePath: '',
};

test('one learned word repeated across intent and description is not two relevance signals', () => {
  assert.deepEqual(matchToolChoicesForStep('harnessorchard', {
    choices: [choice], purpose: 'advertise',
  }), []);
});

test('two distinct learned words still retrieve a procedure without naming its provider', () => {
  const matches = matchToolChoicesForStep('harnessorchard harvest', {
    choices: [choice], purpose: 'advertise',
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].identifier, 'WEATHER_GET');
});

test('conversation grammar and a Users directory do not imply a provider task', () => {
  const records: ToolChoiceRecord[] = [
    { ...choice, intent: 'return.its', description: 'return its contents', choice: { kind: 'composio', identifier: 'OUTLOOK_GET_MESSAGE' } },
    { ...choice, intent: 'what.just', description: 'what you just did', choice: { kind: 'composio', identifier: 'OUTLOOK_GET_CALENDAR_VIEW' } },
    { ...choice, intent: 'slack.users', description: 'find users', choice: { kind: 'composio', identifier: 'SLACK_LIST_ALL_USERS' } },
    { ...choice, intent: 'slack.conversation', description: 'conversation history', choice: { kind: 'composio', identifier: 'SLACK_FETCH_CONVERSATION_HISTORY' } },
  ];
  for (const prompt of [
    'Read /Users/example/notes.txt and return its contents.',
    'What checksum did you just read? Answer only the number from our conversation.',
  ]) assert.deepEqual(matchToolChoicesForStep(prompt, { choices: records, purpose: 'advertise' }), []);
  const named = matchToolChoicesForStep('List Slack users', { choices: records, purpose: 'advertise' });
  assert(named.some((match) => match.identifier === 'SLACK_LIST_ALL_USERS'));
});

test('singular and plural variants are one learned signal; exact commands remain retrievable', () => {
  const record = { ...choice, intent: 'harvests.harvest', description: 'harvests harvest' };
  assert.deepEqual(matchToolChoicesForStep('harvests', { choices: [record], purpose: 'advertise' }), []);
  assert.equal(matchToolChoicesForStep('WEATHER_GET', { choices: [choice], purpose: 'advertise' })[0]?.identifier, 'WEATHER_GET');
});
