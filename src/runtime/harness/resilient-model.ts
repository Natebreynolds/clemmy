/**
 * resilient-model — a provider-agnostic `Model` decorator that gives the THIN
 * brains (Claude, BYO) the model-boundary resilience + reasoning translation
 * that, until now, only the hand-rolled Codex adapter had.
 *
 * A review of the multi-model runtime found that five concerns inside
 * CodexResponsesModel are about the AGENT
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
 * Streaming retry-safety: events are streamed to the Runner AS THEY ARRIVE so the
 * loop's stream-stall watchdog and the user see the model working (buffering them
 * until the first text delta starved the watchdog into a false stall on long
 * thinking / tool-only turns). We may retry only while NOTHING real has been
 * yielded yet — the dominant Anthropic failure (429/529 thrown at stream open,
 * before any event) retries cleanly; a failure after the first real part is
 * surfaced, not retried (it can't be replayed without duplicating Runner state).
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
// A plan/usage QUOTA is exhausted (e.g. Codex/ChatGPT "usage_limit_reached", "The usage
// limit has been reached", plan_limit). Providers return this as 429 OR 403 OR a 400 with
// the marker only in the body — the bare status classifier mis-tags the 403/400 variants as
// auth_expired → terminal run_failed with NO fallover. Detect it by message REGARDLESS of
// status so it routes like a rate-limit: fallover to another brain, else a clean recoverable
// "quota reached" ask — never a hard fail. (Retrying the same exhausted provider is futile.)
const USAGE_LIMIT_RE = /usage[_ ]?limit|plan[_ ]?limit|usage_limit_reached|quota (?:exceeded|reached)|exceeded your current quota/i;

/** Classify a thrown model error into a retry decision. Duck-types the AI SDK's
 *  APICallError (statusCode / responseHeaders / isRetryable) without importing
 *  it, so the wrapper stays provider-neutral. */
export function classifyModelError(err: unknown): ErrorClass {
  const e = err as { statusCode?: unknown; status?: unknown; responseHeaders?: Record<string, string>; isRetryable?: unknown; message?: unknown; name?: unknown } | null;
  const status = typeof e?.statusCode === 'number' ? e.statusCode
    : typeof e?.status === 'number' ? e.status
    : undefined;
  const retryAfterMs = parseRetryAfter(e?.responseHeaders);

  // Usage/plan quota exhausted — check FIRST (before the status branches), because the
  // 403/400 variants would otherwise mis-classify as auth_expired → terminal. Body text
  // (CodexRuntimeError.bodyText) carries the marker even when the message doesn't.
  const quotaText = `${typeof e?.message === 'string' ? e.message : ''} ${typeof (e as { bodyText?: unknown })?.bodyText === 'string' ? (e as { bodyText?: string }).bodyText : ''}`;
  if (USAGE_LIMIT_RE.test(quotaText)) {
    return { retryable: true, kind: 'model.rate_limited', status, isAuth: false, retryAfterMs };
  }

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
  // Jitter SEEDED PER INVOCATION (not just by attempt) so CONCURRENT calls that fail at the
  // same attempt don't compute the IDENTICAL backoff and retry in lockstep — a synchronized
  // thundering herd that turns one overload into an oscillating wave (the burst opened by a
  // swarm + its judges). The salt only needs to DIFFER between interleaved calls, not be
  // random (Math.random is unavailable in some sandboxes); the ±bound is unchanged.
  const jitter = exp * 0.2 * (0.5 - deterministicJitter(attempt, nextJitterSalt()));
  return Math.min(MAX_BACKOFF_MS, Math.round(exp + jitter));
}

let jitterSalt = 0;
function nextJitterSalt(): number {
  jitterSalt = (jitterSalt + 1) % 1_000_000;
  return jitterSalt;
}

// Cheap deterministic jitter (Math.random is unavailable in some sandboxes and
// non-deterministic for tests). Varies by attempt AND a per-invocation salt without a PRNG.
function deterministicJitter(attempt: number, salt: number): number {
  const x = Math.sin((attempt + 1) * 12.9898 + salt * 78.233) * 43758.5453;
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

// The aisdk adapter emits a leading `{type:'model', event:{type:'stream-start'}}`
// (and a trailing `finish` / `response-metadata`) around the real content. These
// METADATA frames must NOT count as "committed real content" — otherwise an
// empty completion (stream-start, finish, response_done{output:[]}) looks
// committed and the empty-completion retry never fires (G5). Only actual content
// parts (text/reasoning/tool deltas) commit us.
const METADATA_PART_TYPES = new Set(['stream-start', 'response-metadata', 'finish']);

/** True for a stream event that is pure metadata (safe to buffer + discard on a
 *  pre-content retry) — response_started, or a `model` frame wrapping a
 *  stream-start / finish / response-metadata part. */
function isBufferableMetadata(ev: unknown): boolean {
  const e = ev as { type?: string; event?: { type?: string } };
  if (e.type === 'response_started') return true;
  if (e.type === 'model' && e.event && METADATA_PART_TYPES.has(e.event.type ?? '')) return true;
  return false;
}

/** A model that 400s specifically because it doesn't accept the effort param
 *  (e.g. Haiku 4.5 — verified). Caught so the wrapper can strip effort and retry
 *  ONCE rather than hard-failing the turn: defense-in-depth for the whole
 *  "registry mis-tagged a model as effort-capable" class. */
export function isEffortRejection(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: unknown; responseBody?: unknown };
  const status = typeof e?.statusCode === 'number' ? e.statusCode : e?.status;
  if (status !== 400) return false;
  const text = `${typeof e?.message === 'string' ? e.message : ''} ${typeof e?.responseBody === 'string' ? e.responseBody : ''}`;
  return /does not support the effort parameter|not support(ed)?\b[^.]*\beffort|\beffort\b[^.]*not support/i.test(text);
}

/** Return a copy of the request with any `providerOptions.anthropic.effort`
 *  stripped (used to recover from an effort-rejection 400). */
export function stripEffortFromRequest(request: ModelRequest): ModelRequest {
  const ms = request.modelSettings ?? {};
  const pd = (ms.providerData ?? {}) as Record<string, unknown>;
  const po = (pd.providerOptions ?? {}) as Record<string, unknown>;
  const anthropic = (po.anthropic ?? {}) as Record<string, unknown>;
  if (anthropic.effort == null) return request;
  const { effort: _dropped, ...restAnthropic } = anthropic;
  return {
    ...request,
    modelSettings: { ...ms, providerData: { ...pd, providerOptions: { ...po, anthropic: restAnthropic } } },
  } as ModelRequest;
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
    let req = translateSettings(request, this.policy.capability);
    const authRefreshed = { value: false };
    let effortStripped = false;
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
        if (!effortStripped && isEffortRejection(err)) {
          effortStripped = true;
          req = stripEffortFromRequest(req);
          logger.warn({ label: this.policy.label, path: 'getResponse' }, 'model rejected the effort parameter — stripping effort and retrying');
          continue;
        }
        if (await this.handleAttemptFailure(err, attempt, authRefreshed, 'getResponse')) continue;
        throw err;
      }
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    let req = translateSettings(request, this.policy.capability);
    const authRefreshed = { value: false };
    let effortStripped = false;

    for (let attempt = 0; ; attempt++) {
      // Stream events to the Runner AS THEY ARRIVE so the loop's stream-stall
      // watchdog — and the user — sees the model working. Reasoning + tool-call
      // frames on a long operational turn can span well past the stall window,
      // so withholding every non-text event until the first TEXT delta (the old
      // behavior) STARVED the watchdog into a false "stream stalled" and hid the
      // model's progress (a tool-only turn yielded nothing at all until the end).
      // Retry-safety instead rests on ONE rule: we may retry only while NOTHING
      // real has been yielded yet. The single buffered frame is response_started,
      // held just long enough to discard cleanly on a pre-content blip / empty
      // completion.
      // Buffer ONLY metadata frames (response_started + the adapter's
      // stream-start/finish/response-metadata `model` frames) until the first
      // REAL content part. Committing on metadata (the prior bug) made an empty
      // completion look committed -> the empty-completion retry never fired, and
      // a transport drop after stream-start but before content couldn't retry.
      const pending: StreamEvent[] = [];
      let committed = false; // a REAL content part (text / reasoning / tool) was yielded
      let sawDone = false;
      let doneEmpty = false;

      try {
        for await (const ev of this.inner.getStreamedResponse(req)) {
          const e = ev as { type?: string; response?: { output?: unknown[] } };
          if (e.type === 'response_done') {
            sawDone = true;
            const emptyOutput = !Array.isArray(e.response?.output) || e.response!.output!.length === 0;
            doneEmpty = !committed && emptyOutput;
            // Empty completion before any real content — bail WITHOUT yielding so
            // the post-loop handler retries OR throws (never a clean empty turn).
            if (doneEmpty) break;
            if (!committed) { yield* drain(pending); committed = true; }
            yield ev;
            continue;
          }
          if (!committed && isBufferableMetadata(ev)) { pending.push(ev); continue; }
          // First REAL content commits us (the Runner now holds live output, so a
          // retry would duplicate it). Flush the buffered metadata in order, then
          // stream this and every later event straight through.
          if (!committed) { yield* drain(pending); committed = true; }
          yield ev;
        }
      } catch (err) {
        if (committed) throw err; // real content already escaped — cannot safely retry
        if (err instanceof BoundaryError) throw err;
        if (!effortStripped && isEffortRejection(err)) {
          effortStripped = true;
          req = stripEffortFromRequest(req);
          logger.warn({ label: this.policy.label, path: 'getStreamedResponse' }, 'model rejected the effort parameter — stripping effort and retrying');
          continue;
        }
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

/** Yield + clear a buffered run of metadata stream events, in order. */
function* drain(buffer: StreamEvent[]): Generator<StreamEvent> {
  for (const ev of buffer) yield ev;
  buffer.length = 0;
}

/** Wrap any SDK Model with the provider-agnostic resilience + translation layer. */
export function withResilience(inner: Model, policy: ResiliencePolicy): Model {
  return new ResilientModel(inner, policy);
}
