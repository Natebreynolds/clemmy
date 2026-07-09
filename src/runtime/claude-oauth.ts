/**
 * Claude (Anthropic) subscription OAuth wallet — peer to codex-native-oauth.ts.
 *
 * Preferred path: Clementine's own Claude OAuth grant, stored in the local
 * vault and refreshed/rotated by Clementine before expiry. Fallback path: the
 * user's existing Claude Code login (macOS Keychain `Claude Code-credentials`,
 * or ~/.claude/.credentials.json on Linux). We deliberately do NOT rotate the
 * Claude Code refresh token, because that would desync the user's CLI login.
 *
 * BILLING GUARANTEE (the owner's top concern): this wallet ONLY ever returns an
 * `sk-ant-oat01-` subscription OAuth token. An `sk-ant-api03-` API key (which
 * would bill pay-per-token) is REFUSED — fail closed. The adapter sends this as
 * a Bearer and never sets x-api-key, so a subscription user can never be
 * silently API-billed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { refreshClaudeTokens, type ClaudeTokenSet } from './claude-native-oauth.js';

const logger = pino({ name: 'clementine.claude-oauth' });

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OAT_PREFIX = 'sk-ant-oat01';
const API_KEY_PREFIX = 'sk-ant-api03';

// Clementine's OWN Claude grant (from the in-app login), decoupled from the
// Claude Code CLI keychain so we can rotate the refresh token freely. Preferred
// over the keychain when present.
const CLAUDE_VAULT_FILE = path.join(BASE_DIR, 'state', 'claude-auth.json');
const CLAUDE_VAULT_DEAD_FILE = path.join(BASE_DIR, 'state', 'claude-auth-dead.json');
const CLAUDE_VAULT_DEGRADED_FILE = path.join(BASE_DIR, 'state', 'claude-auth-degraded.json');

interface ClaudeVaultDeadState {
  refreshTokenHash: string;
  reason: string;
  since: string;
}

interface ClaudeVaultDegradedState {
  vaultTokenHash: string | null;
  reason: string;
  loggedAt: string;
}

/** A Clementine-owned vault refresh token the server has rejected with a
 *  permanent `invalid_grant` (revoked / rotated away / not found). Retrying it on
 *  every request only burns a doomed network round-trip and spams the log — the
 *  grant is dead until the user re-authenticates. Keyed by the token STRING so a
 *  re-auth (which writes a NEW token via saveClaudeTokens) auto-recovers. The
 *  persisted marker stores only the token HASH so the state survives daemon
 *  restarts without duplicating the secret. NULL means "no known-dead grant". */
let deadVaultRefreshToken: string | null = null;
let claudeVaultDeadFile = CLAUDE_VAULT_DEAD_FILE;
let claudeVaultDegradedFile = CLAUDE_VAULT_DEGRADED_FILE;

/** Dedupe the "falling back to the Claude Code subscription token" WARN: it fired
 *  on EVERY request while the vault grant was down. Log once per distinct reason;
 *  reset on re-auth so a future degradation logs again. */
let loggedFallbackReason: string | null = null;

function refreshTokenHash(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

function readClaudeVaultDeadState(): ClaudeVaultDeadState | null {
  if (!existsSync(claudeVaultDeadFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(claudeVaultDeadFile, 'utf-8')) as Partial<ClaudeVaultDeadState>;
    if (
      typeof parsed.refreshTokenHash === 'string' &&
      typeof parsed.reason === 'string' &&
      typeof parsed.since === 'string'
    ) {
      return {
        refreshTokenHash: parsed.refreshTokenHash,
        reason: parsed.reason,
        since: parsed.since,
      };
    }
  } catch { /* ignore corrupt marker; request path can rediscover */ }
  return null;
}

function isVaultRefreshTokenMarkedDead(refreshToken: string): boolean {
  if (deadVaultRefreshToken === refreshToken) return true;
  return readClaudeVaultDeadState()?.refreshTokenHash === refreshTokenHash(refreshToken);
}

function markClaudeVaultRefreshDead(refreshToken: string, reason: string): void {
  deadVaultRefreshToken = refreshToken;
  const refreshTokenHashValue = refreshTokenHash(refreshToken);
  try {
    const existing = readClaudeVaultDeadState();
    if (existing?.refreshTokenHash === refreshTokenHashValue) return;
    mkdirSync(path.dirname(claudeVaultDeadFile), { recursive: true });
    writeFileSync(
      claudeVaultDeadFile,
      JSON.stringify({
        refreshTokenHash: refreshTokenHashValue,
        reason: reason.slice(0, 300),
        since: new Date().toISOString(),
      }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
    try { chmodSync(claudeVaultDeadFile, 0o600); } catch { /* best-effort */ }
  } catch { /* best-effort; the in-memory latch still prevents same-process spam */ }
}

function clearClaudeVaultRefreshDead(): void {
  deadVaultRefreshToken = null;
  try { rmSync(claudeVaultDeadFile, { force: true }); } catch { /* ignore */ }
}

function readClaudeVaultDegradedState(): ClaudeVaultDegradedState | null {
  if (!existsSync(claudeVaultDegradedFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(claudeVaultDegradedFile, 'utf-8')) as Partial<ClaudeVaultDegradedState>;
    if (
      (typeof parsed.vaultTokenHash === 'string' || parsed.vaultTokenHash === null) &&
      typeof parsed.reason === 'string' &&
      typeof parsed.loggedAt === 'string'
    ) {
      return {
        vaultTokenHash: parsed.vaultTokenHash,
        reason: parsed.reason,
        loggedAt: parsed.loggedAt,
      };
    }
  } catch { /* ignore corrupt marker; request path can rewrite */ }
  return null;
}

function vaultFallbackHash(): string | null {
  const vault = getVaultClaudeTokens();
  const token = vault?.refreshToken || vault?.accessToken;
  return token ? refreshTokenHash(token) : null;
}

function shouldLogClaudeCodeFallback(reason: string): boolean {
  const vaultTokenHash = vaultFallbackHash();
  const memoryKey = `${vaultTokenHash ?? 'no-vault'}:${reason}`;
  if (loggedFallbackReason === memoryKey) return false;
  loggedFallbackReason = memoryKey;
  const persisted = readClaudeVaultDegradedState();
  // Once a vault grant is degraded, don't re-warn on every daemon restart. The
  // invalid_grant warning already carries the re-auth action; this line is just
  // the degraded-route notice.
  if (persisted?.vaultTokenHash === vaultTokenHash) return false;
  try {
    mkdirSync(path.dirname(claudeVaultDegradedFile), { recursive: true });
    writeFileSync(
      claudeVaultDegradedFile,
      JSON.stringify({
        vaultTokenHash,
        reason,
        loggedAt: new Date().toISOString(),
      }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
    try { chmodSync(claudeVaultDegradedFile, 0o600); } catch { /* best-effort */ }
  } catch { /* best-effort; in-memory latch still suppresses same-process spam */ }
  return true;
}

function clearClaudeVaultDegraded(): void {
  loggedFallbackReason = null;
  try { rmSync(claudeVaultDegradedFile, { force: true }); } catch { /* ignore */ }
}

/** Persist our own Claude tokens (from the in-app login or a refresh). 0600. */
export function saveClaudeTokens(tokens: ClaudeTokenSet): void {
  mkdirSync(path.dirname(CLAUDE_VAULT_FILE), { recursive: true });
  writeFileSync(CLAUDE_VAULT_FILE, JSON.stringify(tokens, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // A freshly-written grant supersedes any prior dead/degraded state — clear the
  // markers so the next request re-attempts refresh and re-arms fallback logging.
  clearClaudeVaultRefreshDead();
  clearClaudeVaultDegraded();
  try { chmodSync(CLAUDE_VAULT_FILE, 0o600); } catch { /* best-effort */ }
}

function readVaultClaudeTokens(): ClaudeOAuthTokens | null {
  if (!existsSync(CLAUDE_VAULT_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(CLAUDE_VAULT_FILE, 'utf-8')) as Record<string, unknown>;
    if (!j.accessToken) return null;
    return {
      accessToken: j.accessToken as string,
      refreshToken: j.refreshToken as string | undefined,
      expiresAt: typeof j.expiresAt === 'number' ? j.expiresAt : undefined,
      scopes: Array.isArray(j.scopes) ? (j.scopes as string[]) : undefined,
      source: 'vault',
    };
  } catch { return null; }
}

let vaultTokenReader = readVaultClaudeTokens;
function getVaultClaudeTokens(): ClaudeOAuthTokens | null {
  return vaultTokenReader();
}

export interface ClaudeOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scopes?: string[];
  subscriptionType?: string;
  source?: 'vault' | 'claude-code';
}

export class ClaudeAuthError extends Error {
  constructor(message: string, readonly kind: 'missing' | 'expired' | 'not_subscription' | 'parse') {
    super(message);
    this.name = 'ClaudeAuthError';
  }
}

function readRawCredentialJsonFromSystem(): string | null {
  // macOS: Keychain. -w prints the secret; may surface a one-time Allow prompt.
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (raw && raw.trim()) return raw.trim();
    } catch {
      // fall through to the file path
    }
  }
  // Linux / fallback: Claude Code's credentials file.
  const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
  if (existsSync(credFile)) {
    try { return readFileSync(credFile, 'utf-8'); } catch { /* ignore */ }
  }
  return null;
}

let rawCredentialReader = readRawCredentialJsonFromSystem;
function readRawCredentialJson(): string | null {
  return rawCredentialReader();
}

/** Parse Claude Code's stored credential blob into a token set. Tolerates the
 *  `{ claudeAiOauth: {...} }` wrapper Claude Code uses and a few aliases. */
export function parseClaudeCredential(raw: string): ClaudeOAuthTokens {
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new ClaudeAuthError('Claude credential is not valid JSON', 'parse'); }
  const o = (j.claudeAiOauth ?? j.oauth ?? j) as Record<string, unknown>;
  const accessToken = (o.accessToken ?? o.access_token) as string | undefined;
  if (!accessToken) throw new ClaudeAuthError('Claude credential has no access token', 'parse');
  return {
    accessToken,
    refreshToken: (o.refreshToken ?? o.refresh_token) as string | undefined,
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt
      : typeof o.expires_at === 'number' ? o.expires_at : undefined,
    scopes: Array.isArray(o.scopes) ? (o.scopes as string[]) : undefined,
    subscriptionType: (o.subscriptionType ?? o.subscription_type) as string | undefined,
  };
}

function getClaudeCodeTokens(): ClaudeOAuthTokens | null {
  const raw = readRawCredentialJson();
  if (!raw) return null;
  try { return { ...parseClaudeCredential(raw), source: 'claude-code' }; }
  catch { return null; }
}

/** Read the stored Claude OAuth tokens, preferring Clementine's OWN vault grant
 *  (from the in-app login) over the Claude Code CLI keychain. */
export function getStoredClaudeTokens(): ClaudeOAuthTokens | null {
  const vault = getVaultClaudeTokens();
  if (vault) return vault;
  return getClaudeCodeTokens();
}

const EXPIRY_SKEW_MS = 60_000;

/**
 * Resolve a usable Claude subscription access token, or throw a typed
 * ClaudeAuthError the runtime/UI can act on. The billing guarantee lives here:
 * an API-key (`api03`) credential is REFUSED — we never bill the API.
 */
/** The billing guarantee, as a pure function: returns the access token ONLY if
 *  it's a non-expired `oat01` subscription token; throws otherwise. Refusing an
 *  `api03` API key here is what makes silent pay-per-token billing impossible. */
export function assertSubscriptionToken(tokens: ClaudeOAuthTokens | null, nowMs: number = Date.now()): string {
  if (!tokens?.accessToken) {
    throw new ClaudeAuthError(
      'No Claude login found. Sign in to Claude Code (claude.ai Max/Pro subscription) first.',
      'missing',
    );
  }
  if (tokens.accessToken.startsWith(API_KEY_PREFIX)) {
    throw new ClaudeAuthError(
      'Found a Claude API key (sk-ant-api03-), which would bill pay-per-token. Clementine only runs Claude on a SUBSCRIPTION OAuth token (sk-ant-oat01-). Sign in to Claude Code with your Max/Pro plan.',
      'not_subscription',
    );
  }
  if (!tokens.accessToken.startsWith(OAT_PREFIX)) {
    throw new ClaudeAuthError(
      `Unrecognized Claude credential type (expected ${OAT_PREFIX}-). Re-authenticate Claude Code.`,
      'not_subscription',
    );
  }
  if (tokens.expiresAt && tokens.expiresAt <= nowMs + EXPIRY_SKEW_MS) {
    throw new ClaudeAuthError(
      'Claude subscription token has expired. Re-open Claude Code to refresh your login.',
      'expired',
    );
  }
  return tokens.accessToken;
}

export function loadClaudeAccessToken(): string {
  return assertSubscriptionToken(getStoredClaudeTokens());
}

export interface ClaudeAuthSnapshot {
  configured: boolean;
  reason?: string;
  plan?: string;
  expiresAt?: string;
  source?: ClaudeOAuthTokens['source'];
  refreshable?: boolean;
  degraded?: boolean;
}

const REFRESH_BEFORE_MS = 5 * 60_000;
let refreshClaudeTokensImpl = refreshClaudeTokens;

function tryClaudeCodeFallback(reason: string): string | null {
  const cli = getClaudeCodeTokens();
  if (!cli) return null;
  try {
    const token = assertSubscriptionToken(cli);
    if (shouldLogClaudeCodeFallback(reason)) {
      logger.warn({ reason }, 'Using Claude Code subscription token because Clementine Claude vault token is unavailable');
    }
    return token;
  } catch {
    return null;
  }
}

/** A 400 `invalid_grant` means the refresh token is PERMANENTLY dead (revoked /
 *  rotated away / not found) — retrying it will never succeed. Distinct from a
 *  transient timeout or 5xx, which SHOULD keep retrying. */
function isPermanentGrantFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid_grant/i.test(msg) || /refresh failed \(4\d\d\)/i.test(msg);
}

/** True once the vault refresh token has been rejected as `invalid_grant` and not
 *  yet replaced by a re-auth — surfaced for auth-status UI ("re-authenticate
 *  Claude"). Cheap: reads the vault file only, no network. */
export function claudeVaultRefreshDead(): boolean {
  const t = getVaultClaudeTokens();
  return !!t?.refreshToken && isVaultRefreshTokenMarkedDead(t.refreshToken);
}

/** Async loader that refreshes OUR vault token before expiry (rotating the
 *  refresh token). Never refreshes a Claude Code CLI keychain token — that
 *  would desync the user's CLI login. If the Clementine-owned vault grant is
 *  stale and cannot refresh, fall back to a valid Claude Code subscription token
 *  instead of letting a dead vault token shadow a working CLI login. Use this in
 *  the request path. */
export async function loadFreshClaudeAccessToken(): Promise<string> {
  let tokens = getStoredClaudeTokens();
  if (
    tokens?.source === 'vault' &&
    tokens.refreshToken &&
    tokens.accessToken?.startsWith(OAT_PREFIX) &&
    tokens.expiresAt && tokens.expiresAt <= Date.now() + REFRESH_BEFORE_MS
  ) {
    const refreshToken = tokens.refreshToken; // narrowed non-empty by the guard above
    if (isVaultRefreshTokenMarkedDead(refreshToken)) {
      // Grant already rejected as invalid_grant — skip the doomed network refresh
      // and go straight to fallback. Recovers automatically once a re-auth writes
      // a new token (saveClaudeTokens clears the dead marker).
      const fallback = tryClaudeCodeFallback('vault_refresh_dead');
      if (fallback) return fallback;
    } else {
      try {
        const refreshed = await refreshClaudeTokensImpl(refreshToken);
        saveClaudeTokens({
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? refreshToken, // persist the ROTATED token
          expiresAt: refreshed.expiresAt,
          scopes: refreshed.scopes ?? tokens.scopes,
        });
        tokens = getStoredClaudeTokens();
        logger.info('Claude subscription token refreshed');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isPermanentGrantFailure(err)) {
          // Mark the grant dead so we stop re-attempting it every request. Log
          // ONCE, loudly, with the fix — not once per call.
          markClaudeVaultRefreshDead(refreshToken, msg);
          logger.warn(
            { err: msg },
            'Clementine Claude vault grant is dead (invalid_grant) — re-authenticate Claude from Settings. Using the Claude Code subscription token meanwhile; this grant will not be retried until re-auth.',
          );
        } else {
          // Transient (timeout / 5xx / network) — keep retrying on the next call.
          logger.warn({ err: msg }, 'Claude token refresh failed (transient) — will retry');
        }
        const fallback = tryClaudeCodeFallback('vault_refresh_failed');
        if (fallback) return fallback;
      }
    }
  }
  try {
    return assertSubscriptionToken(tokens);
  } catch (err) {
    const fallbackAllowed =
      err instanceof ClaudeAuthError && (err.kind === 'expired' || err.kind === 'missing');
    if (tokens?.source === 'vault' && fallbackAllowed) {
      const fallback = tryClaudeCodeFallback(err.kind);
      if (fallback) return fallback;
    }
    throw err;
  }
}

/** True when a usable Claude subscription token is present (for auth-status UI). */
export function isClaudeSubscriptionReady(): boolean {
  try { loadClaudeAccessToken(); return true; } catch { return false; }
}

/** Cheap, side-effect-free check (the vault FILE only — never the macOS keychain
 *  or the network): is there a Clem-owned Claude token usable or refreshable as a
 *  FALLBACK brain? The brain-fallback probe (codex-client) must not block on a
 *  keychain prompt, so it uses THIS rather than loadFreshClaudeAccessToken. Only
 *  vault tokens qualify — a Claude Code keychain token can't be auto-refreshed by
 *  Clem (source !== 'vault'), so it's not a reliable unattended fallback. */
export function claudeVaultFallbackReady(): boolean {
  const t = getVaultClaudeTokens();
  if (!t?.accessToken?.startsWith(OAT_PREFIX)) return false;
  if (t.refreshToken && !isVaultRefreshTokenMarkedDead(t.refreshToken)) return true; // refreshable
  return !t.expiresAt || t.expiresAt > Date.now() + 60_000; // or currently valid
}

function tokenExpiryIso(tokens: ClaudeOAuthTokens | null): string | undefined {
  return tokens?.expiresAt ? new Date(tokens.expiresAt).toISOString() : undefined;
}

/** Diagnostic snapshot (never includes the token value). */
export function getClaudeAuthSnapshot(): ClaudeAuthSnapshot {
  const tokens = getStoredClaudeTokens();
  try {
    assertSubscriptionToken(tokens);
    return { configured: true, plan: tokens?.subscriptionType, expiresAt: tokenExpiryIso(tokens), source: tokens?.source };
  } catch (err) {
    // The request path refreshes Clementine-owned vault tokens asynchronously.
    // This snapshot is sync, so don't show "logged out" for an expired but
    // refreshable vault grant before the next request has a chance to rotate it.
    if (
      tokens?.source === 'vault' &&
      tokens.accessToken?.startsWith(OAT_PREFIX) &&
      Boolean(tokens.refreshToken) &&
      !claudeVaultRefreshDead()
    ) {
      return {
        configured: true,
        plan: tokens.subscriptionType,
        expiresAt: tokenExpiryIso(tokens),
        source: 'vault',
        refreshable: true,
        reason: 'Claude vault token is expired but refreshable.',
      };
    }
    if (tokens?.source === 'vault') {
      const fallback = getClaudeCodeTokens();
      try {
        assertSubscriptionToken(fallback);
        return {
          configured: true,
          plan: fallback?.subscriptionType,
          expiresAt: tokenExpiryIso(fallback),
          source: fallback?.source,
          degraded: true,
          reason: 'Using Claude Code subscription token because the Clementine Claude vault token is unavailable.',
        };
      } catch {
        if (tokens.refreshToken && isVaultRefreshTokenMarkedDead(tokens.refreshToken)) {
          const dead = readClaudeVaultDeadState();
          return {
            configured: false,
            source: 'vault',
            refreshable: false,
            reason: `Clementine Claude vault grant is dead${dead?.since ? ` since ${dead.since}` : ''}; re-authenticate Claude from Settings.`,
          };
        }
        // Fall through to the primary error.
      }
    }
    return { configured: false, reason: err instanceof ClaudeAuthError ? err.message : String(err) };
  }
}

export const __test__ = {
  parseClaudeCredential,
  assertSubscriptionToken,
  OAT_PREFIX,
  API_KEY_PREFIX,
  setVaultTokenReaderForTests(fn: (() => ClaudeOAuthTokens | null) | null): void {
    vaultTokenReader = fn ?? readVaultClaudeTokens;
  },
  setRawCredentialReaderForTests(fn: (() => string | null) | null): void {
    rawCredentialReader = fn ?? readRawCredentialJsonFromSystem;
  },
  setRefreshClaudeTokensForTests(fn: ((refreshToken: string) => Promise<ClaudeTokenSet>) | null): void {
    refreshClaudeTokensImpl = fn ?? refreshClaudeTokens;
  },
  setClaudeVaultDeadFileForTests(file: string | null): void {
    claudeVaultDeadFile = file ?? CLAUDE_VAULT_DEAD_FILE;
  },
  setClaudeVaultDegradedFileForTests(file: string | null): void {
    claudeVaultDegradedFile = file ?? CLAUDE_VAULT_DEGRADED_FILE;
  },
  getClaudeVaultDeadStateForTests(): ClaudeVaultDeadState | null {
    return readClaudeVaultDeadState();
  },
  getClaudeVaultDegradedStateForTests(): ClaudeVaultDegradedState | null {
    return readClaudeVaultDegradedState();
  },
  resetDegradedMemoryForTests(): void {
    deadVaultRefreshToken = null;
    loggedFallbackReason = null;
  },
  /** Reset module-level degraded-auth markers between tests. */
  resetDegradedStateForTests(): void {
    deadVaultRefreshToken = null;
    loggedFallbackReason = null;
    if (claudeVaultDeadFile !== CLAUDE_VAULT_DEAD_FILE) {
      try { rmSync(claudeVaultDeadFile, { force: true }); } catch { /* ignore */ }
    }
    if (claudeVaultDegradedFile !== CLAUDE_VAULT_DEGRADED_FILE) {
      try { rmSync(claudeVaultDegradedFile, { force: true }); } catch { /* ignore */ }
    }
  },
};

void logger; // reserved for refresh-path logging in the decoupled follow-up
