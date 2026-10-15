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

export type EmbeddingWorkPriority = 'foreground' | 'background';
export interface EmbeddingWorkerRequest {
  id: number;
  texts: string[];
  priority?: EmbeddingWorkPriority;
  deadlineAtMs?: number;
}
export type EmbeddingWorkerMessage = EmbeddingWorkerRequest
  | { kind: 'update'; id: number; priority?: EmbeddingWorkPriority; deadlineAtMs?: number }
  | { kind: 'cancel'; id: number };
export type EmbeddingWorkSkipReason = 'expired' | 'cancelled' | 'queue_full';
export const EMBEDDING_QUEUE_MAX_REQUESTS = 64;
export const EMBEDDING_QUEUE_MAX_TEXTS = 4096;
export const EMBEDDING_QUEUE_MAX_CHARS = 4_000_000;
export type EmbeddingWorkerResponse =
  | { kind: 'ready'; runtime: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'result'; id: number; vectors: Float32Array[] }
  | { kind: 'error'; id: number; error: string }
  | { kind: 'skipped'; id: number; reason: EmbeddingWorkSkipReason };

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

interface QueuedWork {
  id: number;
  texts: string[];
  priority: EmbeddingWorkPriority;
  /** Converted once from the caller's wall-clock deadline to this clock. */
  deadline: number;
  vectors: Float32Array[];
  index: number;
  chars: number;
}
const queued = new Map<number, QueuedWork>();
let queuedTexts = 0;
let queuedChars = 0;
let running = false;
let scheduled = false;

function monotonicDeadline(deadlineAtMs: number | undefined): number {
  return deadlineAtMs === undefined ? Infinity : performance.now() + Math.max(0, deadlineAtMs - Date.now());
}

function retire(work: QueuedWork): boolean {
  if (queued.get(work.id) !== work) return false;
  queued.delete(work.id);
  queuedTexts -= work.texts.length;
  queuedChars -= work.chars;
  return true;
}

function skipped(work: QueuedWork, reason: EmbeddingWorkSkipReason): void {
  if (retire(work)) port!.postMessage({ kind: 'skipped', id: work.id, reason } satisfies EmbeddingWorkerResponse);
}

function schedule(): void {
  if (running || scheduled || queued.size === 0) return;
  scheduled = true;
  // Yield between items: queued control messages and new foreground recall
  // can run before another background item. Native inference cannot be preempted.
  setImmediate(() => { scheduled = false; void runOne(); });
}

async function runOne(): Promise<void> {
  if (running || !extractor) return;
  const work = [...queued.values()].find(item => item.priority === 'foreground') ?? queued.values().next().value;
  if (!work) return;
  if (performance.now() >= work.deadline) { skipped(work, 'expired'); schedule(); return; }
  running = true;
  try {
    const res = await extractor([work.texts[work.index]!], { pooling: 'mean', normalize: true });
    if (queued.get(work.id) !== work) return; // Cancelled while an item was already running.
    work.vectors.push(Float32Array.from(res.data as ArrayLike<number>));
    work.index += 1;
    if (work.index === work.texts.length && retire(work)) {
      port!.postMessage({ kind: 'result', id: work.id, vectors: work.vectors } satisfies EmbeddingWorkerResponse);
    }
  } catch (err) {
    if (retire(work)) port!.postMessage({
      kind: 'error', id: work.id, error: err instanceof Error ? err.message : String(err),
    } satisfies EmbeddingWorkerResponse);
  } finally { running = false; schedule(); }
}

port.on('message', (message: EmbeddingWorkerMessage) => {
  if (!message || !Number.isSafeInteger(message.id) || message.id <= 0) return;
  if ('kind' in message) {
    const work = queued.get(message.id);
    if (!work) return;
    if (message.kind === 'cancel') { skipped(work, 'cancelled'); schedule(); return; }
    if (message.kind !== 'update') return;
    if (message.priority === 'foreground') work.priority = 'foreground';
    if (Object.prototype.hasOwnProperty.call(message, 'deadlineAtMs')) {
      if (message.deadlineAtMs !== undefined && !Number.isFinite(message.deadlineAtMs)) return;
      // Shared work may gain a later/unbounded subscriber; an earlier caller
      // cannot shorten its lifetime or demote another caller's foreground work.
      work.deadline = Math.max(work.deadline, monotonicDeadline(message.deadlineAtMs));
    }
    schedule(); return;
  }
  if (queued.has(message.id)) return;
  if (!extractor) {
    port.postMessage({ kind: 'error', id: message.id, error: 'extractor not ready' } satisfies EmbeddingWorkerResponse); return;
  }
  if (Array.isArray(message.texts) && message.texts.length > EMBEDDING_QUEUE_MAX_TEXTS) {
    port.postMessage({ kind: 'skipped', id: message.id, reason: 'queue_full' } satisfies EmbeddingWorkerResponse); return;
  }
  if (!Array.isArray(message.texts) || message.texts.some(text => typeof text !== 'string')
    || (message.priority !== undefined && message.priority !== 'foreground' && message.priority !== 'background')
    || (message.deadlineAtMs !== undefined && !Number.isFinite(message.deadlineAtMs))) {
    port.postMessage({ kind: 'error', id: message.id, error: 'invalid embedding request' } satisfies EmbeddingWorkerResponse); return;
  }
  const chars = message.texts.reduce((count, text) => count + text.length, 0);
  if (queued.size >= EMBEDDING_QUEUE_MAX_REQUESTS || queuedTexts + message.texts.length > EMBEDDING_QUEUE_MAX_TEXTS
    || queuedChars + chars > EMBEDDING_QUEUE_MAX_CHARS) {
    port.postMessage({ kind: 'skipped', id: message.id, reason: 'queue_full' } satisfies EmbeddingWorkerResponse); return;
  }
  if (message.texts.length === 0) {
    port.postMessage({ kind: 'result', id: message.id, vectors: [] } satisfies EmbeddingWorkerResponse); return;
  }
  const work: QueuedWork = { id: message.id, texts: message.texts, chars,
    priority: message.priority ?? 'foreground', deadline: monotonicDeadline(message.deadlineAtMs), vectors: [], index: 0 };
  queued.set(work.id, work); queuedTexts += work.texts.length; queuedChars += chars;
  schedule();
});

void boot();
