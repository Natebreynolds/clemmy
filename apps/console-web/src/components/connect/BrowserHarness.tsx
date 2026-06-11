import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Check, X, Loader2, Download, Stethoscope, FlaskConical, ExternalLink, Chrome } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  getBrowserHarness, installBrowserHarness, getBrowserHarnessInstallJob,
  browserHarnessDoctor, browserHarnessTest, browserHarnessChromeSetup,
  type BrowserHarnessCommandResult,
} from '@/lib/connect';

// Browser harness (browser-use): lets Clementine drive the user's REAL Chrome
// — logged-in sessions and all. The daemon has had the full status/install/
// doctor/test API since the integration landed; this card is the first time
// the redesigned console actually surfaces it (it was legacy-console-only).
export function BrowserHarness() {
  const qc = useQueryClient();
  const status = usePoll(['browser-harness'], getBrowserHarness, 0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ label: string; r: BrowserHarnessCommandResult } | null>(null);
  const [error, setError] = useState('');

  const jobQ = useQuery({
    queryKey: ['browser-harness-install', jobId],
    queryFn: () => getBrowserHarnessInstallJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data?.job?.status === 'running' ? 1500 : false),
  });
  const job = jobQ.data?.job;
  useEffect(() => {
    if (job && job.status !== 'running') { void qc.invalidateQueries({ queryKey: ['browser-harness'] }); setBusy(null); }
  }, [job?.status, qc]);

  const s = status.data;
  const prereqsMissing = (s?.prerequisites ?? []).filter((p) => !p.available);
  const tone = !s ? 'neutral' : s.installed ? (prereqsMissing.length === 0 ? 'success' : 'warning') : 'neutral';
  const pill = !s ? '—' : s.installed ? (prereqsMissing.length === 0 ? 'Ready' : 'Needs setup') : 'Not installed';

  const install = async () => {
    setBusy('install'); setError(''); setResult(null);
    try { const { job } = await installBrowserHarness(); setJobId(job.id); }
    catch (e) { setBusy(null); setError((e as Error).message); }
  };
  const run = async (label: string, fn: () => Promise<BrowserHarnessCommandResult>) => {
    setBusy(label); setError(''); setResult(null);
    try { setResult({ label, r: await fn() }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); void qc.invalidateQueries({ queryKey: ['browser-harness'] }); }
  };

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <Globe className="h-5 w-5 text-primary" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">Browser harness</h3>
          <p className="text-small text-muted">Let Clementine drive your real Chrome — logged-in sessions included</p>
        </div>
      </div>
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <Chrome className="h-5 w-5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-body font-medium text-fg">browser-use harness</span>
              {s?.version && <span className="font-mono text-caption text-faint">{s.version}</span>}
            </div>
            {s && !s.installed && <div className="truncate text-caption text-faint">Installs to {s.installDir}</div>}
          </div>
          {status.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-faint" aria-hidden /> : <StatusPill tone={tone}>{pill}</StatusPill>}
        </div>

        {/* Prerequisites — only surfaced when something is missing */}
        {s && prereqsMissing.length > 0 && (
          <div className="mt-3 rounded-md border border-border bg-subtle p-2.5">
            <div className="mb-1 text-caption text-muted">Missing prerequisites:</div>
            <div className="flex flex-wrap gap-2">
              {prereqsMissing.map((p) => (
                <span key={p.name} className="inline-flex items-center gap-1 text-caption text-danger"><X className="h-3.5 w-3.5" aria-hidden />{p.name}</span>
              ))}
            </div>
          </div>
        )}

        {s && (
          <div className="mt-3 flex flex-wrap gap-2">
            {!s.installed && (
              <Button size="sm" disabled={busy !== null} onClick={install}>
                {busy === 'install' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />} Install
              </Button>
            )}
            {s.installed && (
              <>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run('doctor', browserHarnessDoctor)}>
                  {busy === 'doctor' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Stethoscope className="h-3.5 w-3.5" aria-hidden />} Doctor
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => run('test', browserHarnessTest)}>
                  {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FlaskConical className="h-3.5 w-3.5" aria-hidden />} Smoke test
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run('chrome-setup', browserHarnessChromeSetup)}>
                  {busy === 'chrome-setup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Chrome className="h-3.5 w-3.5" aria-hidden />} Chrome setup
                </Button>
              </>
            )}
            {s.docsUrl && (
              <a href={s.docsUrl} target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-1 self-center text-caption text-faint hover:text-fg">
                <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Docs
              </a>
            )}
          </div>
        )}

        {/* Install job progress */}
        {job && (
          <div className="mt-3 rounded-md border border-border bg-subtle p-3">
            <div className="mb-1 flex items-center gap-2 text-small">
              {job.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> : job.status === 'succeeded' ? <Check className="h-4 w-4 text-success" aria-hidden /> : <X className="h-4 w-4 text-danger" aria-hidden />}
              <span className="font-medium text-fg">{job.title}</span><span className="text-faint">· {job.status}</span>
            </div>
            {job.output && <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-caption text-muted">{job.output}</pre>}
          </div>
        )}

        {/* Doctor / test / chrome-setup output */}
        {result && (
          <div className="mt-3 rounded-md border border-border bg-subtle p-3">
            <div className="mb-1 flex items-center gap-2 text-small">
              {result.r.ok ? <Check className="h-4 w-4 text-success" aria-hidden /> : <X className="h-4 w-4 text-danger" aria-hidden />}
              <span className="font-medium text-fg">{result.label}</span>
              <span className="text-faint">· exit {result.r.code ?? '—'}</span>
            </div>
            {result.r.output && <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-caption text-muted">{result.r.output}</pre>}
          </div>
        )}

        {error && <p className="mt-3 text-small text-danger">{error}</p>}
      </Card>
    </section>
  );
}
