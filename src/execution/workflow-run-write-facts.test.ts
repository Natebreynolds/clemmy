/**
 * Landed writes are structural facts; the goal decision reads them, never the
 * other way round. Pure checks of the classifier, the decision table and the
 * follow-up lineage.
 *
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-run-write-facts.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-write-facts-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const facts = await import('./workflow-run-write-facts.js');
const runner = await import('./workflow-runner.js');

import type { WorkflowStepInput } from '../memory/workflow-store.js';
import type { GoalValidationResult } from './goal-validate.js';
import type { WorkflowRunWriteFacts, WorkflowStepWriteFacts, WorkflowLandedWrite } from './workflow-run-write-facts.js';

const write = (tool: string, repeatSafe = false): WorkflowLandedWrite => ({
  stepId: 's', sessionId: 'workflow:r:s', logicalCallId: `call-${tool}`, tool, repeatSafe, targets: [],
});
const prose = (id: string, sideEffect: 'read' | 'write' | 'send', extra: Partial<WorkflowStepInput> = {}): WorkflowStepInput =>
  ({ id, prompt: `do ${id}`, sideEffect, ...extra });
const callStep = (id: string, tool: string, extra: Partial<WorkflowStepInput> = {}): WorkflowStepInput =>
  ({ id, prompt: '', sideEffect: 'write', call: { tool, args: {} }, ...extra });

test('classify: a landed write keeps its step from repeating unless every write declares a repeat adds nothing', () => {
  const none = { landed: [], unresolved: 0 };
  assert.equal(facts.classifyWorkflowStepWrites(prose('r', 'read'), 'read', { landed: [write('x')], unresolved: 0 }).disposition, 'none',
    'a read step keeps its existing repeat law');
  assert.equal(facts.classifyWorkflowStepWrites(prose('w', 'write'), 'write', none).disposition, 'none',
    'a write step the ledger saw land nothing is safe to repeat');
  assert.equal(facts.classifyWorkflowStepWrites(callStep('c', 'space_set_data'), 'write', { landed: [write('space_set_data', true)], unresolved: 0 }).disposition,
    'repeat_safe');
  assert.equal(facts.classifyWorkflowStepWrites(prose('w', 'write', { loopSafe: true }), 'write', { landed: [write('x')], unresolved: 0 }).disposition,
    'repeat_safe', 'the author asserted the step is safe to loop');
  assert.equal(facts.classifyWorkflowStepWrites(prose('w', 'write'), 'write', { landed: [write('x', true), write('y')], unresolved: 0 }).disposition,
    'landed', 'one non-repeatable write is enough to protect the step');
  assert.equal(facts.classifyWorkflowStepWrites(prose('s', 'send'), 'send', none).disposition, 'sent',
    'a send step never repeats automatically');
  assert.equal(facts.classifyWorkflowStepWrites(prose('a', 'write', { requiresApproval: true }), 'write', none).disposition, 'sent',
    'an approval-gated step never repeats automatically');
  assert.equal(facts.classifyWorkflowStepWrites(prose('w', 'write'), 'write', { landed: [write('x')], unresolved: 1 }).disposition,
    'uncertain', 'an unresolved write is never a landed fact');
  const script = facts.classifyWorkflowStepWrites({ id: 'd', prompt: '', sideEffect: 'write', deterministic: { runner: 'r.mjs' } }, 'write', none);
  assert.deepEqual([script.disposition, script.landedUnobserved], ['landed', true],
    'a script\'s writes are outside the ledger and taken as landed, never as absent');
});

test('classify: only a step a model carries out can continue its own work', () => {
  assert.equal(facts.workflowStepIsModelDriven(prose('p', 'write')), true);
  assert.equal(facts.workflowStepIsModelDriven(callStep('c', 'x')), false);
  assert.equal(facts.workflowStepIsModelDriven({ id: 'd', prompt: '', deterministic: { runner: 'r.mjs' } }), false);
  assert.equal(facts.toolDeclaresRepeatAddsNoWrite('space_set_data'), true);
  assert.equal(facts.toolDeclaresRepeatAddsNoWrite('write_file'), false);
  assert.equal(facts.toolDeclaresRepeatAddsNoWrite('some_provider_create'), false);
});

const gap: GoalValidationResult = {
  pass: false,
  perCriterion: [{ criterion: 'the seven-day re-check ran', pass: false, method: 'judge', detail: 'skipped' }],
};
const base = { verdict: gap, maxAttempts: 2, priorRepursuits: 0, unsafeStepId: null, chronicallyFailing: false };

test('decide: a gap after landed writes never escalates to a block', () => {
  const landed = (followUpStepIds: string[] = []) => ({ landed: true, followUpStepIds });
  assert.equal(runner.decideGoalRunOutcome({ ...base, landedWrites: landed() }).action, 'repursue',
    'every landed write is safe to repeat');
  assert.equal(runner.decideGoalRunOutcome({ ...base, unsafeStepId: 'main', landedWrites: landed(['main']) }).action, 'follow_up',
    'a model step whose write landed re-checks the gap');
  assert.equal(runner.decideGoalRunOutcome({ ...base, unsafeStepId: 'post', landedWrites: landed() }).action, 'gap',
    'nothing may run again automatically: done, with the gap named');
  assert.equal(runner.decideGoalRunOutcome({ ...base, priorRepursuits: 1, landedWrites: landed(['main']) }).action, 'gap',
    'attempts used up');
  assert.equal(runner.decideGoalRunOutcome({ ...base, chronicallyFailing: true, landedWrites: landed(['main']) }).action, 'gap');
});

test('decide: without landed writes, or with a verdict that is not a gap, the earlier rules stand', () => {
  assert.equal(runner.decideGoalRunOutcome({ ...base, unsafeStepId: 'send', landedWrites: { landed: false, followUpStepIds: [] } }).action, 'escalate');
  assert.equal(runner.decideGoalRunOutcome({ ...base, landedWrites: { landed: false, followUpStepIds: [] } }).action, 'repursue');
  assert.equal(runner.decideGoalRunOutcome({ ...base, unsafeStepId: 'send' }).action, 'escalate', 'no ledger facts: the declared-class law');
  assert.equal(runner.decideGoalRunOutcome({ ...base, verdict: { pass: true, perCriterion: [] }, landedWrites: { landed: true, followUpStepIds: [] } }).action, 'satisfied');
  const judgeDown: GoalValidationResult = { pass: false, judgeFailedOpen: true, perCriterion: [{ criterion: 'x', pass: false, method: 'skipped' }] };
  assert.equal(runner.decideGoalRunOutcome({ ...base, verdict: judgeDown, landedWrites: { landed: true, followUpStepIds: ['main'] } }).action, 'advisory',
    'an unavailable reviewer never triggers another attempt');
});

function stepFacts(stepId: string, partial: Partial<WorkflowStepWriteFacts>): WorkflowStepWriteFacts {
  return { stepId, landed: [], unresolved: 0, disposition: 'none', landedUnobserved: false, modelDriven: false, ...partial };
}

test('unsafe-to-repeat reads what landed when the ledger is available', () => {
  const steps = [prose('fetch', 'read'), callStep('save', 'space_set_data'), prose('review', 'write'), prose('post', 'send')];
  const completed = new Set(['fetch', 'save', 'review']);
  const available = (dispositions: Record<string, WorkflowStepWriteFacts['disposition']>): WorkflowRunWriteFacts => ({
    available: true,
    steps: Object.entries(dispositions).map(([stepId, disposition]) => stepFacts(stepId, { disposition })),
  });
  assert.equal(runner.runUnsafeToRepursue(steps, completed, available({ fetch: 'none', save: 'repeat_safe', review: 'none' })), null);
  assert.equal(runner.runUnsafeToRepursue(steps, completed, available({ fetch: 'none', save: 'repeat_safe', review: 'landed' })), 'review');
  assert.equal(runner.runUnsafeToRepursue(steps, completed, available({ fetch: 'none', save: 'uncertain', review: 'none' })), 'save');
  assert.equal(runner.runUnsafeToRepursue(steps, new Set([...completed, 'post']), available({ fetch: 'none', save: 'none', review: 'none', post: 'none' })), 'post',
    'a completed send is never safe to repeat');
  assert.equal(runner.runUnsafeToRepursue(steps, completed, { available: false, steps: [] }), 'save',
    'an unreadable ledger keeps the declared-class law');
});

test('landed-write summary: an unresolved write anywhere means nothing is treated as landed', () => {
  assert.deepEqual(runner.goalRunLandedWrites({
    available: true,
    steps: [stepFacts('a', { disposition: 'landed', landed: [write('x')], modelDriven: true }), stepFacts('b', { disposition: 'uncertain' })],
  }), { landed: false, followUpStepIds: [] });
  assert.deepEqual(runner.goalRunLandedWrites({
    available: true,
    steps: [
      stepFacts('model', { disposition: 'landed', landed: [write('x')], modelDriven: true }),
      stepFacts('script', { disposition: 'landed', landedUnobserved: true }),
      stepFacts('send', { disposition: 'sent' }),
    ],
  }), { landed: true, followUpStepIds: ['model'] }, 'a completed send that the ledger saw land nothing is not a landed write');
  assert.deepEqual(runner.goalRunLandedWrites(undefined), { landed: false, followUpStepIds: [] });
});

test('follow-up lineage: carry what cannot repeat or re-check, continue model steps, run everything else again', () => {
  const lineage = runner.goalFollowUpLineageFor('run-1', {
    available: true,
    steps: [
      stepFacts('read', { disposition: 'none' }),
      stepFacts('dataset', { disposition: 'repeat_safe', landed: [write('space_set_data', true)] }),
      stepFacts('append', { disposition: 'landed', landed: [write('provider_append')] }),
      stepFacts('review', { disposition: 'landed', landed: [write('provider_update')], modelDriven: true }),
      stepFacts('post', { disposition: 'sent', modelDriven: true }),
    ],
  });
  assert.deepEqual(lineage, {
    fromRunId: 'run-1',
    carriedSteps: [{ stepId: 'append', disposition: 'landed' }, { stepId: 'post', disposition: 'sent' }],
    continuedStepIds: ['review'],
  });
  assert.deepEqual(facts.normalizeWorkflowGoalFollowUpLineage(lineage), lineage);
  assert.equal(facts.normalizeWorkflowGoalFollowUpLineage({ ...lineage, fromRunId: '../x' }), undefined);
  assert.equal(facts.normalizeWorkflowGoalFollowUpLineage({ ...lineage, continuedStepIds: ['append'] }), undefined,
    'a step is carried or continued, never both');
});

test('follow-up lineage read back: carried and continued steps stay landed in the next attempt', () => {
  const next = facts.applyGoalFollowUpLineage({
    available: true,
    steps: [stepFacts('append', { disposition: 'none' }), stepFacts('review', { disposition: 'none', modelDriven: true }), stepFacts('read', { disposition: 'none' })],
  }, { fromRunId: 'run-1', carriedSteps: [{ stepId: 'append', disposition: 'landed' }], continuedStepIds: ['review'] });
  const byId = new Map(next.steps.map((step) => [step.stepId, step]));
  assert.equal(byId.get('append')?.disposition, 'landed');
  assert.equal(byId.get('append')?.carriedFromRunId, 'run-1');
  assert.equal(byId.get('review')?.disposition, 'landed');
  assert.equal(byId.get('read')?.disposition, 'none');
  assert.equal(facts.workflowStepLandedWrites(byId.get('append')!), true);
});

test('landed-write facts for the next attempt name each write once and never a carried copy', () => {
  const text = facts.renderLandedWritesForFollowUp([
    { runId: 'run-1', facts: { available: true, steps: [stepFacts('review', { disposition: 'landed', modelDriven: true, landed: [{ ...write('provider_update'), stepId: 'review', targets: ['sheet-7'] }] })] } },
    { runId: 'run-2', facts: { available: true, steps: [stepFacts('append', { disposition: 'landed', landedUnobserved: true, carriedFromRunId: 'run-1' })] } },
  ]);
  assert.match(text, /run run-1, step "review": provider_update to sheet-7/);
  assert.doesNotMatch(text, /run-2, step "append"/);
  assert.match(text, /do not repeat them/);
  assert.equal(facts.renderLandedWritesForFollowUp([{ runId: 'r', facts: { available: true, steps: [stepFacts('x', {})] } }]), '');
});

test('recurrence never counts a finished run with a goal gap as a clean pilot success', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
  const { projectAutomationRecurrencePilotSuccess } = await import('./automation-recurrence-runtime.js');
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'pilot-gap-1.json'), JSON.stringify({
    id: 'pilot-gap-1',
    workflow: 'FRAMEWORK-TEST pilot',
    source: 'automation_pilot',
    acceptDisabled: true,
    status: 'completed',
    terminalOutcome: 'succeeded',
    goalOutcome: 'gap',
    goalReason: 'the run\'s writes landed; the goal review still found a gap',
    finishedAt: '2026-09-26T00:00:00.000Z',
    triggerReceiptId: 'automation-pilot:v1:fixture',
  }));
  const result = projectAutomationRecurrencePilotSuccess('pilot-gap-1');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.code : '', 'pilot_not_successful');
});
