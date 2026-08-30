import {
  CODEX_RESCUE_MODEL_ENV_KEY,
  getCodexRescueModelSelection,
  normalizeModelId,
  type CodexRescueModelSelection,
} from '../../config.js';
import { removeEnvKey, updateEnvKey } from '../../tools/shared.js';
import { resolveProvider } from './model-wire-registry.js';
import {
  modelRoleOptionCatalogSnapshot,
  type ModelRoleOptionCatalogSnapshot,
} from './model-role-options.js';

export interface CodexRescueModelOption {
  id: string;
  label: string;
  available: boolean;
}

export interface CodexRescueSettingsSnapshot extends CodexRescueModelSelection {
  options: CodexRescueModelOption[];
}

export type CodexRescueSettingsErrorCode =
  | 'INVALID_CODEX_RESCUE_MODEL'
  | 'CODEX_RESCUE_MODEL_UNAVAILABLE';

export class CodexRescueSettingsError extends Error {
  constructor(
    public readonly code: CodexRescueSettingsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRescueSettingsError';
  }
}

/** One provider-owned view used by every Settings surface. Options are exact
 * connected Codex catalog ids; labels are presentation only and never feed the
 * write predicate. */
export function codexRescueSettingsSnapshot(
  catalog: ModelRoleOptionCatalogSnapshot = modelRoleOptionCatalogSnapshot(),
): CodexRescueSettingsSnapshot {
  const selection = getCodexRescueModelSelection(resolveProvider);
  const options: CodexRescueModelOption[] = (catalog.available
    .find((group) => group.provider === 'codex')?.models ?? [])
    .map((option) => ({ ...option, available: true }));
  if (selection.configured && !options.some((option) => option.id === selection.modelId)) {
    options.push({
      id: selection.modelId,
      label: `${selection.modelId} (saved; unavailable)`,
      available: false,
    });
  }
  return {
    ...selection,
    options,
  };
}

/** The sole validation + persistence owner for console and mobile. `null`
 * clears the explicit setting and restores the legacy follow-primary route. */
export function persistCodexRescueModel(
  requestedModelId: string | null,
  catalog: ModelRoleOptionCatalogSnapshot = modelRoleOptionCatalogSnapshot(),
): CodexRescueSettingsSnapshot {
  if (requestedModelId === null) {
    removeEnvKey(CODEX_RESCUE_MODEL_ENV_KEY);
    return codexRescueSettingsSnapshot(catalog);
  }

  const modelId = normalizeModelId(requestedModelId, '');
  let provider = '';
  try {
    provider = modelId ? resolveProvider(modelId) : '';
  } catch {
    provider = '';
  }
  if (!modelId || provider !== 'codex') {
    throw new CodexRescueSettingsError(
      'INVALID_CODEX_RESCUE_MODEL',
      'modelId must be an exact Codex model id.',
    );
  }

  const options = catalog.available.find((group) => group.provider === 'codex')?.models ?? [];
  if (!options.some((option) => option.id === modelId)) {
    throw new CodexRescueSettingsError(
      'CODEX_RESCUE_MODEL_UNAVAILABLE',
      `Model "${modelId}" is not in the connected Codex catalog.`,
    );
  }

  updateEnvKey(CODEX_RESCUE_MODEL_ENV_KEY, modelId);
  return codexRescueSettingsSnapshot(catalog);
}
