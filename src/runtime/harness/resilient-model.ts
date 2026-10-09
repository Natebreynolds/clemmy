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
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@openai/agents-core/types';
import type { ModelCapability } from './model-wire-registry.js';
import { BoundaryError, type BoundaryErrorKind } from '../boundary-error.js';
import { isProviderCapacityExhausted, isProviderCreditRefusal } from '../../shared/provider-capacity.js';
import { isProviderInternalGenerationFailure } from '../../shared/provider-internal-generation.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.resilient-model' });

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 750;
const RATE_LIMIT_BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30_000;
/** A provider that gave no answer (a transport failure or a 5xx) always gets
 * one new attempt, however long it took to fail and whatever other retries
 * (a rate-limit wait, a token refresh, an empty completion, a dropped effort
 * setting) came before it. Later no-answer attempts start only while this much
 * time has passed since the call's first one. A
 * connection that fails fast still gets every retry in the count budget; one
 * that takes its own timeout to fail gets one retry, so a provider that is
 * really down ends the call in about two of its timeouts, not minutes. */
const NO_ANSWER_RETRY_WALL_MS = 20_000;
const NO_ANSWER_KINDS: ReadonlySet<BoundaryErrorKind> = new Set(['model.transport_timeout', 'model.http_5xx']);

type ResiliencePath = 'getResponse' | 'getStreamedResponse';
type ResilienceOutcome = 'returned' | 'failed' | 'cancelled' | 'interrupted';
type ResilienceRetryReason = 'transient_failure' | 'auth_refresh' | 'effort_rejected' | 'empty_completion' | 'incomplete_stream';
type ResilienceFailureKind = BoundaryErrorKind;

interface ResilienceTelemetryBase {
  /** One wrapper invocation, distinct even when cached models serve concurrent calls. */
  callId: string;
  label: string;
  path: ResiliencePath;
  at: number;
  elapsedMs: number;
  maxRetries: number;
  /** This physical provider request was retired, even if its containing
   * logical step is still running on a fresh fallback request. Observation
   * only; it does not grant or withdraw retry authority. */
  requestAborted: boolean;
}

/** Timing observations only. These events contain no request/result bytes,
 * credentials, inferred tokens, or proof of a served model/account. The host
 * binds its observer to the exact accepted source and independently certified
 * route. A returned wrapper call is not a completion/effect verdict. */
type ResilienceTelemetryDetail =
  | { type: 'call_started' }
  | { type: 'attempt_started'; attempt: number }
  | { type: 'attempt_finished'; attempt: number; durationMs: number; outcome: ResilienceOutcome;
      contentCommitted: boolean; completionObserved: boolean; failureKind?: ResilienceFailureKind; status?: number }
  | { type: 'retry_scheduled'; afterAttempt: number; nextAttempt: number; reason: ResilienceRetryReason;
      failureKind: ResilienceFailureKind; plannedBackoffMs: number }
  | { type: 'retry_wait_finished'; afterAttempt: number; nextAttempt: number; reason: ResilienceRetryReason;
      plannedBackoffMs: number; durationMs: number; outcome: 'completed' | 'failed' }
  | { type: 'call_finished'; outcome: ResilienceOutcome; durationMs: number; attemptCount: number;
      failedAttemptCount: number; attemptMs: number; failedAttemptMs: number; retryWaitMs: number;
      completionObserved: boolean; failureKind?: ResilienceFailureKind }
;
export type ResilienceTelemetryEvent = ResilienceTelemetryBase & ResilienceTelemetryDetail;

export type ResilienceTelemetryObserver = (event: Readonly<ResilienceTelemetryEvent>) => void;
const resilienceTelemetry = new AsyncLocalStorage<ResilienceTelemetryObserver>();

/** Bind observations to this asynchronous request, never a mutable process-wide
 * callback. The wrapper captures this binding once before its first attempt. */
export function withModelResilienceTelemetry<T>(observer: ResilienceTelemetryObserver, work: () => T): T {
  return resilienceTelemetry.run(observer, work);
}

class ResilienceCallTelemetry {
  private readonly observer = resilienceTelemetry.getStore();
  private readonly callId = randomUUID();
  private activeAttempt?: { ordinal: number; startedAt: number; contentCommitted: boolean; completionObserved: boolean };
  private attemptCount = 0;
  private failedAttemptCount = 0;
  private attemptMs = 0;
  private failedAttemptMs = 0;
  private retryWaitMs = 0;
  private completionObserved = false;

  constructor(private readonly label: string, private readonly path: ResiliencePath,
    private readonly maxRetries: number, private readonly startedAt: number, private readonly now: () => number,
    private readonly signal?: AbortSignal) {
    this.emit({ type: 'call_started' });
  }

  private emit(event: ResilienceTelemetryDetail): void {
    if (!this.observer) return;
    const at = this.now();
    try {
      const returned: unknown = this.observer(Object.freeze({ ...event, callId: this.callId, label: this.label,
        path: this.path, at, elapsedMs: Math.max(0, at - this.startedAt), maxRetries: this.maxRetries,
        requestAborted: this.signal?.aborted ?? false }) as ResilienceTelemetryEvent);
      // A mistakenly async observer must not turn a journal failure into an
      // unhandled rejection, or delay/change provider retry authority.
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(returned).catch(() => {});
      }
    } catch { /* observation cannot alter the model call */ }
  }

  startAttempt(ordinal: number): void {
    this.attemptCount += 1;
    this.activeAttempt = { ordinal, startedAt: this.now(), contentCommitted: false, completionObserved: false };
    this.emit({ type: 'attempt_started', attempt: ordinal });
  }

  streamState(contentCommitted: boolean, completionObserved: boolean): void {
    if (this.activeAttempt) Object.assign(this.activeAttempt, { contentCommitted, completionObserved });
  }

  finishAttempt(outcome: ResilienceOutcome, contentCommitted: boolean, completionObserved: boolean,
    failureKind?: ResilienceFailureKind, status?: number): void {
    if (!this.activeAttempt) return;
    const { ordinal, startedAt } = this.activeAttempt;
    this.activeAttempt = undefined;
    const durationMs = Math.max(0, this.now() - startedAt);
    this.attemptMs += durationMs;
    if (outcome === 'failed' || outcome === 'cancelled') {
      this.failedAttemptCount += 1;
      this.failedAttemptMs += durationMs;
    }
    // Only the final physical attempt can describe the returned call. A prior
    // empty response_done must not certify a later partial stream as complete.
    this.completionObserved = completionObserved;
    this.emit({ type: 'attempt_finished', attempt: ordinal, durationMs, outcome, contentCommitted,
      completionObserved, ...(failureKind ? { failureKind } : {}), ...(status !== undefined ? { status } : {}) });
  }

  retryNow(afterAttempt: number, reason: ResilienceRetryReason, failureKind: ResilienceFailureKind): void {
    this.emit({ type: 'retry_scheduled', afterAttempt, nextAttempt: afterAttempt + 1, reason, failureKind, plannedBackoffMs: 0 });
  }

  async wait<T>(afterAttempt: number, reason: ResilienceRetryReason, failureKind: ResilienceFailureKind,
    plannedBackoffMs: number, work: () => Promise<T>): Promise<T> {
    this.emit({ type: 'retry_scheduled', afterAttempt, nextAttempt: afterAttempt + 1, reason, failureKind, plannedBackoffMs });
    const startedAt = this.now();
    let outcome: 'completed' | 'failed' = 'failed';
    try { const result = await work(); outcome = 'completed'; return result; }
    finally {
      const durationMs = Math.max(0, this.now() - startedAt);
      this.retryWaitMs += durationMs;
      this.emit({ type: 'retry_wait_finished', afterAttempt, nextAttempt: afterAttempt + 1, reason,
        plannedBackoffMs, durationMs, outcome });
    }
  }

  finish(outcome: ResilienceOutcome, failureKind?: ResilienceFailureKind): void {
    this.finishAttempt(outcome, this.activeAttempt?.contentCommitted ?? false,
      this.activeAttempt?.completionObserved ?? false, failureKind);
    this.emit({ type: 'call_finished', outcome, durationMs: Math.max(0, this.now() - this.startedAt),
      attemptCount: this.attemptCount, failedAttemptCount: this.failedAttemptCount, attemptMs: this.attemptMs,
      failedAttemptMs: this.failedAttemptMs, retryWaitMs: this.retryWaitMs, completionObserved: this.completionObserved,
      ...(failureKind ? { failureKind } : {}) });
  }
}

function telemetryFailureKind(err: unknown): ResilienceFailureKind {
  try { return err instanceof BoundaryError ? err.kind : classifyModelError(err).kind; }
  catch { return 'runtime.unknown'; }
}

function telemetryFailureStatus(err: unknown): number | undefined {
  try { return classifyModelError(err).status; }
  catch { return undefined; }
}

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
  /** Test injection — replace the clock the retry wall reads. */
  now?: () => number;
}

/** Errors this layer stopped retrying because its own budget ran out before
 * any content: every retry this model boundary allows was already spent on
 * them, so an outer layer should not start the same round again. */
const retriesSpentBeforeContent = new WeakSet<object>();

function markRetriesSpent(err: unknown): void {
  if (err && typeof err === 'object') retriesSpentBeforeContent.add(err);
}

/** True when the resilience layer already spent its transparent retries on
 * this failure before the model produced anything. */
export function modelRetriesSpentBeforeContent(err: unknown): boolean {
  return !!err && typeof err === 'object' && retriesSpentBeforeContent.has(err);
}

/** One model call across its attempts. `noAnswerRetries` counts only the
 * retries granted after the provider gave no answer. */
interface NoAnswerCall {
  startedAt: number;
  signal?: AbortSignal;
  noAnswerRetries: number;
}

interface ErrorClass {
  retryable: boolean;
  kind: BoundaryErrorKind;
  status?: number;
  isAuth: boolean;
  retryAfterMs?: number;
  /** False when another attempt on this exact model cannot help (plan/model
   * allowance exhausted). Cross-provider fallover remains eligible. */
  sameProviderRetryable?: boolean;
}

const TRANSPORT_RE = /terminated|econnreset|etimedout|epipe|enotfound|econnrefused|fetch failed|socket hang up|network|und_err|aborted|timeout|connection error|apiconnection/i;

/** Generated HTTP SDKs raise one class for a request that got no response —
 *  refused, reset, or timed out before headers — named APIConnectionError.
 *  Its timeout subclass carries no cause, no status, no name of its own and
 *  the message "Request timed out.", so only the class says it is transport.
 *
 *  An aborted request is not decided here. The SDKs' abort class is a sibling
 *  of this one, but its "aborted" message still reads as transport below, and
 *  no error class can tell a person's stop from a harness deadline: both abort
 *  the request's signal and surface as the same error, and a deadline abort
 *  must stay eligible for a retry or fallover. So every layer that could retry
 *  (this wrapper, the fallback chain, the host runner) reads the request's own
 *  signal and never retries once the caller has cancelled. */
function isSdkConnectionFailure(err: object): boolean {
  let proto: unknown = Object.getPrototypeOf(err);
  for (let depth = 0; proto && depth < 8; depth++) {
    if ((proto as { constructor?: { name?: unknown } }).constructor?.name === 'APIConnectionError') return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/** A transport failure often arrives wrapped: an SDK's connection error whose
 *  cause is the socket error, which in turn may carry only a code. Any link
 *  of that chain naming a transport condition makes the whole error one. */
function transportErrorInChain(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false;
  if (isSdkConnectionFailure(err)) return true;
  const e = err as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown };
  for (const field of [e.message, e.name, e.code]) {
    if (typeof field === 'string' && TRANSPORT_RE.test(field)) return true;
  }
  return transportErrorInChain(e.cause, depth + 1);
}
// A plan/usage QUOTA is exhausted (e.g. Codex/ChatGPT "usage_limit_reached", "The usage
// limit has been reached", plan_limit). Providers return this as 429 OR 403 OR a 400 with
// the marker only in the body — the bare status classifier mis-tags the 403/400 variants as
// auth_expired → terminal run_failed with NO fallover. Detect it by message REGARDLESS of
// status so it routes like a rate-limit: fallover to another brain, else a clean recoverable
// "quota reached" ask — never a hard fail. (Retrying the same exhausted provider is futile.)
/** Classify a thrown model error into a retry decision. Duck-types the AI SDK's
 *  APICallError (statusCode / responseHeaders / isRetryable) without importing
 *  it, so the wrapper stays provider-neutral. */
export function classifyModelError(err: unknown): ErrorClass {
  if (err instanceof BoundaryError && err.kind === 'model.refused') {
    return { retryable: false, kind: 'model.refused', isAuth: false, sameProviderRetryable: false };
  }
  const e = err as { statusCode?: unknown; status?: unknown; responseHeaders?: Record<string, string>; isRetryable?: unknown; message?: unknown; name?: unknown } | null;
  const status = typeof e?.statusCode === 'number' ? e.statusCode
    : typeof e?.status === 'number' ? e.status
    : undefined;
  const retryAfterMs = parseRetryAfter(e?.responseHeaders);

  // Usage/plan quota exhausted — check FIRST (before the status branches), because the
  // 403/400 variants would otherwise mis-classify as auth_expired → terminal. Body text
  // (CodexRuntimeError.bodyText) carries the marker even when the message doesn't.
  // A spent prepaid balance routes the same way: the account refuses until its
  // owner adds credit, so another attempt on it cannot help.
  if (isProviderCapacityExhausted(err) || isProviderCreditRefusal(status, err)) {
    return {
      retryable: true,
      kind: 'model.rate_limited',
      status,
      isAuth: false,
      retryAfterMs,
      sameProviderRetryable: false,
    };
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
  // No HTTP status — a transport / network error thrown before/within the stream,
  // or a native SSE provider that finished HTTP 200 then died while sampling.
  if (status === undefined) {
    if (isProviderInternalGenerationFailure(err)) {
      return { retryable: true, kind: 'model.http_5xx', isAuth: false, retryAfterMs };
    }
    if (transportErrorInChain(err)) {
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

/** Provider protocol metadata, never inference from a model's prose. The AI
 * SDK retains a nonstream finish reason in providerData and streams it in the
 * finish event. A refusal is a terminal response, not a transient empty result.
 */
export function isProviderRefusalFinish(value: unknown): boolean {
  if (value === 'content-filter' || value === 'refusal') return true;
  if (!value || typeof value !== 'object') return false;
  const reason = value as { unified?: unknown; raw?: unknown };
  return reason.unified === 'content-filter' || reason.raw === 'refusal';
}

function providerRefusalError(label: string): BoundaryError {
  return new BoundaryError({ kind: 'model.refused', retryable: false,
    userMessage: 'The selected model declined this response.',
    operatorMessage: `${label}: the provider returned a refusal; no answer was produced and the request was not retried.`,
    context: { label, finishReason: 'refusal' } });
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

  private now(): number {
    return this.policy.now ? this.policy.now() : Date.now();
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = this.policy.sleep ? this.policy.sleep(ms)
      : ms <= 0 ? Promise.resolve()
        : new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    if (!signal) return wait;
    let onAbort: (() => void) | undefined;
    try {
      // Observe both promises immediately. An injected sleep may settle after
      // cancellation; it must not strand this call or reject unobserved.
      await Promise.race([wait, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
      signal.throwIfAborted();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Shared pre-attempt failure handling: decide retry, refresh auth once, back
   *  off. Returns true to retry, false to give up (caller then throws). */
  private async handleAttemptFailure(
    err: unknown,
    attempt: number,
    authRefreshed: { value: boolean },
    path: 'getResponse' | 'getStreamedResponse',
    call: NoAnswerCall,
    telemetry: ResilienceCallTelemetry,
  ): Promise<boolean> {
    // The caller withdrew the request (the owner stopped, or an outer
    // deadline retired it). Another attempt could only fail the same way.
    if (call.signal?.aborted) return false;
    const cls = classifyModelError(err);
    // Auth path FIRST: the one-shot token refresh is INDEPENDENT of the
    // transient-retry budget — an access-token-expiry 401 can land on the final
    // attempt (after a couple of 429s) and still deserves its single refresh,
    // matching the Codex adapter (whose 401 refresh is not budget-gated).
    if (cls.isAuth) {
      if (!this.policy.refreshAuth || authRefreshed.value) return false;
      authRefreshed.value = true;
      try {
        await telemetry.wait(attempt + 1, 'auth_refresh', cls.kind, 0, () => {
          call.signal?.throwIfAborted();
          return this.policy.refreshAuth!();
        });
      } catch {
        return false;
      }
      if (call.signal?.aborted) return false;
      logger.warn({ label: this.policy.label, path, attempt: attempt + 1, kind: cls.kind }, 'model auth expired — refreshed token, retrying');
      return true;
    }
    // A durable plan/model allowance cannot heal during exponential backoff.
    // Surface it immediately to the outer cross-provider chain.
    if (!cls.retryable || cls.sameProviderRetryable === false) return false;
    const noAnswer = NO_ANSWER_KINDS.has(cls.kind);
    if (attempt >= this.maxRetries) {
      // Other retries share the attempt count, so a no-answer failure that
      // arrives on the last attempt is spent only if one of them was its own.
      if (!noAnswer || call.noAnswerRetries >= 1) markRetriesSpent(err);
      return false;
    }
    const wait = backoffMs(attempt, cls);
    const elapsed = this.now() - call.startedAt;
    // A wait the provider named (Retry-After) is honored as before; the window
    // bounds only this layer's own backoff over silent failures. The first
    // no-answer retry is never withheld: one slow failure is still a single
    // blip, and an error marked spent must mean a no-answer retry really ran.
    // Other retries share the attempt count, so the call counts its own.
    if (noAnswer && call.noAnswerRetries >= 1 && cls.retryAfterMs == null && elapsed + wait > NO_ANSWER_RETRY_WALL_MS) {
      markRetriesSpent(err);
      logger.warn(
        { label: this.policy.label, path, attempt: attempt + 1, kind: cls.kind, status: cls.status, elapsedMs: elapsed },
        'model gave no answer before content and the retry window is spent — surfacing',
      );
      return false;
    }
    logger.warn(
      { label: this.policy.label, path, attempt: attempt + 1, maxRetries: this.maxRetries, kind: cls.kind, status: cls.status, backoffMs: wait },
      'model call failed before content — retrying transparently',
    );
    if (noAnswer) call.noAnswerRetries += 1;
    await telemetry.wait(attempt + 1, 'transient_failure', cls.kind, wait, () => this.sleep(wait, call.signal));
    call.signal?.throwIfAborted();
    return true;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    let req = translateSettings(request, this.policy.capability);
    const authRefreshed = { value: false };
    const call: NoAnswerCall = { startedAt: this.now(), signal: request.signal, noAnswerRetries: 0 };
    const telemetry = new ResilienceCallTelemetry(this.policy.label, 'getResponse', this.maxRetries, call.startedAt, () => this.now(), request.signal);
    let outcome: ResilienceOutcome = 'failed';
    let failureKind: ResilienceFailureKind | undefined;
    let effortStripped = false;
    try {
    for (let attempt = 0; ; attempt++) {
      call.signal?.throwIfAborted();
      telemetry.startAttempt(attempt + 1);
      try {
        call.signal?.throwIfAborted();
        const res = await this.inner.getResponse(req);
        if (isEmptyResponse(res) && call.signal?.aborted) {
          telemetry.finishAttempt('cancelled', false, true, 'model.empty_completion');
          call.signal.throwIfAborted();
        }
        if (isEmptyResponse(res) && isProviderRefusalFinish(res.providerData?.finishReason)) {
          throw providerRefusalError(this.policy.label);
        }
        if (isEmptyResponse(res) && attempt < this.maxRetries) {
          telemetry.finishAttempt('failed', false, true, 'model.empty_completion');
          call.signal?.throwIfAborted();
          logger.warn({ label: this.policy.label, attempt: attempt + 1 }, 'model returned empty completion — retrying (always-an-output invariant)');
          const wait = backoffMs(attempt, { retryable: true, kind: 'model.empty_completion', isAuth: false });
          await telemetry.wait(attempt + 1, 'empty_completion', 'model.empty_completion', wait, () => this.sleep(wait, call.signal));
          continue;
        }
        if (isEmptyResponse(res)) {
          telemetry.finishAttempt('failed', false, true, 'model.empty_completion');
          throw new BoundaryError({
            kind: 'model.empty_completion',
            retryable: true,
            userMessage: "Clementine's model returned an empty response. Please ask again.",
            operatorMessage: `${this.policy.label}: empty completion after ${attempt + 1} attempts (no output items).`,
            context: { label: this.policy.label, attempts: attempt + 1 },
          });
        }
        // Preserve a completed response (including its observed usage) for the
        // surrounding recorder. Cancellation still withdraws caller authority;
        // it never grants this wrapper another physical request.
        outcome = call.signal?.aborted ? 'cancelled' : 'returned';
        telemetry.finishAttempt(outcome, true, true);
        return res;
      } catch (err) {
        telemetry.finishAttempt(request.signal?.aborted ? 'cancelled' : 'failed', false, false,
          telemetryFailureKind(err), telemetryFailureStatus(err));
        if (call.signal?.aborted) throw err;
        if (err instanceof BoundaryError) throw err;
        if (!effortStripped && isEffortRejection(err)) {
          effortStripped = true;
          req = stripEffortFromRequest(req);
          logger.warn({ label: this.policy.label, path: 'getResponse' }, 'model rejected the effort parameter — stripping effort and retrying');
          telemetry.retryNow(attempt + 1, 'effort_rejected', telemetryFailureKind(err));
          continue;
        }
        if (await this.handleAttemptFailure(err, attempt, authRefreshed, 'getResponse', call, telemetry)) continue;
        throw err;
      }
    }
    } catch (err) {
      outcome = request.signal?.aborted ? 'cancelled' : 'failed';
      failureKind = telemetryFailureKind(err);
      throw err;
    } finally { telemetry.finish(outcome, failureKind); }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    let req = translateSettings(request, this.policy.capability);
    const authRefreshed = { value: false };
    const call: NoAnswerCall = { startedAt: this.now(), signal: request.signal, noAnswerRetries: 0 };
    const telemetry = new ResilienceCallTelemetry(this.policy.label, 'getStreamedResponse', this.maxRetries, call.startedAt, () => this.now(), request.signal);
    let outcome: ResilienceOutcome = 'interrupted';
    let failureKind: ResilienceFailureKind | undefined;
    let effortStripped = false;

    try {
    for (let attempt = 0; ; attempt++) {
      call.signal?.throwIfAborted();
      telemetry.startAttempt(attempt + 1);
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
        call.signal?.throwIfAborted();
        for await (const ev of this.inner.getStreamedResponse(req)) {
          const e = ev as { type?: string; event?: { type?: string; finishReason?: unknown }; response?: { output?: unknown[]; providerData?: { finishReason?: unknown } } };
          if (!committed && ((e.type === 'model' && e.event?.type === 'finish' && isProviderRefusalFinish(e.event.finishReason))
            || (e.type === 'response_done' && isProviderRefusalFinish(e.response?.providerData?.finishReason)))) {
            throw providerRefusalError(this.policy.label);
          }
          if (e.type === 'response_done') {
            sawDone = true;
            const emptyOutput = !Array.isArray(e.response?.output) || e.response!.output!.length === 0;
            doneEmpty = !committed && emptyOutput;
            // Empty completion before any real content — bail WITHOUT yielding so
            // the post-loop handler retries OR throws (never a clean empty turn).
            if (doneEmpty) break;
            if (!committed) { yield* drain(pending); committed = true; }
            telemetry.streamState(committed, sawDone);
            yield ev;
            continue;
          }
          if (!committed && isBufferableMetadata(ev)) { pending.push(ev); continue; }
          // First REAL content commits us (the Runner now holds live output, so a
          // retry would duplicate it). Flush the buffered metadata in order, then
          // stream this and every later event straight through.
          if (!committed) { yield* drain(pending); committed = true; }
          telemetry.streamState(committed, sawDone);
          yield ev;
        }
      } catch (err) {
        telemetry.finishAttempt(request.signal?.aborted ? 'cancelled' : 'failed', committed, sawDone,
          telemetryFailureKind(err), telemetryFailureStatus(err));
        if (call.signal?.aborted) throw err;
        if (committed) throw err; // real content already escaped — cannot safely retry
        if (err instanceof BoundaryError) throw err;
        if (!effortStripped && isEffortRejection(err)) {
          effortStripped = true;
          req = stripEffortFromRequest(req);
          logger.warn({ label: this.policy.label, path: 'getStreamedResponse' }, 'model rejected the effort parameter — stripping effort and retrying');
          telemetry.retryNow(attempt + 1, 'effort_rejected', telemetryFailureKind(err));
          continue;
        }
        if (await this.handleAttemptFailure(err, attempt, authRefreshed, 'getStreamedResponse', call, telemetry)) continue;
        throw err;
      }

      // Empty completion (response_done with no content). Retry if budget
      // remains; otherwise throw the retryable boundary error — NEVER yield a
      // clean empty response_done (mirrors getResponse + the Codex adapter).
      if (doneEmpty && !committed) {
        if (call.signal?.aborted) {
          telemetry.finishAttempt('cancelled', false, true, 'model.empty_completion');
          call.signal.throwIfAborted();
        }
        telemetry.finishAttempt('failed', false, true, 'model.empty_completion');
        call.signal?.throwIfAborted();
        if (attempt < this.maxRetries) {
          logger.warn({ label: this.policy.label, attempt: attempt + 1 }, 'streamed empty completion — retrying (always-an-output invariant)');
          const wait = backoffMs(attempt, { retryable: true, kind: 'model.empty_completion', isAuth: false });
          await telemetry.wait(attempt + 1, 'empty_completion', 'model.empty_completion', wait, () => this.sleep(wait, call.signal));
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
        if (call.signal?.aborted) {
          telemetry.finishAttempt('cancelled', false, false, 'model.transport_timeout');
          call.signal.throwIfAborted();
        }
        telemetry.finishAttempt('failed', false, false, 'model.transport_timeout');
        call.signal?.throwIfAborted();
        if (attempt < this.maxRetries) {
          logger.warn({ label: this.policy.label, attempt: attempt + 1 }, 'stream ended with no response_done before content — retrying');
          call.noAnswerRetries += 1;
          const wait = backoffMs(attempt, { retryable: true, kind: 'model.transport_timeout', isAuth: false });
          await telemetry.wait(attempt + 1, 'incomplete_stream', 'model.transport_timeout', wait, () => this.sleep(wait, call.signal));
          continue;
        }
        const ended = new BoundaryError({
          kind: 'model.transport_timeout',
          retryable: true,
          userMessage: "Clementine's model backend dropped the connection before finishing this turn. Please retry.",
          operatorMessage: `${this.policy.label}: stream ended without response_done before content (attempts=${attempt + 1}).`,
          context: { label: this.policy.label, attempts: attempt + 1 },
        });
        if (call.noAnswerRetries >= 1) markRetriesSpent(ended);
        throw ended;
      }
      if (!sawDone) call.signal?.throwIfAborted();
      outcome = call.signal?.aborted ? 'cancelled' : 'returned';
      telemetry.finishAttempt(outcome, committed, sawDone);
      return; // committed + drained, or done emitted
    }
    } catch (err) {
      outcome = request.signal?.aborted ? 'cancelled' : 'failed';
      failureKind = telemetryFailureKind(err);
      throw err;
    } finally {
      telemetry.finish(request.signal?.aborted && outcome === 'interrupted' ? 'cancelled' : outcome, failureKind);
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
