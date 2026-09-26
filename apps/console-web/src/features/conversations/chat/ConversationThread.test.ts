import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyToMessages } from './conversation-history';

test('reopened pending plans retain exact proposal identity and actionable status', () => {
  const messages = historyToMessages([
    {
      role: 'assistant',
      text: 'Review plan A',
      createdAt: '2026-08-30T12:00:00.000Z',
      planProposalId: 'plan-a1b2c3d4',
    },
    {
      role: 'assistant',
      text: 'Review plan B',
      createdAt: '2026-08-30T12:01:00.000Z',
      planProposalId: 'plan-b1c2d3e4',
    },
  ]);

  assert.deepEqual(messages.map((message) => ({
    status: message.status,
    planProposalId: message.planProposalId,
  })), [
    { status: 'awaiting-plan', planProposalId: 'plan-a1b2c3d4' },
    { status: 'awaiting-plan', planProposalId: 'plan-b1c2d3e4' },
  ]);
});

test('a reopened conversation keeps who answered each exchange and draws the switch where it happened', async () => {
  const { agentThreadMarks } = await import('@clem/chat-engine');
  const messages = historyToMessages([
    { role: 'user', text: 'plain', createdAt: '2026-09-26T10:00:00.000Z', agentName: null },
    { role: 'assistant', text: 'answer', createdAt: '2026-09-26T10:00:05.000Z', agentName: null },
    { role: 'user', text: 'draft posts', createdAt: '2026-09-26T10:01:00.000Z', agentName: 'Instagram Manager' },
    { role: 'assistant', text: 'drafts', createdAt: '2026-09-26T10:01:30.000Z', agentName: 'Instagram Manager' },
    { role: 'user', text: 'older turn', createdAt: '2026-09-26T10:02:00.000Z' },
  ]);
  assert.deepEqual(messages.map((m) => m.agentName), [null, null, 'Instagram Manager', 'Instagram Manager', undefined]);
  assert.equal(Object.prototype.hasOwnProperty.call(messages[4], 'agentName'), false);
  const marks = agentThreadMarks(messages, null);
  assert.deepEqual(marks.map((m) => m.switchedTo?.name), [undefined, undefined, 'Instagram Manager', undefined, undefined]);
  assert.equal(marks[3].speaker, 'Instagram Manager');
});
