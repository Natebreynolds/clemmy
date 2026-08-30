import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-workflow-subprocess-containment-'));
process.env.CLEMENTINE_HOME = testHome;

const { validateWorkflowDefinition } = await import('./workflow-validator.js');
const { checkWorkflowRunReadiness } = await import('./workflow-run-readiness.js');
const {
  executeStep,
  WorkflowHarnessBlockedSignal,
  workflowRunnerInternalsForTest,
  _setWorkflowCallNodeForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowWatcherForTests,
} = await import('./workflow-runner.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');

test.after(() => {
  _setWorkflowCallNodeForTests();
  _setWorkflowVoiceRewriteForTests(null);
  _setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));
  rmSync(testHome, { recursive: true, force: true });
});

function workflowContext(step: Record<string, unknown>, slug: string, runId: string) {
  return {
    workflow: {
      name: slug,
      description: 'Production-shaped raw subprocess containment fixture.',
      enabled: true,
      trigger: { manual: true },
      steps: [step],
    },
    workflowSlug: slug,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: {
      async respond() { throw new Error('legacy assistant must not run'); },
    },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
}

test('validator rejects raw deterministic and loop-probe declarations with the typed authority reason', () => {
  const deterministic = validateWorkflowDefinition({
    name: 'retired-deterministic-validator',
    description: 'Script existence is not execution authority.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'run_script',
      prompt: 'Run the local helper.',
      sideEffect: 'read',
      deterministic: { runner: 'run.mjs' },
    }],
  });
  assert.equal(deterministic.ok, false);
  assert.ok(
    deterministic.errors.some((error) => /workflow_raw_subprocess_authority_unrepresented.*deterministic\.runner/i.test(error)),
    deterministic.errors.join('\n'),
  );

  const loopProbe = validateWorkflowDefinition({
    name: 'retired-loop-probe-validator',
    description: 'A script probe cannot own hidden external effects.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'poll',
      prompt: 'Read the current job state.',
      sideEffect: 'read',
      loopUntil: {
        probe: { runner: 'probe.mjs' },
        until: { type: 'object', required_keys: ['done'] },
      },
    }],
  });
  assert.equal(loopProbe.ok, false);
  assert.ok(
    loopProbe.errors.some((error) => /workflow_raw_subprocess_authority_unrepresented.*loopUntil\.probe\.runner/i.test(error)),
    loopProbe.errors.join('\n'),
  );
});

test('readiness refuses legacy declarations even when their script files exist', () => {
  const slug = 'retired-subprocess-readiness';
  const scriptsDir = path.join(WORKFLOWS_DIR, slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'run.mjs'), 'process.stdout.write("{}\\n");\n', 'utf8');
  writeFileSync(path.join(scriptsDir, 'probe.mjs'), 'process.stdout.write("{}\\n");\n', 'utf8');

  const readiness = checkWorkflowRunReadiness({
    name: slug,
    description: 'Existing scripts remain preserved but cannot execute.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'run_script',
        prompt: 'Run the local helper.',
        sideEffect: 'read',
        deterministic: { runner: 'run.mjs' },
      },
      {
        id: 'poll',
        prompt: 'Read the current job state.',
        sideEffect: 'read',
        loopUntil: {
          probe: { runner: 'probe.mjs' },
          until: { type: 'object', required_keys: ['done'] },
        },
      },
    ],
  }, slug);

  assert.equal(readiness.ok, false);
  assert.equal(readiness.blockers.length, 2);
  assert.ok(readiness.blockers.every((item) => item.status === 'missing'));
  assert.ok(readiness.blockers.every((item) => /workflow_raw_subprocess_authority_unrepresented/i.test(item.reason)));
});

test('executeStep refuses a deterministic runner before spawn, approval, or workflow events', async () => {
  const slug = 'retired-deterministic-execute-step';
  const runId = 'retired-deterministic-execute-step-run';
  const marker = path.join(testHome, 'deterministic-execute-step-spawned');
  const scriptsDir = path.join(WORKFLOWS_DIR, slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'run.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.stdout.write('{}\\n');\n`,
    'utf8',
  );
  const step = {
    id: 'run_script',
    prompt: 'Run the local helper.',
    sideEffect: 'read' as const,
    requiresApproval: true,
    deterministic: { runner: 'run.mjs' },
  };

  await assert.rejects(
    executeStep(step, workflowContext(step, slug, runId)),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowHarnessBlockedSignal);
      assert.match(error.reason, /workflow_raw_subprocess_authority_unrepresented.*deterministic\.runner/i);
      return true;
    },
  );
  assert.equal(existsSync(marker), false, 'the runner body never starts');
  const events = readWorkflowEvents(slug, runId);
  assert.equal(events.some((event) => event.kind === 'step_started'), false);
  assert.equal(events.some((event) => event.kind === 'step_completed'), false);
});

test('loop probe refusal occurs before the primary exact call and probe process', async () => {
  const slug = 'retired-loop-probe-execute-step';
  const runId = 'retired-loop-probe-execute-step-run';
  const marker = path.join(testHome, 'loop-probe-spawned');
  const scriptsDir = path.join(WORKFLOWS_DIR, slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'probe.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.stdout.write('{"done":true}\\n');\n`,
    'utf8',
  );
  let primaryCalls = 0;
  _setWorkflowCallNodeForTests(async () => {
    primaryCalls += 1;
    return { status: 'pending' };
  });
  const step = {
    id: 'poll',
    prompt: 'Read the current job state.',
    sideEffect: 'read' as const,
    call: { tool: 'EXACT_READ_FOR_TEST', args: {} },
    loopUntil: {
      maxAttempts: 1,
      probe: { runner: 'probe.mjs' },
      until: { type: 'object' as const, required_keys: ['done'] },
    },
  };
  try {
    await assert.rejects(
      workflowRunnerInternalsForTest.runStepVerifiedAttempt(
        step as never,
        workflowContext(step, slug, runId),
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowHarnessBlockedSignal);
        assert.match(error.reason, /workflow_raw_subprocess_authority_unrepresented.*loopUntil\.probe\.runner/i);
        return true;
      },
    );
  } finally {
    _setWorkflowCallNodeForTests();
  }
  assert.equal(primaryCalls, 0, 'the primary external call never crosses');
  assert.equal(existsSync(marker), false, 'the probe body never starts');
  assert.equal(readWorkflowEvents(slug, runId).some((event) => event.kind === 'step_completed'), false);
});
