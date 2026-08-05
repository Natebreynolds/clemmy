/**
 * Run: npx tsx --test src/dashboard/activity-settlement.test.ts
 *
 * A linked notebook action must not outlive the work it points at. The lane
 * that dispatches an action chooses the id it links by, and the lane that
 * settles the work calls back with the id IT knows — so any run whose two ids
 * differ used to leave a permanently "running" action on the user's board.
 *
 * These drive the real console route against real stores: a real focus with a
 * real linked action, real background/workflow records, and the same endpoint
 * the console polls.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clementine-activity-settle-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(testHome, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { settleFocusActionsForTerminals } = await import('./activity-settlement.js');
const { projectActivitySnapshot } = await import('./activity-projection.js');
const focus = await import('../memory/focus.js');
const bg = await import('../execution/background-tasks.js');

test.after(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  } as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function focusWithAction(title: string, action: { id: string; ref: string }): number {
  const row = focus.createFocus({
    resourceRef: `session:settle-${action.id}`,
    title,
    summary: 'settlement fixture',
  });
  focus.activateFocus(row.id);
  focus.patchFocusWorkstate(row.id, {
    upsertActions: [{
      id: action.id,
      label: title,
      status: 'running',
      kind: 'background',
      ref: action.ref,
    }],
  });
  return row.id;
}

function actionStatus(focusId: number, actionId: string): string | undefined {
  const row = focus.listFocuses({ includeTerminal: true, limit: 50 }).find((f) => f.id === focusId);
  return focus.getFocusWorkstate(row)?.actions.find((a) => a.id === actionId)?.status;
}

test('a completed run settles the action linked to it, whichever id it was linked by', async () => {
  const task = bg.createBackgroundTask({ title: 'Export the ledger', prompt: 'export', source: 'desktop' });
  bg.markBackgroundTaskRunning(task.id);
  // Linked by TASK id, the way the dispatch tool links it.
  const byTaskId = focusWithAction('Export the ledger', { id: task.id, ref: task.id });
  // Linked by the run SESSION id — a different identity for the same work,
  // which is exactly the mismatch that used to strand the action.
  const bySessionId = focusWithAction('Export the ledger (session-linked)', {
    id: 'act-session-linked',
    ref: task.runSessionId,
  });

  bg.markBackgroundTaskDone(task.id, 'ledger exported');

  const server = await boot();
  try {
    const response = await fetch(`${server.url}/api/console/activity/v2`);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }

  assert.equal(actionStatus(byTaskId, task.id), 'done',
    'a completed run left its own action running');
  assert.equal(actionStatus(bySessionId, 'act-session-linked'), 'done',
    'an action linked by a different id for the same run stayed running forever');
});

test('a failed run settles as blocked — never done, never still running', () => {
  const task = bg.createBackgroundTask({ title: 'Nightly sync', prompt: 'sync', source: 'gateway' });
  bg.markBackgroundTaskRunning(task.id);
  // Linked by the RUN SESSION id: the task store settles by task id only, so
  // this is precisely the action its own lane can never reach.
  const focusId = focusWithAction('Nightly sync', { id: 'act-failed-session', ref: task.runSessionId });
  bg.markBackgroundTaskFailed(task.id, 'the endpoint refused');

  const settled = settleFocusActionsForTerminals(projectActivitySnapshot().entries);
  assert.ok(settled >= 1, 'the failed run settled nothing');
  assert.equal(actionStatus(focusId, 'act-failed-session'), 'blocked',
    'a failed run was reported as done or left running');
});

test('a run that needs a person stops claiming to run', () => {
  const task = bg.createBackgroundTask({ title: 'Send the summary', prompt: 'send', source: 'desktop' });
  bg.markBackgroundTaskRunning(task.id);
  const focusId = focusWithAction('Send the summary', { id: task.id, ref: task.id });
  bg.markBackgroundTaskAwaitingApproval(task.id, 'apr-settle-1', 'Send it?');

  settleFocusActionsForTerminals(projectActivitySnapshot().entries);
  assert.equal(actionStatus(focusId, task.id), 'blocked',
    'work parked on a human still read as running');
});

test('work still genuinely running is left alone', () => {
  const task = bg.createBackgroundTask({ title: 'Long crawl', prompt: 'crawl', source: 'desktop' });
  bg.markBackgroundTaskRunning(task.id);
  const focusId = focusWithAction('Long crawl', { id: task.id, ref: task.id });

  settleFocusActionsForTerminals(projectActivitySnapshot().entries);
  assert.equal(actionStatus(focusId, task.id), 'running',
    'a live run had its action closed out from under it');
});

test('a settled workflow run settles the action linked by its run id', () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'settle-run.json'), JSON.stringify({
    id: 'settle-run', workflow: 'Weekly Report', status: 'completed',
    createdAt: '2026-08-04T09:00:00.000Z', finishedAt: '2026-08-04T09:05:00.000Z',
  }), 'utf-8');
  const focusId = focusWithAction('Weekly Report', { id: 'act-wf', ref: 'settle-run' });

  settleFocusActionsForTerminals(projectActivitySnapshot().entries);
  assert.equal(actionStatus(focusId, 'act-wf'), 'done',
    'a finished workflow run left its notebook action running');
});
