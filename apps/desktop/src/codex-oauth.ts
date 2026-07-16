import { createHash, randomBytes } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import path from 'node:path';
import { shell } from 'electron';
import {
  extractCodexAccountId,
  getCodexJwtExpiryMs,
  loadClementineOwnedCodexOAuthTokens,
  persistClementineOwnedCodexOAuthTokens,
  resolveClementineCodexAuthPaths,
  type CodexOAuthTokens,
} from './codex-oauth-store.js';

export type { CodexOAuthTokens } from './codex-oauth-store.js';

/**
 * Codex OAuth flow — desktop-local port of src/runtime/codex-native-oauth.ts
 * so the setup wizard can complete sign-in WITHOUT the user dropping into
 * a terminal to run `clementine auth login-native`.
 *
 * Clementine owns a dedicated OAuth grant in
 * ~/.clementine-next/state/auth.json. The external Codex CLI's
 * ~/.codex/auth.json is neither imported nor written because sharing its
 * rotating refresh-token family lets either program revoke the other.
 */

// CODEX_OAUTH_AUTH_BASE_URL overrides the base URL for local testing
// (smoke scripts stand up a fake OAuth server on localhost). Empty /
// undefined falls back to production.
const AUTH_BASE_URL = (process.env.CODEX_OAUTH_AUTH_BASE_URL && process.env.CODEX_OAUTH_AUTH_BASE_URL.length > 0)
  ? process.env.CODEX_OAUTH_AUTH_BASE_URL.replace(/\/+$/, '')
  : 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access';
const CALLBACK_PORTS = [1455, 1441, 1444, 1449, 1452, 1457, 1460, 1466, 1467];
const CALLBACK_PATH = '/auth/callback';
const LEGACY_CALLBACK_PATH = '/callback';
const LOGIN_TIMEOUT_MS = 15 * 60_000;

interface CallbackPayload {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

interface OAuthCallbackResult {
  payload: CallbackPayload;
  redirectUri: string;
}

function base64UrlEncode(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createCodeVerifier(): string {
  return base64UrlEncode(randomBytes(48));
}

function createCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

function buildAuthorizeUrl(
  redirectUri: string,
  state: string,
  codeChallenge: string,
  prompt?: 'login' | 'select_account',
): URL {
  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', SCOPE);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('id_token_add_organizations', 'true');
  // 2026-05-23: standard OIDC `prompt` param. Re-auth button passes
  // 'select_account' so the IdP forces an account picker even when the
  // user already has a ChatGPT session cookie — that's the affordance
  // that enables account switching. First-run setup passes nothing so
  // the happy path stays cookie-friendly.
  if (prompt) authorizeUrl.searchParams.set('prompt', prompt);
  return authorizeUrl;
}

function isOAuthCallbackPath(pathname: string): boolean {
  return pathname === CALLBACK_PATH || pathname === LEGACY_CALLBACK_PATH;
}

type CallbackServer = ReturnType<typeof createServer>;

function closeCallbackServers(servers: CallbackServer[]): void {
  for (const server of servers) {
    try { server.close(); } catch { /* already closed / never opened */ }
  }
}

function listenCallbackServer(
  server: CallbackServer,
  options: { port: number; host: string; ipv6Only?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options);
  });
}

function isUnavailableIpv6(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL';
}

/** OpenAI redirects to `localhost`, which Safari may resolve as ::1 while
 * Chromium resolves it as 127.0.0.1. Listen on both loopback families so the
 * setup wizard works with either browser without exposing the callback on LAN. */
async function listenOnLoopbacks(port: number, listener: RequestListener): Promise<CallbackServer[]> {
  const ipv4 = createServer(listener);
  try {
    await listenCallbackServer(ipv4, { port, host: '127.0.0.1' });
  } catch (error) {
    closeCallbackServers([ipv4]);
    throw error;
  }

  const address = ipv4.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  const ipv6 = createServer(listener);
  try {
    await listenCallbackServer(ipv6, { port: boundPort, host: '::1', ipv6Only: true });
    return [ipv4, ipv6];
  } catch (error) {
    closeCallbackServers([ipv6]);
    if (isUnavailableIpv6(error)) return [ipv4];
    closeCallbackServers([ipv4]);
    throw error;
  }
}

function listenForOAuthCallback(
  state: string,
  codeChallenge: string,
  openUrl: (url: string) => Promise<void> | void,
  prompt?: 'login' | 'select_account',
): Promise<OAuthCallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    let lastListenError: Error | null = null;
    let activeServers: CallbackServer[] = [];

    const finish = (
      error?: Error,
      result?: OAuthCallbackResult,
    ) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      closeCallbackServers(activeServers);
      activeServers = [];
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const tryPort = (index: number) => {
      if (index >= CALLBACK_PORTS.length) {
        const detail = lastListenError ? ` Last error: ${lastListenError.message}` : '';
        finish(new Error(`OAuth callback server could not bind to localhost ports ${CALLBACK_PORTS.join(', ')}.${detail}`));
        return;
      }

      const port = CALLBACK_PORTS[index];
      const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
      const authorizeUrl = buildAuthorizeUrl(redirectUri, state, codeChallenge, prompt);
      const handleCallback: RequestListener = (req, res) => {
        const requestUrl = new URL(req.url ?? '/', redirectUri);
        if (!isOAuthCallbackPath(requestUrl.pathname)) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const payload: CallbackPayload = {
          code: requestUrl.searchParams.get('code') ?? undefined,
          state: requestUrl.searchParams.get('state') ?? undefined,
          error: requestUrl.searchParams.get('error') ?? undefined,
          errorDescription: requestUrl.searchParams.get('error_description') ?? undefined,
        };

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<html><body style="background:#07070a;color:#e5e5ea;font-family:monospace;text-align:center;padding-top:80px"><h1 style="color:#b9ff36">Sign-in completed.</h1><p>You can return to Clementine.</p></body></html>');
        finish(undefined, { payload, redirectUri });
      };

      void listenOnLoopbacks(port, handleCallback).then((servers) => {
        if (settled) { closeCallbackServers(servers); return; }
        activeServers = servers;
        for (const server of servers) server.once('error', (error) => finish(error));
        timeout = setTimeout(() => {
          finish(new Error('OAuth login timed out after 15 minutes.'));
        }, LOGIN_TIMEOUT_MS);

        Promise.resolve(openUrl(authorizeUrl.toString())).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          finish(new Error(`Could not open the browser for OAuth login: ${message}`));
        });
      }).catch((error: Error & { code?: string }) => {
        if (settled) return;
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
          lastListenError = error;
          tryPort(index + 1);
          return;
        }
        finish(error);
      });
    };

    tryPort(0);
  });
}

function isAccessTokenFresh(tokens: CodexOAuthTokens, skewMs = 60_000): boolean {
  const expiresAt = getCodexJwtExpiryMs(tokens.accessToken);
  return expiresAt === null || expiresAt - skewMs > Date.now();
}

async function exchangeAuthorizationCode(code: string, redirectUri: string, codeVerifier: string): Promise<CodexOAuthTokens> {
  // 30s ceiling on the token endpoint call. Without a timeout, a slow
  // or hung network leaves the wizard stuck on "Signing in…" until the
  // user kills the app — see UX issue noted in the OAuth audit.
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch((err: Error & { name?: string }) => {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('OAuth token exchange timed out after 30s. Check your network connection and try again.');
    }
    throw err;
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status}): ${text.slice(0, 300)}`);

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`OAuth token exchange returned invalid JSON: ${text.slice(0, 300)}`); }

  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '';
  const idToken = typeof parsed.id_token === 'string' ? parsed.id_token : undefined;
  if (!accessToken || !refreshToken) {
    throw new Error('OAuth token exchange did not return usable access and refresh tokens.');
  }

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: extractCodexAccountId(idToken, accessToken),
    lastRefresh: new Date().toISOString(),
  };
}

export async function loadUsableClementineCodexOAuthTokens(): Promise<CodexOAuthTokens | null> {
  // Setup never rotates an existing grant: a separately running daemon may own
  // that refresh token. Reuse only a fresh, non-DEAD snapshot without writing
  // it back; stale/revoked grants go through a brand-new browser login.
  const existing = loadClementineOwnedCodexOAuthTokens(LOCAL_AUTH_FILE, CODEX_AUTH_DEAD_FILE);
  if (!existing) return null;
  return isAccessTokenFresh(existing) ? existing : null;
}

/**
 * Run the full PKCE OAuth dance. Opens auth.openai.com in the user's
 * default browser via `shell.openExternal` (Electron-aware version of
 * the daemon's `open` spawn), spins up a localhost callback listener for
 * the callback, exchanges the code, returns tokens.
 *
 * Tokens are NOT persisted by this function — call `persistCodexOAuthTokens`
 * after to write them to Clementine's private auth store.
 */
export interface RunCodexOAuthLoginOptions {
  /** OIDC `prompt` param. Pass `select_account` to force the IdP to
   *  show the account picker even when the user has a session cookie —
   *  the affordance the Settings RE-AUTHENTICATE button needs for
   *  account switching. Omit for the cookie-friendly first-run path. */
  prompt?: 'login' | 'select_account';
}

export async function runCodexOAuthLogin(
  options: RunCodexOAuthLoginOptions = {},
): Promise<CodexOAuthTokens> {
  const state = base64UrlEncode(randomBytes(24));
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const { payload: callback, redirectUri } = await listenForOAuthCallback(
    state,
    codeChallenge,
    (url) => shell.openExternal(url),
    options.prompt,
  );

  if (callback.error) {
    throw new Error(`OAuth callback failed: ${callback.error}${callback.errorDescription ? ` (${callback.errorDescription})` : ''}`);
  }
  if (!callback.code) throw new Error('OAuth callback did not return an authorization code.');
  if (callback.state !== state) throw new Error('OAuth callback state mismatch.');

  return exchangeAuthorizationCode(callback.code, redirectUri, codeVerifier);
}

// ─── Persistence ──────────────────────────────────────────────────────

const { authFile: LOCAL_AUTH_FILE, authDeadFile: CODEX_AUTH_DEAD_FILE } = resolveClementineCodexAuthPaths();

/** Write the tokens to Clementine's private auth store. */
export async function persistCodexOAuthTokens(tokens: CodexOAuthTokens): Promise<void> {
  // Clementine's OWN vault only. We intentionally no longer mirror the token
  // into ~/.codex/auth.json: sharing that file with the external `codex` CLI
  // co-mingled the rotating refresh-token family, so a separate `codex`
  // invocation could consume Clementine's token and trip reuse-detection
  // (token_revoked). Clementine owns its grant; the codex CLI owns its own.
  // A successful re-auth also clears the daemon's terminal-auth latch so the
  // new grant is usable immediately without a restart or manual file cleanup.
  await persistClementineOwnedCodexOAuthTokens(LOCAL_AUTH_FILE, CODEX_AUTH_DEAD_FILE, tokens);
}
