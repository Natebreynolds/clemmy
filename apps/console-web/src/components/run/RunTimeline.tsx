import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ActivityItem } from '@clem/chat-engine';
import { cn } from '@/lib/cn';

/**
 * How the run went, step by step — narrated, not raw.
 *
 * Open while the run is live, because during a run the steps ARE the answer;
 * folded once it settles, because the three sections above already answer the
 * question and a hundred rows of mechanism is not a report. The disclosure is
 * controlled rather than a bare <details> so that the fold can follow the run's
 * own liveness, and so a person who opened it mid-run is not snapped shut when
 * the run finishes under them.
 */
export function RunTimeline({ items, live }: { items: ActivityItem[]; live: boolean }) {
  const [open, setOpen] = useState(live);
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!touched) setOpen(live); }, [live, touched]);

  return (
    <section className="rounded-md border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setTouched(true); setOpen((v) => !v); }}
        className="flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left cursor-pointer"
      >
        <span className="flex items-center gap-1.5 text-body font-semibold text-fg">
          <ChevronRight
            className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-fast', open && 'rotate-90')}
            aria-hidden
          />
          {live ? 'Working' : 'How it went'}
        </span>
        <span className="shrink-0 text-caption text-muted">
          {items.length} {items.length === 1 ? 'step' : 'steps'}
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3">
          {items.length === 0 ? (
            <p className="text-body text-faint">Nothing recorded yet.</p>
          ) : (
            <ol className="space-y-1.5">
              {items.map((item) => (
                <li key={item.id} className="flex items-start gap-2.5 text-body">
                  <StepMark status={item.status} live={live} />
                  <span className="min-w-0">
                    <span className={cn(item.status === 'running' ? 'text-fg' : 'text-muted')}>
                      {item.label}
                    </span>
                    {item.repeats && item.repeats > 1 ? (
                      <span className="ml-1.5 text-caption text-faint">×{item.repeats}</span>
                    ) : null}
                    {item.detail ? (
                      <span className="ml-2 text-caption text-faint">{item.detail}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A running step is the only one that animates, and only while the run itself
 * is live: the pulse is a claim that work is happening RIGHT NOW. A row still
 * marked running on a run that is parked — or one the engine could not settle
 * because its terminal never arrived — gets a hollow ring instead, which says
 * "started, no answer" rather than "in progress".
 */
function StepMark({ status, live }: { status: ActivityItem['status']; live: boolean }) {
  if (status === 'running') {
    return live
      ? <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-label="running" />
      : <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-muted" aria-label="never finished" />;
  }
  const mark = status === 'failed' ? '✗' : status === 'interrupted' ? '–' : '✓';
  const ink = status === 'failed' ? 'text-danger' : status === 'interrupted' ? 'text-warning' : 'text-success';
  return <span className={cn('w-2 shrink-0 text-center text-caption leading-5', ink)} aria-hidden>{mark}</span>;
}
