import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
// Deliberate ESM cycle (approval-registry imports this module): bindings are
// only touched inside verifyApprovedCard at call time, never at module eval.
import * as approvalRegistryForVerify from './approval-registry.js';
import { getEvent, listEvents } from './eventlog.js';
import type { ComposioCliDefaultAccountAuthority } from '../../integrations/composio/cli-default-account-authority.js';

export const PENDING_ACTIONS_DIR = path.join(BASE_DIR, 'pending-actions');
const PENDING_ACTION_TRANSITION_LOCK_DB_PATH = path.join(
  BASE_DIR,
  'pending-action-transition-locks.sqlite',
);
const PENDING_ACTION_TRANSITION_LOCK_TABLE = 'pending_action_transition_locks';
const PENDING_ACTION_TRANSITION_LOCK_MAX_WAIT_MS = 250;
const PENDING_ACTION_TRANSITION_LOCK_BASE_RETRY_MS = 5;
const transitionRetrySignal = new Int32Array(new SharedArrayBuffer(4));
const transitionLockCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const PENDING_ACTION_KINDS = [
  'external_send',
  'external_write',
  'external_update',
  'local_file_write',
  'shell_command',
  'deployment',
  'workflow_run',
  'other',
] as const;

export type PendingActionKind = (typeof PENDING_ACTION_KINDS)[number];

export const PENDING_ACTION_STATUSES = [
  'queued',
  'approval_requested',
  'approved',
  'executing',
  'rejected',
  'expired',
  'executed',
  'failed',
  'cancelled',
] as const;

export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number];

export interface PendingActionHistoryItem {
  at: string;
  status: PendingActionStatus;
  note?: string;
  actor?: string;
}

/** WHO consented to this action (THE-GRANT plan, Phase 1). 'human' may ONLY be
 *  written by a real approval-card/workflow resolution; the policy path is
 *  typed to 'policy' and can never produce it. Absent on legacy records —
 *  defaulted at read time (see safeReadRecord). */
export type PendingActionApprovedBy = 'human' | 'policy';

export type PendingActionApprovalEvidence =
  | { kind: 'card'; approvalId: string }
  | {
      kind: 'conversation';
      approvalId: string;
      promptEventId: string;
      promptEventSeq: number;
      responseSourceUserSeq: number;
      sourceUserSeq: number;
      responderUserId: string;
      conversationKey: string;
      originReplyTargetDigest: string;
    }
  | { kind: 'workflow'; workflowRunId: string }
  | { kind: 'policy'; scope: string };

export interface PendingActionRecord {
  id: string;
  title: string;
  summary: string;
  kind: PendingActionKind;
  toolName: string;
  payload: unknown;
  /** Immutable non-payload execution capability selected by trusted queue
   * admission. Models cannot author this field. */
  executionAuthority?: ComposioCliDefaultAccountAuthority | null;
  payloadHash: string;
  idempotencyKey: string;
  targetSummary: string;
  preview: string;
  risk: string;
  rollback: string;
  sessionId: string | null;
  /** Exact accepted source that prepared this immutable action. A replay of
   * that same source reuses the durable record; a genuinely new user source
   * may intentionally prepare the same bytes again. */
  sourceUserSeq: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: PendingActionStatus;
  approvalId: string | null;
  approvedBy: PendingActionApprovedBy | null;
  approvalEvidence: PendingActionApprovalEvidence | null;
  /** SHA-256 of the opaque capability returned only to the executor that won
   *  the approved→executing claim. The raw token is never persisted or exposed
   *  through record reads. Optional for backwards-compatible legacy reads. */
  executionClaimTokenHash?: string | null;
  executionClaimedBy?: string | null;
  executionClaimedAt?: string | null;
  resultSummary: string | null;
  history: PendingActionHistoryItem[];
}

/** Opaque, process-local authority carried only from the winning
 * approved→executing claim to the exact provider boundary. */
export interface PendingActionExecutionCapability {
  pendingActionId: string;
  payloadHash: string;
  claimToken: string;
  sourceUserSeq: number;
}

export interface QueuePendingActionInput {
  title: string;
  summary: string;
  kind: PendingActionKind;
  toolName: string;
  payload: unknown;
  executionAuthority?: ComposioCliDefaultAccountAuthority | null;
  targetSummary?: string | null;
  preview?: string | null;
  risk?: string | null;
  rollback?: string | null;
  sessionId?: string | null;
  sourceUserSeq?: number | null;
  createdBy?: string | null;
}

function ensurePendingActionsDir(): void {
  if (!existsSync(PENDING_ACTIONS_DIR)) mkdirSync(PENDING_ACTIONS_DIR, { recursive: true });
}

function recordPath(id: string): string {
  return path.join(PENDING_ACTIONS_DIR, `${id}.json`);
}

function recordLockPath(id: string): string {
  return path.join(PENDING_ACTIONS_DIR, `${id}.execution.lock`);
}

function transitionLockKey(id: string): string {
  return `pending-action-transition:${id}`;
}

function sourceFreezeTransitionLockKey(input: {
  sessionId: string;
  sourceUserSeq: number;
  toolName: string;
  payloadHash: string;
}): string {
  const digest = createHash('sha256')
    .update(stableStringify(input), 'utf8')
    .digest('hex');
  return `pending-action-source-freeze:${digest}`;
}

function newPendingActionId(): string {
  return `pa-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function shortHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex').slice(0, 16);
}

function executionTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function executionTokenMatches(expectedHash: string | null | undefined, token: string | null | undefined): boolean {
  if (!expectedHash || !token) return false;
  const actualHash = executionTokenHash(token);
  if (expectedHash.length !== actualHash.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(actualHash, 'hex'));
  } catch {
    return false;
  }
}

export function verifyPendingActionExecutionCapability(input: {
  capability: PendingActionExecutionCapability | null | undefined;
  sessionId: string | null | undefined;
  toolName: string;
  payload: unknown;
}): boolean {
  const capability = input.capability;
  if (!capability || !input.sessionId) return false;
  const record = getPendingAction(capability.pendingActionId);
  const conversationEvidence = record?.approvalEvidence?.kind === 'conversation'
    ? record.approvalEvidence
    : null;
  const response = conversationEvidence && record?.sessionId
    ? listEvents(record.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === conversationEvidence.responseSourceUserSeq)
    : null;
  const sourceBound = conversationEvidence
    ? Boolean(
        capability.sourceUserSeq === conversationEvidence.responseSourceUserSeq
        && response
        && response.data.source === 'channel_send_consent'
        && response.data.approvalId === conversationEvidence.approvalId
        && response.data.decision === 'approve'
        && response.data.userId === conversationEvidence.responderUserId
        && response.data.conversationKey === conversationEvidence.conversationKey
      )
    : Number.isSafeInteger(capability.sourceUserSeq) && capability.sourceUserSeq >= 0;
  return Boolean(
    record
    && record.status === 'executing'
    && record.sessionId === input.sessionId
    && record.toolName === input.toolName
    && record.payloadHash === capability.payloadHash
    && sourceBound
    && pendingActionPayloadHash(
      input.toolName,
      input.payload,
      record.executionAuthority ?? null,
    ) === capability.payloadHash
    && executionTokenMatches(record.executionClaimTokenHash, capability.claimToken),
  );
}

function cleanLine(value: string | null | undefined, fallback: string, max = 1000): string {
  const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, max);
}

function writeRecord(record: PendingActionRecord): PendingActionRecord {
  ensurePendingActionsDir();
  // Atomic replace: readers see the complete old record or the complete new
  // record, never a partially-written JSON file. The unique temp name also
  // keeps concurrent writes from sharing a scratch file.
  const target = recordPath(record.id);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(temp, target);
  return record;
}

type RecordLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

interface PendingActionTransitionLockRow {
  owner_pid: number;
  owner_token: string;
}

function openPendingActionTransitionLockDb(): Database.Database {
  mkdirSync(path.dirname(PENDING_ACTION_TRANSITION_LOCK_DB_PATH), { recursive: true });
  const db = new Database(PENDING_ACTION_TRANSITION_LOCK_DB_PATH);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PENDING_ACTION_TRANSITION_LOCK_TABLE} (
      lock_key     TEXT PRIMARY KEY,
      owner_pid    INTEGER NOT NULL,
      owner_token  TEXT NOT NULL,
      operation    TEXT NOT NULL,
      acquired_at  INTEGER NOT NULL
    )
  `);
  return db;
}

function transitionLockOwnerIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. EPERM and every unknown platform error remain
    // live/uncertain so recovery can never steal an active owner.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function tryAcquirePendingActionTransitionLock(
  db: Database.Database,
  lockKey: string,
  ownerToken: string,
  operation: string,
): boolean {
  const now = Date.now();
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO ${PENDING_ACTION_TRANSITION_LOCK_TABLE}
      (lock_key, owner_pid, owner_token, operation, acquired_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(lockKey, process.pid, ownerToken, operation, now);
  if (inserted.changes === 1) return true;

  const owner = db.prepare(`
    SELECT owner_pid, owner_token
      FROM ${PENDING_ACTION_TRANSITION_LOCK_TABLE}
     WHERE lock_key = ?
  `).get(lockKey) as PendingActionTransitionLockRow | undefined;
  if (!owner || transitionLockOwnerIsAlive(owner.owner_pid)) return false;

  // Exact token CAS closes the check/reclaim race: two recovery processes may
  // observe a dead PID, but only one can replace that precise dead ownership;
  // neither can delete or overwrite a newer live owner.
  const recovered = db.prepare(`
    UPDATE ${PENDING_ACTION_TRANSITION_LOCK_TABLE}
       SET owner_pid = ?, owner_token = ?, operation = ?, acquired_at = ?
     WHERE lock_key = ? AND owner_token = ?
  `).run(process.pid, ownerToken, operation, now, lockKey, owner.owner_token);
  return recovered.changes === 1;
}

function schedulePendingActionTransitionLockCleanup(
  lockKey: string,
  ownerToken: string,
  attempt = 0,
): void {
  const cleanupKey = `${lockKey}\0${ownerToken}`;
  if (transitionLockCleanupTimers.has(cleanupKey)) return;
  const delayMs = Math.min(30_000, 100 * (2 ** Math.min(attempt, 8)));
  const timer = setTimeout(() => {
    transitionLockCleanupTimers.delete(cleanupKey);
    let db: Database.Database | null = null;
    try {
      db = openPendingActionTransitionLockDb();
      db.prepare(`
        DELETE FROM ${PENDING_ACTION_TRANSITION_LOCK_TABLE}
         WHERE lock_key = ? AND owner_token = ?
      `).run(lockKey, ownerToken);
    } catch {
      schedulePendingActionTransitionLockCleanup(lockKey, ownerToken, attempt + 1);
    } finally {
      try { db?.close(); } catch { /* the next token-specific retry remains safe */ }
    }
  }, delayMs);
  timer.unref?.();
  transitionLockCleanupTimers.set(cleanupKey, timer);
}

function withPendingActionTransitionLockKey<T>(
  lockKey: string,
  operation: string,
  fn: () => T,
): RecordLockResult<T> {
  let db: Database.Database;
  try {
    db = openPendingActionTransitionLockDb();
  } catch {
    return { acquired: false };
  }
  const ownerToken = `${process.pid}:${randomBytes(24).toString('base64url')}`;
  const startedAt = Date.now();
  let acquired = false;
  let retryMs = PENDING_ACTION_TRANSITION_LOCK_BASE_RETRY_MS;
  try {
    try {
      while (!acquired) {
        acquired = tryAcquirePendingActionTransitionLock(db, lockKey, ownerToken, operation);
        if (acquired) break;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= PENDING_ACTION_TRANSITION_LOCK_MAX_WAIT_MS) return { acquired: false };
        const waitMs = Math.min(retryMs, PENDING_ACTION_TRANSITION_LOCK_MAX_WAIT_MS - elapsed);
        Atomics.wait(transitionRetrySignal, 0, 0, waitMs);
        retryMs = Math.min(40, retryMs * 2);
      }
    } catch {
      return { acquired: false };
    }
    return { acquired: true, value: fn() };
  } finally {
    if (acquired) {
      try {
        db.prepare(`
          DELETE FROM ${PENDING_ACTION_TRANSITION_LOCK_TABLE}
           WHERE lock_key = ? AND owner_token = ?
        `).run(lockKey, ownerToken);
      } catch {
        // The mutation already committed. Never mask that truth or leave the
        // current live PID wedged forever; retry only this exact owner token.
        schedulePendingActionTransitionLockCleanup(lockKey, ownerToken);
      } finally {
        try { db.close(); } catch {
          schedulePendingActionTransitionLockCleanup(lockKey, ownerToken);
        }
      }
    } else {
      try { db.close(); } catch { /* no ownership was acquired */ }
    }
  }
}

function withPendingActionTransitionLock<T>(
  id: string,
  operation: string,
  fn: () => T,
): RecordLockResult<T> {
  return withPendingActionTransitionLockKey(transitionLockKey(id), operation, fn);
}

function pendingActionTransitionLockIdentityForKeyForTest(lockKey: string): {
  dbPath: string;
  table: string;
  lockKey: string;
} {
  const db = openPendingActionTransitionLockDb();
  db.close();
  return {
    dbPath: PENDING_ACTION_TRANSITION_LOCK_DB_PATH,
    table: PENDING_ACTION_TRANSITION_LOCK_TABLE,
    lockKey,
  };
}

/** Narrow fixture seam for deterministic dead/live-owner crash pins. */
export function pendingActionTransitionLockIdentityForTest(id: string): {
  dbPath: string;
  table: string;
  lockKey: string;
} {
  return pendingActionTransitionLockIdentityForKeyForTest(transitionLockKey(id));
}

/** Exact sibling seam for same-accepted-source freeze crash pins. */
export function pendingActionSourceFreezeLockIdentityForTest(input: {
  sessionId: string;
  sourceUserSeq: number;
  toolName: string;
  payload: unknown;
  executionAuthority?: ComposioCliDefaultAccountAuthority | null;
}): { dbPath: string; table: string; lockKey: string } {
  const payloadHash = pendingActionPayloadHash(
    input.toolName,
    input.payload,
    input.executionAuthority ?? null,
  );
  return pendingActionTransitionLockIdentityForKeyForTest(sourceFreezeTransitionLockKey({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    toolName: input.toolName,
    payloadHash,
  }));
}

/**
 * A filesystem O_EXCL lock makes the approved→executing compare-and-swap safe
 * across daemon processes, not only concurrent promises in one process.
 *
 * This provider-claim/result lock is intentionally never considered stale.
 * Recoverable pre-provider bookkeeping uses the separate SQLite transition
 * owner above; a dead execution owner remains uncertain and non-retryable.
 */
function withRecordExecutionLock<T>(id: string, fn: () => T): RecordLockResult<T> {
  ensurePendingActionsDir();
  const lockPath = recordLockPath(id);
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { acquired: false };
    throw err;
  }
  try {
    writeFileSync(fd, `${JSON.stringify({
      id,
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    })}\n`, 'utf-8');
    return { acquired: true, value: fn() };
  } finally {
    try { closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(lockPath); } catch { /* a crash leaves the lock fail-safe */ }
  }
}

/** THE-GRANT hardening (2026-07-20 audit B4): does this approvalId resolve to
 *  a REAL card that was RESOLVED APPROVED? 'refuted' = the card is missing,
 *  pending, rejected, expired, or cancelled — a consent claim built on it is
 *  invalid. 'unavailable' = the registry could not be read (transient) — the
 *  caller decides fail direction. */
type CardConsentVerification = 'verified' | 'refuted' | 'unavailable';
function verifyApprovedCard(approvalId: string): CardConsentVerification {
  try {
    // approval-registry imports this module, so this is an ESM import CYCLE —
    // safe because the namespace binding is only dereferenced at CALL time
    // (function declarations are hoisted by then), never at module eval.
    // NOTE: a lazy `require()` does NOT work here — this package is
    // "type":"module", so require is undefined at runtime and the catch would
    // silently fail-open (exactly how the first cut of this fix died in tests).
    const row = approvalRegistryForVerify.get(approvalId);
    if (!row) return 'refuted';
    return row.status === 'resolved'
      && row.resolution === 'approved'
      && row.presentation === null
      ? 'verified'
      : 'refuted';
  } catch {
    return 'unavailable';
  }
}

/** Consent inferred from a card id, VERIFIED against the registry. A refuted
 *  id reads as 'policy' — which the executor gate makes inert for irreversible
 *  sends (GRANT INVARIANT I1), surfacing an honest "needs your approval card"
 *  instead of executing on a dangling string. Transient registry unavailability
 *  fails OPEN to the claim (a read hiccup must not rebrand a real approval). */
function conversationEvidenceForRow(
  row: approvalRegistryForVerify.PendingApprovalRow,
): Extract<PendingActionApprovalEvidence, { kind: 'conversation' }> | null {
  const presentation = row.presentation;
  if (
    row.status !== 'resolved'
    || row.resolution !== 'approved'
    || !presentation?.promptEventId
    || !presentation.promptEventSeq
    || !presentation.responseSourceUserSeq
    || !presentation.responseUserId
  ) return null;
  return {
    kind: 'conversation',
    approvalId: row.approvalId,
    promptEventId: presentation.promptEventId,
    promptEventSeq: presentation.promptEventSeq,
    responseSourceUserSeq: presentation.responseSourceUserSeq,
    sourceUserSeq: presentation.sourceUserSeq,
    responderUserId: presentation.responseUserId,
    conversationKey: presentation.conversationKey,
    originReplyTargetDigest: presentation.originReplyTargetDigest,
  };
}

function inferCardConsent(approvalId: string): { by: PendingActionApprovedBy; evidence: PendingActionApprovalEvidence } {
  let conversationalSurface = false;
  try {
    const row = approvalRegistryForVerify.get(approvalId);
    conversationalSurface = Boolean(row?.presentation);
    const conversation = row ? conversationEvidenceForRow(row) : null;
    if (conversation) return { by: 'human', evidence: conversation };
  } catch { /* the fail-closed fallback below owns unreadable state */ }
  return verifyApprovedCard(approvalId) === 'verified'
    ? { by: 'human', evidence: { kind: 'card', approvalId } }
    : {
        by: 'policy',
        evidence: {
          kind: 'policy',
          scope: `${conversationalSurface ? 'unverified-human-decision' : 'unverified-card'}:${approvalId}`,
        },
      };
}

function safeReadRecord(file: string): PendingActionRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as PendingActionRecord;
    if (!parsed || typeof parsed.id !== 'string') return null;
    // Back-compat defaulting (THE-GRANT R-compat): records written before the
    // consent fields existed. Audit B4 (2026-07-20): the old inference minted
    // 'human' from ANY present approvalId string with no existence/approval
    // check — a dangling or rejected id read back as verified human consent
    // and the executor honored it. Now the inferred claim is VERIFIED against
    // the registry; refuted ids read as 'policy' (inert for sends).
    if (parsed.approvedBy === undefined || parsed.approvedBy === null) {
      if (parsed.status === 'approved' || parsed.status === 'executing' || parsed.status === 'executed') {
        if (parsed.approvalId) {
          const consent = inferCardConsent(parsed.approvalId);
          parsed.approvedBy = consent.by;
          parsed.approvalEvidence = consent.evidence;
        } else {
          parsed.approvedBy = 'policy';
          parsed.approvalEvidence = null;
        }
      } else {
        parsed.approvedBy = null;
        parsed.approvalEvidence = parsed.approvalEvidence ?? null;
      }
    }
    parsed.executionAuthority = parsed.executionAuthority ?? null;
    parsed.sourceUserSeq = Number.isSafeInteger(parsed.sourceUserSeq) && (parsed.sourceUserSeq ?? 0) > 0
      ? parsed.sourceUserSeq
      : null;
    return parsed;
  } catch {
    return null;
  }
}

export function queuePendingAction(input: QueuePendingActionInput): PendingActionRecord {
  const now = new Date().toISOString();
  const executionAuthority = input.executionAuthority ?? null;
  const payloadHash = pendingActionPayloadHash(input.toolName, input.payload, executionAuthority);
  const idempotencyKey = shortHash({
    kind: input.kind,
    toolName: input.toolName,
    payloadHash,
    targetSummary: input.targetSummary ?? '',
  });
  const record: PendingActionRecord = {
    id: newPendingActionId(),
    title: cleanLine(input.title, 'Pending action', 160),
    summary: cleanLine(input.summary, 'Prepared action waiting for approval.', 2000),
    kind: input.kind,
    toolName: cleanLine(input.toolName, 'unknown_tool', 160),
    payload: input.payload,
    executionAuthority,
    payloadHash,
    idempotencyKey,
    targetSummary: cleanLine(input.targetSummary, 'target not specified', 1000),
    preview: cleanLine(input.preview, 'no preview supplied', 8000),
    risk: cleanLine(input.risk, 'normal approval risk', 1000),
    rollback: cleanLine(input.rollback, 'no rollback noted', 1000),
    sessionId: input.sessionId?.trim() || null,
    sourceUserSeq: Number.isSafeInteger(input.sourceUserSeq) && (input.sourceUserSeq ?? 0) > 0
      ? input.sourceUserSeq as number
      : null,
    createdBy: cleanLine(input.createdBy, 'clementine', 120),
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    approvalId: null,
    approvedBy: null,
    approvalEvidence: null,
    resultSummary: null,
    history: [{ at: now, status: 'queued', note: 'Action payload queued before execution.', actor: input.createdBy ?? 'clementine' }],
  };
  return writeRecord(record);
}

export function getPendingAction(id: string): PendingActionRecord | null {
  const clean = id.trim();
  if (!clean) return null;
  const file = recordPath(clean);
  if (!existsSync(file)) return null;
  return safeReadRecord(file);
}

export function listPendingActions(filter: {
  status?: PendingActionStatus | 'all';
  sessionId?: string | null;
  limit?: number;
} = {}): PendingActionRecord[] {
  ensurePendingActionsDir();
  const status = filter.status ?? 'all';
  const sessionId = filter.sessionId?.trim() || null;
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 25)));
  return readdirSync(PENDING_ACTIONS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => safeReadRecord(path.join(PENDING_ACTIONS_DIR, file)))
    .filter((record): record is PendingActionRecord => Boolean(record))
    .filter((record) => status === 'all' || record.status === status)
    .filter((record) => !sessionId || record.sessionId === sessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** Statuses where an action is still "open" — queued or somewhere in the
 *  approval lifecycle, but not yet terminal (executed/failed/cancelled/rejected/
 *  expired). Used for dedup: an open card for the same payload should not be
 *  minted twice (the judge-fail-approval batch-loop guard). */
const OPEN_PENDING_STATUSES: ReadonlySet<PendingActionStatus> = new Set([
  'queued', 'approval_requested', 'approved', 'executing',
]);

const TERMINAL_PENDING_STATUSES: ReadonlySet<PendingActionStatus> = new Set([
  'rejected', 'expired', 'cancelled', 'executed', 'failed',
]);

/** Explicit monotonic graph. No generic "set status" path exists: approval can
 *  advance toward a claim or terminate before it; only the claim owner can
 *  leave EXECUTING, and every terminal node is immutable. */
const PENDING_ACTION_TRANSITIONS: Readonly<Record<PendingActionStatus, ReadonlySet<PendingActionStatus>>> = {
  queued: new Set(['approval_requested', 'approved', 'rejected', 'expired', 'cancelled']),
  approval_requested: new Set(['approved', 'rejected', 'expired', 'cancelled']),
  approved: new Set(['executing', 'rejected', 'expired', 'cancelled']),
  executing: new Set(['executed', 'failed']),
  rejected: new Set(),
  expired: new Set(),
  cancelled: new Set(),
  executed: new Set(),
  failed: new Set(),
};

/** Compute the payloadHash the way queuePendingAction does (stable over key
 *  order) so callers can dedup BEFORE minting. */
export function pendingActionPayloadHash(
  toolName: string,
  payload: unknown,
  executionAuthority: ComposioCliDefaultAccountAuthority | null = null,
): string {
  return executionAuthority
    ? shortHash({ toolName, payload, executionAuthority })
    : shortHash({ toolName, payload });
}

/** An OPEN pending action for the exact same tool + payload, if one already
 *  exists — so a repeated judge-failure on the same call (a batch loop) reuses
 *  the one card instead of minting a stack of duplicates. */
export function findOpenPendingActionByPayload(
  toolName: string,
  payload: unknown,
  options: {
    sessionId?: string | null;
    executionAuthority?: ComposioCliDefaultAccountAuthority | null;
  } = {},
): PendingActionRecord | null {
  const hash = pendingActionPayloadHash(
    toolName,
    payload,
    options.executionAuthority ?? null,
  );
  const sessionId = options.sessionId?.trim() || null;
  return listPendingActions({ status: 'all', limit: 100 })
    .find((record) => (
      record.payloadHash === hash
      && OPEN_PENDING_STATUSES.has(record.status)
      && (!sessionId || record.sessionId === sessionId)
    )) ?? null;
}

/** Replay identity for a provider permission boundary. Unlike the generic
 * open-action dedupe, this intentionally includes terminal rows: once the
 * exact accepted source has sent/rejected/failed this payload, replaying that
 * source must observe the old result instead of minting another send. A new
 * accepted source is distinct authority even when its provider bytes match. */
export function findPendingActionByPayloadAndSource(
  toolName: string,
  payload: unknown,
  input: {
    sessionId: string;
    sourceUserSeq: number;
    executionAuthority?: ComposioCliDefaultAccountAuthority | null;
  },
): PendingActionRecord | null {
  const hash = pendingActionPayloadHash(
    toolName,
    payload,
    input.executionAuthority ?? null,
  );
  ensurePendingActionsDir();
  return readdirSync(PENDING_ACTIONS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => safeReadRecord(path.join(PENDING_ACTIONS_DIR, file)))
    .filter((record): record is PendingActionRecord => Boolean(record))
    .filter((record) => (
      record.sessionId === input.sessionId
      && record.sourceUserSeq === input.sourceUserSeq
      && record.toolName === toolName
      && record.payloadHash === hash
    ))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

/** Cross-process atomic freeze for one exact accepted source/provider payload.
 * This is intentionally separate from the execution lock: it serializes only
 * the short find→write registration section and is always released. A crash
 * before the atomic rename writes no record; a crash after it leaves the one
 * complete record visible to the next caller. */
export function getOrCreatePendingActionByPayloadAndSource(
  input: QueuePendingActionInput & { sessionId: string; sourceUserSeq: number },
): { record: PendingActionRecord; created: boolean } {
  ensurePendingActionsDir();
  const executionAuthority = input.executionAuthority ?? null;
  const payloadHash = pendingActionPayloadHash(input.toolName, input.payload, executionAuthority);
  const lockKey = sourceFreezeTransitionLockKey({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    toolName: input.toolName,
    payloadHash,
  });
  const frozen = withPendingActionTransitionLockKey(lockKey, 'source_freeze', () => {
    const existing = findPendingActionByPayloadAndSource(
      input.toolName,
      input.payload,
      {
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        executionAuthority,
      },
    );
    if (existing) return { record: existing, created: false };
    return { record: queuePendingAction(input), created: true };
  });
  if (frozen.acquired) return frozen.value;
  // The winner may have committed while our bounded wait elapsed. Reuse that
  // exact source/payload if visible; otherwise fail closed and let the SDK
  // retry instead of minting a duplicate without serialization.
  const existing = findPendingActionByPayloadAndSource(
    input.toolName,
    input.payload,
    {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      executionAuthority,
    },
  );
  if (existing) return { record: existing, created: false };
  throw new Error('pending action source freeze is active or uncertain');
}

function updatePendingAction(
  id: string,
  status: PendingActionStatus,
  opts: {
    note?: string;
    actor?: string;
    approvalId?: string | null;
    resultSummary?: string | null;
    approvedBy?: PendingActionApprovedBy;
    approvalEvidence?: PendingActionApprovalEvidence;
    executionClaimToken?: string;
  } = {},
): PendingActionRecord | null {
  const mutate = (): PendingActionRecord | null => {
    const record = getPendingAction(id);
    if (!record) return null;
    const evidence = opts.approvalEvidence;
    const verifiedHumanUpgrade = record.status === 'approved'
      && status === 'approved'
      && record.approvedBy !== 'human'
      && opts.approvedBy === 'human'
      && Boolean(evidence)
      && (
        evidence?.kind === 'workflow'
        || (
          evidence?.kind === 'conversation'
          && opts.approvalId === evidence.approvalId
          && verifyConversationEvidence(evidence, record) === null
        )
        || (
          evidence?.kind === 'card'
          && opts.approvalId === evidence.approvalId
          && verifyApprovedCard(evidence.approvalId) === 'verified'
        )
      );
    // Same-state updates and every terminal rewrite are true no-ops: do not
    // touch approval provenance, timestamps, summaries, or history.
    if ((record.status === status && !verifiedHumanUpgrade) || TERMINAL_PENDING_STATUSES.has(record.status)) return record;
    if (record.status !== status && !PENDING_ACTION_TRANSITIONS[record.status].has(status)) return record;
    // EXECUTING is a capability-owned node. Neither a model-callable result
    // tool nor a competing executor can forge terminal truth using only the
    // public action id (or even by guessing the actor label).
    if (
      record.status === 'executing'
      && (status === 'executed' || status === 'failed')
      && (
        cleanLine(opts.actor, 'clementine', 120) !== record.executionClaimedBy
        || !executionTokenMatches(record.executionClaimTokenHash, opts.executionClaimToken)
      )
    ) {
      return record;
    }
    const now = new Date().toISOString();
    record.status = status;
    record.updatedAt = now;
    if (opts.approvalId !== undefined) record.approvalId = opts.approvalId;
    if (opts.resultSummary !== undefined) record.resultSummary = opts.resultSummary;
    // Human consent is monotonic. A later policy bookkeeping call may update the
    // status, but it can never downgrade a real card/workflow grant to policy.
    const wouldDowngradeHuman = record.approvedBy === 'human' && opts.approvedBy === 'policy';
    if (opts.approvedBy !== undefined && !wouldDowngradeHuman) record.approvedBy = opts.approvedBy;
    if (opts.approvalEvidence !== undefined && !wouldDowngradeHuman) record.approvalEvidence = opts.approvalEvidence;
    record.history = [
      ...(Array.isArray(record.history) ? record.history : []),
      { at: now, status, note: opts.note, actor: opts.actor },
    ];
    return writeRecord(record);
  };
  const locked = status === 'executed' || status === 'failed'
    ? withRecordExecutionLock(id, mutate)
    : withPendingActionTransitionLock(id, `status:${status}`, mutate);
  // Transition contention is bounded/retryable by the caller; strict
  // execution-lock contention remains uncertain and never authorizes replay.
  return locked.acquired ? locked.value : getPendingAction(id);
}

export type PendingActionExecutionClaimReason =
  | 'claimed'
  | 'not_found'
  | 'not_approved'
  | 'session_authority_mismatch'
  | 'payload_integrity_failed'
  | 'approval_authority_invalid'
  | 'pre_provider_transition_in_progress'
  | 'claim_in_progress_or_uncertain';

export interface PendingActionExecutionClaim {
  claimed: boolean;
  reason: PendingActionExecutionClaimReason;
  record: PendingActionRecord | null;
  /** Opaque one-shot capability held only by the winning executor. It is
   *  required, with the same actor, to finalize EXECUTING. */
  claimToken?: string;
}

export interface PendingActionExecutionClaimOptions {
  /** The caller's live session authority. Rechecked inside the same lock as the
   * approved→executing transition so a changed record cannot cross a TOCTOU gap. */
  expectedSessionId?: string;
  /** Irreversible/unknown external writes must be backed by one exact resolved
   * card whose immutable snapshot matches this record. */
  requireResolvedHumanCard?: boolean;
  /** Trusted subsystem-specific capability check, evaluated under the same
   * lock as the approved→executing claim. A non-empty reason terminally fails
   * the action before any provider boundary. */
  verifyExecutionAuthority?: (record: PendingActionRecord) => string | null;
}

function failPendingActionClaimIntegrity(
  record: PendingActionRecord,
  actor: string,
  reason: 'payload_integrity_failed' | 'approval_authority_invalid',
  detail: string,
): PendingActionExecutionClaim {
  const now = new Date().toISOString();
  record.status = 'failed';
  record.updatedAt = now;
  record.resultSummary = `${detail} No provider call was made. This authorization is terminal: recreate the pending action from the intended payload and ask the user to approve the new card before execution.`;
  record.history = [
    ...(Array.isArray(record.history) ? record.history : []),
    {
      at: now,
      status: 'failed',
      note: record.resultSummary,
      actor: cleanLine(actor, 'pending-action-executor', 120),
    },
  ];
  return {
    claimed: false,
    reason,
    record: writeRecord(record),
  };
}

function pinnedPendingActionView(args: Record<string, unknown> | null): Record<string, unknown> | null {
  const value = args?.pendingAction;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function verifyConversationEvidence(
  evidence: Extract<PendingActionApprovalEvidence, { kind: 'conversation' }>,
  record: PendingActionRecord,
): string | null {
  let row: approvalRegistryForVerify.PendingApprovalRow | undefined;
  try { row = approvalRegistryForVerify.get(evidence.approvalId); } catch {
    return 'The conversational human decision ledger could not be read.';
  }
  const presentation = row?.presentation;
  if (
    !row
    || row.status !== 'resolved'
    || row.resolution !== 'approved'
    || !record.sessionId
    || row.sessionId !== record.sessionId
    || !presentation
    || presentation.promptEventId !== evidence.promptEventId
    || presentation.promptEventSeq !== evidence.promptEventSeq
    || presentation.responseSourceUserSeq !== evidence.responseSourceUserSeq
    || presentation.sourceUserSeq !== evidence.sourceUserSeq
    || presentation.responseUserId !== evidence.responderUserId
    || presentation.audienceUserId !== evidence.responderUserId
    || presentation.conversationKey !== evidence.conversationKey
    || presentation.originReplyTargetDigest !== evidence.originReplyTargetDigest
  ) return 'The conversational decision provenance does not match its durable approval row.';
  const rowPendingActionId = row.args?.pendingActionId ?? row.args?.pending_action_id;
  const pinned = pinnedPendingActionView(row.args);
  const pinnedExecutionAuthority = pinned?.executionAuthority ?? null;
  const recordExecutionAuthority = record.executionAuthority ?? null;
  if (
    rowPendingActionId !== record.id
    || pinned?.id !== record.id
    || pinned.toolName !== record.toolName
    || pinned.payloadHash !== record.payloadHash
    || pendingActionPayloadHash(
      String(pinned.toolName),
      pinned.payload,
      pinnedExecutionAuthority as ComposioCliDefaultAccountAuthority | null,
    ) !== pinned.payloadHash
    || stableStringify(pinned.payload) !== stableStringify(record.payload)
    || stableStringify(pinnedExecutionAuthority) !== stableStringify(recordExecutionAuthority)
  ) return 'The conversational decision does not pin this exact pending action, payload, and execution authority.';
  const prompt = getEvent(evidence.promptEventId);
  if (
    !prompt
    || prompt.seq !== evidence.promptEventSeq
    || prompt.sessionId !== row.sessionId
    || prompt.type !== 'approval_requested'
    || prompt.data.approvalId !== row.approvalId
    || prompt.data.approvalPresentation !== 'conversation'
    || prompt.data.question !== presentation.question
  ) return 'The ordinary consent question is missing or does not name this exact approval.';
  const source = listEvents(row.sessionId, {
    sinceSeq: evidence.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === evidence.sourceUserSeq);
  if (
    !source
    || source.data.synthetic === true
    || source.data.userId !== evidence.responderUserId
    || source.data.conversationKey !== evidence.conversationKey
    || source.data.originReplyTargetDigest !== evidence.originReplyTargetDigest
  ) return 'The prepared send is not bound to the same accepted human and conversation that received the question.';
  const response = listEvents(row.sessionId, {
    sinceSeq: evidence.responseSourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === evidence.responseSourceUserSeq);
  if (
    !response
    || response.data.source !== 'channel_send_consent'
    || response.data.approvalId !== row.approvalId
    || response.data.decision !== 'approve'
    || response.data.userId !== evidence.responderUserId
    || response.data.conversationKey !== evidence.conversationKey
  ) return 'The approval reply source is missing or not the exact addressed human answer.';
  return null;
}

/** Shared read-only verifier for graph semantic rehydration and execution.
 * Both consumers must agree on the exact frozen payload and conversational
 * provenance; model-visible ids/hashes alone never elevate authority. */
export function verifyConversationalPendingActionAuthority(record: PendingActionRecord): boolean {
  return record.approvedBy === 'human'
    && record.approvalEvidence?.kind === 'conversation'
    && ['approved', 'executing', 'executed', 'failed'].includes(record.status)
    && verifyConversationEvidence(record.approvalEvidence, record) === null;
}

function verifyResolvedHumanCardAuthority(record: PendingActionRecord): string | null {
  if (
    record.approvedBy !== 'human'
    || !record.approvalId
  ) {
    return 'The action requires an exact human decision, but its durable consent provenance is missing or inconsistent.';
  }
  if (record.approvalEvidence?.kind === 'conversation') {
    if (record.approvalEvidence.approvalId !== record.approvalId) {
      return 'The conversational decision names a different approval row.';
    }
    return verifyConversationEvidence(record.approvalEvidence, record);
  }
  if (
    record.approvalEvidence?.kind !== 'card'
    || record.approvalEvidence.approvalId !== record.approvalId
  ) return 'The action requires a verified human card or conversational decision.';
  let row: approvalRegistryForVerify.PendingApprovalRow | undefined;
  try {
    row = approvalRegistryForVerify.get(record.approvalId);
  } catch {
    return 'The resolved approval card could not be verified at the execution boundary.';
  }
  if (
    !row
    || row.status !== 'resolved'
    || row.resolution !== 'approved'
    || row.approvalId !== record.approvalId
  ) {
    return 'The linked approval card is not durably resolved approved.';
  }
  if (!record.sessionId || row.sessionId !== record.sessionId) {
    return 'The linked approval card does not belong to the pending action session.';
  }
  const rowPendingActionId = row.args?.pendingActionId ?? row.args?.pending_action_id;
  const pinned = pinnedPendingActionView(row.args);
  if (
    rowPendingActionId !== record.id
    || pinned?.id !== record.id
    || pinned.toolName !== record.toolName
    || pinned.payloadHash !== record.payloadHash
  ) {
    return 'The resolved approval card does not pin this pending action id, tool, and payload hash.';
  }
  const pinnedExecutionAuthority = pinned.executionAuthority ?? null;
  const recordExecutionAuthority = record.executionAuthority ?? null;
  if (
    pendingActionPayloadHash(
      String(pinned.toolName),
      pinned.payload,
      pinnedExecutionAuthority as ComposioCliDefaultAccountAuthority | null,
    ) !== pinned.payloadHash
    || stableStringify(pinned.payload) !== stableStringify(record.payload)
    || stableStringify(pinnedExecutionAuthority) !== stableStringify(recordExecutionAuthority)
  ) {
    return 'The resolved approval card payload or execution-authority snapshot does not match the stored action.';
  }
  return null;
}

/**
 * Atomically consume an APPROVED action for execution.
 *
 * EXECUTING is deliberately non-retryable: if the daemon dies after this claim
 * and before recording a result, later callers report an uncertain in-flight
 * attempt and NEVER dispatch it automatically a second time.
 */
export function claimPendingActionExecution(
  id: string,
  actor = 'pending-action-executor',
  options: PendingActionExecutionClaimOptions = {},
): PendingActionExecutionClaim {
  const clean = id.trim();
  if (!clean) return { claimed: false, reason: 'not_found', record: null };
  const transition = withPendingActionTransitionLock(clean, 'approved_to_executing', () => {
    const locked = withRecordExecutionLock(clean, () => {
      const record = getPendingAction(clean);
      if (!record) return { claimed: false, reason: 'not_found', record: null } satisfies PendingActionExecutionClaim;
      if (record.status !== 'approved') {
        return { claimed: false, reason: 'not_approved', record } satisfies PendingActionExecutionClaim;
      }
    if (
      options.expectedSessionId !== undefined
      && (!record.sessionId || record.sessionId !== options.expectedSessionId)
    ) {
      return {
        claimed: false,
        reason: 'session_authority_mismatch',
        record,
      } satisfies PendingActionExecutionClaim;
    }
    const recomputedPayloadHash = pendingActionPayloadHash(
      record.toolName,
      record.payload,
      record.executionAuthority ?? null,
    );
    if (recomputedPayloadHash !== record.payloadHash) {
      return failPendingActionClaimIntegrity(
        record,
        actor,
        'payload_integrity_failed',
        `Pending action ${record.id} failed its pre-dispatch payload integrity check: the stored tool/payload no longer matches the approved payload hash.`,
      );
    }
    if (options.requireResolvedHumanCard) {
      const authorityError = verifyResolvedHumanCardAuthority(record);
      if (authorityError) {
        return failPendingActionClaimIntegrity(
          record,
          actor,
          'approval_authority_invalid',
          `Pending action ${record.id} failed its pre-dispatch approval-authority check: ${authorityError}`,
        );
      }
    }
    const executionAuthorityError = options.verifyExecutionAuthority?.(record) ?? null;
    if (executionAuthorityError) {
      return failPendingActionClaimIntegrity(
        record,
        actor,
        'approval_authority_invalid',
        `Pending action ${record.id} failed its pre-dispatch execution-authority check: ${executionAuthorityError}`,
      );
    }
    const now = new Date().toISOString();
    const claimedBy = cleanLine(actor, 'pending-action-executor', 120);
    const claimToken = randomBytes(32).toString('base64url');
    record.status = 'executing';
    record.updatedAt = now;
    record.executionClaimTokenHash = executionTokenHash(claimToken);
    record.executionClaimedBy = claimedBy;
    record.executionClaimedAt = now;
    record.resultSummary = 'Execution claimed. Outcome is pending or uncertain; never retry this action automatically.';
    record.history = [
      ...(Array.isArray(record.history) ? record.history : []),
      {
        at: now,
        status: 'executing',
        note: 'Approved payload atomically claimed for one execution attempt.',
        actor: claimedBy,
      },
    ];
      return {
        claimed: true,
        reason: 'claimed',
        record: writeRecord(record),
        claimToken,
      } satisfies PendingActionExecutionClaim;
    });
    if (locked.acquired) return locked.value;
    return {
      claimed: false,
      reason: 'claim_in_progress_or_uncertain',
      record: getPendingAction(clean),
    } satisfies PendingActionExecutionClaim;
  });
  if (transition.acquired) return transition.value;
  const record = getPendingAction(clean);
  return {
    claimed: false,
    reason: !record
      ? 'not_found'
      : record.status === 'approved'
        ? 'pre_provider_transition_in_progress'
        : record.status === 'executing'
          ? 'claim_in_progress_or_uncertain'
          : 'not_approved',
    record,
  };
}

export function linkPendingActionApproval(id: string, approvalId: string): PendingActionRecord | null {
  // A policy-approved irreversible send is intentionally inert, but the user
  // must still be able to attach a real approval card and upgrade its consent
  // provenance. Keep the state at APPROVED (no backwards edge) while binding
  // the exact card; the verified same-state human upgrade happens on resolve.
  const current = getPendingAction(id);
  if (
    current?.status === 'approval_requested'
    || (current?.status === 'approved' && current.approvedBy !== 'human')
  ) {
    const locked = withPendingActionTransitionLock(id, 'link_approval', () => {
      const record = getPendingAction(id);
      if (
        !record
        || (
          record.status !== 'approval_requested'
          && !(record.status === 'approved' && record.approvedBy !== 'human')
        )
      ) return record;
      const cleanApprovalId = cleanLine(approvalId, '', 160);
      if (!cleanApprovalId || record.approvalId === cleanApprovalId) return record;
      const now = new Date().toISOString();
      record.approvalId = cleanApprovalId;
      record.updatedAt = now;
      record.history = [
        ...(Array.isArray(record.history) ? record.history : []),
        {
          at: now,
          status: record.status,
          note: `Approval requested: ${cleanApprovalId}`,
          actor: 'approval-registry',
        },
      ];
      return writeRecord(record);
    });
    return locked.acquired ? locked.value : getPendingAction(id);
  }
  return updatePendingAction(id, 'approval_requested', {
    approvalId,
    note: `Approval requested: ${approvalId}`,
    actor: 'approval-registry',
  });
}

/** Collapse a same-request queue race without touching a row that acquired any
 * approval authority in the meantime. The status+link check and mutation share
 * the record lock, so a concurrent card can never be cancelled by this cleanup. */
export function cancelPendingActionIfQueuedUnlinked(
  id: string,
  canonicalId: string,
  reason = `Deduplicated same-request retry; canonical pending action is ${canonicalId}.`,
): PendingActionRecord | null {
  const clean = id.trim();
  if (!clean) return null;
  const locked = withPendingActionTransitionLock(clean, 'cancel_unlinked_duplicate', () => {
    const record = getPendingAction(clean);
    if (!record || record.status !== 'queued' || record.approvalId) return record;
    const now = new Date().toISOString();
    record.status = 'cancelled';
    record.updatedAt = now;
    record.resultSummary = reason;
    record.history = [
      ...(Array.isArray(record.history) ? record.history : []),
      {
        at: now,
        status: 'cancelled',
        note: record.resultSummary,
        actor: 'pending-action-graph-transition',
      },
    ];
    return writeRecord(record);
  });
  return locked.acquired ? locked.value : getPendingAction(clean);
}

export function markPendingActionApprovalResolved(
  id: string,
  resolution: 'approved' | 'rejected' | 'expired' | 'cancelled_by_user' | 'cancelled_by_system',
  approvalId?: string | null,
  consent?: { by: PendingActionApprovedBy; evidence: PendingActionApprovalEvidence },
): PendingActionRecord | null {
  const status: PendingActionStatus =
    resolution === 'approved' ? 'approved'
      : resolution === 'rejected' ? 'rejected'
        : resolution === 'expired' ? 'expired'
          : 'cancelled';
  // Consent provenance (THE-GRANT R1, Phase-1 form): a resolution that carries
  // a real approvalId is a human card decision; anything else must declare
  // itself. The policy path (orchestrator auto-approve) passes an explicit
  // 'policy' consent — it can never claim 'human'. Audit B4 (2026-07-20): the
  // inferred human claim is now VERIFIED against the registry (a dangling or
  // non-approved id reads as 'policy', inert for irreversible sends).
  const resolvedConsent = resolution === 'approved'
    ? consent ?? (approvalId
      ? inferCardConsent(approvalId)
      : { by: 'policy' as const, evidence: { kind: 'policy' as const, scope: 'unspecified' } })
    : undefined;
  return updatePendingAction(id, status, {
    approvalId: approvalId ?? undefined,
    note: `Approval ${resolution}${approvalId ? ` (${approvalId})` : ''}.`,
    actor: 'approval-registry',
    ...(resolvedConsent ? { approvedBy: resolvedConsent.by, approvalEvidence: resolvedConsent.evidence } : {}),
  });
}

export function recordPendingActionResult(
  id: string,
  status: 'executed' | 'failed' | 'cancelled',
  resultSummary: string,
  actor = 'clementine',
  executionClaimToken?: string,
): PendingActionRecord | null {
  return updatePendingAction(id, status, {
    resultSummary: cleanLine(resultSummary, status, 4000),
    note: resultSummary,
    actor,
    executionClaimToken,
  });
}

export function parsePendingActionPayloadJson(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`payloadJson must be valid JSON: ${message}`);
  }
}

export function formatPendingAction(record: PendingActionRecord, opts: { verbose?: boolean } = {}): string {
  const lines = [
    `${record.id} [${record.status}] ${record.title}`,
    `Tool: ${record.toolName}`,
    `Target: ${record.targetSummary}`,
    `Payload hash: ${record.payloadHash}`,
    `Idempotency key: ${record.idempotencyKey}`,
  ];
  if (record.approvalId) lines.push(`Approval: ${record.approvalId}`);
  if (record.executionAuthority) {
    lines.push(
      `CLI default authority: ${record.executionAuthority.toolkit} — ${record.executionAuthority.label}`,
    );
  }
  if (opts.verbose) {
    lines.push(
      `Summary: ${record.summary}`,
      `Preview: ${record.preview}`,
      `Risk: ${record.risk}`,
      `Rollback: ${record.rollback}`,
    );
    if (record.resultSummary) lines.push(`Result: ${record.resultSummary}`);
  }
  return lines.join('\n');
}
