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
  looksLikeStreamingNarration,
  looksLikeReasoningLeak,
  frameTrustedMemory,
  sdkStreamingEnabled,
} = brain;
const { appendEvent, createSession, getSession, listEvents, resetEventLog } = await import('./eventlog.js');

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
  delete process.env.CLEMMY_CLAUDE_SDK_STREAMING;
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

test('full mode: completion judge receives prior user context and SDK tool evidence', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-judge-evidence', kind: 'chat', title: 'judge evidence' });
  appendEvent({
    sessionId: 'brain-judge-evidence',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Build and publish the Q3 microsite' },
  });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Published the microsite at https://example.test/q3.',
    sessionId: 'sdk',
    model: 'claude-opus-4-8',
    toolUses: [
      'mcp__clementine-local__run_shell_command',
      'mcp__clementine-local__composio_execute_tool',
      'mcp__clementine-local__composio_execute_tool',
    ],
  }));
  let judgedObjective = '';
  let toolSummary = '';
  setClaudeAgentSdkBrainJudgeForTest(async (objective, _response, skillContext) => {
    judgedObjective = objective;
    toolSummary = skillContext?.toolCallSummary ?? '';
    return { done: true, reason: 'published URL present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'ship it',
    sessionId: 'brain-judge-evidence',
  });

  assert.match(res.text, /https:\/\/example\.test\/q3/);
  assert.match(judgedObjective, /Build and publish the Q3 microsite/);
  assert.match(judgedObjective, /Current user message .*ship it/);
  assert.match(toolSummary, /run_shell_command/);
  assert.match(toolSummary, /composio_execute_tool x2/);
});

test('streaming judge continuation appends the corrected final answer when it was not streamed', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'on';
  const chunks: string[] = [];
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    if (runs === 1) {
      await options.onDelta?.("I'll send the emails next.");
      return {
        text: "I'll send the emails next.",
        sessionId: 'sdk', model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
      };
    }
    return {
      text: 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'send the 3 emails',
    sessionId: 'brain-stream-judge',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.text, 'Sent all 3 emails — here are the message links.');
  assert.deepEqual(chunks, [
    "I'll send the emails next.",
    '\n\nSent all 3 emails — here are the message links.',
  ]);
});

test('streaming judge continuation suppresses retry deltas after stale streamed text', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'on';
  const chunks: string[] = [];
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    if (runs === 1) {
      await options.onDelta?.("I'll send the emails next.");
      return {
        text: "I'll send the emails next.",
        sessionId: 'sdk', model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
      };
    }
    await options.onDelta?.('STREAMED RETRY SHOULD NOT RENDER');
    return {
      text: 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'send the 3 emails',
    sessionId: 'brain-stream-judge-suppress-retry',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.text, 'Sent all 3 emails — here are the message links.');
  assert.deepEqual(chunks, [
    "I'll send the emails next.",
    '\n\nSent all 3 emails — here are the message links.',
  ]);
});

test('local_authoring mode: completion judge verifies workflow-authoring claims before success', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on'; // default Claude brain mode = local_authoring
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return {
      text: prompts.length === 1 ? 'I created the workflow.' : 'Created workflow wf_daily_digest and scheduled it for 8am.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__workflow_create'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'missing workflow id and schedule evidence' } : { done: true, reason: 'workflow id present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'create and schedule a daily digest workflow', sessionId: 'brain-author-judge' });

  assert.equal(prompts.length, 2, 'local-authoring claims are judged and continued once when not done');
  assert.match(prompts[1], /missing workflow id and schedule evidence/);
  assert.match(res.text, /wf_daily_digest/);
});

test('local_authoring mode: zero-tool completion claims are judged before success', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return prompts.length === 1
      ? { text: 'Created workflow daily_digest.', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [] }
      : {
        text: 'Created workflow wf_daily_digest with workflow_create.',
        sessionId: 'sdk',
        model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__workflow_create'],
      };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no workflow_create evidence' } : { done: true, reason: 'workflow tool evidence present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'create a daily digest workflow', sessionId: 'brain-author-zero-tool-claim' });

  assert.equal(prompts.length, 2, 'zero-tool completion claim must be judged and continued');
  assert.match(prompts[1], /no workflow_create evidence/);
  assert.match(res.text, /wf_daily_digest/);
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
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only'; // read_only ⇒ judge skipped
  setClaudeAgentSdkBrainRunForTest(async () => ({ text: 'partial work so far', sessionId: 's', toolUses: [], limitHit: true }));

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'a long multi-step task', sessionId: 'brain-limit' });

  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Say "continue"/);
  assert.equal(res.raw?.limitHit, true);
  const events = listEvents('brain-limit');
  const types = events.map((e) => (e as { type?: string }).type);
  assert.ok(types.includes('user_input_received'), 'user_input_received written for the SDK brain');
  assert.ok(types.includes('conversation_completed'), 'conversation_completed emitted');
  assert.ok(types.includes('conversation_limit_exceeded'), 'limit event emitted for paused/stopped classification');
  assert.ok(
    types.indexOf('conversation_limit_exceeded') < types.indexOf('conversation_completed'),
    'limit telemetry lands before the user-facing continue completion',
  );
  const completed = events.find((e) => (e as { type?: string }).type === 'conversation_completed') as { data?: Record<string, unknown> } | undefined;
  assert.equal(completed?.data?.reason, 'awaiting_continue');
  assert.match(String(completed?.data?.reply ?? ''), /Say "continue"/);
});

test('streaming max-turn stop appends the missing continue guidance instead of suppressing it', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'on';
  const chunks: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    await options.onDelta?.('partial work so far');
    return { text: 'partial work so far', sessionId: 's', toolUses: [], limitHit: true };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'a long multi-step task',
    sessionId: 'brain-stream-limit',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(chunks.join(''), /partial work so far\n\nI hit the turn budget/);
  assert.match(chunks.join(''), /Say "continue"/);
});

test('looksLikeToolNarration flags described-but-not-called tool protocol, ignores real tool calls', () => {
  // The exact shape from the live failure (sess-mql8hb50): narrated, zero tool calls.
  assert.equal(looksLikeToolNarration('Tool:run_shell_command\n\nSystem: tool result is empty\n\nfunction\n{"command":"sf data query"}', []), true);
  assert.equal(looksLikeToolNarration('{"command": "sf data query --json"}', []), true);
  // The 2026-06-22 Workspace-build failure (space-new-workspace-2): the native
  // tool-call XML emitted AS TEXT — nothing ran, so the workspace was never built.
  assert.equal(looksLikeToolNarration('<invoke name="run_shell_command">\n<parameter name="command">sf data query</parameter>\n</invoke>', []), true);
  assert.equal(looksLikeToolNarration('<invoke name="space_save">', []), true);
  assert.equal(looksLikeToolNarration('Fields 40-89:\n<invoke name="run_shell_command"><parameter name="command">ls</parameter></invoke>', []), true);
  // The 2026-06-23 dock failure: a markdown "**Tool call: NAME**" header + a
  // ```json args block, on the Claude brain in FULL mode (42 tools exposed).
  assert.equal(looksLikeToolNarration('**Tool call: skill_read**\n```json\n{\n  "name": "salesforce-deal-risk-workspace"\n}\n```', []), true);
  assert.equal(looksLikeToolNarration('Tool call: skill_read\n{"name":"x"}', []), true);
  assert.equal(looksLikeToolNarration('<tool_call>\n{"name":"skill_read"}', []), true);
  assert.equal(looksLikeToolNarration('[tool_call] skill_read', []), true);
  assert.equal(looksLikeToolNarration('{"tool_slug": "SALESFORCE_RUN_SOQL_QUERY", "arguments": {}}', []), true);
  // Real tool calls happened ⇒ not narration, even if text mentions tools / XML.
  assert.equal(looksLikeToolNarration('Tool:run_shell_command', ['mcp__clementine-local__run_shell_command']), false);
  assert.equal(looksLikeToolNarration('<invoke name="run_shell_command">', ['run_shell_command']), false);
  assert.equal(looksLikeToolNarration('**Tool call: skill_read**', ['skill_read']), false);
  // Normal prose ⇒ not narration (a mid-sentence "tool call" must NOT false-flag).
  assert.equal(looksLikeToolNarration('Pulled your 5 accounts — here they are.', []), false);
  assert.equal(looksLikeToolNarration('I will invoke the report generator and send it over.', []), false);
  assert.equal(looksLikeToolNarration('Here is what each tool call does in the pipeline, summarized.', []), false);
  assert.equal(looksLikeToolNarration('The tool call budget looks fine for this run.', []), false);
  assert.equal(looksLikeToolNarration('', []), false);
});

test('sdkStreamingEnabled defaults OFF (clean dock — opt back in with =on)', () => {
  delete process.env.CLEMMY_CLAUDE_SDK_STREAMING;
  assert.equal(sdkStreamingEnabled(), false);
  process.env.CLEMMY_CLAUDE_SDK_STREAMING = 'on';
  assert.equal(sdkStreamingEnabled(), true);
  delete process.env.CLEMMY_CLAUDE_SDK_STREAMING;
});

test('looksLikeStreamingNarration suppresses live streaming the moment tool-call XML/protocol appears, never on clean prose', () => {
  // The high-precision markers that must cut the live stream (the dock noise).
  assert.equal(looksLikeStreamingNarration('Let me check…\n<invoke name="run_shell_command">'), true);
  assert.equal(looksLikeStreamingNarration('<parameter name="command">ls</parameter>'), true);
  assert.equal(looksLikeStreamingNarration('**Tool call: skill_read**'), true);
  assert.equal(looksLikeStreamingNarration('Tool call: workflow_get'), true);
  assert.equal(looksLikeStreamingNarration('<tool_call>'), true);
  assert.equal(looksLikeStreamingNarration('[tool_call] skill_read'), true);
  // Clean prose must keep streaming — no false cut mid-answer.
  assert.equal(looksLikeStreamingNarration('Pulled your 5 deals — here is the summary.'), false);
  assert.equal(looksLikeStreamingNarration('Here is what each tool call does in the pipeline.'), false);
  assert.equal(looksLikeStreamingNarration('I will invoke the report generator next.'), false);
  assert.equal(looksLikeStreamingNarration(''), false);
});

test('renderClaudeAgentBrainSystemAppend injects the workspace primer for a "space-" session', async () => {
  const { spaceStore } = await import('../../spaces/store.js');
  spaceStore.save({ id: 'deal-risk', title: 'Deal Risk', actions: [], dataSources: [] });
  const out = renderClaudeAgentBrainSystemAppend(
    'dashboard', { sessionId: 'space-deal-risk', message: 'add a close-date filter' } as never, 'full');
  assert.match(out, /space_edit_view\('deal-risk'/);
  assert.match(out, /Deal Risk/);
  // a plain (non-space) session gets no workspace primer
  const plain = renderClaudeAgentBrainSystemAppend('dashboard', { sessionId: 'sess-abc', message: 'hi' } as never, 'full');
  assert.ok(!/space_edit_view/.test(plain));
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

test('limit-hit tool narration parks for continue instead of retrying inside the same turn', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return {
      text: 'Tool:run_shell_command\n\nfunction\n{"command":"sf data query"}',
      sessionId: 's',
      toolUses: [],
      limitHit: true,
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 salesforce accounts', sessionId: 'brain-narrate-limit' });

  assert.equal(runs, 1, 'max-turn pause must not spend another SDK turn on narration retry');
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Say "continue"/);
});

test('local_authoring mode: a narrated workflow tool call triggers ONE retry', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on'; // local_authoring
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate narration retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: '**Tool call: workflow_create**\n```json\n{"name":"daily_digest"}\n```', sessionId: 's', toolUses: [] }
      : { text: 'Created workflow daily_digest.', sessionId: 's', toolUses: ['mcp__clementine-local__workflow_create'] };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'create a daily digest workflow', sessionId: 'brain-author-narrate' });

  assert.equal(calls.length, 2, 'local-authoring narration triggered exactly one retry');
  assert.match(calls[1], /INVOKE the real tool now/);
  assert.match(res.text, /Created workflow daily_digest/);
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

test('limit-hit reasoning leak parks for continue instead of retrying inside the same turn', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return { text: REASONING_LEAK_TEXT, sessionId: 's', toolUses: [], limitHit: true };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 market leaders in SF', sessionId: 'brain-leak-limit' });

  assert.equal(runs, 1, 'max-turn pause must not spend another SDK turn on reasoning-leak retry');
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Say "continue"/);
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

test('salvage A: a parse error AFTER work committed returns a SUCCESS confirmation and NEVER re-runs (no double-send)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE; // default on
  createSession({ id: 'salvage-committed', kind: 'chat', title: 'salvage' });
  // The 3 emails already sent this turn — recorded as external_write events.
  for (const t of ['a@x.com', 'b@y.com', 'c@z.com']) {
    appendEvent({ sessionId: 'salvage-committed', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: [t] } });
  }
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { calls += 1; throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed)."); });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'sent' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send those 3 emails', sessionId: 'salvage-committed' });
  assert.equal(calls, 1, 'must NOT re-run after a committed send (no double-send)');
  assert.equal(res.stoppedReason, 'success');
  assert.match(res.text, /3 emails/);
  assert.match(res.text, /a@x\.com/);
  assert.doesNotMatch(res.text, /could not be parsed|went wrong/i);
});

test('salvage B: a parse error with NOTHING committed retries once and succeeds', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'salvage-retry', kind: 'chat', title: 'salvage retry' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed).");
    return { text: 'Here is your answer.', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'what is 2+2', sessionId: 'salvage-retry' });
  assert.equal(calls, 2, 'retried once after a pre-commit parse error');
  assert.match(res.text, /Here is your answer/);
});

test('salvage: kill-switch off ⇒ the parse error propagates (byte-identical to before)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_SALVAGE = 'off';
  createSession({ id: 'salvage-off', kind: 'chat', title: 'off' });
  appendEvent({ sessionId: 'salvage-off', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'X', toolName: 'composio_execute_tool', targets: ['a@x.com'] } });
  setClaudeAgentSdkBrainRunForTest(async () => { throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed)."); });
  await assert.rejects(
    () => respondViaClaudeAgentSdkBrain('home', { message: 'go', sessionId: 'salvage-off' }),
    /could not be parsed/,
  );
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
});
