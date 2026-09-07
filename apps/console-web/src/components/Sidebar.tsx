import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronRight, Ellipsis } from 'lucide-react';
import { resolveSidebarNav, type NavDest } from '@/lib/nav';
import { DEFAULT_HOME_PREFERENCES, useHomePreferences } from '@/lib/home-prefs';
import { usePoll } from '@/lib/poll';
import { getSettings } from '@/lib/settings';
import { DogMark } from './DogMark';
import { cn } from '@/lib/cn';

/**
 * The sidebar the user shapes: pinned, then shown, then a "More" fold —
 * all from HomePreferences.nav (persisted server-side, so the phone agrees).
 * Two per-window conveniences live in localStorage: whether the rail is
 * collapsed and whether More is open. Both are best-effort (private window,
 * cleared site data) and the sidebar renders correctly without them.
 */
const COLLAPSED_PREF_KEY = 'clem.sidebar.collapsed';
const MORE_PREF_KEY = 'clem.sidebar.more';

export function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_PREF_KEY) === 'collapsed'; } catch { return false; }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(COLLAPSED_PREF_KEY, collapsed ? 'collapsed' : 'open'); } catch { /* preference only */ }
}

function readMoreOpen(): boolean {
  try { return localStorage.getItem(MORE_PREF_KEY) === 'open'; } catch { return false; }
}

function writeMoreOpen(open: boolean): void {
  try { localStorage.setItem(MORE_PREF_KEY, open ? 'open' : 'closed'); } catch { /* preference only */ }
}

function formatBadge(n: number): string {
  return n > 99 ? '99+' : String(n);
}

function NavRow({
  dest,
  collapsed,
  badge,
  badgeTone = 'primary',
  badgeLabel,
}: {
  dest: NavDest;
  collapsed: boolean;
  badge?: number;
  /** Primary = someone is waiting on you; muted = purely informational. */
  badgeTone?: 'primary' | 'muted';
  /** Screen-reader phrasing for the count, e.g. "2 waiting on you". */
  badgeLabel?: string;
}) {
  const Icon = dest.icon;
  const showBadge = typeof badge === 'number' && badge > 0;
  const badgeClass = badgeTone === 'primary' ? 'bg-primary text-primary-fg' : 'bg-subtle text-muted';
  return (
    <NavLink
      to={dest.path}
      title={collapsed ? `${dest.label} — ${dest.hint}` : dest.hint}
      aria-label={showBadge && badgeLabel ? `${dest.label}, ${badgeLabel}` : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex h-10 items-center gap-3 rounded-sm px-3 text-body font-medium transition-colors duration-fast cursor-pointer',
          collapsed && 'w-11 justify-center px-0',
          isActive
            ? 'bg-primary-tint text-primary'
            : 'text-muted hover:bg-hover hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && !collapsed && (
            <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" aria-hidden />
          )}
          <Icon className="h-5 w-5 shrink-0" aria-hidden />
          {!collapsed && <span className="truncate">{dest.label}</span>}
          {showBadge && !collapsed && (
            <span
              className={cn('ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-caption font-bold', badgeClass)}
              aria-hidden
            >
              {formatBadge(badge)}
            </span>
          )}
          {showBadge && collapsed && (
            <span
              className={cn(
                'absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-caption font-bold leading-none',
                badgeClass,
              )}
              aria-hidden
            >
              {formatBadge(badge)}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

export function Sidebar({
  collapsed,
  needsYouCount,
  runningCount = 0,
}: {
  collapsed: boolean;
  /** The ONE needs-you count, from AppShell's presentWorkingNow view. The
   *  sidebar renders it verbatim and never derives its own. */
  needsYouCount: number;
  /** Same source; shown muted on Running as a plain count, not a summons. */
  runningCount?: number;
}) {
  const [moreOpen, setMoreOpen] = useState<boolean>(readMoreOpen);
  const toggleMore = () => {
    setMoreOpen((v) => {
      writeMoreOpen(!v);
      return !v;
    });
  };

  const prefs = useHomePreferences();
  // Developer mode only widens what a preference path may resolve to; it
  // never adds a group of its own (power tools live behind Settings).
  const settings = usePoll(['settings'], getSettings, 0);
  const nav = resolveSidebarNav(prefs.data ?? DEFAULT_HOME_PREFERENCES, {
    developerMode: settings.data?.developerMode === true,
  });

  const badgeFor = (dest: NavDest) => {
    if (dest.path === '/inbox') {
      return { badge: needsYouCount, badgeTone: 'primary' as const, badgeLabel: `${needsYouCount} waiting on you` };
    }
    if (dest.path === '/tasks') {
      return { badge: runningCount, badgeTone: 'muted' as const, badgeLabel: `${runningCount} running` };
    }
    return {};
  };

  const renderRows = (dests: NavDest[]) => dests.map((d) => (
    <NavRow key={d.path} dest={d} collapsed={collapsed} {...badgeFor(d)} />
  ));

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'flex h-full flex-col border-r border-border bg-surface transition-[width] duration-base',
        collapsed ? 'w-[72px]' : 'w-[248px]',
      )}
    >
      <div className={cn('sidebar-brand app-drag flex items-center gap-2.5 px-4 py-4', collapsed && 'justify-center px-0')}>
        <DogMark size={collapsed ? 28 : 32} />
        {!collapsed && <span className="text-h3 font-bold text-fg">Clementine</span>}
      </div>

      <div className={cn('flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2', collapsed && 'items-center px-0')}>
        {renderRows(nav.pinned)}
        {renderRows(nav.shown)}

        {nav.more.length > 0 && (
          <div className={cn('flex flex-col gap-1 pt-2', collapsed && 'items-center')}>
            <button
              type="button"
              onClick={toggleMore}
              className={cn(
                'flex h-10 items-center gap-3 rounded-sm px-3 text-body font-medium text-faint transition-colors duration-fast hover:bg-hover hover:text-muted cursor-pointer',
                collapsed ? 'w-11 justify-center px-0' : 'w-full',
                moreOpen && 'text-muted',
              )}
              aria-expanded={moreOpen}
              aria-controls="sidebar-more"
              aria-label={collapsed ? (moreOpen ? 'Hide more destinations' : 'Show more destinations') : undefined}
              title={collapsed ? 'More' : undefined}
            >
              {collapsed ? (
                <Ellipsis className="h-5 w-5" aria-hidden />
              ) : (
                <>
                  <ChevronRight className={cn('h-5 w-5 transition-transform duration-fast', moreOpen && 'rotate-90')} aria-hidden />
                  <span>More</span>
                </>
              )}
            </button>
            <div
              id="sidebar-more"
              className={cn(moreOpen ? 'flex' : 'hidden', 'flex-col gap-1', collapsed && 'items-center')}
            >
              {renderRows(nav.more)}
            </div>
          </div>
        )}
      </div>

      <div className={cn('flex flex-col gap-1 border-t border-border px-3 py-3', collapsed && 'items-center px-0')}>
        {renderRows(nav.footer)}
      </div>
    </nav>
  );
}
