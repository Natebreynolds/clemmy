import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUTH_MODE, BASE_DIR, getOpenAiApiKey, getRuntimeEnv } from '../config.js';
import type { AuthStatus } from '../types.js';
import { loginWithNativeCodexOAuth, refreshNativeCodexTokens, startCodexDeviceAuth, pollCodexDeviceAuth } from './codex-native-oauth.js';
import type { NativeCodexTokenSet } from './codex-native-oauth.js';
import { claudeVaultFallbackReady, hasClaudeCodeCredentialFile } from './claude-oauth.js';

const AUTH_STATE_FILE = path.join(BASE_DIR, 'state', 'auth.json');

// ─────────────────────────────────────────────────────────────────
// Codex OAuth refresh concurrency control.
//
// Codex/ChatGPT OAuth uses ROTATING refresh tokens with reuse-detection:
// POSTing grant_type=refresh_token with RT1 returns RT2 and INVALIDATES RT1.
// If a second caller POSTs the already-consumed RT1, the server treats it as
// token theft and REVOKES THE ENTIRE TOKEN FAMILY (`token_revoked`) — bricking
// auth until the user re-signs-in.
//
// The harness runs many agents concurrently, each calling
// loadFreshCodexAccessToken() per model request. At the ~50-min refresh
// boundary they ALL see a stale token and would each fire a refresh with the
// same RT → reuse → revoke. We enforce: WITHIN CLEMENTINE'S OWN PROCESSES, a
// refresh token is used for at most one refresh, and only one refresh runs at a
// time.
//
//   1. In-process single-flight — concurrent callers share one refresh promise.
//   2. Cross-process advisory lock — serializes refreshes across daemon
//      instances (e.g. a restart overlap). Fail-open + stale-steal so a crashed
//      holder can never deadlock auth.
//   3. Skip-if-just-refreshed — after acquiring the lock, if another holder
//      refreshed within the last 2 min, reuse their token instead of POSTing
//      the (now-rotated) RT again.
//
// Two residual reuse paths this CANNOT close (both pre-existing, both strictly
// improved vs the old N-way retry storm):
//   - EXTERNAL Codex CLI: writeCodexAuthFile syncs ~/.codex/auth.json and
//     getStoredCodexOAuthTokens reads it as a fallback, so a concurrently-run
//     `codex` binary rotates the SAME family while honoring neither this lock
//     nor skip-if-recent. The clean decouple is a dedicated Clementine login
//     (a separate grant), not a lock. We stop pushing rotated tokens to that
//     file on refresh (below) to at least not feed it our rotating RT.
//   - At-least-once: if the refresh POST reaches the server (RT rotated) but
//     the ACK is lost (timeout fires post-rotation), lastRefresh is NOT
//     advanced and the consumed RT stays on disk → the next caller replays it →
//     revoke. No lock can close server-side consumption with a lost ack.
const REFRESH_LOCK_FILE = path.join(BASE_DIR, 'state', 'codex-refresh.lock');

// ─────────────────────────────────────────────────────────────────
// Terminal-vs-transient auth-error taxonomy + DEAD latch.
//
// OpenAI's auth backend distinguishes PERMANENT failures (the token family is
// gone — only a re-auth recovers) from TRANSIENT ones (quota/rate-limit/backend
// blips — the SAME token is still valid, just retry later). Conflating them is a
// documented foot-gun in sibling harnesses: re-auth-prompting on a mere 429
// (false alarm), and — worse — RE-POSTING an already-revoked refresh token every
// cycle, which both spams the user and can trip further family revokes.
//
// We persist a small DEAD latch the moment a terminal auth failure is observed.
// While latched: refresh short-circuits (never replays the dead RT) and runtimes
// can skip the doomed request and park instead of hammering. ANY successful token
// write (login / import / refresh) clears it — that's the recovery signal.
const CODEX_AUTH_DEAD_FILE = path.join(BASE_DIR, 'state', 'codex-auth-dead.json');

const TERMINAL_AUTH_PATTERNS = [
  'token_revoked',
  'token_invalidated',
  'refresh_token_invalidated',
  'invalidated oauth token',
  'refresh_token_reused',
  'refresh token was already used',
  'invalid_grant',
  'unauthorized_client',
  'refresh_token_expired',
];

export type CodexAuthErrorClass = 'terminal' | 'transient' | null;

/** Classify a Codex auth/model error as terminal (re-auth required), transient
 *  (retry — token still valid), or null (not an auth signal). Pure; used by the
 *  refresh path, the runtimes, and the execution controller so they all agree.
 *
 *  `source` matters for a MARKER-LESS 401. On the `refresh` (token) endpoint a
 *  bare 401 means the refresh token itself was rejected → terminal (re-login).
 *  On a `model` (inference) call a bare 401 almost always means the short-lived
 *  access token just expired (or a one-off edge reject) → TRANSIENT: the caller
 *  must refresh-and-retry first. Conflating the two is exactly what bricked auth
 *  on a transient blip; Codex CLI and Hermes both refresh-and-retry a model 401
 *  and only treat a refresh-endpoint failure as a revoke. Default (no source) is
 *  the conservative legacy behavior (401 → terminal) for the refresh path. */
export function classifyCodexAuthError(input: { message?: string; status?: number; code?: string; source?: 'model' | 'refresh' }): CodexAuthErrorClass {
  const hay = `${input.code ?? ''} ${input.message ?? ''}`.toLowerCase();
  // An explicit terminal MARKER (token_revoked / invalid_grant / refresh_token_reused
  // / …) is terminal wherever it surfaces — the refresh-token family is gone.
  if (TERMINAL_AUTH_PATTERNS.some((p) => hay.includes(p))) return 'terminal';
  // A bare 401 with no terminal marker: terminal only off the refresh endpoint;
  // on a model call it's a needs-refresh signal, not a revoke.
  if (input.status === 401 || /\b401\b/.test(hay)) {
    return input.source === 'model' ? 'transient' : 'terminal';
  }
  // Quota / rate-limit / backend blips: the token is fine, retry later. NEVER
  // treat these as a revoke (the "re-auth on a 429" false alarm).
  if (input.status === 429 || input.status === 402 || (typeof input.status === 'number' && input.status >= 500)) return 'transient';
  if (/rate.?limit|quota|too many requests|temporarily|timeout|503|502|504/.test(hay)) return 'transient';
  return null;
}

/** Decode a JWT payload (base64url, signature NOT verified). Pure. */
function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
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

/** The access token's JWT `exp` in epoch milliseconds, or null when the token
 *  carries no decodable numeric `exp`. Lets callers distinguish "has a real
 *  expiry" from "expiring now" (so they know when to trust exp vs fall back to
 *  the lastRefresh heuristic). */
export function accessTokenExpMs(accessToken: string | undefined): number | null {
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

/** True when the access token's JWT `exp` is at/within `skewMs` of now. Mirrors
 *  Codex CLI / Hermes `_codex_access_token_is_expiring`: refresh off the REAL
 *  token expiry, not a fixed wall-clock guess — fewer rotations (smaller reuse
 *  surface) AND never late (no mid-run 401). Returns false when the token has no
 *  decodable numeric `exp` so the caller falls back to the lastRefresh heuristic. */
export function accessTokenExpiresSoon(accessToken: string | undefined, skewMs = 60_000): boolean {
  const expMs = accessTokenExpMs(accessToken);
  if (expMs === null) return false;
  return expMs <= Date.now() + Math.max(0, skewMs);
}

export interface CodexAuthDeadState { reason: string; since: string; }

export function getCodexAuthDead(): CodexAuthDeadState | null {
  try {
    if (!existsSync(CODEX_AUTH_DEAD_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CODEX_AUTH_DEAD_FILE, 'utf-8')) as Partial<CodexAuthDeadState>;
    if (parsed?.reason && parsed?.since) return { reason: parsed.reason, since: parsed.since };
    return null;
  } catch {
    return null;
  }
}

export function isCodexAuthDead(): boolean {
  return getCodexAuthDead() !== null;
}

/** Latch auth as dead (terminal revoke/expiry). Idempotent — keeps the FIRST
 *  reason/since so the latch reflects when auth actually went down. */
export function markCodexAuthDead(reason: string): void {
  try {
    if (existsSync(CODEX_AUTH_DEAD_FILE)) return; // preserve original since/reason
    mkdirSync(path.dirname(CODEX_AUTH_DEAD_FILE), { recursive: true });
    writeFileSync(
      CODEX_AUTH_DEAD_FILE,
      JSON.stringify({ reason: reason.slice(0, 300), since: new Date().toISOString() }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch { /* best-effort; the latch is an optimization, never load-bearing for correctness */ }
}

export function clearCodexAuthDead(): void {
  try { rmSync(CODEX_AUTH_DEAD_FILE, { force: true }); } catch { /* ignore */ }
}
// STALE must comfortably exceed the 30s refresh HTTP timeout so a slow-but-ALIVE
// holder's lock is never stolen mid-rotation — stealing a live holder is the ONE
// path that re-creates the reuse→revoke this fix prevents. The harness starves
// the event loop under concurrent agents, so the acquire→fetch-resolve gap can
// run well past 30s; 90s (3× the HTTP ceiling) leaves room for that while still
// re-admitting a genuinely crashed holder. WAIT matches STALE so a waiter never
// fails open before a live holder is even eligible to be declared dead.
const REFRESH_LOCK_WAIT_MS = 90_000;   // bound the wait, then fail-open
const REFRESH_LOCK_STALE_MS = 90_000;  // steal only a crashed holder, never a slow live one
const REFRESH_SKIP_IF_WITHIN_MS = 2 * 60 * 1000; // a sibling just refreshed → reuse it

let inflightRefresh: Promise<{ ok: boolean; message: string; terminal?: boolean }> | null = null;

// Test seam: substitute the network token rotation with a stub so the
// single-flight + lock behavior is verifiable without hitting OpenAI.
let refreshTokenImpl: typeof refreshNativeCodexTokens = refreshNativeCodexTokens;
export function __setRefreshTokenImplForTests(fn: typeof refreshNativeCodexTokens | null): void {
  refreshTokenImpl = fn ?? refreshNativeCodexTokens;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Acquire the cross-process refresh lock. Returns an fd on success, or null
 *  if it couldn't be acquired within the wait budget (caller proceeds anyway —
 *  fail-open, since blocking a refresh forever guarantees a 401). */
async function acquireRefreshLock(): Promise<number | null> {
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  mkdirSync(path.dirname(REFRESH_LOCK_FILE), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(REFRESH_LOCK_FILE, 'wx'); // O_EXCL — fails if held
      try { writeFileSync(fd, `${process.pid}`); } catch { /* best-effort marker */ }
      return fd;
    } catch {
      // Held by someone. Steal it if it's stale (crashed holder), else wait.
      try {
        const st = statSync(REFRESH_LOCK_FILE);
        if (Date.now() - st.mtimeMs > REFRESH_LOCK_STALE_MS) {
          rmSync(REFRESH_LOCK_FILE, { force: true });
          continue; // retry immediately
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      if (Date.now() >= deadline) return null; // fail-open
      await delay(150);
    }
  }
}

function releaseRefreshLock(fd: number | null): void {
  if (fd === null) return;
  try { closeSync(fd); } catch { /* ignore */ }
  try { rmSync(REFRESH_LOCK_FILE, { force: true }); } catch { /* ignore */ }
}

function getCodexAuthSourceFile(): string {
  return getRuntimeEnv(
    'CODEX_AUTH_SOURCE_FILE',
    path.join(os.homedir(), '.codex', 'auth.json'),
  );
}

interface CodexCliAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface LocalAuthState {
  importedAt?: string;
  source?: 'codex_cli' | 'native';
  codexOauth?: {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    accountId?: string;
    lastRefresh?: string;
  };
}

export interface StoredCodexOAuthTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  lastRefresh?: string;
}

interface CodexBootstrapState {
  localCodex?: NonNullable<LocalAuthState['codexOauth']>;
  codexCli?: NonNullable<CodexCliAuthFile['tokens']>;
  codexCliLastRefresh?: string;
}

interface CodexBootstrapAvailability {
  available: boolean;
  source: 'local_store' | 'codex_cli' | 'none';
  accountId?: string;
  lastRefresh?: string;
}

function loadLocalAuthState(): LocalAuthState {
  if (!existsSync(AUTH_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_STATE_FILE, 'utf-8')) as LocalAuthState;
  } catch {
    return {};
  }
}

export function getStoredCodexOAuthTokens(): StoredCodexOAuthTokens | null {
  // VAULT ONLY. Clementine never runs off ~/.codex/auth.json (the Codex CLI's
  // file). Reading it as a fallback coupled Clem to the CLI's rotating token
  // family, so a `codex logout` or a concurrent `codex` run revoked Clem too —
  // the dominant "keeps getting logged out" trap. Clem owns its OWN grant
  // (native loopback or device-code login); the CLI file is no longer read.
  const local = loadLocalAuthState();
  if (local.codexOauth?.accessToken && local.codexOauth?.refreshToken) {
    return {
      accessToken: local.codexOauth.accessToken,
      refreshToken: local.codexOauth.refreshToken,
      idToken: local.codexOauth.idToken,
      accountId: local.codexOauth.accountId,
      lastRefresh: local.codexOauth.lastRefresh,
    };
  }
  return null;
}

function saveLocalAuthState(state: LocalAuthState): void {
  // Refresh tokens live here. Lock to 0600 so other accounts on the
  // same machine can't read them. Pass mode at write time AND chmod
  // after because some filesystems re-apply umask on creation.
  mkdirSync(path.dirname(AUTH_STATE_FILE), { recursive: true });
  writeFileSync(AUTH_STATE_FILE, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(AUTH_STATE_FILE, 0o600); } catch { /* best-effort */ }
  // A fresh, usable token landed (login / import / successful refresh) → auth is
  // healthy again, so lift any DEAD latch. This is the single recovery signal.
  if (state.codexOauth?.accessToken && state.codexOauth?.refreshToken) {
    clearCodexAuthDead();
  }
}

function loadCodexCliAuth(sourceFile = getCodexAuthSourceFile()): CodexCliAuthFile | null {
  if (!existsSync(sourceFile)) return null;
  try {
    return JSON.parse(readFileSync(sourceFile, 'utf-8')) as CodexCliAuthFile;
  } catch {
    return null;
  }
}

function getCodexBootstrapState(sourceFile = getCodexAuthSourceFile()): CodexBootstrapState {
  const local = loadLocalAuthState();
  const codexCli = loadCodexCliAuth(sourceFile);
  return {
    localCodex: local.codexOauth,
    codexCli: codexCli?.tokens,
    codexCliLastRefresh: codexCli?.last_refresh,
  };
}

export function getCodexBootstrapAvailability(sourceFile = getCodexAuthSourceFile()): CodexBootstrapAvailability {
  const state = getCodexBootstrapState(sourceFile);
  // VAULT ONLY — a present ~/.codex/auth.json no longer counts as "available".
  // Clem must hold its own independent grant; an external CLI sign-in is not it.
  if (state.localCodex?.accessToken && state.localCodex?.refreshToken) {
    return {
      available: true,
      source: 'local_store',
      accountId: state.localCodex.accountId,
      lastRefresh: state.localCodex.lastRefresh,
    };
  }
  return {
    available: false,
    source: 'none',
  };
}

// Clementine no longer installs, runs, or reads-as-runtime the external `codex`
// CLI. It never mirrors its rotating token into ~/.codex/auth.json, never auto-
// installs the CLI, and never runs `codex login` — all of which coupled Clem to
// the CLI's shared token family (a `codex logout` then signed Clem out). Clem
// signs in independently via the loopback (login-native) or device-code
// (login-device) flows. The CLI file is still READ once, on demand, ONLY by the
// explicit `auth import-codex` migration command (importCodexCliAuth).

export async function loginWithNativeOAuth(_sourceFile = getCodexAuthSourceFile()): Promise<{ ok: boolean; message: string }> {
  try {
    const tokens = await loginWithNativeCodexOAuth();
    // Persist to Clementine's OWN vault ONLY — do NOT write ~/.codex/auth.json.
    // Clementine owns its grant; the external `codex` CLI owns its own. Sharing
    // that file lets a separate `codex` invocation rotate/consume our refresh
    // token and trip reuse-detection (token_revoked). See the notes near
    // REFRESH_LOCK_FILE; this is the "Clem holds her own auth token" decouple.
    saveLocalAuthState({
      importedAt: new Date().toISOString(),
      source: 'native',
      codexOauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        accountId: tokens.accountId,
        lastRefresh: tokens.lastRefresh,
      },
    });
    return {
      ok: true,
      message: 'Signed in to ChatGPT/Codex. Clementine stored its own credentials (independent of the Codex CLI).',
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Device-code login (remote / headless). Persists into Clementine's OWN vault,
// exactly like the loopback native login — no ~/.codex/auth.json coupling. The
// pending map holds the per-login PKCE/poll handles server-side, keyed by an
// opaque loginId; only the loginId + the user_code + verification URL ever cross
// the wire to the (possibly remote) client.
const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;
interface PendingDeviceLogin { deviceAuthId: string; userCode: string; intervalSeconds: number; createdAt: number; }
const pendingDeviceLogins = new Map<string, PendingDeviceLogin>();

function sweepPendingDeviceLogins(): void {
  const cutoff = Date.now() - DEVICE_LOGIN_TTL_MS;
  for (const [id, p] of pendingDeviceLogins) {
    if (p.createdAt < cutoff) pendingDeviceLogins.delete(id);
  }
}

function persistDeviceTokens(tokens: NativeCodexTokenSet): void {
  // OWN vault only (source 'native') — clears the DEAD latch via saveLocalAuthState.
  saveLocalAuthState({
    importedAt: new Date().toISOString(),
    source: 'native',
    codexOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accountId: tokens.accountId,
      lastRefresh: tokens.lastRefresh,
    },
  });
}

export interface CodexDeviceLoginStart {
  loginId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
}

export type CodexDeviceLoginPoll =
  | { status: 'pending' }
  | { status: 'complete'; accountId?: string }
  | { status: 'expired' }
  | { status: 'error'; message: string };

/** Begin a remote/headless device-code sign-in. Returns the user_code +
 *  verification URL to display (URL/QR) and a loginId to poll with. */
export async function beginCodexDeviceLogin(): Promise<CodexDeviceLoginStart> {
  sweepPendingDeviceLogins();
  const start = await startCodexDeviceAuth();
  const loginId = randomUUID();
  pendingDeviceLogins.set(loginId, {
    deviceAuthId: start.deviceAuthId,
    userCode: start.userCode,
    intervalSeconds: start.intervalSeconds,
    createdAt: Date.now(),
  });
  return {
    loginId,
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    intervalSeconds: start.intervalSeconds,
    expiresAt: new Date(Date.now() + DEVICE_LOGIN_TTL_MS).toISOString(),
  };
}

/** Poll a device-code sign-in once. On `complete`, the tokens are persisted to
 *  Clementine's vault (and the DEAD latch is cleared). Safe to call repeatedly
 *  from the client every `intervalSeconds`. */
export async function pollCodexDeviceLogin(loginId: string): Promise<CodexDeviceLoginPoll> {
  const pending = pendingDeviceLogins.get(loginId);
  if (!pending) return { status: 'expired' };
  if (Date.now() - pending.createdAt > DEVICE_LOGIN_TTL_MS) {
    pendingDeviceLogins.delete(loginId);
    return { status: 'expired' };
  }
  try {
    const result = await pollCodexDeviceAuth(pending.deviceAuthId, pending.userCode);
    if (result.status === 'pending') return { status: 'pending' };
    pendingDeviceLogins.delete(loginId);
    persistDeviceTokens(result.tokens);
    return { status: 'complete', accountId: result.tokens.accountId };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Blocking device-code login for the CLI / headless servers: prints the code,
 *  polls until the user authorizes (or it times out), persists on success. */
export async function loginWithCodexDeviceCode(
  onPrompt: (info: { userCode: string; verificationUri: string }) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; message: string }> {
  try {
    const start = await startCodexDeviceAuth();
    onPrompt({ userCode: start.userCode, verificationUri: start.verificationUri });
    const deadline = Date.now() + DEVICE_LOGIN_TTL_MS;
    const intervalMs = Math.max(3, start.intervalSeconds) * 1000;
    for (;;) {
      if (opts.signal?.aborted) return { ok: false, message: 'Device login cancelled.' };
      await delay(intervalMs);
      if (Date.now() > deadline) return { ok: false, message: 'Device login timed out after 15 minutes.' };
      const result = await pollCodexDeviceAuth(start.deviceAuthId, start.userCode);
      if (result.status === 'complete') {
        persistDeviceTokens(result.tokens);
        return { ok: true, message: 'Signed in to ChatGPT/Codex via device code. Clementine stored its own credentials.' };
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Refresh the stored native Codex OAuth tokens. SAFE under concurrency: the
 *  rotating refresh token is used for at most one refresh per token-age window,
 *  even when many agents call this at once (single-flight) or another daemon
 *  races it (cross-process lock + skip-if-just-refreshed). See the concurrency
 *  notes near REFRESH_LOCK_FILE for why this matters (reuse → token_revoked). */
export async function refreshStoredNativeOAuth(options: { force?: boolean; sourceFile?: string } = {}): Promise<{ ok: boolean; message: string; terminal?: boolean }> {
  const { force = false, sourceFile = getCodexAuthSourceFile() } = options;
  // 0. DEAD latch: a prior terminal revoke means the refresh token is gone.
  // Re-POSTing it can't recover and risks tripping further family revokes —
  // short-circuit until a re-auth lands and clears the latch.
  const dead = getCodexAuthDead();
  if (dead) {
    return { ok: false, terminal: true, message: `Codex sign-in is revoked/expired (since ${dead.since}); re-authenticate to resume.` };
  }
  // 1. In-process single-flight: concurrent callers share ONE refresh. (A force
  // refresh still piggybacks on an in-flight one — sharing is what prevents the
  // double-POST reuse→revoke; the caller retries its request afterward.)
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefreshStoredNativeOAuth(sourceFile, force);
  try {
    return await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

function refreshedWithinSkipWindow(lastRefreshIso: string | undefined): boolean {
  if (!lastRefreshIso) return false;
  const last = Date.parse(lastRefreshIso);
  return Number.isFinite(last) && Date.now() - last < REFRESH_SKIP_IF_WITHIN_MS;
}

async function doRefreshStoredNativeOAuth(_sourceFile: string, force = false): Promise<{ ok: boolean; message: string; terminal?: boolean }> {
  // Snapshot the RT we INTEND to spend BEFORE we queue on the lock. If a sibling
  // rotates the token while we wait, the on-disk RT will differ post-lock and we
  // reuse theirs rather than spending our now-stale one (read-before-spend).
  const preLockRefreshToken = loadLocalAuthState().codexOauth?.refreshToken;
  // lockFd starts null + the lock is acquired INSIDE the try, so any throw from
  // acquireRefreshLock (e.g. a state-dir mkdir EACCES) still returns ok:false
  // rather than rejecting the caller's model request.
  let lockFd: number | null = null;
  try {
    // 2. Cross-process lock — only one process refreshes at a time.
    lockFd = await acquireRefreshLock();
    // Re-read AFTER acquiring the lock: another holder may have just rotated
    // the token while we waited. Using the freshest on-disk RT (never a stale
    // snapshot) is what prevents submitting an already-consumed RT.
    const local = loadLocalAuthState();
    const refreshToken = local.codexOauth?.refreshToken;
    if (!refreshToken) {
      return { ok: false, message: 'No locally stored native refresh token is available.' };
    }
    // 3. Skip if a sibling just refreshed — reuse their token instead of POSTing
    // the now-rotated RT again (which would trip reuse-detection). Two signals:
    //   (a) value-based — the on-disk RT changed vs the one we meant to spend
    //       (a sibling rotated it while we queued on the lock), OR
    //   (b) time-based — it was refreshed within the skip window.
    const rotatedWhileWaiting = Boolean(preLockRefreshToken) && refreshToken !== preLockRefreshToken;
    // `force` (a 401 rejected the current access token) bypasses the TIME-based
    // skip — a refresh 2 min ago doesn't help if the token is being rejected NOW,
    // and the on-disk RT is the unused output of that refresh so spending it is a
    // first use, not a reuse. We still honor `rotatedWhileWaiting`: a sibling that
    // rotated while we queued already produced a fresh, valid token — reuse it
    // rather than forcing a second rotation.
    if (rotatedWhileWaiting || (!force && refreshedWithinSkipWindow(local.codexOauth?.lastRefresh))) {
      return { ok: true, message: 'Token was just refreshed by another holder; reusing it.' };
    }
    const tokens = await refreshTokenImpl(refreshToken);
    // Persist to CLEMENTINE'S OWN vault only. We deliberately do NOT write the
    // rotated token back to ~/.codex/auth.json (the external Codex CLI's file):
    // pushing our rotating RT there lets a separate `codex` invocation consume
    // it and trip reuse-detection. Clementine owns its grant; the codex CLI owns
    // its own. (Initial login/import still seeds the CLI file — see those paths.)
    saveLocalAuthState({
      importedAt: new Date().toISOString(),
      source: local.source ?? 'native',
      codexOauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        accountId: tokens.accountId ?? local.codexOauth?.accountId,
        lastRefresh: tokens.lastRefresh,
      },
    });
    return { ok: true, message: 'Native ChatGPT/Codex tokens refreshed.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: number } | null)?.status;
    const kind = classifyCodexAuthError({ message, status });
    if (kind === 'terminal') {
      // The token family is gone — re-POSTing it can't recover and risks more
      // family revokes. Latch DEAD so callers stop hammering until re-auth.
      markCodexAuthDead(message);
      return { ok: false, terminal: true, message };
    }
    // Transient (rate-limit / backend blip / network): the token is still valid;
    // do NOT latch — let the caller retry.
    return { ok: false, message };
  } finally {
    releaseRefreshLock(lockFd);
  }
}

export async function bootstrapCodexAuth(sourceFile = getCodexAuthSourceFile()): Promise<{ ok: boolean; message: string }> {
  const state = getCodexBootstrapState(sourceFile);

  // 1. Clementine already holds its OWN grant in the vault → keep it.
  if (state.localCodex?.accessToken && state.localCodex?.refreshToken) {
    return { ok: true, message: 'Codex OAuth credentials are already stored in Clementine’s own vault.' };
  }

  // 2. No vault grant yet. An interactive TTY can complete the loopback browser
  //    flow — Clem's own INDEPENDENT grant of the shared OAuth client.
  const interactive = Boolean(process.stdout?.isTTY);
  if (interactive) {
    const nativeLogin = await loginWithNativeOAuth(sourceFile);
    if (nativeLogin.ok && getCodexBootstrapState(sourceFile).localCodex?.refreshToken) {
      return nativeLogin;
    }
  }

  // 3. Headless (or native-login failed) → DEVICE-CODE login. No browser, no
  //    loopback, and crucially NO Codex CLI: Clem deliberately does NOT install,
  //    run, or import from the `codex` CLI. That coupling (running off / importing
  //    ~/.codex/auth.json) is exactly what let a `codex logout` or a concurrent
  //    `codex` run sign Clementine out. Clem owns its own grant, full stop.
  return loginWithCodexDeviceCode(({ userCode, verificationUri }) => {
    console.log('\nTo sign in to ChatGPT/Codex from any device:');
    console.log(`  1. Open: ${verificationUri}`);
    console.log(`  2. Enter the code: ${userCode}\n`);
    console.log('Waiting for sign-in… (Ctrl+C to cancel)');
  });
}

export function importCodexCliAuth(sourceFile = getCodexAuthSourceFile()): { ok: boolean; message: string } {
  const source = loadCodexCliAuth(sourceFile);
  if (!source?.tokens?.access_token || !source.tokens.refresh_token) {
    return {
      ok: false,
      message: `No reusable Codex OAuth tokens found in ${sourceFile}.`,
    };
  }

  saveLocalAuthState({
    importedAt: new Date().toISOString(),
    source: 'codex_cli',
    codexOauth: {
      accessToken: source.tokens.access_token,
      refreshToken: source.tokens.refresh_token,
      idToken: source.tokens.id_token,
      accountId: source.tokens.account_id,
      lastRefresh: source.last_refresh,
    },
  });

  return {
    ok: true,
    message: `Imported Codex OAuth credentials from ${sourceFile}.`,
  };
}

export function clearImportedAuth(): void {
  rmSync(AUTH_STATE_FILE, { force: true });
  clearCodexAuthDead();
}

export function getAuthStatus(): AuthStatus {
  const local = loadLocalAuthState();
  const codexCli = loadCodexCliAuth();
  const codexAuthSourceFile = getCodexAuthSourceFile();
  const localCodex = local.codexOauth;
  const openaiApiKeyPresent = Boolean(getOpenAiApiKey());
  const codexOauthPresent = Boolean(localCodex?.accessToken && localCodex?.refreshToken);

  // Shared-family detection: Clem's grant is coupled to the Codex CLI's rotating
  // refresh-token family ONLY when it was explicitly imported from the CLI
  // (legacy `auth import-codex`, source 'codex_cli'). Clem no longer runs off
  // ~/.codex/auth.json, so a mere present CLI file is NOT coupling. In the
  // coupled state a `codex logout` revokes the family server-side and signs Clem
  // out — the user should re-login to mint an independent grant.
  const codexSharedWithCli = codexOauthPresent && local.source === 'codex_cli';
  const sharedHint = ' ⚠ This sign-in was imported from the Codex CLI — signing out of the CLI (`codex logout`) will sign Clementine out too. Run `clementine auth login-device` (or desktop → Re-authenticate) to give Clementine its own independent sign-in.';
  // Tailored hint for someone who used to run off the CLI file before the decouple.
  const legacyCliFilePresent = Boolean(codexCli?.tokens?.access_token && codexCli.tokens.refresh_token);

  if (AUTH_MODE === 'api_key') {
    return {
      mode: AUTH_MODE,
      configured: openaiApiKeyPresent,
      source: openaiApiKeyPresent ? 'env' : 'none',
      message: openaiApiKeyPresent
        ? 'Configured for API-key runtime.'
        : 'Missing OPENAI_API_KEY for API-key runtime.',
      openaiApiKeyPresent,
      codexOauthPresent,
      codexAccountId: localCodex?.accountId,
      codexLastRefresh: localCodex?.lastRefresh,
      codexImportPath: codexAuthSourceFile,
      codexSharedWithCli,
    };
  }

  // claude_oauth previously had NO branch here, so a Claude-subscription user
  // fell through to the CODEX token checks below and always read as
  // unconfigured — which the old boot-time throw turned into a daemon that
  // crash-looped on every launch (live user report 2026-07-16: Claude-only
  // sign-in, bricked after settings). Checks are FILE-only (vault grant or
  // Claude Code's credentials file) — never the macOS keychain, which can
  // block on an Allow prompt and must not be touched by a silent status read.
  if (AUTH_MODE === 'claude_oauth') {
    const claudePresent = claudeVaultFallbackReady() || hasClaudeCodeCredentialFile();
    return {
      mode: AUTH_MODE,
      configured: claudePresent,
      source: claudePresent ? 'local_store' : 'none',
      message: claudePresent
        ? 'Claude subscription sign-in is stored locally.'
        : 'AUTH_MODE=claude_oauth but no Claude sign-in was found. Open Settings → Models & routing → Re-authenticate to sign in with Claude.',
      openaiApiKeyPresent,
      codexOauthPresent,
      codexAccountId: localCodex?.accountId,
      codexLastRefresh: localCodex?.lastRefresh,
      codexImportPath: codexAuthSourceFile,
      codexSharedWithCli,
    };
  }

  if (codexOauthPresent) {
    return {
      mode: AUTH_MODE,
      configured: true,
      source: local.source === 'native' ? 'native' : 'local_store',
      message: (local.source === 'native'
        ? 'Native ChatGPT/Codex credentials are stored locally. Codex CLI is optional.'
        : 'Codex OAuth credentials are imported locally. Codex CLI is optional.')
        + (codexSharedWithCli ? sharedHint : ''),
      openaiApiKeyPresent,
      codexOauthPresent,
      codexAccountId: localCodex?.accountId,
      codexLastRefresh: localCodex?.lastRefresh,
      codexImportPath: codexAuthSourceFile,
      codexSharedWithCli,
    };
  }

  // No vault grant. A present ~/.codex/auth.json is NO LONGER usable by Clem —
  // it must hold its own grant. Point the user at the (remote-capable) login.
  return {
    mode: AUTH_MODE,
    configured: false,
    source: 'none',
    message: legacyCliFilePresent
      ? 'No Clementine Codex sign-in. A Codex CLI sign-in exists but Clementine no longer uses it (so a `codex logout` can’t sign you out). Run `clementine auth login-device` (or desktop → Re-authenticate) to give Clementine its own independent sign-in.'
      : 'No Codex OAuth credentials found. Run `clementine auth login-device` (remote/headless), `clementine auth login-native` (local browser), or use the desktop setup flow to sign in with ChatGPT.',
    openaiApiKeyPresent,
    codexOauthPresent,
    codexImportPath: codexAuthSourceFile,
    codexSharedWithCli,
  };
}

export function formatAuthStatus(status = getAuthStatus()): string {
  return [
    `mode: ${status.mode}`,
    `configured: ${status.configured ? 'yes' : 'no'}`,
    `source: ${status.source}`,
    `api_key_present: ${status.openaiApiKeyPresent ? 'yes' : 'no'}`,
    `codex_oauth_present: ${status.codexOauthPresent ? 'yes' : 'no'}`,
    status.codexSharedWithCli ? `codex_shared_with_cli: yes (a CLI logout will revoke this — run \`clementine auth login-device\` to decouple)` : '',
    status.codexAccountId ? `codex_account_id: ${status.codexAccountId}` : '',
    status.codexLastRefresh ? `codex_last_refresh: ${status.codexLastRefresh}` : '',
    status.codexImportPath ? `codex_import_path: ${status.codexImportPath}` : '',
    `message: ${status.message}`,
  ].filter(Boolean).join('\n');
}
