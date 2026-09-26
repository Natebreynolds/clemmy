import { installedClaudeClientVersion } from './claude-client-version.js';
/**
 * claude-usage — fetch Claude's authoritative Pro/Max usage windows for the
 * top-bar chips. Claude runs through the Claude Code CLI here (agent-SDK +
 * headless), which consumes the rate-limit headers internally and never surfaces
 * them, so we can't capture from a response. Instead we query the same endpoint
 * the Claude Code clients use:
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *     → { five_hour: {utilization, resets_at}, seven_day: {utilization, resets_at}, … }
 *
 * Two hard requirements (or you get persistent 429s): a `claude-code/<version>`
 * User-Agent, and the OAuth beta header. The endpoint is also aggressively
 * rate-limited, so we cache and refresh at most every REFRESH_MS, lazily and
 * off the hot path — getClaudeUsageSnapshot() always returns the prior cache
 * immediately and kicks a background refresh when stale.
 */
import { loadFreshClaudeAccessToken } from '../claude-oauth.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.claude-usage' });

export interface ClaudeUsageWindow { usedPercent: number; resetAt?: number }
export interface ClaudeScopedUsageWindow extends ClaudeUsageWindow {
  /** Provider display name for the constrained model family (for example
   * Anthropic's "Fable"). */
  modelLabel?: string;
  /** Anthropic marks the limit currently blocking the selected route active. */
  active: boolean;
}
export interface ClaudeUsageSnapshot {
  fiveHour?: ClaudeUsageWindow;
  weekly?: ClaudeUsageWindow;
  scopedWeekly?: ClaudeScopedUsageWindow;
  extraUsageEnabled?: boolean;
  extraUsageUserDisabled?: boolean;
  capturedAt: number;
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The endpoint buckets by User-Agent: a `claude-code/<version>` UA gets the
// generous limit, anything else is throttled into uselessness. Keep the oauth
// beta header in lockstep with applyClaudeEnvelope (claude-model.ts).
const ENVELOPE_BETA = 'oauth-2025-04-20,claude-code-20250219';
// Don't poll faster than this — the endpoint 429s hard and stays stuck for a
// long time once tripped. The 15s UI poll only triggers a real fetch this often.
const REFRESH_MS = 180_000;

let cache: ClaudeUsageSnapshot | null = null;
let inflight = false;
let lastAttempt = 0;

/** Pure parser for the /api/oauth/usage body → normalized snapshot. Exported for
 *  tests. utilization is a 0–100 percent; resets_at is an ISO timestamp. */
export function parseClaudeUsage(body: unknown, now: number): ClaudeUsageSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const win = (raw: unknown): ClaudeUsageWindow | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const w = raw as Record<string, unknown>;
    if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return undefined;
    const reset = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    return {
      usedPercent: Math.max(0, Math.min(100, Math.round(w.utilization))),
      resetAt: Number.isFinite(reset) ? reset : undefined,
    };
  };
  const fiveHour = win(b.five_hour);
  const weekly = win(b.seven_day);
  const scopedLimits = (Array.isArray(b.limits) ? b.limits : [])
    .filter((raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === 'object')
    .filter((raw) => raw.kind === 'weekly_scoped' && typeof raw.percent === 'number' && Number.isFinite(raw.percent))
    .map((raw): ClaudeScopedUsageWindow => {
      const scope = raw.scope && typeof raw.scope === 'object' ? raw.scope as Record<string, unknown> : null;
      const model = scope?.model && typeof scope.model === 'object' ? scope.model as Record<string, unknown> : null;
      const reset = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : NaN;
      const label = typeof model?.display_name === 'string' ? model.display_name.trim() : '';
      return {
        usedPercent: Math.max(0, Math.min(100, Math.round(raw.percent as number))),
        resetAt: Number.isFinite(reset) ? reset : undefined,
        active: raw.is_active === true,
        modelLabel: label || undefined,
      };
    });
  // Prefer the provider-declared active blocker. If none is active, retain the
  // highest scoped utilization so the UI can still warn before it becomes one.
  const scopedWeekly = scopedLimits.find((limit) => limit.active)
    ?? scopedLimits.sort((a, b2) => b2.usedPercent - a.usedPercent)[0];
  const extra = b.extra_usage && typeof b.extra_usage === 'object'
    ? b.extra_usage as Record<string, unknown>
    : null;
  const extraUsageEnabled = typeof extra?.is_enabled === 'boolean' ? extra.is_enabled : undefined;
  const extraUsageUserDisabled = typeof extra?.user_disabled === 'boolean' ? extra.user_disabled : undefined;
  if (!fiveHour && !weekly && !scopedWeekly) return null;
  return {
    fiveHour,
    weekly,
    scopedWeekly,
    extraUsageEnabled,
    extraUsageUserDisabled,
    capturedAt: now,
  };
}

async function refresh(): Promise<void> {
  // The usage endpoint is the owner's live Claude account. A test run never
  // calls it; a test installs its reading with __setClaudeUsageForTests.
  if (isolatedTestContractActive()) return;
  if (inflight) return;
  inflight = true;
  lastAttempt = Date.now();
  try {
    const token = await loadFreshClaudeAccessToken();
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ENVELOPE_BETA,
        'user-agent': `claude-code/${installedClaudeClientVersion()} (external, clementine)`,
        accept: 'application/json',
      },
    });
    if (!res.ok) { logger.debug({ status: res.status }, 'claude usage fetch non-ok — keeping prior'); return; }
    const parsed = parseClaudeUsage(await res.json(), Date.now());
    if (parsed) cache = parsed;
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'claude usage fetch failed — keeping prior');
  } finally {
    inflight = false;
  }
}

/** Cached Claude usage windows; kicks a non-blocking refresh when stale (the
 *  endpoint is too rate-limited to call inline). Returns the prior cache (or
 *  null until the first refresh lands). Call only when Claude is connected. */
export function getClaudeUsageSnapshot(): ClaudeUsageSnapshot | null {
  if (!inflight && Date.now() - lastAttempt >= REFRESH_MS) void refresh();
  return cache;
}

/** How long a usage reading stays evidence of CURRENT exhaustion. The same
 *  bound, for the same reason, as the Codex reading (rate-limit-store.ts): a
 *  single stale 100% sample must never lock an account out for a whole window.
 *  Past it, the account is dialed again and the provider's answer decides. */
export const CLAUDE_QUOTA_SAMPLE_FRESH_MS = 15 * 60_000;

export interface ClaudeQuotaExhaustion {
  /** The plan window that is used up. */
  window: 'five_hour' | 'seven_day';
  usedPercent: number;
  resetAt: number;
  capturedAt: number;
}

/**
 * PURE: does this reading PROVE the account cannot serve right now? Only a
 * fresh reading of a plan window at 100% with its reset still ahead counts.
 * Not while extra usage is on: the account keeps serving past the plan window
 * then, and when extra usage runs out too the provider's own refusal says so.
 * A model-scoped cap is also left to that refusal, because the reading names
 * the capped model only by its display name. Missing, stale or expired data
 * proves nothing.
 */
export function claudeUsageExhaustion(snapshot: ClaudeUsageSnapshot | null | undefined, now: number): ClaudeQuotaExhaustion | null {
  if (!snapshot || snapshot.extraUsageEnabled === true) return null;
  const capturedAt = snapshot.capturedAt;
  if (!(capturedAt > 0) || now - capturedAt > CLAUDE_QUOTA_SAMPLE_FRESH_MS) return null;
  const windows: Array<[ClaudeQuotaExhaustion['window'], ClaudeUsageWindow | undefined]> = [
    ['five_hour', snapshot.fiveHour],
    ['seven_day', snapshot.weekly],
  ];
  for (const [window, reading] of windows) {
    if (reading && reading.usedPercent >= 100 && typeof reading.resetAt === 'number' && reading.resetAt > now) {
      return { window, usedPercent: reading.usedPercent, resetAt: reading.resetAt, capturedAt };
    }
  }
  return null;
}

/** The account's plan quota as the usage meters read it. Answers from the
 *  cached reading at once and, like the meters, kicks the throttled background
 *  refresh when the reading is old. Never blocks, never throws. */
export function claudeQuotaExhaustion(now: number = Date.now()): ClaudeQuotaExhaustion | null {
  try {
    return claudeUsageExhaustion(getClaudeUsageSnapshot(), now);
  } catch {
    return null;
  }
}

/** Test-only: clear the cache + refresh gate. */
export function __resetClaudeUsageForTests(): void {
  cache = null;
  inflight = false;
  lastAttempt = 0;
}

/** Test-only: install a usage reading and hold off the background refresh. */
export function __setClaudeUsageForTests(snapshot: ClaudeUsageSnapshot | null): void {
  cache = snapshot;
  inflight = false;
  lastAttempt = Date.now();
}
