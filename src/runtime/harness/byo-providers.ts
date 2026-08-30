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
import { getStoredXaiOAuthTokens } from '../xai-auth-bridge.js';
import { claudeAvailable } from './judge-family.js';
import pino from 'pino';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
/** The xAI provider slug. Its credential may arrive by SUBSCRIPTION OAUTH
 *  rather than a typed key, so it is the one provider whose secret has two
 *  legitimate sources. */
export const XAI_PROVIDER_ID = 'xai';


/**
 * What each provider actually SERVES, learned from its own catalog.
 *
 * `modelIds` means "the models this provider offers" — the code that mints a
 * provider with `modelIds: []` says so directly: "Refresh fills them". But
 * nothing filled them without a person opening Settings, and for the legacy
 * `default` provider the list was never a catalog at all: it is built from
 * [primaryId, judgeId, worker], i.e. the models ALREADY ASSIGNED to roles. So
 * that picker could only ever offer what had already been picked, and a model
 * the provider had just launched could never be selected by any amount of
 * refreshing.
 *
 * Observed 2026-08-25: Z.ai served glm-4.5 through glm-5.3 while Clementine
 * offered only glm-5.2; Moonshot served four Kimi models while Clementine
 * offered one.
 *
 * The daemon already lists every configured provider's catalog on start
 * (warmByoProviderCatalogs) and was discarding the ids. It now records them
 * here, and the ids are UNIONED into modelIds — never subtracted — so a model
 * in active use can never disappear because a catalog call came back thin, and
 * a newly published model shows up on its own.
 */
/** Model types that can hold a conversation turn. Anything a provider labels
 *  image/video/audio/embedding/rerank/moderation cannot, and does not belong in
 *  a model picker. */
const CONVERSATIONAL_MODEL_KINDS = new Set(['chat', 'language', 'code']);

const DISCOVERED_MODELS_FILE = 'byo-discovered-models.json';
let discoveredCache: { mtimeMs: number; byProvider: Record<string, string[]> } | undefined;

function discoveredModelsPath(): string | null {
  try {
    const base = process.env.CLEMENTINE_HOME?.trim() || path.join(os.homedir(), '.clementine-next');
    return path.join(base, 'state', DISCOVERED_MODELS_FILE);
  } catch {
    return null;
  }
}

export function readDiscoveredProviderModels(): Record<string, string[]> {
  const file = discoveredModelsPath();
  if (!file) return {};
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (discoveredCache?.mtimeMs === mtimeMs) return discoveredCache.byProvider;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    const byProvider: Record<string, string[]> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [providerId, ids] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(ids)) continue;
        byProvider[providerId] = ids
          .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
          .map((id) => id.trim());
      }
    }
    discoveredCache = { mtimeMs, byProvider };
    return byProvider;
  } catch {
    // A malformed cache must never cost the user their configured models.
    return {};
  }
}

export function recordDiscoveredProviderModels(providerId: string, ids: readonly string[]): void {
  const file = discoveredModelsPath();
  if (!file || !providerId.trim()) return;
  const clean = ids.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean);
  // An empty or failed listing is not evidence that a provider stopped serving
  // anything, so it never overwrites what was learned before.
  if (clean.length === 0) return;
  try {
    const current = { ...readDiscoveredProviderModels() };
    const previous = current[providerId] ?? [];
    if (previous.length === clean.length && previous.every((id, index) => id === clean[index])) return;
    current[providerId] = clean;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf-8');
    discoveredCache = undefined;
  } catch {
    // Learning the catalog is additive; failing to persist it must not break
    // model selection or daemon start.
  }
}

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

  // A subscription grant with no registry row still needs a handle: Settings
  // Browse/Refresh and the role dropdowns read this list. Empty modelIds are
  // honest — Refresh fills them. Never invent a Grok id here.
  if (getStoredXaiOAuthTokens() && !providers.some((p) => p.id === XAI_PROVIDER_ID)) {
    providers.push({
      id: XAI_PROVIDER_ID,
      label: 'xAI (Grok)',
      baseURL: 'https://api.x.ai/v1',
      modelIds: [],
    });
  }

  // Union in what each provider was last observed to SERVE. Additive only: a
  // model that is configured or in use is never removed by a thin catalog
  // response, and a newly published model becomes selectable without anyone
  // reopening Settings.
  const discovered = readDiscoveredProviderModels();
  for (const provider of providers) {
    const learned = discovered[provider.id];
    if (!learned?.length) continue;
    const merged = new Set(provider.modelIds);
    for (const id of learned) merged.add(id);
    provider.modelIds = Array.from(merged);
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

/**
 * The credential for a provider.
 *
 * An explicitly typed key always wins: a user who pasted one is telling us
 * which credential to bill, and silently preferring a subscription grant over
 * that would spend the wrong account. Only when no key was typed does a
 * connected xAI OAuth grant supply the bearer.
 *
 * Sync by design, matching the caller. Refresh is the auth store's job — this
 * returns whatever is currently stored, and an expired token surfaces as a
 * provider 401 rather than being silently papered over here.
 */
function providerCredential(providerId: string): string {
  const typed = getByoProviderApiKey(providerId);
  if (typed) return typed;
  if (providerId !== XAI_PROVIDER_ID) return '';
  return getStoredXaiOAuthTokens()?.accessToken ?? '';
}

export function providerToBackendConfig(p: ByoProvider): ByoBackendConfig {
  const apiKey = providerCredential(p.id);
  // xAI on the OAuth grant (no typed key): access tokens are short-lived, so
  // the wire client must resolve a FRESH bearer per request — otherwise the
  // first post-expiry call 401s and the brain is falsely marked auth-dead.
  const oauthBacked = p.id === XAI_PROVIDER_ID
    && !getByoProviderApiKey(p.id)
    && Boolean(getStoredXaiOAuthTokens());
  return {
    configured: Boolean(p.baseURL && apiKey),
    baseURL: p.baseURL,
    apiKey,
    primaryId: p.modelIds[0] || '',
    judgeId: p.modelIds[0] || '',
    providerLabel: p.label,
    ...(oauthBacked
      ? {
          refreshBearer: async () => {
            const { refreshNativeXaiTokens } = await import('../xai-native-oauth.js');
            const { getFreshXaiAccessToken } = await import('../auth-store.js');
            return getFreshXaiAccessToken(refreshNativeXaiTokens);
          },
        }
      : {}),
  };
}

export interface ByoRoutingProviderSnapshot {
  readonly provider: Readonly<Omit<ByoProvider, 'modelIds'> & { modelIds: readonly string[] }>;
  readonly backend: Readonly<ByoBackendConfig>;
}

export interface ByoRoutingSnapshot {
  readonly mode: ModelRoutingMode;
  readonly workerModel: string;
  readonly defaultBackend: Readonly<ByoBackendConfig>;
  readonly claudeAvailable: boolean;
  readonly providers: readonly ByoRoutingProviderSnapshot[];
  readonly ownersForModel: (modelId: string) => readonly ByoRoutingProviderSnapshot[];
  readonly configuredOwnersForModel: (modelId: string) => readonly ByoRoutingProviderSnapshot[];
  readonly hasConnectedModel: (modelId: string) => boolean;
}

/**
 * One coherent, request-scoped view of dynamic BYO routing state.
 *
 * The snapshot is intentionally NOT memoized across requests: Settings writes
 * mutate runtime env live, and the next request must see them. Within one
 * derivation, however, model ownership/configuration is indexed once so a
 * provider catalog with hundreds of models never rereads `.env` per model.
 */
export function captureByoRoutingSnapshot(): ByoRoutingSnapshot {
  const mode = getModelRoutingMode();
  const workerModel = (getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '').trim();
  const defaultBackend = Object.freeze({ ...getByoBackendConfig() });
  const providers = Object.freeze(getByoProviders().map((rawProvider) => {
    const provider = Object.freeze({
      ...rawProvider,
      modelIds: Object.freeze([...rawProvider.modelIds]),
    });
    const backend = Object.freeze({ ...providerToBackendConfig(rawProvider) });
    return Object.freeze({ provider, backend });
  }));

  const owners = new Map<string, ByoRoutingProviderSnapshot[]>();
  const configuredOwners = new Map<string, ByoRoutingProviderSnapshot[]>();
  const connectedModels = new Set<string>();
  for (const row of providers) {
    for (const modelId of row.provider.modelIds) {
      const allRows = owners.get(modelId);
      if (allRows) allRows.push(row);
      else owners.set(modelId, [row]);
      if (!row.backend.configured) continue;
      connectedModels.add(modelId);
      const configuredRows = configuredOwners.get(modelId);
      if (configuredRows) configuredRows.push(row);
      else configuredOwners.set(modelId, [row]);
    }
  }
  const freezeIndex = (
    source: Map<string, ByoRoutingProviderSnapshot[]>,
  ): Map<string, readonly ByoRoutingProviderSnapshot[]> => {
    const target = new Map<string, readonly ByoRoutingProviderSnapshot[]>();
    for (const [modelId, rows] of source) target.set(modelId, Object.freeze([...rows]));
    return target;
  };
  const frozenOwners = freezeIndex(owners);
  const frozenConfiguredOwners = freezeIndex(configuredOwners);
  const none = Object.freeze([]) as readonly ByoRoutingProviderSnapshot[];

  return Object.freeze({
    mode,
    workerModel,
    defaultBackend,
    claudeAvailable: claudeAvailable(),
    providers,
    ownersForModel: (modelId: string) => frozenOwners.get(modelId) ?? none,
    configuredOwnersForModel: (modelId: string) => frozenConfiguredOwners.get(modelId) ?? none,
    hasConnectedModel: (modelId: string) => connectedModels.has(modelId),
  });
}

/** Configured BYO providers that explicitly expose a model id. This includes
 * the migrated default provider's worker slot for collision detection even
 * though that legacy slot alone is not strong enough to claim a built-in-shaped
 * id during normal routing. */
export function configuredByoProvidersForModel(modelId: string): ByoProvider[] {
  return configuredByoProvidersForModelFromSnapshot(modelId, captureByoRoutingSnapshot())
    .map((row) => ({ ...row.provider, modelIds: [...row.provider.modelIds] }));
}

export function configuredByoProvidersForModelFromSnapshot(
  modelId: string,
  snapshot: ByoRoutingSnapshot,
): readonly ByoRoutingProviderSnapshot[] {
  const id = (modelId || '').trim();
  return id ? snapshot.configuredOwnersForModel(id) : [];
}

function providerList(owners: readonly ByoRoutingProviderSnapshot[]): string {
  return owners.map(({ provider }) => provider.label || provider.id).join(', ');
}

/** Why an unqualified model id cannot be routed safely. Model ids are legacy
 * identity; until persisted bindings become provider-qualified, duplicate ids
 * must fail closed rather than silently choosing a key/endpoint. `all_in` is
 * itself an explicit BYO provider choice, so a built-in-shaped BYO id is safe
 * there, but two BYO owners remain ambiguous in every mode. */
export function unqualifiedModelCollisionReason(
  modelId: string,
  mode?: ModelRoutingMode,
): string | undefined {
  const snapshot = captureByoRoutingSnapshot();
  return unqualifiedModelCollisionReasonFromSnapshot(modelId, snapshot, mode ?? snapshot.mode);
}

export function unqualifiedModelCollisionReasonFromSnapshot(
  modelId: string,
  snapshot: ByoRoutingSnapshot,
  mode: ModelRoutingMode = snapshot.mode,
): string | undefined {
  const id = (modelId || '').trim();
  if (!id) return undefined;
  const owners = snapshot.configuredOwnersForModel(id);
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
  mode?: ModelRoutingMode,
): void {
  const snapshot = captureByoRoutingSnapshot();
  assertUnambiguousModelRoutingFromSnapshot(modelId, snapshot, mode ?? snapshot.mode);
}

export function assertUnambiguousModelRoutingFromSnapshot(
  modelId: string,
  snapshot: ByoRoutingSnapshot,
  mode: ModelRoutingMode = snapshot.mode,
): void {
  const reason = unqualifiedModelCollisionReasonFromSnapshot(modelId, snapshot, mode);
  if (reason) throw new Error(reason);
}

/** Provider class the router will actually use for an unqualified model id.
 * Unlike resolveProvider's wire-shape classifier, this understands declared BYO
 * ownership and all-in provider isolation. It throws on identity collisions. */
export function resolveEffectiveProviderForModel(
  modelId: string,
  mode?: ModelRoutingMode,
): ModelProviderClass {
  const snapshot = captureByoRoutingSnapshot();
  return resolveEffectiveProviderForModelFromSnapshot(modelId, snapshot, mode ?? snapshot.mode);
}

export function resolveEffectiveProviderForModelFromSnapshot(
  modelId: string,
  snapshot: ByoRoutingSnapshot,
  mode: ModelRoutingMode = snapshot.mode,
): ModelProviderClass {
  const id = (modelId || '').trim();
  assertUnambiguousModelRoutingFromSnapshot(id, snapshot, mode);
  const owners = snapshot.configuredOwnersForModel(id);
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
    if (owners.length === 0 && resolveProvider(id) === 'claude' && snapshot.claudeAvailable) return 'claude';
    if (snapshot.defaultBackend.configured || owners.length === 1) return 'byo';
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
  const snapshot = captureByoRoutingSnapshot();
  if (!isByoModelNotServed(id) && snapshot.configuredOwnersForModel(id).length > 0) return id;
  const cfg = snapshot.defaultBackend;
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
  const backend = resolveByoProviderForModelFromSnapshot(modelId, captureByoRoutingSnapshot());
  return backend ? { ...backend } : undefined;
}

export function resolveByoProviderForModelFromSnapshot(
  modelId: string,
  snapshot: ByoRoutingSnapshot,
): Readonly<ByoBackendConfig> | undefined {
  const id = (modelId || '').trim();
  if (!id) return undefined;
  const providers = snapshot.providers;
  if (providers.length === 0) return undefined;

  const collision = unqualifiedModelCollisionReasonFromSnapshot(id, snapshot, 'all_in');
  if (collision) throw new Error(collision);

  const configuredOwners = snapshot.configuredOwnersForModel(id);
  if (configuredOwners.length === 1) return configuredOwners[0].backend;
  const anyOwner = snapshot.ownersForModel(id)[0];
  if (anyOwner) return anyOwner.backend;

  // Single provider owns everything (byte-identical single-backend behavior).
  if (providers.length === 1) return providers[0].backend;

  return undefined;
}

/** Resolve only an explicitly declared model id. Unlike
 * resolveByoProviderForModel, this never applies the single-provider catch-all,
 * so a BYO provider can serve `gpt-*` or `claude-*` without accidentally
 * claiming every built-in model. A named provider's explicit model list wins.
 * The migrated default owns its primary/judge ids, plus its explicit worker id
 * only in all_in where the routing mode has already selected BYO. */
export function resolveDeclaredByoProviderForModel(modelId: string): ByoBackendConfig | undefined {
  const backend = resolveDeclaredByoProviderForModelFromSnapshot(modelId, captureByoRoutingSnapshot());
  return backend ? { ...backend } : undefined;
}

export function resolveDeclaredByoProviderForModelFromSnapshot(
  modelId: string,
  snapshot: ByoRoutingSnapshot,
): Readonly<ByoBackendConfig> | undefined {
  const id = (modelId || '').trim();
  if (!id) return undefined;
  const collision = unqualifiedModelCollisionReasonFromSnapshot(id, snapshot, 'all_in');
  if (collision) throw new Error(collision);
  const owners = snapshot.configuredOwnersForModel(id);
  const explicit = owners.find(({ provider }) => provider.id !== 'default');
  if (explicit) return explicit.backend;
  const defaultProvider = owners.find(({ provider }) => provider.id === 'default');
  if (!defaultProvider) return undefined;
  const declared = snapshot.defaultBackend;
  const ownsModel = id === declared.primaryId
    || id === declared.judgeId
    || (snapshot.mode === 'all_in' && id === snapshot.workerModel);
  return ownsModel ? defaultProvider.backend : undefined;
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
  return getByoProviderSnapshotsFromRoutingSnapshot(captureByoRoutingSnapshot());
}

export function getByoProviderSnapshotsFromRoutingSnapshot(
  snapshot: ByoRoutingSnapshot,
): ByoProviderSnapshot[] {
  return snapshot.providers.map(({ provider, backend }) => ({
    id: provider.id,
    label: provider.label,
    baseURL: provider.baseURL,
    modelIds: [...provider.modelIds],
    hasKey: Boolean(backend.apiKey),
    configured: backend.configured,
    isDefault: provider.id === 'default',
  }));
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
  /** Provider-published context window for this exact id, when the catalog
   * carries one — recorded as a window observation at discovery time. */
  contextLength?: number;
  /** The provider's own declared model type, when it publishes one (Together:
   *  chat / image / video / embedding / …). Absent for providers that do not
   *  say, which must never be read as "not a chat model". */
  kind?: string;
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
    // The provider's published window for this exact id (Together/Moonshot:
    // `context_length`) — the authoritative fact static registry rows rot away
    // from. Carried so discovery can record it as a window observation.
    const cl = item && typeof item === 'object'
      ? (item as { context_length?: unknown; max_context_length?: unknown })
      : undefined;
    const contextLength = typeof cl?.context_length === 'number' ? cl.context_length
      : typeof cl?.max_context_length === 'number' ? cl.max_context_length : undefined;
    const declaredKind = item && typeof item === 'object'
      ? (item as { type?: unknown }).type
      : undefined;
    const kind = typeof declaredKind === 'string' && declaredKind.trim()
      ? declaredKind.trim().toLowerCase()
      : undefined;
    out.push({
      id,
      label: typeof dn === 'string' && dn.trim() ? dn.trim() : undefined,
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(kind ? { kind } : {}),
    });
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
  const models = normalizeModelsList(json);
  recordCatalogWindowsFromModels(models, baseURL);
  return { status: 200, body: { models } };
}

/** Best-effort: persist provider-published windows as observations. */
function recordCatalogWindowsFromModels(models: DiscoveredModel[], source: string): void {
  try {
    // Lazy import keeps this module's load graph unchanged for tests that stub
    // the discovery path.
    void import('./model-window-observations.js').then(({ recordCatalogWindow }) => {
      for (const m of models) {
        if (m.contextLength !== undefined) recordCatalogWindow(m.id, m.contextLength, source);
      }
    }).catch(() => { /* discovery result is unaffected */ });
  } catch { /* discovery result is unaffected */ }
}

/**
 * Daemon-start catalog warm: list every CONFIGURED BYO provider's models once
 * so their published context windows become durable observations WITHOUT
 * anyone opening the models UI (the observation layer shipped 2026-08-05 was
 * only fed by the console route — a daemon that never opened that page ran on
 * registry seeds forever). Fire-and-forget, short timeout, never throws — a
 * provider being down must not slow daemon start.
 */
export async function warmByoProviderCatalogs(timeoutMs = 8_000): Promise<number> {
  let recorded = 0;
  try {
    const providers = getByoProviders().filter((p) => providerToBackendConfig(p).configured);
    await Promise.all(providers.map(async (p) => {
      try {
        const apiKey = providerToBackendConfig(p).apiKey;
        const result = await discoverProviderModels({ baseURL: p.baseURL, apiKey }, fetch, timeoutMs);
        if (result.status === 200 && 'models' in result.body) {
          recorded += result.body.models.filter((m) => m.contextLength !== undefined).length;
          // The catalog was already being fetched purely for context windows;
          // the ids were thrown away, which is why a provider could serve a new
          // model for weeks and Clementine would never offer it.
          // Only models that can actually hold a turn belong in a model
          // picker. Together publishes a type per model and serves 278 of
          // them — 29 image, 38 video, 15 audio, 2 embedding — which would
          // bury the 169 usable ones. A provider that publishes no type
          // (Z.ai, Moonshot) is never filtered on a guess.
          recordDiscoveredProviderModels(
            p.id,
            result.body.models
              .filter((model) => model.kind === undefined || CONVERSATIONAL_MODEL_KINDS.has(model.kind))
              .map((model) => model.id),
          );
        }
      } catch { /* per-provider best-effort */ }
    }));
  } catch { /* warm is additive — never breaks startup */ }
  return recorded;
}
