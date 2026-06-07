import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { PRIMARY_NAV, ADVANCED_NAV, FOOTER_NAV, type NavDest } from '@/lib/nav';
import { apiGet } from '@/lib/api';
import { usePoll } from '@/lib/poll';
import { DogMark } from './DogMark';
import { cn } from '@/lib/cn';

function NavRow({ dest, collapsed, badge }: { dest: NavDest; collapsed: boolean; badge?: number }) {
  const Icon = dest.icon;
  return (
    <NavLink
      to={dest.path}
      title={collapsed ? `${dest.label} — ${dest.hint}` : dest.hint}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-body font-medium transition-colors duration-fast cursor-pointer',
          collapsed && 'justify-center px-0',
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
          {!collapsed && badge ? (
            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-caption font-bold text-primary-fg">
              {badge > 99 ? '99+' : badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Live Inbox badge: pending approvals (best-effort).
  const approvals = usePoll(
    ['approvals-count'],
    () => apiGet<{ count?: number; approvals?: unknown[] }>('/api/console/approvals/list'),
    8000,
  );
  const pending = approvals.data?.count ?? approvals.data?.approvals?.length ?? 0;

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

      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {PRIMARY_NAV.map((d) => (
          <NavRow key={d.path} dest={d} collapsed={collapsed} badge={d.path === '/inbox' ? pending : undefined} />
        ))}

        <div className="pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-small font-semibold text-faint transition-colors hover:bg-hover hover:text-muted cursor-pointer',
              collapsed && 'justify-center px-0',
            )}
            aria-expanded={advancedOpen}
            title="Advanced"
          >
            <ChevronRight className={cn('h-4 w-4 transition-transform duration-fast', advancedOpen && 'rotate-90')} aria-hidden />
            {!collapsed && <span>Advanced</span>}
          </button>
          {advancedOpen && !collapsed && (
            <div className="mt-1 space-y-1">
              {ADVANCED_NAV.map((d) => (
                <NavRow key={d.path} dest={d} collapsed={false} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-1 border-t border-border px-3 py-3">
        {FOOTER_NAV.map((d) => (
          <NavRow key={d.path} dest={d} collapsed={collapsed} />
        ))}
      </div>
    </nav>
  );
}
