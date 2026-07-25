/**
 * Seed disposable live-test homes with a short-lived Claude subscription access
 * token, never a refresh token.
 *
 * Anthropic refresh tokens rotate. Copying Clementine's full claude-auth.json
 * into an isolated home and refreshing it there invalidates the production
 * refresh token while persisting the replacement only in the disposable copy.
 * Every isolated smoke/proof must therefore use this access-only snapshot.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_SUBSCRIPTION_PREFIX = 'sk-ant-oat01';
const DEFAULT_MIN_VALIDITY_MS = 5 * 60_000;

interface AccessOnlyClaudeCredential {
  accessToken: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

export interface IsolatedClaudeSeed {
  source: 'claude-code' | 'clementine-vault';
  expiresAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Parse either Claude Code's wrapped credential or Clementine's vault shape
 * into an access-only payload. The returned object can be serialized safely to
 * an isolated claude-auth.json: it deliberately has no refreshToken field.
 */
export function accessOnlyClaudeAuthPayload(
  raw: string,
  nowMs = Date.now(),
  minValidityMs = DEFAULT_MIN_VALIDITY_MS,
): AccessOnlyClaudeCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root) return null;
  const wrapped = asRecord(root.claudeAiOauth) ?? asRecord(root.oauth) ?? root;
  const accessToken = wrapped.accessToken ?? wrapped.access_token;
  if (typeof accessToken !== 'string' || !accessToken.startsWith(CLAUDE_SUBSCRIPTION_PREFIX)) return null;

  const rawExpiry = wrapped.expiresAt ?? wrapped.expires_at;
  const expiresAt = typeof rawExpiry === 'number' && Number.isFinite(rawExpiry) ? rawExpiry : undefined;
  if (expiresAt !== undefined && expiresAt <= nowMs + Math.max(0, minValidityMs)) return null;

  const rawScopes = wrapped.scopes;
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((scope): scope is string => typeof scope === 'string')
    : undefined;
  const rawSubscriptionType = wrapped.subscriptionType ?? wrapped.subscription_type;
  const subscriptionType = typeof rawSubscriptionType === 'string' ? rawSubscriptionType : undefined;

  return {
    accessToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
  };
}

function readClaudeCodeCredential(userHome: string): string | null {
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', CLAUDE_CODE_KEYCHAIN_SERVICE, '-w'],
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          // `security` resolves the default login keychain from HOME. Proof
          // daemons intentionally replace HOME, so resolve it in the parent
          // against the actual user's home before spawning the isolated child.
          env: { ...process.env, HOME: userHome },
        },
      );
      if (raw.trim()) return raw.trim();
    } catch {
      /* fall through to Claude Code's credential file */
    }
  }
  const file = path.join(userHome, '.claude', '.credentials.json');
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function readClementineVault(clementineHome: string): string | null {
  const file = path.join(clementineHome, 'state', 'claude-auth.json');
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Writes `<targetHome>/state/claude-auth.json` with a currently valid access
 * token only. Prefers Claude Code's live credential, then a still-valid
 * Clementine vault access token. Returns null when neither can safely cover the
 * isolated run.
 */
export function seedIsolatedClaudeAccess(options: {
  targetHome: string;
  sourceClementineHome: string;
  userHome: string;
  nowMs?: number;
  minValidityMs?: number;
}): IsolatedClaudeSeed | null {
  const nowMs = options.nowMs ?? Date.now();
  const minValidityMs = options.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS;
  const candidates: Array<{ source: IsolatedClaudeSeed['source']; raw: string | null }> = [
    { source: 'claude-code', raw: readClaudeCodeCredential(options.userHome) },
    { source: 'clementine-vault', raw: readClementineVault(options.sourceClementineHome) },
  ];

  for (const candidate of candidates) {
    if (!candidate.raw) continue;
    const payload = accessOnlyClaudeAuthPayload(candidate.raw, nowMs, minValidityMs);
    if (!payload) continue;
    const target = path.join(options.targetHome, 'state', 'claude-auth.json');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(target, 0o600); } catch { /* best effort */ }
    return {
      source: candidate.source,
      ...(payload.expiresAt ? { expiresAt: new Date(payload.expiresAt).toISOString() } : {}),
    };
  }
  return null;
}
