/**
 * RouterModelProvider — dispatches each Agent's model request to either
 * the Codex backend (CodexModelProvider) or a user-supplied
 * OpenAI-compatible backend (MiniMax/DeepSeek/…), by model id.
 *
 * Routing rule:
 *   - `gpt-5*` ids        → Codex (the brain/judge in worker mode).
 *   - any other id        → BYO backend (the delegated worker labor).
 *   - all_in mode         → every role on BYO; a stray `gpt-5*` id falls
 *                           back to the BYO primary so a misconfig can't
 *                           silently hit a dead Codex seat.
 *
 * This provider is only registered (in codex-client.ts) when a BYO
 * backend is configured AND MODEL_ROUTING_MODE != 'off'. Otherwise the
 * harness registers CodexModelProvider exactly as before — so the
 * default path is byte-identical and this code never runs.
 */
import type { Model, ModelProvider } from '@openai/agents-core';
import { CodexModelProvider } from './codex-model.js';
import { getByoModel } from './byo-model.js';
import { getByoBackendConfig, getModelRoutingMode, MODELS } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.router-model' });

export class RouterModelProvider implements ModelProvider {
  private readonly codex = new CodexModelProvider();

  getModel(modelName?: string): Model {
    const byo = getByoBackendConfig();
    const mode = getModelRoutingMode();
    const name = modelName ?? MODELS.primary;

    if (byo.configured && mode !== 'off') {
      if (mode === 'all_in') {
        // In all_in mode, every role routes to BYO. A stray gpt-5* request
        // (e.g. from legacy code) falls back to primaryId, or the requested id
        // if primaryId is empty (which shouldn't happen in a valid config).
        const id = name.startsWith('gpt-5') ? (byo.primaryId || name) : name;
        logger.debug({ requested: name, routedTo: id, backend: 'byo' }, 'route (all_in)');
        return getByoModel(id, byo);
      }
      // worker mode: keep gpt-5* (brain/judge) on Codex, send the rest to BYO.
      if (!name.startsWith('gpt-5')) {
        logger.debug({ requested: name, backend: 'byo' }, 'route (worker)');
        return getByoModel(name, byo);
      }
    }

    return this.codex.getModel(modelName);
  }
}
