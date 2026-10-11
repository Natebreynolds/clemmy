/**
 * memory-model-route — which model does memory's thinking, and whether it can
 * right now.
 *
 * The "Keeps your memory" role (`memory` in the role registry, Settings-only)
 * governs the jobs whose `modelOwner` is `memory` in memory-jobs.ts: learn,
 * reconcile, patterns, skills, identity and import. Two ways to be served:
 *
 *   chosen    — the owner bound a model to the role. Every governed job asks
 *               for exactly that model (buildExactRoleModel): no downshift, no
 *               hedge, no fallover. When the choice cannot be served (its
 *               account is disconnected, out of credit or out of quota) the
 *               route is null and learning WAITS; nothing stands in silently.
 *   automatic — nothing bound. Each job keeps the model it ran on before the
 *               role existed: learn / reconcile / patterns take exactly the
 *               model resolveBoundaryJudge() selects (explicit checker pins
 *               included); skills / identity / import take exactly the
 *               model the owner chose to do the work. A model the owner never
 *               chose never serves memory because it happens to be signed in
 *               (owner, 2026-10-10: "Background memory should run on what the
 *               user has selected"). When that model cannot be served the
 *               route is null too, and learning waits: memory work never
 *               spends a part's tries on a model that cannot answer.
 *
 * Either way the route records its calls under route role `memory` with the
 * job in the decision reason, so the ledger tells memory work apart from
 * review. (Side effect: memory calls no longer feed the checker's learned
 * route policy.)
 *
 * The Settings memory row and the Memory tab name `describeMemoryModel()` —
 * this route's own resolution — never `resolveRoleModel('judge')`, which can
 * differ (a same-family checker, a downshifted default).
 *
 * Nothing here throws, and nothing here waits on the network. Each public
 * read runs under one runtime-config snapshot: resolving the route reads the
 * role registry many times, and an unscoped read parses the env file anew.
 */
import type { Model } from '@openai/agents-core';
import { withRuntimeConfigSnapshot } from '../config.js';
import { memoryJobUsesMemoryModel, type MemoryJobId } from './memory-jobs.js';
import {
  modelProviderLive,
  readDurableBindings,
  registerMemoryAutomaticModel,
  resolveRoleModel,
  unavailableSavedBrain,
  type InactiveRoleBinding,
  type ResolvedRoleModel,
} from '../runtime/harness/model-roles.js';
import {
  buildExactRoleModel,
  resolveBoundaryJudge,
  resolveBoundaryJudgeHedge,
  type BoundaryJudgeRouting,
} from '../runtime/harness/debate-model.js';
import {
  checkerQuotaExhaustion,
  judgeCrossFamilyEnabled,
} from '../runtime/harness/judge-family.js';
import { resolveByoProviderForModel } from '../runtime/harness/byo-providers.js';
import type { ModelProviderClass } from '../runtime/harness/model-wire-registry.js';
import { creditRefusal } from '../runtime/provider-credit.js';
import { getRateLimitSnapshot } from '../runtime/harness/rate-limit-store.js';
import { reflectionExtractorPause } from './reflection.js';
import type { MemoryModelProblem } from './memory-work-types.js';

export type { MemoryModelProblem } from './memory-work-types.js';

export interface MemoryModelRoute {
  job: MemoryJobId;
  /** SDK model object to hand to the Agent (automatic skills/identity/import
   *  keep today's model string, resolved by the process-global provider). */
  model: Model | string;
  /** What will be asked for. */
  modelId: string;
  source: 'chosen' | 'automatic';
  /** Automatic boundary-route jobs only: whose model the route borrows today. */
  follows: 'checker' | 'brain' | null;
  /** The provider family the model is bound to; absent for a bare model string. */
  provider?: ModelProviderClass;
  /** Automatic boundary-route jobs: the checker routing this route reuses, so
   *  a caller keeps today's hedge, deadline and transport semantics. */
  boundary?: BoundaryJudgeRouting;
}

export interface MemoryModelUnavailable {
  problem: MemoryModelProblem;
  /** ISO time the trouble is expected to clear, when a provider said so. */
  until?: string;
}

export interface MemoryModelDescription {
  source: 'chosen' | 'automatic';
  /** The model the next memory job will ask for: the owner's pick (even while
   *  it cannot be served; `unavailable` says why), or the automatic route's
   *  model. Null when no automatic route can be built. */
  modelId: string | null;
  follows: 'checker' | 'brain' | null;
  provider?: ModelProviderClass | null;
  /** The owner's pick when it cannot be served right now. */
  inactiveBinding?: InactiveRoleBinding | null;
  unavailable?: MemoryModelUnavailable | null;
}

export type MemoryModelAvailability =
  | { ok: true }
  | { ok: false; reason: 'model_paused' | 'model_unavailable'; problem?: MemoryModelProblem; until?: string };

/** Jobs whose automatic model is the boundary checker's selection. */
const BOUNDARY_JOBS: ReadonlySet<MemoryJobId> = new Set(['learn', 'reconcile', 'patterns', 'standing']);

/** The job that stands for "memory's model" on Settings and the Memory tab:
 *  the learning extractor, which makes most memory calls. */
const DESCRIBED_JOB: MemoryJobId = 'learn';

function isoTime(ms: number | undefined): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The owner's role-wide memory pick, read without resolving a default. */
function hasMemoryBinding(): boolean {
  return readDurableBindings().some((binding) => binding.role === 'memory' && !binding.whenIntent);
}

/** The owner's pick as the role registry resolves it (live-checked), or null
 *  when nothing is bound. */
function chosenMemoryRole(): ResolvedRoleModel | null {
  if (!hasMemoryBinding()) return null;
  const resolved = resolveRoleModel('memory');
  if (resolved.inactiveBinding) return resolved;
  return resolved.source === 'default' || resolved.source === 'policy' ? null : resolved;
}

/** `checker` iff the automatic model IS the checker's configured model,
 *  `brain` iff it is the brain's, by exact id. Otherwise null (for example a
 *  cheap same-family model the checker only uses at the boundary). */
function followsFor(modelId: string): 'checker' | 'brain' | null {
  try {
    if (modelId && modelId === resolveRoleModel('judge').modelId) return 'checker';
    if (modelId && modelId === resolveRoleModel('brain').modelId) return 'brain';
  } catch { /* an unresolvable role follows nobody */ }
  return null;
}

/** The model the owner chose to do the work, when its account can serve it;
 *  otherwise why not. A saved choice that cannot serve right now is still the
 *  choice: the jobs wait for it and resume on it, never on the model standing
 *  in for it (that fallback is the conversation's, not memory's). Builds
 *  nothing. */
function selectedBrain(): { brain: ResolvedRoleModel; why?: undefined } | { brain: null; why: MemoryModelUnavailable } {
  const saved = unavailableSavedBrain();
  if (saved) return { brain: null, why: problemForModel(saved.provider, saved.modelId) };
  const brain = resolveRoleModel('brain');
  if (!brain.modelId) return { brain: null, why: { problem: 'not_connected' } };
  if (!modelProviderLive(brain.modelId, brain.provider)) return { brain: null, why: problemForModel(brain.provider, brain.modelId) };
  return { brain };
}

/** Whether the extractor's cross-family hedge could take a call the route's
 *  own provider cannot. */
function hedgeServes(routing: BoundaryJudgeRouting): boolean {
  try {
    return Boolean(resolveBoundaryJudgeHedge(routing)?.model);
  } catch {
    return false;
  }
}

/** The automatic route for a job, or why there is none right now. */
type AutomaticResolution =
  | { route: MemoryModelRoute; why?: undefined }
  | { route: null; why: MemoryModelUnavailable };

function resolveAutomatic(job: MemoryJobId): AutomaticResolution {
  if (!BOUNDARY_JOBS.has(job)) {
    // Exactly the model the owner chose to do the work: no fast-tier string
    // for the router to send wherever a subscription happens to be signed in.
    const { brain, why } = selectedBrain();
    if (!brain) return { route: null, why };
    const model = buildExactRoleModel(brain, 'memory', { job });
    if (!model) return { route: null, why: problemForModel(brain.provider, brain.modelId) };
    return { route: { job, model, modelId: brain.modelId, source: 'automatic', follows: 'brain', provider: brain.provider } };
  }
  let routing: BoundaryJudgeRouting;
  try {
    routing = resolveBoundaryJudge(undefined, undefined, { role: 'memory', job });
  } catch {
    return { route: null, why: automaticProblem() }; // the checker's route cannot be built right now: learning waits
  }
  if (!routing.model) return { route: null, why: automaticProblem() };
  // The checker's selection builds its model even when that provider is
  // signed out (a review fails open). Memory work cannot fail open: it waits
  // for the model, unless the extractor's hedge can take the call.
  if (!modelProviderLive(routing.modelId, routing.judgeFamily) && !hedgeServes(routing)) {
    return { route: null, why: problemForModel(routing.judgeFamily, routing.modelId) };
  }
  return {
    route: {
      job,
      model: routing.model,
      modelId: routing.modelId,
      source: 'automatic',
      follows: followsFor(routing.modelId),
      provider: routing.judgeFamily,
      boundary: routing,
    },
  };
}

function automaticRoute(job: MemoryJobId): MemoryModelRoute | null {
  return resolveAutomatic(job).route;
}

/**
 * The model a governed memory job runs on now, or null when it cannot run
 * (the owner's pick is unavailable, or no automatic route can be built) — the
 * caller waits and never substitutes. Null too for a job the memory model does
 * not govern (standing, verify, index, tidy). Never throws.
 */
export function resolveMemoryModelRoute(job: MemoryJobId): MemoryModelRoute | null {
  return withRuntimeConfigSnapshot(() => resolveMemoryModelRouteNow(job));
}

function resolveMemoryModelRouteNow(job: MemoryJobId): MemoryModelRoute | null {
  try {
    if (!memoryJobUsesMemoryModel(job)) return null;
    const chosen = chosenMemoryRole();
    if (!chosen) return automaticRoute(job);
    if (chosen.inactiveBinding) return null;
    const model = buildExactRoleModel(chosen, 'memory', { job });
    if (!model) return null;
    return { job, model, modelId: chosen.modelId, source: 'chosen', follows: null, provider: chosen.provider };
  } catch {
    return null;
  }
}

/** When a used-up subscription plan whose windows the app reads serves
 *  again, from the same reading that proved it used up: the refusal latch's
 *  end, else the latest reset among the windows at their limit. Undefined
 *  when the reading names no time (never guessed). */
function codexQuotaResetAt(now: number): number | undefined {
  try {
    const codex = getRateLimitSnapshot().codex;
    if (!codex) return undefined;
    if (typeof codex.exhaustedUntil === 'number' && codex.exhaustedUntil > now) return codex.exhaustedUntil;
    const resets = [codex.primary, codex.secondary]
      .map((window) => (window && window.usedPercent >= 100 ? window.resetAt : undefined))
      .filter((resetAt): resetAt is number => typeof resetAt === 'number' && resetAt > now);
    return resets.length ? Math.max(...resets) : undefined;
  } catch {
    return undefined;
  }
}

/** The best reason a model on `provider` cannot be served, from signals the
 *  app already keeps: a used-up plan (with its reset), a refused prepaid
 *  balance, or a missing connection. */
function problemForModel(provider: ModelProviderClass, modelId: string): MemoryModelUnavailable {
  if (provider === 'claude' || provider === 'codex') {
    const now = Date.now();
    const exhausted = checkerQuotaExhaustion(provider, now);
    if (exhausted) {
      const until = isoTime(exhausted.resetAt ?? (provider === 'codex' ? codexQuotaResetAt(now) : undefined));
      return { problem: 'quota', ...(until ? { until } : {}) };
    }
    return { problem: 'not_connected' };
  }
  let accountId: string | undefined;
  try {
    accountId = resolveByoProviderForModel(modelId)?.providerId || undefined;
  } catch { /* an ambiguous id belongs to no single account */ }
  if (accountId && creditRefusal(accountId)) return { problem: 'credit' };
  // A provider that owns the model but still could not be built is an error;
  // no owning provider means the model is not connected.
  return { problem: accountId ? 'error' : 'not_connected' };
}

/** Why the automatic boundary route could not be built: the checker the
 *  selection would have used (the owner's unavailable checker pick, or the
 *  brain family's model when an unpinned checker stays in-family). */
function automaticProblem(): MemoryModelUnavailable {
  try {
    const checker = resolveRoleModel('judge');
    if (checker.inactiveBinding) return problemForModel(checker.inactiveBinding.provider, checker.inactiveBinding.modelId);
    const pinned = checker.source !== 'default' && checker.source !== 'policy';
    if (!pinned && !judgeCrossFamilyEnabled()) {
      const brain = resolveRoleModel('brain');
      return problemForModel(brain.provider, brain.modelId);
    }
    return problemForModel(checker.provider, checker.modelId);
  } catch {
    return { problem: 'error' };
  }
}

/** The extractor's backoff window, as the Memory tab says it. */
function pausedFor(job: MemoryJobId): MemoryModelUnavailable | null {
  if (job !== 'learn') return null;
  try {
    const pause = reflectionExtractorPause();
    if (!pause) return null;
    const until = isoTime(pause.until);
    return { problem: pause.problem, ...(until ? { until } : {}) };
  } catch {
    return null;
  }
}

/**
 * The memory model as Settings and the Memory tab show it: chosen or
 * automatic, the model the next memory job asks for, whose model it borrows,
 * and why it cannot be served right now. Never throws; an unreadable state
 * reads as automatic with no model named.
 */
export function describeMemoryModel(): MemoryModelDescription {
  return withRuntimeConfigSnapshot(describeMemoryModelNow);
}

function describeMemoryModelNow(): MemoryModelDescription {
  try {
    const chosen = chosenMemoryRole();
    if (chosen?.inactiveBinding) {
      const inactive = chosen.inactiveBinding;
      return {
        source: 'chosen',
        modelId: inactive.modelId,
        follows: null,
        provider: inactive.provider,
        inactiveBinding: { ...inactive },
        unavailable: problemForModel(inactive.provider, inactive.modelId),
      };
    }
    if (chosen) {
      const route = resolveMemoryModelRoute(DESCRIBED_JOB);
      return {
        source: 'chosen',
        modelId: chosen.modelId,
        follows: null,
        provider: chosen.provider,
        inactiveBinding: null,
        unavailable: route ? pausedFor(DESCRIBED_JOB) : problemForModel(chosen.provider, chosen.modelId),
      };
    }
    const { route, why } = resolveAutomatic(DESCRIBED_JOB);
    if (!route) {
      return { source: 'automatic', modelId: null, follows: null, provider: null, inactiveBinding: null, unavailable: why };
    }
    return {
      source: 'automatic',
      modelId: route.modelId,
      follows: route.follows,
      provider: route.provider ?? null,
      inactiveBinding: null,
      unavailable: pausedFor(DESCRIBED_JOB),
    };
  } catch {
    return { source: 'automatic', modelId: null, follows: null, provider: null, inactiveBinding: null, unavailable: null };
  }
}

/** A governed job's model as it is served: the model id, and the provider
 *  (with its BYO backend, when the router picked one) serving it. */
export interface MemoryJobServing {
  modelId: string;
  provider: ModelProviderClass | null;
  /** The BYO backend's registry id, when the router routed to a named one. */
  byoProviderId?: string;
}

/**
 * How a governed job's model is served, read from one description without
 * building a model (the Memory tab and the token meter poll it): the owner's
 * pick for every job when chosen; for automatic, the described checker
 * selection for learn / reconcile / patterns (they share it), and for the
 * others the model the owner chose to do the work. Null for a job the
 * memory model does not govern, or when nothing can be named. Never throws.
 */
export function memoryJobServing(job: MemoryJobId, described?: MemoryModelDescription): MemoryJobServing | null {
  return withRuntimeConfigSnapshot(() => memoryJobServingNow(job, described ?? describeMemoryModel()));
}

function memoryJobServingNow(job: MemoryJobId, described: MemoryModelDescription): MemoryJobServing | null {
  try {
    if (!memoryJobUsesMemoryModel(job)) return null;
    if (described.source === 'chosen' || BOUNDARY_JOBS.has(job)) {
      return described.modelId ? { modelId: described.modelId, provider: described.provider ?? null } : null;
    }
    // A model its account cannot serve is not the job's model.
    const { brain } = selectedBrain();
    if (!brain) return null;
    let byoProviderId: string | undefined;
    if (brain.provider === 'byo') {
      try { byoProviderId = resolveByoProviderForModel(brain.modelId)?.providerId || undefined; } catch { byoProviderId = undefined; }
    }
    return { modelId: brain.modelId, provider: brain.provider, ...(byoProviderId ? { byoProviderId } : {}) };
  } catch {
    return null;
  }
}

/** The model id a governed job would ask for (see memoryJobServing). */
export function memoryJobModelId(job: MemoryJobId, described?: MemoryModelDescription): string | null {
  return memoryJobServing(job, described)?.modelId ?? null;
}

/**
 * Whether `job` may start model work now. Learning checks this BEFORE it
 * claims anything, so a paused or unreachable model makes it wait instead of
 * burning retries into dead letters. A job the memory model does not govern
 * is always ok here (its own route decides). Never throws.
 */
export function memoryModelAvailability(job: MemoryJobId): MemoryModelAvailability {
  return withRuntimeConfigSnapshot(() => memoryModelAvailabilityNow(job));
}

function memoryModelAvailabilityNow(job: MemoryJobId): MemoryModelAvailability {
  try {
    if (!memoryJobUsesMemoryModel(job)) return { ok: true };
    const paused = pausedFor(job);
    if (paused) return { ok: false, reason: 'model_paused', ...paused };
    const chosen = chosenMemoryRole();
    if (!chosen) {
      const { route, why } = resolveAutomatic(job);
      return route ? { ok: true } : { ok: false, reason: 'model_unavailable', ...why };
    }
    if (resolveMemoryModelRoute(job)) return { ok: true };
    const target = chosen.inactiveBinding ?? chosen;
    return { ok: false, reason: 'model_unavailable', ...problemForModel(target.provider, target.modelId) };
  } catch {
    return { ok: false, reason: 'model_unavailable', problem: 'error' };
  }
}

/**
 * The Settings row for "Keeps your memory", in the shape every other role row
 * has (`ResolvedRoleModel`) plus `follows` and `unavailable`. `source` is
 * `settings`/`chat-rule` when chosen and `default` when automatic; `modelId`
 * is '' when nothing is being used (no automatic route, or the pick is
 * unavailable — `inactiveBinding` names it; nothing stands in).
 */
export function memoryRoleSettingsView(): {
  modelId: string;
  /** Absent when no model is named (never guessed). */
  provider?: ModelProviderClass;
  source: ResolvedRoleModel['source'];
  inactiveBinding?: InactiveRoleBinding;
  follows: 'checker' | 'brain' | null;
  unavailable?: MemoryModelUnavailable;
} {
  const described = describeMemoryModel();
  const provider = described.provider ? { provider: described.provider } : {};
  if (described.source === 'chosen') {
    let source: ResolvedRoleModel['source'] = 'settings';
    try {
      const binding = readDurableBindings().find((b) => b.role === 'memory' && !b.whenIntent);
      if (binding) source = binding.source;
    } catch { /* the pick was saved from Settings */ }
    return {
      modelId: described.inactiveBinding ? '' : described.modelId ?? '',
      ...provider,
      source,
      ...(described.inactiveBinding ? { inactiveBinding: described.inactiveBinding } : {}),
      follows: null,
      ...(described.unavailable ? { unavailable: described.unavailable } : {}),
    };
  }
  return {
    modelId: described.modelId ?? '',
    ...provider,
    source: 'default',
    follows: described.follows,
    ...(described.unavailable ? { unavailable: described.unavailable } : {}),
  };
}

// The role registry reports the automatic memory model as its default for the
// role, without importing this module (it sits below debate-model).
registerMemoryAutomaticModel(() => automaticRoute(DESCRIBED_JOB)?.modelId ?? null);
