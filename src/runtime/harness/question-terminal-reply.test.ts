/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/question-terminal-reply.test.ts
 *
 * A question terminal shows the whole of what the model said when it answered
 * first and asked last; the card's question stays the only text otherwise.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { questionTerminalReply } = await import('./loop.js');

test('a reply that ends on the card question is shown whole', () => {
  const question = 'Which firm are you meeting?';
  const reply = `## What is working\n\nSlide 2 is the deck.\n\n${question}`;
  assert.equal(questionTerminalReply({ question, reply, summary: '' }), reply);
});

test('any other shape keeps the card question as the only safe text', () => {
  const question = 'Which firm are you meeting?';
  assert.equal(questionTerminalReply({ question, reply: question, summary: '' }), question);
  assert.equal(questionTerminalReply({ question, reply: 'An unrelated completed-tagged reply.', summary: 'x' }), question);
  assert.equal(questionTerminalReply({ question: '', reply: 'The reply alone.', summary: 'x' }), 'The reply alone.');
  assert.equal(questionTerminalReply({ question: '', reply: '', summary: 'A summary.' }), 'A summary.');
  assert.equal(questionTerminalReply({ question: '', reply: '', summary: '' }), 'I need your input before I can continue.');
});
