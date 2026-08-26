import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
  processWorkflowRuns,
  WorkflowHarnessBlockedSignal,
  workflowRunnerInternalsForTest,
  _setWorkflowCallNodeForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowWatcherForTests,
} = await import('./workflow-runner.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

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

test('validator rejects deterministic runners and loop probe runners until shared exact authority exists', () => {
  const deterministic = validateWorkflowDefinition({
    name: 'retired-deterministic-validator',
    description: 'The script exists, but existence is not execution authority.',
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
    deterministic.errors.some((error) => /deterministic\.runner.*shared exact authority/i.test(error)),
    deterministic.errors.join('\n'),
  );

  const loopProbe = validateWorkflowDefinition({
    name: 'retired-loop-probe-validator',
    description: 'A local probe cannot independently own provider or filesystem effects.',
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
    loopProbe.errors.some((error) => /loopUntil\.probe\.runner.*shared exact authority/i.test(error)),
    loopProbe.errors.join('\n'),
  );
});

test('run readiness blocks retired subprocess declarations even when both scripts exist', () => {
  const slug = 'retired-subprocess-readiness';
  const scriptsDir = path.join(WORKFLOWS_DIR, slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'run.mjs'), 'process.stdout.write("{}\\n");\n', 'utf8');
  writeFileSync(path.join(scriptsDir, 'probe.mjs'), 'process.stdout.write("{}\\n");\n', 'utf8');

  const readiness = checkWorkflowRunReadiness({
    name: slug,
    description: 'Existing local scripts still lack shared execution authority.',
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
  assert.ok(readiness.blockers.every((item) => /shared exact authority/i.test(item.reason)));
});

test('executeStep refuses a deterministic runner before spawn, approval, or workflow completion events', async () => {
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
      assert.match(error.reason, /deterministic\.runner.*shared exact authority/i);
      return true;
    },
  );
  assert.equal(existsSync(marker), false, 'the retired runner body never starts');
  const events = readWorkflowEvents(slug, runId);
  assert.equal(events.some((event) => event.kind === 'step_started'), false);
  assert.equal(events.some((event) => event.kind === 'step_completed'), false);
});

test('loop probe retirement refuses before the primary step and probe body, with no false completion', async () => {
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
      until: { type: 'object', required_keys: ['done'] },
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
        assert.match(error.reason, /loopUntil\.probe\.runner.*shared exact authority/i);
        return true;
      },
    );
  } finally {
    _setWorkflowCallNodeForTests();
  }
  assert.equal(primaryCalls, 0, 'the primary provider/body lane stays untouched');
  assert.equal(existsSync(marker), false, 'the retired probe body never starts');
  assert.equal(
    readWorkflowEvents(slug, runId).some((event) => event.kind === 'step_completed'),
    false,
  );
});

test('daemon drain blocks a stale persisted deterministic workflow without spawn or false success', async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const slug = `retired-stale-deterministic-${stamp}`;
  const workflowName = `Retired stale deterministic ${stamp}`;
  const runId = `retired-stale-deterministic-run-${stamp}`;
  const marker = path.join(testHome, `${runId}-spawned`);

  writeWorkflow(slug, {
    name: workflowName,
    description: 'Represents a pre-retirement workflow already persisted on disk.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'run_script',
      prompt: 'Run the local helper.',
      sideEffect: 'read',
      deterministic: {
        runner: 'run.mjs',
        source: [
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned');`,
          'process.stdout.write(JSON.stringify({ found: false, kind: "deterministic_source_failure", error: "legacy runner executed" }));',
          'process.exit(1);',
        ].join('\n'),
      },
    }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf8');
  _setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));
  _setWorkflowVoiceRewriteForTests(async (input) => ({
    message: input.fallback,
    nothingHappened: false,
  }));

  await processWorkflowRuns({} as never);

  const terminal = JSON.parse(readFileSync(runFile, 'utf8')) as {
    status?: string;
    error?: string;
    terminalOutcome?: string;
  };
  // Definition preflight preserves the established persisted envelope (`error`)
  // while its canonical terminal/report outcome is blocked. The important
  // release truth is zero body plus no success projection.
  assert.equal(terminal.status, 'error');
  assert.equal(terminal.terminalOutcome, 'blocked');
  assert.match(terminal.error ?? '', /needs edits before it can run/i);
  assert.equal(existsSync(marker), false, 'the stale persisted runner body never starts');
  const events = readWorkflowEvents(slug, runId);
  assert.equal(events.some((event) => event.kind === 'step_completed'), false);
  assert.equal(events.some((event) => event.kind === 'run_completed'), false);
  const failed = events.find((event) => event.kind === 'run_failed');
  assert.ok(failed);
  assert.match(
    JSON.stringify(failed.meta?.preflightErrors ?? []),
    /deterministic\.runner.*shared exact authority/i,
  );
});
