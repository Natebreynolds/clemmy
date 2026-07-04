import { getPendingAction, type PendingActionRecord } from './pending-actions.js';

export interface PendingActionApprovalView {
  id: string;
  title: string;
  summary: string;
  kind: string;
  status: string;
  toolName: string;
  targetSummary: string;
  preview: string;
  risk: string;
  rollback: string;
  payload: unknown;
  payloadHash: string;
  idempotencyKey: string;
  approvalId: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export function pendingActionIdFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const raw = (args as Record<string, unknown>).pendingActionId
    ?? (args as Record<string, unknown>).pending_action_id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function pendingActionApprovalView(record: PendingActionRecord): PendingActionApprovalView {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    kind: record.kind,
    status: record.status,
    toolName: record.toolName,
    targetSummary: record.targetSummary,
    preview: record.preview,
    risk: record.risk,
    rollback: record.rollback,
    payload: record.payload,
    payloadHash: record.payloadHash,
    idempotencyKey: record.idempotencyKey,
    approvalId: record.approvalId,
    resultSummary: record.resultSummary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function pendingActionApprovalViewFromArgs(args: unknown): PendingActionApprovalView | undefined {
  const id = pendingActionIdFromArgs(args);
  if (!id) return undefined;
  const record = getPendingAction(id);
  return record ? pendingActionApprovalView(record) : undefined;
}
