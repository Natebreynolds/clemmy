import type { ActivityEntry, RunSummary } from './api';

export interface ActivitySources {
  runs: RunSummary[] | null;
  working: { entries: ActivityEntry[]; observedAt: string } | null;
  historyUnavailable: boolean;
  workingUnavailable: boolean;
}

/** A failed source is unknown. Keep its last real snapshot and its real clock. */
export async function loadActivitySources(reads: {
  history: () => Promise<{ runs: RunSummary[] }>;
  working: () => Promise<{ entries: ActivityEntry[]; observedAt: string }>;
}, previous: ActivitySources | null): Promise<ActivitySources> {
  const [history, working] = await Promise.allSettled([reads.history(), reads.working()]);
  return {
    runs: history.status === 'fulfilled' ? history.value.runs : previous?.runs ?? null,
    working: working.status === 'fulfilled' ? working.value : previous?.working ?? null,
    historyUnavailable: history.status === 'rejected',
    workingUnavailable: working.status === 'rejected',
  };
}
