/**
 * CodexResponsesModel — native `Model` adapter for the ChatGPT codex
 * backend (https://chatgpt.com/backend-api/codex/responses).
 *
 * The OpenAI Agents SDK exposes a small `Model` interface (two methods
 * — getResponse and getStreamedResponse). This file implements that
 * interface end-to-end against codex's wire protocol — hand-rolled
 * HTTP + SSE, no OpenAI SDK in the request path.
 *
 * Why not just point the OpenAI SDK at codex?
 *   The OpenAI SDK assumes the standard Responses API contract. Codex
 *   diverges in ~6 places: it requires `instructions`, forces
 *   `store: false`, forces `stream: true`, rejects
 *   `previous_response_id` (because it doesn't persist responses),
 *   requires JWT-derived `chatgpt-account-id` + `OpenAI-Beta` +
 *   `originator` headers, and emits `response.completed` with an
 *   empty `output: []` array (items live only in `output_item.done`
 *   events). Patching the SDK via a fetch adapter is whack-a-mole;
 *   every new agent shape finds a new mismatch.
 *
 * This adapter mirrors what pi-ai
 * (@earendil-works/pi-ai/packages/ai/src/providers/openai-codex-responses.ts)
 * and the v0.2 codex-native-runtime.ts both do: speak codex natively.
 *
 * What we plug into the SDK:
 *   - CodexResponsesModel implements `Model.getResponse` and
 *     `Model.getStreamedResponse`. It receives the SDK's `ModelRequest`
 *     and returns `ModelResponse` / `AsyncIterable<StreamEvent>`.
 *   - CodexModelProvider implements `ModelProvider.getModel(name)`.
 *     Register via `setDefaultModelProvider(new CodexModelProvider())`
 *     and every Agent that names a model string by string lookup gets
 *     a CodexResponsesModel back.
 *
 * Auth: each request resolves a fresh codex OAuth access token via
 * `loadFreshCodexAccessToken()`. Token rotation is handled in
 * codex-client.ts (the OAuth wallet); this file just consumes it.
 */

import { Usage } from '@openai/agents-core';
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  SerializedTool,
  SerializedHandoff,
  SerializedOutputType,
} from '@openai/agents-core';
import type { AgentInputItem, AgentOutputItem } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { MODELS } from '../../config.js';
import { loadFreshCodexAccessToken, extractAccountIdFromJwt } from './codex-client.js';
import { refreshStoredNativeOAuth, getStoredCodexOAuthTokens, classifyCodexAuthError } from '../auth-store.js';
import { BoundaryError } from '../boundary-error.js';
import { codexDispatcher, detectCodexTransportFailure, buildTransportTimeoutError } from '../codex-dispatcher.js';
import { estimateInputTokens } from './token-estimator.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.codex-model' });

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_USER_AGENT = 'Codex/0.118.0';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const CODEX_TRANSPARENT_MAX_RETRIES = 3;
const MIN_NATIVE_COMPACTION_THRESHOLD = 1000;
const DEFAULT_NATIVE_COMPACTION_THRESHOLD = 8192;

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

/**
 * Per-attempt diagnostic capture for SSE failures. The throw site for
 * `codex.sse_truncated` previously had no visibility into HTTP status,
 * response headers, or request size — making real-world failures
 * (rate-limit, backend incident, oversized request, transient TLS
 * issue) indistinguishable. This shape is populated as the request
 * progresses; the BoundaryError context attaches whatever fields are
 * set when the truncation throw fires.
 */
interface StreamDiagnostics {
  httpStatus?: number;
  responseHeaders?: Record<string, string>;
  startTs?: number;
  firstByteTs?: number;
  streamEndTs?: number;
  requestBytes?: number;
}

/** Headers we care about for failure diagnostics. OpenAI/Codex
 *  surfaces request id + rate-limit info via these; Cloudflare adds
 *  cf-ray. Anything else would be noise. */
const DIAGNOSTIC_HEADERS = [
  'openai-request-id',
  'openai-version',
  'openai-organization',
  'openai-processing-ms',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'retry-after',
  'cf-ray',
] as const;

function collectDiagnosticHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = headers.get(name);
    if (value != null && value !== '') out[name] = value;
  }
  return out;
}

interface RequestBodyBreakdown {
  totalBytes: number;
  instructionsBytes: number;
  inputBytes: number;
  inputItemCount: number;
  toolsBytes: number;
  toolCount: number;
  /** Top-10 largest tools by serialized JSON size, for surgical
   *  trimming. Sorted descending by bytes. */
  topTools: Array<{ name: string; bytes: number }>;
  otherBytes: number;
}

/**
 * Break down a Codex request body into its top-level components so we
 * can tell at-a-glance whether tool schema, input history, or
 * instructions dominate the wire payload. Pure measurement — no I/O.
 *
 * Triggered from the SSE-truncation throw path when we suspect the
 * request itself is the cause (oversized prefill). Lets a single
 * trace tell the operator exactly which tools to trim.
 */
/**
 * v0.5.19 F5 — persist a Codex SSE-truncation trace to disk.
 *
 * The full request body + a tools breakdown is what unblocks the
 * deferred tool-trim work. Until v0.5.19 the writer was inlined in
 * the throw path and only fired on real-world truncation, which
 * meant we had no captured traces and were guessing what to trim.
 * Extracting this lets the F5 sub-test exercise the writer directly
 * (with a synthetic body), proving the trace contains the breakdown
 * the operator needs.
 *
 * Best-effort: never throws — a trace-write failure must NOT block
 * the boundary-error throw it accompanies.
 */
export async function writeSseTruncationTrace(
  modelId: string,
  diagContext: Record<string, unknown>,
  body: CodexRequestBody,
): Promise<string | null> {
  try {
    const { atomicJsonMutate } = await import('../atomic-json.js');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const { BASE_DIR } = await import('../../config.js');
    // Under test, the harness loop's truncation path is exercised by
    // ScriptedCodexModel with a synthetic empty request — and it lands
    // here on the throw path. Writing to the real BASE_DIR pollutes the
    // operator's live SSE-truncation dataset (99 of 105 captures observed
    // 2026-06-01 were these test artifacts, drowning out the 6 genuine
    // truncations the compaction research relies on). Under test we ALWAYS
    // redirect to a temp dir — unconditionally, not gated on CLEMENTINE_HOME
    // — so a parent-exported CLEMENTINE_HOME pointing at a real state dir
    // can never be polluted by a test run. No test reads the trace file
    // (the writer returns the path), so the redirect is transparent.
    const os = await import('node:os');
    const baseRoot = process.env.NODE_ENV === 'test'
      ? path.join(os.tmpdir(), 'clementine-sse-trace-test')
      : path.join(BASE_DIR, 'state');
    const traceDir = path.join(baseRoot, 'codex-sse-truncated');
    // atomicJsonMutate creates the file's parent dir during the write
    // step (atomic-json.ts:229), but the advisory `.lock` file is
    // opened BEFORE that mkdir. Pre-create the dir so the lock open
    // doesn't ENOENT on the first trace ever written.
    fs.mkdirSync(traceDir, { recursive: true });
    const tracePath = path.join(traceDir, `${Date.now()}-${modelId}.json`);
    await atomicJsonMutate(
      tracePath,
      () => ({
        ts: new Date().toISOString(),
        kind: 'codex.sse_truncated',
        diagnostics: diagContext,
        // Full body — the WHOLE thing. This is the only artifact that
        // tells us which tools are dominating the schema. ~2-3 MB per
        // trace; auto-prune after a few weeks if storage becomes a concern.
        requestBody: body,
      }),
      {} as Record<string, unknown>,
    );
    return tracePath;
  } catch (err) {
    // best-effort: never block the throw path on a trace write.
    // Surface the error in supervisor.log so silent trace loss is
    // diagnosable — but still return null so callers can proceed.
    // eslint-disable-next-line no-console
    console.warn(
      '[codex-model] writeSseTruncationTrace failed (best-effort, returning null):',
      err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err,
    );
    return null;
  }
}

/**
 * v0.5.19 F5 — test-only knob. Returns true when the operator has
 * explicitly opted into forcing an SSE truncation for diagnostic
 * purposes. Double-gated on NODE_ENV or CLEMMY_DEV_OVERRIDES so a
 * production daemon cannot trip this even with the env set.
 */
export function shouldForceSseTruncation(): boolean {
  if (process.env.CLEMMY_FORCE_SSE_TRUNCATE !== '1') return false;
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.CLEMMY_DEV_OVERRIDES === '1') return true;
  return false;
}

/**
 * Harness invariant — "there is always an output." The model boundary must
 * never hand back an EMPTY COMPLETION: a `response.completed` that carried
 * zero output items and surfaced no content to the SDK. That is a backend
 * blip, not an answer — and passing it through as a clean (empty)
 * ModelResponse dead-ends downstream as the "couldn't be structured"
 * sentinel (observed once live: the "find email from Brooke" turn came back
 * empty and gave up on turn 1). An empty completion and a truncated stream
 * are the SAME class ("the model yielded no content"), so we fold the
 * former into the latter's existing retry-or-honest-error path instead of
 * special-casing it downstream. Provably safe to retry (nothing was yielded
 * to the user, so no tokens can duplicate). Kill-switch
 * CLEMMY_CODEX_RETRY_EMPTY_COMPLETION=off restores the legacy pass-through.
 */
export function retryEmptyCompletionEnabled(): boolean {
  const v = (process.env.CLEMMY_CODEX_RETRY_EMPTY_COMPLETION ?? 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

function sizeRequestComponents(body: CodexRequestBody): RequestBodyBreakdown {
  const utf8 = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
  const instructionsBytes = Buffer.byteLength(body.instructions ?? '', 'utf8');
  const inputBytes = utf8(body.input ?? []);
  const inputItemCount = Array.isArray(body.input) ? body.input.length : 0;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolsBytes = utf8(tools);
  const perTool: Array<{ name: string; bytes: number }> = tools.map((t) => {
    const r = t as Record<string, unknown>;
    const name = (r.name as string) ?? (r.function as { name?: string } | undefined)?.name ?? 'unknown';
    return { name: String(name), bytes: utf8(t) };
  });
  perTool.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = utf8(body);
  return {
    totalBytes,
    instructionsBytes,
    inputBytes,
    inputItemCount,
    toolsBytes,
    toolCount: tools.length,
    topTools: perTool.slice(0, 10),
    otherBytes: totalBytes - instructionsBytes - inputBytes - toolsBytes,
  };
}

function countSerializedInputRisk(input: unknown[]): {
  functionCallCount: number;
  functionCallOutputCount: number;
  compactionInputItemCount: number;
  orphanFunctionCallOutputs: number;
  unmatchedFunctionCalls: number;
} {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  let compactionInputItemCount = 0;

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { type?: unknown; call_id?: unknown };
    if (row.type === 'compaction') compactionInputItemCount += 1;
    if (row.type === 'function_call' && typeof row.call_id === 'string') calls.add(row.call_id);
    if (row.type === 'function_call_output' && typeof row.call_id === 'string') outputs.add(row.call_id);
  }

  let orphanFunctionCallOutputs = 0;
  for (const callId of outputs) {
    if (!calls.has(callId)) orphanFunctionCallOutputs += 1;
  }
  let unmatchedFunctionCalls = 0;
  for (const callId of calls) {
    if (!outputs.has(callId)) unmatchedFunctionCalls += 1;
  }

  return {
    functionCallCount: calls.size,
    functionCallOutputCount: outputs.size,
    compactionInputItemCount,
    orphanFunctionCallOutputs,
    unmatchedFunctionCalls,
  };
}

function logNativeCompactionRequestTelemetry(request: ModelRequest, body: CodexRequestBody): void {
  if (!isNativeCodexCompactionEnabled()) return;
  const rawInputItemCount = typeof request.input === 'string' ? 1 : request.input.length;
  const approximateRawInputTokens = typeof request.input === 'string'
    ? Math.ceil(request.input.length / 4)
    : estimateInputTokens(request.input);
  const serializedInput = Array.isArray(body.input) ? body.input : [];
  const serializedRisk = countSerializedInputRisk(serializedInput);
  logger.info(
    {
      modelId: body.model,
      contextManagementSent: Array.isArray(body.context_management) && body.context_management.length > 0,
      contextManagement: body.context_management ?? [],
      rawInputItemCount,
      serializedInputItemCount: serializedInput.length,
      approximateRawInputTokens,
      bodyBreakdown: sizeRequestComponents(body),
      ...serializedRisk,
    },
    'Codex native compaction request telemetry',
  );
}

export function isNativeCodexCompactionEnabled(): boolean {
  const value = (process.env.CLEMMY_CODEX_NATIVE_COMPACTION ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

function nativeCodexCompactionThreshold(): number {
  const raw = process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD;
  if (raw != null && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(MIN_NATIVE_COMPACTION_THRESHOLD, Math.floor(parsed));
    }
  }
  return DEFAULT_NATIVE_COMPACTION_THRESHOLD;
}

function isRetryUnsafeCodexOutputItem(item: CodexOutputItem | undefined): boolean {
  if (!item) return false;
  if (item.type === 'compaction' && isNativeCodexCompactionEnabled()) {
    return false;
  }
  return true;
}

function isRealContentCodexEvent(evt: AnyCodexEvent): boolean {
  if (evt.type === 'response.output_text.delta') return true;
  if (evt.type === 'response.output_item.done') return isRetryUnsafeCodexOutputItem(evt.item);
  return false;
}

function isTransparentCodexRetryError(err: unknown): err is BoundaryError {
  return err instanceof BoundaryError
    && (err.kind === 'codex.transport_timeout' || err.kind === 'codex.sse_truncated')
    && BoundaryError.isTransient(err);
}

/**
 * A Codex 429 (rate limit) is safe to retry transparently: it's thrown
 * at the non-OK response stage, BEFORE any SSE content, so no tokens
 * have been yielded and a retry can't duplicate output. Without this, a
 * transient rate limit (e.g. a burst of concurrent workflow runs) hard-
 * fails the run and fires a "workflow failed" notice — which is how
 * outreach runs were silently/noisily failing on the $100 plan during a
 * concurrency spike. Sustained limits still fail after the retry budget,
 * so genuine exhaustion is still reported.
 */
export function isRetryableCodexRateLimit(err: unknown): boolean {
  return err instanceof CodexModelError && err.status === 429;
}

function shouldRetryTransparentCodexFailure(
  err: unknown,
  yieldedRealContent: boolean,
  attempt: number,
): boolean {
  return (isTransparentCodexRetryError(err) || isRetryableCodexRateLimit(err))
    && !yieldedRealContent
    && attempt < CODEX_TRANSPARENT_MAX_RETRIES;
}

function transparentCodexRetryDelayMs(attempt: number, isRateLimit = false): number {
  const override = process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS;
  if ((process.env.NODE_ENV === 'test' || process.env.CLEMMY_DEV_OVERRIDES === '1') && override != null) {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  // Rate limits need real seconds to clear, not sub-second jitter:
  // 2s, 4s, 8s vs the transport-failure 750ms, 1.5s, 3s.
  const base = isRateLimit ? 2000 : 750;
  return base * Math.pow(2, attempt);
}

async function waitBeforeTransparentCodexRetry(
  err: unknown,
  attempt: number,
  path: 'getResponse' | 'getStreamedResponse',
): Promise<void> {
  const rateLimited = isRetryableCodexRateLimit(err);
  const backoffMs = transparentCodexRetryDelayMs(attempt, rateLimited);
  const boundary = err instanceof BoundaryError ? err : null;
  logger.warn(
    {
      path,
      attempt: attempt + 1,
      nextAttempt: attempt + 2,
      maxRetries: CODEX_TRANSPARENT_MAX_RETRIES,
      backoffMs,
      rateLimited,
      kind: boundary?.kind ?? (rateLimited ? 'codex.rate_limited' : null),
      context: boundary?.context ?? {},
    },
    'Codex model call failed before real content; retrying transparently',
  );
  if (backoffMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
}

export class CodexResponsesModel implements Model {
  constructor(public readonly modelId: string) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    for (let attempt = 0; attempt <= CODEX_TRANSPARENT_MAX_RETRIES; attempt++) {
      const events: AnyCodexEvent[] = [];
      try {
        for await (const evt of this.streamCodex(request)) {
          events.push(evt);
        }
        return assembleModelResponse(events);
      } catch (err) {
        const yieldedRealContent = events.some(isRealContentCodexEvent);
        if (shouldRetryTransparentCodexFailure(err, yieldedRealContent, attempt)) {
          await waitBeforeTransparentCodexRetry(err, attempt, 'getResponse');
          continue;
        }
        throw err;
      }
    }
    throw new CodexModelError('Codex retry loop exhausted unexpectedly.');
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    // Transparent retry on retryable Codex transport/SSE failures when
    // NO content was yielded to the SDK yet. Common field cases:
    // - UND_ERR_HEADERS_TIMEOUT before the backend sends headers.
    // - UND_ERR_BODY_TIMEOUT before any real model content.
    // - `codex.sse_truncated` after response.created but before content.
    //
    // A prior migration attempt moved the harness to Agents SDK 0.11.5
    // but relied on SDK-level retry behavior; the first Codex call then
    // surfaced `UND_ERR_HEADERS_TIMEOUT` and the workflow stalled before
    // any tools fired. Keep this retry inside the Codex adapter, where
    // we know exactly which events have escaped to the SDK.
    //
    // Existing SSE case from the field:
    // the upstream Codex stream emits `response.created` and then drops
    // before any output_text.delta / output_item.done — items=0,
    // responseId set. With this retry, the user-visible failure is
    // hidden as long as the second attempt succeeds. If content was
    // already yielded, we cannot safely retry (would duplicate tokens),
    // so we throw the BoundaryError as before.
    // v0.5.21.1 — bumped 1 → 3 (4 total attempts) with exponential
    // backoff. Verified 2026-05-25 on sess-mplmvrqu: under the chronic
    // Codex SSE-flake window observed 2026-05-24/25 (7 truncations in
    // 48h), MAX_RETRY=1 surfaced the F4 ask-user card on every flake
    // and forced the user to click Retry manually — even though the
    // very next attempt almost always succeeded. With 3 transparent
    // retries + exponential backoff (750ms, 1.5s, 3s), the SDK rides
    // through transient flakes silently. F4 only fires for SUSTAINED
    // outages (rare). Tradeoff: a real outage waits ~12s before the
    // user sees Retry, vs ~3s previously — acceptable because outages
    // are 10× rarer than transient flakes per current telemetry.
    let lastResponseId: string | undefined;
    let lastItemCount = 0;
    let lastDiag: StreamDiagnostics | undefined;

    for (let attempt = 0; attempt <= CODEX_TRANSPARENT_MAX_RETRIES; attempt++) {
      const seenOutputItems: CodexOutputItem[] = [];
      let responseId: string | undefined;
      let completedEvent: AnyCodexEvent | undefined;
      const diag: StreamDiagnostics = {};
      lastDiag = diag;
      // Retry-safety gate: ONLY text deltas + output_item.done count as
      // "real content the SDK has surfaced to the user." If anything
      // here fires and the stream then truncates, retrying would
      // duplicate tokens — FORBIDDEN. Everything else (response_started,
      // model pass-through frames for reasoning summaries / keep-alives
      // / observability) is buffered below until we see first real
      // content. If the stream truncates before any real content, we
      // throw the buffer away and retry — the SDK never saw a stale
      // responseId or duplicated metadata frame.
      let yieldedRealContent = false;
      // Buffered events held back until first real content arrives.
      // pendingStart is the SINGLE response_started (one per response).
      // pendingMetadata is every "model" pass-through event, in order.
      // Both flush together the moment a content event arrives, or on
      // a clean completedEvent path. On retry both are discarded.
      let pendingStart: StreamEvent | undefined;
      let pendingMetadata: StreamEvent[] = [];

      const flushBuffer = function* () {
        if (pendingStart) { yield pendingStart; pendingStart = undefined; }
        if (pendingMetadata.length > 0) {
          for (const ev of pendingMetadata) yield ev;
          pendingMetadata = [];
        }
      };

      let eventsConsumed = 0;
      try {
        for await (const evt of this.streamCodex(request, diag)) {
          eventsConsumed += 1;
          // v0.5.19 F5 — diagnostic knob: after 5 events, drop the
          // stream as if it truncated. Double-gated (NODE_ENV=test or
          // CLEMMY_DEV_OVERRIDES=1) so production cannot trip it. Lets
          // an operator capture a real-traffic SSE-truncation trace
          // without waiting for an organic failure.
          if (eventsConsumed > 5 && shouldForceSseTruncation()) {
            break;
          }
          if (evt.type === 'response.created' && evt.response?.id) {
            responseId = evt.response.id;
            pendingStart = { type: 'response_started', providerData: { responseId } } as StreamEvent;
            continue;
          }
          if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
            yield* flushBuffer();
            yieldedRealContent = true;
            yield {
              type: 'output_text_delta',
              delta: evt.delta,
              providerData: { sequence_number: evt.sequence_number },
            } as StreamEvent;
            continue;
          }
          if (evt.type === 'response.output_item.done' && evt.item) {
            if (isRetryUnsafeCodexOutputItem(evt.item)) {
              yield* flushBuffer();
              yieldedRealContent = true;
            }
            seenOutputItems.push(evt.item);
            continue;
          }
          if (evt.type === 'response.completed' || evt.type === 'response.done') {
            completedEvent = evt;
            continue;
          }
          // Metadata pass-through — buffer instead of yielding. Codex
          // routinely emits one or two reasoning_summary / keep-alive
          // frames before the first text delta; previously we yielded
          // these immediately and that blocked the retry path when the
          // stream then truncated. Now they sit in pendingMetadata until
          // either (a) real content arrives and the buffer flushes in
          // order, or (b) the stream truncates and the buffer is
          // discarded on retry. Net effect: the SDK observes events in
          // the SAME order, just delayed slightly into the same tick.
          pendingMetadata.push({ type: 'model', event: evt } as StreamEvent);
        }
      } catch (err) {
        lastResponseId = responseId;
        lastItemCount = seenOutputItems.length;
        if (shouldRetryTransparentCodexFailure(err, yieldedRealContent, attempt)) {
          pendingStart = undefined;
          pendingMetadata = [];
          await waitBeforeTransparentCodexRetry(err, attempt, 'getStreamedResponse');
          continue;
        }
        throw err;
      }

      // "Empty completion" — response.completed arrived but the model
      // yielded NO content (zero output items, no text delta). Not a valid
      // answer in this harness; fold it into the same no-content retry path
      // a truncated stream uses below (see retryEmptyCompletionEnabled).
      const emptyCompletion = !!completedEvent
        && seenOutputItems.length === 0
        && !yieldedRealContent
        && retryEmptyCompletionEnabled();
      if (completedEvent && !emptyCompletion) {
        // Success path — flush any deferred events (response_started +
        // metadata frames) in arrival order before the response_done.
        // For a "completed cleanly with no real content" trace (rare),
        // this ensures the SDK still observes the start + reasoning
        // events that fired during this attempt.
        yield* flushBuffer();
        // Codex's response.completed has output: []. Stuff in the items
        // we accumulated so the SDK builds the right ModelResponse.
        const finalOutput = seenOutputItems.map(convertCodexItemToSdkOutputItem);
        // The response_done event schema expects a *plain* usage object —
        // not a Usage class instance (which has Array<Record<>> for the
        // details fields). Mirror the OpenAIResponsesModel's streaming
        // shape: snake_case detail spreads, camelCase token counts.
        const u = completedEvent?.response?.usage ?? {};
        yield {
          type: 'response_done',
          response: {
            id: responseId ?? completedEvent?.response?.id ?? '',
            output: finalOutput,
            usage: {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              totalTokens: u.total_tokens ?? 0,
              inputTokensDetails: { ...(u.input_tokens_details ?? {}) },
              outputTokensDetails: { ...(u.output_tokens_details ?? {}) },
            },
            providerData: completedEvent?.response ?? {},
          },
          providerData: {},
        } as unknown as StreamEvent;
        return;
      }

      // No content from the model — either a truncated stream (no
      // response.completed) OR an empty completion (response.completed with
      // zero output). Same class: retry IF nothing was yielded to the SDK
      // yet AND we have retry budget; otherwise throw the retryable
      // BoundaryError so the harness logs it + surfaces a real message.
      // "Always an output": never silently pass an empty answer downstream.
      lastResponseId = responseId;
      lastItemCount = seenOutputItems.length;
      const noContentReason = completedEvent
        ? 'empty completion (response.completed carried no output)'
        : 'SSE ended without response.completed before real content';
      if (!yieldedRealContent && attempt < CODEX_TRANSPARENT_MAX_RETRIES) {
        // v0.5.21.1 — exponential backoff with jitter: 750ms, 1.5s, 3s.
        // Single fixed delay re-hammered the backend on the same frame
        // a struggling Cloudflare/Codex edge was rejecting; spacing
        // attempts gives the upstream time to recover. Buffered events
        // from the failed attempt are explicitly discarded so the new
        // stream's response.created / metadata frames don't collide
        // with stale ones.
        pendingStart = undefined;
        pendingMetadata = [];
        await waitBeforeTransparentCodexRetry(
          new BoundaryError({
            kind: 'codex.sse_truncated',
            retryable: true,
            userMessage: "Clementine's model backend dropped the connection before finishing this turn. Retry — if it persists, the Codex backend may be having an incident.",
            operatorMessage: `Codex produced no content: ${noContentReason}.`,
            context: { responseId: lastResponseId ?? null, itemCount: lastItemCount, emptyCompletion: completedEvent != null },
          }),
          attempt,
          'getStreamedResponse',
        );
        continue;
      }

      // T1.4 — refuse to fabricate a clean "response_done" when the
      // upstream stream never emitted response.completed. The previous
      // behavior here synthesized response_done with empty usage,
      // letting the SDK proceed as if the model had finished cleanly;
      // the caller could not distinguish "model said nothing" from
      // "connection dropped mid-stream." Throw a structured boundary
      // error instead so the harness logs it as codex.sse_truncated +
      // surfaces a real message to the user.
      const durationMs =
        lastDiag?.startTs != null
          ? (lastDiag.streamEndTs ?? Date.now()) - lastDiag.startTs
          : null;
      const ttfbMs =
        lastDiag?.startTs != null && lastDiag.firstByteTs != null
          ? lastDiag.firstByteTs - lastDiag.startTs
          : null;
      // Rebuild the body shape so we can break it down by component.
      // Cheap — same call we make in #streamCodex. Worth the duplication
      // for the diagnostic since the body's not in scope here.
      const body = buildCodexRequestBody(this.modelId, request);
      const breakdown = sizeRequestComponents(body);
      const diagContext = {
        itemCount: lastItemCount,
        responseId: lastResponseId ?? null,
        attempts: attempt + 1,
        modelId: this.modelId,
        // Capture what was actually sent + what came back. Most opaque
        // failures correlate to one of: oversized request, rate-limit
        // (header surfaces it), or upstream incident (HTTP status or
        // ttfb anomaly). Without this we were guessing.
        httpStatus: lastDiag?.httpStatus ?? null,
        responseHeaders: lastDiag?.responseHeaders ?? {},
        requestBytes: lastDiag?.requestBytes ?? null,
        durationMs,
        ttfbMs,
        bodyBreakdown: breakdown,
        emptyCompletion: completedEvent != null,
      };
      // Persist the full request body + breakdown to disk so we can
      // post-mortem WHICH tools dominate the request. Extracted into
      // `writeSseTruncationTrace` (v0.5.19 F5) so the sub-test can
      // exercise the trace-write path without booting the model
      // streamer. Mirrors the existing codex-4xx-trace pattern from
      // #streamCodex. Stored in a separate folder so 4xx traces and
      // SSE-truncation traces don't blur together.
      await writeSseTruncationTrace(this.modelId, diagContext, body);
      // Emit a structured log line BEFORE the throw so the failure is
      // visible even if a downstream consumer swallows BoundaryError's
      // .context. Pino warn level — surfaces in the supervisor log
      // ndjson stream where operators look first.
      logger.warn(
        { ...diagContext, kind: 'codex.sse_truncated' },
        'Codex SSE truncated — stream ended without response.completed',
      );
      throw new BoundaryError({
        kind: 'codex.sse_truncated',
        retryable: true,
        userMessage: "Clementine's model backend dropped the connection before finishing this turn. Retry — if it persists, the Codex backend may be having an incident.",
        operatorMessage: `getStreamedResponse: ${noContentReason} (items=${lastItemCount}, responseId=${lastResponseId ?? 'none'}, attempts=${attempt + 1}, httpStatus=${lastDiag?.httpStatus ?? 'unknown'}, durationMs=${durationMs ?? 'unknown'})`,
        context: diagContext,
      });
    }
  }

  /**
   * Single source of truth for "make the codex request, yield SSE
   * events." Both getResponse and getStreamedResponse consume it.
   *
   * The optional `diag` parameter is a mutable diagnostics bag the
   * caller passes when it wants HTTP metadata + timing to survive
   * out of the generator scope (used by getStreamedResponse so the
   * BoundaryError can carry real diagnostic context when an SSE
   * truncation fires — without this every failure was indistinguish-
   * able from every other).
   */
  protected async *streamCodex(request: ModelRequest, diag?: StreamDiagnostics): AsyncGenerator<AnyCodexEvent> {
    // Request body is token-independent — build it once and reuse across a
    // possible refresh-and-retry below.
    const body = buildCodexRequestBody(this.modelId, request);
    const bodyJson = JSON.stringify(body);
    logNativeCompactionRequestTelemetry(request, body);
    if (diag) {
      diag.requestBytes = Buffer.byteLength(bodyJson, 'utf8');
    }

    let token = await loadFreshCodexAccessToken();
    // A 401 on a MODEL call almost always means the short-lived access token
    // just expired (or a one-off edge reject) — NOT a revoked sign-in. Force ONE
    // refresh + retry before surfacing anything (the daemon CodexNativeRuntime
    // path and Hermes both do this). Only a TERMINAL refresh result (a real
    // revoke, which latches auth DEAD inside refreshStoredNativeOAuth) becomes a
    // re-auth prompt; a transient 401 stays a retryable error and never bricks.
    let refreshedOn401 = false;
    for (;;) {
      const accountId = extractAccountIdFromJwt(token) ?? '';
      if (!accountId) {
        throw new CodexModelError(
          'Could not extract chatgpt_account_id from the codex OAuth token. ' +
            'Run `clementine auth login-native` to re-login.',
        );
      }
      if (diag) {
        diag.startTs = Date.now();
      }
      let res: Response;
      try {
        // v0.5.21 Phase 2 — pass `dispatcher: codexDispatcher` so undici
        // enforces headersTimeout (15s) and bodyTimeout (30s) on this
        // request. Default undici timeouts are 5min each, which hung
        // chat indefinitely on a Cloudflare edge stall (2026-05-25
        // sess-mplfm14j-f0985a98). Detect UND_ERR_HEADERS_TIMEOUT here
        // (the body-timeout case is detected inside the streaming
        // generator below).
        res = await fetch(CODEX_URL, {
          method: 'POST',
          headers: buildCodexHeaders(token, accountId),
          body: bodyJson,
          signal: request.signal,
          dispatcher: codexDispatcher,
        } as RequestInit & { dispatcher?: unknown });
      } catch (err) {
        const undiciCode = detectCodexTransportFailure(err);
        if (undiciCode) {
          throw buildTransportTimeoutError(undiciCode, {
            modelId: this.modelId,
            requestBytes: diag?.requestBytes ?? null,
            phase: 'headers',
          }, err);
        }
        throw err;
      }
      if (diag) {
        diag.httpStatus = res.status;
        diag.responseHeaders = collectDiagnosticHeaders(res.headers);
        diag.firstByteTs = Date.now();
      }

      if (!res.ok) {
        const detail = await safeReadErrorBody(res);
        // Refresh-and-retry on a marker-less 401 (access-token expiry), once.
        // A 401 carrying a real revoke marker (token_revoked / invalid_grant /…)
        // classifies 'terminal' even with source:'model', so it skips the retry
        // and surfaces immediately.
        if (
          res.status === 401
          && !refreshedOn401
          && classifyCodexAuthError({ message: detail ?? '', status: 401, source: 'model' }) !== 'terminal'
        ) {
          refreshedOn401 = true;
          const refreshResult = await refreshStoredNativeOAuth({ force: true });
          if (refreshResult.ok) {
            const refreshed = getStoredCodexOAuthTokens();
            if (refreshed?.accessToken) {
              token = refreshed.accessToken;
              continue; // retry the request with the fresh token (no bytes streamed yet)
            }
          }
          if (refreshResult.terminal) {
            // The refresh token itself is dead — DEAD latch is already set inside
            // refreshStoredNativeOAuth. Surface a terminal error so loop.ts shows
            // the re-auth prompt.
            throw new CodexModelError(
              `Codex sign-in is revoked or expired — re-authenticate to resume. ${refreshResult.message}`,
              401,
            );
          }
          // Transient refresh failure (network / 5xx): fall through to throw a
          // non-terminal 401 the loop can retry, rather than bricking auth.
        }
        // Persist a 4xx trace so operators can inspect the exact request
        // that Codex rejected. The codex-native-runtime path has the same
        // logic (T2.4); the harness path was a gap — without this trace
        // an error like "No tool output found for function call call_X"
        // has no diagnosable surface because the request body is not
        // preserved anywhere else (store:false, stream:true).
        if (res.status >= 400 && res.status < 500) {
          try {
            const { atomicJsonMutate } = await import('../atomic-json.js');
            const path = await import('node:path');
            const { BASE_DIR } = await import('../../config.js');
            const inputArr = Array.isArray(body.input) ? body.input : [];
            const tracePath = path.join(
              BASE_DIR,
              'state',
              'codex-4xx-trace',
              `harness-${Date.now()}.json`,
            );
            await atomicJsonMutate(
              tracePath,
              () => ({
                ts: new Date().toISOString(),
                source: 'codex-model',
                status: res.status,
                modelId: this.modelId,
                responseBody: detail?.slice(0, 4096) ?? '',
                inputItemCount: inputArr.length,
                inputItemSummary: inputArr.map((it) => {
                  const r = it as Record<string, unknown>;
                  return {
                    type: r.type ?? r.role ?? 'unknown',
                    call_id: r.call_id ?? undefined,
                    name: r.name ?? undefined,
                  };
                }),
                requestBody: body,
              }),
              {} as Record<string, unknown>,
            );
          } catch {
            // best-effort; never block the error path on a trace write
          }
        }
        throw new CodexModelError(
          `Codex /responses returned ${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`,
          res.status,
        );
      }
      if (!res.body) {
        throw new CodexModelError('Codex /responses returned an empty body.');
      }

      yield* this.streamCodexBody(res.body, diag);
      return;
    }
  }

  /** Stream + parse the SSE body. Split out of streamCodex so the
   *  refresh-and-retry loop above never re-enters streaming once bytes flow. */
  private async *streamCodexBody(bodyStream: ReadableStream<Uint8Array>, diag?: StreamDiagnostics): AsyncGenerator<AnyCodexEvent> {
    try {
      yield* parseCodexSse(bodyStream);
    } catch (err) {
      // v0.5.21 Phase 2 — undici body-timeout fires here (no SSE bytes
      // for 30s after headers arrived). Same routing as header-timeout
      // above: throw a BoundaryError(kind='codex.transport_timeout')
      // so loop.ts's F4 ask-user routing converts it to Retry/Switch/Stop.
      const undiciCode = detectCodexTransportFailure(err);
      if (undiciCode) {
        throw buildTransportTimeoutError(undiciCode, {
          modelId: this.modelId,
          requestBytes: diag?.requestBytes ?? null,
          httpStatus: diag?.httpStatus ?? null,
          phase: 'body',
        }, err);
      }
      throw err;
    } finally {
      if (diag) diag.streamEndTs = Date.now();
    }
  }
}

export class CodexModelProvider implements ModelProvider {
  constructor(private readonly defaultModelId?: string) {}
  getModel(modelName?: string): Model {
    return new CodexResponsesModel(resolveCodexModel(modelName ?? this.defaultModelId ?? MODELS.primary));
  }
}

export class CodexModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CodexModelError';
  }
}

// ----------------------------------------------------------------------
// Request body construction
// ----------------------------------------------------------------------

function resolveCodexModel(name: string): string {
  // Codex only accepts gpt-5* model ids. Fall back to a known good one
  // so a stray model name (e.g. an experimental autonomous workflow)
  // doesn't take the harness down.
  return name && name.startsWith('gpt-5') ? name : 'gpt-5.4';
}

interface CodexRequestBody {
  model: string;
  instructions: string;
  store: false;
  stream: true;
  input: unknown[];
  tools: unknown[];
  tool_choice: 'auto' | 'required' | 'none' | string;
  parallel_tool_calls?: boolean;
  text?: unknown;
  include: string[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  truncation?: 'auto' | 'disabled';
  reasoning?: { effort?: string; summary?: string };
  context_management?: Array<Record<string, unknown>>;
}

// Exported so contract tests can assert the wire shape without
// having to mock fetch + OAuth + SSE for every assertion.
export function buildCodexRequestBody(modelId: string, request: ModelRequest): CodexRequestBody {
  const tools = serializeTools(request.tools, request.handoffs);
  const body: CodexRequestBody = {
    model: resolveCodexModel(modelId),
    instructions: request.systemInstructions || 'You are a helpful assistant.',
    store: false,
    stream: true,
    input: serializeInput(request.input),
    tools,
    tool_choice: normalizeToolChoice(request.modelSettings?.toolChoice, tools.length > 0),
    include: ['reasoning.encrypted_content'],
  };

  if (tools.length > 0 && typeof request.modelSettings?.parallelToolCalls === 'boolean') {
    body.parallel_tool_calls = request.modelSettings.parallelToolCalls;
  }
  if (typeof request.modelSettings?.temperature === 'number') {
    body.temperature = request.modelSettings.temperature;
  }
  if (typeof request.modelSettings?.topP === 'number') {
    body.top_p = request.modelSettings.topP;
  }
  if (typeof request.modelSettings?.maxTokens === 'number') {
    body.max_output_tokens = request.modelSettings.maxTokens;
  }
  if (request.modelSettings?.truncation) {
    body.truncation = request.modelSettings.truncation;
  }
  if (request.modelSettings?.reasoning?.effort || request.modelSettings?.reasoning?.summary) {
    body.reasoning = {
      effort: request.modelSettings.reasoning.effort ?? undefined,
      summary: request.modelSettings.reasoning.summary ?? 'auto',
    };
  }
  const contextManagement = buildNativeCodexContextManagement(request.modelSettings?.contextManagement);
  if (contextManagement) {
    body.context_management = contextManagement;
  }

  const responseFormat = buildResponseFormat(request.outputType, request.modelSettings?.text);
  if (responseFormat) {
    body.text = responseFormat;
  }

  return body;
}

function buildNativeCodexContextManagement(
  contextManagement: ModelRequest['modelSettings']['contextManagement'] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!isNativeCodexCompactionEnabled()) return undefined;
  const threshold = nativeCodexCompactionThreshold();
  const source = contextManagement && contextManagement.length > 0
    ? contextManagement
    : [{ type: 'compaction', compact_threshold: threshold }];
  return source.map((entry) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined) continue;
      if (key === 'compactThreshold') {
        out.compact_threshold = value;
      } else {
        out[key] = value;
      }
    }
    if (out.type === 'compaction') {
      const compactThreshold = Number(out.compact_threshold);
      out.compact_threshold = Number.isFinite(compactThreshold) && compactThreshold > 0
        ? Math.max(MIN_NATIVE_COMPACTION_THRESHOLD, Math.floor(compactThreshold))
        : threshold;
    }
    return out;
  });
}

function normalizeToolChoice(
  choice: ModelRequest['modelSettings']['toolChoice'],
  hasTools: boolean,
): CodexRequestBody['tool_choice'] {
  if (!hasTools) return 'none';
  if (!choice) return 'auto';
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return choice;
}

function buildResponseFormat(
  outputType: SerializedOutputType | undefined,
  text: ModelRequest['modelSettings']['text'] | undefined,
): unknown {
  const textVerbosity = text?.verbosity;
  if (!outputType || outputType === 'text') {
    return textVerbosity ? { verbosity: textVerbosity } : undefined;
  }
  // Structured output. The SDK serializes Zod schemas into a
  // JsonSchemaDefinition with { name, type: 'json_schema', schema, strict }.
  const def = outputType as { type?: string; name?: string; schema?: unknown; strict?: boolean };
  return {
    format: {
      type: 'json_schema',
      name: def.name ?? 'output',
      schema: def.schema,
      strict: def.strict !== false,
    },
    ...(textVerbosity ? { verbosity: textVerbosity } : {}),
  };
}

// ----------------------------------------------------------------------
// Input + tool serialization
// ----------------------------------------------------------------------

/**
 * Convert the SDK's AgentInputItem[] into the codex Responses API wire
 * format. Codex needs `function_call` items to carry both `id` and
 * `call_id`, and the matching `function_call_output` must share the
 * `call_id` value. Cross-turn omission of the `function_call` is what
 * caused the "No tool call found for function call output" 400s — we
 * preserve everything verbatim.
 */
function serializeInput(input: ModelRequest['input']): unknown[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  const out: unknown[] = [];
  for (const item of input) {
    const serialized = serializeInputItem(item);
    if (serialized) out.push(serialized);
  }
  return out;
}

function serializeInputItem(item: AgentInputItem): unknown {
  const anyItem = item as Record<string, unknown> & { type?: string; role?: string };
  // Plain message items pass through with content normalized.
  if (anyItem.role && (anyItem.type === 'message' || 'content' in anyItem)) {
    const content = anyItem.content;
    if (typeof content === 'string') {
      return { role: anyItem.role, content };
    }
    if (Array.isArray(content)) {
      return {
        role: anyItem.role,
        content: content.map(normalizeContentPart),
      };
    }
    return { role: anyItem.role, content: '' };
  }
  // Tool call → emitted by a previous assistant turn.
  if (anyItem.type === 'function_call') {
    return {
      type: 'function_call',
      id: anyItem.id,
      call_id: anyItem.callId,
      name: anyItem.name,
      arguments: anyItem.arguments,
      status: anyItem.status,
    };
  }
  // Tool result paired with a prior function_call.
  if (anyItem.type === 'function_call_result') {
    const output = anyItem.output as { type?: string; text?: string } | undefined;
    return {
      type: 'function_call_output',
      id: anyItem.id,
      call_id: anyItem.callId,
      output: output?.type === 'text' ? output.text ?? '' : JSON.stringify(output ?? null),
      status: anyItem.status,
    };
  }
  // Reasoning items — pass the encrypted_content blob through so codex
  // can resume reasoning state without re-deriving it.
  if (anyItem.type === 'reasoning') {
    const reasoningContent = anyItem.content as Array<{ text: string }> | undefined;
    const providerData = anyItem.providerData as { encryptedContent?: string } | undefined;
    return {
      id: anyItem.id,
      type: 'reasoning',
      summary: reasoningContent?.map((c) => ({ type: 'summary_text', text: c.text })) ?? [],
      encrypted_content: providerData?.encryptedContent,
    };
  }
  if (anyItem.type === 'compaction') {
    if (!isNativeCodexCompactionEnabled()) return undefined;
    const encryptedContent = typeof anyItem.encrypted_content === 'string'
      ? anyItem.encrypted_content
      : typeof anyItem.encryptedContent === 'string'
        ? anyItem.encryptedContent
        : undefined;
    if (!encryptedContent) {
      throw new CodexModelError('Compaction item missing encrypted_content.');
    }
    return {
      type: 'compaction',
      id: anyItem.id,
      encrypted_content: encryptedContent,
      created_by: anyItem.created_by,
    };
  }
  // Anything else (computer calls, hosted tools, etc.) we don't
  // currently use in the harness; pass through as-is and let codex
  // tell us if it doesn't like the shape.
  return item;
}

function normalizeContentPart(part: unknown): unknown {
  if (!part || typeof part !== 'object') return part;
  const p = part as { type?: string; text?: string };
  if (p.type === 'input_text' || p.type === 'output_text') {
    return { type: p.type, text: p.text ?? '' };
  }
  return part;
}

function serializeTools(
  tools: SerializedTool[],
  handoffs: SerializedHandoff[],
): unknown[] {
  const out: unknown[] = [];
  for (const tool of tools) {
    const t = tool as { type: string };
    if (t.type === 'function') {
      const f = tool as {
        type: 'function';
        name: string;
        description?: string;
        parameters: unknown;
        strict?: boolean;
      };
      out.push({
        type: 'function',
        name: f.name,
        description: f.description,
        parameters: f.parameters,
        strict: f.strict,
      });
      continue;
    }
    // Hosted/computer tools — pass providerData if present so codex
    // can match the canonical shape. Today's harness doesn't lean on
    // these; the local function tools are the primary path.
    out.push(tool);
  }
  for (const handoff of handoffs) {
    out.push({
      type: 'function',
      name: handoff.toolName,
      description: handoff.toolDescription,
      parameters: handoff.inputJsonSchema,
      strict: handoff.strictJsonSchema,
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// Headers + auth
// ----------------------------------------------------------------------

function buildCodexHeaders(token: string, accountId: string): Headers {
  const h = new Headers();
  h.set('Authorization', `Bearer ${token}`);
  h.set('Content-Type', 'application/json');
  h.set('Accept', 'text/event-stream');
  h.set('User-Agent', CODEX_USER_AGENT);
  h.set('chatgpt-account-id', accountId);
  h.set('OpenAI-Beta', 'responses=experimental');
  h.set('originator', 'codex_cli_rs');
  return h;
}

// ----------------------------------------------------------------------
// SSE parsing + codex event types
// ----------------------------------------------------------------------

interface CodexOutputItem {
  id?: string;
  type: string;
  role?: string;
  status?: string;
  content?: Array<{
    type: string;
    text?: string;
    annotations?: unknown[];
    logprobs?: unknown[];
  }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: Array<{ type: string; text: string }>;
  encrypted_content?: string;
  [key: string]: unknown;
}

interface AnyCodexEvent {
  type?: string;
  item?: CodexOutputItem;
  delta?: string;
  sequence_number?: number;
  response?: {
    id?: string;
    output?: unknown[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: Record<string, unknown>;
      output_tokens_details?: Record<string, unknown>;
    };
    error?: { code?: string; message?: string };
  };
  [key: string]: unknown;
}

async function* parseCodexSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<AnyCodexEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseCodexBlock(block);
        if (ev) yield ev;
        idx = buf.indexOf('\n\n');
      }
    }
    if (buf.trim()) {
      const ev = parseCodexBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

function parseCodexBlock(block: string): AnyCodexEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join('\n').trim();
  if (!joined || joined === '[DONE]') return null;
  try {
    return JSON.parse(joined) as AnyCodexEvent;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------
// Codex item → SDK AgentOutputItem
// ----------------------------------------------------------------------

function convertCodexItemToSdkOutputItem(item: CodexOutputItem): AgentOutputItem {
  if (item.type === 'message') {
    const { id, type, role, status, content, ...providerData } = item;
    return {
      id,
      type,
      role,
      status,
      content: (content ?? []).map((c) => {
        if (c.type === 'output_text') {
          return {
            type: 'output_text',
            text: c.text ?? '',
            providerData: { annotations: c.annotations, logprobs: c.logprobs },
          };
        }
        return c as unknown;
      }),
      providerData,
    } as AgentOutputItem;
  }
  if (item.type === 'function_call') {
    const { id, type, call_id, name, arguments: args, status, ...providerData } = item;
    return {
      id,
      type: 'function_call',
      callId: call_id ?? '',
      name: name ?? '',
      arguments: args ?? '',
      status: status,
      providerData,
    } as unknown as AgentOutputItem;
  }
  if (item.type === 'reasoning') {
    const { id, type, summary, encrypted_content, ...providerData } = item;
    return {
      id,
      type: 'reasoning',
      content: (summary ?? []).map((s) => ({ type: 'summary_text', text: s.text })),
      providerData: { ...providerData, encryptedContent: encrypted_content },
    } as unknown as AgentOutputItem;
  }
  if (item.type === 'compaction') {
    const { id, type, encrypted_content, created_by, ...providerData } = item;
    if (!isNativeCodexCompactionEnabled()) {
      return { id, type: 'unknown', providerData: item } as unknown as AgentOutputItem;
    }
    if (typeof encrypted_content !== 'string' || encrypted_content.length === 0) {
      throw new CodexModelError('Compaction item missing encrypted_content.');
    }
    logger.info(
      {
        id: id ?? null,
        createdBy: created_by ?? null,
        encryptedContentBytes: Buffer.byteLength(encrypted_content, 'utf8'),
        providerKeys: Object.keys(providerData),
      },
      'Codex native compaction item received',
    );
    return {
      id,
      type: 'compaction',
      encrypted_content,
      created_by,
      providerData,
    } as unknown as AgentOutputItem;
  }
  // Unknown item — keep as-is so the SDK can decide what to do.
  return item as unknown as AgentOutputItem;
}

// ----------------------------------------------------------------------
// Aggregation helpers
// ----------------------------------------------------------------------

function assembleModelResponse(events: AnyCodexEvent[]): ModelResponse {
  const items: CodexOutputItem[] = [];
  let responseId: string | undefined;
  let completed: AnyCodexEvent | undefined;
  for (const evt of events) {
    if (evt.type === 'response.created' && evt.response?.id) {
      responseId = evt.response.id;
    } else if (evt.type === 'response.output_item.done' && evt.item) {
      items.push(evt.item);
    } else if (evt.type === 'response.completed' || evt.type === 'response.done') {
      completed = evt;
    }
  }
  // T1.4 — SSE truncation honesty. If we processed the entire event
  // stream and never saw a `response.completed` (or `response.done`),
  // the upstream connection dropped mid-response. Before this throw,
  // we returned a ModelResponse with empty usage and partial items;
  // the SDK then treated that as "the model finished cleanly with no
  // work to do" and the harness emitted an empty conversation_completed
  // — observed on the 2026-05-17 cluster of 15 sessions that died
  // with no diagnostic surface. Now we throw a structured error the
  // top-level handler can retry on (`retryable: true`) and surface
  // to the user as "Model response was cut short."
  // Same "always an output" invariant as the streamed path: a completion
  // that carried no output items is an empty completion — treat it as the
  // retryable no-content failure, not a clean (empty) ModelResponse. The
  // getResponse retry loop re-attempts it transparently (nothing yielded).
  const emptyCompletion = !!completed && items.length === 0 && retryEmptyCompletionEnabled();
  if (!completed || emptyCompletion) {
    throw new BoundaryError({
      kind: 'codex.sse_truncated',
      retryable: true,
      userMessage: "Clementine's model backend dropped the connection before finishing this turn. Retry — if it persists, the Codex backend may be having an incident.",
      operatorMessage: completed
        ? `assembleModelResponse: empty completion — response.completed carried no output items (events=${events.length}, responseId=${responseId ?? 'none'})`
        : `assembleModelResponse: SSE ended without response.completed (events=${events.length}, items=${items.length}, responseId=${responseId ?? 'none'})`,
      context: {
        eventCount: events.length,
        itemCount: items.length,
        responseId: responseId ?? null,
        lastEventType: events[events.length - 1]?.type ?? null,
        emptyCompletion,
      },
    });
  }
  return {
    output: items.map(convertCodexItemToSdkOutputItem),
    usage: extractUsage(completed),
    responseId: responseId ?? completed?.response?.id,
    providerData: completed?.response ?? {},
  };
}

function extractUsage(event: AnyCodexEvent | undefined): Usage {
  const u = event?.response?.usage ?? {};
  // The Usage constructor accepts snake_case fields. Codex's response
  // shape is already snake_case so we pass it through directly.
  return new Usage({
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    input_tokens_details: u.input_tokens_details ?? {},
    output_tokens_details: u.output_tokens_details ?? {},
  });
}

async function safeReadErrorBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 500 ? text.slice(0, 500) + '…' : text;
  } catch {
    return undefined;
  }
}
