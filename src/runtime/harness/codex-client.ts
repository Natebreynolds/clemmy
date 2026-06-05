/**
 * Codex-native OAuth bridge for the harness Runner.
 *
 * The 0.3 harness must NOT require an OPENAI_API_KEY. Per Clementine's
 * auth policy, raw OpenAI keys are reserved for voice + embeddings —
 * agent model calls flow through the user's OAuth-issued bearer token
 * the same way Codex CLI and Hermes do.
 *
 * This file is the OAuth wallet for the harness:
 *   - `loadFreshCodexAccessToken()` — read the stored token, refresh
 *     it if older than REFRESH_AFTER_MS, hand back a usable bearer.
 *   - `extractAccountIdFromJwt(token)` — decode the JWT payload and
 *     pull out the `chatgpt_account_id` claim codex needs for the
 *     `chatgpt-account-id` request header.
 *   - `configureHarnessRuntime()` — register `CodexModelProvider` as
 *     the agents SDK's default model provider so every Agent in the
 *     harness ends up routed through our native codex model adapter.
 *
 * The wire-level work (build the codex request body, set the
 * codex-only headers, parse codex's SSE stream, translate items into
 * the SDK's ModelResponse shape) lives in codex-model.ts. That
 * separation matters: we tried to patch the OpenAI SDK with a fetch
 * adapter and a stream rewriter, and each prompt shape surfaced a new
 * mismatch. The right architecture is to implement the SDK's `Model`
 * interface natively and bypass the OpenAI SDK entirely in the request
 * path. pi-ai (@earendil-works/pi-ai) and the v0.2 codex-native-runtime
 * both do the same thing.
 */
import { setDefaultModelProvider } from '@openai/agents';
import { getStoredCodexOAuthTokens, refreshStoredNativeOAuth, accessTokenExpMs } from '../auth-store.js';
import { CodexModelProvider } from './codex-model.js';

// Codex access tokens last ~1 hour. Prefer the token's REAL JWT `exp` and
// refresh a skew before it; only fall back to this wall-clock guess off
// lastRefresh when the token carries no decodable exp. (Hermes/Codex-CLI do the
// same — refreshing off real expiry is never late and rotates less often.)
const REFRESH_AFTER_MS = 50 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

/**
 * Pull `chatgpt_account_id` out of the codex OAuth JWT's payload
 * claim. Codex requires this in the `chatgpt-account-id` request
 * header — without it the backend can't route the request to the
 * correct ChatGPT plan/seat and returns either 401 or a degraded
 * response shape the SDK can't parse.
 */
export function extractAccountIdFromJwt(token: string): string | null {
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

/**
 * Resolve the current access token, refreshing first if the stored
 * one is older than REFRESH_AFTER_MS. If refresh fails, returns the
 * existing token and lets the API surface a 401 — the loop will
 * record run_failed and the CLI prints the error.
 */
export async function loadFreshCodexAccessToken(): Promise<string> {
  const tokens = getStoredCodexOAuthTokens();
  if (!tokens?.accessToken) {
    throw new Error('codex OAuth tokens were cleared while the harness was running');
  }
  if (shouldRefresh(tokens.accessToken, tokens.lastRefresh)) {
    const result = await refreshStoredNativeOAuth();
    if (result.ok) {
      const refreshed = getStoredCodexOAuthTokens();
      if (refreshed?.accessToken) return refreshed.accessToken;
    }
  }
  return tokens.accessToken;
}

let configured = false;

export interface ConfigureResult {
  ok: boolean;
  reason?: string;
}

/**
 * Wire the harness to call codex through the OAuth bridge. Idempotent
 * — safe to call from each CLI invocation; a second call within the
 * same process is a no-op.
 *
 * Returns ok:false if no codex OAuth tokens are present so the caller
 * can print a clear instruction and exit before the run attempts a
 * doomed request.
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

  // Register the codex-native model provider. Every agent in the
  // harness that names a model string (e.g. `gpt-5.4`) gets a
  // CodexResponsesModel back, which hand-rolls the codex protocol
  // instead of leaning on the OpenAI SDK.
  setDefaultModelProvider(new CodexModelProvider());
  configured = true;
  return { ok: true };
}

function shouldRefresh(accessToken: string | undefined | null, lastRefreshIso: string | undefined | null): boolean {
  // Exp-aware: when the access token carries a decodable exp, refresh strictly
  // off it (real expiry minus skew) — never late, and no rotation until needed.
  const expMs = accessTokenExpMs(accessToken ?? undefined);
  if (expMs !== null) {
    return expMs <= Date.now() + REFRESH_SKEW_MS;
  }
  // Fallback: no usable exp → wall-clock guess off the last refresh.
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
export const __test__ = { shouldRefresh, REFRESH_AFTER_MS, REFRESH_SKEW_MS };
