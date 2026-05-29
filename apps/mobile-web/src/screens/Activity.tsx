import { useEffect, useState } from 'preact/hooks';
import { listRecentRuns, type RunSummary } from '../lib/api';

export function Activity() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const { runs } = await listRecentRuns();
        if (!cancelled) {
          setRuns(runs);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load activity');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    refresh();
    const interval = setInterval(refresh, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading && runs.length === 0) return <div class="inbox-empty">Loading…</div>;
  if (error && runs.length === 0) return <div class="inbox-empty">{error}</div>;
  if (runs.length === 0) return <div class="inbox-empty">No recent activity.</div>;

  return (
    <div>
      {runs.map((run) => (
        <div class="run-card" key={run.id}>
          <div class="title">{run.title}</div>
          <div class={`status ${run.status}`}>{run.status}</div>
        </div>
      ))}
    </div>
  );
}
