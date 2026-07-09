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
import { getStoredClaudeTokens } from '../claude-oauth.js';

export interface DiscoveredModel { id: string; label: string }

const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

let cache: { anthropic: DiscoveredModel[]; openai: DiscoveredModel[]; fetchedAt: number } = {
  anthropic: [],
  openai: [],
  fetchedAt: 0,
};
let refreshInFlight: Promise<void> | null = null;

/** OpenAI /v1/models returns EVERYTHING (embeddings, audio, images, gpt-3.5…).
 *  Keep families the codex_responses wire actually runs — gpt-5+ / o-series /
 *  codex-* (gpt-3/4-era models predate the Codex backend and would 400 there) —
 *  and drop date-stamped snapshots (near-duplicate picker noise). Pure. */
export function filterOpenAiChatModelIds(ids: string[]): string[] {
  const include = /^(gpt-(?:[5-9]|[1-9][0-9])|o[0-9]|codex)/i;
  const exclude = /(embed|audio|realtime|whisper|tts|dall-e|image|moderation|transcribe|search|-instruct)/i;
  const dateStamp = /-(20\d{2}-\d{2}-\d{2}|20\d{6})$/;
  return ids.filter((id) => include.test(id) && !exclude.test(id) && !dateStamp.test(id));
}

/** Ids must survive the settings-save validator (normalizeModelId's charset) —
 *  offering an unpersistable id (e.g. a bracketed context-variant) would make the
 *  picker silently revert on save. Date stamps strip to the base alias. Pure. */
export function canonicalPickerId(id: string): string | null {
  const base = id.trim().replace(/-(20\d{6})$/, '');
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
async function discoverAnthropicViaSdk(): Promise<DiscoveredModel[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query({ prompt: 'ok', options: { maxTurns: 1, persistSession: false, allowedTools: [] } as never });
  try {
    const models = await (q as unknown as { supportedModels: () => Promise<Array<{ value?: string; resolvedModel?: string; displayName?: string }>> }).supportedModels();
    const out: DiscoveredModel[] = [];
    for (const m of models ?? []) {
      const raw = (m.resolvedModel || m.value || '').trim();
      if (!raw.startsWith('claude')) continue; // aliases resolve to claude-* wire ids
      const id = canonicalPickerId(raw);
      if (!id) continue; // e.g. bracketed context variants — unpersistable in settings
      if (!out.some((x) => x.id === id)) out.push({ id, label: labelForModelId(id, m.displayName) });
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

async function discoverOpenAi(): Promise<DiscoveredModel[]> {
  const key = getOpenAiApiKey().trim(); // env → file vault (the daemon's real key)
  if (!key) return [];
  const body = await fetchJson('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` }) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === 'string');
  return filterOpenAiChatModelIds(ids).sort().map((id) => ({ id, label: labelForModelId(id) }));
}

const FAILURE_RETRY_MS = 60 * 1000;

async function refresh(): Promise<void> {
  const [anthropic, openai] = await Promise.allSettled([discoverAnthropic(), discoverOpenAi()]);
  // A refresh that produced NOTHING (both failed, or both came back empty —
  // the boot-time shape: the daemon's first settings poll fires while network/
  // keys are still settling) must NOT claim the full TTL: stamping 6h on a
  // failure locked the picker to presets-only for the whole session (live
  // 2026-07-09: three freshly-dropped gpt-5.6 models invisible all day).
  // Back-date the stamp so the next poll retries within a minute; a refresh
  // with ANY real result keeps the full TTL.
  const nextAnthropic = anthropic.status === 'fulfilled' ? anthropic.value : cache.anthropic;
  const nextOpenai = openai.status === 'fulfilled' ? openai.value : cache.openai;
  const producedAnything = nextAnthropic.length > 0 || nextOpenai.length > 0;
  cache = {
    anthropic: nextAnthropic,
    openai: nextOpenai,
    fetchedAt: producedAnything ? Date.now() : Date.now() - (TTL_MS - FAILURE_RETRY_MS),
  };
}

/** Sync cache read; kicks a background refresh when stale. Never throws. */
export function discoveredModels(): { anthropic: DiscoveredModel[]; openai: DiscoveredModel[] } {
  if (Date.now() - cache.fetchedAt > TTL_MS && !refreshInFlight) {
    refreshInFlight = refresh()
      .catch(() => { /* fail-open: presets remain the floor */ })
      .finally(() => { refreshInFlight = null; });
  }
  return { anthropic: cache.anthropic, openai: cache.openai };
}

/** Test-only. */
export function _setDiscoveredModelsForTest(next: { anthropic?: DiscoveredModel[]; openai?: DiscoveredModel[] } | null): void {
  cache = next
    ? { anthropic: next.anthropic ?? [], openai: next.openai ?? [], fetchedAt: Date.now() }
    : { anthropic: [], openai: [], fetchedAt: 0 };
}
