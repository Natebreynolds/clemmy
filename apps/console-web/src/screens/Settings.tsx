import { Sun, Moon, Monitor, ExternalLink } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { ProfileForm } from './settings/ProfileForm';
import { NotificationsEditor } from './settings/NotificationsEditor';
import { ModelsForm } from './settings/ModelsForm';
import { ModelBackendForm } from './settings/ModelBackendForm';
import { cn } from '@/lib/cn';

const THEMES: { key: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { key: 'light', label: 'Light', icon: Sun },
  { key: 'dark', label: 'Dark', icon: Moon },
  { key: 'system', label: 'System', icon: Monitor },
];

function ClassicRow({ title, desc }: { title: string; desc: string }) {
  return (
    <Card className="flex items-center gap-3 p-5">
      <div className="flex-1">
        <h3 className="text-h3 text-fg">{title}</h3>
        <p className="text-small text-muted">{desc}</p>
      </div>
      <a href="/console-legacy" target="_self">
        <Button variant="secondary" size="sm"><ExternalLink className="h-4 w-4" aria-hidden /> Manage</Button>
      </a>
    </Card>
  );
}

export function Settings() {
  const { choice, setChoice } = useTheme();
  return (
    <Page title="Settings" subtitle="Appearance, profile, and account" width="reading">
      <div className="space-y-4">
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

        <ProfileForm />

        <NotificationsEditor />

        <ModelsForm />

        <ModelBackendForm />

        <ClassicRow title="Sign-in & credentials" desc="Codex/OpenAI sign-in and stored keys (in Connect → Keys)." />
      </div>
    </Page>
  );
}
