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
 * Invariant: with NO bindings written (CLEMMY_MODEL_ROLES unset), each role
 * reports the model id the registered provider will actually dispatch. Defaults
 * are provider-derived, and saved bindings are live-checked at read time so a
 * disconnected backend falls back instead of dispatching a dead model. Kill-
 * switch CLEMMY_MODEL_ROLES_REGISTRY (default on; off ⇒ defaults only, bindings
 * ignored).
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
import { validateRoleModelBinding } from './model-role-options.js';
import { resolveProvider, type ModelProviderClass } from './model-wire-registry.js';
import { slugifyIntent } from '../../memory/tool-choice-store.js';

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

export interface InactiveRoleBinding {
  modelId: string;
  provider: ModelProviderClass;
  source: 'settings' | 'chat-rule' | 'session';
  reason: string;
}

export interface ResolvedRoleModel {
  modelId: string;
  provider: ModelProviderClass;
  source: 'default' | 'settings' | 'chat-rule' | 'session';
  inactiveBinding?: InactiveRoleBinding;
  /** The binding's free-form intent slug that matched this resolution (set only
   *  when an intent-scoped binding won) — drives the routing trace + hit/miss. */
  matchedIntent?: string;
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
 * Resolve the model + provider for a role, optionally scoped to a free-form
 * INTENT (the user's own category word, e.g. "design"). Precedence, most-specific
 * first: (1) an EXACT-slug intent binding for this role, (2) a role-wide binding
 * (no whenIntent), (3) the provider-derived default. Each non-default candidate
 * is live-checked (validateRoleModelBinding); a stale one falls through to the
 * NEXT tier (not straight to default) and the highest failed binding is carried
 * as inactiveBinding. Intent matching is EXACT-slug only — the brain emits the
 * user's word verbatim, so a fuzzy tier never fires on realistic input and only
 * adds mis-route risk. `intent` undefined ⇒ no intent tier ⇒ byte-identical to
 * before this change.
 */
export function resolveRoleModel(role: ModelRole, intent?: string): ResolvedRoleModel {
  const roleBindings = readDurableBindings().filter((b) => b.role === role);
  const querySlug = intent ? slugifyIntent(intent) : '';
  const intentMatch = querySlug
    ? roleBindings.find((b) => b.whenIntent && slugifyIntent(b.whenIntent) === querySlug)
    : undefined;
  const roleWide = roleBindings.find((b) => !b.whenIntent);
  const candidates = [intentMatch, roleWide].filter((b): b is RoleBinding => !!b);

  let firstInvalid: { match: RoleBinding; reason: string } | undefined;
  for (const match of candidates) {
    const v = validateRoleModelBinding(role, match.modelId);
    if (v.ok) {
      return {
        modelId: match.modelId,
        provider: v.provider,
        source: match.source,
        ...(match.whenIntent ? { matchedIntent: match.whenIntent } : {}),
      };
    }
    if (!firstInvalid) firstInvalid = { match, reason: v.reason };
  }
  const modelId = defaultForRole(role);
  return firstInvalid
    ? {
        modelId,
        provider: resolveProvider(modelId),
        source: 'default',
        inactiveBinding: {
          modelId: firstInvalid.match.modelId,
          provider: resolveProvider(firstInvalid.match.modelId),
          source: firstInvalid.match.source,
          reason: firstInvalid.reason,
        },
      }
    : { modelId, provider: resolveProvider(modelId), source: 'default' };
}
