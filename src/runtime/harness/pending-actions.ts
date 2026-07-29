import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

export const PENDING_ACTIONS_DIR = path.join(BASE_DIR, 'pending-actions');

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
  | { kind: 'workflow'; workflowRunId: string }
  | { kind: 'policy'; scope: string };

export interface PendingActionRecord {
  id: string;
  title: string;
  summary: string;
  kind: PendingActionKind;
  toolName: string;
  payload: unknown;
  payloadHash: string;
  idempotencyKey: string;
  targetSummary: string;
  preview: string;
  risk: string;
  rollback: string;
  sessionId: string | null;
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

export interface QueuePendingActionInput {
  title: string;
  summary: string;
  kind: PendingActionKind;
  toolName: string;
  payload: unknown;
  targetSummary?: string | null;
  preview?: string | null;
  risk?: string | null;
  rollback?: string | null;
  sessionId?: string | null;
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

/**
 * A filesystem O_EXCL lock makes the approved→executing compare-and-swap safe
 * across daemon processes, not only concurrent promises in one process.
 *
 * The lock is intentionally never considered stale automatically. If a process
 * dies in the tiny synchronous claim section, the orphaned lock leaves the
 * action inert and requiring manual inspection; deleting it automatically
 * could replay an irreversible action whose dispatch boundary was uncertain.
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
    return row.status === 'resolved' && row.resolution === 'approved' ? 'verified' : 'refuted';
  } catch {
    return 'unavailable';
  }
}

/** Consent inferred from a card id, VERIFIED against the registry. A refuted
 *  id reads as 'policy' — which the executor gate makes inert for irreversible
 *  sends (GRANT INVARIANT I1), surfacing an honest "needs your approval card"
 *  instead of executing on a dangling string. Transient registry unavailability
 *  fails OPEN to the claim (a read hiccup must not rebrand a real approval). */
function inferCardConsent(approvalId: string): { by: PendingActionApprovedBy; evidence: PendingActionApprovalEvidence } {
  return verifyApprovedCard(approvalId) === 'refuted'
    ? { by: 'policy', evidence: { kind: 'policy', scope: `unverified-card:${approvalId}` } }
    : { by: 'human', evidence: { kind: 'card', approvalId } };
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
    return parsed;
  } catch {
    return null;
  }
}

export function queuePendingAction(input: QueuePendingActionInput): PendingActionRecord {
  const now = new Date().toISOString();
  const payloadHash = shortHash({ toolName: input.toolName, payload: input.payload });
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
    payloadHash,
    idempotencyKey,
    targetSummary: cleanLine(input.targetSummary, 'target not specified', 1000),
    preview: cleanLine(input.preview, 'no preview supplied', 8000),
    risk: cleanLine(input.risk, 'normal approval risk', 1000),
    rollback: cleanLine(input.rollback, 'no rollback noted', 1000),
    sessionId: input.sessionId?.trim() || null,
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
export function pendingActionPayloadHash(toolName: string, payload: unknown): string {
  return shortHash({ toolName, payload });
}

/** An OPEN pending action for the exact same tool + payload, if one already
 *  exists — so a repeated judge-failure on the same call (a batch loop) reuses
 *  the one card instead of minting a stack of duplicates. */
export function findOpenPendingActionByPayload(toolName: string, payload: unknown): PendingActionRecord | null {
  const hash = pendingActionPayloadHash(toolName, payload);
  return listPendingActions({ status: 'all', limit: 100 })
    .find((record) => record.payloadHash === hash && OPEN_PENDING_STATUSES.has(record.status)) ?? null;
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
  const locked = withRecordExecutionLock(id, () => {
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
  });
  // A live/stale lock means another executor owns (or may have owned) this
  // transition. Returning current durable truth is safer than waiting and
  // accidentally replaying an irreversible action.
  return locked.acquired ? locked.value : getPendingAction(id);
}

export type PendingActionExecutionClaimReason =
  | 'claimed'
  | 'not_found'
  | 'not_approved'
  | 'session_authority_mismatch'
  | 'payload_integrity_failed'
  | 'approval_authority_invalid'
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

function verifyResolvedHumanCardAuthority(record: PendingActionRecord): string | null {
  if (
    record.approvedBy !== 'human'
    || record.approvalEvidence?.kind !== 'card'
    || !record.approvalId
    || record.approvalEvidence.approvalId !== record.approvalId
  ) {
    return 'The action requires an exact human approval card, but its durable consent provenance is missing or inconsistent.';
  }
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
  const pinnedHash = pendingActionPayloadHash(String(pinned.toolName), pinned.payload);
  if (
    pinnedHash !== pinned.payloadHash
    || stableStringify(pinned.payload) !== stableStringify(record.payload)
  ) {
    return 'The resolved approval card payload snapshot does not match the stored action payload.';
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
    const recomputedPayloadHash = pendingActionPayloadHash(record.toolName, record.payload);
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
    const locked = withRecordExecutionLock(id, () => {
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
  const locked = withRecordExecutionLock(clean, () => {
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
  resolution: 'approved' | 'rejected' | 'expired' | 'cancelled_by_user',
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
