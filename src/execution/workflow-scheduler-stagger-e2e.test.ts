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
 * asserts every missed workflow becomes one durable Resume/Skip decision,
 * without entering execution. Resumed decisions are serialized by the runner's
 * independent catch-up admission proof.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-sched-stagger-e2e-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
delete process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK; // default budget: 1
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { processWorkflowSchedules } = await import('./workflow-scheduler.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { listOperationalEvents } = await import('../runtime/operational-telemetry.js');
const { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const SCHEDULE_STATE_FILE = path.join(path.dirname(CRON_RUNS_DIR), 'workflow-schedule-state.json');

test.beforeEach(() => {
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(SCHEDULE_STATE_FILE, { force: true });
  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
});

function seed(name: string, schedule: string): void {
  writeWorkflow(name, {
    name,
    description: 'stagger e2e',
    enabled: true,
    trigger: { schedule },
    steps: [{ id: 's1', prompt: 'do the thing' }],
  });
}

function seedWithDisplayName(slug: string, displayName: string, schedule: string): void {
  writeWorkflow(slug, {
    name: displayName,
    description: 'stable slug scheduler e2e',
    enabled: true,
    trigger: { schedule },
    steps: [{ id: 's1', prompt: 'do the thing' }],
  });
}

/** Stand-in for the run lane finishing work: flip every executable run record
 *  to completed so the scheduler's in-flight gate releases. */
function completeExecutableRuns(): number {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return 0;
  let completed = 0;
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'))) {
    const filePath = path.join(WORKFLOW_RUNS_DIR, file);
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { status?: string };
    if (!raw.status || ['queued', 'running', 'finalizing'].includes(raw.status)) {
      writeFileSync(filePath, JSON.stringify({ ...raw, status: 'completed', finishedAt: new Date().toISOString() }, null, 2));
      completed += 1;
    }
  }
  return completed;
}

function runRecords(): Array<Record<string, unknown>> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
}

// Local-time clocks (minute keys are host-local, so drive local dates).
const day1_0600 = new Date(2026, 6, 29, 6, 0);   // watermark-establishing tick
const day2_0001 = new Date(2026, 6, 30, 0, 1);   // the incident boot: all three missed
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

test('the v3.0.1 incident, replayed end to end: every missed heavy is held and none enters execution', async () => {
  // The exact schedules from the live incident.
  seed('e2e-morning-prospect-prep', '0 8 * * *');
  seed('e2e-scorpion-facebook-trends', '30 7 * * *');
  seed('e2e-team-activity-slack', '0 9 * * *');

  // Establish the watermark before the missed windows.
  const t0 = await processWorkflowSchedules(day1_0600);
  assert.equal(t0.fired.length, 0, 'nothing due at 06:00');

  // Boot after downtime: all three windows (07:30, 08:00, 09:00) were missed.
  const t1 = await processWorkflowSchedules(day2_0001);
  assert.deepEqual(t1.fired, [], 'a stale occurrence is never reported as fired');
  assert.deepEqual(
    [...t1.held].sort(),
    ['e2e-morning-prospect-prep', 'e2e-scorpion-facebook-trends', 'e2e-team-activity-slack'],
    'each missed workflow gets one user-owned recovery decision',
  );
  const held = runRecords();
  assert.equal(held.length, 3);
  assert.ok(held.every((run) =>
    run.status === 'awaiting_catchup_decision'
    && run.catchupDisposition === 'held'
    && run.startedAt === undefined),
  'no held catch-up can consume execution concurrency');
  const heldEvents = listOperationalEvents({ limit: 100 }).filter((event) =>
    event.type === 'workflow_catchup_held'
    && ['e2e-morning-prospect-prep', 'e2e-scorpion-facebook-trends', 'e2e-team-activity-slack']
      .includes(String((event.payload as { workflowName?: string }).workflowName)));
  assert.equal(heldEvents.length, 3, 'telemetry says held, never fired');
  const notices = loadNotifications().filter((notification) =>
    notification.metadata?.catchupHeld === true
    && ['e2e-morning-prospect-prep', 'e2e-scorpion-facebook-trends', 'e2e-team-activity-slack']
      .includes(String(notification.metadata?.workflow)));
  assert.equal(notices.length, 3);
  assert.ok(notices.every((notification) =>
    /No workflow steps have run/.test(notification.body)
    && /Open Tasks/.test(notification.body)));

  const settled = await processWorkflowSchedules(plusMin(day2_0001, 1));
  assert.deepEqual(settled.held, [], 'durable scheduler receipts prevent repeated recovery cards');
  assert.deepEqual(settled.fired, [], 'waiting for the user never starts work on a later tick');
});

test('a live-minute workflow is never delayed by catch-up traffic — even a still-running catch-up run', async () => {
  // This test establishes its own watermark; it must pass in isolation.
  const now = new Date(2026, 6, 30, 10, 0);
  seed('e2e-live-at-ten', '0 10 * * *');
  seed('e2e-missed-at-nine-thirty', '30 9 * * *');
  await processWorkflowSchedules(new Date(2026, 6, 30, 9, 0));

  const t = await processWorkflowSchedules(now);
  assert.ok(t.fired.includes('e2e-live-at-ten'),
    'the live-minute workflow fires on its exact minute regardless of catch-up traffic');
  assert.deepEqual(t.held, ['e2e-missed-at-nine-thirty']);
  const byWorkflow = new Map(runRecords().map((run) => [run.workflow, run]));
  assert.equal(byWorkflow.get('e2e-live-at-ten')?.status, 'queued');
  assert.equal(byWorkflow.get('e2e-missed-at-nine-thirty')?.status, 'awaiting_catchup_decision');
});

test('held catch-ups survive later ticks and aging beyond the 24h discovery window', async () => {
  seed('e2e-old-a', '0 8 29 7 *');
  seed('e2e-old-b', '0 9 29 7 *');
  const before = new Date(2026, 6, 28, 7, 0);
  const boot = new Date(2026, 6, 29, 10, 0);
  await processWorkflowSchedules(before);
  const first = await processWorkflowSchedules(boot);
  assert.equal(first.held.length, 2);
  assert.deepEqual(first.fired, []);

  const aged = new Date(2026, 6, 31, 12, 0);
  const later = await processWorkflowSchedules(aged);
  assert.deepEqual(later.held, []);
  assert.equal(runRecords().filter((run) => run.catchupDisposition === 'held').length, 2);
});

test('an executable catch-up cannot block materialization of new held decisions', async () => {
  seed('e2e-cap-a', '0 8 * * *');
  seed('e2e-cap-b', '0 9 * * *');
  const before = new Date(2026, 6, 29, 7, 0);
  const boot = new Date(2026, 6, 30, 10, 0);
  await processWorkflowSchedules(before);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'already-running.json'), JSON.stringify({
    id: 'already-running',
    workflow: 'other-catchup',
    status: 'running',
    source: 'schedule',
    catchupFire: true,
    catchupDisposition: 'resumed',
    catchupOccurrenceAtMs: before.getTime(),
  }), 'utf-8');
  const result = await processWorkflowSchedules(boot);
  assert.deepEqual([...result.held].sort(), ['e2e-cap-a', 'e2e-cap-b']);
  assert.deepEqual(result.fired, []);
});

test('a parked live-origin run freezes the next occurrence instead of consuming it', async () => {
  seed('e2e-parked-live', '0 8 * * *');
  const firstDue = new Date(2026, 6, 29, 8, 0);
  await processWorkflowSchedules(firstDue);
  const file = readdirSync(WORKFLOW_RUNS_DIR).find((entry) => entry.endsWith('.json'));
  assert.ok(file);
  const runPath = path.join(WORKFLOW_RUNS_DIR, file);
  const run = JSON.parse(readFileSync(runPath, 'utf-8')) as Record<string, unknown>;
  writeFileSync(runPath, JSON.stringify({ ...run, status: 'parked' }, null, 2));

  const nextDue = new Date(2026, 6, 30, 8, 0);
  assert.equal((await processWorkflowSchedules(nextDue)).fired.length, 0);
  writeFileSync(runPath, JSON.stringify({ ...run, status: 'completed' }, null, 2));
  const recovery = await processWorkflowSchedules(plusMin(nextDue, 1));
  assert.deepEqual(recovery.fired, []);
  assert.deepEqual(recovery.held, ['e2e-parked-live'],
    'once the prior approval clears, the now-stale occurrence asks before execution');
});

test('an occurrence receipt prevents a queue/state crash from duplicating a run', async () => {
  seed('e2e-receipted', '0 8 * * *');
  const before = new Date(2026, 6, 29, 7, 0);
  const due = new Date(2026, 6, 29, 9, 0);
  await processWorkflowSchedules(before);
  const preOccurrenceState = readFileSync(SCHEDULE_STATE_FILE, 'utf-8');
  await processWorkflowSchedules(due);

  // Simulate queue acceptance followed by loss of the scheduler-state commit.
  writeFileSync(SCHEDULE_STATE_FILE, preOccurrenceState, 'utf-8');
  const replay = await processWorkflowSchedules(due);
  assert.equal(replay.fired.length, 0);
  assert.ok(replay.deduped.includes('e2e-receipted'));
  assert.equal(
    readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).length,
    1,
    'the deterministic receipt resolves to the already accepted run',
  );
  const receiptEvents = listOperationalEvents({ limit: 200 }).filter((event) =>
    (event.payload as { workflowName?: string }).workflowName === 'e2e-receipted');
  assert.equal(
    receiptEvents.filter((event) => event.type === 'workflow_catchup_held').length,
    1,
    'a receipt replay cannot falsely announce a second held admission',
  );
  assert.equal(
    receiptEvents.filter((event) =>
      event.type === 'workflow_trigger_deduped'
      && (event.payload as { reason?: string }).reason === 'trigger_receipt_replayed').length,
    1,
  );
  assert.equal(
    loadNotifications().filter((notification) =>
      notification.metadata?.workflow === 'e2e-receipted'
      && notification.metadata?.catchupHeld === true).length,
    1,
    'the recovery notice is run-id stable across receipt replay',
  );
});

test('legacy minute-only scheduler state upgrades without replaying its handled occurrence', async () => {
  seed('e2e-legacy-state', '0 8 * * *');
  const handled = new Date(2026, 6, 29, 8, 0);
  mkdirSync(path.dirname(SCHEDULE_STATE_FILE), { recursive: true });
  writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify({
    lastRunByMinute: { 'wf:e2e-legacy-state': '2026-07-29T08:00' },
    lastEvaluatedAtMs: handled.getTime(),
  }), 'utf-8');

  assert.equal((await processWorkflowSchedules(handled)).fired.length, 0);
  const next = await processWorkflowSchedules(new Date(2026, 6, 30, 8, 0));
  assert.deepEqual(next.fired, ['e2e-legacy-state']);
  const upgraded = JSON.parse(readFileSync(SCHEDULE_STATE_FILE, 'utf-8')) as {
    lastRunAtMs?: Record<string, number>;
  };
  assert.equal(upgraded.lastRunAtMs?.['wf:e2e-legacy-state'], new Date(2026, 6, 30, 8, 0).getTime());
});

test('mutable display-name state migrates to the stable workflow slug without replay', async () => {
  seedWithDisplayName('e2e-stable-slug', 'Renamed Workflow Display', '0 8 * * *');
  const handled = new Date(2026, 6, 29, 8, 0);
  mkdirSync(path.dirname(SCHEDULE_STATE_FILE), { recursive: true });
  writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify({
    lastRunByMinute: { 'wf:Renamed Workflow Display': '2026-07-29T08:00' },
    lastRunAtMs: { 'wf:Renamed Workflow Display': handled.getTime() },
    lastEvaluatedAtMs: handled.getTime(),
    pendingByWorkflow: {
      'wf:Renamed Workflow Display': {
        atMs: new Date(2026, 6, 30, 8, 0).getTime(),
        minuteKey: '2026-07-30T08:00',
        scheduleKey: '0 8 * * *\u0000',
        missed: 0,
      },
    },
  }), 'utf-8');

  assert.equal((await processWorkflowSchedules(handled)).fired.length, 0);
  const migrated = JSON.parse(readFileSync(SCHEDULE_STATE_FILE, 'utf-8')) as {
    lastRunByMinute?: Record<string, string>;
    lastRunAtMs?: Record<string, number>;
    pendingByWorkflow?: Record<string, unknown>;
  };
  assert.equal(migrated.lastRunAtMs?.['wf:e2e-stable-slug'], handled.getTime());
  assert.equal('wf:Renamed Workflow Display' in (migrated.lastRunAtMs ?? {}), false);
  assert.ok(migrated.pendingByWorkflow?.['wf:e2e-stable-slug']);
  assert.equal('wf:Renamed Workflow Display' in (migrated.pendingByWorkflow ?? {}), false);
});

test('oldest pending catch-up wins even when workflow file order points at a newer one', async () => {
  seed('a-newer-occurrence', '0 9 * * *');
  seed('z-older-occurrence', '0 8 * * *');
  await processWorkflowSchedules(new Date(2026, 6, 29, 7, 0));

  const result = await processWorkflowSchedules(new Date(2026, 6, 29, 10, 0));
  assert.deepEqual(result.fired, []);
  assert.deepEqual(result.held, ['z-older-occurrence', 'a-newer-occurrence'],
    'held cards are materialized oldest-first even though neither executes');
});

test('future live occurrences still fire while an older catch-up waits for a decision', async () => {
  seed('a-recurring-first', '*/2 * * * *');
  seed('z-recurring-held', '*/2 * * * *');
  const before = new Date(2026, 6, 29, 9, 1);
  await processWorkflowSchedules(before);

  const recovery = await processWorkflowSchedules(new Date(2026, 6, 29, 9, 3));
  assert.deepEqual([...recovery.held].sort(), ['a-recurring-first', 'z-recurring-held']);
  const live = await processWorkflowSchedules(new Date(2026, 6, 29, 9, 4));
  assert.deepEqual([...live.fired].sort(), ['a-recurring-first', 'z-recurring-held'],
    'a held old occurrence does not pause or absorb a future on-time commitment');
});

test('a pathological backlog materializes at most 20 held cards per tick without losing the rest', async () => {
  for (let i = 0; i < 22; i++) {
    seed(`e2e-bulk-${String(i).padStart(2, '0')}`, '0 8 29 7 *');
  }
  await processWorkflowSchedules(new Date(2026, 6, 28, 7, 0));

  const first = await processWorkflowSchedules(new Date(2026, 6, 29, 9, 0));
  assert.equal(first.held.length, 20);
  assert.equal(first.deferred.length, 2);
  assert.equal(runRecords().filter((run) => run.catchupDisposition === 'held').length, 20);

  const second = await processWorkflowSchedules(new Date(2026, 6, 29, 9, 1));
  assert.equal(second.held.length, 2);
  assert.equal(second.deferred.length, 0);
  assert.equal(runRecords().filter((run) => run.catchupDisposition === 'held').length, 22,
    'deferred means later, never dropped');
});

test('corrupt workflow schedule state is preserved and surfaced before recovery resets it', async () => {
  seed('e2e-corrupt-state', '0 8 * * *');
  mkdirSync(path.dirname(SCHEDULE_STATE_FILE), { recursive: true });
  writeFileSync(SCHEDULE_STATE_FILE, '{"lastRunByMinute":', 'utf-8');

  await processWorkflowSchedules(new Date(2026, 6, 29, 7, 0));

  assert.ok(
    readdirSync(path.dirname(SCHEDULE_STATE_FILE))
      .some((name) => name.startsWith('workflow-schedule-state.json.corrupt-')),
    'the unreadable state is retained for diagnosis instead of overwritten silently',
  );
  assert.ok(
    loadNotifications().some((notification) =>
      notification.metadata?.errorCategory === 'workflow_schedule_state_corrupt'),
    'the user is told durable scheduler recovery state was lost',
  );
});

test('epoch identity fires through DST fall-back when local minute keys move backward', async () => {
  const priorTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    seed('e2e-dst', '* * * * *');
    await processWorkflowSchedules(new Date('2026-11-01T08:59:00.000Z')); // 01:59 PDT
    await processWorkflowSchedules(new Date('2026-11-01T09:00:00.000Z')); // 01:00 PST
    assert.equal(
      readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).length,
      2,
      'the later epoch fires even though its local key is lexically earlier',
    );
  } finally {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  }
});
