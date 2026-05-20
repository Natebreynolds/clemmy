import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shell } from 'electron';

/**
 * Codex OAuth flow — desktop-local port of src/runtime/codex-native-oauth.ts
 * so the setup wizard can complete sign-in WITHOUT the user dropping into
 * a terminal to run `clementine auth login-native`.
 *
 * The daemon's auth-store reads from two locations on boot, in order:
 *   1. ~/.clementine-next/state/auth.json   (local "native" path)
 *   2. ~/.codex/auth.json                   (codex CLI compat)
 *
 * We write both so whichever runtime path the daemon takes finds the
 * tokens. The setup flow avoids mirroring these tokens into Keychain;
 * the runtime reads this native auth store directly.
 */

const AUTH_BASE_URL = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email offline_access';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/callback';
const LOGIN_TIMEOUT_MS = 15 * 60_000;

export interface CodexOAuthTokens {
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
  for (const payload of [parseJwtPayload(idToken), parseJwtPayload(accessToken)]) {
    const auth = payload?.['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object' && auth !== null) {
      const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === 'string' && accountId) return accountId;
    }
  }
  return undefined;
}

function getJwtExpiryMs(token?: string): number | null {
  const payload = parseJwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

function isAccessTokenFresh(tokens: CodexOAuthTokens, skewMs = 60_000): boolean {
  const expiresAt = getJwtExpiryMs(tokens.accessToken);
  return expiresAt === null || expiresAt - skewMs > Date.now();
}

function normalizeTokenSet(input: {
  accessToken?: unknown;
  refreshToken?: unknown;
  idToken?: unknown;
  accountId?: unknown;
  lastRefresh?: unknown;
}): CodexOAuthTokens | null {
  if (typeof input.accessToken !== 'string' || !input.accessToken) return null;
  if (typeof input.refreshToken !== 'string' || !input.refreshToken) return null;
  const idToken = typeof input.idToken === 'string' ? input.idToken : undefined;
  const accountId = typeof input.accountId === 'string' ? input.accountId : extractAccountId(idToken, input.accessToken);
  return {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken,
    accountId,
    lastRefresh: typeof input.lastRefresh === 'string' ? input.lastRefresh : new Date().toISOString(),
  };
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function loadExistingCodexOAuthTokens(): CodexOAuthTokens | null {
  const local = readJsonFile(LOCAL_AUTH_FILE);
  const localCodex = local?.codexOauth && typeof local.codexOauth === 'object'
    ? local.codexOauth as Record<string, unknown>
    : null;
  const localTokens = localCodex ? normalizeTokenSet({
    accessToken: localCodex.accessToken,
    refreshToken: localCodex.refreshToken,
    idToken: localCodex.idToken,
    accountId: localCodex.accountId,
    lastRefresh: localCodex.lastRefresh,
  }) : null;
  if (localTokens) return localTokens;

  const cli = readJsonFile(CODEX_AUTH_FILE);
  const cliTokens = cli?.tokens && typeof cli.tokens === 'object'
    ? cli.tokens as Record<string, unknown>
    : null;
  return cliTokens ? normalizeTokenSet({
    accessToken: cliTokens.access_token,
    refreshToken: cliTokens.refresh_token,
    idToken: cliTokens.id_token,
    accountId: cliTokens.account_id,
    lastRefresh: cli?.last_refresh,
  }) : null;
}

async function exchangeAuthorizationCode(code: string, redirectUri: string, codeVerifier: string): Promise<CodexOAuthTokens> {
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
    accountId: extractAccountId(idToken, accessToken),
    lastRefresh: new Date().toISOString(),
  };
}

async function refreshCodexOAuthTokens(tokens: CodexOAuthTokens): Promise<CodexOAuthTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: tokens.refreshToken,
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`OAuth refresh failed (${response.status}): ${text.slice(0, 300)}`);

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`OAuth refresh returned invalid JSON: ${text.slice(0, 300)}`); }

  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : tokens.refreshToken;
  const idToken = typeof parsed.id_token === 'string' ? parsed.id_token : tokens.idToken;
  if (!accessToken) throw new Error('OAuth refresh did not return an access token.');

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: extractAccountId(idToken, accessToken) ?? tokens.accountId,
    lastRefresh: new Date().toISOString(),
  };
}

export async function importUsableCodexOAuthTokens(): Promise<CodexOAuthTokens | null> {
  const existing = loadExistingCodexOAuthTokens();
  if (!existing) return null;
  if (isAccessTokenFresh(existing)) return existing;
  try {
    return await refreshCodexOAuthTokens(existing);
  } catch {
    return null;
  }
}

/**
 * Run the full PKCE OAuth dance. Opens auth.openai.com in the user's
 * default browser via `shell.openExternal` (Electron-aware version of
 * the daemon's `open` spawn), spins up a localhost:1455 listener for
 * the callback, exchanges the code, returns tokens.
 *
 * Tokens are NOT persisted by this function — call `persistCodexOAuthTokens`
 * after to write them to the daemon's auth stores.
 */
export async function runCodexOAuthLogin(): Promise<CodexOAuthTokens> {
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
      res.end('<html><body style="background:#07070a;color:#e5e5ea;font-family:monospace;text-align:center;padding-top:80px"><h1 style="color:#b9ff36">Sign-in completed.</h1><p>You can return to Clementine.</p></body></html>');
      server.close();
      resolve(payload);
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth login timed out after 15 minutes.'));
    }, LOGIN_TIMEOUT_MS);

    server.once('close', () => clearTimeout(timeout));
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      // shell.openExternal returns a promise; if it rejects (no browser)
      // the user is still able to copy/paste the URL manually.
      shell.openExternal(authorizeUrl.toString()).catch(() => { /* fall through */ });
    });
    server.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  if (callback.error) {
    throw new Error(`OAuth callback failed: ${callback.error}${callback.errorDescription ? ` (${callback.errorDescription})` : ''}`);
  }
  if (!callback.code) throw new Error('OAuth callback did not return an authorization code.');
  if (callback.state !== state) throw new Error('OAuth callback state mismatch.');

  return exchangeAuthorizationCode(callback.code, redirectUri, codeVerifier);
}

// ─── Persistence ──────────────────────────────────────────────────────

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.clementine-next', 'state');
const LOCAL_AUTH_FILE = path.join(STATE_DIR, 'auth.json');
const CODEX_AUTH_DIR = path.join(HOME, '.codex');
const CODEX_AUTH_FILE = path.join(CODEX_AUTH_DIR, 'auth.json');

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

/**
 * Write the tokens to both the daemon's local auth store and the codex
 * CLI compatibility file, matching the shape the daemon's
 * `loginWithNativeOAuth` writes.
 */
export function persistCodexOAuthTokens(tokens: CodexOAuthTokens): void {
  const localState = {
    importedAt: new Date().toISOString(),
    source: 'native' as const,
    codexOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accountId: tokens.accountId,
      lastRefresh: tokens.lastRefresh,
    },
  };
  atomicWriteJson(LOCAL_AUTH_FILE, localState);

  let cliFile: Record<string, unknown> = {};
  if (existsSync(CODEX_AUTH_FILE)) {
    try { cliFile = JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf-8')) ?? {}; }
    catch { cliFile = {}; }
  }
  cliFile.auth_mode = 'chatgpt';
  cliFile.OPENAI_API_KEY = null;
  cliFile.tokens = {
    id_token: tokens.idToken,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    account_id: tokens.accountId,
  };
  cliFile.last_refresh = tokens.lastRefresh;
  atomicWriteJson(CODEX_AUTH_FILE, cliFile);
}
