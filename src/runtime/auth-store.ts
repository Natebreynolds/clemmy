import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AUTH_MODE, BASE_DIR, CODEX_AUTH_SOURCE_FILE, CODEX_EXECUTABLE, CODEX_INSTALL_PACKAGE, OPENAI_API_KEY } from '../config.js';
import type { AuthStatus } from '../types.js';
import { loginWithNativeCodexOAuth, refreshNativeCodexTokens } from './codex-native-oauth.js';

const AUTH_STATE_FILE = path.join(BASE_DIR, 'state', 'auth.json');

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

function saveLocalAuthState(state: LocalAuthState): void {
  mkdirSync(path.dirname(AUTH_STATE_FILE), { recursive: true });
  writeFileSync(AUTH_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function loadCodexCliAuth(sourceFile = CODEX_AUTH_SOURCE_FILE): CodexCliAuthFile | null {
  if (!existsSync(sourceFile)) return null;
  try {
    return JSON.parse(readFileSync(sourceFile, 'utf-8')) as CodexCliAuthFile;
  } catch {
    return null;
  }
}

function getCodexBootstrapState(sourceFile = CODEX_AUTH_SOURCE_FILE): CodexBootstrapState {
  const local = loadLocalAuthState();
  const codexCli = loadCodexCliAuth(sourceFile);
  return {
    localCodex: local.codexOauth,
    codexCli: codexCli?.tokens,
    codexCliLastRefresh: codexCli?.last_refresh,
  };
}

export function getCodexBootstrapAvailability(sourceFile = CODEX_AUTH_SOURCE_FILE): CodexBootstrapAvailability {
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

function writeCodexAuthFile(tokens: NonNullable<LocalAuthState['codexOauth']>, sourceFile = CODEX_AUTH_SOURCE_FILE): void {
  mkdirSync(path.dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.idToken ?? null,
      access_token: tokens.accessToken ?? null,
      refresh_token: tokens.refreshToken ?? null,
      account_id: tokens.accountId ?? null,
    },
    last_refresh: tokens.lastRefresh ?? new Date().toISOString(),
  }, null, 2), 'utf-8');
}

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

export async function loginWithNativeOAuth(sourceFile = CODEX_AUTH_SOURCE_FILE): Promise<{ ok: boolean; message: string }> {
  try {
    const tokens = await loginWithNativeCodexOAuth();
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
    writeCodexAuthFile({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accountId: tokens.accountId,
      lastRefresh: tokens.lastRefresh,
    }, sourceFile);
    return {
      ok: true,
      message: `Native ChatGPT/Codex sign-in completed and credentials were saved to ${sourceFile}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function refreshStoredNativeOAuth(sourceFile = CODEX_AUTH_SOURCE_FILE): Promise<{ ok: boolean; message: string }> {
  const local = loadLocalAuthState();
  const refreshToken = local.codexOauth?.refreshToken;
  if (!refreshToken) {
    return {
      ok: false,
      message: 'No locally stored native refresh token is available.',
    };
  }
  try {
    const tokens = await refreshNativeCodexTokens(refreshToken);
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
    writeCodexAuthFile({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accountId: tokens.accountId ?? local.codexOauth?.accountId,
      lastRefresh: tokens.lastRefresh,
    }, sourceFile);
    return {
      ok: true,
      message: 'Native ChatGPT/Codex tokens refreshed and synced.',
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
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

export async function bootstrapCodexAuth(sourceFile = CODEX_AUTH_SOURCE_FILE): Promise<{ ok: boolean; message: string }> {
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

export function importCodexCliAuth(sourceFile = CODEX_AUTH_SOURCE_FILE): { ok: boolean; message: string } {
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
  const localCodex = local.codexOauth;
  const openaiApiKeyPresent = Boolean(OPENAI_API_KEY);
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
      codexImportPath: CODEX_AUTH_SOURCE_FILE,
    };
  }

  if (codexOauthPresent) {
    return {
      mode: AUTH_MODE,
      configured: true,
      source: local.source === 'native' ? 'native' : 'local_store',
      message: isCodexCliAvailable()
        ? local.source === 'native'
          ? 'Native ChatGPT/Codex credentials are stored locally and Codex CLI runtime is available.'
          : 'Codex OAuth credentials imported locally and Codex CLI is available.'
        : `Codex OAuth credentials imported locally, but Codex CLI is not available on PATH. ${getCodexInstallHint()}`,
      openaiApiKeyPresent,
      codexOauthPresent,
      codexAccountId: localCodex?.accountId,
      codexLastRefresh: localCodex?.lastRefresh,
      codexImportPath: CODEX_AUTH_SOURCE_FILE,
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
      codexImportPath: CODEX_AUTH_SOURCE_FILE,
    };
  }

  return {
    mode: AUTH_MODE,
    configured: false,
    source: 'none',
    message: isCodexCliAvailable()
      ? `No Codex OAuth credentials found. Expected source file: ${CODEX_AUTH_SOURCE_FILE}`
      : `Codex executable not found on PATH. ${getCodexInstallHint()}`,
    openaiApiKeyPresent,
    codexOauthPresent,
    codexImportPath: CODEX_AUTH_SOURCE_FILE,
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
