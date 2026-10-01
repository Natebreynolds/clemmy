/**
 * Run: npx tsx --test src/dashboard/console-heartbeats.test.ts
 *
 * The heartbeats surface: every heartbeat is listed with its contract; the
 * owner can change cadence, on/off and how items reach them; rules are added
 * in their words and removed by id; a manual tick answers with a summary and
 * writes nothing when there is nothing to notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-heartbeats-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function send(url: string, method: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

type Status = { id: string; enabled: boolean; cadenceMinutes: number; contract: { notify: string; rules: Array<{ id: string; text: string; by: string }> }; lastFinding?: { summary: string } };

test('heartbeats are listed with their contracts, changed by the owner, given rules, and ticked by hand', async () => {
  const server = await boot();
  try {
    const list = await send(`${server.url}/api/console/heartbeats`, 'GET');
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
    const beats = list.body.heartbeats as Status[];
    assert.deepEqual(beats.map((b) => b.id), ['work-review', 'calendar', 'workflow-suggestions', 'noticing']);
    const review = beats[0];
    assert.equal(review.enabled, true);
    assert.equal(review.cadenceMinutes, 60);
    assert.equal(review.contract.notify, 'quiet');
    assert.deepEqual(review.contract.rules, []);

    const patched = await send(`${server.url}/api/console/heartbeats/work-review`, 'PATCH', { cadenceMinutes: 5, notify: 'push' });
    assert.equal(patched.status, 200);
    const after = patched.body.heartbeat as Status;
    assert.equal(after.cadenceMinutes, 15, 'the cadence is clamped to the heartbeat\'s range');
    assert.equal(after.contract.notify, 'push');

    const bad = await send(`${server.url}/api/console/heartbeats/nope`, 'PATCH', { enabled: false });
    assert.equal(bad.status, 404);

    const rule = await send(`${server.url}/api/console/heartbeats/work-review/rules`, 'POST', { text: 'Skip anything from test or fixture workflows.' });
    assert.equal(rule.status, 200, JSON.stringify(rule.body));
    const ruleId = (rule.body.rule as { id: string; by: string }).id;
    assert.equal((rule.body.rule as { by: string }).by, 'owner');
    const dup = await send(`${server.url}/api/console/heartbeats/work-review/rules`, 'POST', { text: 'skip anything from test or fixture workflows.' });
    assert.equal(dup.status, 400);
    assert.match(String(dup.body.error), /already there/);
    const empty = await send(`${server.url}/api/console/heartbeats/work-review/rules`, 'POST', { text: '  ' });
    assert.equal(empty.status, 400);

    const tick = await send(`${server.url}/api/console/heartbeats/work-review/tick`, 'POST', {});
    assert.equal(tick.status, 200, JSON.stringify(tick.body).slice(0, 200));
    const t = tick.body.tick as { summary: string; produced: number; quiet: boolean };
    assert.equal(t.produced, 0);
    assert.equal(t.quiet, true);
    assert.match(t.summary, /work review: quiet/);
    assert.match(((tick.body.heartbeat as Status).lastFinding?.summary) ?? '', /quiet/);

    const removed = await send(`${server.url}/api/console/heartbeats/work-review/rules/${ruleId}`, 'DELETE');
    assert.equal(removed.status, 200);
    assert.deepEqual((removed.body.heartbeat as Status).contract.rules, []);
    const gone = await send(`${server.url}/api/console/heartbeats/work-review/rules/${ruleId}`, 'DELETE');
    assert.equal(gone.status, 404);

    // Noticing: on the same contract, with its own cap, and a thinking record
    // the owner can read. With no model in this process a tick says so and
    // proposes nothing.
    const noticing = await send(`${server.url}/api/console/noticing`, 'GET');
    assert.equal(noticing.status, 200, JSON.stringify(noticing.body).slice(0, 200));
    const n = noticing.body.noticing as { enabled: boolean; cadenceMinutes: number; dailyCap: number; thinking: unknown[] };
    assert.equal(n.enabled, true);
    assert.equal(n.cadenceMinutes, 180);
    assert.equal(n.dailyCap, 2);
    const patchedCap = await send(`${server.url}/api/console/noticing`, 'PATCH', { dailyCap: 30, cadenceMinutes: 60 });
    assert.equal((patchedCap.body.noticing as { dailyCap: number }).dailyCap, 10, 'the cap is clamped');
    assert.equal((patchedCap.body.noticing as { cadenceMinutes: number }).cadenceMinutes, 60);
    const noticed = await send(`${server.url}/api/console/heartbeats/noticing/tick`, 'POST', {});
    assert.equal(noticed.status, 200, JSON.stringify(noticed.body).slice(0, 300));
    const nt = noticed.body.tick as { summary: string; produced: number; quiet: boolean };
    assert.equal(nt.produced, 0);
    assert.match(nt.summary, /no model/);
    const afterTick = await send(`${server.url}/api/console/noticing`, 'GET');
    const thinking = (afterTick.body.noticing as { thinking: Array<{ summary: string; read: { goals: number } }> }).thinking;
    assert.equal(thinking.length, 1);
    assert.match(thinking[0]!.summary, /no model/);
  } finally {
    await server.close();
  }
});
