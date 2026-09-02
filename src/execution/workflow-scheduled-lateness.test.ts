/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-scheduled-lateness.test.ts
 *
 * A missed scheduled occurrence runs late instead of waiting for a human
 * Resume/Skip; the step's prompt says how late, so the model can judge a
 * time-sensitive step in its own words.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-sched-lateness-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { scheduledLatenessLeadIn, scheduledLatenessLeadInForRun } = await import('./workflow-scheduled-lateness.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

test('a live occurrence gets no lead-in; a missed one is told how late it is and how many it stands for', () => {
  const due = Date.UTC(2026, 8, 1, 23, 0, 0);
  assert.equal(scheduledLatenessLeadIn({}, due + 60_000), '');
  assert.equal(scheduledLatenessLeadIn({ catchupFire: false, catchupOccurrenceAtMs: due }, due + 60_000), '');
  assert.equal(scheduledLatenessLeadIn({ catchupFire: true }, due + 60_000), '', 'no due time, no claim');

  const three = scheduledLatenessLeadIn({ catchupFire: true, catchupOccurrenceAtMs: due, catchupMissedCount: 1 }, due + 3 * 60_000);
  assert.match(three, /due at 2026-09-01T23:00:00\.000Z/);
  assert.match(three, /about 3 minutes late/);
  assert.doesNotMatch(three, /occurrences were missed/);
  assert.match(three, /say so plainly in your result instead of doing it; otherwise do it now/);

  const collapsed = scheduledLatenessLeadIn({ catchupFire: true, catchupOccurrenceAtMs: due, catchupMissedCount: 3 }, due + 26 * 3_600_000);
  assert.match(collapsed, /about 26 hours late/);
  assert.match(collapsed, /3 occurrences were missed; this run stands for all of them/);
});

test('the lead-in is read from the durable run record and never throws', () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const due = Date.UTC(2026, 8, 1, 23, 0, 0);
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'trigger-late.json'), JSON.stringify({
    id: 'trigger-late', workflow: 'x', status: 'queued', catchupFire: true, catchupOccurrenceAtMs: due, catchupMissedCount: 1,
  }));
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'trigger-live.json'), JSON.stringify({ id: 'trigger-live', workflow: 'x', status: 'queued' }));
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'trigger-broken.json'), '{not json');
  assert.match(scheduledLatenessLeadInForRun('trigger-late', due + 8 * 60_000), /about 8 minutes late/);
  assert.equal(scheduledLatenessLeadInForRun('trigger-live', due), '');
  assert.equal(scheduledLatenessLeadInForRun('trigger-broken', due), '');
  assert.equal(scheduledLatenessLeadInForRun('trigger-missing', due), '');
});
