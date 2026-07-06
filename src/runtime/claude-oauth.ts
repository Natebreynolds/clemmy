/**
 * Claude (Anthropic) subscription OAuth wallet — peer to codex-native-oauth.ts.
 *
 * v1 piggybacks on the user's existing Claude Code login: it reads the OAuth
 * token Claude Code already stores (macOS Keychain `Claude Code-credentials`,
 * or ~/.claude/.credentials.json on Linux). The access token is long-lived
 * (~10h), so a test session needs no refresh — and we deliberately do NOT
 * rotate the shared refresh token in v1 (that would desync Claude Code's
 * rotating-refresh login). A decoupled, Clementine-owned Claude login + refresh
 * is the follow-up (mirrors Codex Phase 3).
 *
 * BILLING GUARANTEE (the owner's top concern): this wallet ONLY ever returns an
 * `sk-ant-oat01-` subscription OAuth token. An `sk-ant-api03-` API key (which
 * would bill pay-per-token) is REFUSED — fail closed. The adapter sends this as
 * a Bearer and never sets x-api-key, so a subscription user can never be
 * silently API-billed.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** A Clementine-owned vault refresh token the server has rejected with a
 *  permanent `invalid_grant` (revoked / rotated away / not found). Retrying it on
 *  every request only burns a doomed network round-trip and spams the log — the
 *  grant is dead until the user re-authenticates. Keyed by the token STRING so a
 *  re-auth (which writes a NEW token via saveClaudeTokens) auto-recovers with no
 *  restart. NULL means "no known-dead grant". */
let deadVaultRefreshToken: string | null = null;

/** Dedupe the "falling back to the Claude Code subscription token" WARN: it fired
 *  on EVERY request while the vault grant was down. Log once per distinct reason;
 *  reset on re-auth so a future degradation logs again. */
let loggedFallbackReason: string | null = null;

/** Persist our own Claude tokens (from the in-app login or a refresh). 0600. */
export function saveClaudeTokens(tokens: ClaudeTokenSet): void {
  mkdirSync(path.dirname(CLAUDE_VAULT_FILE), { recursive: true });
  writeFileSync(CLAUDE_VAULT_FILE, JSON.stringify(tokens, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // A freshly-written grant supersedes any prior dead/degraded state — clear the
  // markers so the next request re-attempts refresh and re-arms fallback logging.
  deadVaultRefreshToken = null;
  loggedFallbackReason = null;
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

const REFRESH_BEFORE_MS = 5 * 60_000;
let refreshClaudeTokensImpl = refreshClaudeTokens;

function tryClaudeCodeFallback(reason: string): string | null {
  const cli = getClaudeCodeTokens();
  if (!cli) return null;
  try {
    const token = assertSubscriptionToken(cli);
    if (loggedFallbackReason !== reason) {
      logger.warn({ reason }, 'Using Claude Code subscription token because Clementine Claude vault token is unavailable');
      loggedFallbackReason = reason;
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
  if (!deadVaultRefreshToken) return false;
  const t = getVaultClaudeTokens();
  return !!t?.refreshToken && t.refreshToken === deadVaultRefreshToken;
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
    if (refreshToken === deadVaultRefreshToken) {
      // Grant already rejected as invalid_grant — skip the doomed network refresh
      // and go straight to fallback. Recovers automatically once a re-auth writes
      // a new token (saveClaudeTokens clears deadVaultRefreshToken).
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
          deadVaultRefreshToken = refreshToken;
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
  if (t.refreshToken) return true; // refreshable
  return !t.expiresAt || t.expiresAt > Date.now() + 60_000; // or currently valid
}

/** Diagnostic snapshot (never includes the token value). */
export function getClaudeAuthSnapshot(): { configured: boolean; reason?: string; plan?: string; expiresAt?: string } {
  try {
    loadClaudeAccessToken();
    const t = getStoredClaudeTokens();
    return { configured: true, plan: t?.subscriptionType, expiresAt: t?.expiresAt ? new Date(t.expiresAt).toISOString() : undefined };
  } catch (err) {
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
  /** Reset module-level degraded-auth markers between tests. */
  resetDegradedStateForTests(): void {
    deadVaultRefreshToken = null;
    loggedFallbackReason = null;
  },
};

void logger; // reserved for refresh-path logging in the decoupled follow-up
