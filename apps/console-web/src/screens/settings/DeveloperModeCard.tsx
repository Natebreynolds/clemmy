import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { usePoll } from '@/lib/poll';
import { getSettings, patchDeveloperFlags } from '@/lib/settings';

/**
 * Reveals the Developer panel (Advanced → Developer), a runtime view over the
 * CLEMMY_* kill-switches. Off by default; toggling persists (CLEMMY_DEV_MODE).
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
    <Card className="flex items-center gap-3 p-5">
      <FlaskConical className="h-5 w-5 shrink-0 text-muted" aria-hidden />
      <div className="flex-1">
        <h3 className="text-h3 text-fg">Developer mode</h3>
        <p className="text-small text-muted">
          Adds a <strong>Developer</strong> page under Advanced to flip CLEMMY_* feature flags at runtime. For power users — leave off if unsure.
        </p>
      </div>
      <Switch checked={on} disabled={busy || settings.isLoading} label="Developer mode" onChange={toggle} />
    </Card>
  );
}
