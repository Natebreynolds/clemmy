import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Check, Download, ShieldCheck, Plug, Loader2, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  computerDriverNextStep, connectComputerDriver, getComputerDriver, getComputerDriverInstallJob, grantComputerDriverPermissions, installComputerDriver,
} from '@/lib/computer-driver';

// Your computer: Cua Driver (open source) lets Clem click, type and read in
// the apps on this machine with a cursor of its own. One tap turns it on:
// Clem downloads her own copy, verifies it, and runs it under the app's
// identity, so no administrator, system folder or terminal is involved. The
// system's own permission pages are offered beside the ready line.
export function ComputerDriver() {
  const qc = useQueryClient();
  const status = usePoll(['computer-driver'], getComputerDriver, 20_000);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
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
                <StatusPill tone={s.installed ? 'success' : 'neutral'}>{s.installed ? 'On' : 'Off'}</StatusPill>
                {s.installed && <StatusPill tone={s.daemon === 'running' ? 'success' : s.daemon === 'stopped' ? 'warning' : 'neutral'}>{s.daemon === 'running' ? 'Running' : s.daemon === 'stopped' ? 'Stopped' : 'Starting'}</StatusPill>}
                {s.installed && s.permissions !== 'unknown' && <StatusPill tone={s.permissions === 'granted' ? 'success' : 'warning'}>{s.permissions === 'granted' ? 'Allowed by macOS' : 'Needs your permission'}</StatusPill>}
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
                {busy === 'install' || job?.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />} Turn on
              </Button>
              <span className="text-small text-muted">Downloads Clem’s own copy (about 50 MB, checked against the maker’s checksums) and connects it. No administrator needed.</span>
              <a className="inline-flex items-center gap-1 text-small text-primary hover:underline" href={s.docsUrl} target="_blank" rel="noreferrer">What it is <ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>
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
          {step === 'ready' && s && (
            <div className="mt-2">
              <p className="inline-flex items-center gap-1 text-small text-fg"><Check className="h-4 w-4 text-success" aria-hidden /> Clem can use the apps on this computer. Ask her to do something in one.</p>
              <p className="mt-1 text-small text-muted">This is also Clem’s browser now. The Chrome harness and any cloud browser below stay idle while it is on.</p>
              {s.platformSupport === 'supported' && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" disabled={busy === 'permissions'} onClick={() => run('permissions', async () => { const r = await grantComputerDriverPermissions(); setHint(r.output); })}>
                    {busy === 'permissions' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />} Allow in System Settings
                  </Button>
                  <span className="text-small text-muted">{hint || 'If Clem cannot see or use your screen, switch Clementine on under Accessibility and Screen Recording.'}</span>
                </div>
              )}
            </div>
          )}
          {step === 'unsupported' && <p className="mt-2 text-small text-muted">Cua Driver does not support this platform yet.</p>}
          {job && (
            <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-subtle p-2 text-xs text-muted">{job.status === 'running' ? 'Turning on…\n' : job.status === 'succeeded' ? 'On.\n' : 'That did not finish.\n'}{job.output}</pre>
          )}
          {error && <p className="mt-2 text-small text-danger">{error}</p>}
        </div>
      </div>
    </Card>
  );
}
