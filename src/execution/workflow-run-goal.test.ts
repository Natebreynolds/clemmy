/**
 * Run: npx tsx --test src/execution/workflow-run-goal.test.ts
 *
 * Run-level PINNED GOALS (goal-contract, run scope):
 *   - decideGoalRunOutcome: satisfied / advisory (judge dead, never re-run or
 *     auto-satisfy) / escalate (exhausted, unsafe step, chronic) / repursue
 *   - runUnsafeToRepursue: side-effect law at run scope (declared send,
 *     write without loopSafe, approval-gated; read-only safe; incomplete
 *     steps ignored)
 *   - applyGoalFeedbackToPrompt / renderGoalFeedback: evidence folding
 *   - workflow-store: goal + allow_sends round-trip SKILL.md, clamping
 *   - checkGoalAuthoring: refuses empty objective / out-of-range attempts
 *   - ensureWorkflowRunGoal: creates an ACTIVE workflow-origin contract,
 *     reuses it across re-pursuit runs
 *   - queueWorkflowRun / requeueWorkflowFromRun: goalAttempt + goalFeedback
 *     lineage carried run→run
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-run-goal';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  decideGoalRunOutcome,
  runUnsafeToRepursue,
  applyGoalFeedbackToPrompt,
  renderGoalFeedback,
  setWorkflowRunItemProgress,
  bumpWorkflowRunItemProgress,
  clearWorkflowRunItemProgress,
  getWorkflowRunItemProgress,
} = await import('./workflow-runner.js');
const { checkGoalAuthoring } = await import('./workflow-enforce.js');
const { writeWorkflow, readWorkflow, clampGoalMaxAttempts } = await import('../memory/workflow-store.js');
const { ensureWorkflowRunGoal, getActiveGoalForSession, workflowGoalSessionId, satisfyGoal } = await import('../agents/plan-proposals.js');
const { queueWorkflowRun, requeueWorkflowFromRun } = await import('../tools/workflow-run-queue.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
import type { GoalValidationResult } from './goal-validate.js';
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

const passVerdict: GoalValidationResult = {
  pass: true,
  perCriterion: [{ criterion: 'report saved', pass: true, method: 'deterministic' }],
};
const failVerdict: GoalValidationResult = {
  pass: false,
  perCriterion: [
    { criterion: 'at least 10 rows', pass: false, method: 'judge', detail: 'only 2 rows found' },
    { criterion: 'report saved', pass: true, method: 'deterministic' },
  ],
  advice: 'unmet: at least 10 rows (only 2 rows found)',
};
const judgeDeadVerdict: GoalValidationResult = {
  pass: false,
  judgeFailedOpen: true,
  perCriterion: [{ criterion: 'looks complete', pass: false, method: 'skipped', detail: 'judge unavailable: 503' }],
  advice: 'completion judge unavailable — retry validation or escalate',
};

const baseDecision = { maxAttempts: 2, priorRepursuits: 0, unsafeStepId: null, chronicallyFailing: false };

test('decideGoalRunOutcome: pass → satisfied', () => {
  assert.equal(decideGoalRunOutcome({ ...baseDecision, verdict: passVerdict }).action, 'satisfied');
});

test('decideGoalRunOutcome: dead judge → advisory, NEVER repursue or satisfy', () => {
  const d = decideGoalRunOutcome({ ...baseDecision, verdict: judgeDeadVerdict });
  assert.equal(d.action, 'advisory');
});

test('decideGoalRunOutcome: dead judge does NOT mask a PROVEN deterministic miss', () => {
  const mixed: GoalValidationResult = {
    pass: false,
    judgeFailedOpen: true,
    perCriterion: [
      { criterion: 'report saved to ./out/report.md', pass: false, method: 'deterministic', detail: 'file missing: ./out/report.md' },
      { criterion: 'looks complete', pass: false, method: 'skipped', detail: 'judge unavailable: 503' },
    ],
  };
  // Attempts left + safe → the provable miss re-pursues despite the dead judge.
  assert.equal(decideGoalRunOutcome({ ...baseDecision, verdict: mixed }).action, 'repursue');
  // Exhausted → escalates (still never a quiet advisory).
  assert.equal(decideGoalRunOutcome({ ...baseDecision, verdict: mixed, priorRepursuits: 1 }).action, 'escalate');
});

test('decideGoalRunOutcome: unmet with attempts left and safe → repursue', () => {
  const d = decideGoalRunOutcome({ ...baseDecision, verdict: failVerdict });
  assert.equal(d.action, 'repursue');
});

test('decideGoalRunOutcome: attempts exhausted → escalate', () => {
  const d = decideGoalRunOutcome({ ...baseDecision, verdict: failVerdict, priorRepursuits: 1 });
  assert.equal(d.action, 'escalate');
  assert.match(d.reason, /2\/2/);
});

test('decideGoalRunOutcome: unsafe completed step → escalate even with attempts left', () => {
  const d = decideGoalRunOutcome({ ...baseDecision, verdict: failVerdict, unsafeStepId: 'send_email' });
  assert.equal(d.action, 'escalate');
  assert.match(d.reason, /send_email/);
});

test('decideGoalRunOutcome: chronically failing workflow → escalate', () => {
  const d = decideGoalRunOutcome({ ...baseDecision, verdict: failVerdict, chronicallyFailing: true });
  assert.equal(d.action, 'escalate');
});

test('runUnsafeToRepursue: declared send / ungated write / approval gate are unsafe; reads safe; incomplete ignored', () => {
  const steps: WorkflowStepInput[] = [
    { id: 'scrape', prompt: 'fetch the data', sideEffect: 'read' },
    { id: 'save', prompt: 'upsert rows', sideEffect: 'write' },
    { id: 'send', prompt: 'email the report', sideEffect: 'send' },
  ];
  // Only the read completed → safe.
  assert.equal(runUnsafeToRepursue(steps, new Set(['scrape'])), null);
  // Write completed without loopSafe → unsafe.
  assert.equal(runUnsafeToRepursue(steps, new Set(['scrape', 'save'])), 'save');
  // Same write asserted idempotent → safe.
  const idempotent = steps.map((s) => (s.id === 'save' ? { ...s, loopSafe: true } : s));
  assert.equal(runUnsafeToRepursue(idempotent, new Set(['scrape', 'save'])), null);
  // Completed send is always unsafe.
  assert.equal(runUnsafeToRepursue(idempotent, new Set(['scrape', 'save', 'send'])), 'send');
  // Send not yet executed → ignored.
  assert.equal(runUnsafeToRepursue(idempotent, new Set(['scrape'])), null);
  // Approval-gated read counts as the author's own mutation signal.
  const gated: WorkflowStepInput[] = [{ id: 'deploy', prompt: 'deploy the site', sideEffect: 'read', requiresApproval: true }];
  assert.equal(runUnsafeToRepursue(gated, new Set(['deploy'])), 'deploy');
  // Undeclared step with send-looking prose → heuristic backstop.
  const undeclared: WorkflowStepInput[] = [{ id: 'blast', prompt: 'send the email blast to the client list' }];
  assert.equal(runUnsafeToRepursue(undeclared, new Set(['blast'])), 'blast');
});

test('applyGoalFeedbackToPrompt: unchanged without feedback, appended with', () => {
  assert.equal(applyGoalFeedbackToPrompt({}, 'do the thing'), 'do the thing');
  assert.equal(applyGoalFeedbackToPrompt({ goalFeedback: '   ' }, 'do the thing'), 'do the thing');
  const out = applyGoalFeedbackToPrompt({ goalFeedback: '- UNMET: at least 10 rows' }, 'do the thing');
  assert.match(out, /^do the thing\n/);
  assert.match(out, /PRIOR ATTEMPT FEEDBACK/);
  assert.match(out, /UNMET: at least 10 rows/);
});

test('renderGoalFeedback: unmet criteria + guidance, passing criteria omitted (fallback when no directives)', () => {
  const fb = renderGoalFeedback(failVerdict);
  assert.match(fb, /UNMET: at least 10 rows \(only 2 rows found\)/);
  assert.match(fb, /Guidance: unmet/);
  assert.ok(!fb.includes('report saved'));
});

test('renderGoalFeedback: leads with the numeric scorecard and concrete FIX directives (S3)', () => {
  const scoredVerdict: GoalValidationResult = {
    pass: false,
    perCriterion: [
      { criterion: 'report saved to /out/report.md', pass: false, method: 'deterministic' },
      { criterion: 'has at least 10 rows', pass: true, method: 'judge' },
    ],
    advice: 'unmet: report saved',
    successRatePercent: 50,
    criteriaMet: 1,
    criteriaTotal: 2,
    failedDirectives: [
      { criterion: 'report saved to /out/report.md', method: 'deterministic', fix: 'Create the missing artifact at /out/report.md, then re-validate.' },
    ],
  };
  const fb = renderGoalFeedback(scoredVerdict);
  assert.match(fb, /Goal score: 50% \(1\/2 criteria met\)/);
  assert.match(fb, /- FIX: Create the missing artifact at \/out\/report\.md/);
  // structured FIX replaces the bare UNMET restatement when directives are present
  assert.ok(!fb.includes('UNMET:'));
});

test('workflow-store: goal + allow_sends round-trip SKILL.md; maxAttempts clamped', () => {
  const def: WorkflowDefinition = {
    name: 'goal-roundtrip',
    description: 'test',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'gather rows', sideEffect: 'read' }],
    allowSends: false,
    goal: { objective: 'collect at least 10 prospect rows', successCriteria: ['at least 10 rows', 'saved to disk'], maxAttempts: 9 },
  };
  writeWorkflow('goal-roundtrip', def);
  const back = readWorkflow('goal-roundtrip');
  assert.ok(back);
  assert.equal(back.data.allowSends, false);
  assert.ok(back.data.goal);
  assert.equal(back.data.goal.objective, 'collect at least 10 prospect rows');
  assert.deepEqual(back.data.goal.successCriteria, ['at least 10 rows', 'saved to disk']);
  assert.equal(back.data.goal.maxAttempts, 3); // clamped from 9
});

test('workflow-store: no goal / default allowSends stay unwritten', () => {
  const def: WorkflowDefinition = {
    name: 'goal-absent',
    description: 'test',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'gather rows' }],
  };
  const entry = writeWorkflow('goal-absent', def);
  const raw = readFileSync(entry.filePath, 'utf-8');
  assert.ok(!raw.includes('goal:'));
  assert.ok(!raw.includes('allow_sends'));
  const back = readWorkflow('goal-absent');
  assert.equal(back?.data.goal, undefined);
  assert.equal(back?.data.allowSends, undefined);
});

test('clampGoalMaxAttempts: default 2, floor 1, ceiling 3', () => {
  assert.equal(clampGoalMaxAttempts(undefined), 2);
  assert.equal(clampGoalMaxAttempts(0), 1);
  assert.equal(clampGoalMaxAttempts(3), 3);
  assert.equal(clampGoalMaxAttempts(99), 3);
});

test('checkGoalAuthoring: refuses empty objective and out-of-range attempts; sane goal passes', () => {
  const base: WorkflowDefinition = {
    name: 'g', description: 'd', enabled: true, trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'p' }],
  };
  assert.deepEqual(checkGoalAuthoring(base), []);
  assert.equal(checkGoalAuthoring({ ...base, goal: { objective: '  ' } }).length, 1);
  assert.equal(checkGoalAuthoring({ ...base, goal: { objective: 'collect rows', maxAttempts: 7 } }).length, 1);
  assert.deepEqual(checkGoalAuthoring({ ...base, goal: { objective: 'collect rows', maxAttempts: 2 } }), []);
});

test('ensureWorkflowRunGoal: creates ACTIVE workflow-origin contract, reuses across runs, fresh after satisfied', () => {
  const first = ensureWorkflowRunGoal({
    workflowName: 'prospect-sweep',
    runId: 'run-1',
    objective: 'collect at least 10 prospect rows',
    successCriteria: ['at least 10 rows'],
    maxAttempts: 2,
  });
  assert.ok(first);
  assert.equal(first.status, 'active');
  assert.equal(first.origin?.kind, 'workflow');
  assert.equal(first.origin?.runId, 'run-1');
  // Re-pursuit run reuses the SAME active contract (lineage accumulates).
  const second = ensureWorkflowRunGoal({
    workflowName: 'prospect-sweep',
    runId: 'run-2',
    objective: 'collect at least 10 prospect rows',
    maxAttempts: 2,
  });
  assert.equal(second?.id, first.id);
  assert.equal(getActiveGoalForSession(workflowGoalSessionId('prospect-sweep'))?.id, first.id);
  // After the contract resolves, the next fire gets a fresh one.
  satisfyGoal(first.id, 'test passed');
  const third = ensureWorkflowRunGoal({
    workflowName: 'prospect-sweep',
    runId: 'run-3',
    objective: 'collect at least 10 prospect rows',
  });
  assert.ok(third);
  assert.notEqual(third.id, first.id);
});

test('ensureWorkflowRunGoal: a CHANGED objective supersedes the stale contract instead of resurrecting it', () => {
  const first = ensureWorkflowRunGoal({
    workflowName: 'objective-shift',
    runId: 'run-a',
    objective: 'collect 10 prospect rows',
  });
  assert.ok(first);
  const second = ensureWorkflowRunGoal({
    workflowName: 'objective-shift',
    runId: 'run-b',
    objective: 'publish the weekly digest', // goal: block was edited between fires
  });
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  // The new contract is the one active; the stale one was superseded.
  assert.equal(getActiveGoalForSession(workflowGoalSessionId('objective-shift'))?.id, second.id);
});

test('item progress: per-step keying — concurrent fan-outs aggregate, sibling clear is isolated', () => {
  setWorkflowRunItemProgress('run-x', 'step-a', { completed: 1, failed: 0, total: 10 });
  setWorkflowRunItemProgress('run-x', 'step-b', { completed: 0, failed: 0, total: 5 });
  bumpWorkflowRunItemProgress('run-x', 'step-a', 'completed');
  bumpWorkflowRunItemProgress('run-x', 'step-b', 'failed');
  assert.deepEqual(getWorkflowRunItemProgress('run-x'), { completed: 2, failed: 1, total: 15 });
  // One fan-out finishing must not delete its still-running sibling's progress.
  clearWorkflowRunItemProgress('run-x', 'step-a');
  assert.deepEqual(getWorkflowRunItemProgress('run-x'), { completed: 0, failed: 1, total: 5 });
  // Run-wide clear (end of step loop) removes the rest.
  clearWorkflowRunItemProgress('run-x');
  assert.equal(getWorkflowRunItemProgress('run-x'), null);
});

test('run queue: goalAttempt + goalFeedback persist and carry through requeue', () => {
  writeWorkflow('goal-queue-wf', {
    name: 'goal-queue-wf', description: 'd', enabled: true, trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'p' }],
  });
  const queued = queueWorkflowRun('goal-queue-wf', { url: 'https://example.com' }, {
    originSessionId: 'sess-1',
    goalAttempt: 1,
    goalFeedback: '- UNMET: at least 10 rows',
  });
  assert.equal(queued.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), 'utf-8'));
  assert.equal(rec.goalAttempt, 1);
  assert.equal(rec.goalFeedback, '- UNMET: at least 10 rows');
  assert.equal(rec.originSessionId, 'sess-1');
  // Requeue from this run with bumped lineage WHILE the source is still
  // 'queued' on disk — a goal re-pursuit queues mid-completion, when the
  // source record still reads running/queued, so the same-inputs dedupe must
  // EXCLUDE the source run (regression: re-pursuit silently returned
  // 'duplicate' of its own source and never queued).
  const requeued = requeueWorkflowFromRun(queued.id!, { goalAttempt: 2, goalFeedback: '- UNMET: still short' });
  assert.equal(requeued.status, 'queued');
  const rec2 = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${requeued.id}.json`), 'utf-8'));
  assert.equal(rec2.goalAttempt, 2);
  assert.equal(rec2.goalFeedback, '- UNMET: still short');
  assert.equal(rec2.originSessionId, 'sess-1');
});
