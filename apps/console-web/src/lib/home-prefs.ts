/**
 * Home preferences — the ONE per-user record that shapes the main window on
 * every first-party surface (desktop console + phone). Persisted server-side
 * (`GET/PATCH /api/console/settings/home`, `/m/api/settings/home`) so a choice
 * made on the desktop applies on the phone and survives relaunch.
 *
 * Pane / nav ids are stable strings; the renderer maps them to components.
 * Unknown ids (from a newer build) are preserved on write and ignored on read.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from './api';

export type HomeLanding = 'home' | 'last_conversation' | 'current_project';

export type HomePaneId =
  | 'quick_actions'
  | 'needs_you'
  | 'running'
  | 'while_away'
  | 'projects'
  | 'workstate';

export interface QuickAction {
  id: string;
  kind: 'prompt' | 'workflow';
  label: string;
  /** Prompt text, or the workflow name for kind='workflow'. */
  value: string;
}

export interface HomePreferences {
  landing: HomeLanding;
  panes: {
    /** Render order. Ids absent here render after, in default order. */
    order: HomePaneId[];
    hidden: HomePaneId[];
  };
  nav: {
    /** Always visible, in this order, above the fold. */
    pinned: string[];
    /** Visible below the pinned group. */
    shown: string[];
    /** Folded into "More". Anything else known to the app also lands in More. */
    more: string[];
  };
  quickActions: QuickAction[];
  /** Phone: the destinations offered by the title switcher, in order. */
  phoneSwitcher: string[];
}

export const DEFAULT_HOME_PANE_ORDER: HomePaneId[] = [
  'quick_actions',
  'needs_you',
  'running',
  'while_away',
  'projects',
];

export const DEFAULT_HOME_PREFERENCES: HomePreferences = {
  landing: 'home',
  panes: { order: DEFAULT_HOME_PANE_ORDER, hidden: ['workstate'] },
  nav: {
    pinned: ['/home', '/inbox', '/tasks', '/workspaces'],
    shown: ['/automate', '/connect'],
    more: ['/chat', '/memory', '/meetings', '/goals', '/agents'],
  },
  quickActions: [],
  phoneSwitcher: ['home', 'inbox', 'chats', 'spaces', 'more'],
};

export const HOME_PREFS_KEY = ['settings', 'home'] as const;

/**
 * Always yields a usable record: the placeholder while loading, the defaults
 * if the daemon predates the route (404) or is unreachable, the saved record
 * otherwise. Callers never branch on undefined.
 */
export function useHomePreferences() {
  const query = useQuery({
    queryKey: HOME_PREFS_KEY,
    queryFn: () => apiGet<{ home: HomePreferences }>('/api/console/settings/home').then((r) => r.home),
    staleTime: 30_000,
    retry: 1,
    placeholderData: DEFAULT_HOME_PREFERENCES,
  });
  return { ...query, data: query.data ?? DEFAULT_HOME_PREFERENCES } as typeof query & { data: HomePreferences };
}

export function useSaveHomePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<HomePreferences>) =>
      apiPatch<{ home: HomePreferences }>('/api/console/settings/home', patch).then((r) => r.home),
    onSuccess: (home) => qc.setQueryData(HOME_PREFS_KEY, home),
  });
}

/** Pane ids in render order, honoring the user's order and hidden set. */
export function visiblePanes(prefs: HomePreferences): HomePaneId[] {
  const hidden = new Set(prefs.panes.hidden);
  const ordered = prefs.panes.order.filter((id) => !hidden.has(id));
  const rest = DEFAULT_HOME_PANE_ORDER.filter((id) => !hidden.has(id) && !ordered.includes(id));
  return [...ordered, ...rest];
}
