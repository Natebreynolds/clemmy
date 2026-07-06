/**
 * RouterModelProvider — dispatches each Agent's model request to the provider
 * implied by the model id: Codex, Claude, or a user-supplied OpenAI-compatible
 * backend (MiniMax/DeepSeek/…).
 *
 * Routing rule:
 *   - `gpt-5*` / `o*` ids → Codex.
 *   - `claude-*` ids      → Claude subscription adapter.
 *   - any other id        → BYO OpenAI-compatible backend.
 *   - all_in mode         → every role on BYO; a stray `gpt-5*` id falls
 *                           back to the BYO primary so a misconfig can't
 *                           silently hit a dead Codex seat.
 *
 * This is what makes the role→model registry real: a role can name a model from
 * any connected provider, and the provider dispatch follows the model id rather
 * than whichever brain happened to be active.
 */
import type { Model, ModelProvider } from '@openai/agents-core';
import { CodexModelProvider } from './codex-model.js';
import { getByoModel } from './byo-model.js';
import { resolveByoProviderForModel } from './byo-providers.js';
import { ClaudeModelProvider } from './claude-model.js';
import { resolveProvider } from './model-wire-registry.js';
import { codexModelsAvailable, claudeModelsAvailable } from './model-role-options.js';
import { withModelFallback, type FallbackTarget } from './fallback-model.js';
import { maybeWrapWithFaultInjection } from './fault-inject.js';
import { harnessRunContextStorage } from './brackets.js';
import { getActiveAuthMode, getByoBackendConfig, getClaudeBrainModel, getModelRoutingMode, getRuntimeEnv, MODELS } from '../../config.js';
import { withModelRouteMetrics, type ModelRouteDecisionSource } from '../model-route-metrics.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.router-model' });

type BrainProvider = 'codex' | 'claude' | 'byo';

/** Universal cross-provider brain-fallover: every turn runs through an ordered
 *  chain of ALL connected brains, so a single provider's overload/429/hang is
 *  invisible — Clem switches brains and finishes. Kill-switch default-on. */
function brainFalloverEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', 'on') ?? 'on').toLowerCase() !== 'off';
}
/** First-byte fallover budget — set BELOW the loop's stall watchdog (modelFirstByteStallMs,
 *  default 75s) so a hung provider falls over to the next brain instead of dead-ending. */
function brainFalloverFirstByteMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_BRAIN_FALLOVER_FIRST_BYTE_MS', '') || '', 10);
  // 90s (was 60s): high-effort gpt-5.x reasoning turns can take 90-120s to their
  // first token, and every real session-correlated fallover observed (07-06 audit)
  // was this exact case — a slow-but-HEALTHY turn abandoned mid-reasoning, not a
  // genuine hang. 90s still catches a truly silent provider well before the loop's
  // stall watchdog. Tunable via CLEMMY_BRAIN_FALLOVER_FIRST_BYTE_MS.
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000;
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
        firstByteTimeoutMs: brainFalloverFirstByteMs(),
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

    if (mode === 'all_in') {
      const backend = resolveByoProviderForModel(name) ?? byo;
      if (!backend.configured) throw new Error('BYO all-in mode is enabled, but no BYO backend is configured.');
      const id = resolveProvider(name) === 'codex' ? (backend.primaryId || name) : name;
      logger.debug({ requested: name, routedTo: id, backend: 'byo' }, 'route (all_in)');
      return { model: getByoModel(id, backend), provider: 'byo', label: id };
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
    const chain: FallbackTarget[] = [{ label: primary.label, getModel: () => primary.model }];
    // Codex (OpenAI) — generally the steadiest fallback.
    if (primary.provider !== 'codex' && codexModelsAvailable()) {
      chain.push({ label: 'codex', getModel: () => this.codex.getModel(MODELS.primary) });
    }
    // Claude subscription.
    if (primary.provider !== 'claude' && claudeModelsAvailable()) {
      chain.push({ label: 'claude', getModel: () => this.claude.getModel(getClaudeBrainModel()) });
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
