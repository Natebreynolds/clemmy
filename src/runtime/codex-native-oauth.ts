import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

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

// ─────────────────────────────────────────────────────────────────
// Device-code login (remote / headless). The loopback browser flow above only
// works for someone sitting at the daemon's machine — it opens a LOCAL browser
// and binds a localhost callback on the daemon host. The device-code flow has no
// such requirement: the daemon shows a short URL + code, the user authorizes on
// ANY device (phone, another laptop), and the daemon POLLS for the token. This
// is the SAME endpoints the Codex CLI's `--device-auth` and the Hermes agent use
// against this same public client. No loopback server, no tunnel redirect.
const DEVICE_USERCODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;

export interface NativeCodexTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  lastRefresh: string;
}

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

function buildAuthorizeUrl(redirectUri: string, state: string, codeChallenge: string): URL {
  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', SCOPE);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('id_token_add_organizations', 'true');
  return authorizeUrl;
}

function isOAuthCallbackPath(pathname: string): boolean {
  return pathname === CALLBACK_PATH || pathname === LEGACY_CALLBACK_PATH;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

type BrowserOpener = (url: string) => void | Promise<void>;

function listenForOAuthCallback(state: string, codeChallenge: string, opener?: BrowserOpener): Promise<OAuthCallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    let lastListenError: Error | null = null;

    const finish = (
      server: ReturnType<typeof createServer> | null,
      error?: Error,
      result?: OAuthCallbackResult,
    ) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      try {
        server?.close();
      } catch {
        // The server may already be closed after a callback response.
      }
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const tryPort = (index: number) => {
      if (index >= CALLBACK_PORTS.length) {
        const detail = lastListenError ? ` Last error: ${lastListenError.message}` : '';
        reject(new Error(`Native OAuth callback server could not bind to localhost ports ${CALLBACK_PORTS.join(', ')}.${detail}`));
        return;
      }

      const port = CALLBACK_PORTS[index];
      const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
      const authorizeUrl = buildAuthorizeUrl(redirectUri, state, codeChallenge);
      const server = createServer((req, res) => {
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
        res.end('<html><body><h1>Sign-in completed.</h1><p>You can return to Clementine.</p></body></html>');
        finish(server, undefined, { payload, redirectUri });
      });

      server.once('error', (error: Error & { code?: string }) => {
        if (settled) return;
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
          lastListenError = error;
          try {
            server.close();
          } catch {
            // ignore and try the next port
          }
          tryPort(index + 1);
          return;
        }
        finish(server, error);
      });

      server.listen(port, '127.0.0.1', () => {
        timeout = setTimeout(() => {
          finish(server, new Error('Native OAuth login timed out after 15 minutes.'));
        }, LOGIN_TIMEOUT_MS);
        try {
          const launch = opener ?? openBrowser;
          const result = launch(authorizeUrl.toString());
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              finish(server, new Error(`Could not open the browser for native OAuth login: ${message}`));
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          finish(server, new Error(`Could not open the browser for native OAuth login: ${message}`));
        }
      });
    };

    tryPort(0);
  });
}

function parseJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(idToken?: string, accessToken?: string): string | undefined {
  const payloads = [parseJwtPayload(idToken), parseJwtPayload(accessToken)];
  for (const payload of payloads) {
    const auth = payload?.['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object' && auth !== null) {
      const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === 'string' && accountId) {
        return accountId;
      }
    }
  }
  return undefined;
}

async function exchangeAuthorizationCode(code: string, redirectUri: string, codeVerifier: string): Promise<NativeCodexTokenSet> {
  // 30s ceiling. Without this the daemon's CLI login (`clementine auth
  // login-native`) hangs indefinitely on a flaky network. The AbortError
  // gets converted to a human-readable timeout message.
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
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
      throw new Error('Native OAuth token exchange timed out after 30s. Check your network connection and try again.');
    }
    throw err;
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Native OAuth token exchange failed (${response.status}): ${text.slice(0, 300)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Native OAuth token exchange returned invalid JSON: ${text.slice(0, 300)}`);
  }

  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '';
  const idToken = typeof parsed.id_token === 'string' ? parsed.id_token : undefined;

  if (!accessToken || !refreshToken) {
    throw new Error('Native OAuth token exchange did not return usable access and refresh tokens.');
  }

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: extractAccountId(idToken, accessToken),
    lastRefresh: new Date().toISOString(),
  };
}

export async function refreshNativeCodexTokens(refreshToken: string): Promise<NativeCodexTokenSet> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch((err: Error & { name?: string }) => {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('Native OAuth refresh timed out after 30s. Check your network connection and try again.');
    }
    throw err;
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Native OAuth refresh failed (${response.status}): ${text.slice(0, 300)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Native OAuth refresh returned invalid JSON: ${text.slice(0, 300)}`);
  }

  const nextAccessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  const nextRefreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : refreshToken;
  const nextIdToken = typeof parsed.id_token === 'string' ? parsed.id_token : undefined;
  if (!nextAccessToken) {
    throw new Error('Native OAuth refresh did not return an access token.');
  }

  return {
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
    idToken: nextIdToken,
    accountId: extractAccountId(nextIdToken, nextAccessToken),
    lastRefresh: new Date().toISOString(),
  };
}

export interface CodexDeviceAuthStart {
  /** Short human-typed code the user enters at the verification URL. */
  userCode: string;
  /** Opaque server handle used to poll for completion. Keep this server-side. */
  deviceAuthId: string;
  /** Where the user goes to enter the code (e.g. https://auth.openai.com/codex/device). */
  verificationUri: string;
  /** Minimum seconds the server asks us to wait between polls. */
  intervalSeconds: number;
}

export type CodexDevicePollResult =
  | { status: 'pending' }
  | { status: 'complete'; tokens: NativeCodexTokenSet };

/** Step 1 of device-code login: request a user_code + device_auth_id. The caller
 *  shows `userCode` + `verificationUri` to the (possibly remote) user, then polls
 *  with {@link pollCodexDeviceAuth}. */
export async function startCodexDeviceAuth(): Promise<CodexDeviceAuthStart> {
  const response = await fetch(DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  }).catch((err: Error & { name?: string }) => {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('Codex device-code request timed out after 15s. Check your network connection and try again.');
    }
    throw err;
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex device-code request failed (${response.status}): ${text.slice(0, 300)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Codex device-code request returned invalid JSON: ${text.slice(0, 300)}`);
  }
  const userCode = typeof parsed.user_code === 'string' ? parsed.user_code : '';
  const deviceAuthId = typeof parsed.device_auth_id === 'string' ? parsed.device_auth_id : '';
  if (!userCode || !deviceAuthId) {
    throw new Error('Codex device-code response was missing user_code or device_auth_id.');
  }
  const interval = Number(parsed.interval);
  const intervalSeconds = Number.isFinite(interval) && interval > 0 ? Math.max(3, Math.floor(interval)) : 5;
  return { userCode, deviceAuthId, verificationUri: DEVICE_VERIFICATION_URL, intervalSeconds };
}

/** Step 2 of device-code login: poll once. Returns `pending` until the user has
 *  authorized, then `complete` with a usable token set (the authorization code +
 *  PKCE verifier come back from the poll and are exchanged at the token URL). */
export async function pollCodexDeviceAuth(deviceAuthId: string, userCode: string): Promise<CodexDevicePollResult> {
  const response = await fetch(DEVICE_POLL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(15_000),
  }).catch((err: Error & { name?: string }) => {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('Codex device-code poll timed out after 15s. Check your network connection and try again.');
    }
    throw err;
  });

  // 403/404 = the user has not finished authorizing yet (matches the Codex CLI /
  // Hermes contract). Anything else non-2xx is a real error.
  if (response.status === 403 || response.status === 404) {
    return { status: 'pending' };
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex device-code poll failed (${response.status}): ${text.slice(0, 300)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Codex device-code poll returned invalid JSON: ${text.slice(0, 300)}`);
  }
  const authorizationCode = typeof parsed.authorization_code === 'string' ? parsed.authorization_code : '';
  const codeVerifier = typeof parsed.code_verifier === 'string' ? parsed.code_verifier : '';
  if (!authorizationCode || !codeVerifier) {
    throw new Error('Codex device-code poll succeeded but did not return an authorization_code/code_verifier.');
  }
  const tokens = await exchangeAuthorizationCode(authorizationCode, DEVICE_REDIRECT_URI, codeVerifier);
  return { status: 'complete', tokens };
}

export async function loginWithNativeCodexOAuth(opener?: BrowserOpener): Promise<NativeCodexTokenSet> {
  const state = base64UrlEncode(randomBytes(24));
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const { payload: callback, redirectUri } = await listenForOAuthCallback(state, codeChallenge, opener);

  if (callback.error) {
    throw new Error(`Native OAuth callback failed: ${callback.error}${callback.errorDescription ? ` (${callback.errorDescription})` : ''}`);
  }
  if (!callback.code) {
    throw new Error('Native OAuth callback did not return an authorization code.');
  }
  if (callback.state !== state) {
    throw new Error('Native OAuth callback state mismatch.');
  }

  return exchangeAuthorizationCode(callback.code, redirectUri, codeVerifier);
}
