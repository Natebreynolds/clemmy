/**
 * Embedding inference, off the daemon's event loop.
 *
 * ONNX feature extraction is synchronous native work. Awaiting it does not
 * yield: on the main thread it holds the loop for the whole inference. On
 * 2026-09-10, during a Zoom call, that starved the daemon badly enough that its
 * HTTP listener AND its supervisor IPC heartbeat both went silent — and because
 * the heartbeat is a setInterval on that same loop, the supervisor's
 * "busy-but-alive" deferral could not fire. It SIGKILLed a daemon that was
 * merely CPU-starved, restarted into ~16s+ of boot reconciliation over a 1.1GB
 * harness.db, and the user saw "Clem just doesn't load".
 *
 * The fix is structural: inference belongs on another thread, so a saturated
 * CPU costs latency instead of liveness.
 *
 * Protocol is deliberately tiny — one request id in, one vector batch out.
 */
import { parentPort } from 'node:worker_threads';
import { createLocalExtractor, type LocalExtractor } from './embeddings.js';

export interface EmbeddingWorkerRequest { id: number; texts: string[] }
export type EmbeddingWorkerResponse =
  | { kind: 'ready'; runtime: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'result'; id: number; vectors: Float32Array[] }
  | { kind: 'error'; id: number; error: string };

const port = parentPort;
if (!port) throw new Error('embedding.worker must be started as a worker thread');

let extractor: LocalExtractor | null = null;

async function boot(): Promise<void> {
  try {
    const built = await createLocalExtractor();
    if (!built) {
      port!.postMessage({ kind: 'unavailable', reason: 'transformers pipeline unavailable' } satisfies EmbeddingWorkerResponse);
      return;
    }
    extractor = built.extractor;
    port!.postMessage({ kind: 'ready', runtime: built.runtime } satisfies EmbeddingWorkerResponse);
  } catch (err) {
    port!.postMessage({
      kind: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    } satisfies EmbeddingWorkerResponse);
  }
}

port.on('message', (message: EmbeddingWorkerRequest) => {
  void (async () => {
    if (!extractor) {
      port.postMessage({ kind: 'error', id: message.id, error: 'extractor not ready' } satisfies EmbeddingWorkerResponse);
      return;
    }
    try {
      const vectors: Float32Array[] = [];
      for (const text of message.texts) {
        const res = await extractor([text], { pooling: 'mean', normalize: true });
        vectors.push(Float32Array.from(res.data as ArrayLike<number>));
      }
      port.postMessage({ kind: 'result', id: message.id, vectors } satisfies EmbeddingWorkerResponse);
    } catch (err) {
      port.postMessage({
        kind: 'error',
        id: message.id,
        error: err instanceof Error ? err.message : String(err),
      } satisfies EmbeddingWorkerResponse);
    }
  })();
});

void boot();
