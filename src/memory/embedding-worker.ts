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
import { Worker } from 'node:worker_threads';
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
 * Start (once) the embedding worker. Returns null when a worker cannot be used,
 * which is a signal to fall back — never an error.
 */
export async function startEmbeddingWorker(): Promise<EmbeddingWorkerHandle | null> {
  if (handle !== undefined) return handle;
  if (startInFlight) return startInFlight;
  if (workerDisabled()) { handle = null; return null; }

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
        const timer = setTimeout(() => resolve(null), WORKER_BOOT_TIMEOUT_MS);
        timer.unref?.();
        worker.on('message', (msg: EmbeddingWorkerResponse) => {
          if (msg.kind === 'ready') { clearTimeout(timer); resolve(msg.runtime); }
          else if (msg.kind === 'unavailable') {
            clearTimeout(timer);
            logger.warn({ reason: msg.reason }, 'embedding worker reported the model unavailable');
            resolve(null);
          }
        });
      });

      if (runtime === null || dead) {
        void worker.terminate();
        handle = null;
        return null;
      }

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
