/**
 * Run: npx tsx --test src/execution/durable-fanout-production.test.ts
 *
 * C-series proof: an admitted typed manifest becomes REAL work on the mature
 * background scheduler. The only thing replaced is the model — the fake
 * assistant plays a worker by doing exactly what the production worker prompt
 * instructs (list its plan's open items, settle each through the real journal
 * API). Everything else is production machinery: the dispatch tool's manifest
 * lane, durable task records, bounded-concurrency processing, the item×phase
 * journal, the reducer lease, and restart reconciliation.
 */
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
  loadFanoutPlan,
  maybeAdmitFanoutReducer,
  scheduleDurableFanout,
  settleFanoutActivation,
  reconcileDurableFanout,
  fanoutReducerReady,
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

function originSession(id: string): string {
  if (!eventlog.getSession(id)) {
    eventlog.createSession({ id, kind: 'chat', channel: 'home', title: id });
  }
  return id;
}

/** Extract the plan id a worker prompt names — what the model would read. */
function planIdFromPrompt(prompt: string): string | null {
  return /plan (fp_[a-z0-9]+)/.exec(prompt)?.[1] ?? null;
}

/**
 * The worker with the model replaced: does exactly what the production prompt
 * instructs — finds its plan, settles every still-open item it can see, using
 * only the public journal API a real tool call would hit.
 */
function workerAssistant(options: {
  onOverlap?: () => void;
  settleLimit?: number;
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
        // Yield so a concurrently-started worker can register overlap.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const planId = planIdFromPrompt(request.message);
        if (!planId) return { text: 'no plan named', sessionId: request.sessionId };
        for (const activation of listFanoutActivations(planId)) {
          if (activation.status === 'done') continue;
          if (options.crashAfter !== undefined && settledTotal >= options.crashAfter) {
            throw new Error('worker crashed mid-window');
          }
          const settled = settleFanoutActivation({
            planId, itemId: activation.itemId, phaseId: activation.phaseId,
            status: 'done', receiptRef: `processed:${activation.itemId}`,
          });
          if (settled.settled && !settled.alreadySettled) settledTotal += 1;
          if (options.settleLimit !== undefined && settledTotal >= options.settleLimit) break;
        }
        return { text: 'window complete', sessionId: request.sessionId };
      } finally {
        inFlight -= 1;
      }
    },
  };
}

// ─── the journal is the readiness authority ──────────────────────────────────

test('reducer readiness and the once-only lease come from the journal, not callers', () => {
  const admitted = admitDurableFanoutPlan(dispositionOf(3, 'lease check over three accounts'), {
    originSessionId: originSession('sess-lease'),
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;

  assert.equal(fanoutReducerReady(planId).ready, false);
  assert.equal(fanout.acquireFanoutReducerLease(planId, 'early'), false,
    'the lease was granted before the journal was complete');

  for (const a of listFanoutActivations(planId)) {
    settleFanoutActivation({ planId, itemId: a.itemId, phaseId: a.phaseId, status: 'done' });
  }
  assert.equal(fanoutReducerReady(planId).ready, true);

  const grants = ['a', 'b', 'c', 'd'].map((owner) => fanout.acquireFanoutReducerLease(planId, owner));
  assert.deepEqual(grants, [true, false, false, false], 'the reducer lease was granted more than once');
});

test('settlement is exactly-once: a retry observes alreadySettled and cannot regress a terminal', () => {
  const admitted = admitDurableFanoutPlan(dispositionOf(2, 'exactly once over two accounts'), {
    originSessionId: originSession('sess-once'),
  });
  assert.equal(admitted.ok, true);
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  const [first] = listFanoutActivations(planId);
  const a = settleFanoutActivation({ planId, itemId: first!.itemId, phaseId: first!.phaseId, status: 'done', receiptRef: 'r1' });
  const b = settleFanoutActivation({ planId, itemId: first!.itemId, phaseId: first!.phaseId, status: 'done', receiptRef: 'r2' });
  assert.deepEqual(a, { settled: true, alreadySettled: false });
  assert.deepEqual(b, { settled: true, alreadySettled: true });
  // A later "failed" cannot un-settle done work.
  const c = settleFanoutActivation({ planId, itemId: first!.itemId, phaseId: first!.phaseId, status: 'failed' });
  assert.equal(c.settled && c.alreadySettled, true);
  const row = listFanoutActivations(planId).find((x) => x.itemId === first!.itemId)!;
  assert.equal(row.status, 'done');
  assert.equal(row.receiptRef, 'r1', 'a retry overwrote the original settlement receipt');
});

test('a settlement for an item the plan never named is refused', () => {
  const admitted = admitDurableFanoutPlan(dispositionOf(2, 'forged settlement check'), {
    originSessionId: originSession('sess-forged'),
  });
  assert.equal(admitted.ok, true);
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  const forged = settleFanoutActivation({ planId, itemId: 'acct-9999999', phaseId: 'execute', status: 'done' });
  assert.equal(forged.settled, false);
  assert.equal(fanoutReducerReady(planId).ready, false);
});

// ─── explicit background without a manifest ─────────────────────────────────

test('explicit background with no manifest compiles to the canonical one-item durable contract', () => {
  const admitted = admitDurableFanoutPlan({
    kind: 'direct',
    objective: 'keep an eye on the renewal queue overnight',
    successCriteria: [],
    missingRequiredInputs: [],
    effectCeiling: 'read',
    estimatedActivations: 1,
  }, { originSessionId: originSession('sess-single'), controls: { explicit: 'background' } });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const plan = (admitted as Extract<typeof admitted, { ok: true }>).plan;
  const activations = listFanoutActivations(plan.planId);
  assert.equal(activations.length, 1, 'the durable-single contract is not one item × one phase');
  const scheduled = scheduleDurableFanout(plan.planId);
  assert.equal(scheduled?.workerTasks.length, 1, 'the single-item plan produced no real durable task');
});

// ─── real execution at 40 / 120 / 514 ───────────────────────────────────────

for (const count of [40, 120, 514]) {
  test(`${count} items execute fully on the mature scheduler and reduce exactly once`, async () => {
    const session = originSession(`sess-run-${count}`);
    const admitted = admitDurableFanoutPlan(dispositionOf(count), { originSessionId: session });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;

    const before = tasks.listBackgroundTasks({ includeArchived: true }).length;
    const scheduled = scheduleDurableFanout(planId);
    assert.ok(scheduled);
    const expectedWindows = Math.ceil(count / 256);
    assert.equal(scheduled!.workerTasks.length, expectedWindows,
      `${count} items should schedule ${expectedWindows} real worker window task(s)`);
    assert.equal(
      tasks.listBackgroundTasks({ includeArchived: true }).length - before,
      expectedWindows,
      'the windows are not real durable background tasks',
    );

    // Idempotent re-scheduling: the windows are owned; nothing forks.
    const again = scheduleDurableFanout(planId);
    assert.equal(again?.workerTasks.length, 0, 're-scheduling forked duplicate worker tasks');

    let overlapped = false;
    const assistant = workerAssistant({ onOverlap: () => { overlapped = true; } });
    // Two drain ticks land while work is pending — the production shape
    // (interval tick + requestBackgroundDrain kick). Policy capacity lets them
    // claim disjoint windows, so real workers overlap.
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
      assert.equal(overlapped, true, 'two worker windows never overlapped despite concurrency 2');
    }

    // The last settlement admits the reducer exactly once (the settle tool
    // path calls this in production; reconciliation is the backstop).
    const reducerTask = maybeAdmitFanoutReducer(planId);
    const reducerAgain = maybeAdmitFanoutReducer(planId);
    assert.ok(reducerTask, 'no reducer task was admitted for a complete journal');
    assert.equal(reducerAgain, null, 'the reducer was admitted twice');
    const plan = loadFanoutPlan(planId)!;
    assert.equal(plan.status, 'reduced');
    assert.equal(plan.reducerTaskId, reducerTask!.id);
    assert.match(reducerTask!.prompt, /Do not reprocess items/,
      'the reducer prompt does not carry the no-reprocess contract');
  });
}

// ─── crash and restart ──────────────────────────────────────────────────────

test('a crashed worker restarts into reuse: settled items are never redone, the remainder completes, the reducer runs once', async () => {
  const session = originSession('sess-crash');
  const admitted = admitDurableFanoutPlan(dispositionOf(40, 'crash-restart over forty accounts'), {
    originSessionId: session,
  });
  assert.equal(admitted.ok, true);
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  scheduleDurableFanout(planId);

  // The worker settles 17 items then dies mid-window.
  const crashy = workerAssistant({ crashAfter: 17 });
  await tasks.processBackgroundTasks(crashy as never, 1);
  const settledAtCrash = listFanoutActivations(planId).filter((a) => a.status === 'done');
  assert.equal(settledAtCrash.length, 17, 'the crash point drifted — fix the fixture');
  const receiptsAtCrash = new Map(settledAtCrash.map((a) => [`${a.itemId}::${a.phaseId}`, a.updatedAt]));

  // "Restart": reconciliation observes the dead worker (its task is terminal
  // on the scheduler), releases the window, and re-schedules the remainder.
  // Other plans in this store may legitimately reduce here; THIS plan's
  // journal is incomplete and must not.
  const reducedPlans: string[] = [];
  const outcome = reconcileDurableFanout({
    workerTaskAlive: (taskId) => {
      const task = tasks.listBackgroundTasks({ includeArchived: true }).find((t) => t.id === taskId);
      return Boolean(task && (task.status === 'pending' || task.status === 'running'));
    },
    runReducer: (plan) => { reducedPlans.push(plan.planId); },
  });
  assert.equal(outcome.rescheduled.includes(planId), true, 'the dead window was not re-scheduled');
  assert.equal(reducedPlans.includes(planId), false, 'the reducer ran before the journal was complete');

  const healthy = workerAssistant();
  for (let round = 0; round < 4; round += 1) {
    const processed = await tasks.processBackgroundTasks(healthy as never, 1);
    if (processed === 0) break;
  }
  const after = listFanoutActivations(planId);
  assert.equal(after.filter((a) => a.status !== 'done').length, 0, 'the remainder never completed after restart');
  for (const [key, updatedAt] of receiptsAtCrash) {
    const row = after.find((a) => `${a.itemId}::${a.phaseId}` === key)!;
    assert.equal(row.updatedAt, updatedAt, `settled work was redone after restart: ${key}`);
  }

  const reducerTask = maybeAdmitFanoutReducer(planId);
  assert.ok(reducerTask, 'the completed journal admitted no reducer');
  assert.equal(maybeAdmitFanoutReducer(planId), null, 'restart admitted a second reducer');
});
