export interface HomeStatusFacts {
  decisionCount: number;
  decisionCountKnown: boolean;
  currentTaskCountKnown: boolean;
  running: number;
  currentNeedsAttention: number;
  loading: boolean;
}

/**
 * Home may use the Inbox badge as its primary decision count, but the
 * Working-Now projection can contain blocked/stale work that has not produced
 * an Inbox card. Those rows are still user-visible truth and must prevent a
 * quiet/all-clear claim.
 */
export function homeStatusLine({
  decisionCount,
  decisionCountKnown,
  currentTaskCountKnown,
  running,
  currentNeedsAttention,
  loading,
}: HomeStatusFacts): string {
  if (loading) return 'Catching up…';
  if (decisionCount > 0) {
    return running > 0
      ? `${decisionCount} waiting on you · ${running} running`
      : `${decisionCount} waiting on you`;
  }
  if (currentNeedsAttention > 0) {
    const attention = currentNeedsAttention === 1
      ? '1 current task needs attention'
      : `${currentNeedsAttention} current tasks need attention`;
    return running > 0 ? `${attention} · ${running} running` : attention;
  }
  if (running > 0) {
    return running === 1 ? 'Clem is working on something' : `Clem is running ${running} things`;
  }
  if (!decisionCountKnown) return 'Checking what needs you…';
  if (!currentTaskCountKnown) return 'Checking current work…';
  return 'Everything is quiet';
}

export function homeCanSayAllClear(input: {
  loading: boolean;
  needsYouCount: number;
  needsYouCountKnown: boolean;
  currentTaskCount: number;
  currentTaskCountKnown: boolean;
  reminderCount: number;
  recentChatCount: number;
}): boolean {
  return !input.loading
    && input.needsYouCountKnown
    && input.needsYouCount === 0
    && input.currentTaskCountKnown
    && input.currentTaskCount === 0
    && input.reminderCount === 0
    && input.recentChatCount === 0;
}
