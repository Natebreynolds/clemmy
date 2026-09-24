/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-dead-occurrences.test.ts
 *
 * Live 2026-09-22: twelve paused occurrences of two scheduled workflows, none
 * of which ever reached a provider, each with a newer occurrence behind it,
 * sat as cards for up to eleven days. The connection pinned here: a waiting
 * occurrence that never worked is cancelled once a newer occurrence exists,
 * with a reason naming it; the newest one and any occurrence that completed a
 * step are kept for the person.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-dead-occurrences-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { sweepDeadOccurrences, deadOccurrences, readOccurrenceViews } = await import('./workflow-dead-occurrences.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { addNotification, loadNotifications } = await import('../runtime/notifications.js');

function writeRun(id: string, slug: string, status: string, createdAt: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({
    id, workflow: slug, workflowSlug: slug, status, source: 'schedule', inputs: {}, createdAt, ...extra,
  }, null, 2), 'utf-8');
}
function writeEvents(slug: string, id: string, kinds: string[]): void {
  const dir = path.join(WORKFLOWS_DIR, slug, 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), kinds.map((kind) => JSON.stringify({ t: '2026-09-18T00:00:00.000Z', kind })).join('\n') + '\n', 'utf-8');
}
const readRun = (id: string) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), 'utf-8')) as Record<string, unknown>;

test('an occurrence that never worked is cancelled once a newer one exists; the newest and any that worked are kept', () => {
  // standup: three paused, never worked (oldest two die), one paused that completed a step (kept)
  writeRun('standup-1', 'daily-standup', 'parked', '2026-09-11T15:00:00.000Z', { startedAt: '2026-09-11T15:00:24.000Z', error: 'Paused after 447 automatic restarts.' });
  writeEvents('daily-standup', 'standup-1', ['run_started', 'step_started', 'step_started']);
  writeRun('standup-2', 'daily-standup', 'parked', '2026-09-17T15:00:00.000Z', { startedAt: '2026-09-17T15:03:06.000Z' });
  writeEvents('daily-standup', 'standup-2', ['run_started', 'step_started']);
  writeRun('standup-3', 'daily-standup', 'parked', '2026-09-22T15:00:00.000Z', { startedAt: '2026-09-22T15:00:37.000Z' });
  writeEvents('daily-standup', 'standup-3', ['run_started', 'step_started']);
  writeRun('standup-worked', 'daily-standup', 'parked', '2026-09-15T15:00:00.000Z', { startedAt: '2026-09-15T15:00:10.000Z' });
  writeEvents('daily-standup', 'standup-worked', ['run_started', 'step_started', 'step_completed', 'step_started']);
  // review: a single paused occurrence, nothing newer → kept
  writeRun('review-1', 'channel-review', 'parked', '2026-09-15T23:00:00.000Z');
  // a completed run of standup between the old ones and the newest (a newer occurrence of any state supersedes)
  writeRun('standup-done', 'daily-standup', 'completed', '2026-09-16T15:00:00.000Z', { finishedAt: '2026-09-16T15:02:00.000Z', terminalOutcome: 'succeeded' });
  addNotification({ id: 'workflow-boot-resume-cap-standup-1', kind: 'system', title: 'Paused "daily-standup" after repeated restarts', body: 'x', createdAt: new Date().toISOString(), read: false });

  const dead = deadOccurrences(readOccurrenceViews());
  assert.deepEqual(dead.map((entry) => entry.dead.runId).sort(), ['standup-1', 'standup-2']);

  const result = sweepDeadOccurrences({ source: 'test' });
  assert.equal(result.cancelled, 2, JSON.stringify(result));
  assert.deepEqual(result.cancelledRunIds.sort(), ['standup-1', 'standup-2']);
  assert.equal(result.keptNewest, 2, 'standup-3 and review-1 wait for a decision');
  assert.equal(result.keptWorked, 1, 'standup-worked completed a step');
  assert.equal(readRun('standup-1').status, 'cancelled');
  assert.match(String(readRun('standup-1').error ?? readRun('standup-1').cancelReason ?? JSON.stringify(readRun('standup-1'))), /Superseded: "daily-standup" has a newer occurrence/);
  assert.equal(readRun('standup-3').status, 'parked');
  assert.equal(readRun('standup-worked').status, 'parked');
  assert.equal(readRun('review-1').status, 'parked');
  assert.equal(loadNotifications().find((n) => n.id === 'workflow-boot-resume-cap-standup-1')?.read, true, 'the dead card is read');

  const again = sweepDeadOccurrences({ source: 'test' });
  assert.equal(again.cancelled, 0, 'idempotent');
});
