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

test('reopened file receipts retain every recorded artifact alongside workflow receipts', () => {
  const files = [{ name: 'email.html', dir: 'drafts' }, { name: 'brief.pdf', dir: 'reports' }, { name: 'brief.pdf', dir: 'other' }];
  const messages = historyToMessages([
    { role: 'user', text: 'Make the documents', createdAt: '2026-10-09T10:00:00.000Z', files },
    { role: 'assistant', text: 'Saved the documents', createdAt: '2026-10-09T10:01:00.000Z', files, workflows: [{
      slug: 'report-drafts', name: 'Report drafts', op: 'created', enabled: false,
      steps: [], changedStepIds: [], addedStepIds: [], removedStepIds: [],
    }] },
    { role: 'assistant', text: 'The prose mentions another.pdf', createdAt: '2026-10-09T10:02:00.000Z' },
  ]);
  assert.equal(messages[0]?.activity, undefined, 'file receipts belong to assistant replies');
  assert.equal(messages[2]?.activity, undefined, 'prose does not invent a file receipt');
  const activity = messages[1]?.activity;
  assert.equal(activity?.length, 2);
  assert.equal(activity?.[0]?.workflow?.slug, 'report-drafts');
  const saved = activity?.find(row => row.id === 'deliverables');
  assert.deepEqual(saved?.deliverables, files);
  assert.deepEqual(saved?.deliverable, { name: 'brief.pdf', dir: 'other' });
  assert.equal(saved?.count, 3);
  assert.equal(saved?.status, 'done');
});
