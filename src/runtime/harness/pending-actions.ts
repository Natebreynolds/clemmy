import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

function cleanLine(value: string | null | undefined, fallback: string, max = 1000): string {
  const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, max);
}

function writeRecord(record: PendingActionRecord): PendingActionRecord {
  ensurePendingActionsDir();
  writeFileSync(recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  return record;
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
      if (parsed.status === 'approved' || parsed.status === 'executed') {
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
  'queued', 'approval_requested', 'approved',
]);

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
  } = {},
): PendingActionRecord | null {
  const record = getPendingAction(id);
  if (!record) return null;
  const terminal = new Set<PendingActionStatus>(['executed', 'failed', 'cancelled']);
  if (terminal.has(record.status) && record.status !== status) return record;
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
}

export function linkPendingActionApproval(id: string, approvalId: string): PendingActionRecord | null {
  return updatePendingAction(id, 'approval_requested', {
    approvalId,
    note: `Approval requested: ${approvalId}`,
    actor: 'approval-registry',
  });
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
): PendingActionRecord | null {
  return updatePendingAction(id, status, {
    resultSummary: cleanLine(resultSummary, status, 4000),
    note: resultSummary,
    actor,
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
