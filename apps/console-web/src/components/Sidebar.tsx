import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, Ellipsis, MessageSquare, Plus, Search } from 'lucide-react';
import { resolveSidebarNav, type NavDest } from '@/lib/nav';
import { DEFAULT_HOME_PREFERENCES, useHomePreferences } from '@/lib/home-prefs';
import { usePoll } from '@/lib/poll';
import { getSettings } from '@/lib/settings';
import { DogMark } from './DogMark';
import { cn } from '@/lib/cn';
import { workKindForPath } from '@/lib/work-navigation';
import { ConversationSidebar } from '@/features/conversations/list/ConversationSidebar';
import { RecentWork, WorkCollection } from './WorkNavigator';

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
      end={dest.path === '/chat'}
      title={collapsed ? `${dest.label} — ${dest.hint}` : dest.hint}
      aria-label={showBadge && badgeLabel ? `${dest.label}, ${badgeLabel}` : undefined}
      className={({ isActive }) =>
        cn(
          // Navigation recedes so the page leads: a quiet fill and full-strength
          // text mark where you are, inactive rows stay muted, icons are small.
          'group relative flex h-10 items-center gap-2.5 rounded-sm px-3 text-body font-medium transition-colors duration-fast cursor-pointer',
          collapsed && 'w-11 justify-center px-0',
          isActive
            ? 'bg-subtle text-fg'
            : 'text-muted hover:bg-hover hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-faint group-hover:text-muted')} strokeWidth={1.75} aria-hidden />
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
  onExpand,
}: {
  collapsed: boolean;
  /** The ONE needs-you count, from AppShell's presentWorkingNow view. The
   *  sidebar renders it verbatim and never derives its own. */
  needsYouCount: number;
  /** Same source; shown muted on Running as a plain count, not a summons. */
  runningCount?: number;
  onExpand?: () => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [view, setView] = useState<'work' | 'chats'>('work');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(
    ['/projects', '/workspaces', '/automate', '/agents'].filter(path => pathname.startsWith(`${path}/`)),
  ));
  const showChats = () => { setView('chats'); if (collapsed) onExpand?.(); };
  const startNewChat = () => navigate('/chat', { state: { newChat: Date.now() } });
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

  const renderRows = (dests: NavDest[]) => dests.map((d) => {
    const kind = workKindForPath(d.path);
    const open = expanded.has(d.path);
    return (
      <div key={d.path}>
        <div className="flex min-w-0 items-center">
          <div className="min-w-0 flex-1"><NavRow dest={d} collapsed={collapsed} {...badgeFor(d)} /></div>
          {kind && !collapsed && <button
            type="button"
            aria-label={`${open ? 'Hide' : 'Show'} ${d.label.toLowerCase()} items`}
            aria-expanded={open}
            onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(d.path)) next.delete(d.path); else next.add(d.path); return next; })}
            className="grid h-9 w-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
          ><ChevronRight className={cn('h-3.5 w-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden /></button>}
        </div>
        {kind && open && !collapsed && <WorkCollection kind={kind} path={d.path} />}
      </div>
    );
  });

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-base motion-reduce:transition-none',
        collapsed ? 'w-[72px]' : 'w-[248px]',
      )}
    >
      <div className={cn('sidebar-brand app-drag flex items-center gap-2.5 px-4 py-4', collapsed && 'justify-center px-0')}>
        <DogMark size={collapsed ? 28 : 32} />
        {!collapsed && <span className="text-h3 font-bold text-fg">Clementine</span>}
      </div>

      <div className={cn('flex shrink-0 flex-col gap-1 px-3 pb-3', collapsed && 'items-center px-0')}>
        <button type="button" onClick={startNewChat} title="New chat" aria-label="New chat" className={cn('flex h-10 items-center gap-2.5 rounded-md bg-fg px-3 text-body font-semibold text-canvas transition-opacity hover:opacity-85', collapsed ? 'w-11 justify-center px-0' : 'w-full')}>
          <Plus className="h-4 w-4 shrink-0" aria-hidden />{!collapsed && 'New chat'}
        </button>
        <button type="button" onClick={() => window.dispatchEvent(new Event('clem:command-palette'))} title="Search work and chats" aria-label="Search work and chats" className={cn('flex h-10 items-center gap-2.5 rounded-md px-3 text-body text-muted transition-colors hover:bg-hover hover:text-fg', collapsed ? 'w-11 justify-center px-0' : 'w-full')}>
          <Search className="h-4 w-4 shrink-0" aria-hidden />{!collapsed && 'Search work and chats'}
        </button>
        {collapsed && <button type="button" onClick={showChats} title="Chat history" aria-label="Chat history" className="grid h-10 w-11 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"><MessageSquare className="h-4 w-4" aria-hidden /></button>}
      </div>

      {!collapsed && <div role="group" aria-label="Navigator view" className="mx-3 flex shrink-0 gap-4 border-b border-border px-2">
        {(['work', 'chats'] as const).map(value => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={cn('border-b-2 px-1 pb-2 text-small font-semibold transition-colors', view === value ? 'border-primary text-fg' : 'border-transparent text-muted hover:text-fg')}>{value === 'work' ? 'Work' : 'Chats'}</button>)}
      </div>}

      {view === 'chats' && !collapsed ? (
        <ConversationSidebar embedded className="min-h-0 w-full flex-1 border-r-0" />
      ) : <div className={cn('flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-2', collapsed && 'items-center px-0')}>
        {!collapsed && <RecentWork onHistory={showChats} />}
        {renderRows(nav.pinned)}
        {renderRows(nav.shown)}

        {nav.more.length > 0 && (
          <div className={cn('flex flex-col gap-1.5 pt-3', collapsed && 'items-center')}>
            <button
              type="button"
              onClick={toggleMore}
              className={cn(
                'flex h-10 items-center gap-2.5 rounded-sm px-3 text-body font-medium text-faint transition-colors duration-fast hover:bg-hover hover:text-muted cursor-pointer',
                collapsed ? 'w-11 justify-center px-0' : 'w-full',
                moreOpen && 'text-muted',
              )}
              aria-expanded={moreOpen}
              aria-controls="sidebar-more"
              aria-label={collapsed ? (moreOpen ? 'Hide more destinations' : 'Show more destinations') : undefined}
              title={collapsed ? 'More' : undefined}
            >
              {collapsed ? (
                <Ellipsis className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              ) : (
                <>
                  <ChevronRight className={cn('h-4 w-4 transition-transform duration-fast', moreOpen && 'rotate-90')} strokeWidth={1.75} aria-hidden />
                  <span>More</span>
                </>
              )}
            </button>
            <div
              id="sidebar-more"
              className={cn(moreOpen ? 'flex' : 'hidden', 'flex-col gap-1.5', collapsed && 'items-center')}
            >
              {renderRows(nav.more)}
            </div>
          </div>
        )}
      </div>}

      <div className={cn('flex flex-col gap-1 border-t border-border px-3 py-3', collapsed && 'items-center px-0')}>
        {renderRows(nav.footer)}
      </div>
    </nav>
  );
}
