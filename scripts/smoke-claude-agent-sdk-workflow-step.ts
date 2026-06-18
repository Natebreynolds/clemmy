#!/usr/bin/env tsx
/**
 * Live smoke: run a workflow step tagged intent:"design" through the Claude
 * Agent SDK workflow-step lane. This proves a Codex-authored workflow can route
 * a design/report step to Claude under subscription auth, have Claude call the
 * local skill_read MCP tool, and return structured step output.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expected = 'CLAUDE_AGENT_SDK_WORKFLOW_STEP_SKILL_OK';
const realHome = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
const realClaudeAuth = path.join(realHome, 'state', 'claude-auth.json');
if (!existsSync(realClaudeAuth)) {
  console.error(`Claude auth not found at ${realClaudeAuth}`);
  process.exit(1);
}

const tmpHome = path.join(os.tmpdir(), `clemmy-claude-sdk-workflow-step-${Date.now()}`);
mkdirSync(path.join(tmpHome, 'state'), { recursive: true });
mkdirSync(path.join(tmpHome, 'skills', 'claude-workflow-smoke'), { recursive: true });
writeFileSync(path.join(tmpHome, 'state', 'claude-auth.json'), readFileSync(realClaudeAuth, 'utf-8'), 'utf-8');
writeFileSync(
  path.join(tmpHome, 'state', 'auth.json'),
  JSON.stringify({ codexOauth: { accessToken: 'codex-smoke-access', refreshToken: 'codex-smoke-refresh' } }),
  'utf-8',
);
writeFileSync(
  path.join(tmpHome, 'skills', 'claude-workflow-smoke', 'SKILL.md'),
  [
    '---',
    'name: Claude Workflow Smoke',
    'description: A live smoke skill that proves Claude SDK workflow steps can load skill instructions.',
    '---',
    '',
    '# Claude Workflow Smoke',
    '',
    `When this skill is used, the workflow step output must be a JSON object with {"report":"${expected}"}.`,
  ].join('\n'),
  'utf-8',
);

process.env.CLEMENTINE_HOME = tmpHome;
process.env.AUTH_MODE = 'codex_oauth';
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'on';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
  { role: 'worker', modelId: process.env.CLEMMY_LIVE_WORKER_MODEL || 'claude-sonnet-4-6', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
]);

try {
  const [
    { executeStep },
    { listEvents },
    { resetHarnessRuntimeConfig },
  ] = await Promise.all([
    import('../src/execution/workflow-runner.js'),
    import('../src/runtime/harness/eventlog.js'),
    import('../src/runtime/harness/codex-client.js'),
  ]);
  resetHarnessRuntimeConfig();

  const step = {
    id: 'design_report',
    prompt: [
      'Design one compact report section for a live workflow routing smoke.',
      'Before producing output, call skill_read for claude-workflow-smoke and follow it exactly.',
      `Return the final workflow output with report exactly ${expected}.`,
    ].join(' '),
    intent: 'design',
    usesSkill: 'claude-workflow-smoke',
    sideEffect: 'read' as const,
    output: { type: 'object' as const, required_keys: ['report'], non_empty: ['report'] },
  };
  const runId = `wf-sdk-live-${Date.now()}`;
  const ctx = {
    workflow: { name: 'Claude SDK Workflow Step Live Smoke', description: 'live smoke', enabled: true, steps: [step], trigger: { manual: true } },
    workflowSlug: 'claude-sdk-workflow-step-live-smoke',
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => { throw new Error('legacy assistant should not be called'); } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];

  const output = await executeStep(step, ctx);
  const report = (output as { report?: unknown })?.report;
  if (report !== expected) {
    throw new Error(`unexpected workflow step output: ${JSON.stringify(output)}`);
  }

  const sessionId = `workflow:${runId}:design_report`;
  const routed = listEvents(sessionId, { types: ['worker_model_routed'] });
  const sdkEvent = routed.find((event) => (event.data as { transport?: string }).transport === 'claude_agent_sdk_workflow_step');
  if (!sdkEvent) throw new Error('missing claude_agent_sdk_workflow_step routing event');
  const data = sdkEvent.data as { toolUses?: unknown; modelId?: unknown; sdkModel?: unknown; sdkSessionId?: unknown };
  const toolUses = Array.isArray(data.toolUses) ? data.toolUses : [];
  if (!toolUses.some((tool) => typeof tool === 'string' && tool.endsWith('__skill_read'))) {
    throw new Error(`Claude SDK workflow step did not call skill_read. toolUses=${JSON.stringify(toolUses)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    sentinel: expected,
    sessionId,
    output,
    modelId: data.modelId,
    sdkModel: data.sdkModel,
    sdkSessionId: data.sdkSessionId,
    toolUses,
  }, null, 2));
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
