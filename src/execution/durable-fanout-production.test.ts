/**
 * Run: npx tsx --test src/execution/durable-fanout-production.test.ts
 *
 * C-series proof at scale: an admitted typed manifest becomes REAL work on
 * the mature background scheduler. Only the model is replaced — and the
 * replaced worker has no journal powers: it reads ITS window through the
 * window-authority API and settles item by item through the same
 * authenticated path the production tool uses. 40, 120, and 514 items
 * execute through claimed bounded windows, survive a mid-window crash AND a
 * genuine child-process restart, and reduce exactly once into one user-bound
 * terminal.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-durable-fanout-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
// The scheduler's model boundary: with the harness lane off, the drain hands
// each worker turn to the injected assistant — the same replaced-model seam
// every background-task suite uses.
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const fanout = await import('./durable-fanout.js');
const tasks = await import('./background-tasks.js');
const eventlog = await import('../runtime/harness/eventlog.js');

const {
  admitDurableFanoutPlan,
  listFanoutActivations,
  listFanoutWindows,
  loadFanoutPlan,
  reconcileDurableFanout,
  scheduleDurableFanout,
  settleFanoutActivationAs,
  windowAuthorityFor,
  recordFanoutReducerOutcome,
} = fanout;

function manifestOf(count: number) {
  return {
    manifestId: `mf-${count}`,
    contractVersion: 'v1',
    canonicalItems: Array.from({ length: count }, (_, i) => ({ id: `acct-${1000 + i}` })),
    phases: [{ id: 'execute', dependsOn: [], runnerClass: 'worker' as const }],
    reducer: { id: 'reduce', requiredPhases: ['execute'], outputContract: 'report@1' },
  };
}

function dispositionOf(count: number, objective = `summarize ${count} accounts`) {
  return {
    kind: 'durable_manifest' as const,
    objective,
    successCriteria: ['every account counted once'],
    missingRequiredInputs: [],
    effectCeiling: 'read' as const,
    estimatedActivations: count,
    manifest: manifestOf(count),
  };
}

let sessions = 0;
function originSession(): string {
  const id = `sess-run-${(sessions += 1)}`;
  eventlog.createSession({ id, kind: 'chat', channel: 'home', title: id });
  return id;
}

function planIdFromPrompt(prompt: string): string | null {
  return /plan (fp_[a-z0-9]+)/.exec(prompt)?.[1] ?? null;
}

/**
 * The worker with the model replaced — and NOTHING more. It discovers its own
 * window through the same authority the production tool consults for its run
 * session, and settles ONLY those items through the authenticated path. It
 * cannot see, let alone mutate, the rest of the journal.
 */
function workerAssistant(options: {
  onOverlap?: () => void;
  crashAfter?: number;
} = {}) {
  let inFlight = 0;
  let settledTotal = 0;
  return {
    getRuntime() { return {} as never; },
    async respond(request: { message: string; sessionId: string }) {
      inFlight += 1;
      if (inFlight > 1) options.onOverlap?.();
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const planId = planIdFromPrompt(request.message);
        if (!planId) return { text: 'no plan named', sessionId: request.sessionId };
        const authority = windowAuthorityFor(planId, request.sessionId);
        if (!authority) return { text: 'no window authority', sessionId: request.sessionId };
        for (const itemId of authority.itemIds) {
          if (options.crashAfter !== undefined && settledTotal >= options.crashAfter) {
            throw new Error('worker crashed mid-window');
          }
          const settled = settleFanoutActivationAs({
            planId, itemId, phaseId: 'execute', status: 'done',
            receiptRef: `processed:${itemId}`,
            callerRunSessionId: request.sessionId,
          });
          if (settled.settled && !settled.alreadySettled) settledTotal += 1;
        }
        return { text: 'window complete', sessionId: request.sessionId };
      } finally {
        inFlight -= 1;
      }
    },
  };
}

function schedulerTaskState(taskId: string): 'alive' | 'done' | 'failed' | 'missing' {
  const task = tasks.listBackgroundTasks({ includeArchived: true }).find((t) => t.id === taskId);
  if (!task) return 'missing';
  if (task.status === 'pending' || task.status === 'running') return 'alive';
  if (task.status === 'done') return 'done';
  return 'failed';
}

// ─── real execution at 40 / 120 / 514 ───────────────────────────────────────

for (const count of [40, 120, 514]) {
  test(`${count} items execute through claimed bounded windows and reduce exactly once`, async () => {
    const session = originSession();
    const admitted = admitDurableFanoutPlan(dispositionOf(count), {
      originSessionId: session, route: { source: 'desktop' },
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;

    const scheduled = scheduleDurableFanout(planId);
    const expectedWindows = Math.ceil(count / 256);
    assert.equal(scheduled?.workerTasks.length, expectedWindows,
      `${count} items should claim ${expectedWindows} real worker window task(s)`);
    for (const worker of scheduled!.workerTasks) {
      assert.equal(worker.internal, true, 'a worker window is not an internal task');
      assert.equal(worker.originSessionId, undefined, 'a worker window would report into the user chat');
    }
    // Idempotent: claimed windows are not forked.
    assert.equal(scheduleDurableFanout(planId)?.workerTasks.length, 0, 're-scheduling forked worker tasks');

    let overlapped = false;
    const assistant = workerAssistant({ onOverlap: () => { overlapped = true; } });
    for (let round = 0; round < 6; round += 1) {
      const processed = (await Promise.all([
        tasks.processBackgroundTasks(assistant as never, 2),
        tasks.processBackgroundTasks(assistant as never, 2),
      ])).reduce((a, b) => a + b, 0);
      if (processed === 0) break;
    }

    const open = listFanoutActivations(planId).filter((a) => a.status !== 'done');
    assert.equal(open.length, 0,
      `${open.length} of ${count} item×phase activations never settled — refusal, truncation, or a ceiling`);
    if (expectedWindows > 1) {
      assert.equal(overlapped, true, 'two worker windows never overlapped despite concurrent drains');
    }

    // Reconciliation (ordinary operation) admits the reducer exactly once,
    // on the plan's persisted route, back to the origin chat.
    const first = reconcileDurableFanout({ taskState: schedulerTaskState });
    assert.equal(first.reduced.includes(planId), true, 'a complete journal admitted no reducer');
    const again = reconcileDurableFanout({ taskState: schedulerTaskState });
    assert.equal(again.reduced.includes(planId), false, 'the reducer was admitted twice');

    let plan = loadFanoutPlan(planId)!;
    assert.equal(plan.reducerState, 'admitted');
    assert.equal(plan.status, 'active', 'admission was recorded as completion');
    const reducerTask = tasks.listBackgroundTasks({ includeArchived: true })
      .find((t) => t.id === plan.reducerTaskId);
    assert.ok(reducerTask, 'the reducer is not a real durable task');
    assert.equal(reducerTask!.originSessionId, session,
      'the reducer terminal does not ride the originating route');
    assert.match(reducerTask!.prompt, /fanout_list_settlements/,
      'the reducer is not instructed to page the full journal');

    // The reducer task completes on the scheduler → the plan closes.
    recordFanoutReducerOutcome(planId, { taskId: plan.reducerTaskId!, outcome: 'completed' });
    plan = loadFanoutPlan(planId)!;
    assert.equal(plan.status, 'reduced');
    assert.equal(plan.reducerState, 'completed');
  });
}

// ─── crash and restart (in-process worker death) ────────────────────────────

test('a crashed worker restarts into reuse: settled items are never redone and the remainder completes', async () => {
  const session = originSession();
  const admitted = admitDurableFanoutPlan(dispositionOf(40, 'crash-restart over forty accounts'), {
    originSessionId: session, route: { source: 'desktop' },
  });
  assert.equal(admitted.ok, true);
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  scheduleDurableFanout(planId);

  const crashy = workerAssistant({ crashAfter: 17 });
  await tasks.processBackgroundTasks(crashy as never, 1);
  const settledAtCrash = listFanoutActivations(planId).filter((a) => a.status === 'done');
  assert.equal(settledAtCrash.length, 17, 'the crash point drifted — fix the fixture');
  const stamps = new Map(settledAtCrash.map((a) => [`${a.itemId} ${a.phaseId}`, a.updatedAt]));

  const outcome = reconcileDurableFanout({ taskState: schedulerTaskState });
  assert.equal(outcome.rescheduled.includes(planId), true, 'the dead window was not re-scheduled');
  assert.equal(outcome.reduced.includes(planId), false, 'the reducer ran before the journal was complete');

  const healthy = workerAssistant();
  for (let round = 0; round < 4; round += 1) {
    if (await tasks.processBackgroundTasks(healthy as never, 1) === 0) break;
  }
  const after = listFanoutActivations(planId);
  assert.equal(after.filter((a) => a.status !== 'done').length, 0, 'the remainder never completed after restart');
  for (const [key, updatedAt] of stamps) {
    const [itemId, phaseId] = key.split(' ');
    const row = after.find((a) => a.itemId === itemId && a.phaseId === phaseId)!;
    assert.equal(row.updatedAt, updatedAt, `settled work was redone after restart: ${itemId}`);
  }
});

// ─── genuine child-process restart ──────────────────────────────────────────

test('a child process settles part of a window, dies, and this process completes and reduces once', () => {
  const session = originSession();
  const admitted = admitDurableFanoutPlan(dispositionOf(12, 'child process restart proof'), {
    originSessionId: session, route: { source: 'desktop' },
  });
  assert.equal(admitted.ok, true);
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  scheduleDurableFanout(planId);
  const window = listFanoutWindows(planId)[0]!;
  assert.ok(window.runSessionId, 'the claimed window has no worker session to authenticate as');

  // A REAL separate process, sharing only the durable stores, settles five
  // items through the authenticated path and exits without finishing.
  const script = `
    process.env.CLEMENTINE_HOME = ${JSON.stringify(TMP_HOME)};
    const fanout = await import(${JSON.stringify(path.resolve('src/execution/durable-fanout.ts'))});
    const authority = fanout.windowAuthorityFor(${JSON.stringify(planId)}, ${JSON.stringify(window.runSessionId)});
    if (!authority) throw new Error('child holds no window authority');
    for (const itemId of authority.itemIds.slice(0, 5)) {
      const settled = fanout.settleFanoutActivationAs({
        planId: ${JSON.stringify(planId)}, itemId, phaseId: 'execute', status: 'done',
        receiptRef: 'child:' + itemId,
        callerRunSessionId: ${JSON.stringify(window.runSessionId)},
      });
      if (!settled.settled) throw new Error('child settlement refused: ' + settled.reason);
    }
    console.log('CHILD_SETTLED');
  `;
  const scriptPath = path.join(TMP_HOME, 'child-worker.mts');
  writeFileSync(scriptPath, script, 'utf-8');
  const stdout = execFileSync('npx', ['tsx', scriptPath], { encoding: 'utf-8', timeout: 120_000 });
  assert.match(stdout, /CHILD_SETTLED/);

  // Back in THIS process: the child's settlements are durable truth.
  const settled = listFanoutActivations(planId).filter((a) => a.status === 'done');
  assert.equal(settled.length, 5, 'the child’s settlements did not survive the process boundary');

  // The child died mid-window; reconciliation releases and completes here.
  const outcome = reconcileDurableFanout({ taskState: () => 'missing' });
  assert.equal(outcome.rescheduled.includes(planId), true);
  const newWindow = listFanoutWindows(planId)[0]!;
  assert.ok(newWindow.generation > window.generation, 'the re-claimed window kept the dead generation');
  assert.notEqual(newWindow.runSessionId, window.runSessionId,
    'the dead worker session still holds authority over the re-claimed window');
  // The DEAD child's authority is gone: its old session can no longer settle.
  const stale = settleFanoutActivationAs({
    planId, itemId: newWindow.itemIds.find((id) => !settled.some((s) => s.itemId === id))!,
    phaseId: 'execute', status: 'done', callerRunSessionId: window.runSessionId!,
  });
  assert.equal(stale.settled, false, 'a dead generation’s authority settled into the live window');

  for (const itemId of newWindow.itemIds) {
    settleFanoutActivationAs({
      planId, itemId, phaseId: 'execute', status: 'done',
      callerRunSessionId: newWindow.runSessionId!,
    });
  }
  const finalReconcile = reconcileDurableFanout({ taskState: () => 'missing' });
  assert.equal(finalReconcile.reduced.includes(planId), true, 'the completed journal admitted no reducer');
  const plan = loadFanoutPlan(planId)!;
  recordFanoutReducerOutcome(planId, { taskId: plan.reducerTaskId!, outcome: 'completed' });
  assert.equal(loadFanoutPlan(planId)!.status, 'reduced');
});
