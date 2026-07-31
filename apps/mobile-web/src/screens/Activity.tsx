import { useCallback, useEffect, useState } from 'preact/hooks';
import { listRecentRuns, type RunSummary } from '../lib/api';
import { relativeTime } from '../components/Approvals';
import { RunControl } from '../components/RunControl';
import { REFRESH_EVENT } from '../lib/native-bridge';

/** Runs still in flight, grouped above the finished ones. */
const ACTIVE = new Set(['running', 'queued', 'received', 'awaiting_approval']);

export function Activity() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { runs } = await listRecentRuns();
      setRuns(runs);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 8000);
    const onPull = () => { void refresh(); };
    window.addEventListener(REFRESH_EVENT, onPull);
    return () => {
      clearInterval(interval);
      window.removeEventListener(REFRESH_EVENT, onPull);
    };
  }, [refresh]);

  if (loading && runs.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }
  if (error && runs.length === 0) {
    return (
      <div class="empty">
        <p class="empty-title">Couldn't load activity</p>
        <p class="empty-body">{error}</p>
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div class="empty">
        <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
        <p class="empty-title">Nothing has run yet</p>
        <p class="empty-body">Everything Clem does — chats, workflows, background work — shows up here.</p>
      </div>
    );
  }

  const live = runs.filter((run) => ACTIVE.has(run.status));
  const done = runs.filter((run) => !ACTIVE.has(run.status));

  return (
    <div class="home">
      {live.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Happening now</h2>
          <div class="stack">
            {live.map((run, i) => <RunCard key={run.id} run={run} index={i} live onChanged={refresh} />)}
          </div>
        </section>
      ) : null}
      {done.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Earlier</h2>
          <div class="stack">
            {done.map((run, i) => <RunCard key={run.id} run={run} index={i} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function RunCard({ run, index, live, onChanged }: {
  run: RunSummary;
  index: number;
  live?: boolean;
  onChanged?: () => void;
}) {
  return (
    <article class={`card rise ${live ? 'card-live' : ''}`} style={{ '--i': index }}>
      {live ? <span class="pulse-dot" aria-hidden="true" /> : null}
      <div class="min-w-0">
        <div class="card-title-sm">{run.title || 'Untitled run'}</div>
        <div class="card-when">
          {live ? null : <span class={`status-dot status-${run.status}`} aria-hidden="true" />}
          {run.status.replace(/_/g, ' ')} · {relativeTime(run.updatedAt)}
        </div>
      </div>
      {live && onChanged ? <RunControl target={{ kind: 'run', runId: run.id }} onChanged={onChanged} /> : null}
    </article>
  );
}
