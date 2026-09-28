import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Button } from '@/components/ui/Button';

type Job = { id: string; title: string; action?: string; status: string; detail?: string; output: string; interactive?: boolean };

/** Process controls stay with the conversation; sensitive input never becomes a chat message. */
export function CliSessions({ sessionId }: { sessionId?: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setJobs([]); setInputs({}); setProblem('');
    if (!sessionId) return;
    const poll = async () => {
      try {
        const data = await apiGet<{ jobs: Job[] }>(`/api/console/cli-sessions?sessionId=${encodeURIComponent(sessionId)}`);
        if (!disposed) { setJobs(data.jobs); setProblem(''); }
      } catch { if (!disposed) setProblem('Unable to reach your computer. Process status is unconfirmed.'); }
      if (!disposed) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionId]);
  const act = async (job: Job, action: 'input' | 'cancel') => {
    setBusy(job.id); setProblem('');
    const input = inputs[job.id] ?? '';
    setInputs(previous => ({ ...previous, [job.id]: '' }));
    try {
      await apiPost(`/api/console/cli-sessions/${encodeURIComponent(job.id)}/${action}`, { sessionId, ...(action === 'input' ? { input } : {}) });
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Could not reach the process.'); }
    finally { setBusy(null); }
  };
  if (!jobs.length) return null;
  return <section aria-label="Command-line activity" className="my-4 space-y-3 rounded-lg border border-border bg-surface p-4">
    {problem && <p role="status" className="text-sm text-warning">{problem}</p>}
    {jobs.map(job => <div key={job.id} className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm text-fg">{job.title}</strong><span className="text-xs text-muted">{problem ? 'Status unavailable' : job.status === 'running' ? 'In progress' : job.status === 'succeeded' ? job.action === 'auth' ? 'Verified' : 'Completed' : job.status}</span></div>
      {job.detail && <p className="text-sm text-muted">{job.detail}</p>}
      <details><summary className="cursor-pointer text-sm text-muted">Process details</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-fg">{job.output || 'No output available. Interactive output is not saved after a restart.'}</pre></details>
      {job.status === 'running' && <div className="flex flex-wrap items-end gap-2">
        {job.interactive && <form className="flex min-w-0 flex-1 flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void act(job, 'input'); }}>
          <label className="min-w-0 flex-1 text-xs text-muted">Private response to process<input aria-label={`Private response for ${job.title}`} type="password" autoComplete="off" maxLength={511} value={inputs[job.id] ?? ''} onChange={event => setInputs(previous => ({ ...previous, [job.id]: event.target.value }))} className="mt-1 block w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary" /></label>
          <Button type="submit" disabled={busy !== null || Boolean(problem)} size="sm">Send input</Button>
        </form>}
        <Button size="sm" variant="ghost" disabled={busy !== null || Boolean(problem)} onClick={() => void act(job, 'cancel')}>Stop process</Button>
      </div>}
    </div>)}
  </section>;
}
