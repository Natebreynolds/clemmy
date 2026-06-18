#!/usr/bin/env tsx
/**
 * Live north-star smoke: ask the Codex brain to author a Clementine workflow
 * whose design/report step runs on Claude and uses a skill, then execute that
 * authored step. Runs in an isolated CLEMENTINE_HOME and spends real model
 * calls through the user's subscription auth.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expected = 'CODEX_BRAIN_CLAUDE_DESIGN_WORKFLOW_OK';
const workerModel = process.env.CLEMMY_LIVE_WORKER_MODEL || 'claude-sonnet-4-6';
const workflowName = `Codex Brain Claude Design Smoke ${Date.now()}`;
const skillName = 'taste-smoke';

const realHome = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
const realCodexAuth = path.join(realHome, 'state', 'auth.json');
const realClaudeAuth = path.join(realHome, 'state', 'claude-auth.json');
if (!existsSync(realCodexAuth)) {
  console.error(`Codex auth not found at ${realCodexAuth}`);
  process.exit(1);
}
if (!existsSync(realClaudeAuth)) {
  console.error(`Claude auth not found at ${realClaudeAuth}`);
  process.exit(1);
}

const tmpHome = path.join(os.tmpdir(), `clemmy-codex-brain-claude-design-${Date.now()}`);
mkdirSync(path.join(tmpHome, 'state'), { recursive: true });
mkdirSync(path.join(tmpHome, 'skills', skillName), { recursive: true });
writeFileSync(path.join(tmpHome, 'state', 'auth.json'), readFileSync(realCodexAuth, 'utf-8'), 'utf-8');
writeFileSync(path.join(tmpHome, 'state', 'claude-auth.json'), readFileSync(realClaudeAuth, 'utf-8'), 'utf-8');
writeFileSync(
  path.join(tmpHome, 'skills', skillName, 'SKILL.md'),
  [
    '---',
    'name: Taste Smoke',
    'description: Minimal design/report taste skill for Codex brain to Claude worker workflow smoke.',
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
process.env.AUTH_MODE = 'codex_oauth';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'on';
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
  { role: 'worker', modelId: workerModel, whenIntent: 'design', scope: 'durable', source: 'smoke' },
]);

try {
  const [
    { respondPreferHarness },
    { executeStep },
    { buildOrchestratorAgent },
    { listEvents },
    { resumePendingApproval },
    { listWorkflows },
  ] = await Promise.all([
    import('../src/runtime/harness/respond-bridge.js'),
    import('../src/execution/workflow-runner.js'),
    import('../src/agents/orchestrator.js'),
    import('../src/runtime/harness/eventlog.js'),
    import('../src/runtime/harness/loop.js'),
    import('../src/memory/workflow-store.js'),
  ]);

  const sessionId = `codex-brain-claude-design-${Date.now()}`;
  const response = await respondPreferHarness(
    'home',
    {
      sessionId,
      channel: 'smoke',
      maxWallClockMs: 120_000,
      message: [
        'Live smoke with full details supplied: create the local Clementine workflow now; do not ask a clarifying question.',
        `Create a workflow named ${JSON.stringify(workflowName)} using workflow_create.`,
        'Do not run the workflow from chat.',
        `Use exactly one step with id "design_report", intent "design", usesSkill ${JSON.stringify(skillName)}, sideEffect "read", and an object output contract requiring key "report".`,
        `The design_report prompt must say to follow ${skillName} and return report exactly ${expected}.`,
        `Because the design worker role is already bound to ${workerModel} for intent "design", tag the step with intent "design"; an explicit model ${JSON.stringify(workerModel)} is also acceptable.`,
        'After workflow_create succeeds, briefly say the workflow was created.',
      ].join(' '),
    },
    async () => {
      throw new Error('legacy responder should not be called for Codex brain smoke');
    },
  );

  if (response.pendingApprovalId) {
    const resumeAgent = await buildOrchestratorAgent({
      sessionId,
      userInput: `approve ${response.pendingApprovalId}`,
      mcpToolScope: {
        reason: 'live smoke: local workflow authoring only',
        allowedServerSlugs: [],
        maxTools: 0,
      },
    });
    const resumed = await resumePendingApproval({
      sessionId,
      agent: resumeAgent,
      decision: 'approve',
      resolver: 'codex-brain-claude-design-smoke',
      maxTurns: 8,
    });
    if (resumed.status !== 'completed' && resumed.status !== 'awaiting_user_input') {
      throw new Error(`approval resume did not complete workflow_create: ${JSON.stringify(resumed)}`);
    }
  }

  const workflow = listWorkflows().find((entry) => entry.data.name === workflowName);
  if (!workflow) {
    throw new Error(`Codex brain did not save the workflow. response=${JSON.stringify(response.text)}`);
  }
  const step = workflow.data.steps.find((item) => item.id === 'design_report');
  if (!step) throw new Error(`design_report step missing: ${JSON.stringify(workflow.data.steps)}`);
  if (step.intent !== 'design') throw new Error(`design_report intent mismatch: ${JSON.stringify(step)}`);
  if (step.model && step.model !== workerModel) throw new Error(`design_report model mismatch: ${JSON.stringify(step)}`);
  if (step.usesSkill !== skillName) throw new Error(`design_report usesSkill mismatch: ${JSON.stringify(step)}`);
  if (step.sideEffect !== 'read') throw new Error(`design_report sideEffect mismatch: ${JSON.stringify(step)}`);
  if (step.output?.type !== 'object' || !step.output.required_keys?.includes('report')) {
    throw new Error(`design_report output contract mismatch: ${JSON.stringify(step.output)}`);
  }

  const runId = `codex-authored-claude-design-${Date.now()}`;
  const ctx = {
    workflow: workflow.data,
    workflowSlug: workflow.name,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => { throw new Error('legacy assistant should not be called for Codex-authored Claude design step'); } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
  const stepOutput = await executeStep(step, ctx);
  if ((stepOutput as { report?: unknown }).report !== expected) {
    throw new Error(`Codex-authored Claude design step produced unexpected output: ${JSON.stringify(stepOutput)}`);
  }

  const stepSessionId = `workflow:${runId}:design_report`;
  const routed = listEvents(stepSessionId, { types: ['worker_model_routed'] });
  const sdkStepEvent = routed.find((event) => (event.data as { transport?: string }).transport === 'claude_agent_sdk_workflow_step');
  if (!sdkStepEvent) throw new Error('missing claude_agent_sdk_workflow_step event for Codex-authored workflow step');
  const sdkStepData = sdkStepEvent.data as { modelId?: unknown; provider?: unknown; toolUses?: unknown; sdkModel?: unknown; sdkSessionId?: unknown };
  if (sdkStepData.modelId !== workerModel) throw new Error(`expected modelId=${workerModel}, got ${String(sdkStepData.modelId)}`);
  const stepToolUses = Array.isArray(sdkStepData.toolUses) ? sdkStepData.toolUses : [];

  console.log(JSON.stringify({
    ok: true,
    sentinel: expected,
    sessionId,
    response: response.text,
    workflow: workflow.data.name,
    step,
    stepOutput,
    routed: {
      modelId: sdkStepData.modelId,
      provider: sdkStepData.provider,
      sdkModel: sdkStepData.sdkModel,
      sdkSessionId: sdkStepData.sdkSessionId,
      toolUses: stepToolUses,
    },
  }, null, 2));
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
