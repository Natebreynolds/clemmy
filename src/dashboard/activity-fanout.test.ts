/**
 * Run: npx tsx --test src/dashboard/activity-fanout.test.ts
 *
 * A durable fan-out plan as the surfaces see it.
 *
 * A plan is ONE piece of work to a user, however many worker windows the
 * scheduler cuts it into. These drive the real journal — admit, schedule,
 * settle, reduce — and assert the projection shows the plan with the journal's
 * own counts, keeps its internal windows off the board, and never lets a plan
 * that stopped short read as finished.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-activity-fanout-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(testHome, 'state'), { recursive: true });

const {
  projectActivitySnapshot,
  shouldSurfaceInWorkingNow,
} = await import('./activity-projection.js');
const { settleFocusActionsForTerminals } = await import('./activity-settlement.js');
const { buildActivitySnapshot } = await import('../shared/activity-snapshot.js');
const fanout = await import('../execution/durable-fanout.js');
const bg = await import('../execution/background-tasks.js');
const focus = await import('../memory/focus.js');
const { createSession } = await import('../runtime/harness/eventlog.js');

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

function admitPlan(objective: string, items: string[], originSessionId?: string) {
  const admitted = fanout.admitDurableFanoutPlan({
    kind: 'durable_manifest',
    objective,
    successCriteria: ['every item settled exactly once'],
    missingRequiredInputs: [],
    effectCeiling: 'read',
    estimatedActivations: items.length,
    manifest: {
      manifestId: `test-${objective.replace(/\W+/g, '-').slice(0, 24)}`,
      contractVersion: 'v1',
      canonicalItems: items.map((id) => ({ id })),
      phases: [{ id: 'execute', dependsOn: [], runnerClass: 'worker' }],
      reducer: { id: 'reduce', requiredPhases: ['execute'], outputContract: 'report@1' },
    },
  }, {
    ...(originSessionId ? { originSessionId } : {}),
    route: { source: 'desktop' },
  });
  assert.equal(admitted.ok, true, `the fixture plan was refused: ${JSON.stringify(admitted)}`);
  return (admitted as { ok: true; plan: { planId: string } }).plan;
}

function entryFor(planId: string) {
  return projectActivitySnapshot().entries.find((entry) => entry.planId === planId);
}

test('a plan reports the journal’s own counts, not an estimate', () => {
  const plan = admitPlan('Summarize five accounts', ['a', 'b', 'c', 'd', 'e']);

  const queued = entryFor(plan.planId)!;
  assert.ok(queued, 'an admitted plan is not in the projection');
  assert.equal(queued.kind, 'fanout');
  assert.equal(queued.lifecycle, 'queued', 'a plan with no claimed window is not running');
  assert.deepEqual(queued.progress, { completed: 0, total: 5 },
    'the denominator must be the admitted contract, not a guess');

  fanout.scheduleDurableFanout(plan.planId);
  fanout.settleFanoutActivation({ planId: plan.planId, itemId: 'a', phaseId: 'execute', status: 'done' });
  fanout.settleFanoutActivation({ planId: plan.planId, itemId: 'b', phaseId: 'execute', status: 'done' });

  const running = entryFor(plan.planId)!;
  assert.deepEqual(running.progress, { completed: 2, total: 5 });
  assert.equal(running.lifecycle, 'fanout', 'a plan with claimed windows is fanning out');
  assert.equal(running.activity?.text, 'Working on 2 of 5',
    'the label must carry the journal’s counts');
  assert.equal(running.terminal, undefined, 'an unfinished plan grew a terminal');
  assert.equal(shouldSurfaceInWorkingNow(running, Date.now()), true,
    'detached plan work belongs in Working Now');
});

test('the plan is on the board and its worker windows are not', () => {
  const plan = admitPlan('Enrich twelve leads', ['l1', 'l2', 'l3']);
  const scheduled = fanout.scheduleDurableFanout(plan.planId);
  assert.ok((scheduled?.workerTasks.length ?? 0) > 0, 'the fixture scheduled no windows');

  const entries = projectActivitySnapshot().entries;
  const workerTaskIds = new Set(scheduled!.workerTasks.map((task) => task.id));
  const leaked = entries.filter((entry) => entry.taskId && workerTaskIds.has(entry.taskId));
  assert.deepEqual(leaked, [],
    'a plan sub-unit was projected beside the plan that owns it — the same work counted twice');

  // The windows really are internal work, not merely absent from the board.
  for (const task of scheduled!.workerTasks) {
    assert.equal(bg.getBackgroundTask(task.id)?.internal, true,
      'a worker window is not marked internal');
  }
  assert.ok(entries.some((entry) => entry.planId === plan.planId), 'the plan itself vanished');
});

test('the notch, App Home and Discord status show the plan and none of its windows', () => {
  const plan = admitPlan('Audit nine vendors', ['v1', 'v2', 'v3']);
  const scheduled = fanout.scheduleDurableFanout(plan.planId);
  const workerTaskIds = new Set((scheduled?.workerTasks ?? []).map((task) => task.id));

  const running = buildActivitySnapshot().runningNow;
  const planRow = running.find((row) => row.id === plan.planId);
  assert.ok(planRow, 'a running plan is invisible to the channel surfaces');
  assert.equal(planRow?.kind, 'plan');
  assert.equal(planRow?.title, 'Audit nine vendors');
  assert.deepEqual(
    running.filter((row) => workerTaskIds.has(row.id)),
    [],
    'an internal worker window reached a user-facing surface',
  );
});

test('a reducer holding its lease is live, and combining says so', () => {
  const plan = admitPlan('Combine three regions', ['r1', 'r2', 'r3']);
  fanout.scheduleDurableFanout(plan.planId);
  for (const itemId of ['r1', 'r2', 'r3']) {
    fanout.settleFanoutActivation({ planId: plan.planId, itemId, phaseId: 'execute', status: 'done' });
  }
  assert.equal(fanout.acquireFanoutReducerLease(plan.planId, 'reducer-under-test'), true);

  const entry = entryFor(plan.planId)!;
  assert.equal(entry.lifecycle, 'reducing', 'a plan whose items all settled is combining, not fanning out');
  assert.equal(entry.owner, 'reducer-under-test', 'the durable owner is not carried');
  assert.equal(entry.liveness, 'live', 'a held reducer lease read as dead while it combined');
  assert.equal(entry.activity?.text, 'Combining results');
  assert.deepEqual(entry.progress, { completed: 3, total: 3 });
  assert.equal(entry.terminal, undefined,
    'every item settling is not the plan finishing — the combine still has to land');
});

test('a plan that stopped short is never presented as finished', () => {
  const plan = admitPlan('Reconcile two ledgers', ['x', 'y']);
  fanout.scheduleDurableFanout(plan.planId);
  fanout.settleFanoutActivation({ planId: plan.planId, itemId: 'x', phaseId: 'execute', status: 'done' });
  fanout.settleFanoutActivation({ planId: plan.planId, itemId: 'y', phaseId: 'execute', status: 'failed' });

  const entry = entryFor(plan.planId)!;
  assert.notEqual(entry.lifecycle, 'completed');
  assert.notEqual(entry.terminal?.status, 'completed');
  assert.deepEqual(entry.progress, { completed: 1, total: 2 },
    'a failed item was counted as settled');
  assert.equal(JSON.stringify(entry).includes('"status":"completed"'), false,
    'an unfinished plan carries a completed status somewhere in its payload');
});

test('a settled plan settles the notebook action linked by its plan id', () => {
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'Fan-out origin' });
  const plan = admitPlan('Score forty accounts', ['s1', 's2'], session.id);

  const row = focus.createFocus({
    resourceRef: `session:${session.id}`,
    title: 'Score forty accounts',
    summary: 'fan-out fixture',
    relatedSessionId: session.id,
  });
  focus.activateFocus(row.id, session.id);
  focus.patchFocusWorkstate(row.id, {
    upsertActions: [{
      id: plan.planId,
      label: 'Score forty accounts',
      status: 'running',
      kind: 'background',
      // The dispatch tool links a fan-out by PLAN id — the identity no task or
      // run settlement path ever calls back with.
      ref: plan.planId,
    }],
  });

  fanout.scheduleDurableFanout(plan.planId);
  for (const itemId of ['s1', 's2']) {
    fanout.settleFanoutActivation({ planId: plan.planId, itemId, phaseId: 'execute', status: 'done' });
  }
  // The real reducer lifecycle: lease → admitted reducer task → its terminal.
  const reducerTask = fanout.maybeAdmitFanoutReducer(plan.planId, { owner: 'reducer-under-test' });
  assert.ok(reducerTask, 'the reducer was never admitted');
  assert.equal(
    fanout.recordFanoutReducerOutcome(plan.planId, { taskId: reducerTask!.id, outcome: 'completed' }),
    true,
  );

  const entry = entryFor(plan.planId)!;
  assert.equal(entry.terminal?.status, 'completed', 'a reduced plan has no completed terminal');
  assert.equal(shouldSurfaceInWorkingNow(entry, Date.now()), false, 'a reduced plan stayed in Working Now');

  settleFocusActionsForTerminals(projectActivitySnapshot().entries);
  const after = focus.listFocuses({ includeTerminal: true, limit: 50 }).find((f) => f.id === row.id);
  const action = focus.getFocusWorkstate(after)?.actions.find((a) => a.id === plan.planId);
  assert.equal(action?.status, 'done',
    'a reduced plan left its notebook action running because the ids differ');
});
