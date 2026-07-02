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
  DEFAULT_CODEX_MODEL,
} from '../../config.js';
import { validateRoleModelBinding } from './model-role-options.js';
import { pickRoutePolicyModel } from './route-policy.js';
import { resolveProvider, type ModelProviderClass } from './model-wire-registry.js';
import { slugifyIntent } from '../../memory/tool-choice-store.js';
import {
  chooseBoundaryJudgeFamily,
  judgeCrossFamilyEnabled,
  debateBrainsAvailable,
  boundaryClaudeJudgeModel,
  boundaryCodexJudgeModel,
} from './judge-family.js';

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
  source: 'default' | 'settings' | 'chat-rule' | 'session' | 'policy';
  inactiveBinding?: InactiveRoleBinding;
  /** The binding's free-form intent slug that matched this resolution (set only
   *  when an intent-scoped binding won) — drives the routing trace + hit/miss. */
  matchedIntent?: string;
  /** Set when the learned route policy won: the evidence behind the pick. */
  policy?: { score: number; defaultScore: number; sampleCount: number; policyVersion: number };
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
/**
 * Brain-aware judge DEFAULT (feedback [[feedback_judge_different_family]]: the
 * judge should be a DIFFERENT LLM family than the brain whenever possible — never
 * self-grade). Returns a cheap judge id from a family DIFFERENT than the brain, or
 * '' to fall through to the legacy same-family default. PURE — availability, the
 * kill-switch, and the explicit-pin are injected — so it's deterministically
 * testable. Never overrides an explicit CLEMMY_DEBATE_JUDGE pin, and fails open
 * (→ '') for single-family users, so it's a no-regression change.
 */
export function judgeDefaultModel(
  brainProvider: ModelProviderClass,
  avail: { claude: boolean; codex: boolean },
  opts: { crossFamilyEnabled: boolean; explicitJudgeChoice: string },
): string {
  if (!opts.crossFamilyEnabled) return '';
  const explicit = opts.explicitJudgeChoice.trim().toLowerCase();
  if (explicit === 'claude' || explicit === 'codex') return ''; // honor the user's explicit pin (legacy path)
  const cross = chooseBoundaryJudgeFamily(brainProvider, avail.claude, avail.codex);
  return cross?.modelId ?? '';
}

/** MODELS.primary, guarded for a Codex brain. When codex_oauth is the active
 *  brain but the OPENAI_MODEL_* slot was repurposed for a BYO model id (e.g.
 *  glm-5.2, which resolveProvider routes to a BYO endpoint), returning it would
 *  silently send the "Codex" brain straight back to the BYO provider — the
 *  "switched the brain to Codex but everything still ran on GLM" bug. Fall back
 *  to the canonical Codex default so the turn actually runs on Codex. Non-codex
 *  brains (claude_oauth handled by callers; api_key/all-in handled above) and a
 *  correctly-set Codex primary are unaffected (byte-identical). */
function codexSafePrimary(): string {
  if (getActiveAuthMode() === 'codex_oauth' && resolveProvider(MODELS.primary) !== 'codex') {
    return DEFAULT_CODEX_MODEL;
  }
  return MODELS.primary;
}

/** The brain's provider family — the family the wire will ACTUALLY dispatch the
 *  brain to. Reuses defaultForRole('brain') so all_in→byo, claude_oauth→claude,
 *  codex_oauth→codex (guarded) are all classified correctly, and a repurposed
 *  OPENAI_MODEL_* slot can't mislabel a Codex brain as 'byo'. */
function activeBrainFamily(): ModelProviderClass {
  return resolveProvider(defaultForRole('brain'));
}

/** MODELS.fast, guarded against a repurposed OPENAI_MODEL_FAST slot that holds a
 *  BYO id (e.g. glm-5.2). MODELS.fast is the JUDGE/warmup fail-open across the
 *  boundary gates; when that slot routes to a BYO endpoint the (parallel) judge
 *  lanes and the boot warmup storm the BYO provider even though the user never
 *  picked BYO for the brain — the observed 429 burst ("set the brain to Codex but
 *  everything still ran on GLM"). When the fast slot would route to BYO but the
 *  brain is NOT byo, fall back to the brain family's cheap, code-level judge id so
 *  the fail-open stays on the brain's own family (an already-tagged self-judge)
 *  instead of an unintended BYO storm. A fast slot that already matches the brain
 *  family, or a genuine BYO brain, is unaffected (byte-identical). Mirrors
 *  codexSafePrimary(). */
export function codexSafeFast(): string {
  const fast = MODELS.fast;
  if (resolveProvider(fast) !== 'byo') return fast;
  const brainFamily = activeBrainFamily();
  if (brainFamily === 'byo') return fast; // the user really is on BYO — intended
  return brainFamily === 'claude' ? boundaryClaudeJudgeModel() : boundaryCodexJudgeModel();
}

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
    // role === 'brain': honor an explicit per-model brain override (set when the
    // user picks a SPECIFIC connected model as the brain — e.g. a Together AI
    // model living in an EXTRA provider, not the default slot). The router routes
    // this id to its OWNING provider's baseURL+key via resolveByoProviderForModel
    // — no credential moves, no slot reshuffle. The active-brain route validates
    // it's a real, configured connected model before writing it; if a stale id
    // ever slipped through, the router falls back to the default BYO backend.
    const brainOverride = (getRuntimeEnv('BYO_BRAIN_MODEL_ID', '') || '').trim();
    return brainOverride || byo.primaryId;
  }

  switch (role) {
    case 'brain': {
      // claude_oauth ⇒ the Claude brain; all_in+byo ⇒ the BYO primary; else the
      // Codex primary — exactly the configureHarnessRuntime outcomes.
      if (getActiveAuthMode() === 'claude_oauth') return getClaudeBrainModel();
      return codexSafePrimary();
    }
    case 'judge': {
      // Cross-family by default (feedback: the judge should be a DIFFERENT LLM
      // family than the brain whenever possible — never self-grade). When the
      // cross-family flag is on, the user hasn't explicitly pinned a judge family,
      // and a different family is logged in, default the judge to a cheap model
      // from that other family. Otherwise fall through to the legacy choice:
      // judge=claude ⇒ the checker model (Sonnet); judge=codex ⇒ the Codex primary.
      // Use codexSafePrimary() (not raw MODELS.primary) so the brain-provider read
      // matches the brain the wire ACTUALLY runs — otherwise a BYO id leaked into
      // the OPENAI_MODEL_* slot would mislabel a Codex brain as 'byo' here.
      const brainProvider: ModelProviderClass =
        getActiveAuthMode() === 'claude_oauth' ? 'claude' : resolveProvider(codexSafePrimary());
      const crossFamily = judgeDefaultModel(brainProvider, debateBrainsAvailable(), {
        crossFamilyEnabled: judgeCrossFamilyEnabled(),
        explicitJudgeChoice: getRuntimeEnv('CLEMMY_DEBATE_JUDGE', '') || '',
      });
      if (crossFamily) return crossFamily;
      return judgeChoice() === 'claude' ? getDebateCheckerModel() : codexSafePrimary();
    }
    case 'worker':
    default:
      // Default workers follow the active brain unless the legacy worker-offload
      // backend is enabled. This matches the provider dispatch path and keeps the
      // "Default (follow the brain)" UI truthful.
      if (getActiveAuthMode() === 'claude_oauth') return getClaudeBrainModel();
      if (mode === 'worker' && byo.configured) return getWorkerModel();
      return codexSafePrimary();
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
  // Learned route policy — consulted ONLY when no explicit binding matched
  // (user bindings always win), bounded by min-samples/floor/hysteresis inside
  // pickRoutePolicyModel, and live-validated exactly like a binding. Empty
  // policy table / kill-switch off ⇒ falls through byte-identically.
  try {
    const pick = pickRoutePolicyModel(role, querySlug || undefined, modelId,
      (candidateId) => validateRoleModelBinding(role, candidateId).ok);
    if (pick) {
      return {
        modelId: pick.modelId,
        provider: resolveProvider(pick.modelId),
        source: 'policy',
        ...(querySlug ? { matchedIntent: querySlug } : {}),
        policy: {
          score: pick.score,
          defaultScore: pick.defaultScore,
          sampleCount: pick.sampleCount,
          policyVersion: pick.policyVersion,
        },
        ...(firstInvalid
          ? {
              inactiveBinding: {
                modelId: firstInvalid.match.modelId,
                provider: resolveProvider(firstInvalid.match.modelId),
                source: firstInvalid.match.source,
                reason: firstInvalid.reason,
              },
            }
          : {}),
      };
    }
  } catch { /* the policy read must never break resolution */ }
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
