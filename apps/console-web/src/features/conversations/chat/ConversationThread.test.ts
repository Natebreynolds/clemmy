import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalNoticeLine, terminalStatusPill } from '@clem/chat-engine';
import { historyToMessages } from './conversation-history';
import { voiceReadableText } from '../../../lib/voice-turns';

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

// Reopened desktop history used to be text only, so the app's Stop line came
// back as a finished reply in Clem's place, with no pill and nothing kept.
test('a reopened Stop draws its pill with what was kept, never a reply, and stays out of live voice history', () => {
  const [stopped] = historyToMessages([{
    role: 'assistant',
    text: 'Stopped. Nothing further runs for this turn.',
    createdAt: '2026-10-12T12:00:00.000Z',
    terminal: {
      presentation: { status: 'cancelled', kind: 'answer' },
      turnOutcome: { status: 'cancelled', resumable: true },
      retained: { results: 2, outsideChange: 'none' },
      notice: { code: 'stopped' },
    },
  }]);
  assert.equal(stopped?.text, '');
  assert.equal(stopped?.status, 'stopped');
  assert.deepEqual(stopped?.terminal?.notice, { code: 'stopped' });
  assert.equal(terminalNoticeLine(stopped?.terminal), null, 'a chosen stop is the pill alone');
  assert.equal(terminalStatusPill(stopped?.terminal, { wordless: true })?.label, 'Cancelled · 2 results kept');
  assert.equal(voiceReadableText(stopped!), '', 'nothing for live voice to take as Clem’s');
});

test('a reopened reply keeps its review ruling, and a draft held for its format keeps her words beside the notice', () => {
  const [held, reviewed] = historyToMessages([
    {
      role: 'assistant',
      text: 'Here is the object, though one office may be missing.',
      createdAt: '2026-10-12T12:00:00.000Z',
      terminal: {
        presentation: { status: 'blocked', kind: 'answer' },
        turnOutcome: { status: 'blocked', resumable: true },
        review: 'rejected',
        reviewNote: 'The total omits one office.',
        notice: { code: 'response_format_unmet' },
      },
    },
    {
      role: 'assistant',
      text: 'I wrote alpha, beta and gamma.',
      createdAt: '2026-10-12T12:01:00.000Z',
      terminal: { presentation: { status: 'done', kind: 'answer' }, turnOutcome: { status: 'done' }, review: 'unchecked' },
    },
  ]);
  assert.equal(held?.text, 'Here is the object, though one office may be missing.');
  assert.equal(held?.status, 'failed');
  assert.equal(held?.terminal?.review, 'rejected');
  assert.equal(held?.terminal?.reviewNote, 'The total omits one office.');
  assert.ok(terminalNoticeLine(held?.terminal), 'the notice line is drawn beside her words');
  assert.equal(voiceReadableText(held!), 'Here is the object, though one office may be missing.');
  assert.equal(reviewed?.status, 'complete');
  assert.equal(reviewed?.terminal?.review, 'unchecked');
});

test('a reply from an older Mac with no typed terminal reopens as plain text', () => {
  const [plain] = historyToMessages([{ role: 'assistant', text: 'Two meetings today.', createdAt: '2026-10-12T12:00:00.000Z' }]);
  assert.equal(plain?.text, 'Two meetings today.');
  assert.equal(plain?.status, 'complete');
  assert.equal(plain?.terminal, undefined);
});
