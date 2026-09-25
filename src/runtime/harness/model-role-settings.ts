import { slugifyIntent } from '../../memory/tool-choice-store.js';
import { updateEnvKey } from '../../tools/shared.js';
import { resolveEffectiveProviderForModel } from './byo-providers.js';
import { validateRoleModelBinding } from './model-role-options.js';
import { readDurableBindings, type ModelRole, type RoleBinding } from './model-roles.js';

/** The roles a settings door binds to a model. The brain has its own door (the
 * active-brain switch), because choosing it also moves the auth mode and the
 * provider slots. */
export type BindableModelRole = Exclude<ModelRole, 'brain'>;

export function isBindableModelRole(value: unknown): value is BindableModelRole {
  return value === 'worker' || value === 'judge' || value === 'writer';
}

export type ModelRoleSettingErrorCode =
  | 'INVALID_MODEL_ID'
  | 'INVALID_INTENT'
  | 'MODEL_UNAVAILABLE';

export class ModelRoleSettingError extends Error {
  constructor(
    public readonly code: ModelRoleSettingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelRoleSettingError';
  }
}

export interface ModelRoleSettingChange {
  role: BindableModelRole;
  /** An exact connected model id. Empty or absent clears the binding. */
  modelId?: string;
  /** The owner's own category word ("design"). Absent = the role-wide binding. */
  whenIntent?: string;
  clear?: boolean;
  source: RoleBinding['source'];
}

/**
 * The sole validation + persistence owner for every door that binds a role to
 * a model: desktop Settings, the phone and the chat tool all write the same
 * CLEMMY_MODEL_ROLES store through here. Returns the saved bindings. Callers
 * drop their model caches so the change applies on the next turn.
 */
export function persistModelRoleSetting(change: ModelRoleSettingChange): RoleBinding[] {
  const { role, source } = change;
  const rawModelId = typeof change.modelId === 'string' ? change.modelId.trim() : '';
  const modelId = /^[A-Za-z0-9._:/-]*$/.test(rawModelId) ? rawModelId : '';
  if (rawModelId && !modelId) {
    throw new ModelRoleSettingError('INVALID_MODEL_ID', 'modelId contains unsupported characters.');
  }
  const whenIntent = typeof change.whenIntent === 'string' ? change.whenIntent.trim() : '';
  const slug = whenIntent ? slugifyIntent(whenIntent) : '';
  if (whenIntent && !slug) {
    throw new ModelRoleSettingError('INVALID_INTENT', 'whenIntent is empty after normalization');
  }
  const clear = change.clear === true || !modelId;
  if (!clear) {
    const validation = validateRoleModelBinding(role, modelId);
    if (!validation.ok) throw new ModelRoleSettingError('MODEL_UNAVAILABLE', validation.reason);
  }

  // An intent-scoped binding routes only that user-named kind of work; a
  // role-wide binding is the role default. Each write replaces the one binding
  // with the same key and leaves every other rule alone.
  const next: RoleBinding[] = readDurableBindings().filter((binding) => {
    if (binding.role !== role) return true;
    return slug
      ? !(binding.whenIntent && slugifyIntent(binding.whenIntent) === slug)
      : Boolean(binding.whenIntent);
  });
  if (!clear) {
    next.push(slug
      ? { role, modelId, whenIntent: slug, scope: 'durable', source }
      : { role, modelId, scope: 'durable', source });
  }
  updateEnvKey('CLEMMY_MODEL_ROLES', JSON.stringify(next));

  // The legacy judge branch is global (which provider reconciles), so only a
  // role-wide judge binding moves it. It can name only Claude or Codex; a BYO
  // judge is carried by the binding itself, so the branch is cleared instead
  // of forcing that judge onto another provider.
  if (role === 'judge' && !slug) {
    const provider = clear ? '' : resolveEffectiveProviderForModel(modelId);
    if (provider === 'claude' || provider === 'codex') {
      updateEnvKey('CLEMMY_DEBATE_JUDGE', provider);
      process.env.CLEMMY_DEBATE_JUDGE = provider;
    } else {
      updateEnvKey('CLEMMY_DEBATE_JUDGE', '');
      delete process.env.CLEMMY_DEBATE_JUDGE;
    }
  }
  return next;
}
