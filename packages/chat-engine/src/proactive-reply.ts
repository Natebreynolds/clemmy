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
