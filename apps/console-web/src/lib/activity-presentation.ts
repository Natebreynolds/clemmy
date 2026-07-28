import type { ActivityItem, MessageStatus } from './useChat';

export type ActivityTerminalOutcome = 'completed' | 'failed' | 'interrupted';

/**
 * Close only activity rows whose terminal event never arrived. A successful
 * turn can safely settle them as done; failures and parked/stopped turns must
 * remain visibly non-successful.
 */
export function settleTerminalActivity(
  items: ActivityItem[],
  outcome?: ActivityTerminalOutcome,
): ActivityItem[] {
  if (!outcome) return items;
  const status: ActivityItem['status'] = outcome === 'completed'
    ? 'done'
    : outcome === 'failed'
      ? 'failed'
      : 'interrupted';
  return items.map((item) => (item.status === 'running' ? { ...item, status } : item));
}

export function activityTerminalOutcomeForMessageStatus(
  status: MessageStatus | undefined,
): ActivityTerminalOutcome | undefined {
  if (status === 'thinking') return undefined;
  if (status === 'complete') return 'completed';
  if (status === 'failed') return 'failed';
  return 'interrupted';
}

/**
 * The board can lag or project several terminal statuses into one column.
 * Prefer the durable harness terminal event; without one, fail closed as an
 * interruption instead of painting unmatched calls green.
 */
export function activityTerminalOutcomeFromHarnessEvents(
  events: ReadonlyArray<{ type: string }>,
  live: boolean,
): ActivityTerminalOutcome | undefined {
  if (live) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'run_failed') return 'failed';
    if (events[index]?.type === 'conversation_completed') return 'completed';
  }
  return 'interrupted';
}
