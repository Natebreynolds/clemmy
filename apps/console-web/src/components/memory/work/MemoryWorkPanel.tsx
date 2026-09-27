/**
 * Memory at work — the top of the Memory screen: what Clem is doing to keep
 * the owner's memory current, with which model, and what it changed.
 *
 * One cheap read (`GET /api/console/memory/work`), polled every 5 s while the
 * window is visible. Everything shown is that snapshot put into words by the
 * shared presenter; nothing here infers work from a schedule or a lease.
 * Unknown is not empty: a failed first read says so and offers a retry, and a
 * failed later read keeps the last good one on screen, labelled, with nothing
 * moving. The owner's "still" live-status style stops every animation here
 * too; reduced motion does the same.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
// clsx, not cn: tailwind-merge reads this app's text sizes (text-caption,
// text-h2…) as colours and drops them when a colour class sits beside them.
import { clsx } from 'clsx';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHomePreferences } from '@/lib/home-prefs';
import { memoryWorkViewModel, useMemoryWork } from '@/lib/memory-work';
import { ActivityStrip } from './ActivityStrip';
import { JobRoster } from './JobRoster';
import { LearningPipeline } from './LearningPipeline';
import { MemoryModelChip, WorkStatusBand } from './WorkStatus';
import { WorkTimeline } from './WorkTimeline';

/** Ages ("4 min ago") move on their own; the running clock moves each second. */
function useClock(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), fast ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [fast]);
  return now;
}

function Frame({ still, children }: { still?: boolean; children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="memory-work-title"
      className={clsx('memory-work rounded-lg border border-border-raised bg-raised', still && 'is-still')}
    >
      {children}
    </section>
  );
}

function Title() {
  return <h3 id="memory-work-title" className="text-h3 text-fg">Memory at work</h3>;
}

function Section({ id, title, aside, children, className }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={clsx('min-w-0', className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 id={id} className="text-body font-semibold text-fg">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function MemoryWorkPanel() {
  const work = useMemoryWork();
  const prefs = useHomePreferences();
  const still = (prefs.data?.liveStatus ?? 'animated') !== 'animated';
  const stale = work.isError && Boolean(work.data);
  const liveHint = Boolean(work.data && work.data.state === 'working' && !stale);
  const now = useClock(liveHint);
  const view = useMemo(
    () => (work.data ? memoryWorkViewModel(work.data, now, { stale, readAt: work.dataUpdatedAt || undefined }) : null),
    [work.data, now, stale, work.dataUpdatedAt],
  );

  if (work.isLoading && !work.data) {
    return (
      <Frame>
        <div className="space-y-4 p-4 sm:p-5" aria-busy="true">
          <div className="flex items-start justify-between gap-4">
            <Title />
            <Skeleton className="h-10 w-44" />
          </div>
          <Skeleton className="h-16 w-full" />
          <div className="grid grid-cols-4 gap-6">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
          <Skeleton className="h-24 w-full" />
          <span className="sr-only">Reading memory work…</span>
        </div>
      </Frame>
    );
  }

  if (work.isError && !work.data) {
    return (
      <Frame>
        <div className="p-4 sm:p-5">
          <Title />
          {/* Static content in a labelled section, not an alert: opening Memory
              on a daemon without this route must not interrupt a screen reader. */}
          <div className="mt-3 flex flex-wrap items-start gap-3 rounded-md border border-border bg-subtle px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-body font-semibold text-fg">Couldn’t read memory work just now</p>
              <p className="text-small text-muted">Nothing has been lost. Clem keeps learning in the background; this panel checks again in a few seconds.</p>
            </div>
            <button
              type="button"
              onClick={() => void work.refetch()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-small font-semibold text-fg transition-colors duration-fast hover:bg-hover"
            >
              <RefreshCw className={clsx('h-3.5 w-3.5', work.isFetching && 'animate-spin')} aria-hidden /> Try again
            </button>
          </div>
        </div>
      </Frame>
    );
  }

  if (!view) return null;
  const unknown = view.state === 'unknown';
  return (
    <Frame still={still}>
      <div className="memory-head px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <Title />
          <p className="mt-0.5 text-small text-muted">What Clem is doing to keep your memory current, and what it changed.</p>
        </div>
        <MemoryModelChip model={view.model} />
      </div>
      <div className="px-4 pt-3 sm:px-5">
        <WorkStatusBand view={view} now={now} />
      </div>

      <div className="space-y-6 px-4 pb-5 pt-5 sm:px-5">
        <Section id="memory-work-today" title="Today’s learning" aside={<span className="text-caption text-faint">Counts since midnight</span>}>
          <LearningPipeline stages={view.pipeline} flows={view.flows} />
        </Section>

        <div className="border-t border-border pt-5">
          <ActivityStrip view={view} />
        </div>

        <div className="border-t border-border pt-5">
          <Section id="memory-work-jobs" title="Background jobs" aside={<span className="text-caption text-faint">What each one does, the model it uses, and when it runs</span>}>
            <JobRoster jobs={view.jobs} />
          </Section>
        </div>

        <div className="border-t border-border pt-5">
          <Section
            id="memory-work-done"
            title="What Clem did"
            aside={view.eventCount > 0 ? <span className="text-caption text-faint">Newest first</span> : undefined}
          >
            <WorkTimeline days={view.timeline} count={view.eventCount} unknown={unknown} />
            <div className="mt-4 space-y-1 text-caption text-faint">
              <p>{view.retentionText}</p>
              {view.queueLine && <p>{view.queueLine}.</p>}
            </div>
          </Section>
        </div>
      </div>
    </Frame>
  );
}
