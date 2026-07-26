/**
 * Run: npx tsx --test src/dashboard/console-focus.test.ts
 *
 * The console must see the same normalized collaborative notebook the model
 * sees, without exposing current_focus.metadata_json as an unbounded internal
 * transport.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-focus-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { createFocus, patchFocusWorkstate } = await import('../memory/focus.js');

after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(authorized = true) {
  const app = express();
  app.use(express.json());
  const assistant = {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  };
  registerConsoleRoutes(app, () => authorized, assistant as never, { serveLegacyAtRoot: false });
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

test('GET /api/console/focus returns a bounded shared-workstate projection', async () => {
  const parked = createFocus({
    resourceRef: 'session:meal-planning-old',
    resourceKind: 'thread',
    relatedSessionId: 'meal-planning-old',
    title: 'Earlier dinner ideas',
    summary: 'Paused while we compare a new menu.',
    metadata: { internalOnly: 'do-not-expose' },
  });
  patchFocusWorkstate(parked.id, {
    mode: 'explore',
    upsertCandidates: [{ id: 'tacos', label: 'Tacos', status: 'considering' }],
  });

  const active = createFocus({
    resourceRef: 'session:meal-planning',
    resourceKind: 'thread',
    relatedSessionId: 'meal-planning',
    title: 'Plan weeknight meals',
    summary: 'Choose recipes, then update Airtable and the calendar.',
    metadata: { providerScratch: { shouldStayPrivate: true } },
  });
  patchFocusWorkstate(active.id, {
    mode: 'execute',
    objective: 'Finalize three meals and coordinate the selected plan.',
    addDecisions: ['Make the lemon pasta on Tuesday.'],
    openLoops: ['Choose the Thursday meal.'],
    upsertActions: [{
      id: 'calendar',
      label: 'Update the calendar',
      status: 'running',
      kind: 'background',
      ref: 'bg-calendar-1',
    }],
  });

  const h = await boot();
  try {
    const res = await fetch(`${h.url}/api/console/focus`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      active: Record<string, unknown> & { workstate?: Record<string, unknown> };
      parked: Array<Record<string, unknown> & { workstate?: Record<string, unknown> }>;
      needsConfirm: boolean;
    };

    assert.equal(body.active.id, active.id);
    assert.equal(body.active.metadata_json, undefined, 'internal metadata is never sent to the console');
    assert.equal(body.active.workstate?.mode, 'execute');
    assert.deepEqual(body.active.workstate?.decisions, ['Make the lemon pasta on Tuesday.']);
    assert.deepEqual(body.active.workstate?.openLoops, ['Choose the Thursday meal.']);
    assert.equal(
      (body.active.workstate?.actions as Array<{ ref?: string }>)[0]?.ref,
      'bg-calendar-1',
    );

    const parkedView = body.parked.find((row) => row.id === parked.id);
    assert.ok(parkedView, 'parked focus remains available for continuity');
    assert.equal(parkedView?.metadata_json, undefined);
    assert.equal(parkedView?.workstate?.mode, 'explore');
  } finally {
    await h.close();
  }
});

test('GET /api/console/focus preserves the authorization boundary', async () => {
  const h = await boot(false);
  try {
    const res = await fetch(`${h.url}/api/console/focus`);
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});
