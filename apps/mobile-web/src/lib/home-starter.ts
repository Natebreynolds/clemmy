/** A useful invitation is safe only after every visible source has answered. */
export interface HomeStarterRead {
  data: unknown | null;
  loading: boolean;
  stale: boolean;
  error: unknown;
  offline: boolean;
}

export function homeReadConfirmed(read: HomeStarterRead): boolean {
  return read.data != null && !read.loading && !read.stale && !read.error && !read.offline;
}

export function showHomeBusinessStarter(state: {
  preferencesReady: boolean;
  countKnown: boolean;
  countLive: boolean;
  needsYou: number;
  workKnown: boolean;
  workError: unknown;
  workOffline: boolean;
  workCount: number;
  homeComplete: boolean;
  homeRead: HomeStarterRead;
  homeRows: number;
  fromClemRead: HomeStarterRead;
  fromClemRows: number;
  recentRead: HomeStarterRead;
  recentRows: number;
  quickActions: number;
  pinsConfirmedEmpty: boolean;
  missedRunsConfirmedEmpty: boolean;
}): boolean {
  return state.preferencesReady && state.countKnown && state.countLive && state.needsYou === 0
    && state.workKnown && !state.workError && !state.workOffline && state.workCount === 0
    && state.homeComplete && homeReadConfirmed(state.homeRead) && state.homeRows === 0
    && homeReadConfirmed(state.fromClemRead) && state.fromClemRows === 0
    && homeReadConfirmed(state.recentRead) && state.recentRows === 0
    && state.quickActions === 0 && state.pinsConfirmedEmpty && state.missedRunsConfirmedEmpty;
}

/** This opens a draft. It does not assume a provider, account, or permission. */
export const WEEKLY_BRIEF_REQUEST = 'Help me prepare a weekly brief for my business. Ask what the brief should cover, who it is for, and which information I want to use. Suggest a simple first version, then help me decide whether to make it a recurring automation. Ask before connecting accounts, scheduling work, or sending anything.';
