/**
 * A route handler that rejects is that request's error, never the daemon's.
 *
 * Express 4 calls each handler inside a try, so a synchronous throw becomes
 * the request's error, but it drops the promise an async handler returns: a
 * rejection is unhandled, and the daemon's crash guard exits on unhandled
 * rejections. One refused credential read (Windows refuses reads whose
 * privacy cannot be verified) inside any async route therefore ended the
 * whole daemon. This gives a returned promise the same treatment as a throw.
 * It patches the single place Express invokes handlers, so every route is
 * covered and the route stack keeps its exact handler functions.
 */
import { createRequire } from 'node:module';

type Next = (err?: unknown) => void;
interface LayerPrototype {
  handle_request: (this: { handle: (...args: unknown[]) => unknown }, req: unknown, res: unknown, next: Next) => void;
}

let installed = false;

export function containAsyncRouteRejections(): void {
  if (installed) return;
  installed = true;
  const require = createRequire(import.meta.url);
  const Layer = require('express/lib/router/layer.js') as { prototype: LayerPrototype };
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    // Error-handling middleware is invoked elsewhere; Express skips it here.
    if (fn.length > 3) { next(); return; }
    let result: unknown;
    try {
      result = fn(req, res, next);
    } catch (err) {
      next(err);
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      (result as PromiseLike<unknown>).then(undefined, (err: unknown) => {
        next(err ?? new Error('A route handler rejected without a reason.'));
      });
    }
  };
}
