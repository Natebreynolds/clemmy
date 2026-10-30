/**
 * The fields a notice list adds to a stored notice so it reads the way the
 * owner talks: an approval by what became of it, a workflow by its name
 * rather than its slug. The stored notice is unchanged.
 */
import type { NotificationRecord } from './notifications.js';
import { approvalNoticeFields, type ApprovalNoticeOutcome } from './approval-notice-presentation.js';
import { withWorkflowName } from '../shared/workflow-display-name.js';

export function noticeListFields(
  row: Pick<NotificationRecord, 'kind' | 'title' | 'body' | 'metadata'>,
): { title?: string; approvalOutcome?: ApprovalNoticeOutcome; approvalOutcomeLabel?: string } {
  const approval = approvalNoticeFields(row);
  const base = approval.title ?? row.title;
  const named = withWorkflowName(withWorkflowName(base, row.metadata?.workflowSlug), row.metadata?.workflow);
  return named === row.title ? approval : { ...approval, title: named };
}

/** A notice that reports that nothing happened: Clementine was closed for a
 *  while and nothing was due. Lists and counts leave it out; the boot no
 *  longer writes one (live 2026-10-30: 35 of them filled Updates). */
export function isEmptyHistoryNotice(row: Pick<NotificationRecord, 'kind' | 'metadata'>): boolean {
  return row.kind === 'system' && row.metadata?.errorCategory === 'daemon_offline' && row.metadata?.missedCount === 0;
}
