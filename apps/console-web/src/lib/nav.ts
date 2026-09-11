import {
  Home, MessageCircle, Inbox, Zap, Plug, Brain, Video, LayoutDashboard,
  BarChart3, Wrench, Stethoscope, Gauge, Sliders, Sparkles,
  Settings, HelpCircle, Users, FlaskConical, Goal, Activity, GitBranch,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react';
import { primaryHomeNavigation, type HomePreferences } from './home-prefs';

export interface NavDest {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Plain-language one-liner shown as a tooltip / subtitle. */
  hint: string;
}

/**
 * The destinations a user can shape into their sidebar (pin / show / fold
 * into More — see HomePreferences.nav). Every path here is a real route, so
 * deep links from older builds keep working even where a label changed:
 * /inbox is now "Needs you", /tasks is "Running", /workspaces is "Projects".
 */
export const PRIMARY_NAV: NavDest[] = [
  { path: '/home', label: 'Home', icon: Home, hint: "What needs you, what's running, what got done" },
  { path: '/chat', label: 'Chat', icon: MessageCircle, hint: 'Talk to Clementine' },
  { path: '/inbox', label: 'Needs you', icon: Inbox, hint: 'Approvals, questions & anything waiting on you' },
  { path: '/tasks', label: 'Running', icon: Activity, hint: 'Everything Clementine is working on right now' },
  { path: '/workspaces', label: 'Spaces', icon: LayoutDashboard, hint: 'Live spaces Clementine built for you' },
  { path: '/automate', label: 'Automate', icon: Zap, hint: 'Workflows & skills' },
  { path: '/connect', label: 'Connect', icon: Plug, hint: 'Apps, tools, CLIs & your phone' },
  { path: '/memory', label: 'Memory', icon: Brain, hint: 'What Clementine knows about you' },
  { path: '/meetings', label: 'Meetings', icon: Video, hint: 'Recorded meetings & summaries' },
  { path: '/goals', label: 'Goals', icon: Goal, hint: 'Long-running outcomes and self-drive' },
  { path: '/agents', label: 'Agents', icon: Users, hint: 'Your specialized team & how they talk' },
];

/**
 * Power tools. No longer a sidebar group: reachable from Settings (the
 * Developer link, shown when developer mode is on) and the command palette.
 */
export const ADVANCED_NAV: NavDest[] = [
  { path: '/advanced/usage', label: 'Usage', icon: BarChart3, hint: 'Token spend & activity' },
  { path: '/advanced/tools', label: 'Tools', icon: Wrench, hint: 'Registered tool catalog' },
  { path: '/advanced/diagnostics', label: 'Diagnostics', icon: Stethoscope, hint: 'Health, logs & storage' },
  { path: '/advanced/observability', label: 'Observability', icon: Activity, hint: 'Live operational telemetry feed' },
  { path: '/advanced/traces', label: 'Trace Lab', icon: GitBranch, hint: 'Harness run timeline & replay preview' },
  { path: '/advanced/budgets', label: 'Run limits', icon: Gauge, hint: 'How far a run goes — steps, time & caps' },
  { path: '/advanced/autonomy', label: 'Autonomy', icon: Sliders, hint: 'When Clementine acts on its own' },
  { path: '/advanced/evolution', label: 'Evolution', icon: Sparkles, hint: 'Nightly self-research reports' },
];

/** Exists ONLY when developer mode is on (Settings → Developer mode). */
export const DEVELOPER_NAV: NavDest = {
  path: '/advanced/developer', label: 'Developer', icon: FlaskConical, hint: 'Feature flags & kill-switches',
};

/** Pinned at the bottom of the sidebar. */
export const FOOTER_NAV: NavDest[] = [
  { path: '/settings', label: 'Settings', icon: Settings, hint: 'Appearance, profile & account' },
  { path: '/help', label: 'Help', icon: HelpCircle, hint: 'Guides, shortcuts & version' },
];

/** Reachable from Home, not a sidebar pin. Command palette and titles still resolve. */
export const MADE_NAV: NavDest = {
  path: '/made', label: 'Made', icon: FolderOpen, hint: 'Finished work — drafts, files, sheets',
};

/** Every destination the command palette can jump to and titles resolve from. */
export const ALL_NAV: NavDest[] = [...PRIMARY_NAV, MADE_NAV, ...ADVANCED_NAV, ...FOOTER_NAV];

export interface SidebarNav {
  /** Always visible, in the user's order, above the fold. */
  pinned: NavDest[];
  /** Visible below the pinned group. */
  shown: NavDest[];
  /** Folded into the "More" disclosure. */
  more: NavDest[];
  /** Settings & Help, at the bottom. */
  footer: NavDest[];
}

/**
 * Turn the user's nav preferences into the three sidebar groups.
 *
 * - Paths resolve against PRIMARY_NAV; with developer mode on, a power tool
 *   the user explicitly named (ADVANCED_NAV / DEVELOPER_NAV) resolves too.
 * - Unknown paths (a newer build, a typo, a tool that is not a sidebar
 *   destination) are ignored; a path named twice keeps its first mention.
 * - Every primary destination the preferences never mention lands in More,
 *   so nothing the app knows about becomes unreachable.
 */
export function resolveSidebarNav(
  prefs: HomePreferences,
  opts: { developerMode: boolean },
): SidebarNav {
  const known = new Map<string, NavDest>();
  for (const d of PRIMARY_NAV) known.set(d.path, d);
  if (opts.developerMode) {
    for (const d of ADVANCED_NAV) known.set(d.path, d);
    known.set(DEVELOPER_NAV.path, DEVELOPER_NAV);
  }

  const placed = new Set<string>();
  const resolve = (paths: readonly string[] | undefined): NavDest[] => {
    const out: NavDest[] = [];
    for (const path of paths ?? []) {
      const dest = known.get(path);
      if (!dest || placed.has(path)) continue;
      placed.add(path);
      out.push(dest);
    }
    return out;
  };

  const primary = primaryHomeNavigation(prefs.nav);
  const pinned = resolve(primary.pinned);
  const shown = resolve(primary.shown);
  const more = resolve(primary.more);
  for (const d of PRIMARY_NAV) {
    if (!placed.has(d.path)) {
      placed.add(d.path);
      more.push(d);
    }
  }

  return { pinned, shown, more, footer: FOOTER_NAV };
}
