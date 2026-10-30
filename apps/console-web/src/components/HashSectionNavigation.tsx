import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';

export function sectionNavigationState(pathname: string, id: string, state: unknown): unknown {
  if (pathname !== '/settings' || ['accounts', 'models', 'who-does-what'].includes(id)
    || !state || typeof state !== 'object' || Array.isArray(state)) return state;
  const next = { ...state } as Record<string, unknown>;
  delete next.onboardingModelReturn;
  return next;
}

/** In-page destinations stay reachable when a desktop window is narrow.
 * Router links retain scoped draft-return state while changing only the hash. */
export function HashSectionNavigation({ label, items, defaultId, className }: {
  label: string; items: readonly { id: string; label: string }[]; defaultId: string; className?: string;
}) {
  const location = useLocation();
  const current = location.hash.slice(1) || defaultId;
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [location.hash, items]);
  return <nav aria-label={label} className={cn('flex shrink-0 gap-5 overflow-x-auto border-b border-border bg-canvas px-5', className)}>
    {items.map(item => <Link key={item.id} to={{ pathname: location.pathname, search: location.search, hash: `#${item.id}` }} state={sectionNavigationState(location.pathname, item.id, location.state)}
      aria-current={current === item.id ? 'location' : undefined}
      className={cn('inline-flex min-h-12 shrink-0 items-center border-b-2 text-small font-semibold', current === item.id ? 'border-primary text-fg' : 'border-transparent text-muted hover:text-fg')}>{item.label}</Link>)}
  </nav>;
}
