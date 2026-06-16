/**
 * resilient-model — a provider-agnostic `Model` decorator that gives the THIN
 * brains (Claude, BYO) the model-boundary resilience + reasoning translation
 * that, until now, only the hand-rolled Codex adapter had.
 *
 * The multi-model strategy (CLAUDE-MULTI-MODEL-ABSTRACTION-STRATEGY-2026-06-16.md)
 * found that five concerns inside CodexResponsesModel are about the AGENT
 * CONTRACT, not the Codex wire — yet only Codex got them, which is why Claude
 * struggled. This wrapper lifts them above the wire so every brain inherits them:
 *
 *   1. Transparent retry (G2) on transient failures — 429 rate-limit, 529
 *      overloaded, 5xx, transport drops — gated on "nothing user-visible was
 *      yielded yet", so a retry can never duplicate streamed text.
 *   2. 401 refresh-and-retry (G4) via an injected `refreshAuth` hook.
 *   3. Empty-completion invariant (G5) — a stop with zero output is a backend
 *      blip, not an answer; retry it (provably safe — nothing yielded).
 *   4. Per-turn reasoning translation (G1) — re-emit the harness's generic
 *      effort tier as the active provider's wire idiom (Anthropic
 *      `providerOptions.anthropic.effort` -> `output_config.effort`). getModel()
 *      is cached per-id and can't see the turn, so this MUST live here.
 *
 * Codex is deliberately NOT wrapped: it already owns all of the above, and
 * wrapping the primary-traffic brain only to opt it back out is pure regression
 * surface. We wrap exactly the brains that LACK these concerns, so the next brain
 * (DeepSeek/MiniMax) inherits parity for free — fixing the general CLASS.
 *
 * Streaming retry-safety (the proven Codex rule): the ONLY event that commits us
 * (makes a retry unsafe) is `output_text_delta` — user-visible streamed text.
 * Everything else (response_started, reasoning/metadata passthrough, and even
 * tool-call frames, which don't execute until the turn finishes) is buffered and
 * discarded-on-retry. So any transient failure BEFORE the first text delta — the
 * dominant Anthropic case (429/529 thrown at stream open) — retries cleanly.
 */
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import type { ModelCapability } from './model-wire-registry.js';
import { BoundaryError, type BoundaryErrorKind } from '../boundary-error.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.resilient-model' });

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 750;
const RATE_LIMIT_BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30_000;

export interface ResiliencePolicy {
  /** Short label for logs (e.g. 'claude', 'byo'). */
  label: string;
  capability: ModelCapability;
  /** Max transparent retries on transient pre-content failures. Default 3. */
  maxRetries?: number;
  /** Invalidate cached auth + force refresh, then the wrapper retries once on a
   *  401. Omit for brains without refreshable auth. */
  refreshAuth?: () => Promise<void>;
  /** Test injection — replace the backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
}

interface ErrorClass {
  retryable: boolean;
  kind: BoundaryErrorKind;
  status?: number;
  isAuth: boolean;
  retryAfterMs?: number;
}

const TRANSPORT_RE = /terminated|econnreset|etimedout|epipe|enotfound|econnrefused|fetch failed|socket hang up|network|und_err|aborted|timeout/i;

/** Classify a thrown model error into a retry decision. Duck-types the AI SDK's
 *  APICallError (statusCode / responseHeaders / isRetryable) without importing
 *  it, so the wrapper stays provider-neutral. */
export function classifyModelError(err: unknown): ErrorClass {
  const e = err as { statusCode?: unknown; status?: unknown; responseHeaders?: Record<string, string>; isRetryable?: unknown; message?: unknown; name?: unknown } | null;
  const status = typeof e?.statusCode === 'number' ? e.statusCode
    : typeof e?.status === 'number' ? e.status
    : undefined;
  const retryAfterMs = parseRetryAfter(e?.responseHeaders);

  if (status === 401 || status === 403) {
    return { retryable: true, kind: 'model.auth_expired', status, isAuth: true, retryAfterMs };
  }
  if (status === 429) {
    return { retryable: true, kind: 'model.rate_limited', status, isAuth: false, retryAfterMs };
  }
  if (status === 529) {
    return { retryable: true, kind: 'model.overloaded', status, isAuth: false, retryAfterMs };
  }
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return { retryable: true, kind: 'model.http_5xx', status, isAuth: false, retryAfterMs };
  }
  if (e?.isRetryable === true) {
    return { retryable: true, kind: 'model.transport_timeout', status, isAuth: false, retryAfterMs };
  }
  // No HTTP status — a transport / network error thrown before/within the stream.
  if (status === undefined) {
    const msg = typeof e?.message === 'string' ? e.message : '';
    const name = typeof e?.name === 'string' ? e.name : '';
    if (TRANSPORT_RE.test(msg) || TRANSPORT_RE.test(name)) {
      return { retryable: true, kind: 'model.transport_timeout', isAuth: false, retryAfterMs };
    }
  }
  return { retryable: false, kind: 'runtime.unknown', status, isAuth: false, retryAfterMs };
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

function backoffMs(attempt: number, cls: ErrorClass): number {
  if (cls.retryAfterMs != null) return Math.min(MAX_BACKOFF_MS, cls.retryAfterMs);
  const base = cls.kind === 'model.rate_limited' || cls.kind === 'model.overloaded'
    ? RATE_LIMIT_BASE_BACKOFF_MS
    : BASE_BACKOFF_MS;
  const exp = base * Math.pow(2, attempt);
  // +/- 20% jitter so concurrent runs don't re-hammer the same frame.
  const jitter = exp * 0.2 * (0.5 - deterministicJitter(attempt));
  return Math.min(MAX_BACKOFF_MS, Math.round(exp + jitter));
}

// Cheap deterministic jitter (Math.random is unavailable in some sandboxes and
// non-deterministic for tests). Varies by attempt without a PRNG.
function deterministicJitter(attempt: number): number {
  const x = Math.sin((attempt + 1) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Re-emit the harness's generic reasoning-effort tier as the active provider's
 * wire idiom. Anthropic: write `providerOptions.anthropic.effort` (which
 * @ai-sdk/anthropic maps to `output_config.effort`). Returns a NEW request
 * (never mutates the caller's) with merged providerData; a no-op for non-effort
 * shapes (Codex maps effort natively; BYO manages reasoning at its own layer).
 */
export function translateSettings(request: ModelRequest, cap: ModelCapability): ModelRequest {
  if (cap.apiShape !== 'anthropic_messages' || cap.thinkingMode !== 'effort' || !cap.supportsEffort) {
    return request;
  }
  const tier = request.modelSettings?.reasoning?.effort as keyof ModelCapability['effortMap'] | undefined;
  if (!tier) return request;
  const mapped = cap.effortMap[tier];
  if (mapped == null) return request;

  const ms = request.modelSettings ?? {};
  const providerData = (ms.providerData ?? {}) as Record<string, unknown>;
  const providerOptions = (providerData.providerOptions ?? {}) as Record<string, unknown>;
  const anthropic = (providerOptions.anthropic ?? {}) as Record<string, unknown>;
  // Respect an explicitly-set effort (don't clobber a deliberate override).
  if (anthropic.effort != null) return request;

  return {
    ...request,
    modelSettings: {
      ...ms,
      providerData: {
        ...providerData,
        providerOptions: {
          ...providerOptions,
          anthropic: { ...anthropic, effort: mapped },
        },
      },
    },
  } as ModelRequest;
}

/** True when a ModelResponse carried no output at all — a backend blip, not an
 *  answer (the "always an output" invariant). A reasoning-only or empty-text
 *  message still has output.length>=1, so it is NOT flagged. */
function isEmptyResponse(res: ModelResponse): boolean {
  return !res || !Array.isArray(res.output) || res.output.length === 0;
}

export class ResilientModel implements Model {
  constructor(private readonly inner: Model, private readonly policy: ResiliencePolicy) {}

  private get maxRetries(): number {
    return this.policy.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private sleep(ms: number): Promise<void> {
    if (this.policy.sleep) return this.policy.sleep(ms);
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Shared pre-attempt failure handling: decide retry, refresh auth once, back
   *  off. Returns true to retry, false to give up (caller then throws). */
  private async handleAttemptFailure(
    err: unknown,
    attempt: number,
    authRefreshed: { value: boolean },
    path: 'getResponse' | 'getStreamedResponse',
  ): Promise<boolean> {
    const cls = classifyModelError(err);
    // Auth path FIRST: the one-shot token refresh is INDEPENDENT of the
    // transient-retry budget — an access-token-expiry 401 can land on the final
    // attempt (after a couple of 429s) and still deserves its single refresh,
    // matching the Codex adapter (whose 401 refresh is not budget-gated).
    if (cls.isAuth) {
      if (!this.policy.refreshAuth || authRefreshed.value) return false;
      authRefreshed.value = true;
      try {
        await this.policy.refreshAuth();
      } catch {
        return false;
      }
      logger.warn({ label: this.policy.label, path, attempt: attempt + 1, kind: cls.kind }, 'model auth expired — refreshed token, retrying');
      return true;
    }
    if (!cls.retryable || attempt >= this.maxRetries) return false;
    const wait = backoffMs(attempt, cls);
    logger.warn(
      { label: this.policy.label, path, attempt: attempt + 1, maxRetries: this.maxRetries, kind: cls.kind, status: cls.status, backoffMs: wait },
      'model call failed before content — retrying transparently',
    );
    await this.sleep(wait);
    return true;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const req = translateSettings(request, this.policy.capability);
    const authRefreshed = { value: false };
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.inner.getResponse(req);
        if (isEmptyResponse(res) && attempt < this.maxRetries) {
          logger.warn({ label: this.policy.label, attempt: attempt + 1 }, 'model returned empty completion — retrying (always-an-output invariant)');
          await this.sleep(backoffMs(attempt, { retryable: true, kind: 'model.empty_completion', isAuth: false }));
          continue;
        }
        if (isEmptyResponse(res)) {
          throw new BoundaryError({
            kind: 'model.empty_completion',
            retryable: true,
            userMessage: "Clementine's model returned an empty response. Please ask again.",
            operatorMessage: `${this.policy.label}: empty completion after ${attempt + 1} attempts (no output items).`,
            context: { label: this.policy.label, attempts: attempt + 1 },
          });
        }
        return res;
      } catch (err) {
        if (err instanceof BoundaryError) throw err;
        if (await this.handleAttemptFailure(err, attempt, authRefreshed, 'getResponse')) continue;
        throw err;
      }
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const req = translateSettings(request, this.policy.capability);
    const authRefreshed = { value: false };

    for (let attempt = 0; ; attempt++) {
      // Buffer non-committing events; the ONLY committing event is a
      // user-visible text delta. Everything else (start, reasoning/metadata,
      // tool-call frames that haven't executed) is safe to discard on retry.
      const buffer: StreamEvent[] = [];
      let committed = false;
      let sawTextDelta = false;
      let sawDone = false;
      let doneEmpty = false;

      try {
        for await (const ev of this.inner.getStreamedResponse(req)) {
          const e = ev as { type?: string; response?: { output?: unknown[] } };
          if (e.type === 'output_text_delta') {
            // First user-visible content: flush buffer in order, then commit.
            if (!committed) { yield* drain(buffer); committed = true; }
            sawTextDelta = true;
            yield ev;
            continue;
          }
          if (e.type === 'response_done') {
            sawDone = true;
            doneEmpty = !sawTextDelta && (!Array.isArray(e.response?.output) || e.response!.output!.length === 0);
            // An empty completion before any commit is a retryable blip — bail
            // out of the loop WITHOUT yielding (regardless of remaining budget)
            // so the post-loop handler retries OR throws, never fabricating a
            // clean empty turn (the always-an-output invariant).
            if (doneEmpty && !committed) break;
            if (!committed) { yield* drain(buffer); committed = true; }
            yield ev;
            continue;
          }
          // Non-committing: forward if we've already committed, else buffer.
          if (committed) yield ev; else buffer.push(ev);
        }
      } catch (err) {
        if (committed) throw err; // user already saw text — cannot safely retry
        if (err instanceof BoundaryError) throw err;
        if (await this.handleAttemptFailure(err, attempt, authRefreshed, 'getStreamedResponse')) continue;
        throw err;
      }

      // Empty completion (response_done with no content). Retry if budget
      // remains; otherwise throw the retryable boundary error — NEVER yield a
      // clean empty response_done (mirrors getResponse + the Codex adapter).
      if (doneEmpty && !committed) {
        if (attempt < this.maxRetries) {
          logger.warn({ label: this.policy.label, attempt: attempt + 1 }, 'streamed empty completion — retrying (always-an-output invariant)');
          await this.sleep(backoffMs(attempt, { retryable: true, kind: 'model.empty_completion', isAuth: false }));
          continue;
        }
        throw new BoundaryError({
          kind: 'model.empty_completion',
          retryable: true,
          userMessage: "Clementine's model returned an empty response. Please ask again.",
          operatorMessage: `${this.policy.label}: streamed empty completion after ${attempt + 1} attempts (response_done with no output).`,
          context: { label: this.policy.label, attempts: attempt + 1 },
        });
      }
      // If the stream ended with no done event and nothing committed, surface a
      // retryable boundary error (don't fabricate a clean end).
      if (!sawDone && !committed) {
        if (attempt < this.maxRetries) {
          logger.warn({ label: this.policy.label, attempt: attempt + 1 }, 'stream ended with no response_done before content — retrying');
          await this.sleep(backoffMs(attempt, { retryable: true, kind: 'model.transport_timeout', isAuth: false }));
          continue;
        }
        throw new BoundaryError({
          kind: 'model.transport_timeout',
          retryable: true,
          userMessage: "Clementine's model backend dropped the connection before finishing this turn. Please retry.",
          operatorMessage: `${this.policy.label}: stream ended without response_done before content (attempts=${attempt + 1}).`,
          context: { label: this.policy.label, attempts: attempt + 1 },
        });
      }
      return; // committed + drained, or done emitted
    }
  }
}

function* drain(buffer: StreamEvent[]): Generator<StreamEvent> {
  for (const ev of buffer) yield ev;
  buffer.length = 0;
}

/** Wrap any SDK Model with the provider-agnostic resilience + translation layer. */
export function withResilience(inner: Model, policy: ResiliencePolicy): Model {
  return new ResilientModel(inner, policy);
}
