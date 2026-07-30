/**
 * Run: npx tsx --test src/daemon/cron-catchup-stagger.test.ts
 *
 * END-TO-END pin for the CRON catch-up stagger — the sibling of the workflow
 * scheduler stampede shipped in v3.0.1.
 *
 * Cron jobs run sequentially, so the failure mode here is loop STARVATION,
 * not machine exhaustion: each job is a full brain turn with a multi-minute
 * wall-clock budget, and N missed jobs after downtime used to run
 * back-to-back inside ONE daemon tick — blocking workflow scheduling,
 * autonomy, briefs, and the watchdog for the sum of their durations.
 *
 * This suite drives processCronSchedules itself with injected clocks and a
 * stub brain, because the workflow scheduler's first stagger proved a
 * decision-rule-only pin is blind to the deadly half: durable state. Held jobs
 * must be frozen before the evaluation watermark advances, survive restart and
 * the 24h discovery horizon, and never re-fire a job already handled. Those
 * properties are asserted here through the real function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cron-stagger-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
delete process.env.CLEMENTINE_CRON_CATCHUP_PER_TICK; // independent default budget: 1
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
// Route runCronJob to the stub brain: disable the cron harness lane AND
// explicitly opt into the legacy respond fallback (without the second flag the
// bridge blocks pre-run instead of falling back — by design).
process.env.CLEMMY_HARNESS_CRON = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';

const {
  _testOnly_processCronSchedules: processCron,
  _testOnly_processCronTriggers: processTriggers,
  _testOnly_waitForCronScheduleIdle: waitForCronScheduleIdle,
  _testOnly_loadDaemonState: loadDaemonState,
} = await import('./runner.js') as unknown as {
  _testOnly_processCronSchedules: (assistant: unknown, state: CronState, now?: Date) => Promise<void>;
  _testOnly_processCronTriggers: (assistant: unknown) => Promise<void>;
  _testOnly_waitForCronScheduleIdle: () => Promise<void>;
  _testOnly_loadDaemonState: () => CronState;
};
const { CRON_FILE: cronFile } = await import('../memory/vault.js');

type CronState = {
  lastCronRunByMinute: Record<string, string>;
  lastCronRunAtMs?: Record<string, number>;
  pendingCronOccurrences?: Record<string, {
    atMs: number;
    minuteKey: string;
    scheduleKey: string;
    missed: number;
  }>;
  lastCronEvaluatedAtMs?: number;
};

/** Stub brain: records which jobs actually RAN (one respond call per fire). */
const ran: string[] = [];
const stubAssistant = {
  respond: async (req: { sessionId?: string }) => {
    ran.push(String(req.sessionId ?? 'unknown').replace(/^cron:/, '').replace(/:\d+$/, ''));
    return { text: 'done', sessionId: req.sessionId };
  },
};

test.beforeEach(async () => {
  await waitForCronScheduleIdle();
  ran.length = 0;
  rmSync(path.join(TMP_HOME, 'state', 'daemon-state.json'), { force: true });
  delete process.env.CLEMENTINE_CRON_CATCHUP_PER_TICK;
  delete process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK;
});

function seedCronFile(jobs: Array<{ name: string; schedule: string }>): void {
  mkdirSync(path.dirname(cronFile), { recursive: true });
  const body = [
    '---',
    'jobs:',
    ...jobs.flatMap((j) => [
      `  - name: ${j.name}`,
      `    schedule: "${j.schedule}"`,
      '    prompt: say ok',
      '    enabled: true',
    ]),
    '---',
    '',
    '# Cron',
  ].join('\n');
  writeFileSync(cronFile, body, 'utf-8');
}

// Local-time clocks (cron minute keys are host-local).
const day1_0600 = new Date(2026, 6, 29, 6, 0);
const boot = new Date(2026, 6, 30, 0, 1); // downtime boot: all three missed
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

async function processCronAndWait(assistant: unknown, state: CronState, now: Date): Promise<void> {
  await processCron(assistant, state, now);
  await waitForCronScheduleIdle();
}

test('missed cron jobs drain one per tick — the daemon loop is never starved by a catch-up train', async () => {
  seedCronFile([
    { name: 'cron-daily-brief', schedule: '0 8 * * *' },
    { name: 'cron-inbox-sweep', schedule: '30 7 * * *' },
    { name: 'cron-eod-summary', schedule: '0 9 * * *' },
  ]);
  const state: CronState = { lastCronRunByMinute: {} };

  // Establish the watermark before the missed windows.
  await processCronAndWait(stubAssistant, state, day1_0600);
  assert.equal(ran.length, 0, 'nothing due at 06:00');

  // Boot after downtime: exactly ONE catch-up job runs on the boot tick.
  await processCronAndWait(stubAssistant, state, boot);
  assert.equal(ran.length, 1,
    `exactly one catch-up cron job runs on the boot tick — the tick stays short (ran: ${JSON.stringify(ran)})`);

  // The watermark advances because held work has its own durable identity.
  assert.equal(state.lastCronEvaluatedAtMs, boot.getTime());
  assert.equal(Object.keys(state.pendingCronOccurrences ?? {}).length, 2,
    'held jobs are frozen durably instead of depending on a rewound window');

  // Subsequent ticks drain the rest, one per tick, no repeats, none lost.
  for (let i = 1; i <= 4 && ran.length < 3; i++) {
    const before = ran.length;
    await processCronAndWait(stubAssistant, state, plusMin(boot, i));
    assert.ok(ran.length - before <= 1, 'never more than one catch-up per tick');
  }
  assert.deepEqual([...ran].sort(),
    ['cron-daily-brief', 'cron-eod-summary', 'cron-inbox-sweep'],
    'every missed cron job runs exactly once — held means QUEUED, never dropped');

  // Once drained, the watermark advances to now and nothing re-fires.
  const settledNow = plusMin(boot, 6);
  await processCronAndWait(stubAssistant, state, settledNow);
  assert.equal(ran.length, 3, 'the backlog is drained; no ghost re-fires');
  assert.equal(state.lastCronEvaluatedAtMs, settledNow.getTime(),
    'with nothing held the watermark tracks now again');
});

test('a live-minute cron job is never delayed by a spent catch-up budget', async () => {
  seedCronFile([
    { name: 'cron-missed-nine-thirty', schedule: '30 9 * * *' },
    { name: 'cron-live-at-ten', schedule: '0 10 * * *' },
  ]);
  const state: CronState = { lastCronRunByMinute: {}, lastCronEvaluatedAtMs: new Date(2026, 6, 30, 9, 0).getTime() };

  const now = new Date(2026, 6, 30, 10, 0);
  await processCronAndWait(stubAssistant, state, now);
  assert.equal(ran[0], 'cron-live-at-ten', 'live work executes before an earlier YAML catch-up');
  assert.ok(ran.includes('cron-live-at-ten'),
    'the live-minute job runs on its exact minute regardless of catch-up traffic');

  // The missed one drains within bounded ticks rather than being lost.
  for (let i = 1; i <= 4 && !ran.includes('cron-missed-nine-thirty'); i++) {
    await processCronAndWait(stubAssistant, state, plusMin(now, i));
  }
  assert.ok(ran.includes('cron-missed-nine-thirty'), 'the held catch-up still runs');
  assert.equal(ran.filter((n) => n === 'cron-missed-nine-thirty').length, 1, 'exactly once');
});

test('durable same-minute siblings drain without re-firing the one already handled', async () => {
  seedCronFile([
    { name: 'cron-a-same-minute', schedule: '15 8 * * *' },
    { name: 'cron-b-same-minute', schedule: '15 8 * * *' },
  ]);
  const state: CronState = { lastCronRunByMinute: {}, lastCronEvaluatedAtMs: new Date(2026, 6, 30, 8, 0).getTime() };
  const tick1 = new Date(2026, 6, 30, 8, 40);
  await processCronAndWait(stubAssistant, state, tick1);
  assert.equal(ran.length, 1, 'one fires, one is held');

  await processCronAndWait(stubAssistant, state, plusMin(tick1, 1));
  assert.deepEqual([...ran].sort(), ['cron-a-same-minute', 'cron-b-same-minute'],
    'the held sibling fires next tick');

  await processCronAndWait(stubAssistant, state, plusMin(tick1, 2));
  assert.equal(ran.length, 2, 'no repeats after the durable pending sibling drains');
});

test('a pending cron occurrence survives restart and aging beyond 24 hours', async () => {
  seedCronFile([
    { name: 'cron-restart-a', schedule: '0 8 * * *' },
    { name: 'cron-restart-b', schedule: '0 9 * * *' },
  ]);
  const state: CronState = {
    lastCronRunByMinute: {},
    lastCronEvaluatedAtMs: new Date(2026, 6, 28, 7, 0).getTime(),
  };
  const bootTick = new Date(2026, 6, 29, 10, 0);
  await processCronAndWait(stubAssistant, state, bootTick);
  assert.equal(ran.length, 1);
  assert.equal(Object.keys(state.pendingCronOccurrences ?? {}).length, 1);
  const heldName = ran[0] === 'cron-restart-a' ? 'cron-restart-b' : 'cron-restart-a';
  seedCronFile([{
    name: heldName,
    schedule: heldName === 'cron-restart-a' ? '0 8 * * *' : '0 9 * * *',
  }]);

  const restarted = loadDaemonState();
  await processCronAndWait(stubAssistant, restarted, new Date(2026, 7, 1, 12, 0));
  assert.equal(ran.length, 2, 'the held occurrence runs after restart even outside the scan horizon');
  assert.notEqual(ran[0], ran[1]);
});

test('a manual trigger cannot overlap the schedule lane — the same job never runs twice concurrently', async () => {
  // v3.0.3 regression (validation finding, shipped): the async schedule lane
  // made a Console "run now" concurrent with a scheduled run of the SAME job.
  // The trigger pass now defers whole while the lane is mid-turn; the trigger
  // file is consumed only when its job actually runs, so it retries next tick.
  seedCronFile([{ name: 'cron-overlap-job', schedule: '0 8 * * *' }]);
  const state: CronState = {
    lastCronRunByMinute: {},
    lastCronEvaluatedAtMs: new Date(2026, 7, 2, 7, 0).getTime(),
  };
  ran.length = 0;

  // Hold the schedule-lane job open mid-turn.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowAssistant = {
    respond: async (req: { sessionId?: string }) => {
      ran.push(String(req.sessionId ?? 'unknown').replace(/^cron:/, '').replace(/:\d+$/, ''));
      await gate;
      return { text: 'done', sessionId: req.sessionId };
    },
  };
  await processCron(slowAssistant, state, new Date(2026, 7, 2, 8, 0));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, ['cron-overlap-job'], 'the scheduled run is mid-turn on the lane');

  // A manual trigger for the SAME job arrives while the lane is busy.
  const { CRON_TRIGGERS_DIR } = await import('../tools/shared.js');
  const triggersDir = CRON_TRIGGERS_DIR;
  mkdirSync(triggersDir, { recursive: true });
  const triggerFile = path.join(triggersDir, 'overlap-trigger.json');
  writeFileSync(triggerFile, JSON.stringify({ jobName: 'cron-overlap-job' }), 'utf-8');

  await processTriggers(slowAssistant);
  assert.equal(ran.length, 1, 'the trigger DEFERS — no second concurrent execution of the job');
  assert.ok(existsSync(triggerFile), 'the deferred trigger file survives for the next tick');

  // Lane completes → the next trigger pass runs it.
  release();
  await waitForCronScheduleIdle();
  await processTriggers(slowAssistant);
  assert.equal(ran.length, 2, 'the queued trigger runs once the lane is idle');
  assert.equal(existsSync(triggerFile), false, 'a trigger that RAN is consumed');
});

test('cron admission is non-blocking and single-flight while completion owns the durable commit', async () => {
  seedCronFile([{ name: 'cron-slow', schedule: '0 8 * * *' }]);
  const state: CronState = {
    lastCronRunByMinute: {},
    lastCronEvaluatedAtMs: new Date(2026, 6, 30, 7, 0).getTime(),
  };
  const due = new Date(2026, 6, 30, 9, 0);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  const slowAssistant = {
    respond: async (req: { sessionId?: string }) => {
      starts += 1;
      await gate;
      return { text: 'done', sessionId: req.sessionId };
    },
  };

  await processCron(slowAssistant, state, due);
  assert.equal(starts, 1, 'the background lane was admitted');
  assert.ok(state.pendingCronOccurrences?.['cron-slow'], 'pending is checkpointed before the turn');
  assert.equal(state.lastCronRunAtMs?.['cron-slow'], undefined, 'completion has not committed yet');

  await processCron(slowAssistant, state, plusMin(due, 1));
  assert.equal(starts, 1, 'a second tick cannot overlap the active cron lane');

  release();
  await waitForCronScheduleIdle();
  assert.equal(state.lastCronRunAtMs?.['cron-slow'], new Date(2026, 6, 30, 8, 0).getTime());
  assert.equal(state.pendingCronOccurrences?.['cron-slow'], undefined);
});

test('oldest cron catch-up wins even when YAML order points at a newer occurrence', async () => {
  seedCronFile([
    { name: 'cron-newer-first', schedule: '0 9 * * *' },
    { name: 'cron-older-second', schedule: '0 8 * * *' },
  ]);
  const state: CronState = {
    lastCronRunByMinute: {},
    lastCronEvaluatedAtMs: new Date(2026, 6, 30, 7, 0).getTime(),
  };

  await processCronAndWait(stubAssistant, state, new Date(2026, 6, 30, 10, 0));
  assert.deepEqual(ran, ['cron-older-second']);
});

test('a recurring first YAML job cannot refresh its way ahead of an older held sibling', async () => {
  seedCronFile([
    { name: 'cron-a-recurring-first', schedule: '*/2 * * * *' },
    { name: 'cron-z-recurring-held', schedule: '*/2 * * * *' },
  ]);
  const state: CronState = {
    lastCronRunByMinute: {},
    lastCronEvaluatedAtMs: new Date(2026, 6, 30, 9, 1).getTime(),
  };

  await processCronAndWait(stubAssistant, state, new Date(2026, 6, 30, 9, 3));
  assert.deepEqual(ran, ['cron-a-recurring-first']);
  await processCronAndWait(stubAssistant, state, new Date(2026, 6, 30, 9, 5));
  assert.deepEqual(ran, ['cron-a-recurring-first', 'cron-z-recurring-held']);
});
