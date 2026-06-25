/**
 * Tasks board — the unified background-work Kanban. Reads GET
 * /api/console/board (background tasks · runs · executions · in-flight
 * workflow runs) and routes drag actions to the right POST per source.
 *
 * A drop is a REQUEST: the frontend checks the dragged card's `actions`
 * allowlist before firing, the server re-validates, and the board re-polls
 * so the card lands wherever its real status puts it (snap-back on reject).
 */
import { apiGet, apiPost } from './api';
import type { Tone } from '@/components/ui/StatusPill';

export type BoardColumnId = 'queued' | 'running' | 'needs_you' | 'done';
export type BoardSourceKind = 'background' | 'run' | 'execution' | 'workflow';

export interface BoardCard {
  id: string;
  sourceKind: BoardSourceKind;
  title: string;
  column: BoardColumnId;
  status: string;
  progressHint: string;
  sessionId: string | null;
  ageMs: number;
  updatedAt: string;
  /** Allowed actions: 'cancel' | 'resume' | 'promote' | 'archive' | 'restore'. */
  actions: string[];
  /** A finished/parked background task idle past the stale threshold (>7d). */
  stale?: boolean;
  staleKind?: 'finished' | 'parked';
  /** Soft-deleted (only present when the board was fetched with ?includeArchived=1). */
  archived?: boolean;
  raw: {
    workflowName?: string;
    runId?: string;
    error?: string;
    blocker?: string;
    pausedBy?: string;
    source?: string;
    objective?: string;
    resultPreview?: string;
    pendingApprovalId?: string;
  };
}

export const COLUMNS: { id: BoardColumnId; label: string }[] = [
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'done', label: 'Done' },
];

export const listBoard = () => apiGet<{ cards: BoardCard[]; generatedAt: string }>('/api/console/board');

/**
 * The action a drop onto `target` would trigger, or null if the move isn't
 * legal for this card. Each action verb maps to exactly one target column:
 * cancel → done, resume/promote → running. The card's server-computed
 * `actions` allowlist is the source of truth.
 */
export function intentForDrop(card: BoardCard, target: BoardColumnId): 'cancel' | 'resume' | 'promote' | null {
  if (target === card.column) return null; // no-op (in-column reorder is Phase 2)
  if (target === 'done' && card.actions.includes('cancel')) return 'cancel';
  if (target === 'running' && card.actions.includes('promote')) return 'promote';
  if (target === 'running' && card.actions.includes('resume')) return 'resume';
  return null;
}

/** Why a drop was rejected, for the snap-back toast. */
export function rejectReason(card: BoardCard, target: BoardColumnId): string {
  if (target === card.column) return '';
  if (target === 'done') return 'This card can’t be cancelled.';
  if (card.status === 'awaiting_approval') return 'Approve from the card to continue — a drag can’t grant approval.';
  if (card.status === 'awaiting_continue') return 'Move it to Running to continue the background task.';
  if (target === 'running') return 'Nothing to start or resume here.';
  return 'That move isn’t available.';
}

export type BoardActionIntent = 'cancel' | 'resume' | 'promote' | 'archive' | 'restore';

export async function runBoardAction(card: BoardCard, intent: BoardActionIntent): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (card.sourceKind === 'background') {
      // archive/restore + cancel/resume/promote all route to the same per-id action endpoint.
      return await apiPost<{ ok: boolean; reason?: string }>(`/api/console/board/background/${encodeURIComponent(card.id)}/${intent}`);
    }
    if (card.sourceKind === 'execution') {
      const to = intent === 'cancel' ? 'cancelled' : 'active';
      return await apiPost<{ ok: boolean; reason?: string }>(`/api/console/board/execution/${encodeURIComponent(card.id)}/transition`, { to });
    }
    if (card.sourceKind === 'run' && intent === 'cancel') {
      return await apiPost<{ ok: boolean; reason?: string }>(`/api/console/board/run/${encodeURIComponent(card.id)}/cancel`);
    }
    if (card.sourceKind === 'workflow' && intent === 'cancel' && card.raw.workflowName && card.raw.runId) {
      return await apiPost<{ ok: boolean; reason?: string }>(
        `/api/console/workflows/${encodeURIComponent(card.raw.workflowName)}/runs/${encodeURIComponent(card.raw.runId)}/cancel`,
        { reason: 'Cancelled from the Tasks board.' },
      );
    }
    return { ok: false, reason: 'That action isn’t available for this card.' };
  } catch (err) {
    const reason = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'Action failed.';
    return { ok: false, reason };
  }
}

/** A short, human label for the card's source kind (shown as a chip). */
export function sourceLabel(kind: BoardSourceKind): string {
  switch (kind) {
    case 'background': return 'Task';
    case 'workflow': return 'Workflow';
    case 'execution': return 'Goal';
    case 'run': return 'Run';
  }
}

/** Map a board status/column to a semantic pill tone + label. */
export function cardTone(card: BoardCard): { tone: Tone; label: string } {
  const s = card.status.toLowerCase();
  if (card.column === 'done') {
    if (s.includes('fail') || s.includes('abort') || s.includes('interrupt') || s.includes('block')) return { tone: 'danger', label: card.status };
    if (s.includes('cancel')) return { tone: 'neutral', label: 'Cancelled' };
    return { tone: 'success', label: 'Done' };
  }
  if (card.column === 'needs_you') {
    return {
      tone: 'warning',
      label: card.status === 'awaiting_approval'
        ? 'Approval'
        : card.status === 'awaiting_continue'
          ? 'Continue'
          : card.status,
    };
  }
  if (card.column === 'running') return { tone: 'live', label: s === 'cancelling' ? 'Cancelling' : 'Working' };
  return { tone: 'neutral', label: 'Queued' };
}
