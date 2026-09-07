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

/**
 * The shipped order, and the ONLY place "work leads" is expressed.
 *
 * The renderer used to enforce it instead, by sinking `quick_actions` below
 * every pane at draw time — which meant the Customize sheet showed the chips
 * in position 1 while the home drew them last, and dragging them to the top
 * did nothing. The rule belongs here, in data the sheet displays and the user
 * can reorder, so that what the sheet says is what the home renders.
 *
 * NOTE for whoever owns src/runtime/home-preferences.ts:52 — the daemon ships
 * its own copy of this array, still chips-first, and it is the one a fresh
 * install actually receives. The two should match.
 */
export const DEFAULT_HOME_PANE_ORDER: HomePaneId[] = [
  'needs_you',
  'running',
  'while_away',
  'projects',
  'quick_actions',
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

/** The order the daemon still ships (src/runtime/home-preferences.ts:52), and
 *  the one a fresh install receives over the wire. */
const LEGACY_DEFAULT_HOME_PANE_ORDER: HomePaneId[] = [
  'quick_actions',
  'needs_you',
  'running',
  'while_away',
  'projects',
];

/**
 * Re-express the shipped chips-first default as chips-last, ONCE, at the
 * boundary — so the Customize sheet and the home read the same record.
 *
 * This fires only on a record whose order is byte-for-byte the legacy default,
 * and that shape cannot be a user's choice: every order the Customize sheet
 * writes has been through normalizePreferences(), which appends the full pane
 * id set, so a saved order always carries all six ids and never equals this
 * five-id array. And for any record where it DOES fire, the previous build
 * already drew the chips last (homeBlocks sank them), so nothing the user sees
 * moves — what changes is that the sheet now agrees with the screen, and a
 * user who drags "Quick actions" back to slot 1 keeps it there.
 */
export function migrateHomePreferences(prefs: HomePreferences): HomePreferences {
  const order = prefs.panes.order;
  const isShippedDefault =
    order.length === LEGACY_DEFAULT_HOME_PANE_ORDER.length
    && order.every((id, i) => id === LEGACY_DEFAULT_HOME_PANE_ORDER[i]);
  if (!isShippedDefault) return prefs;
  return { ...prefs, panes: { ...prefs.panes, order: [...DEFAULT_HOME_PANE_ORDER] } };
}

/**
 * Always yields a usable record: the placeholder while loading, the defaults
 * if the daemon predates the route (404) or is unreachable, the saved record
 * otherwise. Callers never branch on undefined.
 */
export function useHomePreferences() {
  const query = useQuery({
    queryKey: HOME_PREFS_KEY,
    queryFn: () =>
      apiGet<{ home: HomePreferences }>('/api/console/settings/home').then((r) => migrateHomePreferences(r.home)),
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
    // Same migration on the way back: a PATCH that touches only `landing`
    // returns a record whose order is still the legacy default, and putting
    // that into the cache raw would make the chips jump to the top the moment
    // the user saved an unrelated setting.
    onSuccess: (home) => qc.setQueryData(HOME_PREFS_KEY, migrateHomePreferences(home)),
  });
}

/** Pane ids in render order, honoring the user's order and hidden set. */
export function visiblePanes(prefs: HomePreferences): HomePaneId[] {
  const hidden = new Set(prefs.panes.hidden);
  const ordered = prefs.panes.order.filter((id) => !hidden.has(id));
  const rest = DEFAULT_HOME_PANE_ORDER.filter((id) => !hidden.has(id) && !ordered.includes(id));
  return [...ordered, ...rest];
}
