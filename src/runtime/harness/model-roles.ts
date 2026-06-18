/**
 * model-roles — the ONE canonical read point for "which model serves this role".
 *
 * Clementine plays a handful of fixed architectural ROLES (brain · worker ·
 * judge/checker), and historically each was selected by its own scattered getter
 * (getClaudeBrainModel / getDebateCheckerModel / getWorkerModel / MODELS.primary,
 * plus the configureHarnessRuntime branch tree). This collapses that selection
 * into `resolveRoleModel(role, intent?)` so the UI's brain/worker/judge pickers
 * and chat-driven routing rules write to ONE place and every dispatch site reads
 * from it.
 *
 * Two axes, deliberately different in kind:
 *   - ROLE is a fixed internal seam (brain/worker/judge) → a hard enum.
 *   - INTENT is the USER'S OWN free-form category ("my legal stuff") → never an
 *     enum (intent-scoped bindings land in a later phase, mirroring
 *     tool-choice-store's free-form slugs).
 *
 * Phase 1 invariant: with NO bindings written (CLEMMY_MODEL_ROLES unset) the
 * resolved model id is BYTE-IDENTICAL to the legacy getter for every role, on
 * every auth/routing permutation — because the default path delegates straight
 * to those getters. The default is provider-DERIVED: it never names a provider
 * the user isn't logged into, so a Codex-only user resolves all-Codex with no
 * "wanted Claude but logged out" state. Kill-switch CLEMMY_MODEL_ROLES_REGISTRY
 * (default on; off ⇒ defaults only, bindings ignored).
 */
import {
  getRuntimeEnv,
  getActiveAuthMode,
  getModelRoutingMode,
  getClaudeBrainModel,
  getDebateCheckerModel,
  getWorkerModel,
  getByoBackendConfig,
  judgeChoice,
  MODELS,
} from '../../config.js';
import { resolveProvider, type ModelProviderClass } from './model-wire-registry.js';

/** Fixed internal role seam. brain = the active orchestrator model; worker =
 *  delegated run_worker/grunt labor; judge = the fusion verify checker / debate
 *  reconciler. (debate's draftA is intentionally NOT a registry role — it stays
 *  the flagship and the user never touches it.) */
export type ModelRole = 'brain' | 'worker' | 'judge';

/** A user-set role→model assignment (from the Models UI or a chat rule). */
export interface RoleBinding {
  role: ModelRole;
  modelId: string;
  /** The user's OWN free-form category, slugified — undefined = the role default
   *  (applies to every turn of that role). Intent-scoped matching lands with
   *  chat-driven routing; Phase 1 only honors the undefined (role-wide) form. */
  whenIntent?: string;
  scope: 'durable' | 'session';
  source: 'settings' | 'chat-rule';
}

export interface ResolvedRoleModel {
  modelId: string;
  provider: ModelProviderClass;
  source: 'default' | 'settings' | 'chat-rule' | 'session';
}

/** Kill-switch. off ⇒ resolveRoleModel returns ONLY the provider-derived default
 *  (bindings ignored), i.e. byte-identical to the legacy getters. Default on. */
export function modelRolesRegistryEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_MODEL_ROLES_REGISTRY', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/** Parse durable bindings from CLEMMY_MODEL_ROLES (JSON array). Unset/bad JSON ⇒
 *  [] ⇒ pure defaults (byte-identical to today). Never throws. */
export function readDurableBindings(): RoleBinding[] {
  if (!modelRolesRegistryEnabled()) return [];
  const raw = (getRuntimeEnv('CLEMMY_MODEL_ROLES', '') || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is RoleBinding =>
        !!b &&
        typeof b === 'object' &&
        ((b as RoleBinding).role === 'brain' ||
          (b as RoleBinding).role === 'worker' ||
          (b as RoleBinding).role === 'judge') &&
        typeof (b as RoleBinding).modelId === 'string' &&
        (b as RoleBinding).modelId.length > 0,
    );
  } catch {
    return [];
  }
}

/**
 * The provider-DERIVED default model id for a role — mirrors the model id each
 * branch of configureHarnessRuntime + resolveDebateBrains selects today, so an
 * unbound role is byte-identical to the legacy getters. Never names a provider
 * the user isn't on (a Codex-only user resolves all-Codex).
 */
export function defaultForRole(role: ModelRole): string {
  const byo = getByoBackendConfig();
  const mode = getModelRoutingMode();

  // In all-in BYO mode the registered provider routes every role to the BYO
  // backend, even if a legacy caller still asks for a gpt-* tier. Make the role
  // snapshot say the same thing the wire will actually do.
  if (mode === 'all_in' && byo.configured) {
    if (role === 'judge') return byo.judgeId || byo.primaryId;
    if (role === 'worker') {
      // getWorkerModel() never returns empty (falls back to MODELS.primary, a
      // gpt-* id). In all_in the router collapses any codex-class id to the BYO
      // primary, so report what the wire actually sends; a real BYO worker id is kept.
      const w = getWorkerModel();
      return resolveProvider(w) === 'codex' ? byo.primaryId : w;
    }
    return byo.primaryId;
  }

  switch (role) {
    case 'brain': {
      // claude_oauth ⇒ the Claude brain; all_in+byo ⇒ the BYO primary; else the
      // Codex primary — exactly the configureHarnessRuntime outcomes.
      if (getActiveAuthMode() === 'claude_oauth') return getClaudeBrainModel();
      return MODELS.primary;
    }
    case 'judge':
      // judge=claude ⇒ the dedicated checker model (Sonnet); judge=codex ⇒ the
      // Codex primary. Mirrors resolveDebateBrains.
      return judgeChoice() === 'claude' ? getDebateCheckerModel() : MODELS.primary;
    case 'worker':
    default:
      // Default workers follow the active brain unless the legacy worker-offload
      // backend is enabled. This matches the provider dispatch path and keeps the
      // "Default (follow the brain)" UI truthful.
      if (getActiveAuthMode() === 'claude_oauth') return getClaudeBrainModel();
      if (mode === 'worker' && byo.configured) return getWorkerModel();
      return MODELS.primary;
  }
}

/**
 * Resolve the model + provider for a role. Precedence: a durable role-wide
 * binding (no whenIntent) wins, else the provider-derived default. (Session
 * bindings + free-form intent matching arrive with later phases; the `intent`
 * param is accepted now so call sites are forward-compatible.)
 */
export function resolveRoleModel(role: ModelRole, _intent?: string): ResolvedRoleModel {
  const bindings = readDurableBindings();
  const match = bindings.find((b) => b.role === role && !b.whenIntent);
  if (match) {
    return { modelId: match.modelId, provider: resolveProvider(match.modelId), source: match.source };
  }
  const modelId = defaultForRole(role);
  return { modelId, provider: resolveProvider(modelId), source: 'default' };
}
