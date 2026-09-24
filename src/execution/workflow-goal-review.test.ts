import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorkflowRunGoal } from './workflow-goal-review.js';

test('output keys and a URL cannot substitute for the workflow objective', async () => {
  const objective = 'Update the tracker, preserve existing headers, and refresh the board.';
  let calls = 0;
  const result = await validateWorkflowRunGoal({
    objective,
    successCriteria: ['Step "main" returns required key(s): url, leads.', 'Step "main" returns a real non-empty http(s) URL at "url".'],
    stepOutputs: { main: { url: 'https://example.test/tracker', leads: [] } },
    evidenceText: 'The provider receipt shows that the existing headers were overwritten.',
  }, {
    judgeCriteria: async (_objective, criteria) => {
      calls++;
      return criteria.map(criterion => ({ pass: !criterion.includes(objective), note: 'The output has the keys and URL, but the write violated the objective.' }));
    },
  });
  assert.equal(result.pass, false, 'schema success must not certify objective completion');
  assert.equal(calls, 1, 'objective and criteria share one review call');
  assert.ok(result.perCriterion.some(criterion => criterion.criterion.includes(objective) && !criterion.pass));
});

test('pinned goal reviewer can inspect write receipts and saved constraints without inlining large payloads', async () => {
  const { workflowGoalExecutionEvidence } = await import('./workflow-goal-review.js');
  const payload = 'private retained content'.repeat(2000);
  const definition = { steps: [{ id: 'main', prompt: 'Preserve existing headers.' }] };
  const context = workflowGoalExecutionEvidence({
    available: true,
    summary: 'write result: existing header row overwritten; see payload',
    results: [{ toolName: 'provider_update', logicalToolCallId: 'write-1', status: 'verified', outcome: 'succeeded' }],
    evidence: { refKind: 'result', refs: () => ['payload'], resolve: ref => ref === 'payload' ? { text: payload } : undefined },
  }, definition);
  assert.match(context.summary, /provider_update/);
  assert.doesNotMatch(context.summary, /private retained/);
  assert.deepEqual(context.evidence.resolve('workflow_contract')?.value, definition);
  assert.match(context.evidence.resolve('workflow_execution')?.text ?? '', /header row overwritten/);
  assert.equal(context.evidence.resolve('payload')?.text, payload);
  assert.equal(context.evidence.resolve('another-run/payload'), undefined);
});

test('objective review failure stays unverified instead of banking structural success', async () => {
  const result = await validateWorkflowRunGoal({
    objective: 'Publish the correct report.',
    successCriteria: ['Step "main" output includes required keys: url'],
    stepOutputs: { main: { url: 'https://example.test/report' } },
    evidenceText: 'Output has a URL.',
  }, { judge: async () => { throw new Error('review unavailable'); } });
  assert.equal(result.pass, false);
  assert.equal(result.judgeFailedOpen, true);
  assert.equal(result.perCriterion.filter(row => row.method === 'deterministic' && row.pass).length, 1);
  assert.equal(result.perCriterion.filter(row => row.method === 'skipped').length, 1);
});

test('whole-objective miss cannot be downgraded to a successful-work advisory', async () => {
  const { goalMissIsJudgeOnlyAdvisory } = await import('./goal-validate.js');
  const result = await validateWorkflowRunGoal({
    objective: 'Preserve the existing header and update the daily totals.',
    successCriteria: [], evidenceText: 'The header was overwritten.',
  }, { judge: async () => ({ done: false, reason: 'The write violated the preservation requirement.' }) });
  assert.equal(goalMissIsJudgeOnlyAdvisory(result, {
    blockedSteps: 0, forEachFailures: 0, targetMissed: false,
  }), false);
});

test('a filename in the full objective cannot turn semantic review into an existence check', async () => {
  let reviewed = 0;
  const result = await validateWorkflowRunGoal({
    objective: 'Update /tmp/report.csv while preserving its headers and verify the totals.',
    successCriteria: [], evidenceText: 'The file exists but its headers were overwritten.',
  }, {
    fileExists: () => true,
    judge: async () => { reviewed++; return { done: false, reason: 'Headers were not preserved.' }; },
  });
  assert.equal(reviewed, 1);
  assert.equal(result.pass, false);
});

test('approved pilot criterion identities stay exact while objective review remains separately recorded', async () => {
  const { workflowGoalValidationReceipt } = await import('./workflow-goal-review.js');
  const criteria = ['Step "main" output includes required keys: url'];
  const verdict = await validateWorkflowRunGoal({ objective: 'Update the board correctly.',
    successCriteria: criteria, stepOutputs: { main: { url: 'https://example.test' } }, evidenceText: 'Header overwritten.' },
  { judge: async () => ({ done: false, reason: 'Constraint violated.' }) });
  const receipt = workflowGoalValidationReceipt({ objective: 'Update the board correctly.',
    successCriteria: criteria, verdict, validatedAt: '2026-09-23T14:00:00.000Z' });
  assert.deepEqual(receipt.successCriteria, criteria);
  assert.deepEqual(receipt.perCriterion.map(row => row.criterion), criteria);
  assert.equal(receipt.perCriterion[0].pass, true);
  assert.equal(receipt.objectiveReview?.scope, 'objective');
  assert.equal(receipt.objectiveReview?.pass, false);
  assert.equal(receipt.pass, false, 'passing approved structural criteria cannot conceal a failed whole objective');
});
