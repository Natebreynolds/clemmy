#!/usr/bin/env tsx
/**
 * Live smoke: select Claude as the main brain through the Agent SDK, then have
 * it author a local Clementine workflow with a Claude-routed design/report step
 * and an installed skill reference. Runs in an isolated CLEMENTINE_HOME.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expected = 'CLAUDE_AGENT_SDK_BRAIN_WORKFLOW_AUTHORING_OK';
const modelId = process.env.CLEMMY_LIVE_WORKER_MODEL || 'claude-sonnet-4-6';
const workflowName = `Claude Brain Design Report Smoke ${Date.now()}`;
const skillName = 'taste-smoke';

const realHome = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
const realClaudeAuth = path.join(realHome, 'state', 'claude-auth.json');
if (!existsSync(realClaudeAuth)) {
  console.error(`Claude auth not found at ${realClaudeAuth}`);
  process.exit(1);
}

const tmpHome = path.join(os.tmpdir(), `clemmy-claude-sdk-brain-author-${Date.now()}`);
mkdirSync(path.join(tmpHome, 'state'), { recursive: true });
mkdirSync(path.join(tmpHome, 'skills', skillName), { recursive: true });
writeFileSync(path.join(tmpHome, 'state', 'claude-auth.json'), readFileSync(realClaudeAuth, 'utf-8'), 'utf-8');
writeFileSync(
  path.join(tmpHome, 'skills', skillName, 'SKILL.md'),
  [
    '---',
    'name: Taste Smoke',
    'description: Minimal design/report taste skill for Claude brain authoring smoke.',
    '---',
    '',
    '# Taste Smoke',
    '',
    'Reports should be concise, structured, and easy to scan.',
    `For this live smoke, any workflow step using this skill must return {"report":"${expected}"}.`,
  ].join('\n'),
  'utf-8',
);

process.env.CLEMENTINE_HOME = tmpHome;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'on';

try {
  const [{ respondPreferHarness }, { executeStep }, { listEvents }, { listWorkflows }] = await Promise.all([
    import('../src/runtime/harness/respond-bridge.js'),
    import('../src/execution/workflow-runner.js'),
    import('../src/runtime/harness/eventlog.js'),
    import('../src/memory/workflow-store.js'),
  ]);

  const sessionId = `claude-sdk-brain-author-${Date.now()}`;
  const response = await respondPreferHarness(
    'home',
    {
      sessionId,
      channel: 'smoke',
      message: [
        `Create a local Clementine workflow named ${JSON.stringify(workflowName)}.`,
        'Call workflow_create. Do not run the workflow.',
        `Use exactly one step with id "design_report", intent "design", model ${JSON.stringify(modelId)}, usesSkill ${JSON.stringify(skillName)}, sideEffect "read", and an object output contract requiring key "report".`,
        `The step prompt should instruct the worker to design a compact report, call/follow the ${skillName} skill, and return report exactly ${expected}.`,
        `After workflow_create succeeds, reply exactly ${expected} and nothing else.`,
      ].join(' '),
    },
    async () => {
      throw new Error('legacy responder should not be called when Claude SDK brain is enabled');
    },
  );

  if (response.text.trim() !== expected) {
    throw new Error(`unexpected Claude SDK brain authoring response: ${JSON.stringify(response.text.trim())}`);
  }
  const raw = response.raw as { transport?: unknown; mode?: unknown; toolUses?: unknown; model?: unknown; sessionId?: unknown } | undefined;
  if (raw?.transport !== 'claude_agent_sdk_brain' || raw.mode !== 'local_authoring') {
    throw new Error(`unexpected Claude brain raw metadata: ${JSON.stringify(raw)}`);
  }
  const toolUses = Array.isArray(raw.toolUses) ? raw.toolUses : [];
  if (!toolUses.some((tool) => typeof tool === 'string' && tool.endsWith('__workflow_create'))) {
    throw new Error(`Claude SDK brain did not call workflow_create. toolUses=${JSON.stringify(toolUses)}`);
  }

  const workflow = listWorkflows().find((entry) => entry.data.name === workflowName);
  if (!workflow) throw new Error(`workflow was not saved: ${workflowName}`);
  const step = workflow.data.steps.find((item) => item.id === 'design_report');
  if (!step) throw new Error(`design_report step missing: ${JSON.stringify(workflow.data.steps)}`);
  if (step.intent !== 'design') throw new Error(`design_report intent mismatch: ${JSON.stringify(step)}`);
  if (step.model !== modelId) throw new Error(`design_report model mismatch: ${JSON.stringify(step)}`);
  if (step.usesSkill !== skillName) throw new Error(`design_report usesSkill mismatch: ${JSON.stringify(step)}`);
  if (step.sideEffect !== 'read') throw new Error(`design_report sideEffect mismatch: ${JSON.stringify(step)}`);
  if (step.output?.type !== 'object' || !step.output.required_keys?.includes('report')) {
    throw new Error(`design_report output contract mismatch: ${JSON.stringify(step.output)}`);
  }

  const runId = `claude-brain-authored-wf-${Date.now()}`;
  const ctx = {
    workflow: workflow.data,
    workflowSlug: workflow.name,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => { throw new Error('legacy assistant should not be called for Claude-authored design step'); } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
  const stepOutput = await executeStep(step, ctx);
  if ((stepOutput as { report?: unknown }).report !== expected) {
    throw new Error(`Claude-authored workflow step produced unexpected output: ${JSON.stringify(stepOutput)}`);
  }
  const stepSessionId = `workflow:${runId}:design_report`;
  const routed = listEvents(stepSessionId, { types: ['worker_model_routed'] });
  const sdkStepEvent = routed.find((event) => (event.data as { transport?: string }).transport === 'claude_agent_sdk_workflow_step');
  if (!sdkStepEvent) throw new Error('missing claude_agent_sdk_workflow_step event for Claude-authored workflow step');
  const sdkStepData = sdkStepEvent.data as { toolUses?: unknown; sdkModel?: unknown; sdkSessionId?: unknown };
  const stepToolUses = Array.isArray(sdkStepData.toolUses) ? sdkStepData.toolUses : [];

  console.log(JSON.stringify({
    ok: true,
    sentinel: expected,
    sessionId,
    workflow: workflow.data.name,
    model: raw.model,
    sdkSessionId: raw.sessionId,
    toolUses,
    stepOutput,
    stepSdkModel: sdkStepData.sdkModel,
    stepSdkSessionId: sdkStepData.sdkSessionId,
    stepToolUses,
    step,
  }, null, 2));
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
