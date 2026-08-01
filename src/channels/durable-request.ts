import { createHash } from 'node:crypto';
import {
  claimHarnessChatRequest,
  getHarnessChatRequestReceipt,
  type HarnessChatRequestReceipt,
} from '../runtime/harness/eventlog.js';

/**
 * Provider/client retries need an identity that is stable across daemon
 * restarts.  Never put the opaque provider key itself in a run id or log: the
 * domain-separated digest is sufficient and avoids leaking bearer-like keys.
 */
export function durableRequestIdentity(surface: string, key: string): {
  requestId: string;
  runId: string;
  digest: string;
} {
  const normalizedSurface = surface.trim().toLowerCase();
  const normalizedKey = key.trim();
  if (!normalizedSurface) throw new Error('surface is required');
  if (!normalizedKey) throw new Error('idempotency key is required');
  if (normalizedKey.length > 512) throw new Error('idempotency key is too long');
  const digest = createHash('sha256')
    .update(`clementine-durable-request:v1\0${normalizedSurface}\0${normalizedKey}`)
    .digest('hex');
  return {
    requestId: `${normalizedSurface}:${digest}`,
    runId: `run-${normalizedSurface}-${digest.slice(0, 40)}`,
    digest,
  };
}

/** Canonical hash for the complete authority-bearing request payload. */
export function durablePayloadHash(payload: Record<string, unknown>): string {
  const ordered = Object.keys(payload)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = payload[key] ?? null;
      return result;
    }, {});
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/**
 * Bind one transport key to one payload/session/run.  The receipt is durable;
 * an in-memory single-flight map may optimize concurrent retries, but is never
 * the source of idempotency authority.
 */
export function claimDurableRequest(input: {
  requestId: string;
  sessionId: string;
  runId: string;
  inputHash: string;
  sinceSeq: number;
}): { receipt: HarnessChatRequestReceipt; inserted: boolean } {
  const prior = getHarnessChatRequestReceipt(input.requestId);
  // Avoid manufacturing a caller-selected session on a replay. The durable
  // receipt decides which session owns the logical turn.
  const sessionId = prior?.sessionId ?? input.sessionId;
  return claimHarnessChatRequest({ ...input, sessionId });
}
