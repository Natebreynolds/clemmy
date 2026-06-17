/**
 * fallback-model — try an ordered chain of brains, advancing ONLY when a model
 * is OVERLOADED (Anthropic 529 "the model is temporarily limiting requests — not
 * your usage limit"), after that model has already burned its own transparent
 * retry budget. The chain for the Claude brain is:
 *
 *     Opus 4.8  ->  Sonnet 4.6  ->  Codex (gpt-5.x, only if a Codex login exists)
 *
 * Why overload-only: a 529 is per-MODEL capacity (Opus is the most contended on
 * Max/Pro; Sonnet/Codex are far less so), so switching models genuinely helps. A
 * 429 is your ACCOUNT-wide quota — switching Claude models won't help — so we do
 * NOT fall back on it (the resilient wrapper just backs off + surfaces). Codex is
 * a different provider entirely, so it survives an Anthropic-wide incident.
 *
 * Retry-safety: for a streamed turn we may only switch BEFORE any event has been
 * yielded to the Runner. The resilient wrapper buffers metadata and yields
 * nothing until it commits on real content, so "no event yielded yet" === "no
 * real content escaped" — switching then can never duplicate a reply.
 *
 * This is the seam the future Codex+Claude "fusion" routing will build on.
 */
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { BoundaryError } from '../boundary-error.js';
import { classifyModelError } from './resilient-model.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.fallback-model' });

export interface FallbackTarget {
  label: string;
  /** Lazily build the Model — a fallback is only constructed if it's reached. */
  getModel: () => Model;
}

/** True when an error means the model is OVERLOADED (529 / overloaded_error) —
 *  the only condition that warrants switching models. Detects both the raw AI
 *  SDK error and a BoundaryError the resilient wrapper may have thrown. */
export function isOverloadError(err: unknown): boolean {
  if (err instanceof BoundaryError) return err.kind === 'model.overloaded';
  return classifyModelError(err).kind === 'model.overloaded';
}

export class FallbackModel implements Model {
  constructor(private readonly chain: FallbackTarget[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    for (let i = 0; i < this.chain.length; i++) {
      try {
        return await this.chain[i].getModel().getResponse(request);
      } catch (err) {
        if (isOverloadError(err) && i < this.chain.length - 1) {
          logger.warn({ from: this.chain[i].label, to: this.chain[i + 1].label }, 'model overloaded — falling back to the next brain');
          continue;
        }
        throw err;
      }
    }
    // Unreachable (chain always non-empty), but satisfy the type.
    throw new Error('fallback chain exhausted');
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    for (let i = 0; i < this.chain.length; i++) {
      let yieldedAny = false;
      try {
        for await (const ev of this.chain[i].getModel().getStreamedResponse(request)) {
          yieldedAny = true; // first yield === resilient wrapper committed on real content
          yield ev;
        }
        return; // streamed to completion on this model
      } catch (err) {
        // Can only switch if NOTHING reached the Runner yet (else we'd duplicate
        // a partially-streamed reply), it's an overload, and a next brain exists.
        if (!yieldedAny && isOverloadError(err) && i < this.chain.length - 1) {
          logger.warn({ from: this.chain[i].label, to: this.chain[i + 1].label }, 'model overloaded mid-request — falling back to the next brain');
          continue;
        }
        throw err;
      }
    }
  }
}

/** Wrap an ordered chain of brains with overload-fallback. A single-element chain
 *  is returned as-is (no wrapper overhead). */
export function withModelFallback(chain: FallbackTarget[]): Model {
  return chain.length <= 1 ? chain[0].getModel() : new FallbackModel(chain);
}
