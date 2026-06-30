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
const sdkMod = await import('./claude-agent-sdk.js');
const {
  claudeAgentSdkWorkflowStepEnabled,
  claudeWorkflowStepOutputSchema,
  renderClaudeAgentWorkflowStepSystemAppend,
  requiredLocalMcpToolsForWorkflowStep,
  runClaudeAgentSdkWorkflowStep,
  setClaudeAgentSdkWorkflowStepRunForTest,
} = mod;
const { ClaudeAgentSdkToolSurfaceError } = sdkMod;

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

test('requiredLocalMcpToolsForWorkflowStep detects Salesforce CLI and notification requirements', () => {
  const salesforceStep = {
    id: 'main',
    sideEffect: 'send' as const,
    prompt: 'Use the authenticated Salesforce CLI via run_shell_command: sf data query --query "SELECT Id FROM Event" --json. Notify Nate with the results.',
  };
  const tools = requiredLocalMcpToolsForWorkflowStep(salesforceStep, true);
  assert.ok(tools.includes('run_shell_command'));
  assert.ok(tools.includes('notify_user'));
  assert.deepEqual(requiredLocalMcpToolsForWorkflowStep(salesforceStep, false), []);
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
  assert.deepEqual(captured.requiredLocalMcpTools, [], 'generic full-lane steps do not over-require every possible tool');
  // Workflow authoring stays out of a step lane even in full mode.
  assert.equal(captured.allowedLocalMcpTools.includes('execution_create'), false);
});

test('runClaudeAgentSdkWorkflowStep passes concrete required tools for Salesforce send steps', async () => {
  let captured: any;
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    captured = options;
    return {
      text: '{"status":"completed","output":{"notified":true}}',
      structuredOutput: { status: 'completed', output: { notified: true } },
      sessionId: 'sdk-workflow-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__run_shell_command', 'mcp__clementine-local__notify_user'],
    };
  });

  const salesforceStep = {
    id: 'main',
    sideEffect: 'send' as const,
    prompt: 'Use run_shell_command to execute sf data query --query "SELECT Id FROM Event" --json, then notify Nate.',
  };
  const result = await runClaudeAgentSdkWorkflowStep({
    step: salesforceStep,
    workflowName: 'daily-overdue-salesforce-meetings',
    prompt: salesforceStep.prompt,
    modelId: 'claude-opus-4-8',
    sessionId: 'workflow:run-salesforce:main',
    fullLane: true,
  });

  assert.deepEqual(result.output, { notified: true });
  assert.deepEqual(captured.requiredLocalMcpTools.sort(), ['notify_user', 'run_shell_command']);
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

test('runClaudeAgentSdkWorkflowStep converts missing tool surface into a blocked workflow result', async () => {
  setClaudeAgentSdkWorkflowStepRunForTest(async () => {
    throw new ClaudeAgentSdkToolSurfaceError(['run_shell_command'], ['mcp__clementine-local__ping']);
  });

  const result = await runClaudeAgentSdkWorkflowStep({
    step: {
      id: 'main',
      prompt: 'Use run_shell_command to execute sf data query --json, then notify Nate.',
      sideEffect: 'send' as const,
    },
    workflowName: 'daily-overdue-salesforce-meetings',
    prompt: 'Use run_shell_command to execute sf data query --json, then notify Nate.',
    modelId: 'claude-opus-4-8',
    sessionId: 'workflow:run-salesforce:main',
    fullLane: true,
  });

  assert.deepEqual(result.output, {
    blocked: true,
    reason: 'Clementine workflow runtime did not expose required local MCP tool: run_shell_command. This is a runtime/tool-surface issue, not a service credential issue.',
  });
  assert.equal(result.structured, true);
});

test('runClaudeAgentSdkWorkflowStep RE-THROWS (transient, self-heal) when the MCP surface never initialized (0 baseline tools)', async () => {
  // The per-step MCP child advertised an EMPTY surface (no baseline read tools) —
  // i.e. it had not finished initializing. This is the 2026-06-30 facebook-scrape
  // failure mode: every step blocked on composio not being advertised. It must NOT
  // hard-block (that kills the workflow's real work); it must throw a TRANSIENT
  // error so the runner retries with a fresh MCP child.
  setClaudeAgentSdkWorkflowStepRunForTest(async () => {
    throw new ClaudeAgentSdkToolSurfaceError(['composio_execute_tool', 'composio_search_tools'], []);
  });
  const { isTransientStepError } = await import('../../execution/transient-error.js');

  await assert.rejects(
    () => runClaudeAgentSdkWorkflowStep({
      step: { id: 'scrape_and_analyze', prompt: 'Use composio_execute_tool to scrape.', sideEffect: 'read' as const, allowedTools: ['composio_execute_tool'] },
      workflowName: 'scorpion-facebook-trends',
      prompt: 'Use composio_execute_tool to scrape.',
      modelId: 'claude-opus-4-8',
      sessionId: 'workflow:run-fb:scrape_and_analyze',
      fullLane: true,
    }),
    (err: unknown) => {
      assert.match((err as Error).message, /temporarily unavailable/);
      assert.equal(isTransientStepError(err), true, 'must be classified retryable so the runner self-heals');
      return true;
    },
  );
});

test('runClaudeAgentSdkWorkflowStep converts SDK turn limits into a blocked workflow result', async () => {
  setClaudeAgentSdkWorkflowStepRunForTest(async () => ({
    text: 'I reached the turn budget. Say "continue" to keep going.',
    limitHit: true,
    sessionId: 'sdk-workflow-session',
    model: 'claude-sonnet-4-6',
    toolUses: ['mcp__clementine-local__skill_read'],
    usage: { input_tokens: 12, output_tokens: 4 },
    modelUsage: { provider: 'claude', model: 'claude-sonnet-4-6' },
  }));

  const result = await runClaudeAgentSdkWorkflowStep({
    step,
    workflowName: 'Report Workflow',
    prompt: 'Do the workflow step.',
    modelId: 'claude-sonnet-4-6',
  });

  assert.deepEqual(result.output, {
    blocked: true,
    reason: 'Claude reached the workflow-step turn budget before finishing this step.',
  });
  assert.equal(result.structured, true);
  assert.equal(result.sdkSessionId, 'sdk-workflow-session');
  assert.deepEqual(result.toolUses, ['mcp__clementine-local__skill_read']);
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4 });
  assert.deepEqual(result.modelUsage, { provider: 'claude', model: 'claude-sonnet-4-6' });
});
