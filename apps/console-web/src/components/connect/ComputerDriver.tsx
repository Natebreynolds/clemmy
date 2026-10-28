import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Check, Download, ShieldCheck, Plug, Loader2, ExternalLink, Copy } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  computerDriverNextStep, connectComputerDriver, getComputerDriver, getComputerDriverInstallJob, grantComputerDriverPermissions, installComputerDriver,
} from '@/lib/computer-driver';

// Your computer: Cua Driver (open source) lets Clem click, type and read in
// the apps on this machine, in windows behind yours, with a cursor of its
// own. Three moves, one at a time: install, grant permissions, connect.
export function ComputerDriver() {
  const qc = useQueryClient();
  const status = usePoll(['computer-driver'], getComputerDriver, 20_000);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const jobQ = useQuery({
    queryKey: ['computer-driver-install', jobId],
    queryFn: () => getComputerDriverInstallJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data?.job?.status === 'running' ? 1500 : false),
  });
  const job = jobQ.data?.job;
  const refresh = () => qc.invalidateQueries({ queryKey: ['computer-driver'] });
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); await refresh(); }
  };
  const s = status.data;
  const step = s ? computerDriverNextStep(s) : null;

  return (
    <Card>
      <div className="flex items-start gap-3">
        <Monitor className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 text-fg">Your computer</h3>
            {s && (
              <>
                <StatusPill tone={s.installed ? 'success' : 'neutral'}>{s.installed ? 'Installed' : 'Not installed'}</StatusPill>
                {s.installed && <StatusPill tone={s.daemon === 'running' ? 'success' : s.daemon === 'stopped' ? 'warning' : 'neutral'}>{s.daemon === 'running' ? 'Running' : s.daemon === 'stopped' ? 'Stopped' : 'Status unknown'}</StatusPill>}
                {s.installed && s.permissions !== 'unknown' && <StatusPill tone={s.permissions === 'granted' ? 'success' : 'warning'}>{s.permissions === 'granted' ? 'Permissions granted' : 'Needs permissions'}</StatusPill>}
                <StatusPill tone={s.connected ? 'success' : 'neutral'}>{s.connected ? 'Connected to Clem' : 'Not connected'}</StatusPill>
              </>
            )}
          </div>
          <p className="mt-1 text-small text-muted">
            Cua Driver (open source) lets Clem click, type and read in the apps on this Mac, in windows behind yours, with a cursor of its own.
            Every action still asks you first when it changes something, and is recorded like any other.
            {s?.platformSupport === 'preview' && ' On Windows this is a preview.'}
          </p>
          {step === 'install' && s && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy === 'install' || job?.status === 'running'} onClick={() => run('install', async () => { const r = await installComputerDriver(); setJobId(r.job.id); })}>
                {busy === 'install' || job?.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />} Install Cua Driver
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard?.writeText(s.installCommand); }} aria-label="Copy the install command"><Copy className="h-4 w-4" aria-hidden /> Copy the command</Button>
              <a className="inline-flex items-center gap-1 text-small text-primary hover:underline" href={s.docsUrl} target="_blank" rel="noreferrer">What it installs <ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>
            </div>
          )}
          {step === 'permissions' && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy === 'permissions'} onClick={() => run('permissions', grantComputerDriverPermissions)}>
                {busy === 'permissions' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />} Grant Accessibility & Screen Recording
              </Button>
              <span className="text-small text-muted">macOS asks you; nothing is granted from here.</span>
            </div>
          )}
          {step === 'connect' && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy === 'connect'} onClick={() => run('connect', connectComputerDriver)}>
                {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plug className="h-4 w-4" aria-hidden />} Connect to Clem
              </Button>
              <span className="text-small text-muted">Registers the driver as Clem’s own tool server.</span>
            </div>
          )}
          {step === 'ready' && <p className="mt-2 inline-flex items-center gap-1 text-small text-fg"><Check className="h-4 w-4 text-success" aria-hidden /> Clem can use the apps on this computer. Ask her to do something in one.</p>}
          {step === 'unsupported' && <p className="mt-2 text-small text-muted">Cua Driver does not support this platform yet.</p>}
          {job && (
            <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-subtle p-2 text-xs text-muted">{job.status === 'running' ? 'Installing…\n' : job.status === 'succeeded' ? 'Installed.\n' : 'The install did not finish.\n'}{job.output}</pre>
          )}
          {error && <p className="mt-2 text-small text-danger">{error}</p>}
        </div>
      </div>
    </Card>
  );
}
