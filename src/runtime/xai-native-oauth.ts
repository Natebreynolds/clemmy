/**
 * xAI (Grok) subscription OAuth login — RFC 8628 device-code flow, peer to
 * codex-native-oauth.ts and claude-native-oauth.ts.
 *
 * Verified live 2026-08-14 against the real discovery document at
 * https://auth.x.ai/.well-known/openid-configuration:
 *   authorize  https://auth.x.ai/oauth2/authorize
 *   token      https://auth.x.ai/oauth2/token
 *   device     https://auth.x.ai/oauth2/device/code
 *   revoke     https://auth.x.ai/oauth2/revoke
 * grant_types: authorization_code, refresh_token, device_code. PKCE S256.
 *
 * This gives Clementine its OWN xAI grant (stored in our vault), decoupled from
 * the user's `grok` CLI login — so we can refresh without desyncing their CLI,
 * and users without the CLI can sign in.
 *
 * WHY DEVICE CODE RATHER THAN THE PASTE-A-CODE PKCE FLOW the Claude lane uses:
 * xAI advertises the device grant, which needs no redirect URI, no loopback
 * listener, and no clipboard round trip — the user opens a URL, types a short
 * code, and approves. It is also the only one of the three that works unchanged
 * on a headless box or from a phone, which is how this daemon is often driven.
 *
 * The returned access token is a JWT bearer for api.x.ai. `api:access` is the
 * scope that grants model inference; the rest are identity/refresh.
 */
import pino from 'pino';

const logger = pino({ name: 'clementine.xai-native-oauth' });

const ISSUER = 'https://auth.x.ai';
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const REVOKE_URL = `${ISSUER}/oauth2/revoke`;

/**
 * The public `grok` CLI client. Public OAuth client identifiers are not
 * secrets — the Claude and Codex lanes hardcode their vendors' first-party CLI
 * clients the same way, because a public client is exactly what a native app
 * with no server-side secret is required to use (RFC 8252).
 */
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/** `api:access` is the one that grants model inference; `offline_access` is what
 *  returns a refresh token, without which every session would re-prompt. */
const SCOPE = 'openid profile email offline_access api:access';

const REQUEST_TIMEOUT_MS = 15_000;

export interface NativeXaiTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Absolute expiry, ISO-8601. Derived from `expires_in` at receipt time. */
  expiresAt?: string;
  lastRefresh: string;
}

export interface XaiDeviceAuthStart {
  /** Short human-typed code the user enters at the verification URL. */
  userCode: string;
  /** Opaque handle used to poll for completion. Keep this server-side: it is
   *  the bearer of the pending grant. */
  deviceCode: string;
  /** Where the user goes to enter the code. */
  verificationUri: string;
  /** Same page with the code pre-filled — prefer this for a clickable link/QR. */
  verificationUriComplete?: string;
  /** Minimum seconds the server asks us to wait between polls. */
  intervalSeconds: number;
  /** Absolute expiry of the pending grant, ISO-8601. */
  expiresAt: string;
}

export type XaiDevicePollResult =
  | { status: 'pending' }
  /** The server asked us to back off; the caller must widen its interval. */
  | { status: 'slow_down'; intervalSeconds: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'complete'; tokens: NativeXaiTokenSet };

function timeoutMessage(what: string): string {
  return `xAI ${what} timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Check your network connection and try again.`;
}

async function postForm(url: string, form: Record<string, string>, what: string): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  raw: string;
}> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((err: Error & { name?: string }) => {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error(timeoutMessage(what));
    throw err;
  });
  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A non-JSON body is only fatal when the call also failed; the callers below
    // decide, because an OAuth error is itself delivered as a JSON body.
  }
  return { ok: response.ok, status: response.status, body, raw };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tokenSetFrom(body: Record<string, unknown>, priorRefreshToken?: string): NativeXaiTokenSet {
  const accessToken = str(body.access_token);
  if (!accessToken) throw new Error('xAI token response was missing access_token.');
  // A refresh response may legitimately omit refresh_token when the server is
  // NOT rotating it; carrying the prior one forward is what keeps a long-lived
  // grant alive instead of silently downgrading to a single-use token.
  const refreshToken = str(body.refresh_token) || priorRefreshToken || '';
  const expiresIn = Number(body.expires_in);
  return {
    accessToken,
    refreshToken,
    ...(str(body.id_token) ? { idToken: str(body.id_token) } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
      : {}),
    lastRefresh: new Date().toISOString(),
  };
}

/**
 * Step 1 of device-code login: request a user_code + device_code.
 *
 * The caller shows `userCode` and `verificationUri` (or the pre-filled
 * `verificationUriComplete`) to the — possibly remote — user, then polls with
 * {@link pollXaiDeviceAuth}.
 */
export async function startXaiDeviceAuth(): Promise<XaiDeviceAuthStart> {
  const { ok, status, body, raw } = await postForm(
    DEVICE_CODE_URL,
    { client_id: CLIENT_ID, scope: SCOPE },
    'device-code request',
  );
  if (!ok) throw new Error(`xAI device-code request failed (${status}): ${raw.slice(0, 300)}`);

  const userCode = str(body.user_code);
  const deviceCode = str(body.device_code);
  const verificationUri = str(body.verification_uri);
  if (!userCode || !deviceCode || !verificationUri) {
    throw new Error('xAI device-code response was missing user_code, device_code, or verification_uri.');
  }
  const interval = Number(body.interval);
  const expiresIn = Number(body.expires_in);
  return {
    userCode,
    deviceCode,
    verificationUri,
    ...(str(body.verification_uri_complete)
      ? { verificationUriComplete: str(body.verification_uri_complete) }
      : {}),
    // Never poll faster than the server asks. The floor mirrors the Codex lane.
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.max(3, Math.floor(interval)) : 5,
    expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1800) * 1000).toISOString(),
  };
}

/**
 * Step 2 of device-code login: poll once.
 *
 * RFC 8628 delivers its in-progress states as HTTP 400 with a typed `error`
 * body, so a non-2xx here is usually NOT a failure — treating it as one is the
 * classic way to break this flow. Only an unrecognized error is fatal.
 */
export async function pollXaiDeviceAuth(deviceCode: string): Promise<XaiDevicePollResult> {
  const { ok, status, body, raw } = await postForm(
    TOKEN_URL,
    {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    'device token poll',
  );
  if (ok) return { status: 'complete', tokens: tokenSetFrom(body) };

  switch (str(body.error)) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down': {
      const interval = Number(body.interval);
      return {
        status: 'slow_down',
        intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.max(3, Math.floor(interval)) : 10,
      };
    }
    case 'access_denied':
      return { status: 'denied' };
    case 'expired_token':
      return { status: 'expired' };
    default:
      throw new Error(`xAI device token poll failed (${status}): ${raw.slice(0, 300)}`);
  }
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshNativeXaiTokens(refreshToken: string): Promise<NativeXaiTokenSet> {
  if (!refreshToken.trim()) throw new Error('xAI refresh requires a refresh token.');
  const { ok, status, body, raw } = await postForm(
    TOKEN_URL,
    { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken },
    'token refresh',
  );
  if (!ok) throw new Error(`xAI token refresh failed (${status}): ${raw.slice(0, 300)}`);
  return tokenSetFrom(body, refreshToken);
}

/** Best-effort revocation on disconnect. A failure here is logged, never thrown:
 *  the local grant is already being discarded and a dead token is harmless. */
export async function revokeNativeXaiToken(token: string): Promise<void> {
  if (!token.trim()) return;
  try {
    await postForm(REVOKE_URL, { client_id: CLIENT_ID, token }, 'token revocation');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'xAI token revocation failed');
  }
}

export interface XaiDeviceLoginPrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
}

/**
 * Full device-code login: start, show the code, poll to completion.
 *
 * `onPrompt` receives the code and URL to display. Polling honors the server's
 * interval and any `slow_down`, and stops at the grant's own expiry rather than
 * a local guess, so a user who walks away cannot leave this spinning.
 */
export async function loginWithNativeXaiOAuth(
  onPrompt: (prompt: XaiDeviceLoginPrompt) => void,
  options: { signal?: AbortSignal } = {},
): Promise<NativeXaiTokenSet> {
  const start = await startXaiDeviceAuth();
  onPrompt({
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    ...(start.verificationUriComplete ? { verificationUriComplete: start.verificationUriComplete } : {}),
  });

  let intervalMs = start.intervalSeconds * 1000;
  const deadline = Date.parse(start.expiresAt);
  for (;;) {
    if (options.signal?.aborted) throw new Error('xAI sign-in was cancelled.');
    if (Date.now() >= deadline) {
      throw new Error('xAI sign-in expired before it was approved. Start the sign-in again.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const poll = await pollXaiDeviceAuth(start.deviceCode);
    if (poll.status === 'complete') return poll.tokens;
    if (poll.status === 'denied') throw new Error('xAI sign-in was denied in the browser.');
    if (poll.status === 'expired') {
      throw new Error('xAI sign-in expired before it was approved. Start the sign-in again.');
    }
    if (poll.status === 'slow_down') intervalMs = poll.intervalSeconds * 1000;
  }
}

/** The endpoints and client this lane uses. Exported so a doctor/status surface
 *  can show what it will talk to without duplicating the constants. */
export const XAI_OAUTH_ENDPOINTS = Object.freeze({
  issuer: ISSUER,
  deviceCodeUrl: DEVICE_CODE_URL,
  tokenUrl: TOKEN_URL,
  revokeUrl: REVOKE_URL,
  clientId: CLIENT_ID,
  scope: SCOPE,
});
