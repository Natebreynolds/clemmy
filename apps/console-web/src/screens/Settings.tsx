/**
 * Settings — cleaned up, not rebuilt (owner 2026-09-08: "a little cluttered…
 * not looking for a complete overhaul"). A left nav instead of one long
 * scroll; Models first because it is what changes most, and every model
 * account, key and job in that one section; the diagnostics panel lives under
 * Advanced › Diagnostics where it belongs.
 */
import { Sun, Moon, Monitor, Sliders, ChevronRight } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { openCustomizeHome } from '@/components/home/CustomizePanel';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { ProfileForm } from './settings/ProfileForm';
import { NotificationsEditor } from './settings/NotificationsEditor';
import { ModelsSection } from './settings/ModelsRoutingSection';
import { DeveloperModeCard } from './settings/DeveloperModeCard';
import { NotchSettingsCard } from './settings/NotchSettingsCard';
import { CleanupCard } from './settings/CleanupCard';
import { cn } from '@/lib/cn';

const THEMES: { key: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { key: 'light', label: 'Light', icon: Sun },
  { key: 'dark', label: 'Dark', icon: Moon },
  { key: 'system', label: 'System', icon: Monitor },
];

/**
 * Nine settings in a flat list read as a pile: "Models, Profile,
 * Notifications, Clean up, Appearance, In the notch, Home layout, Developer"
 * gives the eye no way to skip the two thirds it does not want. The groups
 * below are the three questions someone actually arrives with — what is she
 * running on, what does she know about me, how does this app behave — plus the
 * upkeep drawer everything else falls into.
 */
const NAV_GROUPS: { group: string; items: { id: string; label: string }[] }[] = [
  { group: 'Clementine', items: [
    { id: 'accounts', label: 'Model accounts' },
    { id: 'who-does-what', label: 'Who does what' },
  ] },
  { group: 'You', items: [
    { id: 'profile', label: 'Profile' },
    { id: 'notifications', label: 'Notifications' },
  ] },
  { group: 'This app', items: [
    { id: 'appearance', label: 'Appearance' },
    { id: 'home', label: 'Home layout' },
    { id: 'notch', label: 'In the notch' },
  ] },
  { group: 'Upkeep', items: [
    { id: 'cleanup', label: 'Clean up' },
    { id: 'developer', label: 'Developer mode' },
  ] },
];

export function Settings() {
  const { choice, setChoice } = useTheme();
  // Links from elsewhere (Connect, a top-bar chip) land on a section by hash;
  // the router does not scroll to it on its own.
  const { hash } = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [hash]);
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Settings sections" className="hidden w-[220px] shrink-0 flex-col border-r border-border bg-subtle px-3 py-6 md:flex">
        {NAV_GROUPS.map((g, i) => (
          <div key={g.group} className={cn('flex flex-col', i > 0 && 'mt-3 border-t border-border pt-3')}>
            <p className="px-2.5 pb-1 text-caption font-semibold uppercase tracking-widest text-faint">{g.group}</p>
            {g.items.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="rounded-md px-2.5 py-1.5 text-small font-medium text-muted transition-colors hover:bg-surface hover:text-fg">{s.label}</a>
            ))}
          </div>
        ))}
        <div className="mt-4 border-t border-border pt-3">
          {/* One door. Advanced now carries its own rail to every section, so
              naming three of them here was a second, partial way in. */}
          <Link to="/advanced" className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-small text-muted hover:text-fg">Advanced <ChevronRight className="h-3.5 w-3.5" aria-hidden /></Link>
        </div>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-10">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8">
          <p className="-mb-4 text-caption font-semibold uppercase tracking-widest text-faint">Clementine</p>
          <ModelsSection />
          <p className="-mb-4 text-caption font-semibold uppercase tracking-widest text-faint">You</p>
          <section id="profile" className="scroll-mt-16"><h2 className="mb-3 text-h2 text-fg">Profile</h2><ProfileForm /></section>
          <section id="notifications" className="scroll-mt-16"><NotificationsEditor /></section>
          <p className="-mb-4 text-caption font-semibold uppercase tracking-widest text-faint">This app</p>
          <section id="appearance" className="scroll-mt-16">
            <h2 className="mb-3 text-h2 text-fg">Appearance</h2>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3">
              <div><div className="text-body font-semibold text-fg">Theme</div><div className="text-small text-muted">Warm light by default.</div></div>
              <div role="group" aria-label="Theme" className="inline-flex rounded-full bg-subtle p-0.5">
                {THEMES.map((t) => {
                  const Icon = t.icon;
                  const active = choice === t.key;
                  return (
                    <button key={t.key} type="button" aria-pressed={active} onClick={() => setChoice(t.key)}
                      className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-small font-semibold transition-colors', active ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg')}>
                      <Icon className="h-3.5 w-3.5" aria-hidden />{t.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
          <section id="home" className="scroll-mt-16">
            <h2 className="mb-3 text-h2 text-fg">Home layout</h2>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
              <Sliders className="h-5 w-5 shrink-0 text-muted" aria-hidden />
              <div className="flex-1"><div className="text-body font-semibold text-fg">Panes, sidebar pins, quick actions</div><div className="text-small text-muted">Applies on your phone too.</div></div>
              <Button variant="secondary" size="sm" onClick={openCustomizeHome}>Customize</Button>
            </div>
          </section>
          <section id="notch" className="scroll-mt-16"><NotchSettingsCard /></section>
          <p className="-mb-4 text-caption font-semibold uppercase tracking-widest text-faint">Upkeep</p>
          <section id="cleanup" className="scroll-mt-16">
            <h2 className="mb-1 text-h2 text-fg">Clean up</h2>
            <p className="mb-3 text-small text-muted">Clear what is only taking up room. Nothing is deleted: updates are marked read, stale asks cancelled, stuck runs stopped, old conversations archived.</p>
            <CleanupCard />
          </section>
          <section id="developer" className="scroll-mt-16"><DeveloperModeCard /></section>
        </div>
      </div>
    </div>
  );
}
