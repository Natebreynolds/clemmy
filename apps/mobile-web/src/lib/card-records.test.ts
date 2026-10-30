import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardRecordHeadline, cardRecordInMotion, cardStepLabel } from './card-records';

test('a card record names each step in plain words and says where the work stands', () => {
  assert.equal(cardStepLabel({ tool: 'OUTLOOK_UPDATE_EVENT' }), 'Updated Outlook event');
  assert.equal(cardStepLabel({ tool: 'OUTLOOK_GET_CALENDAR_VIEW', done: true }), 'Checked Outlook calendar view');
  assert.equal(cardStepLabel({ tool: 'SLACK_LIST_CONVERSATIONS', done: false }), 'Checking Slack conversations');
  assert.equal(cardStepLabel({ tool: 'GMAIL_SEND_EMAIL' }), 'Sent Gmail email');
  assert.equal(cardStepLabel({ tool: 'memory_recall' }), 'Memory recall');
  assert.equal(cardStepLabel({ tool: '' }), '');
  assert.deepEqual(cardRecordHeadline({ state: 'working', steps: [] }), { tone: 'info', text: 'Clem is working on it…' });
  assert.equal(cardRecordHeadline({ state: 'needs_you', text: 'OK?', sessionId: 'clem', asks: 'approval' }).text, 'Clem needs your OK');
  assert.equal(cardRecordHeadline({ state: 'needs_you', text: 'Which?', sessionId: 'clem', asks: 'answer' }).text, 'Clem needs one more thing');
  assert.equal(cardRecordHeadline({ state: 'done', text: 'Moved.', sessionId: 'clem' }).tone, 'done');
  assert.equal(cardRecordInMotion({ outcome: { state: 'working' } }), true);
  assert.equal(cardRecordInMotion({ outcome: { state: 'done', text: 'x', sessionId: 'clem' } }), false);
});
