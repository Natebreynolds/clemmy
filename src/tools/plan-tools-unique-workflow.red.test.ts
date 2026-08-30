/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/plan-tools-unique-workflow.red.test.ts
 *
 * OPEN-THE-GATES C. Live sess-desktop-ca4779: "Run my platform 49 workflow"
 * called plan_task three times, workflow_get three times, and never
 * workflow_run. Clem invented a host-gate refusal. A uniquely named run is
 * invoked with workflow_run; plan_task must refuse with that exact name.
 *
 * Re-break two ways:
 *   (i)  uniqueWorkflowRunRequest is not consulted
 *   (ii) the repair does not name workflow_run
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PLAN = new URL('./plan-tools.ts', import.meta.url);

test('NEGATIVE: a uniquely named workflow run must not be planned', () => {
  const src = readFileSync(PLAN, 'utf8');
  const fn = src.slice(src.indexOf('async function executePlanTask'), src.indexOf('export function buildPlanTaskTool'));
  assert.match(fn, /uniqueWorkflowRunRequest\(\s*objective/);
  assert.match(fn, /priorAcceptedSourceTexts\(sessionId, sourceUserSeq\)/);
  assert.match(fn, /code: 'plan_not_required'/);
  assert.match(
    fn,
    /Call workflow_run with name "\$\{uniqueWorkflow\.name\}"/,
    'the repair must name the exact workflow',
  );
});

test('re-break (i): uniqueWorkflowRunRequest must run before admitAndCompile', () => {
  const src = readFileSync(PLAN, 'utf8');
  const fn = src.slice(src.indexOf('async function executePlanTask'), src.indexOf('export function buildPlanTaskTool'));
  const uniqueAt = fn.indexOf('uniqueWorkflowRunRequest(');
  const admitAt = fn.indexOf('admitAndCompilePrimaryModelProposal');
  assert.ok(uniqueAt >= 0 && admitAt > uniqueAt, 'the unique-run check must precede plan admission');
});

test('re-break (ii): the repair must not send the model back into plan_task', () => {
  const src = readFileSync(PLAN, 'utf8');
  const fn = src.slice(src.indexOf('async function executePlanTask'), src.indexOf('export function buildPlanTaskTool'));
  const block = fn.slice(fn.indexOf('uniqueWorkflowRunRequest('), fn.indexOf('const proposal = proposalFromDraft'));
  assert.match(block, /Do not plan_task/);
  assert.match(block, /workflow_run/);
});
