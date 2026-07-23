/**
 * Run: npx tsx --test apps/console-web/src/lib/workflow-run-detail.test.ts
 *
 * Pins the folding rules for the workflow run-detail reducer: step grouping +
 * ordering, terminal status, duration/token rollup, forEach item counts, retry
 * counting, attempt sub-records, judge/quality advisories (incl. note capture),
 * and the run summary (because · artifacts · needsAttention).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisoryLabel, advisoryTone, buildWorkflowRunDetail } from './workflow-run-detail';

type Ev = Record<string, unknown>;

test('folds a finished multi-step run into ordered steps with status + duration', () => {
  const events: Ev[] = [
    { t: '2026-07-04T00:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T00:00:01.000Z', kind: 'step_started', stepId: 'research' },
    { t: '2026-07-04T00:00:03.500Z', kind: 'step_completed', stepId: 'research', output: 'found 3 sources' },
    { t: '2026-07-04T00:00:04.000Z', kind: 'step_started', stepId: 'draft' },
    { t: '2026-07-04T00:00:06.000Z', kind: 'step_failed', stepId: 'draft', error: 'model refused' },
    { t: '2026-07-04T00:00:06.500Z', kind: 'run_failed' },
  ];
  const detail = buildWorkflowRunDetail(events);
  assert.equal(detail.runStatus, 'failed');
  assert.deepEqual(detail.steps.map((s) => s.stepId), ['research', 'draft']);
  assert.equal(detail.steps[0].status, 'done');
  assert.equal(detail.steps[0].durationMs, 2500);
  assert.equal(detail.steps[0].output, 'found 3 sources');
  assert.equal(detail.steps[1].status, 'failed');
  assert.equal(detail.steps[1].error, 'model refused');
  assert.equal(detail.durationMs, 6500);
});

test('captures attempts, retries, and rolls tokens up from attempt samples', () => {
  const events: Ev[] = [
    { t: '2026-07-04T00:00:00.000Z', kind: 'step_started', stepId: 'build' },
    { t: '2026-07-04T00:00:01.000Z', kind: 'step_retry', stepId: 'build' },
    {
      t: '2026-07-04T00:00:01.100Z',
      kind: 'attempt_record',
      stepId: 'build',
      attempt: {
        attemptIndex: 1,
        maxAttempts: 3,
        failedProblems: ['missing citation', 'wrong tone'],
        changeSummary: 'fixed tone; citation still missing',
        metrics: { durationMs: 900, tokens: 1200, toolCalls: 4 },
      },
    },
    { t: '2026-07-04T00:00:02.000Z', kind: 'step_completed', stepId: 'build', output: 'done' },
  ];
  const detail = buildWorkflowRunDetail(events);
  const step = detail.steps[0];
  assert.equal(step.retries, 1);
  assert.equal(step.attempts.length, 1);
  assert.equal(step.attempts[0].attemptIndex, 1);
  assert.equal(step.attempts[0].maxAttempts, 3);
  assert.deepEqual(step.attempts[0].failedProblems, ['missing citation', 'wrong tone']);
  assert.equal(step.attempts[0].metrics.tokens, 1200);
  // No completion-meta tokens → rolled up from the attempt sample.
  assert.equal(step.tokens, 1200);
  assert.equal(detail.tokensTotal, 1200);
});

test('a step_completed tagged meta.blocked folds to blocked (not done) with its reason', () => {
  const events: Ev[] = [
    { t: '2026-07-04T00:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T00:00:01.000Z', kind: 'step_started', stepId: 'add_to_airtable' },
    {
      t: '2026-07-04T00:00:02.000Z',
      kind: 'step_completed',
      stepId: 'add_to_airtable',
      output: { blocked: true, reason: 'no prospects — Salesforce connection expired' },
      meta: { blocked: true },
    },
    { t: '2026-07-04T00:00:02.500Z', kind: 'run_completed' },
  ];
  const step = buildWorkflowRunDetail(events).steps[0];
  assert.equal(step.status, 'blocked');
  assert.equal(step.error, 'no prospects — Salesforce connection expired');
  // The raw {blocked:true} envelope is NOT surfaced as the step's output.
  assert.equal(step.output, '');
});

test('prefers completion-meta tokens/cost over attempt samples', () => {
  const events: Ev[] = [
    { t: '2026-07-04T00:00:00.000Z', kind: 'step_started', stepId: 's' },
    { t: '2026-07-04T00:00:00.100Z', kind: 'attempt_record', stepId: 's', attempt: { attemptIndex: 1, metrics: { tokens: 100 } } },
    { t: '2026-07-04T00:00:01.000Z', kind: 'step_completed', stepId: 's', output: 'x', meta: { tokens: 5000, costUsd: 0.42 } },
  ];
  const step = buildWorkflowRunDetail(events).steps[0];
  assert.equal(step.tokens, 5000);
  assert.equal(step.costUsd, 0.42);
});

test('counts forEach items and records advisories with their note', () => {
  const events: Ev[] = [
    { t: '2026-07-04T00:00:00.000Z', kind: 'step_started', stepId: 'send' },
    { t: '2026-07-04T00:00:00.100Z', kind: 'item_started', stepId: 'send', itemKey: 'a' },
    { t: '2026-07-04T00:00:00.200Z', kind: 'item_completed', stepId: 'send', itemKey: 'a' },
    { t: '2026-07-04T00:00:00.300Z', kind: 'item_started', stepId: 'send', itemKey: 'b' },
    { t: '2026-07-04T00:00:00.400Z', kind: 'item_failed', stepId: 'send', itemKey: 'b' },
    {
      t: '2026-07-04T00:00:00.500Z',
      kind: 'step_advisory',
      stepId: 'send',
      meta: { reason: 'skill_not_executed', note: 'could not confirm the skill deliverable' },
    },
    { t: '2026-07-04T00:00:01.000Z', kind: 'step_completed', stepId: 'send', output: 'ok' },
  ];
  const step = buildWorkflowRunDetail(events).steps[0];
  assert.deepEqual(step.items, { started: 2, completed: 1, failed: 1 });
  assert.equal(step.advisories.length, 1);
  assert.equal(step.advisories[0].reason, 'skill_not_executed');
  assert.equal(step.advisories[0].note, 'could not confirm the skill deliverable');
});

test('parses the run summary (because · artifacts · needsAttention)', () => {
  const events: Ev[] = [
    { t: '2026-07-04T00:00:00.000Z', kind: 'run_started' },
    {
      t: '2026-07-04T00:00:01.000Z',
      kind: 'run_summary',
      meta: {
        because: 'reached the workflow target',
        needsAttention: true,
        artifacts: { counts: ['12 rows'], files: ['/tmp/out.md'], urls: ['https://x.test'] },
      },
    },
    { t: '2026-07-04T00:00:01.500Z', kind: 'run_completed' },
  ];
  const detail = buildWorkflowRunDetail(events);
  assert.ok(detail.summary);
  assert.equal(detail.summary!.because, 'reached the workflow target');
  assert.equal(detail.summary!.needsAttention, true);
  assert.deepEqual(detail.summary!.artifacts.files, ['/tmp/out.md']);
  assert.equal(detail.runStatus, 'completed');
});

test('advisory labels + tones cover the newer self-improvement reasons', () => {
  assert.equal(advisoryLabel('contract_tightened'), 'Success contract tightened');
  assert.equal(advisoryLabel('self_heal_reverted'), 'Auto-heal reverted (regressed)');
  assert.equal(advisoryLabel('batch_sibling_failed_while_parked'), 'Sibling batch item failed while parked');
  assert.equal(advisoryLabel('some_unknown_reason'), 'some unknown reason');
  assert.equal(advisoryTone('contract_tightened'), 'success');
  assert.equal(advisoryTone('self_heal_reverted'), 'warning');
});

test('tolerates an empty / malformed log without throwing', () => {
  assert.deepEqual(buildWorkflowRunDetail([]).steps, []);
  assert.equal(buildWorkflowRunDetail(undefined).runStatus, 'unknown');
  const detail = buildWorkflowRunDetail([{ kind: 'step_started' }, { foo: 'bar' } as Ev]);
  assert.deepEqual(detail.steps, []); // events without a stepId are ignored
});

// ─── Trust cockpit: run-level verdicts + watcher steers (T3-B4) ──────────────

test('verdict_recorded folds into run-level verdicts with the criteria scorecard — never a step', () => {
  const detail = buildWorkflowRunDetail([
    { kind: 'run_started', t: '2026-07-08T01:00:00Z' },
    { kind: 'step_started', stepId: 'pull', t: '2026-07-08T01:00:01Z' },
    { kind: 'step_completed', stepId: 'pull', t: '2026-07-08T01:00:05Z', output: 'rows' },
    { kind: 'verdict_recorded', t: '2026-07-08T01:00:09Z', meta: { door: 'goal_validation', pass: false, reason: 'criterion 2 unmet', failedOpen: false, criteriaMet: 1, criteriaTotal: 2 } },
    { kind: 'verdict_recorded', t: '2026-07-08T01:00:10Z', meta: { door: 'workflow_target', pass: true, reason: 'target satisfied' } },
    { kind: 'run_completed', t: '2026-07-08T01:00:11Z' },
  ]);
  assert.equal(detail.verdicts.length, 2);
  assert.deepEqual(detail.verdicts[0], { door: 'goal_validation', pass: false, reason: 'criterion 2 unmet', failedOpen: false, criteriaMet: 1, criteriaTotal: 2 });
  assert.equal(detail.verdicts[1].pass, true);
  assert.deepEqual(detail.steps.map((s) => s.stepId), ['pull'], 'verdicts never create steps');
});

test('watcher steers fold run-level — the synthetic (watcher) stepId never becomes a phantom pending step', () => {
  const detail = buildWorkflowRunDetail([
    { kind: 'step_completed', stepId: 'a', t: '2026-07-08T01:00:01Z', output: 'x' },
    { kind: 'step_advisory', stepId: '(watcher)', t: '2026-07-08T01:00:02Z', meta: { reason: 'watcher_steer', miss: 'criterion untouched', steer: 'address it before drafting', injection: 1, afterSteps: 2 } },
    { kind: 'step_completed', stepId: 'b', t: '2026-07-08T01:00:05Z', output: 'y' },
  ]);
  assert.equal(detail.watcherSteers.length, 1);
  assert.deepEqual(detail.watcherSteers[0], { miss: 'criterion untouched', steer: 'address it before drafting', afterSteps: 2 });
  assert.deepEqual(detail.steps.map((s) => s.stepId), ['a', 'b'], 'no (watcher) phantom step');
});

test('advisoryLabel knows the watcher steer slug; runs without cockpit events fold to empty lists', () => {
  assert.equal(advisoryLabel('watcher_steer'), 'Watcher steered mid-run');
  const detail = buildWorkflowRunDetail([{ kind: 'step_completed', stepId: 'a', t: '', output: 'x' }]);
  assert.deepEqual(detail.verdicts, []);
  assert.deepEqual(detail.watcherSteers, []);
});

// B (v2.3.0): a park is durably logged as step_failed (reaper re-admission
// contract) but must NOT render as a red FAILED row — the live 2026-07-23
// screenshot showed "post_slack FAILED: Workflow run parked on approval"
// while the run was simply waiting for the user. Both the tagged meta and the
// bare legacy message reclassify to awaiting_approval with friendly copy.
test('park-on-approval step_failed reclassifies to awaiting_approval, real failures stay failed', () => {
  const events: Ev[] = [
    { t: '2026-07-04T00:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T00:00:01.000Z', kind: 'step_started', stepId: 'post_slack' },
    {
      t: '2026-07-04T00:00:02.000Z', kind: 'step_failed', stepId: 'post_slack',
      error: 'Workflow run parked on approval.', meta: { reason: 'parked_on_approval' },
    },
    { t: '2026-07-04T00:00:03.000Z', kind: 'step_started', stepId: 'legacy_park' },
    // Pre-tag event shape: message only, no meta.
    { t: '2026-07-04T00:00:04.000Z', kind: 'step_failed', stepId: 'legacy_park', error: 'Workflow run parked on approval.' },
    { t: '2026-07-04T00:00:05.000Z', kind: 'step_started', stepId: 'broken' },
    { t: '2026-07-04T00:00:06.000Z', kind: 'step_failed', stepId: 'broken', error: 'model refused' },
  ];
  const detail = buildWorkflowRunDetail(events);
  const byId = Object.fromEntries(detail.steps.map((s) => [s.stepId, s]));
  assert.equal(byId.post_slack.status, 'awaiting_approval');
  assert.match(byId.post_slack.error ?? '', /Waiting for your approval/);
  assert.equal(byId.legacy_park.status, 'awaiting_approval');
  assert.equal(byId.broken.status, 'failed');
  assert.equal(byId.broken.error, 'model refused');
});

// Resume-after-approve: the SAME step re-running must overwrite the parked
// presentation (running → done), never stick at awaiting_approval.
test('a parked step that resumes and completes ends done, not awaiting_approval', () => {
  const events: Ev[] = [
    { t: '2026-07-04T00:00:01.000Z', kind: 'step_started', stepId: 'send' },
    { t: '2026-07-04T00:00:02.000Z', kind: 'step_failed', stepId: 'send', error: 'Workflow run parked on approval.' },
    { t: '2026-07-04T00:01:00.000Z', kind: 'step_started', stepId: 'send' },
    { t: '2026-07-04T00:01:05.000Z', kind: 'step_completed', stepId: 'send', output: 'posted' },
  ];
  const detail = buildWorkflowRunDetail(events);
  assert.equal(detail.steps.length, 1);
  assert.equal(detail.steps[0].status, 'done');
  assert.equal(detail.steps[0].output, 'posted');
});
