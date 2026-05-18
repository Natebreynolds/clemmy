/**
 * Codex-native OAuth bridge for the harness Runner.
 *
 * The 0.3 harness must NOT require an OPENAI_API_KEY. Per Clementine's
 * auth policy, raw OpenAI keys are reserved for voice + embeddings —
 * agent model calls flow through the user's OAuth-issued bearer token
 * the same way Codex CLI and Hermes do.
 *
 * Mechanism:
 *   1. The agents SDK supports `setDefaultOpenAIClient(client)` to
 *      install a process-wide OpenAI client. Every Runner constructed
 *      afterwards uses it instead of `new OpenAI({ apiKey })`.
 *   2. The OpenAI SDK accepts `apiKey` as an async getter
 *      (`ApiKeySetter = () => Promise<string>`). Each request invokes
 *      the getter, so we can refresh the OAuth token on the fly without
 *      swapping clients.
 *   3. Point `baseURL` at `https://chatgpt.com/backend-api/codex` —
 *      the same endpoint v0.2's CodexNativeRuntime hits manually —
 *      and the SDK's Responses-API requests land at
 *      `${baseURL}/responses` with `Authorization: Bearer <token>`.
 *   4. Install a `fetch` adapter that rewrites the request body to
 *      meet codex backend requirements that the standard agents SDK
 *      doesn't satisfy — primarily forcing `store: false`. The codex
 *      backend rejects requests where `store` is missing or true with
 *      a 400 `"Store must be set to false"`. Without this adapter the
 *      harness can't make a single successful call.
 */
import OpenAI from 'openai';
import { setDefaultOpenAIClient } from '@openai/agents';
import { getStoredCodexOAuthTokens, refreshStoredNativeOAuth } from '../auth-store.js';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
// Mirrors src/runtime/codex-native-runtime.ts so the backend sees the
// same client identity v0.2 sends.
const CODEX_USER_AGENT = 'Codex/0.118.0';
// Codex access tokens last ~1 hour. Refresh proactively a little
// before that so requests don't 401 mid-run.
const REFRESH_AFTER_MS = 50 * 60 * 1000;

/**
 * Codex backend specifics the agents SDK does NOT apply by default,
 * and that we add via this fetch adapter so the SDK can otherwise be
 * left alone:
 *
 *   Request body:
 *     - `store: false` is required. Missing or `true` 400s with
 *       `"Store must be set to false"`.
 *     - `include: ["reasoning.encrypted_content"]` lets codex return
 *       reasoning summaries the SDK already knows how to parse.
 *
 *   Request headers:
 *     - `chatgpt-account-id: <JWT.chatgpt_account_id>` — codex requires
 *       this to route the request to the correct ChatGPT plan/seat.
 *       Extracted from the bearer token's JWT payload.
 *     - `OpenAI-Beta: responses=experimental` — flags the
 *       experimental Responses surface; codex returns the modern
 *       structured-event stream only when this is set.
 *     - `originator: codex_cli_rs` — codex-side analytics tag; matches
 *       the User-Agent we already set.
 *
 * The pi-ai package (@earendil-works/pi-ai) is the reference
 * implementation we followed — they hand-roll the same wire format
 * for the same backend.
 */

const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

function extractAccountIdFromJwt(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf-8'),
    ) as Record<string, unknown>;
    const claims = payload[JWT_CLAIM_PATH];
    if (!claims || typeof claims !== 'object') return null;
    const accountId = (claims as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === 'string' ? accountId : null;
  } catch {
    return null;
  }
}

async function codexResponsesFetch(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const targetUrl = typeof url === 'string' ? url : 'url' in url ? url.url : String(url);
  if (
    init?.method !== 'POST' ||
    typeof init.body !== 'string' ||
    !targetUrl.includes('/responses')
  ) {
    return globalThis.fetch(url, init);
  }

  let bodyText = init.body;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    parsed.store = false;
    if (!Array.isArray(parsed.include)) {
      parsed.include = ['reasoning.encrypted_content'];
    }
    // Codex enforces `store: false`, so it has nothing to look up
    // for a `previous_response_id` from an earlier turn — the id
    // refers to a response codex never persisted. Sending it 400s
    // the second turn of any multi-turn session with no body.
    // History is already inlined into `input`, so dropping this is
    // safe and matches what pi-ai's hand-rolled provider does.
    delete parsed.previous_response_id;
    bodyText = JSON.stringify(parsed);
  } catch {
    // body wasn't JSON — leave it alone
  }

  // Layer codex-required headers on top of whatever the SDK already
  // set. Headers passed via init can be Headers, plain object, or
  // array of tuples; normalize through `new Headers()`.
  const headers = new Headers(init.headers);
  const bearer = headers.get('authorization') ?? headers.get('Authorization') ?? '';
  const token = bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7) : bearer;
  if (token) {
    const accountId = extractAccountIdFromJwt(token);
    if (accountId) headers.set('chatgpt-account-id', accountId);
  }
  headers.set('OpenAI-Beta', 'responses=experimental');
  if (!headers.has('originator')) headers.set('originator', 'codex_cli_rs');

  const upstream = await globalThis.fetch(url, { ...init, body: bodyText, headers });
  if (!upstream.ok || !upstream.body) return upstream;
  return new Response(rewriteCodexResponseStream(upstream.body), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/**
 * Patch codex's SSE stream so the OpenAI agents SDK can consume it.
 *
 * Codex emits message + tool-call items via `response.output_item.done`
 * during the stream but leaves `response.completed.response.output`
 * as an empty array. The agents SDK reads `output` from
 * `response.completed` to build its `RunMessageOutputItem`s; without
 * the patch every codex turn looks empty to the SDK and the loop
 * re-runs until `maxTurns` trips.
 *
 * This rewriter:
 *   1. Passes every SSE chunk through unchanged.
 *   2. Accumulates `response.output_item.done` items as they arrive.
 *   3. When `response.completed` arrives with an empty `output`,
 *      injects the accumulated items before forwarding it.
 *
 * SSE framing: events are `data: <json>\n\n`. The parser keeps a
 * line buffer across chunks; the writer emits the original chunk
 * verbatim except for the one `response.completed` event we patch.
 */
function rewriteCodexResponseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let textBuffer = '';
  const accumulated: unknown[] = [];

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      textBuffer += decoder.decode(chunk, { stream: true });
      const events = textBuffer.split('\n\n');
      // Keep the trailing partial in the buffer.
      textBuffer = events.pop() ?? '';
      for (const block of events) {
        controller.enqueue(encoder.encode(processEventBlock(block, accumulated) + '\n\n'));
      }
    },
    flush(controller) {
      if (textBuffer.length > 0) {
        controller.enqueue(encoder.encode(processEventBlock(textBuffer, accumulated)));
      }
    },
  });

  return source.pipeThrough(transform);
}

function processEventBlock(block: string, accumulated: unknown[]): string {
  // SSE blocks may contain `event:` and/or `data:` lines. Find the
  // data line(s) — we only need to inspect/mutate the JSON payload.
  const lines = block.split('\n');
  const dataLineIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('data:')) dataLineIndexes.push(i);
  }
  if (dataLineIndexes.length === 0) return block;
  const joinedData = dataLineIndexes
    .map((i) => lines[i].slice(5).replace(/^ /, ''))
    .join('\n');
  if (joinedData === '[DONE]') return block;

  let parsed: { type?: string; item?: unknown; response?: { output?: unknown[] } };
  try {
    parsed = JSON.parse(joinedData);
  } catch {
    return block;
  }

  if (parsed.type === 'response.output_item.done' && parsed.item) {
    accumulated.push(parsed.item);
    return block;
  }

  if (
    parsed.type === 'response.completed' &&
    parsed.response &&
    Array.isArray(parsed.response.output) &&
    parsed.response.output.length === 0 &&
    accumulated.length > 0
  ) {
    parsed.response.output = [...accumulated];
    const newData = `data: ${JSON.stringify(parsed)}`;
    // Replace all data lines with the single rewritten one; keep
    // event: lines if present.
    const rebuilt: string[] = [];
    let injected = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('data:')) {
        if (!injected) {
          rebuilt.push(newData);
          injected = true;
        }
        // skip subsequent data: lines (they've been folded into newData)
      } else {
        rebuilt.push(lines[i]);
      }
    }
    return rebuilt.join('\n');
  }

  return block;
}

let configured = false;

export interface ConfigureResult {
  ok: boolean;
  reason?: string;
}

/**
 * Wire the harness Runner to call OpenAI through the codex-native
 * OAuth path. Idempotent — safe to call from each CLI invocation;
 * a second call within the same process is a no-op.
 *
 * Returns ok:false if no codex OAuth tokens are present so the caller
 * can print a clear instruction and exit before the SDK 401s.
 */
export async function configureHarnessRuntime(): Promise<ConfigureResult> {
  if (configured) return { ok: true };

  const tokens = getStoredCodexOAuthTokens();
  if (!tokens?.accessToken) {
    return {
      ok: false,
      reason:
        'No codex OAuth tokens are stored. Run `clementine auth login-native` ' +
        '(or `clementine auth import-codex` if you already use the Codex CLI).',
    };
  }

  const client = new OpenAI({
    apiKey: () => loadFreshCodexAccessToken(),
    baseURL: CODEX_BASE_URL,
    defaultHeaders: { 'User-Agent': CODEX_USER_AGENT },
    fetch: codexResponsesFetch,
  });
  // The agents SDK pins a copy of the `openai` package whose `OpenAI`
  // class declares a private brand. Our `import OpenAI from 'openai'`
  // may resolve to a sibling install with a structurally identical
  // but nominally distinct class. Cast through unknown — the runtime
  // shape is identical (same package, same version range).
  setDefaultOpenAIClient(client as unknown as Parameters<typeof setDefaultOpenAIClient>[0]);
  configured = true;
  return { ok: true };
}

/**
 * Resolve the current access token, refreshing first if the stored
 * one is older than REFRESH_AFTER_MS. If refresh fails, returns the
 * existing token and lets the API surface a 401 — the loop will
 * record run_failed and the CLI prints the error.
 */
async function loadFreshCodexAccessToken(): Promise<string> {
  const tokens = getStoredCodexOAuthTokens();
  if (!tokens?.accessToken) {
    throw new Error('codex OAuth tokens were cleared while the harness was running');
  }
  if (shouldRefresh(tokens.lastRefresh)) {
    const result = await refreshStoredNativeOAuth();
    if (result.ok) {
      const refreshed = getStoredCodexOAuthTokens();
      if (refreshed?.accessToken) return refreshed.accessToken;
    }
  }
  return tokens.accessToken;
}

function shouldRefresh(lastRefreshIso: string | undefined | null): boolean {
  if (!lastRefreshIso) return true;
  const last = Date.parse(lastRefreshIso);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last > REFRESH_AFTER_MS;
}

/** Test helper — reset the module-level "configured" flag. */
export function resetHarnessRuntimeConfig(): void {
  configured = false;
}

/** Test helper — direct access to the staleness check. */
export const __test__ = { shouldRefresh, REFRESH_AFTER_MS };
