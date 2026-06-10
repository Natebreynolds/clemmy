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
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';

const logger = pino({ name: 'clementine.claude-oauth' });

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OAT_PREFIX = 'sk-ant-oat01';
const API_KEY_PREFIX = 'sk-ant-api03';

export interface ClaudeOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scopes?: string[];
  subscriptionType?: string;
}

export class ClaudeAuthError extends Error {
  constructor(message: string, readonly kind: 'missing' | 'expired' | 'not_subscription' | 'parse') {
    super(message);
    this.name = 'ClaudeAuthError';
  }
}

function readRawCredentialJson(): string | null {
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

/** Read the stored Claude OAuth tokens, or null if none are present. */
export function getStoredClaudeTokens(): ClaudeOAuthTokens | null {
  const raw = readRawCredentialJson();
  if (!raw) return null;
  try { return parseClaudeCredential(raw); }
  catch { return null; }
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

/** True when a usable Claude subscription token is present (for auth-status UI). */
export function isClaudeSubscriptionReady(): boolean {
  try { loadClaudeAccessToken(); return true; } catch { return false; }
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

export const __test__ = { parseClaudeCredential, assertSubscriptionToken, OAT_PREFIX, API_KEY_PREFIX };

void logger; // reserved for refresh-path logging in the decoupled follow-up
