import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityEntry } from '@/lib/activity';
import type { PresentedWorkingNowEntry } from '@/lib/activity-presentation';
import type { HomeLiveStatus } from '@/lib/home-prefs';
import { cn } from '@/lib/cn';
import { clockLabel, runningMeta, runningOpenTarget } from './home-model';

const CYCLE_MS = 4_200;

/**
 * Clem at work, said in one band under the greeting. While something is
 * running it names it — what, and the step it is on — cycling through the
 * running work, and leads to the board, which owns the detail. Quiet, it says
 * so and when the next scheduled check is. Everything here comes from the
 * shared working-now presenter (the board's own counts) and the calendar
 * watch's schedule; it adds no call of its own.
 */
export function LiveStatus({ entries, mode, nextCheckAt, unavailable }: {
  entries: readonly PresentedWorkingNowEntry<ActivityEntry>[];
  mode: HomeLiveStatus;
  /** When Clem next checks something on a schedule, if known. */
  nextCheckAt?: string | null;
  /** The working-now read failed: say nothing rather than "caught up". */
  unavailable?: boolean;
}) {
  const running = entries.filter((p) => p.membership === 'running');
  const [index, setIndex] = useState(0);
  const cycle = mode === 'animated' && running.length > 1;
  useEffect(() => {
    if (!cycle) { setIndex(0); return; }
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const timer = window.setInterval(() => setIndex((i) => i + 1), CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [cycle, running.length]);

  if (mode === 'off' || unavailable) return null;
  const working = running.length > 0;
  const current = working ? running[index % running.length]! : null;
  const step = current ? runningMeta(current.entry) : '';
  const next = nextCheckAt ? clockLabel(nextCheckAt) : '';

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'live-band flex items-center gap-3 rounded-md border px-4 py-3',
        working ? 'is-working border-primary/40 bg-gradient-to-r from-primary-tint to-surface' : 'border-border bg-surface',
        mode === 'still' && 'live-band-still',
      )}
    >
      <span
        className={cn('live-dot h-2.5 w-2.5 shrink-0 rounded-full', working ? 'bg-primary' : 'bg-success')}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <>
            <Link
              key={current.entry.runKey}
              to={runningOpenTarget(current.entry)}
              className="truncate text-body font-semibold text-fg animate-fade-in hover:text-primary"
            >
              {current.entry.headline || 'Working'}
            </Link>
            {step && <span key={`${current.entry.runKey}-step`} className="truncate text-small text-muted animate-fade-in">{step}</span>}
          </>
        ) : (
          <>
            <span className="text-body font-semibold text-fg">Clem is caught up</span>
            {next && <span className="text-small text-muted">Next calendar check at {next}</span>}
          </>
        )}
      </span>
      {running.length > 1 && (
        <span className="hidden shrink-0 text-small text-muted sm:inline">
          {mode === 'animated' ? `${running.length} things running` : `+${running.length - 1} more`}
        </span>
      )}
      <Link to="/tasks" className="shrink-0 text-small font-semibold text-primary hover:underline">
        Open the board ›
      </Link>
    </div>
  );
}
