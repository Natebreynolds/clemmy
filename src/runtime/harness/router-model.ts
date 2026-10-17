/**
 * RouterModelProvider — dispatches each Agent's model request to the provider
 * implied by the model id: Codex, Claude, or a user-supplied OpenAI-compatible
 * backend (MiniMax/DeepSeek/…).
 *
 * Routing rule:
 *   - `gpt-5*` / `o*` ids → Codex.
 *   - `claude-*` ids      → Claude subscription adapter.
 *   - any other id        → BYO OpenAI-compatible backend.
 *   - all_in mode         → declared BYO models keep their backend; connected
 *                           subscription ids keep their own lane. Undeclared,
 *                           disconnected built-in defaults use the BYO primary.
 *
 * This is what makes the role→model registry real: a role can name a model from
 * any connected provider, and the provider dispatch follows the model id rather
 * than whichever brain happened to be active.
 */
import type { Model, ModelProvider, ModelRequest } from '@openai/agents-core';
import { Agent, Runner } from '@openai/agents';
import { CodexModelProvider } from './codex-model.js';
import { getByoModel } from './byo-model.js';
import {
  assertUnambiguousModelRouting,
  resolveByoProviderForModel,
  resolveDeclaredByoProviderForModel,
  resolveEffectiveProviderForModel,
} from './byo-providers.js';
import { ClaudeModelProvider, claudeHarnessModelSupportsTools } from './claude-model.js';
import { resolveProvider } from './model-wire-registry.js';
import { codexModelsAvailable, claudeModelsAvailable } from './model-role-options.js';
import { withModelFallback, type FallbackTarget } from './fallback-model.js';
import { isPinnedWorkerModel } from './pinned-worker-model.js';
import { maybeWrapWithFaultInjection } from './fault-inject.js';
import { harnessRunContextStorage } from './brackets.js';
import { brainBackupModelIds } from './brain-backups.js';
import { resolvedBrainForSession } from './model-roles.js';
import { modelUsageAttributionStorage } from '../usage-log.js';
import type { ByoBackendConfig } from '../../config.js';
import {
  DEFAULT_CODEX_FAST_MODEL,
  DEFAULT_CLAUDE_FAST_MODEL,
  getActiveAuthMode,
  getByoBackendConfig,
  getClaudeBrainModel,
  getModelRoutingMode,
  getRuntimeEnv,
  MODELS,
} from '../../config.js';
import {
  withModelRouteMetrics,
  type ModelRouteDecisionSource,
  type ModelRouteMetricsContext,
} from '../model-route-metrics.js';
import pino from 'pino';
import {
  modelFirstByteStallMs,
  modelInteractivePreActionableMs,
} from './model-stall-policy.js';

const logger = pino({ name: 'clementine.router-model' });

export type BrainProvider = 'codex' | 'claude' | 'byo';

type SyncModelProvider = {
  getModel(modelName?: string, options?: { allowOverloadFallback?: boolean }): Model;
};

/** Narrow dependency seam for deterministic route tests. Production callers
 * use the defaults; no provider construction or selection behavior changes. */
export interface RouterModelProviderOptions {
  codex?: SyncModelProvider;
  claude?: SyncModelProvider;
  resolveByoModel?: typeof getByoModel;
  /** Canonical wire-provider classifier. Injectable only so route tests can
   * exercise connected-provider decisions without reading a real auth vault. */
  resolveEffectiveProvider?: (modelId: string) => BrainProvider;
  codexAvailable?: () => boolean;
  claudeAvailable?: () => boolean;
}

/** Worker rescue onto the small subscription models. The brain's backups are
 *  the owner's list (brain-backups.ts), never this switch. */
function brainFalloverEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}
/** First-byte fallover budget — set BELOW the loop's stall watchdog (modelFirstByteStallMs,
 *  default 75s) so a hung provider falls over to the next brain instead of dead-ending. */
function brainFalloverFirstByteMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_BRAIN_FALLOVER_FIRST_BYTE_MS', '') || '', 10);
  // The fallover budget MUST stay strictly below the loop's first-byte stall
  // watchdog (modelFirstByteStallMs) — otherwise the watchdog kills the turn
  // before fallover can switch brains, DISABLING cross-brain fallover for a
  // silent hang (adversarial review 07-06 caught a 90s value regressing this
  // against a 75s watchdog). 2026-09-01: raised from 60s to 150s TOGETHER with
  // the watchdog (75s → 180s): a 45k-token authoring prompt on Sonnet crossed
  // 60s before its first content twice, was silenced, and the turn fell to a
  // rate-limited rescue. Interactive foreground turns keep their own 60s
  // pre-actionable wall (modelInteractivePreActionableMs); this budget governs
  // silence, not UX pace. Tunable via CLEMMY_BRAIN_FALLOVER_FIRST_BYTE_MS.
  return Number.isFinite(raw) && raw > 0 ? raw : 150_000;
}

/** BYO's fallover budget, kept strictly under the loop's first-byte watchdog. */
function byoFalloverFirstByteMs(): number {
  const watchdog = modelFirstByteStallMs();
  const budget = brainFalloverFirstByteMs();
  if (watchdog <= 0) return budget;
  // Sit just below the watchdog. Above it, the watchdog kills the turn before
  // the chain can switch — which is exactly the bug this repairs.
  return Math.max(1_000, Math.min(budget * 2, watchdog - 5_000));
}

export function brainFalloverFirstByteMsForProvider(provider: BrainProvider): number | undefined {
  // The BYO adapter completes a non-streaming request and then emits one
  // synthetic stream chunk, so its "first byte" IS the full completion time. A
  // 60s deadline would therefore falsely fail healthy long work — which is why
  // this returned undefined.
  //
  // But undefined did not mean "no deadline": it meant no FALLOVER deadline,
  // while the loop's own first-byte watchdog (75s) still applied. So a hung BYO
  // brain hit the watchdog, retried the SAME dead brain, and the turn died
  // without ever consulting the chain. Live 2026-08-28: three
  // model.transport_timeout retries against one provider, then "the model
  // transport stopped responding" — with a healthy Codex and Claude sitting
  // unused in the chain, both of which serve tool turns fine.
  //
  // A budget just BELOW the watchdog costs nothing that works today: any BYO
  // completion slower than the watchdog was already being killed. It only
  // converts that death into a brain switch, which is the whole point of
  // fallover and of never-resting.
  return provider === 'byo' ? byoFalloverFirstByteMs() : brainFalloverFirstByteMs();
}

function requestNeedsNativeTools(request: ModelRequest): boolean {
  return (Array.isArray(request.tools) && request.tools.length > 0)
    || (Array.isArray(request.handoffs) && request.handoffs.length > 0);
}

function claudeHarnessSupportsRequest(request: ModelRequest): boolean {
  return !requestNeedsNativeTools(request) || claudeHarnessModelSupportsTools();
}

/** Where the router sends a model name first, before any fallover. */
export interface RoutedPrimaryModel {
  /** The name as asked for (the primary model when none was given). */
  requested: string;
  provider: BrainProvider;
  /** The model id asked of that provider. */
  modelId: string;
  /** BYO only: the backend that serves it. */
  backend?: ByoBackendConfig;
  /** Why `modelId` is not the name asked for: all-in routing sends an
   *  undeclared built-in-shaped id to the BYO primary; an active Claude
   *  sign-in with no Codex sends a Codex-shaped id to the Claude brain. */
  via?: 'all_in' | 'claude_no_codex';
}

/**
 * The provider and model the router serves a model name on first, without
 * building a model: ONE rule, used by the router itself and by anything that
 * names the model a bare string reaches (the Memory tab's job rows, the token
 * meter's "keeps your memory" tag). Throws as the router does when the name
 * is ambiguous, or resolves to a BYO backend and none is configured.
 */
export function routedPrimaryModel(
  modelName?: string,
  deps: { resolveEffectiveProvider?: (modelId: string) => BrainProvider; codexAvailable?: () => boolean } = {},
): RoutedPrimaryModel {
  const mode = getModelRoutingMode();
  const requested = typeof modelName === 'string' ? modelName.trim() : '';
  const name = requested || MODELS.primary;
  assertUnambiguousModelRouting(name, mode);

  // Provider selection has ONE truth. In particular, the canonical classifier
  // honors connected subscription ids even while the ambient default is BYO
  // all-in. Reimplementing all-in first can silently change an explicit agent
  // pin into the BYO primary after session resolution selected the pin. Keep
  // fallback-to-primary only when the canonical classifier actually chose BYO
  // (disconnected/stale built-in defaults included).
  const effectiveProvider = !requested && mode === 'all_in' && resolveProvider(name) === 'codex'
    && getByoBackendConfig().configured
    // No model was selected for this call: retain the existing all-in default.
    // An explicit subscription choice (including a saved agent pin) follows
    // the canonical classifier instead of inheriting this ambient collapse.
    ? 'byo'
    : (deps.resolveEffectiveProvider ?? resolveEffectiveProviderForModel)(name);
  switch (effectiveProvider) {
    case 'claude':
      return { requested: name, provider: 'claude', modelId: name };
    case 'byo': {
      // Exact ownership declared by a named BYO provider beats model-id
      // regexes. This is how an OpenAI-compatible endpoint can intentionally
      // serve a model called `gpt-4o` or `claude-*` without being mistaken for
      // a subscription. An undeclared built-in-shaped id in all-in still
      // collapses to the configured BYO primary, preserving the dead-seat
      // guard for ambient/stale defaults.
      const declaredBackend = resolveDeclaredByoProviderForModel(name);
      const backend = declaredBackend ?? resolveByoProviderForModel(name) ?? getByoBackendConfig();
      if (!backend.configured) {
        throw new Error(`Model ${name} resolves to a BYO/OpenAI-compatible backend, but no BYO backend is configured.`);
      }
      const collapse = mode === 'all_in' && !declaredBackend && resolveProvider(name) !== 'byo';
      const modelId = collapse ? (backend.primaryId || name) : name;
      return { requested: name, provider: 'byo', modelId, backend, ...(modelId !== name ? { via: 'all_in' as const } : {}) };
    }
    case 'codex':
    default:
      if (getActiveAuthMode() === 'claude_oauth' && !(deps.codexAvailable ?? codexModelsAvailable)()) {
        return { requested: name, provider: 'claude', modelId: getClaudeBrainModel(), via: 'claude_no_codex' };
      }
      return { requested: name, provider: 'codex', modelId: name };
  }
}

export class RouterModelProvider implements ModelProvider {
  private readonly codex: SyncModelProvider;
  private readonly claude: SyncModelProvider;
  private readonly resolveByoModel: typeof getByoModel;
  private readonly resolveEffectiveProvider: (modelId: string) => BrainProvider;
  private readonly codexAvailable: () => boolean;
  private readonly claudeAvailable: () => boolean;

  constructor(options: RouterModelProviderOptions = {}) {
    this.codex = options.codex ?? new CodexModelProvider();
    this.claude = options.claude ?? new ClaudeModelProvider();
    this.resolveByoModel = options.resolveByoModel ?? getByoModel;
    this.resolveEffectiveProvider = options.resolveEffectiveProvider ?? resolveEffectiveProviderForModel;
    this.codexAvailable = options.codexAvailable ?? codexModelsAvailable;
    this.claudeAvailable = options.claudeAvailable ?? claudeModelsAvailable;
  }

  getModel(modelName?: string): Model {
    const primary = this.resolvePrimary(modelName);
    const exactWorker = typeof modelName === 'string' && isPinnedWorkerModel(modelName);
    if (exactWorker && primary.label !== modelName) {
      throw new Error(`The saved agent requires ${modelName}, but that exact model is unavailable. No substitute was started.`);
    }
    // Dev-only fault injection (no-op unless CLEMMY_FAULT_INJECT_BRAIN names this
    // provider): wrap the resolved primary so a live transient failure can be
    // forced to prove cross-brain fallover. The lazily-built fallover targets in
    // buildBrainChain are different providers → not wrapped → they recover.
    primary.model = maybeWrapWithFaultInjection(primary.model, primary.provider);
    const requested = typeof modelName === 'string' && modelName.trim().length > 0 ? modelName.trim() : MODELS.primary;
    const runContext = harnessRunContextStorage.getStore();
    const sessionId = runContext?.sessionId;
    const waitForOwnModel = modelUsageAttributionStorage.getStore()?.waitForOwnModel === true;
    const backups = exactWorker ? null : this.brainBackupTargets(modelName, primary.label);
    const primarySource = routeSourceForModelName(modelName);
    const primaryMetricsContext: ModelRouteMetricsContext = {
      sessionId,
      workflowRunId: workflowRunIdFromSessionId(sessionId),
      role: runContext?.workerScope === true ? 'worker' : 'brain',
      requestedModel: requested,
      resolvedModel: primary.label,
      provider: primary.provider,
      source: primarySource,
      reason: {
        routingMode: getModelRoutingMode(),
        falloverEnabled: brainFalloverEnabled(),
        routeTargetIndex: 0,
        initialResolvedModel: primary.label,
      },
    };
    const instrumentTargets = (targets: FallbackTarget[]): FallbackTarget[] => targets.map((target, index) => ({
      ...target,
      // Record at the target boundary, not around the aggregate fallback model:
      // one failed primary + one successful rescue are two paid provider calls.
      // The fallback model's replay/mirror of the winning response never crosses
      // this boundary again and therefore cannot double-count usage or cost.
      getModel: () => withModelRouteMetrics(target.getModel(), {
        ...primaryMetricsContext,
        resolvedModel: target.model ?? target.label,
        provider: target.provider ?? 'unknown',
        source: index === 0 ? primarySource : 'fallback',
        reason: {
          routingMode: getModelRoutingMode(),
          falloverEnabled: brainFalloverEnabled(),
          routeTargetIndex: index,
          initialResolvedModel: primary.label,
        },
      }),
    }));
    const workerRescue = !exactWorker && !waitForOwnModel && backups === null && brainFalloverEnabled() && workerScoped(runContext);
    let resolved: Model;
    if (exactWorker || (!backups?.length && !workerRescue)) {
      // No backup: the lone primary still sits behind the same graph boundary
      // so a reasoning-only completion becomes a typed failure instead of an
      // unbounded Agents SDK run-again loop.
      resolved = withModelFallback(instrumentTargets([{
        label: primary.label,
        provider: primary.provider,
        model: primary.label,
        getModel: () => primary.model,
        ...(primary.provider === 'claude' ? { supportsRequest: claudeHarnessSupportsRequest } : {}),
      }]), backups ? { brainLabel: primary.label, sessionId } : {});
    } else {
      // A brain request falls over to the owner's backups, in their order; a
      // worker keeps its role on the small subscription models. falloverOn429:
      // a 429 on one provider is irrelevant to the next, so switch.
      // firstByteTimeoutMs: a silent provider falls over before the loop's
      // stall watchdog fires.
      const chain = instrumentTargets(backups?.length
        ? [this.primaryTarget(primary), ...backups]
        : this.workerChain(primary));
      // Correlate a fallover to the run that triggered it. getModel runs inside
      // the harness run ALS (the loop wraps runner.run), so the active sessionId
      // is available here; workflow step sessions encode the run id in the id.
      const runSilencedLabels = runContext
        ? (runContext.silencedModelLabels ??= new Set<string>())
        : undefined;
      const preActionableTimeoutMs = runContext?.interactiveForeground === true
        && runContext.workerScope !== true
        && !runContext.guardrailScopeId
        ? modelInteractivePreActionableMs()
        : undefined;
      resolved = withModelFallback(chain, {
        falloverOn429: true,
        firstByteTimeoutMs: brainFalloverFirstByteMsForProvider(primary.provider),
        preActionableTimeoutMs,
        sessionId,
        workflowRunId: workflowRunIdFromSessionId(sessionId),
        runSilencedLabels,
        ...(backups ? { brainLabel: primary.label } : {}),
      });
    }
    // Preserve the router's existing read-only introspection surface without
    // wrapping the aggregate fallback model in another recorder. Recording is
    // deliberately confined to concrete targets above, so this metadata cannot
    // create a mirror outcome for the winning response.
    Object.defineProperty(resolved, 'context', {
      value: primaryMetricsContext,
      enumerable: false,
      configurable: true,
    });
    return resolved;
  }

  /** Resolve the single model the routing rules pick (no fallover) + which
   *  provider it is, so the chain builder can append the OTHER providers.
   *  The pick itself is `routedPrimaryModel`; this builds it. */
  private resolvePrimary(modelName?: string): { model: Model; provider: BrainProvider; label: string } {
    const routed = routedPrimaryModel(modelName, {
      resolveEffectiveProvider: this.resolveEffectiveProvider,
      codexAvailable: this.codexAvailable,
    });
    const allowOverloadFallback = harnessRunContextStorage.getStore()?.workerScope !== true
      && modelUsageAttributionStorage.getStore()?.waitForOwnModel !== true
      && !(typeof modelName === 'string' && isPinnedWorkerModel(modelName));
    switch (routed.provider) {
      case 'claude':
        if (routed.via === 'claude_no_codex') {
          logger.debug({ requested: routed.requested, routedTo: routed.modelId, backend: 'claude' }, 'route (active claude, no codex)');
        } else {
          logger.debug({ requested: routed.requested, backend: 'claude' }, 'route');
        }
        return { model: this.claude.getModel(routed.modelId, { allowOverloadFallback }), provider: 'claude', label: routed.modelId };
      case 'byo': {
        const backend = routed.backend!;
        logger.debug({ requested: routed.requested, routedTo: routed.modelId, backend: 'byo', provider: backend.providerLabel },
          getModelRoutingMode() === 'all_in' ? 'route (all_in)' : 'route');
        return { model: this.resolveByoModel(routed.modelId, backend), provider: 'byo', label: routed.modelId };
      }
      case 'codex':
      default:
        logger.debug({ requested: routed.requested, backend: 'codex' }, 'route');
        return { model: this.codex.getModel(routed.modelId), provider: 'codex', label: routed.modelId };
    }
  }

  /** The model, alone: no backup, no rescue. The outage check asks a down
   *  brain through this, so a backup can never answer for it. */
  getModelAlone(modelName: string): Model {
    const primary = this.resolvePrimary(modelName);
    return withModelFallback([this.primaryTarget(primary)]);
  }

  private primaryTarget(primary: { model: Model; provider: BrainProvider; label: string }): FallbackTarget {
    return {
      label: primary.label,
      provider: primary.provider,
      model: primary.label,
      getModel: () => primary.model,
      ...(primary.provider === 'claude' ? { supportsRequest: claudeHarnessSupportsRequest } : {}),
    };
  }

  /**
   * The owner's backup brains for a brain request, in their order; null when
   * this is not a brain request. A brain request is one the chosen brain
   * serves — the default model, the brain of the turn's conversation, or a
   * brain in an outage — outside a worker or an explicitly pinned memory job.
   * Accounting job identity alone does not change routing. An unreached backup is
   * never built.
   */
  private brainBackupTargets(modelName: string | undefined, primaryLabel: string): FallbackTarget[] | null {
    const runContext = harnessRunContextStorage.getStore();
    if (workerScoped(runContext)) return null;
    if (modelUsageAttributionStorage.getStore()?.waitForOwnModel === true) return null;
    const explicit = typeof modelName === 'string' && modelName.trim().length > 0;
    if (explicit && !isBrainModel(primaryLabel, runContext?.sessionId)) return null;
    return brainBackupModelIds(primaryLabel).map((modelId) => ({
      label: modelId,
      provider: resolveEffectiveProviderSafe(this.resolveEffectiveProvider, modelId),
      model: modelId,
      getModel: () => this.resolvePrimary(modelId).model,
      ...(resolveEffectiveProviderSafe(this.resolveEffectiveProvider, modelId) === 'claude'
        ? { supportsRequest: claudeHarnessSupportsRequest } : {}),
    }));
  }

  /** Workers retain their role on provider failure. Foreground brain settings
   *  must not silently promote a small delegated task to a large model, and
   *  all_in keeps a worker fan-out off the subscriptions entirely. */
  private workerChain(primary: { model: Model; provider: BrainProvider; label: string }): FallbackTarget[] {
    const chain = [this.primaryTarget(primary)];
    if (getModelRoutingMode() === 'all_in') return chain;
    if (harnessRunContextStorage.getStore()?.workerScope !== true) return chain;
    if (primary.provider !== 'codex' && this.codexAvailable()) {
      chain.push({ label: DEFAULT_CODEX_FAST_MODEL, provider: 'codex', model: DEFAULT_CODEX_FAST_MODEL,
        getModel: () => this.codex.getModel(DEFAULT_CODEX_FAST_MODEL) });
    }
    if (primary.provider !== 'claude' && this.claudeAvailable()) {
      chain.push({ label: DEFAULT_CLAUDE_FAST_MODEL, provider: 'claude', model: DEFAULT_CLAUDE_FAST_MODEL,
        getModel: () => this.claude.getModel(DEFAULT_CLAUDE_FAST_MODEL, { allowOverloadFallback: false }),
        supportsRequest: claudeHarnessSupportsRequest });
    }
    return chain;
  }
}

function workerScoped(context: ReturnType<typeof harnessRunContextStorage.getStore>): boolean {
  return context?.workerScope === true || Boolean(context?.guardrailScopeId);
}

/** The brain this conversation is served on (its pin, else the chosen brain). */
function isBrainModel(label: string, sessionId?: string): boolean {
  try {
    return resolvedBrainForSession(sessionId).modelId === label;
  } catch {
    return false;
  }
}

function resolveEffectiveProviderSafe(resolve: (modelId: string) => BrainProvider, modelId: string): BrainProvider {
  try { return resolve(modelId); } catch { return 'byo'; }
}

/** The outage check: one short question to exactly the down model. */
export async function probeBrainModel(modelId: string): Promise<void> {
  const agent = new Agent({
    name: 'BrainCheck',
    model: new RouterModelProvider().getModelAlone(modelId),
    modelSettings: { maxTokens: 64 },
    instructions: 'Reply with the word OK.',
    tools: [],
  });
  const result = await modelUsageAttributionStorage.run(
    { sessionId: 'brain-check', sourceUserSeq: 0, role: 'brain', usageJobId: `brain-check:${modelId}` },
    () => new Runner({ workflowName: 'clementine-brain-check' })
      .run(agent, 'Are you there?', { maxTurns: 1, signal: AbortSignal.timeout(90_000) }),
  );
  const answer = (result as { finalOutput?: unknown }).finalOutput;
  if (typeof answer !== 'string' || answer.trim().length === 0) throw new Error('no answer');
}

function routeSourceForModelName(modelName?: string): ModelRouteDecisionSource {
  return typeof modelName === 'string' && modelName.trim().length > 0 ? 'explicit' : 'default';
}

/** Workflow step sessions are keyed `workflow:<runId>:<stepId>` — pull the run id
 *  so a fallover on a workflow step correlates to its run. Undefined otherwise. */
function workflowRunIdFromSessionId(sessionId?: string): string | undefined {
  if (!sessionId || !sessionId.startsWith('workflow:')) return undefined;
  const parts = sessionId.split(':');
  return parts.length >= 2 && parts[1] ? parts[1] : undefined;
}
