/**
 * Multi-provider BYO registry. Lets a user connect SEVERAL OpenAI-compatible
 * providers at once (GLM/Z.ai + DeepSeek + MiniMax …) and routes each model id
 * to the provider that OWNS it, so brain=glm-5.2 (Z.ai), workers=deepseek-chat
 * (DeepSeek) and judge=MiniMax-M3 (MiniMax) each hit their own key + endpoint.
 *
 * Back-compat is the whole point: when no `BYO_PROVIDERS` registry is set, the
 * legacy single `BYO_MODEL_*` config is migrated into a one-element ['default']
 * registry, and `resolveByoProviderForModel` returns that single backend for
 * every id — byte-identical to the pre-registry single-BYO behavior. Metadata
 * (id/label/baseURL/modelIds) lives in the `BYO_PROVIDERS` JSON env key; each
 * provider's secret lives in the vault/env via getByoProviderApiKey — never in
 * the JSON.
 */
import {
  getRuntimeEnv,
  getByoBackendConfig,
  getByoProviderApiKey,
  getModelRoutingMode,
  type ByoBackendConfig,
  type ModelRoutingMode,
} from '../../config.js';
import { resolveProvider, type ModelProviderClass } from './model-wire-registry.js';
import { claudeAvailable } from './judge-family.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.byo-providers' });

export interface ByoProvider {
  /** Stable slug, e.g. 'default', 'zai', 'deepseek'. */
  id: string;
  /** Cosmetic label, e.g. 'GLM (Z.ai)'. Not part of routing identity. */
  label: string;
  baseURL: string;
  /** The model ids this provider serves (user-declared at connect time). */
  modelIds: string[];
}

/** BYO ids may include '/' (OpenRouter-style) — looser than normalizeModelId. */
function cleanId(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9._:/-]+$/.test(s) ? s : '';
}

/**
 * The connected BYO providers. The 'default' provider is ALWAYS the legacy
 * single backend (`BYO_MODEL_*`), so getByoBackendConfig() — read by
 * configureHarnessRuntime's all_in check and other callers — stays consistent
 * and a single-BYO user is byte-identical. The `BYO_PROVIDERS` JSON registry
 * holds only the EXTRA (non-default) providers added through the multi-provider
 * UI. Each provider's key lives in the vault/env (getByoProviderApiKey), never
 * in the JSON.
 */
export function getByoProviders(): ByoProvider[] {
  const providers: ByoProvider[] = [];

  // 'default' = the legacy single backend (authoritative), if configured.
  const legacy = getByoBackendConfig();
  if (legacy.configured || legacy.baseURL) {
    const worker = cleanId((getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '').trim());
    // OPENAI_MODEL_WORKER is a shared legacy slot. Outside all_in, a built-in-
    // shaped id is not BYO ownership proof; inside all_in the mode is itself the
    // explicit provider choice, so preserve legitimate same-endpoint models such
    // as primary=glm-5.2 + worker=gpt-4o.
    const byoWorker = worker && (getModelRoutingMode() === 'all_in' || resolveProvider(worker) === 'byo') ? worker : '';
    const modelIds = [legacy.primaryId, legacy.judgeId, byoWorker]
      .map(cleanId)
      .filter(Boolean);
    providers.push({ id: 'default', label: legacy.providerLabel, baseURL: legacy.baseURL, modelIds: Array.from(new Set(modelIds)) });
  }

  // Extra providers from the registry (anything but 'default').
  const raw = (getRuntimeEnv('BYO_PROVIDERS', '') || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<Partial<ByoProvider>>;
      for (const p of Array.isArray(parsed) ? parsed : []) {
        const id = cleanId(p?.id);
        const baseURL = typeof p?.baseURL === 'string' ? p.baseURL.trim() : '';
        if (!id || id === 'default' || !baseURL) continue;
        if (providers.some((x) => x.id === id)) continue;
        providers.push({
          id,
          label: typeof p?.label === 'string' ? p.label.trim().slice(0, 40) : '',
          baseURL,
          modelIds: Array.isArray(p?.modelIds) ? p!.modelIds!.map(cleanId).filter(Boolean) : [],
        });
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'BYO_PROVIDERS parse failed — ignoring extra providers',
      );
    }
  }

  return providers;
}

/** Build the per-call ByoBackendConfig getByoModel wants for a provider,
 *  pulling its key from the vault/env. `primaryId` is the provider's OWN primary
 *  model (its first declared id) — NOT the requested model id. The router's
 *  all_in codex-collapse (`resolveProvider(name)==='codex' ? backend.primaryId
 *  : name`) reads primaryId to remap a stray gpt-* id onto the BYO model, so it
 *  MUST be the provider's real model (e.g. glm-5.2), never the gpt-* id that was
 *  requested — otherwise a gpt-* id gets sent verbatim to the BYO endpoint. The
 *  model actually sent on the wire is passed to getByoModel separately. */
export function providerToBackendConfig(p: ByoProvider): ByoBackendConfig {
  const apiKey = getByoProviderApiKey(p.id);
  return {
    configured: Boolean(p.baseURL && apiKey),
    baseURL: p.baseURL,
    apiKey,
    primaryId: p.modelIds[0] || '',
    judgeId: p.modelIds[0] || '',
    providerLabel: p.label,
  };
}

/** Configured BYO providers that explicitly expose a model id. This includes
 * the migrated default provider's worker slot for collision detection even
 * though that legacy slot alone is not strong enough to claim a built-in-shaped
 * id during normal routing. */
export function configuredByoProvidersForModel(modelId: string): ByoProvider[] {
  const id = (modelId || '').trim();
  if (!id) return [];
  return getByoProviders().filter((provider) =>
    provider.modelIds.includes(id) && providerToBackendConfig(provider).configured,
  );
}

function providerList(owners: ByoProvider[]): string {
  return owners.map((owner) => owner.label || owner.id).join(', ');
}

/** Why an unqualified model id cannot be routed safely. Model ids are legacy
 * identity; until persisted bindings become provider-qualified, duplicate ids
 * must fail closed rather than silently choosing a key/endpoint. `all_in` is
 * itself an explicit BYO provider choice, so a built-in-shaped BYO id is safe
 * there, but two BYO owners remain ambiguous in every mode. */
export function unqualifiedModelCollisionReason(
  modelId: string,
  mode: ModelRoutingMode = getModelRoutingMode(),
): string | undefined {
  const id = (modelId || '').trim();
  if (!id) return undefined;
  const owners = configuredByoProvidersForModel(id);
  if (owners.length > 1) {
    return `Model ${id} is exposed by multiple connected BYO providers (${providerList(owners)}). `
      + 'Provider-qualified model identity is required; remove the duplicate model id before selecting or binding it.';
  }
  const builtIn = resolveProvider(id);
  if (mode !== 'all_in' && owners.length === 1 && builtIn !== 'byo') {
    const label = builtIn === 'codex' ? 'Codex' : 'Claude';
    return `Model ${id} is exposed by both ${label} and BYO provider ${providerList(owners)}. `
      + 'Provider-qualified model identity is required; rename or remove the duplicate BYO model id before selecting or binding it.';
  }
  return undefined;
}

export function assertUnambiguousModelRouting(
  modelId: string,
  mode: ModelRoutingMode = getModelRoutingMode(),
): void {
  const reason = unqualifiedModelCollisionReason(modelId, mode);
  if (reason) throw new Error(reason);
}

/** Provider class the router will actually use for an unqualified model id.
 * Unlike resolveProvider's wire-shape classifier, this understands declared BYO
 * ownership and all-in provider isolation. It throws on identity collisions. */
export function resolveEffectiveProviderForModel(
  modelId: string,
  mode: ModelRoutingMode = getModelRoutingMode(),
): ModelProviderClass {
  const id = (modelId || '').trim();
  assertUnambiguousModelRouting(id, mode);
  const owners = configuredByoProvidersForModel(id);
  if (mode === 'all_in') {
    // Explicit claude ids dispatch on the claude lane (2026-07-24, second
    // pass): the all-in collapse silently rewrote a workflow's Sonnet pin to
    // the BYO primary at the wire (requested claude-sonnet-5 → resolved
    // glm-5.2) — an honest system may refuse, but never silently substitute.
    // Safe NOW because the per-request transport router (v2.7.3) makes the
    // claude harness lane tool-capable; the text-only crash class that
    // justified the collapse is retired. gpt-shaped ids keep the collapse
    // (the 2026-07-22 undeclared-worker-default guard); a disconnected
    // Claude falls through to the collapse as before.
    if (owners.length === 0 && resolveProvider(id) === 'claude') {
      try {
        if (claudeAvailable()) return 'claude';
      } catch { /* availability probe is best-effort */ }
    }
    const defaultByo = getByoBackendConfig();
    if (defaultByo.configured || owners.length === 1) return 'byo';
  }
  if (owners.length === 1) return 'byo';
  return resolveProvider(id);
}

/**
 * all_in routing classifies ANY model id as 'byo' once a default BYO backend
 * is configured — including ids no BYO provider actually serves (e.g. the
 * gpt-* worker default). The backend then 400s "Unknown Model" and every
 * worker routed there dies (live 2026-07-22: 5/5 workers DOA). When a
 * byo-routed id has no owning provider, substitute the default BYO backend's
 * primary id so the call lands on a model the provider actually has.
 */
// Ids the BYO backend has PROVEN it does not serve (a 400 "unknown model"
// class response). Config cannot know this up front — the legacy shim lists
// the shared worker slot as "offered" because aggregator endpoints (Together,
// OpenRouter) genuinely serve foreign ids, while single-family endpoints
// (z.ai) 400 on them. The provider's own rejection is the truth; learn it
// once and translate thereafter (live 2026-07-22: gpt-5.4 → z.ai, 17 dead
// workers across two tests before this memo existed).
const byoNotServedIds = new Set<string>();

export function markByoModelNotServed(modelId: string): void {
  const id = (modelId || '').trim();
  if (id) byoNotServedIds.add(id);
}

export function isByoModelNotServed(modelId: string): boolean {
  return byoNotServedIds.has((modelId || '').trim());
}

export function clearByoNotServedForTest(): void {
  byoNotServedIds.clear();
}

/** True when an error text is the provider's unknown-model rejection class. */
export function looksLikeUnknownModelError(text: string | null | undefined): boolean {
  return /unknown model|model not (?:found|exist|supported)|no such model|invalid model(?: code| id)?|does not exist.{0,20}model/i.test(text ?? '');
}

export function repairByoRoutedModelId(modelId: string): string {
  const id = (modelId || '').trim();
  if (!id) return id;
  if (!isByoModelNotServed(id) && configuredByoProvidersForModel(id).length > 0) return id;
  const cfg = getByoBackendConfig();
  const primary = cfg.configured && cfg.primaryId ? cfg.primaryId : id;
  // Never "repair" to another known-dead id.
  return isByoModelNotServed(primary) ? id : primary;
}

/**
 * Resolve a model id -> the backend config of the provider that OWNS it.
 * Duplicate exact owners fail closed until persisted identity is provider-
 * qualified. When exactly one provider exists it owns everything (preserves
 * single-backend all_in/worker semantics). Returns undefined when no provider
 * claims the id, so this never broadens which ids hit BYO.
 */
export function resolveByoProviderForModel(modelId: string): ByoBackendConfig | undefined {
  const id = (modelId || '').trim();
  if (!id) return undefined;
  const providers = getByoProviders();
  if (providers.length === 0) return undefined;

  const collision = unqualifiedModelCollisionReason(id, 'all_in');
  if (collision) throw new Error(collision);

  const configuredOwners = configuredByoProvidersForModel(id);
  if (configuredOwners.length === 1) return providerToBackendConfig(configuredOwners[0]);
  const anyOwner = providers.find((p) => p.modelIds.includes(id));
  if (anyOwner) return providerToBackendConfig(anyOwner);

  // Single provider owns everything (byte-identical single-backend behavior).
  if (providers.length === 1) return providerToBackendConfig(providers[0]);

  return undefined;
}

/** Resolve only an explicitly declared model id. Unlike
 * resolveByoProviderForModel, this never applies the single-provider catch-all,
 * so a BYO provider can serve `gpt-*` or `claude-*` without accidentally
 * claiming every built-in model. A named provider's explicit model list wins.
 * The migrated default owns its primary/judge ids, plus its explicit worker id
 * only in all_in where the routing mode has already selected BYO. */
export function resolveDeclaredByoProviderForModel(modelId: string): ByoBackendConfig | undefined {
  const id = (modelId || '').trim();
  if (!id) return undefined;
  const collision = unqualifiedModelCollisionReason(id, 'all_in');
  if (collision) throw new Error(collision);
  const owners = configuredByoProvidersForModel(id);
  const explicit = owners.find((provider) => provider.id !== 'default');
  if (explicit) return providerToBackendConfig(explicit);
  const defaultProvider = owners.find((provider) => provider.id === 'default');
  if (!defaultProvider) return undefined;
  const declared = getByoBackendConfig();
  const worker = (getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '').trim();
  const ownsModel = id === declared.primaryId
    || id === declared.judgeId
    || (getModelRoutingMode() === 'all_in' && id === worker);
  return ownsModel ? providerToBackendConfig(defaultProvider) : undefined;
}

// ── persistence helpers (pure — the console route does the updateEnvKey writes) ──

/** The env key that stores a provider's API key. 'default' reuses the legacy
 *  single-backend slot; others use a per-id slot. Mirrors getByoProviderApiKey. */
export function byoProviderKeyEnvKey(providerId: string): string {
  const id = (providerId || 'default').trim();
  if (id === 'default') return 'BYO_MODEL_API_KEY';
  // Hyphens → underscores for a valid env-var token; MUST match getByoProviderApiKey().
  const slug = id.replace(/[^A-Za-z0-9]/g, '_');
  return `BYO_PROVIDER_${slug.toUpperCase()}_API_KEY`;
}

/** Derive a stable provider slug from a label/base URL. Never 'default'. */
export function slugifyProviderId(input: string): string {
  const slug = (input || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return slug && slug !== 'default' ? slug : 'provider';
}

/** Serialize the EXTRA (non-'default') providers for the BYO_PROVIDERS env key. */
export function serializeExtraProviders(providers: ByoProvider[]): string {
  const extras = providers
    .filter((p) => p.id !== 'default')
    .map((p) => ({ id: p.id, label: p.label, baseURL: p.baseURL, modelIds: p.modelIds }));
  return JSON.stringify(extras);
}

export interface ByoProviderSnapshot {
  id: string;
  label: string;
  baseURL: string;
  modelIds: string[];
  hasKey: boolean;
  configured: boolean;
  isDefault: boolean;
}

/** Non-secret snapshot of every connected provider, for the settings API/UI. */
export function getByoProviderSnapshots(): ByoProviderSnapshot[] {
  return getByoProviders().map((p) => {
    const cfg = providerToBackendConfig(p);
    return {
      id: p.id,
      label: p.label,
      baseURL: p.baseURL,
      modelIds: p.modelIds,
      hasKey: Boolean(cfg.apiKey),
      configured: cfg.configured,
      isDefault: p.id === 'default',
    };
  });
}

// ── model discovery (generic — any OpenAI-compatible provider) ──────────────
// A provider exposes its catalog at `GET {baseURL}/models`. We fetch it with the
// provider's key and normalize to a flat id/label list so the settings UI can let
// users PICK models instead of hand-typing long namespaced ids. Pure + injectable
// so it unit-tests without Express or a live provider.

export interface DiscoveredModel {
  id: string;
  /** Optional human label (provider `display_name`), falls back to id in the UI. */
  label?: string;
}

/**
 * Normalize a `/models` payload into a flat, sorted, deduped id/label list.
 * Accepts the OpenAI/Together shape `{ object:'list', data:[{ id, ... }] }` OR a
 * bare array (of strings or objects). Drops ids failing `cleanId` (so every
 * returned id is routable). Never throws — returns `[]` on garbage.
 */
export function normalizeModelsList(raw: unknown): DiscoveredModel[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
      ? (raw as { data: unknown[] }).data
      : [];
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const id = cleanId(typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const dn = item && typeof item === 'object' ? (item as { display_name?: unknown }).display_name : undefined;
    out.push({ id, label: typeof dn === 'string' && dn.trim() ? dn.trim() : undefined });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** http(s)-only URL parse; null on anything else (other protocols / unparseable). */
function safeParseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export interface DiscoverModelsResult {
  status: number;
  body: { models: DiscoveredModel[] } | { error: string };
}

/**
 * Fetch + normalize a provider's model catalog. Plain `fetch` (not getByoModel's
 * wrapped client — `/models` is a plain GET, the chat-completions wrapper is
 * irrelevant). Maps provider failures to precise statuses and NEVER echoes the
 * key. `fetchImpl` is injectable for tests. localhost is intentionally allowed
 * (local Ollama/vLLM is a legit BYO setup; the route's auth gate guards access).
 */
export async function discoverProviderModels(
  input: { baseURL: string; apiKey: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<DiscoverModelsResult> {
  const baseURL = (input.baseURL || '').trim();
  const apiKey = (input.apiKey || '').trim();
  if (!safeParseHttpUrl(baseURL)) return { status: 400, body: { error: 'A valid http(s) base URL is required.' } };
  if (!apiKey) return { status: 400, body: { error: 'An API key is required to list models.' } };

  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { status: 504, body: { error: aborted ? 'The provider timed out listing models.' : 'Could not reach the provider.' } };
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) return { status: 401, body: { error: 'The provider rejected the API key.' } };
  if (resp.status === 404) return { status: 404, body: { error: 'This provider has no /models endpoint — enter model ids manually.' } };
  if (!resp.ok) return { status: 502, body: { error: `The provider returned ${resp.status} listing models.` } };

  const json = (await resp.json().catch(() => null)) as unknown;
  return { status: 200, body: { models: normalizeModelsList(json) } };
}
