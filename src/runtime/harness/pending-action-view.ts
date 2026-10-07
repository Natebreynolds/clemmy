import { getPendingAction, type PendingActionRecord } from './pending-actions.js';

export interface PendingActionApprovalView {
  id: string;
  title: string;
  summary: string;
  /** Clem's question to the owner; the card's heading. */
  ask: string;
  why?: string;
  kind: string;
  status: string;
  toolName: string;
  targetSummary: string;
  preview: string;
  risk: string;
  rollback: string;
  payload: unknown;
  executionAuthority: PendingActionRecord['executionAuthority'];
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

/** The card's heading in Clem's words. A record queued without her words
 * (an older caller) still asks as her, from its title, never as a tool name. */
export function pendingActionAsk(record: Pick<PendingActionRecord, 'title' | 'ask'>): string {
  if (record.ask?.trim()) return record.ask.trim();
  const title = record.title.trim().replace(/[.?!]+$/, '');
  const lowered = title ? title.charAt(0).toLowerCase() + title.slice(1) : 'go ahead';
  return `I need to ${lowered}. OK to go ahead?`;
}

export function pendingActionApprovalView(record: PendingActionRecord): PendingActionApprovalView {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    ask: pendingActionAsk(record),
    ...(record.why?.trim() ? { why: record.why.trim() } : {}),
    kind: record.kind,
    status: record.status,
    toolName: record.toolName,
    targetSummary: record.targetSummary,
    preview: record.preview,
    risk: record.risk,
    rollback: record.rollback,
    payload: record.payload,
    executionAuthority: record.executionAuthority ?? null,
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
  if (id) {
    const record = getPendingAction(id);
    if (record) return pendingActionApprovalView(record);
  }
  return synthesizedViewFromBatchPlan(args);
}

/**
 * A run_batch `propose` approval fires BEFORE any pending action exists, so
 * there is no queue record to render — which left the approval card with a
 * bare "run_batch: propose" and zero context while the payload carried the
 * full plan (ask-first batch regression: an Approve button for 10 outbound
 * emails with no recipients, no count, no objective). Synthesize the rich
 * view straight from the plan so the card shows what approval actually means.
 */
function synthesizedViewFromBatchPlan(args: unknown): PendingActionApprovalView | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const plan = (args as Record<string, unknown>).plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return undefined;
  const p = plan as { sideEffect?: unknown; items?: unknown; composioSlug?: unknown; tool?: unknown; objective?: unknown };
  const items = Array.isArray(p.items) ? (p.items as Array<{ id?: unknown; args?: unknown }>) : [];
  if (items.length === 0) return undefined;
  const sideEffect = typeof p.sideEffect === 'string' ? p.sideEffect : 'write';
  const tool = typeof p.composioSlug === 'string' && p.composioSlug ? p.composioSlug : typeof p.tool === 'string' ? p.tool : 'batch';
  const objective = typeof p.objective === 'string' ? p.objective : '';
  const ids = items.map((i) => (typeof i.id === 'string' ? i.id : '')).filter(Boolean);
  const now = new Date().toISOString();
  const title = `Batch ${sideEffect}: ${objective.slice(0, 80) || tool}`;
  return {
    id: '',
    title,
    ask: `I'd like to ${sideEffect} ${items.length} item${items.length === 1 ? '' : 's'} through ${tool}${objective ? ` — ${objective.slice(0, 80)}` : ''}. OK to go ahead?`,
    summary: `${items.length} ${sideEffect} item(s) via ${tool}${objective ? ` — ${objective}` : ''}`,
    kind: sideEffect === 'send' ? 'external_send' : 'external_write',
    status: 'proposed',
    toolName: 'run_batch',
    targetSummary: `${items.length} item(s): ${ids.slice(0, 12).join(', ')}${items.length > 12 ? ' …' : ''}`,
    preview: JSON.stringify(items[0]?.args ?? {}).slice(0, 400),
    risk: sideEffect === 'send'
      ? `Approving executes ${items.length} irreversible send(s) with no further review.`
      : `Approving executes ${items.length} ${sideEffect} call(s) with no further review.`,
    rollback: sideEffect === 'send' ? 'Sends are irreversible once delivered.' : 'Depends on the target tool; the ledger lists every executed item.',
    payload: plan,
    executionAuthority: null,
    payloadHash: '',
    idempotencyKey: '',
    approvalId: null,
    resultSummary: null,
    createdAt: now,
    updatedAt: now,
  };
}
