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
 *               included); skills / identity / import keep today's fast-tier
 *               model string.
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
 * Nothing here throws, and nothing here waits on the network.
 */
import type { Model } from '@openai/agents-core';
import { DEFAULT_CODEX_FAST_MODEL, MODELS } from '../config.js';
import { memoryJobUsesMemoryModel, type MemoryJobId } from './memory-jobs.js';
import {
  readDurableBindings,
  registerMemoryAutomaticModel,
  resolveRoleModel,
  type InactiveRoleBinding,
  type ResolvedRoleModel,
} from '../runtime/harness/model-roles.js';
import {
  buildExactRoleModel,
  resolveBoundaryJudge,
  type BoundaryJudgeRouting,
} from '../runtime/harness/debate-model.js';
import { checkerQuotaExhaustion, judgeCrossFamilyEnabled } from '../runtime/harness/judge-family.js';
import { resolveByoProviderForModel } from '../runtime/harness/byo-providers.js';
import type { ModelProviderClass } from '../runtime/harness/model-wire-registry.js';
import { creditRefusal } from '../runtime/provider-credit.js';
import { getRateLimitSnapshot } from '../runtime/harness/rate-limit-store.js';
import { reflectionExtractorPause } from './reflection.js';

/** Why a model call could not run. Never a provider name. Mirrors
 *  packages/chat-engine/src/memory-work.ts `MemoryModelProblem`. */
export type MemoryModelProblem = 'quota' | 'credit' | 'not_connected' | 'timeout' | 'error';

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
  /** Only automatic boundary-route jobs may carry today's hedge/pause semantics. */
  timeoutMs?: number;
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
const BOUNDARY_JOBS: ReadonlySet<MemoryJobId> = new Set(['learn', 'reconcile', 'patterns']);

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

/** Today's fast-tier string for the jobs that never had a bound model. */
function automaticFastModelId(job: MemoryJobId): string {
  return job === 'import' ? (MODELS.fast || MODELS.primary || DEFAULT_CODEX_FAST_MODEL) : MODELS.fast;
}

function automaticRoute(job: MemoryJobId): MemoryModelRoute | null {
  if (!BOUNDARY_JOBS.has(job)) {
    const modelId = automaticFastModelId(job);
    return modelId ? { job, model: modelId, modelId, source: 'automatic', follows: null } : null;
  }
  let routing: BoundaryJudgeRouting;
  try {
    routing = resolveBoundaryJudge(undefined, undefined, { role: 'memory', job });
  } catch {
    return null; // the checker's route cannot be built right now: learning waits
  }
  if (!routing.model) return null;
  return {
    job,
    model: routing.model,
    modelId: routing.modelId,
    source: 'automatic',
    follows: followsFor(routing.modelId),
    ...(typeof routing.timeoutMs === 'number' ? { timeoutMs: routing.timeoutMs } : {}),
    provider: routing.judgeFamily,
    boundary: routing,
  };
}

/**
 * The model a governed memory job runs on now, or null when it cannot run
 * (the owner's pick is unavailable, or no automatic route can be built) — the
 * caller waits and never substitutes. Null too for a job the memory model does
 * not govern (standing, verify, index, tidy). Never throws.
 */
export function resolveMemoryModelRoute(job: MemoryJobId): MemoryModelRoute | null {
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

/** When a used-up Codex plan serves again, from the same reading that proved it
 *  used up: the refusal latch's end, else the latest reset among the windows
 *  at their limit. Undefined when the reading names no time (never guessed). */
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
    const route = automaticRoute(DESCRIBED_JOB);
    if (!route) {
      return { source: 'automatic', modelId: null, follows: null, provider: null, inactiveBinding: null, unavailable: automaticProblem() };
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

/**
 * Whether `job` may start model work now. Learning checks this BEFORE it
 * claims anything, so a paused or unreachable model makes it wait instead of
 * burning retries into dead letters. A job the memory model does not govern
 * is always ok here (its own route decides). Never throws.
 */
export function memoryModelAvailability(job: MemoryJobId): MemoryModelAvailability {
  try {
    if (!memoryJobUsesMemoryModel(job)) return { ok: true };
    const paused = pausedFor(job);
    if (paused) return { ok: false, reason: 'model_paused', ...paused };
    if (resolveMemoryModelRoute(job)) return { ok: true };
    const chosen = chosenMemoryRole();
    const target = chosen?.inactiveBinding ?? chosen;
    const why = target ? problemForModel(target.provider, target.modelId) : automaticProblem();
    return { ok: false, reason: 'model_unavailable', ...why };
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
