/**
 * Settings — cleaned up, not rebuilt (owner 2026-09-08: "a little cluttered…
 * not looking for a complete overhaul"). A left nav instead of one long
 * scroll; Models first because it is what changes most; providers as chips;
 * the diagnostics panel lives under Advanced › Diagnostics where it belongs.
 */
import { Sun, Moon, Monitor, Sliders, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { openCustomizeHome } from '@/components/home/CustomizePanel';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { ProfileForm } from './settings/ProfileForm';
import { NotificationsEditor } from './settings/NotificationsEditor';
import { ConnectedSection, ModelsSection } from './settings/ModelsRoutingSection';
import { DeveloperModeCard } from './settings/DeveloperModeCard';
import { NotchSettingsCard } from './settings/NotchSettingsCard';
import { cn } from '@/lib/cn';

const THEMES: { key: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { key: 'light', label: 'Light', icon: Sun },
  { key: 'dark', label: 'Dark', icon: Moon },
  { key: 'system', label: 'System', icon: Monitor },
];

const NAV: { id: string; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'connected', label: 'Connected' },
  { id: 'profile', label: 'Profile' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'notch', label: 'In the notch' },
  { id: 'home', label: 'Home layout' },
  { id: 'developer', label: 'Developer' },
];

export function Settings() {
  const { choice, setChoice } = useTheme();
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Settings sections" className="hidden w-[220px] shrink-0 flex-col border-r border-border bg-subtle px-3 py-6 md:flex">
        <h1 className="mb-3 px-2 text-h2 text-fg">Settings</h1>
        {NAV.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="rounded-md px-2.5 py-1.5 text-small font-medium text-muted transition-colors hover:bg-surface hover:text-fg">{s.label}</a>
        ))}
        <div className="mt-4 border-t border-border pt-3">
          <Link to="/advanced" className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-small text-muted hover:text-fg">Advanced <ChevronRight className="h-3.5 w-3.5" aria-hidden /></Link>
          <Link to="/advanced/diagnostics" className="block rounded-md px-2.5 py-1 text-caption text-faint hover:text-fg">Diagnostics · Usage · Observability</Link>
        </div>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-10">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8">
          <h1 className="text-h1 text-fg md:hidden">Settings</h1>
          <ModelsSection />
          <ConnectedSection />
          <section id="profile" className="scroll-mt-16"><h2 className="mb-3 text-h2 text-fg">Profile</h2><ProfileForm /></section>
          <section id="notifications" className="scroll-mt-16"><NotificationsEditor /></section>
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
          <section id="notch" className="scroll-mt-16"><NotchSettingsCard /></section>
          <section id="home" className="scroll-mt-16">
            <h2 className="mb-3 text-h2 text-fg">Home layout</h2>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
              <Sliders className="h-5 w-5 shrink-0 text-muted" aria-hidden />
              <div className="flex-1"><div className="text-body font-semibold text-fg">Panes, sidebar pins, quick actions</div><div className="text-small text-muted">Applies on your phone too.</div></div>
              <Button variant="secondary" size="sm" onClick={openCustomizeHome}>Customize</Button>
            </div>
          </section>
          <section id="developer" className="scroll-mt-16"><DeveloperModeCard /></section>
        </div>
      </div>
    </div>
  );
}
