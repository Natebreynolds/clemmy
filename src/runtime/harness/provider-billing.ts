/**
 * provider-billing — where each model account gets more credit, what it is
 * doing for Clem, and the balance its own key can read.
 *
 * One directory for every surface: the status payload carries the link, so
 * the desktop, the phone and a chat notice all send the owner to the same
 * page. A BYO account is matched by its API host (and path, where one host
 * serves both a plan and pay-as-you-go endpoint); a signed-in account by its
 * account id. A provider not listed here simply has no link.
 *
 * Money figures: only what a provider serves to the ordinary API key is read
 * — a remaining balance where one exists, otherwise this month's billed spend
 * — with a plain GET that costs nothing. Readings are cached and refreshed in
 * the background so building a status never waits on a network.
 */
import pino from 'pino';
import { creditRefusal, creditRefusals, JEV_ACCOUNT_ID, OPENAI_KEY_ACCOUNT_ID, type CreditRefusal } from '../provider-credit.js';
import { getByoProviders, providerToBackendConfig, resolveByoProviderForModel } from './byo-providers.js';
import { boundWriterModel, resolveRoleModel } from './model-roles.js';
import { resolveProvider } from './model-wire-registry.js';

const logger = pino({ name: 'clementine.provider-billing' });

export type BillingKind = 'prepaid' | 'plan';

export interface MoneyReading { amount: number; currency: string; capturedAt: number }

export interface AccountBilling {
  url?: string;
  kind?: BillingKind;
  outOfCredit?: CreditRefusal;
  /** What is left, as the provider reports it to the key. */
  balance?: MoneyReading;
  /** What the provider has billed this calendar month, in its own figures. */
  monthSpend?: MoneyReading;
  /** Jobs this account is doing now: brain, writer, judge, worker,
   *  quick_checks, memory_search. */
  roles?: string[];
}

/** One GET the ordinary API key may make for a money figure. */
interface MoneyProbe {
  /** Full URL for the GET, from the provider's own base URL. */
  url(baseURL: string): string;
  parse(body: unknown): { amount: number; currency: string } | null;
}

interface HostEntry {
  host: string;
  /** Distinguishes two products on one host (plan vs pay-as-you-go). */
  pathPrefix?: string;
  url: string;
  kind: BillingKind;
  balance?: MoneyProbe;
  monthSpend?: MoneyProbe;
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** `{ data: { available_balance } }`, in the currency the platform bills. */
const moonshotBalance = (currency: string): MoneyProbe => ({
  url: (baseURL) => `${baseURL.replace(/\/+$/, '')}/users/me/balance`,
  parse: (body) => {
    const amount = num(record(record(body)?.data)?.available_balance);
    return amount === null ? null : { amount, currency };
  },
});

/** `{ balance_infos: [{ currency, total_balance }] }` — the first currency. */
const deepseekBalance: MoneyProbe = {
  url: () => 'https://api.deepseek.com/user/balance',
  parse: (body) => {
    const infos = record(body)?.balance_infos;
    const first = Array.isArray(infos) ? record(infos[0]) : null;
    const amount = num(first?.total_balance);
    const currency = typeof first?.currency === 'string' ? first.currency : '';
    return amount === null || !currency ? null : { amount, currency };
  },
};

/** This month's billed usage: `{ currency, data: [{ line_items: [{ cost }] }] }`,
 *  costs as decimal strings. The sum is the provider's own figure. */
const togetherMonthSpend: MoneyProbe = {
  url: (baseURL) => `${baseURL.replace(/\/+$/, '')}/billing/usage?granularity=day&limit=100`,
  parse: (body) => {
    const root = record(body);
    const windows = root?.data;
    if (!Array.isArray(windows)) return null;
    let amount = 0;
    for (const window of windows) {
      const items = record(window)?.line_items;
      if (!Array.isArray(items)) continue;
      for (const item of items) amount += num(record(item)?.cost) ?? 0;
    }
    const currency = typeof root?.currency === 'string' && root.currency ? root.currency : 'USD';
    return { amount, currency };
  },
};

const OPENAI_BILLING_URL = 'https://platform.openai.com/settings/organization/billing';

const BY_HOST: readonly HostEntry[] = [
  { host: 'api.together.ai', url: 'https://api.together.ai/settings/organization/~current/billing', kind: 'prepaid', monthSpend: togetherMonthSpend },
  { host: 'api.together.xyz', url: 'https://api.together.ai/settings/organization/~current/billing', kind: 'prepaid', monthSpend: togetherMonthSpend },
  { host: 'api.moonshot.ai', url: 'https://platform.kimi.ai/console/pay', kind: 'prepaid', balance: moonshotBalance('USD') },
  { host: 'api.moonshot.cn', url: 'https://platform.moonshot.cn/console/pay', kind: 'prepaid', balance: moonshotBalance('CNY') },
  { host: 'api.kimi.com', pathPrefix: '/coding', url: 'https://www.kimi.com/membership/subscription?tab=quota', kind: 'plan' },
  { host: 'api.deepseek.com', url: 'https://platform.deepseek.com/top_up', kind: 'prepaid', balance: deepseekBalance },
  { host: 'api.z.ai', pathPrefix: '/api/coding', url: 'https://z.ai/manage-apikey/subscription', kind: 'plan' },
  { host: 'api.z.ai', url: 'https://z.ai/manage-apikey/billing', kind: 'prepaid' },
  { host: 'api.x.ai', url: 'https://console.x.ai/team/default/billing', kind: 'prepaid' },
  { host: 'api.minimax.io', url: 'https://platform.minimax.io/user-center/payment/balance', kind: 'prepaid' },
  { host: 'openrouter.ai', url: 'https://openrouter.ai/settings/credits', kind: 'prepaid' },
  { host: 'api.openai.com', url: OPENAI_BILLING_URL, kind: 'prepaid' },
];

/** Accounts that are not reached through a BYO base URL. */
const BY_ACCOUNT: Readonly<Record<string, { url: string; kind: BillingKind }>> = {
  codex: { url: 'https://chatgpt.com/codex/settings/usage', kind: 'plan' },
  claude: { url: 'https://claude.ai/settings/usage', kind: 'plan' },
  [OPENAI_KEY_ACCOUNT_ID]: { url: OPENAI_BILLING_URL, kind: 'prepaid' },
  [JEV_ACCOUNT_ID]: { url: 'https://console.typesafe.ai/settings/billing', kind: 'prepaid' },
};

/** The directory entry for a BYO base URL; the longest matching path wins. */
export function billingEntryForBaseURL(baseURL: string): HostEntry | undefined {
  let parsed: URL;
  try { parsed = new URL(baseURL); } catch { return undefined; }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;
  return BY_HOST
    .filter((e) => e.host === host && (!e.pathPrefix || pathname.startsWith(e.pathPrefix)))
    .sort((a, b) => (b.pathPrefix?.length ?? 0) - (a.pathPrefix?.length ?? 0))[0];
}

// ── balances and billed spend ───────────────────────────────────────────────

const BALANCE_FRESH_MS = 5 * 60_000;
const BALANCE_RETRY_AFTER_FAILURE_MS = 15 * 60_000;
const BALANCE_TIMEOUT_MS = 5_000;

interface BalanceCacheEntry { reading?: MoneyReading; attemptedAt: number; ok: boolean; inflight?: boolean }
/** Keyed `${accountId}:balance` or `${accountId}:monthSpend`. */
const balanceCache = new Map<string, BalanceCacheEntry>();

type BalanceFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
let fetchOverride: BalanceFetch | undefined;

async function readBalance(cacheKey: string, probe: MoneyProbe, baseURL: string, apiKey: string): Promise<void> {
  const entry = balanceCache.get(cacheKey) ?? { attemptedAt: 0, ok: false };
  entry.inflight = true;
  entry.attemptedAt = Date.now();
  balanceCache.set(cacheKey, entry);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const doFetch: BalanceFetch = fetchOverride ?? (globalThis.fetch as unknown as BalanceFetch);
    const res = await doFetch(probe.url(baseURL), {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    });
    const parsed = res.ok ? probe.parse(await res.json()) : null;
    if (parsed) {
      entry.reading = { ...parsed, capturedAt: Date.now() };
      entry.ok = true;
    } else {
      entry.ok = false;
    }
  } catch (err) {
    entry.ok = false;
    logger.debug({ reading: cacheKey, err: err instanceof Error ? err.message : String(err) }, 'billing read failed');
  } finally {
    clearTimeout(timer);
    entry.inflight = false;
  }
}

/** Last known reading; starts a background refresh when it is due. */
function balanceFor(cacheKey: string, probe: MoneyProbe, baseURL: string, apiKey: string, now: number): MoneyReading | undefined {
  const entry = balanceCache.get(cacheKey);
  const due = !entry
    || (!entry.inflight && now - entry.attemptedAt > (entry.ok ? BALANCE_FRESH_MS : BALANCE_RETRY_AFTER_FAILURE_MS));
  if (due && apiKey) void readBalance(cacheKey, probe, baseURL, apiKey);
  return entry?.reading;
}

// ── roles ───────────────────────────────────────────────────────────────────

/** Which account serves a model id: codex / claude by wire shape, otherwise the
 *  BYO provider that owns it. */
function accountForModel(modelId: string): string | undefined {
  if (!modelId) return undefined;
  const cls = resolveProvider(modelId);
  if (cls === 'codex' || cls === 'claude') return cls;
  try {
    return resolveByoProviderForModel(modelId)?.providerId || undefined;
  } catch {
    return undefined; // an ambiguous id belongs to no single account
  }
}

/** account id → the jobs it is doing now. */
export function rolesByAccount(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (account: string | undefined, role: string): void => {
    if (!account) return;
    const list = out.get(account) ?? [];
    if (!list.includes(role)) list.push(role);
    out.set(account, list);
  };
  for (const role of ['brain', 'worker', 'judge'] as const) {
    try { add(accountForModel(resolveRoleModel(role).modelId), role); } catch { /* unresolved role names no account */ }
  }
  try { add(accountForModel(boundWriterModel()?.modelId ?? ''), 'writer'); } catch { /* no writer bound */ }
  return out;
}

// ── assembly ────────────────────────────────────────────────────────────────

function assemble(
  accountId: string,
  link: { url: string; kind: BillingKind } | undefined,
  roles: string[] | undefined,
  money: { balance?: MoneyReading; monthSpend?: MoneyReading } = {},
): AccountBilling {
  const refused = creditRefusal(accountId);
  return {
    ...(link ? { url: link.url, kind: link.kind } : {}),
    ...(refused ? { outOfCredit: refused } : {}),
    ...(money.balance ? { balance: money.balance } : {}),
    ...(money.monthSpend ? { monthSpend: money.monthSpend } : {}),
    ...(roles?.length ? { roles } : {}),
  };
}

/** Billing for every account the status payload can show, keyed by account
 *  id (codex, claude, each BYO provider id, openai, jev). */
export function buildAccountBilling(now = Date.now()): Record<string, AccountBilling> {
  const roles = rolesByAccount();
  const out: Record<string, AccountBilling> = {};
  out.codex = assemble('codex', BY_ACCOUNT.codex, roles.get('codex'));
  out.claude = assemble('claude', BY_ACCOUNT.claude, roles.get('claude'));
  for (const provider of getByoProviders()) {
    const backend = providerToBackendConfig(provider);
    // A signed-in (OAuth) account is billed by its subscription, not by the
    // API console its host belongs to, so it gets no API billing link or
    // money reads.
    const entry = backend.refreshBearer ? undefined : billingEntryForBaseURL(provider.baseURL);
    const read = (kind: 'balance' | 'monthSpend'): MoneyReading | undefined => {
      const probe = entry?.[kind];
      return probe && backend.configured
        ? balanceFor(`${provider.id}:${kind}`, probe, provider.baseURL, backend.apiKey, now)
        : undefined;
    };
    out[provider.id] = assemble(provider.id, entry, roles.get(provider.id), { balance: read('balance'), monthSpend: read('monthSpend') });
  }
  out[OPENAI_KEY_ACCOUNT_ID] = assemble(OPENAI_KEY_ACCOUNT_ID, BY_ACCOUNT[OPENAI_KEY_ACCOUNT_ID], ['memory_search']);
  out[JEV_ACCOUNT_ID] = assemble(JEV_ACCOUNT_ID, BY_ACCOUNT[JEV_ACCOUNT_ID], ['quick_checks']);
  return out;
}

// ── chat notice ─────────────────────────────────────────────────────────────

const RECENT_REFUSAL_MS = 2 * 60_000;

function accountNameAndLink(accountId: string): { name: string; url?: string } {
  if (accountId === OPENAI_KEY_ACCOUNT_ID) return { name: 'The OpenAI API key', url: BY_ACCOUNT[accountId]?.url };
  if (accountId === JEV_ACCOUNT_ID) return { name: 'Jev (TypeSafe)', url: BY_ACCOUNT[accountId]?.url };
  const provider = getByoProviders().find((p) => p.id === accountId);
  if (!provider) return { name: accountId, url: BY_ACCOUNT[accountId]?.url };
  return { name: provider.label || provider.id, url: billingEntryForBaseURL(provider.baseURL)?.url };
}

/** What a chat turn says when a model account just refused for lack of
 *  credit: which account, the provider's own words, and the page that fixes
 *  it. It reports the refusal; it never claims a balance Clem cannot see.
 *  Null when no account refused in the last couple of minutes. */
export function recentCreditRefusalNotice(now = Date.now()): string | null {
  try {
    const latest = Object.entries(creditRefusals())
      .filter(([, r]) => now - r.lastSeenAt <= RECENT_REFUSAL_MS)
      .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)[0];
    if (!latest) return null;
    const [accountId, refusal] = latest;
    const { name, url } = accountNameAndLink(accountId);
    const said = refusal.detail ? `: “${refusal.detail}”` : refusal.status === 402 ? ' with “payment required”' : ' for lack of credit';
    const fix = url ? ` Add credit here: ${url}` : ' Credit is added on the provider’s billing page.';
    return `${name} turned down this request${said}.${fix}`;
  } catch {
    return null;
  }
}

/** Test seams. */
export function __setBalanceFetchForTests(value: BalanceFetch | undefined): void {
  fetchOverride = value;
}
export function __resetProviderBillingForTests(): void {
  balanceCache.clear();
  fetchOverride = undefined;
}
