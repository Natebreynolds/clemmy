import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-task-handling-routes-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('../runtime/harness/eventlog.js');
const { registerConsoleTaskHandlingRoutes } = await import('./console-task-handling-routes.js');
const memory = await import('../memory/db.js');
after(() => { log.closeEventLog(); memory.closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });
test('details require authorization and an exact accepted source, and never cache task information', async () => {
  const session = log.createSession({ id: 'fixture-task-route', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, type: 'user_input_received', turn: 0, role: 'user', data: { text: 'Synthetic route fixture.' } });
  let authorized = false;
  const app = express();
  registerConsoleTaskHandlingRoutes(app, { isAuthorized: () => authorized });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/sessions/${session.id}/handling`;
  try {
    assert.equal((await fetch(`${base}?sourceUserSeq=${source.seq}`)).status, 401);
    authorized = true;
    for (const value of ['', '?sourceUserSeq=0', '?sourceUserSeq=1.5', '?sourceUserSeq=1x', '?sourceUserSeq=9007199254740992']) {
      assert.equal((await fetch(`${base}${value}`)).status, 400);
    }
    assert.equal((await fetch(`${base}?sourceUserSeq=${source.seq + 1000}`)).status, 404);
    const before = log.openEventLog().prepare('SELECT COUNT(*) AS count FROM events').get();
    const response = await fetch(`${base}?sourceUserSeq=${source.seq}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { sessionId: string; sourceUserSeq: number };
    assert.equal(body.sessionId, session.id);
    assert.equal(body.sourceUserSeq, source.seq);
    assert.doesNotMatch(JSON.stringify(body), /Synthetic route fixture/);
    assert.deepEqual(log.openEventLog().prepare('SELECT COUNT(*) AS count FROM events').get(), before, 'GET records no new harness events');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('lightweight memory status requires exact identity, is never cached, and sanitizes read failures', async () => {
  const session = log.createSession({ id: 'fixture-memory-status-route', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, type: 'user_input_received', turn: 0, role: 'user', data: { text: 'Synthetic ordinary read.' } });
  let authorized = false;
  const app = express(); registerConsoleTaskHandlingRoutes(app, { isAuthorized: () => authorized });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/sessions/${session.id}/memory-status`;
  try {
    const denied = await fetch(`${base}?sourceUserSeq=${source.seq}`);
    assert.equal(denied.status, 401); assert.equal(denied.headers.get('cache-control'), 'no-store');
    authorized = true;
    for (const query of ['', '?sourceUserSeq=-1', '?sourceUserSeq=1.5', '?sourceUserSeq=1x', '?sourceUserSeq=9007199254740992', '?sourceUserSeq=1&sourceUserSeq=2']) {
      const invalid = await fetch(`${base}${query}`); assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await fetch(`${base}?sourceUserSeq=${source.seq + 1000}`)).status, 404);
    const before = log.openEventLog().prepare('SELECT * FROM events ORDER BY seq').all();
    const response = await fetch(`${base}?sourceUserSeq=${source.seq}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { memory: unknown };
    assert.equal(body.memory, null); assert.doesNotMatch(JSON.stringify(body), /Synthetic ordinary read/);
    assert.deepEqual(log.openEventLog().prepare('SELECT * FROM events ORDER BY seq').all(), before);
    log.openEventLog().exec('SAVEPOINT broken_status_reader');
    try {
      log.openEventLog().exec('ALTER TABLE events RENAME TO events_unavailable_fixture');
      const failed = await fetch(`${base}?sourceUserSeq=${source.seq}`);
      assert.equal(failed.status, 500); assert.equal(failed.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await failed.json(), { error: 'Memory status is temporarily unavailable.' });
    } finally { log.openEventLog().exec('ROLLBACK TO broken_status_reader; RELEASE broken_status_reader'); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
