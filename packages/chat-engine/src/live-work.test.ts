import assert from 'node:assert/strict';
import test from 'node:test';
import { liveTurnText, looksLikeMachineText, stepInHand, workReceiptLine, workApps, workClock } from './live-work.js';
import type { ActivityItem } from './types.js';

const draft = (withdrawn: 'tool_call' | 'review') => ({ id: 'draft-1', base: '', phase: 'withdrawn' as const, withdrawn });

test('the sentence she wrote before a tool ran leads the work line, never the answer slot', () => {
  const said = liveTurnText({ text: 'Let me pull Mike from Salesforce first.', answerDraft: draft('tool_call') }, true);
  assert.deepEqual(said, { words: 'Let me pull Mike from Salesforce first.', showReply: false });
  const first = liveTurnText({ text: 'Looking at your calendar.' }, true);
  assert.deepEqual(first, { words: 'Looking at your calendar.', showReply: false });
});

test('a draft that is the tool call itself is never shown, as words or as an answer', () => {
  for (const text of [
    '{"requirement_id":"cap:local:run_shell_command:ordinary","name":"run_shell_command","args_json":"{\\"command\\":\\"sf data query\\"}"}',
    '[{"Id":"003Rj000002c0XLIAY","Name":"Mike"}]',
    '"tool_slug": "OUTLOOK_SEARCH_MESSAGES", "arguments": {"query": "slide 7"}',
    'Calling it now: {"tool_slug":"OUTLOOK_SEARCH_MESSAGES","arguments":{"query":"slide 7"}}',
  ]) {
    assert.equal(looksLikeMachineText(text), true, text);
    assert.deepEqual(liveTurnText({ text, answerDraft: draft('tool_call') }, true), { words: '', showReply: false }, text);
    assert.deepEqual(liveTurnText({ text }, true), { words: '', showReply: false }, text);
  }
});

test('an answer is an answer: long streaming text, a draft under review, and the delivered reply all show', () => {
  const long = 'Here is what I found. '.repeat(20);
  assert.deepEqual(liveTurnText({ text: long }, true), { words: '', showReply: true });
  assert.deepEqual(liveTurnText({ text: 'Mike works at Litman Law.', answerDraft: draft('review') }, true), { words: '', showReply: true });
  assert.deepEqual(liveTurnText({ text: 'Mike works at Litman Law.' }, false), { words: '', showReply: true });
  // A delivered reply that quotes JSON is still the answer.
  assert.deepEqual(liveTurnText({ text: '{"ok": true}' }, false), { words: '', showReply: true });
  assert.equal(looksLikeMachineText('Sent the draft to Mike — "Great catching up" — at 3 pm.'), false);
});

const row = (label: string, status: ActivityItem['status'], extra: Partial<ActivityItem> = {}): ActivityItem => ({
  id: label, kind: 'tool', label, status, ...extra,
});

test('the card holds the step in the owner\'s app over the lookups that got there', () => {
  const rows = [
    row('outlook search messages', 'done', { startedAt: 1_000, finishedAt: 4_000 }),
    row('recall memory', 'running', { startedAt: 4_000 }),
  ];
  assert.equal(stepInHand(rows)?.label, 'outlook search messages');
  assert.equal(stepInHand([...rows, row('outlook create draft', 'running', { effect: 'external_write' })])?.label, 'outlook create draft');
  assert.equal(stepInHand([row('recall memory', 'running')])?.label, 'recall memory');
  assert.equal(stepInHand([]), undefined);
});

test('done folds to one receipt line that names one or two steps and leads with any trouble', () => {
  const two = [row('outlook get calendar view', 'done'), row('outlook create draft', 'done')];
  assert.equal(workReceiptLine('completed', 18_000, two), 'Worked 18s · read calendar view · created draft');
  const many = [...two, row('slack send message', 'done')];
  assert.equal(workReceiptLine('completed', 72_000, many), 'Worked 1m 12s · 3 steps');
  assert.equal(workReceiptLine('failed', 5_000, many), 'Ran into trouble · worked 5s · 3 steps');
  assert.deepEqual(workApps(many), ['Outlook', 'Slack']);
  assert.equal(workClock(1_000, 68_000), '1:07');
});
