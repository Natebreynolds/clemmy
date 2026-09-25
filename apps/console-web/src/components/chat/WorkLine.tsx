/**
 * WorkLine — how a chat turn shows Clem's work.
 *
 * While she works it is one quiet line: a live mark, what she is doing now,
 * and the clock, with the steps settling in underneath. When the answer lands
 * it folds to "Worked 58s · 4 steps", which opens to the same steps. The
 * answer is the page; the work is its footnote.
 *
 * Rows come from the same narration the activity card uses (discovery hidden,
 * repeats folded, attempts merged with outcomes), so the chat and every other
 * surface tell one story. Space builds and background tasks keep the card.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, CheckCircle2, ChevronRight, PauseCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ActivityItem } from '@/lib/useChat';
import { BatchRow, useNowTick } from '@/components/chat/ActivityFeed';
import { LiveStepList, StepRow } from '@/components/chat/ActivityCard';
import { narrateActivity, settleTerminalActivity, type ActivityTerminalOutcome } from '@/lib/activity-presentation';
import { activityCardHead, clockLabel, groupActivityByParent } from '@/lib/activity-card';

/** "58s" / "1m 12s": how long she worked, in words rather than a stopwatch. */
export function workedFor(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The folded line's words. The outcome leads when it is not a success, so a
 *  stopped turn never reads like a finished one. */
export function workLineSummary(
  outcome: ActivityTerminalOutcome,
  totalMs: number | undefined,
  steps: number,
  helpers: number,
): string {
  const worked = workedFor(totalMs);
  const parts = [
    outcome === 'failed' ? 'Ran into trouble' : outcome === 'interrupted' ? 'Didn’t finish' : outcome === 'waiting' ? 'Waiting for you' : '',
    worked ? (outcome === 'completed' ? `Worked ${worked}` : `worked ${worked}`) : (outcome === 'completed' ? 'Worked through it' : ''),
    steps > 0 ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : '',
    helpers > 0 ? `${helpers} ${helpers === 1 ? 'helper' : 'helpers'}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function OutcomeMark({ outcome }: { outcome: ActivityTerminalOutcome }) {
  if (outcome === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-danger" strokeWidth={2} role="img" aria-label="Failed" />;
  if (outcome === 'interrupted') return <AlertCircle className="h-4 w-4 shrink-0 text-warning" strokeWidth={2} role="img" aria-label="Did not finish" />;
  if (outcome === 'waiting') return <PauseCircle className="h-4 w-4 shrink-0 text-info" strokeWidth={2} role="img" aria-label="Waiting for you" />;
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" strokeWidth={2} role="img" aria-label="Completed" />;
}

export function WorkLine({
  items,
  live,
  progress,
  terminalOutcome,
  traceHref,
  onBackground,
}: {
  items: ActivityItem[];
  live: boolean;
  /** The engine's rolling human line ("Reading your calendar…"). */
  progress?: string;
  terminalOutcome?: ActivityTerminalOutcome;
  traceHref?: string;
  /** Detach the running turn to the background; offered while live. */
  onBackground?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const now = useNowTick(live);
  const outcome = live ? 'completed' : (terminalOutcome ?? 'interrupted');
  const view = items.length > 0 ? settleTerminalActivity(narrateActivity(items, { live }), live ? undefined : outcome) : [];
  if (!live && view.length === 0) return null;
  const head = activityCardHead(view, live, now);
  const { top, children } = groupActivityByParent(view);
  const anyRunning = live && view.some((row) => row.status === 'running');
  const current = anyRunning ? head.title : (progress ?? head.title);
  const steps = (
    <LiveStepList live={live}>
      <ol className="ml-[7px] mt-1 list-none border-l border-border py-0.5 pl-4">
        {top.map((a) => (
          a.kind === 'batch'
            ? <BatchRow key={a.id} a={a} now={now} live={live} />
            : (
              <li key={a.id} className="list-none">
                <ol className="list-none p-0"><StepRow a={a} now={now} live={live} /></ol>
                {children.get(a.id) && (
                  <ol className="list-none p-0">
                    {children.get(a.id)!.map((c) => <StepRow key={c.id} a={c} now={now} live={live} nested />)}
                  </ol>
                )}
              </li>
            )
        ))}
      </ol>
    </LiveStepList>
  );

  if (live) {
    return (
      <section aria-label="What Clem is doing" className="min-w-0">
        <div className="flex min-h-7 items-center gap-2.5 text-small">
          <span className="work-orb shrink-0" aria-hidden />
          <span role="status" aria-live="polite" className="work-shimmer min-w-0 truncate font-semibold">
            {current || 'Thinking…'}
          </span>
          {head.startedAt !== undefined && (
            <span className="shrink-0 font-mono text-caption tabular-nums text-faint">{clockLabel(head.startedAt, now)}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-3 text-caption text-faint">
            {onBackground && (
              <button
                type="button"
                onClick={onBackground}
                title="Keeps working, reports back here, and frees the chat"
                className="transition-colors hover:text-fg"
              >
                Move to background
              </button>
            )}
            {traceHref && (
              <Link to={traceHref} className="inline-flex items-center gap-0.5 transition-colors hover:text-fg">
                Full trace <ArrowUpRight className="h-3 w-3" aria-hidden />
              </Link>
            )}
          </span>
        </div>
        {view.length > 0 && steps}
      </section>
    );
  }

  const stepCount = top.filter((row) => row.kind !== 'check').length;
  return (
    <section aria-label="What Clem did" className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="-ml-1.5 inline-flex max-w-full items-center gap-2 rounded-sm px-1.5 py-1 text-small text-muted transition-colors duration-fast hover:bg-subtle hover:text-fg active:scale-press"
      >
        <OutcomeMark outcome={outcome} />
        <span className="min-w-0 truncate">{workLineSummary(outcome, head.totalMs, stepCount, head.helpers)}</span>
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-base', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div className="work-reveal">
          {steps}
          {traceHref && (
            <Link to={traceHref} className="ml-[23px] mt-1 inline-flex items-center gap-0.5 text-caption text-faint transition-colors hover:text-fg">
              Full trace <ArrowUpRight className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
