import { useState } from 'preact/hooks';
import { isActiveRunStatus, listRecentRuns, listWorkingNow, type ActivityEntry, type RunSummary } from '../lib/api';
import { mobileRunControl } from '../lib/running-tasks';
import { relativeTime } from '../components/Approvals';
import { RunControl } from '../components/RunControl';
import { ScreenNotice } from '../components/ScreenNotice';
import { useScreenData } from '../lib/use-screen-data';
import { Run } from './Run';

export function Activity() {
  const [openRun, setOpenRun] = useState<string | null>(null);
  // "Happening now" reads the canonical server-owned working-now projection —
  // the same one the running-tasks sheet and desktop read — so a workflow
  // dispatched from chat appears here and its Stop targets the right route.
  // "Earlier" stays on the run history, which is where terminal rows live.
  const { data, loading, error, offline, refresh } = useScreenData(
    async () => {
      const [runsResult, workingNow] = await Promise.all([
        listRecentRuns().then((v) => ({ v }), (e) => ({ e })),
        listWorkingNow().then((v) => ({ v }), (e) => ({ e })),
      ]);
      if ('e' in runsResult && 'e' in workingNow) throw (runsResult as { e: unknown }).e;
      return {
        runs: 'v' in runsResult ? runsResult.v.runs : [],
        working: 'v' in workingNow ? workingNow.v.entries : [],
      };
    },
    { intervalMs: 8000, disabled: openRun !== null },
  );
  const runs = data?.runs ?? [];
  const working = data?.working ?? [];

  if (openRun) {
    return <Run sessionId={openRun} onBack={() => { setOpenRun(null); void refresh(); }} />;
  }

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

  const done = runs.filter((run) => !isActiveRunStatus(run.status));

  return (
    <div class="home">
      {notice}
      {working.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Happening now</h2>
          <div class="stack">
            {working.map((entry, i) => (
              <LiveCard key={entry.runKey} entry={entry} index={i} onChanged={() => void refresh()} onOpen={setOpenRun} />
            ))}
          </div>
        </section>
      ) : null}
      {done.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Earlier</h2>
          <div class="stack">
            {done.map((run, i) => <RunCard key={run.id} run={run} index={i} onOpen={setOpenRun} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}


function LiveCard({ entry, index, onChanged, onOpen }: {
  entry: ActivityEntry;
  index: number;
  onChanged: () => void;
  onOpen: (sessionId: string) => void;
}) {
  const control = mobileRunControl(entry);
  const body = (
    <>
      <span class="pulse-dot" aria-hidden="true" />
      <div class="min-w-0">
        <div class="card-title-sm">{entry.headline || 'Working…'}</div>
        <div class="card-when">
          {entry.activity?.text || entry.lifecycle.replace(/_/g, ' ')} · {relativeTime(entry.startedAt)}
        </div>
      </div>
    </>
  );
  return (
    <article class="card card-live rise" style={{ '--i': index }}>
      {entry.sessionId ? (
        <button type="button" class="card-open-target" onClick={() => onOpen(entry.sessionId as string)}>
          {body}
        </button>
      ) : body}
      {control ? <RunControl target={control.target} resumable={control.resumable} onChanged={onChanged} /> : null}
    </article>
  );
}

function RunCard({ run, index, live, onChanged, onOpen }: {
  run: RunSummary;
  index: number;
  live?: boolean;
  onChanged?: () => void;
  onOpen?: (sessionId: string) => void;
}) {
  return (
    <article class={`card rise ${live ? 'card-live' : ''}`} style={{ '--i': index }}>
      {live ? <span class="pulse-dot" aria-hidden="true" /> : null}
      {/* The row opens the run. A run is a thing you look at, not a status
          line you read — the button wraps only the text so the stop control
          beside it stays independently tappable. */}
      <button class="run-open min-w-0" onClick={() => onOpen?.(run.sessionId)}>
        <div class="card-title-sm">{run.title || 'Untitled run'}</div>
        <div class="card-when">
          {live ? null : <span class={`status-dot status-${run.status}`} aria-hidden="true" />}
          {run.status.replace(/_/g, ' ')} · {relativeTime(run.updatedAt)}
        </div>
      </button>
      {live && onChanged ? <RunControl target={{ kind: 'run', runId: run.id }} onChanged={onChanged} /> : null}
    </article>
  );
}
