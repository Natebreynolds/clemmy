/**
 * fallback-model — try an ordered chain of brains, advancing when a brain is
 * UNAVAILABLE (overloaded 529, a 5xx, OR a transport TIMEOUT — the request hung
 * with no response), after that brain has already burned its own transparent
 * retry budget. The chain for the Claude brain is:
 *
 *     Opus 4.8  ->  Sonnet 4.6  ->  Codex (gpt-5.x, only if a Codex login exists)
 *
 * Why these classes: a 529 is per-MODEL capacity (Opus is the most contended on
 * Max/Pro; Sonnet/Codex are far less so) so switching genuinely helps; and when
 * Anthropic is at capacity it frequently HANGS rather than returning a clean 529
 * (model.transport_timeout) — gating on overload-only meant the chain never
 * advanced on that, the dominant real-world failure, so a hung Claude took the
 * turn down instead of falling over. A 429 is your ACCOUNT-wide quota — switching
 * Claude models won't help — so we do NOT fall back on it (the resilient wrapper
 * backs off + surfaces). Codex is a different provider, so it survives an
 * Anthropic-wide incident.
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
import { getRuntimeEnv } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.fallback-model' });

/**
 * TEST KNOB: pretend the first N brains in the chain are OVERLOADED so the
 * fallback fires deterministically (a real 529 can't be forced). DOUBLE-GATED —
 * only honored under NODE_ENV=test OR CLEMMY_DEV_OVERRIDES=1, so production can
 * never trip it. `CLEMMY_FORCE_CLAUDE_OVERLOAD=1` skips Opus -> Sonnet answers;
 * `=2` skips Opus+Sonnet -> Codex answers.
 */
export function forcedOverloadDepth(): number {
  const raw = (getRuntimeEnv('CLEMMY_FORCE_CLAUDE_OVERLOAD', '') || '').trim().toLowerCase();
  if (!raw || raw === 'off' || raw === '0') return 0;
  if (process.env.NODE_ENV !== 'test' && (getRuntimeEnv('CLEMMY_DEV_OVERRIDES', '') || '') !== '1') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1; // '1'/'on'/'true' => depth 1
}

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

/** True when an error means the brain is UNAVAILABLE and a DIFFERENT brain is
 *  worth trying: overloaded (529), a 5xx, OR a transport TIMEOUT (the request
 *  hung with no response). The timeout is the load-bearing case — when Anthropic
 *  is at capacity it often does NOT return a clean 529, it HANGS
 *  (model.transport_timeout, after the resilient wrapper burns its retries).
 *  Gating fallback on overload-only meant the chain never advanced on the failure
 *  that actually happens in the wild, so a hung Claude took the whole turn down
 *  ("Overloaded") instead of falling over. 429 (rate_limited) is deliberately
 *  EXCLUDED — that's account-wide quota; switching Claude tiers won't help (the
 *  resilient wrapper backs off + surfaces it). */
export function isFalloverError(err: unknown): boolean {
  const kind = err instanceof BoundaryError ? err.kind : classifyModelError(err).kind;
  return kind === 'model.overloaded'
    || kind === 'model.http_5xx'
    || kind === 'model.transport_timeout';
}

export class FallbackModel implements Model {
  constructor(private readonly chain: FallbackTarget[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const forced = forcedOverloadDepth();
    for (let i = 0; i < this.chain.length; i++) {
      if (i < forced && i < this.chain.length - 1) {
        logger.warn({ forced: true, from: this.chain[i].label, to: this.chain[i + 1].label }, 'FORCED overload (test knob) — falling back to the next brain');
        continue;
      }
      try {
        return await this.chain[i].getModel().getResponse(request);
      } catch (err) {
        if (isFalloverError(err) && i < this.chain.length - 1) {
          logger.warn({ from: this.chain[i].label, to: this.chain[i + 1].label, kind: err instanceof BoundaryError ? err.kind : undefined }, 'brain unavailable — falling back to the next brain');
          continue;
        }
        throw err;
      }
    }
    // Unreachable (chain always non-empty), but satisfy the type.
    throw new Error('fallback chain exhausted');
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const forced = forcedOverloadDepth();
    for (let i = 0; i < this.chain.length; i++) {
      if (i < forced && i < this.chain.length - 1) {
        logger.warn({ forced: true, from: this.chain[i].label, to: this.chain[i + 1].label }, 'FORCED overload (test knob) — falling back to the next brain');
        continue;
      }
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
        if (!yieldedAny && isFalloverError(err) && i < this.chain.length - 1) {
          logger.warn({ from: this.chain[i].label, to: this.chain[i + 1].label, kind: err instanceof BoundaryError ? err.kind : undefined }, 'brain unavailable mid-request — falling back to the next brain');
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
