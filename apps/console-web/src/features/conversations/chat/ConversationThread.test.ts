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
