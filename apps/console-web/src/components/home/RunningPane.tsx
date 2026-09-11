import { Link } from 'react-router-dom';
import type { ActivityEntry } from '@/lib/activity';
import { workingNowStatusLabel, type WorkingNowView } from '@/lib/activity-presentation';
import { cn } from '@/lib/cn';
import { ActivityCard } from '@/components/chat/ActivityCard';
import { sessionActivityLive, useSessionActivity, useWorkflowRunActivity } from '@/lib/session-activity';
import {
  runningKindLabel,
  runningMeta,
  runningOpenTarget,
  runningPercent,
  steerTarget,
} from './home-model';
import { LoadFailedLine, PaneCard, PaneRow, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';

const MAX_ROWS = 4;

/** The lead in-flight run streams into the same ActivityCard chat uses, so
 *  a workflow on Home is not a headline with no work underneath. */
function LiveRunFeed({ entry }: { entry: ActivityEntry }) {
  const workflow = useWorkflowRunActivity(entry.kind === 'workflow' ? (entry.runId ?? null) : null);
  const session = useSessionActivity(entry.kind === 'workflow' ? null : (entry.sessionId ?? null));
  const state = entry.kind === 'workflow' ? workflow : session;
  const live = sessionActivityLive(state, entry.liveness === 'live');
  if (state.items.length === 0 && !state.progress) return null;
  return (
    <ActivityCard
      items={state.items}
      live={live}
      progress={state.progress}
      className="border-0 bg-subtle/70 shadow-none"
    />
  );
}

const ACTION =
  'inline-flex h-8 items-center rounded-md px-3 text-small font-semibold transition-colors';

/**
 * RUNNING — the ONE Working-Now presenter, rendered as in-flight work.
 *
 * Rows a person is BLOCKING are decisions, not running work: they live in the
 * Needs-you pane (and on the Tasks board), never here twice. A STALLED row has
 * no such second home — Home's needs-you pane is fed by the command-center
 * query, not by this view — so filtering it out of here left an unfinished run
 * rendering NOWHERE on this screen while the pane said "Nothing is running
 * right now." That is the owner's "I don't see the ability to clear certain
 * things": you cannot clear what you cannot see. Stalled rows stay, under
 * their own quiet line, with the link that opens them.
 */
export function RunningPane({
  view,
  loading,
  error,
  onRetry,
  headingId,
}: {
  view: WorkingNowView<ActivityEntry>;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  headingId: string;
}) {
  const inFlight = view.entries.filter((presented) => presented.membership === 'running');
  const stalled = view.entries.filter((presented) => presented.membership === 'stalled');
  // The cap is on the pane, not on each group: running work first, then what
  // stopped and never finished.
  const rows = [...inFlight, ...stalled];
  const visible = rows.slice(0, MAX_ROWS);
  const overflow = rows.length - visible.length;
  const leadLiveKey = inFlight[0]?.entry.runKey;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader id={headingId} label="Running" count={view.running} countTone="muted" />
      <PaneCard>
        {loading ? (
          <RowSkeleton rows={1} tall />
        ) : error ? (
          <LoadFailedLine what="what’s running" onRetry={onRetry} />
        ) : rows.length === 0 ? (
          <QuietLine>Nothing is running right now.</QuietLine>
        ) : (
          <>
            {inFlight.length === 0 && (
              <QuietLine>Nothing is running right now. These stopped without finishing:</QuietLine>
            )}
            {visible.map((presented) => {
              const entry = presented.entry;
              const percent = runningPercent(entry);
              // A row that STOPPED says so, in the same word the pill uses,
              // instead of replaying the phase text it was showing when it
              // stopped (runningMeta leads with exactly that text). A running
              // row keeps its phase, with the silence appended when nothing
              // has landed on it for longer than the stall threshold.
              const meta = presented.membership === 'running'
                ? [runningMeta(entry), presented.quiet && presented.silence
                    ? `no update in ${presented.silence}` : ''].filter(Boolean).join(' · ')
                : workingNowStatusLabel({
                  membership: presented.membership,
                  silence: presented.silence,
                  lifecycle: entry.lifecycle,
                });
              const steer = steerTarget(entry);
              const open = runningOpenTarget(entry);
              return (
                <PaneRow key={entry.runKey} className="flex-col items-stretch gap-2.5 py-3.5">
                  <div className="flex items-center gap-2">
                    {/* The pulse is a certificate: animated only when the
                        presenter said the run is live. */}
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        presented.pulse ? 'animate-pulse bg-primary' : 'bg-border-strong',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg" title={entry.headline}>
                      {entry.headline}
                    </span>
                    <span className="shrink-0 text-caption text-faint">
                      {[runningKindLabel(entry.kind), presented.stalled ? '' : presented.elapsed]
                        .filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {meta && <p className="truncate text-small text-muted" title={meta}>{meta}</p>}
                  {percent !== null && (
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-subtle"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                      aria-label={`${percent}% done`}
                    >
                      <div className="h-full rounded-full bg-primary transition-[width] duration-slow" style={{ width: `${percent}%` }} />
                    </div>
                  )}
                  {entry.runKey === leadLiveKey && <LiveRunFeed entry={entry} />}
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Steering means typing into a live conversation. A run
                        that stopped days ago has nothing to steer, so the
                        control is not offered — only the door that opens it. */}
                    {steer && !presented.stalled && (
                      <Link to={steer} className={cn(ACTION, 'border border-border bg-surface text-fg hover:border-border-strong hover:bg-hover')}>
                        Steer
                      </Link>
                    )}
                    <Link to={open} className={cn(ACTION, 'text-muted hover:bg-hover hover:text-fg')}>
                      Open run
                    </Link>
                  </div>
                </PaneRow>
              );
            })}
            {overflow > 0 ? (
              <PaneRow className="justify-center">
                <Link to="/tasks" className="text-small font-semibold text-primary hover:underline">
                  +{overflow} more in Tasks
                </Link>
              </PaneRow>
            ) : rows.length === 1 && inFlight.length === 1 ? (
              <QuietLine>Nothing else is running</QuietLine>
            ) : null}
          </>
        )}
      </PaneCard>
    </section>
  );
}
