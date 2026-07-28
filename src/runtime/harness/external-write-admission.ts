import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { IRREVERSIBLE_SEND_VERBS } from './execution-gate.js';
import { HARNESS_DB_PATH, listEvents } from './eventlog.js';

/**
 * Nominal proof that provider dispatch never started. Transport-specific local
 * preflights may subclass this, but returned strings/objects can never become
 * instances. The shared harness uses it to release an exact reservation and
 * present a recoverable corrective instead of inventing an ambiguous write.
 */
export class ExternalWritePreDispatchError extends Error {
  readonly provenNoDispatch = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExternalWritePreDispatchError';
  }
}

/**
 * Cross-process serialization for the tiny read-ledger → reserve-write
 * admission window. The in-memory chain preserves cheap FIFO behavior inside
 * one runtime; a separate SQLite CAS lock closes the same race across the
 * desktop daemon, CLI, MCP children, and workers. Provider dispatch happens
 * only after the callback has durably appended its reservation and released
 * both locks, so independent recipients still fan out concurrently.
 */
const admissionLocks = new Map<string, Promise<unknown>>();
const ADMISSION_LOCK_DB_PATH = `${HARNESS_DB_PATH}.external-write-admission.db`;
const ADMISSION_LOCK_RETRY_MS = 15;
const ADMISSION_LOCK_MAX_WAIT_MS = 30_000;
const ADMISSION_LOCK_LEASE_MS = 60_000;
const ADMISSION_LOCK_HEARTBEAT_MS = 5_000;

interface AdmissionLockRow {
  owner_pid: number;
  owner_token: string;
}

function openAdmissionLockDb(): Database.Database {
  mkdirSync(path.dirname(ADMISSION_LOCK_DB_PATH), { recursive: true });
  const db = new Database(ADMISSION_LOCK_DB_PATH);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_write_admission_locks (
      lock_key     TEXT PRIMARY KEY,
      owner_pid    INTEGER NOT NULL,
      owner_token  TEXT NOT NULL,
      acquired_at  INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    )
  `);
  return db;
}

function admissionLockOwnerIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryAcquireCrossProcessAdmissionLock(
  db: Database.Database,
  key: string,
  ownerToken: string,
): boolean {
  const now = Date.now();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO external_write_admission_locks
      (lock_key, owner_pid, owner_token, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, process.pid, ownerToken, now, now + ADMISSION_LOCK_LEASE_MS);
  if (insert.changes === 1) return true;

  const owner = db.prepare(`
    SELECT owner_pid, owner_token
      FROM external_write_admission_locks
     WHERE lock_key = ?
  `).get(key) as AdmissionLockRow | undefined;
  if (!owner || admissionLockOwnerIsAlive(owner.owner_pid)) return false;

  // Crash recovery is an exact compare-and-swap. If two waiters both observe a
  // dead owner, only one can replace that exact token; neither can erase a new
  // live owner's row.
  const recovered = db.prepare(`
    UPDATE external_write_admission_locks
       SET owner_pid = ?, owner_token = ?, acquired_at = ?, expires_at = ?
     WHERE lock_key = ? AND owner_token = ?
  `).run(
    process.pid,
    ownerToken,
    now,
    now + ADMISSION_LOCK_LEASE_MS,
    key,
    owner.owner_token,
  );
  return recovered.changes === 1;
}

async function withCrossProcessAdmissionLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = openAdmissionLockDb();
  const ownerToken = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  let acquired = false;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    while (!acquired) {
      acquired = tryAcquireCrossProcessAdmissionLock(db, key, ownerToken);
      if (acquired) break;
      if (Date.now() - startedAt >= ADMISSION_LOCK_MAX_WAIT_MS) {
        throw new Error(
          `Timed out after ${ADMISSION_LOCK_MAX_WAIT_MS}ms waiting for durable external-write admission lock.`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, ADMISSION_LOCK_RETRY_MS));
    }

    heartbeat = setInterval(() => {
      try {
        db.prepare(`
          UPDATE external_write_admission_locks
             SET expires_at = ?
           WHERE lock_key = ? AND owner_token = ?
        `).run(Date.now() + ADMISSION_LOCK_LEASE_MS, key, ownerToken);
      } catch {
        // The owning PID remains the primary crash-recovery authority. A
        // transient heartbeat failure must not release or transfer ownership.
      }
    }, ADMISSION_LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (acquired) {
      try {
        db.prepare(`
          DELETE FROM external_write_admission_locks
           WHERE lock_key = ? AND owner_token = ?
        `).run(key, ownerToken);
      } finally {
        db.close();
      }
    } else {
      db.close();
    }
  }
}

export function withExternalWriteAdmissionLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = admissionLocks.get(key) ?? Promise.resolve();
  const run = prior.then(
    () => withCrossProcessAdmissionLock(key, fn),
    () => withCrossProcessAdmissionLock(key, fn),
  );
  const settled = run.then(() => undefined, () => undefined);
  admissionLocks.set(key, settled);
  void settled.finally(() => {
    if (admissionLocks.get(key) === settled) admissionLocks.delete(key);
  });
  return run;
}

export function externalWriteAdmissionKey(sessionId: string): string {
  return `external-write-admission\0${sessionId}`;
}

function normalizedIdentityKeys(values: readonly string[]): string[] {
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase()))]
    .sort();
}

const SEMANTIC_WRAPPER_KEYS = new Set([
  'arguments',
  'args',
  'args_json',
  'payload',
  'input',
  'body',
]);
const SEMANTIC_WRAPPER_ROUTING_KEYS = new Set([
  'action',
  'app',
  'app_name',
  'name',
  'tool',
]);
const SEMANTIC_TRANSPORT_NOISE_KEYS = new Set([
  '_meta',
  'meta',
  'metadata',
  'tool_slug',
  'tool_name',
  'server',
  'server_slug',
  'provider',
  'connected_account_id',
  'connection_id',
  'connector_id',
  'integration_id',
  'request_id',
  'idempotency_key',
  'headers',
  'auth',
  'credentials',
]);

function normalizedSemanticKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function decodeSemanticJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function canonicalSemanticPayload(value: unknown, seen = new WeakSet<object>()): unknown {
  const decoded = decodeSemanticJson(value);
  if (decoded === null || decoded === undefined) return null;
  if (typeof decoded === 'bigint') return decoded.toString();
  if (typeof decoded !== 'object') {
    if (typeof decoded === 'number' && !Number.isFinite(decoded)) return String(decoded);
    return decoded;
  }
  if (seen.has(decoded)) return '[circular]';
  seen.add(decoded);
  try {
    if (Array.isArray(decoded)) {
      return decoded.map((item) => canonicalSemanticPayload(item, seen));
    }

    const retained = Object.entries(decoded as Record<string, unknown>)
      .map(([rawKey, child]) => [normalizedSemanticKey(rawKey), child] as const)
      .filter(([key, child]) =>
        child !== undefined
        && child !== null
        && !SEMANTIC_TRANSPORT_NOISE_KEYS.has(key)
        && !key.startsWith('_')
      );
    const wrappers = retained.filter(([key]) => SEMANTIC_WRAPPER_KEYS.has(key));
    if (
      wrappers.length === 1
      && retained.every(([key]) =>
        SEMANTIC_WRAPPER_KEYS.has(key)
        || SEMANTIC_WRAPPER_ROUTING_KEYS.has(key)
      )
    ) {
      return canonicalSemanticPayload(wrappers[0]![1], seen);
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of retained.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      out[key] = canonicalSemanticPayload(child, seen);
    }
    return out;
  } finally {
    seen.delete(decoded);
  }
}

/**
 * Provider-neutral payload identity for targetless external writes. Transport
 * carriers (Composio's tool_slug + arguments, MCP payload/input/body wrappers,
 * connection ids and metadata) are projected away before stable hashing, while
 * the canonical action family and every semantic payload field remain. The raw
 * payload never leaves this function.
 */
export function externalWriteSemanticFingerprint(
  actionKey: string,
  payload: unknown,
): string {
  const canonical = canonicalSemanticPayload(payload);
  const serialized = JSON.stringify([
    actionKey.trim().toLowerCase(),
    canonical,
  ]);
  return `semantic-v1:${createHash('sha256').update(serialized).digest('hex')}`;
}

/**
 * Duplicate safety is recipient/resource based when identities exist. Some
 * irreversible actions (social posts, draft sends, thread replies) expose no
 * recipient field, so an exact payload fingerprint is the narrow fallback:
 * identical replay is blocked while a genuinely different post/message stays
 * admissible.
 */
export function externalWriteDuplicateIdentityKeys(
  targets: readonly string[],
  correlationFingerprint: string | undefined,
): string[] {
  const concrete = normalizedIdentityKeys(targets);
  if (concrete.length > 0) return concrete;
  const fingerprint = correlationFingerprint?.trim().toLowerCase();
  return fingerprint ? [`payload:${fingerprint}`] : [];
}

export interface ConsumedExternalWriteRetryAuthorization {
  retryOfCallId: string;
  executionId: string;
  authorizationSeq: number;
}

/**
 * Select one retry authorization while holding the session admission lock. The
 * caller's durable `external_write` reservation claims it by persisting
 * `retryAuthorizationSeq`; selection alone never burns the grant. This ordering
 * is deliberate: if reservation persistence fails, no provider dispatch occurs
 * and a later attempt may safely select the same authorization. Legacy explicit
 * consumption rows remain authoritative for backward compatibility.
 */
export function consumeExternalWriteRetryAuthorization(input: {
  sessionId: string;
  sourceUserSeq?: number;
  actionKey: string;
  duplicateIdentityKeys: readonly string[];
}): ConsumedExternalWriteRetryAuthorization | undefined {
  if (
    !Number.isSafeInteger(input.sourceUserSeq)
    || (input.sourceUserSeq ?? 0) <= 0
    || !input.actionKey
  ) return undefined;

  const events = listEvents(input.sessionId, {
    types: [
      'external_write_retry_authorized',
      'external_write_retry_consumed',
      'external_write',
    ],
  });
  const consumed = new Set(
    events
      .filter((event) =>
        event.type === 'external_write_retry_consumed'
        || event.type === 'external_write'
      )
      .map((event) => {
        const data = event.data as {
          authorizationSeq?: unknown;
          retryAuthorizationSeq?: unknown;
        } | undefined;
        return event.type === 'external_write'
          ? data?.retryAuthorizationSeq
          : data?.authorizationSeq;
      })
      .filter((seq): seq is number => Number.isSafeInteger(seq)),
  );
  const wantedKeys = normalizedIdentityKeys(input.duplicateIdentityKeys);
  const authorization = [...events].reverse().find((event) => {
    if (event.type !== 'external_write_retry_authorized' || consumed.has(event.seq)) return false;
    const data = event.data as {
      sourceUserSeq?: unknown;
      actionKey?: unknown;
      duplicateIdentityKeys?: unknown;
      retryOfCallId?: unknown;
      executionId?: unknown;
    } | undefined;
    if (
      !data
      || data.sourceUserSeq !== input.sourceUserSeq
      || data.actionKey !== input.actionKey
      || typeof data.retryOfCallId !== 'string'
      || !data.retryOfCallId
      || typeof data.executionId !== 'string'
      || !data.executionId
    ) return false;
    const authorizedKeys = normalizedIdentityKeys(
      Array.isArray(data.duplicateIdentityKeys)
        ? data.duplicateIdentityKeys.filter((value): value is string => typeof value === 'string')
        : [],
    );
    return authorizedKeys.length === wantedKeys.length
      && authorizedKeys.every((value, index) => value === wantedKeys[index]);
  });
  if (!authorization) return undefined;
  const data = authorization.data as {
    retryOfCallId: string;
    executionId: string;
  };
  return {
    retryOfCallId: data.retryOfCallId,
    executionId: data.executionId,
    authorizationSeq: authorization.seq,
  };
}

/**
 * Provider-neutral effect identity used only for duplicate admission. Keep the
 * provider-specific shapeKey for audit/batch accounting, but make equivalent
 * Composio and native MCP transports meet at the same safety boundary.
 */
export function canonicalExternalWriteActionKey(
  toolName: string | undefined,
  shapeKey: string | undefined,
): string {
  const normalized = `${shapeKey ?? ''}\0${toolName ?? ''}`
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  const tokens = new Set(normalized.split('_').filter(Boolean));
  const hasAny = (...values: string[]): boolean => values.some((value) => tokens.has(value));
  const dispatches = [...tokens].some((token) => IRREVERSIBLE_SEND_VERBS.has(token))
    || hasAny('CREATE', 'CREATION', 'MAKE', 'RESPOND');

  // Order is semantic: a Slack POST_MESSAGE is a message, not a social post;
  // an email reply is not a generic message; a calendar EVENT is not content.
  if (hasAny('EMAIL', 'EMAILS', 'MAIL')) {
    if (hasAny('FORWARD')) return 'email:forward';
    if (hasAny('REPLY', 'RESPOND')) return 'email:reply';
    if (hasAny('DRAFT') && hasAny('SEND', 'PUBLISH')) return 'email:send_draft';
    if (hasAny('DRAFT')) return 'email:draft';
    if (dispatches) return 'email:send';
  }
  if (hasAny('REPLY') && hasAny('THREAD')) return 'email:reply';
  if (hasAny('EVENT') && hasAny('RESPOND', 'REPLY')) {
    return 'calendar:respond_event';
  }
  if (hasAny('EVENT') && hasAny('CREATE', 'SCHEDULE', 'RESCHEDULE')) {
    return 'calendar:create_event';
  }
  if (hasAny('MEETING', 'MEETINGS') && hasAny('CREATE', 'MAKE')) {
    return 'meeting:create';
  }
  if (hasAny('CALL') && hasAny('CREATE', 'MAKE', 'DIAL', 'OUTBOUND')) {
    return 'call:outbound';
  }
  if (hasAny('INVITE', 'INVITES', 'INVITATION') && dispatches) {
    return 'invite:send';
  }
  if (
    hasAny('MESSAGE', 'MESSAGES', 'SMS', 'DM', 'NOTIFICATION', 'ANNOUNCEMENT')
    && dispatches
  ) {
    return 'message:send';
  }
  if (hasAny('POST', 'POSTS', 'TWEET', 'BROADCAST') && dispatches) {
    return 'social:publish';
  }
  const fallback = (shapeKey ?? toolName ?? 'unknown')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ':')
    .replace(/^:+|:+$/g, '');
  return `shape:${fallback || 'unknown'}`;
}

/**
 * Returned/thrown error prose is not proof that an irreversible write had no
 * effect. These phrases explicitly indicate that dispatch may have begun or
 * that only the response channel failed; callers must preserve the write as
 * ambiguous even when the same text also says "invalid" or "validation".
 */
export function externalWriteFailureMayHaveLanded(text: string): boolean {
  return /\b(?:accepted|committed|dispatched|executed|succeeded|successful(?:ly)?)\b|\bexecution\s+(?:was\s+)?completed\b|after\s+(?:the\s+)?(?:provider\s+)?(?:dispatch|send|commit|accept|execut(?:e|ion))|outcome\s+(?:is\s+)?(?:unknown|uncertain)|(?:may|might|could)\s+have\s+(?:landed|sent|committed)|\b(?:timeout|timed out|gateway timeout|dropped response|lost response|response envelope|malformed response|invalid response)\b/i.test(
    text,
  );
}

export function externalWriteFailureProvesNoDispatch(text: string): boolean {
  return /\[provider-dispatch:not-started:[a-z0-9_-]+\]/i.test(text);
}

interface WriteEvidenceEvent {
  seq: number;
  type: string;
  data?: unknown;
  createdAt?: string;
}

function evidenceData(event: WriteEvidenceEvent): Record<string, unknown> {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
}

function evidenceString(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return '';
}

function evidenceId(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function evidenceTargets(data: Record<string, unknown>): string[] {
  return Array.isArray(data.targets)
    ? data.targets
      .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
      .map((target) => target.trim().toLowerCase())
    : [];
}

/**
 * Return provisional/successful writes that have not been compensated by a
 * proven-no-effect resolution. Exact call or payload correlation wins; only
 * truly legacy rows fall back to shape + target matching. Orphans deliberately
 * remain present because a maybe-landed send must still block blind replay.
 */
export function uncompensatedExternalWriteEvents<T extends WriteEvidenceEvent>(
  events: readonly T[],
): T[] {
  const writes: T[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'external_write') {
      writes.push(event);
      continue;
    }
    if (event.type !== 'external_write_failed') continue;

    const failure = evidenceData(event);
    const callId = evidenceId(failure, 'canonicalCallId', 'callId');
    const fingerprint = evidenceString(failure, 'correlationFingerprint', 'payloadFingerprint');
    const shape = evidenceString(failure, 'actionKey', 'shapeKey', 'slug', 'toolName', 'tool');
    const targets = new Set(evidenceTargets(failure));
    let match = -1;
    for (let index = writes.length - 1; index >= 0; index -= 1) {
      const candidate = evidenceData(writes[index]!);
      const candidateCallId = evidenceId(candidate, 'canonicalCallId', 'callId');
      const candidateFingerprint = evidenceString(
        candidate,
        'correlationFingerprint',
        'payloadFingerprint',
      );
      if (callId && candidateCallId === callId) {
        match = index;
        break;
      }
      if (!callId && fingerprint && candidateFingerprint === fingerprint) {
        match = index;
        break;
      }
      if (!callId && !fingerprint) {
        const candidateShape = evidenceString(
          candidate,
          'actionKey',
          'shapeKey',
          'slug',
          'toolName',
          'tool',
        );
        const candidateTargets = evidenceTargets(candidate);
        if (
          candidateShape === shape
          && (
            targets.size === 0
            || candidateTargets.some((target) => targets.has(target))
          )
        ) {
          match = index;
          break;
        }
      }
    }
    if (match >= 0) writes.splice(match, 1);
  }
  return writes;
}
