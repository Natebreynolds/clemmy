/**
 * Run: npx tsx --test src/execution/workflow-readiness.test.ts
 *
 * DIFFERENTIAL GATE: graph-derived readiness must equal the runner's original
 * topological planner on every valid shape. `planWorkflowExecutionBatches` is
 * the reference oracle here — if the graph path ever diverges, this fails
 * instead of silently reordering someone's production workflow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflowReadiness } from './workflow-readiness.js';
import { planWorkflowExecutionBatches } from './workflow-runner.js';
import { compileWorkflowStepsToGraph, validateWorkflowGraph, applyWorkflowGraphPatch } from './workflow-graph.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

const step = (id: string, dependsOn: string[] = []): WorkflowStepInput =>
  ({ id, prompt: `do ${id}`, dependsOn } as WorkflowStepInput);

/** Shapes that cover the real corpus: linear, diamond, fan-out, fan-in,
 *  disjoint islands, deep chains, and wide first waves. */
const CORPUS: Array<{ name: string; steps: WorkflowStepInput[] }> = [
  { name: 'single', steps: [step('a')] },
  { name: 'linear', steps: [step('a'), step('b', ['a']), step('c', ['b'])] },
  { name: 'diamond', steps: [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])] },
  { name: 'wide fan-out', steps: [step('root'), ...['x', 'y', 'z', 'w'].map((id) => step(id, ['root']))] },
  { name: 'fan-in', steps: [step('a'), step('b'), step('c'), step('join', ['a', 'b', 'c'])] },
  { name: 'disjoint islands', steps: [step('a'), step('b', ['a']), step('m'), step('n', ['m'])] },
  { name: 'deep chain', steps: Array.from({ length: 12 }, (_, i) => step(`s${i}`, i === 0 ? [] : [`s${i - 1}`])) },
  {
    name: 'mixed depth',
    steps: [
      step('pull'), step('enrich', ['pull']), step('verify', ['enrich']),
      step('report', ['verify', 'pull']), step('notify', ['report']), step('audit', ['pull']),
    ],
  },
];

/** Every completion prefix, not just the empty one — resume enters the loop
 *  with an arbitrary completed set, which is exactly where an ordering bug
 *  would hide. */
function completionPrefixes(steps: WorkflowStepInput[]): Set<string>[] {
  const prefixes: Set<string>[] = [new Set()];
  const completed = new Set<string>();
  for (const batch of planWorkflowExecutionBatches(steps)) {
    for (const s of batch) completed.add(s.id);
    prefixes.push(new Set(completed));
  }
  return prefixes;
}

test('graph readiness equals the planner on every corpus shape and completion prefix', () => {
  for (const { name, steps } of CORPUS) {
    assert.equal(validateWorkflowGraph(compileWorkflowStepsToGraph(steps)).ok, true, `${name}: graph must validate`);
    for (const completed of completionPrefixes(steps)) {
      const oracle = (planWorkflowExecutionBatches(steps, completed)[0] ?? []).map((s) => s.id).sort();
      const actual = [...resolveWorkflowReadiness(steps, completed).readyStepIds].sort();
      assert.deepEqual(actual, oracle, `${name}: divergence at completed={${[...completed].join(',')}}`);
    }
  }
});

test('a blocked step withholds its dependents without stalling independent branches', () => {
  const steps = [step('a'), step('b', ['a']), step('m'), step('n', ['m'])];
  // 'a' is blocked: 'b' must never become ready, but the m→n island proceeds.
  const first = resolveWorkflowReadiness(steps, [], { blockedStepIds: ['a'] });
  assert.deepEqual(first.readyStepIds.sort(), ['m']);
  assert.equal(first.structurallyStalled, false);

  const afterM = resolveWorkflowReadiness(steps, ['m'], { blockedStepIds: ['a'] });
  assert.deepEqual(afterM.readyStepIds, ['n']);

  const exhausted = resolveWorkflowReadiness(steps, ['m', 'n'], { blockedStepIds: ['a'] });
  assert.deepEqual(exhausted.readyStepIds, []);
  assert.equal(exhausted.structurallyStalled, true, 'only the blocked subtree remains');
  assert.match(exhausted.stalledDetail ?? '', /b waits for a/);
});

test('an unprogressable definition stalls explicitly instead of looping or throwing', () => {
  // Cyclic: the planner throws; readiness reports a named stall. The admission
  // validator is what rejects this shape — see the assertion below.
  const cyclic = [step('a', ['b']), step('b', ['a'])];
  const readiness = resolveWorkflowReadiness(cyclic, []);
  assert.deepEqual(readiness.readyStepIds, []);
  assert.equal(readiness.structurallyStalled, true);
  assert.match(readiness.stalledDetail ?? '', /a waits for b/);
  assert.equal(validateWorkflowGraph(compileWorkflowStepsToGraph(cyclic)).ok, false, 'cycles are rejected at admission');

  // Unknown dependency: same contract — named stall here, rejected at admission.
  const unknownDep = [step('a'), step('b', ['ghost'])];
  const unknown = resolveWorkflowReadiness(unknownDep, ['a']);
  assert.deepEqual(unknown.readyStepIds, []);
  assert.equal(unknown.structurallyStalled, true);
  const validation = validateWorkflowGraph(compileWorkflowStepsToGraph(unknownDep));
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => /unknown source node "ghost"/.test(e)));
});

test('completed work is never re-offered and a finished run reports no stall', () => {
  const steps = [step('a'), step('b', ['a'])];
  const done = resolveWorkflowReadiness(steps, ['a', 'b']);
  assert.deepEqual(done.readyStepIds, []);
  assert.equal(done.structurallyStalled, false, 'nothing remains — that is completion, not a stall');
});

test('readiness follows a patched graph — the reshape actually changes what runs next', () => {
  // This is the Phase 1 payoff: the graph decides, so a structural change to it
  // changes execution. Without this wiring a patch could never take effect.
  const steps = [step('pull'), step('analyze', ['pull'])];
  const base = compileWorkflowStepsToGraph(steps);

  const widened = applyWorkflowGraphPatch(base, {
    operations: [
      { op: 'add_node', node: { id: 'analyze-b', type: 'step', label: 'second branch' } },
      { op: 'add_edge', edge: { id: 'pull->analyze-b:dependency', source: 'pull', target: 'analyze-b', type: 'dependency' } },
    ],
    reason: 'split the analysis into parallel branches',
  });
  assert.equal(widened.ok, true, widened.errors.join('; '));

  const patchedSteps = [...steps, step('analyze-b', ['pull'])];
  const readiness = resolveWorkflowReadiness(patchedSteps, ['pull'], { graph: widened.graph });
  assert.deepEqual(readiness.readyStepIds.sort(), ['analyze', 'analyze-b']);

  // Disabling an edge withholds its target without deleting proven work.
  const narrowed = applyWorkflowGraphPatch(widened.graph, {
    operations: [{ op: 'disable_edge', edgeId: 'pull->analyze-b:dependency', reason: 'source rate-limited' }],
  });
  assert.equal(narrowed.ok, true, narrowed.errors.join('; '));
  const afterDisable = resolveWorkflowReadiness(patchedSteps, ['pull'], { graph: narrowed.graph });
  assert.deepEqual(afterDisable.readyStepIds, ['analyze'], 'a disabled edge withholds only its own target');
});
