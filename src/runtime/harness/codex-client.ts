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
 *
 * This is the only wiring the harness needs to authenticate. The
 * codex backend speaks the OpenAI Responses API natively, so the
 * agents SDK's wire format is unchanged.
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
    // ApiKeySetter — the SDK invokes this per request, so token
    // refresh below applies to every Runner call.
    apiKey: () => loadFreshCodexAccessToken(),
    baseURL: CODEX_BASE_URL,
    defaultHeaders: { 'User-Agent': CODEX_USER_AGENT },
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
