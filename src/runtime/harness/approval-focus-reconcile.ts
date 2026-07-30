import {
  get,
  onApprovalResolved,
  type PendingApprovalRow,
} from './approval-registry.js';
import {
  clearFocus,
  getActiveFocus,
} from '../../memory/focus.js';
import type { FocusRow } from '../../memory/db.js';

const APPROVAL_ID_RE = /\bapr-[a-z0-9]+\b/gi;
const APPROVAL_ASK_RE = /^\s*ASK:\s*(?:approve|reject|decide|review)\b/i;

function metadataSource(row: FocusRow): string {
  try {
    const parsed = JSON.parse(row.metadata_json ?? '{}') as { source?: unknown };
    return typeof parsed.source === 'string' ? parsed.source : '';
  } catch {
    return '';
  }
}

function approvalIdsForSyntheticAsk(row: FocusRow): string[] {
  if (metadataSource(row) !== 'harness_auto_focus') return [];
  const text = `${row.title}\n${row.summary}`;
  if (!APPROVAL_ASK_RE.test(text)) return [];
  return [...new Set(text.match(APPROVAL_ID_RE)?.map((id) => id.toLowerCase()) ?? [])];
}

function resolutionForRows(rows: PendingApprovalRow[]): 'completed' | 'abandoned' {
  return rows.some((row) => row.resolution === 'approved')
    ? 'completed'
    : 'abandoned';
}

/** Close only synthetic, approval-only focus rows. User-authored focus and
 * broader project focus remain untouched. */
export function reconcileResolvedApprovalFocus(
  resolvedRow?: PendingApprovalRow,
): FocusRow | null {
  const active = getActiveFocus();
  if (!active) return null;
  const approvalIds = approvalIdsForSyntheticAsk(active);
  if (approvalIds.length === 0) return null;
  if (resolvedRow && (
    active.related_session_id !== resolvedRow.sessionId
    || !approvalIds.includes(resolvedRow.approvalId.toLowerCase())
  )) return null;

  const rows = approvalIds
    .map((approvalId) => get(approvalId))
    .filter((row): row is PendingApprovalRow => Boolean(row));
  if (rows.length !== approvalIds.length) return null;
  if (rows.some((row) => row.status === 'pending')) return null;
  return clearFocus(active.id, resolutionForRows(rows));
}

let initialized = false;

export function initApprovalFocusReconciliation(): void {
  if (initialized) return;
  initialized = true;
  onApprovalResolved((row) => {
    reconcileResolvedApprovalFocus(row);
  });
  setImmediate(() => {
    reconcileResolvedApprovalFocus();
  });
}
