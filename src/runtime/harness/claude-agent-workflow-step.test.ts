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

test('requiredLocalMcpToolsForWorkflowStep does not promote every allowed tool to a hard requirement', () => {
  const discoveryStep = {
    id: 'find_official_page',
    sideEffect: 'read' as const,
    allowedTools: ['composio_execute_tool', 'composio_search_tools'],
    prompt: 'Find the official public Facebook page. Expected official page: https://www.facebook.com/scorpion.co unless evidence shows otherwise.',
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
  });

  assert.deepEqual(result.output, { report: 'did the real work' });
  assert.equal(captured.agentic, true, 'full lane runs in agentic (gated-mutation) mode');
  assert.equal(captured.maxTurns, 24, 'full lane gets brain-level turn headroom (not the read-only 6)');
  assert.equal(captured.sessionId, 'workflow:run-xyz:scrape', 'gated tools run on the workflow session for plan-scope grants');
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
  setClaudeAgentSdkWorkflowStepRunForTest(async () => {
    calls += 1;
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
  const result = await runClaudeAgentSdkWorkflowStep({ step, workflowName: 'WF', prompt: 'do 5 items', modelId: 'claude-sonnet-5', fullLane: true });
  assert.equal(calls, 2, 'auto-continued once past the step turn budget');
  assert.deepEqual(result.output, { report: 'all 5 done' }, 'finished — not blocked on turn budget');
  assert.notEqual((result.output as { blocked?: boolean }).blocked, true);
});

test('F3: a step limit-hit with NO tool progress still BLOCKS (anti-loop)', async () => {
  let calls = 0;
  setClaudeAgentSdkWorkflowStepRunForTest(async () => { calls += 1; return { text: 'stuck', sessionId: 's', toolUses: [], limitHit: true }; });
  const result = await runClaudeAgentSdkWorkflowStep({ step, workflowName: 'WF', prompt: 'x', modelId: 'claude-sonnet-5', fullLane: true });
  assert.equal(calls, 1, 'no auto-continue without tool progress');
  assert.equal((result.output as { blocked?: boolean }).blocked, true, 'blocks honestly on the turn budget');
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
