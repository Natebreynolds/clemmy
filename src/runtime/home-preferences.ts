import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

/**
 * Home preferences — the ONE per-user record that shapes the main window on
 * every first-party surface (desktop console + phone): which panes show and in
 * what order, which navigation destinations are pinned / shown / folded into
 * "More", what opens on launch, and the user's own quick actions.
 *
 * Distinct from UserProfile (how the user wants to be addressed) and from the
 * proactivity policy (what Clem may do unprompted). This record carries NO
 * execution authority — a quick action is a prompt or a workflow name the user
 * still has to tap.
 *
 * Storage: single JSON file at ~/.clementine-next/state/home-preferences.json,
 * atomic writes via tmp+rename (same pattern as user-profile).
 */

export type HomeLanding = 'home' | 'last_conversation' | 'current_project';

export const HOME_PANE_IDS = [
  'quick_actions',
  'needs_you',
  'running',
  'while_away',
  'made',
  'projects',
  'workstate',
] as const;
export type HomePaneId = (typeof HOME_PANE_IDS)[number];

export interface QuickAction {
  id: string;
  kind: 'prompt' | 'workflow';
  label: string;
  value: string;
}

export interface HomePreferences {
  landing: HomeLanding;
  panes: { order: HomePaneId[]; hidden: HomePaneId[] };
  nav: { pinned: string[]; shown: string[]; more: string[] };
  quickActions: QuickAction[];
  phoneSwitcher: string[];
  updatedAt: string;
}

const PREFS_FILE = path.join(BASE_DIR, 'state', 'home-preferences.json');

export const DEFAULT_HOME_PREFERENCES: HomePreferences = {
  landing: 'home',
  panes: { order: ['needs_you', 'running', 'while_away', 'made', 'projects', 'quick_actions'], hidden: ['workstate'] },
  nav: {
    // Chat is the main feature; it is pinned, not folded. Spaces (/workspaces)
    // keep the product name the phone already uses.
    pinned: ['/home', '/chat', '/inbox', '/tasks', '/workspaces'],
    shown: ['/automate', '/connect'],
    more: ['/memory', '/meetings', '/goals', '/agents'],
  },
  quickActions: [],
  phoneSwitcher: ['home', 'inbox', 'chats', 'spaces', 'more'],
  updatedAt: new Date(0).toISOString(),
};

const LANDINGS = new Set<HomeLanding>(['home', 'last_conversation', 'current_project']);
const PANE_SET = new Set<string>(HOME_PANE_IDS);
const MAX_LIST = 64;
const MAX_QUICK_ACTIONS = 24;

function stringList(input: unknown, max = MAX_LIST): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().slice(0, 120);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function paneList(input: unknown): HomePaneId[] {
  return stringList(input).filter((id): id is HomePaneId => PANE_SET.has(id));
}

function quickActionList(input: unknown): QuickAction[] {
  if (!Array.isArray(input)) return [];
  const out: QuickAction[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const kind = r.kind === 'workflow' ? 'workflow' : r.kind === 'prompt' ? 'prompt' : null;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 80) : '';
    const value = typeof r.value === 'string' ? r.value.trim().slice(0, 2000) : '';
    if (!kind || !label || !value) continue;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 64) : `qa-${out.length + 1}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`;
    if (out.some((q) => q.id === id)) continue;
    out.push({ id, kind, label, value });
    if (out.length >= MAX_QUICK_ACTIONS) break;
  }
  return out;
}

type RawPrefs = Partial<Record<keyof HomePreferences, unknown>>;


/**
 * The sidebar shape shipped before Chat was pinned. A stored nav that still
 * equals it byte-for-byte was never shaped by the user — every save writes the
 * full record, so an untouched file is a copy of whatever default was current.
 * Such a file follows the NEW default; any customized sidebar is left alone.
 */
const LEGACY_DEFAULT_NAV = {
  pinned: ['/home', '/inbox', '/tasks', '/workspaces'],
  shown: ['/automate', '/connect'],
  more: ['/chat', '/memory', '/meetings', '/goals', '/agents'],
};
function navUnchangedFromLegacyDefault(nav: Record<string, unknown>): boolean {
  const same = (key: keyof typeof LEGACY_DEFAULT_NAV): boolean =>
    JSON.stringify(stringList(nav[key])) === JSON.stringify(LEGACY_DEFAULT_NAV[key]);
  return 'pinned' in nav && 'shown' in nav && 'more' in nav && same('pinned') && same('shown') && same('more');
}

export function normalizeHomePreferences(input: RawPrefs = {}): HomePreferences {
  const d = DEFAULT_HOME_PREFERENCES;
  const panes = (input.panes && typeof input.panes === 'object' ? input.panes : {}) as Record<string, unknown>;
  const nav = (input.nav && typeof input.nav === 'object' ? input.nav : {}) as Record<string, unknown>;
  const landing = typeof input.landing === 'string' && LANDINGS.has(input.landing as HomeLanding)
    ? (input.landing as HomeLanding)
    : d.landing;
  const order = 'order' in panes ? paneList(panes.order) : d.panes.order;
  const hidden = 'hidden' in panes ? paneList(panes.hidden) : d.panes.hidden;
  return {
    landing,
    panes: { order, hidden },
    nav: {
      pinned: navUnchangedFromLegacyDefault(nav) ? d.nav.pinned : 'pinned' in nav ? stringList(nav.pinned) : d.nav.pinned,
      shown: navUnchangedFromLegacyDefault(nav) ? d.nav.shown : 'shown' in nav ? stringList(nav.shown) : d.nav.shown,
      more: navUnchangedFromLegacyDefault(nav) ? d.nav.more : 'more' in nav ? stringList(nav.more) : d.nav.more,
    },
    quickActions: 'quickActions' in input ? quickActionList(input.quickActions) : d.quickActions,
    phoneSwitcher: 'phoneSwitcher' in input ? stringList(input.phoneSwitcher, 12) : d.phoneSwitcher,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
  };
}

export function loadHomePreferences(): HomePreferences {
  if (!existsSync(PREFS_FILE)) return normalizeHomePreferences(DEFAULT_HOME_PREFERENCES);
  try {
    return normalizeHomePreferences(JSON.parse(readFileSync(PREFS_FILE, 'utf-8')) as RawPrefs);
  } catch {
    return normalizeHomePreferences(DEFAULT_HOME_PREFERENCES);
  }
}

/** Shallow patch: a provided top-level key replaces that key wholesale. */
export function saveHomePreferences(patch: RawPrefs): HomePreferences {
  const current = loadHomePreferences();
  const next = normalizeHomePreferences({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmp, PREFS_FILE);
  return next;
}
