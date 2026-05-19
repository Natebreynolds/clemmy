/**
 * Rate-limited alert helper — collapses N noisy events into ONE
 * actionable user notification per window per key.
 *
 * Why this exists: the audit on 2026-05-18 found ~600 supervisor.log
 * lines per 10 minutes from DataForSEO's "Token expired" loop. Same
 * pattern for Codex 5xx clusters, OAuth-refresh flaps, MCP server
 * disconnects. Each individual line is uninteresting; the AGGREGATE
 * (N occurrences in a window) is the actionable signal — "the server
 * is genuinely down, here is what to do about it."
 *
 * Usage:
 *   await rateLimitedAlert('mcp-noise-dataforseo-token-expired', {
 *     title: 'DataForSEO is failing internally',
 *     body: '47 "Token expired" errors in the last 10 minutes. The MCP server probably needs a fresh API key.',
 *     kind: 'system',
 *   });
 *
 * The first hit for a key fires immediately + records the bucket;
 * subsequent hits within `windowMs` are silently suppressed but
 * counted. After the window expires, the next hit fires again and
 * the count resets — the user sees "another 47" not the same 47.
 *
 * Persistence: the bucket map is stored at `state/alert-buckets.json`
 * so a daemon restart doesn't immediately refire every key (which
 * would defeat the purpose for a flapping condition that survives the
 * restart). In-process Map is the fast path; the file is read once at
 * module load and written through atomicJsonMutate on every fire.
 */

import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';
import { addNotification, type NotificationRecord } from './notifications.js';
import { randomUUID } from 'node:crypto';

const BUCKETS_FILE = path.join(BASE_DIR, 'state', 'alert-buckets.json');
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

interface BucketEntry {
  lastFiredAt: number;
  /** How many hits arrived during the current window AFTER the first
   *  one fired. Persists so the next fire-after-window can include
   *  "Another N suppressed since the last alert" if we want it. */
  suppressedCount: number;
}

interface BucketStore {
  version: 'v1';
  buckets: Record<string, BucketEntry>;
}

const inMemoryBuckets = new Map<string, BucketEntry>();
let bucketsHydrated = false;
let hydratePromise: Promise<void> | null = null;

async function hydrateBuckets(): Promise<void> {
  if (bucketsHydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      await atomicJsonMutate<BucketStore>(
        BUCKETS_FILE,
        (current) => {
          for (const [key, entry] of Object.entries(current.buckets ?? {})) {
            inMemoryBuckets.set(key, entry);
          }
          // Read-only on hydrate path — don't rewrite the file.
          return undefined;
        },
        { version: 'v1', buckets: {} },
      );
    } catch {
      // Hydrate is best-effort. If the file is missing/corrupted the
      // next call to rateLimitedAlert will repopulate from scratch.
    }
    bucketsHydrated = true;
  })();
  return hydratePromise;
}

export interface RateLimitedAlertInput {
  /** Short headline for the notification. */
  title: string;
  /** Multi-line body. */
  body: string;
  /** Defaults to 'system'. */
  kind?: NotificationRecord['kind'];
  /** Defaults to DEFAULT_WINDOW_MS (10 min). */
  windowMs?: number;
  /** Optional metadata attached to the notification record. */
  metadata?: Record<string, unknown>;
}

export interface RateLimitedAlertResult {
  /** True when this hit actually fired a user notification. False
   *  when it was suppressed because the bucket is hot. */
  fired: boolean;
  /** How many suppressed hits have accumulated since the last fire.
   *  Useful for tests + for callers that want to include the count in
   *  the body ("Another 23 since I last alerted you"). */
  suppressedSinceLastFire: number;
}

/**
 * Fire (or suppress) an alert keyed by `key`. Returns whether it fired
 * so callers can branch (e.g. operators may want to log the suppressed
 * count even when not notifying).
 */
export async function rateLimitedAlert(
  key: string,
  input: RateLimitedAlertInput,
): Promise<RateLimitedAlertResult> {
  await hydrateBuckets();
  const now = Date.now();
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const current = inMemoryBuckets.get(key);

  if (current && now - current.lastFiredAt < windowMs) {
    // Hot bucket — suppress, just bump the counter.
    current.suppressedCount += 1;
    inMemoryBuckets.set(key, current);
    await persistBuckets();
    return { fired: false, suppressedSinceLastFire: current.suppressedCount };
  }

  // Cold bucket OR window expired — fire.
  inMemoryBuckets.set(key, { lastFiredAt: now, suppressedCount: 0 });
  await persistBuckets();

  addNotification({
    id: `alert-${key}-${now}-${randomUUID().slice(0, 8)}`,
    kind: input.kind ?? 'system',
    title: input.title,
    body: input.body,
    createdAt: new Date(now).toISOString(),
    read: false,
    metadata: { alertKey: key, ...(input.metadata ?? {}) },
  });

  return { fired: true, suppressedSinceLastFire: 0 };
}

async function persistBuckets(): Promise<void> {
  const snapshot: BucketStore = {
    version: 'v1',
    buckets: Object.fromEntries(inMemoryBuckets.entries()),
  };
  try {
    await atomicJsonMutate<BucketStore>(BUCKETS_FILE, () => snapshot, snapshot);
  } catch {
    // Persistence is best-effort — losing it just means a daemon
    // restart refires keys that would otherwise still be suppressed.
    // The notification itself already landed via addNotification.
  }
}

// ---- test helpers (exported for direct use in unit tests only) ----

/** Clear the in-memory + on-disk bucket state. Test-only. */
export async function __resetAlertBuckets(): Promise<void> {
  inMemoryBuckets.clear();
  bucketsHydrated = false;
  hydratePromise = null;
  try {
    await atomicJsonMutate<BucketStore>(
      BUCKETS_FILE,
      () => ({ version: 'v1', buckets: {} }),
      { version: 'v1', buckets: {} },
    );
  } catch {
    /* nothing to clear */
  }
}
