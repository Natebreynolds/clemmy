/**
 * Usage meters — one presenter for every surface.
 *
 * The daemon reports what each model account exposes: Codex and Claude have
 * 5-hour and weekly windows as a used percentage; Grok and other API-key
 * providers report a request and a token budget with how much is left; every
 * account has today's token spend from the local ledger. A surface shows a
 * connected account even when its provider publishes no window — the spend
 * line is then the whole meter — and never shows an account the daemon does
 * not consider connected.
 */

export interface UsageWindowLike { usedPercent: number; resetAt?: number; windowMinutes?: number }
export interface UsageLimitLike { limit: number; remaining: number; resetAt?: number }
export interface UsageLimitsLike { requests?: UsageLimitLike; tokens?: UsageLimitLike; capturedAt?: number }
export interface UsageSpendLike { tokens: number; calls: number }

export interface UsageStatusLike {
  codex: { connected: boolean; primary?: UsageWindowLike; secondary?: UsageWindowLike; capturedAt?: number };
  claude: {
    connected: boolean;
    fiveHour?: UsageWindowLike;
    weekly?: UsageWindowLike;
    scopedWeekly?: UsageWindowLike & { modelLabel?: string; active: boolean };
    capturedAt?: number;
    status?: string;
    extraUsageEnabled?: boolean;
  };
  xai?: { connected: boolean } & UsageLimitsLike;
  openai?: { connected: boolean };
  byoProviders?: Array<{ id: string; label: string; modelIds?: string[]; connected: boolean; limits?: UsageLimitsLike }>;
  spendToday?: { date: string; byProvider: Record<string, UsageSpendLike> };
}

export type UsageTone = 'ok' | 'warning' | 'danger';

export interface UsageMeterWindow {
  id: string;
  /** Short label a chip can afford: "5h", "week", "requests", "tokens". */
  label: string;
  usedPercent: number;
  tone: UsageTone;
  resetAt?: number;
  /** A longer line for a panel or tooltip: "590 of 600 requests left". */
  detail?: string;
}

export interface UsageMeter {
  id: string;
  label: string;
  windows: UsageMeterWindow[];
  spend?: UsageSpendLike;
  /** Why there is no window, when there is none. */
  note?: string;
  capturedAt?: number;
}

export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent >= 90) return 'danger';
  if (usedPercent >= 70) return 'warning';
  return 'ok';
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function resetsInText(resetAt: number | undefined, now: number): string | null {
  if (!resetAt || !Number.isFinite(resetAt)) return null;
  const ms = resetAt - now;
  if (ms <= 0) return 'resets now';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `resets in ${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `resets in ${Math.round(hours / 24)}d`;
}

function windowFrom(id: string, label: string, w: UsageWindowLike | undefined): UsageMeterWindow | null {
  if (!w || !Number.isFinite(w.usedPercent)) return null;
  const usedPercent = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
  return { id, label, usedPercent, tone: usageTone(usedPercent), ...(w.resetAt ? { resetAt: w.resetAt } : {}), detail: `${usedPercent}% of the ${label} window used` };
}

function limitWindow(id: string, label: string, l: UsageLimitLike | undefined): UsageMeterWindow | null {
  if (!l || !Number.isFinite(l.limit) || l.limit <= 0 || !Number.isFinite(l.remaining)) return null;
  const used = Math.max(0, Math.min(l.limit, l.limit - l.remaining));
  const usedPercent = Math.round((used / l.limit) * 100);
  return {
    id,
    label,
    usedPercent,
    tone: usageTone(usedPercent),
    ...(l.resetAt ? { resetAt: l.resetAt } : {}),
    detail: `${formatTokenCount(l.remaining)} of ${formatTokenCount(l.limit)} ${label} left`,
  };
}

function limitWindows(limits: UsageLimitsLike | undefined): UsageMeterWindow[] {
  return [limitWindow('requests', 'requests', limits?.requests), limitWindow('tokens', 'tokens', limits?.tokens)]
    .filter((w): w is UsageMeterWindow => w !== null);
}

export function presentUsageMeters(status: UsageStatusLike | null | undefined): UsageMeter[] {
  if (!status) return [];
  const spend = status.spendToday?.byProvider ?? {};
  const meters: UsageMeter[] = [];

  if (status.codex?.connected) {
    const windows = [windowFrom('five', '5h', status.codex.primary), windowFrom('week', 'week', status.codex.secondary)]
      .filter((w): w is UsageMeterWindow => w !== null);
    meters.push({
      id: 'codex',
      label: 'Codex',
      windows,
      ...(spend.codex ? { spend: spend.codex } : {}),
      ...(windows.length === 0 ? { note: 'No window reported yet — it arrives with the first Codex answer.' } : {}),
      ...(status.codex.capturedAt ? { capturedAt: status.codex.capturedAt } : {}),
    });
  }
  if (status.claude?.connected) {
    const windows = [
      windowFrom('five', '5h', status.claude.fiveHour),
      windowFrom('week', 'week', status.claude.weekly),
      status.claude.scopedWeekly?.active
        ? windowFrom('scoped', status.claude.scopedWeekly.modelLabel ? `${status.claude.scopedWeekly.modelLabel} week` : 'model week', status.claude.scopedWeekly)
        : null,
    ].filter((w): w is UsageMeterWindow => w !== null);
    meters.push({
      id: 'claude',
      label: 'Claude',
      windows,
      ...(spend.claude ? { spend: spend.claude } : {}),
      ...(windows.length === 0 ? { note: 'Usage not reported yet.' } : {}),
      ...(status.claude.capturedAt ? { capturedAt: status.claude.capturedAt } : {}),
    });
  }
  if (status.xai?.connected) {
    const windows = limitWindows(status.xai);
    meters.push({
      id: 'xai',
      label: 'Grok',
      windows,
      ...(spend.xai ? { spend: spend.xai } : {}),
      ...(windows.length === 0 ? { note: 'Limits arrive with the first Grok answer.' } : {}),
      ...(status.xai.capturedAt ? { capturedAt: status.xai.capturedAt } : {}),
    });
  }
  for (const provider of status.byoProviders ?? []) {
    if (!provider.connected || provider.id === 'xai') continue;
    const windows = limitWindows(provider.limits);
    meters.push({
      id: provider.id,
      label: provider.label || provider.id,
      windows,
      ...(spend[provider.id] ? { spend: spend[provider.id] } : {}),
      ...(windows.length === 0 ? { note: `${provider.label || provider.id} does not report a limit.` } : {}),
      ...(provider.limits?.capturedAt ? { capturedAt: provider.limits.capturedAt } : {}),
    });
  }
  return meters;
}

/** The whole meter in one short line, for a chip: "5h 42% · wk 18%",
 *  "req 2% · tok 8%", or "186k today" when no window exists. */
export function compactUsageText(meter: UsageMeter): string {
  const short: Record<string, string> = { '5h': '5h', week: 'wk', requests: 'req', tokens: 'tok' };
  if (meter.windows.length > 0) {
    return meter.windows.slice(0, 2).map((w) => `${short[w.label] ?? w.label} ${w.usedPercent}%`).join(' · ');
  }
  if (meter.spend) return `${formatTokenCount(meter.spend.tokens)} today`;
  return 'connected';
}

/** A reading older than this is shown with its age and without alarm: a
 *  two-day-old "83%" in amber read as a live warning (2026-09-22). */
export const USAGE_READING_STALE_MS = 6 * 3_600_000;

const WINDOW_WORDS: Record<string, string> = {
  '5h': '5-hour limit', week: 'week', requests: 'request limit', tokens: 'token limit',
};

function ageWords(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  return hours < 48 ? `${hours}h old` : `${Math.floor(hours / 24)}d old`;
}

/** The chip in words, not "wk 83%": the window closest to its limit, and the
 *  reading's age once it is no longer current. "Codex" · "83% of week · 2d old". */
export function usageChipText(meter: UsageMeter, now: number): { text: string; stale: boolean } {
  const stale = typeof meter.capturedAt === 'number' && now - meter.capturedAt > USAGE_READING_STALE_MS;
  const age = stale && typeof meter.capturedAt === 'number' ? ` · ${ageWords(now - meter.capturedAt)}` : '';
  const busiest = meter.windows.reduce<UsageMeterWindow | null>(
    (best, w) => (!best || w.usedPercent > best.usedPercent ? w : best),
    null,
  );
  if (busiest) return { text: `${busiest.usedPercent}% of ${WINDOW_WORDS[busiest.label] ?? busiest.label}${age}`, stale };
  if (meter.spend) return { text: `${formatTokenCount(meter.spend.tokens)} tokens today`, stale: false };
  return { text: 'connected', stale: false };
}

export function meterTone(meter: UsageMeter): UsageTone {
  return meter.windows.reduce<UsageTone>((tone, w) => (
    w.tone === 'danger' || tone === 'danger' ? 'danger' : w.tone === 'warning' || tone === 'warning' ? 'warning' : 'ok'
  ), 'ok');
}
