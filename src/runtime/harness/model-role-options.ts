import {
  CLAUDE_MODEL_PRESETS,
  DEFAULT_CODEX_MODEL,
  MODEL_PRESETS,
  MODELS,
  getClaudeBrainModel,
  getDebateCheckerModel,
  getByoBackendConfig,
  getModelRoutingMode,
  getActiveAuthMode,
} from '../../config.js';
import { getStoredCodexOAuthTokens } from '../auth-store.js';
import { getStoredClaudeTokens } from '../claude-oauth.js';
import { defaultForRole, type ModelRole } from './model-roles.js';
import { resolveProvider, type ModelProviderClass } from './model-wire-registry.js';
import {
  getByoProviders,
  providerToBackendConfig,
  configuredByoProvidersForModel,
  resolveEffectiveProviderForModel,
} from './byo-providers.js';
import { discoveredModels } from './model-discovery.js';

export interface AvailableModelGroup {
  provider: ModelProviderClass;
  /** For byo groups: the connected provider's slug (disambiguates when several
   *  byo providers are connected). Undefined for codex/claude. */
  providerId?: string;
  label: string;
  models: Array<{ id: string; label: string }>;
}

/** Union of model ids served by every CONFIGURED (keyed) BYO provider — the
 *  allow-set for binding any non-brain role. For a migrated single-BYO user this
 *  is exactly {primaryId, judgeId, worker}, so existing bindings never demote. */
function connectedByoModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const p of getByoProviders()) {
    if (!providerToBackendConfig(p).configured) continue;
    for (const id of p.modelIds) ids.add(id);
  }
  return ids;
}

export type RoleModelCapability =
  | { ok: true; provider: ModelProviderClass }
  | { ok: false; reason: string };

const CLAUDE_OAT_PREFIX = 'sk-ant-oat01';

function pushUnique(models: Array<{ id: string; label: string }>, id: string, label = id): void {
  const clean = id.trim();
  if (!clean || models.some((m) => m.id === clean)) return;
  models.push({ id: clean, label });
}

function codexBrainModelChoices(): Array<{ id: string; label: string }> {
  const models = [...MODEL_PRESETS];
  for (const id of [MODELS.fast, MODELS.primary, MODELS.deep, DEFAULT_CODEX_MODEL]) {
    try {
      if (resolveProvider(id) === 'codex') pushUnique(models, id);
    } catch {
      // Unknown/custom ids are ignored here; the router still validates at dispatch.
    }
  }
  // Live discovery: any additional gpt/o/codex-class model the user's OpenAI
  // credentials can see (providers' /v1/models) — a NEW model shows up in the
  // picker without a Clementine release. Presets stay first (curated labels win).
  for (const m of discoveredModels().openai) pushUnique(models, m.id, m.label);
  return models;
}

function claudeBrainModelChoices(): Array<{ id: string; label: string }> {
  const models = [...CLAUDE_MODEL_PRESETS];
  for (const id of [getClaudeBrainModel(), getDebateCheckerModel()]) {
    try {
      if (resolveProvider(id) === 'claude') pushUnique(models, id);
    } catch {
      // Unknown/custom ids are ignored here; the router still validates at dispatch.
    }
  }
  // Live discovery (Anthropic /v1/models via API key or the subscription OAuth):
  // a newly dropped Claude model appears here on the next settings poll.
  for (const m of discoveredModels().anthropic) pushUnique(models, m.id, m.label);
  return models;
}

export function codexModelsAvailable(): boolean {
  try {
    return Boolean(getStoredCodexOAuthTokens()?.accessToken);
  } catch {
    return false;
  }
}

export type BrainProviderClass = 'codex' | 'claude' | 'byo';

/**
 * Ordered cross-provider fallover targets (model ids) EXCLUDING `current` —
 * the SAME order RouterModelProvider.buildBrainChain uses (codex, then claude,
 * then the configured BYO backend), restricted to brains that are actually
 * connected. Used for STEP-BOUNDARY re-dispatch when a brain's provider is down
 * mid-run, where in-stream fallover can't fire (FallbackModel only switches
 * before the first byte). `all_in` mode returns [] (one provider, nowhere to go).
 */
/** The model id a fallover-to-codex should run on. Normally MODELS.primary —
 *  but when that slot is repurposed to a BYO id (OPENAI_MODEL_PRIMARY=glm-*),
 *  it routes to BYO, the mis-route guard below drops the entry, and Codex is
 *  SILENTLY excluded from the chain even though its OAuth is connected (the
 *  claude→glm-only recoveries, 2026-07-02 daemon.log). Fall back to the
 *  canonical Codex default so a connected Codex always stays reachable.
 *  Mirrors codexSafePrimary()/codexSafeFast() in model-roles.ts. */
function falloverCodexModelId(): string {
  try {
    if (resolveProvider(MODELS.primary) === 'codex') return MODELS.primary;
  } catch { /* unknown id → use the canonical default */ }
  return DEFAULT_CODEX_MODEL;
}

export function falloverBrainModelIds(current: BrainProviderClass): Array<{ provider: BrainProviderClass; modelId: string }> {
  if (getModelRoutingMode() === 'all_in') return [];
  const out: Array<{ provider: BrainProviderClass; modelId: string }> = [];
  if (current !== 'codex' && codexModelsAvailable()) out.push({ provider: 'codex', modelId: falloverCodexModelId() });
  if (current !== 'claude' && claudeModelsAvailable()) out.push({ provider: 'claude', modelId: getClaudeBrainModel() });
  const byo = getByoBackendConfig();
  if (current !== 'byo' && byo.configured) out.push({ provider: 'byo', modelId: byo.primaryId || MODELS.primary });
  // Correctness guard (backstop): every entry's modelId must actually ROUTE to
  // its claimed provider, and no two entries may collapse to the same wire
  // provider — a mis-routed entry would be a redundant same-brain "fallover"
  // that re-hits the failing provider. The codex entry is already repurpose-safe
  // via falloverCodexModelId(); this guard still protects the other slots.
  const seen = new Set<string>([current]);
  return out.filter((e) => {
    let resolved: string;
    try { resolved = resolveProvider(e.modelId); } catch { return false; }
    if (resolved !== e.provider) return false; // modelId doesn't actually route to its provider
    if (seen.has(resolved)) return false;       // already covered by an earlier (or current) brain
    seen.add(resolved);
    return true;
  });
}

export function claudeModelsAvailable(): boolean {
  try {
    const t = getStoredClaudeTokens();
    if (!t?.accessToken?.startsWith(CLAUDE_OAT_PREFIX)) return false;
    if (t.refreshToken) return true;
    return !t.expiresAt || t.expiresAt > Date.now() + 60_000;
  } catch {
    return false;
  }
}

export function connectedModelGroups(): AvailableModelGroup[] {
  const groups: AvailableModelGroup[] = [];

  // Presets + configured slots + LIVE-DISCOVERED models (providers' /v1/models):
  // a newly released Codex/Anthropic model shows up as a choice on the next
  // settings poll, no Clementine release needed.
  if (codexModelsAvailable()) {
    groups.push({ provider: 'codex', label: 'Codex', models: codexBrainModelChoices() });
  }

  if (claudeModelsAvailable()) {
    groups.push({ provider: 'claude', label: 'Claude', models: claudeBrainModelChoices() });
  }

  // One group per CONNECTED BYO provider, so the picker lists every model the
  // user has added across providers (GLM + DeepSeek + MiniMax …).
  for (const provider of getByoProviders()) {
    if (!providerToBackendConfig(provider).configured) continue;
    const models: Array<{ id: string; label: string }> = [];
    for (const id of provider.modelIds) pushUnique(models, id);
    if (models.length === 0) continue;
    groups.push({ provider: 'byo', providerId: provider.id, label: provider.label || 'Custom', models });
  }

  return groups;
}

export function connectedModelGroupsForRole(role: ModelRole): AvailableModelGroup[] {
  if (role === 'brain') return [];
  return connectedModelGroups()
    .map((group) => {
      const models = group.models.filter((model) => {
        const capability = roleModelCapability(role, model.id);
        return capability.ok && capability.provider === group.provider;
      });
      return { ...group, models };
    })
    .filter((group) => group.models.length > 0);
}

export function modelIdsAvailableForRole(role: ModelRole): Set<string> {
  const ids = new Set<string>();
  for (const group of connectedModelGroupsForRole(role)) {
    for (const model of group.models) ids.add(model.id);
  }
  return ids;
}

export function roleModelCapability(role: ModelRole, modelId: string): RoleModelCapability {
  if (role === 'brain') {
    return { ok: false, reason: 'The brain is set through the active-brain provider switch for now.' };
  }
  const clean = modelId.trim();
  if (!clean) return { ok: false, reason: 'modelId is required.' };
  let provider: ModelProviderClass;
  try {
    provider = resolveEffectiveProviderForModel(clean);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (getModelRoutingMode() === 'all_in' && getByoBackendConfig().configured && provider !== 'byo') {
    return {
      ok: false,
      reason: `All-in mode is isolated to the BYO provider; ${clean} cannot be bound to ${role} until all-in is disabled.`,
    };
  }

  if (provider === 'byo') {
    // Any model offered by any connected provider can serve any non-brain role
    // (the user declares a provider's models at connect time; worker vs judge is
    // their pick, not a per-env distinction). Union across all configured providers.
    const allowed = connectedByoModelIds();
    if (allowed.size === 0) return { ok: false, reason: 'No BYO backend is configured.' };
    if (!allowed.has(clean)) {
      return {
        ok: false,
        reason: `BYO model ${clean} is not offered by any connected provider. Add it to a provider's model list in Settings → Models.`,
      };
    }
  }

  return { ok: true, provider };
}

export function validateRoleModelBinding(role: ModelRole, modelId: string): RoleModelCapability {
  const capability = roleModelCapability(role, modelId);
  if (!capability.ok) return capability;

  const allowed = modelIdsAvailableForRole(role);
  const clean = modelId.trim();
  if (!allowed.has(clean)) {
    const available = [...allowed].sort();
    return {
      ok: false,
      reason: available.length
        ? `Model ${clean} is not available for ${role}. Connected choices: ${available.join(', ')}.`
        : `No connected models are available for ${role}. Connect Codex, Claude, or a BYO backend first.`,
    };
  }

  return capability;
}

// ── Brain picker: who orchestrates every turn ────────────────────────────────
// The brain is a provider switch (Codex / Claude / a BYO model), distinct from
// the worker/judge role bindings. A BYO brain runs all-in (every role on the BYO
// backend unless a role is bound elsewhere — e.g. judge → Codex).

export type BrainChoice = ReturnType<typeof getActiveAuthMode>; // 'codex_oauth' | 'claude_oauth' | 'api_key'
export interface BrainOption {
  id: BrainChoice;
  /** Unique selector value (codex/claude = the id; a BYO model = `api_key:<modelId>`
   *  so several BYO models can coexist under the single 'api_key' brain class). */
  value: string;
  label: string;
  available: boolean;
  /** For a BYO brain option: the model id that will orchestrate + its provider. */
  modelId?: string;
  providerId?: string;
}

/** The brain choices to show in the picker — Codex, Claude, and EVERY connected
 *  BYO model (across all configured providers, not just the default slot). Any
 *  connected model can be the brain: the router resolves a chosen model id to its
 *  OWNING provider's baseURL+key via resolveByoProviderForModel, so selecting an
 *  extra-provider model (e.g. a Together AI model) just works — no slot reshuffle. */
export function brainOptions(): BrainOption[] {
  const opts: BrainOption[] = [];
  // Codex brain: offer the SPECIFIC gpt-5.x model (like the worker picker) so the
  // brain can be pinned to gpt-5.5 vs gpt-5.4 — not just "Codex". Sourced from the
  // same connected-Codex model list the worker uses; value `codex_oauth:<id>` so
  // the active-brain route persists the exact model. Falls back to unavailable
  // model-specific rows when Codex isn't connected so effectiveBrainValue remains in-list.
  const codexGroup = connectedModelGroups().find((g) => g.provider === 'codex');
  const codexModels = codexGroup?.models?.length ? codexGroup.models : codexBrainModelChoices();
  for (const m of codexModels) {
    opts.push({
      id: 'codex_oauth',
      value: `codex_oauth:${m.id}`,
      modelId: m.id,
      label: `Codex — ${m.label}`,
      available: Boolean(codexGroup),
    });
  }
  // Claude brain: offer each connected Claude model (like the Codex picker) so the
  // brain can be pinned to Sonnet 5 vs Opus 4.8 vs Fable 5 — not just "Claude".
  // value `claude_oauth:<id>` so the active-brain route persists the exact model
  // (→ CLAUDE_MODEL). Falls back to unavailable model-specific rows when Claude
  // isn't connected so effectiveBrainValue remains in-list.
  const claudeGroup = connectedModelGroups().find((g) => g.provider === 'claude');
  const claudeModels = claudeGroup?.models?.length ? claudeGroup.models : claudeBrainModelChoices();
  for (const m of claudeModels) {
    opts.push({
      id: 'claude_oauth',
      value: `claude_oauth:${m.id}`,
      modelId: m.id,
      label: `Claude — ${m.label.replace(/^Claude\s+/, '')}`,
      available: Boolean(claudeGroup),
    });
  }
  const seen = new Set<string>();
  for (const provider of getByoProviders()) {
    if (!providerToBackendConfig(provider).configured) continue;
    for (const raw of provider.modelIds) {
      const modelId = raw.trim();
      if (configuredByoProvidersForModel(modelId).length > 1) continue;
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      opts.push({
        id: 'api_key',
        value: `api_key:${modelId}`,
        modelId,
        providerId: provider.id,
        available: true,
        label: `${provider.label || 'Custom'} — ${modelId}`,
      });
    }
  }
  return opts;
}

/** The selector VALUE for the brain the wire actually uses — matches one of
 *  brainOptions().value so the picker highlights the right row. For a BYO brain
 *  it is `api_key:<the orchestrating model id>` (the per-model override if set,
 *  else the default slot's primary). */
export function effectiveBrainValue(): string {
  // SINGLE SOURCE OF TRUTH: the model id the wire actually orchestrates with.
  // defaultForRole('brain') already encodes every case — all_in BYO (the per-model
  // BYO_BRAIN_MODEL_ID override or the default-slot primary), claude_oauth → the
  // Claude brain, else MODELS.primary (which the harness config COLLAPSES to the
  // BYO primary when AUTH_MODE=api_key, so a BYO brain still resolves to its BYO
  // model even in worker mode). Map that id back to the picker's selector value so
  // the highlighted option is ALWAYS the real brain — never a bare, unmatchable
  // 'api_key' nor a BYO model that isn't actually orchestrating.
  const brainModelId = defaultForRole('brain');
  if (getModelRoutingMode() === 'all_in' && getByoBackendConfig().configured) {
    return `api_key:${brainModelId}`;
  }
  const provider = resolveProvider(brainModelId);
  // claude → the SPECIFIC model value so the picker highlights the right Claude
  // row (brainOptions lists every connected Claude model; the resolved id is
  // getClaudeBrainModel(), always one of CLAUDE_MODEL_PRESETS or the default).
  if (provider === 'claude') return `claude_oauth:${brainModelId}`;
  // codex → the SPECIFIC model value so the picker highlights the right gpt-5.x row
  // (brainOptions lists every connected Codex model; the resolved id is always one
  // of them — MODEL_PRESETS includes the DEFAULT_CODEX_MODEL fallback).
  if (provider === 'codex') return `codex_oauth:${brainModelId}`;
  return `api_key:${brainModelId}`; // byo → matches its api_key:<modelId> option
}

/** The brain the wire actually uses, for the picker's selected value: all-in BYO
 *  routing means the BYO model is the brain regardless of the stored AUTH_MODE.
 *  Never returns a value the brain picker has no option for: 'api_key' is only a
 *  real brain when a BYO backend is configured (brainOptions gates it the same
 *  way) — otherwise getActiveAuthMode()'s default-'api_key' (unset AUTH_MODE, the
 *  common Codex-only case) is clamped to Codex so the Select value stays in-list. */
export function effectiveBrain(): BrainChoice {
  const byoConfigured = getByoBackendConfig().configured;
  if (getModelRoutingMode() === 'all_in' && byoConfigured) return 'api_key';
  const mode = getActiveAuthMode();
  if (mode === 'api_key' && !byoConfigured) return 'codex_oauth';
  return mode;
}

/** Test-only: expose the raw choice builders (they read the discovery cache). */
export function __testChoices(): { codex: Array<{ id: string; label: string }>; claude: Array<{ id: string; label: string }> } {
  return { codex: codexBrainModelChoices(), claude: claudeBrainModelChoices() };
}
