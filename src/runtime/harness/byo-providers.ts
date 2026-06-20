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
import { getRuntimeEnv, getByoBackendConfig, getByoProviderApiKey, type ByoBackendConfig } from '../../config.js';
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
    const modelIds = [legacy.primaryId, legacy.judgeId, (getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '').trim()]
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

/**
 * Resolve a model id → the backend config of the provider that OWNS it.
 * Precedence: an EXPLICIT (non-'default') provider that lists the id wins over
 * the migrated 'default' provider, so adding a real MiniMax provider re-routes
 * `MiniMax-M3` away from a Z.ai 'default'. When exactly one provider exists it
 * owns everything (preserves single-backend all_in/worker semantics). Returns
 * undefined when no provider claims the id — the caller then falls back to the
 * legacy getByoBackendConfig(), so this never broadens which ids hit BYO.
 */
export function resolveByoProviderForModel(modelId: string): ByoBackendConfig | undefined {
  const id = (modelId || '').trim();
  if (!id) return undefined;
  const providers = getByoProviders();
  if (providers.length === 0) return undefined;

  // Explicit, non-default ownership wins (newer connected providers beat the
  // migrated legacy 'default' for a shared id).
  const explicit = providers.find((p) => p.id !== 'default' && p.modelIds.includes(id));
  if (explicit) return providerToBackendConfig(explicit);

  const anyOwner = providers.find((p) => p.modelIds.includes(id));
  if (anyOwner) return providerToBackendConfig(anyOwner);

  // Single provider owns everything (byte-identical single-backend behavior).
  if (providers.length === 1) return providerToBackendConfig(providers[0]);

  return undefined;
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
