/**
 * Seed a disposable proof home with one short-lived Codex access token.
 *
 * Codex refresh tokens rotate with reuse detection. A byte-for-byte copy of
 * Clementine's auth.json gives the real daemon and the proof daemon the same
 * rotating family while each process holds a different BASE_DIR-local lock.
 * The two locks cannot coordinate, so a concurrent refresh can revoke the
 * whole family. Proof homes therefore receive a deliberately separate,
 * access-only file that the runtime can consume but can never refresh.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ISOLATED_CODEX_ACCESS_FILE = 'codex-access-only.json';

/** Covers the 90s proof boot budget plus one 15-minute completion window with
 * enough margin to reject a token that would expire during the first turn. */
export const PROOF_CODEX_MIN_VALIDITY_MS = 20 * 60_000;

export interface AccessOnlyCodexCredential {
  version: 1;
  accessToken: string;
  expiresAt: number;
  accountId?: string;
}

export interface IsolatedCodexSeed {
  source: 'clementine-vault';
  expiresAt: string;
  accountId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return asRecord(JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')));
  } catch {
    return null;
  }
}

function accountIdFromClaims(payload: Record<string, unknown>): string | undefined {
  const auth = asRecord(payload['https://api.openai.com/auth']);
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.trim() ? accountId : undefined;
}

/**
 * Reduce Clementine's native vault shape to the only fields a disposable
 * proof may receive. Opaque tokens are rejected: without a JWT `exp` claim the
 * harness cannot prove that the access token will cover its first live turn.
 */
export function accessOnlyCodexAuthPayload(
  raw: string,
  nowMs = Date.now(),
  minValidityMs = PROOF_CODEX_MIN_VALIDITY_MS,
): AccessOnlyCodexCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const oauth = asRecord(root?.codexOauth);
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken.trim()) return null;

  const claims = decodeJwtPayload(accessToken);
  const exp = claims?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  const expiresAt = exp * 1000;
  if (expiresAt <= nowMs + Math.max(0, minValidityMs)) return null;

  const storedAccountId = oauth?.accountId;
  const accountId = typeof storedAccountId === 'string' && storedAccountId.trim()
    ? storedAccountId
    : claims ? accountIdFromClaims(claims) : undefined;
  return {
    version: 1,
    accessToken,
    expiresAt,
    ...(accountId ? { accountId } : {}),
  };
}

function readClementineCodexVault(clementineHome: string): string | null {
  const file = path.join(clementineHome, 'state', 'auth.json');
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** Side-effect-free availability check used while planning a proof leg. */
export function inspectIsolatedCodexAccess(options: {
  sourceClementineHome: string;
  nowMs?: number;
  minValidityMs?: number;
}): IsolatedCodexSeed | null {
  const raw = readClementineCodexVault(options.sourceClementineHome);
  if (!raw) return null;
  const payload = accessOnlyCodexAuthPayload(
    raw,
    options.nowMs,
    options.minValidityMs,
  );
  if (!payload) return null;
  return {
    source: 'clementine-vault',
    expiresAt: new Date(payload.expiresAt).toISOString(),
    ...(payload.accountId ? { accountId: payload.accountId } : {}),
  };
}

/**
 * Write `<targetHome>/state/codex-access-only.json`. The source vault remains
 * untouched and refreshToken/idToken are neither returned nor serialized.
 */
export function seedIsolatedCodexAccess(options: {
  targetHome: string;
  sourceClementineHome: string;
  nowMs?: number;
  minValidityMs?: number;
}): IsolatedCodexSeed | null {
  const raw = readClementineCodexVault(options.sourceClementineHome);
  if (!raw) return null;
  const payload = accessOnlyCodexAuthPayload(
    raw,
    options.nowMs,
    options.minValidityMs,
  );
  if (!payload) return null;

  const target = path.join(options.targetHome, 'state', ISOLATED_CODEX_ACCESS_FILE);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try { chmodSync(target, 0o600); } catch { /* best effort */ }
  return {
    source: 'clementine-vault',
    expiresAt: new Date(payload.expiresAt).toISOString(),
    ...(payload.accountId ? { accountId: payload.accountId } : {}),
  };
}
