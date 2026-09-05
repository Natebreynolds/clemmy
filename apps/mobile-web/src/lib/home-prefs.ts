/**
 * Home preferences — the ONE per-user record that shapes the main window on
 * every first-party surface (desktop console + phone). Same shape as the
 * desktop lib (apps/console-web/src/lib/home-prefs.ts); persisted by the
 * daemon (`GET/PATCH /m/api/settings/home`) so a choice made on either
 * surface applies on the other and survives relaunch.
 *
 * Pane / nav ids are stable strings; the renderer maps them to components.
 * Unknown ids (from a newer build, or desktop-only panes) are preserved on
 * write and ignored on read.
 */
import { useEffect } from 'preact/hooks';
import { api } from './api';
import { createLiveStore, useLiveStore } from './live-store';

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

/** Pane ids in render order, honoring the user's order and hidden set. */
export function visiblePanes(prefs: HomePreferences): HomePaneId[] {
  const hidden = new Set(prefs.panes.hidden);
  const ordered = prefs.panes.order.filter((id) => !hidden.has(id));
  const rest = DEFAULT_HOME_PANE_ORDER.filter((id) => !hidden.has(id) && !ordered.includes(id));
  return [...ordered, ...rest];
}

/**
 * The panes the phone renders, with their labels. `workstate` is a desktop
 * pane (the shared collaborative notebook has no phone projection yet), so
 * it is neither listed nor toggled here — its stored setting passes through
 * every write untouched.
 */
export const PHONE_PANES: ReadonlyArray<{ id: HomePaneId; label: string }> = [
  { id: 'quick_actions', label: 'Quick actions' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'while_away', label: 'While you were away' },
  { id: 'projects', label: 'Coming up · Projects' },
];
const PHONE_PANE_IDS = new Set<HomePaneId>(PHONE_PANES.map((pane) => pane.id));

/** Phone panes in render order, visible ones only. */
export function phoneVisiblePanes(prefs: HomePreferences): HomePaneId[] {
  return visiblePanes(prefs).filter((id) => PHONE_PANE_IDS.has(id));
}

/** Every phone pane in the user's order — hidden ones too — for the customize sheet. */
export function phonePaneRows(prefs: HomePreferences): Array<{ id: HomePaneId; label: string; on: boolean }> {
  const hidden = new Set(prefs.panes.hidden);
  const ordered = prefs.panes.order.filter((id) => PHONE_PANE_IDS.has(id));
  const rest = PHONE_PANES.map((pane) => pane.id).filter((id) => !ordered.includes(id));
  return [...ordered, ...rest].map((id) => ({
    id,
    label: PHONE_PANES.find((pane) => pane.id === id)?.label ?? id,
    on: !hidden.has(id),
  }));
}

/** A new `panes` value from the phone's rows, keeping non-phone ids exactly as stored. */
export function panesFromPhoneRows(
  prefs: HomePreferences,
  rows: ReadonlyArray<{ id: HomePaneId; on: boolean }>,
): HomePreferences['panes'] {
  const phoneOrder = rows.map((row) => row.id);
  const phoneHidden = rows.filter((row) => !row.on).map((row) => row.id);
  return {
    order: [...phoneOrder, ...prefs.panes.order.filter((id) => !PHONE_PANE_IDS.has(id))],
    hidden: [...prefs.panes.hidden.filter((id) => !PHONE_PANE_IDS.has(id)), ...phoneHidden],
  };
}

export const SWITCHER_MORE = 'more';

/**
 * The title switcher's destinations: the stored order, restricted to ids this
 * build knows, with "More" always present at the end so every section stays
 * reachable no matter what the record says.
 */
export function phoneSwitcherIds(prefs: HomePreferences, known: ReadonlyArray<string>): string[] {
  const knownSet = new Set(known);
  const out: string[] = [];
  for (const id of prefs.phoneSwitcher) {
    if (id === SWITCHER_MORE || !knownSet.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return [...out, SWITCHER_MORE];
}

// ─── store ─────────────────────────────────────────────────────────────────

export interface HomePrefsState {
  prefs: HomePreferences;
  /** True once the daemon's record has been read at least once. */
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  /** Last load/save failure; cleared by the next success. */
  error: string | null;
}

const store = createLiveStore<HomePrefsState>({
  prefs: DEFAULT_HOME_PREFERENCES,
  loaded: false,
  loading: false,
  saving: false,
  error: null,
});

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Defend the renderer against a partial or older record: every field has a shape. */
function normalize(input: Partial<HomePreferences> | null | undefined): HomePreferences {
  const d = DEFAULT_HOME_PREFERENCES;
  const raw = (input ?? {}) as Record<string, unknown>;
  const panes = (raw.panes && typeof raw.panes === 'object' ? raw.panes : {}) as Record<string, unknown>;
  const nav = (raw.nav && typeof raw.nav === 'object' ? raw.nav : {}) as Record<string, unknown>;
  const landing = raw.landing === 'last_conversation' || raw.landing === 'current_project' ? raw.landing : 'home';
  const quickActions = Array.isArray(raw.quickActions)
    ? raw.quickActions.filter((item): item is QuickAction => Boolean(
      item && typeof item === 'object'
      && typeof (item as QuickAction).id === 'string'
      && ((item as QuickAction).kind === 'prompt' || (item as QuickAction).kind === 'workflow')
      && typeof (item as QuickAction).label === 'string'
      && typeof (item as QuickAction).value === 'string',
    ))
    : d.quickActions;
  return {
    landing,
    panes: {
      order: ('order' in panes ? list(panes.order) : d.panes.order) as HomePaneId[],
      hidden: ('hidden' in panes ? list(panes.hidden) : d.panes.hidden) as HomePaneId[],
    },
    nav: {
      pinned: 'pinned' in nav ? list(nav.pinned) : d.nav.pinned,
      shown: 'shown' in nav ? list(nav.shown) : d.nav.shown,
      more: 'more' in nav ? list(nav.more) : d.nav.more,
    },
    quickActions,
    phoneSwitcher: 'phoneSwitcher' in raw ? list(raw.phoneSwitcher) : d.phoneSwitcher,
  };
}

let loadInFlight: Promise<void> | null = null;

export function loadHomePreferences(): Promise<void> {
  if (loadInFlight) return loadInFlight;
  store.set((s) => ({ ...s, loading: true }));
  loadInFlight = api<{ home: HomePreferences }>('/m/api/settings/home')
    .then((body) => {
      store.set((s) => ({ ...s, prefs: normalize(body.home), loaded: true, loading: false, error: null }));
    }, (err: unknown) => {
      store.set((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : 'Could not load your home settings' }));
    })
    .finally(() => { loadInFlight = null; });
  return loadInFlight;
}

// Saves run in order. Two quick toggles must land as two ordered PATCHes,
// never as a race where the older write wins.
let saveChain: Promise<unknown> = Promise.resolve();

/**
 * Shallow top-level patch, applied optimistically and confirmed by the
 * daemon's response. A failed save reloads the daemon's truth rather than
 * guessing which local change to keep.
 */
export function saveHomePreferences(patch: Partial<HomePreferences>): Promise<HomePreferences> {
  store.set((s) => ({ ...s, prefs: { ...s.prefs, ...patch }, saving: true, error: null }));
  const attempt = saveChain.then(async () => {
    try {
      const body = await api<{ home: HomePreferences }>('/m/api/settings/home', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const prefs = normalize(body.home);
      store.set((s) => ({ ...s, prefs, loaded: true, saving: false, error: null }));
      return prefs;
    } catch (err) {
      store.set((s) => ({ ...s, saving: false, error: err instanceof Error ? err.message : 'Could not save your home settings' }));
      void loadHomePreferences();
      throw err;
    }
  });
  saveChain = attempt.catch(() => undefined);
  return attempt;
}

/**
 * Read the shared record; the first enabled reader triggers the load. Every
 * reader sees the same value, so Home, the title switcher, and the customize
 * sheet can never disagree.
 */
export function useHomePreferences(options?: { enabled?: boolean }): HomePrefsState & {
  save: typeof saveHomePreferences;
  reload: () => Promise<void>;
} {
  const state = useLiveStore(store);
  const enabled = options?.enabled !== false;
  useEffect(() => {
    if (!enabled) return;
    const current = store.get();
    if (!current.loaded && !current.loading) void loadHomePreferences();
  }, [enabled]);
  return { ...state, save: saveHomePreferences, reload: loadHomePreferences };
}

/** Test seam: reset the store without touching the daemon. */
export function _resetHomePreferencesForTest(): void {
  store.set({ prefs: DEFAULT_HOME_PREFERENCES, loaded: false, loading: false, saving: false, error: null });
}
