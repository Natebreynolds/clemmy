/**
 * Live model discovery — the model picker exposes ANY Codex/Anthropic model the
 * user's credentials can see, so a newly released model shows up as a brain /
 * worker / judge choice WITHOUT a Clementine release (hardcoded preset lists rot
 * the day a model drops).
 *
 * Design:
 *  - Providers' own model-list APIs are the source of truth:
 *      Anthropic  GET /v1/models   (x-api-key, or the Claude-subscription OAuth
 *                                   bearer with the oauth beta header)
 *      OpenAI     GET /v1/models   (OPENAI_API_KEY)
 *  - SYNC read + background refresh: connectedModelGroups() is called from sync
 *    route handlers, so reads come from a module cache; a stale/empty cache
 *    fire-and-forgets a refresh (TTL 6h). First paint = presets; discovered
 *    models appear on the next poll.
 *  - FAIL-OPEN everywhere: no key / network error / schema drift ⇒ empty list,
 *    presets remain the floor. Discovery only ever ADDS options.
 */
import { getRuntimeEnv, getOpenAiApiKey } from '../../config.js';
import { getStoredClaudeTokens, loadFreshClaudeAccessToken } from '../claude-oauth.js';
import { getStoredCodexOAuthTokens } from '../auth-store.js';

export interface DiscoveredModel { id: string; label: string }

const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const FAILURE_RETRY_MS = 60 * 1000;

export type ModelDiscoveryPhase = 'idle' | 'refreshing' | 'ready' | 'degraded' | 'unavailable';
export interface ModelDiscoveryProviderStatus {
  phase: ModelDiscoveryPhase;
  modelCount: number;
  attemptedAt: number | null;
  fetchedAt: number | null;
  error?: string;
}
export interface ModelDiscoveryStatus {
  refreshing: boolean;
  providers: {
    anthropic: ModelDiscoveryProviderStatus;
    openai: ModelDiscoveryProviderStatus;
  };
}

interface ProviderCache extends ModelDiscoveryProviderStatus {
  models: DiscoveredModel[];
}

type ProviderName = 'anthropic' | 'openai';

function emptyProviderCache(): ProviderCache {
  return {
    models: [],
    phase: 'idle',
    modelCount: 0,
    attemptedAt: null,
    fetchedAt: null,
  };
}

let cache: Record<ProviderName, ProviderCache> = {
  anthropic: emptyProviderCache(),
  openai: emptyProviderCache(),
};
let refreshInFlight: Promise<void> | null = null;

/** OpenAI /v1/models returns EVERYTHING (131 ids in the wild: embeddings, audio,
 *  images, o-series, every gpt-5.x point-release + mini/nano/pro variants…). The
 *  Codex picker should stay TIGHT and CURRENT — what the Codex agent backend
 *  actually runs — so we keep only:
 *    • the codex-branded family (any version: `*-codex`, `*-codex-max`), and
 *    • the NEWEST generation's flagship chat models (e.g. the gpt-5.6 line),
 *  and drop older generations, the small/variant noise (mini/nano/pro/
 *  chat-latest), the o-series, other modalities, and date-stamped snapshots.
 *  Fully dynamic by design: a new `*-codex` or a newer gpt generation (5.7, 6.x)
 *  auto-appears on the next refresh and prior generations fall off on their own —
 *  no Clementine release, no hand-maintained list. Any dropped id is still
 *  runnable by typing its exact id in Settings → Models. Pure. (owner ask,
 *  2026-07-24: "only the codex models, but keep the newest flagships like 5.6".) */
export function filterOpenAiChatModelIds(ids: string[]): string[] {
  const family = /^(gpt-(?:[5-9]|[1-9][0-9])|codex)/i; // gpt-5+ / codex — NOT o-series or gpt-3/4-era
  const noise = /(embed|audio|realtime|whisper|tts|dall-e|image|moderation|transcribe|search|-instruct|-mini|-nano|-pro|-chat-latest)/i;
  const dateStamp = /-(20\d{2}-\d{2}-\d{2}|20\d{6})$/;
  const candidates = ids.filter((id) => family.test(id) && !noise.test(id) && !dateStamp.test(id));

  const isCodex = (id: string) => /codex/i.test(id);
  // Compare numeric generation components as a tuple, not a decimal:
  // 5.10 must sort AFTER 5.6 (Number("5.10") would incorrectly become 5.1).
  // Codex ids bypass newest-generation filtering via isCodex.
  const generation = (id: string): readonly [number, number] => {
    const m = id.match(/^gpt-(\d+)(?:\.(\d+))?/i);
    return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
  };
  const compareGeneration = (a: readonly [number, number], b: readonly [number, number]): number =>
    a[0] - b[0] || a[1] - b[1];
  const newest = candidates.reduce<readonly [number, number]>((max, id) => {
    const current = generation(id);
    return compareGeneration(current, max) > 0 ? current : max;
  }, [0, 0]);
  return candidates.filter((id) => isCodex(id) || compareGeneration(generation(id), newest) === 0).sort();
}

/** Ids must survive the settings-save validator (normalizeModelId's charset) and
 *  dispatch through the clean wire alias Clementine already uses (its presets are
 *  `claude-opus-4-8`, never the bracketed form). The Agent SDK reports the
 *  1M-context flagship as `claude-opus-5[1m]` — STRIP that `[…]` context
 *  annotation to the persistable base alias (`claude-opus-5`) rather than dropping
 *  the id, so a newly launched flagship actually reaches the picker. Date stamps
 *  strip to the base alias too. Pure. */
export function canonicalPickerId(id: string): string | null {
  const base = id.trim()
    .replace(/\[[^\]]*\]$/, '')  // Agent-SDK context annotation, e.g. "[1m]" — unpersistable + not a wire alias
    .replace(/-(20\d{6})$/, '');
  return /^[A-Za-z0-9._:-]+$/.test(base) ? base : null;
}

/** "claude-fable-5" → "Claude Fable 5"; API display_name wins when present. Pure. */
export function labelForModelId(id: string, displayName?: string | null): string {
  if (displayName && displayName.trim()) return displayName.trim();
  return id
    .replace(/-(\d{8})$/, '') // date-stamped snapshots read cleaner without the stamp
    .split('-')
    .map((part) => (/^\d/.test(part) ? part.replace(/_/g, '.') : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
    .replace(/\bGpt\b/g, 'GPT');
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, keepalive: false });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function discoverAnthropicViaApiKey(apiKey: string): Promise<DiscoveredModel[]> {
  const body = await fetchJson('https://api.anthropic.com/v1/models?limit=100', {
    'anthropic-version': '2023-06-01',
    'x-api-key': apiKey,
  }) as { data?: Array<{ id?: string; display_name?: string }> };
  return (body.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => typeof m?.id === 'string' && m.id.startsWith('claude'))
    .map((m) => ({ id: m.id, label: labelForModelId(m.id, m.display_name) }));
}

/** Subscription path: /v1/models rejects the Claude-Code OAuth grant (401), but
 *  the Agent SDK exposes supportedModels() — the models the user's SUBSCRIPTION
 *  can run, straight from the horse's mouth. One short-lived child per TTL. */
export function claudeSdkModelDiscoveryOptions(): Record<string, unknown> {
  return {
    maxTurns: 1,
    persistSession: false,
    // Model discovery is metadata, not an execution surface. Do not inherit
    // user/project settings, skills, built-ins, or configured MCP servers into
    // the short-lived SDK child.
    settingSources: [],
    skills: [],
    tools: [],
    allowedTools: [],
    mcpServers: {},
  };
}

async function discoverAnthropicViaSdk(): Promise<DiscoveredModel[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const accessToken = await loadFreshClaudeAccessToken();
  const q = query({ prompt: 'ok', options: { ...claudeSdkModelDiscoveryOptions(),
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: accessToken },
  } as never });
  try {
    const models = await (q as unknown as { supportedModels: () => Promise<Array<{ value?: string; resolvedModel?: string; displayName?: string }>> }).supportedModels();
    const out: DiscoveredModel[] = [];
    for (const m of models ?? []) {
      const raw = (m.resolvedModel || m.value || '').trim();
      if (!raw.startsWith('claude')) continue; // aliases resolve to claude-* wire ids
      const id = canonicalPickerId(raw);
      if (!id) continue; // e.g. bracketed context variants — unpersistable in settings
      // The SDK labels the flagship with picker CHROME ("Default (recommended)")
      // rather than a model name; ignore those so the id-derived name wins
      // ("Claude Opus 5"), and dedup collapses the [1m]/plain pair to one entry.
      const displayName = m.displayName && !/\b(default|recommended)\b/i.test(m.displayName) ? m.displayName : undefined;
      if (!out.some((x) => x.id === id)) out.push({ id, label: labelForModelId(id, displayName) });
    }
    return out;
  } finally {
    try { await (q as unknown as { interrupt: () => Promise<void> }).interrupt(); } catch { /* child cleanup is best-effort */ }
  }
}

async function discoverAnthropic(): Promise<DiscoveredModel[]> {
  const apiKey = (getRuntimeEnv('ANTHROPIC_API_KEY', '') ?? '').trim();
  if (apiKey) return discoverAnthropicViaApiKey(apiKey);
  if (getStoredClaudeTokens()?.accessToken) return discoverAnthropicViaSdk();
  return [];
}

/** The Codex backend lists the models a SUBSCRIPTION can run, filtered by the
 *  calling client's version (an old client sees an empty list). The catalog
 *  asks as the newest possible client so a model that has landed is listed;
 *  dispatch still identifies as the real client and the provider decides at
 *  call time. Listing is metadata: no completion is requested. */
export const CODEX_MODEL_CATALOG_URL = 'https://chatgpt.com/backend-api/codex/models';
export const CODEX_MODEL_CATALOG_CLIENT_VERSION = '9.9.9';

export interface CodexCatalogModel { slug?: string; visibility?: string; priority?: number; display_name?: string }

/** Pure: the backend's rows → picker choices. Hidden rows (review-only,
 *  reserved) stay out; the backend's own priority orders the rest. */
export function filterCodexCatalogModels(rows: readonly CodexCatalogModel[]): DiscoveredModel[] {
  return rows
    .filter((row): row is CodexCatalogModel & { slug: string } => typeof row?.slug === 'string' && row.slug.trim().length > 0)
    .filter((row) => (row.visibility ?? 'list') === 'list')
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || a.slug.localeCompare(b.slug))
    .map((row) => ({ id: row.slug, label: labelForModelId(row.slug, row.display_name) }));
}

function codexAccountIdFromJwt(token: string): string {
  try {
    const payload = token.split('.')[1] ?? '';
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'] as { chatgpt_account_id?: unknown } | undefined;
    return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : '';
  } catch { return ''; }
}

type CodexSubscription = { accessToken: string; accountId: string };
let codexSubscription: () => CodexSubscription | null = () => {
  const token = getStoredCodexOAuthTokens()?.accessToken?.trim();
  if (!token) return null;
  const accountId = codexAccountIdFromJwt(token);
  return accountId ? { accessToken: token, accountId } : null;
};

async function discoverCodexSubscription(): Promise<DiscoveredModel[]> {
  const subscription = codexSubscription();
  if (!subscription) return [];
  const body = await fetchJson(`${CODEX_MODEL_CATALOG_URL}?client_version=${CODEX_MODEL_CATALOG_CLIENT_VERSION}`, {
    authorization: `Bearer ${subscription.accessToken}`,
    'chatgpt-account-id': subscription.accountId,
    originator: 'codex_cli_rs',
    'user-agent': `Codex/${CODEX_MODEL_CATALOG_CLIENT_VERSION}`,
    accept: 'application/json',
  }) as { models?: CodexCatalogModel[] };
  return filterCodexCatalogModels(body.models ?? []);
}

/** OpenAI choices are the union of what an API key can see and what a Codex
 *  subscription can run; each source fails open on its own so one outage
 *  never hides the other's models. */
async function discoverOpenAi(): Promise<DiscoveredModel[]> {
  const settled = await Promise.allSettled([discoverOpenAiViaApiKey(), discoverCodexSubscription()]);
  const merged: DiscoveredModel[] = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const model of result.value) if (!merged.some((m) => m.id === model.id)) merged.push(model);
  }
  if (merged.length === 0 && settled.some((r) => r.status === 'rejected')) {
    throw (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
  }
  return merged;
}

async function discoverOpenAiViaApiKey(): Promise<DiscoveredModel[]> {
  const key = getOpenAiApiKey().trim(); // env → file vault (the daemon's real key)
  if (!key) return [];
  const body = await fetchJson('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` }) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === 'string');
  return filterOpenAiChatModelIds(ids).sort().map((id) => ({ id, label: labelForModelId(id) }));
}

function providerHasDiscoveryCredential(provider: ProviderName): boolean {
  if (provider === 'openai') return Boolean(getOpenAiApiKey().trim()) || codexSubscription() !== null;
  const apiKey = (getRuntimeEnv('ANTHROPIC_API_KEY', '') ?? '').trim();
  return Boolean(apiKey || getStoredClaudeTokens()?.accessToken);
}

function providerNeedsRefresh(provider: ProviderName, now = Date.now()): boolean {
  const current = cache[provider];
  const haveCredential = providerHasDiscoveryCredential(provider);
  if (current.phase === 'refreshing') return false;
  if (current.phase === 'idle') return true;
  // Login/logout should invalidate an unavailable/ready catalog immediately,
  // rather than waiting for the retry/TTL window.
  if (current.phase === 'unavailable' && haveCredential) return true;
  if (current.phase !== 'unavailable' && !haveCredential) return true;
  const stamp = current.phase === 'ready' ? current.fetchedAt : current.attemptedAt;
  const maxAge = current.phase === 'ready' ? TTL_MS : FAILURE_RETRY_MS;
  return stamp === null || now - stamp > maxAge;
}

function safeDiscoveryError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.trim().slice(0, 240) || 'Model catalog refresh failed.';
}

let discoverers: Record<ProviderName, () => Promise<DiscoveredModel[]>> = {
  anthropic: discoverAnthropic,
  openai: discoverOpenAi,
};

async function refreshProvider(provider: ProviderName): Promise<void> {
  const attemptedAt = Date.now();
  const current = cache[provider];
  if (!providerHasDiscoveryCredential(provider)) {
    cache[provider] = {
      ...current,
      phase: 'unavailable',
      modelCount: current.models.length,
      attemptedAt,
      error: undefined,
    };
    return;
  }

  try {
    const models = await discoverers[provider]();
    if (models.length === 0) {
      // Empty provider responses are not proof that a previously available
      // model disappeared. Retain the last-known catalog and retry soon.
      cache[provider] = {
        ...current,
        phase: 'degraded',
        modelCount: current.models.length,
        attemptedAt,
        error: 'Provider returned no compatible models; retrying.',
      };
      return;
    }
    cache[provider] = {
      models,
      phase: 'ready',
      modelCount: models.length,
      attemptedAt,
      fetchedAt: Date.now(),
      error: undefined,
    };
  } catch (err) {
    // A network/auth/schema failure must never erase the last-known choices or
    // demote a saved role binding. Keep cached models and retry within a minute.
    cache[provider] = {
      ...current,
      phase: 'degraded',
      modelCount: current.models.length,
      attemptedAt,
      error: safeDiscoveryError(err),
    };
  }
}

function ensureRefresh(): Promise<void> | null {
  if (refreshInFlight) return refreshInFlight;
  const targets = (['anthropic', 'openai'] as const).filter((provider) => providerNeedsRefresh(provider));
  if (targets.length === 0) return null;
  for (const provider of targets) {
    cache[provider] = { ...cache[provider], phase: 'refreshing', error: undefined };
  }
  refreshInFlight = Promise.all(targets.map((provider) => refreshProvider(provider)))
    .then(() => undefined)
    .catch(() => { /* refreshProvider is fail-open; this is a final backstop */ })
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

function statusSnapshot(): ModelDiscoveryStatus {
  const providerStatus = (provider: ProviderName): ModelDiscoveryProviderStatus => {
    const { phase, modelCount, attemptedAt, fetchedAt, error } = cache[provider];
    return { phase, modelCount, attemptedAt, fetchedAt, ...(error ? { error } : {}) };
  };
  return {
    refreshing: cache.anthropic.phase === 'refreshing' || cache.openai.phase === 'refreshing',
    providers: {
      anthropic: providerStatus('anthropic'),
      openai: providerStatus('openai'),
    },
  };
}

/** Sync cache read; kicks a background refresh when stale. Never throws. */
export function discoveredModels(): { anthropic: DiscoveredModel[]; openai: DiscoveredModel[] } {
  ensureRefresh();
  return { anthropic: cache.anthropic.models, openai: cache.openai.models };
}

/** Observable readiness for Settings/UI and diagnostics. Reading also starts a
 * stale refresh, so a cold first paint can truthfully render "refreshing". */
export function modelDiscoveryStatus(): ModelDiscoveryStatus {
  ensureRefresh();
  return statusSnapshot();
}

/** A sign-in just landed (or a sign-out): drop the provider's lease so the
 *  next read lists what the NEW credential can see, and start that read now
 *  instead of at the next picker visit. Never throws. */
export async function refreshModelDiscoveryNow(provider?: ProviderName): Promise<void> {
  // ensureRefresh coalesces onto whatever is in flight and adds no targets to
  // it; let that pass finish so this provider's read actually starts.
  if (refreshInFlight) { try { await refreshInFlight; } catch { /* fail-open */ } }
  const targets: ProviderName[] = provider ? [provider] : ['anthropic', 'openai'];
  for (const name of targets) {
    if (cache[name].phase === 'refreshing') continue;
    cache[name] = { ...cache[name], phase: 'idle' };
  }
  const pending = ensureRefresh();
  if (pending) await pending;
}

let heartbeat: ReturnType<typeof setInterval> | null = null;

/** Models land between picker visits. A daemon-lifetime tick at the catalog's
 *  own lease keeps the cache within one lease of the provider, so the next
 *  picker paint lists a model that dropped while the app sat open. Idempotent;
 *  the timer never holds the process open. */
export function startModelDiscoveryHeartbeat(intervalMs = TTL_MS): () => void {
  if (heartbeat) return () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };
  heartbeat = setInterval(() => { ensureRefresh(); }, Math.max(10, intervalMs));
  heartbeat.unref?.();
  return () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };
}

/** Test-only: pretend a Codex subscription is (or is not) signed in. */
export function _setCodexSubscriptionForTest(next: (() => CodexSubscription | null) | null): void {
  codexSubscription = next ?? (() => {
    const token = getStoredCodexOAuthTokens()?.accessToken?.trim();
    if (!token) return null;
    const accountId = codexAccountIdFromJwt(token);
    return accountId ? { accessToken: token, accountId } : null;
  });
}

/** Daemon-boot warmup. Waits only up to the caller's small startup budget; an
 * unfinished refresh continues in the background and remains visible via status. */
export async function warmModelDiscovery(timeoutMs = 2_500): Promise<ModelDiscoveryStatus> {
  const pending = ensureRefresh();
  if (!pending || timeoutMs <= 0) return statusSnapshot();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return statusSnapshot();
}

/** Test-only. */
export function _setDiscoveredModelsForTest(
  next: { anthropic?: DiscoveredModel[]; openai?: DiscoveredModel[] } | null,
  phase: Exclude<ModelDiscoveryPhase, 'idle' | 'refreshing'> = 'ready',
): void {
  refreshInFlight = null;
  if (!next) {
    cache = { anthropic: emptyProviderCache(), openai: emptyProviderCache() };
    return;
  }
  const now = Date.now();
  const seeded = (models: DiscoveredModel[]): ProviderCache => ({
    models,
    phase,
    modelCount: models.length,
    attemptedAt: now,
    fetchedAt: phase === 'ready' ? now : null,
    ...(phase === 'degraded' ? { error: 'Test-seeded degraded catalog.' } : {}),
  });
  cache = {
    anthropic: seeded(next.anthropic ?? []),
    openai: seeded(next.openai ?? []),
  };
}

/** Test-only dependency injection for deterministic warmup/failure coverage. */
export function _setModelDiscoverersForTest(
  next: Partial<Record<ProviderName, () => Promise<DiscoveredModel[]>>> | null,
): void {
  discoverers = next
    ? { anthropic: next.anthropic ?? discoverAnthropic, openai: next.openai ?? discoverOpenAi }
    : { anthropic: discoverAnthropic, openai: discoverOpenAi };
}
