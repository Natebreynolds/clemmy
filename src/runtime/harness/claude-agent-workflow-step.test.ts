import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-workflow-step-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const STATE_DIR = path.join(TMP_HOME, 'state');
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(
  path.join(STATE_DIR, 'claude-auth.json'),
  JSON.stringify({
    accessToken: 'sk-ant-oat01-workflow-step-test-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  }),
  'utf-8',
);

const mod = await import('./claude-agent-workflow-step.js');
const {
  claudeAgentSdkWorkflowStepEnabled,
  claudeWorkflowStepOutputSchema,
  renderClaudeAgentWorkflowStepSystemAppend,
  runClaudeAgentSdkWorkflowStep,
  setClaudeAgentSdkWorkflowStepRunForTest,
} = mod;

beforeEach(() => {
  setClaudeAgentSdkWorkflowStepRunForTest(null);
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP_MAX_TURNS;
});

after(() => {
  setClaudeAgentSdkWorkflowStepRunForTest(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const step = {
  id: 'design_report',
  prompt: 'Design the report section using the taste skill.',
  intent: 'design',
  usesSkill: 'taste',
  output: { type: 'object' as const, required_keys: ['report'] },
};

test('claudeAgentSdkWorkflowStepEnabled defaults on for Claude models and is kill-switchable', () => {
  assert.equal(claudeAgentSdkWorkflowStepEnabled('claude-sonnet-4-6'), true);
  assert.equal(claudeAgentSdkWorkflowStepEnabled('gpt-5.4'), false);
  process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'off';
  assert.equal(claudeAgentSdkWorkflowStepEnabled('claude-sonnet-4-6'), false);
});

test('renderClaudeAgentWorkflowStepSystemAppend tells Claude to use skills and stay read-only', () => {
  const prompt = renderClaudeAgentWorkflowStepSystemAppend({ workflowName: 'Report Workflow', step });
  assert.match(prompt, /READ-ONLY\/local-context/);
  assert.match(prompt, /call `skill_read`/);
  assert.match(prompt, /Declared skill: taste/);
  assert.match(prompt, /Step intent: design/);
});

test('claudeWorkflowStepOutputSchema requires a status and output envelope', () => {
  const schema = claudeWorkflowStepOutputSchema();
  assert.deepEqual(schema.required, ['status', 'output']);
  assert.equal((schema.properties as Record<string, unknown>).status !== undefined, true);
});

test('runClaudeAgentSdkWorkflowStep builds a schema-bound SDK call and returns structured output', async () => {
  let captured: any;
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    captured = options;
    return {
      text: '{"status":"completed","output":{"report":"sdk workflow ok"}}',
      structuredOutput: { status: 'completed', output: { report: 'sdk workflow ok' } },
      sessionId: 'sdk-workflow-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__skill_read'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });

  const result = await runClaudeAgentSdkWorkflowStep({
    step,
    workflowName: 'Report Workflow',
    prompt: 'Workflow: Report Workflow\nStep: design_report\n\nDesign the report.',
    modelId: 'claude-sonnet-4-6',
  });

  assert.deepEqual(result.output, { report: 'sdk workflow ok' });
  assert.equal(result.structured, true);
  assert.equal(result.sdkSessionId, 'sdk-workflow-session');
  assert.deepEqual(result.toolUses, ['mcp__clementine-local__skill_read']);
  assert.equal(captured.modelId, 'claude-sonnet-4-6');
  assert.equal(captured.maxTurns, 6);
  assert.ok(captured.allowedLocalMcpTools.includes('skill_read'));
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.deepEqual(captured.outputSchema.required, ['status', 'output']);
});

test('renderClaudeAgentWorkflowStepSystemAppend full lane permits gated execution tools (no read-only boundary)', () => {
  const prompt = renderClaudeAgentWorkflowStepSystemAppend({ workflowName: 'Report Workflow', step, fullLane: true });
  assert.doesNotMatch(prompt, /READ-ONLY\/local-context/);
  assert.match(prompt, /FULL gated lane/);
  assert.match(prompt, /composio_execute_tool/);
  assert.match(prompt, /run_shell_command/);
  assert.match(prompt, /harness gate chain/);
  assert.match(prompt, /call `skill_read`/);
});

test('runClaudeAgentSdkWorkflowStep full lane runs the tool-capable gated profile on the workflow session', async () => {
  let captured: any;
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    captured = options;
    return {
      text: '{"status":"completed","output":{"report":"did the real work"}}',
      structuredOutput: { status: 'completed', output: { report: 'did the real work' } },
      sessionId: 'sdk-workflow-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });

  const result = await runClaudeAgentSdkWorkflowStep({
    step,
    workflowName: 'Report Workflow',
    prompt: 'Scrape and analyze.',
    modelId: 'claude-sonnet-4-6',
    sessionId: 'workflow:run-xyz:scrape',
    fullLane: true,
  });

  assert.deepEqual(result.output, { report: 'did the real work' });
  assert.equal(captured.agentic, true, 'full lane runs in agentic (gated-mutation) mode');
  assert.equal(captured.maxTurns, 24, 'full lane gets brain-level turn headroom (not the read-only 6)');
  assert.equal(captured.sessionId, 'workflow:run-xyz:scrape', 'gated tools run on the workflow session for plan-scope grants');
  assert.ok(captured.allowedLocalMcpTools.includes('composio_execute_tool'), 'composio exposed for external read/write');
  assert.ok(captured.allowedLocalMcpTools.includes('run_shell_command'), 'shell exposed (gated)');
  assert.ok(captured.allowedLocalMcpTools.includes('write_file'), 'file write exposed (gated)');
  assert.ok(captured.allowedLocalMcpTools.includes('notify_user'), 'notify_user exposed so notify/report steps can deliver');
  // Workflow authoring stays out of a step lane even in full mode.
  assert.equal(captured.allowedLocalMcpTools.includes('execution_create'), false);
});

test('runClaudeAgentSdkWorkflowStep converts blocked SDK output into a workflow blocked result', async () => {
  setClaudeAgentSdkWorkflowStepRunForTest(async () => ({
    text: '',
    structuredOutput: { status: 'blocked', output: null, reason: 'needs a mutating file write' },
    sessionId: 'sdk-workflow-session',
    model: 'claude-sonnet-4-6',
    toolUses: [],
  }));

  const result = await runClaudeAgentSdkWorkflowStep({
    step,
    workflowName: 'Report Workflow',
    prompt: 'Write a file.',
    modelId: 'claude-sonnet-4-6',
  });
  assert.deepEqual(result.output, { blocked: true, reason: 'needs a mutating file write' });
  assert.equal(result.structured, true);
});
