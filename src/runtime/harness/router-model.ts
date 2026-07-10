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
import { getActiveAuthMode, getByoBackendConfig, getClaudeBrainModel, getModelRoutingMode, getRuntimeEnv, MODELS } from '../../config.js';
import { withModelRouteMetrics, type ModelRouteDecisionSource } from '../model-route-metrics.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.router-model' });

export type BrainProvider = 'codex' | 'claude' | 'byo';

/** Cross-provider brain fallover is an explicit recovery mode. Default off:
 *  each selected provider owns its request unless the operator opts into a
 *  compatible provider switch. */
function brainFalloverEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', 'off') ?? 'off').trim());
}
/** First-byte fallover budget — set BELOW the loop's stall watchdog (modelFirstByteStallMs,
 *  default 75s) so a hung provider falls over to the next brain instead of dead-ending. */
function brainFalloverFirstByteMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_BRAIN_FALLOVER_FIRST_BYTE_MS', '') || '', 10);
  // 60s: the fallover budget MUST stay strictly below the loop's first-byte stall
  // watchdog (~75s) — otherwise the watchdog kills the turn before fallover can
  // switch brains, DISABLING cross-brain fallover for a silent hang (the exact
  // case it exists for; adversarial review 07-06 caught a 90s value regressing
  // this). Giving high-effort turns more first-byte headroom requires raising the
  // watchdog AND the fallover budget together (a coordinated follow-up), not this
  // value alone. Tunable via CLEMMY_BRAIN_FALLOVER_FIRST_BYTE_MS.
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

export function brainFalloverFirstByteMsForProvider(provider: BrainProvider): number | undefined {
  // The BYO adapter deliberately completes a non-streaming request and then
  // emits one synthetic stream chunk. Its "first byte" is therefore the full
  // completion time, so a first-byte deadline would falsely fail healthy work.
  return provider === 'byo' ? undefined : brainFalloverFirstByteMs();
}

function requestNeedsNativeTools(request: ModelRequest): boolean {
  return (Array.isArray(request.tools) && request.tools.length > 0)
    || (Array.isArray(request.handoffs) && request.handoffs.length > 0);
}

function claudeHarnessSupportsRequest(request: ModelRequest): boolean {
  return !requestNeedsNativeTools(request) || claudeHarnessModelSupportsTools();
}

export class RouterModelProvider implements ModelProvider {
  private readonly codex = new CodexModelProvider();
  private readonly claude = new ClaudeModelProvider();

  getModel(modelName?: string): Model {
    const primary = this.resolvePrimary(modelName);
    // Dev-only fault injection (no-op unless CLEMMY_FAULT_INJECT_BRAIN names this
    // provider): wrap the resolved primary so a live transient failure can be
    // forced to prove cross-brain fallover. The lazily-built fallover targets in
    // buildBrainChain are different providers → not wrapped → they recover.
    primary.model = maybeWrapWithFaultInjection(primary.model, primary.provider);
    let resolved: Model;
    if (!brainFalloverEnabled()) {
      resolved = primary.model;
    } else {
      // Wrap in a cross-provider fallover chain (primary -> other connected brains)
      // so an overloaded/rate-limited/HUNG provider switches brains instead of
      // dead-ending. falloverOn429: a 429 on one provider is irrelevant to the
      // next, so switch. firstByteTimeoutMs: a silent provider falls over before
      // the loop's stall watchdog fires.
      const chain = this.buildBrainChain(primary);
      // Correlate a fallover to the run that triggered it. getModel runs inside
      // the harness run ALS (the loop wraps runner.run), so the active sessionId
      // is available here; workflow step sessions encode the run id in the id.
      const sessionId = harnessRunContextStorage.getStore()?.sessionId;
      resolved = withModelFallback(chain, {
        falloverOn429: true,
        firstByteTimeoutMs: brainFalloverFirstByteMsForProvider(primary.provider),
        sessionId,
        workflowRunId: workflowRunIdFromSessionId(sessionId),
      });
    }
    const requested = typeof modelName === 'string' && modelName.trim().length > 0 ? modelName.trim() : MODELS.primary;
    const sessionId = harnessRunContextStorage.getStore()?.sessionId;
    return withModelRouteMetrics(resolved, {
      sessionId,
      workflowRunId: workflowRunIdFromSessionId(sessionId),
      role: 'brain',
      requestedModel: requested,
      resolvedModel: primary.label,
      provider: primary.provider,
      source: routeSourceForModelName(modelName),
      reason: {
        routingMode: getModelRoutingMode(),
        falloverEnabled: brainFalloverEnabled(),
      },
    });
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
      return { model: getByoModel(id, backend), provider: 'byo', label: id };
    }

    // Exact ownership declared by a named BYO provider beats model-id regexes.
    // This is how an OpenAI-compatible endpoint can intentionally serve a model
    // called `gpt-4o` or `claude-*` without being mistaken for a subscription.
    const declaredBackend = resolveDeclaredByoProviderForModel(name);
    if (declaredBackend?.configured) {
      logger.debug({ requested: name, backend: 'byo', provider: declaredBackend.providerLabel }, 'route (declared owner)');
      return { model: getByoModel(name, declaredBackend), provider: 'byo', label: name };
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
        return { model: getByoModel(name, backend), provider: 'byo', label: name };
      }
      case 'codex':
      default:
        if (getActiveAuthMode() === 'claude_oauth' && !codexModelsAvailable()) {
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
      getModel: () => primary.model,
      ...(primary.provider === 'claude' ? { supportsRequest: claudeHarnessSupportsRequest } : {}),
    }];
    // all_in is a provider-isolation promise, not merely a primary preference.
    // Even an explicitly enabled fallover must not spend subscription seats.
    if (getModelRoutingMode() === 'all_in') return chain;
    // Codex (OpenAI) — generally the steadiest fallback.
    if (primary.provider !== 'codex' && codexModelsAvailable()) {
      chain.push({ label: 'codex', getModel: () => this.codex.getModel(MODELS.primary) });
    }
    // Claude subscription.
    if (primary.provider !== 'claude' && claudeModelsAvailable()) {
      chain.push({
        label: 'claude',
        getModel: () => this.claude.getModel(getClaudeBrainModel()),
        supportsRequest: claudeHarnessSupportsRequest,
      });
    }
    // The configured BYO/OpenAI-compatible backend (GLM/DeepSeek/…), if it isn't
    // already the primary.
    const byo = getByoBackendConfig();
    if (primary.provider !== 'byo' && byo.configured) {
      chain.push({ label: `byo:${byo.primaryId || 'default'}`, getModel: () => getByoModel(byo.primaryId || MODELS.primary, byo) });
    }
    return chain;
  }
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
