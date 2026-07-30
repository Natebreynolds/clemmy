/**
 * Run: npx tsx --test src/execution/workflow-scheduler-stagger-e2e.test.ts
 *
 * END-TO-END pin for the catch-up stagger, driving processWorkflowSchedules
 * itself with injected clocks — NOT the decision helper.
 *
 * Exists because the first version of the stagger shipped with exactly the bug
 * a helper-only test cannot see: held occurrences were "queued" per the
 * decision logic, but the end-of-pass watermark advanced to `now`
 * unconditionally, so the held minutes fell out of the next tick's window and
 * were silently DROPPED. The stampede fix had become a data-loss bug. This
 * suite replays the real v3.0.1 incident shape through the real scheduler and
 * asserts every missed workflow eventually fires exactly once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-sched-stagger-e2e-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
delete process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK; // default budget: 1

const { processWorkflowSchedules } = await import('./workflow-scheduler.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');

function seed(name: string, schedule: string): void {
  writeWorkflow(name, {
    name,
    description: 'stagger e2e',
    enabled: true,
    trigger: { schedule },
    steps: [{ id: 's1', prompt: 'do the thing' }],
  });
}

// Local-time clocks (minute keys are host-local, so drive local dates).
const day1_0600 = new Date(2026, 6, 29, 6, 0);   // watermark-establishing tick
const day2_0001 = new Date(2026, 6, 30, 0, 1);   // the incident boot: all three missed
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

test('the v3.0.1 incident, replayed end to end: three missed heavies drain one per tick, none lost, none repeated', async () => {
  // The exact schedules from the live incident.
  seed('e2e-morning-prospect-prep', '0 8 * * *');
  seed('e2e-scorpion-facebook-trends', '30 7 * * *');
  seed('e2e-team-activity-slack', '0 9 * * *');

  // Establish the watermark before the missed windows.
  const t0 = await processWorkflowSchedules(day1_0600);
  assert.equal(t0.fired.length, 0, 'nothing due at 06:00');

  // Boot after downtime: all three windows (07:30, 08:00, 09:00) were missed.
  const fires: string[] = [];
  const t1 = await processWorkflowSchedules(day2_0001);
  fires.push(...t1.fired);
  assert.equal(t1.fired.length, 1,
    `exactly ONE catch-up fires on the boot tick — the SIGKILL condition cannot form (got ${JSON.stringify(t1.fired)})`);

  // Subsequent ticks drain the rest, one per tick, with no repeats.
  for (let i = 1; i <= 4 && fires.length < 3; i++) {
    const t = await processWorkflowSchedules(plusMin(day2_0001, i));
    for (const name of t.fired) {
      assert.ok(!fires.includes(name), `${name} must not fire twice`);
      fires.push(name);
    }
    assert.ok(t.fired.length <= 1, 'never more than one catch-up per tick');
  }

  assert.deepEqual(
    [...fires].sort(),
    ['e2e-morning-prospect-prep', 'e2e-scorpion-facebook-trends', 'e2e-team-activity-slack'],
    'every missed workflow fires exactly once — held means QUEUED, never dropped',
  );

  // Steady state: nothing re-fires.
  const settled = await processWorkflowSchedules(plusMin(day2_0001, 6));
  assert.equal(settled.fired.length, 0, 'the backlog is drained; no ghost re-fires');
});

test('a live-minute workflow is never delayed by a spent catch-up budget', async () => {
  // A workflow whose schedule matches the CURRENT tick minute exactly,
  // alongside a fresh missed one competing for the (already spent) budget.
  const now = new Date(2026, 6, 30, 10, 0);
  seed('e2e-live-at-ten', '0 10 * * *');
  seed('e2e-missed-at-nine-thirty', '30 9 * * *');

  const t = await processWorkflowSchedules(now);
  assert.ok(t.fired.includes('e2e-live-at-ten'),
    'the live-minute workflow fires on its exact minute regardless of catch-up traffic');

  // And the missed one still drains rather than being lost. It may win the
  // very first tick's budget (iteration order) or a later one; the property is
  // drainage, not position. The first test's dailies also compete here with
  // their day-2 occurrences (a new day is a new occurrence — correct).
  const drained: string[] = [...t.fired];
  for (let i = 1; i <= 8 && !drained.includes('e2e-missed-at-nine-thirty'); i++) {
    const r = await processWorkflowSchedules(plusMin(now, i));
    assert.ok(r.fired.length <= 1, 'catch-ups stay one per tick while draining');
    drained.push(...r.fired);
  }
  assert.ok(drained.includes('e2e-missed-at-nine-thirty'), 'the held catch-up still fires');
});
