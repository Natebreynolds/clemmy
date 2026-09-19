/**
 * Host side of the embedding worker — see embedding.worker.ts for why this
 * exists at all (ONNX inference on the main thread took the daemon's liveness
 * down with it during a Zoom call).
 *
 * Contract this module owes its caller:
 *   - Never throw. A worker that cannot start returns null and the caller falls
 *     back to in-process inference; degraded recall beats no recall.
 *   - Never hang a request forever. A wedged worker is replaced, not waited on.
 *   - Never hold the process open (the worker is unref'd).
 */
import { isMainThread, Worker } from 'node:worker_threads';
import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import type { EmbeddingWorkerRequest, EmbeddingWorkerResponse } from './embedding.worker.js';

const logger = pino({ name: 'clementine-next.memory.embedding-worker' });

/** A cold worker must load the ONNX model before it can answer, and on a
 *  saturated machine (the case this whole module exists for) that is slow.
 *  Generous on boot, tight per request once warm. */
const WORKER_BOOT_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface EmbeddingWorkerHandle {
  runtime: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let handle: EmbeddingWorkerHandle | null | undefined;
let startInFlight: Promise<EmbeddingWorkerHandle | null> | null = null;

/** Resolve the worker entry next to this module, in whichever form is running:
 *  `.ts` under tsx from source, `.js` from the built bundle. Getting this wrong
 *  is the most likely reason the worker silently never starts, so it is derived
 *  from THIS module's own URL rather than from a build flag that can disagree
 *  with reality. */
function workerEntry(): { url: URL; execArgv?: string[] } {
  const here = import.meta.url;
  return here.endsWith('.ts')
    ? { url: new URL('./embedding.worker.ts', here), execArgv: ['--import', 'tsx'] }
    : { url: new URL('./embedding.worker.js', here) };
}

function workerDisabled(): boolean {
  return (getRuntimeEnv('CLEMMY_EMBED_WORKER', 'on') || 'on').trim().toLowerCase() === 'off';
}

/**
 * A worker thread must never start an embedding worker of its own.
 *
 * This module exists for exactly one reason: keep synchronous ONNX inference
 * off the MAIN thread, whose event loop carries the HTTP listener and the
 * supervisor heartbeat. Inside a worker there is no such loop to protect, so
 * spawning another worker buys nothing -- and it does not merely waste a
 * thread. embedding.worker.ts imports ./embeddings.js, whose module top level
 * eagerly warms the local provider on a no-key install; that warmup calls
 * startEmbeddingWorker(), which would spawn the next generation, which imports
 * the module again. The recursion is unbounded and every generation keeps a
 * loaded copy of the model (~220 MB plus an ONNX thread pool), so a process
 * that merely touched embeddings climbed until the machine gave out: clemmy's
 * own `bench:gates` and eval-suite CI jobs printed their PASS verdict and were
 * then killed by the runner, ~70 generations in.
 *
 * Returning null here is the existing "no worker available" signal, and the
 * caller already handles it by doing inference in process -- which is the
 * correct behaviour off the main thread anyway.
 */
function workerWouldRecurse(): boolean {
  return !isMainThread;
}

/**
 * Start (once) the embedding worker. Returns null when a worker cannot be used,
 * which is a signal to fall back — never an error.
 */
export async function startEmbeddingWorker(): Promise<EmbeddingWorkerHandle | null> {
  if (handle !== undefined) return handle;
  if (startInFlight) return startInFlight;
  if (workerDisabled() || workerWouldRecurse()) { handle = null; return null; }

  startInFlight = (async () => {
    try {
      const { url, execArgv } = workerEntry();
      const worker = new Worker(url, execArgv ? { execArgv } : undefined);
      // A pending reconnect/inference must never keep the daemon alive.
      worker.unref();

      const pending = new Map<number, Pending>();
      let nextId = 1;
      let dead: string | null = null;

      const failAll = (reason: string) => {
        dead = reason;
        for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
        pending.clear();
      };

      worker.on('message', (msg: EmbeddingWorkerResponse) => {
        if (msg.kind === 'result' || msg.kind === 'error') {
          const p = pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(msg.id);
          if (msg.kind === 'result') p.resolve(msg.vectors);
          else p.reject(new Error(msg.error));
        }
      });
      worker.on('error', (err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'embedding worker errored — falling back to in-process inference');
        failAll('embedding worker errored');
        handle = null;
      });
      worker.on('exit', (code) => {
        if (code !== 0) logger.warn({ code }, 'embedding worker exited — falling back to in-process inference');
        failAll(`embedding worker exited (${code})`);
        handle = null;
      });

      const runtime = await new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), WORKER_BOOT_TIMEOUT_MS);
        timer.unref?.();
        // A worker that cannot spawn at all (missing entry in a packaged
        // layout, spawn refused) emits error/exit immediately. Without these
        // two lines the boot promise would sit on the full timeout before
        // falling back — turning a fast, correct degradation into a multi-
        // minute stall on the first recall that needs an embedding.
        worker.once('error', () => finish(null));
        worker.once('exit', () => finish(null));
        worker.on('message', (msg: EmbeddingWorkerResponse) => {
          if (msg.kind === 'ready') finish(msg.runtime);
          else if (msg.kind === 'unavailable') {
            logger.warn({ reason: msg.reason }, 'embedding worker reported the model unavailable');
            finish(null);
          }
        });
      });

      if (runtime === null || dead) {
        void worker.terminate();
        handle = null;
        return null;
      }

      // unref() AGAIN, and this time it sticks.
      //
      // The call at spawn is undone by our own listeners: attaching a
      // 'message' handler starts the underlying MessagePort, and a started
      // port is ref'd, so the process is held open by the very channel we
      // unref'd before we had anything to listen with. The active handle list
      // after a finished run read ["PipeWrap","MessagePort"] -- the port, not
      // the Worker. Re-unref once the listeners this module needs are all
      // attached, which is the only point at which the module's stated
      // contract ("never hold the process open") is actually true.
      //
      // Consistent with the request timers above, which are unref'd for the
      // same reason: nothing about an embedding is worth keeping a process
      // alive for.
      worker.unref();

      handle = {
        runtime,
        embed(texts) {
          if (dead) return Promise.reject(new Error(dead));
          if (texts.length === 0) return Promise.resolve([]);
          const id = nextId++;
          return new Promise<Float32Array[]>((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error('embedding worker timed out'));
            }, REQUEST_TIMEOUT_MS);
            timer.unref?.();
            pending.set(id, { resolve, reject, timer });
            worker.postMessage({ id, texts } satisfies EmbeddingWorkerRequest);
          });
        },
      };
      return handle;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'embedding worker could not start — falling back to in-process inference');
      handle = null;
      return null;
    } finally {
      startInFlight = null;
    }
  })();
  return startInFlight;
}

/** Test seam: forget any started/failed worker so the next call re-probes. */
export function _resetEmbeddingWorkerForTest(): void {
  handle = undefined;
  startInFlight = null;
}
