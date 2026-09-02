/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-deterministic-runner.test.ts
 *
 * Owner-authored deterministic runners are a first-class lane (reinstated
 * 2026-09-01: "legacy ones still need to be able to run"). The bar is effects,
 * not method: a script under the workflow's own scripts/, bytes pinned to the
 * admitted run, interpreter allowlist, scrubbed env, capped wall clock and
 * output, and the step's output contract enforced before step_completed.
 * A MISSING script is a readiness block that names the file — never a lecture
 * about migration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-workflow-deterministic-runner-'));
process.env.CLEMENTINE_HOME = testHome;

const { validateWorkflowDefinition } = await import('./workflow-validator.js');
const { checkWorkflowRunReadiness } = await import('./workflow-run-readiness.js');
const { executeStep } = await import('./workflow-runner.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');

test.after(() => {
  rmSync(testHome, { recursive: true, force: true });
});

function definition(slug: string, steps: unknown[]) {
  return { name: slug, description: 'owner-authored runner fixture', enabled: true, trigger: { manual: true }, steps } as never;
}

function context(step: Record<string, unknown>, slug: string, runId: string) {
  return {
    workflow: definition(slug, [step]),
    workflowSlug: slug,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { async respond() { throw new Error('the model must not run'); } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
}

test('the validator accepts a present deterministic runner and a loop probe', () => {
  const result = validateWorkflowDefinition({
    name: 'owner-runner-validates',
    description: 'The script is the owner\'s.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'run_script', prompt: '', sideEffect: 'read', deterministic: { runner: 'run.mjs' } },
      { id: 'poll', prompt: 'Read the current job state.', sideEffect: 'read', loopUntil: { probe: { runner: 'probe.mjs' }, until: { type: 'object', required_keys: ['done'] } } },
    ],
  });
  assert.deepEqual(result.errors.filter((error) => /raw_subprocess|retired/i.test(error)), []);
});

test('readiness is the script\'s presence: present runs, missing names the file', () => {
  const slug = 'owner-runner-readiness';
  const scriptsDir = path.join(WORKFLOWS_DIR, slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'run.mjs'), 'process.stdout.write("{}\\n");\n', 'utf8');
  const present = checkWorkflowRunReadiness(definition(slug, [
    { id: 'run_script', prompt: '', sideEffect: 'read', deterministic: { runner: 'run.mjs' } },
  ]), slug);
  assert.equal(present.ok, true, JSON.stringify(present.blockers));
  const missing = checkWorkflowRunReadiness(definition(slug, [
    { id: 'run_script', prompt: '', sideEffect: 'read', deterministic: { runner: 'gone.mjs' } },
  ]), slug);
  assert.equal(missing.ok, false);
  assert.equal(missing.blockers.length, 1);
  assert.equal(missing.blockers[0]!.status, 'missing');
  assert.match(missing.blockers[0]!.name, /gone\.mjs/);
  assert.doesNotMatch(missing.blockers[0]!.reason, /raw_subprocess|migrate/i);
});

test('executeStep runs the owner-authored runner and enforces its output contract', async () => {
  const slug = 'owner-runner-execute-step';
  const scriptsDir = path.join(WORKFLOWS_DIR, slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const marker = path.join(testHome, 'owner-runner-execute-step-spawned');
  writeFileSync(
    path.join(scriptsDir, 'good.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.stdout.write(JSON.stringify({ summary: 'team summary' }) + '\\n');\n`,
    'utf8',
  );
  writeFileSync(path.join(scriptsDir, 'thin.mjs'), 'process.stdout.write("{}\\n");\n', 'utf8');

  const good = { id: 'pull', prompt: '', sideEffect: 'read', deterministic: { runner: 'good.mjs' }, output: { type: 'object', required_keys: ['summary'], non_empty: ['summary'] } };
  const output = await executeStep(good as never, context(good, slug, 'good-run'));
  assert.deepEqual(output, { summary: 'team summary' });
  assert.equal(existsSync(marker), true);
  const goodKinds = readWorkflowEvents(slug, 'good-run').map((event) => event.kind);
  assert.ok(goodKinds.includes('step_started') && goodKinds.includes('step_completed'));

  // The declared output contract is enforced before step_completed.
  const thin = { id: 'pull', prompt: '', sideEffect: 'read', deterministic: { runner: 'thin.mjs' }, output: { type: 'object', required_keys: ['summary'], non_empty: ['summary'] } };
  await assert.rejects(executeStep(thin as never, context(thin, slug, 'thin-run')));
  const thinKinds = readWorkflowEvents(slug, 'thin-run').map((event) => event.kind);
  assert.ok(thinKinds.includes('step_failed'));
  assert.equal(thinKinds.includes('step_completed'), false);

  // A runner outside scripts/ is refused before anything spawns.
  const escape = { id: 'pull', prompt: '', sideEffect: 'read', deterministic: { runner: '../escape.mjs' } };
  await assert.rejects(executeStep(escape as never, context(escape, slug, 'escape-run')));
});
