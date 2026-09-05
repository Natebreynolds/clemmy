import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ADVANCED_NAV, DEVELOPER_NAV } from '@/lib/nav';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { usePoll } from '@/lib/poll';
import { getSettings, patchDeveloperFlags } from '@/lib/settings';

/**
 * The home of the advanced panels now that they no longer sit in the sidebar,
 * plus the Developer switch: a runtime view over the CLEMMY_* kill-switches.
 * Off by default; toggling persists (CLEMMY_DEV_MODE).
 */
export function DeveloperModeCard() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const on = settings.data?.developerMode ?? false;
  const [busy, setBusy] = useState(false);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await patchDeveloperFlags({ devMode: next });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <FlaskConical className="h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">Developer mode</h3>
          <p className="text-small text-muted">
            Adds a <strong>Developer</strong> page here to flip CLEMMY_* feature flags at runtime. For power users — leave off if unsure.
          </p>
        </div>
        <Switch checked={on} disabled={busy || settings.isLoading} label="Developer mode" onChange={toggle} />
      </div>
      <nav aria-label="Advanced panels" className="flex flex-wrap gap-2">
        {[...ADVANCED_NAV, ...(on ? [DEVELOPER_NAV] : [])].map((d) => {
          const Icon = d.icon;
          return (
            <Link
              key={d.path}
              to={d.path}
              title={d.hint}
              className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-border bg-surface px-2.5 text-small text-muted transition-colors hover:border-border-strong hover:text-fg"
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span>{d.label}</span>
            </Link>
          );
        })}
      </nav>
    </Card>
  );
}
