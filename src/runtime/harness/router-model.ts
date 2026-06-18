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
import { ClaudeModelProvider } from './claude-model.js';
import { resolveProvider } from './model-wire-registry.js';
import { codexModelsAvailable } from './model-role-options.js';
import { getActiveAuthMode, getByoBackendConfig, getClaudeBrainModel, getModelRoutingMode, MODELS } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.router-model' });

export class RouterModelProvider implements ModelProvider {
  private readonly codex = new CodexModelProvider();
  private readonly claude = new ClaudeModelProvider();

  getModel(modelName?: string): Model {
    const byo = getByoBackendConfig();
    const mode = getModelRoutingMode();
    const requested = typeof modelName === 'string' ? modelName.trim() : '';
    const name = requested || MODELS.primary;

    if (mode === 'all_in') {
      if (!byo.configured) throw new Error('BYO all-in mode is enabled, but no BYO backend is configured.');
      const id = resolveProvider(name) === 'codex' ? (byo.primaryId || name) : name;
      logger.debug({ requested: name, routedTo: id, backend: 'byo' }, 'route (all_in)');
      return getByoModel(id, byo);
    }

    switch (resolveProvider(name)) {
      case 'claude':
        logger.debug({ requested: name, backend: 'claude' }, 'route');
        return this.claude.getModel(name);
      case 'byo': {
        if (!byo.configured) {
          throw new Error(`Model ${name} resolves to a BYO/OpenAI-compatible backend, but no BYO backend is configured.`);
        }
        logger.debug({ requested: name, backend: 'byo' }, 'route');
        return getByoModel(name, byo);
      }
      case 'codex':
      default:
        // Active Claude does not require a Codex login. Legacy helper agents
        // still name gpt-* tiers; before the router, ClaudeModelProvider mapped
        // those ids back to the Claude brain. Preserve that no-Codex Claude path.
        if (getActiveAuthMode() === 'claude_oauth' && !codexModelsAvailable()) {
          const id = getClaudeBrainModel();
          logger.debug({ requested: name, routedTo: id, backend: 'claude' }, 'route (active claude, no codex)');
          return this.claude.getModel(id);
        }
        logger.debug({ requested: name, backend: 'codex' }, 'route');
        return this.codex.getModel(name);
    }
  }
}
