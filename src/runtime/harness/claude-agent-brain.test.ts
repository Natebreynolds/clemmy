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
} = brain;
const { getSession, resetEventLog } = await import('./eventlog.js');

beforeEach(() => {
  resetEventLog();
  setClaudeAgentSdkBrainRunForTest(null);
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN_MAX_TURNS;
  process.env.AUTH_MODE = 'api_key';
});

after(() => {
  setClaudeAgentSdkBrainRunForTest(null);
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
  assert.match(prompt, /Core Clementine operating rubric/);
  assert.match(prompt, /You are Clementine/);
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
  assert.equal(captured.maxTurns, 6);
  assert.ok(captured.allowedLocalMcpTools.includes('memory_search'));
  assert.equal(captured.allowedLocalMcpTools.includes('memory_read'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('composio_execute_tool'), false);
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
