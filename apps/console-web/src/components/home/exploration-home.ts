import { readOnboardingEntry } from '../../lib/onboarding-entry';

export interface ExplorationSnapshot {
  state: 'loaded' | 'loading' | 'error' | 'unconfirmed';
  count: number | undefined;
  updatedAt: number;
}

/** This entry is an explicit setup choice, never an inferred account state.
 * The server's epoch denotes untouched preferences; saved arrangements stay. */
export function isDefaultExploration(pathname: string, state: unknown, preferences: { updatedAt?: string } | undefined, preferencesConfirmed: boolean): boolean {
  return pathname === '/chat' && readOnboardingEntry(state)?.intent === 'explore'
    && preferencesConfirmed && preferences?.updatedAt === '1970-01-01T00:00:00.000Z';
}

/** Empty introductions can yield to the first conversation. A failed, old,
 * loading or nonempty source always retains its pane and its recovery. */
export function quietExplorationIntroductions(input: {
  eligible: boolean;
  nowMs: number;
  made: ExplorationSnapshot;
  projects: ExplorationSnapshot;
  spaces: ExplorationSnapshot;
  watching: ExplorationSnapshot;
}): Record<'made' | 'projects' | 'spaces' | 'watching', boolean> {
  const empty = (source: ExplorationSnapshot) => input.eligible && source.state === 'loaded'
    && source.count === 0 && Number.isFinite(source.updatedAt) && source.updatedAt > 0
    && source.updatedAt <= input.nowMs && input.nowMs - source.updatedAt <= 90_000;
  return { made: empty(input.made), projects: empty(input.projects), spaces: empty(input.spaces), watching: empty(input.watching) };
}
