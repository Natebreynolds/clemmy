import { isActiveRunStatus, listRecentRuns, type RunSummary } from '../lib/api';
import { relativeTime } from '../components/Approvals';
import { RunControl } from '../components/RunControl';
import { ScreenNotice } from '../components/ScreenNotice';
import { useScreenData } from '../lib/use-screen-data';

export function Activity() {
  const { data, loading, error, offline, refresh } = useScreenData(
    () => listRecentRuns(),
    { intervalMs: 8000 },
  );
  const runs = data?.runs ?? [];

  if (loading && runs.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }

  const notice = <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={runs.length > 0} />;

  if (runs.length === 0 && (error || offline)) return <div class="home">{notice}</div>;

  if (runs.length === 0) {
    return (
      <div class="empty">
        <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
        <p class="empty-title">Nothing has run yet</p>
        <p class="empty-body">Everything Clem does — chats, workflows, background work — shows up here.</p>
      </div>
    );
  }

  const live = runs.filter((run) => isActiveRunStatus(run.status));
  const done = runs.filter((run) => !isActiveRunStatus(run.status));

  return (
    <div class="home">
      {notice}
      {live.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Happening now</h2>
          <div class="stack">
            {live.map((run, i) => <RunCard key={run.id} run={run} index={i} live onChanged={() => void refresh()} />)}
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
