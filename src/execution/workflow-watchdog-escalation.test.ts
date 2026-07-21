/**
 * Run: npx tsx --test src/execution/workflow-watchdog-escalation.test.ts
 * Watchdog escalation (2026-07-20): a run "running" with zero activity past
 * the escalation window is actually CANCELLED at the boundary, not warned
 * forever. Isolated CLEMENTINE_HOME — the run/notification stores are real.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-watchdog-escalation-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { runWorkflowWatchdog } = await import('./workflow-watchdog.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { loadNotifications } = await import('../runtime/notifications.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.CLEMMY_WORKFLOW_ESCALATE;
  delete process.env.CLEMMY_WORKFLOW_ESCALATE_MS;
});

const NOW = 1_780_000_000_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function writeRun(id: string, silentForMs: number): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
  writeFileSync(file, JSON.stringify({
    id,
    workflow: 'client-outreach',
    status: 'running',
    createdAt: iso(silentForMs + 60_000),
    startedAt: iso(silentForMs + 30_000),
    lastActivityAt: iso(silentForMs),
  }, null, 2));
  return file;
}

test('a run silent past the escalation window is CANCELLED with an honest notification', () => {
  const file = writeRun('wfrun-zombie', 90 * 60_000); // silent 90m > 60m default window
  runWorkflowWatchdog(NOW);
  const record = JSON.parse(readFileSync(file, 'utf-8')) as { status?: string };
  assert.equal(record.status, 'cancelled', 'the zombie stops pretending to work');
  const notes = loadNotifications();
  const escalated = notes.find((n) => n.id === 'workflow-escalated-wfrun-zombie');
  assert.ok(escalated, 'the user is told the run was stopped, not left with a stale alert');
  assert.match(escalated!.body, /zero activity/);
  assert.match(escalated!.body, /Completed steps stay cached/);
  const plainAlert = notes.find((n) => n.id === 'workflow-stalled-wfrun-zombie');
  assert.equal(plainAlert, undefined, 'no per-tick stalled alert once terminated');
});

test('a run inside the escalation window only ALERTS (10m silent → warn, not cancel)', () => {
  const file = writeRun('wfrun-young', 15 * 60_000); // silent 15m < 60m window
  runWorkflowWatchdog(NOW);
  const record = JSON.parse(readFileSync(file, 'utf-8')) as { status?: string };
  assert.equal(record.status, 'running', 'inside the window the human decides');
  assert.ok(loadNotifications().some((n) => n.id === 'workflow-stalled-wfrun-young'), 'the plain stall alert fires');
});

test('CLEMMY_WORKFLOW_ESCALATE=off restores observe-only', () => {
  process.env.CLEMMY_WORKFLOW_ESCALATE = 'off';
  const file = writeRun('wfrun-observed', 90 * 60_000);
  runWorkflowWatchdog(NOW);
  const record = JSON.parse(readFileSync(file, 'utf-8')) as { status?: string };
  assert.equal(record.status, 'running', 'kill-switch keeps the old alert-only behavior');
  assert.ok(loadNotifications().some((n) => n.id === 'workflow-stalled-wfrun-observed'));
});
