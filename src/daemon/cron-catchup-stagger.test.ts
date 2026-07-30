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
 * decision-rule-only pin is blind to the deadly half: the watermark. Held
 * jobs must stay INSIDE the next evaluation window (parked watermark) and a
 * rewound window must never re-fire a job that already ran (strictly-newer
 * dedupe). Both halves are asserted here through the real function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cron-stagger-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
delete process.env.CLEMENTINE_WORKFLOW_CATCHUP_PER_TICK; // default budget: 1
// Route runCronJob to the stub brain: disable the cron harness lane AND
// explicitly opt into the legacy respond fallback (without the second flag the
// bridge blocks pre-run instead of falling back — by design).
process.env.CLEMMY_HARNESS_CRON = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';

const { _testOnly_processCronSchedules: processCron, CRON_FILE } = await import('./runner.js') as unknown as {
  _testOnly_processCronSchedules: (assistant: unknown, state: CronState, now?: Date) => Promise<void>;
  CRON_FILE?: string;
};
const { CRON_FILE: cronFile } = await import('../memory/vault.js');

type CronState = {
  lastCronRunByMinute: Record<string, string>;
  lastCronEvaluatedAtMs?: number;
};

/** Stub brain: records which jobs actually RAN (one respond call per fire). */
const ran: string[] = [];
const stubAssistant = {
  respond: async (req: { sessionId?: string }) => {
    ran.push(String(req.sessionId ?? 'unknown').replace(/^cron:/, ''));
    return { text: 'done', sessionId: req.sessionId };
  },
};

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

test('missed cron jobs drain one per tick — the daemon loop is never starved by a catch-up train', async () => {
  seedCronFile([
    { name: 'cron-daily-brief', schedule: '0 8 * * *' },
    { name: 'cron-inbox-sweep', schedule: '30 7 * * *' },
    { name: 'cron-eod-summary', schedule: '0 9 * * *' },
  ]);
  const state: CronState = { lastCronRunByMinute: {} };

  // Establish the watermark before the missed windows.
  await processCron(stubAssistant, state, day1_0600);
  assert.equal(ran.length, 0, 'nothing due at 06:00');

  // Boot after downtime: exactly ONE catch-up job runs on the boot tick.
  await processCron(stubAssistant, state, boot);
  assert.equal(ran.length, 1,
    `exactly one catch-up cron job runs on the boot tick — the tick stays short (ran: ${JSON.stringify(ran)})`);

  // The watermark is PARKED, not advanced: held jobs stay inside the window.
  assert.ok(state.lastCronEvaluatedAtMs !== undefined && state.lastCronEvaluatedAtMs < boot.getTime(),
    'held jobs must remain inside the next evaluation window');

  // Subsequent ticks drain the rest, one per tick, no repeats, none lost.
  for (let i = 1; i <= 4 && ran.length < 3; i++) {
    const before = ran.length;
    await processCron(stubAssistant, state, plusMin(boot, i));
    assert.ok(ran.length - before <= 1, 'never more than one catch-up per tick');
  }
  assert.deepEqual([...ran].sort(),
    ['cron-daily-brief', 'cron-eod-summary', 'cron-inbox-sweep'],
    'every missed cron job runs exactly once — held means QUEUED, never dropped');

  // Once drained, the watermark advances to now and nothing re-fires.
  const settledNow = plusMin(boot, 6);
  await processCron(stubAssistant, state, settledNow);
  assert.equal(ran.length, 3, 'the backlog is drained; no ghost re-fires');
  assert.equal(state.lastCronEvaluatedAtMs, settledNow.getTime(),
    'with nothing held the watermark tracks now again');
});

test('a live-minute cron job is never delayed by a spent catch-up budget', async () => {
  seedCronFile([
    { name: 'cron-live-at-ten', schedule: '0 10 * * *' },
    { name: 'cron-missed-nine-thirty', schedule: '30 9 * * *' },
  ]);
  const state: CronState = { lastCronRunByMinute: {}, lastCronEvaluatedAtMs: new Date(2026, 6, 30, 9, 0).getTime() };
  ran.length = 0;

  const now = new Date(2026, 6, 30, 10, 0);
  await processCron(stubAssistant, state, now);
  assert.ok(ran.includes('cron-live-at-ten'),
    'the live-minute job runs on its exact minute regardless of catch-up traffic');

  // The missed one drains within bounded ticks rather than being lost.
  for (let i = 1; i <= 4 && !ran.includes('cron-missed-nine-thirty'); i++) {
    await processCron(stubAssistant, state, plusMin(now, i));
  }
  assert.ok(ran.includes('cron-missed-nine-thirty'), 'the held catch-up still runs');
  assert.equal(ran.filter((n) => n === 'cron-missed-nine-thirty').length, 1, 'exactly once');
});

test('rewound windows are safe: a job that already ran is never re-fired by the parked watermark', async () => {
  // Two missed jobs at the SAME minute: one fires, one is held, the watermark
  // rewinds to before that shared minute. The strictly-newer matcher must
  // exclude the already-run job from the rewound window.
  seedCronFile([
    { name: 'cron-a-same-minute', schedule: '15 8 * * *' },
    { name: 'cron-b-same-minute', schedule: '15 8 * * *' },
  ]);
  const state: CronState = { lastCronRunByMinute: {}, lastCronEvaluatedAtMs: new Date(2026, 6, 30, 8, 0).getTime() };
  ran.length = 0;

  const tick1 = new Date(2026, 6, 30, 8, 40);
  await processCron(stubAssistant, state, tick1);
  assert.equal(ran.length, 1, 'one fires, one is held');

  await processCron(stubAssistant, state, plusMin(tick1, 1));
  assert.deepEqual([...ran].sort(), ['cron-a-same-minute', 'cron-b-same-minute'],
    'the held sibling fires next tick');

  await processCron(stubAssistant, state, plusMin(tick1, 2));
  assert.equal(ran.length, 2, 'no repeats from the rewound window');
});
