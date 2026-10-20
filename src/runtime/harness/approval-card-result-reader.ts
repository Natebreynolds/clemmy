/** Exact-card display read. No execution, resume, narration or state transition. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import * as registry from './approval-registry.js';
import { getPendingAction, pendingActionPayloadHash, PENDING_ACTIONS_DIR, PENDING_ACTION_STATUSES } from './pending-actions.js';
import { pendingActionPublicResult, type PendingActionPublicResult } from './pending-action-public-result.js';
import type { PendingActionRecord } from './pending-actions.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';

export interface ApprovalCardResultQuery {
  approvalId: unknown;
  sessionId: unknown;
  pendingActionId?: unknown;
  payloadHash?: unknown;
  recordUpdatedAt?: unknown;
}
export interface ApprovalCardResultSnapshot {
  approvalId: string;
  sessionId: string;
  pendingAction: {
    id: string; approvalId: string; payloadHash: string; updatedAt: string; status: string;
    resultSummary: string | null; publicResult?: PendingActionPublicResult;
  };
}
export type ApprovalCardResultRead = { ok: true; value: ApprovalCardResultSnapshot }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };
const error = (status: 400 | 404 | 409 | 503, value: string): ApprovalCardResultRead => ({ ok: false, status, error: value });
const ownText = (value: unknown, max: number): value is string => typeof value === 'string'
  && value === value.trim() && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const safeId = (value: unknown): value is string => ownText(value, 192) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const digest = (value: unknown): string => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');

/** This is a frozen relation, not a lookup by a title, provider or newest turn.
 * A slim old event may discover this same relation once through its exact card. */
function frozenAction(row: registry.PendingApprovalRow): { id: string; payloadHash: string } | null {
  const args = object(row.args);
  const snapshot = object(args?.pendingAction);
  const ids = [args?.pendingActionId, args?.pending_action_id].filter(value => value !== undefined);
  if (!snapshot || !safeId(snapshot.id) || ids.length === 0 || ids.some(id => id !== snapshot.id)
    || typeof snapshot.payloadHash !== 'string' || !/^[a-f0-9]{16}$/.test(snapshot.payloadHash)
    || (snapshot.approvalId != null && snapshot.approvalId !== row.approvalId)
    || (snapshot.sessionId != null && snapshot.sessionId !== row.sessionId)) return null;
  return { id: snapshot.id, payloadHash: snapshot.payloadHash };
}
function fileGeneration(id: string): string {
  const stat = lstatSync(path.join(PENDING_ACTIONS_DIR, `${id}.json`), { bigint: true });
  if (!stat.isFile() || stat.size > 1_048_576n) throw new Error('result_record_unreadable');
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;
}
function cardDigest(row: registry.PendingApprovalRow): string {
  return digest({ approvalId: row.approvalId, sessionId: row.sessionId, args: row.args, requestedAt: row.requestedAt,
    status: row.status, resolution: row.resolution, consumedAt: row.consumedAt, presentation: row.presentation });
}

/** History uses the cheap record-only projection. Authenticated GET handlers
 * supply the canonical terminal reader explicitly; request data cannot select it. */
export function readApprovalCardResultSnapshot(query: ApprovalCardResultQuery,
  readPublicResult: (action: PendingActionRecord) => PendingActionPublicResult | null = pendingActionPublicResult,
): ApprovalCardResultRead {
  if (!safeId(query.approvalId) || !ownText(query.sessionId, 1024)
    || (query.pendingActionId !== undefined && !safeId(query.pendingActionId))
    || (query.payloadHash !== undefined && (typeof query.payloadHash !== 'string' || !/^[a-f0-9]{16}$/.test(query.payloadHash)))
    || (query.recordUpdatedAt !== undefined && (!ownText(query.recordUpdatedAt, 64)
      || !Number.isFinite(Date.parse(query.recordUpdatedAt))))) return error(400, 'approval_result_query_invalid');
  try {
    const row = registry.get(query.approvalId);
    if (!row || row.sessionId !== query.sessionId || !registry.isFormalApprovalSurface(row)) return error(404, 'approval_result_not_found');
    const frozen = frozenAction(row);
    if (!frozen) return error(404, 'approval_result_not_bound');
    if ((query.pendingActionId !== undefined && query.pendingActionId !== frozen.id)
      || (query.payloadHash !== undefined && query.payloadHash !== frozen.payloadHash)) return error(409, 'approval_result_binding_changed');
    const generation = fileGeneration(frozen.id);
    const action = getPendingAction(frozen.id);
    if (!action) return error(404, 'approval_result_not_found');
    if (action.id !== frozen.id || action.approvalId !== row.approvalId || action.sessionId !== row.sessionId
      || action.payloadHash !== frozen.payloadHash
      || pendingActionPayloadHash(action.toolName, action.payload, action.executionAuthority ?? null) !== frozen.payloadHash
      || !PENDING_ACTION_STATUSES.includes(action.status) || !ownText(action.updatedAt, 64)
      || !Number.isFinite(Date.parse(action.updatedAt))
      || (action.resultSummary !== null && (typeof action.resultSummary !== 'string' || action.resultSummary.length > 16_000))) {
      return error(409, 'approval_result_binding_changed');
    }
    if (typeof query.recordUpdatedAt === 'string' && Date.parse(action.updatedAt) < Date.parse(query.recordUpdatedAt)) {
      return error(409, 'approval_result_revision_changed');
    }
    const firstCard = cardDigest(row);
    const firstAction = digest(action);
    const publicResult = readPublicResult(action);
    const currentRow = registry.get(row.approvalId);
    const currentAction = getPendingAction(frozen.id);
    if (generation !== fileGeneration(frozen.id) || !currentRow || !currentAction
      || cardDigest(currentRow) !== firstCard || digest(currentAction) !== firstAction) {
      return error(409, 'approval_result_changed_during_read');
    }
    const value: ApprovalCardResultSnapshot = { approvalId: row.approvalId, sessionId: row.sessionId,
      pendingAction: { id: action.id, approvalId: row.approvalId, payloadHash: action.payloadHash,
        updatedAt: action.updatedAt, status: action.status, resultSummary: action.resultSummary,
        ...(publicResult ? { publicResult } : {}) } };
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64_000) return error(503, 'approval_result_unavailable');
    return { ok: true, value };
  } catch { return error(503, 'approval_result_unavailable'); }
}
