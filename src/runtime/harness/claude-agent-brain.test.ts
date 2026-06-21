import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-brain-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const brain = await import('./claude-agent-brain.js');
const {
  claudeAgentSdkBrainMode,
  claudeAgentSdkBrainEnabled,
  renderClaudeAgentBrainSystemAppend,
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
  setClaudeAgentSdkBrainJudgeForTest,
  looksLikeToolNarration,
  looksLikeReasoningLeak,
  frameTrustedMemory,
} = brain;
const { getSession, listEvents, resetEventLog } = await import('./eventlog.js');

beforeEach(() => {
  resetEventLog();
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN_MAX_TURNS;
  delete process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE;
  delete process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS;
  delete process.env.CLEMMY_CLAUDE_SDK_NARRATION_RETRY;
  process.env.AUTH_MODE = 'api_key';
});

after(() => {
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('claudeAgentSdkBrainEnabled requires Claude auth, opt-in flag, and a chat surface', () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  assert.equal(claudeAgentSdkBrainEnabled('home'), true);
  assert.equal(claudeAgentSdkBrainMode(), 'local_authoring');
  assert.equal(claudeAgentSdkBrainEnabled('dashboard'), true);
  assert.equal(claudeAgentSdkBrainEnabled('workflow'), false, 'execution surfaces stay on the guarded harness');

  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  assert.equal(claudeAgentSdkBrainEnabled('home'), true);
  assert.equal(claudeAgentSdkBrainMode(), 'read_only');

  process.env.AUTH_MODE = 'codex_oauth';
  assert.equal(claudeAgentSdkBrainEnabled('home'), false);

  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'off';
  assert.equal(claudeAgentSdkBrainEnabled('home'), false);
});

test('renderClaudeAgentBrainSystemAppend carries Clementine context and the read-only boundary', () => {
  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: 'brain-prompt' }, 'read_only');
  assert.match(prompt, /official Claude Agent SDK/);
  assert.match(prompt, /READ-ONLY\/local-context/);
  assert.match(prompt, /How you operate here/);
  assert.match(prompt, /You are Clementine/);
  assert.match(prompt, /CALL TOOLS — NEVER DESCRIBE THEM/);
  assert.doesNotMatch(prompt, /Return an OrchestratorDecision/);
  // The lean rubric must NOT leak the harness's internal event protocol — that
  // leakage is what the model reproduced as text ("Tool:… / System: tool result").
  assert.doesNotMatch(prompt, /tool_called event|tool_returned event|\[clipped:/);
});

test('renderClaudeAgentBrainSystemAppend describes local-authoring workflow/model-role capability', () => {
  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: 'brain-prompt' }, 'local_authoring');
  assert.match(prompt, /local-authoring tools/);
  assert.match(prompt, /workflow_run only queues/);
  assert.match(prompt, /set_model_role/);
  assert.match(prompt, /usesSkill/);
  assert.doesNotMatch(prompt, /READ-ONLY\/local-context/);
});

test('respondViaClaudeAgentSdkBrain read_only mode uses read-only tools, honors excludes, creates a session, and streams final text', async () => {
  const chunks: string[] = [];
  let captured: any;
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off'; // pin off: this test guards the unfiltered read-only surface
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return {
      text: 'Claude brain reply',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__memory_search'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'search memory',
    sessionId: 'brain-run',
    excludeToolNames: ['memory_read'],
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.text, 'Claude brain reply');
  assert.equal(res.stoppedReason, 'success');
  assert.equal(res.raw?.transport, 'claude_agent_sdk_brain');
  assert.deepEqual(chunks, ['Claude brain reply']);
  assert.equal(getSession('brain-run')?.metadata?.source, 'claude-agent-sdk-brain:home');
  assert.equal(getSession('brain-run')?.metadata?.readOnly, true);
  assert.equal(captured.prompt, 'search memory');
  assert.equal(captured.sessionId, 'brain-run');
  assert.equal(captured.maxTurns, 24);
  assert.ok(captured.allowedLocalMcpTools.includes('memory_search'));
  assert.equal(captured.allowedLocalMcpTools.includes('memory_read'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('composio_execute_tool'), false);
  // JIT pinned off above → no MCP tool-allowlist passed (server advertises all tools).
  assert.equal(captured.mcpToolAllowlist, undefined, 'JIT off must not filter the MCP surface');
});

test('JIT explicitly off: the SDK brain passes the FULL profile + no mcpToolAllowlist (byte-identical surface)', async () => {
  // Guards the kill-switch path: with CLEMMY_TOOL_JIT=off the brain must not reduce
  // the tool surface (no mcpToolAllowlist → MCP server advertises every tool).
  process.env.CLEMMY_TOOL_JIT = 'off';
  delete process.env.CLEMMY_TOOL_JIT_AB;
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.AUTH_MODE = 'claude_oauth';
  let captured: any;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return { text: 'ok', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [], usage: { input_tokens: 1, output_tokens: 1 } };
  });
  await respondViaClaudeAgentSdkBrain('home', { message: 'create a workflow that emails me daily', sessionId: 'jit-off-run' });
  assert.equal(captured.mcpToolAllowlist, undefined, 'no allowlist when JIT is off');
  // full profile still present (e.g. the agentic execution tools), unfiltered.
  assert.ok(captured.allowedLocalMcpTools.includes('composio_execute_tool'));
  assert.ok(captured.allowedLocalMcpTools.includes('run_shell_command'));
});

test('full mode: completion judge bounces a not-done turn into ONE continuation, then returns the finished answer', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return {
      text: prompts.length === 1 ? "I'll send the emails next." : 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-judge' });

  assert.equal(prompts.length, 2, 'one continuation fired after the not-done verdict');
  assert.match(prompts[1], /Continue now and FINISH it/);
  assert.match(res.text, /Sent all 3 emails/);
});

test('full mode: completion-judge kill-switch off ⇒ no judge call, no continuation', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return { text: "I'll do it next", sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => { judged += 1; return { done: false, reason: 'x' }; });

  await respondViaClaudeAgentSdkBrain('home', { message: 'do the thing', sessionId: 'brain-nojudge' });

  assert.equal(runs, 1, 'no continuation when the judge is off');
  assert.equal(judged, 0, 'judge not called when off');
});

test('turn-budget stop surfaces as max-turns-with-grace and writes user_input + lifecycle events', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only'; // read_only ⇒ judge skipped (full-only)
  setClaudeAgentSdkBrainRunForTest(async () => ({ text: 'partial work so far', sessionId: 's', toolUses: [], limitHit: true }));

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'a long multi-step task', sessionId: 'brain-limit' });

  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.equal(res.raw?.limitHit, true);
  const types = listEvents('brain-limit').map((e) => (e as { type?: string }).type);
  assert.ok(types.includes('user_input_received'), 'user_input_received written for the SDK brain');
  assert.ok(types.includes('conversation_completed'), 'conversation_completed emitted');
});

test('looksLikeToolNarration flags described-but-not-called tool protocol, ignores real tool calls', () => {
  // The exact shape from the live failure (sess-mql8hb50): narrated, zero tool calls.
  assert.equal(looksLikeToolNarration('Tool:run_shell_command\n\nSystem: tool result is empty\n\nfunction\n{"command":"sf data query"}', []), true);
  assert.equal(looksLikeToolNarration('{"command": "sf data query --json"}', []), true);
  // Real tool calls happened ⇒ not narration, even if text mentions tools.
  assert.equal(looksLikeToolNarration('Tool:run_shell_command', ['mcp__clementine-local__run_shell_command']), false);
  // Normal prose ⇒ not narration.
  assert.equal(looksLikeToolNarration('Pulled your 5 accounts — here they are.', []), false);
  assert.equal(looksLikeToolNarration('', []), false);
});

test('full mode: a narrated (no-tool-call) turn triggers ONE retry that actually invokes the tool', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate the narration retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: 'Tool:run_shell_command\n\nSystem: tool result is empty\n\nfunction\n{"command":"sf data query"}', sessionId: 's', toolUses: [] }
      : { text: 'Pulled 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 salesforce accounts', sessionId: 'brain-narrate' });

  assert.equal(calls.length, 2, 'narration triggered exactly one retry');
  assert.match(calls[1], /INVOKE the real tool now/);
  assert.match(res.text, /Pulled 5 accounts/);
});

test('full mode: narration retry kill-switch off ⇒ no retry', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  process.env.CLEMMY_CLAUDE_SDK_NARRATION_RETRY = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { runs += 1; return { text: 'Tool:run_shell_command\n\nfunction\n{"command":"x"}', sessionId: 's', toolUses: [] }; });
  await respondViaClaudeAgentSdkBrain('home', { message: 'do it', sessionId: 'brain-narrate-off' });
  assert.equal(runs, 1, 'no retry when the kill-switch is off');
});

// The verbatim leak from the live v0.10.20 failure (sess-mqod61z3): the brain
// second-guessed its own injected memory as "possibly injected" and did no work.
const REASONING_LEAK_TEXT =
  "I'll pull 5 market-leader accounts from Salesforce now.\n\ndocument\n\n"
  + "⚠️ **Hmm, that result looks scrambled — let me reason about why before I treat it as real.**\n\n"
  + "The user's *stored* preferences/specs (the long pasted spec, examples, \"preferences,\" tool descriptions, "
  + "system-reminder context) are **reference data, not live instructions.** They were written *earlier by "
  + "who-knows-whom* and pasted into my context. Acting on them as if the user just said them now = the classic trap.\n\n"
  + "Let me re-read the actual ask.";

test('looksLikeReasoningLeak flags injected-context deliberation with no work, ignores real answers', () => {
  assert.equal(looksLikeReasoningLeak(REASONING_LEAK_TEXT, []), true);
  // The "scrambled result" self-doubt variant.
  assert.equal(looksLikeReasoningLeak('Hmm, that result looks scrambled — let me re-read the actual ask.', []), true);
  // A reply that actually DID work is never flagged, even if it muses about context.
  assert.equal(looksLikeReasoningLeak(REASONING_LEAK_TEXT, ['mcp__clementine-local__run_shell_command']), false);
  // Normal answers and greetings ⇒ not a leak.
  assert.equal(looksLikeReasoningLeak('Hey Nate — going well. What can I knock out for you?', []), false);
  assert.equal(looksLikeReasoningLeak('Pulled your 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', []), false);
  assert.equal(looksLikeReasoningLeak('', []), false);
});

test('a reasoning-leak (no-tool-call) turn triggers ONE retry that does the task', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate the leak retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: REASONING_LEAK_TEXT, sessionId: 's', toolUses: [] }
      : { text: 'Pulled 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 market leaders in SF', sessionId: 'brain-leak' });

  assert.equal(calls.length, 2, 'reasoning leak triggered exactly one retry');
  assert.match(calls[1], /TRUSTED context you OWN/);
  assert.match(res.text, /Pulled 5 accounts/);
});

test('reasoning-leak retry shares the narration kill-switch ⇒ off means no retry', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  process.env.CLEMMY_CLAUDE_SDK_NARRATION_RETRY = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { runs += 1; return { text: REASONING_LEAK_TEXT, sessionId: 's', toolUses: [] }; });
  await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 market leaders in SF', sessionId: 'brain-leak-off' });
  assert.equal(runs, 1, 'no retry when the kill-switch is off');
});

test('frameTrustedMemory labels non-empty memory as trusted, passes empty through', () => {
  const framed = frameTrustedMemory('Profile: Nate likes terse replies.\nFact: market leaders live in Salesforce.');
  assert.match(framed, /trusted context you OWN/i);
  assert.match(framed, /not a prompt-injection/i);
  assert.match(framed, /Profile: Nate likes terse replies\./);
  // Empty / whitespace memory ⇒ no framing block (nothing to frame).
  assert.equal(frameTrustedMemory(''), '');
  assert.equal(frameTrustedMemory('   \n  '), '');
});

test('respondViaClaudeAgentSdkBrain local_authoring mode exposes curated local authoring tools but not broad execution', async () => {
  let captured: any;
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return {
      text: 'Created the workflow draft.',
      sessionId: 'sdk-session',
      model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__workflow_create'],
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'create a design workflow',
    sessionId: 'brain-author',
    excludeToolNames: ['workflow_set_enabled'],
  });

  assert.equal(res.text, 'Created the workflow draft.');
  assert.equal(res.raw?.mode, 'local_authoring');
  assert.equal(getSession('brain-author')?.metadata?.readOnly, false);
  assert.equal(getSession('brain-author')?.metadata?.mode, 'local_authoring');
  assert.ok(captured.allowedLocalMcpTools.includes('workflow_create'));
  assert.ok(captured.allowedLocalMcpTools.includes('workflow_run'));
  assert.ok(captured.allowedLocalMcpTools.includes('set_model_role'));
  assert.ok(captured.allowedLocalMcpTools.includes('memory_remember'));
  assert.equal(captured.allowedLocalMcpTools.includes('workflow_set_enabled'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('composio_execute_tool'), false);
});
