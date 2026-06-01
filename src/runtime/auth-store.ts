import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AUTH_MODE, BASE_DIR, CODEX_EXECUTABLE, CODEX_INSTALL_PACKAGE, getOpenAiApiKey, getRuntimeEnv } from '../config.js';
import type { AuthStatus } from '../types.js';
import { loginWithNativeCodexOAuth, refreshNativeCodexTokens } from './codex-native-oauth.js';

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

let inflightRefresh: Promise<{ ok: boolean; message: string }> | null = null;

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

  const cli = loadCodexCliAuth();
  if (cli?.tokens?.access_token && cli.tokens.refresh_token) {
    return {
      accessToken: cli.tokens.access_token,
      refreshToken: cli.tokens.refresh_token,
      idToken: cli.tokens.id_token,
      accountId: cli.tokens.account_id,
      lastRefresh: cli.last_refresh,
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
  if (state.localCodex?.accessToken && state.localCodex?.refreshToken) {
    return {
      available: true,
      source: 'local_store',
      accountId: state.localCodex.accountId,
      lastRefresh: state.localCodex.lastRefresh,
    };
  }
  if (state.codexCli?.access_token && state.codexCli?.refresh_token) {
    return {
      available: true,
      source: 'codex_cli',
      accountId: state.codexCli.account_id,
      lastRefresh: state.codexCliLastRefresh,
    };
  }
  return {
    available: false,
    source: 'none',
  };
}

export function isCodexCliAvailable(): boolean {
  const result = spawnSync(CODEX_EXECUTABLE, ['--version'], {
    stdio: 'ignore',
    env: process.env,
  });
  return result.status === 0;
}

export function getCodexInstallHint(): string {
  return `Install Codex first: npm install -g ${CODEX_INSTALL_PACKAGE}`;
}

// (writeCodexAuthFile removed) Clementine no longer mirrors its rotating token
// into ~/.codex/auth.json — login + refresh persist to its OWN vault only, so a
// separate `codex` CLI invocation can't consume/rotate the shared family and
// trip reuse-detection (token_revoked). The CLI file is still READ as a one-time
// import bootstrap (loadCodexCliAuth), never written.

function runInteractiveCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export async function installCodexCli(): Promise<{ ok: boolean; message: string }> {
  // Fail fast and honestly when npm itself is missing. Without this the
  // error surfaced to the user is "Failed to install Codex globally"
  // with no hint that Node is the actual missing piece — observed on
  // fresh Macs where Clementine was the user's first attempt at any
  // Node-based tool.
  const npmProbe = spawnSync('npm', ['--version'], { stdio: 'ignore', env: process.env });
  if (npmProbe.status !== 0) {
    return {
      ok: false,
      message: 'Cannot install Codex: npm is not on PATH. Install Node.js from https://nodejs.org (LTS is fine), reopen your terminal, then retry.',
    };
  }
  const installed = await runInteractiveCommand('npm', ['install', '-g', CODEX_INSTALL_PACKAGE]);
  if (!installed) {
    return {
      ok: false,
      message: `Failed to install Codex globally. Try: npm install -g ${CODEX_INSTALL_PACKAGE}`,
    };
  }
  return {
    ok: true,
    message: `Installed Codex globally from ${CODEX_INSTALL_PACKAGE}.`,
  };
}

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

/** Refresh the stored native Codex OAuth tokens. SAFE under concurrency: the
 *  rotating refresh token is used for at most one refresh per token-age window,
 *  even when many agents call this at once (single-flight) or another daemon
 *  races it (cross-process lock + skip-if-just-refreshed). See the concurrency
 *  notes near REFRESH_LOCK_FILE for why this matters (reuse → token_revoked). */
export async function refreshStoredNativeOAuth(sourceFile = getCodexAuthSourceFile()): Promise<{ ok: boolean; message: string }> {
  // 1. In-process single-flight: concurrent callers share ONE refresh.
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefreshStoredNativeOAuth(sourceFile);
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

async function doRefreshStoredNativeOAuth(_sourceFile: string): Promise<{ ok: boolean; message: string }> {
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
    // 3. Skip if a sibling just refreshed — reuse their token instead of
    // POSTing the now-rotated RT again (which would trip reuse-detection).
    if (refreshedWithinSkipWindow(local.codexOauth?.lastRefresh)) {
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
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    releaseRefreshLock(lockFd);
  }
}

export async function runCodexLogin(): Promise<{ ok: boolean; message: string }> {
  if (!isCodexCliAvailable()) {
    return {
      ok: false,
      message: `Codex CLI is not available on PATH. ${getCodexInstallHint()}`,
    };
  }
  const loggedIn = await runInteractiveCommand(CODEX_EXECUTABLE, ['login']);
  return {
    ok: loggedIn,
    message: loggedIn ? 'Codex login completed.' : 'Codex login did not complete successfully.',
  };
}

export async function bootstrapCodexAuth(sourceFile = getCodexAuthSourceFile()): Promise<{ ok: boolean; message: string }> {
  let state = getCodexBootstrapState(sourceFile);
  const hasReusableAuth = Boolean(
    (state.localCodex?.accessToken && state.localCodex?.refreshToken)
    || (state.codexCli?.access_token && state.codexCli?.refresh_token),
  );

  if (!hasReusableAuth) {
    const nativeLogin = await loginWithNativeOAuth(sourceFile);
    if (!nativeLogin.ok) {
      if (!isCodexCliAvailable()) {
        const installResult = await installCodexCli();
        if (!installResult.ok) {
          return nativeLogin;
        }
      }
      const loginResult = await runCodexLogin();
      if (!loginResult.ok) {
        return nativeLogin;
      }
    }
    state = getCodexBootstrapState(sourceFile);
  }

  if (!isCodexCliAvailable()) {
    const installResult = await installCodexCli();
    if (!installResult.ok) {
      return installResult;
    }
  }

  const hasImportedAuth = Boolean(state.localCodex?.accessToken && state.localCodex?.refreshToken);
  const hasCodexCliAuth = Boolean(state.codexCli?.access_token && state.codexCli?.refresh_token);

  if (!hasImportedAuth && !hasCodexCliAuth) {
    return {
      ok: false,
      message: `Codex login finished, but no reusable credentials were found at ${sourceFile}.`,
    };
  }

  const importResult = importCodexCliAuth(sourceFile);
  if (importResult.ok) {
    return importResult;
  }

  return {
    ok: hasImportedAuth || hasCodexCliAuth,
    message: hasImportedAuth || hasCodexCliAuth
      ? 'Codex login completed and reusable credentials are available.'
      : importResult.message,
  };
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
}

export function getAuthStatus(): AuthStatus {
  const local = loadLocalAuthState();
  const codexCli = loadCodexCliAuth();
  const codexAuthSourceFile = getCodexAuthSourceFile();
  const localCodex = local.codexOauth;
  const openaiApiKeyPresent = Boolean(getOpenAiApiKey());
  const codexOauthPresent = Boolean(localCodex?.accessToken && localCodex?.refreshToken);

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
    };
  }

  if (codexOauthPresent) {
    return {
      mode: AUTH_MODE,
      configured: true,
      source: local.source === 'native' ? 'native' : 'local_store',
      message: local.source === 'native'
        ? 'Native ChatGPT/Codex credentials are stored locally. Codex CLI is optional.'
        : 'Codex OAuth credentials are imported locally. Codex CLI is optional.',
      openaiApiKeyPresent,
      codexOauthPresent,
      codexAccountId: localCodex?.accountId,
      codexLastRefresh: localCodex?.lastRefresh,
      codexImportPath: codexAuthSourceFile,
    };
  }

  if (codexCli?.tokens?.access_token && codexCli.tokens.refresh_token) {
    return {
      mode: AUTH_MODE,
      configured: isCodexCliAvailable(),
      source: 'codex_cli',
      message: isCodexCliAvailable()
        ? 'Codex CLI credentials detected. Import is optional; the Codex-backed runtime can use the existing CLI login.'
        : `Codex CLI credentials detected, but the Codex executable is not available on PATH. ${getCodexInstallHint()}`,
      openaiApiKeyPresent,
      codexOauthPresent,
      codexAccountId: codexCli.tokens.account_id,
      codexLastRefresh: codexCli.last_refresh,
      codexImportPath: codexAuthSourceFile,
    };
  }

  return {
    mode: AUTH_MODE,
    configured: false,
    source: 'none',
    message: `No Codex OAuth credentials found. Sign in with ChatGPT from the desktop setup flow, or import an existing Codex CLI auth file from ${codexAuthSourceFile}.`,
    openaiApiKeyPresent,
    codexOauthPresent,
    codexImportPath: codexAuthSourceFile,
  };
}

export function formatAuthStatus(status = getAuthStatus()): string {
  return [
    `mode: ${status.mode}`,
    `configured: ${status.configured ? 'yes' : 'no'}`,
    `source: ${status.source}`,
    `api_key_present: ${status.openaiApiKeyPresent ? 'yes' : 'no'}`,
    `codex_oauth_present: ${status.codexOauthPresent ? 'yes' : 'no'}`,
    status.codexAccountId ? `codex_account_id: ${status.codexAccountId}` : '',
    status.codexLastRefresh ? `codex_last_refresh: ${status.codexLastRefresh}` : '',
    status.codexImportPath ? `codex_import_path: ${status.codexImportPath}` : '',
    `message: ${status.message}`,
  ].filter(Boolean).join('\n');
}
