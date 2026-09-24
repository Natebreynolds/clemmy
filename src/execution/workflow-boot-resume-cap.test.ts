import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 2026-09-10: five daemon restarts in five minutes. Every boot re-resumed the
// same in-flight workflows, so platform-49-slack-channel-review re-ran on
// nearly every cycle — 484k input tokens and 18 frames on a single pass. A
// crash loop must not amplify into repeated paid work.

const home = mkdtempSync(path.join(tmpdir(), 'clem-bootresume-'));
process.env.CLEMENTINE_HOME = home;
mkdirSync(path.join(home, 'state'), { recursive: true });

const { parkRunsExceedingBootResumeCap, BOOT_RESUME_CAP } = await import('./workflow-runner.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

function seedRun(runId: string, record: Record<string, unknown>): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(file, JSON.stringify({ id: runId, workflow: 'demo', status: 'running', ...record }, null, 2));
  return file;
}
function readRun(runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf8'));
}

test('an ordinary restart counts but does not park', () => {
  seedRun('run-ordinary', {});
  const parked = parkRunsExceedingBootResumeCap([{ runId: 'run-ordinary', workflowName: 'demo', lastEventAt: 't1' }]);
  assert.equal(parked.size, 0, 'one restart is normal — upgrade, manual quit, a one-off crash');
  assert.equal(readRun('run-ordinary').bootResumeCount, 1);
  assert.equal(readRun('run-ordinary').status, 'running');
});

test('a run that keeps restarting without progressing parks at the cap', () => {
  seedRun('run-loop', {});
  let parked = new Set<string>();
  for (let i = 0; i < BOOT_RESUME_CAP + 1; i++) {
    parked = parkRunsExceedingBootResumeCap([{ runId: 'run-loop', workflowName: 'demo', lastEventAt: 'frozen' }]);
  }
  assert.ok(parked.has('run-loop'), 'a restart loop must stop replaying paid work');
  const rec = readRun('run-loop');
  assert.equal(rec.status, 'parked');
  assert.match(String(rec.error), /automatic restarts/);
  // The cap's park is not a person's approval hold. It is marked so the
  // scheduler never holds the next occurrence for it.
  assert.match(String(rec.bootResumeParkedAt), /^\d{4}-\d{2}-\d{2}T/);
});

test('a cap-parked run does not hold the schedule; an approval-parked run does', async () => {
  const { workflowSchedulerInternalsForTest: seam } = await import('./workflow-scheduler.js');
  seedRun('sched-cap-parked', { status: 'parked', bootResumeParkedAt: '2026-09-16T15:26:10.000Z', workflow: 'sched-demo' });
  seedRun('sched-approval-parked', { status: 'parked', workflow: 'sched-demo' });
  const counts = seam.countActiveRunsFor('sched-demo');
  assert.equal(counts.parked, 1, 'only the approval-parked run counts as parked');
});

test('a parked run is excluded from the resume set, not merely flagged', () => {
  seedRun('run-excluded', { bootResumeCount: BOOT_RESUME_CAP });
  const parked = parkRunsExceedingBootResumeCap([{ runId: 'run-excluded', workflowName: 'demo', lastEventAt: 'x' }]);
  assert.ok(parked.has('run-excluded'), 'the caller filters on this set — a flag alone would still re-run the work');
});

test('a long job that PROGRESSES across restarts is never punished', () => {
  seedRun('run-progressing', {});
  // Each boot sees a different lastEventAt: the run is advancing, just slowly.
  for (let i = 0; i < BOOT_RESUME_CAP + 3; i++) {
    const parked = parkRunsExceedingBootResumeCap([
      { runId: 'run-progressing', workflowName: 'demo', lastEventAt: `event-${i}` },
    ]);
    assert.equal(parked.size, 0, `parked on iteration ${i} despite making progress`);
  }
  assert.equal(readRun('run-progressing').status, 'running');
});

test('a terminal run is left completely alone', () => {
  seedRun('run-done', { status: 'completed', finishedAt: new Date().toISOString() });
  const parked = parkRunsExceedingBootResumeCap([{ runId: 'run-done', workflowName: 'demo', lastEventAt: 't' }]);
  assert.equal(parked.size, 0);
  assert.equal(readRun('run-done').bootResumeCount, undefined, 'a finished run must not be rewritten');
});

test('a missing or unreadable record leaves the run resumable — capping never breaks recovery', () => {
  const parked = parkRunsExceedingBootResumeCap([{ runId: 'run-does-not-exist', workflowName: 'demo' }]);
  assert.equal(parked.size, 0, 'a safeguard must not become a new way for recovery to fail');
});

// ── The connection pin ──────────────────────────────────────────────────────
test('the boot reconcile actually filters the resume list on the cap', () => {
  const source = readFileSync(new URL('./workflow-runner.ts', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export function reconcilePendingWorkflowRuns'));
  const body = fn.slice(0, fn.indexOf('\nexport const BOOT_RESUME_CAP'));
  assert.match(body, /parkRunsExceedingBootResumeCap\(pending\)/,
    'counting without filtering would let a crash loop keep re-running paid work');
  assert.match(body, /pending\.filter\(\(p\) => !parked\.has\(p\.runId\)\)/,
    'the parked runs must be removed from the set that gets resumed');
});

test('a run already parked is a decision for a person: never counted again, never re-raised', async () => {
  const { listNotifications } = await import('../runtime/notifications.js');
  // Live 2026-09-22: ten parked occurrences of one workflow carried
  // bootResumeCount up to 446 — every launch re-counted, re-parked and
  // re-raised runs the cap had already stopped days earlier.
  seedRun('already-parked', { status: 'parked', bootResumeParkedAt: '2026-09-17T15:03:00.000Z', bootResumeCount: 4, error: 'Paused after 4 automatic restarts.' });
  seedRun('capability-parked', { status: 'parked', parked: { reason: 'ambiguous-account' } });
  let parked = new Set<string>();
  for (let i = 0; i < 5; i++) {
    parked = parkRunsExceedingBootResumeCap([
      { runId: 'already-parked', workflowName: 'demo' },
      { runId: 'capability-parked', workflowName: 'demo' },
    ]);
  }
  assert.ok(parked.has('already-parked'), 'a cap-parked run stays out of the resume set');
  assert.ok(parked.has('capability-parked'), 'a capability-parked run is waiting for a choice, not a restart');
  assert.equal(readRun('already-parked').bootResumeCount, 4, 'the count on the record is what the user was told');
  assert.equal(readRun('already-parked').error, 'Paused after 4 automatic restarts.');
  assert.equal(readRun('capability-parked').bootResumeParkedAt, undefined, 'a choice park is never relabelled as a restart loop');
  assert.equal(readRun('capability-parked').bootResumeCount, undefined);
  const raised = listNotifications().filter((n) => n.id === 'workflow-boot-resume-cap-already-parked' || n.id === 'workflow-boot-resume-cap-capability-parked');
  assert.equal(raised.length, 0, 'no card is raised for a run that was already parked');
});
