import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { withFileLockSync } from '../atomic-json.js';
import { resolveModelCapability } from './model-wire-registry.js';

/**
 * Evidence-based context windows — the registry is a SEED, never the truth.
 *
 * Static model→window rows rot: providers ship new models, raise limits, and
 * serve the same model id with different windows on different backends. The
 * durable source of truth is what the serving provider itself says and does
 * (owner concern, 2026-08-05 — same principle as tool discovery: no curated
 * static lists where the platform publishes the fact). Three evidence kinds,
 * strongest-first:
 *
 *   catalog   — the provider's own /v1/models `context_length` for the exact id
 *               (Together and Moonshot both publish it). Recorded whenever a
 *               provider catalog is listed.
 *   rejected  — the provider returned a context-overflow 4xx. Ratchets the
 *               effective window DOWN below the failure point, so an
 *               over-stated row self-corrects after ONE failure instead of
 *               overflowing every turn.
 *   accepted  — a real request succeeded with usage.input_tokens above what we
 *               believed. Raises the floor to proven capacity.
 *
 * Fail-safe direction: with no evidence, the registry row (conservative
 * fallbacks for unknown ids) applies — an unknown NEW model compacts early
 * (wasted headroom, never a hard failure) until its first catalog listing or
 * live acceptance teaches its real size. All functions are best-effort and
 * never throw — budgeting must not break a turn.
 */

interface WindowObservation {
  /** Provider-published context_length for this exact model id. */
  catalogWindow?: number;
  catalogSource?: string;
  /** Highest input_tokens a live request PROVED accepted. */
  provenAcceptedInput?: number;
  /** Effective ceiling learned from a context-overflow rejection. */
  rejectedCeiling?: number;
  /** Calls whose usage reported a prompt-cache READ for this model. A wire
   *  either caches or it does not, so this is evidence of a contract, not a
   *  rate to average. */
  cacheHitCalls?: number;
  /** Calls observed at all — the denominator, so a single fluke cannot flip a
   *  wire and a genuinely non-caching wire stays non-caching however long it
   *  runs. */
  cacheObservedCalls?: number;
  /** Smallest prompt seen WITH a cache read: the provider's practical floor. */
  smallestCachedPrompt?: number;
  updatedAt?: string;
}

type ObservationsFile = { version: 1; entries: Record<string, WindowObservation> };

const OBS_PATH = path.join(BASE_DIR, 'state', 'model-window-observations.json');
const MIN_WINDOW_FLOOR = 32_000;

let cache: { mtimeMs: number; data: ObservationsFile } | null = null;

function readObservations(): ObservationsFile {
  try {
    if (!existsSync(OBS_PATH)) return { version: 1, entries: {} };
    const mtimeMs = statSync(OBS_PATH).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.data;
    const parsed = JSON.parse(readFileSync(OBS_PATH, 'utf-8')) as ObservationsFile;
    const data = parsed && parsed.version === 1 && parsed.entries ? parsed : { version: 1 as const, entries: {} };
    cache = { mtimeMs, data };
    return data;
  } catch {
    return { version: 1, entries: {} };
  }
}

function mutate(modelId: string, patch: (prev: WindowObservation) => WindowObservation): void {
  try {
    // The lock file lives beside OBS_PATH — the directory must exist BEFORE
    // lock acquisition, not inside the locked section.
    mkdirSync(path.dirname(OBS_PATH), { recursive: true });
    withFileLockSync(OBS_PATH, () => {
      cache = null; // re-read inside the lock
      const base = readObservations();
      const next = patch(base.entries[modelId] ?? {});
      next.updatedAt = new Date().toISOString();
      const out: ObservationsFile = { ...base, entries: { ...base.entries, [modelId]: next } };
      mkdirSync(path.dirname(OBS_PATH), { recursive: true });
      const tmp = `${OBS_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
      renameSync(tmp, OBS_PATH);
    });
    cache = null;
  } catch { /* best-effort — budgeting never breaks a turn */ }
}

const cleanModelId = (id: string | undefined | null): string => (id ?? '').trim();

/** Record the provider's published context_length for a model id. */
export function recordCatalogWindow(modelId: string, contextLength: unknown, source?: string): void {
  const id = cleanModelId(modelId);
  const n = typeof contextLength === 'number' && Number.isFinite(contextLength) ? Math.trunc(contextLength) : 0;
  if (!id || n < MIN_WINDOW_FLOOR) return;
  mutate(id, (prev) => ({ ...prev, catalogWindow: n, ...(source ? { catalogSource: source } : {}) }));
}

/** Record a context-overflow rejection. When the attempted input size is known
 * it becomes the ceiling; otherwise ratchet 10% below the current belief. */
export function recordWindowRejection(modelId: string, attemptedInputTokens?: number): void {
  const id = cleanModelId(modelId);
  if (!id) return;
  const current = effectiveContextWindow(id);
  const ceiling = Number.isFinite(attemptedInputTokens) && (attemptedInputTokens as number) > MIN_WINDOW_FLOOR
    ? Math.trunc(attemptedInputTokens as number) - 1
    : Math.floor(current * 0.9);
  mutate(id, (prev) => ({
    ...prev,
    rejectedCeiling: Math.max(MIN_WINDOW_FLOOR, Math.min(prev.rejectedCeiling ?? Infinity, ceiling)),
  }));
}

/** Record a PROVEN acceptance (usage.input_tokens from a successful request).
 * Only writes when it beats the current belief — steady-state cost is zero. */
export function recordWindowAcceptance(modelId: string, inputTokens: unknown): void {
  const id = cleanModelId(modelId);
  const n = typeof inputTokens === 'number' && Number.isFinite(inputTokens) ? Math.trunc(inputTokens) : 0;
  if (!id || n <= 0) return;
  if (n <= effectiveContextWindow(id)) return;
  mutate(id, (prev) => ({ ...prev, provenAcceptedInput: Math.max(prev.provenAcceptedInput ?? 0, n) }));
}

/**
 * The context window budgeting should trust for this model RIGHT NOW:
 * registry seed → catalog overrides → proven acceptance raises →
 * rejection ceiling clamps (proven acceptance still wins over an older,
 * lower rejection — the provider's live behavior is the tiebreak).
 */
export function effectiveContextWindow(modelId: string | undefined | null): number {
  const id = cleanModelId(modelId);
  let window = resolveModelCapability(id || undefined).contextWindow;
  if (!id) return window;
  const obs = readObservations().entries[id];
  if (!obs) return window;
  if (typeof obs.catalogWindow === 'number' && obs.catalogWindow >= MIN_WINDOW_FLOOR) window = obs.catalogWindow;
  if (typeof obs.provenAcceptedInput === 'number' && obs.provenAcceptedInput > window) window = obs.provenAcceptedInput;
  if (typeof obs.rejectedCeiling === 'number' && obs.rejectedCeiling < window) {
    window = Math.max(MIN_WINDOW_FLOOR, obs.rejectedCeiling, obs.provenAcceptedInput ?? 0);
  }
  return window;
}

/**
 * How much roomier this model is than the 200K-era baseline every fixed
 * harness threshold was tuned against. Consumers multiply their tuned default
 * by this — never divide below 1 (small windows are protected by the
 * compaction budget, not by shrinking result surfaces), and capped so a 1M
 * window loosens generously without becoming unbounded. Env overrides at each
 * consumer still win untouched.
 */
export function windowScaleForModel(modelId: string | undefined | null, maxScale = 4): number {
  try {
    const scale = effectiveContextWindow(modelId) / 200_000;
    if (!Number.isFinite(scale)) return 1;
    return Math.min(maxScale, Math.max(1, scale));
  } catch {
    return 1;
  }
}

/**
 * LEARN THE CACHE CONTRACT FROM THE WIRE, NOT FROM DOCTRINE.
 *
 * The registry seeds `supportsPromptCache` per family, and on 2026-09-12 that
 * seed was measurably wrong for a shipping brain: grok was marked
 * non-caching on a 2026-08-20 note reading "no server-side prompt cache
 * contract we can rely on", while this machine's own usage log showed 673 of
 * 690 grok calls reporting cache reads — 3,457,024 cached of 11,449,913 input
 * tokens, a 30.2% hit rate, with the adapter stamping cacheDialect
 * 'inclusive' on every single one. The evidence was being recorded all along
 * and nothing read it.
 *
 * That flag is load-bearing: mid-turn compaction stays absolute on a
 * non-caching wire and scales with the window on a caching one. Reading it
 * wrong pinned a 256k-window brain to a 32k trigger — compacting at 13% of
 * context — while every collapse rewrote a prefix the provider was caching.
 *
 * So a user plugging in ANY model should not wait on a code release. Same
 * shape as the window observations above: the registry is a seed, the wire is
 * the authority.
 */
const CACHE_PROOF_MIN_CALLS = 5;

/** Record what one model response reported. Best-effort; never throws. */
export function recordCacheObservation(
  modelId: string | undefined | null,
  inputTokens: unknown,
  cachedInputTokens: unknown,
): void {
  const id = cleanModelId(modelId);
  if (!id) return;
  const input = typeof inputTokens === 'number' && Number.isFinite(inputTokens) ? inputTokens : 0;
  const cached = typeof cachedInputTokens === 'number' && Number.isFinite(cachedInputTokens)
    ? cachedInputTokens
    : 0;
  if (input <= 0) return;
  // Same locked read-modify-write every other observation uses, so concurrent
  // lanes cannot lose each other's evidence.
  mutate(id, (prev) => ({
    ...prev,
    cacheObservedCalls: (prev.cacheObservedCalls ?? 0) + 1,
    ...(cached > 0
      ? {
        cacheHitCalls: (prev.cacheHitCalls ?? 0) + 1,
        smallestCachedPrompt: Math.min(prev.smallestCachedPrompt ?? input, input),
      }
      : {}),
  }));
}

/**
 * Does this wire cache, according to the wire? The registry seed stands until
 * the model has actually demonstrated otherwise — a proof needs several calls,
 * so one fluke cannot flip a family, and absence of hits never flips a seeded
 * `true` to false (a cold conversation legitimately reports no reads).
 */
export function effectivePromptCacheSupport(modelId: string | undefined | null): boolean {
  const seeded = resolveModelCapability(cleanModelId(modelId) || undefined).supportsPromptCache;
  if (seeded) return true;
  try {
    const id = cleanModelId(modelId);
    if (!id) return seeded;
    const obs = readObservations().entries[id];
    if (!obs) return seeded;
    return (obs.cacheHitCalls ?? 0) >= CACHE_PROOF_MIN_CALLS;
  } catch {
    return seeded;
  }
}

/** The observed practical floor, for consumers that need a minimum. Falls back
 *  to the registry's seeded value when the wire has taught us nothing. */
export function effectiveCacheMinTokens(modelId: string | undefined | null): number {
  const seeded = resolveModelCapability(cleanModelId(modelId) || undefined).cacheMinTokens;
  try {
    const id = cleanModelId(modelId);
    const observed = id ? readObservations().entries[id]?.smallestCachedPrompt : undefined;
    if (typeof observed === 'number' && observed > 0) {
      return seeded > 0 ? Math.min(seeded, observed) : observed;
    }
  } catch { /* seeded value stands */ }
  return seeded;
}

/** Test-only: reset the read cache (the state file is under a temp HOME in tests). */
export function _resetModelWindowObservationCacheForTests(): void {
  cache = null;
}
