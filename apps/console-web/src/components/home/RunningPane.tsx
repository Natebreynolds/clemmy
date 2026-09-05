import { Link } from 'react-router-dom';
import type { ActivityEntry } from '@/lib/activity';
import type { WorkingNowView } from '@/lib/activity-presentation';
import { cn } from '@/lib/cn';
import {
  runningKindLabel,
  runningMeta,
  runningOpenTarget,
  runningPercent,
  steerTarget,
} from './home-model';
import { LoadFailedLine, PaneCard, PaneRow, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';

const MAX_ROWS = 4;

const ACTION =
  'inline-flex h-8 items-center rounded-md px-3 text-small font-semibold transition-colors';

/**
 * RUNNING — the ONE Working-Now presenter, rendered as in-flight work. Rows
 * whose presentation is "needs you" are decisions, not running work; they
 * live in the Needs-you pane (and on the Tasks board), never here twice.
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
  const inFlight = view.entries.filter((presented) => presented.presentation !== 'needs_you');
  const visible = inFlight.slice(0, MAX_ROWS);
  const overflow = inFlight.length - visible.length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader id={headingId} label="Running" count={view.running} countTone="muted" />
      <PaneCard>
        {loading ? (
          <RowSkeleton rows={1} tall />
        ) : error ? (
          <LoadFailedLine what="what’s running" onRetry={onRetry} />
        ) : inFlight.length === 0 ? (
          <QuietLine>Nothing is running right now.</QuietLine>
        ) : (
          <>
            {visible.map((presented) => {
              const entry = presented.entry;
              const percent = runningPercent(entry);
              const meta = runningMeta(entry);
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
                      {[runningKindLabel(entry.kind), presented.elapsed].filter(Boolean).join(' · ')}
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
                  <div className="flex flex-wrap items-center gap-2">
                    {steer && (
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
            ) : inFlight.length === 1 ? (
              <QuietLine>Nothing else is running</QuietLine>
            ) : null}
          </>
        )}
      </PaneCard>
    </section>
  );
}
