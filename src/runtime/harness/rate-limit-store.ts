/**
 * rate-limit-store — capture + expose Codex's OWN usage windows so the desktop
 * status bar can show Codex 5h/weekly quota the same way the Codex CLI (`/status`)
 * does. (Claude uses a different source — see claude-usage.ts — because Claude
 * runs through the Claude Code CLI here, which never surfaces its rate-limit
 * headers to us.)
 *
 * Source of truth is the Codex `/responses` rate-limit RESPONSE HEADERS, read
 * best-effort off each model call (codex-model.ts). Captured values are kept
 * in-memory (latest snapshot) and written through to
 * state/model-rate-limits.json so they survive a restart and are readable by the
 * console route.
 *
 * Capture must NEVER throw into the model path — every entry point is wrapped, and
 * a parse miss simply leaves the prior snapshot intact. That last part matters:
 * Codex intermittently DROPS its `x-codex-*` headers on streaming responses, so a
 * call with no quota headers keeps the last-known value rather than blanking it.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { BASE_DIR } from '../../config.js';
import { atomicJsonMutate } from '../atomic-json.js';

export interface CodexWindow { usedPercent: number; resetAt?: number; windowMinutes?: number }
export interface CodexRateLimit { primary?: CodexWindow; secondary?: CodexWindow; capturedAt: number }
export interface RateLimitSnapshot { codex?: CodexRateLimit }

const STORE_PATH = path.join(BASE_DIR, 'state', 'model-rate-limits.json');
// Read dynamically (not a const at import) so a test setting NODE_ENV after this
// module is first imported by another file still keeps the store in-memory.
function isTest(): boolean {
  return process.env.NODE_ENV === 'test';
}

let snapshot: RateLimitSnapshot = {};
let loaded = false;

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  if (isTest()) return; // tests run in-memory; never touch the operator's live file
  try {
    if (existsSync(STORE_PATH)) {
      snapshot = JSON.parse(readFileSync(STORE_PATH, 'utf-8')) as RateLimitSnapshot;
    }
  } catch {
    /* corrupt / unreadable → start empty */
  }
}

function persist(): void {
  if (isTest()) return;
  // Fire-and-forget write-through; never block or throw into the model path.
  void atomicJsonMutate<RateLimitSnapshot>(STORE_PATH, () => snapshot, {}).catch(() => {});
}

// ── header helpers ──────────────────────────────────────────────────────────
type HeaderLike = Headers | Record<string, string | undefined>;

function getHeader(h: HeaderLike, name: string): string | undefined {
  if (h && typeof (h as Headers).get === 'function') {
    const v = (h as Headers).get(name);
    return v == null ? undefined : v;
  }
  const rec = (h ?? {}) as Record<string, string | undefined>;
  return rec[name] ?? rec[name.toLowerCase()];
}

function numFrom(h: HeaderLike, ...names: string[]): number | undefined {
  for (const n of names) {
    const raw = getHeader(h, n);
    if (raw == null || raw === '') continue;
    const v = Number.parseFloat(raw);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Normalize a utilization value to 0–100. Providers report either a fraction
 *  (0–1) or a percentage (0–100); a value ≤ 1 is treated as a fraction. */
function toPercent(v: number | undefined): number | undefined {
  if (v == null) return undefined;
  const p = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/** Resolve a reset value to absolute epoch-ms. Accepts an RFC3339/ISO string, an
 *  epoch (seconds or ms), or a seconds-from-now duration. */
function resetToEpochMs(h: HeaderLike, absNames: string[], afterSecNames: string[], now: number): number | undefined {
  for (const n of absNames) {
    const raw = getHeader(h, n);
    if (!raw) continue;
    const asNum = Number.parseFloat(raw);
    if (Number.isFinite(asNum) && /^\s*\d+(\.\d+)?\s*$/.test(raw)) {
      return asNum > 1e12 ? asNum : asNum * 1000; // ms vs seconds
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const after = numFrom(h, ...afterSecNames);
  if (after != null) return now + after * 1000;
  return undefined;
}

// ── capture entry points (best-effort; never throw) ─────────────────────────

/** Capture Codex 5h (primary) + weekly (secondary) quota from a `/responses`
 *  HTTP response's headers. No-op when the `x-codex-*` headers are absent (the
 *  streaming-drop case) so the last-known snapshot is preserved. */
export function recordCodexRateLimit(headers: HeaderLike): void {
  try {
    loadOnce();
    const now = Date.now();
    const primaryUsed = toPercent(numFrom(headers, 'x-codex-primary-used-percent'));
    const secondaryUsed = toPercent(numFrom(headers, 'x-codex-secondary-used-percent'));
    if (primaryUsed == null && secondaryUsed == null) return; // headers dropped → keep prior
    const primary: CodexWindow | undefined = primaryUsed == null
      ? snapshot.codex?.primary
      : {
          usedPercent: primaryUsed,
          resetAt: resetToEpochMs(headers, ['x-codex-primary-reset-at'], ['x-codex-primary-reset-after-seconds'], now),
          windowMinutes: numFrom(headers, 'x-codex-primary-window-minutes'),
        };
    const secondary: CodexWindow | undefined = secondaryUsed == null
      ? snapshot.codex?.secondary
      : {
          usedPercent: secondaryUsed,
          resetAt: resetToEpochMs(headers, ['x-codex-secondary-reset-at'], ['x-codex-secondary-reset-after-seconds'], now),
          windowMinutes: numFrom(headers, 'x-codex-secondary-window-minutes'),
        };
    snapshot.codex = { primary, secondary, capturedAt: now };
    persist();
  } catch {
    /* never break the model path */
  }
}

/** Latest captured quota snapshot (loads the persisted file once on cold start). */
export function getRateLimitSnapshot(): RateLimitSnapshot {
  loadOnce();
  return snapshot;
}

/** Test-only: clear the in-memory snapshot. */
export function __resetRateLimitStoreForTests(): void {
  snapshot = {};
  loaded = false;
}
