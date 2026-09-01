/**
 * RouterModelProvider — dispatches each Agent's model request to the provider
 * implied by the model id: Codex, Claude, or a user-supplied OpenAI-compatible
 * backend (MiniMax/DeepSeek/…).
 *
 * Routing rule:
 *   - `gpt-5*` / `o*` ids → Codex.
 *   - `claude-*` ids      → Claude subscription adapter.
 *   - any other id        → BYO OpenAI-compatible backend.
 *   - all_in mode         → every role on BYO; a stray built-in model id falls
 *                           back to the BYO primary so a misconfig can't
 *                           silently hit a dead Codex seat.
 *
 * This is what makes the role→model registry real: a role can name a model from
 * any connected provider, and the provider dispatch follows the model id rather
 * than whichever brain happened to be active.
 */
import type { Model, ModelProvider, ModelRequest } from '@openai/agents-core';
import { CodexModelProvider } from './codex-model.js';
import { getByoModel } from './byo-model.js';
import {
  assertUnambiguousModelRouting,
  resolveByoProviderForModel,
  resolveDeclaredByoProviderForModel,
} from './byo-providers.js';
import { ClaudeModelProvider, claudeHarnessModelSupportsTools } from './claude-model.js';
import { resolveProvider } from './model-wire-registry.js';
import { codexModelsAvailable, claudeModelsAvailable } from './model-role-options.js';
import { withModelFallback, type FallbackTarget } from './fallback-model.js';
import { maybeWrapWithFaultInjection } from './fault-inject.js';
import { harnessRunContextStorage } from './brackets.js';
import {
  getActiveAuthMode,
  getByoBackendConfig,
  getClaudeBrainModel,
  getCodexRescueModelSelection,
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
  getModel(modelName?: string): Model;
};

/** Narrow dependency seam for deterministic route tests. Production callers
 * use the defaults; no provider construction or selection behavior changes. */
export interface RouterModelProviderOptions {
  codex?: SyncModelProvider;
  claude?: SyncModelProvider;
  resolveByoModel?: typeof getByoModel;
  codexAvailable?: () => boolean;
  claudeAvailable?: () => boolean;
}

/** Cross-provider brain fallover is an explicit recovery mode. Default off:
 *  each selected provider owns its request unless the operator opts into a
 *  compatible provider switch. */
function brainFalloverEnabled(): boolean {
  // Default ON (kill-switch CLEMMY_BRAIN_FALLOVER=off). A connected fallback brain
  // that only works after setting an undocumented env var is a rollout flag on
  // validated behavior — cross-brain fallover IS the default now, so an expired /
  // overloaded / hung brain routes to the next connected one instead of failing.
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

export class RouterModelProvider implements ModelProvider {
  private readonly codex: SyncModelProvider;
  private readonly claude: SyncModelProvider;
  private readonly resolveByoModel: typeof getByoModel;
  private readonly codexAvailable: () => boolean;
  private readonly claudeAvailable: () => boolean;

  constructor(options: RouterModelProviderOptions = {}) {
    this.codex = options.codex ?? new CodexModelProvider();
    this.claude = options.claude ?? new ClaudeModelProvider();
    this.resolveByoModel = options.resolveByoModel ?? getByoModel;
    this.codexAvailable = options.codexAvailable ?? codexModelsAvailable;
    this.claudeAvailable = options.claudeAvailable ?? claudeModelsAvailable;
  }

  getModel(modelName?: string): Model {
    const primary = this.resolvePrimary(modelName);
    // Dev-only fault injection (no-op unless CLEMMY_FAULT_INJECT_BRAIN names this
    // provider): wrap the resolved primary so a live transient failure can be
    // forced to prove cross-brain fallover. The lazily-built fallover targets in
    // buildBrainChain are different providers → not wrapped → they recover.
    primary.model = maybeWrapWithFaultInjection(primary.model, primary.provider);
    const requested = typeof modelName === 'string' && modelName.trim().length > 0 ? modelName.trim() : MODELS.primary;
    const runContext = harnessRunContextStorage.getStore();
    const sessionId = runContext?.sessionId;
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
    let resolved: Model;
    if (!brainFalloverEnabled()) {
      // The kill-switch disables cross-brain switching, not the completion
      // invariant. Keep the lone primary behind the same graph boundary so a
      // reasoning-only completion becomes a typed failure instead of an
      // unbounded Agents SDK run-again loop.
      resolved = withModelFallback(instrumentTargets([{
        label: primary.label,
        provider: primary.provider,
        model: primary.label,
        getModel: () => primary.model,
        ...(primary.provider === 'claude' ? { supportsRequest: claudeHarnessSupportsRequest } : {}),
      }]));
    } else {
      // Wrap in a cross-provider fallover chain (primary -> other connected brains)
      // so an overloaded/rate-limited/HUNG provider switches brains instead of
      // dead-ending. falloverOn429: a 429 on one provider is irrelevant to the
      // next, so switch. firstByteTimeoutMs: a silent provider falls over before
      // the loop's stall watchdog fires.
      const chain = instrumentTargets(this.buildBrainChain(primary));
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
   *  provider it is, so the chain builder can append the OTHER providers. */
  private resolvePrimary(modelName?: string): { model: Model; provider: BrainProvider; label: string } {
    const byo = getByoBackendConfig();
    const mode = getModelRoutingMode();
    const requested = typeof modelName === 'string' ? modelName.trim() : '';
    const name = requested || MODELS.primary;
    assertUnambiguousModelRouting(name, mode);

    if (mode === 'all_in') {
      const declaredBackend = resolveDeclaredByoProviderForModel(name);
      const backend = declaredBackend ?? resolveByoProviderForModel(name) ?? byo;
      if (!backend.configured) throw new Error('BYO all-in mode is enabled, but no BYO backend is configured.');
      const id = !declaredBackend && resolveProvider(name) !== 'byo' ? (backend.primaryId || name) : name;
      logger.debug({ requested: name, routedTo: id, backend: 'byo' }, 'route (all_in)');
      return { model: this.resolveByoModel(id, backend), provider: 'byo', label: id };
    }

    // Exact ownership declared by a named BYO provider beats model-id regexes.
    // This is how an OpenAI-compatible endpoint can intentionally serve a model
    // called `gpt-4o` or `claude-*` without being mistaken for a subscription.
    const declaredBackend = resolveDeclaredByoProviderForModel(name);
    if (declaredBackend?.configured) {
      logger.debug({ requested: name, backend: 'byo', provider: declaredBackend.providerLabel }, 'route (declared owner)');
      return { model: this.resolveByoModel(name, declaredBackend), provider: 'byo', label: name };
    }

    switch (resolveProvider(name)) {
      case 'claude':
        logger.debug({ requested: name, backend: 'claude' }, 'route');
        return { model: this.claude.getModel(name), provider: 'claude', label: name };
      case 'byo': {
        const backend = resolveByoProviderForModel(name) ?? byo;
        if (!backend.configured) {
          throw new Error(`Model ${name} resolves to a BYO/OpenAI-compatible backend, but no BYO backend is configured.`);
        }
        logger.debug({ requested: name, backend: 'byo' }, 'route');
        return { model: this.resolveByoModel(name, backend), provider: 'byo', label: name };
      }
      case 'codex':
      default:
        if (getActiveAuthMode() === 'claude_oauth' && !this.codexAvailable()) {
          const id = getClaudeBrainModel();
          logger.debug({ requested: name, routedTo: id, backend: 'claude' }, 'route (active claude, no codex)');
          return { model: this.claude.getModel(id), provider: 'claude', label: id };
        }
        logger.debug({ requested: name, backend: 'codex' }, 'route');
        return { model: this.codex.getModel(name), provider: 'codex', label: name };
    }
  }

  /** Build the cross-provider fallover chain: the primary first, then every OTHER
   *  connected brain (deduped by provider), most-reliable first. Lazy targets —
   *  a fallback brain is only constructed if reached. */
  private buildBrainChain(primary: { model: Model; provider: BrainProvider; label: string }): FallbackTarget[] {
    const chain: FallbackTarget[] = [{
      label: primary.label,
      provider: primary.provider,
      model: primary.label,
      getModel: () => primary.model,
      ...(primary.provider === 'claude' ? { supportsRequest: claudeHarnessSupportsRequest } : {}),
    }];
    // all_in keeps BYO primary — but a CONVERSATION must complete (owner
    // question, 2026-07-24: kimi rate-limited and the turn died with "go
    // change your settings" instead of falling back). Connected subscription
    // brains join as LAST-RESORT rescue targets for the ORCHESTRATOR surface
    // only: worker fan-outs stay isolated (guardrailScopeId set), so a 429
    // storm across 100 workers can never silently drain a subscription — a
    // single user-facing turn rescuing onto Codex/Claude is exactly what the
    // user wants instead of an error card. No connected subscription → the
    // original isolation holds by construction.
    if (getModelRoutingMode() === 'all_in') {
      const workerScope = Boolean(harnessRunContextStorage.getStore()?.guardrailScopeId);
      if (workerScope) return chain;
      if (primary.provider !== 'codex' && this.codexAvailable()) {
        const model = codexRescueModelId();
        chain.push({
          label: 'codex:rescue',
          provider: 'codex',
          model,
          getModel: () => this.codex.getModel(model),
        });
      }
      if (primary.provider !== 'claude' && this.claudeAvailable()) {
        const model = getClaudeBrainModel();
        chain.push({
          label: 'claude:rescue',
          provider: 'claude',
          model,
          getModel: () => this.claude.getModel(model),
          supportsRequest: claudeHarnessSupportsRequest,
        });
      }
      return chain;
    }
    // Codex (OpenAI) — generally the steadiest fallback.
    if (primary.provider !== 'codex' && this.codexAvailable()) {
      chain.push({
        label: 'codex',
        provider: 'codex',
        model: MODELS.primary,
        getModel: () => this.codex.getModel(MODELS.primary),
      });
    }
    // Claude subscription.
    if (primary.provider !== 'claude' && this.claudeAvailable()) {
      const model = getClaudeBrainModel();
      chain.push({
        label: 'claude',
        provider: 'claude',
        model,
        getModel: () => this.claude.getModel(model),
        supportsRequest: claudeHarnessSupportsRequest,
      });
    }
    // The configured BYO/OpenAI-compatible backend (GLM/DeepSeek/…), if it isn't
    // already the primary.
    const byo = getByoBackendConfig();
    if (primary.provider !== 'byo' && byo.configured) {
      const model = byo.primaryId || MODELS.primary;
      chain.push({
        label: `byo:${byo.primaryId || 'default'}`,
        provider: 'byo',
        model,
        getModel: () => this.resolveByoModel(model, byo),
      });
    }
    return chain;
  }
}

/** The settings write path only accepts exact Codex catalog ids. Keep a final
 * registry check here too for hand-edited env files; an invalid explicit value
 * falls back to the legacy primary route rather than changing provider by name
 * or display-label heuristics. */
function codexRescueModelId(): string {
  const selection = getCodexRescueModelSelection(resolveProvider);
  if (!selection.configured) return selection.modelId;
  try {
    if (resolveProvider(selection.modelId) === 'codex') return selection.modelId;
  } catch {
    // Fall through to the inherited legacy route.
  }
  logger.warn({ configuredModel: selection.modelId, inheritedModel: selection.inheritedModelId },
    'ignoring non-Codex rescue model');
  return selection.inheritedModelId;
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
