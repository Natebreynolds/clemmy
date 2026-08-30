import { debateBrainsAvailable } from './judge-family.js';
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
  getRuntimeEnv,
} from '../../config.js';
import { getStoredCodexOAuthTokens } from '../auth-store.js';
import { getStoredClaudeTokens } from '../claude-oauth.js';
import { defaultForRole, type ModelRole } from './model-roles.js';
import { resolveProvider, type ModelProviderClass } from './model-wire-registry.js';
import {
  captureByoRoutingSnapshot,
  getByoProviderSnapshotsFromRoutingSnapshot,
  resolveEffectiveProviderForModelFromSnapshot,
  type ByoProviderSnapshot,
  type ByoRoutingSnapshot,
} from './byo-providers.js';
import { discoveredModels, labelForModelId, modelDiscoveryStatus, type ModelDiscoveryPhase } from './model-discovery.js';

export interface AvailableModelGroup {
  provider: ModelProviderClass;
  /** For byo groups: the connected provider's slug (disambiguates when several
   *  byo providers are connected). Undefined for codex/claude. */
  providerId?: string;
  label: string;
  models: Array<{ id: string; label: string }>;
}

interface ModelOptionDerivationContext {
  readonly byo: ByoRoutingSnapshot;
  readonly connected: Readonly<{ codex: boolean; claude: boolean }>;
  readonly roleAvailable: Readonly<{ codex: boolean; claude: boolean }>;
}

export interface ModelOptionSnapshotObservation {
  providerCount: number;
  configuredProviderCount: number;
  modelCount: number;
}

let modelOptionSnapshotObserverForTest:
  | ((observation: ModelOptionSnapshotObservation) => void)
  | undefined;

/** Test-only observation seam. It measures environment-backed snapshot
 * CAPTURES, not pure per-model lookups, so a large catalog can prove the former
 * remains O(provider count) instead of regressing to O(model count). */
export function _setModelOptionSnapshotObserverForTest(
  observer: ((observation: ModelOptionSnapshotObservation) => void) | null,
): void {
  modelOptionSnapshotObserverForTest = observer ?? undefined;
}

/**
 * Capture mutable runtime/provider state exactly once for one settings
 * derivation. Every model lookup after this point is pure and indexed.
 *
 * Do not promote this to a cross-request cache: Settings writes intentionally
 * change process.env/.env at runtime, and the next request must observe them.
 */
function captureModelOptionContext(): ModelOptionDerivationContext {
  const byo = captureByoRoutingSnapshot();
  const connected = Object.freeze({
    codex: codexModelsAvailable(),
    claude: claudeModelsAvailable(),
  });
  const roleAvailable = Object.freeze(debateBrainsAvailable());

  modelOptionSnapshotObserverForTest?.({
    providerCount: byo.providers.length,
    configuredProviderCount: byo.providers.filter(({ backend }) => backend.configured).length,
    modelCount: byo.providers.reduce((sum, { provider }) => sum + provider.modelIds.length, 0),
  });

  return Object.freeze({
    byo,
    connected,
    roleAvailable,
  });
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

/** Parse only model ids from durable worker/judge bindings. Kept as a leaf-level
 * parser here (instead of importing model-roles.ts) to avoid the intentional
 * model-roles ↔ model-role-options validation cycle. */
export function savedRoleModelIdsForProvider(raw: string, provider: ModelProviderClass): string[] {
  if (!raw.trim() || (provider !== 'codex' && provider !== 'claude')) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== 'object') continue;
      const binding = value as { role?: unknown; modelId?: unknown };
      if (binding.role !== 'worker' && binding.role !== 'judge') continue;
      if (typeof binding.modelId !== 'string') continue;
      const id = binding.modelId.trim();
      if (!id || ids.includes(id)) continue;
      try {
        if (resolveProvider(id) === provider) ids.push(id);
      } catch {
        // Invalid/custom ids remain excluded; normal validation explains them.
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function addSavedRoleModelsWhileCatalogUncertain(
  models: Array<{ id: string; label: string }>,
  provider: 'codex' | 'claude',
  phase: ModelDiscoveryPhase,
): void {
  // A completed non-empty provider catalog is authoritative. Before that point,
  // preserve recognized saved bindings provisionally so a daemon restart cannot
  // flash "unavailable; using default" merely because discovery is still cold
  // or a refresh encountered a transient provider failure.
  if (phase === 'ready') return;
  const raw = getRuntimeEnv('CLEMMY_MODEL_ROLES', '') ?? '';
  const suffix = phase === 'refreshing' || phase === 'idle'
    ? ' (saved; checking availability)'
    : ' (saved; using last known route)';
  for (const id of savedRoleModelIdsForProvider(raw, provider)) {
    pushUnique(models, id, `${labelForModelId(id)}${suffix}`);
  }
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
  addSavedRoleModelsWhileCatalogUncertain(models, 'codex', modelDiscoveryStatus().providers.openai.phase);
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
  addSavedRoleModelsWhileCatalogUncertain(models, 'claude', modelDiscoveryStatus().providers.anthropic.phase);
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

function connectedModelGroupsFromContext(context: ModelOptionDerivationContext): AvailableModelGroup[] {
  const groups: AvailableModelGroup[] = [];

  // Presets + configured slots + LIVE-DISCOVERED models (providers' /v1/models):
  // a newly released Codex/Anthropic model shows up as a choice on the next
  // settings poll, no Clementine release needed.
  if (context.connected.codex) {
    groups.push({ provider: 'codex', label: 'Codex', models: codexBrainModelChoices() });
  }
  if (context.connected.claude) {
    groups.push({ provider: 'claude', label: 'Claude', models: claudeBrainModelChoices() });
  }

  // One group per CONNECTED BYO provider, so the picker lists every model the
  // user has added across providers (GLM + DeepSeek + MiniMax …).
  for (const { provider, backend } of context.byo.providers) {
    if (!backend.configured) continue;
    const seen = new Set<string>();
    const models: Array<{ id: string; label: string }> = [];
    for (const raw of provider.modelIds) {
      const id = raw.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: id });
    }
    if (models.length === 0) continue;
    groups.push({ provider: 'byo', providerId: provider.id, label: provider.label || 'Custom', models });
  }
  return groups;
}

export function connectedModelGroups(): AvailableModelGroup[] {
  return connectedModelGroupsFromContext(captureModelOptionContext());
}

function roleModelCapabilityFromContext(
  role: ModelRole,
  modelId: string,
  context: ModelOptionDerivationContext,
): RoleModelCapability {
  if (role === 'brain') {
    return { ok: false, reason: 'The brain is set through the active-brain provider switch for now.' };
  }
  const clean = modelId.trim();
  if (!clean) return { ok: false, reason: 'modelId is required.' };

  let provider: ModelProviderClass;
  try {
    provider = resolveEffectiveProviderForModelFromSnapshot(clean, context.byo);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (context.byo.mode === 'all_in' && context.byo.defaultBackend.configured && provider !== 'byo') {
    const connected = provider === 'claude'
      ? context.roleAvailable.claude
      : provider === 'codex' ? context.roleAvailable.codex : false;
    if (!connected) {
      return {
        ok: false,
        reason: `${clean} needs a connected ${provider === 'claude' ? 'Claude' : 'Codex'} login — sign in under Models & routing, or pick a BYO model.`,
      };
    }
  }

  if (provider === 'byo' && !context.byo.hasConnectedModel(clean)) {
    let family: ModelProviderClass | null = null;
    try { family = resolveProvider(clean); } catch { family = null; }
    if (family === 'claude') {
      return {
        ok: false,
        reason: `${clean} needs a connected Claude login — sign in under Models & routing, or pick a BYO model.`,
      };
    }
    if (family === 'codex') {
      return {
        ok: false,
        reason: `${clean} is unavailable while all-in mode is on — Codex-family ids stay on the BYO backend in all-in. Use a Claude model for this role, or turn all-in off.`,
      };
    }
    if (!context.byo.providers.some(({ provider: candidate, backend }) =>
      backend.configured && candidate.modelIds.length > 0)) {
      return { ok: false, reason: 'No BYO backend is configured.' };
    }
    return {
      ok: false,
      reason: `BYO model ${clean} is not offered by any connected provider. Add it to a provider's model list in Settings → Models.`,
    };
  }

  return { ok: true, provider };
}

function connectedModelGroupsForRoleFromContext(
  role: ModelRole,
  context: ModelOptionDerivationContext,
  groups = connectedModelGroupsFromContext(context),
): AvailableModelGroup[] {
  if (role === 'brain') return [];
  return groups
    .map((group) => {
      const models = group.models.filter((model) => {
        const capability = roleModelCapabilityFromContext(role, model.id, context);
        return capability.ok && capability.provider === group.provider;
      });
      return { ...group, models };
    })
    .filter((group) => group.models.length > 0);
}

export function connectedModelGroupsForRole(role: ModelRole): AvailableModelGroup[] {
  const context = captureModelOptionContext();
  return connectedModelGroupsForRoleFromContext(role, context);
}

function modelIdsAvailableForRoleFromContext(
  role: ModelRole,
  context: ModelOptionDerivationContext,
): Set<string> {
  const ids = new Set<string>();
  for (const group of connectedModelGroupsForRoleFromContext(role, context)) {
    for (const model of group.models) ids.add(model.id);
  }
  return ids;
}

export function modelIdsAvailableForRole(role: ModelRole): Set<string> {
  return modelIdsAvailableForRoleFromContext(role, captureModelOptionContext());
}

export function roleModelCapability(role: ModelRole, modelId: string): RoleModelCapability {
  return roleModelCapabilityFromContext(role, modelId, captureModelOptionContext());
}

export function validateRoleModelBinding(role: ModelRole, modelId: string): RoleModelCapability {
  const context = captureModelOptionContext();
  const capability = roleModelCapabilityFromContext(role, modelId, context);
  if (!capability.ok) return capability;

  const allowed = modelIdsAvailableForRoleFromContext(role, context);
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
function brainOptionsFromContext(
  context: ModelOptionDerivationContext,
  groups = connectedModelGroupsFromContext(context),
): BrainOption[] {
  const opts: BrainOption[] = [];
  // Codex brain: offer the SPECIFIC gpt-5.x model (like the worker picker) so the
  // brain can be pinned to gpt-5.5 vs gpt-5.4 — not just "Codex". Sourced from the
  // same connected-Codex model list the worker uses; value `codex_oauth:<id>` so
  // the active-brain route persists the exact model. Falls back to unavailable
  // model-specific rows when Codex isn't connected so effectiveBrainValue remains in-list.
  const codexGroup = groups.find((g) => g.provider === 'codex');
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
  const claudeGroup = groups.find((g) => g.provider === 'claude');
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
  for (const { provider, backend } of context.byo.providers) {
    if (!backend.configured) continue;
    for (const raw of provider.modelIds) {
      const modelId = raw.trim();
      if (context.byo.configuredOwnersForModel(modelId).length > 1) continue;
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

export function brainOptions(): BrainOption[] {
  const context = captureModelOptionContext();
  return brainOptionsFromContext(context);
}

export interface ModelRoleOptionCatalogSnapshot {
  available: AvailableModelGroup[];
  roleOptions: {
    worker: AvailableModelGroup[];
    judge: AvailableModelGroup[];
  };
  brainOptions: BrainOption[];
  providerSnapshots: ByoProviderSnapshot[];
}

/** One coherent settings-catalog derivation. Provider configuration is read
 * once, then worker/judge/brain choices share the same immutable indexed view. */
export function modelRoleOptionCatalogSnapshot(): ModelRoleOptionCatalogSnapshot {
  const context = captureModelOptionContext();
  const available = connectedModelGroupsFromContext(context);
  return {
    available,
    roleOptions: {
      worker: connectedModelGroupsForRoleFromContext('worker', context, available),
      judge: connectedModelGroupsForRoleFromContext('judge', context, available),
    },
    brainOptions: brainOptionsFromContext(context, available),
    providerSnapshots: getByoProviderSnapshotsFromRoutingSnapshot(context.byo),
  };
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
