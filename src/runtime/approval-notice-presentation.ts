/**
 * How an approval notice reads once the approval has an outcome.
 *
 * The stored title is the moment the approval was raised ("Approval pending").
 * Past updates showed that word on every row long after the owner answered,
 * tagged only by whether a push reached a device or the row had been opened.
 * The registry writes the outcome onto the notice when the approval settles;
 * an older notice without it is read from the registry row itself.
 */
import type { NotificationRecord } from './notifications.js';
import * as approvalRegistry from './harness/approval-registry.js';

export type ApprovalNoticeOutcome = 'waiting' | 'approved' | 'declined' | 'expired' | 'withdrawn' | 'closed';

const RAISED_TITLE = 'Approval pending';

const OUTCOME_WORDS: Record<ApprovalNoticeOutcome, string> = {
  waiting: 'Waiting on your OK',
  approved: 'Approved',
  declined: 'Declined',
  expired: 'No answer in time',
  withdrawn: 'Withdrawn',
  closed: 'Closed',
};

function fromResolution(resolution: unknown): ApprovalNoticeOutcome | undefined {
  if (resolution === 'approved') return 'approved';
  if (resolution === 'rejected') return 'declined';
  if (resolution === 'expired') return 'expired';
  if (resolution === 'cancelled_by_user' || resolution === 'cancelled_by_system') return 'withdrawn';
  return undefined;
}

export function approvalNoticeOutcome(
  row: Pick<NotificationRecord, 'kind' | 'metadata'>,
): ApprovalNoticeOutcome | undefined {
  if (row.kind !== 'approval') return undefined;
  const recorded = fromResolution(row.metadata?.approvalResolution);
  if (recorded) return recorded;
  const approvalId = row.metadata?.approvalId;
  const live = typeof approvalId === 'string' && approvalId ? approvalRegistry.get(approvalId) : undefined;
  if (!live) return 'closed';
  if (live.status === 'pending') return 'waiting';
  return fromResolution(live.resolution) ?? (live.status === 'expired' ? 'expired' : 'closed');
}

export function approvalOutcomeLabel(outcome: ApprovalNoticeOutcome): string {
  return OUTCOME_WORDS[outcome];
}

/** The fields a notice list adds for an approval row; nothing for any other. */
export function approvalNoticeFields(
  row: Pick<NotificationRecord, 'kind' | 'title' | 'body' | 'metadata'>,
): { title?: string; approvalOutcome?: ApprovalNoticeOutcome; approvalOutcomeLabel?: string } {
  const outcome = approvalNoticeOutcome(row);
  if (!outcome) return {};
  return {
    title: presentedNotificationTitle(row, outcome),
    approvalOutcome: outcome,
    approvalOutcomeLabel: OUTCOME_WORDS[outcome],
  };
}

/** The title a list shows: the approval's subject, led by what became of it. */
export function presentedNotificationTitle(
  row: Pick<NotificationRecord, 'kind' | 'title' | 'body' | 'metadata'>,
  outcome: ApprovalNoticeOutcome | undefined = approvalNoticeOutcome(row),
): string {
  if (!outcome || row.title.trim() !== RAISED_TITLE) return row.title;
  const subject = row.body.trim().split('\n')[0]?.trim() ?? '';
  return subject ? `${OUTCOME_WORDS[outcome]}: ${subject}` : OUTCOME_WORDS[outcome];
}
