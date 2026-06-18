import {
  CLAUDE_MODEL_PRESETS,
  MODEL_PRESETS,
  MODELS,
  getByoBackendConfig,
  getClaudeBrainModel,
  getDebateCheckerModel,
  getRuntimeEnv,
} from '../../config.js';
import { getStoredCodexOAuthTokens } from '../auth-store.js';
import { getStoredClaudeTokens } from '../claude-oauth.js';
import type { ModelRole } from './model-roles.js';
import { resolveProvider, type ModelProviderClass } from './model-wire-registry.js';

export interface AvailableModelGroup {
  provider: ModelProviderClass;
  label: string;
  models: Array<{ id: string; label: string }>;
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

  const byo = getByoBackendConfig();
  if (byo.configured) {
    const models: Array<{ id: string; label: string }> = [];
    pushUnique(models, byo.primaryId);
    pushUnique(models, byo.judgeId);
    pushUnique(models, getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '');
    groups.push({ provider: 'byo', label: byo.providerLabel || 'Custom', models });
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
    const byo = getByoBackendConfig();
    if (!byo.configured) return { ok: false, reason: 'No BYO backend is configured.' };

    const workerIds = new Set([
      byo.primaryId,
      getRuntimeEnv('OPENAI_MODEL_WORKER', '') || '',
    ].filter(Boolean));
    const judgeIds = new Set([
      byo.primaryId,
      byo.judgeId,
    ].filter(Boolean));
    const allowed = role === 'judge' ? judgeIds : workerIds;
    if (!allowed.has(clean)) {
      return {
        ok: false,
        reason:
          role === 'judge'
            ? `BYO model ${clean} is not configured as a judge-capable model. Use BYO_MODEL_ID or BYO_MODEL_JUDGE_ID.`
            : `BYO model ${clean} is not configured as a worker-capable model. Use BYO_MODEL_ID or OPENAI_MODEL_WORKER.`,
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
