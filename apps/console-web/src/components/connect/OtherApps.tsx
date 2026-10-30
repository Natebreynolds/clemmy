import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Share2, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { getOtherApps, otherAppAction, otherAppStateWords, setOtherAppConnected, type OtherApp } from '@/lib/other-apps';

// Other apps on this computer (Claude Desktop, Cursor) can hand Clem a task.
// One tap adds her to that app's own MCP settings; the work still happens
// here, with her memory and tools, and anything that needs the owner waits
// for them here.
export function OtherApps() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['other-apps'], queryFn: getOtherApps, staleTime: 30_000 });
  const [busy, setBusy] = useState<OtherApp['id'] | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const data = status.data;
  if (!data?.available) return status.isError ? <QueryUnavailable title="Other apps couldn’t be checked" description="Availability on this computer is unknown." onRetry={() => { void status.refetch(); }} className="mb-4 py-5" /> : null;
  const apps = data.apps.filter((app) => app.state !== 'not_installed');

  const act = async (app: OtherApp, connect: boolean) => {
    setBusy(app.id); setNotice(null);
    try {
      const result = await setOtherAppConnected(app.id, connect);
      setNotice({ tone: 'info', text: connect ? `${app.name} can hand Clem work now. ${result.after ?? ''}`.trim() : `${app.name} no longer reaches Clem.` });
    } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: ['other-apps'] });
    }
  };

  return (
    <Card>
      {status.isError && <QueryUnavailable title="Other apps couldn’t be refreshed" description="Showing their last loaded connection state." onRetry={() => { void status.refetch(); }} className="mb-3 py-5" />}
      <div className="flex items-start gap-3">
        <Share2 className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-h3 text-fg">Let other apps hand Clem work</h3>
          <p className="mt-1 text-small text-muted">
            Ask Clem for something from another app on this computer. She does it here, with her memory and tools, and anything that needs you still waits for you here.
          </p>
          {apps.length === 0 ? (
            <p className="mt-3 text-small text-muted">Claude Desktop and Cursor are not on this computer. Any app that speaks MCP can still reach her.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {apps.map((app) => {
                const action = otherAppAction(app.state);
                return (
                  <li key={app.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="text-body text-fg">{app.name}</span>
                    <StatusPill tone={app.state === 'connected' ? 'success' : app.state === 'needs_update' || app.state === 'unreadable' ? 'warning' : 'neutral'}>
                      {otherAppStateWords(app.state)}
                    </StatusPill>
                    <span className="flex-1" />
                    {action && (
                      <Button size="sm" variant={action.connect ? 'primary' : 'secondary'} disabled={busy !== null || status.isError} onClick={() => act(app, action.connect)}>
                        {busy === app.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                        {action.label}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {notice && <p className={`mt-2 text-small ${notice.tone === 'danger' ? 'text-danger' : 'text-muted'}`} role="status">{notice.text}</p>}
        </div>
      </div>
    </Card>
  );
}
