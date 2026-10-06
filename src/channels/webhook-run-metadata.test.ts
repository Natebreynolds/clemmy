import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response, NextFunction } from 'express';

assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'run through the disposable test runner');
process.env.WEBHOOK_SECRET = 'fixture-webhook-run-metadata-secret';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const { buildWebhookApp, __test__ } = await import('./webhook.js');
const log = await import('../runtime/harness/eventlog.js');
const { WEBHOOK_SECRET } = await import('../config.js');
const privateKey = log.HELD_STOP_PUBLICATION_METADATA_KEY;
const app = await buildWebhookApp({
  handleMessage: () => { throw new Error('a run projection must not execute the assistant'); },
} as never);
type RouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;
const routes = (app as unknown as {
  _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RouteHandler }> } }> };
})._router.stack;
const route = routes.find(layer => layer.route?.path === '/api/runs/:id' && layer.route.methods.get)?.route;
assert.ok(route, 'exercise the registered production route, without binding an HTTP listener');
test.after(() => log.closeEventLog());

async function runDetail(id: string, environment: boolean, authorized = true) {
  let status = 200;
  let serialized: string | undefined;
  const req = {
    params: { id },
    query: environment ? { view: 'environment' } : {},
    headers: authorized
      ? { cookie: `clementine_dashboard_session=${__test__.deriveDashboardSessionToken(WEBHOOK_SECRET)}` }
      : {},
  } as unknown as Request;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { serialized = JSON.stringify(value); return this; },
  } as unknown as Response;
  for (const layer of route!.stack) {
    let advanced = false;
    await layer.handle(req, res, ((error?: unknown) => {
      if (error) throw error;
      advanced = true;
    }) as NextFunction);
    if (!advanced) break;
  }
  assert.notEqual(serialized, undefined, 'the real route must send a serialized response');
  return { status, body: JSON.parse(serialized!) };
}

test('run detail hides only private publication debt in both views without changing durable state or counts', async () => {
  const session = log.createSession({ id: 'fixture-private-debt-projection', kind: 'chat', userId: 'fixture-owner',
    metadata: { source: 'desktop', channelId: 'fixture-channel', projectId: 'fixture-project',
      custom: { nested: ['retained', 7] }, __unrelated_private_looking_key: 'retained' } });
  log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'A controlled activity projection fixture.' } });
  const baselines = await Promise.all([runDetail(session.id, false), runDetail(session.id, true)]);
  assert.deepEqual(baselines.map(row => row.status), [200, 200]);
  assert.deepEqual(baselines[0].body.run.metadata, session.metadata);
  assert.equal(baselines[0].body.run.runEnvironmentMeta.auditEventsTotal, 1);
  const db = log.openEventLog();
  const eventsBefore = log.listEvents(session.id);

  // The projection has no publication authority. Seed only its stored input,
  // including malformed debt: even invalid private data must stay private.
  for (const debt of [{ '17': { state: 'pending', attemptsUsed: 3, origin: { attemptId: 'fixture-attempt' } } },
    'malformed-private-debt', null]) {
    const metadata = { ...session.metadata, [privateKey]: debt };
    const raw = JSON.stringify(metadata);
    db.prepare('UPDATE sessions SET metadata_json=? WHERE id=?').run(raw, session.id);
    for (const [index, environment] of [false, true].entries()) {
      const response = await runDetail(session.id, environment);
      assert.equal(response.status, 200);
      assert.equal(Object.hasOwn(response.body.run.metadata, privateKey), false,
        `the ${environment ? 'environment' : 'normal'} response must not serialize private debt`);
      assert.deepEqual(response, baselines[index], 'all existing public metadata, events, counts, and controls stay unchanged');
      assert.equal((db.prepare('SELECT metadata_json FROM sessions WHERE id=?').get(session.id) as { metadata_json: string }).metadata_json,
        raw, 'projection must not erase or rewrite the durable debt');
    }
  }
  assert.deepEqual(log.listEvents(session.id), eventsBefore, 'reading either view must not publish or acknowledge debt');
});

test('the registered run-detail route still rejects unauthenticated requests', async () => {
  const response = await runDetail('fixture-private-debt-projection', false, false);
  assert.deepEqual(response, { status: 401, body: { error: 'Unauthorized' } });
});
