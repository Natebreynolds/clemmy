import { Sun, Moon, Monitor, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { ProfileForm } from './settings/ProfileForm';
import { NotificationsEditor } from './settings/NotificationsEditor';
import { ModelsRoutingSection } from './settings/ModelsRoutingSection';
import { DeveloperModeCard } from './settings/DeveloperModeCard';
import { StartupDoctorCard } from './settings/StartupDoctorCard';
import { NotchSettingsCard } from './settings/NotchSettingsCard';
import { cn } from '@/lib/cn';

const THEMES: { key: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { key: 'light', label: 'Light', icon: Sun },
  { key: 'dark', label: 'Dark', icon: Moon },
  { key: 'system', label: 'System', icon: Monitor },
];

// In-app navigation row (NOT the legacy app). Used to point at the Connect
// screen for stored keys + connections; sign-in itself now lives inline in
// Models & routing (Codex + Claude), so nothing here bounces to /console-legacy.
function LinkRow({ title, desc, to }: { title: string; desc: string; to: string }) {
  return (
    <Card className="flex items-center gap-3 p-5">
      <div className="flex-1">
        <h3 className="text-h3 text-fg">{title}</h3>
        <p className="text-small text-muted">{desc}</p>
      </div>
      <Link to={to}>
        <Button variant="secondary" size="sm">Manage <ChevronRight className="h-4 w-4" aria-hidden /></Button>
      </Link>
    </Card>
  );
}

// Anchor jump-nav for the long single-page scroll — no router change, each
// section keeps its component; the ids live on lightweight wrapper divs.
const SECTIONS: { id: string; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'notch', label: 'Notch' },
  { id: 'profile', label: 'Profile' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'models', label: 'Models' },
  { id: 'developer', label: 'Developer' },
];

export function Settings() {
  const { choice, setChoice } = useTheme();
  return (
    <Page title="Settings" subtitle="Personalize Clementine and manage how it works" width="reading">
      <nav className="sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap gap-1.5 bg-canvas/95 px-1 py-2 backdrop-blur">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full border border-border px-3 py-1 text-small font-medium text-muted transition-colors hover:text-fg"
          >
            {s.label}
          </a>
        ))}
      </nav>
      <div className="space-y-4">
        <div id="appearance" className="scroll-mt-16">
        <Card className="p-5">
          <h3 className="mb-1 text-h3 text-fg">Appearance</h3>
          <p className="mb-4 text-small text-muted">Clementine opens in a warm light theme by default.</p>
          <div className="flex gap-2">
            {THEMES.map((t) => {
              const Icon = t.icon;
              const active = choice === t.key;
              return (
                <button key={t.key} type="button" onClick={() => setChoice(t.key)}
                  className={cn('flex flex-1 flex-col items-center gap-2 rounded-md border px-4 py-4 transition-colors cursor-pointer',
                    active ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:bg-hover hover:text-fg')}>
                  <Icon className="h-5 w-5" aria-hidden />
                  <span className="text-small font-medium">{t.label}</span>
                </button>
              );
            })}
          </div>
        </Card>
        </div>

        <div id="notch" className="scroll-mt-16"><NotchSettingsCard /></div>

        <div id="profile" className="scroll-mt-16">
          <ProfileForm />
          <div className="mt-4"><StartupDoctorCard /></div>
        </div>

        <div id="notifications" className="scroll-mt-16"><NotificationsEditor /></div>

        <div id="models" className="scroll-mt-16"><ModelsRoutingSection /></div>

        <LinkRow title="Connections & API keys" desc="Composio apps, stored keys, and MCP servers. (Codex & Claude sign-in are in Models & routing above.)" to="/connect" />

        <div id="developer" className="scroll-mt-16"><DeveloperModeCard /></div>
      </div>
    </Page>
  );
}
