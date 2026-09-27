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
 *
 * The money side rides along: where the account gets more credit, whether it
 * is refusing work for lack of credit, the balance when the provider lets the
 * key read it, and what the account is doing for Clem right now.
 */
import { MEMORY_ROLE_WORDS } from './memory-work.js';

export interface UsageWindowLike { usedPercent: number; resetAt?: number; windowMinutes?: number }
export interface UsageLimitLike { limit: number; remaining: number; resetAt?: number }
export interface UsageLimitsLike { requests?: UsageLimitLike; tokens?: UsageLimitLike; capturedAt?: number }
export interface UsageSpendLike { tokens: number; calls: number }

/** An account's money side, as the daemon reports it. `roles` are the jobs
 *  the account is doing right now (brain, writer, judge, worker, memory,
 *  quick_checks, memory_search). */
export interface UsageBillingLike {
  url?: string;
  kind?: 'prepaid' | 'plan';
  outOfCredit?: { since: number; lastSeenAt: number; status?: number; detail?: string };
  balance?: { amount: number; currency: string; capturedAt: number };
  monthSpend?: { amount: number; currency: string; capturedAt: number };
  roles?: string[];
}

export interface UsageStatusLike {
  codex: { connected: boolean; primary?: UsageWindowLike; secondary?: UsageWindowLike; capturedAt?: number; billing?: UsageBillingLike };
  claude: {
    connected: boolean;
    fiveHour?: UsageWindowLike;
    weekly?: UsageWindowLike;
    scopedWeekly?: UsageWindowLike & { modelLabel?: string; active: boolean };
    capturedAt?: number;
    status?: string;
    extraUsageEnabled?: boolean;
    billing?: UsageBillingLike;
  };
  xai?: { connected: boolean; billing?: UsageBillingLike } & UsageLimitsLike;
  openai?: { connected: boolean; billing?: UsageBillingLike };
  jev?: { connected: boolean; billing?: UsageBillingLike };
  byoProviders?: Array<{ id: string; label: string; modelIds?: string[]; connected: boolean; limits?: UsageLimitsLike; billing?: UsageBillingLike }>;
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
  /** The provider's own page for adding credit or changing the plan, and the
   *  words its button says. */
  billing?: { url: string; action: 'Add credit' | 'Manage plan' };
  /** The provider turned down Clem's requests for lack of credit — observed,
   *  never inferred from a balance. `detail` is the provider's own words. */
  outOfCredit?: { since: number; lastSeenAt: number; status?: number; detail?: string };
  /** Balance the account's own key can read, when the provider serves one. */
  balance?: { amount: number; currency: string; capturedAt: number };
  /** What the provider has billed this month, when it serves that instead. */
  monthSpend?: { amount: number; currency: string; capturedAt: number };
  /** What the account is doing for Clem, in words ("does the work"). */
  uses?: string[];
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

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£' };

/** "$38.20", "¥110.00", or "38.20 XYZ" for a currency without a symbol here. */
export function formatBalance(balance: { amount: number; currency: string }): string {
  const code = balance.currency.trim().toUpperCase();
  const amount = balance.amount.toFixed(2);
  const symbol = CURRENCY_SYMBOL[code];
  return symbol ? `${symbol}${amount}` : `${amount} ${code}`;
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

const ROLE_WORDS: Record<string, string> = {
  brain: 'does the work',
  writer: 'writes the final answer',
  judge: 'checks the work',
  worker: 'helps in parallel',
  // The memory role's own title, in the same lower-case voice as its siblings.
  memory: MEMORY_ROLE_WORDS.title.toLowerCase(),
  quick_checks: 'quick checks',
  memory_search: 'memory search',
};

/** The money fields every account's meter carries. */
function billingFields(billing: UsageBillingLike | undefined): Pick<UsageMeter, 'billing' | 'outOfCredit' | 'balance' | 'monthSpend' | 'uses'> {
  const uses = (billing?.roles ?? []).map((role) => ROLE_WORDS[role]).filter((w): w is string => Boolean(w));
  const out = billing?.outOfCredit;
  return {
    ...(uses.length ? { uses: [...new Set(uses)] } : {}),
    ...(billing?.url ? { billing: { url: billing.url, action: billing.kind === 'plan' ? 'Manage plan' as const : 'Add credit' as const } } : {}),
    ...(out ? {
      outOfCredit: {
        since: out.since,
        lastSeenAt: out.lastSeenAt,
        ...(out.status !== undefined ? { status: out.status } : {}),
        ...(out.detail ? { detail: out.detail } : {}),
      },
    } : {}),
    ...(billing?.balance && Number.isFinite(billing.balance.amount) ? { balance: billing.balance } : {}),
    ...(billing?.monthSpend && Number.isFinite(billing.monthSpend.amount) ? { monthSpend: billing.monthSpend } : {}),
  };
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
      ...billingFields(status.codex.billing),
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
      ...billingFields(status.claude.billing),
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
      ...billingFields(status.xai.billing),
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
      ...billingFields(provider.billing),
    });
  }
  if (status.openai?.connected) {
    meters.push({
      id: 'openai',
      label: 'OpenAI API',
      windows: [],
      ...(spend.openai ? { spend: spend.openai } : {}),
      note: 'OpenAI does not report a limit to the key.',
      ...billingFields(status.openai.billing),
    });
  }
  if (status.jev?.connected) {
    meters.push({
      id: 'jev',
      label: 'Jev',
      windows: [],
      ...(spend.jev ? { spend: spend.jev } : {}),
      note: 'TypeSafe shows the balance only on its billing page.',
      ...billingFields(status.jev.billing),
    });
  }
  return meters;
}

/** What a refused account shows where its usage would be. It names what the
 *  provider did, not a balance Clem cannot see. */
export const CREDIT_REFUSAL_WORDS = 'refusing requests';

/** The whole meter in one short line, for a chip: "5h 42% · wk 18%",
 *  "req 2% · tok 8%", "$38.20 left", "$42.10 this month", or "186k today". */
export function compactUsageText(meter: UsageMeter): string {
  if (meter.outOfCredit) return CREDIT_REFUSAL_WORDS;
  const short: Record<string, string> = { '5h': '5h', week: 'wk', requests: 'req', tokens: 'tok' };
  if (meter.windows.length > 0) {
    return meter.windows.slice(0, 2).map((w) => `${short[w.label] ?? w.label} ${w.usedPercent}%`).join(' · ');
  }
  if (meter.balance) return `${formatBalance(meter.balance)} left`;
  if (meter.monthSpend) return `${formatBalance(meter.monthSpend)} this month`;
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
 *  reading's age once it is no longer current. "Codex" · "83% of week · 2d old".
 *  An account the provider is refusing for lack of credit says so first. */
export function usageChipText(meter: UsageMeter, now: number): { text: string; stale: boolean } {
  if (meter.outOfCredit) return { text: CREDIT_REFUSAL_WORDS, stale: false };
  const stale = typeof meter.capturedAt === 'number' && now - meter.capturedAt > USAGE_READING_STALE_MS;
  const age = stale && typeof meter.capturedAt === 'number' ? ` · ${ageWords(now - meter.capturedAt)}` : '';
  const busiest = meter.windows.reduce<UsageMeterWindow | null>(
    (best, w) => (!best || w.usedPercent > best.usedPercent ? w : best),
    null,
  );
  if (busiest) return { text: `${busiest.usedPercent}% of ${WINDOW_WORDS[busiest.label] ?? busiest.label}${age}`, stale };
  if (meter.balance) return { text: `${formatBalance(meter.balance)} left`, stale: false };
  if (meter.monthSpend) return { text: `${formatBalance(meter.monthSpend)} this month`, stale: false };
  if (meter.spend) return { text: `${formatTokenCount(meter.spend.tokens)} tokens today`, stale: false };
  return { text: 'connected', stale: false };
}

export function meterTone(meter: UsageMeter): UsageTone {
  if (meter.outOfCredit) return 'danger';
  return meter.windows.reduce<UsageTone>((tone, w) => (
    w.tone === 'danger' || tone === 'danger' ? 'danger' : w.tone === 'warning' || tone === 'warning' ? 'warning' : 'ok'
  ), 'ok');
}

/** What the provider did, in one sentence, for an account that needs its
 *  owner: "Together AI turned down Clem’s last request at 10:13 PM: “Credit
 *  limit exceeded.” Clem uses another model where it can until Together AI
 *  answers again." Quotes the provider rather than claiming a balance. Null
 *  when nothing is wrong. The time is the caller's to format so each surface
 *  keeps its locale. */
export function creditRefusalSentence(meter: UsageMeter, formatTime: (epochMs: number) => string): string | null {
  const refusal = meter.outOfCredit;
  if (!refusal) return null;
  const said = refusal.detail
    ? `: “${refusal.detail}”${/[.!?]$/.test(refusal.detail) ? '' : '.'}`
    : refusal.status === 402 ? ' with “payment required.”' : ' for lack of credit.';
  return `${meter.label} turned down Clem’s last request at ${formatTime(refusal.lastSeenAt)}${said} `
    + `Clem uses another model where it can until ${meter.label} answers again.`;
}

// ── one grammar for every account ─────────────────────────────────────────────
//
// Every account used to speak its own language: "87% of week", "82% of Fable
// week", "0% of request limit", "connected", "941k tokens today", "$10.62
// left", "refusing requests". Both apps now say the same three things in the
// same order: what is LEFT, when it RESETS, what the account is DOING.

export interface AccountStatus {
  /** What is left, in the owner's words: "13% left this week", "$10.62 left",
   *  "No limit reported", "Refusing requests". */
  left: string;
  /** "resets in 3d" when the tightest window says so. */
  resets: string | null;
  /** The jobs it does for Clem, sentence-cased: "Checks the work", or "Idle". */
  doing: string;
  /** Today's spend, when any: "941k tokens today · 36 calls". */
  today: string | null;
  tone: UsageTone;
  /** The reading is older than USAGE_READING_STALE_MS: "reading 2d old". */
  age: string | null;
  /** The window `left` speaks about, so a card can draw exactly that bar. */
  window: UsageMeterWindow | null;
}

const LEFT_WORDS: Record<string, string> = {
  '5h': 'in this 5-hour window',
  week: 'this week',
  requests: 'of the request limit',
  tokens: 'of the token limit',
};

function windowLeftWords(label: string): string {
  return LEFT_WORDS[label] ?? `of ${label}`;
}

function sentenceCase(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function accountStatus(meter: UsageMeter, now: number): AccountStatus {
  const doing = meter.uses?.length ? sentenceCase(meter.uses.join(' · ')) : 'Idle';
  const today = meter.spend
    ? `${formatTokenCount(meter.spend.tokens)} tokens today · ${meter.spend.calls} call${meter.spend.calls === 1 ? '' : 's'}`
    : null;
  const stale = typeof meter.capturedAt === 'number' && now - meter.capturedAt > USAGE_READING_STALE_MS;
  const age = stale && typeof meter.capturedAt === 'number' ? `reading ${ageWords(now - meter.capturedAt)}` : null;
  if (meter.outOfCredit) {
    return { left: sentenceCase(CREDIT_REFUSAL_WORDS), resets: null, doing, today, tone: 'danger', age: null, window: null };
  }
  const tightest = meter.windows.reduce<UsageMeterWindow | null>(
    (best, w) => (!best || w.usedPercent > best.usedPercent ? w : best),
    null,
  );
  if (tightest) {
    const remaining = Math.max(0, 100 - tightest.usedPercent);
    return {
      left: `${remaining}% left ${windowLeftWords(tightest.label)}`,
      resets: resetsInText(tightest.resetAt, now),
      doing, today, tone: meterTone(meter), age, window: tightest,
    };
  }
  if (meter.balance) return { left: `${formatBalance(meter.balance)} left`, resets: null, doing, today, tone: 'ok', age, window: null };
  if (meter.monthSpend) return { left: `${formatBalance(meter.monthSpend)} billed this month`, resets: null, doing, today, tone: 'ok', age, window: null };
  return { left: 'No limit reported', resets: null, doing, today, tone: 'ok', age: null, window: null };
}

/** The one-line headline beside the account's name: "13% left this week · resets in 3d". */
export function accountHeadline(meter: UsageMeter, now: number): string {
  const s = accountStatus(meter, now);
  return [s.left, s.resets, s.age].filter(Boolean).join(' · ');
}

/** The grey line under it: what it does, and today's spend. "Checks the work · 747k tokens today · 54 calls". */
export function accountCaption(meter: UsageMeter, now: number): string {
  const s = accountStatus(meter, now);
  return [s.doing, s.today ?? 'nothing today'].join(' · ');
}
