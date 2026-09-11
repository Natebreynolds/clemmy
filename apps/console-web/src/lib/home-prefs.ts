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
  | 'made'
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
  /** The server's epoch marks untouched defaults; saved choices have a real timestamp. */
  updatedAt?: string;
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
 * NOTE for whoever owns src/runtime/home-preferences.ts:51 — the daemon ships
 * its own copy of this array, and it is the one a fresh install actually
 * receives. The two should match.
 */
export const DEFAULT_HOME_PANE_ORDER: HomePaneId[] = [
  'needs_you',
  'running',
  'while_away',
  'made',
  'projects',
  'quick_actions',
];

export const DEFAULT_HOME_PREFERENCES: HomePreferences = {
  landing: 'home',
  panes: { order: DEFAULT_HOME_PANE_ORDER, hidden: ['workstate'] },
  nav: {
    pinned: ['/home', '/chat', '/inbox', '/tasks', '/workspaces'],
    shown: ['/automate', '/connect'],
    more: ['/memory', '/meetings', '/goals', '/agents'],
  },
  quickActions: [],
  phoneSwitcher: ['home', 'inbox', 'chats', 'spaces', 'more'],
};

/** Home is the command center; all other nav choices retain their relative
 *  order and grouping. This does not write the shared record. */
export function primaryHomeNavigation(nav: HomePreferences['nav']): HomePreferences['nav'] {
  return {
    pinned: ['/home', ...nav.pinned.filter(path => path !== '/home')],
    shown: nav.shown.filter(path => path !== '/home'),
    more: nav.more.filter(path => path !== '/home'),
  };
}

/** Only the server's explicit untouched-default marker changes the landing.
 * A saved last-conversation or current-project choice remains exactly that. */
export function desktopHomePreferences(prefs: HomePreferences): HomePreferences {
  const migrated = migrateHomePreferences(prefs);
  return {
    ...migrated,
    landing: migrated.updatedAt === '1970-01-01T00:00:00.000Z' ? 'home' : migrated.landing,
    nav: primaryHomeNavigation(migrated.nav),
  };
}

export const HOME_PREFS_KEY = ['settings', 'home'] as const;

/** Untouched daemon defaults that still put chips first. A Customize save
 *  always writes every known pane id (including `workstate`), so these arrays
 *  can never be a user's choice. */
const SHIPPED_CHIPS_FIRST_ORDERS: readonly HomePaneId[][] = [
  ['quick_actions', 'needs_you', 'running', 'while_away', 'projects'],
  ['quick_actions', 'needs_you', 'running', 'while_away', 'made', 'projects'],
];

/**
 * Re-express a shipped chips-first default as chips-last, ONCE, at the
 * boundary — so the Customize sheet and the home read the same record.
 *
 * Fires only when the order is byte-for-byte a shipped default. For any
 * record where it does fire, the previous build already drew the chips last
 * (homeBlocks sank them), so nothing the user sees moves — what changes is
 * that the sheet now agrees with the screen, and a user who drags "Quick
 * actions" back to slot 1 keeps it there. `made` rest-appends on existing
 * saved orders that never named it.
 */
export function migrateHomePreferences(prefs: HomePreferences): HomePreferences {
  const order = prefs.panes.order;
  const isShippedDefault = SHIPPED_CHIPS_FIRST_ORDERS.some(
    (shipped) => order.length === shipped.length && order.every((id, i) => id === shipped[i]),
  );
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
    queryFn: () => apiGet<{ home: HomePreferences }>('/api/console/settings/home').then((r) => desktopHomePreferences(r.home)),
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
    onSuccess: (home) => qc.setQueryData(HOME_PREFS_KEY, desktopHomePreferences(home)),
  });
}

/** Pane ids in render order, honoring the user's order and hidden set. */
export function visiblePanes(prefs: HomePreferences): HomePaneId[] {
  const hidden = new Set(prefs.panes.hidden);
  const ordered = prefs.panes.order.filter((id) => !hidden.has(id));
  const rest = DEFAULT_HOME_PANE_ORDER.filter((id) => !hidden.has(id) && !ordered.includes(id));
  return [...ordered, ...rest];
}
