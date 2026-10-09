import { getPendingAction, type PendingActionRecord } from './pending-actions.js';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { outgoingFilesInCommand } from '../shell-outgoing-files.js';
import { LocalFileSendRefusal, describeLocalFileToSend, resolveLocalFileToSend } from '../local-file-sending.js';

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
  /** The local files a command would send off this computer, each named
   * by name, size and folder (or why it cannot be sent). Display only. */
  files?: string[];
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
    ...(() => {
      const files = pendingActionOutgoingFiles(record);
      return files.length > 0 ? { files } : {};
    })(),
  };
}

/** The files a queued command would send from this computer, as the card names them. */
export function pendingActionOutgoingFiles(record: Pick<PendingActionRecord, 'toolName' | 'kind' | 'payload'>): string[] {
  const shell = record.toolName === 'run_shell_command' || record.kind === 'shell_command';
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown> : null;
  if (!shell || !payload || typeof payload.command !== 'string') return [];
  try {
    const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : BASE_DIR;
    return outgoingFilesInCommand(payload.command, cwd).slice(0, 8).map((file) => {
      try {
        return describeLocalFileToSend(resolveLocalFileToSend(file));
      } catch (error) {
        return `${path.basename(file)}: cannot be sent (${error instanceof LocalFileSendRefusal ? error.message : 'it cannot be read'})`;
      }
    });
  } catch {
    return [];
  }
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
