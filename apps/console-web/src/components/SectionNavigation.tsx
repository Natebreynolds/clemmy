import { NavLink, useLocation } from 'react-router-dom';
import { AUTOMATION_DESTINATIONS, experienceSection, WORK_DESTINATIONS } from '@/lib/nav';
import { cn } from '@/lib/cn';

/** Local navigation keeps the full product visible without a crowded sidebar. */
export function SectionNavigation() {
  const { pathname } = useLocation();
  const section = experienceSection(pathname);
  if (!section) return null;
  const destinations = section === 'work' ? WORK_DESTINATIONS : AUTOMATION_DESTINATIONS;
  return (
    <nav aria-label={section === 'work' ? 'Work' : 'Automations'} className="section-navigation shrink-0 overflow-x-auto border-b border-border bg-canvas px-5 sm:px-8">
      <div className="mx-auto flex min-w-max max-w-6xl gap-5">
        {destinations.map(dest => <NavLink key={dest.path} to={dest.path}
          className={({ isActive }) => cn('inline-flex min-h-12 items-center border-b-2 px-0.5 text-small font-semibold transition-colors',
            isActive ? 'border-primary text-fg' : 'border-transparent text-muted hover:border-border-strong hover:text-fg')}>
          {dest.label}
        </NavLink>)}
      </div>
    </nav>
  );
}
