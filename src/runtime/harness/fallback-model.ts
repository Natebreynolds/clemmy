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
import { recordOperationalEvent } from '../operational-telemetry.js';
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

export interface FallbackOptions {
  /**
   * Also fall over on a 429 (rate-limited). OFF by default because for a SAME-
   * provider tier chain (Opus -> Sonnet) a 429 is account-wide and switching
   * tiers won't help. Turn ON for a CROSS-PROVIDER chain (GLM -> Codex -> Claude)
   * where a 429 on one provider has nothing to do with the next provider's quota
   * — there, a 429 SHOULD switch brains. This is the proactive-fallover lever.
   */
  falloverOn429?: boolean;
  /**
   * If a brain sends NO first stream event within this many ms, treat it as a
   * hang and fall over to the NEXT brain (the dominant real-world failure: a
   * provider accepts the request then goes silent). Applies only to non-last
   * brains — the last brain keeps the full per-request budget (the loop's stall
   * watchdog is its backstop). 0/undefined disables. Set BELOW the loop's
   * first-byte stall window so the hang becomes a fallover, not a dead-end.
   */
  firstByteTimeoutMs?: number;
}

/** A brain went silent past the first-byte fallover budget — switch brains. */
class FirstByteTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`no first stream event within ${ms}ms`);
    this.name = 'FirstByteTimeoutError';
  }
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
  constructor(private readonly chain: FallbackTarget[], private readonly opts: FallbackOptions = {}) {}

  /** Does this error warrant switching brains? Overload/5xx/timeout always; a
   *  429 only when this chain opted in (cross-provider). */
  private shouldFallover(err: unknown): boolean {
    if (isFalloverError(err)) return true;
    if (this.opts.falloverOn429) {
      const kind = err instanceof BoundaryError ? err.kind : classifyModelError(err).kind;
      return kind === 'model.rate_limited';
    }
    return false;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const forced = forcedOverloadDepth();
    for (let i = 0; i < this.chain.length; i++) {
      const isLast = i >= this.chain.length - 1;
      if (i < forced && !isLast) {
        logger.warn({ forced: true, from: this.chain[i].label, to: this.chain[i + 1].label }, 'FORCED overload (test knob) — falling back to the next brain');
        continue;
      }
      const { request: req, cleanup } = this.linkAbort(request);
      try {
        const call = this.chain[i].getModel().getResponse(req);
        const result = await this.withFirstByteTimeout(call, isLast, () => cleanup(true));
        cleanup(false);
        return result;
      } catch (err) {
        cleanup(true); // release a hung request
        if (this.isFalloverReason(err) && !isLast) {
          this.logFallover(i, err);
          continue;
        }
        throw err;
      }
    }
    throw new Error('fallback chain exhausted'); // unreachable (chain non-empty)
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const forced = forcedOverloadDepth();
    for (let i = 0; i < this.chain.length; i++) {
      const isLast = i >= this.chain.length - 1;
      if (i < forced && !isLast) {
        logger.warn({ forced: true, from: this.chain[i].label, to: this.chain[i + 1].label }, 'FORCED overload (test knob) — falling back to the next brain');
        continue;
      }
      const { request: req, cleanup } = this.linkAbort(request);
      let yieldedAny = false;
      try {
        const it = this.chain[i].getModel().getStreamedResponse(req)[Symbol.asyncIterator]();
        // First event raced against the first-byte fallover budget (non-last brains).
        const firstNext = it.next();
        firstNext.catch(() => {}); // a lost race must not throw unhandled
        let cur = await this.withFirstByteTimeout(firstNext, isLast, () => cleanup(true));
        while (!cur.done) {
          yieldedAny = true; // first yield === committed on real content; no more fallover
          yield cur.value;
          cur = await it.next();
        }
        cleanup(false);
        return; // streamed to completion
      } catch (err) {
        cleanup(true); // release a hung brain
        // Switch only if NOTHING reached the Runner yet (else we'd duplicate a
        // partially-streamed reply) and a next brain exists.
        if (!yieldedAny && this.isFalloverReason(err) && !isLast) {
          this.logFallover(i, err);
          continue;
        }
        throw err;
      }
    }
  }

  private isFalloverReason(err: unknown): boolean {
    return err instanceof FirstByteTimeoutError || this.shouldFallover(err);
  }

  private logFallover(i: number, err: unknown): void {
    const reason = err instanceof FirstByteTimeoutError ? 'first-byte-timeout' : (err instanceof BoundaryError ? err.kind : classifyModelError(err).kind);
    logger.warn(
      {
        from: this.chain[i].label,
        to: this.chain[i + 1].label,
        reason,
      },
      'brain unavailable — falling over to the next brain',
    );
    recordOperationalEvent({
      source: 'model',
      type: 'model_fallover',
      severity: 'warn',
      actor: 'fallback-model',
      payload: {
        from: this.chain[i].label,
        to: this.chain[i + 1].label,
        reason,
      },
    });
  }

  /** Race a model call's first result against the first-byte timeout (only for a
   *  non-last brain with a configured budget). On timeout, abort and throw
   *  FirstByteTimeoutError so the caller advances to the next brain. */
  private async withFirstByteTimeout<T>(call: Promise<T>, isLast: boolean, abort: () => void): Promise<T> {
    const ms = this.opts.firstByteTimeoutMs;
    if (isLast || !ms || ms <= 0) return call;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abort(); reject(new FirstByteTimeoutError(ms)); }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Per-attempt AbortController linked to the caller's signal, so a first-byte
   *  timeout (or the caller cancelling) actually releases the hung request. */
  private linkAbort(request: ModelRequest): { request: ModelRequest; cleanup: (aborted: boolean) => void } {
    const controller = new AbortController();
    const parent = (request as { signal?: AbortSignal }).signal;
    const onParentAbort = () => controller.abort();
    if (parent) {
      if (parent.aborted) controller.abort();
      else parent.addEventListener('abort', onParentAbort, { once: true });
    }
    return {
      request: { ...request, signal: controller.signal } as ModelRequest,
      cleanup: (aborted: boolean) => {
        if (parent) parent.removeEventListener('abort', onParentAbort);
        if (aborted) { try { controller.abort(); } catch { /* best-effort */ } }
      },
    };
  }
}

/** Wrap an ordered chain of brains with fallover. A single-element chain is
 *  returned as-is (no wrapper overhead) UNLESS a first-byte timeout is requested
 *  (a lone brain still benefits from converting a hang into a clean error). */
export function withModelFallback(chain: FallbackTarget[], opts: FallbackOptions = {}): Model {
  if (chain.length === 0) throw new Error('withModelFallback: empty chain');
  if (chain.length === 1 && !opts.firstByteTimeoutMs) return chain[0].getModel();
  return new FallbackModel(chain, opts);
}
