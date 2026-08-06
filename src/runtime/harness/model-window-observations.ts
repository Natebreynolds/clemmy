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

/** Test-only: reset the read cache (the state file is under a temp HOME in tests). */
export function _resetModelWindowObservationCacheForTests(): void {
  cache = null;
}
