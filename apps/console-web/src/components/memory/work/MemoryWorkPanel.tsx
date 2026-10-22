/**
 * Memory at work — the overview of the Memory screen: what Clem is doing to
 * keep memory current, with which model, and what it changed. The status line
 * stays open. The pipeline, the activity, the jobs, and the history open on
 * request so the stores underneath stay reachable.
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
import { AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
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

const FOLD_KEY = 'clem.memory.workFolds';
type Fold = 'learning' | 'activity' | 'jobs' | 'history';

function readFolds(): Partial<Record<Fold, boolean>> {
  try {
    const raw = sessionStorage.getItem(FOLD_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<Fold, boolean>>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Closed until the owner opens it. A running job opens today's learning the
 *  first time, and a choice sticks for the rest of the visit. */
function useWorkFolds(): [Partial<Record<Fold, boolean>>, (key: Fold, open: boolean) => void] {
  const [chosen, setChosen] = useState<Partial<Record<Fold, boolean>>>(readFolds);
  const setOpen = (key: Fold, open: boolean) => {
    setChosen((prev) => {
      const next = { ...prev, [key]: open };
      try { sessionStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };
  return [chosen, setOpen];
}

function FoldSection({
  id,
  title,
  summary,
  open,
  onOpen,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) onOpen(next);
      }}
      className="memory-fold border-t border-border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3">
        <ChevronRight className={clsx('h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-fast', open && 'rotate-90')} aria-hidden />
        <span className="text-body font-semibold text-fg">{title}</span>
        <span className="min-w-0 flex-1 truncate text-right text-caption text-faint">{summary}</span>
      </summary>
      <div className="pb-5">{children}</div>
    </details>
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
        <div className="space-y-3 p-4 sm:p-5" aria-busy="true">
          <div className="flex items-start justify-between gap-4">
            <Title />
            <Skeleton className="h-10 w-44" />
          </div>
          <Skeleton className="h-14 w-full" />
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
          <span className="sr-only">Reading memory work…</span>
        </div>
      </Frame>
    );
  }

  // A failed first read says so; a daemon that answered "not reported" (null) stays hidden.
  if (work.isError && work.data === undefined) {
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

  // A daemon that does not report memory work (null) shows no panel.
  if (!view) return null;
  return (
    <Frame still={still}>
      <WorkGlance view={view} now={now} />
    </Frame>
  );
}

function WorkGlance({ view, now }: { view: ReturnType<typeof memoryWorkViewModel>; now: number }) {
  const [chosen, setOpen] = useWorkFolds();
  const unknown = view.state === 'unknown';
  const isOpen = (key: Fold, fallback: boolean) => (key in chosen ? Boolean(chosen[key]) : fallback);
  const read = view.pipeline.find((stage) => stage.id === 'read');
  const kept = view.pipeline.find((stage) => stage.id === 'kept');
  const jobs = [...view.jobs.learning, ...view.jobs.upkeep];
  const running = jobs.filter((job) => job.dot === 'running').length;
  const failed = jobs.filter((job) => job.dot === 'failed').length;
  const jobSummary = running > 0 ? `${running} working now` : failed > 0 ? `${failed} didn’t finish` : `${jobs.length} jobs`;
  const latest = view.timeline[0]?.rows[0]?.sentence;
  const historySummary = view.eventCount === 0
    ? (unknown ? 'Couldn’t be read' : 'Nothing in this history')
    : latest ?? `${view.eventCount} ${view.eventCount === 1 ? 'change' : 'changes'}`;
  return (
    <>
      <div className="memory-head px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <Title />
          <p className="mt-0.5 text-small text-muted">Open a row to see the learning, the jobs, or what changed.</p>
        </div>
        <MemoryModelChip model={view.model} />
      </div>
      <div className="px-4 pb-1 pt-3 sm:px-5">
        <WorkStatusBand view={view} now={now} />
      </div>
      <div className="px-4 sm:px-5">
        <FoldSection
          id="memory-work-today"
          title="Today’s learning"
          summary={`${read?.text ?? '—'} read · ${kept?.text ?? '—'} kept · ${view.todayCaption}`}
          open={isOpen('learning', view.live)}
          onOpen={(open) => setOpen('learning', open)}
        >
          <LearningPipeline stages={view.pipeline} flows={view.flows} />
        </FoldSection>
        <FoldSection
          id="memory-work-activity"
          title="When it happened"
          summary={view.hourlySummary}
          open={isOpen('activity', false)}
          onOpen={(open) => setOpen('activity', open)}
        >
          <ActivityStrip view={view} />
        </FoldSection>
        <FoldSection
          id="memory-work-jobs"
          title="Background jobs"
          summary={jobSummary}
          open={isOpen('jobs', false)}
          onOpen={(open) => setOpen('jobs', open)}
        >
          <JobRoster jobs={view.jobs} />
        </FoldSection>
        <FoldSection
          id="memory-work-done"
          title="What Clem did"
          summary={historySummary}
          open={isOpen('history', false)}
          onOpen={(open) => setOpen('history', open)}
        >
          <WorkTimeline days={view.timeline} count={view.eventCount} unknown={unknown} />
          <div className="mt-4 space-y-1 text-caption text-faint">
            <p>{view.retentionText}</p>
            {view.queueLine && <p>{view.queueLine}.</p>}
          </div>
        </FoldSection>
      </div>
    </>
  );
}
