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
export interface CodexRateLimit {
  /** Older captures ambiguously converted 1 percent to 100; never reuse them. */
  percentUnit?: 'percent';
  primary?: CodexWindow;
  secondary?: CodexWindow;
  capturedAt: number;
  /** Explicit exhaustion latch: set when /responses answers 429 (usage limit)
   *  WITHOUT quota headers — the belt for the header-drop case. Cleared by
   *  time or by any later capture showing head-room. */
  exhaustedUntil?: number;
}
/** A limit/remaining pair as OpenAI-compatible providers report it in
 *  `x-ratelimit-{limit,remaining}-{requests,tokens}` headers (xAI ships all
 *  four on every completion). The window is the provider's, usually a minute;
 *  no reset header is promised, so `resetAt` is optional. */
export interface ByoRateLimitWindow { limit: number; remaining: number; resetAt?: number }
export interface ByoRateLimit {
  requests?: ByoRateLimitWindow;
  tokens?: ByoRateLimitWindow;
  capturedAt: number;
}
export interface RateLimitSnapshot {
  codex?: CodexRateLimit;
  /** Keyed by BYO provider id (e.g. the xAI grant). */
  byo?: Record<string, ByoRateLimit>;
}

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
      snapshot = discardAmbiguousCodexPercentages(JSON.parse(readFileSync(STORE_PATH, 'utf-8')) as RateLimitSnapshot);
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

/** Codex *-used-percent headers are percentages, including values <= 1. */
function toPercent(v: number | undefined): number | undefined {
  if (v == null) return undefined;
  return Math.max(0, Math.min(100, v));
}

/** Legacy normalized values cannot distinguish actual exhaustion from 1%.
 * Drop those windows until a fresh provider response; preserve explicit 429
 * backoff and unrelated providers. Never guess a replacement percentage. */
export function discardAmbiguousCodexPercentages(value: RateLimitSnapshot): RateLimitSnapshot {
  if (!value.codex || value.codex.percentUnit === 'percent') return value;
  const { primary: _primary, secondary: _secondary, ...rest } = value.codex;
  return { ...value, codex: rest };
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
    const headroom = [primary, secondary].some(
      (window) => window && window.windowMinutes !== 0 && window.usedPercent < 100,
    );
    snapshot.codex = {
      percentUnit: 'percent',
      primary,
      secondary,
      capturedAt: now,
      ...(headroom ? {} : snapshot.codex?.exhaustedUntil ? { exhaustedUntil: snapshot.codex.exhaustedUntil } : {}),
    };
    persist();
  } catch {
    /* never break the model path */
  }
}

/** A 429 from /responses proves exhaustion even when quota headers were
 *  dropped. Latch for `retryAfterMs` (default 30 min) so availability checks
 *  stop dialing a lane the provider just refused — the live 2026-08-07 class:
 *  every scheduled workflow's judge dialed an out-of-tokens Codex hourly and
 *  minted an alert each time. */
export function recordCodexUsageExhausted(retryAfterMs?: number): void {
  try {
    loadOnce();
    const now = Date.now();
    const until = now + Math.min(6 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, retryAfterMs ?? 30 * 60 * 1000));
    snapshot.codex = { ...(snapshot.codex ?? { capturedAt: now }), exhaustedUntil: until };
    persist();
  } catch { /* never break the model path */ }
}

/**
 * Is the Codex lane PROVABLY out of quota right now? True when the explicit
 * 429 latch is live, or when a captured window reads >=100% used with its
 * reset still in the future. Missing/stale/expired data → false (fail-open:
 * availability must never be denied on guesswork).
 */
/** How long a captured usedPercent sample remains evidence of CURRENT
 *  unavailability. Beyond this the 429 latch (exhaustedUntil) is the only
 *  authority and a probe may re-establish truth. Tunable for operators who want
 *  a longer hold; it can never override an active latch. */
export const CODEX_QUOTA_SAMPLE_FRESH_MS = (() => {
  const raw = Number.parseInt(process.env.CLEMMY_CODEX_QUOTA_SAMPLE_FRESH_MS ?? '900000', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 900_000;
})();

export function codexQuotaExhausted(now: number = Date.now()): boolean {
  try {
    loadOnce();
    const codex = snapshot.codex;
    if (!codex) return false;
    // The 429 LATCH is the authoritative backoff and stays absolute.
    if (typeof codex.exhaustedUntil === 'number' && codex.exhaustedUntil > now) return true;
    // A captured usedPercent is EVIDENCE, and evidence goes stale. Treating a
    // single 100% sample as authoritative until resetAt turned one reading into
    // a lockout for the whole window — observed 2026-09-05: capturedAt 17:36
    // with a weekly resetAt of 09-11 disabled the Codex lane for six days while
    // the owner reported having quota. It is also self-sustaining: the ONLY
    // writer is recordCodexRateLimit(res.headers) from an actual Codex response
    // (codex-model.ts), and codexAvailable() gates that call — so the one thing
    // that could refresh the reading is the thing the reading prevents.
    //
    // Past the freshness bound the cached percentage no longer proves current
    // unavailability, so a probe may proceed. If the account really is out, that
    // probe 429s and re-arms exhaustedUntil, which is the mechanism designed for
    // it. Nothing here edits an auth/quota file to manufacture availability.
    const capturedAt = typeof codex.capturedAt === 'number' ? codex.capturedAt : 0;
    const captureIsFresh = capturedAt > 0 && (now - capturedAt) <= CODEX_QUOTA_SAMPLE_FRESH_MS;
    if (captureIsFresh) {
      for (const window of [codex.primary, codex.secondary]) {
        if (!window) continue;
        if (window.windowMinutes === 0) continue; // placeholder, not a real limit
        if (window.usedPercent >= 100 && typeof window.resetAt === 'number' && window.resetAt > now) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Capture the generic OpenAI-style limit headers a BYO provider returns.
 *  No-op when neither remaining header is present, so a streaming response
 *  that dropped them keeps the last-known reading. */
export function recordByoRateLimit(providerId: string, headers: HeaderLike): void {
  try {
    if (!providerId) return;
    loadOnce();
    const now = Date.now();
    const window = (kind: 'requests' | 'tokens'): ByoRateLimitWindow | undefined => {
      const remaining = numFrom(headers, `x-ratelimit-remaining-${kind}`);
      const limit = numFrom(headers, `x-ratelimit-limit-${kind}`);
      if (remaining == null || limit == null || limit <= 0) return undefined;
      const resetAt = resetToEpochMs(headers, [], [`x-ratelimit-reset-${kind}`], now);
      return {
        limit: Math.round(limit),
        remaining: Math.max(0, Math.min(Math.round(limit), Math.round(remaining))),
        ...(resetAt ? { resetAt } : {}),
      };
    };
    const requests = window('requests');
    const tokens = window('tokens');
    if (!requests && !tokens) return;
    snapshot.byo = { ...(snapshot.byo ?? {}), [providerId]: { requests, tokens, capturedAt: now } };
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

export interface CodexQuotaView {
  fiveHour?: CodexWindow;
  weekly?: CodexWindow;
  capturedAt?: number;
}

/**
 * Assign captured Codex windows to UI slots by their DURATION, never their
 * header position. The provider has shipped the weekly window as "primary"
 * (live 2026-07-30: primary.windowMinutes=10080 rendered under the 5h label,
 * while a zero-duration placeholder secondary showed as "wk 0%").
 *
 * Rules: ≥2 days ⇒ weekly slot; a positive shorter duration ⇒ 5h slot; a
 * zero-duration window is a placeholder and is DROPPED (never rendered as a
 * fake 0%); a window with no duration header at all keeps the legacy
 * positional meaning (primary ⇒ 5h, secondary ⇒ weekly).
 */
export function classifyCodexQuota(codex: RateLimitSnapshot['codex']): CodexQuotaView {
  const out: CodexQuotaView = { capturedAt: codex?.capturedAt };
  if (!codex) return out;
  const assign = (window: CodexWindow | undefined, positionalSlot: 'fiveHour' | 'weekly'): void => {
    if (!window) return;
    const minutes = window.windowMinutes;
    if (minutes === 0) return; // placeholder, not a real limit
    const slot = minutes == null
      ? positionalSlot
      : minutes >= 2880 ? 'weekly' : 'fiveHour';
    if (!out[slot]) out[slot] = window;
  };
  assign(codex.primary, 'fiveHour');
  assign(codex.secondary, 'weekly');
  return out;
}

/** Test-only: clear the in-memory snapshot. */
export function __resetRateLimitStoreForTests(): void {
  snapshot = {};
  loaded = false;
}
