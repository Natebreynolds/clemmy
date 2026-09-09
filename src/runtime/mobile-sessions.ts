/**
 * Mobile PWA session store.
 *
 * After a successful PIN entry or QR pairing, the daemon issues an opaque
 * random token and persists a SHA-256 hash of it. The token itself is set as an
 * HttpOnly cookie and never written anywhere on the server — leaking
 * `mobile-sessions.json` does NOT grant access to any account.
 *
 * ## Why sessions are device-bound (v2)
 *
 * A v1 session was a pure bearer cookie: possession was sufficient, the TTL was
 * 30 days, and nothing ever rotated. Anything that read that cookie once — a
 * stolen phone, a backup, a copied cookie jar — held full access for a month,
 * and the daemon could not distinguish the thief from the owner. That matters
 * more here than in most apps, because a mobile session has full capability
 * parity with the desktop, including driving the agent loop that can run shell
 * commands.
 *
 * So a v2 session additionally carries the phone's P-256 PUBLIC key. The
 * private half is generated non-extractable in the browser and can never be
 * read back out, only used to sign (see mobile-device-proof.ts). A stolen
 * cookie is then worthless on its own.
 *
 * Binding is to a KEY, never to an IP or User-Agent. Phones roam constantly
 * between cellular and WiFi; IP binding would log users out for moving between
 * rooms while barely inconveniencing an attacker on the same network.
 *
 * ## Migration
 *
 * v1 rows are never dropped. They load as `binding: 'cookie'` with a 14-day
 * upgrade grace, during which the PWA silently generates a key and binds it
 * with zero user interaction. Only after the grace does an unbound session stop
 * working, and then it fails to a login screen rather than to a broken app.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';
import { isSupportedDeviceKey } from './mobile-device-proof.js';

/** How the holder of this session proves it is theirs. */
export type MobileSessionBinding = 'key' | 'cookie';

/**
 * 'full' is ordinary access. 'pin-rotation' is a sandbox for a session created
 * from a legacy weak PIN: it may only inspect its own status and set a new PIN.
 */
export type MobileSessionScope = 'full' | 'pin-rotation';

export interface MobileSessionRecord {
  /** sha256(token) — token itself is never stored. */
  tokenHash: string;
  deviceId: string;
  deviceLabel?: string;
  createdAt: string;
  /** Idle expiry. Slides forward on use. */
  expiresAt: string;
  lastSeenAt: string;
  /** Set when the client confirms its push subscription. v1: optional. */
  pushSubscribed?: boolean;

  // ---- v2 ----
  /** The device's P-256 public key. Absent on migrated v1 rows. */
  devicePublicKeyJwk?: JsonWebKey;
  binding?: MobileSessionBinding;
  scope?: MobileSessionScope;
  /** Increments on every rotation; lets reuse detection spot a retired token. */
  tokenGeneration?: number;
  /** Hard ceiling. Never slides, so a session cannot live forever. */
  absoluteExpiresAt?: string;
  lastRotatedAt?: string;
  /** The just-rotated-away token, honored briefly to absorb in-flight requests. */
  previousTokenHash?: string;
  previousTokenValidUntil?: string;
  /** For migrated cookie-only sessions: bind a key before this or stop working. */
  upgradeGraceUntil?: string;
  /** Audit only — never used for authorization decisions. */
  createdIp?: string;
  lastSeenIp?: string;
  /** Stable hash of the origin-handoff bearer that created this session. */
  originHandoffDigest?: string;
}

interface MobileSessionsFileV1 {
  version: 1;
  sessions: MobileSessionRecord[];
}

interface MobileSessionsFileV2 {
  version: 2;
  sessions: MobileSessionRecord[];
}

/** Idle window. Unchanged from v1 — shortening it would be a UX regression, and
 *  with key binding a stale cookie is not the threat it used to be. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Absolute ceiling. Never slides; forces an eventual deliberate re-pair. */
export const ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Rotate the token after this much time, bounding the value of any capture. */
export const ROTATE_AFTER_MS = 12 * 60 * 60 * 1000;
/** How long a just-rotated token keeps working. */
export const PREVIOUS_TOKEN_GRACE_MS = 30 * 1000;
/** How long a migrated v1 session may run before it must carry a device key. */
export const UPGRADE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export interface MobileSessionStoreOptions {
  stateDir?: string;
  ttlMs?: number;
  absoluteTtlMs?: number;
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

function emptyFile(): MobileSessionsFileV2 {
  return { version: 2, sessions: [] };
}

/**
 * Upgrades a v1 row in memory. Deliberately total and lossless: every field is
 * defaulted rather than dropped, so no device is logged out by an upgrade.
 */
function normalizeRecord(row: MobileSessionRecord, now: number): MobileSessionRecord {
  if (row.binding) return row;
  const createdMs = Date.parse(row.createdAt);
  return {
    ...row,
    binding: 'cookie',
    scope: row.scope ?? 'full',
    tokenGeneration: row.tokenGeneration ?? 0,
    absoluteExpiresAt:
      row.absoluteExpiresAt
      ?? new Date((Number.isFinite(createdMs) ? createdMs : now) + ABSOLUTE_TTL_MS).toISOString(),
    upgradeGraceUntil: row.upgradeGraceUntil ?? new Date(now + UPGRADE_GRACE_MS).toISOString(),
  };
}

function loadFile(opts?: MobileSessionStoreOptions): MobileSessionsFileV2 {
  const file = sessionsFile(opts);
  if (!existsSync(file)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as
      | Partial<MobileSessionsFileV1>
      | Partial<MobileSessionsFileV2>;
    if (!Array.isArray(parsed?.sessions)) return emptyFile();
    if (parsed.version !== 1 && parsed.version !== 2) return emptyFile();
    const now = opts?.now?.() ?? Date.now();
    return { version: 2, sessions: parsed.sessions.map((row) => normalizeRecord(row, now)) };
  } catch {
    return emptyFile();
  }
}

/** A session dies when EITHER its idle window or its absolute ceiling passes. */
function isLive(row: MobileSessionRecord, now: number): boolean {
  if (Date.parse(row.expiresAt) <= now) return false;
  if (row.absoluteExpiresAt && Date.parse(row.absoluteExpiresAt) <= now) return false;
  return true;
}

function pruneExpired(sessions: MobileSessionRecord[], now: number): MobileSessionRecord[] {
  return sessions.filter((row) => isLive(normalizeRecord(row, now), now));
}

export interface CreatedSession {
  token: string;
  record: MobileSessionRecord;
}

export interface CreateMobileSessionInput {
  deviceLabel?: string;
  devicePublicKeyJwk?: JsonWebKey;
  scope?: MobileSessionScope;
  ip?: string;
  /** Reuse an existing device identity (e.g. re-pairing the same phone). */
  deviceId?: string;
  /** Internal, server-derived binding for idempotent cross-origin adoption. */
  originHandoffDigest?: string;
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function prepareSession(
  input: CreateMobileSessionInput,
  opts?: MobileSessionStoreOptions,
  fixedToken?: string,
): CreatedSession {
  const now = opts?.now?.() ?? Date.now();
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const absoluteTtl = opts?.absoluteTtlMs ?? ABSOLUTE_TTL_MS;
  const token = fixedToken ?? mintToken();
  const hasKey = isSupportedDeviceKey(input.devicePublicKeyJwk);
  return {
    token,
    record: {
      tokenHash: hashToken(token),
      deviceId: input.deviceId || `dev-${randomBytes(6).toString('base64url')}`,
      deviceLabel: input.deviceLabel?.slice(0, 80),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      devicePublicKeyJwk: hasKey ? input.devicePublicKeyJwk : undefined,
      binding: hasKey ? 'key' : 'cookie',
      scope: input.scope ?? 'full',
      tokenGeneration: 0,
      absoluteExpiresAt: new Date(now + absoluteTtl).toISOString(),
      lastRotatedAt: new Date(now).toISOString(),
      // A client that paired without a key gets the same grace as a migrated one,
      // so an older cached PWA bundle keeps working while it updates itself.
      upgradeGraceUntil: hasKey ? undefined : new Date(now + UPGRADE_GRACE_MS).toISOString(),
      createdIp: input.ip,
      lastSeenIp: input.ip,
      originHandoffDigest: /^[a-f0-9]{64}$/.test(input.originHandoffDigest ?? '')
        ? input.originHandoffDigest
        : undefined,
    },
  };
}

export async function createSession(
  input: CreateMobileSessionInput = {},
  opts?: MobileSessionStoreOptions,
): Promise<CreatedSession> {
  const now = opts?.now?.() ?? Date.now();
  const created = prepareSession(input, opts);
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFileV2>(
    file,
    (current) => {
      const live = pruneExpired(current.sessions ?? [], now);
      return { version: 2, sessions: [...live, created.record] };
    },
    emptyFile(),
  );
  return created;
}

/**
 * Creates another origin-scoped session only while this exact device still
 * has a live session.
 *
 * The precondition and append share the same cross-process file lock as every
 * revocation operation. Consequently a seven-day origin-handoff cannot revive
 * a deliberately revoked phone: if revocation wins first this returns
 * undefined; if creation wins first the following revocation removes both
 * origin sessions.
 */
export async function createSessionForExistingDevice(
  input: CreateMobileSessionInput & { deviceId: string },
  opts?: MobileSessionStoreOptions,
): Promise<CreatedSession | undefined> {
  if (!input.deviceId) return undefined;
  const now = opts?.now?.() ?? Date.now();
  const created = prepareSession(input, opts);
  let admitted = false;
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFileV2>(
    file,
    (current) => {
      const live = pruneExpired(current.sessions ?? [], now);
      if (!live.some((row) => row.deviceId === input.deviceId)) {
        return { version: 2, sessions: live };
      }
      admitted = true;
      return { version: 2, sessions: [...live, created.record] };
    },
    emptyFile(),
  );
  return admitted ? created : undefined;
}

/**
 * Idempotently adopts one exact bearer as the session token for an existing
 * device. The handoff route supplies a server-minted 256-bit token; binding
 * the resulting session to that same token means a lost HTTP response can be
 * retried without storing a second raw secret or creating another session.
 *
 * The lookup/reuse, live-device precondition, and append share the normal
 * sessions-file lock with device revocation.
 */
export async function createOrReuseSessionForExistingDevice(
  input: CreateMobileSessionInput & { deviceId: string; reuseOnly?: boolean },
  sessionToken: string,
  opts?: MobileSessionStoreOptions,
): Promise<CreatedSession | undefined> {
  if (!input.deviceId || sessionToken.length < 32) return undefined;
  const now = opts?.now?.() ?? Date.now();
  const tokenHash = hashToken(sessionToken);
  const prepared = prepareSession(input, opts, sessionToken);
  let record: MobileSessionRecord | undefined;
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFileV2>(
    file,
    (current) => {
      const live = pruneExpired(current.sessions ?? [], now);
      const existing = live.find((row) => row.tokenHash === tokenHash);
      if (existing) {
        if (
          existing.deviceId === input.deviceId
          && (
            input.originHandoffDigest === undefined
            || existing.originHandoffDigest === input.originHandoffDigest
          )
        ) record = existing;
        return live.length === (current.sessions ?? []).length
          ? undefined
          : { version: 2, sessions: live };
      }
      if (
        input.originHandoffDigest
        && live.some((row) => row.originHandoffDigest === input.originHandoffDigest)
      ) {
        // The session append may have committed immediately before the
        // handoff receipt write crashed. Its stable digest is enough to prove
        // this bearer has already exercised its one create transition; after
        // rotation it may not manufacture another row.
        return live.length === (current.sessions ?? []).length
          ? undefined
          : { version: 2, sessions: live };
      }
      // Once a handoff has created its origin session, a retry may reopen only
      // that exact still-current bearer. It must never mint fresh authority if
      // the bearer was later rotated or retired.
      if (input.reuseOnly) {
        return live.length === (current.sessions ?? []).length
          ? undefined
          : { version: 2, sessions: live };
      }
      if (!live.some((row) => row.deviceId === input.deviceId)) {
        return { version: 2, sessions: live };
      }
      record = prepared.record;
      return { version: 2, sessions: [...live, prepared.record] };
    },
    emptyFile(),
  );
  return record ? { token: sessionToken, record } : undefined;
}

/**
 * Returns the matching session if the token is valid and not expired.
 *
 * Also accepts a token that was rotated away within the grace window, so a
 * request already in flight when rotation happened does not 401.
 */
export async function validateSession(
  token: string,
  opts?: MobileSessionStoreOptions,
): Promise<MobileSessionRecord | undefined> {
  if (!token) return undefined;
  const now = opts?.now?.() ?? Date.now();
  const tokenHash = hashToken(token);
  const file = loadFile(opts);
  const match = file.sessions.find(
    (row) => row.tokenHash === tokenHash
      || (row.previousTokenHash === tokenHash
        && row.previousTokenValidUntil
        && Date.parse(row.previousTokenValidUntil) > now),
  );
  if (!match) return undefined;
  if (!isLive(match, now)) return undefined;
  // Best-effort lastSeenAt bump.
  try {
    await atomicJsonMutate<MobileSessionsFileV2>(
      sessionsFile(opts),
      (current) => {
        const target = (current.sessions ?? []).find((row) => row.tokenHash === match.tokenHash);
        if (!target) return undefined;
        target.lastSeenAt = new Date(now).toISOString();
        return { version: 2, sessions: pruneExpired(current.sessions, now) };
      },
      emptyFile(),
    );
  } catch {
    /* lastSeenAt bump is best-effort */
  }
  return match;
}

/**
 * Atomically swaps a session's token, preserving device identity and the
 * absolute ceiling. The outgoing token stays valid for a short grace so an
 * in-flight request or a reconnecting SSE stream does not fail.
 */
export async function rotateSessionToken(
  currentToken: string,
  opts?: MobileSessionStoreOptions,
): Promise<CreatedSession | undefined> {
  if (!currentToken) return undefined;
  const now = opts?.now?.() ?? Date.now();
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const currentHash = hashToken(currentToken);
  const nextToken = mintToken();
  let rotated: MobileSessionRecord | undefined;

  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFileV2>(
    file,
    (current) => {
      const sessions = (current.sessions ?? []).map((row) => normalizeRecord(row, now));
      const target = sessions.find((row) => row.tokenHash === currentHash);
      if (!target) return undefined;
      target.previousTokenHash = target.tokenHash;
      target.previousTokenValidUntil = new Date(now + PREVIOUS_TOKEN_GRACE_MS).toISOString();
      target.tokenHash = hashToken(nextToken);
      target.tokenGeneration = (target.tokenGeneration ?? 0) + 1;
      target.lastRotatedAt = new Date(now).toISOString();
      // Idle window slides; the absolute ceiling deliberately does not.
      target.expiresAt = new Date(now + ttl).toISOString();
      rotated = { ...target };
      return { version: 2, sessions };
    },
    emptyFile(),
  );
  return rotated ? { token: nextToken, record: rotated } : undefined;
}

/**
 * Detects use of a token that was already rotated away and is past its grace.
 *
 * A legitimate client always holds the newest token, so presenting a retired
 * one means the value leaked and two parties now hold session material. The
 * safe response is to kill the whole device chain rather than guess which
 * caller is the owner.
 */
export async function detectTokenReuse(
  token: string,
  opts?: MobileSessionStoreOptions,
): Promise<{ reused: true; deviceId: string; record: MobileSessionRecord } | { reused: false }> {
  if (!token) return { reused: false };
  const now = opts?.now?.() ?? Date.now();
  const tokenHash = hashToken(token);
  const file = loadFile(opts);
  const match = file.sessions.find(
    (row) => row.previousTokenHash === tokenHash
      && (!row.previousTokenValidUntil || Date.parse(row.previousTokenValidUntil) <= now),
  );
  // The record travels with the verdict because a retired token alone cannot
  // tell a leak from a client that simply fell behind — the caller needs the
  // device key to arbitrate, and only this row knows it.
  return match ? { reused: true, deviceId: match.deviceId, record: { ...match } } : { reused: false };
}

/**
 * One-shot upgrade of a migrated cookie-only session to key binding.
 * Rotates the token at the same time, so the pre-binding value stops working.
 */
export async function bindDeviceKey(
  token: string,
  jwk: JsonWebKey,
  opts?: MobileSessionStoreOptions,
): Promise<CreatedSession | undefined> {
  if (!token || !isSupportedDeviceKey(jwk)) return undefined;
  const now = opts?.now?.() ?? Date.now();
  const currentHash = hashToken(token);

  let bound = false;
  await atomicJsonMutate<MobileSessionsFileV2>(
    sessionsFile(opts),
    (current) => {
      const sessions = (current.sessions ?? []).map((row) => normalizeRecord(row, now));
      const target = sessions.find((row) => row.tokenHash === currentHash);
      if (!target) return undefined;
      // Rebinding an already-bound session would let a stolen cookie swap in a
      // key the thief controls, which is exactly what this is meant to prevent.
      if (target.binding === 'key') return undefined;
      target.devicePublicKeyJwk = jwk;
      target.binding = 'key';
      target.upgradeGraceUntil = undefined;
      bound = true;
      return { version: 2, sessions };
    },
    emptyFile(),
  );
  if (!bound) return undefined;
  return rotateSessionToken(token, opts);
}

/** True when a cookie-bound session has run out of its silent-upgrade window. */
export function needsDeviceUpgrade(record: MobileSessionRecord, now: number): boolean {
  if (record.binding === 'key') return false;
  if (!record.upgradeGraceUntil) return true;
  return Date.parse(record.upgradeGraceUntil) <= now;
}

/** True when this session's token is old enough to be swapped. */
export function shouldRotate(record: MobileSessionRecord, now: number): boolean {
  const last = record.lastRotatedAt ? Date.parse(record.lastRotatedAt) : Date.parse(record.createdAt);
  if (!Number.isFinite(last)) return false;
  return now - last >= ROTATE_AFTER_MS;
}

/**
 * ── Revocation reaches what is already open ─────────────────────────────────
 *
 * THE DEFECT THIS EXISTS TO FIX. Every revoke path removed the durable row and
 * stopped there, but authorization is checked ONCE, at attach. An SSE stream
 * that was already running kept writing frames to a revoked phone until the
 * socket happened to close, and its push subscriptions kept delivering
 * notification CONTENT indefinitely. Rotating the PIN and restarting the daemon
 * was the only certain cut — which is not a revoke button, it is an outage.
 *
 * So revocation is an EVENT, not just a deletion. Anything holding live state
 * for a device registers a closer here, and every revoke path fires them after
 * the durable removal lands. Registering lives with the thing being closed (the
 * stream handler, the push routes), so this file never learns what a stream or
 * a push destination is.
 *
 * Order matters: the row is removed FIRST, so a closer that races a reconnect
 * finds no session to attach to.
 */
type DeviceRevocationCloser = (deviceId: string) => void;

const revocationClosers = new Set<DeviceRevocationCloser>();

/**
 * Register a teardown to run when a device is revoked. Returns an unsubscribe
 * so a caller with a lifetime (a request, a test) can detach cleanly.
 *
 * A closer must never throw and must be safe to call for a device it knows
 * nothing about — every closer is offered every revoked device.
 */
export function onDeviceRevoked(close: DeviceRevocationCloser): () => void {
  revocationClosers.add(close);
  return () => revocationClosers.delete(close);
}

function fireRevoked(deviceIds: Iterable<string>): void {
  for (const deviceId of deviceIds) {
    if (!deviceId) continue;
    for (const close of revocationClosers) {
      // One bad closer must not strand the rest: a half-executed revoke is the
      // failure this whole mechanism exists to prevent.
      try {
        close(deviceId);
      } catch {
        /* a closer that throws has already failed; keep cutting the others */
      }
    }
  }
}

/** Test seam: forget every registered closer. Never called by the daemon. */
export function resetDeviceRevocationClosers(): void {
  revocationClosers.clear();
}

export async function revokeSession(
  token: string,
  opts?: MobileSessionStoreOptions,
): Promise<boolean> {
  if (!token) return false;
  const tokenHash = hashToken(token);
  let removed = false;
  const revokedDeviceIds = new Set<string>();
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFileV2>(
    file,
    (current) => {
      const next = (current.sessions ?? []).filter((row) => {
        if (row.tokenHash === tokenHash || row.previousTokenHash === tokenHash) {
          removed = true;
          revokedDeviceIds.add(row.deviceId);
          return false;
        }
        return true;
      });
      return { version: 2, sessions: next };
    },
    emptyFile(),
  );
  fireRevoked(revokedDeviceIds);
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
  await atomicJsonMutate<MobileSessionsFileV2>(
    file,
    (current) => {
      const next = (current.sessions ?? []).filter((row) => {
        if (row.deviceId === deviceId) {
          removed = true;
          return false;
        }
        return true;
      });
      return { version: 2, sessions: next };
    },
    emptyFile(),
  );
  // Fired even when no row remained: the durable session may already have
  // expired while a stream attached to it is still open, and that stream is
  // exactly what this call is meant to cut.
  fireRevoked([deviceId]);
  return removed;
}

export async function revokeAllSessions(opts?: MobileSessionStoreOptions): Promise<number> {
  let count = 0;
  const revokedDeviceIds = new Set<string>();
  const file = sessionsFile(opts);
  ensureParentDir(file);
  await atomicJsonMutate<MobileSessionsFileV2>(
    file,
    (current) => {
      const rows = current.sessions ?? [];
      count = rows.length;
      for (const row of rows) revokedDeviceIds.add(row.deviceId);
      return { version: 2, sessions: [] };
    },
    emptyFile(),
  );
  fireRevoked(revokedDeviceIds);
  return count;
}

export function listSessions(opts?: MobileSessionStoreOptions): MobileSessionRecord[] {
  const now = opts?.now?.() ?? Date.now();
  return pruneExpired(loadFile(opts).sessions, now);
}

/**
 * Mark a session's pushSubscribed flag. Returns true if the session existed and
 * was updated. Used after the PWA confirms its push subscription was accepted.
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
  await atomicJsonMutate<MobileSessionsFileV2>(
    file,
    (current) => {
      const target = (current.sessions ?? []).find(
        (row) => row.tokenHash === tokenHash || row.previousTokenHash === tokenHash,
      );
      if (!target) return undefined;
      target.pushSubscribed = subscribed;
      updated = true;
      return { version: 2, sessions: current.sessions };
    },
    emptyFile(),
  );
  return updated;
}
