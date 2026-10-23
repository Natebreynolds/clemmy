/** Reply receipts describe a particular version of a proactive item. HTTP
 * success alone does not mean the item was answered. This is presentation,
 * never permission to dispatch or replay work. */
export interface ProactiveReplyReceipt {
  voiceDigest: string;
  settled: boolean;
  tone: 'success' | 'error' | 'info';
  text: string;
  sessionId?: string;
}
export function proactiveReplySettled(outcome: string): boolean {
  return ['gone', 'started', 'approved', 'declined', 'cleared', 'later', 'rule_added', 'answered'].includes(outcome);
}
export function currentProactiveReceipt<T extends { voiceDigest: string }>(receipt: T | undefined, voiceDigest: string): T | undefined {
  return receipt?.voiceDigest === voiceDigest ? receipt : undefined;
}


/** A check-in decision reports the saved disposition, not merely HTTP success
 * or the button pressed on a stale card. */
export function checkInProposalDecisionFeedback(
  decision: 'keep' | 'decline', status: string | undefined, title: string,
): { tone: 'success' | 'error'; text: string } {
  if (decision === 'keep' && status === 'approved') return { tone: 'success', text: `Kept — “${title}” is set up.` };
  if (decision === 'decline' && status === 'rejected') return { tone: 'success', text: `Turned down — Clem won't set up “${title}”.` };
  if (status === 'approved' || status === 'rejected') return { tone: 'error', text: `This suggestion was already ${status}, so nothing changed.` };
  return { tone: 'error', text: 'Couldn’t confirm that decision. Check the suggestion before trying again.' };
}
