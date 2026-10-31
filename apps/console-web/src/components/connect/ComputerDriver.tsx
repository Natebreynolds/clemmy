import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Download, ShieldCheck, Plug, Loader2, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { computerDriverPresentation } from '@/lib/computer-driver-presentation';
import {
  computerDriverNextStep, connectComputerDriver, getComputerDriver, getComputerDriverInstallJob, grantComputerDriverPermissions, installComputerDriver,
} from '@/lib/computer-driver';

// Your computer: Cua Driver (open source) lets Clem click, type and read in
// the apps on this machine with a cursor of its own. One tap turns it on:
// Clem downloads her own copy, verifies it, and runs it under the app's
// identity, so no administrator, system folder or terminal is involved. The
// system's own permission pages remain available beside the relevant state.
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
  const presentation = computerDriverPresentation(s, status.isError);
  const setupPending = Boolean(jobId && (!job || job.status === 'running' || jobQ.isError));
  const setupDisabled = status.isError || busy !== null || setupPending;
  const permissions = s?.permissionSettingsAvailable === true && step === 'ready' ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" disabled={setupDisabled} onClick={() => run('permissions', async () => { const r = await grantComputerDriverPermissions(); setHint(r.output); })}>
        {busy === 'permissions' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />} Open permission settings
      </Button>
      {hint && <span className="text-small text-muted">{hint}</span>}
    </div>
  ) : null;

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <Monitor className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 text-fg">Your computer</h3>
            <StatusPill tone={presentation.tone}>{presentation.label}</StatusPill>
          </div>
          <p className="mt-1 max-w-prose text-small text-muted">{presentation.detail}</p>
          {s?.platformSupport === 'preview' && <p className="mt-1 text-small text-muted">Computer control on Windows is a preview.</p>}
          {status.isError && <Button variant="secondary" size="sm" className="mt-3" disabled={status.isFetching} onClick={() => { void status.refetch(); }}>{status.isFetching ? 'Checking…' : 'Retry status'}</Button>}
          {step === 'install' && s && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={setupDisabled} onClick={() => run('install', async () => { const r = await installComputerDriver(); setJobId(r.job.id); })}>
                {busy === 'install' || job?.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />} Turn on
              </Button>
              <span className="text-small text-muted">Downloads and connects Clem’s computer control.</span>
            </div>
          )}
          {step === 'connect' && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={setupDisabled} onClick={() => run('connect', connectComputerDriver)}>
                {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plug className="h-4 w-4" aria-hidden />} Connect to Clem
              </Button>
            </div>
          )}
          {s && s.permissions !== 'granted' && permissions && <div className="mt-3">{permissions}</div>}
          {job && <p role="status" className="mt-3 text-small text-fg">{job.status === 'running' ? 'Turning on computer control…' : job.status === 'succeeded' ? 'Setup finished. Connection status is checked above.' : 'Computer setup did not finish. Open Connection details to see the setup output before trying again.'}</p>}
          {jobId && jobQ.isError && <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-small text-muted">
            Setup progress couldn’t be refreshed. Check its status before trying setup again.
            <Button size="sm" variant="secondary" disabled={jobQ.isFetching} onClick={() => { void jobQ.refetch(); }}>{jobQ.isFetching ? 'Checking…' : 'Retry setup status'}</Button>
          </div>}
          {error && <p role="alert" className="mt-2 text-small text-danger">{error}</p>}
          {s && <details className="mt-4 border-t border-border pt-3">
            <summary className="cursor-pointer rounded-md py-1 text-small font-medium text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Connection details</summary>
            <div className="mt-3 space-y-3 text-small text-muted">
              {status.isError && <p>These are the last checked details. The current connection status is unavailable.</p>}
              <p className="max-w-prose">Cua Driver is the open-source software Clem uses to click, type and read in apps with a cursor of her own. Actions are recorded and follow your approval rules.</p>
              {s.installed ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                <dt>Version</dt><dd>{s.version || 'Not available'}</dd>
                <dt>Running state</dt><dd>{s.daemon === 'running' ? 'Running' : s.daemon === 'stopped' ? 'Stopped' : 'Not confirmed'}</dd>
                <dt>Screen access</dt><dd>{s.permissions === 'granted' ? 'Allowed' : s.permissions === 'missing' ? 'Permission needed' : 'Not confirmed'}</dd>
                <dt>Connection</dt><dd>{s.connected ? 'Connected to Clem' : 'Not connected'}</dd>
              </dl> : <p>Downloads Clem’s own copy (about 50 MB), checks the maker’s checksums, and connects it. No administrator needed.</p>}
              {s.installed && s.connected && <p>Computer control also handles browsing when available. Saved browser fallbacks stay separate.</p>}
              {s.permissions === 'granted' && permissions}
              {s.docsUrl && <a className="inline-flex items-center gap-1 text-small text-primary hover:underline" href={s.docsUrl} target="_blank" rel="noreferrer">About computer control <ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}
              {job && <pre className="max-h-40 overflow-auto rounded-md bg-subtle p-2 text-xs text-muted">{job.output || 'No setup output recorded.'}</pre>}
            </div>
          </details>}
        </div>
      </div>
    </Card>
  );
}
