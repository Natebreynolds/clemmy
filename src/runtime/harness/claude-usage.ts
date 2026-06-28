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
import pino from 'pino';

const logger = pino({ name: 'clementine.claude-usage' });

export interface ClaudeUsageWindow { usedPercent: number; resetAt?: number }
export interface ClaudeUsageSnapshot { fiveHour?: ClaudeUsageWindow; weekly?: ClaudeUsageWindow; capturedAt: number }

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The endpoint buckets by User-Agent: a `claude-code/<version>` UA gets the
// generous limit, anything else is throttled into uselessness. Keep the oauth
// beta header in lockstep with applyClaudeEnvelope (claude-model.ts).
const CLAUDE_CODE_UA = 'claude-code/2.1.195 (external, clementine)';
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
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly, capturedAt: now };
}

async function refresh(): Promise<void> {
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
        'user-agent': CLAUDE_CODE_UA,
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

/** Test-only: clear the cache + refresh gate. */
export function __resetClaudeUsageForTests(): void {
  cache = null;
  inflight = false;
  lastAttempt = 0;
}
