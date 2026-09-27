import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
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
            Reveals the instruments under Advanced in the sidebar — diagnostics, telemetry, run replay, nightly self-research — and a <strong>Developer</strong> page for CLEMMY_* flags. Off by default; the panels keep working if you have a link to one.
          </p>
        </div>
        <Switch checked={on} disabled={busy || settings.isLoading} label="Developer mode" onChange={toggle} />
      </div>
    </Card>
  );
}
