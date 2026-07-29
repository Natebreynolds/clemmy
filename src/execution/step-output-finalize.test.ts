/**
 * Run: npx tsx --test src/execution/step-output-finalize.test.ts
 *
 * Integration coverage for finalizeStepOutput now that contract verification
 * is UNCONDITIONAL (the WORKFLOW_CONTRACT_OUTPUT flag was removed). Asserts the
 * three guarantees that matter for "workflows run correct":
 *   1. A declared contract is verified BEFORE step_completed is recorded.
 *   2. A contract failure emits step_failed + throws and NEVER emits
 *      step_completed (so computeResumeState can't feed bad output downstream).
 *   3. A step with no declared contract is unverified (byte-identical to before).
 * verifyStepOutput's check matrix is covered separately in step-output-verify.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'clementine-finalize-test-'));
process.env.CLEMENTINE_HOME = tmp;
process.env.HOME = tmp;
// Prove the flag is gone: even explicitly OFF, verification must still run.
process.env.WORKFLOW_CONTRACT_OUTPUT = 'off';

const {
  finalizeStepOutput,
  _setAfterStepArtifactPersistForTests,
} = await import('./workflow-runner.js');
const { computeResumeState, readWorkflowEvents } = await import('./workflow-events.js');
const {
  readStepOutputArtifact,
  readWorkspaceManifest,
} = await import('./workflow-run-workspace.js');

test.afterEach(() => {
  _setAfterStepArtifactPersistForTests(null);
});

const WF = 'finalize-test-wf';
let n = 0;
const nextRun = () => `run-${++n}`;
const kinds = (run: string) => readWorkflowEvents(WF, run).map((e) => e.kind);

test('contract + valid output → verified, step_completed recorded, no throw', () => {
  const run = nextRun();
  const step = { id: 's1', prompt: 'p', output: { type: 'object' as const, required_keys: ['url'] } };
  const out = finalizeStepOutput(WF, run, step, { url: 'https://site.example', extra: 1 });
  assert.deepEqual(out, { url: 'https://site.example', extra: 1 });
  const k = kinds(run);
  assert.ok(k.includes('step_completed'), 'step_completed recorded');
  assert.ok(!k.includes('step_failed'), 'no step_failed');
});

test('contract FAIL → throws, step_failed recorded, step_completed NEVER recorded (resume credibility)', () => {
  const run = nextRun();
  const step = { id: 's2', prompt: 'p', output: { type: 'object' as const, required_keys: ['url'] } };
  assert.throws(
    () => finalizeStepOutput(WF, run, step, { notUrl: 'oops' }),
    /failed its contract/,
  );
  const k = kinds(run);
  assert.ok(k.includes('step_failed'), 'step_failed recorded');
  assert.ok(!k.includes('step_completed'), 'step_completed must NOT be recorded for a contract-failed step');
});

test('contracted step that BLOCKS ({blocked:true}) is NOT masked as a contract failure — surfaces as a blocked step with its reason', () => {
  const run = nextRun();
  const step = { id: 'sb', prompt: 'p', output: { type: 'object' as const, required_keys: ['created_records', 'airtable_table_url'] } };
  // The live add_to_airtable case: it blocked (nothing to add) and the contract
  // verifier masked it as "missing required key". Now it must pass through as a
  // completed-but-blocked step so the run reports the REASON, not a contract error.
  const blocked = { blocked: true, reason: 'no prospects to add — Salesforce connection expired' };
  const out = finalizeStepOutput(WF, run, step, blocked);
  assert.deepEqual(out, blocked, 'the blocked output flows through (downstream + detectBlockedSteps surface the reason)');
  const k = kinds(run);
  assert.ok(k.includes('step_completed'), 'recorded as step_completed (the run-level self-heal then flags needs-attention)');
  assert.ok(!k.includes('step_failed'), 'a legitimate block must NOT be a contract failure');
});

test('verification is UNCONDITIONAL — fires even with WORKFLOW_CONTRACT_OUTPUT=off (flag removed)', () => {
  const run = nextRun();
  const step = { id: 's3', prompt: 'p', output: { type: 'number' as const } };
  // env flag is set to 'off' at top-of-file; verification must still catch this.
  assert.throws(() => finalizeStepOutput(WF, run, step, 'not-a-number'), /failed its contract/);
  assert.ok(kinds(run).includes('step_failed'));
});

test('no declared contract → no verification, step_completed recorded (backward-compatible)', () => {
  const run = nextRun();
  const step = { id: 's4', prompt: 'p' }; // no `output` contract
  const out = finalizeStepOutput(WF, run, step, { anything: true });
  assert.deepEqual(out, { anything: true });
  const k = kinds(run);
  assert.ok(k.includes('step_completed'));
  assert.ok(!k.includes('step_failed'));
});

test('synthesis-shape step with url_present contract + no URL → fails the final deliverable loudly', () => {
  const run = nextRun();
  const step = { id: '__synthesis__', prompt: 'p', output: { verify: { url_present: ['url'] } } };
  assert.throws(
    () => finalizeStepOutput(WF, run, step, { summary: 'done!', url: '' }),
    /failed its contract/,
  );
  assert.ok(kinds(run).includes('step_failed'));
});

test('artifact-first completion survives the crash window without authorizing truncated data', () => {
  const run = nextRun();
  const step = { id: 'large-source', prompt: 'produce exact rows' };
  const marker = 'ROW-BEYOND-EVENT-PREVIEW-MUST-SURVIVE';
  const output = {
    rows: Array.from({ length: 500 }, (_, index) => ({
      index,
      value: `${'x'.repeat(90)}${index === 499 ? marker : ''}`,
    })),
  };

  _setAfterStepArtifactPersistForTests(() => {
    throw new Error('simulated process death after artifact fsync');
  });
  assert.throws(
    () => finalizeStepOutput(WF, run, step, output),
    /simulated process death/,
  );

  assert.equal(
    computeResumeState(WF, run).completedSteps.has(step.id),
    false,
    'an orphan artifact is never completion authority',
  );
  const orphan = readWorkspaceManifest(WF, run)
    .find((entry) => entry.tool === 'step-output' && entry.agent === step.id);
  assert.ok(orphan?.sha256, 'the exact content-addressed artifact was durable before the crash');

  _setAfterStepArtifactPersistForTests(null);
  finalizeStepOutput(WF, run, step, output);

  const resume = computeResumeState(WF, run);
  const reference = resume.completedStepArtifacts.get(step.id);
  assert.ok(reference, 'step_completed owns one exact artifact reference');
  const journalOutput = resume.completedSteps.get(step.id) as { truncated?: boolean };
  assert.equal(journalOutput.truncated, true, 'the event journal remains compact');

  const exact = readStepOutputArtifact({
    workflowName: WF,
    runId: run,
    stepId: step.id,
    reference,
  });
  assert.equal(exact.verified, true);
  assert.match(JSON.stringify(exact.value), new RegExp(marker));
});
