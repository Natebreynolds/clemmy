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
