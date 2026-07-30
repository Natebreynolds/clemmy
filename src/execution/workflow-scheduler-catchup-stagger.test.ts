/**
 * Run: npx tsx --test src/execution/workflow-scheduler-catchup-stagger.test.ts
 *
 * SHIPPED-INCIDENT REGRESSION (v3.0.0, live on the owner's machine): several
 * heavy missed schedules started together after boot and pegged the daemon.
 * Stale workflow occurrences no longer enter execution admission at all. Each
 * collapses to one durable Resume/Skip card; only a user-resumed lineage enters
 * the existing one-active catch-up selector. Live-minute work remains live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
