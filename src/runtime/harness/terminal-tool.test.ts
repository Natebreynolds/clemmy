import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTerminalToolName,
  terminalToolShouldHalt,
  ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX,
  formatAutoResolvedAskUserQuestionOutput,
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
  // Live 2026-08-10, session-fixture-terminal-control (Codex gpt-5.6-sol): "How's it
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

test('background status terminality is relative to durable foreground action authority', () => {
  const receipt = '{"ok":true,"taskId":"bg-stale","status":"awaiting_input"}';
  assert.equal(
    terminalToolShouldHalt('background_task_status', receipt),
    true,
    'a status/review request is answered by one successful status receipt',
  );
  assert.equal(
    terminalToolShouldHalt('background_task_status', receipt, { actionExpectedWork: true }),
    false,
    'inside an accepted action, status is reconciliation evidence rather than completion',
  );
  assert.equal(
    terminalToolShouldHalt('background_task_revise', receipt, { actionExpectedWork: true }),
    true,
    'the exception is deliberately status-only',
  );
});

// Stage 8 (status fast path): the Codex lane consumes the same control
// receipts the Claude lane already does — the 58-status-call incident WAS on
// Codex (live 2026-08-10: "How's it going?" → good answer produced → harness
// re-invoked 39 more model steps, 3.36M tokens, nothing delivered).
test('a successful control receipt formats a machine-readable final output that parses to a completed decision', async () => {
  const { formatControlReceiptFinalOutput, parseControlReceiptFinalOutput, renderTerminalToolReply } = await import('./terminal-tool.js');
  const { toOrchestratorDecision } = await import('./loop.js');
  const statusText = 'Task bg-123 is running: 7 of 12 records analyzed, none failed.';
  const finalOutput = formatControlReceiptFinalOutput(renderTerminalToolReply('background_task_status', null, statusText));
  assert.equal(parseControlReceiptFinalOutput(finalOutput), statusText);
  const decision = toOrchestratorDecision(finalOutput);
  assert.ok(decision, 'the receipt parses as a decision, never prose/stall parsing');
  assert.equal(decision!.done, true);
  assert.equal(decision!.nextAction, 'completed');
  assert.equal(decision!.reply, statusText);
});

test('the orchestrator halt hook ends the turn on a successful background control receipt', async () => {
  const { userChoiceToolUseBehavior } = await import('../../agents/orchestrator.js');
  const halted = await userChoiceToolUseBehavior({}, [
    {
      type: 'function_output',
      tool: { name: 'background_task_status' },
      output: 'Task bg-123 is running: 7 of 12 records analyzed.',
    },
  ] as never);
  assert.equal(halted.isFinalOutput, true, 'a successful status read settles the request');
  assert.match(String((halted as { finalOutput?: unknown }).finalOutput ?? ''), /^\[clementine:control-receipt:final\]\n/);
  const notHalted = await userChoiceToolUseBehavior({}, [
    {
      type: 'function_output',
      tool: { name: 'background_task_status' },
      output: '{"ok":false,"error":"task not found"}',
    },
  ] as never);
  assert.equal(notHalted.isFinalOutput, false, 'a failed control read returns to the model loop');

  const actionStatus = await userChoiceToolUseBehavior({}, [
    {
      type: 'function_output',
      tool: { name: 'background_task_status' },
      output: 'Task bg-stale is awaiting input.',
    },
  ] as never, { actionExpectedWork: true });
  assert.equal(
    actionStatus.isFinalOutput,
    false,
    'Codex keeps an accepted action alive after reconciling stale background status',
  );
});

test('a real question has a distinct resumable final-output contract', async () => {
  const {
    formatAwaitingUserInputFinalOutput,
    parseAwaitingUserInputFinalOutput,
    parseControlReceiptFinalOutput,
  } = await import('./terminal-tool.js');
  const { toOrchestratorDecision } = await import('./loop.js');
  const question = 'Which connected account should I use?';
  const output = formatAwaitingUserInputFinalOutput(question);

  assert.equal(parseAwaitingUserInputFinalOutput(output), question);
  assert.equal(parseControlReceiptFinalOutput(output), null,
    'a pause must never decode as a completed control receipt');
  assert.deepEqual(toOrchestratorDecision(output), {
    summary: question,
    reply: question,
    done: false,
    nextAction: 'awaiting_user_input',
    reason: 'awaiting_user_input',
  });
});

// The alignment-beat refusal must never halt the turn as a "successful"
// dispatch receipt: unmarked, it was rendered into a fabricated "Started …"
// line and the honesty floor blocked the whole turn (live 2026-08-11,
// second acceptance run).
test('the alignment-beat refusal is a failed control receipt and fabricates nothing', async () => {
  const { renderTerminalToolReply, terminalToolShouldHalt } = await import('./terminal-tool.js');
  const refusal = 'Tool call refused by harness: alignment beat owed — no task was started.\nReply with the plan first.';
  assert.equal(terminalToolShouldHalt('dispatch_background_task', refusal), false);
  const rendered = renderTerminalToolReply('dispatch_background_task', null, 'anything without a dispatch receipt');
  assert.doesNotMatch(rendered, /^Started "/, 'no fabricated handoff claim without a real receipt');
});
