/**
 * One owner for "how much of each model account is used" — the desktop top
 * bar, the desktop Models settings and the phone all read this builder, so no
 * surface can disagree about a number or show a provider the daemon does not
 * consider connected.
 *
 * Sources, per provider:
 * - Codex: 5h + weekly windows captured from the provider's response headers.
 * - Claude: 5h + 7-day windows polled from the account usage endpoint (cached).
 * - Grok (xAI) and any BYO provider: request/token limit-and-remaining pairs
 *   captured from its response headers, when the provider sends them.
 * - Every provider: today's token spend from the local ledger, so a meter is
 *   never blank just because a provider publishes no window.
 *
 * Only connection booleans, percentages, counts and non-secret provider ids
 * leave this module.
 */
import { getOpenAiApiKey } from '../../config.js';
import { readUsageEventsForDate } from '../usage-log.js';
import { xaiOAuthConnected } from '../auth-store.js';
import { getByoProviderSnapshots, XAI_PROVIDER_ID } from './byo-providers.js';
import { getClaudeUsageSnapshot } from './claude-usage.js';
import { claudeModelsAvailable, codexModelsAvailable } from './model-role-options.js';
import { resolveProvider } from './model-wire-registry.js';
import { classifyCodexQuota, getRateLimitSnapshot, type ByoRateLimit } from './rate-limit-store.js';

export interface ProviderSpend { tokens: number; calls: number; inputTokens: number; outputTokens: number }

export interface ModelStatusPayload {
  codex: { connected: boolean; primary?: unknown; secondary?: unknown; capturedAt?: number };
  claude: { connected: boolean } & Record<string, unknown>;
  openai: { connected: boolean };
  /** The Grok account: connected when an xAI grant is stored; limits when
   *  the provider has answered at least once since the daemon started. */
  xai: { connected: boolean } & Partial<ByoRateLimit>;
  byoProviders: Array<{ id: string; label: string; modelIds: string[]; connected: boolean; limits?: ByoRateLimit }>;
  together: { connected: boolean };
  /** Today's local token ledger, grouped by provider: codex, claude, xai, or
   *  the BYO provider id. */
  spendToday: { date: string; byProvider: Record<string, ProviderSpend> };
  updatedAt: number;
}

const SPEND_CACHE_MS = 20_000;
let spendCache: { at: number; value: ModelStatusPayload['spendToday'] } | null = null;

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Which account a ledger row spent against. Codex and Claude are known by
 *  wire shape; a BYO model belongs to the provider that lists it; a Grok id
 *  with no listing still belongs to the xAI account. */
export function providerForSpend(modelId: string, byo: Array<{ id: string; modelIds: readonly string[] }>): string {
  const cls = resolveProvider(modelId);
  if (cls === 'codex' || cls === 'claude') return cls;
  const owner = byo.find((p) => p.modelIds.includes(modelId));
  if (owner) return owner.id;
  if (/^grok/i.test(modelId)) return XAI_PROVIDER_ID;
  return 'byo';
}

function spendToday(byo: Array<{ id: string; modelIds: readonly string[] }>, now = Date.now()): ModelStatusPayload['spendToday'] {
  if (spendCache && now - spendCache.at < SPEND_CACHE_MS) return spendCache.value;
  const date = new Date(now);
  const byProvider: Record<string, ProviderSpend> = {};
  try {
    for (const event of readUsageEventsForDate(date)) {
      const key = providerForSpend(String(event.model ?? ''), byo);
      const row = byProvider[key] ?? (byProvider[key] = { tokens: 0, calls: 0, inputTokens: 0, outputTokens: 0 });
      row.calls += 1;
      row.tokens += Number(event.totalTokens) || 0;
      row.inputTokens += Number(event.inputTokens) || 0;
      row.outputTokens += Number(event.outputTokens) || 0;
    }
  } catch {
    /* a missing or unreadable ledger day is an empty day */
  }
  const value = { date: localDateKey(date), byProvider };
  spendCache = { at: now, value };
  return value;
}

export function buildModelStatus(now = Date.now()): ModelStatusPayload {
  const rl = getRateLimitSnapshot();
  const claudeConnected = claudeModelsAvailable();
  // Claude windows come from the dedicated account usage endpoint (cached,
  // lazily refreshed) — only poke it when Claude is actually connected.
  const claudeUsage = claudeConnected ? getClaudeUsageSnapshot() : null;
  const configured = getByoProviderSnapshots().filter((p) => p.configured);
  const byoProviders = configured
    .filter((p) => p.id !== XAI_PROVIDER_ID)
    .map((p) => ({
      id: p.id,
      label: p.label || p.id,
      modelIds: [...p.modelIds],
      connected: true,
      ...(rl.byo?.[p.id] ? { limits: rl.byo[p.id] } : {}),
    }));
  const togetherConnected = byoProviders.some(
    (p) => p.id === 'together' || p.id === 'together-ai' || /together/i.test(p.label),
  );
  // Window slots assigned by DURATION, not header position — the provider
  // has shipped weekly as "primary" (see classifyCodexQuota). Wire names
  // stay primary=5h-slot / secondary=weekly-slot for renderer compat.
  const codexQuota = classifyCodexQuota(rl.codex);
  const xaiConnected = xaiOAuthConnected() || configured.some((p) => p.id === XAI_PROVIDER_ID);
  return {
    codex: {
      connected: codexModelsAvailable(),
      primary: codexQuota.fiveHour,
      secondary: codexQuota.weekly,
      capturedAt: codexQuota.capturedAt,
    },
    claude: { connected: claudeConnected, ...(claudeUsage ?? {}) },
    openai: { connected: Boolean(getOpenAiApiKey()) },
    xai: { connected: xaiConnected, ...(xaiConnected && rl.byo?.[XAI_PROVIDER_ID] ? rl.byo[XAI_PROVIDER_ID] : {}) },
    byoProviders,
    together: { connected: togetherConnected },
    spendToday: spendToday(configured.map((p) => ({ id: p.id, modelIds: p.modelIds })), now),
    updatedAt: now,
  };
}

/** Test seam. */
export function __resetModelStatusCacheForTests(): void {
  spendCache = null;
}
