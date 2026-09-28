import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { connectionDoor } from '../lib/native-bridge';

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
        const data = await api<{ jobs: Job[] }>(`/m/api/cli-sessions?sessionId=${encodeURIComponent(sessionId)}`);
        if (connectionDoor() === 'offline') throw new Error('Offline snapshot');
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
      await api(`/m/api/cli-sessions/${encodeURIComponent(job.id)}/${action}`, { method: 'POST', body: JSON.stringify({ sessionId, ...(action === 'input' ? { input } : {}) }) });
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Could not reach the process.'); }
    finally { setBusy(null); }
  };
  if (!jobs.length) return null;
  return <section aria-label="Command-line activity" className="cli-sessions">
    {problem && <p role="status">{problem}</p>}
    {jobs.map(job => <div key={job.id} className="cli-session">
      <div className="cli-session-heading"><strong>{job.title}</strong><span>{problem ? 'Status unavailable' : job.status === 'running' ? 'In progress' : job.status === 'succeeded' ? job.action === 'auth' ? 'Verified' : 'Completed' : job.status}</span></div>
      {job.detail && <p>{job.detail}</p>}
      <details><summary>Process details</summary><pre>{job.output || 'No output available. Interactive output is not saved after a restart.'}</pre></details>
      {job.status === 'running' && <div className="cli-session-controls">
        {job.interactive && <form className="cli-session-input" onSubmit={event => { event.preventDefault(); void act(job, 'input'); }}>
          <label>Private response to process<input aria-label={`Private response for ${job.title}`} type="password" autoComplete="off" maxLength={511} value={inputs[job.id] ?? ''} onChange={event => setInputs(previous => ({ ...previous, [job.id]: event.currentTarget.value }))} /></label>
          <button type="submit" disabled={busy !== null || Boolean(problem)}>Send input</button>
        </form>}
        <button disabled={busy !== null || Boolean(problem)} onClick={() => void act(job, 'cancel')}>Stop process</button>
      </div>}
    </div>)}
  </section>;
}
