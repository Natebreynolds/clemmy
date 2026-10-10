import assert from 'node:assert/strict';
import test from 'node:test';
import { liveTurnText, looksLikeMachineText, stepInHand, workReceiptLine, workApps, workClock } from './live-work.js';
import type { ActivityItem } from './types.js';

const draft = (withdrawn: 'tool_call' | 'review') => ({ id: 'draft-1', base: '', phase: 'withdrawn' as const, withdrawn });

test('the sentence she wrote before a tool ran leads the work line, never the answer slot', () => {
  const said = liveTurnText({ text: 'Let me pull the contact from the CRM first.', answerDraft: draft('tool_call') }, true);
  assert.deepEqual(said, { words: 'Let me pull the contact from the CRM first.', showReply: false });
  const first = liveTurnText({ text: 'Looking at your calendar.' }, true);
  assert.deepEqual(first, { words: 'Looking at your calendar.', showReply: false });
});

test('a draft that is the tool call itself is never shown, as words or as an answer', () => {
  for (const text of [
    '{"requirement_id":"cap:local:run_shell_command:ordinary","name":"run_shell_command","args_json":"{\\"command\\":\\"sf data query\\"}"}',
    '[{"Id":"record-1","Name":"Example"}]',
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
  assert.deepEqual(liveTurnText({ text: 'The contact works at Example Law.', answerDraft: draft('review') }, true), { words: '', showReply: true });
  assert.deepEqual(liveTurnText({ text: 'The contact works at Example Law.' }, false), { words: '', showReply: true });
  // A delivered reply that quotes JSON is still the answer.
  assert.deepEqual(liveTurnText({ text: '{"ok": true}' }, false), { words: '', showReply: true });
  assert.equal(looksLikeMachineText('Sent the draft to the contact — "Great catching up" — at 3 pm.'), false);
});

const row = (label: string, status: ActivityItem['status'], extra: Partial<ActivityItem> = {}): ActivityItem => ({
  id: label, kind: 'tool', label, status, ...extra,
});

test('the card holds the step in the owner\'s app over the lookups that got there', () => {
  const rows = [
    row('outlook search messages', 'done', { startedAt: 1_000, finishedAt: 4_000, fromApp: true }),
    row('recall memory', 'running', { startedAt: 4_000 }),
  ];
  assert.equal(stepInHand(rows)?.label, 'outlook search messages');
  assert.equal(stepInHand([...rows, row('outlook create draft', 'running', { effect: 'external_write', fromApp: true })])?.label, 'outlook create draft');
  // A built-in tool named noun-first is not an app, so it does not take the card.
  assert.equal(stepInHand([row('file query', 'done'), row('outlook search messages', 'done', { fromApp: true }), row('skill read', 'done')])?.label,
    'outlook search messages');
  assert.equal(stepInHand([row('recall memory', 'running')])?.label, 'recall memory');
  assert.equal(stepInHand([]), undefined);
});

test('done folds to one receipt line that names one or two steps and leads with any trouble', () => {
  const two = [row('outlook get calendar view', 'done', { fromApp: true }), row('outlook create draft', 'done', { fromApp: true })];
  assert.equal(workReceiptLine('completed', 18_000, two), 'Worked 18s · read calendar view · created draft');
  const many = [...two, row('slack send message', 'done', { fromApp: true })];
  assert.equal(workReceiptLine('completed', 72_000, many), 'Worked 1m 12s · 3 steps');
  assert.equal(workReceiptLine('failed', 5_000, many), 'Ran into trouble · worked 5s · 3 steps');
  assert.deepEqual(workApps(many), ['Outlook', 'Slack']);
  assert.equal(workClock(1_000, 68_000), '1:07');
});

test('built-in tools read as actions, never as apps called File or Work', () => {
  assert.equal(workReceiptLine('completed', 9_000, [row('file query', 'done'), row('skill read', 'done')]),
    'Worked 9s · searched file · read skill');
  assert.deepEqual(workApps([row('file query', 'done'), row('run shell command', 'done'), row('outlook search messages', 'done', { fromApp: true })]),
    ['Outlook']);
});

test('a reopened turn keeps its real duration: steps are stamped with their own event times', async () => {
  const { foldTranscript } = await import('./engine.js');
  const t0 = Date.parse('2026-10-10T15:38:47Z');
  const sessionId = 'sess-replay-clock';
  const events = [
    { seq: 1, sessionId, type: 'user_input_received', role: 'user', createdAt: t0, data: { text: 'Draft an email to the contact.' } },
    { seq: 2, sessionId, type: 'tool_called', createdAt: t0 + 4_000, data: { sourceUserSeq: 1, tool: 'work_call', innerTool: 'run_shell_command', callId: 'c1' } },
    { seq: 3, sessionId, type: 'tool_returned', createdAt: t0 + 9_000, data: { sourceUserSeq: 1, tool: 'work_call', callId: 'c1', ok: true } },
    { seq: 4, sessionId, type: 'tool_called', createdAt: t0 + 60_000, data: { sourceUserSeq: 1, tool: 'work_call', publicSlug: 'OUTLOOK_CREATE_DRAFT', callId: 'c2' } },
    { seq: 5, sessionId, type: 'tool_returned', createdAt: t0 + 125_000, data: { sourceUserSeq: 1, tool: 'work_call', callId: 'c2', ok: true } },
    { seq: 6, sessionId, type: 'conversation_completed', createdAt: t0 + 126_000, data: { sourceUserSeq: 1, reply: 'Done.' } },
  ];
  const reply = foldTranscript(events as never, sessionId).find((message) => message.role === 'assistant');
  const steps = (reply?.activity ?? []).filter((item) => item.kind === 'tool');
  assert.deepEqual(steps.map((item) => [item.label, item.fromApp === true, item.startedAt, item.finishedAt]), [
    ['run shell command', false, t0 + 4_000, t0 + 9_000],
    ['outlook create draft', true, t0 + 60_000, t0 + 125_000],
  ]);
  assert.equal(workReceiptLine('completed', 121_000, steps), 'Worked 2m 1s · ran shell command · created draft');
});
