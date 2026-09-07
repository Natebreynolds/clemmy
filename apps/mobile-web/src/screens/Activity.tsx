import { useEffect, useState } from 'preact/hooks';
import { useBackGesture, withDepthTransition } from '../lib/back-gesture';
import { isActiveRunStatus, listRecentRuns, listWorkingNow, type ActivityEntry, type RunSummary } from '../lib/api';
import { presentWorkingNow, type PresentedWorkingNowEntry } from '@clem/chat-engine';
import { mobileRunControl, runStatusLabel } from '../lib/running-tasks';
import { lastGoodAt, lastGoodNotice } from '../lib/last-good';
import { runRowLabel } from '../lib/run-rows';
import { relativeTime } from '../components/Approvals';
import { RunControl } from '../components/RunControl';
import { ScreenNotice } from '../components/ScreenNotice';
import { useScreenData } from '../lib/use-screen-data';
import { Run } from './Run';

interface Props {
  /** A run addressed by the URL — a push tap, a reload, or any surface that
   *  shows running work handing this screen its destination. */
  initialRunId?: string | null;
  /** Keeps the URL in step with what is open, so reload and the swipe-back
   *  gesture both land where the user actually is. */
  onRunChange?: (sessionId: string | null) => void;
}

export function Activity({ initialRunId, onRunChange }: Props = {}) {
  const [openRun, setOpenRun] = useState<string | null>(initialRunId ?? null);
  // The swipe-back closes the run AND drops it from the URL, so a reload after
  // leaving does not reopen the run the user just walked out of. (No transition
  // here: back-gesture already wraps the pop it is servicing.)
  useBackGesture(openRun !== null, () => { setOpenRun(null); onRunChange?.(null); });
  // The URL is the source of truth for which run is open: a push arriving while
  // this screen is already mounted must move it, not be ignored.
  useEffect(() => {
    setOpenRun(initialRunId ?? null);
  }, [initialRunId]);

  const showRun = (sessionId: string | null): void => {
    withDepthTransition(() => {
      setOpenRun(sessionId);
      onRunChange?.(sessionId);
    });
  };
  // "Happening now" reads the canonical server-owned working-now projection —
  // the same one the running-tasks sheet and desktop read — so a workflow
  // dispatched from chat appears here and its Stop targets the right route.
  // "Earlier" stays on the run history, which is where terminal rows live.
  //
  // It heads only the rows the presenter calls RUNNING. It used to head every
  // non-terminal row, which is how six runs blocked two days earlier came to
  // sit under the words "Happening now" — each of them still printing the live
  // phase text it had been showing when it died.
  const { data, loading, error, offline, refresh } = useScreenData(
    async () => {
      const [runsResult, workingNow] = await Promise.all([
        listRecentRuns().then((v) => ({ v }), (e) => ({ e })),
        listWorkingNow().then((v) => ({ v }), (e) => ({ e })),
      ]);
      if ('e' in runsResult && 'e' in workingNow) throw (runsResult as { e: unknown }).e;
      return {
        runs: 'v' in runsResult ? runsResult.v.runs : [],
        working: 'v' in workingNow ? workingNow.v : { entries: [], observedAt: new Date().toISOString() },
      };
    },
    { intervalMs: 8000, disabled: openRun !== null },
  );
  const runs = data?.runs ?? [];
  const working = data?.working ?? { entries: [], observedAt: new Date().toISOString() };
  // Same certificate as Home: pulse and elapsed come from the ONE shared
  // presenter — a stale or waiting row must not look alive here either.
  const workingView = presentWorkingNow(working.entries, working.observedAt);

  if (openRun) {
    return <Run sessionId={openRun} onBack={() => { showRun(null); void refresh(); }} />;
  }

  if (loading && runs.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }

  // The run list is one of the few things the service worker keeps through a
  // process death, so a cold open with the Mac asleep still shows work. It is
  // stamped, never passed off as live.
  const notice = (
    <ScreenNotice
      error={error}
      offline={offline}
      onRetry={() => void refresh()}
      hasData={runs.length > 0 || workingView.total > 0}
      lastGood={lastGoodNotice(lastGoodAt('/m/api/runs'), Date.now())}
    />
  );

  if (runs.length === 0 && workingView.total === 0 && (error || offline)) return <div class="home">{notice}</div>;

  if (runs.length === 0 && workingView.total === 0) {
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
      {LIVE_SECTIONS.map(({ membership, head }) => {
        const rows = workingView.entries.filter((p) => p.membership === membership);
        if (rows.length === 0) return null;
        return (
          <section class="home-section" key={membership}>
            <h2 class="section-head">{head}</h2>
            <div class="stack">
              {rows.map((p, i) => (
                <LiveCard key={p.entry.runKey} presented={p} index={i} onChanged={() => void refresh()} onOpen={showRun} />
              ))}
            </div>
          </section>
        );
      })}
      {done.length > 0 ? (
        <section class="home-section">
          <h2 class="section-head">Earlier</h2>
          <div class="stack">
            {done.map((run, i) => <RunCard key={run.id} run={run} index={i} onOpen={showRun} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}


/** Each membership gets its OWN heading, so a heading is never a claim about a
 *  row underneath it. Order is what a person cares about first. */
const LIVE_SECTIONS: ReadonlyArray<{ membership: 'needs_you' | 'running' | 'stalled'; head: string }> = [
  { membership: 'needs_you', head: 'Waiting on you' },
  { membership: 'running', head: 'Happening now' },
  { membership: 'stalled', head: 'Stalled' },
];

function LiveCard({ presented, index, onChanged, onOpen }: {
  presented: PresentedWorkingNowEntry<ActivityEntry>;
  index: number;
  onChanged: () => void;
  onOpen: (sessionId: string) => void;
}) {
  const entry = presented.entry;
  const { pulse, elapsed } = presented;
  const control = mobileRunControl(entry);
  const body = (
    <>
      {/* The pulse is a certificate: it animates only when the server said
          liveness === 'live'; anything else gets a quiet dot. */}
      {pulse
        ? <span class="pulse-dot" aria-hidden="true" />
        : <span class="running-task-state" style={{ background: 'var(--line-strong)' }} aria-hidden="true" />}
      <div class="min-w-0">
        <div class="card-title-sm">{entry.headline || 'Working…'}</div>
        {/* One vocabulary with the chip and with Home: a row that stopped
            says so, and how long ago, instead of replaying the phase text it
            was showing when it stopped. */}
        <div class="card-when">
          {runStatusLabel(presented)}
          {/* A stalled row already states an age, and for a row whose only
              evidence is its start the two ages are the same number — one
              suffix, not "nothing for 2d · 2d". */}
          {elapsed && !presented.stalled ? ` · ${elapsed}` : ''}
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
  // What it did, not what the engine calls it. The list route already carries
  // both lines (see lib/run-rows.ts); this row used to print the raw token.
  const label = runRowLabel(run);
  return (
    <article class={`card rise ${live ? 'card-live' : ''}`} style={{ '--i': index }}>
      {live ? <span class="pulse-dot" aria-hidden="true" /> : null}
      {/* The row opens the run. A run is a thing you look at, not a status
          line you read — the button wraps only the text so the stop control
          beside it stays independently tappable. */}
      <button class="run-open min-w-0" onClick={() => onOpen?.(run.sessionId)}>
        <div class="card-title-sm">{run.title || 'Untitled run'}</div>
        {label.detail ? <div class="run-outcome truncate">{label.detail}</div> : null}
        <div class="card-when">
          {live ? null : <span class={`status-dot status-${run.status}`} aria-hidden="true" />}
          {label.state} · {relativeTime(run.updatedAt)}
        </div>
      </button>
      {live && onChanged ? <RunControl target={{ kind: 'run', runId: run.id }} onChanged={onChanged} /> : null}
    </article>
  );
}
