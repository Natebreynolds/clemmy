import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import type { ExpectedMemorySnapshot } from './memory-fact-mutation-guard.js';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-edit-guard-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const { registerConsoleRoutes } = await import('./console-routes.js');
const facts = await import('../memory/facts.js');
const memory = await import('../memory/db.js');
const events = await import('../runtime/harness/eventlog.js');
const telemetry = await import('../runtime/operational-telemetry.js');
const models = await import('../runtime/model-route-metrics.js');
const { stableContextGeneration } = await import('../runtime/stable-context-generation.js');
after(() => {
  models.closeModelRouteMetricsDb(); memory.closeMemoryDb(); events.closeEventLog(); telemetry.closeOperationalTelemetryDb();
  rmSync(home, { recursive: true, force: true });
});
const snapshot = (fact: NonNullable<ReturnType<typeof facts.getFact>>): ExpectedMemorySnapshot => ({
  updatedAt: fact.updatedAt, content: fact.content, active: fact.active,
  supersededByFactId: fact.supersededByFactId ?? null, pinned: Boolean(fact.pinned),
});
async function boot() {
  const app = express(); app.use(express.json());
  registerConsoleRoutes(app, () => true, { getRuntime: () => ({ listPendingApprovals: () => [] }) } as never, { serveLegacyAtRoot: false });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/memory/facts`;
  return { request: (id: number | string, verb: string, body: unknown, method = 'POST') => fetch(`${base}/${id}${verb ? `/${verb}` : ''}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
function unchangedState(ids: number[]) {
  const db = memory.openMemoryDb();
  return { changes: db.prepare('SELECT total_changes() AS changes').get(),
    allFacts: db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get(),
    rows: ids.map(id => db.prepare('SELECT * FROM consolidated_facts WHERE id = ?').get(id)) };
}

test('stale correction, forget and restored superseded records refuse without touching either generation', async () => {
  const original = facts.rememberFact({ kind: 'project', content: 'Synthetic old guarded approach.', scope: { projectId: 'guarded-project', agentKey: null } });
  const expectedMemory = snapshot(original);
  const successor = facts.supersedeFact(original.id, { content: 'Synthetic newer guarded approach.' })!;
  const freshObsolete = snapshot(facts.getFact(original.id)!);
  const app = await boot();
  try {
    const before = unchangedState([original.id, successor.id]);
    const generationBefore = stableContextGeneration();
    for (const request of [
      () => app.request(original.id, '', { expectedMemory, content: 'SHOULD_NOT_FORK' }, 'PATCH'),
      () => app.request(original.id, 'forget', { expectedMemory }),
      () => app.request(original.id, 'restore', { expectedMemory: freshObsolete }),
      () => app.request(original.id, 'pin', { expectedMemory: freshObsolete, pinned: true }),
    ]) {
      const response = await request();
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'This saved memory changed. Reload it and review before trying again.' });
      assert.deepEqual(unchangedState([original.id, successor.id]), before);
      assert.equal(stableContextGeneration(), generationBefore, 'a rejected snapshot does not invalidate stable memory');
    }
  } finally { await app.close(); }
});

test('a forgotten record superseded after the detail read cannot be revived by stale restore', async () => {
  const original = facts.rememberFact({ kind: 'feedback', content: 'Synthetic stale restore original.' });
  facts.forgetFact(original.id);
  const expectedMemory = snapshot(facts.getFact(original.id)!);
  const successor = facts.supersedeFact(original.id, { content: 'Synthetic stale restore successor.' })!;
  const before = unchangedState([original.id, successor.id]);
  const app = await boot();
  try {
    assert.equal((await app.request(original.id, 'restore', { expectedMemory })).status, 409);
    assert.deepEqual(unchangedState([original.id, successor.id]), before);
  } finally { await app.close(); }
});

test('fresh snapshots permit existing correction, forget, restore and pin operations while preserving scope', async () => {
  const original = facts.rememberFact({ kind: 'project', content: 'Synthetic successful guarded correction.', scope: { projectId: 'guarded-project', agentKey: null } });
  const app = await boot();
  try {
    const generationBefore = stableContextGeneration();
    const corrected = await app.request(original.id, '', { expectedMemory: snapshot(original), content: 'Synthetic successful guarded successor.' }, 'PATCH');
    assert.equal(corrected.status, 200);
    assert.equal(stableContextGeneration(), generationBefore + 1, 'a successful correction invalidates the stable memory snapshot once');
    const result = await corrected.json() as { fact: { id: number; content: string }; supersededFactId: number };
    assert.equal(result.supersededFactId, original.id);
    assert.notEqual(result.fact.id, original.id);
    assert.equal(facts.factScope(result.fact.id)?.projectId, 'guarded-project');
    assert.equal(facts.getFact(original.id)?.supersededByFactId, result.fact.id);
    const id = result.fact.id;
    assert.equal((await app.request(id, 'pin', { expectedMemory: snapshot(facts.getFact(id)!), pinned: true })).status, 200);
    assert.equal(facts.getFact(id)?.pinned, true);
    assert.equal((await app.request(id, 'forget', { expectedMemory: snapshot(facts.getFact(id)!) })).status, 200);
    assert.equal(facts.getFact(id)?.active, false);
    assert.equal((await app.request(id, 'restore', { expectedMemory: snapshot(facts.getFact(id)!) })).status, 200);
    assert.equal(facts.getFact(id)?.active, true);
  } finally { await app.close(); }
});

test('invalid snapshots and noncanonical guarded IDs fail before a mutation; same timestamp does not hide content or pin changes', async () => {
  const original = facts.rememberFact({ kind: 'user', content: 'Synthetic snapshot validation.' });
  const app = await boot();
  try {
    const before = unchangedState([original.id]);
    for (const expectedMemory of [null, [], {}, { ...snapshot(original), active: 1 }, { ...snapshot(original), pinned: undefined }, { ...snapshot(original), supersededByFactId: '2' }]) {
      assert.equal((await app.request(original.id, 'forget', { expectedMemory })).status, 400);
      assert.deepEqual(unchangedState([original.id]), before);
    }
    assert.equal((await app.request(`${original.id}x`, 'forget', { expectedMemory: snapshot(original) })).status, 400);
    const db = memory.openMemoryDb();
    db.prepare('UPDATE consolidated_facts SET pinned = 1 WHERE id = ?').run(original.id);
    const afterPin = unchangedState([original.id]);
    assert.equal((await app.request(original.id, 'forget', { expectedMemory: snapshot(original) })).status, 409);
    assert.deepEqual(unchangedState([original.id]), afterPin);
    db.prepare('UPDATE consolidated_facts SET content = ? WHERE id = ?').run('Synthetic externally changed content.', original.id);
    const afterContent = unchangedState([original.id]);
    assert.equal((await app.request(original.id, '', { expectedMemory: snapshot(original), content: 'SHOULD_NOT_REPLACE' }, 'PATCH')).status, 409);
    assert.deepEqual(unchangedState([original.id]), afterContent);
  } finally { await app.close(); }
});

test('snapshot comparison and mutation retain one immediate write lock against another connection', async t => {
  const original = facts.rememberFact({ kind: 'user', content: 'Synthetic atomic guarded update.' });
  const app = await boot();
  const db = memory.openMemoryDb();
  const competitor = new Database(path.join(home, 'state', 'memory.db'));
  competitor.pragma('busy_timeout = 0');
  const prepare = db.prepare.bind(db);
  let blocked = false;
  let attempted = false;
  const mocked = t.mock.method(db, 'prepare', ((sql: string) => {
    const statement = prepare(sql);
    if (sql !== 'SELECT * FROM consolidated_facts WHERE id = ?' || attempted) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === 'get') return (...args: unknown[]) => {
        const row = target.get(...args as never[]);
        if (!attempted) {
          attempted = true;
          try { competitor.prepare('UPDATE consolidated_facts SET content = ? WHERE id = ?').run('SHOULD_NOT_RACE', original.id); }
          catch (error) { blocked = (error as { code?: string }).code === 'SQLITE_BUSY'; }
        }
        return row;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }) as typeof db.prepare);
  try {
    const response = await app.request(original.id, 'forget', { expectedMemory: snapshot(original) });
    assert.equal(response.status, 200);
    assert.equal(attempted, true);
    assert.equal(blocked, true, 'other connection cannot write between comparison and mutation');
    assert.equal(facts.getFact(original.id)?.content, original.content);
    assert.equal(facts.getFact(original.id)?.active, false);
  } finally { mocked.mock.restore(); competitor.close(); await app.close(); }
});

test('callers without expectedMemory preserve the existing restore behavior', async () => {
  const original = facts.rememberFact({ kind: 'user', content: 'Synthetic legacy restore source.' });
  facts.supersedeFact(original.id, { content: 'Synthetic legacy restore successor.' });
  const app = await boot();
  try {
    const response = await app.request(original.id, 'restore', {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(facts.getFact(original.id)?.active, true);
    assert.equal(facts.getFact(original.id)?.supersededByFactId, null);
  } finally { await app.close(); }
});
