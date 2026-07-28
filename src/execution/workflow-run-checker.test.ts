/**
 * Run: npx tsx --test src/execution/workflow-run-checker.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-run-checker-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { appendWorkflowEvent } = await import('./workflow-events.js');
const { anchorRunGoal, recordStepOutput } = await import('./workflow-run-workspace.js');
const { buildWorkspaceEvidence, checkRunAgainstGoal, renderCheckerReport, checkerReportFromVerdict } = await import('./workflow-run-checker.js');

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

const NOW = '2026-07-05T00:00:00.000Z';

function seed(wf: string, run: string): void {
  anchorRunGoal(wf, run, { objective: 'Email each prospect a tailored note', successCriteria: ['Must mention the prospect company', 'Must not be too generic'] });
  recordStepOutput({ workflowName: wf, runId: run, stepId: 'pull', output: { prospects: [{ company: 'Acme LLP' }, { company: 'Boron PC' }] }, nowIso: NOW });
  recordStepOutput({ workflowName: wf, runId: run, stepId: 'draft', output: 'Dear Acme LLP, we noticed your firm…', nowIso: NOW });
}

// Deterministic stand-ins for the real cross-family judge. validateGoal makes
// ONE holistic checklist call for all prose criteria, so the verdict is
// all-or-nothing — model that faithfully.
const passJudge = async (_objective: string, evidence: string) => ({ done: /Acme/i.test(evidence), reason: 'work references the firm' });
const failJudge = async () => ({ done: false, reason: 'reads generic; no company named' });

test('checker reads the shared workspace (goal + every step work-product) as its evidence', () => {
  seed('wf', 'r1');
  const { evidenceText, evidenceSteps } = buildWorkspaceEvidence('wf', 'r1');
  assert.deepEqual(evidenceSteps, ['pull', 'draft']);
  assert.match(evidenceText, /Email each prospect a tailored note/); // the goal
  assert.match(evidenceText, /Step "pull" produced/);
  assert.match(evidenceText, /Acme LLP/); // the actual draft work product
});

test('checker evidence preserves trailing proof fields after wide arrays and long provider text', () => {
  anchorRunGoal('wf', 'r-proof', { objective: 'Verify the tracker write', successCriteria: ['Must preserve duplicate and read-back proof'] });
  recordStepOutput({
    workflowName: 'wf',
    runId: 'r-proof',
    stepId: 'upsert',
    output: {
      columns: Array.from({ length: 70 }, (_, index) => `Column ${index + 1}`),
      providerDetail: `provider ${'x'.repeat(4_000)}`,
      duplicateMatches: [{ stableKey: 'acct-1', canonicalRowNumber: 29, ignoredRowNumbers: [13, 28] }],
      verifiedCount: 1,
      protectedFieldsUnchanged: true,
    },
    nowIso: NOW,
  });

  const { evidenceText } = buildWorkspaceEvidence('wf', 'r-proof');
  assert.match(evidenceText, /"columns": \{ "count": 70/);
  assert.match(evidenceText, /"duplicateMatches": \{ "count": 1/);
  assert.match(evidenceText, /"verifiedCount": 1/);
  assert.match(evidenceText, /"protectedFieldsUnchanged": true/);
});

test('checker engine evidence counts only each step final state after retries', () => {
  anchorRunGoal('wf', 'r-recovered', { objective: 'Recover and finish', successCriteria: ['Must finish the recovered step'] });
  recordStepOutput({ workflowName: 'wf', runId: 'r-recovered', stepId: 'recovered', output: { verifiedCount: 1 }, nowIso: NOW });
  appendWorkflowEvent('wf', 'r-recovered', { kind: 'step_failed', stepId: 'recovered', error: 'transient' });
  appendWorkflowEvent('wf', 'r-recovered', { kind: 'step_completed', stepId: 'recovered', output: { verifiedCount: 1 } });
  appendWorkflowEvent('wf', 'r-recovered', { kind: 'step_failed', stepId: 'still_failed', error: 'terminal' });

  const { evidenceText } = buildWorkspaceEvidence('wf', 'r-recovered');
  assert.match(evidenceText, /1 workflow step reached step_completed/);
  assert.match(evidenceText, /Unresolved step_failed events: 1/);
});

test('checker engine evidence separates blocked/skipped step_completed events from verified successes', () => {
  anchorRunGoal('wf', 'r-blocked', { objective: 'Enrich and upsert rows', successCriteria: ['Must upsert verified rows'] });
  recordStepOutput({ workflowName: 'wf', runId: 'r-blocked', stepId: 'pull', output: { rows: [{ id: 1 }] }, nowIso: NOW });
  recordStepOutput({ workflowName: 'wf', runId: 'r-blocked', stepId: 'upsert', output: { blocked: true, reason: 'tracker has zero data rows' }, nowIso: NOW });
  appendWorkflowEvent('wf', 'r-blocked', { kind: 'step_completed', stepId: 'pull', output: { rows: [{ id: 1 }] } });
  // An honest block flows through as step_completed with meta.blocked (runner
  // tags both direct blocks and blocked-upstream dependency skips this way).
  appendWorkflowEvent('wf', 'r-blocked', {
    kind: 'step_completed', stepId: 'upsert',
    output: { blocked: true, reason: 'tracker has zero data rows' },
    meta: { blocked: true },
  });
  appendWorkflowEvent('wf', 'r-blocked', {
    kind: 'step_completed', stepId: 'notify',
    output: { blocked: true, reason: 'Skipped because the required upstream path is blocked by "upsert"' },
    meta: { blocked: true, skipped: true, reason: 'blocked_upstream_dependency', blockedBy: 'upsert' },
  });

  const { evidenceText } = buildWorkspaceEvidence('wf', 'r-blocked');
  assert.match(evidenceText, /1 workflow step reached step_completed/);
  assert.match(evidenceText, /2 steps? finished BLOCKED/i);
  assert.doesNotMatch(evidenceText, /3 workflow steps reached step_completed/);
});

test('checker PASSES when the accumulated work satisfies the goal, attributing evidence to steps', async () => {
  seed('wf', 'r2');
  const report = await checkRunAgainstGoal({
    workflowName: 'wf', runId: 'r2', objective: 'Email each prospect a tailored note',
    successCriteria: ['Must mention the prospect company', 'Must not be too generic'],
    checkedAt: NOW, deps: { judge: passJudge },
  });
  assert.equal(report.pass, true);
  assert.equal(report.metCount, 2);
  assert.deepEqual(report.evidenceSteps, ['pull', 'draft']);
  assert.match(report.summary, /2\/2 criteria met across 2 step work-products/);
});

test('checker FLAGS a goal miss (does not silently pass sub-par work)', async () => {
  seed('wf', 'r2b');
  const report = await checkRunAgainstGoal({
    workflowName: 'wf', runId: 'r2b', objective: 'Email each prospect a tailored note',
    successCriteria: ['Must mention the prospect company', 'Must not be too generic'],
    checkedAt: NOW, deps: { judge: failJudge },
  });
  assert.equal(report.pass, false);
  assert.equal(report.unmetCount, 2);
  assert.match(report.summary, /does NOT yet meet the goal/);
});

test('a run with no work products yet is not-yet-verifiable, never a false pass', async () => {
  anchorRunGoal('wf', 'r3', { objective: 'do a thing', successCriteria: ['Must X'] });
  const report = await checkRunAgainstGoal({
    workflowName: 'wf', runId: 'r3', objective: 'do a thing', successCriteria: ['Must X'],
    checkedAt: NOW, deps: { judge: passJudge },
  });
  assert.equal(report.pass, false);
  assert.equal(report.evidenceSteps.length, 0);
  assert.match(report.summary, /nothing to verify/);
});

test('checkerReportFromVerdict reuses a completion verdict without a second judge call', () => {
  const verdict = {
    pass: false,
    perCriterion: [
      { criterion: 'Must mention the prospect company', pass: true, method: 'judge' as const },
      { criterion: 'Must not be too generic', pass: false, method: 'judge' as const, detail: 'reads generic' },
    ],
  };
  const report = checkerReportFromVerdict('r7', verdict, ['pull', 'draft'], NOW);
  assert.equal(report.pass, false);
  assert.equal(report.metCount, 1);
  assert.equal(report.unmetCount, 1);
  assert.deepEqual(report.evidenceSteps, ['pull', 'draft']);
  assert.match(report.summary, /1\/2 criteria met across 2 step work-products/);
});

test('renderCheckerReport lists unmet criteria for a flagged run', async () => {
  seed('wf', 'r4');
  const report = await checkRunAgainstGoal({
    workflowName: 'wf', runId: 'r4', objective: 'x',
    successCriteria: ['Must mention the prospect company', 'Must not be too generic'],
    checkedAt: NOW, deps: { judge: failJudge },
  });
  const text = renderCheckerReport(report);
  assert.match(text, /Not yet satisfied:/);
  assert.match(text, /✗ Must not be too generic/);
  assert.match(text, /✗ Must mention the prospect company/);
});
