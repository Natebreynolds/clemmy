import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-worker-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const STATE_DIR = path.join(TMP_HOME, 'state');
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(
  path.join(STATE_DIR, 'claude-auth.json'),
  JSON.stringify({
    accessToken: 'sk-ant-oat01-worker-test-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }),
  'utf-8',
);

const mod = await import('./claude-agent-worker.js');
const {
  claudeAgentSdkWorkerEnabled,
  renderClaudeAgentWorkerSystemAppend,
  runClaudeAgentSdkWorker,
  setClaudeAgentSdkWorkerRunForTest,
} = mod;

beforeEach(() => {
  setClaudeAgentSdkWorkerRunForTest(null);
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER_MAX_TURNS;
});

after(() => {
  setClaudeAgentSdkWorkerRunForTest(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const packet = {
  objective: 'Design a concise report section using an installed skill.',
  item: 'report hero',
  resolvedTools: 'skill_read',
  context: 'Use skill claude-worker-smoke.',
  instructions: 'Use the installed skill before writing.',
  expectedOutput: 'One compact design direction.',
  intent: 'design',
};

test('claudeAgentSdkWorkerEnabled defaults on for Claude models and is kill-switchable', () => {
  assert.equal(claudeAgentSdkWorkerEnabled('claude-sonnet-4-6'), true);
  assert.equal(claudeAgentSdkWorkerEnabled('gpt-5.4'), false);
  process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKER = 'off';
  assert.equal(claudeAgentSdkWorkerEnabled('claude-sonnet-4-6'), false);
});

test('renderClaudeAgentWorkerSystemAppend tells Claude to use named skills and stay read-only', () => {
  const prompt = renderClaudeAgentWorkerSystemAppend(packet);
  assert.match(prompt, /READ-ONLY\/local-context/);
  assert.match(prompt, /call `skill_read`/);
  assert.match(prompt, /Worker intent: design/);
});

test('runClaudeAgentSdkWorker builds a worker packet prompt with read-only tools', async () => {
  let captured: any;
  setClaudeAgentSdkWorkerRunForTest(async (options) => {
    captured = options;
    return {
      text: 'worker ok',
      sessionId: 'sdk-worker-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__skill_read'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });

  const result = await runClaudeAgentSdkWorker(packet, 'claude-sonnet-4-6');
  assert.equal(result.text, 'worker ok');
  assert.equal(result.sdkSessionId, 'sdk-worker-session');
  assert.deepEqual(result.toolUses, ['mcp__clementine-local__skill_read']);
  assert.equal(captured.modelId, 'claude-sonnet-4-6');
  assert.equal(captured.maxTurns, 5);
  assert.match(captured.prompt, /\[WORKER JOB PACKET\]/);
  assert.ok(captured.allowedLocalMcpTools.includes('skill_read'));
  assert.ok(captured.allowedLocalMcpTools.includes('memory_search'));
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
});
