import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUDGE_MEMORY_MAX_CHARS, _resetJudgeMemoryForTest, judgeMemoryFor, judgeMemoryView, rememberTurnMemoryForJudges } from './judge-memory.js';

const PRIMER = [
  '[MEMORY PRIMER]',
  'A local FTS5 plus semantic rerank memory search ran for the latest user message before this model call.',
  '',
  '[VAULT] Q3 planning notes: budget frozen until October.',
  '',
  '[REMEMBERED FACTS — durable, user-stated or curated; treat as known]',
  '- The owner prefers replies under 100 words.',
  '- Invoices go to accounting@example.test.',
].join('\n');

test('the checks see the remembered facts first, without the primer preamble', () => {
  const view = judgeMemoryView(PRIMER);
  assert.ok(view.startsWith('[REMEMBERED FACTS'), view);
  assert.match(view, /prefers replies under 100 words/);
  assert.match(view, /Q3 planning notes/);
  assert.doesNotMatch(view, /memory search ran/);
  assert.ok(judgeMemoryView('x'.repeat(5_000)).length <= JUDGE_MEMORY_MAX_CHARS);
});

test('memory is remembered per session and an empty primer forgets it', () => {
  _resetJudgeMemoryForTest();
  rememberTurnMemoryForJudges('sess-a', PRIMER);
  assert.match(judgeMemoryFor('sess-a'), /accounting@example.test/);
  assert.equal(judgeMemoryFor('sess-b'), '');
  rememberTurnMemoryForJudges('sess-a', '');
  assert.equal(judgeMemoryFor('sess-a'), '');
  assert.equal(judgeMemoryFor(undefined), '');
});
