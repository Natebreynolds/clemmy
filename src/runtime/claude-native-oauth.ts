/**
 * Claude (Anthropic) subscription OAuth login — PKCE paste-the-code flow,
 * peer to codex-native-oauth.ts. Verified live 2026-06-10 on a real Max account:
 * authorize at claude.ai, exchange at console.anthropic.com, returns an
 * sk-ant-oat01 subscription token + a refresh token (expires_in ~8h).
 *
 * This gives Clementine its OWN Claude grant (stored in our vault), decoupled
 * from the Claude Code CLI login — so we can refresh (rotating refresh token)
 * without desyncing the user's Claude Code, and users without Claude Code can
 * sign in. The wallet (claude-oauth.ts) consumes these tokens.
 */
import crypto from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'clementine.claude-native-oauth' });

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // public Claude Code client
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPE = 'org:create_api_key user:profile user:inference';

export interface ClaudeTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scopes?: string[];
}

export interface ClaudeLoginStart {
  authorizeUrl: string;
  verifier: string;
  state: string;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

/** Step 1: build the authorize URL + PKCE verifier/state. Caller shows the URL,
 *  the user approves and pastes back the code, then calls completeClaudeLogin
 *  with the SAME verifier/state. */
export function beginClaudeLogin(): ClaudeLoginStart {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { authorizeUrl: url.toString(), verifier, state };
}

export function parseTokenResponse(j: Record<string, unknown>): ClaudeTokenSet {
  const accessToken = j.access_token as string | undefined;
  if (!accessToken) throw new Error('Claude token response had no access_token');
  return {
    accessToken,
    refreshToken: j.refresh_token as string | undefined,
    expiresAt: typeof j.expires_in === 'number' ? Date.now() + j.expires_in * 1000 : undefined,
    scopes: typeof j.scope === 'string' ? (j.scope as string).split(' ').filter(Boolean) : undefined,
  };
}

/** Step 2: exchange the pasted code (may be "code#state") for tokens. */
export async function completeClaudeLogin(rawCode: string, verifier: string, fallbackState: string): Promise<ClaudeTokenSet> {
  const [code, stateFromCode] = rawCode.trim().split('#');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: stateFromCode || fallbackState,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Claude token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  const tokens = parseTokenResponse(JSON.parse(text) as Record<string, unknown>);
  if (!tokens.accessToken.startsWith('sk-ant-oat01')) {
    throw new Error('Claude login did not return a subscription (oat01) token — refusing (would bill API).');
  }
  logger.info({ scopes: tokens.scopes, expiresAt: tokens.expiresAt }, 'Claude subscription login complete');
  return tokens;
}

/** Refresh using the (rotating) refresh token. Returns a NEW token set whose
 *  refresh_token MUST be persisted (Anthropic rotates it). */
export async function refreshClaudeTokens(refreshToken: string): Promise<ClaudeTokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Claude token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  return parseTokenResponse(JSON.parse(text) as Record<string, unknown>);
}

export const __test__ = { CLIENT_ID, REDIRECT_URI, AUTHORIZE_URL, TOKEN_URL };
