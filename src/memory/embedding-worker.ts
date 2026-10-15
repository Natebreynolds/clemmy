/**
 * Host side of the embedding worker — see embedding.worker.ts for why this
 * exists at all (ONNX inference on the main thread took the daemon's liveness
 * down with it during a Zoom call).
 *
 * Contract this module owes its caller:
 *   - Never throw. A worker that cannot start returns null and the caller falls
 *     back to in-process inference; degraded recall beats no recall.
 *   - Never hang a request forever. A wedged worker is replaced, not waited on.
 *   - Never hold the process open while idle. The worker keeps it alive only
 *     while a caller is waiting on it (its boot, or a request in flight), each
 *     bounded by a timeout — see syncLiveness below.
 */
import { Worker } from 'node:worker_threads';
import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import type { EmbeddingWorkerMessage, EmbeddingWorkerRequest, EmbeddingWorkerResponse, EmbeddingWorkPriority, EmbeddingWorkSkipReason } from './embedding.worker.js';

const logger = pino({ name: 'clementine-next.memory.embedding-worker' });

/** A cold worker must load the ONNX model before it can answer, and on a
 *  saturated machine (the case this whole module exists for) that is slow.
 *  Generous on boot, tight per request once warm. */
const WORKER_BOOT_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface EmbeddingWorkUpdate {
  priority?: EmbeddingWorkPriority;
  /** Absolute epoch milliseconds; an explicit undefined removes a deadline. */
  deadlineAtMs?: number;
}
export interface EmbeddingWorkControl {
  /** Promote priority or extend lifetime. Never tightens another subscriber's budget. */
  update(options: EmbeddingWorkUpdate): void;
  /** Retire this request; native inference already running cannot be preempted. */
  cancel(): void;
}
export interface EmbeddingWorkOptions extends EmbeddingWorkUpdate {
  /** Host-only callback, invoked once after pending admission is registered. */
  onQueued?: (control: EmbeddingWorkControl) => void;
}
export class EmbeddingWorkSkippedError extends Error {
  readonly code = 'EMBEDDING_WORK_SKIPPED';
  constructor(readonly reason: EmbeddingWorkSkipReason) {
    super(`embedding work skipped (${reason})`);
    this.name = 'EmbeddingWorkSkippedError';
  }
}
export interface EmbeddingWorkerHandle {
  runtime: string;
  embed(texts: string[], options?: EmbeddingWorkOptions): Promise<Float32Array[]>;
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  texts: number;
  chars: number;
}

let handle: EmbeddingWorkerHandle | null | undefined;
let startInFlight: Promise<EmbeddingWorkerHandle | null> | null = null;
let entryForTest: URL | null = null;

/** Resolve the worker entry next to this module, in whichever form is running:
 *  `.ts` under tsx from source, `.js` from the built bundle. Getting this wrong
 *  is the most likely reason the worker silently never starts, so it is derived
 *  from THIS module's own URL rather than from a build flag that can disagree
 *  with reality. */
function workerEntry(): { url: URL; execArgv?: string[] } {
  if (entryForTest) return { url: entryForTest, execArgv: [] };
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

      const pending = new Map<number, Pending>();
      let nextId = 1;
      let pendingTexts = 0;
      let pendingChars = 0;
      let dead: string | null = null;
      let booting = true;

      // Liveness: the worker holds this process open only while a caller is
      // waiting on it (the model load, or a request in flight), never while it
      // sits idle, so a process whose work is done can exit.
      //
      // A single unref() cannot express that. Attaching the first 'message'
      // listener to a Worker refs its message port again (Node's
      // setupPortReferencing), silently undoing an unref() made at spawn. And
      // a worker unref'd for good lets a process with nothing else on its loop
      // exit under an embed() whose answer is still on its way, leaving the
      // caller's await unsettled. So the ref is re-derived from the
      // outstanding work each time that work changes.
      const syncLiveness = () => {
        if (booting || pending.size > 0) worker.ref();
        else worker.unref();
      };

      const takePending = (id: number): Pending | undefined => {
        const item = pending.get(id);
        if (!item) return undefined;
        pending.delete(id); clearTimeout(item.timer);
        pendingTexts -= item.texts; pendingChars -= item.chars;
        syncLiveness(); return item;
      };

      const failAll = (reason: string) => {
        dead = reason;
        for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
        pending.clear(); pendingTexts = 0; pendingChars = 0;
        syncLiveness();
      };

      worker.on('message', (msg: EmbeddingWorkerResponse) => {
        if (msg.kind === 'result' || msg.kind === 'error' || msg.kind === 'skipped') {
          const p = takePending(msg.id);
          if (!p) return;
          if (msg.kind === 'result') p.resolve(msg.vectors);
          else if (msg.kind === 'skipped') p.reject(new EmbeddingWorkSkippedError(msg.reason));
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
      booting = false;
      syncLiveness();

      if (runtime === null || dead) {
        void worker.terminate();
        handle = null;
        return null;
      }

      handle = {
        runtime,
        embed(texts, options = {}) {
          if (dead) return Promise.reject(new Error(dead));
          if (Array.isArray(texts) && texts.length > 4096) return Promise.reject(new EmbeddingWorkSkippedError('queue_full'));
          if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')
            || (options.priority !== undefined && options.priority !== 'foreground' && options.priority !== 'background')
            || (options.deadlineAtMs !== undefined && !Number.isFinite(options.deadlineAtMs))) {
            return Promise.reject(new Error('invalid embedding request'));
          }
          if (texts.length === 0) return Promise.resolve([]);
          const chars = texts.reduce((count, text) => count + text.length, 0);
          // Bound packets before structured-clone allocates a second copy in
          // the worker. The worker independently enforces its own queue bounds.
          if (pending.size >= 64 || pendingTexts + texts.length > 4096 || pendingChars + chars > 4_000_000) {
            return Promise.reject(new EmbeddingWorkSkippedError('queue_full'));
          }
          let deadline = options.deadlineAtMs === undefined ? Infinity
            : performance.now() + Math.max(0, options.deadlineAtMs - Date.now());
          if (performance.now() >= deadline) return Promise.reject(new EmbeddingWorkSkippedError('expired'));
          const id = nextId++;
          let posted = false;
          const message: EmbeddingWorkerRequest = { id, texts, priority: options.priority ?? 'foreground' };
          const wireDeadline = () => deadline === Infinity ? undefined : Date.now() + Math.max(0, deadline - performance.now());
          message.deadlineAtMs = wireDeadline();
          return new Promise<Float32Array[]>((resolve, reject) => {
            const sendCancel = () => {
              if (posted) try { worker.postMessage({ kind: 'cancel', id } satisfies EmbeddingWorkerMessage); } catch { /* retired worker */ }
            };
            const timer = setTimeout(() => {
              const item = takePending(id); if (!item) return;
              sendCancel(); item.reject(new Error('embedding worker timed out'));
            }, REQUEST_TIMEOUT_MS);
            timer.unref?.();
            pending.set(id, { resolve, reject, timer, texts: texts.length, chars });
            pendingTexts += texts.length; pendingChars += chars; syncLiveness();
            const control: EmbeddingWorkControl = {
              update(update) {
                if (!pending.has(id)) return;
                if (update.priority !== undefined && update.priority !== 'foreground' && update.priority !== 'background') return;
                if (Object.prototype.hasOwnProperty.call(update, 'deadlineAtMs')) {
                  if (update.deadlineAtMs !== undefined && !Number.isFinite(update.deadlineAtMs)) return;
                  const extended = update.deadlineAtMs === undefined ? Infinity
                    : performance.now() + Math.max(0, update.deadlineAtMs - Date.now());
                  deadline = Math.max(deadline, extended);
                }
                if (update.priority === 'foreground') message.priority = 'foreground';
                message.deadlineAtMs = wireDeadline();
                if (posted) try {
                  worker.postMessage({ kind: 'update', id, priority: message.priority, deadlineAtMs: message.deadlineAtMs } satisfies EmbeddingWorkerMessage);
                } catch { /* normal worker error/timeout settles the request */ }
              },
              cancel() {
                const item = takePending(id); if (!item) return;
                sendCancel(); item.reject(new EmbeddingWorkSkippedError('cancelled'));
              },
            };
            try { options.onQueued?.(control); }
            catch { takePending(id)?.reject(new Error('embedding queue observer failed')); return; }
            if (!pending.has(id)) return; // An immediate cancellation sends no work.
            message.deadlineAtMs = wireDeadline();
            try { worker.postMessage(message); posted = true; }
            catch { takePending(id)?.reject(new Error('embedding worker request could not be sent')); }
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

/** Test seam: start a stand-in worker script (plain ESM speaking the same
 *  protocol) instead of the ONNX one, so the host side can be exercised
 *  without loading a model. `null` restores the real entry. */
export function _setEmbeddingWorkerEntryForTest(url: URL | null): void {
  entryForTest = url;
  handle = undefined;
  startInFlight = null;
}
