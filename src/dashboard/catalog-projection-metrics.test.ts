import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-catalog-metrics-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const log = await import('../runtime/harness/eventlog.js');
const { SessionStore } = await import('../memory/session-store.js');
const { buildUnifiedSessionList } = await import('./sessions-api.js');
const { createWorkflowRunStatusReader } = await import('./workflow-run-status.js');
const { readAcceptedSourceConversationProjection, claimSessionForAcceptedSource } = await import('../runtime/harness/accepted-source-session-branch.js');
const { ProjectionReadMetrics } = await import('./projection-read-metrics.js');
const { registerConsoleRoutes } = await import('./console-routes.js');
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

const secretFixture = 'fixture-only catalog private query';
const row = log.createSession({ id: 'metrics-chat', kind: 'chat', channel: 'desktop', userId: 'metrics-owner',
  title: 'Catalog metrics fixture', metadata: { source: 'desktop', channelId: 'metrics-conversation', userId: 'metrics-owner',
    tags: ['metrics'], __conversation: { private: 'state'.repeat(20_000) } } });
claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: row.id, durableSourceId: 'metrics-source',
  continuity: { provider: 'desktop', scopeId: null, conversationId: 'metrics-conversation', audienceId: 'metrics-owner' },
  receipt: { requestId: 'metrics-request', runId: 'metrics-source', inputHash: '1'.repeat(64) } });
const source = log.appendEvent({ sessionId: row.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: secretFixture } });
log.appendEvent({ sessionId: row.id, turn: 1, role: 'Clem', type: 'conversation_completed', data: { sourceUserSeq: source.seq, reply: 'Fixture answer.' } });

function authoritativeRows() {
  const db = log.openEventLog();
  return ['sessions', 'events', 'accepted_source_session_bindings', 'accepted_source_session_pointers']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all());
}

test('measured catalog is exactly equal and diagnostics cannot mutate authority or leak fixture data', () => {
  const query = { q: secretFixture, tag: 'metrics', limit: 10 };
  const before = authoritativeRows();
  const normal = buildUnifiedSessionList(query);
  const metrics = new ProjectionReadMetrics();
  const measured = buildUnifiedSessionList(query, { observer: metrics.observe });
  assert.deepEqual(measured, normal);
  assert.equal(measured.length, 1);
  assert.equal(measured[0]!.preview, 'Fixture answer.');
  assert.deepEqual(authoritativeRows(), before);
  const headers = metrics.headers();
  for (const phase of ['catalog_pages', 'catalog_lineage', 'catalog_lineage_rows', 'catalog_lineage_proofs',
    'catalog_desktop', 'catalog_search', 'catalog_preview', 'catalog_sort', 'catalog_build']) {
    assert.match(headers['Server-Timing']!, new RegExp(`${phase};dur=[\\d.]+`));
  }
  assert.match(headers['Server-Timing']!, /catalog_status;desc="unobserved"/);
  assert.doesNotMatch(JSON.stringify(headers), /fixture-only|metrics-owner|metrics-chat|Fixture answer|private query/);
  assert.deepEqual(buildUnifiedSessionList(query, { observer: () => { throw new Error('observer'); } }), normal);
  assert.deepEqual(readAcceptedSourceConversationProjection(row.id, { observer: () => { throw new Error('observer'); } }),
    readAcceptedSourceConversationProjection(row.id));
});

test('workflow record timing counts real memo misses without replacing unavailable coverage', () => {
  const metrics = new ProjectionReadMetrics();
  const normal = createWorkflowRunStatusReader(path.join(fixtureHome, 'absent-runs'));
  const measured = createWorkflowRunStatusReader(path.join(fixtureHome, 'absent-runs'), { observer: metrics.observe });
  const first = measured('missing-controlled-record');
  assert.deepEqual(first, normal('missing-controlled-record'));
  assert.deepEqual(measured('missing-controlled-record'), first);
  assert.equal(first.runCoverage.state, 'unavailable');
  assert.equal(first.status, 'unknown');
  assert.match(metrics.headers()['X-Clementine-Projection-Counts']!, /catalog_status_records_calls=1/);
});

const app = express();
registerConsoleRoutes(app, req => req.headers.authorization === 'synthetic-fixture-auth', {
  getRuntime: () => ({ listPendingApprovals: () => [] }),
} as never, { serveLegacyAtRoot: false });
const handler = app._router.stack.find((layer: { route?: { path: string } }) => layer.route?.path === '/api/console/sessions').route.stack[0].handle;

async function request(input: { auth?: boolean; optIn?: unknown; peer?: string; query?: Record<string, string> } = {}) {
  const headers = new Map<string, string>();
  let body = '';
  const req = { headers: { ...(input.auth === false ? {} : { authorization: 'synthetic-fixture-auth' }),
    'x-clementine-projection-timing': input.optIn }, socket: { remoteAddress: input.peer ?? '127.0.0.1' },
    query: input.query ?? { q: secretFixture, limit: '10' }, method: 'GET', fresh: false } as unknown as express.Request;
  const res = Object.create(express.response) as express.Response;
  res.app = app; res.req = req; res.statusCode = 200;
  res.setHeader = ((name: string, value: string) => { headers.set(name.toLowerCase(), String(value)); return res; }) as never;
  res.getHeader = ((name: string) => headers.get(name.toLowerCase())) as never;
  res.removeHeader = ((name: string) => { headers.delete(name.toLowerCase()); }) as never;
  res.end = ((value: string | Buffer) => { body = value.toString(); return res; }) as never;
  await handler(req, res);
  return { headers, body, status: res.statusCode };
}

test('actual route defaults are byte-identical; only authenticated local opt-in emits safe metrics', async () => {
  const normal = await request();
  const measured = await request({ optIn: '1' });
  assert.equal(normal.status, 200); assert.equal(measured.status, 200);
  assert.equal(measured.body, normal.body);
  assert.equal(normal.headers.has('server-timing'), false);
  assert.match(measured.headers.get('server-timing')!, /catalog_callback;dur=[\d.]+/);
  assert.match(measured.headers.get('server-timing')!, /catalog_serialize;dur=[\d.]+/);
  assert.doesNotMatch(measured.headers.get('server-timing')! + measured.headers.get('x-clementine-projection-counts')!,
    /fixture|query|metrics-owner|metrics-chat|Fixture answer/);
  const unauthorized = await request({ auth: false, optIn: '1' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.has('server-timing'), false);
  const remote = await request({ peer: '192.0.2.10', optIn: '1' });
  assert.equal(remote.body, normal.body);
  assert.equal(remote.headers.has('server-timing'), false);
  assert.equal((await request({ optIn: ['1'] })).headers.has('server-timing'), false);
});

test('route operation failure preserves error/status and records failure instead of false completion', async () => {
  const original = SessionStore.prototype.listAll;
  const error = new Error('controlled original catalog failure');
  SessionStore.prototype.listAll = () => { throw error; };
  try {
    const normal = await request();
    const measured = await request({ optIn: '1' });
    assert.equal(measured.status, 500);
    assert.equal(measured.body, normal.body);
    assert.deepEqual(JSON.parse(measured.body), { error: error.message });
    assert.match(measured.headers.get('x-clementine-projection-counts')!, /catalog_desktop_failures=1/);
    assert.match(measured.headers.get('x-clementine-projection-counts')!, /catalog_build_failures=1/);
    assert.match(measured.headers.get('x-clementine-projection-counts')!, /catalog_callback_failures=1/);
  } finally { SessionStore.prototype.listAll = original; }
});
