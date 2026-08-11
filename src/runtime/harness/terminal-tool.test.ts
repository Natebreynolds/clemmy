import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTerminalToolName,
  terminalToolShouldHalt,
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

test('a successful durable control receipt settles the foreground request on every lane', () => {
  // Live 2026-08-10, sess-msmo2312-e8aad2da (Codex gpt-5.6-sol): "How's it
  // going?" → one correct status read → one good answer → the harness treated
  // the still-running CHILD task as unfinished FOREGROUND work. 58 status
  // calls, 40 conversation steps, 95 model calls, 3.36M tokens, no delivered
  // completion. A revision receipt was discarded the same way.
  //
  // Both lanes read this one set (orchestrator.ts = Codex,
  // claude-agent-sdk.ts = Claude), so these assertions are lane-agnostic by
  // construction rather than by duplication.
  for (const receipt of [
    'background_task_status',
    'background_task_revise',
    'background_task_cancel',
    'dispatch_background_task',
  ]) {
    assert.equal(isTerminalToolName(receipt), true, `${receipt} must settle the request that invoked it`);
    assert.equal(
      terminalToolShouldHalt(receipt, '{"ok":true,"taskId":"bg-x","status":"running"}'),
      true,
      `${receipt} succeeded — the parent request is answered even though the child runs on`,
    );
    // MCP-namespaced transport must not change the semantics.
    assert.equal(isTerminalToolName(`server__${receipt}`), true);
  }

  // A FAILED control action is an ordinary typed tool failure and belongs back
  // in the model loop — halting there would strand the user with no answer and
  // nothing running.
  assert.equal(
    terminalToolShouldHalt('background_task_revise', '{"ok":false,"error":"task not found"}'),
    false,
    'a failed revision must not settle the request',
  );
  assert.equal(
    terminalToolShouldHalt('dispatch_background_task', 'Tool call refused by harness: guardrail block'),
    false,
    'a refused dispatch must not settle the request',
  );
  assert.equal(
    terminalToolShouldHalt('background_task_status', '[provider-dispatch:not-started:invalid-args] bad args'),
    false,
    'a pre-dispatch refusal must not settle the request',
  );
});
