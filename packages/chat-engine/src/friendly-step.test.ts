import assert from 'node:assert/strict';
import test from 'node:test';
import { friendlyStep } from './tool-labels.js';

test('a connected app step reads as the app and what is being done, from the label alone', () => {
  assert.deepEqual(friendlyStep('outlook get calendar view'), { app: 'Outlook', action: 'Reading calendar view', done: 'Read calendar view' });
  assert.deepEqual(friendlyStep('gmail send email'), { app: 'Gmail', action: 'Sending email', done: 'Sent email' });
  assert.deepEqual(friendlyStep('googlesheets create spreadsheet'), { app: 'Googlesheets', action: 'Creating spreadsheet', done: 'Created spreadsheet' });
  assert.deepEqual(friendlyStep('slack · search messages'), { app: 'Slack', action: 'Searching messages', done: 'Searched messages' });
});

test('a built-in step reads as what is being done', () => {
  assert.deepEqual(friendlyStep('read file'), { action: 'Reading file', done: 'Read file' });
  assert.deepEqual(friendlyStep('run shell command'), { action: 'Running shell command', done: 'Ran shell command' });
});

test('words already written for people are kept as they are', () => {
  assert.deepEqual(friendlyStep('Created a draft to Dana'), { action: 'Created a draft to Dana', done: 'Created a draft to Dana' });
  assert.deepEqual(friendlyStep('Finding the right tool…'), { action: 'Finding the right tool…', done: 'Finding the right tool…' });
  assert.deepEqual(friendlyStep('memory recall'), { action: 'Memory recall', done: 'Memory recall' });
});
