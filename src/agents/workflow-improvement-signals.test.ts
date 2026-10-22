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
  const now = Date.parse('2026-10-22T00:00:00Z');
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const signals = workflowImprovementSignals([
    // The observed window is in file-name order; a stale run comes first here.
    { runId: 'stale', workflow: 'channel-review', status: 'completed', createdAt: at(24 * 30) },
    { runId: 'r2', workflow: 'channel-review', status: 'completed', createdAt: at(1) },
    { runId: 'r1', workflow: 'channel-review', status: 'completed', createdAt: at(2) },
    { runId: 'clean', workflow: 'digest', status: 'completed', createdAt: at(3) },
    // A single re-run step repairs another run; it is not the workflow's own run.
    { runId: 'repair', workflow: 'digest', status: 'completed', createdAt: at(1), targetStepId: 'main' },
  ], {
    now,
    pendingStepProposals: () => [
      { kind: 'workflow_step', target: 'digest::main', evidence: 'same problem in 2 distinct runs: "missing required output key \"summary\""' },
      { kind: 'doctor_fix', target: 'digest', evidence: 'not a step problem' },
    ],
    readEvents: (_workflow, runId) => events[runId] ?? [],
    refusals: (runId, stepIds) => {
      stepsAsked.push([...stepIds]);
      if (runId === 'stale') throw new Error('a month-old run is not read');
      return runId === 'r1' || runId === 'r2' ? [{ stepId: 'main', tool: 'space_refresh', reason: 'coverage_missing' }] : [];
    },
  });
  assert.deepEqual(signals, [
    { workflow: 'channel-review', runsSeen: 2, refusedByOwnDefinition: ['space_refresh'], goalShortfalls: ['2/3'] },
    // A clean recent run still carries the queue's recurring step problem.
    { workflow: 'digest', runsSeen: 1, refusedByOwnDefinition: [], goalShortfalls: [],
      recurringStepProblems: ['same problem in 2 distinct runs: "missing required output key \"summary\""'] },
  ]);
  assert.ok(stepsAsked.every((ids) => ids.every((id) => !id.startsWith('('))), 'bookkeeping nodes are not steps');
});
