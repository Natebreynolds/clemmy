/**
 * ClaudeModelProvider — runs Claude (Anthropic) as a flagship brain on the
 * user's Claude Max/Pro SUBSCRIPTION via OAuth, peer to CodexModelProvider.
 *
 * Why this shape (for reviewers): the scope considered a fully hand-rolled
 * Messages adapter (mirroring CodexResponsesModel). The reason it preferred
 * native — keeping the OAuth Bearer instead of an x-api-key — is satisfied here
 * by a custom `fetch` that we fully control. With that resolved, we use the
 * maintained `@openai/agents-extensions/ai-sdk` adapter over `@ai-sdk/anthropic`
 * to get correct Messages streaming + tool-use + extended-thinking translation
 * into the SDK `Model` interface, instead of re-deriving ~1000 lines of SSE /
 * StreamEvent plumbing. The Claude-specific work that actually matters — the
 * subscription-OAuth billing guarantee and the Claude-Code identity envelope —
 * lives entirely in `makeClaudeFetch` below.
 *
 * BILLING GUARANTEE ("subscription-or-stop", fail closed):
 *   - Every request resolves a fresh `oat01` SUBSCRIPTION token via the auth
 *     wallet, which THROWS unless it's an oat01 (an api03 API key is refused).
 *   - The fetch DELETES any `x-api-key` header (so a stray ANTHROPIC_API_KEY in
 *     the provider/env can never produce a pay-per-token API bill) and sends
 *     ONLY `Authorization: Bearer <oat>`. There is no code path here that bills
 *     the API.
 */
import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { Model, ModelProvider } from '@openai/agents-core';
import { loadClaudeAccessToken } from '../claude-oauth.js';
import { getClaudeBrainModel } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.claude-model' });

// The first system block must establish the Claude-Code identity for the
// subscription OAuth token to be honored (verified live: the identity prefix is
// the load-bearing element, not the beta header).
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const ENVELOPE_BETA = 'oauth-2025-04-20,claude-code-20250219';
const CLAUDE_USER_AGENT = 'claude-cli/1.0.0 (external, clementine)';

// Cache the validated subscription token briefly so we don't shell out to the
// keychain on every request. The billing guard (oat01-only) runs on each
// (re)read; the token itself is long-lived (~10h).
const TOKEN_TTL_MS = 5 * 60_000;
let cachedToken: { value: string; readAt: number } | null = null;
function freshClaudeToken(): string {
  const now = Date.now();
  if (cachedToken && now - cachedToken.readAt < TOKEN_TTL_MS) return cachedToken.value;
  const value = loadClaudeAccessToken(); // throws (fail-closed) unless oat01 + valid
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
      parsed.system = withIdentityPrefix(parsed.system);
      body = JSON.stringify(parsed);
    } catch {
      // non-JSON body (shouldn't happen for Messages) — leave as-is
    }
  }
  return { headers, body };
}

/** Custom fetch enforcing the OAuth billing guarantee + identity envelope. */
export function makeClaudeFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const token = freshClaudeToken();
    const { headers, body } = applyClaudeEnvelope(init, token);
    return fetch(input, { ...init, headers, body });
  }) as typeof fetch;
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

const modelCache = new Map<string, Model>();
export function getClaudeModel(modelId: string): Model {
  const cached = modelCache.get(modelId);
  if (cached) return cached;
  const model = aisdk(getProvider()(modelId));
  modelCache.set(modelId, model);
  return model;
}

function isClaudeModelId(id: string | undefined): boolean {
  return Boolean(id && /claude|opus|sonnet|haiku/i.test(id));
}

export class ClaudeModelProvider implements ModelProvider {
  getModel(modelName?: string): Model {
    // A claude-* id is used verbatim; any other id (e.g. a gpt-5* tier name) maps
    // to the configured Claude brain model so the whole harness runs on Claude.
    const id = isClaudeModelId(modelName) ? (modelName as string) : getClaudeBrainModel();
    return getClaudeModel(id);
  }
}

/** Test/debug — clear the token + model caches (e.g. after re-auth). */
export function resetClaudeModelCache(): void {
  cachedToken = null;
  modelCache.clear();
  provider = null;
}
