import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-detail-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
const { registerConsoleMemoryFactDetailRoutes } = await import('./console-memory-fact-detail-routes.js');
const facts = await import('../memory/facts.js');
const memory = await import('../memory/db.js');
const events = await import('../runtime/harness/eventlog.js');
const telemetry = await import('../runtime/operational-telemetry.js');
const { withScopeViews } = await import('../projects/memory-scope-views.js');
after(() => {
  memory.closeMemoryDb(); events.closeEventLog(); telemetry.closeOperationalTelemetryDb();
  rmSync(home, { recursive: true, force: true });
});

async function boot() {
  const authorized = { value: true };
  const app = express();
  registerConsoleMemoryFactDetailRoutes(app, { isAuthorized: () => authorized.value });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { authorized, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/memory/facts`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('auth is checked before IDs or memory lookups; responses are never cached', async () => {
  const app = await boot();
  try {
    app.authorized.value = false;
    for (const id of ['1', 'not-an-id']) {
      const response = await fetch(`${app.url}/${id}/detail`);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
  } finally { await app.close(); }
});

test('malformed, nonpositive and unsafe IDs cannot select a partial or rounded fact', async () => {
  const app = await boot();
  try {
    for (const id of ['0', '-1', '1x', '1.5', '1e2', 'NaN', 'Infinity', '9007199254740992', '%20', '%201%20', '%2B1']) {
      const response = await fetch(`${app.url}/${id}/detail`);
      assert.equal(response.status, 400, id);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'A valid memory ID is required.' });
    }
    const missing = await fetch(`${app.url}/9007199254740991/detail`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await missing.json(), { error: 'This saved memory was not found.' });
  } finally { await app.close(); }
});

test('detail returns the exact current fact with its evidence, stored scope and pin', async () => {
  const retained = facts.rememberFact({ kind: 'project', content: 'Synthetic preference: use the fixture command for this project.',
    sourceUri: 'fixture://preference-source', scope: { projectId: 'fixture-project', agentKey: null } });
  facts.setFactPinned(retained.id, true);
  const expected = withScopeViews([facts.getFactWithEvidence(retained.id)!])[0];
  const app = await boot();
  try {
    const response = await fetch(`${app.url}/${retained.id}/detail`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { fact } = await response.json() as { fact: typeof expected };
    assert.deepEqual(fact, JSON.parse(JSON.stringify(expected)));
    assert.equal(fact.active, true);
    assert.equal(fact.pinned, true);
    assert.equal(fact.scope.kind, 'project');
    assert.equal(fact.scope.projectId, 'fixture-project');
    assert.equal(fact.evidence?.[0].sourceUri, 'fixture://preference-source');
    assert.ok(fact.evidence?.[0].excerpt.includes('Synthetic preference'));
  } finally { await app.close(); }
});

test('inactive and superseded facts remain addressable without silently returning a successor', async () => {
  const original = facts.rememberFact({ kind: 'feedback', content: 'Synthetic original preference.', scope: { projectId: 'fixture-project', agentKey: null } });
  const replacement = facts.supersedeFact(original.id, { content: 'Synthetic corrected preference.' })!;
  const forgotten = facts.rememberFact({ kind: 'user', content: 'Synthetic separately forgotten preference.' });
  facts.forgetFact(forgotten.id);
  const app = await boot();
  try {
    const originalResponse = await fetch(`${app.url}/${original.id}/detail`);
    assert.equal(originalResponse.status, 200);
    const { fact } = await originalResponse.json() as { fact: { id: number; content: string; active: boolean; supersededByFactId: number; scope: { projectId: string } } };
    assert.equal(fact.id, original.id);
    assert.equal(fact.content, original.content);
    assert.equal(fact.active, false);
    assert.equal(fact.supersededByFactId, replacement.id);
    assert.equal(fact.scope.projectId, 'fixture-project');
    const successor = await (await fetch(`${app.url}/${replacement.id}/detail`)).json() as { fact: { id: number; content: string; active: boolean } };
    assert.equal(successor.fact.id, replacement.id);
    assert.equal(successor.fact.content, replacement.content);
    assert.equal(successor.fact.active, true);
    const inactive = await (await fetch(`${app.url}/${forgotten.id}/detail`)).json() as { fact: { id: number; active: boolean } };
    assert.equal(inactive.fact.id, forgotten.id);
    assert.equal(inactive.fact.active, false);
  } finally { await app.close(); }
});

test('repeated detail GETs do not change memory rows, counters or harness events', async () => {
  const retained = facts.rememberFact({ kind: 'user', content: 'Synthetic read-only detail fixture.' });
  const db = memory.openMemoryDb();
  const eventDb = events.openEventLog();
  const app = await boot();
  try {
    const snapshot = () => ({
      writes: db.prepare('SELECT total_changes() AS changes').get(),
      fact: db.prepare('SELECT * FROM consolidated_facts WHERE id = ?').get(retained.id),
      evidence: db.prepare('SELECT * FROM fact_evidence WHERE fact_id = ?').all(retained.id),
      eventWrites: eventDb.prepare('SELECT total_changes() AS changes').get(),
      eventCount: eventDb.prepare('SELECT COUNT(*) AS count FROM events').get(),
    });
    const before = snapshot();
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${app.url}/${retained.id}/detail`)).status, 200);
    assert.deepEqual(snapshot(), before);
  } finally { await app.close(); }
});

test('read failures return sanitized errors without leaking saved content or storage paths', async t => {
  const retained = facts.rememberFact({ kind: 'user', content: 'Synthetic error fixture.' });
  const app = await boot();
  const db = memory.openMemoryDb();
  const prepare = db.prepare.bind(db);
  const mocked = t.mock.method(db, 'prepare', ((sql: string) => {
    if (sql === 'SELECT * FROM consolidated_facts WHERE id = ?') throw new Error('/private/fixture-home saved-content-should-not-leak');
    return prepare(sql);
  }) as typeof db.prepare);
  try {
    const response = await fetch(`${app.url}/${retained.id}/detail`);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'This saved memory is temporarily unavailable.' });
  } finally { mocked.mock.restore(); await app.close(); }
});
