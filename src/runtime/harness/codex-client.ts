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
import { randomUUID } from 'node:crypto';
import { setDefaultModelProvider } from '@openai/agents';
import { getStoredCodexOAuthTokens, refreshStoredNativeOAuth, accessTokenExpMs } from '../auth-store.js';
import { RouterModelProvider } from './router-model.js';
import { maybeWrapDebate } from './debate-model.js';
import { loadFreshClaudeAccessToken, claudeVaultFallbackReady } from '../claude-oauth.js';
import { addNotification } from '../notifications.js';
import { getModelRoutingMode, getByoBackendConfig, getActiveAuthMode } from '../../config.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.codex-client' });

type BrainMode = 'codex_oauth' | 'claude_oauth' | 'api_key';

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
  /** Set when the user's chosen brain couldn't authenticate and the harness
   *  fell back to an available provider FOR THIS SESSION (so a restart retries
   *  the real choice). Callers surface `note` to the user. */
  fallback?: { from: string; to: BrainMode; note: string };
}

/**
 * Find the first AVAILABLE alternative brain when the desired one can't
 * authenticate. Order: Codex (subscription OAuth) → Claude (subscription OAuth,
 * refreshed) → BYO (the user's own API key). Every option is a subscription
 * login or the user's own key — never a silent pay-per-token fallback. Returns
 * the fallback mode, or null when nothing usable is connected.
 */
function pickAvailableBrainFallback(skip: BrainMode): BrainMode | null {
  // Every probe is cheap + side-effect-free: codex reads auth.json, claude reads
  // the vault FILE only (claudeVaultFallbackReady — NEVER the keychain, which can
  // surface a blocking GUI prompt), byo reads env/vault file. The actual Claude
  // token refresh still happens at dispatch (claude-model uses loadFresh).
  if (skip !== 'codex_oauth') {
    try { if (getStoredCodexOAuthTokens()?.accessToken) return 'codex_oauth'; } catch { /* none */ }
  }
  if (skip !== 'claude_oauth') {
    try { if (claudeVaultFallbackReady()) return 'claude_oauth'; } catch { /* none */ }
  }
  if (skip !== 'api_key') {
    try { if (getByoBackendConfig().configured) return 'api_key'; } catch { /* none */ }
  }
  return null;
}

/** Apply a brain fallback for THIS SESSION ONLY (process.env override, NOT .env),
 *  so a restart retries the user's real choice once they reconnect. Registers the
 *  router, logs loudly, and notifies the user. */
function applyBrainFallback(from: string, to: BrainMode): ConfigureResult {
  process.env.AUTH_MODE = to;
  if (to === 'api_key') process.env.MODEL_ROUTING_MODE = 'all_in';
  setDefaultModelProvider(maybeWrapDebate(new RouterModelProvider()));
  configured = true;
  const label = to === 'codex_oauth' ? 'Codex' : to === 'claude_oauth' ? 'Claude' : 'your BYO model';
  const note = `Your ${from} login isn't available, so I switched the brain to ${label} for now so I can keep working. Reconnect ${from} in Settings → Models to switch back.`;
  logger.warn({ from, to }, `brain fallback engaged — ${note}`);
  try {
    addNotification({
      id: randomUUID(), kind: 'system', title: 'Brain switched (login unavailable)',
      body: note, createdAt: new Date().toISOString(), read: false,
    });
  } catch { /* notification is best-effort */ }
  return { ok: true, fallback: { from, to, note } };
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

  const mode = getModelRoutingMode();
  const byo = getByoBackendConfig();

  // All-in (BYO brain) takes PRECEDENCE over the stored AUTH_MODE. When a user
  // has explicitly enabled all_in with a configured BYO backend, EVERY role —
  // including the brain — runs on the BYO model (e.g. GLM), and no Codex/Claude
  // token is required (the BYO key is the credential). This MUST win over a
  // leftover AUTH_MODE=claude_oauth/codex_oauth: otherwise a stale oauth mode
  // (e.g. set before switching to a GLM brain via the old backend form) silently
  // hijacks the brain and makes it depend on an expired OAuth token the user no
  // longer wants — the exact "settings says GLM but it's actually Claude (token
  // expired)" trap. effectiveBrain() mirrors this precedence so UI == runtime.
  if (mode === 'all_in' && byo.configured) {
    setDefaultModelProvider(maybeWrapDebate(new RouterModelProvider()));
    configured = true;
    return { ok: true };
  }

  // Claude brain (subscription OAuth) — when AUTH_MODE=claude_oauth (and not the
  // all_in BYO-brain case above), every role runs on Claude via the user's
  // Max/Pro subscription. We REFRESH the token at the gate (loadFresh, not the
  // sync loader) — a refreshable-but-expired access token is renewed here instead
  // of throwing "expired", which was the recurring "Claude login keeps expiring"
  // bug: the gate threw before the request-path refresher ever ran. Still fails
  // closed on a missing token or an `api03` API key (billing guard). If Claude
  // genuinely can't authenticate, fall back to another connected model.
  if (getActiveAuthMode() === 'claude_oauth') {
    try {
      await loadFreshClaudeAccessToken();
      setDefaultModelProvider(maybeWrapDebate(new RouterModelProvider()));
      configured = true;
      return { ok: true };
    } catch (err) {
      const fb = pickAvailableBrainFallback('claude_oauth');
      if (fb) return applyBrainFallback('Claude', fb);
      return {
        ok: false,
        reason: (err instanceof Error ? err.message : 'Claude subscription auth is not ready.')
          + ' No other model is connected — set one up in Settings → Models.',
      };
    }
  }

  // all_in requested but no BYO backend configured → clear, actionable error.
  if (mode === 'all_in') {
    return {
      ok: false,
      reason:
        'all_in mode is enabled but no BYO backend is configured. ' +
        'Set a backend (e.g., DeepSeek, MiniMax) in Settings → Model backend.',
    };
  }

  const tokens = getStoredCodexOAuthTokens();
  if (!tokens?.accessToken) {
    // Codex is the default brain but isn't logged in — fall back to any other
    // connected model (Claude / BYO) before surfacing a hard error.
    const fb = pickAvailableBrainFallback('codex_oauth');
    if (fb) return applyBrainFallback('Codex', fb);
    return {
      ok: false,
      reason:
        'No AI model is signed in yet. Open Settings → Models & routing and ' +
        'sign in with ChatGPT or Claude (or add an API-key model).',
    };
  }

  // Every agent names a model id. The router dispatches that id to Codex,
  // Claude, or BYO, which is what makes role→model bindings real instead of
  // cosmetic. The default Codex path still resolves gpt-* ids to Codex.
  setDefaultModelProvider(maybeWrapDebate(new RouterModelProvider()));
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
