import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const AUTH_BASE_URL = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/callback';
const LOGIN_TIMEOUT_MS = 15 * 60_000;

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

function base64UrlEncode(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createCodeVerifier(): string {
  return base64UrlEncode(randomBytes(48));
}

function createCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
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

export async function loginWithNativeCodexOAuth(): Promise<NativeCodexTokenSet> {
  const state = base64UrlEncode(randomBytes(24));
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', SCOPE);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('id_token_add_organizations', 'true');

  const callback = await new Promise<CallbackPayload>((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', redirectUri);
      if (requestUrl.pathname !== CALLBACK_PATH) {
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
      server.close();
      resolve(payload);
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Native OAuth login timed out after 15 minutes.'));
    }, LOGIN_TIMEOUT_MS);

    server.once('close', () => clearTimeout(timeout));
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      openBrowser(authorizeUrl.toString());
    });
    server.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

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
