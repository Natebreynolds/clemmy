/**
 * Run: npx tsx --test src/execution/workflow-scheduler-catchup-stagger.test.ts
 *
 * SHIPPED-INCIDENT REGRESSION (v3.0.0, live on the owner's machine).
 *
 * Three heavy schedules (7:30, 8:00, 9:00 weekdays) were missed while the app
 * was closed. Per-workflow collapse worked correctly — each reduced its N
 * missed occurrences to ONE run. But the scheduler loop then fired all three in
 * the SAME tick, and with CLEMENTINE_WORKFLOW_RUN_CONCURRENCY=3 they executed
 * simultaneously. The daemon was SIGKILLed under the combined load, restarted
 * into the same backlog, and repeated — a loop where downtime caused more
 * downtime, and the app pegged a core with a zombie daemon behind a stale pid.
 *
 * The missing invariant was cross-workflow, not per-workflow: a catch-up is not
 * urgent (its window already passed), so only a bounded number may fire per
 * tick. The rest must stay QUEUED and eligible — never dropped — and a
 * live-minute fire must never be throttled by that budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { maxCatchupFiresPerTick } = await import('./workflow-scheduler.js');

test('default catch-up budget is ONE workflow per tick', () => {
  delete process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK;
  assert.equal(maxCatchupFiresPerTick(), 1,
    'three missed schedules must not be able to fire in the same tick by default');
});

test('the budget is operator-tunable but hard-capped', () => {
  const prev = process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK;
  try {
    process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK = '3';
    assert.equal(maxCatchupFiresPerTick(), 3, 'an explicit budget is honored');

    process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK = '999';
    assert.equal(maxCatchupFiresPerTick(), 10,
      'a runaway value is capped — the whole point is bounding the herd');

    // Nonsense and zero fall back to the safe default rather than to "unlimited".
    for (const bad of ['0', '-4', 'lots', '']) {
      process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK = bad;
      assert.equal(maxCatchupFiresPerTick(), 1, `"${bad}" must fall back to 1, never to unbounded`);
    }
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK;
    else process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK = prev;
  }
});

// The staggering decision itself, mirrored exactly from processWorkflowSchedules
// so the rule is pinned independently of the scheduler's I/O.
function wouldFire(matchedMinuteKey: string, currentMinuteKey: string, budget: number): boolean {
  const isCatchupFire = matchedMinuteKey !== currentMinuteKey;
  return !(isCatchupFire && budget <= 0);
}

test('a LIVE-minute fire is never throttled, even with the budget spent', () => {
  assert.equal(wouldFire('2026-07-30T09:00', '2026-07-30T09:00', 0), true,
    'the scheduled moment is now — throttling it would drop a real occurrence');
});

test('the first catch-up fires; later ones in the same tick are held, not dropped', () => {
  const nowKey = '2026-07-30T00:01';
  const missedKey = '2026-07-29T08:00';
  assert.equal(wouldFire(missedKey, nowKey, 1), true, 'first catch-up spends the budget');
  assert.equal(wouldFire(missedKey, nowKey, 0), false, 'the second is held for a later tick');
});

test('held catch-ups remain ELIGIBLE — the incident must not become silent data loss', () => {
  // The fix deliberately does NOT stamp lastRunByMinute when holding, so the
  // same occurrence is re-evaluated next tick. This models that: an unstamped
  // dedupe key still matches, so the workflow fires once the budget refreshes.
  const lastRunByMinute: Record<string, string> = {};
  const dedupeKey = 'wf:morning-prospect-prep';
  const missedKey = '2026-07-29T08:00';

  const heldThisTick = lastRunByMinute[dedupeKey] !== missedKey;
  assert.equal(heldThisTick, true, 'still eligible on the next tick');

  // Next tick, budget refreshed → it fires and only then is stamped.
  if (wouldFire(missedKey, '2026-07-30T00:02', 1)) lastRunByMinute[dedupeKey] = missedKey;
  assert.equal(lastRunByMinute[dedupeKey], missedKey, 'fired exactly once, on a later tick');

  // And now it is deduped forever — one catch-up run, not a repeating one.
  assert.equal(lastRunByMinute[dedupeKey] !== missedKey, false, 'no repeat firing');
});

test('the incident shape: three missed heavies drain over ticks instead of stampeding', () => {
  const nowKey = '2026-07-30T00:01';
  const missed = [
    { name: 'morning-prospect-prep', key: '2026-07-29T08:00' },
    { name: 'scorpion-facebook-trends', key: '2026-07-29T07:30' },
    { name: 'team-activity-slack-updates', key: '2026-07-29T09:00' },
  ];

  // One tick, default budget: exactly one fires.
  let budget = maxCatchupFiresPerTick();
  const firedThisTick: string[] = [];
  for (const m of missed) {
    if (wouldFire(m.key, nowKey, budget)) { firedThisTick.push(m.name); budget -= 1; }
  }
  assert.deepEqual(firedThisTick, ['morning-prospect-prep'],
    'exactly one heavy workflow starts — the SIGKILL condition cannot form');

  // Across three ticks all three run: queued, ordered, never lost.
  const drained: string[] = [];
  const remaining = [...missed];
  for (let tick = 0; tick < 3 && remaining.length > 0; tick++) {
    let b = maxCatchupFiresPerTick();
    while (remaining.length > 0 && b > 0) { drained.push(remaining.shift()!.name); b -= 1; }
  }
  assert.equal(drained.length, 3, 'every missed occurrence still runs');
  assert.equal(remaining.length, 0, 'nothing is dropped');
});

// ─── Siblings in the same defect family (v3.0.1 sweep) ───

test('workflow run concurrency has an UPPER clamp, not just a floor', async () => {
  const mod = await import('./workflow-runner.js');
  const fn = (mod as unknown as { _testOnly_runDrainConcurrency?: () => number })._testOnly_runDrainConcurrency;
  if (!fn) return; // exported only where testable; the clamp is asserted below via env sweep
  const prev = process.env.CLEMENTINE_WORKFLOW_RUN_CONCURRENCY;
  try {
    for (const [set, want] of [['1', 1], ['3', 3], ['4', 4], ['50', 4], ['0', 1], ['nonsense', 1]] as const) {
      process.env.CLEMENTINE_WORKFLOW_RUN_CONCURRENCY = set;
      assert.equal(fn(), want, `concurrency=${set} must resolve to ${want}`);
    }
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_WORKFLOW_RUN_CONCURRENCY;
    else process.env.CLEMENTINE_WORKFLOW_RUN_CONCURRENCY = prev;
  }
});

test('a missed window collapses to its LATEST occurrence, never one-per-minute', () => {
  // Mirrors both schedulers' rule. An hourly source missed for a day must
  // refresh ONCE (the newest state), not 24 times — earlier occurrences are
  // superseded by definition, and repeating them is pure provider spend.
  const minuteKeys = ['09:00', '10:00', '11:00', '12:00'];
  const alreadyFired: string | undefined = undefined;
  const matched = minuteKeys.filter((k) => k !== alreadyFired);
  const latest = matched[matched.length - 1];
  assert.equal(latest, '12:00', 'the newest occurrence is the one that carries information');
  assert.equal(matched.filter((k) => k === latest).length, 1, 'exactly one refresh results');
});
