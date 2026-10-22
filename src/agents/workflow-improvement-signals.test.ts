/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/workflow-improvement-signals.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowImprovementSignals } from './workflow-improvement-signals.js';

test('a workflow its own permissions refused, or whose goal fell short, is named; a clean one is not', () => {
  const events: Record<string, Array<{ kind: string; stepId?: string; meta?: Record<string, unknown> }>> = {
    r1: [{ kind: 'step_started', stepId: 'main' }, { kind: 'step_started', stepId: '(run goal)' },
      { kind: 'verdict_recorded', meta: { door: 'goal_validation', pass: false, criteriaMet: 2, criteriaTotal: 3 } }],
    r2: [{ kind: 'step_started', stepId: 'main' }, { kind: 'verdict_recorded', meta: { door: 'goal_validation', pass: true, criteriaMet: 3, criteriaTotal: 3 } }],
    clean: [{ kind: 'step_started', stepId: 'main' }],
    repair: [{ kind: 'step_started', stepId: 'main' }],
  };
  const stepsAsked: string[][] = [];
  const signals = workflowImprovementSignals([
    { runId: 'r1', workflow: 'channel-review', status: 'completed' },
    { runId: 'r2', workflow: 'channel-review', status: 'completed' },
    { runId: 'clean', workflow: 'digest', status: 'completed' },
    // A single re-run step repairs another run; it is not the workflow's own run.
    { runId: 'repair', workflow: 'digest', status: 'completed', targetStepId: 'main' },
  ], {
    readEvents: (_workflow, runId) => events[runId] ?? [],
    refusals: (runId, stepIds) => {
      stepsAsked.push([...stepIds]);
      return runId === 'r1' || runId === 'r2' ? [{ stepId: 'main', tool: 'space_refresh', reason: 'coverage_missing' }] : [];
    },
  });
  assert.deepEqual(signals, [{ workflow: 'channel-review', runsSeen: 2, refusedByOwnDefinition: ['space_refresh'], goalShortfalls: ['2/3'] }]);
  assert.ok(stepsAsked.every((ids) => ids.every((id) => !id.startsWith('('))), 'bookkeeping nodes are not steps');
});
