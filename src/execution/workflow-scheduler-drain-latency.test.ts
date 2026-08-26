/**
 * Run: npx tsx --test src/execution/workflow-scheduler-drain-latency.test.ts
 *
 * Regression for trigger-508: the workflow scheduler and run lane both ticked
 * every 15 seconds. A live occurrence admitted immediately after an empty run
 * drain therefore remained queued for almost a full interval. The enqueue
 * signal is latency-only; the periodic scan remains the durable recovery path.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-scheduler-drain-latency-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { processWorkflowSchedules } = await import('./workflow-scheduler.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { CRON_RUNS_DIR, WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { registerWorkflowRunDrainKick } = await import('../tools/workflow-run-queue.js');
const { _testOnly_runWorkflowDrainAdmissionPass } = await import('./workflow-runner.js');

const SCHEDULE_STATE_FILE = path.join(path.dirname(CRON_RUNS_DIR), 'workflow-schedule-state.json');

test.beforeEach(() => {
  registerWorkflowRunDrainKick(null);
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(SCHEDULE_STATE_FILE, { force: true });
  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
});

test.after(() => {
  registerWorkflowRunDrainKick(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function seedLiveWorkflow(slug: string): void {
  writeWorkflow(slug, {
    name: slug,
    description: 'Live scheduler drain latency fixture.',
    enabled: true,
    trigger: { schedule: '* * * * *' },
    steps: [{ id: 'read', prompt: 'Read the already available local input.', sideEffect: 'read' }],
  });
}

function runRecords(): Array<Record<string, unknown> & { id: string; status?: string }> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as (
      Record<string, unknown> & { id: string; status?: string }
    ));
}

async function runAdmissionPass(
  runIds: readonly string[],
  onAdmitted: (run: Record<string, unknown> & { id: string }) => Promise<void>,
): Promise<string[]> {
  const requested = new Set(runIds);
  const candidates = runRecords().filter((run) => requested.has(run.id));
  return _testOnly_runWorkflowDrainAdmissionPass(
    candidates as never,
    onAdmitted as never,
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`condition was not reached within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a live schedule admitted just after an empty timer pass starts draining within 1s exactly once', async (t) => {
  const slug = 'scheduler-immediate-drain';
  const now = new Date('2026-08-25T12:34:00.000Z');
  seedLiveWorkflow(slug);

  const kickRunIds: string[][] = [];
  const claimedRunIds: string[] = [];
  let releaseImmediateClaim!: () => void;
  const holdImmediateClaim = new Promise<void>((resolve) => { releaseImmediateClaim = resolve; });
  let immediatePass: Promise<string[]> | undefined;
  registerWorkflowRunDrainKick((runIds) => {
    kickRunIds.push([...runIds]);
    setImmediate(() => {
      immediatePass = runAdmissionPass(runIds, async (run) => {
        claimedRunIds.push(run.id);
        await holdImmediateClaim;
      });
    });
  });

  // Worst-case phase: the periodic run-lane timer has just scanned an empty
  // queue, then the scheduler admits this minute's occurrence.
  assert.deepEqual(await runAdmissionPass([], async () => {}), []);
  const admittedAt = performance.now();
  const first = await processWorkflowSchedules(now);
  await waitFor(() => claimedRunIds.length === 1, 900);
  const startLatencyMs = performance.now() - admittedAt;
  t.diagnostic(`immediate scheduler drain claim latency: ${startLatencyMs.toFixed(1)}ms`);

  assert.deepEqual(first.fired, [slug]);
  assert.ok(startLatencyMs < 1_000, `scheduled run started after ${startLatencyMs.toFixed(1)}ms`);
  assert.equal(kickRunIds.length, 1, 'one fresh executable admission requests one drain');
  assert.deepEqual(kickRunIds[0], claimedRunIds);

  // The next ordinary recovery tick may overlap the immediate pass. Exercise
  // the production run-ownership lease: it cannot claim the same physical run.
  const timerClaims: string[] = [];
  assert.deepEqual(
    await runAdmissionPass(kickRunIds[0], async (run) => { timerClaims.push(run.id); }),
    [],
  );
  assert.deepEqual(timerClaims, []);
  releaseImmediateClaim();
  assert.deepEqual(await immediatePass, claimedRunIds);

  // Same-minute scheduler replay cannot create a second record or another kick.
  const replay = await processWorkflowSchedules(now);
  assert.equal(claimedRunIds.length, 1, 'timer recovery cannot duplicate the immediate claim');
  assert.equal(runRecords().length, 1, 'the occurrence receipt owns one durable run');
  assert.equal(runRecords()[0]?.status, 'queued', 'the admission-only seam does not fake execution state');
  assert.equal(kickRunIds.length, 1, 'scheduler replay creates no drain churn');
  assert.ok(replay.deduped.includes(slug));
});

test('a failed latency kick leaves the durable queued run for timer recovery', async () => {
  const slug = 'scheduler-drain-timer-recovery';
  seedLiveWorkflow(slug);
  registerWorkflowRunDrainKick(() => {
    throw new Error('simulated lost wakeup');
  });

  const scheduled = await processWorkflowSchedules(new Date('2026-08-25T12:35:00.000Z'));
  assert.deepEqual(scheduled.fired, [slug], 'callback failure cannot roll back durable admission');
  assert.equal(runRecords()[0]?.status, 'queued');

  const [queued] = runRecords();
  assert.ok(queued);
  const recoveryClaims: string[] = [];
  let releaseRecoveryClaim!: () => void;
  const holdRecoveryClaim = new Promise<void>((resolve) => { releaseRecoveryClaim = resolve; });
  const recoveryPass = runAdmissionPass([queued.id], async (run) => {
    recoveryClaims.push(run.id);
    await holdRecoveryClaim;
  });
  await waitFor(() => recoveryClaims.length === 1, 900);
  assert.deepEqual(
    await runAdmissionPass([queued.id], async (run) => { recoveryClaims.push(run.id); }),
    [],
    'an overlapping timer cannot acquire the same production ownership lease',
  );
  releaseRecoveryClaim();
  assert.deepEqual(await recoveryPass, [queued.id]);
  assert.deepEqual(recoveryClaims, [queued.id], 'periodic recovery claims the queued record once');
});
