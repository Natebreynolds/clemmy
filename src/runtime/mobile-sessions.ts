/**
 * Mobile PWA session store.
 *
 * After a successful PIN entry, the daemon issues an opaque random
 * token and persists a SHA-256 hash of that token to disk. The token
 * itself is set as an HttpOnly cookie on the client and never written
 * anywhere on the server — leaking `mobile-sessions.json` does NOT
 * grant access to any account.
 *
 * Sessions persist across daemon restarts (unlike the in-memory
 * dashboard token in webhook.ts). 30-day TTL, lazy expiry on read,
 * sweep-on-write to keep the file bounded.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';

export interface MobileSessionRecord {
  /** sha256(token) — token itself is never stored. */
  tokenHash: string;
  deviceId: string;
  deviceLabel?: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  /** Set when the client confirms its push subscription. v1: optional. */
  pushSubscribed?: boolean;
}

interface MobileSessionsFile {
  version: 1;
  sessions: MobileSessionRecord[];
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface MobileSessionStoreOptions {
  stateDir?: string;
  ttlMs?: number;
  /** Override clock for tests. */
  now?: () => number;
}

function sessionsFile(opts?: MobileSessionStoreOptions): string {
  const dir = opts?.stateDir ?? path.join(BASE_DIR, 'state');
  return path.join(dir, 'mobile-sessions.json');
}

function ensureParentDir(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function emptyFile(): MobileSessionsFile {
  return { version: 1, sessions: [] };
}

function loadFile(opts?: MobileSessionStoreOptions): MobileSessionsFile {
  const file = sessionsFile(opts);
  if (!existsSync(file)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<MobileSessionsFile>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) return emptyFile();
    return { version: 1, sessions: parsed.sessions };
  } catch {
    return emptyFile();
  }
}

function pruneExpired(sessions: MobileSessionRecord[], now: number): MobileSessionRecord[] {
  return sessions.filter((row) => Date.parse(row.expiresAt) > now);
}

export interface CreatedSession {
  token: string;
  record: MobileSessionRecord;
}

export async function createSession(
  input: { deviceLabel?: string } = {},
  opts?: MobileSessionStoreOptions,
): Promise<CreatedSession> {
  const now = opts?.now?.() ?? Date.now();
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const token = randomBytes(32).toString('base64url');
  const record: MobileSessionRecord = {
    tokenHash: hashToken(token),
    deviceId: `dev-${randomBytes(6).toString('base64url')}`,
    deviceLabel: input.deviceLabel?.slice(0, 80),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  };
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFile>(
    file,
    (current) => {
      const live = pruneExpired(current.sessions, now);
      return { version: 1, sessions: [...live, record] };
    },
    emptyFile(),
  );
  return { token, record };
}

/**
 * Returns the matching session if the token is valid and not expired,
 * else undefined. Bumps `lastSeenAt` on hit (best-effort — failure to
 * persist is not fatal).
 */
export async function validateSession(
  token: string,
  opts?: MobileSessionStoreOptions,
): Promise<MobileSessionRecord | undefined> {
  if (!token) return undefined;
  const now = opts?.now?.() ?? Date.now();
  const tokenHash = hashToken(token);
  const file = loadFile(opts);
  const match = file.sessions.find((row) => row.tokenHash === tokenHash);
  if (!match) return undefined;
  if (Date.parse(match.expiresAt) <= now) return undefined;
  // Best-effort lastSeenAt bump.
  try {
    await atomicJsonMutate<MobileSessionsFile>(
      sessionsFile(opts),
      (current) => {
        const target = current.sessions.find((row) => row.tokenHash === tokenHash);
        if (!target) return undefined;
        target.lastSeenAt = new Date(now).toISOString();
        return { version: 1, sessions: pruneExpired(current.sessions, now) };
      },
      emptyFile(),
    );
  } catch {
    /* lastSeenAt bump is best-effort */
  }
  return match;
}

export async function revokeSession(
  token: string,
  opts?: MobileSessionStoreOptions,
): Promise<boolean> {
  if (!token) return false;
  const tokenHash = hashToken(token);
  let removed = false;
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFile>(
    file,
    (current) => {
      const next = current.sessions.filter((row) => {
        if (row.tokenHash === tokenHash) {
          removed = true;
          return false;
        }
        return true;
      });
      return { version: 1, sessions: next };
    },
    emptyFile(),
  );
  return removed;
}

export async function revokeSessionByDeviceId(
  deviceId: string,
  opts?: MobileSessionStoreOptions,
): Promise<boolean> {
  if (!deviceId) return false;
  let removed = false;
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFile>(
    file,
    (current) => {
      const next = current.sessions.filter((row) => {
        if (row.deviceId === deviceId) {
          removed = true;
          return false;
        }
        return true;
      });
      return { version: 1, sessions: next };
    },
    emptyFile(),
  );
  return removed;
}

export async function revokeAllSessions(opts?: MobileSessionStoreOptions): Promise<number> {
  let count = 0;
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFile>(
    file,
    (current) => {
      count = current.sessions.length;
      return { version: 1, sessions: [] };
    },
    emptyFile(),
  );
  return count;
}

export function listSessions(opts?: MobileSessionStoreOptions): MobileSessionRecord[] {
  const now = opts?.now?.() ?? Date.now();
  return pruneExpired(loadFile(opts).sessions, now);
}

/**
 * Mark a session's pushSubscribed flag. Returns true if the session
 * existed and was updated. Used after the PWA confirms its push
 * subscription was accepted by the daemon.
 */
export async function markPushSubscribed(
  token: string,
  subscribed: boolean,
  opts?: MobileSessionStoreOptions,
): Promise<boolean> {
  if (!token) return false;
  const tokenHash = hashToken(token);
  let updated = false;
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFile>(
    file,
    (current) => {
      const target = current.sessions.find((row) => row.tokenHash === tokenHash);
      if (!target) return undefined;
      target.pushSubscribed = subscribed;
      updated = true;
      return current;
    },
    emptyFile(),
  );
  return updated;
}
