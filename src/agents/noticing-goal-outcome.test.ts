import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalOutcomeProgress } from './goal-outcome-progress.js';
import { compactGoalOutcomeProgressForNoticing, DEFAULT_NOTICING_CONFIG, emptyNoticingState,
  runNoticingTick, type NoticingObservation, type NoticingTickDeps } from './noticing.js';

function progress(): GoalOutcomeProgress {
  return { version: 1, availability: 'available', summary: 'Historical subtask evidence; the whole goal remains unchanged. '.repeat(8),
    omittedTasks: 3, linkedTasks: Array.from({ length: 4 }, (_, task) => ({
      proposalId: `proposal-${task}`, title: 'A long display-only title. '.repeat(40),
      sessionId: `session-${task}`, sourceUserSeq: task + 1, goalBinding: 'current', state: 'needs_attention',
      detail: 'Full display evidence stays in the UI. '.repeat(100), omittedWorkflows: 2,
      workflows: Array.from({ length: 4 }, (_, run) => ({ runId: `run-${task}-${run}`,
        workflowName: 'Long display-only workflow name. '.repeat(20), state: 'not_satisfied', contractId: `contract-${task}-${run}`,
        criteria: { total: 8, passed: 1, remaining: Array.from({ length: 7 }, (_, i) => `Criterion ${i}: ${'x'.repeat(220)}`) },
        artifactReadback: 'not_checked', detail: 'Full artifact evidence stays in the UI. '.repeat(100) })),
    })) };
}

test('Noticing outcome context keeps exact identities and bounded evidence with explicit omissions', () => {
  const full = progress();
  const before = structuredClone(full);
  const compact = compactGoalOutcomeProgressForNoticing(full);
  assert.equal(compact.availability, 'available');
  assert.ok(compact.summary.length <= 180);
  assert.equal(compact.linkedTasks.length, 2);
  assert.equal(compact.omittedTasks, 5);
  for (const [i, task] of compact.linkedTasks.entries()) {
    assert.equal(task.proposalId, full.linkedTasks[i]!.proposalId);
    assert.equal(task.sessionId, full.linkedTasks[i]!.sessionId);
    assert.equal(task.sourceUserSeq, full.linkedTasks[i]!.sourceUserSeq);
    assert.equal(task.state, 'needs_attention', 'bounded context does not turn omitted evidence into completion');
    assert.equal(task.workflows.length, 2);
    assert.equal(task.omittedWorkflows, 4, 'preserves omissions from both the shared reader and this projection');
    assert.equal('title' in task, false);
    assert.equal('detail' in task, false);
    for (const [j, workflow] of task.workflows.entries()) {
      assert.equal(workflow.runId, full.linkedTasks[i]!.workflows[j]!.runId);
      assert.equal(workflow.criteria.total, 8);
      assert.equal(workflow.criteria.passed, 1);
      assert.equal(workflow.criteria.remaining.length, 2);
      assert.ok(workflow.criteria.remaining.every(text => text.length <= 120));
      assert.equal(workflow.criteria.omittedRemaining, 5);
      assert.equal('workflowName' in workflow, false);
      assert.equal('contractId' in workflow, false);
      assert.equal('detail' in workflow, false);
    }
  }
  assert.ok(JSON.stringify(compact).length < 4_000);
  assert.deepEqual(full, before, 'the full durable/UI evidence is not changed');
});

test('an overlong identity is omitted with its entry instead of being truncated into another identity', () => {
  const full = progress();
  full.linkedTasks[0]!.sessionId = 's'.repeat(161);
  full.linkedTasks[1]!.workflows[0]!.runId = 'r'.repeat(161);
  const compact = compactGoalOutcomeProgressForNoticing(full);
  assert.deepEqual(compact.linkedTasks.map(task => task.proposalId), ['proposal-1', 'proposal-2']);
  assert.equal(compact.omittedTasks, 5);
  assert.deepEqual(compact.linkedTasks[0]!.workflows.map(run => run.runId), ['run-1-1', 'run-1-2']);
  assert.equal(compact.linkedTasks[0]!.omittedWorkflows, 4);
  assert.ok(!JSON.stringify(compact).includes('r'.repeat(160)));
});

test('an unavailable outcome read stays distinct from a readable empty relation', () => {
  const unknown = compactGoalOutcomeProgressForNoticing({ version: 1, availability: 'unavailable',
    summary: 'Linked evidence is unavailable.', linkedTasks: [], omittedTasks: 0 });
  const empty = compactGoalOutcomeProgressForNoticing({ version: 1, availability: 'available',
    summary: 'No linked task is retained.', linkedTasks: [], omittedTasks: 0 });
  assert.notDeepEqual(unknown, empty);
  assert.equal(unknown.availability, 'unavailable');
});

test('workflow status and artifact readback changes invalidate decision reuse while a clock-only change does not', async () => {
  const full = progress();
  full.linkedTasks[0]!.workflows[0]!.state = 'satisfied';
  full.linkedTasks[0]!.workflows[0]!.criteria = { total: 1, passed: 1, remaining: [] };
  full.linkedTasks[0]!.workflows[0]!.artifactReadback = 'verified';
  let now = Date.parse('2026-10-17T12:00:00.000Z');
  let state = emptyNoticingState();
  let calls = 0;
  const observation = (): NoticingObservation => ({ at: new Date(now).toISOString(),
    goals: [{ id: 'controlled-goal', title: 'Controlled local draft goal', status: 'active', priority: 'medium',
      updatedAt: '2026-10-17T10:00:00.000Z', progressNotes: [], nextActions: ['Review the local draft.'], blockers: [],
      outcomeProgress: compactGoalOutcomeProgressForNoticing(full) }],
    work: { runs: [], waits: [], drafts: [] }, calendar: [], conversations: [], memories: [] });
  const deps: NoticingTickDeps = { now: () => now, tickId: 'controlled-goal-context', source: 'heartbeat',
    config: { ...DEFAULT_NOTICING_CONFIG }, rules: ['Never send this draft.'], observe: async () => observation(),
    propose: async ({ evidenceDigest }) => { calls++; return { modelIdentity: 'controlled-reader',
      answer: { proposal: null, setAside: [], evidenceDigest } }; },
    ask: async () => { throw new Error('this control must not publish a proposal'); },
    isAnswered: () => ({ answered: false }), loadState: () => state, saveState: next => { state = next; } };
  assert.equal((await runNoticingTick(deps)).modelCheck, 'fresh');
  const fingerprint = state.decisionReuse!.fingerprint;
  now += 30 * 60_000;
  assert.equal((await runNoticingTick(deps)).modelCheck, 'recent_unchanged');
  assert.equal(state.decisionReuse!.fingerprint, fingerprint);
  assert.equal(calls, 1);
  full.linkedTasks[0]!.workflows[0]!.state = 'not_satisfied';
  now += 5 * 60_000;
  assert.equal((await runNoticingTick(deps)).modelCheck, 'fresh');
  assert.notEqual(state.decisionReuse!.fingerprint, fingerprint);
  const changedState = state.decisionReuse!.fingerprint;
  full.linkedTasks[0]!.workflows[0]!.artifactReadback = 'changed_or_unavailable';
  now += 5 * 60_000;
  assert.equal((await runNoticingTick(deps)).modelCheck, 'fresh');
  assert.notEqual(state.decisionReuse!.fingerprint, changedState);
  assert.equal(calls, 3);
});
