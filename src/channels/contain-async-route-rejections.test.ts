import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { containAsyncRouteRejections } from './contain-async-route-rejections.js';

async function serve(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
  const server = await new Promise<Server>(resolve => { const listener = createServer(app); listener.listen(0, '127.0.0.1', () => resolve(listener)); });
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('a rejecting async route is that request\'s 500; nothing reaches the process as unhandled', async () => {
  containAsyncRouteRejections();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const app = express();
    const guard = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
    app.get('/refused', guard, async () => { throw new Error('Credential storage privacy or integrity could not be verified'); });
    app.get('/silent', async () => { await Promise.reject(undefined); });
    app.get('/ok', async (_req, res) => { res.json({ ok: true }); });
    // A promise-like result that rejects, and one whose then itself throws.
    app.get('/thenable', (() => ({ then: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error('thenable refusal')) })) as unknown as express.RequestHandler);
    app.get('/broken-then', (() => ({ then: () => { throw new Error('then threw'); } })) as unknown as express.RequestHandler);
    const router = express.Router();
    router.post('/mounted', async () => { throw new Error('mounted refusal'); });
    app.use('/m', router);
    const errors: string[] = [];
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      errors.push(err.message);
      res.status(500).json({ error: err.message });
    });
    await serve(app, async (base) => {
      assert.equal((await fetch(`${base}/refused`)).status, 500);
      assert.equal((await fetch(`${base}/silent`)).status, 500);
      assert.equal((await fetch(`${base}/m/mounted`, { method: 'POST' })).status, 500);
      assert.equal((await fetch(`${base}/thenable`)).status, 500);
      assert.equal((await fetch(`${base}/broken-then`)).status, 500);
      assert.deepEqual(await (await fetch(`${base}/ok`)).json(), { ok: true }, 'still serving');
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(errors, [
      'Credential storage privacy or integrity could not be verified',
      'A route handler rejected without a reason.',
      'mounted refusal',
      'thenable refusal',
      'then threw',
    ]);
    // Settings reads and the route stack keep their own functions.
    app.set('probe', 7);
    assert.equal(app.get('probe'), 7);
    const routeStack = (app._router.stack as Array<{ route?: { stack: Array<{ handle: unknown }> } }>)
      .find(layer => layer.route)?.route?.stack.map(layer => layer.handle);
    assert.equal(routeStack?.[0], guard, 'handler identity is unchanged');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
