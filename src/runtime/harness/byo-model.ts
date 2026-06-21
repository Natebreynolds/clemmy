/**
 * BYO (bring-your-own) model adapter — run worker/all-in roles on a
 * user-supplied OpenAI-compatible Chat-Completions backend (MiniMax,
 * DeepSeek, OpenRouter, or any compatible endpoint).
 *
 * The harness's Agents SDK ships `OpenAIChatCompletionsModel`, which
 * already implements the SDK `Model` interface end to end. We don't
 * reimplement it — we just point it at a custom `baseURL` + key and
 * intercept the outbound request to smooth over two incompatibilities
 * that every non-OpenAI compatible backend trips on:
 *
 *   1. Strict structured output. The harness asks for
 *      `response_format: { type: 'json_schema', strict: true }` at the
 *      judge/orchestrator/reflection sites. Compatible backends reject
 *      json_schema and 400. We downgrade to `{ type: 'json_object' }`
 *      and fold the schema into the system prompt so the model still
 *      returns conforming JSON (the Runner validates it against the
 *      original Zod schema downstream).
 *
 *   2. OpenAI-only request fields (`store`, `prompt_cache_retention`,
 *      `reasoning_effort`, `verbosity`) that compatible backends 400 on.
 *      We strip them.
 *
 * The interception point is the OpenAI client's
 * `chat.completions.create` — the exact method the SDK model calls
 * (openaiChatCompletionsModel `#fetchResponse`). Wrapping it here keeps
 * every call site and the harness loop untouched.
 */
import OpenAI from 'openai';
import { OpenAIChatCompletionsModel } from '@openai/agents-openai';
import type { Model } from '@openai/agents-core';
import type { ByoBackendConfig } from '../../config.js';
import { getRuntimeEnv } from '../../config.js';
import { repairToParseableJson, isParseableJson } from './json-repair.js';
import { withResilience } from './resilient-model.js';
import { resolveModelCapability, modelParityEnabled, restoreLegacyInstructionOrder } from './model-wire-registry.js';
import { recordModelUsage } from '../usage-log.js';
import { harnessRunContextStorage } from './brackets.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.byo-model' });

// OpenAI-only request fields many compatible backends reject with a 400.
const OPENAI_ONLY_FIELDS = ['store', 'prompt_cache_retention', 'reasoning_effort', 'verbosity'] as const;

/** Map the harness's per-turn reasoning-effort tier onto GLM (Z.ai)'s
 *  OpenAI-compatible `thinking` switch, so a GLM brain/worker actually responds
 *  to Clementine's dynamic effort instead of running at the backend default.
 *  `reasoning_effort` is otherwise stripped as an OpenAI-only field and silently
 *  lost. none/minimal → disabled (fast; don't burn the output budget on
 *  reasoning_content); low/medium/high → enabled. GATED to GLM model ids — other
 *  compat backends 400 on an unknown `thinking` param. No-op if the caller
 *  already set `thinking`, or if the harness sent no effort (leave GLM's
 *  default). Mutates `body` in place. Exported for unit tests.
 *
 *  STRUCTURED-OUTPUT OVERRIDE: when the request asks for structured output
 *  (json_schema / json_object — i.e. the orchestrator decision, judges, every
 *  contract-bound call), thinking is forced DISABLED regardless of effort.
 *  GLM extended thinking + structured output corrupt each other — the thinking
 *  stream bleeds into the answer and yields malformed JSON (the live
 *  "reply: expected string, received …" failure → repair/re-ask/degraded turn)
 *  AND adds latency to every decision. This mirrors the Claude
 *  `withThinkingDisabled` fix on the verify/judge path. Free-form turns (no
 *  structured contract) keep effort-driven thinking, where it actually helps. */
export function applyGlmThinking(body: Record<string, unknown>, effort: string | undefined): void {
  const modelId = typeof body.model === 'string' ? body.model : '';
  if (!/glm/i.test(modelId)) return;
  if (body.thinking != null) return;
  const rfType = (body.response_format as { type?: string } | undefined)?.type;
  if (rfType === 'json_schema' || rfType === 'json_object') {
    body.thinking = { type: 'disabled' }; // structured output — never think
    return;
  }
  if (!effort) return;
  body.thinking = effort === 'none' || effort === 'minimal'
    ? { type: 'disabled' }
    : { type: 'enabled' };
}

// Marks request bodies whose strict json_schema we downgraded to json_object,
// so the response interceptor only repairs OUR structured calls — never a
// tool-call turn, free-text worker output, or a pre-existing json_object
// request. WeakSet membership is not a wire field, so the body stays
// byte-identical on the network; it's GC'd with the body.
const downgradedBodies = new WeakSet<object>();

/** Relax a Chat-Completions request body for a generic OpenAI-compatible
 *  backend: strip OpenAI-only fields and downgrade strict json_schema to
 *  json_object + schema-in-prompt. Pure — returns a new object. */
export function relaxRequestForCompatBackend(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const next: Record<string, unknown> = { ...(body as Record<string, unknown>) };

  // Capture the harness's per-turn reasoning effort BEFORE stripping it, so a
  // backend with its own thinking switch (GLM) can honor it (below).
  const requestedEffort = typeof next.reasoning_effort === 'string' ? next.reasoning_effort : undefined;

  for (const field of OPENAI_ONLY_FIELDS) {
    if (field in next) delete next[field];
  }

  // GLM (Z.ai): drive its `thinking` switch from the (now-stripped) effort tier.
  applyGlmThinking(next, requestedEffort);

  // Restore legacy (dynamic-first) order in system message(s) — a BYO backend
  // never caches via breakpoints, so its wire stays BYTE-IDENTICAL to pre-parity.
  if (Array.isArray(next.messages)) {
    next.messages = (next.messages as Array<Record<string, unknown>>).map((m) =>
      m?.role === 'system' && typeof m.content === 'string'
        ? { ...m, content: restoreLegacyInstructionOrder(m.content) }
        : m,
    );
  }

  // Some compatible backends reject `strict` on function tool definitions
  // (an OpenAI structured-tools feature). Strip it — non-strict tool args
  // are fine; the harness validates downstream.
  if (Array.isArray(next.tools)) {
    next.tools = (next.tools as Array<Record<string, unknown>>).map((t) => {
      const fn = t?.function as Record<string, unknown> | undefined;
      if (fn && 'strict' in fn) {
        const { strict: _drop, ...rest } = fn;
        return { ...t, function: rest };
      }
      return t;
    });
  }

  // Reasoning models (M3) count thinking against output tokens; without a
  // generous cap a long <think> trace can truncate before the answer/tool call
  // lands. Opt-in via BYO_MAX_TOKENS (off by default — forcing a high cap can
  // 400 on backends with lower limits).
  const maxTokensRaw = getRuntimeEnv('BYO_MAX_TOKENS', '') || '';
  const maxTokens = maxTokensRaw ? Number.parseInt(maxTokensRaw, 10) : Number.NaN;
  if (Number.isFinite(maxTokens) && maxTokens > 0 && next.max_tokens == null && next.max_completion_tokens == null) {
    next.max_tokens = maxTokens;
  }

  const rf = next.response_format as { type?: string; json_schema?: { schema?: unknown } } | undefined;
  if (rf && rf.type === 'json_schema') {
    const schema = rf.json_schema?.schema;
    const instruction =
      '\n\nIMPORTANT: Respond with ONLY a single valid JSON object — no markdown fences, no prose, no explanation — that strictly conforms to this JSON Schema:\n' +
      JSON.stringify(schema);
    const messages = Array.isArray(next.messages)
      ? [...(next.messages as Array<Record<string, unknown>>)]
      : [];
    const sysIdx = messages.findIndex((m) => m?.role === 'system');
    if (sysIdx >= 0) {
      const prev = messages[sysIdx];
      messages[sysIdx] = { ...prev, content: `${(prev.content as string) ?? ''}${instruction}` };
    } else {
      messages.unshift({ role: 'system', content: instruction.trim() });
    }
    next.messages = messages;
    next.response_format = { type: 'json_object' };
    downgradedBodies.add(next);
  }

  return next;
}

// --- response-side JSON repair --------------------------------------------
// Compatible backends frequently return fenced/prose-wrapped JSON for a
// structured-output call, which then fails the SDK's downstream JSON.parse.
// We intercept the wrapped create: for OUR downgraded calls only, recover the
// JSON (strip fences / extract the balanced object) and, if still unparseable,
// re-ask once. Tool-call/empty turns are passed through untouched.

type CreateFn = (params: Record<string, unknown>, options?: unknown) => Promise<unknown>;

interface CompatCompletion {
  id?: string;
  created?: number;
  model?: string;
  usage?: unknown;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      // Interleaved-thinking backends (MiniMax M3, DeepSeek-reasoner) put the
      // reasoning trace here. `reasoning` is the field the Agents SDK reads &
      // carries forward; we lift the others into it.
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: Array<{ text?: string }>;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

type CompatMessage = NonNullable<NonNullable<CompatCompletion['choices']>[number]['message']>;

/** A message we must NOT JSON-repair: missing, a tool-call turn, or empty
 *  content (mirrors the SDK's own hasContent gate). */
function isToolOrEmpty(msg: CompatMessage | undefined): boolean {
  return !msg
    || (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)
    || msg.content == null
    || msg.content === '';
}

/** One-shot re-ask with a terse JSON-only instruction (always non-streaming).
 *  Reuses the relaxed body (schema already folded into the system message). */
async function reAskForJson(original: CreateFn, relaxed: Record<string, unknown>, options: unknown): Promise<string | null> {
  try {
    const messages = Array.isArray(relaxed.messages) ? [...(relaxed.messages as unknown[])] : [];
    messages.push({ role: 'system', content: 'Return ONLY the JSON value — no markdown fences, no prose, no explanation.' });
    const c = (await original({ ...relaxed, stream: false, stream_options: undefined, messages }, options)) as CompatCompletion;
    return c?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** Lift an interleaved-thinking model's reasoning (MiniMax M3, DeepSeek-
 *  reasoner) into `message.reasoning` — the field the Agents SDK carries
 *  forward across turns. These backends emit reasoning in `reasoning_content`
 *  / `reasoning_details`, or inline as <think>…</think> in `content`. Without
 *  this lift the SDK sees no reasoning and DROPS it between turns, so the model
 *  loses its plan/state on long tool loops (MiniMax measures −35–40% on agentic
 *  tasks — the "8 tool calls then drift" failure). Also strips a leading
 *  <think> block out of content so raw think-tags aren't fed back as content.
 *  Mutates the completion in place. */
export function liftReasoning(completion: CompatCompletion): void {
  const msg = completion?.choices?.[0]?.message;
  if (!msg) return;
  if (typeof msg.reasoning === 'string' && msg.reasoning) return; // already populated

  let reasoning: string | undefined;
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
    reasoning = msg.reasoning_content;
  } else if (Array.isArray(msg.reasoning_details)) {
    const joined = msg.reasoning_details.map((d) => (typeof d?.text === 'string' ? d.text : '')).join('');
    if (joined.trim()) reasoning = joined;
  }
  // Fallback: a leading <think>…</think> inline in content.
  if (!reasoning && typeof msg.content === 'string') {
    const m = msg.content.match(/^\s*<think\b[^>]*>([\s\S]*?)<\/think\s*>\s*/i);
    if (m) {
      reasoning = m[1];
      msg.content = msg.content.slice(m[0].length);
    }
  }
  if (reasoning) msg.reasoning = reasoning;
}

/** Repair a structured (downgraded json_object) response's content into
 *  parseable JSON, re-asking once if needed. Mutates the completion. */
async function repairStructuredContent(original: CreateFn, relaxed: Record<string, unknown>, options: unknown, completion: CompatCompletion): Promise<void> {
  const msg = completion?.choices?.[0]?.message;
  if (!msg || typeof msg.content !== 'string') return;
  let { text, repaired } = repairToParseableJson(msg.content);
  let reAsked = false;
  if (!isParseableJson(text)) {
    const reText = await reAskForJson(original, relaxed, options);
    reAsked = true;
    if (reText != null) {
      const r2 = repairToParseableJson(reText);
      if (isParseableJson(r2.text)) { text = r2.text; repaired = true; }
    }
  }
  if (repaired) msg.content = text;
  logger.debug({ repaired, reAsked, kind: 'structured' }, 'byo json repair');
}

/** Repair malformed tool-call ARGUMENTS in place (strip fences / extract the
 *  balanced JSON object) — the tool-turn analogue of repairStructuredContent.
 *  A weaker compat backend can wrap function-call args in prose/fences, which
 *  then fail the SDK's downstream JSON.parse with NO recovery (unlike structured
 *  content). Only touches args that DON'T already parse, so a healthy tool call
 *  stays byte-identical. No re-ask — a tool turn can't be cheaply re-elicited;
 *  this recovers the common wrapping case. Returns true if anything changed.
 *  Mutates the completion. Exported for unit tests. */
export function repairToolCallArguments(completion: CompatCompletion): boolean {
  const calls = completion?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return false;
  let changed = false;
  for (const tc of calls) {
    const fn = tc?.function;
    const args = fn?.arguments;
    // Skip absent / empty (no-arg call) / already-valid args.
    if (!fn || typeof args !== 'string' || args === '' || isParseableJson(args)) continue;
    const { text, repaired } = repairToParseableJson(args);
    if (repaired && isParseableJson(text)) {
      fn.arguments = text;
      changed = true;
    }
  }
  if (changed) logger.debug({ kind: 'tool_args' }, 'byo json repair');
  return changed;
}

/** Re-emit a completion as a single SDK-legal stream chunk, carrying content +
 *  reasoning so the SDK preserves the thinking trace across turns. */
async function* synthContentStream(completion: CompatCompletion): AsyncGenerator<unknown> {
  const msg = completion?.choices?.[0]?.message;
  const delta: Record<string, unknown> = { role: 'assistant', content: msg?.content ?? '' };
  if (typeof msg?.reasoning === 'string' && msg.reasoning) delta.reasoning = msg.reasoning;
  yield {
    id: completion?.id ?? 'byo-repair',
    object: 'chat.completion.chunk',
    created: completion?.created ?? 0,
    model: completion?.model ?? '',
    choices: [{ index: 0, delta, finish_reason: completion?.choices?.[0]?.finish_reason ?? 'stop', logprobs: null }],
    usage: completion?.usage,
  };
}

/** Faithfully re-emit a tool-call / empty completion as one stream chunk —
 *  preserves tool_calls AND reasoning so neither tool use nor the thinking
 *  trace is dropped on a tool turn (the critical long-loop case). */
async function* synthFaithfulStream(completion: CompatCompletion): AsyncGenerator<unknown> {
  const choice = completion?.choices?.[0];
  const msg = choice?.message ?? {};
  const delta: Record<string, unknown> = { role: 'assistant' };
  if (msg.content != null && msg.content !== '') delta.content = msg.content;
  if (typeof msg.reasoning === 'string' && msg.reasoning) delta.reasoning = msg.reasoning;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    delta.tool_calls = msg.tool_calls.map((tc, index) => ({
      index,
      id: tc.id,
      type: tc.type ?? 'function',
      function: { name: tc.function?.name, arguments: tc.function?.arguments },
    }));
  }
  yield {
    id: completion?.id ?? 'byo-repair',
    object: 'chat.completion.chunk',
    created: completion?.created ?? 0,
    model: completion?.model ?? '',
    choices: [{
      index: 0,
      delta,
      finish_reason: choice?.finish_reason ?? (delta.tool_calls ? 'tool_calls' : 'stop'),
      logprobs: null,
    }],
    usage: completion?.usage,
  };
}

/** Wrap an OpenAI-compatible `chat.completions.create`: relax the request,
 *  PRESERVE the model's reasoning across turns (critical for interleaved-
 *  thinking models like M3), and repair structured JSON. Every BYO call runs
 *  NON-streaming internally — more reliable for M3 (avoids its stream bugs) and
 *  lets us lift reasoning + repair — then re-emits one SDK-legal chunk.
 *  Exported for unit tests with an injected `original`. */
export function wrapCompletionsCreate(original: CreateFn): CreateFn {
  return async (params: Record<string, unknown>, options?: unknown) => {
    const relaxed = relaxRequestForCompatBackend(params) as Record<string, unknown>;
    const structured = downgradedBodies.has(relaxed as object);

    if (relaxed.stream === true) {
      let completion: CompatCompletion;
      try {
        completion = (await original({ ...relaxed, stream: false, stream_options: undefined }, options)) as CompatCompletion;
      } catch {
        return original(relaxed, options); // backend rejects stream:false → real (unmodified) stream
      }
      liftReasoning(completion);
      recordByoUsage(completion, relaxed.model);
      const msg = completion?.choices?.[0]?.message;
      if (isToolOrEmpty(msg)) {
        repairToolCallArguments(completion);
        return synthFaithfulStream(completion);
      }
      if (structured) await repairStructuredContent(original, relaxed, options, completion);
      return synthContentStream(completion);
    }

    const completion = (await original(relaxed, options)) as CompatCompletion;
    liftReasoning(completion);
    recordByoUsage(completion, relaxed.model);
    const msg = completion?.choices?.[0]?.message;
    if (Array.isArray(msg?.tool_calls) && msg!.tool_calls!.length > 0) {
      repairToolCallArguments(completion);
    } else if (structured && !isToolOrEmpty(msg)) {
      await repairStructuredContent(original, relaxed, options, completion);
    }
    return completion;
  };
}

/**
 * Record a BYO (GLM/DeepSeek/MiniMax/…) completion into the usage log so the
 * dashboard + efficiency readout can see token spend AND cache-hit-rate on the
 * user's actual brain. Before this, ONLY the Codex native runtime logged usage,
 * so a GLM-brain user (the common `all_in` setup) had ZERO usage visibility and
 * an unmeasurable cache-hit-rate. Chat-completions shape: prompt_tokens already
 * includes the cached subset, reported under prompt_tokens_details.cached_tokens
 * (absent on backends that don't cache → 0). Session id from the harness run
 * context. Fails silently — telemetry must never break the model call path.
 */
function recordByoUsage(completion: CompatCompletion, fallbackModel?: unknown): void {
  try {
    const u = (completion as { usage?: Record<string, unknown> })?.usage;
    if (!u || typeof u !== 'object') return;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
    // Presence check, not `||`: chat-completions (prompt/completion_tokens) and
    // Responses (input/output_tokens) are mutually-exclusive shapes, so a real
    // 0 must not fall through to the other shape's field.
    const inputTokens = 'prompt_tokens' in u ? n(u.prompt_tokens) : n(u.input_tokens);
    const outputTokens = 'completion_tokens' in u ? n(u.completion_tokens) : n(u.output_tokens);
    if (inputTokens === 0 && outputTokens === 0) return;
    const cached = n(details?.cached_tokens) || n(u.cached_tokens);
    const sessionId = harnessRunContextStorage.getStore()?.sessionId ?? 'unknown';
    recordModelUsage({
      sessionId,
      model: (completion as { model?: string })?.model || (typeof fallbackModel === 'string' ? fallbackModel : 'byo'),
      inputTokens,
      cachedInputTokens: cached,
      outputTokens,
      totalTokens: n(u.total_tokens) || inputTokens + outputTokens,
    });
  } catch { /* never break the call path */ }
}

const clientCache = new Map<string, OpenAI>();
const modelCache = new Map<string, Model>();

function clientKey(byo: ByoBackendConfig): string {
  return `${byo.baseURL}::${byo.apiKey.slice(-8)}`;
}

function makeWrappedClient(byo: ByoBackendConfig): OpenAI {
  // When the parity resilience wrapper owns retry/backoff, disable the OpenAI
  // client's own 2 retries so they don't STACK (otherwise a persistently-down
  // backend makes ~(1+3)×(1+2) attempts with two backoff schedules). Parity off
  // keeps the SDK default (2) — byte-identical legacy behavior.
  const client = new OpenAI({
    baseURL: byo.baseURL,
    apiKey: byo.apiKey,
    ...(modelParityEnabled() ? { maxRetries: 0 } : {}),
  });
  const completions = client.chat.completions;
  const original = completions.create.bind(completions) as unknown as CreateFn;
  // Shadow the prototype method on this instance: relax the request + repair
  // structured JSON responses. The SDK calls client.chat.completions.create.
  (completions as unknown as { create: CreateFn }).create = wrapCompletionsCreate(original);
  return client;
}

/** Get (memoized) a `Model` for `modelId` on the BYO backend. */
export function getByoModel(modelId: string, byo: ByoBackendConfig): Model {
  const ckey = clientKey(byo);
  const mkey = `${ckey}::${modelId}`;
  const cachedModel = modelCache.get(mkey);
  if (cachedModel) return cachedModel;

  let client = clientCache.get(ckey);
  if (!client) {
    client = makeWrappedClient(byo);
    clientCache.set(ckey, client);
    logger.info({ baseURL: byo.baseURL, provider: byo.providerLabel || 'custom' }, 'BYO model backend initialized');
  }

  let model: Model = new OpenAIChatCompletionsModel(client as unknown as ConstructorParameters<typeof OpenAIChatCompletionsModel>[0], modelId);
  // Parity layer: the same provider-agnostic resilience the Claude path gets —
  // transparent retry on transient 429/5xx/transport blips + empty-completion
  // invariant. (BYO already lifts reasoning + repairs JSON at the client layer;
  // the wrapper adds only the model-boundary resilience.)
  if (modelParityEnabled()) {
    model = withResilience(model, { label: 'byo', capability: resolveModelCapability(modelId) });
  }
  modelCache.set(mkey, model);
  return model;
}

/** Test/debug helper — drop cached clients/models (e.g. after a key change). */
export function resetByoModelCache(): void {
  clientCache.clear();
  modelCache.clear();
}
