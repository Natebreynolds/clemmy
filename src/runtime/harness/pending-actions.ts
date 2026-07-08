import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

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

function safeReadRecord(file: string): PendingActionRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as PendingActionRecord;
    if (!parsed || typeof parsed.id !== 'string') return null;
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
  opts: { note?: string; actor?: string; approvalId?: string | null; resultSummary?: string | null } = {},
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
): PendingActionRecord | null {
  const status: PendingActionStatus =
    resolution === 'approved' ? 'approved'
      : resolution === 'rejected' ? 'rejected'
        : resolution === 'expired' ? 'expired'
          : 'cancelled';
  return updatePendingAction(id, status, {
    approvalId: approvalId ?? undefined,
    note: `Approval ${resolution}${approvalId ? ` (${approvalId})` : ''}.`,
    actor: 'approval-registry',
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
