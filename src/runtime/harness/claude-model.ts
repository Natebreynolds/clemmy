/**
 * ClaudeModelProvider — runs Claude (Anthropic) as a flagship brain on the
 * user's Claude Max/Pro SUBSCRIPTION via OAuth, peer to CodexModelProvider.
 *
 * Default transport: Claude Code headless print mode (`claude -p`) via
 * claude-headless-model.ts. Live verification showed this is the path that
 * draws from the user's Claude subscription quota. The raw Anthropic Messages
 * adapter below is retained only as `CLEMMY_CLAUDE_TRANSPORT=raw_messages` for
 * diagnostics/rollback; it can authenticate with an oat01 token, but it did not
 * behave like the official Claude Code / Agent SDK subscription runner.
 *
 * RAW-MESSAGES BILLING GUARD ("subscription-or-stop", fail closed):
 *   - Every request resolves a fresh `oat01` SUBSCRIPTION token via the auth
 *     wallet, which THROWS unless it's an oat01 (an api03 API key is refused).
 *   - The fetch DELETES any `x-api-key` header (so a stray ANTHROPIC_API_KEY in
 *     the provider/env can never produce a pay-per-token API bill) and sends
 *     ONLY `Authorization: Bearer <oat>`. There is no code path here that bills
 *     the API.
 */
import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { createAnthropic } from '@ai-sdk/anthropic';
import { Agent } from 'undici';
import type { Model, ModelProvider, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { loadFreshClaudeAccessToken } from '../claude-oauth.js';
import { getClaudeBrainModel, getRuntimeEnv } from '../../config.js';
import { withResilience } from './resilient-model.js';
import { withModelFallback, type FallbackTarget } from './fallback-model.js';
import { CodexModelProvider } from './codex-model.js';
import { getStoredCodexOAuthTokens } from '../auth-store.js';
import { resolveModelCapability, estimateTokens, modelParityEnabled, restoreLegacyInstructionOrder, CACHE_BREAK_SENTINEL, type ModelCapability } from './model-wire-registry.js';
import { claudeSubscriptionTransport, claudeHeadlessCliAvailable, getClaudeHeadlessModel, resetClaudeHeadlessModelCache } from './claude-headless-model.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.claude-model' });

// Bounded socket timeouts for the Claude fetch (G6) — mirrors codexDispatcher.
// Headers 30s (generous: effort/thinking happens AFTER headers, during the SSE
// ping stream); body 120s (max gap between SSE events, not total turn time).
const CLAUDE_HEADERS_TIMEOUT_MS = 30_000;
const CLAUDE_BODY_TIMEOUT_MS = 120_000;
let claudeDispatcher: Agent | null = null;
function getClaudeDispatcher(): Agent {
  if (!claudeDispatcher) {
    claudeDispatcher = new Agent({ headersTimeout: CLAUDE_HEADERS_TIMEOUT_MS, bodyTimeout: CLAUDE_BODY_TIMEOUT_MS });
  }
  return claudeDispatcher;
}

// The first system block must establish the Claude-Code identity for the
// subscription OAuth token to be honored (verified live: the identity prefix is
// the load-bearing element, not the beta header).
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const ENVELOPE_BETA = 'oauth-2025-04-20,claude-code-20250219';
const CLAUDE_USER_AGENT = 'claude-cli/1.0.0 (external, clementine)';
// Anthropic Messages REQUIRES max_tokens. The AI SDK passes the harness's
// maxTokens through, but we defensively fill a generous default if a turn ever
// omits it, so a Claude call can never 400 on a missing max_tokens.
const CLAUDE_DEFAULT_MAX_TOKENS = 16384;

// Cache the validated subscription token briefly so we don't shell out to the
// keychain on every request. The billing guard (oat01-only) runs on each
// (re)read; the token itself is long-lived (~10h).
const TOKEN_TTL_MS = 60_000;
let cachedToken: { value: string; readAt: number } | null = null;
async function freshClaudeToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now - cachedToken.readAt < TOKEN_TTL_MS) return cachedToken.value;
  const value = await loadFreshClaudeAccessToken(); // refreshes-if-needed; throws (fail-closed) unless oat01 + valid
  cachedToken = { value, readAt: now };
  return value;
}

/** Prepend the Claude-Code identity to the request's `system` (string or block
 *  array), without duplicating it. */
export function withIdentityPrefix(system: unknown): unknown {
  const id = { type: 'text', text: CLAUDE_CODE_IDENTITY };
  if (system == null || system === '') return [id];
  if (typeof system === 'string') {
    return system.startsWith(CLAUDE_CODE_IDENTITY) ? system : [id, { type: 'text', text: system }];
  }
  if (Array.isArray(system)) {
    const first = system[0] as { text?: unknown } | undefined;
    if (first && typeof first.text === 'string' && first.text.startsWith(CLAUDE_CODE_IDENTITY)) return system;
    return [id, ...system];
  }
  return system;
}

/** Pure billing-guard + envelope transform (unit-testable without the network
 *  or keychain). Strips x-api-key, sets the OAuth Bearer + identity envelope,
 *  and injects the Claude-Code identity into the request body's `system`. */
export function applyClaudeEnvelope(
  init: { headers?: HeadersInit; body?: BodyInit | null } | undefined,
  token: string,
): { headers: Headers; body: BodyInit | null | undefined } {
  const headers = new Headers(init?.headers);
  headers.delete('x-api-key'); // BILLING GUARD — never API-bill
  headers.set('authorization', `Bearer ${token}`);
  headers.set('anthropic-version', '2023-06-01');
  const existingBeta = headers.get('anthropic-beta');
  headers.set('anthropic-beta', existingBeta ? `${ENVELOPE_BETA},${existingBeta}` : ENVELOPE_BETA);
  headers.set('user-agent', CLAUDE_USER_AGENT);

  let body = init?.body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (modelParityEnabled()) {
        // Parity path: identity-first system blocks + a cache_control breakpoint
        // on the stable prefix (G3), gated by the model's cacheMinTokens.
        const cap = resolveModelCapability(typeof parsed.model === 'string' ? parsed.model : '');
        applyClaudeCaching(parsed, cap);
      } else {
        // Legacy path. Defensively restore legacy order / strip any stray
        // sentinel first — handling BOTH a string system AND the real
        // array-of-text-blocks shape the AI SDK actually emits — so a flag-flip
        // between assembly and wire can never leak the marker to the Anthropic
        // API (which would 400 / pollute the prompt).
        parsed.system = withIdentityPrefix(restoreLegacySystem(parsed.system));
      }
      // Correctness (all models, independent of parity): Anthropic accepts a
      // system prompt ONLY via the top-level `system` field — a role:'system'
      // message inside `messages` is rejected by every Claude model EXCEPT Opus
      // (verified: Opus 4.8 -> 200, Sonnet 4.6 -> 400 "role 'system' is not
      // supported on this model"). The harness appends role:'system' directives
      // to the turn input (valid for Codex/OpenAI), so hoist them into the system
      // blocks here so the request is valid on EVERY Claude model, not just Opus.
      hoistSystemMessagesIntoSystem(parsed);
      if (parsed.max_tokens == null) parsed.max_tokens = CLAUDE_DEFAULT_MAX_TOKENS;
      body = JSON.stringify(parsed);
    } catch {
      // non-JSON body (shouldn't happen for Messages) — leave as-is
    }
  }
  return { headers, body };
}

/** Best-effort plain text from an Anthropic message `content` (string or an
 *  array of text/content blocks). */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const p = c as { text?: unknown };
        return typeof p?.text === 'string' ? p.text : '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * Move any `role:'system'` message out of `messages` and into the top-level
 * `system` blocks (Anthropic's only valid place for a system prompt). The
 * harness appends role:'system' directives to the turn input for the next model
 * turn (a Codex/OpenAI-valid pattern); on the Anthropic wire those are invalid
 * on every model but Opus. Mutates `parsed` in place; a no-op when there are no
 * system messages.
 */
export function hoistSystemMessagesIntoSystem(parsed: Record<string, unknown>): void {
  const messages = Array.isArray(parsed.messages) ? (parsed.messages as Array<Record<string, unknown>>) : null;
  if (!messages || messages.length === 0) return;
  const hoisted: string[] = [];
  const kept: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m && m.role === 'system') {
      const text = extractMessageText(m.content);
      if (text) hoisted.push(text);
    } else {
      kept.push(m);
    }
  }
  if (hoisted.length === 0) return;
  const sys: Array<Record<string, unknown>> = Array.isArray(parsed.system)
    ? (parsed.system as Array<Record<string, unknown>>)
    : typeof parsed.system === 'string' && parsed.system
      ? [{ type: 'text', text: parsed.system }]
      : [];
  for (const text of hoisted) sys.push({ type: 'text', text });
  parsed.system = sys;
  parsed.messages = kept;
}

/** Restore legacy instruction order / strip the cache-break sentinel from a
 *  `system` value of EITHER shape the AI SDK can hand us — a plain string or the
 *  array-of-text-blocks shape `@ai-sdk/anthropic` actually emits. Used on the
 *  parity-off path so a stray sentinel never reaches the Anthropic wire. */
export function restoreLegacySystem(system: unknown): unknown {
  if (typeof system === 'string') return restoreLegacyInstructionOrder(system);
  if (Array.isArray(system)) {
    return system.map((b) => {
      const t = (b as { text?: unknown })?.text;
      return typeof t === 'string' ? { ...(b as object), text: restoreLegacyInstructionOrder(t) } : b;
    });
  }
  return system;
}

/** Normalize the AI SDK's `system` (string or text-block array) to a single
 *  string we can split at the stable/dynamic boundary. NOTE: the harness emits
 *  exactly ONE system message, so the production array has a single block; the
 *  '\n' join is only a defensive fallback for a hypothetical multi-block input. */
function normalizeSystemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => {
        const t = (b as { text?: unknown })?.text;
        return typeof t === 'string' ? t : '';
      })
      .join('\n');
  }
  return '';
}

/**
 * Build the Anthropic `system` as text blocks: [identity, stable(+cache_control?),
 * dynamic]. The identity block MUST stay index 0 (the subscription OAuth token is
 * only honored when the Claude-Code identity leads). When the harness emitted the
 * CACHE_BREAK_SENTINEL (parity reorder on), everything before it is the STABLE
 * prefix and gets the cache breakpoint; everything after is per-turn dynamic and
 * stays uncached. No sentinel → the whole prompt is treated as dynamic (no system
 * cache) and the caller caches tools instead.
 */
export function buildClaudeSystemBlocks(
  system: unknown,
  cap: ModelCapability,
  cachingOn: boolean,
  toolsTokens = 0,
): { blocks: Array<Record<string, unknown>>; systemCached: boolean } {
  let raw = normalizeSystemText(system);
  if (raw.startsWith(CLAUDE_CODE_IDENTITY)) {
    raw = raw.slice(CLAUDE_CODE_IDENTITY.length).replace(/^\s+/, '');
  }
  const sentIdx = raw.indexOf(CACHE_BREAK_SENTINEL);
  const stripAll = (s: string): string => s.split(CACHE_BREAK_SENTINEL).join('').trim();
  const stable = stripAll(sentIdx >= 0 ? raw.slice(0, sentIdx) : raw);
  const dynamic = stripAll(sentIdx >= 0 ? raw.slice(sentIdx + CACHE_BREAK_SENTINEL.length) : '');

  const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }];
  let systemCached = false;
  // Anthropic 400s on an EMPTY text content block, so only emit the stable block
  // when it has content (identity-only is a valid system, matching legacy
  // withIdentityPrefix('')). Reachable with an empty/whitespace system or a
  // sentinel-led prompt whose stable prefix is empty.
  if (stable) {
    const stableBlock: Record<string, unknown> = { type: 'text', text: stable };
    // A breakpoint on the stable system block caches the WHOLE prefix up to it
    // (tools + identity + stable, per Anthropic's tools->system->messages
    // hierarchy), so the min-size gate counts the tools tokens that share the
    // cached prefix — not just identity+stable.
    if (
      cachingOn && cap.supportsPromptCache && sentIdx >= 0
      && estimateTokens(CLAUDE_CODE_IDENTITY + stable) + toolsTokens >= cap.cacheMinTokens
    ) {
      stableBlock.cache_control = { type: 'ephemeral' };
      systemCached = true;
    }
    blocks.push(stableBlock);
  }
  if (dynamic) blocks.push({ type: 'text', text: dynamic });
  return { blocks, systemCached };
}

/** Cache the shared conversation transcript (`messages`) too, not just system+tools.
 *  The system/tools breakpoints cache the prefix UP TO messages; the transcript
 *  itself (which all fusion sub-calls — draft A, draft B, judge — re-send identically
 *  within a turn, and which the next turn re-sends as a growing prefix) was billed
 *  fresh every call. Breakpointing the last transcript message lets draft B + the
 *  judge read draft A's cached transcript and the next turn read this turn's — the
 *  fix for the fusion re-send (the sonnet-5 ~362K/turn aggregate). */
/** Put a cache breakpoint on the last content block of a message. String content is
 *  wrapped into a single cacheable text block (valid Anthropic shape); a block array
 *  gets the breakpoint on its last object block. No-op on an unexpected shape. */
function breakpointLastMessage(msg: Record<string, unknown>): void {
  const content = msg.content;
  if (typeof content === 'string') {
    msg.content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1];
    if (last && typeof last === 'object') (last as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  }
}

/** Mutate the request body in place: identity-first cached system blocks; a cache
 *  breakpoint on the (stable) tools array when the system prefix wasn't cached (no
 *  sentinel / empty stable, e.g. a sub-agent prompt); and — additively — a
 *  breakpoint on the transcript so the shared conversation caches (Gap #1). */
function applyClaudeCaching(parsed: Record<string, unknown>, cap: ModelCapability): void {
  const tools = Array.isArray(parsed.tools) ? (parsed.tools as Array<Record<string, unknown>>) : [];
  const toolsTokens = tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0;
  const { blocks, systemCached } = buildClaudeSystemBlocks(parsed.system, cap, true, toolsTokens);
  parsed.system = blocks;
  // breakpoint tally — Anthropic allows at most 4 cache_control markers per request.
  let breakpoints = systemCached ? 1 : 0;
  if (!systemCached && cap.supportsPromptCache && tools.length > 0 && toolsTokens >= cap.cacheMinTokens) {
    const last = tools[tools.length - 1];
    if (last && typeof last === 'object') { last.cache_control = { type: 'ephemeral' }; breakpoints += 1; }
  }
  // Gap #1 — transcript caching. Only when it's big enough to be worth a breakpoint
  // and we have budget. Caches tools+system+transcript-so-far; the next turn / the
  // sibling fusion sub-calls read it instead of re-billing.
  if (cap.supportsPromptCache && breakpoints < 4) {
    const messages = Array.isArray(parsed.messages) ? (parsed.messages as Array<Record<string, unknown>>) : [];
    if (messages.length > 0 && estimateTokens(JSON.stringify(messages)) >= cap.cacheMinTokens) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && typeof lastMsg === 'object') breakpointLastMessage(lastMsg);
    }
  }
}

/** Opt-in wire diagnostics (off by default). `CLEMMY_CLAUDE_WIRE_DEBUG=1` logs
 *  the outbound request shape + the response's cache-usage to supervisor.log so a
 *  live smoke can confirm: effort on the wire, cache breakpoints present, the
 *  sentinel never leaks, and `cacheReadInputTokens > 0` on a repeat turn. */
export function claudeWireDebugEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_CLAUDE_WIRE_DEBUG', '') || '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

/** Log the cache/effort/sentinel shape of the outbound Claude request. Best-effort. */
export function logClaudeRequestShape(body: BodyInit | null | undefined): void {
  try {
    if (typeof body !== 'string') return;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const sys = Array.isArray(parsed.system) ? (parsed.system as Array<Record<string, unknown>>) : [];
    const tools = Array.isArray(parsed.tools) ? (parsed.tools as Array<Record<string, unknown>>) : [];
    const sysBreakpoints = sys.filter((b) => b?.cache_control).length;
    const toolBreakpoints = tools.filter((t) => t?.cache_control).length;
    const outputConfig = parsed.output_config as { effort?: unknown } | undefined;
    const msgs = Array.isArray(parsed.messages) ? (parsed.messages as Array<Record<string, unknown>>) : [];
    const roles = msgs.map((m) => String(m?.role ?? '?'));
    const systemRoleIdxs = roles.map((r, i) => (r === 'system' ? i : -1)).filter((i) => i >= 0);
    logger.info(
      {
        kind: 'claude_wire_request',
        model: parsed.model,
        systemBlocks: sys.length,
        cacheBreakpoints: sysBreakpoints + toolBreakpoints,
        systemCached: sysBreakpoints > 0,
        toolsCached: toolBreakpoints > 0,
        effort: outputConfig?.effort ?? null,
        sentinelLeaked: body.includes(CACHE_BREAK_SENTINEL),
        messageCount: msgs.length,
        roles: roles.join(','),
        systemRoleInMessages: systemRoleIdxs,
      },
      '[claude-wire] outbound request shape',
    );
  } catch {
    // best-effort diagnostics — never affect the request
  }
}

/** Scan the SSE response for the message_start usage (which carries Anthropic's
 *  cache token counts) and log it. Reads a TEE'd copy — never touches the stream
 *  the SDK consumes. Best-effort, bounded, never throws. */
export async function logClaudeResponseUsage(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const marker = buf.indexOf('"type":"message_start"');
      if (marker >= 0) {
        const lineStart = buf.lastIndexOf('data:', marker);
        const lineEnd = buf.indexOf('\n', marker);
        if (lineStart >= 0 && lineEnd > lineStart) {
          try {
            const evt = JSON.parse(buf.slice(lineStart + 5, lineEnd).trim()) as { message?: { usage?: Record<string, unknown> } };
            const u = evt.message?.usage ?? {};
            logger.info(
              {
                kind: 'claude_wire_usage',
                inputTokens: u.input_tokens ?? null,
                cacheCreationInputTokens: u.cache_creation_input_tokens ?? null,
                cacheReadInputTokens: u.cache_read_input_tokens ?? null,
                outputTokens: u.output_tokens ?? null,
              },
              '[claude-wire] response usage — cache HIT when cacheReadInputTokens > 0',
            );
          } catch { /* keep reading until a parseable message_start */ }
          break;
        }
      }
      if (buf.length > 65_536) buf = buf.slice(-8_192); // bound memory
    }
    try { await reader.cancel(); } catch { /* ignore */ }
  } catch {
    // best-effort — a diagnostics failure must never affect the turn
  }
}

/** Custom fetch enforcing the OAuth billing guarantee + identity envelope, plus
 *  (parity-on) a bounded undici dispatcher so a stalled edge can't hang a turn. */
export function makeClaudeFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const token = await freshClaudeToken();
    const { headers, body } = applyClaudeEnvelope(init, token);
    const dispatcher = modelParityEnabled() ? getClaudeDispatcher() : undefined;
    const debug = claudeWireDebugEnabled();
    if (debug) logClaudeRequestShape(body);
    const res = await fetch(input, {
      ...init,
      headers,
      body,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: unknown });
    // ALWAYS persist an error trace (request body + response) to disk on ANY
    // non-2xx — 4xx (malformed: system placement / effort / cache_control), 429
    // (YOUR usage quota: rate_limit_error), 529 (ANTHROPIC capacity:
    // overloaded_error — "not your usage limit"), and 5xx. The Codex path traces;
    // the Claude path didn't. This makes "was it us or Anthropic?" answerable
    // from disk (the body names the error type). Best-effort; reads a clone so
    // the SDK still gets the original error body.
    if (res.status >= 400) {
      void persistClaudeErrorTrace(res.clone(), body, res.status);
    }
    // Diagnostics only: tee the body so we can read usage without disturbing the
    // stream the SDK consumes. Entirely skipped when the debug flag is off.
    if (debug && res.ok && res.body) {
      try {
        const [forSdk, forLog] = res.body.tee();
        void logClaudeResponseUsage(forLog);
        return new Response(forSdk, { status: res.status, statusText: res.statusText, headers: res.headers });
      } catch {
        return res; // tee failed before locking → return the original untouched
      }
    }
    return res;
  }) as typeof fetch;
}

/** Classify an Anthropic non-2xx so "was it us or Anthropic?" is one glance:
 *  429 rate_limit_error = YOUR quota; 529 overloaded_error = ANTHROPIC capacity
 *  (not your usage limit); 4xx = malformed request (our bug); 5xx = backend. */
function classifyClaudeHttpCause(status: number, body: string): string {
  if (status === 429) return 'rate_limited (YOUR usage/rate quota)';
  if (status === 529) return 'overloaded (ANTHROPIC capacity — not your usage limit)';
  if (/overloaded_error/.test(body)) return 'overloaded (ANTHROPIC capacity)';
  if (/rate_limit_error/.test(body)) return 'rate_limited (YOUR usage/rate quota)';
  if (status >= 500) return 'backend 5xx (ANTHROPIC server)';
  if (status >= 400) return 'invalid_request (malformed by us)';
  return 'unknown';
}

/** Persist a Claude error (request body + response) to BASE_DIR/state/
 *  claude-error-trace on ANY non-2xx, with the cause classified, so a rejection
 *  (malformed), a 429 (your quota) or a 529 (Anthropic overload) is diagnosable
 *  from disk. Mirrors the Codex trace pattern. Best-effort — never throws. */
async function persistClaudeErrorTrace(res: Response, requestBody: BodyInit | null | undefined, status: number): Promise<void> {
  try {
    const detail = await res.text().catch(() => '');
    const cause = classifyClaudeHttpCause(status, detail);
    const { atomicJsonMutate } = await import('../atomic-json.js');
    const path = await import('node:path');
    const { BASE_DIR } = await import('../../config.js');
    let reqParsed: unknown;
    let model: unknown;
    if (typeof requestBody === 'string') {
      try { reqParsed = JSON.parse(requestBody); model = (reqParsed as { model?: unknown } | null)?.model; } catch { /* keep raw */ }
    }
    const tracePath = path.join(BASE_DIR, 'state', 'claude-error-trace', `claude-${status}-${Date.now()}.json`);
    await atomicJsonMutate(
      tracePath,
      () => ({
        ts: new Date().toISOString(),
        source: 'claude-model',
        status,
        cause,
        retryAfter: res.headers.get('retry-after'),
        model: model ?? null,
        responseBody: detail.slice(0, 4096),
        // request body only kept for a 4xx (malformed-by-us) — a 429/529 isn't
        // about our request, so don't bloat the trace with it.
        requestBody: status >= 400 && status < 500 ? (reqParsed ?? requestBody ?? null) : undefined,
      }),
      {} as Record<string, unknown>,
    );
    logger.warn({ status, cause, model: model ?? null, retryAfter: res.headers.get('retry-after'), tracePath, responsePreview: detail.slice(0, 240) }, '[claude-wire] error — trace persisted');
  } catch {
    // best-effort: a trace-write failure must never affect the request path
  }
}

/** Drop the cached subscription token so the next request re-reads (and
 *  refreshes) it — the 401 refresh-and-retry hook for the resilience wrapper. */
export function invalidateClaudeToken(): void {
  cachedToken = null;
}

async function refreshClaudeAuth(): Promise<void> {
  invalidateClaudeToken();
  try {
    await loadFreshClaudeAccessToken();
  } catch {
    // best-effort — a refresh failure surfaces on the retried request itself
  }
}

// One provider instance for the process; the custom fetch resolves a fresh
// token per request. The apiKey placeholder is required by the lib but never
// reaches Anthropic (the fetch deletes x-api-key).
let provider: ReturnType<typeof createAnthropic> | null = null;
function getProvider(): ReturnType<typeof createAnthropic> {
  if (!provider) {
    provider = createAnthropic({ apiKey: 'clementine-oauth-no-api-key', fetch: makeClaudeFetch() });
    logger.info('Claude subscription brain initialized (OAuth, no x-api-key)');
  }
  return provider;
}

/** Does the aisdk Anthropic adapter accept this `reasoning` item, or will it
 *  throw `UserError: Unknown item type: reasoning`? The adapter
 *  (@openai/agents-extensions/ai-sdk) only handles a reasoning item whose
 *  `content[0].text` is a string; anything else falls through to its
 *  `throw new UserError('Unknown item type: reasoning')`. */
export function aisdkAcceptsReasoning(item: { content?: unknown }): boolean {
  const content = item?.content;
  return Array.isArray(content) && content.length > 0 && typeof (content[0] as { text?: unknown })?.text === 'string';
}

/** Strip the cross-model items the aisdk Anthropic adapter cannot serialize.
 *
 *  Why this exists (live failure): Codex emits `reasoning` items with an EMPTY
 *  `content` array — the actual trace lives in encrypted providerData scoped to
 *  the OpenAI provider. When a Claude brain CONSUMES input produced by Codex, the
 *  adapter hits that empty-content reasoning item and throws `Unknown item type:
 *  reasoning`, crashing the whole turn. This happens on every Codex->Claude
 *  boundary: the fusion judge/checker (executor=Codex, checker=Claude) and the
 *  overload fallback (Codex draft -> Claude). Fixing it at the Claude model
 *  boundary covers ALL of those paths (the general class), not one call site.
 *
 *  We drop ONLY the reasoning items the adapter would reject. Well-formed
 *  reasoning (string text — e.g. Claude's own extended-thinking blocks carrying
 *  signatures the Anthropic API needs echoed back) is preserved, so thinking
 *  continuity is never broken. Reasoning is intermediate scratch; the user-facing
 *  answer and the harness's `role:system` context packet (focus/memory/goal) are
 *  untouched — only an array input is filtered, a string input is passed through. */
export function sanitizeClaudeInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  let dropped = 0;
  const out = input.filter((it) => {
    const item = it as { type?: string; content?: unknown };
    if (item?.type === 'reasoning' && !aisdkAcceptsReasoning(item)) { dropped += 1; return false; }
    return true;
  });
  if (dropped > 0) logger.debug({ dropped }, 'sanitized cross-model reasoning items the Anthropic adapter cannot serialize');
  return dropped > 0 ? out : input;
}

/** Innermost Claude-model decorator: sanitize request.input before it reaches the
 *  aisdk adapter, so a Codex-shaped reasoning item can never crash a Claude turn.
 *  Wraps the bare adapter so retries (withResilience) see sanitized input too. */
class ClaudeInputSanitizingModel implements Model {
  constructor(private readonly inner: Model) {}
  getResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.inner.getResponse({ ...request, input: sanitizeClaudeInput((request as { input?: unknown }).input) } as ModelRequest);
  }
  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    return this.inner.getStreamedResponse({ ...request, input: sanitizeClaudeInput((request as { input?: unknown }).input) } as ModelRequest);
  }
}

export function withClaudeInputSanitizer(inner: Model): Model {
  return new ClaudeInputSanitizingModel(inner);
}

const modelCache = new Map<string, Model>();
export function getClaudeModel(modelId: string): Model {
  const cached = modelCache.get(modelId);
  if (cached) return cached;
  if (claudeSubscriptionTransport() === 'headless') {
    if (claudeHeadlessCliAvailable()) {
      const model = getClaudeHeadlessModel(modelId);
      modelCache.set(modelId, model);
      return model;
    }
    // Headless was selected but the `claude` CLI isn't on PATH. Rather than
    // fail every Claude-brain turn with an unrecoverable spawn ENOENT, fall
    // through to the raw Messages adapter below — it serves the SAME oat01
    // subscription token, so billing + behavior stay correct.
    logger.warn('Claude headless transport selected but `claude` CLI not found on PATH — falling back to raw_messages adapter (same subscription token).');
  }
  // Sanitize cross-model input FIRST (innermost), so a Codex-shaped reasoning
  // item can't crash the aisdk adapter — on the primary call OR any retry.
  let model: Model = withClaudeInputSanitizer(aisdk(getProvider()(modelId)));
  // Parity layer: provider-agnostic resilience (retry/empty/401) + reasoning
  // translation (effort -> output_config.effort). Wrap BEFORE caching so the
  // cache hands back the resilient model, not the bare passthrough.
  if (modelParityEnabled()) {
    model = withResilience(model, {
      label: 'claude',
      capability: resolveModelCapability(modelId),
      refreshAuth: refreshClaudeAuth,
    });
  }
  modelCache.set(modelId, model);
  return model;
}

/** Whether the Claude model used by the standard Agents harness can execute
 * native Clementine tools. Claude Code print mode is deliberately text-only;
 * the raw Messages adapter remains tool-capable. */
export function claudeHarnessModelSupportsTools(): boolean {
  return claudeSubscriptionTransport() !== 'headless' || !claudeHeadlessCliAvailable();
}

function isClaudeModelId(id: string | undefined): boolean {
  return Boolean(id && /claude|opus|sonnet|haiku/i.test(id));
}

/** Optional overload-fallback (Opus -> Sonnet -> Codex-if-installed) on a 529.
 *  Default off: the universal router owns provider changes when explicitly
 *  enabled, avoiding nested retry/fallback chains. */
export function overloadFallbackEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((getRuntimeEnv('CLEMMY_CLAUDE_OVERLOAD_FALLBACK', 'off') || 'off').trim());
}

const SONNET_FALLBACK_ID = 'claude-sonnet-4-6';

/** A Codex fallback target — ONLY if a Codex login exists (different provider, so
 *  it survives an Anthropic-wide overload). null when Codex isn't installed. */
function codexFallbackTarget(): FallbackTarget | null {
  try {
    if (!getStoredCodexOAuthTokens()?.accessToken) return null;
    return { label: 'codex', getModel: () => new CodexModelProvider().getModel() };
  } catch {
    return null;
  }
}

export class ClaudeModelProvider implements ModelProvider {
  getModel(modelName?: string): Model {
    // A claude-* id is used verbatim; any other id (e.g. a gpt-5* tier name) maps
    // to the configured Claude brain model so the whole harness runs on Claude.
    const id = isClaudeModelId(modelName) ? (modelName as string) : getClaudeBrainModel();
    const primary = getClaudeModel(id);
    if (!overloadFallbackEnabled()) return primary;
    // Overload chain: primary -> Sonnet (unless already Sonnet) -> Codex (if any).
    const chain: FallbackTarget[] = [{ label: id, getModel: () => primary }];
    if (id !== SONNET_FALLBACK_ID) {
      chain.push({ label: SONNET_FALLBACK_ID, getModel: () => getClaudeModel(SONNET_FALLBACK_ID) });
    }
    const codex = codexFallbackTarget();
    if (codex) chain.push(codex);
    return withModelFallback(chain);
  }
}

/** Test/debug — clear the token + model caches (e.g. after re-auth). */
export function resetClaudeModelCache(): void {
  cachedToken = null;
  modelCache.clear();
  resetClaudeHeadlessModelCache();
  provider = null;
}
