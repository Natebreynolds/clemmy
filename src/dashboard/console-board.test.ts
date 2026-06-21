/**
 * Run: npx tsx --test src/dashboard/console-board.test.ts
 *
 * Functional smoke for the unified Tasks-board route (GET /api/console/board
 * + the background action route). Seeds background tasks across every status,
 * boots a tiny Express app with the REAL registerConsoleRoutes (stub assistant
 * — the board route never touches it), and asserts each task normalizes into
 * the right column with the right drag/button actions. Fills the gap that the
 * board route had no test. Offline, deterministic, per-test temp home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-board-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask, markBackgroundTaskRunning, markBackgroundTaskDone,
  markBackgroundTaskAwaitingApproval, markBackgroundTaskBlocked, markBackgroundTaskFailed,
  getBackgroundTask,
} = await import('../execution/background-tasks.js');
const { registerConsoleRoutes } = await import('./console-routes.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

interface BoardCard { id: string; column: string; actions: string[]; sourceKind: string; status: string }

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  // The board route uses only isAuthorized + the background-task store; the
  // assistant is touched only by the `promote` action (not exercised here).
  registerConsoleRoutes(app, () => authorized.v, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('GET /api/console/board normalizes every background-task status into the right column + actions', async () => {
  // Seed one task per status, driving each through the real state machine.
  const pending = createBackgroundTask({ title: 'queued task', prompt: 'p' });

  const running = createBackgroundTask({ title: 'running task', prompt: 'p' });
  markBackgroundTaskRunning(running.id);

  const awaiting = createBackgroundTask({ title: 'awaiting task', prompt: 'p' });
  markBackgroundTaskRunning(awaiting.id);
  markBackgroundTaskAwaitingApproval(awaiting.id, 'appr-1', 'need your ok');

  const blocked = createBackgroundTask({ title: 'blocked task', prompt: 'p' });
  markBackgroundTaskRunning(blocked.id);
  markBackgroundTaskBlocked(blocked.id, 'missing data', 'could not finish');

  const done = createBackgroundTask({ title: 'done task', prompt: 'p' });
  markBackgroundTaskRunning(done.id);
  markBackgroundTaskDone(done.id, 'finished');

  const interrupted = createBackgroundTask({ title: 'interrupted task', prompt: 'p' });
  markBackgroundTaskFailed(interrupted.id, 'daemon restarted', 'interrupted');

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board`);
    assert.equal(res.status, 200);
    const body = await res.json() as { cards: BoardCard[] };
    assert.ok(Array.isArray(body.cards), 'board returns a cards array');
    const byId = new Map(body.cards.map((c) => [c.id, c]));

    const expect = (id: string, column: string, actions: string[]) => {
      const card = byId.get(id);
      assert.ok(card, `card ${id} present on the board`);
      assert.equal(card!.sourceKind, 'background');
      assert.equal(card!.column, column, `${id} → column ${column} (got ${card!.column})`);
      assert.deepEqual([...card!.actions].sort(), [...actions].sort(), `${id} actions`);
    };
    expect(pending.id, 'queued', ['promote', 'cancel']);
    expect(running.id, 'running', ['cancel']);
    expect(awaiting.id, 'needs_you', ['cancel']);
    expect(blocked.id, 'needs_you', ['cancel']);
    // Terminal tasks now also offer `archive` (declutter the Done column).
    expect(done.id, 'done', ['archive']);
    expect(interrupted.id, 'done', ['resume', 'archive']);
  } finally {
    await h.close();
  }
});

test('board archive → drops the task off the board; ?includeArchived restores it', async () => {
  const task = createBackgroundTask({ title: 'to archive', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  markBackgroundTaskDone(task.id, 'finished');
  const authorized = { v: true };
  const h = await boot(authorized);
  try {
    // Archive → 200, task soft-deleted.
    const arch = await fetch(`${h.url}/api/console/board/background/${task.id}/archive`, { method: 'POST' });
    assert.equal(arch.status, 200);
    assert.equal((await arch.json() as { ok: boolean }).ok, true);
    assert.equal(getBackgroundTask(task.id)!.archived, true, 'record marked archived (kept on disk)');

    // Default board hides it.
    const board = await (await fetch(`${h.url}/api/console/board`)).json() as { cards: BoardCard[] };
    assert.equal(board.cards.some((c) => c.id === task.id), false, 'archived task hidden from the default board');

    // ?includeArchived=1 surfaces it with a restore-only action.
    const withArchived = await (await fetch(`${h.url}/api/console/board?includeArchived=1`)).json() as { cards: BoardCard[] };
    const card = withArchived.cards.find((c) => c.id === task.id);
    assert.ok(card, 'archived task visible when explicitly requested');
    assert.deepEqual(card!.actions, ['restore']);

    // Restore → back on the default board.
    const rest = await fetch(`${h.url}/api/console/board/background/${task.id}/restore`, { method: 'POST' });
    assert.equal(rest.status, 200);
    assert.equal(getBackgroundTask(task.id)!.archived, false, 'restored');
    const after = await (await fetch(`${h.url}/api/console/board`)).json() as { cards: BoardCard[] };
    assert.equal(after.cards.some((c) => c.id === task.id), true, 'restored task back on the default board');
  } finally {
    await h.close();
  }
});

test('board archive is rejected for an ACTIVE task (its worker is still live)', async () => {
  const task = createBackgroundTask({ title: 'still running', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/board/background/${task.id}/archive`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal((await res.json() as { ok: boolean }).ok, false);
    assert.notEqual(getBackgroundTask(task.id)!.archived, true, 'running task left un-archived');
  } finally {
    await h.close();
  }
});

test('board action route: cancel is accepted and transitions the task; auth is gated', async () => {
  const task = createBackgroundTask({ title: 'to cancel', prompt: 'p' });
  markBackgroundTaskRunning(task.id);
  const authorized = { v: true };
  const h = await boot(authorized);
  try {
    // Unauthorized → 401, no state change.
    authorized.v = false;
    const denied = await fetch(`${h.url}/api/console/board/background/${task.id}/cancel`, { method: 'POST' });
    assert.equal(denied.status, 401);

    // Authorized cancel → 200 ok, task moves out of running.
    authorized.v = true;
    const res = await fetch(`${h.url}/api/console/board/background/${task.id}/cancel`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
    const after = getBackgroundTask(task.id);
    assert.ok(after && after.status !== 'running', `task left running (now ${after?.status})`);

    // 404 for an unknown id.
    const missing = await fetch(`${h.url}/api/console/board/background/does-not-exist/cancel`, { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});
