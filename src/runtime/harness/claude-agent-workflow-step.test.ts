import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-workflow-step-test-'));
const ORIGINAL_OWNER_NAME = process.env.OWNER_NAME;
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
const { AgentRuntimeCancelledError } = await import('../provider.js');
const { saveUserProfile } = await import('../user-profile.js');
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
  process.env.OWNER_NAME = '';
  rmSync(path.join(STATE_DIR, 'user-profile.json'), { force: true });
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP_MAX_TURNS;
  delete process.env.MODEL_ROUTING_MODE;
  delete process.env.BYO_MODEL_BASE_URL;
  delete process.env.BYO_MODEL_API_KEY;
  delete process.env.BYO_MODEL_ID;
});

after(() => {
  setClaudeAgentSdkWorkflowStepRunForTest(null);
  if (ORIGINAL_OWNER_NAME === undefined) delete process.env.OWNER_NAME;
  else process.env.OWNER_NAME = ORIGINAL_OWNER_NAME;
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

test('Claude-shaped all_in BYO model does not enter the Claude SDK workflow-step lane', () => {
  process.env.MODEL_ROUTING_MODE = 'all_in';
  process.env.BYO_MODEL_BASE_URL = 'https://byo.example.test/v1';
  process.env.BYO_MODEL_API_KEY = 'byo-key';
  process.env.BYO_MODEL_ID = 'claude-custom';
  assert.equal(claudeAgentSdkWorkflowStepEnabled('claude-custom'), false);
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
    sessionId: 'workflow:run-source:design_report',
    sourceUserSeq: 42,
    shouldCancel: () => false,
  });

  assert.deepEqual(result.output, { report: 'sdk workflow ok' });
  assert.equal(result.structured, true);
  assert.equal(result.sdkSessionId, 'sdk-workflow-session');
  assert.deepEqual(result.toolUses, ['mcp__clementine-local__skill_read']);
  assert.equal(captured.modelId, 'claude-sonnet-4-6');
  assert.equal(captured.sessionId, 'workflow:run-source:design_report');
  assert.equal(captured.sourceUserSeq, 42);
  assert.equal(await captured.shouldCancel(), false);
  assert.equal(captured.maxTurns, 6);
  assert.ok(captured.allowedLocalMcpTools.includes('skill_read'));
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.deepEqual(captured.outputSchema.required, ['status', 'output']);
});

test('compiled project read step gives Claude exactly its sanitized snapshot tools', async () => {
  let captured: any;
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    captured = options;
    return {
      text: '{"status":"completed","output":{"rows":3}}',
      structuredOutput: { status: 'completed', output: { rows: 3 } },
      sessionId: 'sdk-compiled-read-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__list_files'],
    };
  });

  const compiledReadStep = {
    id: 'inspect_inputs',
    prompt: 'Read the files, use skill_read, remember this, and notify the user.',
    sideEffect: 'read' as const,
    allowedTools: [
      ' list_files ',
      'workspace_artifact_query',
      'list_files',
      'workflow_step_result',
      'mcp__clementine-local__workflow_step_result',
      '*',
      '**',
      '',
    ],
    __compiledProjectRuntime: true as const,
  };
  const result = await runClaudeAgentSdkWorkflowStep({
    step: compiledReadStep as any,
    workflowName: 'compiled-project-read',
    prompt: compiledReadStep.prompt,
    modelId: 'claude-sonnet-4-6',
    sessionId: 'workflow:compiled-read:inspect_inputs',
    fullLane: false,
  });

  assert.deepEqual(result.output, { rows: 3 });
  assert.deepEqual(captured.allowedLocalMcpTools, ['list_files', 'workspace_artifact_query']);
  assert.deepEqual(captured.mcpToolAllowlist, captured.allowedLocalMcpTools, 'registered local tools cannot exceed compiled authority');
  assert.deepEqual(captured.localMcpToolUniverse, captured.allowedLocalMcpTools, 'deferred call_tool authority cannot exceed compiled authority');
  assert.deepEqual(captured.requiredLocalMcpTools, [], 'compiled steps never infer required tools from prompt prose');
  assert.equal(captured.nativeMcpToolScope, null, 'a local-only compiled grant cannot attach prompt-inferred native MCP servers');
  for (const forbidden of ['skill_read', 'memory_search', 'memory_remember', 'notify_user', 'workflow_step_result']) {
    assert.equal(captured.allowedLocalMcpTools.includes(forbidden), false, `${forbidden} was not granted by the compiled snapshot`);
  }
});

test('a future compiled project writer cannot inherit the broad SDK worker profile', async () => {
  let captured: any;
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    captured = options;
    return {
      text: '{"status":"completed","output":{"document":"report.docx"}}',
      structuredOutput: { status: 'completed', output: { document: 'report.docx' } },
      sessionId: 'sdk-compiled-write-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__project_artifact_write'],
    };
  });

  const compiledWriteStep = {
    id: 'render_report',
    prompt: 'Use run_shell_command and write_file, then notify me when the report is ready.',
    sideEffect: 'write' as const,
    allowedTools: [
      ' workspace_artifact_query ',
      'project_artifact_write',
      'project_artifact_write',
      'workflow_step_result',
    ],
    __compiledProjectRuntime: true as const,
  };
  const result = await runClaudeAgentSdkWorkflowStep({
    step: compiledWriteStep as any,
    workflowName: 'compiled-project-write',
    prompt: compiledWriteStep.prompt,
    modelId: 'claude-sonnet-4-6',
    sessionId: 'workflow:compiled-write:render_report',
    fullLane: true,
  });

  assert.deepEqual(result.output, { document: 'report.docx' });
  assert.equal(captured.agentic, true);
  assert.deepEqual(captured.allowedLocalMcpTools, ['workspace_artifact_query', 'project_artifact_write']);
  assert.deepEqual(captured.mcpToolAllowlist, captured.allowedLocalMcpTools);
  assert.deepEqual(captured.localMcpToolUniverse, captured.allowedLocalMcpTools);
  assert.deepEqual(captured.requiredLocalMcpTools, [], 'prompt mentions cannot widen or hard-require compiled authority');
  for (const forbidden of ['produce_document', 'run_shell_command', 'write_file', 'notify_user', 'composio_execute_tool', 'dispatch_background_task']) {
    assert.equal(captured.allowedLocalMcpTools.includes(forbidden), false, `${forbidden} did not leak in from the worker profile or prompt`);
  }
});

test('ordinary catalog workflow steps retain the legacy SDK profile and prompt inference', async () => {
  let captured: any;
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    captured = options;
    return {
      text: '{"status":"completed","output":{"ok":true}}',
      structuredOutput: { status: 'completed', output: { ok: true } },
      sessionId: 'sdk-legacy-workflow-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__run_shell_command'],
    };
  });

  const legacyStep = {
    id: 'legacy_send',
    prompt: 'Use run_shell_command to inspect the data, write a file, then notify Alex.',
    sideEffect: 'send' as const,
    // Ordinary workflows historically treat this as a harness lock elsewhere;
    // the Claude SDK caller still receives its worker profile here.
    allowedTools: ['list_files'],
  };
  const result = await runClaudeAgentSdkWorkflowStep({
    step: legacyStep,
    workflowName: 'legacy-catalog-workflow',
    prompt: legacyStep.prompt,
    modelId: 'claude-sonnet-4-6',
    sessionId: 'workflow:legacy:legacy_send',
    fullLane: true,
  });

  assert.deepEqual(result.output, { ok: true });
  for (const legacyTool of ['run_shell_command', 'write_file', 'notify_user', 'memory_search']) {
    assert.equal(captured.allowedLocalMcpTools.includes(legacyTool), true, `${legacyTool} remains in the ordinary worker profile`);
  }
  assert.deepEqual(captured.requiredLocalMcpTools.sort(), ['notify_user', 'run_shell_command', 'write_file']);
  assert.equal(Object.prototype.hasOwnProperty.call(captured, 'mcpToolAllowlist'), false, 'ordinary MCP exposure behavior is unchanged');
  assert.equal(Object.prototype.hasOwnProperty.call(captured, 'localMcpToolUniverse'), false, 'ordinary deferred authority behavior is unchanged');
});

test('auto-continue HALTS when a continuation anti-thrash loop-stops (no thrash cascade) + reports the honest reason', async () => {
  let calls = 0;
  setClaudeAgentSdkWorkflowStepRunForTest(async () => {
    calls += 1;
    // Call 1: budget stop, NOT a loop (selfStopped=false) → the loop is entered.
    // Call 2 (first continuation): anti-thrash LOOP-stop (selfStopped=true) → must HALT,
    // not cascade to the cap (before the fix the while ignored selfStopped and ran 4×).
    const selfStopped = calls >= 2;
    return {
      text: 'partial progress',
      sessionId: 'sdk-workflow-session',
      model: 'claude-sonnet-4-6',
      toolUses: [`mcp__clementine-local__t${calls}`],
      usage: { input_tokens: 1, output_tokens: 1 },
      limitHit: true,
      selfStopped,
    } as any;
  });

  const result = await runClaudeAgentSdkWorkflowStep({
    step,
    workflowName: 'Report Workflow',
    prompt: 'Workflow: Report Workflow\nStep: design_report\n\nDesign the report.',
    modelId: 'claude-sonnet-4-6',
  });

  assert.equal(calls, 2, 'initial run + ONE continuation that loop-stopped, then HALT — no cascade to the cap');
  assert.equal((result.output as any).blocked, true, 'a loop-stopped step blocks (self-heal handles it)');
  assert.match((result.output as any).reason, /loop/i, 'the honest anti-thrash reason is surfaced, not the generic budget message');
});

test('a reasoning-burn step (budget spent, ZERO tool calls) gets ONE action-forcing continuation, then blocks if still empty', async () => {
  // Regression: before this, the auto-continue loop required toolUses.length > 0,
  // so a step that spent its whole budget thinking without acting dead-ended
  // straight to needs-attention — a hard STOP, the opposite of long-running.
  let calls = 0;
  const prompts: string[] = [];
  setClaudeAgentSdkWorkflowStepRunForTest(async (opts: any) => {
    calls += 1;
    prompts.push(String(opts?.prompt ?? ''));
    return {
      text: 'let me think about how to approach this...',
      sessionId: 'sdk-workflow-session',
      model: 'claude-sonnet-4-6',
      toolUses: [], // pure reasoning burn — never acted
      usage: { input_tokens: 1, output_tokens: 1 },
      limitHit: true,
      selfStopped: false,
    } as any;
  });

  const result = await runClaudeAgentSdkWorkflowStep({
    step,
    workflowName: 'Report Workflow',
    prompt: 'Workflow: Report Workflow\nStep: design_report\n\nDesign the report.',
    modelId: 'claude-sonnet-4-6',
  });

  assert.equal(calls, 2, 'initial run + EXACTLY ONE zero-tool continuation — not zero (dead-end) and not a budget-looping cascade');
  assert.match(prompts[1], /without taking a single action|Act, do not narrate/, 'the continuation FORCES action, not a generic "keep going"');
  assert.equal((result.output as any).blocked, true, 'still-empty after the one nudge blocks honestly for self-heal to re-queue');
});

test('a reasoning-burn step that ACTS on the nudge converges instead of blocking', async () => {
  let calls = 0;
  setClaudeAgentSdkWorkflowStepRunForTest(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        text: 'thinking...',
        sessionId: 'sdk-workflow-session',
        model: 'claude-sonnet-4-6',
        toolUses: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        limitHit: true,
        selfStopped: false,
      } as any;
    }
    // The nudge converted thinking into action and finished cleanly.
    return {
      text: 'done',
      sessionId: 'sdk-workflow-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
      usage: { input_tokens: 1, output_tokens: 1 },
      limitHit: false,
      selfStopped: false,
      structured: true,
      output: { report: 'ok' },
    } as any;
  });

  const result = await runClaudeAgentSdkWorkflowStep({
    step,
    workflowName: 'Report Workflow',
    prompt: 'Design the report.',
    modelId: 'claude-sonnet-4-6',
  });

  assert.equal(calls, 2, 'the nudge ran exactly once and the step converged');
  assert.notEqual((result.output as any)?.blocked, true, 'a step that acted on the nudge is NOT dead-ended');
});

test('renderClaudeAgentWorkflowStepSystemAppend full lane permits gated execution tools (no read-only boundary)', () => {
  const prompt = renderClaudeAgentWorkflowStepSystemAppend({ workflowName: 'Report Workflow', step, fullLane: true });
  assert.doesNotMatch(prompt, /READ-ONLY\/local-context/);
  assert.match(prompt, /FULL gated lane/);
  assert.match(prompt, /composio_execute_tool/);
  assert.match(prompt, /run_shell_command/);
  assert.match(prompt, /harness gate chain/);
  assert.match(prompt, /call `skill_read`/);
  // Move 3 / adoption: the full (data-tool) lane carries the code-mode batch-shape
  // steer so a multi-fetch step aggregates through run_tool_program.
  assert.match(prompt, /BATCH-SHAPE RULE/);
  assert.match(prompt, /run_tool_program/);
});

test('renderClaudeAgentWorkflowStepSystemAppend read-only lane omits the code-mode batch-shape rule (no send/write tools to steer)', () => {
  const prompt = renderClaudeAgentWorkflowStepSystemAppend({ workflowName: 'Report Workflow', step, fullLane: false });
  assert.doesNotMatch(prompt, /BATCH-SHAPE RULE/);
});

test('requiredLocalMcpToolsForWorkflowStep detects Salesforce CLI and notification requirements', () => {
  const salesforceStep = {
    id: 'main',
    sideEffect: 'send' as const,
    prompt: 'Use the authenticated Salesforce CLI via run_shell_command: sf data query --query "SELECT Id FROM Event" --json. Notify Alex with the results.',
  };
  const tools = requiredLocalMcpToolsForWorkflowStep(salesforceStep, true);
  assert.ok(tools.includes('run_shell_command'));
  assert.ok(tools.includes('notify_user'));
  assert.deepEqual(requiredLocalMcpToolsForWorkflowStep(salesforceStep, false), []);
});

test('requiredLocalMcpToolsForWorkflowStep routes configured user aliases to notify_user', () => {
  process.env.OWNER_NAME = 'Jordan Kim';
  assert.ok(requiredLocalMcpToolsForWorkflowStep({
    id: 'owner_update',
    sideEffect: 'send' as const,
    prompt: 'Send Jordan the completed report.',
  }, true).includes('notify_user'), 'first-name alias from OWNER_NAME is recognized');

  process.env.OWNER_NAME = '';
  saveUserProfile({ displayName: 'Taylor Morgan', preferredName: 'Tay' });
  assert.ok(requiredLocalMcpToolsForWorkflowStep({
    id: 'profile_update',
    sideEffect: 'send' as const,
    prompt: 'Email the completed report to Tay.',
  }, true).includes('notify_user'), 'preferred profile name is recognized');

  assert.ok(!requiredLocalMcpToolsForWorkflowStep({
    id: 'external_recipient',
    sideEffect: 'send' as const,
    prompt: 'Email the completed report to Riley.',
  }, true).includes('notify_user'), 'an unrelated named recipient is not treated as the configured user');
});

test('requiredLocalMcpToolsForWorkflowStep does not promote every allowed tool to a hard requirement', () => {
  const discoveryStep = {
    id: 'find_official_page',
    sideEffect: 'read' as const,
    allowedTools: ['composio_execute_tool', 'composio_search_tools'],
    prompt: 'Find the official public Facebook page. Expected official page: https://www.facebook.com/corp.example unless evidence shows otherwise.',
  };
  assert.deepEqual(
    requiredLocalMcpToolsForWorkflowStep(discoveryStep, true),
    [],
    'allowedTools are permissions; optional discovery tools must not block a step before it can use deterministic evidence',
  );
});

test('requiredLocalMcpToolsForWorkflowStep still requires explicit Composio execution/search paths', () => {
  const scrapeStep = {
    id: 'scrape_and_analyze',
    sideEffect: 'read' as const,
    prompt: 'Use Composio tool APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS with actorId apify/facebook-posts-scraper.',
  };
  assert.deepEqual(requiredLocalMcpToolsForWorkflowStep(scrapeStep, true), ['composio_execute_tool']);

  const discoverStep = {
    id: 'discover_tool',
    sideEffect: 'read' as const,
    prompt: 'Use composio_search_tools to discover the right Google Sheets action.',
  };
  assert.deepEqual(requiredLocalMcpToolsForWorkflowStep(discoverStep, true), ['composio_search_tools']);
});

test('requiredLocalMcpToolsForWorkflowStep does not equate every send step with notify_user', () => {
  const emailStep = {
    id: 'send_daily_email',
    sideEffect: 'send' as const,
    prompt: 'Use Composio tool GMAIL_SEND_EMAIL to send the daily standup email.',
  };
  assert.deepEqual(requiredLocalMcpToolsForWorkflowStep(emailStep, true), ['composio_execute_tool']);
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
    parkApprovals: true,
  });

  assert.deepEqual(result.output, { report: 'did the real work' });
  assert.equal(captured.agentic, true, 'full lane runs in agentic (gated-mutation) mode');
  assert.equal(captured.maxTurns, 24, 'full lane gets brain-level turn headroom (not the read-only 6)');
  assert.equal(captured.sessionId, 'workflow:run-xyz:scrape', 'gated tools run on the workflow session for plan-scope grants');
  assert.equal(captured.approvalMode, 'park', 'workflow runner can release the SDK child while a concrete approval waits');
  assert.ok(captured.allowedLocalMcpTools.includes('composio_search_tools'), 'composio search exposed for action discovery');
  assert.ok(captured.allowedLocalMcpTools.includes('composio_list_tools'), 'composio list exposed for schema discovery');
  assert.ok(captured.allowedLocalMcpTools.includes('composio_execute_tool'), 'composio exposed for external read/write');
  assert.ok(captured.allowedLocalMcpTools.includes('run_shell_command'), 'shell exposed (gated)');
  assert.ok(captured.allowedLocalMcpTools.includes('write_file'), 'file write exposed (gated)');
  assert.ok(captured.allowedLocalMcpTools.includes('notify_user'), 'notify_user exposed so notify/report steps can deliver');
  assert.deepEqual(captured.requiredLocalMcpTools, [], 'generic full-lane steps do not over-require every possible tool');
  // Workflow authoring stays out of a step lane even in full mode.
  assert.equal(captured.allowedLocalMcpTools.includes('execution_create'), false);
});

test('runClaudeAgentSdkWorkflowStep requires and exposes Composio discovery for DataForSEO workflow steps', async () => {
  let captured: any;
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    captured = options;
    return {
      text: '{"status":"completed","output":{"accounts":[]}}',
      structuredOutput: { status: 'completed', output: { accounts: [] } },
      sessionId: 'sdk-workflow-session',
      model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__composio_search_tools'],
    };
  });

  const seoStep = {
    id: 'enrich_missing_seo_once',
    sideEffect: 'read' as const,
    prompt: 'Use composio_search_tools to discover the DataForSEO action, then use Composio tool DATAFORSEO_GET_BACKLINKS_SUMMARY_LIVE when SEO is missing.',
  };
  const result = await runClaudeAgentSdkWorkflowStep({
    step: seoStep,
    workflowName: 'morning-prospect-prep',
    prompt: seoStep.prompt,
    modelId: 'claude-sonnet-5',
    sessionId: 'workflow:run-prospect:enrich_missing_seo_once',
    fullLane: true,
  });

  assert.deepEqual(result.output, { accounts: [] });
  assert.ok(captured.allowedLocalMcpTools.includes('composio_search_tools'));
  assert.ok(captured.allowedLocalMcpTools.includes('composio_execute_tool'));
  assert.deepEqual(captured.requiredLocalMcpTools.sort(), ['composio_execute_tool', 'composio_search_tools']);
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
    prompt: 'Use run_shell_command to execute sf data query --query "SELECT Id FROM Event" --json, then notify Alex.',
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
      prompt: 'Use run_shell_command to execute sf data query --json, then notify Alex.',
      sideEffect: 'send' as const,
    },
    workflowName: 'daily-overdue-salesforce-meetings',
    prompt: 'Use run_shell_command to execute sf data query --json, then notify Alex.',
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
      workflowName: 'acme-facebook-trends',
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
  // Isolate the pure block-conversion path (F3 auto-continue off) — a permanently
  // limited step's auto-continue behavior is covered by the F3 tests below.
  process.env.CLEMMY_CLAUDE_SDK_WORKFLOW_STEP_AUTO_CONTINUE = 'off';
  setClaudeAgentSdkWorkflowStepRunForTest(async () => ({
    text: 'I reached the turn budget. Say "continue" to keep going.',
    limitHit: true,
    sessionId: 'sdk-workflow-session',
    model: 'claude-sonnet-4-6',
    toolUses: ['mcp__clementine-local__skill_read'],
    usage: { input_tokens: 12, output_tokens: 4 },
    modelUsage: { provider: 'claude', model: 'claude-sonnet-4-6' },
  }));

  try {
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
  } finally {
    delete process.env.CLEMMY_CLAUDE_SDK_WORKFLOW_STEP_AUTO_CONTINUE;
  }
});

test('F3: a workflow step that hits its turn budget WITH progress auto-continues and finishes (not blocked)', async () => {
  let calls = 0;
  const seen: Array<{ sourceUserSeq?: number; shouldCancel?: unknown }> = [];
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    calls += 1;
    seen.push({ sourceUserSeq: options.sourceUserSeq, shouldCancel: options.shouldCancel });
    if (calls === 1) {
      // Made tool progress but hit the per-query turn cap.
      return { text: 'partial: did 2 of 5', sessionId: 's', model: 'claude-sonnet-5', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: true };
    }
    return {
      text: '{"status":"completed","output":{"report":"all 5 done"}}',
      structuredOutput: { status: 'completed', output: { report: 'all 5 done' } },
      sessionId: 's', model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: false,
    };
  });
  const shouldCancel = () => false;
  const result = await runClaudeAgentSdkWorkflowStep({
    step,
    workflowName: 'WF',
    prompt: 'do 5 items',
    modelId: 'claude-sonnet-5',
    fullLane: true,
    sourceUserSeq: 73,
    shouldCancel,
  });
  assert.equal(calls, 2, 'auto-continued once past the step turn budget');
  assert.deepEqual(seen, [
    { sourceUserSeq: 73, shouldCancel },
    { sourceUserSeq: 73, shouldCancel },
  ], 'the exact attempt source and stop hook survive SDK auto-continuation');
  assert.deepEqual(result.output, { report: 'all 5 done' }, 'finished — not blocked on turn budget');
  assert.notEqual((result.output as { blocked?: boolean }).blocked, true);
});

test('workflow SDK continuations rotate physical leases and revoke the winner on completion', async () => {
  const eventlog = await import('./eventlog.js');
  const leases = await import('./dispatch-lease.js');
  const session = eventlog.createSession({ kind: 'workflow' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: 'wf-lease-run' });
  const seen: NonNullable<Parameters<typeof leases.isDispatchLeaseCurrent>[0]>[] = [];
  let calls = 0;
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    calls += 1;
    assert.ok(options.dispatchLease, 'production workflow attempt installs a physical dispatch lease');
    assert.equal(leases.isDispatchLeaseCurrent(options.dispatchLease), true);
    if (seen[0]) assert.equal(leases.isDispatchLeaseCurrent(seen[0]), false, 'continuation starts only after prior revoke');
    seen.push(options.dispatchLease);
    if (calls === 1) {
      return {
        text: 'partial',
        sessionId: 'sdk-step',
        model: 'claude-sonnet-5',
        toolUses: ['mcp__clementine-local__read_file'],
        limitHit: true,
      };
    }
    return {
      text: '{"status":"completed","output":{"ok":true}}',
      structuredOutput: { status: 'completed', output: { ok: true } },
      sessionId: 'sdk-step',
      model: 'claude-sonnet-5',
      toolUses: [],
      limitHit: false,
    };
  });

  try {
    const result = await runClaudeAgentSdkWorkflowStep({
      step,
      workflowName: 'WF Lease',
      prompt: 'finish the step',
      modelId: 'claude-sonnet-5',
      sessionId: session.id,
      runAttemptId: attempt.attemptId,
      fullLane: true,
    });
    assert.deepEqual(result.output, { ok: true });
    assert.equal(calls, 2);
    assert.notEqual(seen[0].leaseId, seen[1].leaseId);
    assert.equal(leases.isDispatchLeaseCurrent(seen[1]), false, 'successful return revoked the final query');
  } finally {
    eventlog.finishRunAttempt(attempt, 'completed');
  }
});

test('workflow SDK approval park revokes dispatch before returning control to the runner', async () => {
  const eventlog = await import('./eventlog.js');
  const leases = await import('./dispatch-lease.js');
  const session = eventlog.createSession({ kind: 'workflow' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: 'wf-park-lease-run' });
  let captured: Parameters<typeof leases.isDispatchLeaseCurrent>[0];
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    captured = options.dispatchLease;
    assert.equal(leases.isDispatchLeaseCurrent(captured), true);
    throw new sdkMod.ClaudeAgentSdkApprovalBoundaryError({
      approvalId: 'apr-workflow-lease',
      sessionId: session.id,
      tool: 'composio_execute_tool',
      args: { tool_slug: 'GMAIL_SEND_EMAIL' },
      state: 'pending',
    });
  });

  try {
    await assert.rejects(
      () => runClaudeAgentSdkWorkflowStep({
        step,
        workflowName: 'WF Lease',
        prompt: 'send the approved message',
        modelId: 'claude-sonnet-5',
        sessionId: session.id,
        runAttemptId: attempt.attemptId,
        fullLane: true,
        parkApprovals: true,
      }),
      (err: unknown) => err instanceof sdkMod.ClaudeAgentSdkApprovalBoundaryError,
    );
    assert.ok(captured);
    assert.equal(leases.isDispatchLeaseCurrent(captured), false);
  } finally {
    eventlog.finishRunAttempt(attempt, 'interrupted');
  }
});

test('F3: cancellation during SDK auto-continue is re-thrown, never converted to prior partial output', async () => {
  const eventlog = await import('./eventlog.js');
  const leases = await import('./dispatch-lease.js');
  const session = eventlog.createSession({ kind: 'workflow' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: 'wf-cancel-lease-run' });
  let calls = 0;
  const seen: NonNullable<Parameters<typeof leases.isDispatchLeaseCurrent>[0]>[] = [];
  setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
    calls += 1;
    assert.ok(options.dispatchLease);
    seen.push(options.dispatchLease);
    if (calls === 1) {
      return {
        text: 'partial progress',
        sessionId: 's',
        model: 'claude-sonnet-5',
        toolUses: ['mcp__clementine-local__skill_read'],
        limitHit: true,
      };
    }
    throw new AgentRuntimeCancelledError('Run cancelled by caller.');
  });

  await assert.rejects(
    () => runClaudeAgentSdkWorkflowStep({
      step,
      workflowName: 'WF',
      prompt: 'continue a long step',
      modelId: 'claude-sonnet-5',
      sessionId: session.id,
      runAttemptId: attempt.attemptId,
      sourceUserSeq: 88,
      shouldCancel: () => true,
    }),
    (err: unknown) => err instanceof AgentRuntimeCancelledError,
  );
  assert.equal(calls, 2, 'the stop lands on the first continuation and is not retried/swallowed');
  assert.equal(seen.every((lease) => !leases.isDispatchLeaseCurrent(lease)), true);
  eventlog.finishRunAttempt(attempt, 'cancelled');
});

test('F3: a limit-hit step with NO tool progress gets ONE action-forcing nudge, then BLOCKS (bounded — never loops the budget)', async () => {
  // Evolved from "block immediately" to "one action-forcing nudge, then block":
  // a reasoning burn dead-ending straight to needs-attention is a hard STOP,
  // against the long-running directive. The nudge is capped at one shot, so the
  // anti-loop invariant (no cascade) is preserved — asserted by calls === 2.
  let calls = 0;
  setClaudeAgentSdkWorkflowStepRunForTest(async () => { calls += 1; return { text: 'stuck', sessionId: 's', toolUses: [], limitHit: true }; });
  const result = await runClaudeAgentSdkWorkflowStep({ step, workflowName: 'WF', prompt: 'x', modelId: 'claude-sonnet-5', fullLane: true });
  assert.equal(calls, 2, 'exactly one action-forcing nudge to convert a reasoning burn, then STOP re-running (bounded, no loop)');
  assert.equal((result.output as { blocked?: boolean }).blocked, true, 'still-empty after the one nudge blocks honestly for self-heal');
});

test('F3: kill-switch off ⇒ blocks on the turn budget (prior behavior)', async () => {
  process.env.CLEMMY_CLAUDE_SDK_WORKFLOW_STEP_AUTO_CONTINUE = 'off';
  let calls = 0;
  setClaudeAgentSdkWorkflowStepRunForTest(async () => { calls += 1; return { text: 'partial', sessionId: 's', toolUses: ['x'], limitHit: true }; });
  try {
    const result = await runClaudeAgentSdkWorkflowStep({ step, workflowName: 'WF', prompt: 'x', modelId: 'claude-sonnet-5', fullLane: true });
    assert.equal(calls, 1, 'no auto-continue when off');
    assert.equal((result.output as { blocked?: boolean }).blocked, true);
  } finally {
    delete process.env.CLEMMY_CLAUDE_SDK_WORKFLOW_STEP_AUTO_CONTINUE;
  }
});
