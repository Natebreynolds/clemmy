/**
 * Run: npx tsx --test src/execution/durable-fanout-closeout.test.ts
 *
 * R2/C closeout: plan identity comes from the whole admitted contract; the
 * ledger cannot be forged by crafted ids; workers hold WINDOW authority and
 * cannot settle work that is not theirs; phase dependencies are enforced
 * durably; users see one kickoff and one reducer terminal — not one message
 * per internal window; the reducer has a real lifecycle with retry; and dead
 * windows are reconciled during ordinary operation, not only at boot.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-fanout-closeout-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_HARNESS_BACKGROUND = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const fanout = await import('./durable-fanout.js');
const tasks = await import('./background-tasks.js');
const eventlog = await import('../runtime/harness/eventlog.js');

function manifestOf(count: number, over: Record<string, unknown> = {}) {
  return {
    manifestId: 'mf-shared',
    contractVersion: 'v1',
    canonicalItems: Array.from({ length: count }, (_, i) => ({ id: `acct-${1000 + i}` })),
    phases: [{ id: 'execute', dependsOn: [], runnerClass: 'worker' as const }],
    reducer: { id: 'reduce', requiredPhases: ['execute'], outputContract: 'report@1' },
    ...over,
  };
}

function dispositionOf(count: number, objective: string, over: Record<string, unknown> = {}) {
  return {
    kind: 'durable_manifest' as const,
    objective,
    successCriteria: ['every item counted once'],
    missingRequiredInputs: [],
    effectCeiling: 'read' as const,
    estimatedActivations: count,
    manifest: manifestOf(count),
    ...over,
  };
}

let sessions = 0;
function originSession(): { sessionId: string; sourceUserSeq: number } {
  const sessionId = `sess-c-${(sessions += 1)}`;
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: sessionId });
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  const event = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: 'fan this out', attemptId: attempt.attemptId, source: 'home' },
  }, { armRunInFlight: true });
  return { sessionId, sourceUserSeq: event.seq };
}

// ─── C.1: plan identity is the whole contract ────────────────────────────────

test('two different manifests in one reusable chat produce two plans; an exact replay rejoins', () => {
  const origin = originSession();
  const first = fanout.admitDurableFanoutPlan(
    dispositionOf(3, 'summarize the northern accounts'),
    { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq },
  );
  assert.equal(first.ok, true, JSON.stringify(first));

  // A SECOND, different manifest in the SAME accepted turn (the model split
  // one request into two dispatches; the manifestId is model-authored and NOT
  // unique). The contract is the identity — nothing else distinguishes them.
  const second = fanout.admitDurableFanoutPlan(
    dispositionOf(5, 'audit the southern invoices'),
    { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq },
  );
  assert.equal(second.ok, true, JSON.stringify(second));
  const firstPlan = (first as Extract<typeof first, { ok: true }>).plan;
  const secondPlan = (second as Extract<typeof second, { ok: true }>).plan;
  assert.notEqual(firstPlan.planId, secondPlan.planId,
    'two different admitted contracts collided into one plan');
  assert.equal(fanout.listFanoutActivations(firstPlan.planId).length, 3,
    'the second admission overwrote the first plan’s journal');

  // Byte-identical replay (a retried tool call) rejoins the SAME plan.
  const replay = fanout.admitDurableFanoutPlan(
    dispositionOf(3, 'summarize the northern accounts'),
    { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq },
  );
  assert.equal(replay.ok, true);
  assert.equal((replay as Extract<typeof replay, { ok: true }>).plan.planId, firstPlan.planId,
    'an exact replay forked a duplicate plan');
});

// ─── C.2: the ledger cannot be forged by crafted ids ─────────────────────────

test('delimiter-adversarial item and phase ids cannot fake reducer readiness', () => {
  const origin = originSession();
  // (item "x::y", phase "z") and (item "x", phase "y::z") flatten to the same
  // delimited string — settling one must never satisfy the other.
  const admitted = fanout.admitDurableFanoutPlan({
    kind: 'durable_manifest',
    objective: 'adversarial ids',
    successCriteria: [], missingRequiredInputs: [], effectCeiling: 'read', estimatedActivations: 2,
    manifest: {
      manifestId: 'mf-adv', contractVersion: 'v1',
      canonicalItems: [{ id: 'x::y' }, { id: 'x' }],
      phases: [
        { id: 'z', dependsOn: [], runnerClass: 'worker' },
        { id: 'y::z', dependsOn: [], runnerClass: 'worker' },
      ],
      reducer: { id: 'reduce', requiredPhases: ['z', 'y::z'], outputContract: 'r@1' },
    },
  }, { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;

  // Settle three of the four entries; ("x", "y::z") NEVER settles, but its
  // flattened key is already covered by ("x::y", "z").
  fanout.settleFanoutActivation({ planId, itemId: 'x::y', phaseId: 'z', status: 'done' });
  fanout.settleFanoutActivation({ planId, itemId: 'x::y', phaseId: 'y::z', status: 'done' });
  fanout.settleFanoutActivation({ planId, itemId: 'x', phaseId: 'z', status: 'done' });
  const verdict = fanout.fanoutReducerReady(planId);
  assert.equal(verdict.ready, false,
    'an entry that never settled was counted ready — ledger identity is delimiter-forgeable');
});

// ─── C.4: phase dependencies are enforced durably ────────────────────────────

test('a dependent phase cannot settle before its prerequisite phase settled for that item', () => {
  const origin = originSession();
  const admitted = fanout.admitDurableFanoutPlan({
    kind: 'durable_manifest',
    objective: 'two-phase pipeline',
    successCriteria: [], missingRequiredInputs: [], effectCeiling: 'read', estimatedActivations: 2,
    manifest: {
      manifestId: 'mf-phases', contractVersion: 'v1',
      canonicalItems: [{ id: 'row-1' }, { id: 'row-2' }],
      phases: [
        { id: 'fetch', dependsOn: [], runnerClass: 'worker' },
        { id: 'enrich', dependsOn: ['fetch'], runnerClass: 'worker' },
      ],
      reducer: { id: 'reduce', requiredPhases: ['fetch', 'enrich'], outputContract: 'r@1' },
    },
  }, { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq });
  assert.equal(admitted.ok, true);
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;

  const early = fanout.settleFanoutActivation({ planId, itemId: 'row-1', phaseId: 'enrich', status: 'done' });
  assert.equal(early.settled, false,
    'enrich settled for an item whose fetch never ran — the dependency lives only in prose');
  fanout.settleFanoutActivation({ planId, itemId: 'row-1', phaseId: 'fetch', status: 'done' });
  const after = fanout.settleFanoutActivation({ planId, itemId: 'row-1', phaseId: 'enrich', status: 'done' });
  assert.equal(after.settled, true, 'the dependency refused a legitimately ordered settlement');
});

// ─── C.5: worker window authority ────────────────────────────────────────────

test('a worker may settle only its own claimed window, never another worker’s items', async () => {
  const origin = originSession();
  const admitted = fanout.admitDurableFanoutPlan(
    dispositionOf(300, 'authority check across two windows'),
    { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq },
  );
  assert.equal(admitted.ok, true);
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  const scheduled = fanout.scheduleDurableFanout(planId);
  assert.equal(scheduled?.workerTasks.length, 2, '300 items should claim two windows');

  const [w0, w1] = scheduled!.workerTasks;
  const w1Items = fanout.listFanoutActivations(planId)
    .filter((a) => a.workerTaskId === w1!.id).map((a) => a.itemId);
  assert.ok(w1Items.length > 0);

  // Worker 0 (authenticated by ITS run session) tries to settle worker 1's item.
  const cross = fanout.settleFanoutActivationAs({
    planId, itemId: w1Items[0]!, phaseId: 'execute', status: 'done',
    callerRunSessionId: w0!.runSessionId,
  });
  assert.equal(cross.settled, false,
    'one worker settled another window’s item — settlement carries no window authority');
  const own = fanout.listFanoutActivations(planId).find((a) => a.workerTaskId === w0!.id)!;
  const legit = fanout.settleFanoutActivationAs({
    planId, itemId: own.itemId, phaseId: 'execute', status: 'done',
    callerRunSessionId: w0!.runSessionId,
  });
  assert.equal(legit.settled, true, 'window authority refused the window’s own worker');
});

// ─── C.6/C.7: one kickoff, one reducer terminal, on the originating route ────

test('internal windows never report back to the user; the reducer terminal rides the stored route', async () => {
  const origin = originSession();
  const admitted = fanout.admitDurableFanoutPlan(
    dispositionOf(3, 'route check over three items'),
    {
      originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq,
      route: { source: 'discord', channel: '112233445566778899' },
    },
  );
  assert.equal(admitted.ok, true);
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  const scheduled = fanout.scheduleDurableFanout(planId);
  for (const worker of scheduled!.workerTasks) {
    assert.equal(worker.originSessionId, undefined,
      'an internal worker window is wired to report back into the user chat');
  }
  for (const a of fanout.listFanoutActivations(planId)) {
    fanout.settleFanoutActivation({ planId, itemId: a.itemId, phaseId: a.phaseId, status: 'done' });
  }
  const reducer = fanout.maybeAdmitFanoutReducer(planId);
  assert.ok(reducer, 'no reducer admitted');
  assert.equal(reducer!.originSessionId, origin.sessionId,
    'the reducer terminal does not return to the originating chat');
  assert.equal(reducer!.source, 'discord', 'the stored delivery route was not reused for the reducer');
  assert.equal(reducer!.channel, '112233445566778899');
});

// ─── C.8: reducer lifecycle with retry ───────────────────────────────────────

test('the reducer lifecycle is ready→leased→admitted→running→completed, with failure retry', () => {
  const origin = originSession();
  const admitted = fanout.admitDurableFanoutPlan(
    dispositionOf(2, 'reducer lifecycle probe'),
    { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq },
  );
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  for (const a of fanout.listFanoutActivations(planId)) {
    fanout.settleFanoutActivation({ planId, itemId: a.itemId, phaseId: a.phaseId, status: 'done' });
  }

  const reducerTask = fanout.maybeAdmitFanoutReducer(planId);
  assert.ok(reducerTask);
  let plan = fanout.loadFanoutPlan(planId)!;
  assert.equal(plan.reducerState, 'admitted',
    'enqueueing the reducer marked the plan reduced — admission is not completion');
  assert.equal(plan.status, 'active', 'the plan closed before the reducer produced anything');

  // The reducer task FAILS on the scheduler → the lifecycle records failure
  // and a bounded retry re-admits a fresh reducer task.
  fanout.recordFanoutReducerOutcome(planId, { taskId: reducerTask!.id, outcome: 'failed' });
  plan = fanout.loadFanoutPlan(planId)!;
  assert.equal(plan.reducerState, 'failed');
  const retry = fanout.maybeAdmitFanoutReducer(planId);
  assert.ok(retry, 'a failed reduction cannot retry — the lease was never recoverable');
  assert.notEqual(retry!.id, reducerTask!.id);

  fanout.recordFanoutReducerOutcome(planId, { taskId: retry!.id, outcome: 'completed' });
  plan = fanout.loadFanoutPlan(planId)!;
  assert.equal(plan.reducerState, 'completed');
  assert.equal(plan.status, 'reduced');
  assert.equal(fanout.maybeAdmitFanoutReducer(planId), null, 'a completed plan admitted another reducer');
});

// ─── C.9: the reducer reads ALL settlements, paged ───────────────────────────

test('the reducer can page every durable settlement, not only the first 200', () => {
  const origin = originSession();
  const admitted = fanout.admitDurableFanoutPlan(
    dispositionOf(514, 'paging probe over 514 items'),
    { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq },
  );
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;
  for (const a of fanout.listFanoutActivations(planId)) {
    fanout.settleFanoutActivation({
      planId, itemId: a.itemId, phaseId: a.phaseId, status: 'done', receiptRef: `r:${a.itemId}`,
    });
  }
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = fanout.listFanoutSettlements(planId, { offset, limit: 200 });
    if (page.length === 0) break;
    for (const s of page) seen.add(s.itemId);
    offset += page.length;
  }
  assert.equal(seen.size, 514, 'the settlement read path truncates — the reducer would summarize a subset');
});

// ─── C.10: runtime reconciliation with bounded retry and honest terminals ────

test('a window that keeps dying is retried boundedly, then the plan fails honestly', () => {
  const origin = originSession();
  const admitted = fanout.admitDurableFanoutPlan(
    dispositionOf(2, 'bounded retry probe'),
    { originSessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq },
  );
  const planId = (admitted as Extract<typeof admitted, { ok: true }>).plan.planId;

  fanout.scheduleDurableFanout(planId);
  let generations = 1;
  for (let round = 0; round < 10; round += 1) {
    // Every worker is dead; ordinary-operation reconciliation both releases
    // and re-schedules, so it alone drives the retry ladder.
    const outcome = fanout.reconcileDurableFanout({
      workerTaskAlive: () => false,
      runReducer: () => {},
    });
    generations += outcome.rescheduled.includes(planId) ? 1 : 0;
    if (fanout.loadFanoutPlan(planId)!.status === 'failed') break;
  }
  const plan = fanout.loadFanoutPlan(planId)!;
  assert.equal(plan.status, 'failed',
    `a permanently dying window was retried forever (${generations} generations) instead of failing honestly`);
  assert.ok(generations <= 5, 'the retry bound is not bounded');
});
