import {
  CLAUDE_MODEL_PRESETS,
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
import type { ModelRole } from './model-roles.js';
import { resolveProvider, type ModelProviderClass } from './model-wire-registry.js';
import { getByoProviders, providerToBackendConfig } from './byo-providers.js';

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

export function codexModelsAvailable(): boolean {
  try {
    return Boolean(getStoredCodexOAuthTokens()?.accessToken);
  } catch {
    return false;
  }
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

  if (codexModelsAvailable()) {
    const models = [...MODEL_PRESETS];
    for (const id of [MODELS.fast, MODELS.primary, MODELS.deep]) {
      if (resolveProvider(id) === 'codex') pushUnique(models, id);
    }
    groups.push({ provider: 'codex', label: 'Codex', models });
  }

  if (claudeModelsAvailable()) {
    const models = [...CLAUDE_MODEL_PRESETS];
    for (const id of [getClaudeBrainModel(), getDebateCheckerModel()]) {
      if (resolveProvider(id) === 'claude') pushUnique(models, id);
    }
    groups.push({ provider: 'claude', label: 'Claude', models });
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
      const models = group.models.filter((model) => roleModelCapability(role, model.id).ok);
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
  const provider = resolveProvider(clean);

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
  label: string;
  available: boolean;
  /** For the BYO brain: the model id that will orchestrate. */
  modelId?: string;
}

/** The brain choices to show in the picker — Codex, Claude, and (if a BYO backend
 *  is configured) the BYO model — each flagged available based on its connection. */
export function brainOptions(): BrainOption[] {
  const byo = getByoBackendConfig();
  const opts: BrainOption[] = [
    { id: 'codex_oauth', label: 'Codex — GPT-5.x', available: codexModelsAvailable() },
    { id: 'claude_oauth', label: 'Claude — Opus', available: claudeModelsAvailable() },
  ];
  if (byo.configured) {
    opts.push({ id: 'api_key', label: `${byo.providerLabel || 'Custom'} — ${byo.primaryId}`, available: true, modelId: byo.primaryId });
  }
  return opts;
}

/** The brain the wire actually uses, for the picker's selected value: all-in BYO
 *  routing means the BYO model is the brain regardless of the stored AUTH_MODE. */
export function effectiveBrain(): BrainChoice {
  if (getModelRoutingMode() === 'all_in' && getByoBackendConfig().configured) return 'api_key';
  return getActiveAuthMode();
}
