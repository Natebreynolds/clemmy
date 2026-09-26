import { updateEnvKey } from '../../tools/shared.js';
import { connectedJudgeFallbackModelGroups, validateJudgeFallbackModelBinding, type AvailableModelGroup, type ModelRoleOptionCatalogSnapshot } from './model-role-options.js';
import type { ResolvedRoleModel } from './model-roles.js';
import {
  JUDGE_FALLBACK_ENV,
  parseJudgeFallbackSetting,
  readJudgeFallbackSetting,
  type JudgeFallbackSetting,
} from './judge-fallback-policy.js';

export { readJudgeFallbackSetting, type JudgeFallbackSetting } from './judge-fallback-policy.js';

export type JudgeFallbackSnapshot = JudgeFallbackSetting & {
  options: AvailableModelGroup[];
  available?: boolean;
  reason?: string;
};

export class JudgeFallbackSettingError extends Error {
  constructor(public readonly code: 'INVALID_SETTING' | 'MODEL_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'JudgeFallbackSettingError';
  }
}

export type JudgeFallbackModelResolution =
  | { status: 'available'; role: ResolvedRoleModel }
  | { status: 'unavailable'; modelId: string; reason: string }
  | { status: 'not_selected' };

/** Resolve an exact choice through the connected fallback catalog, independent
 * of the brain's routing mode. Unavailability never selects another model. */
export function resolveJudgeFallbackModel(
  setting: JudgeFallbackSetting = readJudgeFallbackSetting(),
): JudgeFallbackModelResolution {
  if (setting.mode !== 'model') return { status: 'not_selected' };
  const validation = validateJudgeFallbackModelBinding(setting.modelId);
  if (!validation.ok) return { status: 'unavailable', modelId: setting.modelId, reason: validation.reason };
  return {
    status: 'available',
    role: { modelId: setting.modelId, provider: validation.provider, source: 'settings' },
  };
}

export function judgeFallbackSettingsSnapshot(catalog?: ModelRoleOptionCatalogSnapshot): JudgeFallbackSnapshot {
  const setting = readJudgeFallbackSetting();
  const options = catalog?.judgeFallbackOptions ?? connectedJudgeFallbackModelGroups();
  if (setting.mode !== 'model') return { ...setting, options };
  const available = options.some((group) => group.models.some((model) => model.id === setting.modelId));
  return available ? { ...setting, options, available: true } : {
    ...setting, options, available: false,
    reason: `Saved fallback ${setting.modelId} is not available from a connected account. Reconnect it or choose another fallback.`,
  };
}

/** Desktop and mobile share one validated, restart-safe setting. Saving a
 * choice changes fallback policy only, never the primary judge or its family. */
export function persistJudgeFallbackSetting(value: unknown): JudgeFallbackSnapshot {
  const setting = parseJudgeFallbackSetting(value);
  if (!setting) {
    throw new JudgeFallbackSettingError('INVALID_SETTING', 'Choose Automatic, No fallback, or one connected fallback model.');
  }
  const resolved = resolveJudgeFallbackModel(setting);
  if (resolved.status === 'unavailable') throw new JudgeFallbackSettingError('MODEL_UNAVAILABLE', resolved.reason);
  updateEnvKey(JUDGE_FALLBACK_ENV, JSON.stringify(setting));
  return judgeFallbackSettingsSnapshot();
}
