import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveClementineHomeDirectory } from './clementine-paths.js';

export interface CodexOAuthTokens {
  grantId?: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  lastRefresh: string;
}

/** Written only for grants minted independently by Clementine. */
export const CODEX_GRANT_PROVENANCE = 'clementine-oauth-v1' as const;

export interface ClementineCodexAuthPaths {
  baseDir: string;
  stateDir: string;
  authFile: string;
  authDeadFile: string;
}

/** Resolve the same state tree as the daemon, including isolated/custom homes. */
export function resolveClementineCodexAuthPaths(
  configuredHome = process.env.CLEMENTINE_HOME,
  userHome?: string,
): ClementineCodexAuthPaths {
  const baseDir = resolveClementineHomeDirectory(configuredHome, userHome);
  const stateDir = path.join(baseDir, 'state');
  return {
    baseDir,
    stateDir,
    authFile: path.join(stateDir, 'auth.json'),
    authDeadFile: path.join(stateDir, 'codex-auth-dead.json'),
  };
}

interface ClementineAuthState {
  source?: 'codex_cli' | 'native';
  codexOauth?: {
    grantProvenance?: unknown;
    grantId?: unknown;
    accessToken?: unknown;
    refreshToken?: unknown;
    idToken?: unknown;
    accountId?: unknown;
    lastRefresh?: unknown;
  };
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

export function getCodexJwtExpiryMs(token?: string): number | null {
  const exp = parseJwtPayload(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

export function extractCodexAccountId(idToken?: string, accessToken?: string): string | undefined {
  for (const payload of [parseJwtPayload(idToken), parseJwtPayload(accessToken)]) {
    const auth = payload?.['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object' && auth !== null) {
      const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === 'string' && accountId) return accountId;
    }
  }
  return undefined;
}

function normalizeTokenSet(input: NonNullable<ClementineAuthState['codexOauth']>): CodexOAuthTokens | null {
  if (typeof input.accessToken !== 'string' || !input.accessToken) return null;
  if (typeof input.refreshToken !== 'string' || !input.refreshToken) return null;
  const idToken = typeof input.idToken === 'string' ? input.idToken : undefined;
  const accountId = typeof input.accountId === 'string'
    ? input.accountId
    : extractCodexAccountId(idToken, input.accessToken);
  return {
    grantId: typeof input.grantId === 'string' ? input.grantId : undefined,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken,
    accountId,
    lastRefresh: typeof input.lastRefresh === 'string' ? input.lastRefresh : new Date().toISOString(),
  };
}

/**
 * Load only a Clementine-owned Codex grant.
 *
 * A grant explicitly imported from the external Codex CLI is intentionally
 * rejected: Codex refresh tokens rotate with reuse detection, so two programs
 * refreshing the same family can revoke each other. Missing/legacy provenance
 * also fails closed and sends setup through a fresh browser login instead.
 */
export function loadClementineOwnedCodexOAuthTokens(
  authFile: string,
  authDeadFile?: string,
): CodexOAuthTokens | null {
  if (!existsSync(authFile)) return null;
  let state: ClementineAuthState;
  try {
    const parsed = JSON.parse(readFileSync(authFile, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    state = parsed as ClementineAuthState;
  } catch {
    return null;
  }

  if (
    state.source !== 'native'
    || state.codexOauth?.grantProvenance !== CODEX_GRANT_PROVENANCE
    || typeof state.codexOauth.grantId !== 'string'
    || !state.codexOauth.grantId
  ) return null;

  // A DEAD latch is generation-bound. A crash can leave the old grant's latch
  // behind after another process atomically stores a fresh grant; that stale
  // file must not make desktop setup reject the new sign-in. Missing/malformed
  // generation metadata remains fail-closed for compatibility with old builds.
  if (authDeadFile && existsSync(authDeadFile)) {
    try {
      const parsed = JSON.parse(readFileSync(authDeadFile, 'utf-8')) as { grantId?: unknown };
      const deadGrantId = typeof parsed?.grantId === 'string' && parsed.grantId
        ? parsed.grantId
        : undefined;
      if (!deadGrantId || deadGrantId === state.codexOauth.grantId) return null;
    } catch {
      return null;
    }
  }
  return normalizeTokenSet(state.codexOauth);
}

const AUTH_LOCK_WAIT_MS = 90_000;
const AUTH_LOCK_STALE_MS = 90_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function acquireAuthWriteLock(lockFile: string): Promise<number | null> {
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS;
  mkdirSync(path.dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx');
      try { writeFileSync(fd, `${process.pid}`); } catch { /* best-effort marker */ }
      return fd;
    } catch {
      try {
        const st = statSync(lockFile);
        if (Date.now() - st.mtimeMs > AUTH_LOCK_STALE_MS) {
          rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return null;
      await delay(150);
    }
  }
}

function releaseAuthWriteLock(lockFile: string, fd: number | null): void {
  if (fd === null) return;
  try { closeSync(fd); } catch { /* ignore */ }
  try { rmSync(lockFile, { force: true }); } catch { /* ignore */ }
}

/**
 * Atomically persist a fresh Clementine-owned grant, then lift the daemon's
 * terminal-auth latch. The latch is removed only after the token write lands;
 * a failed write must leave the prior revoked state intact.
 */
export async function persistClementineOwnedCodexOAuthTokens(
  authFile: string,
  authDeadFile: string,
  tokens: CodexOAuthTokens,
): Promise<void> {
  const lockFile = path.join(path.dirname(authFile), 'codex-refresh.lock');
  const lockFd = await acquireAuthWriteLock(lockFile);
  if (lockFd === null) {
    throw new Error('Timed out waiting to safely store the new Codex sign-in. Please try again.');
  }
  const grantId = tokens.grantId || randomUUID();
  const state = {
    importedAt: new Date().toISOString(),
    source: 'native' as const,
    codexOauth: {
      grantProvenance: CODEX_GRANT_PROVENANCE,
      grantId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accountId: tokens.accountId,
      lastRefresh: tokens.lastRefresh,
    },
  };

  try {
    mkdirSync(path.dirname(authFile), { recursive: true });
    const tmp = `${authFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmp, authFile);
      try { chmodSync(authFile, 0o600); } catch { /* best-effort; rename normally preserves mode */ }
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }

    rmSync(authDeadFile, { force: true });
  } finally {
    releaseAuthWriteLock(lockFile, lockFd);
  }
}
