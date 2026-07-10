import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX,
  formatAutoResolvedAskUserQuestionOutput,
  terminalToolShouldHalt,
} from './terminal-tool.js';

test('ask_user_question is non-terminal only with the exact auto-resolved prefix', () => {
  const output = formatAutoResolvedAskUserQuestionOutput('Proceed with the approved default.');
  assert.equal(terminalToolShouldHalt('ask_user_question', output), false);
  assert.equal(terminalToolShouldHalt('mcp__clementine-local__ask_user_question', output), false);

  assert.equal(terminalToolShouldHalt('ask_user_question', ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX), true);
  assert.equal(terminalToolShouldHalt('ask_user_question', `receipt: ${output}`), true);
});

test('clarification text cannot accidentally trigger the non-terminal path', () => {
  for (const phrase of ['standing approval', 'NOT pausing', 'not waiting']) {
    const output = `Question posted: What does "${phrase}" mean here? Awaiting user reply.`;
    assert.equal(terminalToolShouldHalt('ask_user_question', output), true, phrase);
  }
});
